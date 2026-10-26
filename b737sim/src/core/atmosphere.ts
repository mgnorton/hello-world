// Atmosphere model: ISA with non-standard sea-level pressure (QNH) and temperature,
// airspeed conversions and barometric altimetry.
import { clamp } from './math.ts';

export const P0 = 101325;
export const RHO0 = 1.225;
export const T0 = 288.15;
export const A0 = 340.294;
const R = 287.053;
const GAMMA = 1.4;
const L = 0.0065;
const G = 9.80665;
const EXP = G / (L * R); // 5.2559

export interface AirState {
  /** Static temperature, K */
  T: number;
  /** Static pressure, Pa */
  p: number;
  /** Density, kg/m^3 */
  rho: number;
  /** Speed of sound, m/s */
  a: number;
  /** Density ratio rho/rho0 */
  sigma: number;
}

/**
 * Air at geometric altitude h (m MSL) for a given sea-level pressure (Pa) and
 * temperature deviation from ISA (K). Pressure follows the standard lapse from QNH.
 */
export function airAt(h: number, qnhPa = P0, isaDev = 0): AirState {
  h = clamp(h, -1000, 30000);
  let Tisa: number;
  let p: number;
  if (h < 11000) {
    Tisa = T0 - L * h;
    p = qnhPa * Math.pow(Tisa / T0, EXP);
  } else {
    Tisa = 216.65;
    const p11 = qnhPa * Math.pow(216.65 / T0, EXP);
    p = p11 * Math.exp((-G * (h - 11000)) / (R * Tisa));
  }
  const T = Tisa + isaDev;
  const rho = p / (R * T);
  return { T, p, rho, a: Math.sqrt(GAMMA * R * T), sigma: rho / RHO0 };
}

/** Standard-atmosphere air (for tests and simple callers). */
export const isa = (h: number, isaDev = 0): AirState => airAt(h, P0, isaDev);

/** Pressure altitude (m) shown by an altimeter set to `settingPa` for static pressure p. */
export function baroAltitude(p: number, settingPa: number): number {
  const ratio = p / settingPa;
  if (ratio > 0.2234) return (T0 / L) * (1 - Math.pow(ratio, 1 / EXP));
  // Above the tropopause relative to the setting.
  const p11 = 0.2234 * settingPa;
  return 11000 - ((R * 216.65) / G) * Math.log(p / p11);
}

/** Calibrated airspeed (m/s) from true airspeed (m/s). */
export function casFromTas(tas: number, air: AirState): number {
  const M = tas / air.a;
  const qc = air.p * (Math.pow(1 + 0.2 * M * M, 3.5) - 1);
  return A0 * Math.sqrt(5 * (Math.pow(qc / P0 + 1, 2 / 7) - 1));
}

/** True airspeed (m/s) from calibrated airspeed (m/s). */
export function tasFromCas(cas: number, air: AirState): number {
  const qc = P0 * (Math.pow(1 + 0.2 * (cas / A0) ** 2, 3.5) - 1);
  const M = Math.sqrt(5 * (Math.pow(qc / air.p + 1, 2 / 7) - 1));
  return M * air.a;
}

/** Calibrated airspeed (m/s) equivalent to a Mach number at this altitude. */
export function casFromMach(M: number, air: AirState): number {
  return casFromTas(M * air.a, air);
}

export const hPaToInHg = (hpa: number): number => hpa * 0.0295299830714;
export const inHgToHPa = (inhg: number): number => inhg / 0.0295299830714;
