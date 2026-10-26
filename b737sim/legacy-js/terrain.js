// Procedural terrain height model (pure, shared by physics and rendering).
// Terrain is fractal noise anchored to absolute earth coordinates, flattened around
// airports and lowered under approach paths so instrument approaches are clear.
import { clamp, smoothstep, dirOf, DEG } from './math.js';

export const WATER_LEVEL = -6; // m; terrain below this is sea / lake

function hash(ix, iz) {
  let h = (ix * 374761393 + iz * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

function valueNoise(x, z) {
  const ix = Math.floor(x);
  const iz = Math.floor(z);
  const fx = x - ix;
  const fz = z - iz;
  const ux = fx * fx * (3 - 2 * fx);
  const uz = fz * fz * (3 - 2 * fz);
  const a = hash(ix, iz);
  const b = hash(ix + 1, iz);
  const c = hash(ix, iz + 1);
  const d = hash(ix + 1, iz + 1);
  return (a + (b - a) * ux + (c - a) * uz + (a - b - c + d) * ux * uz) * 2 - 1;
}

export function fbm(x, z, oct) {
  let s = 0;
  let amp = 0.5;
  let norm = 0;
  for (let i = 0; i < oct; i++) {
    s += amp * valueNoise(x, z);
    norm += amp;
    // Rotate the domain a little each octave to hide grid artefacts.
    const nx = x * 1.6 + z * 1.2 + 17.3;
    z = -x * 1.2 + z * 1.6 + 5.1;
    x = nx;
    amp *= 0.5;
  }
  return s / norm;
}

function ridged(x, z, oct) {
  let s = 0;
  let amp = 0.5;
  let norm = 0;
  for (let i = 0; i < oct; i++) {
    const n = 1 - Math.abs(valueNoise(x, z));
    s += amp * n * n;
    norm += amp;
    const nx = x * 1.9 + z * 0.9 + 3.7;
    z = -x * 0.9 + z * 1.9 + 9.2;
    x = nx;
    amp *= 0.5;
  }
  return s / norm;
}

export class TerrainModel {
  constructor(proj, airports) {
    this.ox = proj.ox;
    this.oz = proj.oz;
    this.airports = airports;
    // Pre-compute runway footprints and approach corridors.
    this.zones = [];
    for (const a of airports) {
      for (const r of a.runways) {
        const d = dirOf(r.heading);
        this.zones.push({
          airport: a, runway: r, cx: r.cx, cz: r.cz, dx: d[0], dz: d[2],
          halfLen: r.length / 2 + 700, halfWid: r.width / 2 + 650, elev: r.elev,
        });
      }
      this.zones.push({
        airport: a, runway: null, cx: a.apron.x, cz: a.apron.z,
        dx: dirOf(a.apron.heading)[0], dz: dirOf(a.apron.heading)[2],
        halfLen: a.apron.length / 2 + 500, halfWid: a.apron.depth / 2 + 500, elev: a.elevM,
      });
    }
  }

  /** Raw natural terrain without airport shaping. */
  natural(x, z) {
    const X = x + this.ox;
    const Z = z + this.oz;
    const cont = fbm(X / 70000, Z / 70000, 4);
    let h = 220 + 820 * cont;
    const mask = smoothstep(0.05, 0.55, fbm(X / 110000 + 31.7, Z / 110000 - 17.3, 3));
    const r = ridged(X / 21000, Z / 21000, 5);
    h += mask * 2900 * r * r * r;
    h += 140 * fbm(X / 4500, Z / 4500, 3) * (0.35 + mask);
    h += 18 * fbm(X / 700, Z / 700, 2);
    return h;
  }

  /** Distance (m) from a point to the nearest airport zone rectangle, plus that zone. */
  airportDistance(x, z) {
    let best = Infinity;
    let zone = null;
    for (const zn of this.zones) {
      const px = x - zn.cx;
      const pz = z - zn.cz;
      if (Math.abs(px) > 40000 || Math.abs(pz) > 40000) continue;
      const along = px * zn.dx + pz * zn.dz;
      const across = px * -zn.dz + pz * zn.dx;
      const ex = Math.max(0, Math.abs(along) - zn.halfLen);
      const ez = Math.max(0, Math.abs(across) - zn.halfWid);
      const d = Math.hypot(ex, ez);
      if (d < best) {
        best = d;
        zone = zn;
      }
    }
    return { d: best, zone };
  }

  height(x, z) {
    let h = this.natural(x, z);
    const { d, zone } = this.airportDistance(x, z);
    if (zone) {
      // Push mountains away from airports and blend smoothly to field elevation.
      const calm = smoothstep(2500, 22000, d);
      h = zone.elev + (h - zone.elev) * (0.25 + 0.75 * calm) * smoothstep(0, 4500, d);
      // Keep approach corridors below a 2 degree plane from each runway end.
      for (const zn of this.zones) {
        if (!zn.runway || Math.abs(x - zn.cx) > 35000 || Math.abs(z - zn.cz) > 35000) continue;
        const px = x - zn.cx;
        const pz = z - zn.cz;
        const along = Math.abs(px * zn.dx + pz * zn.dz) - zn.runway.length / 2;
        if (along < 0 || along > 32000) continue;
        const across = Math.abs(px * -zn.dz + pz * zn.dx);
        const width = 1200 + along * 0.18;
        if (across > width + 2500) continue;
        const cap = zn.elev + Math.max(0, along * Math.tan(2.0 * DEG) - 40);
        const w = 1 - smoothstep(width, width + 2500, across);
        if (h > cap) h = h + (cap - h) * w;
      }
    }
    return h;
  }

  /** Surface under a point: height (m), whether it is water, and the surface kind. */
  surface(x, z) {
    const h = this.height(x, z);
    if (h < WATER_LEVEL) return { h: WATER_LEVEL, water: true, kind: 'water' };
    const { d, zone } = this.airportDistance(x, z);
    if (zone && d < 1) {
      for (const zn of this.zones) {
        if (zn.runway && zn.runway.contains(x, z, 2)) return { h: zn.elev, water: false, kind: 'runway' };
      }
      if (zone.airport) {
        const a = zone.airport;
        const ap = a.apron;
        const ad = dirOf(ap.heading);
        const px = x - ap.x;
        const pz = z - ap.z;
        if (Math.abs(px * ad[0] + pz * ad[2]) < ap.length / 2 && Math.abs(px * -ad[2] + pz * ad[0]) < ap.depth / 2 + 60) {
          return { h, water: false, kind: 'runway' };
        }
        if (onTaxiway(a, x, z)) return { h, water: false, kind: 'runway' };
      }
    }
    return { h, water: false, kind: 'grass' };
  }
}

/** Parallel taxiway geometry shared by renderer and physics. */
export function taxiwayLayout(airport) {
  const r = airport.runways[0];
  const d = dirOf(r.heading);
  const offset = r.width / 2 + 180;
  const segs = [];
  // Parallel taxiway.
  segs.push({ x: r.cx + -d[2] * offset, z: r.cz + d[0] * offset, heading: r.heading, length: r.length, width: 23 });
  // Connectors every ~700 m, plus both ends.
  const n = Math.max(2, Math.round(r.length / 700));
  for (let i = 0; i <= n; i++) {
    const t = -0.5 + i / n;
    const along = clamp(t * r.length, -r.length / 2 + 15, r.length / 2 - 15);
    const cx = r.cx + d[0] * along + -d[2] * offset / 2;
    const cz = r.cz + d[2] * along + d[0] * offset / 2;
    segs.push({ x: cx, z: cz, heading: r.heading + 90, length: offset, width: 23 });
  }
  // Apron link.
  const ap = airport.apron;
  const lx = (ap.x + r.cx + -d[2] * offset) / 2;
  const lz = (ap.z + r.cz + d[0] * offset) / 2;
  segs.push({ x: lx, z: lz, heading: r.heading + 90, length: Math.hypot(ap.x - (r.cx + -d[2] * offset), ap.z - (r.cz + d[0] * offset)), width: 30 });
  return segs;
}

function onTaxiway(airport, x, z) {
  if (!airport._taxi) airport._taxi = taxiwayLayout(airport);
  for (const s of airport._taxi) {
    const d = dirOf(s.heading);
    const px = x - s.x;
    const pz = z - s.z;
    if (Math.abs(px * d[0] + pz * d[2]) < s.length / 2 + 5 && Math.abs(px * -d[2] + pz * d[0]) < s.width / 2 + 3) return true;
  }
  return false;
}
