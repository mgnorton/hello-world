// Six degree-of-freedom flight dynamics model of the Boeing 737-900.
// Rigid body with stability-derivative aerodynamics, CFM56 engine model, spring/damper
// landing gear with tyre friction, flaps, spoilers, reversers and autobrakes. The air it
// flies through comes from the weather engine (wind, gusts, turbulence, storm downdrafts,
// non-standard pressure and temperature).
import {
  v3, quat, clamp, lerp, smoothstep, expK, DEG, RAD, KT, FPM, G0, wrap180, bearingOf, type Vec3, type Quat,
} from './math.ts';
import { airAt, casFromTas, baroAltitude, P0, type AirState } from './atmosphere.ts';
import { B739, flapAero, AUTOBRAKE_DECEL, type AutobrakeSetting } from './aircraftData.ts';
import type { Surface, SurfaceKind } from '../world/worldData.ts';
import type { WeatherSample } from '../weather/weather.ts';

const A = B739.aero;

export interface Terrain {
  surface(x: number, z: number): Surface;
}

export interface Environment {
  sample(x: number, z: number, h: number, ground: number): WeatherSample;
  gustAt(x: number, z: number): number;
}

export interface Controls {
  pitch: number;
  roll: number;
  yaw: number;
  tiller: number;
  throttle: [number, number];
  brakeL: number;
  brakeR: number;
  parkingBrake: boolean;
  flapLever: number;
  gearDown: boolean;
  speedbrake: number;
  speedbrakeArmed: boolean;
  reverse: boolean;
  trim: number;
  autobrake: AutobrakeSetting;
}

export interface TouchdownData {
  t: number;
  vs: number;
  ias: number;
  pitch: number;
  roll: number;
  crab: number;
  peakG: number;
  pos: Vec3;
  surface: SurfaceKind;
}

export type FdmEvent =
  | { type: 'touchdown'; data: TouchdownData }
  | { type: 'crash'; reason: string }
  | { type: 'tailstrike' }
  | { type: 'autobrakeDisarm' };

export class Engine {
  n1 = B739.idleN1Ground;
  n2 = 60;
  egt = 450;
  ff = 0.15; // kg/s
  thrust = 0;
  running = true;
  failed = false;
  reverser = 0; // 0 stowed .. 1 deployed

  constructor(readonly index: number) {}

  update(dt: number, tla: number, reverseCmd: boolean, air: AirState, mach: number, onGround: boolean): void {
    const idle = onGround ? B739.idleN1Ground : B739.idleN1Flight;
    let target: number;
    if (this.failed || !this.running) target = 4 + Math.min(14, mach * 30); // windmilling
    else if (this.reverser > 0.5) target = idle + (82 - idle) * tla; // reverse limited to ~82 % N1
    else target = idle + (100.5 - idle) * tla;
    const tau = this.n1 < 45 ? 2.6 : target > this.n1 ? 1.4 : 1.1;
    this.n1 += (target - this.n1) * expK(dt, tau);
    this.reverser += clamp((reverseCmd ? 1 : 0) - this.reverser, -dt / 1.8, dt / 1.8);
    const frac = clamp((this.n1 - 19) / 81, 0, 1.02);
    const lapse = Math.pow(air.sigma, 0.82) * (1 - 0.9 * mach + 0.55 * mach * mach);
    let t = B739.staticThrust * (0.055 + 0.945 * Math.pow(frac, 1.65)) * lapse;
    if (this.failed || !this.running) t = -2500 * mach;
    t *= lerp(1, -0.42, this.reverser);
    this.thrust = t;
    this.n2 = 58 + 0.42 * this.n1;
    const egtTarget = this.failed ? 60 : 380 + 520 * Math.pow(frac, 1.4) + (air.T - 288) * 1.5;
    this.egt += (egtTarget - this.egt) * expK(dt, 3);
    const tsfc = (0.36 + 0.34 * mach) * 2.833e-5; // kg / (N s)
    this.ff = this.failed ? 0 : Math.max(0.09, Math.abs(t) * tsfc);
  }
}

/** Smooth deterministic noise in [-1, 1] for gusts and turbulence. */
function noise1(t: number, seed: number): number {
  let s = 0;
  let amp = 1;
  let f = 1;
  for (let i = 0; i < 4; i++) {
    s += amp * Math.sin(t * f * 0.37 + seed * 1.7 + i * 2.1) * Math.cos(t * f * 0.23 + seed * 0.9 + i);
    amp *= 0.5;
    f *= 2.03;
  }
  return s;
}

export class Aircraft {
  readonly engines = [new Engine(0), new Engine(1)];
  readonly controls: Controls = {
    pitch: 0, roll: 0, yaw: 0, tiller: 0, throttle: [0, 0], brakeL: 0, brakeR: 0, parkingBrake: true,
    flapLever: 0, gearDown: true, speedbrake: 0, speedbrakeArmed: false, reverse: false, trim: 0, autobrake: 'OFF',
  };
  payload = 15000;
  fuel = 9000;

  // State
  pos: Vec3 = [0, 0, 0];
  vel: Vec3 = [0, 0, 0];
  q: Quat = [1, 0, 0, 0];
  w: Vec3 = [0, 0, 0];
  time = 0;
  flapPos = 0;
  gearPos = 1;
  spoilerPos = 0;
  crashed: string | null = null;
  damage: string[] = [];
  wow = false;
  noseWow = false;
  gearLoad = [0, 0, 0];
  gearCompression = [0, 0, 0];
  airborneTime = 0;
  groundTime = 0;
  touchdownEval: TouchdownData | null = null;
  events: FdmEvent[] = [];
  tailStrike = false;
  private tailStrikeLogged = false;
  autobrakeActive = false;
  autobrakePress = 0;
  autobrakeDisarmed = false;
  autobrakeCmd = 0;
  rtoTriggered = false;
  maxTakeoffSpeed = 0;
  spoilersAutoDeployed = false;

  // Derived (instruments, autopilot)
  air: AirState = airAt(0);
  env!: WeatherSample;
  private envTimer = 0;
  wind: Vec3 = [0, 0, 0];
  groundH = 0;
  surfaceKind: SurfaceKind = 'runway';
  agl = 0;
  tas = 0;
  ias = 0;
  mach = 0;
  alpha = 0;
  beta = 0;
  heading = 0;
  pitch = 0;
  roll = 0;
  gs = 0;
  track = 0;
  vs = 0;
  radioAlt = 0;
  decel = 0;
  private prevGs = 0;
  nz = 1;
  buffet = 0;
  stallWarning = false;
  alphaStall = 0.2;
  fuelFlow = 0;
  /** Altimeter: setting in Pa, or standard (29.92 inHg). */
  baroSetting = P0;
  baroStd = false;
  /** Indicated (barometric) altitude in metres. */
  altInd = 0;

  constructor(readonly terrain: Terrain, readonly environment: Environment) {
    this.reset([0, 0, 0], 0);
  }

  get mass(): number {
    return B739.oew + this.payload + this.fuel;
  }

  reset(pos: Vec3, headingDeg: number, opts: { pitch?: number; n1?: number } = {}): void {
    this.pos = [pos[0], pos[1], pos[2]];
    this.vel = [0, 0, 0];
    this.q = quat.fromEuler(headingDeg * DEG, (opts.pitch ?? 0) * DEG, 0);
    this.w = [0, 0, 0];
    this.time = 0;
    this.flapPos = this.controls.flapLever;
    this.gearPos = this.controls.gearDown ? 1 : 0;
    this.spoilerPos = 0;
    this.crashed = null;
    this.damage = [];
    this.wow = false;
    this.noseWow = false;
    this.gearLoad = [0, 0, 0];
    this.gearCompression = [0, 0, 0];
    this.airborneTime = 0;
    this.groundTime = 0;
    this.touchdownEval = null;
    this.events = [];
    this.tailStrike = false;
    this.autobrakeActive = false;
    this.autobrakePress = 0;
    this.autobrakeDisarmed = false;
    this.rtoTriggered = false;
    this.maxTakeoffSpeed = 0;
    this.spoilersAutoDeployed = false;
    this.prevGs = 0;
    this.decel = 0;
    this.nz = 1;
    this.stallWarning = false;
    this.envTimer = 0;
    for (const e of this.engines) {
      e.n1 = opts.n1 ?? B739.idleN1Ground;
      e.reverser = 0;
    }
    this.updateDerived(0);
  }

  /** Air data and attitude used by instruments, autopilot and sounds. */
  updateDerived(dt: number): void {
    const surf = this.terrain.surface(this.pos[0], this.pos[2]);
    this.groundH = surf.h;
    this.surfaceKind = surf.kind;
    this.agl = this.pos[1] - surf.h;
    this.envTimer -= dt;
    if (!this.env || this.envTimer <= 0) {
      this.envTimer = 0.1;
      this.env = this.environment.sample(this.pos[0], this.pos[2], this.pos[1], surf.h);
    }
    const env = this.env;
    this.air = airAt(this.pos[1], env.qnhPa, env.isaDev);
    // Gusts near the ground and turbulence add to the mean wind.
    const t = this.time;
    const gust = this.environment.gustAt(this.pos[0], this.pos[2]) * (1 - smoothstep(200, 1200, this.agl));
    const gustMag = Math.max(0, noise1(t * 0.45, 3) * 0.5 + 0.5) * gust;
    const turbAmp = [0, 1.0, 2.6, 5.5][Math.min(3, Math.round(env.turbulence))] * Math.min(1, env.turbulence);
    const ws = env.windSpeed || 1;
    this.wind = [
      env.wind[0] + (env.wind[0] / ws) * gustMag + noise1(t * 2.1, 11) * turbAmp,
      env.wind[1] + noise1(t * 2.7, 23) * turbAmp * 0.8,
      env.wind[2] + (env.wind[2] / ws) * gustMag + noise1(t * 2.3, 17) * turbAmp,
    ];
    const va = v3.sub(this.vel, this.wind);
    const vb = quat.rotateInv(this.q, va);
    const V = v3.len(vb);
    this.tas = V;
    this.alpha = V > 1 ? Math.atan2(-vb[1], vb[0]) : 0;
    this.beta = V > 1 ? Math.asin(clamp(vb[2] / V, -1, 1)) : 0;
    this.mach = V / this.air.a;
    this.ias = casFromTas(Math.max(0, vb[0]), this.air);
    const e = quat.toEuler(this.q);
    this.heading = e.heading * RAD;
    this.pitch = e.pitch * RAD;
    this.roll = e.roll * RAD;
    this.gs = Math.hypot(this.vel[0], this.vel[2]);
    this.track = this.gs > 1 ? bearingOf(this.vel[0], this.vel[2]) : this.heading;
    this.vs = this.vel[1];
    this.radioAlt = Math.max(0, this.agl - 2.57 - Math.sin(this.pitch * DEG) * 1.2);
    this.altInd = baroAltitude(this.air.p, this.baroStd ? P0 : this.baroSetting);
    if (dt > 0) {
      const a = (this.gs - this.prevGs) / dt;
      this.decel += (-a - this.decel) * expK(dt, 0.4);
      this.prevGs = this.gs;
    }
  }

  inertia(): Vec3 {
    const r = this.mass / B739.inertiaRef.mass;
    const I = B739.inertiaRef;
    return [I.roll * r, I.yaw * r, I.pitch * r];
  }

  /** Advance the simulation by dt seconds (call with small steps, ~1/240 s). */
  step(dt: number): void {
    if (this.crashed) return;
    this.time += dt;
    const c = this.controls;
    this.updateDerived(dt);
    const air = this.air;
    const onGround = this.wow;
    this.updateSystems(dt, onGround);

    // --- Aerodynamics ------------------------------------------------------------
    const va = v3.sub(this.vel, this.wind);
    const vb = quat.rotateInv(this.q, va);
    const V = v3.len(vb);
    const Vc = Math.max(V, 15);
    const qbar = 0.5 * air.rho * V * V;
    const S = B739.wingArea;
    const b = B739.span;
    const cbar = B739.chord;
    const alpha = this.alpha;
    const beta = this.beta;
    const p = this.w[0];
    const qr = this.w[2];
    const r = -this.w[1];
    const ph = (p * b) / (2 * Vc);
    const rh = (r * b) / (2 * Vc);
    const qh = (qr * cbar) / (2 * Vc);

    const fa = flapAero(this.flapPos);
    const M = this.mach;
    const machLoss = 1 - 0.62 * Math.max(0, M - 0.32) * smoothstep(0, 0.5, 1 - this.flapPos);
    const icingLoss = this.env.icing ? 0.93 : 1;
    const clmax = fa.clmax * Math.max(0.5, machLoss) * icingLoss;
    const alphaStall = (clmax - fa.cl0) / A.cla;
    this.alphaStall = alphaStall;
    const hw = Math.max(0, this.agl - 1.6);
    const ge = 1 - smoothstep(0, b * 0.9, hw);
    let CL: number;
    if (alpha <= alphaStall) {
      CL = Math.max(fa.cl0 + A.cla * alpha, -0.9 + fa.cl0 * 0.2);
    } else {
      const x = alpha - alphaStall;
      const post = clmax * (1 - 0.38 * smoothstep(0, 7 * DEG, x));
      const plate = 1.15 * Math.sin(2 * alpha);
      CL = lerp(post, plate, smoothstep(14 * DEG, 30 * DEG, x));
    }
    CL *= 1 + 0.09 * ge;
    CL += A.clSpoiler * this.spoilerPos * (0.6 + 0.4 * smoothstep(0, 3, this.flapPos));
    CL += 4.5 * qh;
    const kInd = A.k * (1 - 0.45 * ge);
    const wave = 20 * Math.pow(Math.max(0, M - A.mcrit), 4) + 2.5 * Math.pow(Math.max(0, M - 0.84), 2);
    const CD = A.cd0 + fa.cd + A.cdGear * this.gearPos + A.cdSpoiler * this.spoilerPos +
      kInd * (CL - 0.08) * (CL - 0.08) + wave + 1.1 * Math.pow(Math.sin(Math.max(0, alpha - alphaStall)), 2) +
      0.25 * beta * beta + (this.env.icing ? 0.002 : 0);
    const stallDepth = alpha - alphaStall;
    this.buffet = clamp((stallDepth + 2.5 * DEG) / (5 * DEG), 0, 1) * smoothstep(20, 50, V);
    this.stallWarning = alpha > alphaStall - 1.6 * DEG && V > 25 && !onGround;
    const wingDrop = stallDepth > 0 ? Math.sin(this.time * 1.3) * 0.012 * smoothstep(0, 4 * DEG, stallDepth) : 0;
    // Turbulence also kicks the attitude a little through the aerodynamic moments.
    const turbRoll = this.env.turbulence > 0.3 ? noise1(this.time * 3.1, 41) * 0.004 * this.env.turbulence : 0;

    const ail = c.roll * clamp(150 / Math.max(V, 1), 0.45, 1);
    const elevEff = 1 - 0.25 * smoothstep(0, 10 * DEG, stallDepth);
    const rud = c.yaw * clamp(200 / Math.max(V, 1), 0.35, 1);
    const CY = A.cyb * beta + A.cyRud * rud;
    const Cl = A.clb * beta + A.clp * ph + A.clr * rh + A.clAil * ail + A.clRud * rud + wingDrop + turbRoll;
    const Cm = A.cm0 + fa.cm + A.cma * alpha + A.cmq * qh + A.cmElev * c.pitch * elevEff + A.cmTrim * c.trim +
      0.01 * this.spoilerPos - 0.004 * this.gearPos - 0.35 * Math.max(0, stallDepth) - 0.015 * ge;
    const Cn = A.cnb * beta + (A.cnr + A.yawDamper * smoothstep(40, 70, V)) * rh + A.cnp * ph + A.cnAil * ail + A.cnRud * rud;

    const aeroScale = smoothstep(2, 15, V);
    const L = CL * qbar * S * aeroScale;
    const D = CD * qbar * S * aeroScale;
    const Y = CY * qbar * S * aeroScale;
    let Fb: Vec3 = [0, 0, 0];
    let Mb: Vec3 = [0, 0, 0];
    if (V > 0.5) {
      const vdir = v3.scale(vb, 1 / V);
      const liftDir = v3.norm(v3.cross([0, 0, 1], vb));
      Fb = v3.add(v3.add(v3.scale(vdir, -D), v3.scale(liftDir, L)), [0, 0, Y]);
      Mb = [Cl * qbar * S * b * aeroScale, -Cn * qbar * S * b * aeroScale, Cm * qbar * S * cbar * aeroScale];
    }

    // --- Engines -----------------------------------------------------------------
    let fuelFlow = 0;
    for (let i = 0; i < 2; i++) {
      const eng = this.engines[i];
      eng.update(dt, c.throttle[i], c.reverse && this.wow, air, M, onGround);
      fuelFlow += eng.ff;
      const F: Vec3 = [eng.thrust, 0, 0];
      Fb = v3.add(Fb, F);
      Mb = v3.add(Mb, v3.cross(B739.engineOffsets[i], F));
    }
    this.fuel = Math.max(0, this.fuel - fuelFlow * dt);
    if (this.fuel <= 0) for (const e of this.engines) e.running = false;
    this.fuelFlow = fuelFlow;

    let Fw = quat.rotate(this.q, Fb);
    let Mbody = Mb;
    const mass = this.mass;
    const contact = this.groundContact(dt);
    Fw = v3.add(Fw, contact.F);
    Mbody = v3.add(Mbody, contact.M);
    Fw[1] -= mass * G0;
    const fSpec = quat.rotateInv(this.q, v3.sub(Fw, [0, -mass * G0, 0]));
    this.nz += (fSpec[1] / (mass * G0) - this.nz) * expK(dt, 0.08);

    // --- Integrate ---------------------------------------------------------------
    this.vel = v3.add(this.vel, v3.scale(Fw, dt / mass));
    this.pos = v3.add(this.pos, v3.scale(this.vel, dt));
    const I = this.inertia();
    const Iw: Vec3 = [I[0] * this.w[0], I[1] * this.w[1], I[2] * this.w[2]];
    const gyro = v3.cross(this.w, Iw);
    const wdot: Vec3 = [(Mbody[0] - gyro[0]) / I[0], (Mbody[1] - gyro[1]) / I[1], (Mbody[2] - gyro[2]) / I[2]];
    this.w = v3.add(this.w, v3.scale(wdot, dt));
    this.q = quat.integrate(this.q, this.w, dt);

    if (this.wow && this.gs < 0.05 && (c.parkingBrake || c.brakeL > 0.5) && Math.abs(this.w[1]) < 0.01) {
      if (Math.max(this.engines[0].thrust, this.engines[1].thrust) < 40000) {
        this.vel[0] = 0;
        this.vel[2] = 0;
        this.w[1] = 0;
      }
    }
    this.checkLimits();
  }

  private updateSystems(dt: number, onGround: boolean): void {
    const c = this.controls;
    this.flapPos += clamp(c.flapLever - this.flapPos, -dt / 2.5, dt / 2.5);
    if (!c.gearDown && this.wow) c.gearDown = true;
    this.gearPos += clamp((c.gearDown || this.wow ? 1 : 0) - this.gearPos, -dt / 7, dt / 7);
    const thrIdle = c.throttle[0] < 0.08 && c.throttle[1] < 0.08;
    const gs = this.gs;
    this.maxTakeoffSpeed = onGround ? Math.max(this.maxTakeoffSpeed, gs) : 0;
    if (c.speedbrakeArmed && onGround && thrIdle && (this.airborneTime > 0 || (gs > 30 && this.rtoTriggered))) {
      c.speedbrake = 1;
      c.speedbrakeArmed = false;
      this.spoilersAutoDeployed = true;
    }
    if (this.spoilersAutoDeployed && !thrIdle && !c.reverse) {
      c.speedbrake = 0;
      this.spoilersAutoDeployed = false;
    }
    const sbTarget = onGround ? c.speedbrake : Math.min(c.speedbrake, 0.65);
    this.spoilerPos += clamp(sbTarget - this.spoilerPos, -dt / 1.2, dt / 1.2);

    const ab = c.autobrake;
    let abCmd = 0;
    if (ab === 'RTO') {
      if (onGround && thrIdle && this.maxTakeoffSpeed > 88 * KT && gs > 2) {
        this.rtoTriggered = true;
        c.speedbrake = 1;
      }
      if (this.rtoTriggered) abCmd = 1;
      if (!onGround && this.airborneTime > 2) c.autobrake = 'OFF';
    } else if (AUTOBRAKE_DECEL[ab]) {
      if (onGround && thrIdle && this.airborneTime > 0 && !this.autobrakeDisarmed && gs > 1) this.autobrakeActive = true;
      if (this.autobrakeActive) {
        const err = AUTOBRAKE_DECEL[ab]! - this.decel;
        this.autobrakePress = clamp(this.autobrakePress + err * 0.6 * dt, 0, 1);
        abCmd = gs < 0.5 ? 0.6 : this.autobrakePress;
      }
      if (this.autobrakeActive && (c.brakeL > 0.6 || c.brakeR > 0.6 || (!thrIdle && !c.reverse))) {
        this.autobrakeActive = false;
        this.autobrakeDisarmed = true;
        c.autobrake = 'OFF';
        this.events.push({ type: 'autobrakeDisarm' });
      }
    }
    if (!onGround && ab !== 'RTO') this.autobrakeDisarmed = false;
    this.autobrakeCmd = abCmd;
  }

  private groundContact(dt: number): { F: Vec3; M: Vec3 } {
    const c = this.controls;
    let F: Vec3 = [0, 0, 0];
    let Mb: Vec3 = [0, 0, 0];
    const gearDown = this.gearPos > 0.97;
    let mainContact = false;
    let noseContact = false;
    const gsKt = this.gs / KT;
    const steerAuth = lerp(70, 7, smoothstep(5, 35, gsKt));
    const steer = clamp(c.yaw + c.tiller, -1, 1) * steerAuth * DEG;
    // Wet runways in rain: less braking and cornering grip.
    const wet = this.env.precip > 0.5 ? clamp(this.env.precip / 6, 0.3, 1) : 0;

    for (let i = 0; i < B739.gear.length; i++) {
      const g = B739.gear[i];
      this.gearLoad[i] = 0;
      this.gearCompression[i] = 0;
      if (!gearDown) continue;
      const rArm = quat.rotate(this.q, g.p);
      const pw = v3.add(this.pos, rArm);
      const surf = this.terrain.surface(pw[0], pw[2]);
      const pen = surf.h - pw[1];
      if (pen <= 0) continue;
      if (surf.water) {
        this.crash('Ditched in water');
        return { F, M: Mb };
      }
      const vp = v3.add(this.vel, quat.rotate(this.q, v3.cross(this.w, g.p)));
      let N = g.k * pen + g.c * -vp[1];
      if (pen > B739.maxStroke) N += (pen - B739.maxStroke) * g.k * 12;
      N = Math.max(0, N);
      this.gearLoad[i] = N;
      this.gearCompression[i] = pen;
      if (g.name === 'nose') noseContact = true;
      else mainContact = true;
      const s = g.steer ? steer : 0;
      let fw = quat.rotate(this.q, [Math.cos(s), 0, Math.sin(s)]);
      fw = v3.norm([fw[0], 0, fw[2]]);
      const side: Vec3 = [-fw[2], 0, fw[0]];
      const vl = v3.dot(vp, fw);
      const vs = v3.dot(vp, side);
      const paved = surf.kind === 'runway' || surf.kind === 'paved';
      const muRoll = paved ? 0.016 : 0.07;
      let brake = 0;
      if (g.brake) {
        const manual = g.brake === 'L' ? c.brakeL : c.brakeR;
        brake = Math.max(manual, this.autobrakeCmd, c.parkingBrake ? 1 : 0);
      }
      const muBrake = (paved ? 0.52 : 0.3) * brake * (1 - 0.45 * wet);
      const muLat = (paved ? 0.75 : 0.45) * (1 - 0.3 * wet);
      let Fl = -(muRoll + muBrake) * N * clamp(vl / 0.3, -1, 1);
      let Fs = -muLat * N * clamp(vs / 0.25, -1, 1);
      const cap = (paved ? 0.85 : 0.55) * (1 - 0.35 * wet) * N;
      const mag = Math.hypot(Fl, Fs);
      if (mag > cap) {
        Fl *= cap / mag;
        Fs *= cap / mag;
      }
      const Fg: Vec3 = [fw[0] * Fl + side[0] * Fs, N, fw[2] * Fl + side[2] * Fs];
      F = v3.add(F, Fg);
      Mb = v3.add(Mb, quat.rotateInv(this.q, v3.cross(rArm, Fg)));
    }

    this.tailStrike = false;
    for (const sp of B739.structure) {
      if (sp.kind === 'belly' && gearDown) continue;
      const rArm = quat.rotate(this.q, sp.p);
      const pw = v3.add(this.pos, rArm);
      const surf = this.terrain.surface(pw[0], pw[2]);
      const pen = surf.h - pw[1];
      if (pen <= 0) continue;
      const vp = v3.add(this.vel, quat.rotate(this.q, v3.cross(this.w, sp.p)));
      if (surf.water && this.tas > 5) {
        this.crash(this.gearPos < 0.5 ? 'Ditched in water' : 'Struck water');
        break;
      }
      if (sp.kind === 'tail') {
        this.tailStrike = true;
        if (!this.tailStrikeLogged) {
          this.events.push({ type: 'tailstrike' });
          this.damage.push('Tail strike');
          this.tailStrikeLogged = true;
        }
        if (pen > 0.6) this.crash('Severe tail strike');
      } else if (sp.kind === 'engine' || sp.kind === 'wing') {
        if (this.gs > 15 * KT || -vp[1] > 2) {
          this.crash(sp.kind === 'engine' ? 'Engine pod strike' : 'Wingtip struck the ground');
          break;
        }
      } else if (sp.kind === 'belly') {
        if (this.gs > 20 * KT || -vp[1] > 3) {
          this.crash(this.gearPos < 0.5 ? 'Gear-up landing' : 'Fuselage impact');
          break;
        }
      }
      if (-vp[1] > 6) {
        this.crash('Impact with terrain');
        break;
      }
      const N = Math.max(0, 4e6 * pen - 4e5 * vp[1]);
      const hv = Math.hypot(vp[0], vp[2]) || 1;
      const Fg: Vec3 = [(-vp[0] / hv) * N * 0.4, N, (-vp[2] / hv) * N * 0.4];
      F = v3.add(F, Fg);
      Mb = v3.add(Mb, quat.rotateInv(this.q, v3.cross(rArm, Fg)));
    }
    if (!gearDown && this.agl < 1.0 && this.gs > 10) {
      const surf = this.terrain.surface(this.pos[0], this.pos[2]);
      if (this.pos[1] - surf.h < 1.8) this.crash(this.gearPos < 0.5 ? 'Gear-up landing' : 'Gear collapsed');
    }

    const wasWow = this.wow;
    this.wow = mainContact;
    this.noseWow = noseContact;
    if (this.wow) {
      this.groundTime += dt;
      if (!wasWow && this.airborneTime > 3) this.beginTouchdown();
    } else {
      if (wasWow) this.airborneTime = 0;
      this.airborneTime += dt;
      this.groundTime = 0;
      this.tailStrikeLogged = false;
    }
    if (this.touchdownEval) this.evaluateTouchdown(dt);
    return { F, M: Mb };
  }

  private beginTouchdown(): void {
    this.touchdownEval = {
      t: 0, vs: this.vel[1] / FPM, ias: this.ias / KT, pitch: this.pitch, roll: this.roll,
      crab: wrap180(this.heading - this.track), peakG: this.nz, pos: [this.pos[0], this.pos[1], this.pos[2]], surface: this.surfaceKind,
    };
  }

  private evaluateTouchdown(dt: number): void {
    const td = this.touchdownEval!;
    td.t += dt;
    td.peakG = Math.max(td.peakG, this.nz);
    if (td.t < 0.6) return;
    this.touchdownEval = null;
    if (td.vs < -1400 || td.peakG > 2.9) this.crash('Hard landing: structural failure');
    else if (td.vs < -600 || td.peakG > 2.0) this.damage.push('Hard landing');
    this.events.push({ type: 'touchdown', data: td });
  }

  private checkLimits(): void {
    if (this.nz > 4.0 || this.nz < -2.0) this.crash('Structural failure (g-load)');
    if (this.ias > (B739.vmo + 75) * KT) this.crash('Structural failure (overspeed)');
    if (!this.wow && this.agl < 0.5 && this.surfaceKind !== 'runway' && this.gearPos < 0.97) this.crash('Impact with terrain');
  }

  crash(reason: string): void {
    if (this.crashed) return;
    this.crashed = reason;
    this.vel = [0, 0, 0];
    this.w = [0, 0, 0];
    this.events.push({ type: 'crash', reason });
  }

  /** Place the aircraft on the ground at (x, z) and let the gear settle. */
  placeOnGround(x: number, z: number, headingDeg: number): void {
    const h = this.terrain.surface(x, z).h;
    this.controls.gearDown = true;
    this.reset([x, h + 2.6, z], headingDeg);
    const keep = this.controls.parkingBrake;
    this.controls.parkingBrake = true;
    for (let i = 0; i < 480; i++) {
      this.step(1 / 240);
      this.pos[0] = x;
      this.pos[2] = z;
      this.vel[0] = 0;
      this.vel[2] = 0;
    }
    this.controls.parkingBrake = keep;
    this.airborneTime = 0;
    this.events = [];
    this.time = 0;
  }

  /** Initialise trimmed flight at a calibrated airspeed (kt), flight path angle (deg), altitude (m) and heading. */
  setTrimmedFlight(pos: Vec3, headingDeg: number, casKt: number, gammaDeg: number, cfg: { flaps?: number; gearDown?: boolean } = {}): void {
    const c = this.controls;
    if (cfg.flaps !== undefined) c.flapLever = cfg.flaps;
    if (cfg.gearDown !== undefined) c.gearDown = cfg.gearDown;
    c.parkingBrake = false;
    c.speedbrake = 0;
    this.reset(pos, headingDeg);
    this.flapPos = c.flapLever;
    this.gearPos = c.gearDown ? 1 : 0;
    const env = this.environment.sample(pos[0], pos[2], pos[1], this.terrain.surface(pos[0], pos[2]).h);
    const air = airAt(pos[1], env.qnhPa, env.isaDev);
    let tas = casKt * KT;
    for (let i = 0; i < 20; i++) tas *= (casKt * KT) / casFromTas(tas, air);
    const gamma = gammaDeg * DEG;
    const W = this.mass * G0;
    const qbar = 0.5 * air.rho * tas * tas;
    const fa = flapAero(this.flapPos);
    const M = tas / air.a;
    let alpha = 0.05;
    let thrust = 0;
    for (let i = 0; i < 30; i++) {
      const CLreq = (W * Math.cos(gamma) - thrust * Math.sin(alpha)) / (qbar * B739.wingArea);
      alpha = (CLreq - fa.cl0) / A.cla;
      const CL = fa.cl0 + A.cla * alpha;
      const wave = 20 * Math.pow(Math.max(0, M - A.mcrit), 4) + 2.5 * Math.pow(Math.max(0, M - 0.84), 2);
      const CD = A.cd0 + fa.cd + A.cdGear * this.gearPos + A.k * (CL - 0.08) ** 2 + wave;
      thrust = (CD * qbar * B739.wingArea + W * Math.sin(gamma)) / Math.cos(alpha);
    }
    c.trim = -(A.cm0 + fa.cm + A.cma * alpha - 0.004 * this.gearPos) / A.cmTrim;
    c.trim -= (0.7 * thrust) / (qbar * B739.wingArea * B739.chord * A.cmTrim);
    c.trim = clamp(c.trim, -1, 1);
    this.q = quat.fromEuler(headingDeg * DEG, alpha + gamma, 0);
    const fwd: Vec3 = [Math.sin(headingDeg * DEG) * Math.cos(gamma), Math.sin(gamma), -Math.cos(headingDeg * DEG) * Math.cos(gamma)];
    this.vel = v3.add(v3.scale(fwd, tas), [env.wind[0], 0, env.wind[2]]);
    const per = Math.max(0, thrust / 2);
    const lapse = Math.pow(air.sigma, 0.82) * (1 - 0.9 * M + 0.55 * M * M);
    const frac = Math.pow(clamp((per / (B739.staticThrust * lapse) - 0.055) / 0.945, 0, 1), 1 / 1.65);
    const n1 = 19 + frac * 81;
    const tla = clamp((n1 - B739.idleN1Flight) / (100.5 - B739.idleN1Flight), 0, 1);
    c.throttle = [tla, tla];
    for (const e of this.engines) e.n1 = Math.max(n1, B739.idleN1Flight);
    this.airborneTime = 30;
    this.wow = false;
    this.envTimer = 0;
    this.updateDerived(0);
  }
}
