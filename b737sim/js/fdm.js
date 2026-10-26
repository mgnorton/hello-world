// Six degree-of-freedom flight dynamics model of the Boeing 737-900.
// Rigid body with stability-derivative aerodynamics, CFM56 engine model,
// spring/damper landing gear with tyre friction, flaps, spoilers, reversers
// and autobrakes. Pure JS so it can run headless for tests.
import {
  v3, quat, clamp, lerp, smoothstep, expK, DEG, RAD, KT, FPM, G0, wrap180, bearingOf,
} from './math.js';
import { isa, casFromTas } from './atmosphere.js';
import { B739, flapAero, AUTOBRAKE_DECEL } from './aircraftData.js';

const A = B739.aero;

export class Engine {
  constructor(index) {
    this.index = index;
    this.n1 = B739.idleN1Ground;
    this.n2 = 60;
    this.egt = 450;
    this.ff = 0.15;      // kg/s
    this.thrust = 0;
    this.running = true;
    this.failed = false;
    this.reverser = 0;   // 0 stowed .. 1 deployed
  }

  update(dt, tla, reverseCmd, atm, mach, onGround) {
    const idle = onGround ? B739.idleN1Ground : B739.idleN1Flight;
    let target;
    if (this.failed || !this.running) {
      target = 4 + Math.min(14, mach * 30); // windmilling
    } else if (this.reverser > 0.5) {
      target = idle + (82 - idle) * tla;     // reverse thrust is limited to ~82% N1
    } else {
      target = idle + (100.5 - idle) * tla;
    }
    // Spool dynamics: slower from low N1 (classic high-bypass behaviour).
    const tau = this.n1 < 45 ? 2.6 : target > this.n1 ? 1.4 : 1.1;
    this.n1 += (target - this.n1) * expK(dt, tau);
    // Reverser sleeve motion.
    const rTarget = reverseCmd ? 1 : 0;
    this.reverser += clamp(rTarget - this.reverser, -dt / 1.8, dt / 1.8);

    const frac = clamp((this.n1 - 19) / 81, 0, 1.02);
    const lapse = Math.pow(atm.sigma, 0.82) * (1 - 0.9 * mach + 0.55 * mach * mach);
    let t = B739.staticThrust * (0.055 + 0.945 * Math.pow(frac, 1.65)) * lapse;
    if (this.failed || !this.running) t = -2500 * mach; // windmill drag
    // Reverser deflects fan flow forward.
    const revEff = -0.42;
    t *= lerp(1, revEff, this.reverser);
    this.thrust = t;
    this.n2 = 58 + 0.42 * this.n1;
    const egtTarget = this.failed ? 60 : 380 + 520 * Math.pow(frac, 1.4) + (1 - atm.sigma) * 40;
    this.egt += (egtTarget - this.egt) * expK(dt, 3);
    const tsfc = (0.36 + 0.34 * mach) * 2.833e-5; // kg / (N s)
    this.ff = this.failed ? 0 : Math.max(0.09, Math.abs(t) * tsfc);
  }
}

export class Aircraft {
  constructor(terrain, weather) {
    this.terrain = terrain;
    this.weather = weather;
    this.engines = [new Engine(0), new Engine(1)];
    this.controls = {
      pitch: 0, roll: 0, yaw: 0, tiller: 0,
      throttle: [0, 0],
      brakeL: 0, brakeR: 0, parkingBrake: true,
      flapLever: 0, gearDown: true,
      speedbrake: 0, speedbrakeArmed: false,
      reverse: false,
      trim: 0,
      autobrake: 'OFF',
    };
    this.payload = 15000;
    this.fuel = 9000;
    this.reset([0, 0, 0], 0);
  }

  get mass() {
    return B739.oew + this.payload + this.fuel;
  }

  reset(pos, headingDeg, opts = {}) {
    this.pos = pos.slice();
    this.vel = [0, 0, 0];
    this.q = quat.fromEuler(headingDeg * DEG, (opts.pitch || 0) * DEG, 0);
    this.w = [0, 0, 0];
    this.time = 0;
    this.flapPos = this.controls.flapLever;
    this.gearPos = this.controls.gearDown ? 1 : 0;
    this.spoilerPos = 0;
    this.crashed = null;
    this.damage = [];
    this.wow = false;          // any main gear on ground
    this.noseWow = false;
    this.gearLoad = [0, 0, 0];
    this.gearCompression = [0, 0, 0];
    this.airborneTime = 0;
    this.groundTime = 0;
    this.lastTouchdown = null;
    this.touchdownEval = null;
    this.events = [];
    this.tailStrike = false;
    this.autobrakeActive = false;
    this.autobrakePress = 0;
    this.autobrakeDisarmed = false;
    this.rtoTriggered = false;
    this.maxTakeoffSpeed = 0;
    this.spoilersAutoDeployed = false;
    this.surfaceKind = 'runway';
    this.prevGs = 0;
    this.decel = 0;
    this.nz = 1;
    this.peakNz = 1;
    this.stallWarning = false;
    for (const e of this.engines) {
      e.n1 = opts.n1 ?? B739.idleN1Ground;
      e.reverser = 0;
    }
    this.updateDerived(0);
  }

  /** Air data and attitude used by instruments, autopilot and sounds. */
  updateDerived(dt) {
    const atm = isa(this.pos[1], this.weather.isaDev);
    this.atm = atm;
    const surf = this.terrain.surface(this.pos[0], this.pos[2]);
    this.groundH = surf.h;
    this.surfaceKind = surf.kind;
    this.agl = this.pos[1] - surf.h;
    this.wind = this.weather.windAt(this.pos[1], this.agl, this.time);
    const va = v3.sub(this.vel, this.wind);
    const vb = quat.rotateInv(this.q, va);
    const V = v3.len(vb);
    this.tas = V;
    this.alpha = V > 1 ? Math.atan2(-vb[1], vb[0]) : 0;
    this.beta = V > 1 ? Math.asin(clamp(vb[2] / V, -1, 1)) : 0;
    this.mach = V / atm.a;
    this.cas = casFromTas(Math.max(0, vb[0]), atm);
    this.ias = this.cas;
    const e = quat.toEuler(this.q);
    this.heading = e.heading * RAD;
    this.pitch = e.pitch * RAD;
    this.roll = e.roll * RAD;
    this.gs = Math.hypot(this.vel[0], this.vel[2]);
    this.track = this.gs > 1 ? bearingOf(this.vel[0], this.vel[2]) : this.heading;
    this.vs = this.vel[1];
    // Radio altitude: lowest main-gear point above ground (0 when sitting on the runway).
    this.radioAlt = Math.max(0, this.agl - 2.57 - Math.sin(this.pitch * DEG) * 1.2);
    if (dt > 0) {
      const a = (this.gs - this.prevGs) / dt;
      this.decel += (-a - this.decel) * expK(dt, 0.4);
      this.prevGs = this.gs;
    }
  }

  inertia() {
    const r = this.mass / B739.inertiaRef.mass;
    const I = B739.inertiaRef;
    // Body frame axes: x roll, y yaw, z pitch.
    return [I.roll * r, I.yaw * r, I.pitch * r];
  }

  /** Advance the simulation by dt seconds (call with small steps, ~1/240 s). */
  step(dt) {
    if (this.crashed) return;
    this.time += dt;
    const c = this.controls;
    this.updateDerived(dt);
    const atm = this.atm;
    const onGround = this.wow;

    this.updateSystems(dt, onGround);

    // --- Aerodynamics --------------------------------------------------------
    const va = v3.sub(this.vel, this.wind);
    const vb = quat.rotateInv(this.q, va);
    const V = v3.len(vb);
    const Vc = Math.max(V, 15);
    const qbar = 0.5 * atm.rho * V * V;
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
    const clmax = fa.clmax * Math.max(0.5, machLoss);
    const alphaStall = (clmax - fa.cl0) / A.cla;
    this.alphaStall = alphaStall;
    // Ground effect from wing height above ground.
    const hw = Math.max(0, this.agl - 1.6);
    const ge = 1 - smoothstep(0, b * 0.9, hw);
    let CL;
    const lin = fa.cl0 + A.cla * alpha;
    if (alpha <= alphaStall) {
      CL = Math.max(lin, -0.9 + fa.cl0 * 0.2);
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
    let CD = A.cd0 + fa.cd + A.cdGear * this.gearPos + A.cdSpoiler * this.spoilerPos +
      kInd * (CL - 0.08) * (CL - 0.08) + wave + 1.1 * Math.pow(Math.sin(Math.max(0, alpha - alphaStall)), 2) +
      0.25 * beta * beta;
    // Stall buffet / wing drop.
    const stallDepth = alpha - alphaStall;
    this.buffet = clamp((stallDepth + 2.5 * DEG) / (5 * DEG), 0, 1) * smoothstep(20, 50, V);
    this.stallWarning = alpha > alphaStall - 1.6 * DEG && V > 25 && !onGround;
    const wingDrop = stallDepth > 0 ? Math.sin(this.time * 1.3) * 0.012 * smoothstep(0, 4 * DEG, stallDepth) : 0;

    const ail = c.roll * clamp(150 / Math.max(V, 1), 0.45, 1);
    const elevEff = 1 - 0.25 * smoothstep(0, 10 * DEG, stallDepth);
    const rud = c.yaw * clamp(200 / Math.max(V, 1), 0.35, 1);
    const CY = A.cyb * beta + A.cyRud * rud;
    const Cl = A.clb * beta + A.clp * ph + A.clr * rh + A.clAil * ail + A.clRud * rud + wingDrop;
    const Cm = A.cm0 + fa.cm + A.cma * alpha + A.cmq * qh + A.cmElev * c.pitch * elevEff + A.cmTrim * c.trim +
      0.01 * this.spoilerPos - 0.004 * this.gearPos - 0.35 * Math.max(0, stallDepth) - 0.015 * ge;
    const Cn = A.cnb * beta + (A.cnr + A.yawDamper * smoothstep(40, 70, V)) * rh + A.cnp * ph + A.cnAil * ail + A.cnRud * rud;

    const aeroScale = smoothstep(2, 15, V);
    const L = CL * qbar * S * aeroScale;
    const D = CD * qbar * S * aeroScale;
    const Y = CY * qbar * S * aeroScale;
    this.CL = CL;
    this.CD = CD;
    let Fb = [0, 0, 0];
    let Mb = [0, 0, 0];
    if (V > 0.5) {
      const vdir = v3.scale(vb, 1 / V);
      const liftDir = v3.norm(v3.cross([0, 0, 1], vb));
      Fb = v3.add(v3.add(v3.scale(vdir, -D), v3.scale(liftDir, L)), [0, 0, Y]);
      Mb = [
        Cl * qbar * S * b * aeroScale,
        -Cn * qbar * S * b * aeroScale,
        Cm * qbar * S * cbar * aeroScale,
      ];
    }

    // --- Engines -------------------------------------------------------------
    let fuelFlow = 0;
    for (let i = 0; i < 2; i++) {
      const eng = this.engines[i];
      eng.update(dt, c.throttle[i], c.reverse && this.wow, atm, M, onGround);
      fuelFlow += eng.ff;
      const F = [eng.thrust, 0, 0];
      const rr = B739.engineOffsets[i];
      Fb = v3.add(Fb, F);
      Mb = v3.add(Mb, v3.cross(rr, F));
    }
    this.fuel = Math.max(0, this.fuel - fuelFlow * dt);
    if (this.fuel <= 0) for (const e of this.engines) e.running = false;
    this.fuelFlow = fuelFlow;

    // Convert to world.
    let Fw = quat.rotate(this.q, Fb);
    let Mbody = Mb;

    // --- Ground contact ------------------------------------------------------
    const mass = this.mass;
    const contact = this.groundContact(dt, mass);
    Fw = v3.add(Fw, contact.F);
    Mbody = v3.add(Mbody, contact.M);

    // Gravity.
    Fw[1] -= mass * G0;

    // Load factor (specific force along body up).
    const fSpec = quat.rotateInv(this.q, v3.sub(Fw, [0, -mass * G0, 0]));
    this.nz += (fSpec[1] / (mass * G0) - this.nz) * expK(dt, 0.08);

    // --- Integrate -----------------------------------------------------------
    const acc = v3.scale(Fw, 1 / mass);
    this.vel = v3.add(this.vel, v3.scale(acc, dt));
    this.pos = v3.add(this.pos, v3.scale(this.vel, dt));
    const I = this.inertia();
    const Iw = [I[0] * this.w[0], I[1] * this.w[1], I[2] * this.w[2]];
    const gyro = v3.cross(this.w, Iw);
    const wdot = [(Mbody[0] - gyro[0]) / I[0], (Mbody[1] - gyro[1]) / I[1], (Mbody[2] - gyro[2]) / I[2]];
    this.w = v3.add(this.w, v3.scale(wdot, dt));
    this.q = quat.integrate(this.q, this.w, dt);

    // Park the aircraft completely when stopped with brakes set (avoids creeping).
    if (this.wow && this.gs < 0.05 && (c.parkingBrake || c.brakeL > 0.5) && Math.abs(this.w[1]) < 0.01) {
      const maxThr = Math.max(this.engines[0].thrust, this.engines[1].thrust);
      if (maxThr < 40000) {
        this.vel[0] = 0;
        this.vel[2] = 0;
        this.w[1] = 0;
      }
    }
    this.checkLimits();
  }

  updateSystems(dt, onGround) {
    const c = this.controls;
    // Flaps: about 2.5 s per detent.
    this.flapPos += clamp(c.flapLever - this.flapPos, -dt / 2.5, dt / 2.5);
    // Gear: cannot retract with weight on wheels.
    const gearTarget = c.gearDown || this.wow ? 1 : 0;
    if (!c.gearDown && this.wow) c.gearDown = true;
    this.gearPos += clamp(gearTarget - this.gearPos, -dt / 7, dt / 7);

    const thrIdle = c.throttle[0] < 0.08 && c.throttle[1] < 0.08;
    const gs = this.gs;
    // Track takeoff roll for RTO logic.
    if (onGround) this.maxTakeoffSpeed = Math.max(this.maxTakeoffSpeed, gs);
    else this.maxTakeoffSpeed = 0;

    // Auto speedbrake.
    if (c.speedbrakeArmed && onGround && thrIdle && (this.airborneTime > 0 || (gs > 30 && this.rtoTriggered))) {
      c.speedbrake = 1;
      c.speedbrakeArmed = false;
      this.spoilersAutoDeployed = true;
    }
    if (this.spoilersAutoDeployed && !thrIdle && !c.reverse) {
      c.speedbrake = 0;
      this.spoilersAutoDeployed = false;
    }
    // Flight spoilers are limited in the air; full deflection on the ground.
    const sbTarget = onGround ? c.speedbrake : Math.min(c.speedbrake, 0.65);
    this.spoilerPos += clamp(sbTarget - this.spoilerPos, -dt / 1.2, dt / 1.2);

    // Autobrake.
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
      if (onGround && thrIdle && this.airborneTime > 0 && !this.autobrakeDisarmed && gs > 1) {
        this.autobrakeActive = true;
      }
      if (this.autobrakeActive) {
        const target = AUTOBRAKE_DECEL[ab] - (c.reverse ? 0.0 : 0);
        const err = target - this.decel;
        this.autobrakePress = clamp(this.autobrakePress + err * 0.6 * dt, 0, 1);
        abCmd = this.autobrakePress;
        if (gs < 0.5) abCmd = 0.6;
      }
      if (this.autobrakeActive && (c.brakeL > 0.6 || c.brakeR > 0.6 || (!thrIdle && !c.reverse))) {
        this.autobrakeActive = false;
        this.autobrakeDisarmed = true;
        c.autobrake = 'OFF';
        this.events.push({ type: 'autobrakeDisarm' });
      }
    }
    if (!onGround && ab !== 'RTO') {
      this.autobrakeDisarmed = false;
    }
    this.autobrakeCmd = abCmd;
  }

  groundContact(dt, mass) {
    const c = this.controls;
    let F = [0, 0, 0];
    let Mb = [0, 0, 0];
    const gearDown = this.gearPos > 0.97;
    let mainContact = false;
    let noseContact = false;
    const gsKt = this.gs / KT;
    // Nose wheel steering: tiller authority at low speed, rudder pedals (+/-7 deg) at speed.
    const steerAuth = lerp(70, 7, smoothstep(5, 35, gsKt));
    const steer = clamp(c.yaw + c.tiller, -1, 1) * steerAuth * DEG;

    for (let i = 0; i < B739.gear.length; i++) {
      const g = B739.gear[i];
      this.gearLoad[i] = 0;
      this.gearCompression[i] = 0;
      if (!gearDown) continue;
      const pw = v3.add(this.pos, quat.rotate(this.q, g.p));
      const surf = this.terrain.surface(pw[0], pw[2]);
      const pen = surf.h - pw[1];
      if (pen <= 0) continue;
      if (surf.water) {
        this.crash('Ditched in water');
        return { F, M: Mb };
      }
      const rArm = quat.rotate(this.q, g.p);
      const vp = v3.add(this.vel, quat.rotate(this.q, v3.cross(this.w, g.p)));
      const compRate = -vp[1];
      let N = g.k * pen + g.c * compRate;
      if (pen > B739.maxStroke) N += (pen - B739.maxStroke) * g.k * 12;
      N = Math.max(0, N);
      this.gearLoad[i] = N;
      this.gearCompression[i] = pen;
      if (g.name === 'nose') noseContact = true;
      else mainContact = true;

      const s = g.steer ? steer : 0;
      const fwdB = [Math.cos(s), 0, Math.sin(s)];
      let fw = quat.rotate(this.q, fwdB);
      fw = v3.norm([fw[0], 0, fw[2]]);
      const side = [-fw[2], 0, fw[0]];
      const vl = v3.dot(vp, fw);
      const vs = v3.dot(vp, side);
      const paved = surf.kind === 'runway';
      const muRoll = paved ? 0.016 : 0.07;
      let brake = 0;
      if (g.brake) {
        const manual = g.brake === 'L' ? c.brakeL : c.brakeR;
        brake = Math.max(manual, this.autobrakeCmd || 0, c.parkingBrake ? 1 : 0);
      }
      const muBrake = (paved ? 0.52 : 0.3) * brake;
      const muLat = paved ? 0.75 : 0.45;
      let Fl = -(muRoll + muBrake) * N * clamp(vl / 0.3, -1, 1);
      let Fs = -muLat * N * clamp(vs / 0.25, -1, 1);
      const cap = (paved ? 0.85 : 0.55) * N;
      const mag = Math.hypot(Fl, Fs);
      if (mag > cap) {
        Fl *= cap / mag;
        Fs *= cap / mag;
      }
      const Fg = [fw[0] * Fl + side[0] * Fs, N, fw[2] * Fl + side[2] * Fs];
      F = v3.add(F, Fg);
      Mb = v3.add(Mb, quat.rotateInv(this.q, v3.cross(rArm, Fg)));
    }

    // Structural contact points: tail strike, belly, nacelles and wingtips.
    this.tailStrike = false;
    for (const sp of B739.structure) {
      if (sp.kind === 'belly' && gearDown) continue;
      const pw = v3.add(this.pos, quat.rotate(this.q, sp.p));
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
        if (!this._tailStrikeLogged) {
          this.events.push({ type: 'tailstrike' });
          this.damage.push('Tail strike');
          this._tailStrikeLogged = true;
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
      // Scrape: stiff spring + sliding friction.
      const rArm = quat.rotate(this.q, sp.p);
      const N = Math.max(0, 4e6 * pen - 4e5 * vp[1]);
      const hv = Math.hypot(vp[0], vp[2]) || 1;
      const Fg = [-vp[0] / hv * N * 0.4, N, -vp[2] / hv * N * 0.4];
      F = v3.add(F, Fg);
      Mb = v3.add(Mb, quat.rotateInv(this.q, v3.cross(rArm, Fg)));
    }
    // Wheels-up or gear in transit contacting the ground at speed.
    if (!gearDown && this.agl < 1.0 && this.gs > 10) {
      const pw = this.pos;
      const surf = this.terrain.surface(pw[0], pw[2]);
      if (pw[1] - surf.h < 1.8) this.crash(this.gearPos < 0.5 ? 'Gear-up landing' : 'Gear collapsed');
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
      this._tailStrikeLogged = false;
    }
    if (this.touchdownEval) this.evaluateTouchdown(dt);
    return { F, M: Mb };
  }

  beginTouchdown() {
    this.touchdownEval = {
      t: 0,
      vs: this.vel[1] / FPM,
      ias: this.ias / KT,
      pitch: this.pitch,
      roll: this.roll,
      crab: wrap180(this.heading - this.track),
      peakG: this.nz,
      pos: this.pos.slice(),
    };
  }

  evaluateTouchdown(dt) {
    const td = this.touchdownEval;
    td.t += dt;
    td.peakG = Math.max(td.peakG, this.nz);
    if (td.t < 0.6) return;
    this.touchdownEval = null;
    if (td.vs < -1400 || td.peakG > 2.9) {
      this.crash('Hard landing: structural failure');
    } else if (td.vs < -600 || td.peakG > 2.0) {
      this.damage.push('Hard landing');
    }
    this.lastTouchdown = td;
    this.events.push({ type: 'touchdown', data: td });
  }

  checkLimits() {
    if (this.nz > 4.0 || this.nz < -2.0) this.crash('Structural failure (g-load)');
    if (this.ias > (B739.vmo + 75) * KT) this.crash('Structural failure (overspeed)');
    // Terrain impact while airborne (e.g. hitting a hillside at speed).
    if (!this.wow && this.agl < 0.5 && this.surfaceKind !== 'runway' && this.gearPos < 0.97) {
      this.crash('Impact with terrain');
    }
  }

  crash(reason) {
    if (this.crashed) return;
    this.crashed = reason;
    this.vel = [0, 0, 0];
    this.w = [0, 0, 0];
    this.events.push({ type: 'crash', reason });
  }

  // --- Helpers used by the scenario setup ---------------------------------

  /** Place the aircraft on the ground at (x,z) and let the gear settle. */
  placeOnGround(x, z, headingDeg) {
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

  /**
   * Initialise trimmed flight at a calibrated airspeed (kt), flight path angle (deg),
   * altitude (m) and heading. Solves for alpha, stab trim and thrust.
   */
  setTrimmedFlight(pos, headingDeg, casKt, gammaDeg, cfg = {}) {
    const c = this.controls;
    if (cfg.flaps !== undefined) c.flapLever = cfg.flaps;
    if (cfg.gearDown !== undefined) c.gearDown = cfg.gearDown;
    c.parkingBrake = false;
    c.speedbrake = 0;
    this.reset(pos, headingDeg);
    this.flapPos = c.flapLever;
    this.gearPos = c.gearDown ? 1 : 0;
    const atm = isa(pos[1], this.weather.isaDev);
    // Find TAS for the requested CAS.
    let tas = casKt * KT;
    for (let i = 0; i < 20; i++) tas *= (casKt * KT) / casFromTas(tas, atm);
    const gamma = gammaDeg * DEG;
    const W = this.mass * G0;
    const qbar = 0.5 * atm.rho * tas * tas;
    const fa = flapAero(this.flapPos);
    const M = tas / atm.a;
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
    // Thrust pitching moment from the engines below the CG.
    const thrustMoment = 0.7 * thrust; // N*m (engines 0.7 m below CG)
    c.trim -= thrustMoment / (qbar * B739.wingArea * B739.chord * A.cmTrim);
    c.trim = clamp(c.trim, -1, 1);
    const pitch = alpha + gamma;
    const wind = this.weather.windAt(pos[1], 1000, 0);
    this.q = quat.fromEuler(headingDeg * DEG, pitch, 0);
    const fwd = [Math.sin(headingDeg * DEG) * Math.cos(gamma), Math.sin(gamma), -Math.cos(headingDeg * DEG) * Math.cos(gamma)];
    this.vel = v3.add(v3.scale(fwd, tas), wind);
    // Throttle setting that produces the trim thrust.
    const per = Math.max(0, thrust / 2);
    const lapse = Math.pow(atm.sigma, 0.82) * (1 - 0.9 * M + 0.55 * M * M);
    const frac = Math.pow(clamp((per / (B739.staticThrust * lapse) - 0.055) / 0.945, 0, 1), 1 / 1.65);
    const n1 = 19 + frac * 81;
    const tla = clamp((n1 - B739.idleN1Flight) / (100.5 - B739.idleN1Flight), 0, 1);
    c.throttle = [tla, tla];
    for (const e of this.engines) e.n1 = Math.max(n1, B739.idleN1Flight);
    this.airborneTime = 30;
    this.wow = false;
    this.updateDerived(0);
    return { alpha: alpha * RAD, tla, trim: c.trim };
  }
}

