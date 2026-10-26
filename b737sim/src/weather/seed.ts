// Initial weather states: the real NOAA HRRR snapshot, or a scenario preset generated
// on the same 0.1 degree grid.
import { mulberry } from '../core/math.ts';

export interface SeedGrid {
  south: number;
  west: number;
  step: number;
  rows: number;
  cols: number;
}

/** Quantised HRRR snapshot, as written by tools/build_weather.py. */
export interface WeatherSeed {
  source: string;
  validTime: string;
  grid: SeedGrid;
  sfc: Record<'u10' | 'v10' | 'gust' | 't2' | 'td2' | 'mslp' | 'vis' | 'lcc' | 'mcc' | 'hcc' | 'refc' | 'cape' | 'ceil', number[]>;
  levels: { p: number; alt: number; u: number[]; v: number[]; t: number[] }[];
}

/** Decoded fields in SI-ish units used by the engine. */
export interface SeedFields {
  grid: SeedGrid;
  validTime: string;
  source: string;
  u10: Float32Array; // m/s east
  v10: Float32Array; // m/s north
  gust: Float32Array; // m/s
  t2: Float32Array; // C
  td2: Float32Array; // C
  mslp: Float32Array; // hPa
  vis: Float32Array; // m
  lcc: Float32Array; // 0..1
  mcc: Float32Array;
  hcc: Float32Array;
  refc: Float32Array; // dBZ
  cape: Float32Array; // J/kg
  ceil: Float32Array; // m AGL, NaN = none
  levels: { alt: number; u: Float32Array; v: Float32Array; t: Float32Array }[];
  /** Thunderstorm behaviour: 0 none .. 1 outbreak. */
  convection: number;
  /** Steering-flow drift multiplier and trends. */
  pressureTrend: number; // hPa per hour
  tempTrend: number; // C per hour
}

export function decodeSeed(s: WeatherSeed): SeedFields {
  const f = (a: number[], k: number) => Float32Array.from(a, (v) => v * k);
  const sf = s.sfc;
  const capeMax = Math.max(...sf.cape);
  return {
    grid: s.grid, validTime: s.validTime, source: s.source,
    u10: f(sf.u10, 0.1), v10: f(sf.v10, 0.1), gust: f(sf.gust, 0.1), t2: f(sf.t2, 0.1), td2: f(sf.td2, 0.1),
    mslp: f(sf.mslp, 0.1), vis: f(sf.vis, 1), lcc: f(sf.lcc, 0.01), mcc: f(sf.mcc, 0.01), hcc: f(sf.hcc, 0.01),
    refc: f(sf.refc, 1), cape: f(sf.cape, 1), ceil: Float32Array.from(sf.ceil, (v) => (v < 0 ? NaN : v)),
    levels: s.levels.map((l) => ({ alt: l.alt, u: f(l.u, 0.1), v: f(l.v, 0.1), t: f(l.t, 0.1) })),
    convection: capeMax > 2500 ? 0.7 : capeMax > 1200 ? 0.35 : capeMax > 500 ? 0.1 : 0,
    pressureTrend: 0, tempTrend: 0,
  };
}

export type PresetId = 'live' | 'clear' | 'front' | 'ifr' | 'storms' | 'winter' | 'custom';

export interface CustomWeather {
  windDir: number; // from, true
  windKt: number;
  gustKt: number;
  visKm: number;
  cloudBaseFt: number;
  cover: number; // 0..1
  tempC: number;
  qnhHpa: number;
  convection: number; // 0..1
}

export const PRESETS: { id: PresetId; name: string; blurb: string }[] = [
  { id: 'live', name: 'Real world (NOAA HRRR)', blurb: 'Actual conditions from the latest HRRR analysis, then evolving.' },
  { id: 'clear', name: 'High pressure, clear', blurb: 'Light south wind, a few cirrus, great visibility.' },
  { id: 'front', name: 'Cold front passage', blurb: 'Gusty north winds behind a front sweeping southeast, low cloud and rain.' },
  { id: 'ifr', name: 'Low IFR fog', blurb: 'Dense fog and low stratus that slowly lifts during the morning.' },
  { id: 'storms', name: 'Spring thunderstorms', blurb: 'Supercells form on a dryline west of the metroplex and track northeast.' },
  { id: 'winter', name: 'Winter overcast', blurb: 'Cold north wind, low overcast, light drizzle.' },
  { id: 'custom', name: 'Custom', blurb: 'Set wind, visibility, clouds and storms yourself.' },
];

/** Build a procedural seed for a preset on the same grid as the real snapshot. */
export function presetSeed(id: Exclude<PresetId, 'live'>, grid: SeedGrid, custom?: CustomWeather, seed = 1): SeedFields {
  const n = grid.rows * grid.cols;
  const rnd = mulberry(seed * 7919 + id.length * 31);
  const mk = (v: number) => new Float32Array(n).fill(v);
  const F = {
    u10: mk(0), v10: mk(0), gust: mk(0), t2: mk(20), td2: mk(10), mslp: mk(1015), vis: mk(40000),
    lcc: mk(0), mcc: mk(0), hcc: mk(0), refc: mk(-10), cape: mk(0), ceil: mk(NaN),
  };
  // Smooth spatial noise helper on the grid (sum of a few random sinusoids).
  const waves = Array.from({ length: 6 }, () => ({ kx: (rnd() - 0.5) * 0.9, ky: (rnd() - 0.5) * 0.9, ph: rnd() * 6.28 }));
  const noise = (i: number, j: number) => waves.reduce((s, w) => s + Math.sin(w.kx * j + w.ky * i + w.ph), 0) / waves.length;
  let windFrom = 170;
  let windKt = 8;
  let gustKt = 0;
  let aloftFrom = 230;
  let aloftKt = 60;
  let convection = 0;
  let pressureTrend = 0;
  let tempTrend = 0;
  for (let i = 0; i < grid.rows; i++) {
    for (let j = 0; j < grid.cols; j++) {
      const k = i * grid.cols + j;
      const nz = noise(i, j);
      // Distance across the grid, 0 at the west/south edge.
      const sx = j / grid.cols;
      const sy = i / grid.rows;
      switch (id) {
        case 'clear':
          windFrom = 170; windKt = 7; aloftFrom = 250; aloftKt = 45;
          F.t2[k] = 24 - sy * 4; F.td2[k] = 8; F.mslp[k] = 1024 - sx * 2; F.hcc[k] = Math.max(0, 0.15 + nz * 0.2);
          break;
        case 'front': {
          // Front oriented SW-NE, passing over DFW about an hour into the flight.
          windFrom = 340; windKt = 18; gustKt = 30; aloftFrom = 260; aloftKt = 80;
          const dfront = (sx + sy) - 1.05; // >0 ahead (warm sector to the SE), <0 behind
          const behind = dfront < 0;
          F.t2[k] = behind ? 9 + nz * 2 : 24 + nz;
          F.td2[k] = behind ? 2 : 17;
          F.mslp[k] = 1016 - dfront * 10;
          F.lcc[k] = Math.max(0, Math.min(1, (behind ? 0.75 : 0.25) + nz * 0.25 + (Math.abs(dfront) < 0.12 ? 0.3 : 0)));
          F.mcc[k] = Math.abs(dfront) < 0.2 ? 0.8 : 0.2;
          F.ceil[k] = behind ? 750 + nz * 200 : Math.abs(dfront) < 0.12 ? 500 : NaN;
          F.refc[k] = Math.abs(dfront) < 0.08 ? 28 + nz * 14 : behind && nz > 0.4 ? 18 : -10;
          F.vis[k] = Math.abs(dfront) < 0.08 ? 6000 : 25000;
          F.u10[k] = behind ? 1 : -1; // marker, replaced below
          pressureTrend = 0.8;
          tempTrend = -1.5;
          break;
        }
        case 'ifr':
          windFrom = 140; windKt = 3; aloftFrom = 200; aloftKt = 30;
          F.t2[k] = 14; F.td2[k] = 13.6; F.mslp[k] = 1019;
          F.lcc[k] = 1; F.ceil[k] = 60 + Math.max(0, nz) * 120; F.vis[k] = 300 + Math.max(0, nz + 0.3) * 1400;
          tempTrend = 0.8;
          break;
        case 'storms':
          windFrom = 170; windKt = 15; gustKt = 24; aloftFrom = 240; aloftKt = 70;
          F.t2[k] = 29 + nz; F.td2[k] = sx < 0.25 ? 5 : 20; F.mslp[k] = 1006 - sx * 2;
          F.lcc[k] = Math.max(0, 0.35 + nz * 0.25); F.ceil[k] = 1100; F.cape[k] = sx < 0.25 ? 300 : 3200;
          F.hcc[k] = 0.4; F.vis[k] = 16000;
          convection = 1;
          break;
        case 'winter':
          windFrom = 10; windKt = 14; gustKt = 22; aloftFrom = 290; aloftKt = 90;
          F.t2[k] = 1 + sy * -3 + nz; F.td2[k] = -1 + sy * -3; F.mslp[k] = 1029;
          F.lcc[k] = 1; F.ceil[k] = 380 + nz * 120; F.vis[k] = 5000 + nz * 2000; F.refc[k] = nz > 0.1 ? 15 : -10;
          tempTrend = -0.2;
          break;
        case 'custom': {
          const c = custom!;
          windFrom = c.windDir; windKt = c.windKt; gustKt = c.gustKt; aloftFrom = c.windDir + 40; aloftKt = 40 + c.windKt * 2;
          F.t2[k] = c.tempC; F.td2[k] = c.tempC - Math.max(1, c.cloudBaseFt / 400); F.mslp[k] = c.qnhHpa;
          F.lcc[k] = Math.max(0, Math.min(1, c.cover + nz * 0.15 * (c.cover > 0 && c.cover < 1 ? 1 : 0)));
          F.ceil[k] = c.cover > 0.55 ? c.cloudBaseFt * 0.3048 : NaN; F.vis[k] = c.visKm * 1000;
          F.cape[k] = c.convection * 3500;
          convection = c.convection;
          break;
        }
      }
      const toUV = (from: number, kt: number): [number, number] => {
        const r = (from * Math.PI) / 180;
        return [-Math.sin(r) * kt * 0.5144, -Math.cos(r) * kt * 0.5144];
      };
      let from = windFrom;
      let kt = windKt;
      if (id === 'front') {
        const behind = F.u10[k] > 0;
        from = behind ? 340 + nz * 15 : 180 + nz * 15;
        kt = behind ? 18 + nz * 4 : 12;
      } else {
        from += nz * 12;
        kt *= 1 + nz * 0.15;
      }
      const [u, v] = toUV(from, kt);
      F.u10[k] = u;
      F.v10[k] = v;
      F.gust[k] = Math.max(kt, gustKt) * 0.5144;
    }
  }
  const levelAlts = [1457, 3012, 5574, 9164, 10363];
  const levels = levelAlts.map((alt, li) => {
    const frac = (li + 1) / levelAlts.length;
    const u = new Float32Array(n);
    const v = new Float32Array(n);
    const t = new Float32Array(n);
    for (let k = 0; k < n; k++) {
      const sfcFrom = (Math.atan2(-F.u10[k], -F.v10[k]) * 180) / Math.PI;
      const sfcKt = Math.hypot(F.u10[k], F.v10[k]) / 0.5144;
      const from = sfcFrom + ((((aloftFrom - sfcFrom + 540) % 360) - 180) * Math.min(1, frac * 1.3));
      const kt = sfcKt + (aloftKt - sfcKt) * frac;
      const r = (from * Math.PI) / 180;
      u[k] = -Math.sin(r) * kt * 0.5144;
      v[k] = -Math.cos(r) * kt * 0.5144;
      t[k] = F.t2[k] - 6.5 * (alt / 1000) * (id === 'ifr' ? 0.6 : 1);
    }
    return { alt, u, v, t };
  });
  const name = PRESETS.find((p) => p.id === id)!.name;
  return {
    grid, validTime: new Date().toISOString(), source: `Preset: ${name}`,
    ...F, levels, convection, pressureTrend, tempTrend,
  };
}
