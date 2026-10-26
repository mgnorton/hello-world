// Geodesy helpers: local map projection around the home airport, great-circle math and
// magnetic variation from the World Magnetic Model grid baked into world.json.
import { DEG, RAD, NM, wrap180, wrap360 } from '../core/math.ts';

export const R_EARTH = 6371000;

/**
 * Equirectangular projection centred on the home airport. Over the ~600 km scenery
 * region the distortion is well under 1 %, and it is linear, so shaders can recover
 * latitude/longitude from world coordinates exactly.
 */
export class Projection {
  readonly cos0: number;
  constructor(readonly lat0: number, readonly lon0: number) {
    this.cos0 = Math.cos(lat0 * DEG);
  }
  /** [x east, z south] metres for a latitude/longitude. */
  toLocal(lat: number, lon: number): [number, number] {
    return [wrap180(lon - this.lon0) * DEG * R_EARTH * this.cos0, -(lat - this.lat0) * DEG * R_EARTH];
  }
  toLatLon(x: number, z: number): [number, number] {
    return [this.lat0 - (z / R_EARTH) * RAD, this.lon0 + (x / (R_EARTH * this.cos0)) * RAD];
  }
  /** Metres per degree of latitude / longitude (for shaders). */
  get mPerDegLat(): number {
    return DEG * R_EARTH;
  }
  get mPerDegLon(): number {
    return DEG * R_EARTH * this.cos0;
  }
}

export function gcDistanceNm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const p1 = lat1 * DEG;
  const p2 = lat2 * DEG;
  const dp = p2 - p1;
  const dl = (lon2 - lon1) * DEG;
  const a = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return (2 * R_EARTH * Math.asin(Math.min(1, Math.sqrt(a)))) / NM;
}

export function gcBearing(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const p1 = lat1 * DEG;
  const p2 = lat2 * DEG;
  const dl = (lon2 - lon1) * DEG;
  const y = Math.sin(dl) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return wrap360(Math.atan2(y, x) * RAD);
}

export interface MagVarMeta {
  south: number;
  west: number;
  step: number;
  grid: number[][];
  model: string;
  epoch: string;
}

/** Magnetic declination (degrees, east positive) interpolated from a coarse WMM grid. */
export class MagVar {
  constructor(private readonly meta: MagVarMeta) {}
  at(lat: number, lon: number): number {
    const m = this.meta;
    const fy = (lat - m.south) / m.step;
    const fx = (lon - m.west) / m.step;
    const rows = m.grid.length;
    const cols = m.grid[0].length;
    const i = Math.max(0, Math.min(rows - 2, Math.floor(fy)));
    const j = Math.max(0, Math.min(cols - 2, Math.floor(fx)));
    const ty = Math.max(0, Math.min(1, fy - i));
    const tx = Math.max(0, Math.min(1, fx - j));
    const g = m.grid;
    return (g[i][j] * (1 - tx) + g[i][j + 1] * tx) * (1 - ty) + (g[i + 1][j] * (1 - tx) + g[i + 1][j + 1] * tx) * ty;
  }
}
