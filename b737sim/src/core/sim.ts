// Simulation session: aircraft, autopilot, radios, flight plan, weather and warnings over the
// real-world KDFW region. No browser dependencies (runs headless in tests).
import { clamp, wrap180, wrap360, DEG, RAD, KT, FT, NM } from './math.ts';
import { Aircraft } from './fdm.ts';
import { Autopilot } from './autopilot.ts';
import { Warnings } from './warnings.ts';
import { B739, vSpeeds, type VSpeeds } from './aircraftData.ts';
import { hPaToInHg } from './atmosphere.ts';
import { RadioStack } from '../nav/radios.ts';
import { FlightPlan, type PlanSpec } from '../fms/flightplan.ts';
import { WeatherSystem } from '../weather/weather.ts';
import { decodeSeed, presetSeed, type CustomWeather, type PresetId } from '../weather/seed.ts';
import type { WorldData } from '../world/worldData.ts';
import type { Airport, RawProcedure, RunwayEnd } from '../world/navdb.ts';
import { gcBearing } from '../world/geo.ts';

export const PHYSICS_HZ = 240;

export type StartKind = 'runway' | 'approach' | 'final' | 'cruise';

export interface SimOptions {
  dep: string;
  depRwy: string;
  arr: string;
  arrRwy: string;
  sid: string | null;
  sidTransition: string | null;
  route: string;
  star: string | null;
  starTransition: string | null;
  approach: string | null;
  start: StartKind;
  cruiseAlt: number;
  pax: number;
  fuel: number;
  weather: PresetId;
  custom?: CustomWeather;
  /** Weather evolution speed: 0 frozen, 1 real time, 4 accelerated. */
  weatherRate: number;
  hour: number; // local time (America/Chicago)
  autoTrim: boolean;
  apOnApproach: boolean;
  seed: number;
}

export const DEFAULT_OPTIONS: SimOptions = {
  dep: 'KDFW', depRwy: '17R', arr: 'KAUS', arrRwy: '', sid: null, sidTransition: null, route: '', star: null, starTransition: null,
  approach: null, start: 'runway', cruiseAlt: 28000, pax: 160, fuel: 8000, weather: 'live', weatherRate: 1, hour: 14,
  autoTrim: true, apOnApproach: true, seed: 1,
};

export interface PilotInput {
  pitch: number;
  roll: number;
  yaw: number;
  tiller?: number;
  brakeL?: number;
  brakeR?: number;
}

export interface LandingReport {
  grade: string;
  vs: number;
  g: string;
  ias: number;
  pitch: string;
  roll: string;
  crab: string;
  runway: string;
  fromThreshold: number | null;
  centerline: number | null;
  windshear: boolean;
}

export interface Message {
  text: string;
  kind: 'info' | 'warn' | 'crash' | 'landing';
}

/** Choose a sensible SID / STAR / ILS for a city pair from the real procedures. */
export function suggestProcedures(world: WorldData, o: Pick<SimOptions, 'dep' | 'depRwy' | 'arr' | 'arrRwy'>, windFrom: number, windKt: number):
  { depRwy: string; sid: string | null; arrRwy: string; star: string | null; starTransition: string | null; approach: string | null; } {
  const db = world.nav;
  const dep = db.airport(o.dep);
  const arr = db.airport(o.arr);
  if (!dep || !arr) return { depRwy: o.depRwy, sid: null, arrRwy: o.arrRwy, star: null, starTransition: null, approach: null };
  const depEnd = dep.end(o.depRwy) ?? dep.bestEnd(windFrom, windKt);
  const brg = gcBearing(dep.lat, dep.lon, arr.lat, arr.lon);
  const lastFix = (p: RawProcedure): { lat: number; lon: number } | null => {
    const legs = [...p.transitions.flatMap((t) => t.legs), ...p.common.flatMap((c) => c.legs)].filter((l) => l.lat !== undefined);
    if (!legs.length) return null;
    let far = legs[0];
    let fd = -1;
    for (const l of legs) {
      const d = Math.hypot(l.lat! - dep.lat, l.lon! - dep.lon);
      if (d > fd) {
        fd = d;
        far = l;
      }
    }
    return { lat: far.lat!, lon: far.lon! };
  };
  let sid: string | null = null;
  let bestScore = 60;
  for (const p of db.proceduresFor(dep.ident, 'SID')) {
    const hasRw = p.transitions.some((t) => t.name === `RW${depEnd.id}` || (t.name.endsWith('B') && t.name.slice(2, -1) === depEnd.id.replace(/[LRC]$/, '')));
    if (!hasRw) continue;
    const f = lastFix(p);
    if (!f) continue;
    const diff = Math.abs(wrap180(gcBearing(dep.lat, dep.lon, f.lat, f.lon) - brg));
    if (diff < bestScore) {
      bestScore = diff;
      sid = p.ident;
    }
  }
  // Arrival runway with an ILS, aligned with the wind.
  const arrEnd = arr.end(o.arrRwy) ?? arr.bestEnd(windFrom, windKt);
  const approach = db.proceduresFor(arr.ident, 'IAP').find((p) => p.runway === arrEnd.id && p.approachType === 'ILS')
    ?? db.proceduresFor(arr.ident, 'IAP').find((p) => p.runway === arrEnd.id) ?? null;
  // STAR whose entry is closest in direction to where we come from.
  let star: string | null = null;
  let starTransition: string | null = null;
  bestScore = 70;
  const back = gcBearing(arr.lat, arr.lon, dep.lat, dep.lon);
  for (const p of db.proceduresFor(arr.ident, 'STAR')) {
    for (const t of p.transitions) {
      if (t.name.startsWith('RW')) continue;
      const first = t.legs.find((l) => l.lat !== undefined);
      if (!first) continue;
      const diff = Math.abs(wrap180(gcBearing(arr.lat, arr.lon, first.lat!, first.lon!) - back));
      const dist = Math.hypot(first.lat! - arr.lat, first.lon! - arr.lon);
      if (diff < bestScore && dist > 0.3) {
        bestScore = diff;
        star = p.ident;
        starTransition = t.name;
      }
    }
  }
  return { depRwy: depEnd.id, sid, arrRwy: arrEnd.id, star, starTransition, approach: approach?.ident ?? null };
}

export class Simulation {
  readonly options: SimOptions;
  readonly world: WorldData;
  readonly weather: WeatherSystem;
  readonly ac: Aircraft;
  readonly radios = new RadioStack();
  readonly ap: Autopilot;
  plan: FlightPlan | null = null;
  planErrors: string[] = [];
  readonly warnings: Warnings;
  depAirport: Airport;
  arrAirport: Airport;
  depEnd: RunwayEnd;
  arrEnd: RunwayEnd;
  paused = false;
  timeScale = 1;
  elapsed = 0;
  /** Simulation clock (UTC). */
  clock: Date;
  messages: Message[] = [];
  landingReports: LandingReport[] = [];
  assists: { autoTrim: boolean };
  pilot: PilotInput = { pitch: 0, roll: 0, yaw: 0 };
  takeoffFlap = 3;
  startKind: StartKind;
  apDiscFlash = 0;

  constructor(world: WorldData, options: Partial<SimOptions> = {}) {
    const o = { ...DEFAULT_OPTIONS, ...options };
    this.options = o;
    this.world = world;
    const db = world.nav;
    this.depAirport = db.airport(o.dep) ?? world.home;
    this.arrAirport = db.airport(o.arr) ?? this.depAirport;
    // Weather.
    const grid = world.weatherSeed?.grid ?? { south: 29.8, west: -100, step: 0.1, rows: 58, cols: 58 };
    const seed = o.weather === 'live' && world.weatherSeed ? decodeSeed(world.weatherSeed) : presetSeed(o.weather === 'live' ? 'clear' : o.weather, grid, o.custom, o.seed);
    this.weather = new WeatherSystem(seed, world.proj, { evolution: o.weatherRate, seed: o.seed });
    // Sim clock: today's date at the chosen local hour (Central time, UTC-5 in daylight time).
    const now = new Date();
    this.clock = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0) + (o.hour + 5) * 3600 * 1000);
    this.ac = new Aircraft(world, this.weather);
    this.ac.payload = clamp(o.pax, 0, B739.maxPax) * B739.paxMass;
    this.ac.fuel = clamp(o.fuel, 1000, B739.maxFuel);
    this.ap = new Autopilot(this.ac, this.radios, db);
    this.assists = { autoTrim: o.autoTrim };
    this.warnings = new Warnings(this);
    // Runways from the wind when not chosen.
    const sw = this.surfaceWind(this.depAirport);
    this.depEnd = this.depAirport.end(o.depRwy) ?? this.depAirport.bestEnd(sw.from, sw.kt);
    const aw = this.surfaceWind(this.arrAirport);
    this.arrEnd = this.arrAirport.end(o.arrRwy) ?? this.arrAirport.bestEnd(aw.from, aw.kt);
    this.buildPlan();
    this.startKind = o.start;
    this.setupStart(o.start);
  }

  surfaceWind(ap: Airport): { from: number; kt: number } {
    const s = this.weather.sample(ap.x, ap.z, ap.elevM + 10, ap.elevM);
    return { from: s.windFrom, kt: s.windSpeed / KT };
  }

  get vspeeds(): VSpeeds {
    return vSpeeds(this.ac.mass, this.takeoffFlap, this.ac.mass);
  }

  private planSpec(): PlanSpec {
    const o = this.options;
    return {
      origin: this.depAirport.ident, depRunway: this.depEnd.id, sid: o.sid, sidTransition: o.sidTransition, route: o.route,
      star: o.star, starTransition: o.starTransition, approach: o.approach, dest: this.arrAirport.ident, arrRunway: this.arrEnd.id,
      cruiseAltFt: o.cruiseAlt,
    };
  }

  buildPlan(spec?: PlanSpec): string[] {
    const res = FlightPlan.build(this.world.nav, spec ?? this.planSpec());
    this.planErrors = [...res.errors, ...res.warnings];
    if (res.plan) {
      this.plan = res.plan;
      this.ap.plan = res.plan;
      this.arrEnd = res.plan.arrEnd;
      this.autotune(true);
    }
    return this.planErrors;
  }

  /** FMC autotune: the destination ILS on both NAV radios (when it has one). */
  autotune(force = false): void {
    if (!this.radios.autotune && !force) return;
    const e = this.arrEnd;
    if (!e.ils) return;
    const course = Math.round(e.ils.magCrs);
    if (this.radios.nav1.active !== e.ils.freq) this.radios.nav1.tune(e.ils.freq, course);
    if (this.radios.nav2.active !== e.ils.freq) this.radios.nav2.tune(e.ils.freq, course);
  }

  private setupStart(kind: StartKind): void {
    const ac = this.ac;
    const ap = this.ap;
    const c = ac.controls;
    const o = this.options;
    ap.mcp.alt = Math.min(10000, Math.round(o.cruiseAlt / 1000) * 1000);
    const qnh = this.weather.qnh(this.depAirport.x, this.depAirport.z);
    ac.baroSetting = qnh;
    if (kind === 'runway') {
      const end = this.depEnd;
      const [x, z] = end.pointOnFinal(-60);
      c.flapLever = 3;
      this.takeoffFlap = 3;
      c.gearDown = true;
      c.autobrake = 'RTO';
      c.throttle = [0, 0];
      ac.placeOnGround(x, z, end.heading);
      c.trim = clamp(0.18 + (ac.mass - 65000) / 60000, -0.2, 0.6);
      const vs = this.vspeeds;
      ap.mcp.spd = vs.v2;
      ap.mcp.hdg = Math.round(end.magHeading);
      ap.atArm = true;
      ap.at = 'ARM';
      ap.fd = true;
      // Departure radios: the runway's ILS (for the back course display) on NAV 1 is not useful;
      // tune the on-field VOR when there is one, NAV 2 the destination ILS.
      const vor = this.world.nav.navaids.filter((n) => n.isVor).sort((a, b) => Math.hypot(a.x - x, a.z - z) - Math.hypot(b.x - x, b.z - z))[0];
      if (vor) this.radios.nav1.tune(vor.raw.freq, Math.round(end.magHeading));
      this.radios.autotune = false;
      if (this.arrEnd.ils) this.radios.nav2.tune(this.arrEnd.ils.freq, Math.round(this.arrEnd.ils.magCrs));
      this.message(`Cleared for takeoff ${end.name}. V1 ${vs.v1} VR ${vs.vr} V2 ${vs.v2}. ${this.metar(this.depAirport)}`);
    } else if (kind === 'approach' || kind === 'final') {
      const end = this.arrEnd;
      const final = kind === 'final';
      const dist = final ? 5 * NM : 13 * NM;
      const [x, z] = end.pointOnFinal(dist);
      const gsH = (dist + end.gsOffset) * Math.tan(end.gpa * DEG);
      const alt = end.elevM + (final ? gsH : Math.min(gsH - 180, 3000 * FT));
      const flaps = final ? 7 : 3;
      const vref = vSpeeds(ac.mass, 3, ac.mass).vref30;
      const spd = final ? vref + 5 : 190;
      ac.baroSetting = this.weather.qnh(end.x, end.z);
      ac.setTrimmedFlight([x, alt, z], end.heading, spd, final ? -end.gpa : 0, { flaps, gearDown: final });
      c.autobrake = '2';
      c.speedbrakeArmed = final;
      if (this.plan) this.plan.active = this.plan.runwayIndex;
      this.radios.autotune = true;
      this.autotune(true);
      ap.mcp.spd = spd;
      ap.mcp.hdg = Math.round(end.magHeading);
      ap.mcp.alt = Math.round((end.elevM / FT + 3000) / 100) * 100;
      ap.atArm = true;
      ap.at = 'MCP SPD';
      if (!final && o.apOnApproach && end.ils) {
        ap.engage(true);
        ap.setLat('HDG HOLD');
        ap.holdTrack = end.heading;
        ap.altHold();
        ap.app();
        this.message(`Inbound on the ${end.name} localizer, APP armed. ${this.metar(this.arrAirport)}`);
      } else {
        ap.atArm = false;
        ap.at = null;
        this.message(`Short final ${end.name}. Flaps 30, gear down, Vref ${vref}. ${this.metar(this.arrAirport)}`);
      }
      ac.updateDerived(0);
    } else if (kind === 'cruise') {
      const plan = this.plan!;
      const total = plan.remaining(this.depEnd.x, this.depEnd.z);
      const fromDest = Math.min(120 * NM, total * 0.5);
      // Walk back along the route from the destination runway.
      let remaining = fromDest;
      let px = this.depEnd.x;
      let pz = this.depEnd.z;
      let hdg = this.depEnd.heading;
      let idx = 1;
      const fixes = plan.legs.map((l, i) => ({ l, i })).filter(({ l, i }) => l.type === 'fix' && i <= plan.runwayIndex);
      for (let k = fixes.length - 1; k > 0; k--) {
        const a = fixes[k - 1].l;
        const b = fixes[k].l;
        const seg = Math.hypot(b.x - a.x, b.z - a.z);
        if (seg >= remaining || k === 1) {
          const t = clamp(1 - remaining / Math.max(seg, 1), 0, 1);
          px = a.x + (b.x - a.x) * t;
          pz = a.z + (b.z - a.z) * t;
          hdg = wrap360(Math.atan2(b.x - a.x, -(b.z - a.z)) * RAD);
          idx = fixes[k].i;
          break;
        }
        remaining -= seg;
      }
      const altFt = Math.min(o.cruiseAlt, Math.max(12000, (fromDest / NM) * 250));
      ac.baroStd = altFt > 18000;
      ac.setTrimmedFlight([px, altFt * FT, pz], hdg, altFt > 26000 ? 270 : 280, 0, { flaps: 0, gearDown: false });
      plan.active = idx;
      ap.mcp.alt = Math.round(altFt / 100) * 100;
      ap.mcp.spd = 280;
      ap.mcp.mach = 0.78;
      ap.mcp.useMach = altFt > 26000;
      ap.mcp.hdg = Math.round(wrap360(hdg - ap.magVar));
      ap.atArm = true;
      ap.engage(true);
      ap.setLat('LNAV');
      ap.altHold();
      c.autobrake = '2';
      this.radios.autotune = true;
      this.autotune(true);
      ac.updateDerived(0);
      this.message(`Cruising at ${altFt > 18000 ? `FL${Math.round(altFt / 100)}` : `${Math.round(altFt)} ft`}, ${Math.round(fromDest / NM)} nm from ${this.arrAirport.ident}. Plan your descent (VNAV or LVL CHG).`);
    }
  }

  message(text: string, kind: Message['kind'] = 'info'): void {
    this.messages.push({ text, kind });
  }

  update(frameDt: number, pilot: PilotInput): void {
    if (this.paused || this.ac.crashed || !(frameDt > 0)) return;
    const dt = Math.min(frameDt, 0.1) * this.timeScale;
    const n = Math.max(1, Math.ceil(dt * PHYSICS_HZ));
    const h = dt / n;
    const ac = this.ac;
    const c = ac.controls;
    const ap = this.ap;
    this.pilot = pilot;
    if (ap.cmd && (Math.abs(pilot.pitch) > 0.4 || Math.abs(pilot.roll) > 0.4)) ap.disconnect('override');
    for (let i = 0; i < n; i++) {
      if (!ap.cmd) {
        c.pitch = pilot.pitch;
        c.roll = pilot.roll;
      }
      if (!(ap.cmd && ap.lat === 'ROLLOUT')) c.yaw = pilot.yaw;
      // Like Infinite Flight, the roll input also steers the nosewheel while taxiing.
      c.tiller = pilot.tiller || (ac.wow && ac.gs < 40 * KT ? pilot.roll * 0.6 : 0);
      c.brakeL = pilot.brakeL || 0;
      c.brakeR = pilot.brakeR || 0;
      ap.update(h);
      if (!ap.cmd) this.manualAssists(h);
      ac.step(h);
      this.elapsed += h;
      if (ac.crashed) break;
    }
    this.clock = new Date(this.clock.getTime() + dt * 1000);
    const [lat, lon] = this.world.proj.toLatLon(ac.pos[0], ac.pos[2]);
    this.radios.update(dt, this.world.nav, ac.pos[0], ac.pos[1], ac.pos[2], ac.heading, this.world.magVar.at(lat, lon));
    if (this.plan && this.radios.autotune && this.plan.remaining(ac.pos[0], ac.pos[2]) < 60 * NM) this.autotune();
    this.weather.update(dt, ac.pos[0], ac.pos[2]);
    this.warnings.update(dt);
    this.processEvents();
    if (this.apDiscFlash > 0) this.apDiscFlash -= dt;
  }

  private manualAssists(dt: number): void {
    const ac = this.ac;
    const c = ac.controls;
    if (this.assists.autoTrim && !ac.wow && ac.ias > 90 * KT && Math.abs(c.pitch) < 0.06 && Math.abs(ac.roll) < 50) {
      c.trim = clamp(c.trim - ac.w[2] * 2.2 * dt, -1, 1);
    }
  }

  private processEvents(): void {
    const ac = this.ac;
    for (const e of ac.events) {
      if (e.type === 'touchdown') this.onTouchdown(e.data);
      if (e.type === 'crash') this.message(`CRASH: ${e.reason}`, 'crash');
      if (e.type === 'tailstrike') this.message('Tail strike!', 'warn');
      if (e.type === 'autobrakeDisarm') this.message('Autobrake disarmed');
    }
    ac.events.length = 0;
    for (const e of this.ap.events) {
      if (e === 'apDisconnect') {
        this.warnings.trigger('apDisconnect');
        this.apDiscFlash = 3;
      }
      if (e === 'apOverride') this.message('Autopilot disconnected by control input', 'warn');
      if (e === 'atDisconnect') this.warnings.trigger('atDisconnect');
      if (e === 'locCapture') this.message('LOC captured');
      if (e === 'vorCapture') this.message('VOR radial captured');
      if (e === 'gsCapture') this.message('G/S captured');
      if (e === 'goAround') this.message('Go-around! Missed approach active in LNAV', 'warn');
      if (e === 'tod') this.message('Top of descent');
    }
    this.ap.events.length = 0;
  }

  private onTouchdown(td: import('./fdm.ts').TouchdownData): void {
    const ac = this.ac;
    let best: { end: RunwayEnd; along: number; xtk: number } | null = null;
    let bestScore = Infinity;
    for (const a of this.world.nav.airportsNear(td.pos[0], td.pos[2], 8000)) {
      for (const e of a.ends) {
        const d = e.ilsDeviation(td.pos[0], td.pos[1], td.pos[2]);
        const hdgErr = Math.abs(wrap180(ac.heading - e.heading));
        if (hdgErr > 60) continue;
        const score = Math.abs(d.xtk) + hdgErr * 10;
        if (score < bestScore && d.along < 200 && d.along > -e.runway.lengthM && Math.abs(d.xtk) < e.runway.widthM) {
          bestScore = score;
          best = { end: e, along: d.along, xtk: d.xtk };
        }
      }
    }
    const vs = td.vs;
    const grade = vs > -60 ? 'Butter!' : vs > -180 ? 'Smooth' : vs > -360 ? 'Firm' : vs > -600 ? 'Hard' : 'Very hard';
    const report: LandingReport = {
      grade, vs: Math.round(vs), g: td.peakG.toFixed(2), ias: Math.round(td.ias), pitch: td.pitch.toFixed(1), roll: td.roll.toFixed(1),
      crab: td.crab.toFixed(1), runway: best ? best.end.name : td.surface === 'grass' ? 'off-runway (grass)' : 'off-runway',
      fromThreshold: best ? Math.round(-best.along / FT) : null, centerline: best ? Math.round(best.xtk / FT) : null,
      windshear: this.warnings.active.has('windshear'),
    };
    this.landingReports.push(report);
    this.message(`Touchdown: ${grade} ${report.vs} fpm, ${report.g} g`, 'landing');
  }

  // ------------------------------------------------------------------ reports

  metar(ap: Airport): string {
    return this.weather.metar(ap.ident, ap.x, ap.z, ap.elevM, this.clock);
  }

  /** ATIS broadcast text for an airport, with runways in use. */
  atis(ap: Airport): string {
    const w = this.surfaceWind(ap);
    const s = this.weather.sample(ap.x, ap.z, ap.elevM + 10, ap.elevM);
    const letter = String.fromCharCode(65 + (Math.floor(this.clock.getTime() / 3.6e6) % 26));
    const magWind = Math.round(wrap360(w.from - ap.magVar) / 10) * 10 || 360;
    const ends = ap.ends.filter((e) => e.runway.lengthM > 1500);
    const into = ends.filter((e) => Math.cos((e.heading - w.from) * DEG) > 0.2 || w.kt < 4);
    let arr: RunwayEnd[];
    let dep: RunwayEnd[];
    if (ap.ident === 'KDFW') {
      // DFW flow: arrivals on the outboard and centre runways, departures on the inboard pair.
      const south = Math.cos((180 - w.from) * DEG) > -0.1;
      arr = (south ? ['17C', '17L', '18R', '13R'] : ['35C', '35R', '36L', '31R']).map((id) => ap.end(id)!).filter(Boolean);
      dep = (south ? ['17R', '18L'] : ['35L', '36R']).map((id) => ap.end(id)!).filter(Boolean);
    } else {
      const list = (into.length ? into : ends).sort((a, b) => b.runway.lengthM - a.runway.lengthM);
      arr = list.slice(0, 2);
      dep = list.slice(0, 2);
    }
    const qnh = hPaToInHg(s.qnhPa / 100).toFixed(2);
    const vis = s.vis / 1609.34;
    const cloud = this.weather.layersAt(ap.x, ap.z, ap.elevM).map((l) => {
      const c = l.cover < 0.25 ? 'few clouds' : l.cover < 0.5 ? 'scattered' : l.cover < 0.88 ? 'broken' : 'overcast';
      return `${c} ${Math.round((l.base - ap.elevM) / FT / 100) * 100}${l.type === 'cb' ? ' cumulonimbus' : ''}`;
    });
    const zulu = `${String(this.clock.getUTCHours()).padStart(2, '0')}${String(this.clock.getUTCMinutes()).padStart(2, '0')}`;
    const appType = arr.some((e) => e.ils) ? 'ILS' : 'Visual';
    return [
      `${ap.name.replace(/\b\w/g, (m) => m.toUpperCase()).toLowerCase().replace(/\b\w/g, (m) => m.toUpperCase())} information ${letter}, ${zulu} Zulu.`,
      `Wind ${String(magWind).padStart(3, '0')} at ${Math.round(w.kt)}.`,
      `Visibility ${vis >= 10 ? '10' : vis.toFixed(vis < 3 ? 1 : 0)}.`,
      cloud.length ? `${cloud.join(', ')}.` : 'Sky clear.',
      `Temperature ${Math.round(s.tempC)}, dewpoint ${Math.round(s.dewpointC)}. Altimeter ${qnh}.`,
      `${appType} approaches runway${arr.length > 1 ? 's' : ''} ${arr.map((e) => e.id).join(', ')} in use. Departing runway${dep.length > 1 ? 's' : ''} ${dep.map((e) => e.id).join(', ')}.`,
      s.precip > 2 ? 'Braking action reports: wet runways.' : '',
      `Advise on initial contact you have information ${letter}.`,
    ].filter(Boolean).join(' ');
  }

  routeInfo(): { remainingNm: number; ete: number; nextWp: string; nextDist: number; todNm: number | null } {
    const ac = this.ac;
    const plan = this.plan;
    const gs = Math.max(ac.gs, 60);
    if (!plan) return { remainingNm: 0, ete: 0, nextWp: '', nextDist: 0, todNm: null };
    const rem = plan.remaining(ac.pos[0], ac.pos[2]);
    const leg = plan.activeLeg;
    return {
      remainingNm: rem / NM, ete: rem / gs, nextWp: leg?.ident ?? '',
      nextDist: leg && leg.type === 'fix' ? Math.hypot(leg.x - ac.pos[0], leg.z - ac.pos[2]) / NM : 0,
      todNm: ac.pos[1] > 3000 * FT ? plan.topOfDescentNm(ac.pos[0], ac.pos[2]) : null,
    };
  }

  /** Set the altimeter to the local QNH (or standard). */
  setBaro(std: boolean): void {
    const ac = this.ac;
    ac.baroStd = std;
    if (!std) ac.baroSetting = this.weather.qnh(ac.pos[0], ac.pos[2]);
  }
}


