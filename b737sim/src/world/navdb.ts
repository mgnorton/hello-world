// Real-world navigation database (FAA NASR + CIFP) projected into the local frame.
import { DEG, FT, NM, RAD, dirOf, wrap360 } from '../core/math.ts';
import { Projection, MagVar } from './geo.ts';

// ---------------------------------------------------------------- raw JSON shapes
export interface RawIls { ident: string; freq: number; magCrs: number; gs: number | null; cat: string; dme: boolean; type: string }
export interface RawRunwayEnd {
  id: string; lat: number; lon: number; elevFt: number; trueHdg: number;
  displacedFt?: number; tchFt?: number; gpa?: number; tdzeFt?: number; vgsi?: string; als?: string;
  cl?: number; tdz?: number; reil?: number; marking?: string; ils?: RawIls;
}
export interface RawRunway { id: string; lengthFt: number; widthFt: number; surface: string; lighting: string | null; ends: RawRunwayEnd[] }
export interface RawAirport {
  id: string; icao: string | null; name: string; city: string; state: string; lat: number; lon: number; elevFt: number;
  magVar: number; towered: boolean; freqs: Record<string, number>; runways: RawRunway[];
}
export interface RawNavaid {
  id: string; name: string; type: string; lat: number; lon: number; elevFt: number; freq: number; unit: 'MHz' | 'kHz';
  cls: string; stationVar: number; dme: boolean;
}
export interface RawFix { id: string; lat: number; lon: number }
export interface RawAirway { id: string; pts: { id: string; lat: number; lon: number; mea: number | null }[] }
export interface AltConstraint { d: string; a1: number | null; a2: number | null }
export interface RawLeg {
  pt: string; fix?: string; lat?: number; lon?: number; cat?: string; crs?: number; dist?: number;
  alt?: AltConstraint; spd?: { d: string; kt: number }; turn?: string; flyover?: number; faf?: number; map?: number;
  va?: number; nav?: string; arc?: number; center?: string; clat?: number; clon?: number;
}
export interface RawProcedure {
  airports: string[]; type: 'SID' | 'STAR' | 'IAP'; name: string; ident: string; runway: string | null; approachType: string | null;
  common: { airports: string[] | null; legs: RawLeg[] }[];
  transitions: { name: string; legs: RawLeg[] }[];
  missed: RawLeg[] | null;
}
export interface NavDataJson {
  cycle: string; cifpCycle: string; magModel: string; sources: string;
  airports: RawAirport[]; navaids: RawNavaid[]; fixes: RawFix[]; airways: RawAirway[]; procedures: RawProcedure[];
}

// ---------------------------------------------------------------- model classes
export interface IlsDeviation {
  /** Distance before the threshold along the course (m, + on approach). */
  along: number;
  /** Cross-track (m, + = right of course looking along the landing direction). */
  xtk: number;
  /** Localizer angular deviation (deg, + = aircraft right of course). */
  locDev: number;
  /** Glide slope deviation (deg, + = above path). */
  gsDev: number;
  /** DME distance (nm) from the localizer/glide-slope DME. */
  dme: number;
  /** Horizontal distance to the glide-slope antenna (m). */
  gsDist: number;
  /** Height above threshold elevation (m). */
  h: number;
}

export class RunwayEnd {
  readonly x: number;
  readonly z: number;
  readonly elevM: number;
  /** Direction of travel when landing on / departing from this end (true degrees). */
  readonly heading: number;
  readonly displacedM: number;
  readonly tchM: number;
  readonly gpa: number;
  /** Landing threshold position (accounts for displaced thresholds). */
  readonly tx: number;
  readonly tz: number;
  /** Distance from the landing threshold to where the glide path meets the runway. */
  readonly gsOffset: number;
  readonly ils: RawIls | null;
  constructor(readonly raw: RawRunwayEnd, readonly runway: Runway, proj: Projection) {
    [this.x, this.z] = proj.toLocal(raw.lat, raw.lon);
    this.elevM = raw.elevFt * FT;
    this.heading = raw.trueHdg;
    this.displacedM = (raw.displacedFt ?? 0) * FT;
    this.tchM = (raw.tchFt ?? 50) * FT;
    this.gpa = raw.ils?.gs ?? raw.gpa ?? 3.0;
    const d = dirOf(this.heading);
    this.tx = this.x + d[0] * this.displacedM;
    this.tz = this.z + d[2] * this.displacedM;
    this.gsOffset = this.tchM / Math.tan(this.gpa * DEG);
    this.ils = raw.ils ?? null;
  }
  get id(): string {
    return this.raw.id;
  }
  get airport(): Airport {
    return this.runway.airport;
  }
  get name(): string {
    return `${this.airport.ident} ${this.id}`;
  }
  get magHeading(): number {
    return wrap360(this.heading - this.airport.magVar);
  }
  /** Localizer course (magnetic) as published, else the runway's magnetic heading. */
  get courseMag(): number {
    return this.ils ? this.ils.magCrs : this.magHeading;
  }
  get opposite(): RunwayEnd {
    return this.runway.ends[0] === this ? this.runway.ends[1] : this.runway.ends[0];
  }
  /** Point on the extended centreline `dist` metres before the landing threshold. */
  pointOnFinal(dist: number): [number, number] {
    const d = dirOf(this.heading);
    return [this.tx - d[0] * dist, this.tz - d[2] * dist];
  }
  ilsDeviation(x: number, y: number, z: number): IlsDeviation {
    const d = dirOf(this.heading);
    const dx = x - this.tx;
    const dz = z - this.tz;
    const along = -(dx * d[0] + dz * d[2]);
    const xtk = dx * -d[2] + dz * d[0];
    const runwayLen = this.runway.lengthM - this.displacedM;
    const locDist = along + runwayLen + 300;
    const locDev = Math.atan2(xtk, Math.max(1, locDist)) * RAD;
    const gsDist = along + this.gsOffset;
    const h = y - this.elevM;
    const gsDev = Math.atan2(h, Math.max(1, gsDist)) * RAD - this.gpa;
    const dme = Math.hypot(gsDist, xtk, h) / NM;
    return { along, xtk, locDev, gsDev, dme, gsDist, h };
  }
}

export class Runway {
  readonly ends: [RunwayEnd, RunwayEnd];
  readonly lengthM: number;
  readonly widthM: number;
  readonly cx: number;
  readonly cz: number;
  /** True heading from end 0 towards end 1. */
  readonly heading: number;
  constructor(readonly raw: RawRunway, readonly airport: Airport, proj: Projection) {
    this.ends = [new RunwayEnd(raw.ends[0], this, proj), new RunwayEnd(raw.ends[1], this, proj)];
    const [a, b] = this.ends;
    this.lengthM = Math.hypot(b.x - a.x, b.z - a.z);
    this.widthM = raw.widthFt * FT;
    this.cx = (a.x + b.x) / 2;
    this.cz = (a.z + b.z) / 2;
    this.heading = a.heading;
  }
  get id(): string {
    return this.raw.id;
  }
  get paved(): boolean {
    return /CONC|ASPH|PEM|BIT|PFC|GRVD|ASP|CON/.test(this.raw.surface);
  }
  /** Along/across coordinates of a point relative to the runway centre. */
  local(x: number, z: number): { along: number; across: number } {
    const d = dirOf(this.heading);
    const dx = x - this.cx;
    const dz = z - this.cz;
    return { along: dx * d[0] + dz * d[2], across: dx * -d[2] + dz * d[0] };
  }
  contains(x: number, z: number, margin = 0): boolean {
    const { along, across } = this.local(x, z);
    return Math.abs(along) <= this.lengthM / 2 + margin && Math.abs(across) <= this.widthM / 2 + margin;
  }
  /** Runway surface elevation (m) at an along-track position, interpolated between the ends. */
  elevAt(along: number): number {
    const t = Math.max(0, Math.min(1, along / this.lengthM + 0.5));
    return this.ends[0].raw.elevFt * FT * (1 - t) + this.ends[1].raw.elevFt * FT * t;
  }
}

export class Airport {
  readonly x: number;
  readonly z: number;
  readonly elevM: number;
  readonly runways: Runway[];
  readonly ends: RunwayEnd[];
  readonly longest: number;
  constructor(readonly raw: RawAirport, proj: Projection) {
    [this.x, this.z] = proj.toLocal(raw.lat, raw.lon);
    this.elevM = raw.elevFt * FT;
    this.runways = raw.runways.map((r) => new Runway(r, this, proj));
    this.ends = this.runways.flatMap((r) => r.ends);
    this.longest = Math.max(...this.runways.map((r) => r.lengthM));
  }
  get id(): string {
    return this.raw.id;
  }
  /** ICAO identifier when there is one, otherwise the FAA location identifier. */
  get ident(): string {
    return this.raw.icao || this.raw.id;
  }
  get name(): string {
    return this.raw.name;
  }
  get magVar(): number {
    return this.raw.magVar;
  }
  get lat(): number {
    return this.raw.lat;
  }
  get lon(): number {
    return this.raw.lon;
  }
  end(id: string): RunwayEnd | undefined {
    return this.ends.find((e) => e.id === id);
  }
  /** Runway end best aligned with a wind blowing FROM windDirTrue; prefers ILS ends and long runways. */
  bestEnd(windDirTrue: number, windKt: number, jetOnly = true): RunwayEnd {
    let best = this.ends[0];
    let score = -Infinity;
    for (const e of this.ends) {
      if (jetOnly && e.runway.lengthM < 1500) continue;
      const head = Math.cos((e.heading - windDirTrue) * DEG) * Math.max(windKt, 3);
      const s = head * 2 + e.runway.lengthM / 400 + (e.ils ? 4 : 0);
      if (s > score) {
        score = s;
        best = e;
      }
    }
    return best;
  }
}

export class Navaid {
  readonly x: number;
  readonly z: number;
  readonly elevM: number;
  constructor(readonly raw: RawNavaid, proj: Projection) {
    [this.x, this.z] = proj.toLocal(raw.lat, raw.lon);
    this.elevM = raw.elevFt * FT;
  }
  get id(): string {
    return this.raw.id;
  }
  get isVor(): boolean {
    return /VOR/.test(this.raw.type);
  }
  get isNdb(): boolean {
    return /NDB/.test(this.raw.type);
  }
  get isDmeOnly(): boolean {
    return this.raw.type === 'DME' || this.raw.type === 'TACAN';
  }
  /** Standard service volume range (nm) by class. */
  get rangeNm(): number {
    const c = this.raw.cls;
    if (this.isNdb) return /HH/.test(c) ? 75 : /H/.test(c) ? 50 : /MH/.test(c) ? 25 : 15;
    if (/H/.test(c)) return 130;
    if (/L/.test(c)) return 40;
    return 25;
  }
}

export interface Waypoint {
  id: string;
  kind: 'fix' | 'navaid' | 'airport' | 'runway' | 'latlon';
  lat: number;
  lon: number;
  x: number;
  z: number;
}

export class NavDB {
  readonly airports: Airport[];
  readonly navaids: Navaid[];
  readonly fixes: Waypoint[];
  readonly airways = new Map<string, Waypoint[][]>();
  readonly procedures: RawProcedure[];
  private readonly fixIndex = new Map<string, Waypoint[]>();
  private readonly airportIndex = new Map<string, Airport>();

  constructor(readonly raw: NavDataJson, readonly proj: Projection, readonly magVar: MagVar) {
    this.airports = raw.airports.map((a) => new Airport(a, proj));
    this.navaids = raw.navaids.map((n) => new Navaid(n, proj));
    this.fixes = raw.fixes.map((f) => {
      const [x, z] = proj.toLocal(f.lat, f.lon);
      return { id: f.id, kind: 'fix' as const, lat: f.lat, lon: f.lon, x, z };
    });
    for (const a of this.airports) {
      this.airportIndex.set(a.id, a);
      if (a.raw.icao) this.airportIndex.set(a.raw.icao, a);
    }
    const add = (w: Waypoint) => {
      const list = this.fixIndex.get(w.id) ?? [];
      list.push(w);
      this.fixIndex.set(w.id, list);
    };
    for (const f of this.fixes) add(f);
    for (const n of this.navaids) add({ id: n.id, kind: 'navaid', lat: n.raw.lat, lon: n.raw.lon, x: n.x, z: n.z });
    for (const a of raw.airways) {
      const pts = a.pts.map((p) => {
        const [x, z] = proj.toLocal(p.lat, p.lon);
        return { id: p.id, kind: 'fix' as const, lat: p.lat, lon: p.lon, x, z };
      });
      const list = this.airways.get(a.id) ?? [];
      list.push(pts);
      this.airways.set(a.id, list);
    }
    this.procedures = raw.procedures;
  }

  airport(ident: string): Airport | undefined {
    const k = ident.trim().toUpperCase();
    return this.airportIndex.get(k) ?? (k.length === 4 && k.startsWith('K') ? this.airportIndex.get(k.slice(1)) : undefined);
  }

  /** Resolve a named waypoint (fix, navaid or airport), choosing the candidate nearest (x, z). */
  waypoint(ident: string, nearX = 0, nearZ = 0): Waypoint | null {
    const k = ident.trim().toUpperCase();
    const list = [...(this.fixIndex.get(k) ?? [])];
    const ap = this.airport(k);
    if (ap) list.push({ id: ap.ident, kind: 'airport', lat: ap.lat, lon: ap.lon, x: ap.x, z: ap.z });
    let best: Waypoint | null = null;
    let bd = Infinity;
    for (const w of list) {
      const d = Math.hypot(w.x - nearX, w.z - nearZ);
      if (d < bd) {
        bd = d;
        best = w;
      }
    }
    return best;
  }

  navaid(ident: string, nearX = 0, nearZ = 0): Navaid | null {
    let best: Navaid | null = null;
    let bd = Infinity;
    for (const n of this.navaids) {
      if (n.id !== ident) continue;
      const d = Math.hypot(n.x - nearX, n.z - nearZ);
      if (d < bd) {
        bd = d;
        best = n;
      }
    }
    return best;
  }

  airportsNear(x: number, z: number, radius: number): Airport[] {
    return this.airports.filter((a) => Math.abs(a.x - x) < radius && Math.abs(a.z - z) < radius && Math.hypot(a.x - x, a.z - z) < radius);
  }

  /** All localizers (runway ends with an ILS/LOC) on a frequency. */
  localizers(freqMhz: number): RunwayEnd[] {
    const out: RunwayEnd[] = [];
    for (const a of this.airports) for (const e of a.ends) if (e.ils && Math.abs(e.ils.freq - freqMhz) < 0.004) out.push(e);
    return out;
  }

  navaidsOnFreq(freq: number, unit: 'MHz' | 'kHz'): Navaid[] {
    return this.navaids.filter((n) => n.raw.unit === unit && Math.abs(n.raw.freq - freq) < (unit === 'MHz' ? 0.004 : 0.6));
  }

  proceduresFor(icao: string, type?: RawProcedure['type']): RawProcedure[] {
    return this.procedures.filter((p) => p.airports.includes(icao) && (!type || p.type === type));
  }

  /** Airway segment between two named points (inclusive), or null. */
  airwaySegment(airway: string, from: string, to: string): Waypoint[] | null {
    for (const pts of this.airways.get(airway.toUpperCase()) ?? []) {
      const i = pts.findIndex((p) => p.id === from);
      const j = pts.findIndex((p) => p.id === to);
      if (i < 0 || j < 0) continue;
      return i <= j ? pts.slice(i, j + 1) : pts.slice(j, i + 1).reverse();
    }
    return null;
  }

  /** Magnetic heading for a true heading at a position. */
  magnetic(trueDeg: number, x: number, z: number): number {
    const [lat, lon] = this.proj.toLatLon(x, z);
    return wrap360(trueDeg - this.magVar.at(lat, lon));
  }

  /** Bearing (true) and distance (m) between local points. */
  static vector(x1: number, z1: number, x2: number, z2: number): { brg: number; dist: number } {
    return { brg: wrap360(Math.atan2(x2 - x1, -(z2 - z1)) * RAD), dist: Math.hypot(x2 - x1, z2 - z1) };
  }
}

