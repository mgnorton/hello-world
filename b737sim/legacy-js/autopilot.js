// 737NG-style Autopilot Flight Director System (AFDS) and Autothrottle.
// Roll modes:  HDG SEL, HDG HOLD, LNAV, VOR/LOC, ROLLOUT, TO/GA
// Pitch modes: ALT HOLD, ALT ACQ, V/S, MCP SPD (level change), G/S, FLARE, TO/GA
// A/T modes:   MCP SPD, N1, RETARD, ARM, THR HLD
import { clamp, wrap180, wrap360, DEG, RAD, KT, FT, FPM, G0, expK, bearingOf } from './math.js';
import { casFromMach } from './atmosphere.js';

const CLB_TLA = 0.94;
const TO_TLA = 1.0;
const GA_TLA = 0.9;

export class Autopilot {
  constructor(ac) {
    this.ac = ac;
    this.plan = null;
    this.approach = null; // RunwayEnd used for APP / LOC
    this.magVar = 0;
    this.mcp = { spd: 250, mach: 0.78, useMach: false, hdg: 0, alt: 10000, vs: 0 };
    this.cmd = false;
    this.fd = true;
    this.atArm = false;
    this.lat = null;
    this.latArmed = null;
    this.vert = null;
    this.vertArmed = null;
    this.at = null;
    this.holdTrack = 0;
    this.pitchCmd = 0;
    this.bankCmd = 0;
    this.accel = 0;
    this.prevIas = 0;
    this.acqVs = 0;
    this.events = [];
    this.fdPitch = 0;
    this.fdRoll = 0;
    this.autoland = false;
    this.lastLocData = null;
    this.tune = { aDes: 0.08, spdGain: 1.0, accelTau: 0.8, gammaP: 2.5 };
  }

  get magHeading() {
    return wrap360(this.ac.heading - this.magVar);
  }

  // --- Mode selection (MCP buttons) ---------------------------------------

  engage(on = !this.cmd) {
    const ac = this.ac;
    if (on && ac.wow) return; // AP cannot be engaged on the ground
    if (on && !this.cmd) {
      this.cmd = true;
      this.pitchCmd = ac.pitch;
      if (!this.lat || this.lat === 'TO/GA') this.setLat('HDG HOLD');
      if (!this.vert || this.vert === 'TO/GA') {
        if (Math.abs(ac.vs) < 400 * FPM) this.altHold();
        else this.setVS(Math.round(ac.vs / FPM / 100) * 100);
      }
    } else if (!on && this.cmd) {
      this.cmd = false;
      this.events.push('apDisconnect');
    }
  }

  disconnect(reason = 'manual') {
    if (this.cmd) {
      this.cmd = false;
      this.events.push('apDisconnect');
      if (reason !== 'manual') this.events.push('apOverride');
    }
    if (this.vert === 'FLARE' || this.lat === 'ROLLOUT') {
      this.lat = null;
      this.vert = null;
    }
  }

  toggleAT() {
    this.atArm = !this.atArm;
    if (this.atArm) this.at = this.ac.wow ? 'ARM' : 'MCP SPD';
    else {
      this.at = null;
      this.events.push('atDisconnect');
    }
  }

  setLat(mode) {
    const ac = this.ac;
    this.lat = mode;
    if (mode === 'HDG HOLD') this.holdTrack = ac.track;
    if (mode === 'LNAV' && this.plan) this.plan.syncTo(ac.pos[0], ac.pos[2], ac.track);
    if (mode === this.latArmed) this.latArmed = null;
  }

  hdgSel() {
    if (this.lat === 'HDG SEL') this.setLat('HDG HOLD');
    else this.setLat('HDG SEL');
  }

  lnav() {
    if (!this.plan) return;
    if (this.lat === 'LNAV') this.setLat('HDG HOLD');
    else this.setLat('LNAV');
  }

  loc() {
    if (!this.approach) return;
    if (this.lat === 'VOR/LOC' || this.latArmed === 'VOR/LOC') {
      this.latArmed = null;
      if (this.lat === 'VOR/LOC') this.setLat('HDG HOLD');
    } else this.latArmed = 'VOR/LOC';
  }

  app() {
    if (!this.approach) return;
    if (this.vertArmed === 'G/S' || this.vert === 'G/S') {
      this.vertArmed = null;
      if (this.latArmed === 'VOR/LOC') this.latArmed = null;
      if (this.vert === 'G/S') this.altHold();
      return;
    }
    if (this.lat !== 'VOR/LOC') this.latArmed = 'VOR/LOC';
    this.vertArmed = 'G/S';
  }

  altHold() {
    this.vert = 'ALT HOLD';
    this.holdAlt = this.ac.pos[1];
    if (Math.abs(this.ac.pos[1] - this.mcp.alt * FT) < 40 * FT) this.holdAlt = this.mcp.alt * FT;
    this.speedAT();
  }

  setVS(fpm) {
    this.vert = 'V/S';
    this.mcp.vs = fpm ?? Math.round(this.ac.vs / FPM / 100) * 100;
    this.speedAT();
  }

  lvlChg() {
    const ac = this.ac;
    this.vert = 'MCP SPD';
    this.gammaCmd = Math.asin(clamp(ac.vs / Math.max(ac.tas, 50), -0.3, 0.3));
    if (this.atArm) {
      const climb = this.mcp.alt * FT > ac.pos[1];
      this.at = climb ? 'N1' : 'RETARD';
    }
  }

  toga() {
    const ac = this.ac;
    if (ac.wow) {
      // Takeoff: FD pitch command, A/T to takeoff N1.
      this.lat = 'TO/GA';
      this.vert = 'TO/GA';
      this.holdTrack = ac.heading;
      if (this.atArm) this.at = 'N1';
      this.toThrust = TO_TLA;
    } else {
      // Go-around.
      this.lat = 'TO/GA';
      this.vert = 'TO/GA';
      this.latArmed = null;
      this.vertArmed = null;
      this.holdTrack = ac.track;
      this.toThrust = GA_TLA;
      if (this.atArm) this.at = 'N1';
      this.autoland = false;
      this.events.push('goAround');
    }
  }

  speedAT() {
    if (this.atArm && this.at !== 'THR HLD') this.at = 'MCP SPD';
  }

  /** Target IAS in m/s from the MCP (handles Mach). */
  targetIas() {
    if (this.mcp.useMach) return casFromMach(this.mcp.mach, this.ac.atm);
    return this.mcp.spd * KT;
  }

  // --- Main update -----------------------------------------------------------

  update(dt) {
    const ac = this.ac;
    const c = ac.controls;
    const ias = ac.ias;
    const a = (ias - this.prevIas) / Math.max(dt, 1e-3);
    this.prevIas = ias;
    this.accel += (a - this.accel) * expK(dt, this.tune.accelTau);

    // Automatic IAS / Mach changeover.
    if (!this.mcp.useMach && ac.pos[1] > 24000 * FT && ac.mach >= this.mcp.mach - 0.002 && ac.vs > 0) {
      this.mcp.useMach = true;
    } else if (this.mcp.useMach && ac.vs < 0 && casFromMach(this.mcp.mach, ac.atm) >= this.mcp.spd * KT) {
      this.mcp.useMach = false;
    }

    this.updateArmed();
    const bank = this.lateralCommand(dt);
    const pitch = this.verticalCommand(dt);
    this.bankCmd = bank;
    this.pitchTarget = pitch;
    this.fdRoll = clamp(bank - ac.roll, -20, 20);
    this.fdPitch = pitch === null ? 0 : clamp(pitch - ac.pitch, -12, 12);

    if (this.cmd) {
      if (bank !== null && this.lat !== 'ROLLOUT') {
        const p = ac.w[0] * RAD;
        c.roll = clamp(0.055 * (bank - ac.roll) - 0.03 * p, -0.65, 0.65);
      }
      if (pitch !== null) this.pitchLoop(dt, pitch);
      if (this.lat === 'ROLLOUT') this.rollout(dt);
    }
    this.autothrottle(dt);
  }

  pitchLoop(dt, pitch) {
    const ac = this.ac;
    const c = ac.controls;
    const q = ac.w[2] * RAD;
    const err = pitch - ac.pitch;
    const elev = clamp(0.11 * err - 0.42 * q, -0.55, 0.65);
    c.pitch = elev;
    // Automatic stab trim offloads the elevator (provides the integral action).
    if (!ac.wow) c.trim = clamp(c.trim + clamp(elev * 0.4, -0.08, 0.08) * dt, -1, 1);
  }

  rollout(dt) {
    const ac = this.ac;
    const c = ac.controls;
    const ils = this.approach.ils(ac.pos[0], ac.pos[1], ac.pos[2]);
    const hErr = wrap180(ac.heading - this.approach.heading);
    const r = -ac.w[1] * RAD;
    c.yaw = clamp(-0.12 * hErr - 0.012 * ils.xtk - 0.3 * r, -1, 1);
    c.roll = clamp(-0.05 * ac.roll, -0.3, 0.3);
    c.pitch = ac.noseWow ? 0 : clamp(0.08 * (0 - ac.pitch) - 0.3 * ac.w[2] * RAD, -0.3, 0.2);
    void dt;
  }

  updateArmed() {
    const ac = this.ac;
    const appr = this.approach;
    if (appr && (this.latArmed === 'VOR/LOC' || this.vertArmed === 'G/S' || this.lat === 'VOR/LOC')) {
      const ils = appr.ils(ac.pos[0], ac.pos[1], ac.pos[2]);
      this.lastLocData = ils;
      if (this.latArmed === 'VOR/LOC' && ils.along > -500 && ils.dme < 30) {
        const R = (ac.gs * ac.gs) / (G0 * Math.tan(25 * DEG));
        const angle = Math.abs(wrap180(ac.track - appr.heading)) * DEG;
        const lead = R * (1 - Math.cos(Math.min(angle, Math.PI / 2))) + 150;
        const closing = Math.sign(ils.xtk) !== Math.sign(wrap180(ac.track - appr.heading)) || Math.abs(ils.xtk) < 300;
        if (Math.abs(ils.locDev) < 2.4 && Math.abs(ils.xtk) < lead && closing) {
          this.lat = 'VOR/LOC';
          this.latArmed = null;
          this.events.push('locCapture');
        }
      }
      if (this.vertArmed === 'G/S' && this.lat === 'VOR/LOC' && ils.along > 0 && ils.gsDev > -0.06 && ils.gsDev < 0.8) {
        this.vert = 'G/S';
        this.vertArmed = null;
        this.speedAT();
        this.events.push('gsCapture');
      }
    }
    // Autoland is available when both LOC and G/S are captured with the AP engaged.
    this.autoland = this.cmd && this.lat === 'VOR/LOC' && (this.vert === 'G/S' || this.vert === 'FLARE');
    if (this.vert === 'G/S' && this.autoland && ac.radioAlt < 50 * FT) {
      this.vert = 'FLARE';
      this.events.push('flare');
    }
    if ((this.vert === 'FLARE' || this.vert === 'G/S') && ac.wow && this.cmd && this.lat === 'VOR/LOC') {
      this.lat = 'ROLLOUT';
      this.vert = 'ROLLOUT';
    }
  }

  lateralCommand(dt) {
    const ac = this.ac;
    const maxBank = ac.radioAlt < 1000 * FT && this.lat === 'VOR/LOC' ? 15 : 25;
    let trackCmd = null;
    switch (this.lat) {
      case 'HDG SEL': {
        const hdgTrue = this.mcp.hdg + this.magVar;
        const err = wrap180(hdgTrue - ac.heading);
        return clamp(err * 2.0, -maxBank, maxBank);
      }
      case 'HDG HOLD':
      case 'TO/GA':
        if (ac.wow) return 0;
        trackCmd = this.holdTrack;
        break;
      case 'LNAV':
        trackCmd = this.lnavTrack();
        if (trackCmd === null) {
          this.setLat('HDG HOLD');
          trackCmd = this.holdTrack;
        }
        break;
      case 'VOR/LOC': {
        const ils = this.approach.ils(ac.pos[0], ac.pos[1], ac.pos[2]);
        const L = clamp(ils.gsDist * 0.09 + 900, 900, 5000);
        const intercept = clamp(Math.atan2(ils.xtk, L) * RAD, -30, 30);
        trackCmd = this.approach.heading - intercept;
        break;
      }
      case 'ROLLOUT':
        return 0;
      default:
        return this.cmd ? 0 : null;
    }
    const err = wrap180(trackCmd - ac.track);
    void dt;
    return clamp(err * 2.2, -maxBank, maxBank);
  }

  lnavTrack() {
    const ac = this.ac;
    const plan = this.plan;
    if (!plan) return null;
    let wp = plan.activeWp;
    if (!wp) return null;
    const prev = plan.prevWp;
    const legCourse = bearingOf(wp.x - prev.x, wp.z - prev.z);
    // Sequence waypoints with turn anticipation.
    const next = plan.waypoints[plan.active + 1];
    const distToGo = Math.hypot(wp.x - ac.pos[0], wp.z - ac.pos[2]);
    let turnLead = 250;
    if (next) {
      const nextCourse = bearingOf(next.x - wp.x, next.z - wp.z);
      const dpsi = Math.abs(wrap180(nextCourse - legCourse)) * DEG;
      const R = (ac.gs * ac.gs) / (G0 * Math.tan(25 * DEG));
      turnLead = Math.max(250, R * Math.tan(Math.min(dpsi, 2.6) / 2));
    }
    const brgToWp = bearingOf(wp.x - ac.pos[0], wp.z - ac.pos[2]);
    const passed = Math.abs(wrap180(brgToWp - legCourse)) > 100;
    if ((distToGo < turnLead || passed) && next) {
      plan.active++;
      this.events.push('wpSequence');
      return this.lnavTrack();
    }
    // Cross-track error to the leg (positive = right of course).
    const d = [Math.sin(legCourse * DEG), -Math.cos(legCourse * DEG)];
    const px = ac.pos[0] - prev.x;
    const pz = ac.pos[2] - prev.z;
    const xtk = px * -d[1] + pz * d[0];
    const L = Math.max(2500, ac.gs * 22);
    const intercept = clamp(Math.atan2(xtk, L) * RAD, -45, 45);
    return legCourse - intercept;
  }

  verticalCommand(dt) {
    const ac = this.ac;
    const mcpAlt = this.mcp.alt * FT;
    const altErr = mcpAlt - ac.pos[1];
    // Altitude capture from climb/descent modes.
    if (this.vert === 'V/S' || this.vert === 'MCP SPD' || (this.vert === 'TO/GA' && !ac.wow && ac.radioAlt > 400 * FT)) {
      const towards = Math.sign(altErr) === Math.sign(ac.vs) || Math.abs(altErr) < 15;
      const capDist = (ac.vs * ac.vs) / (2 * 0.55) + 25;
      if (towards && Math.abs(altErr) < capDist) {
        this.vert = 'ALT ACQ';
        this.acqVs = Math.abs(ac.vs);
        this.speedAT();
      }
    }
    let vsCmd = null;
    let pitchCmd = null;
    switch (this.vert) {
      case 'ALT ACQ': {
        const mag = Math.min(this.acqVs + 0.5, Math.sqrt(2 * 0.55 * Math.abs(altErr)), 0.25 * Math.abs(altErr) + 0.05);
        vsCmd = Math.sign(altErr) * mag;
        if (Math.abs(altErr) < 8 && Math.abs(ac.vs) < 1.2) {
          this.vert = 'ALT HOLD';
          this.holdAlt = mcpAlt;
          this.events.push('altCapture');
        }
        break;
      }
      case 'ALT HOLD':
        vsCmd = clamp((this.holdAlt - ac.pos[1]) * 0.15, -6, 6);
        break;
      case 'V/S':
        vsCmd = this.mcp.vs * FPM;
        break;
      case 'MCP SPD':
        vsCmd = this.speedOnPitch(dt, altErr > 0);
        break;
      case 'G/S': {
        const ils = this.approach.ils(ac.pos[0], ac.pos[1], ac.pos[2]);
        const pathH = ils.gsDist * Math.tan(this.approach.gsAngle * DEG);
        const vErr = ils.h - pathH;
        vsCmd = -ac.gs * Math.tan(this.approach.gsAngle * DEG) - clamp(0.16 * vErr, -4, 4);
        break;
      }
      case 'FLARE':
        vsCmd = -Math.max(0.35, 0.26 * ac.radioAlt + 0.15);
        break;
      case 'ROLLOUT':
        return null;
      case 'TO/GA':
        if (ac.wow) return 15;
        vsCmd = this.speedOnPitch(dt, true, 15);
        break;
      default:
        return this.cmd ? ac.pitch : null;
    }
    if (pitchCmd === null) {
      // Flight-path controller: command a flight path angle, rate limited to ~0.12 g.
      const tas = Math.max(ac.tas, 50);
      let gCmd = Math.asin(clamp(vsCmd / tas, -0.35, 0.35));
      const gMax = (0.12 * G0 / tas) * dt * (this.vert === 'FLARE' ? 2 : 1);
      const prevG = this.gammaRef ?? Math.asin(clamp(ac.vs / tas, -0.35, 0.35));
      gCmd = clamp(gCmd, prevG - gMax, prevG + gMax);
      this.gammaRef = gCmd;
      const gNow = Math.asin(clamp(ac.vs / tas, -0.35, 0.35));
      pitchCmd = ac.pitch + clamp((gCmd - gNow) * RAD * this.tune.gammaP, -4, 4);
    } else {
      this.gammaRef = undefined;
      const prev = this.pitchCmd ?? ac.pitch;
      pitchCmd = clamp(pitchCmd, prev - 2.5 * dt, prev + 2.5 * dt);
    }
    this.pitchCmd = clamp(pitchCmd, -12, 22);
    return this.pitchCmd;
  }

  /** Pitch-for-speed: returns a vertical speed command (m/s). */
  speedOnPitch(dt, climb, maxPitch = 20) {
    const ac = this.ac;
    const target = this.vert === 'TO/GA' ? Math.max(this.targetIas(), ac.ias - 2) : this.targetIas();
    const k = this.tune;
    const aDes = clamp(k.aDes * (target - ac.ias), -0.6, 0.6);
    // Changing the flight path by dγ changes acceleration by -g·dγ, so command the γ that yields aDes.
    const gNow = Math.asin(clamp(ac.vs / Math.max(ac.tas, 50), -0.3, 0.3));
    this.gammaCmd = gNow + clamp(((this.accel - aDes) / G0) * k.spdGain, -3 * DEG, 3 * DEG);
    const minG = climb ? 0.3 * DEG : -9 * DEG;
    const maxG = climb ? (maxPitch - 2) * DEG : -0.3 * DEG;
    this.gammaCmd = clamp(this.gammaCmd, minG, maxG);
    return Math.sin(this.gammaCmd) * ac.tas;
  }

  autothrottle(dt) {
    const ac = this.ac;
    const c = ac.controls;
    if (!this.atArm) return;
    let tla = c.throttle[0];
    switch (this.at) {
      case 'MCP SPD': {
        const errKt = (this.targetIas() - ac.ias) / KT;
        const accKt = this.accel / KT;
        const rate = clamp(0.014 * errKt - 0.07 * accKt, -0.12, 0.12);
        tla = clamp(tla + rate * dt, 0, CLB_TLA);
        break;
      }
      case 'N1': {
        const lim = this.vert === 'TO/GA' ? this.toThrust || TO_TLA : CLB_TLA;
        tla = Math.min(lim, tla + 0.25 * dt);
        if (tla > lim) tla = lim;
        if (ac.wow && ac.ias > 84 * KT && this.vert === 'TO/GA') this.at = 'THR HLD';
        break;
      }
      case 'RETARD':
        tla = Math.max(0, tla - 0.3 * dt);
        if (tla <= 0) this.at = 'ARM';
        break;
      case 'THR HLD':
        if (!ac.wow && ac.radioAlt > 800 * FT) this.at = 'ARM';
        return;
      case 'ARM':
      default:
        return;
    }
    // Flare retard at 27 ft (autoland) or 20 ft otherwise.
    if (this.vert === 'FLARE' && ac.radioAlt < 27 * FT) this.at = 'RETARD';
    if (this.vert === 'ROLLOUT' && this.at !== 'ARM') this.at = 'RETARD';
    c.throttle = [tla, tla];
  }

  /** Short flight mode annunciator strings for the PFD. */
  fma() {
    return {
      at: this.atArm ? this.at || 'ARM' : '',
      roll: this.lat || '',
      rollArmed: this.latArmed || (this.lat === 'VOR/LOC' && this.autoland ? 'ROLLOUT' : ''),
      pitch: this.vert || '',
      pitchArmed: this.vertArmed || (this.vert === 'G/S' && this.autoland ? 'FLARE' : ''),
      status: this.cmd ? (this.autoland ? 'LAND 3' : 'CMD') : this.fd ? 'FD' : '',
    };
  }
}

