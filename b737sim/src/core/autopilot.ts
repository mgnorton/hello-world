// 737NG-style Autopilot Flight Director System (AFDS), autothrottle and FMC guidance.
// Roll modes:  HDG SEL, HDG HOLD, LNAV, VOR/LOC (VOR radial or localizer on NAV 1), ROLLOUT, TO/GA
// Pitch modes: ALT HOLD, ALT ACQ, V/S, MCP SPD (level change), VNAV SPD / PTH / ALT, G/S, FLARE, TO/GA
// A/T modes:   MCP SPD, FMC SPD, N1, RETARD, ARM, THR HLD
import { clamp, wrap180, wrap360, DEG, RAD, KT, FT, FPM, G0, expK, bearingOf } from './math.ts';
import { casFromMach } from './atmosphere.ts';
import { B739 } from './aircraftData.ts';
import type { Aircraft } from './fdm.ts';
import type { RadioStack } from '../nav/radios.ts';
import type { NavDB, RunwayEnd } from '../world/navdb.ts';
import { legGeometry, type FlightPlan } from '../fms/flightplan.ts';

const CLB_TLA = 0.94;
const TO_TLA = 1.0;
const GA_TLA = 0.9;

export type LatMode = 'HDG SEL' | 'HDG HOLD' | 'LNAV' | 'VOR/LOC' | 'ROLLOUT' | 'TO/GA' | null;
export type VertMode =
  | 'ALT HOLD' | 'ALT ACQ' | 'V/S' | 'MCP SPD' | 'G/S' | 'FLARE' | 'ROLLOUT' | 'TO/GA' | 'VNAV PTH' | 'VNAV SPD' | 'VNAV ALT' | null;
export type AtMode = 'MCP SPD' | 'FMC SPD' | 'N1' | 'RETARD' | 'ARM' | 'THR HLD' | null;
export type ApEvent =
  | 'apDisconnect' | 'apOverride' | 'atDisconnect' | 'locCapture' | 'vorCapture' | 'gsCapture' | 'goAround' | 'flare'
  | 'altCapture' | 'wpSequence' | 'tod';

export interface Fma {
  at: string;
  roll: string;
  rollArmed: string;
  pitch: string;
  pitchArmed: string;
  status: string;
}

export class Autopilot {
  plan: FlightPlan | null = null;
  mcp = { spd: 250, mach: 0.78, useMach: false, hdg: 0, alt: 10000, vs: 0 };
  cmd = false;
  fd = true;
  atArm = false;
  lat: LatMode = null;
  latArmed: 'VOR/LOC' | 'LNAV' | null = null;
  vert: VertMode = null;
  vertArmed: 'G/S' | 'VNAV' | null = null;
  at: AtMode = null;
  holdTrack = 0;
  holdAlt = 0;
  pitchCmd = 0;
  bankCmd = 0;
  fdPitch = 0;
  fdRoll = 0;
  autoland = false;
  events: ApEvent[] = [];
  /** Runway used by the localizer when it was captured (for flare / rollout). */
  landingEnd: RunwayEnd | null = null;
  vnavSpeedKt = 250;
  private accel = 0;
  private prevIas = 0;
  private acqVs = 0;
  private gammaRef: number | undefined;
  private gammaCmd = 0;
  private toThrust = TO_TLA;
  private legStart: { x: number; z: number; leg: number } | null = null;
  private todAnnounced = false;
  private vnavDescent = false;
  private vnavLevel: number | null = null;
  tune = { aDes: 0.08, spdGain: 1.0, accelTau: 0.8, gammaP: 2.5 };

  constructor(readonly ac: Aircraft, readonly radios: RadioStack, readonly nav: NavDB) {}

  /** Local magnetic variation (deg east). */
  get magVar(): number {
    const [lat, lon] = this.nav.proj.toLatLon(this.ac.pos[0], this.ac.pos[2]);
    return this.nav.magVar.at(lat, lon);
  }
  get magHeading(): number {
    return wrap360(this.ac.heading - this.magVar);
  }
  /** Barometric altitude (m) used for all altitude modes. */
  private get alt(): number {
    return this.ac.altInd;
  }
  /** The localizer on NAV 1, when received. */
  get loc(): RunwayEnd | null {
    const n = this.radios.nav1;
    return n.receiving && n.kind === 'ils' ? n.loc : null;
  }

  // --- Mode selection (MCP buttons) ----------------------------------------------

  engage(on = !this.cmd): void {
    const ac = this.ac;
    if (on && ac.wow) return;
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

  disconnect(reason: 'manual' | 'override' = 'manual'): void {
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

  toggleAT(): void {
    this.atArm = !this.atArm;
    if (this.atArm) this.at = this.ac.wow ? 'ARM' : this.vnavActive ? 'FMC SPD' : 'MCP SPD';
    else {
      this.at = null;
      this.events.push('atDisconnect');
    }
  }

  setLat(mode: LatMode): void {
    const ac = this.ac;
    this.lat = mode;
    if (mode === 'HDG HOLD') this.holdTrack = ac.track;
    if (mode === 'LNAV') this.legStart = null;
    if (mode === this.latArmed) this.latArmed = null;
  }

  hdgSel(): void {
    this.setLat(this.lat === 'HDG SEL' ? 'HDG HOLD' : 'HDG SEL');
  }

  lnav(): void {
    if (!this.plan) return;
    if (this.lat === 'LNAV' || this.latArmed === 'LNAV') {
      this.latArmed = null;
      if (this.lat === 'LNAV') this.setLat('HDG HOLD');
      return;
    }
    if (this.ac.wow || this.ac.radioAlt < 50 * FT) this.latArmed = 'LNAV';
    else this.setLat('LNAV');
  }

  vorLoc(): void {
    if (this.lat === 'VOR/LOC' || this.latArmed === 'VOR/LOC') {
      this.latArmed = null;
      if (this.lat === 'VOR/LOC') this.setLat('HDG HOLD');
    } else this.latArmed = 'VOR/LOC';
  }

  app(): void {
    if (this.vertArmed === 'G/S' || this.vert === 'G/S') {
      this.vertArmed = null;
      if (this.latArmed === 'VOR/LOC') this.latArmed = null;
      if (this.vert === 'G/S') this.altHold();
      return;
    }
    if (this.lat !== 'VOR/LOC') this.latArmed = 'VOR/LOC';
    this.vertArmed = 'G/S';
  }

  altHold(): void {
    this.vert = 'ALT HOLD';
    this.holdAlt = this.alt;
    if (Math.abs(this.alt - this.mcp.alt * FT) < 40 * FT) this.holdAlt = this.mcp.alt * FT;
    this.speedAT();
  }

  setVS(fpm?: number): void {
    this.vert = 'V/S';
    this.mcp.vs = fpm ?? Math.round(this.ac.vs / FPM / 100) * 100;
    this.speedAT();
  }

  lvlChg(): void {
    const ac = this.ac;
    this.vert = 'MCP SPD';
    this.gammaCmd = Math.asin(clamp(ac.vs / Math.max(ac.tas, 50), -0.3, 0.3));
    if (this.atArm) this.at = this.mcp.alt * FT > this.alt ? 'N1' : 'RETARD';
  }

  get vnavActive(): boolean {
    return this.vert === 'VNAV PTH' || this.vert === 'VNAV SPD' || this.vert === 'VNAV ALT';
  }

  vnav(): void {
    if (!this.plan) return;
    if (this.vnavActive || this.vertArmed === 'VNAV') {
      this.vertArmed = null;
      if (this.vnavActive) this.altHold();
      return;
    }
    if (this.ac.wow || this.ac.radioAlt < 400 * FT) {
      this.vertArmed = 'VNAV';
      return;
    }
    this.vert = 'VNAV SPD';
    this.todAnnounced = false;
    this.vnavDescent = false;
    this.vnavLevel = null;
  }

  toga(): void {
    const ac = this.ac;
    this.lat = 'TO/GA';
    this.vert = 'TO/GA';
    if (ac.wow) {
      this.holdTrack = ac.heading;
      if (this.atArm) this.at = 'N1';
      this.toThrust = TO_TLA;
    } else {
      this.latArmed = null;
      this.vertArmed = null;
      this.holdTrack = ac.track;
      this.toThrust = GA_TLA;
      if (this.atArm) this.at = 'N1';
      this.autoland = false;
      if (this.plan) this.plan.missedActive = true;
      this.events.push('goAround');
    }
  }

  private speedAT(): void {
    if (this.atArm && this.at !== 'THR HLD') this.at = this.vnavActive ? 'FMC SPD' : 'MCP SPD';
  }

  /** FMC speed schedule (kt IAS) for VNAV, including restrictions and flap placards. */
  private fmcSpeed(): number {
    const ac = this.ac;
    const plan = this.plan;
    const altFt = this.alt / FT;
    let spd: number;
    const descending = this.vert === 'VNAV PTH' && ac.vs < -2;
    if (altFt < 10000) spd = 250;
    else spd = descending ? 280 : 290;
    // Crossover: hold Mach .78 at high altitude.
    const machCas = casFromMach(0.78, ac.air) / KT;
    spd = Math.min(spd, machCas);
    if (plan) {
      const lim = plan.speedLimit();
      if (lim) spd = Math.min(spd, lim);
      const remNm = plan.remaining(ac.pos[0], ac.pos[2]) / 1852;
      if (remNm < 25 && !plan.missedActive) spd = Math.min(spd, 210);
    }
    const fl = B739.flaps[Math.round(ac.flapPos)];
    if (ac.flapPos > 0.2) spd = Math.min(spd, fl.vfe - 10);
    return spd;
  }

  /** Target IAS in m/s. */
  targetIas(): number {
    if (this.vnavActive) return this.vnavSpeedKt * KT;
    if (this.mcp.useMach) return casFromMach(this.mcp.mach, this.ac.air);
    return this.mcp.spd * KT;
  }

  // --- Main update -----------------------------------------------------------------

  update(dt: number): void {
    const ac = this.ac;
    const c = ac.controls;
    const a = (ac.ias - this.prevIas) / Math.max(dt, 1e-3);
    this.prevIas = ac.ias;
    this.accel += (a - this.accel) * expK(dt, this.tune.accelTau);
    if (!this.mcp.useMach && this.alt > 24000 * FT && ac.mach >= this.mcp.mach - 0.002 && ac.vs > 0) this.mcp.useMach = true;
    else if (this.mcp.useMach && ac.vs < 0 && casFromMach(this.mcp.mach, ac.air) >= this.mcp.spd * KT) this.mcp.useMach = false;
    if (this.vnavActive) this.vnavSpeedKt = this.fmcSpeed();

    this.updateArmed();
    const bank = this.lateralCommand();
    const pitch = this.verticalCommand(dt);
    this.bankCmd = bank ?? 0;
    this.fdRoll = bank === null ? 0 : clamp(bank - ac.roll, -20, 20);
    this.fdPitch = pitch === null ? 0 : clamp(pitch - ac.pitch, -12, 12);
    if (this.cmd) {
      if (bank !== null && this.lat !== 'ROLLOUT') {
        const p = ac.w[0] * RAD;
        c.roll = clamp(0.055 * (bank - ac.roll) - 0.03 * p, -0.65, 0.65);
      }
      if (pitch !== null) this.pitchLoop(dt, pitch);
      if (this.lat === 'ROLLOUT') this.rollout();
    }
    this.autothrottle(dt);
  }

  private pitchLoop(dt: number, pitch: number): void {
    const ac = this.ac;
    const c = ac.controls;
    const q = ac.w[2] * RAD;
    const elev = clamp(0.11 * (pitch - ac.pitch) - 0.42 * q, -0.55, 0.65);
    c.pitch = elev;
    if (!ac.wow) c.trim = clamp(c.trim + clamp(elev * 0.4, -0.08, 0.08) * dt, -1, 1);
  }

  private rollout(): void {
    const ac = this.ac;
    const c = ac.controls;
    const e = this.landingEnd;
    if (!e) return;
    const d = e.ilsDeviation(ac.pos[0], ac.pos[1], ac.pos[2]);
    const hErr = wrap180(ac.heading - e.heading);
    const r = -ac.w[1] * RAD;
    c.yaw = clamp(-0.12 * hErr - 0.012 * d.xtk - 0.3 * r, -1, 1);
    c.roll = clamp(-0.05 * ac.roll, -0.3, 0.3);
    c.pitch = ac.noseWow ? 0 : clamp(0.08 * -ac.pitch - 0.3 * ac.w[2] * RAD, -0.3, 0.2);
  }

  private turnRadius(): number {
    const v = Math.max(this.ac.gs, 60);
    return (v * v) / (G0 * Math.tan(25 * DEG));
  }

  private updateArmed(): void {
    const ac = this.ac;
    // LNAV / VNAV armed on the ground engage after takeoff.
    if (this.latArmed === 'LNAV' && !ac.wow && ac.radioAlt > 50 * FT) this.setLat('LNAV');
    if (this.vertArmed === 'VNAV' && !ac.wow && ac.radioAlt > 400 * FT) {
      this.vertArmed = null;
      this.vert = 'VNAV SPD';
      this.vnavDescent = false;
      this.vnavLevel = null;
      if (this.atArm) this.at = 'N1';
    }
    const nav1 = this.radios.nav1;
    if (this.latArmed === 'VOR/LOC' && nav1.receiving) {
      const angle = Math.abs(wrap180(ac.track - this.courseTrue())) * DEG;
      const lead = this.turnRadius() * (1 - Math.cos(Math.min(angle, Math.PI / 2))) + 150;
      if (nav1.kind === 'ils' && nav1.loc) {
        const d = nav1.loc.ilsDeviation(ac.pos[0], ac.pos[1], ac.pos[2]);
        const closing = Math.sign(d.xtk) !== Math.sign(wrap180(ac.track - nav1.loc.heading)) || Math.abs(d.xtk) < 300;
        if (d.along > -500 && Math.abs(d.locDev) < 2.4 && Math.abs(d.xtk) < lead && closing) {
          this.lat = 'VOR/LOC';
          this.latArmed = null;
          this.landingEnd = nav1.loc;
          this.events.push('locCapture');
        }
      } else if (nav1.kind === 'vor' && nav1.vor) {
        const dist = Math.hypot(ac.pos[0] - nav1.vor.x, ac.pos[2] - nav1.vor.z);
        const xtk = dist * Math.sin(nav1.devDeg * DEG);
        const closing = Math.sign(xtk) !== Math.sign(wrap180(ac.track - this.courseTrue())) || Math.abs(xtk) < 300;
        if (Math.abs(nav1.devDeg) < 10 && Math.abs(xtk) < lead && closing) {
          this.lat = 'VOR/LOC';
          this.latArmed = null;
          this.events.push('vorCapture');
        }
      }
    }
    const loc = this.loc;
    if (this.vertArmed === 'G/S' && this.lat === 'VOR/LOC' && loc && loc.ils?.gs) {
      const d = loc.ilsDeviation(ac.pos[0], ac.pos[1], ac.pos[2]);
      if (d.along > 0 && d.gsDev > -0.06 && d.gsDev < 0.8) {
        this.vert = 'G/S';
        this.vertArmed = null;
        this.landingEnd = loc;
        this.speedAT();
        this.events.push('gsCapture');
      }
    }
    this.autoland = this.cmd && this.lat === 'VOR/LOC' && !!this.landingEnd && (this.vert === 'G/S' || this.vert === 'FLARE');
    if (this.vert === 'G/S' && this.autoland && ac.radioAlt < 50 * FT) {
      this.vert = 'FLARE';
      this.events.push('flare');
    }
    if ((this.vert === 'FLARE' || this.vert === 'G/S') && ac.wow && this.cmd && this.lat === 'VOR/LOC') {
      this.lat = 'ROLLOUT';
      this.vert = 'ROLLOUT';
    }
  }

  /** Selected course on NAV 1 as a true direction (VOR uses the station's declination). */
  private courseTrue(): number {
    const n = this.radios.nav1;
    if (n.kind === 'ils' && n.loc) return n.loc.heading;
    if (n.kind === 'vor' && n.vor) return wrap360(n.course + n.vor.raw.stationVar);
    return wrap360(n.course + this.magVar);
  }

  private lateralCommand(): number | null {
    const ac = this.ac;
    const maxBank = ac.radioAlt < 1000 * FT && this.lat === 'VOR/LOC' ? 15 : 25;
    let trackCmd: number;
    switch (this.lat) {
      case 'HDG SEL': {
        const err = wrap180(this.mcp.hdg + this.magVar - ac.heading);
        return clamp(err * 2.0, -maxBank, maxBank);
      }
      case 'HDG HOLD':
      case 'TO/GA':
        if (ac.wow) return 0;
        trackCmd = this.holdTrack;
        break;
      case 'LNAV': {
        const t = this.lnavTrack();
        if (t === null) {
          this.setLat('HDG HOLD');
          trackCmd = this.holdTrack;
        } else trackCmd = t;
        break;
      }
      case 'VOR/LOC': {
        const n = this.radios.nav1;
        const e = this.landingEnd && n.kind === 'ils' ? n.loc ?? this.landingEnd : null;
        if (e) {
          const d = e.ilsDeviation(ac.pos[0], ac.pos[1], ac.pos[2]);
          const L = clamp(d.gsDist * 0.09 + 900, 900, 5000);
          trackCmd = e.heading - clamp(Math.atan2(d.xtk, L) * RAD, -30, 30);
        } else if (n.kind === 'vor' && n.vor && n.receiving) {
          const dist = Math.hypot(ac.pos[0] - n.vor.x, ac.pos[2] - n.vor.z);
          const xtk = dist * Math.sin(n.devDeg * DEG);
          const L = Math.max(2500, ac.gs * 25);
          // Near the station the radial is unreliable (cone of confusion): hold the course.
          const corr = dist < 2500 ? 0 : clamp(Math.atan2(xtk, L) * RAD, -40, 40);
          trackCmd = this.courseTrue() - corr;
        } else {
          trackCmd = ac.track;
        }
        break;
      }
      case 'ROLLOUT':
        return 0;
      default:
        return this.cmd ? 0 : null;
    }
    return clamp(wrap180(trackCmd - ac.track) * 2.2, -maxBank, maxBank);
  }

  /** LNAV steering along the flight plan legs; returns the commanded true track. */
  private lnavTrack(): number | null {
    const ac = this.ac;
    const plan = this.plan;
    if (!plan) return null;
    const end = plan.missedActive ? plan.legs.length - 1 : plan.runwayIndex;
    for (let guard = 0; guard < 4; guard++) {
      const i = plan.active;
      const leg = plan.legs[i];
      if (!leg) return null;
      if (leg.type === 'course') {
        if (this.alt >= (leg.untilAltM ?? 0) - 10 && i < end) {
          plan.active++;
          this.legStart = { x: ac.pos[0], z: ac.pos[2], leg: plan.active };
          this.events.push('wpSequence');
          continue;
        }
        return leg.course!;
      }
      const start = this.legStart && this.legStart.leg === i ? this.legStart : plan.legStart(i);
      const course = bearingOf(leg.x - start.x, leg.z - start.z);
      const distToGo = Math.hypot(leg.x - ac.pos[0], leg.z - ac.pos[2]);
      const next = plan.legs[i + 1];
      let lead = 250;
      if (next && next.type === 'fix' && !leg.flyover) {
        const nextCourse = legGeometry(plan, i + 1).course;
        const dpsi = Math.abs(wrap180(nextCourse - course)) * DEG;
        lead = Math.max(250, this.turnRadius() * Math.tan(Math.min(dpsi, 2.6) / 2));
      } else if (next && next.type === 'course') {
        lead = 400;
      }
      const brgToWp = bearingOf(leg.x - ac.pos[0], leg.z - ac.pos[2]);
      const passed = Math.abs(wrap180(brgToWp - course)) > 100;
      if ((distToGo < lead || passed) && i < end) {
        plan.active++;
        this.events.push('wpSequence');
        continue;
      }
      // Cross-track error (positive = right of course).
      const d = [Math.sin(course * DEG), -Math.cos(course * DEG)];
      const xtk = (ac.pos[0] - start.x) * -d[1] + (ac.pos[2] - start.z) * d[0];
      const L = Math.max(2500, ac.gs * 22);
      return course - clamp(Math.atan2(xtk, L) * RAD, -45, 45);
    }
    return null;
  }

  private verticalCommand(dt: number): number | null {
    const ac = this.ac;
    const mcpAlt = this.mcp.alt * FT;
    const altErr = mcpAlt - this.alt;
    if (this.vert === 'V/S' || this.vert === 'MCP SPD' || (this.vert === 'TO/GA' && !ac.wow && ac.radioAlt > 400 * FT)) {
      const towards = Math.sign(altErr) === Math.sign(ac.vs) || Math.abs(altErr) < 15;
      if (towards && Math.abs(altErr) < (ac.vs * ac.vs) / (2 * 0.55) + 25) {
        this.vert = 'ALT ACQ';
        this.acqVs = Math.abs(ac.vs);
        this.speedAT();
      }
    }
    let vsCmd: number;
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
        vsCmd = clamp((this.holdAlt - this.alt) * 0.15, -6, 6);
        break;
      case 'V/S':
        vsCmd = this.mcp.vs * FPM;
        break;
      case 'MCP SPD':
        vsCmd = this.speedOnPitch(altErr > 0);
        break;
      case 'VNAV SPD':
      case 'VNAV PTH':
      case 'VNAV ALT':
        vsCmd = this.vnavCommand(mcpAlt);
        break;
      case 'G/S': {
        const e = this.landingEnd ?? this.loc;
        if (!e) {
          vsCmd = 0;
          break;
        }
        const d = e.ilsDeviation(ac.pos[0], ac.pos[1], ac.pos[2]);
        const vErr = d.h - d.gsDist * Math.tan(e.gpa * DEG);
        vsCmd = -ac.gs * Math.tan(e.gpa * DEG) - clamp(0.16 * vErr, -4, 4);
        break;
      }
      case 'FLARE':
        vsCmd = -Math.max(0.35, 0.26 * ac.radioAlt + 0.15);
        break;
      case 'ROLLOUT':
        return null;
      case 'TO/GA':
        if (ac.wow) return 15;
        vsCmd = this.speedOnPitch(true, 15);
        break;
      default:
        return this.cmd ? ac.pitch : null;
    }
    // Flight-path controller: command a flight path angle, rate limited to ~0.12 g.
    const tas = Math.max(ac.tas, 50);
    let gCmd = Math.asin(clamp(vsCmd / tas, -0.35, 0.35));
    const gMax = ((0.12 * G0) / tas) * dt * (this.vert === 'FLARE' ? 2 : 1);
    const prevG = this.gammaRef ?? Math.asin(clamp(ac.vs / tas, -0.35, 0.35));
    gCmd = clamp(gCmd, prevG - gMax, prevG + gMax);
    this.gammaRef = gCmd;
    const gNow = Math.asin(clamp(ac.vs / tas, -0.35, 0.35));
    this.pitchCmd = clamp(ac.pitch + clamp((gCmd - gNow) * RAD * this.tune.gammaP, -4, 4), -12, 22);
    return this.pitchCmd;
  }

  /** VNAV: climb at FMC speed, cruise, then descend on the geometric path to the restrictions. */
  private vnavCommand(mcpAlt: number): number {
    const ac = this.ac;
    const plan = this.plan!;
    const alt = this.alt;
    const path = plan.descentPathAlt(ac.pos[0], ac.pos[2]);
    const cruise = plan.cruiseAltM;
    // Descent starts at the top of descent (path below us) and, once started, continues.
    if (path.alt < alt - 60) this.vnavDescent = true;
    if (!this.vnavDescent) {
      // Climb toward the lower of the MCP altitude, a SID restriction and the cruise level.
      const target = Math.min(mcpAlt, cruise, plan.climbCeiling());
      const err = target - alt;
      if (err > 30 && this.vnavLevel === null) {
        if (err < (ac.vs * ac.vs) / (2 * 0.55) + 40) {
          if (this.atArm && this.at !== 'THR HLD') this.at = 'FMC SPD';
          return Math.min(Math.sqrt(2 * 0.55 * err), 0.25 * err + 0.05, Math.max(ac.vs, 1));
        }
        this.vert = 'VNAV SPD';
        if (this.atArm) this.at = 'N1';
        return this.speedOnPitch(true);
      }
      // Level: at the target, or holding the present altitude until the top of descent.
      if (this.vnavLevel === null || (err > 30 && Math.abs(target - this.vnavLevel) > 30 && target > this.vnavLevel)) {
        this.vnavLevel = Math.abs(err) < 150 ? target : alt;
      }
      if (target > this.vnavLevel + 30) {
        this.vnavLevel = null; // climb resumed (MCP raised)
        return this.speedOnPitch(true);
      }
      this.vert = Math.abs(this.vnavLevel - cruise) < 60 ? 'VNAV PTH' : 'VNAV ALT';
      if (this.atArm && this.at !== 'THR HLD') this.at = 'FMC SPD';
      return clamp((this.vnavLevel - alt) * 0.15, -5, 5);
    }
    this.vnavLevel = null;
    if (!this.todAnnounced) {
      this.todAnnounced = true;
      this.events.push('tod');
    }
    // Never descend below the MCP altitude: capture it smoothly.
    const above = alt - mcpAlt;
    if (above < (ac.vs * ac.vs) / (2 * 0.55) + 30) {
      this.vert = 'VNAV ALT';
      if (this.atArm && this.at !== 'THR HLD') this.at = 'FMC SPD';
      if (above < 10) return clamp(-above * 0.15, -5, 5);
      return -Math.min(Math.sqrt(2 * 0.55 * above), 0.25 * above + 0.05, Math.max(-ac.vs, 1));
    }
    const target = Math.max(path.alt, mcpAlt);
    const pathVs = -ac.gs * Math.tan(3 * DEG);
    const dev = alt - target;
    if (dev > 300 * FT) {
      // High above the path: idle thrust, speed on pitch.
      this.vert = 'VNAV SPD';
      if (this.atArm && this.at !== 'ARM') this.at = 'RETARD';
      return this.speedOnPitch(false);
    }
    this.vert = 'VNAV PTH';
    if (this.atArm && this.at !== 'THR HLD') this.at = 'FMC SPD';
    return clamp(pathVs - dev * 0.08, -18, 1);
  }

  /** Pitch-for-speed: returns a vertical speed command (m/s). */
  private speedOnPitch(climb: boolean, maxPitch = 20): number {
    const ac = this.ac;
    const target = this.vert === 'TO/GA' ? Math.max(this.targetIas(), ac.ias - 2) : this.targetIas();
    const aDes = clamp(this.tune.aDes * (target - ac.ias), -0.6, 0.6);
    const gNow = Math.asin(clamp(ac.vs / Math.max(ac.tas, 50), -0.3, 0.3));
    this.gammaCmd = gNow + clamp(((this.accel - aDes) / G0) * this.tune.spdGain, -3 * DEG, 3 * DEG);
    this.gammaCmd = clamp(this.gammaCmd, climb ? 0.3 * DEG : -9 * DEG, climb ? (maxPitch - 2) * DEG : -0.3 * DEG);
    return Math.sin(this.gammaCmd) * ac.tas;
  }

  private autothrottle(dt: number): void {
    const ac = this.ac;
    const c = ac.controls;
    if (!this.atArm) return;
    let tla = c.throttle[0];
    switch (this.at) {
      case 'MCP SPD':
      case 'FMC SPD': {
        const errKt = (this.targetIas() - ac.ias) / KT;
        const rate = clamp(0.014 * errKt - (0.07 * this.accel) / KT, -0.12, 0.12);
        tla = clamp(tla + rate * dt, 0, CLB_TLA);
        break;
      }
      case 'N1': {
        const lim = this.vert === 'TO/GA' ? this.toThrust : CLB_TLA;
        tla = Math.min(lim, tla + 0.25 * dt);
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
      default:
        return;
    }
    if (this.vert === 'FLARE' && ac.radioAlt < 27 * FT) this.at = 'RETARD';
    if (this.vert === 'ROLLOUT' && this.at !== 'ARM') this.at = 'RETARD';
    c.throttle = [tla, tla];
  }

  fma(): Fma {
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
