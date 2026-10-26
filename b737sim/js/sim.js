// Simulation session: ties together the flight model, autopilot, flight plan,
// warnings and callouts. Has no browser dependencies.
import { clamp, wrap180, wrap360, DEG, RAD, KT, FT, FPM, NM } from './math.js';
import { Weather } from './atmosphere.js';
import { NavDatabase, FlightPlan, routeDistanceNm } from './navigation.js';
import { TerrainModel } from './terrain.js';
import { Aircraft } from './fdm.js';
import { Autopilot } from './autopilot.js';
import { B739, vSpeeds, FLAP_NAMES } from './aircraftData.js';

export const PHYSICS_HZ = 240;

export const DEFAULT_OPTIONS = {
  dep: 'KSEA', depRwy: '16L', arr: 'KPDX', arrRwy: '10R',
  start: 'runway', pax: 160, fuel: 9000, cruiseAlt: 33000,
  windDir: 160, windSpeed: 8, gust: 0, turbulence: 0, visibility: 60, clouds: 'scattered', cloudBase: 4500,
  hour: 13, autoTrim: true, apOnApproach: true,
};

export class Simulation {
  constructor(options = {}) {
    const o = { ...DEFAULT_OPTIONS, ...options };
    this.options = o;
    this.nav = new NavDatabase(o.dep);
    this.depAirport = this.nav.airport(o.dep);
    this.arrAirport = this.nav.airport(o.arr) || this.depAirport;
    this.weather = new Weather(o);
    this.depEnd = this.depAirport.end(o.depRwy) || this.depAirport.bestEnd(o.windDir);
    this.arrEnd = this.arrAirport.end(o.arrRwy) || this.arrAirport.bestEnd(o.windDir);
    this.terrain = new TerrainModel(this.nav.proj, this.nav.airports);
    this.ac = new Aircraft(this.terrain, this.weather);
    this.ac.payload = clamp(o.pax, 0, B739.maxPax) * B739.paxMass;
    this.ac.fuel = clamp(o.fuel, 1000, B739.maxFuel);
    this.plan = new FlightPlan(this.depEnd, this.arrEnd, o.cruiseAlt);
    this.ap = new Autopilot(this.ac);
    this.ap.plan = this.plan;
    this.ap.approach = this.arrEnd;
    this.ap.magVar = this.depAirport.magVar;
    this.assists = { autoTrim: o.autoTrim };
    this.paused = false;
    this.timeScale = 1;
    this.elapsed = 0;
    this.warnings = new Warnings(this);
    this.messages = [];
    this.landingReports = [];
    this.flightLog = { maxAlt: 0, distance: 0, fuelStart: this.ac.fuel };
    this.pilot = { pitch: 0, roll: 0, yaw: 0 };
    this.setupStart(o.start);
  }

  get vspeeds() {
    const ac = this.ac;
    const toFlap = clamp(Math.round(ac.controls.flapLever), 1, 6);
    return vSpeeds(ac.mass, this.takeoffFlap ?? toFlap, ac.mass);
  }

  setupStart(kind) {
    const ac = this.ac;
    const ap = this.ap;
    const c = ac.controls;
    const o = this.options;
    this.startKind = kind;
    ap.mcp.alt = Math.round(o.cruiseAlt / 1000) * 1000;
    if (kind === 'runway') {
      const end = this.depEnd;
      const [x, z] = end.pointOnFinal(-45);
      c.flapLever = 3; // flaps 5
      this.takeoffFlap = 3;
      c.gearDown = true;
      c.speedbrake = 0;
      c.speedbrakeArmed = false;
      c.autobrake = 'RTO';
      c.throttle = [0, 0];
      ac.placeOnGround(x, z, end.heading);
      c.trim = this.takeoffTrim();
      const vs = this.vspeeds;
      ap.mcp.spd = vs.v2;
      ap.mcp.hdg = Math.round(end.magHeading);
      ap.atArm = true;
      ap.at = 'ARM';
      ap.fd = true;
      this.message(`Ready for departure ${end.name}. V1 ${vs.v1}  VR ${vs.vr}  V2 ${vs.v2}`);
    } else if (kind === 'approach' || kind === 'final') {
      const end = this.arrEnd;
      const final = kind === 'final';
      const dist = final ? 5 * NM : 13 * NM;
      const [x, z] = end.pointOnFinal(dist);
      const gsH = (dist + 300) * Math.tan(end.gsAngle * DEG);
      const alt = end.elev + (final ? gsH : Math.min(gsH - 180, 3000 * FT));
      const flaps = final ? 7 : 3;
      const vref = vSpeeds(ac.mass, 3, ac.mass).vref30;
      const spd = final ? vref + 5 : 190;
      const gamma = final ? -end.gsAngle : 0;
      ac.setTrimmedFlight([x, alt, z], end.heading, spd, gamma, { flaps, gearDown: final });
      c.autobrake = '2';
      c.speedbrakeArmed = final;
      this.plan.active = this.plan.waypoints.length - (final ? 1 : 2);
      ap.mcp.spd = spd;
      ap.mcp.hdg = Math.round(end.magHeading);
      ap.mcp.alt = Math.round((end.elev / FT + 3000) / 100) * 100;
      ap.atArm = true;
      ap.at = 'MCP SPD';
      if (!final && o.apOnApproach) {
        ap.engage(true);
        ap.setLat('VOR/LOC');
        ap.altHold();
        ap.app();
        this.message(`Established on the ${end.name} localizer. APP armed - configure for landing.`);
      } else {
        ap.atArm = false;
        ap.at = null;
        this.message(`Short final ${end.name}. Flaps 30, gear down, Vref ${vref}. Hand-fly it!`);
      }
    } else if (kind === 'cruise') {
      const plan = this.plan;
      const total = plan.remaining(this.depEnd.tx, this.depEnd.tz);
      const fromDest = Math.min(140 * NM, total * 0.5);
      // Walk back along the route from the destination.
      const wps = plan.waypoints;
      let remaining = fromDest;
      let px = 0;
      let pz = 0;
      let hdg = 0;
      let idx = wps.length - 1;
      for (let i = wps.length - 1; i > 0; i--) {
        const a = wps[i - 1];
        const b = wps[i];
        const seg = Math.hypot(b.x - a.x, b.z - a.z);
        if (seg >= remaining || i === 1) {
          const t = clamp(1 - remaining / seg, 0, 1);
          px = a.x + (b.x - a.x) * t;
          pz = a.z + (b.z - a.z) * t;
          hdg = wrap360(Math.atan2(b.x - a.x, -(b.z - a.z)) * RAD);
          idx = i;
          break;
        }
        remaining -= seg;
      }
      const altFt = Math.min(o.cruiseAlt, Math.max(12000, (fromDest / NM) * 250));
      const useMach = altFt > 26000;
      const spd = useMach ? 280 : 280;
      c.gearDown = false;
      c.flapLever = 0;
      if (useMach) {
        ac.setTrimmedFlight([px, altFt * FT, pz], hdg, 270, 0, { flaps: 0, gearDown: false });
      } else {
        ac.setTrimmedFlight([px, altFt * FT, pz], hdg, spd, 0, { flaps: 0, gearDown: false });
      }
      plan.active = idx;
      ap.mcp.alt = Math.round(altFt / 100) * 100;
      ap.mcp.spd = 280;
      ap.mcp.mach = 0.78;
      ap.mcp.useMach = useMach;
      ap.mcp.hdg = Math.round(wrap360(hdg - ap.magVar));
      ap.atArm = true;
      ap.engage(true);
      ap.setLat('LNAV');
      ap.altHold();
      c.autobrake = '2';
      this.message(`Cruising at FL${Math.round(altFt / 100)}, ${Math.round(fromDest / NM)} nm from ${this.arrAirport.icao}. Plan your descent.`);
    }
    this.pilot = { pitch: 0, roll: 0, yaw: 0 };
  }

  /** Stabilizer trim for takeoff from CG/weight (returns -1..1 control units). */
  takeoffTrim() {
    return clamp(0.18 + (this.ac.mass - 65000) / 60000, -0.2, 0.6);
  }

  message(text, kind = 'info') {
    this.messages.push({ text, kind, t: this.elapsed });
  }

  /**
   * Advance the simulation by a frame.
   * pilot: { pitch, roll, yaw, tiller, brakeL, brakeR } from the input devices.
   */
  update(frameDt, pilot) {
    if (this.paused || this.ac.crashed || !(frameDt > 0)) return;
    const dt = Math.min(frameDt, 0.1) * this.timeScale;
    const n = Math.max(1, Math.ceil(dt * PHYSICS_HZ));
    const h = dt / n;
    const ac = this.ac;
    const c = ac.controls;
    const ap = this.ap;
    this.pilot = pilot;
    // Pilot overriding the autopilot.
    if (ap.cmd && (Math.abs(pilot.pitch) > 0.4 || Math.abs(pilot.roll) > 0.4)) {
      ap.disconnect('override');
    }
    for (let i = 0; i < n; i++) {
      if (!ap.cmd) {
        c.pitch = pilot.pitch;
        c.roll = pilot.roll;
      }
      if (!(ap.cmd && ap.lat === 'ROLLOUT')) c.yaw = pilot.yaw;
      // Like Infinite Flight, the roll input also steers the nosewheel while on the ground.
      c.tiller = pilot.tiller || (ac.wow && ac.gs < 40 * KT ? pilot.roll * 0.6 : 0);
      c.brakeL = pilot.brakeL || 0;
      c.brakeR = pilot.brakeR || 0;
      ap.update(h);
      if (!ap.cmd) this.manualAssists(h);
      ac.step(h);
      this.elapsed += h;
      if (ac.crashed) break;
    }
    this.flightLog.maxAlt = Math.max(this.flightLog.maxAlt, ac.pos[1]);
    this.flightLog.distance += ac.gs * dt;
    this.warnings.update(dt);
    this.processEvents();
  }

  manualAssists(dt) {
    const ac = this.ac;
    const c = ac.controls;
    // Auto-trim: with the column near neutral, the stabilizer trims out pitch rate.
    if (this.assists.autoTrim && !ac.wow && ac.ias > 90 * KT && Math.abs(c.pitch) < 0.06 && Math.abs(ac.roll) < 50) {
      const q = ac.w[2];
      c.trim = clamp(c.trim - q * 2.2 * dt, -1, 1);
    }
  }

  processEvents() {
    const ac = this.ac;
    for (const e of ac.events) {
      if (e.type === 'touchdown') this.onTouchdown(e.data);
      if (e.type === 'crash') this.message(`CRASH: ${e.reason}`, 'crash');
      if (e.type === 'tailstrike') this.message('Tail strike!', 'warn');
      if (e.type === 'autobrakeDisarm') this.message('Autobrake disarmed', 'info');
    }
    ac.events.length = 0;
    for (const e of this.ap.events) {
      if (e === 'apDisconnect') this.warnings.trigger('apDisconnect');
      if (e === 'apOverride') this.message('Autopilot disconnected by control input', 'warn');
      if (e === 'atDisconnect') this.warnings.trigger('atDisconnect');
      if (e === 'locCapture') this.message('LOC captured', 'info');
      if (e === 'gsCapture') this.message('G/S captured', 'info');
      if (e === 'goAround') this.message('Go-around!', 'warn');
    }
    this.ap.events.length = 0;
  }

  onTouchdown(td) {
    const ac = this.ac;
    // Find the runway end we landed on.
    let best = null;
    let bestScore = Infinity;
    for (const a of this.nav.near(td.pos[0], td.pos[2], 8000)) {
      for (const e of a.ends) {
        const ils = e.ils(td.pos[0], td.pos[1], td.pos[2]);
        const hdgErr = Math.abs(wrap180(ac.heading - e.heading));
        if (hdgErr > 60) continue;
        const score = Math.abs(ils.xtk) + hdgErr * 10;
        if (score < bestScore && ils.along < 200 && ils.along > -e.runway.length) {
          bestScore = score;
          best = { end: e, ils };
        }
      }
    }
    const vs = td.vs;
    let grade;
    if (vs > -60) grade = 'Butter!';
    else if (vs > -180) grade = 'Smooth';
    else if (vs > -360) grade = 'Firm';
    else if (vs > -600) grade = 'Hard';
    else grade = 'Very hard';
    const report = {
      grade,
      vs: Math.round(vs),
      g: td.peakG.toFixed(2),
      ias: Math.round(td.ias),
      pitch: td.pitch.toFixed(1),
      roll: td.roll.toFixed(1),
      crab: td.crab.toFixed(1),
      runway: best ? best.end.name : 'off-runway',
      fromThreshold: best ? Math.round(-best.ils.along / FT) : null,
      centerline: best ? Math.round(best.ils.xtk / FT) : null,
    };
    this.landingReports.push(report);
    this.message(`Touchdown: ${grade} ${report.vs} fpm, ${report.g} g`, 'landing');
  }

  // --- Info used by the HUD/top bar ------------------------------------------
  routeInfo() {
    const ac = this.ac;
    const rem = this.plan.remaining(ac.pos[0], ac.pos[2]);
    const wp = this.plan.activeWp;
    const gs = Math.max(ac.gs, 60);
    return {
      remainingNm: rem / NM,
      ete: rem / gs,
      nextWp: wp ? wp.name : '',
      nextDist: wp ? Math.hypot(wp.x - ac.pos[0], wp.z - ac.pos[2]) / NM : 0,
      todNm: Math.max(0, rem / NM - ((ac.pos[1] - this.arrEnd.elev) / FT / 1000) * 3.2),
    };
  }

  static routeDistance(dep, arr) {
    return routeDistanceNm(dep, arr);
  }
}

/** Aural and visual warnings: GPWS, stall, overspeed, config, callouts. */
export class Warnings {
  constructor(sim) {
    this.sim = sim;
    this.active = new Set();
    this.queue = [];      // callouts / one-shot sounds for the audio system
    this.prevRa = 1e9;
    this.calls = new Set();
    this.raRate = 0;
    this.masterCaution = false;
    this.cooldown = {};
    this.v1Called = false;
    this.rotateCalled = false;
    this.eightyCalled = false;
    this.posRateCalled = false;
  }

  trigger(name) {
    this.queue.push(name);
  }

  say(name, cooldown = 4) {
    const t = this.sim.elapsed;
    if (this.cooldown[name] && t - this.cooldown[name] < cooldown) return;
    this.cooldown[name] = t;
    this.queue.push(name);
  }

  update(dt) {
    const sim = this.sim;
    const ac = sim.ac;
    const c = ac.controls;
    const raFt = ac.radioAlt / FT;
    const vsFpm = ac.vs / FPM;
    const iasKt = ac.ias / KT;
    const act = new Set();
    if (dt > 0) this.raRate += ((raFt - this.prevRa) / dt * 60 - this.raRate) * Math.min(1, dt * 2);

    // Stall warning (stick shaker).
    if (ac.stallWarning) act.add('stall');
    // Overspeed.
    const flapLimit = B739.flaps[Math.round(ac.flapPos)].vfe;
    if (iasKt > B739.vmo + 2 || ac.mach > B739.mmo + 0.005 || (ac.flapPos > 0.2 && iasKt > flapLimit + 3) ||
      (ac.gearPos > 0.05 && iasKt > 275)) act.add('overspeed');
    // Takeoff configuration.
    if (ac.wow && Math.max(c.throttle[0], c.throttle[1]) > 0.6 && iasKt < 100) {
      const flapOk = c.flapLever >= 1 && c.flapLever <= 6 && Math.abs(ac.flapPos - c.flapLever) < 0.1;
      if (!flapOk || c.speedbrake > 0.05 || c.parkingBrake || c.trim < -0.3 || c.trim > 0.75) act.add('config');
    }
    if (!ac.wow && ac.airborneTime > 5) {
      // GPWS mode 1: excessive descent rate.
      if (raFt < 2500 && raFt > 30) {
        if (vsFpm < -(1600 + raFt * 1.6)) act.add('pullup');
        else if (vsFpm < -(1100 + raFt * 1.1)) act.add('sinkrate');
      }
      // Mode 2: terrain closure.
      if (raFt < 1800 && raFt > 50 && this.raRate < -4500 && ac.gearPos < 0.5) act.add('terrain');
      // Mode 4: unsafe terrain clearance.
      if (raFt < 500 && raFt > 30 && ac.gearPos < 0.9 && iasKt < 190 && vsFpm < 0) act.add('toolowgear');
      else if (raFt < 245 && raFt > 30 && ac.flapPos < 5.5 && ac.gearPos > 0.9 && vsFpm < 0 && iasKt < 160) act.add('toolowflaps');
      // Mode 5: below glide slope.
      const ap = sim.ap;
      if (ap.approach && raFt < 1000 && raFt > 50 && ac.gearPos > 0.9) {
        const ils = ap.approach.ils(ac.pos[0], ac.pos[1], ac.pos[2]);
        if (ils.along > 0 && ils.along < 15 * NM && Math.abs(ils.locDev) < 2.5 && ils.gsDev < -0.45) act.add('glideslope');
      }
      // Bank angle.
      if (Math.abs(ac.roll) > 35 + (raFt > 2500 ? 5 : 0)) act.add('bankangle');
    }
    // Altitude callouts on approach.
    if (!ac.wow && ac.airborneTime > 10 && vsFpm < -100) {
      for (const h of [2500, 1000, 500, 100, 50, 40, 30, 20, 10]) {
        if (this.prevRa > h && raFt <= h && !this.calls.has(h)) {
          this.calls.add(h);
          this.queue.push(`ra${h}`);
        }
      }
      const da = 200;
      if (this.prevRa > da && raFt <= da && !this.calls.has('min')) {
        this.calls.add('min');
        this.queue.push('minimums');
      }
      if (raFt < 25 && raFt > 3 && Math.max(c.throttle[0], c.throttle[1]) > 0.12 && !this.calls.has('retard')) {
        this.calls.add('retard');
        this.queue.push('retard');
      }
    }
    if (raFt > 3000) this.calls.clear();
    // Takeoff callouts.
    if (ac.wow && ac.groundTime > 1) {
      const vs = sim.vspeeds;
      if (iasKt > 80 && !this.eightyCalled && c.throttle[0] > 0.5) {
        this.eightyCalled = true;
        this.queue.push('eighty');
      }
      if (iasKt > vs.v1 && !this.v1Called && c.throttle[0] > 0.5) {
        this.v1Called = true;
        this.queue.push('v1');
      }
      if (iasKt > vs.vr && !this.rotateCalled && c.throttle[0] > 0.5) {
        this.rotateCalled = true;
        this.queue.push('rotate');
      }
      if (iasKt < 40) {
        this.v1Called = false;
        this.rotateCalled = false;
        this.eightyCalled = false;
        this.posRateCalled = false;
      }
    }
    if (!ac.wow && ac.airborneTime > 1 && ac.airborneTime < 15 && vsFpm > 300 && !this.posRateCalled && this.rotateCalled) {
      this.posRateCalled = true;
      this.queue.push('positiverate');
    }
    this.prevRa = raFt;

    // Repeat voice warnings while active.
    const voice = { pullup: 'pullup', sinkrate: 'sinkrate', terrain: 'terrain', toolowgear: 'toolowgear',
      toolowflaps: 'toolowflaps', glideslope: 'glideslope', bankangle: 'bankangle', config: 'config' };
    for (const k of act) if (voice[k]) this.say(voice[k], k === 'config' ? 3 : 2.5);
    this.active = act;
    this.masterCaution = act.size > 0;
  }
}

export { FLAP_NAMES };
