// Generated airport ground layout (taxiways, apron, terminal, hangars, tower).
// FAA data gives exact runways but not taxiways or buildings, so these are placed with
// rules that mirror typical layouts: parallel taxiways ~400 ft from the runway, aprons
// near the airport reference point and clear of runways. Shared by physics and graphics.
import { DEG, dirOf, wrap360 } from '../core/math.ts';
import { R_EARTH } from './geo.ts';
import type { Airport, Runway } from './navdb.ts';

export interface Pavement {
  x: number;
  z: number;
  heading: number; // true heading of the "length" axis
  length: number;
  width: number;
  kind: 'taxiway' | 'apron';
}

export interface Building {
  x: number;
  z: number;
  heading: number;
  length: number; // along heading
  width: number;
  height: number;
  kind: 'terminal' | 'hangar' | 'tower';
  /** Curved terminal: a half ring of this outer radius bulging towards `heading`. */
  arc?: number;
}

export interface AirportLayout {
  pavements: Pavement[];
  buildings: Building[];
  tower: { x: number; z: number; height: number } | null;
}

const cache = new WeakMap<Airport, AirportLayout>();

function overlapsRunway(ap: Airport, x: number, z: number, margin: number, except?: Runway): boolean {
  for (const r of ap.runways) {
    if (r === except) continue;
    if (r.contains(x, z, margin)) return true;
  }
  return false;
}

/** Rectangle sample points for overlap tests. */
function rectPoints(p: { x: number; z: number; heading: number; length: number; width: number }, n = 6): [number, number][] {
  const d = dirOf(p.heading);
  const pts: [number, number][] = [];
  for (let i = 0; i <= n; i++) {
    for (let j = 0; j <= 2; j++) {
      const a = (i / n - 0.5) * p.length;
      const c = (j / 2 - 0.5) * p.width;
      pts.push([p.x + d[0] * a - d[2] * c, p.z + d[2] * a + d[0] * c]);
    }
  }
  return pts;
}

export function airportLayout(ap: Airport): AirportLayout {
  const hit = cache.get(ap);
  if (hit) return hit;
  const pavements: Pavement[] = [];
  const buildings: Building[] = [];
  const big = ap.longest >= 2400;
  const medium = ap.longest >= 1500;

  for (const r of ap.runways) {
    if (!r.paved || r.lengthM < 900) continue;
    const d = dirOf(r.heading);
    // Parallel taxiway on the side of the airport reference point.
    const { across } = r.local(ap.x, ap.z);
    const sides = Math.abs(across) < 30 ? [1, -1] : [Math.sign(across)];
    const offset = r.widthM / 2 + (big ? 160 : medium ? 110 : 60);
    const width = big ? 23 : medium ? 18 : 11;
    for (const side of sides) {
      const tx = r.cx + -d[2] * offset * side;
      const tz = r.cz + d[0] * offset * side;
      const twy: Pavement = { x: tx, z: tz, heading: r.heading, length: r.lengthM, width, kind: 'taxiway' };
      const bad = rectPoints(twy, 12).filter(([px, pz]) => overlapsRunway(ap, px, pz, 25, r)).length;
      if (bad > 3) continue;
      pavements.push(twy);
      // Connectors at both ends and every ~650 m.
      const n = Math.max(2, Math.round(r.lengthM / 650));
      for (let i = 0; i <= n; i++) {
        const along = (-0.5 + i / n) * (r.lengthM - 2 * width);
        const cx = r.cx + d[0] * along + -d[2] * (offset / 2) * side;
        const cz = r.cz + d[2] * along + d[0] * (offset / 2) * side;
        pavements.push({ x: cx, z: cz, heading: wrap360(r.heading + 90), length: offset, width, kind: 'taxiway' });
      }
      if (!big) break;
    }
  }

  if (ap.ident === 'KDFW') return finish(ap, dfwTerminals(ap, pavements, buildings));

  // Apron and terminal near the reference point, pushed clear of the runways.
  const main = ap.runways.reduce((a, b) => (b.lengthM > a.lengthM ? b : a));
  const apronLen = big ? 1300 : medium ? 450 : 160;
  const apronDepth = big ? 420 : medium ? 160 : 70;
  const d = dirOf(main.heading);
  let best: Pavement | null = null;
  const tries: [number, number][] = [];
  for (let r = 0; r <= 2400; r += 60) for (const s of [1, -1]) tries.push([s * r, 0]);
  for (const [off] of tries) {
    const x = ap.x + -d[2] * off;
    const z = ap.z + d[0] * off;
    const apron: Pavement = { x, z, heading: main.heading, length: apronLen, width: apronDepth, kind: 'apron' };
    const clear = rectPoints(apron, 8).every(([px, pz]) => !overlapsRunway(ap, px, pz, 60));
    if (clear) {
      best = apron;
      break;
    }
  }
  if (best) {
    pavements.push(best);
    // Link the apron to the nearest taxiway / runway with a stub.
    const { across } = main.local(best.x, best.z);
    const side = Math.sign(across) || 1;
    const linkLen = Math.max(20, Math.abs(across) - main.widthM / 2 - best.width / 2);
    const lx = best.x - -d[2] * side * (best.width / 2 + linkLen / 2);
    const lz = best.z - d[0] * side * (best.width / 2 + linkLen / 2);
    pavements.push({ x: lx, z: lz, heading: wrap360(main.heading + 90), length: linkLen, width: big ? 30 : 15, kind: 'taxiway' });
    // Terminal along the far side of the apron, hangars at one end.
    const far = best.width / 2 + (big ? 45 : 20);
    const bx = best.x + -d[2] * side * far;
    const bz = best.z + d[0] * side * far;
    if (medium) {
      buildings.push({ x: bx, z: bz, heading: main.heading, length: apronLen * 0.75, width: big ? 70 : 35, height: big ? 22 : 10, kind: 'terminal' });
    }
    const hangars = big ? 3 : medium ? 2 : 2;
    for (let k = 0; k < hangars; k++) {
      const along = apronLen / 2 + 50 + k * (big ? 95 : 45);
      buildings.push({
        x: bx + d[0] * along, z: bz + d[2] * along, heading: main.heading,
        length: big ? 80 : 35, width: big ? 70 : 30, height: big ? 25 : 9, kind: 'hangar',
      });
    }
  }
  let tower: AirportLayout['tower'] = null;
  if (ap.raw.towered && best) {
    const { across } = main.local(best.x, best.z);
    const side = Math.sign(across) || 1;
    const along = -apronLen / 2 - 80;
    tower = {
      x: best.x + d[0] * along + -d[2] * side * (best.width / 2 + 60),
      z: best.z + d[2] * along + d[0] * side * (best.width / 2 + 60),
      height: big ? 60 : 30,
    };
    buildings.push({ x: tower.x, z: tower.z, heading: 0, length: 10, width: 10, height: tower.height, kind: 'tower' });
  }
  return finish(ap, { pavements, buildings, tower });
}

function finish(ap: Airport, layout: AirportLayout): AirportLayout {
  cache.set(ap, layout);
  return layout;
}

/**
 * DFW's real landside: five terminals along International Parkway, the north-south spine road
 * between runways 17R/35L and 18L/36R. A, C and E sit east of the spine, B and D west of it.
 * Positions are approximate (about +-100 m); the FAA data sets have no building footprints.
 */
function dfwTerminals(ap: Airport, pavements: Pavement[], buildings: Building[]): AirportLayout {
  const spineLon = -97.0403;
  const toLocal = (lat: number, lon: number): [number, number] => [
    ap.x + (lon - ap.lon) * DEG * R_EARTH * Math.cos(ap.lat * DEG),
    ap.z - (lat - ap.lat) * DEG * R_EARTH,
  ];
  const terminals: [string, number, 1 | -1][] = [['A', 32.9058, 1], ['B', 32.9052, -1], ['C', 32.8977, 1], ['D', 32.8982, -1], ['E', 32.8898, 1]];
  for (const [, lat, side] of terminals) {
    const [x, z] = toLocal(lat, spineLon + side * 0.0007);
    const heading = side > 0 ? 90 : 270;
    const radius = 300;
    buildings.push({ x, z, heading, length: radius * 2, width: 40, height: 16, kind: 'terminal', arc: radius });
    // Ramp wrapping the outside of the half ring.
    pavements.push({ x: x + side * radius * 0.6, z, heading: 0, length: radius * 2 + 220, width: radius * 1.2 + 160, kind: 'apron' });
  }
  // Cargo / maintenance ramp and hangars south-west of the terminals.
  const [hx, hz] = toLocal(32.8845, -97.0445);
  pavements.push({ x: hx, z: hz, heading: 0, length: 700, width: 260, kind: 'apron' });
  for (let k = 0; k < 3; k++) buildings.push({ x: hx - 200, z: hz - 250 + k * 250, heading: 90, length: 90, width: 80, height: 24, kind: 'hangar' });
  const [tx, tz] = toLocal(32.8967, -97.0403);
  const tower = { x: tx, z: tz, height: 60 };
  buildings.push({ x: tx, z: tz, heading: 0, length: 10, width: 10, height: tower.height, kind: 'tower' });
  return { pavements, buildings, tower };
}

/** Is (x, z) on a generated paved area of this airport? */
export function onPavement(layout: AirportLayout, x: number, z: number): boolean {
  for (const p of layout.pavements) {
    const d = dirOf(p.heading);
    const dx = x - p.x;
    const dz = z - p.z;
    if (Math.abs(dx * d[0] + dz * d[2]) <= p.length / 2 + 4 && Math.abs(dx * -d[2] + dz * d[0]) <= p.width / 2 + 3) return true;
  }
  return false;
}
