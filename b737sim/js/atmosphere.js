// International Standard Atmosphere plus wind / turbulence model.
import { KT, FT, DEG, clamp, smoothstep } from './math.js';

export const P0 = 101325;
export const RHO0 = 1.225;
export const T0 = 288.15;
export const A0 = 340.294;
const R = 287.053;
const GAMMA = 1.4;
const L = 0.0065;
const G = 9.80665;

/** ISA properties at geometric altitude h (m). tempOffset in K (ISA deviation). */
export function isa(h, tempOffset = 0) {
  h = clamp(h, -1000, 30000);
  let T, p;
  if (h < 11000) {
    T = T0 - L * h;
    p = P0 * Math.pow(T / T0, G / (L * R));
  } else {
    T = 216.65;
    p = 22632.06 * Math.exp((-G * (h - 11000)) / (R * T));
  }
  T += tempOffset;
  const rho = p / (R * T);
  const a = Math.sqrt(GAMMA * R * T);
  return { T, p, rho, a, sigma: rho / RHO0 };
}

/** Calibrated airspeed (m/s) from true airspeed (m/s). */
export function casFromTas(tas, atm) {
  const M = tas / atm.a;
  const qc = atm.p * (Math.pow(1 + 0.2 * M * M, 3.5) - 1);
  return A0 * Math.sqrt(5 * (Math.pow(qc / P0 + 1, 2 / 7) - 1));
}

/** True airspeed (m/s) from calibrated airspeed (m/s). */
export function tasFromCas(cas, atm) {
  const qc = P0 * (Math.pow(1 + 0.2 * (cas / A0) ** 2, 3.5) - 1);
  const M = Math.sqrt(5 * (Math.pow(qc / atm.p + 1, 2 / 7) - 1));
  return M * atm.a;
}

/** Calibrated airspeed (m/s) equivalent to a Mach number at this altitude. */
export function casFromMach(M, atm) {
  return casFromTas(M * atm.a, atm);
}

// Deterministic, smooth 1-D noise used for gusts.
function gustNoise(t, seed) {
  let s = 0;
  let amp = 1;
  let f = 1;
  for (let i = 0; i < 4; i++) {
    s += amp * Math.sin(t * f * 0.37 + seed * 1.7 + i * 2.1) * Math.cos(t * f * 0.23 + seed * 0.9 + i);
    amp *= 0.5;
    f *= 2.03;
  }
  return s;
}

/**
 * Weather: surface wind (direction it blows FROM, degrees true; speed knots),
 * gust amplitude, turbulence level 0..3, OAT deviation from ISA.
 */
export class Weather {
  constructor(opts = {}) {
    this.windDir = opts.windDir ?? 270;
    this.windSpeed = opts.windSpeed ?? 8;   // knots at the surface
    this.gust = opts.gust ?? 0;             // knots
    this.turbulence = opts.turbulence ?? 0; // 0 none, 1 light, 2 moderate, 3 severe
    this.isaDev = opts.isaDev ?? 0;
    this.visibility = opts.visibility ?? 60; // km
    this.clouds = opts.clouds ?? 'scattered';
    this.cloudBase = opts.cloudBase ?? 4500; // ft MSL
    this.time = 0;
  }

  /** Air-mass velocity (m/s, world frame) at altitude h (m MSL), height above ground agl (m). */
  windAt(h, agl, t) {
    // Wind veers and strengthens with altitude, with a boundary-layer profile near the ground.
    const altFt = h / FT;
    const boundary = 0.55 + 0.45 * smoothstep(0, 600, agl);
    const aloft = 1 + Math.min(altFt, 35000) / 35000 * 3.2; // ~4x at cruise
    const speed = this.windSpeed * KT * boundary * aloft;
    const dir = (this.windDir + Math.min(altFt, 30000) / 30000 * 35) * DEG;
    // Wind blows FROM dir, so the air moves toward dir + 180.
    let wx = -Math.sin(dir) * speed;
    let wz = Math.cos(dir) * speed;
    let wy = 0;
    if (this.gust > 0) {
      const g = gustNoise(t * 0.6, 3) * 0.5 + 0.5;
      const gs = Math.max(0, g) * this.gust * KT * boundary;
      wx += -Math.sin(dir) * gs;
      wz += Math.cos(dir) * gs;
    }
    if (this.turbulence > 0) {
      const amp = [0, 0.8, 2.0, 4.5][this.turbulence] * (0.6 + 0.4 * smoothstep(0, 1500, agl));
      wx += gustNoise(t * 2.1, 11) * amp;
      wz += gustNoise(t * 2.3, 17) * amp;
      wy += gustNoise(t * 2.7, 23) * amp * 0.8;
    }
    return [wx, wy, wz];
  }
}
