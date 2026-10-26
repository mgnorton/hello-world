// Flight plan built from real procedures: SID, airways/route, STAR and approach (FAA CIFP).
import { DEG, FT, NM, RAD, wrap360 } from '../core/math.ts';
import type { Airport, NavDB, RawLeg, RawProcedure, RunwayEnd, Waypoint } from '../world/navdb.ts';

export type LegSource = 'DEP' | 'SID' | 'ENR' | 'STAR' | 'APP' | 'MISSED' | 'ARR';

export interface AltRestriction {
  /** 'at', 'above' (at or above), 'below' (at or below), 'between'. */
  kind: 'at' | 'above' | 'below' | 'between';
  /** Feet MSL; for 'between', lo..hi. */
  lo: number;
  hi: number;
}

export interface Leg {
  ident: string;
  /** 'fix': fly to a point. 'course': fly a true course until reaching `untilAltM`. */
  type: 'fix' | 'course';
  x: number;
  z: number;
  lat: number;
  lon: number;
  course?: number; // true degrees for 'course' legs
  untilAltM?: number;
  alt?: AltRestriction;
  speedKt?: number;
  flyover?: boolean;
  faf?: boolean;
  runway?: RunwayEnd;
  source: LegSource;
  /** Procedure name shown on the legs page. */
  via: string;
}

export interface PlanSpec {
  origin: string;
  depRunway: string;
  sid?: string | null;
  sidTransition?: string | null;
  route: string;
  star?: string | null;
  starTransition?: string | null;
  approach?: string | null; // procedure ident, e.g. I17C
  approachTransition?: string | null;
  dest: string;
  arrRunway?: string | null;
  cruiseAltFt: number;
}

export interface BuildResult {
  plan: FlightPlan | null;
  errors: string[];
  warnings: string[];
}

function restriction(l: RawLeg): AltRestriction | undefined {
  const a = l.alt;
  if (!a || a.a1 === null) return undefined;
  const a1 = a.a1;
  const a2 = a.a2 ?? a1;
  switch (a.d) {
    case '-':
      return { kind: 'below', lo: -1e9, hi: a1 };
    case '+':
    case 'H':
    case 'J':
    case 'V':
      return { kind: 'above', lo: a1, hi: 1e9 };
    case 'C':
      return { kind: 'above', lo: a2, hi: 1e9 };
    case 'B':
      return { kind: 'between', lo: Math.min(a1, a2), hi: Math.max(a1, a2) };
    default:
      return { kind: 'at', lo: a1, hi: a1 };
  }
}

/** Runway transition names in CIFP: "RW17C", or "RW17B" for both parallels, or "ALL". */
function matchesRunway(name: string, rw: string): boolean {
  if (name === 'ALL' || name === '') return true;
  if (!name.startsWith('RW')) return false;
  const n = name.slice(2);
  if (n === rw) return true;
  return n.endsWith('B') && n.slice(0, -1) === rw.replace(/[LRC]$/, '');
}

export class FlightPlan {
  legs: Leg[] = [];
  active = 1;
  /** True once the missed approach has been activated (go-around). */
  missedActive = false;
  readonly cruiseAltM: number;

  constructor(readonly db: NavDB, readonly spec: PlanSpec, readonly origin: Airport, readonly depEnd: RunwayEnd,
    readonly dest: Airport, readonly arrEnd: RunwayEnd, readonly approach: RawProcedure | null) {
    this.cruiseAltM = spec.cruiseAltFt * FT;
  }

  static build(db: NavDB, spec: PlanSpec): BuildResult {
    const errors: string[] = [];
    const warnings: string[] = [];
    const origin = db.airport(spec.origin);
    const dest = db.airport(spec.dest);
    if (!origin) errors.push(`Unknown origin airport ${spec.origin}`);
    if (!dest) errors.push(`Unknown destination ${spec.dest}`);
    if (!origin || !dest) return { plan: null, errors, warnings };
    const depEnd = origin.end(spec.depRunway) ?? origin.ends[0];
    if (!origin.end(spec.depRunway)) warnings.push(`Runway ${spec.depRunway} not found at ${origin.ident}; using ${depEnd.id}`);
    let approach: RawProcedure | null = null;
    if (spec.approach) {
      approach = db.proceduresFor(dest.ident, 'IAP').find((p) => p.ident === spec.approach || p.name === spec.approach) ?? null;
      if (!approach) warnings.push(`Approach ${spec.approach} not found at ${dest.ident}`);
    }
    const arrId = approach?.runway ?? spec.arrRunway ?? dest.ends[0].id;
    const arrEnd = dest.end(arrId) ?? dest.ends[0];
    const plan = new FlightPlan(db, spec, origin, depEnd, dest, arrEnd, approach);
    plan.assemble(errors, warnings);
    return { plan: errors.length ? null : plan, errors, warnings };
  }

  private magVarAt(ap: Airport): number {
    return ap.magVar;
  }

  private fixLeg(w: { id: string; lat: number; lon: number }, source: LegSource, via: string, extra: Partial<Leg> = {}): Leg {
    const [x, z] = this.db.proj.toLocal(w.lat, w.lon);
    return { ident: w.id, type: 'fix', x, z, lat: w.lat, lon: w.lon, source, via, ...extra };
  }

  private convertLegs(raw: RawLeg[], source: LegSource, via: string, ap: Airport): Leg[] {
    const out: Leg[] = [];
    for (const l of raw) {
      const common: Partial<Leg> = {
        alt: restriction(l), speedKt: l.spd?.kt, flyover: !!l.flyover, faf: !!l.faf,
      };
      switch (l.pt) {
        case 'IF': case 'TF': case 'CF': case 'DF': case 'AF': case 'RF': case 'HF': case 'HM': case 'HA': case 'FC': case 'FD': {
          if (l.lat === undefined || l.lon === undefined || !l.fix) break;
          const rwMatch = /^RW(\d\d[LRC]?)$/.exec(l.fix);
          const rwEnd = rwMatch ? ap.end(rwMatch[1]) : undefined;
          out.push(this.fixLeg({ id: l.fix, lat: l.lat, lon: l.lon }, source, via, { ...common, runway: rwEnd }));
          break;
        }
        case 'FA': case 'FM': {
          if (l.lat !== undefined && l.lon !== undefined && l.fix) out.push(this.fixLeg({ id: l.fix, lat: l.lat, lon: l.lon }, source, via, common));
          if (l.pt === 'FA' && l.crs !== undefined && l.alt?.a1) {
            out.push(this.courseLeg(l.crs, l.alt.a1, ap, source, via));
          }
          break;
        }
        case 'VA': case 'CA': {
          if (l.crs !== undefined && l.alt?.a1) out.push(this.courseLeg(l.crs, l.alt.a1, ap, source, via));
          break;
        }
        default:
          // VI/CI/VM/VD/CD/PI legs: the next fix is flown direct.
          break;
      }
    }
    return out;
  }

  private courseLeg(crsMag: number, altFt: number, ap: Airport, source: LegSource, via: string): Leg {
    const course = wrap360(crsMag + this.magVarAt(ap));
    return {
      ident: `(${Math.round(altFt)})`, type: 'course', x: 0, z: 0, lat: 0, lon: 0, course, untilAltM: altFt * FT,
      alt: { kind: 'above', lo: altFt, hi: 1e9 }, source, via,
    };
  }

  private assemble(errors: string[], warnings: string[]): void {
    const { db, spec, origin, depEnd, dest, arrEnd } = this;
    const legs: Leg[] = [];
    // Departure runway.
    legs.push(this.fixLeg({ id: `RW${depEnd.id}`, lat: depEnd.raw.lat, lon: depEnd.raw.lon }, 'DEP', origin.ident, { runway: depEnd }));
    const depElevFt = depEnd.elevM / FT;
    // SID.
    let sidLegs: Leg[] = [];
    if (spec.sid) {
      const sid = db.proceduresFor(origin.ident, 'SID').find((p) => p.ident === spec.sid || p.name === spec.sid);
      if (!sid) warnings.push(`SID ${spec.sid} not found at ${origin.ident}`);
      else {
        const rwT = sid.transitions.filter((t) => t.name.startsWith('RW') || t.name === 'ALL');
        const rw = rwT.find((t) => matchesRunway(t.name, depEnd.id));
        if (rwT.length && !rw) warnings.push(`${sid.name} has no transition for runway ${depEnd.id}`);
        if (rw) sidLegs.push(...this.convertLegs(rw.legs, 'SID', sid.name, origin));
        for (const c of sid.common) sidLegs.push(...this.convertLegs(c.legs, 'SID', sid.name, origin));
        if (spec.sidTransition) {
          const t = sid.transitions.find((x) => x.name === spec.sidTransition);
          if (t) sidLegs.push(...this.convertLegs(t.legs, 'SID', `${sid.name}.${t.name}`, origin));
          else warnings.push(`${sid.name} transition ${spec.sidTransition} not found`);
        }
      }
    }
    // Climb straight out to 400 ft before turning when the SID starts with a heading leg.
    if (!sidLegs.length || sidLegs[0].type === 'fix') {
      legs.push({ ...this.courseLeg(depEnd.courseMag, depElevFt + 400, origin, 'DEP', origin.ident), course: depEnd.heading });
    }
    legs.push(...sidLegs);

    // En-route: waypoints and airways.
    const tokens = spec.route.toUpperCase().split(/[\s,]+/).filter((t) => t && t !== 'DCT');
    let lastX = legs[legs.length - 1].x || depEnd.x;
    let lastZ = legs[legs.length - 1].z || depEnd.z;
    let lastId = legs[legs.length - 1].ident;
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];
      if (db.airways.has(t) && i + 1 < tokens.length) {
        const to = tokens[i + 1];
        const seg = db.airwaySegment(t, lastId, to);
        if (!seg) {
          errors.push(`${t} does not connect ${lastId} and ${to}`);
          continue;
        }
        for (const p of seg.slice(1)) legs.push(this.fixLeg(p, 'ENR', t));
        const end = seg[seg.length - 1];
        lastX = end.x;
        lastZ = end.z;
        lastId = end.id;
        i++;
        continue;
      }
      const w: Waypoint | null = db.waypoint(t, lastX, lastZ);
      if (!w) {
        errors.push(`Unknown waypoint ${t}`);
        continue;
      }
      if (w.id === lastId) continue;
      legs.push(this.fixLeg(w, 'ENR', 'DCT'));
      lastX = w.x;
      lastZ = w.z;
      lastId = w.id;
    }

    // STAR.
    if (spec.star) {
      const star = db.proceduresFor(dest.ident, 'STAR').find((p) => p.ident === spec.star || p.name === spec.star);
      if (!star) warnings.push(`STAR ${spec.star} not found at ${dest.ident}`);
      else {
        const enr = spec.starTransition ? star.transitions.find((t) => t.name === spec.starTransition) : undefined;
        if (spec.starTransition && !enr) warnings.push(`${star.name} transition ${spec.starTransition} not found`);
        if (enr) legs.push(...this.convertLegs(enr.legs, 'STAR', `${star.name}.${enr.name}`, dest));
        for (const c of star.common) legs.push(...this.convertLegs(c.legs, 'STAR', star.name, dest));
        const rw = star.transitions.find((t) => t.name.startsWith('RW') && matchesRunway(t.name, arrEnd.id));
        if (rw) legs.push(...this.convertLegs(rw.legs, 'STAR', star.name, dest));
      }
    }

    // Approach.
    const ap = this.approach;
    if (ap) {
      if (spec.approachTransition) {
        const tr = ap.transitions.find((t) => t.name === spec.approachTransition);
        if (tr) legs.push(...this.convertLegs(tr.legs, 'APP', `${ap.name}.${tr.name}`, dest));
      }
      for (const c of ap.common) legs.push(...this.convertLegs(c.legs, 'APP', ap.name, dest));
      if (ap.missed) {
        for (const l of this.convertLegs(ap.missed, 'MISSED', `${ap.name} MISSED`, dest)) legs.push(l);
      }
    } else {
      // Visual / vectors: a 10 nm final fix and the runway threshold.
      const [fx, fz] = arrEnd.pointOnFinal(10 * NM);
      const [flat, flon] = db.proj.toLatLon(fx, fz);
      legs.push(this.fixLeg({ id: `FI${arrEnd.id}`, lat: flat, lon: flon }, 'ARR', 'FINAL', { alt: { kind: 'at', lo: Math.round((arrEnd.elevM / FT + 3000) / 100) * 100, hi: Math.round((arrEnd.elevM / FT + 3000) / 100) * 100 } }));
      const [tlat, tlon] = db.proj.toLatLon(arrEnd.tx, arrEnd.tz);
      legs.push(this.fixLeg({ id: `RW${arrEnd.id}`, lat: tlat, lon: tlon }, 'ARR', 'FINAL', { runway: arrEnd, alt: { kind: 'at', lo: Math.round(arrEnd.elevM / FT + 50), hi: Math.round(arrEnd.elevM / FT + 50) } }));
    }
    // Remove consecutive duplicates.
    this.legs = legs.filter((l, i) => i === 0 || l.type === 'course' || l.ident !== legs[i - 1].ident);
    this.active = 1;
  }

  get activeLeg(): Leg | null {
    return this.legs[this.active] ?? null;
  }

  /** Index of the runway (missed approach point) leg at the destination. */
  get runwayIndex(): number {
    for (let i = this.legs.length - 1; i >= 0; i--) if (this.legs[i].runway === this.arrEnd) return i;
    return this.legs.length - 1;
  }

  /** Position of the leg's start point (previous fix, or a fallback). */
  legStart(i: number): { x: number; z: number } {
    for (let k = i - 1; k >= 0; k--) {
      const l = this.legs[k];
      if (l.type === 'fix') return { x: l.x, z: l.z };
    }
    return { x: this.depEnd.x, z: this.depEnd.z };
  }

  /** Distance (m) along the route from (x, z) through leg `upTo` (inclusive), starting at the active leg. */
  distanceTo(x: number, z: number, upTo: number): number {
    let d = 0;
    let px = x;
    let pz = z;
    for (let i = this.active; i <= upTo && i < this.legs.length; i++) {
      const l = this.legs[i];
      if (l.type !== 'fix') continue;
      d += Math.hypot(l.x - px, l.z - pz);
      px = l.x;
      pz = l.z;
    }
    return d;
  }

  /** Remaining distance to the destination runway (m). */
  remaining(x: number, z: number): number {
    return this.distanceTo(x, z, this.runwayIndex);
  }

  /** Go direct to a leg from the present position. */
  directTo(i: number): void {
    this.active = Math.max(1, Math.min(this.legs.length - 1, i));
  }

  /**
   * VNAV descent path altitude (m) at the aircraft: the lowest altitude needed to meet every
   * downstream "at"/"at or below" restriction on a 3 degree path, capped at cruise altitude.
   */
  descentPathAlt(x: number, z: number): { alt: number; raw: number; nextConstraint: Leg | null; distNm: number } {
    const slope = Math.tan(3 * DEG);
    let best = Infinity;
    let next: Leg | null = null;
    let nd = 0;
    const end = this.missedActive ? this.legs.length - 1 : this.runwayIndex;
    let d = 0;
    let px = x;
    let pz = z;
    for (let i = this.active; i <= end; i++) {
      const l = this.legs[i];
      if (l.type !== 'fix') continue;
      d += Math.hypot(l.x - px, l.z - pz);
      px = l.x;
      pz = l.z;
      let target: number;
      if (i === this.runwayIndex && !this.missedActive) {
        // The path always ends at the threshold crossing height.
        target = this.arrEnd.elevM + this.arrEnd.tchM;
      } else {
        if (!l.alt || l.source === 'SID' || l.source === 'DEP' || l.source === 'MISSED') continue;
        // Approach fixes published "at or above" (FAF / glide slope intercept) are flown at that altitude.
        if (l.alt.kind === 'above' && l.source !== 'APP') continue;
        target = (l.alt.kind === 'above' ? l.alt.lo : l.alt.hi) * FT;
      }
      const a = target + d * slope;
      if (a < best) {
        best = a;
        next = l;
        nd = d / NM;
      }
    }
    return { alt: Math.min(best, this.cruiseAltM), raw: best, nextConstraint: next, distNm: nd };
  }

  /** Distance (nm) to the top of descent from cruise altitude, or null when past it. */
  topOfDescentNm(x: number, z: number): number | null {
    const p = this.descentPathAlt(x, z);
    if (!Number.isFinite(p.raw) || p.raw <= this.cruiseAltM) return null;
    return (p.raw - this.cruiseAltM) / Math.tan(3 * DEG) / NM;
  }

  /** Climb restriction ceiling ahead ("at or below" in the SID), metres, or Infinity. */
  climbCeiling(): number {
    for (let i = this.active; i < this.legs.length; i++) {
      const l = this.legs[i];
      if (l.source !== 'SID' && l.source !== 'DEP') break;
      if (l.alt && (l.alt.kind === 'below' || l.alt.kind === 'at')) return l.alt.hi * FT;
    }
    return Infinity;
  }

  /** Speed restriction applying to the active part of the route (kt), if any. */
  speedLimit(): number | null {
    for (let i = this.active; i < Math.min(this.legs.length, this.active + 3); i++) {
      if (this.legs[i].speedKt) return this.legs[i].speedKt!;
    }
    return null;
  }

  /** Summary string like "KDFW AKUNA9 ... BOOVE7 I17C KIAH". */
  describe(): string {
    const s = this.spec;
    return [this.origin.ident, `RW${this.depEnd.id}`, s.sid ?? '', s.route, s.star ?? '', this.approach?.name ?? `RW${this.arrEnd.id}`, this.dest.ident].filter(Boolean).join(' ');
  }
}

/** True course (deg) and length (m) of the path into leg i. */
export function legGeometry(plan: FlightPlan, i: number): { course: number; len: number } {
  const l = plan.legs[i];
  if (l.type === 'course') return { course: l.course!, len: 0 };
  const s = plan.legStart(i);
  return { course: wrap360(Math.atan2(l.x - s.x, -(l.z - s.z)) * RAD), len: Math.hypot(l.x - s.x, l.z - s.z) };
}

