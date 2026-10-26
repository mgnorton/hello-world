// Boeing 737-900 (CFM56-7B27) data. Figures are public / approximate and tuned
// so that the simulated aircraft meets real-world performance numbers
// (V-speeds, liftoff attitude, approach pitch, cruise fuel burn).
import { KT } from './math.js';
import { RHO0 } from './atmosphere.js';

export const B739 = {
  name: 'Boeing 737-900',
  icao: 'B739',
  // Geometry
  wingArea: 124.58,       // m^2
  span: 35.79,            // m (with blended winglets)
  chord: 3.96,            // m mean aerodynamic chord
  length: 42.11,
  height: 12.55,
  // Weights (kg)
  oew: 42900,
  mzfw: 63300,
  mlw: 66360,
  mtow: 79010,
  maxFuel: 20890,
  maxPax: 189,
  paxMass: 95,            // passenger + bags
  // Inertia (kg m^2) at ~70 t, scaled linearly with mass
  inertiaRef: { mass: 70000, roll: 1.9e6, yaw: 5.6e6, pitch: 4.4e6 },
  // Speed limits
  vmo: 340,               // KIAS
  mmo: 0.82,
  ceiling: 41000,         // ft
  maxTaxi: 30,            // kt guidance
  // Engines
  engines: 2,
  staticThrust: 121400,   // N per engine (27,300 lbf)
  idleN1Ground: 21.0,
  idleN1Flight: 27.0,
  // Flap detents and aero increments.
  flaps: [
    //  name  angle  CL0   CLmax  dCD     dCm     placard(kt) maneuver(+Vref40)
    { n: 'UP', a: 0,  cl0: 0.25, clmax: 1.45, cd: 0.000, cm: 0.000, vfe: 340, man: 70 },
    { n: '1',  a: 1,  cl0: 0.40, clmax: 1.62, cd: 0.006, cm: -0.004, vfe: 250, man: 50 },
    { n: '2',  a: 2,  cl0: 0.46, clmax: 1.68, cd: 0.009, cm: -0.006, vfe: 250, man: 40 },
    { n: '5',  a: 5,  cl0: 0.57, clmax: 1.86, cd: 0.013, cm: -0.010, vfe: 250, man: 30 },
    { n: '10', a: 10, cl0: 0.64, clmax: 1.94, cd: 0.020, cm: -0.013, vfe: 210, man: 30 },
    { n: '15', a: 15, cl0: 0.70, clmax: 2.00, cd: 0.027, cm: -0.016, vfe: 200, man: 20 },
    { n: '25', a: 25, cl0: 0.78, clmax: 2.05, cd: 0.040, cm: -0.020, vfe: 190, man: 10 },
    { n: '30', a: 30, cl0: 0.84, clmax: 2.10, cd: 0.052, cm: -0.024, vfe: 175, man: 5 },
    { n: '40', a: 40, cl0: 0.92, clmax: 2.18, cd: 0.075, cm: -0.030, vfe: 162, man: 0 },
  ],
  takeoffFlaps: [1, 2, 3, 4, 5, 6], // detent indexes valid for takeoff (1,2,5,10,15,25)
  // Aerodynamic coefficients
  aero: {
    cla: 6.0,       // per rad
    cd0: 0.0195,
    k: 0.040,       // induced drag factor
    mcrit: 0.69,    // Lock's wave-drag onset
    cdGear: 0.018,
    cdSpoiler: 0.050,
    clSpoiler: -0.45,
    cm0: 0.062,
    cma: -1.25,
    cmq: -24,
    cmElev: 0.48,   // per unit column (pull = +)
    cmTrim: 0.26,   // per unit stab trim
    cyb: -0.90,
    cyRud: -0.16,
    clb: -0.13,
    clp: -0.48,
    clr: 0.14,
    clAil: 0.052,
    clRud: -0.010,
    cnb: 0.15,
    cnr: -0.20,
    cnp: -0.035,
    cnAil: -0.004,
    cnRud: 0.085,
    yawDamper: -0.30,
  },
  // Contact points (body frame, m, relative to CG). Gear points are at full strut extension.
  gear: [
    { name: 'nose', p: [16.0, -2.75, 0], k: 3.2e5, c: 7.0e4, steer: true },
    { name: 'left', p: [-1.2, -2.75, -2.86], k: 1.6e6, c: 3.2e5, brake: 'L' },
    { name: 'right', p: [-1.2, -2.75, 2.86], k: 1.6e6, c: 3.2e5, brake: 'R' },
  ],
  maxStroke: 0.55,
  // Points that must never touch the ground (fuselage, nacelles, wingtips, tail).
  structure: [
    { name: 'tail', p: [-19.6, 0.5, 0], kind: 'tail' },
    { name: 'aft belly', p: [-12, -1.6, 0], kind: 'belly' },
    { name: 'belly', p: [0, -1.9, 0], kind: 'belly' },
    { name: 'fwd belly', p: [12, -1.8, 0], kind: 'belly' },
    { name: 'nose', p: [20.5, -0.3, 0], kind: 'belly' },
    { name: 'left engine', p: [3.6, -2.05, -4.9], kind: 'engine' },
    { name: 'right engine', p: [3.6, -2.05, 4.9], kind: 'engine' },
    { name: 'left wingtip', p: [-7.3, 0.6, -17.6], kind: 'wing' },
    { name: 'right wingtip', p: [-7.3, 0.6, 17.6], kind: 'wing' },
  ],
  engineOffsets: [[3.6, -0.7, -4.9], [3.6, -0.7, 4.9]],
  eyePoint: [17.6, 0.95, -0.53], // captain's eye
};

/** Interpolate flap table by (fractional) detent position. */
export function flapAero(pos) {
  const f = B739.flaps;
  const i = Math.max(0, Math.min(f.length - 1, Math.floor(pos)));
  const j = Math.min(f.length - 1, i + 1);
  const t = pos - i;
  const mix = (k) => f[i][k] + (f[j][k] - f[i][k]) * t;
  return { cl0: mix('cl0'), clmax: mix('clmax'), cd: mix('cd'), cm: mix('cm') };
}

/** Stall speed (1g, KCAS) for a flap detent index and mass (kg). */
export function stallSpeed(mass, detent) {
  const W = mass * 9.80665;
  const f = B739.flaps[detent];
  return Math.sqrt((2 * W) / (RHO0 * B739.wingArea * f.clmax)) / KT;
}

/** V-speeds (KIAS) for a given takeoff/landing mass. */
export function vSpeeds(towMass, takeoffDetent, landingMass) {
  const vs = stallSpeed(towMass, takeoffDetent);
  const v2 = Math.round(vs * 1.13 + 4);
  const vr = v2 - 5;
  const v1 = vr - 3;
  const vref30 = Math.round(stallSpeed(landingMass, 7) * 1.23);
  const vref40 = Math.round(stallSpeed(landingMass, 8) * 1.23);
  const vref15 = Math.round(stallSpeed(landingMass, 5) * 1.23);
  return { v1, vr, v2, vref15, vref30, vref40 };
}

export const FLAP_NAMES = B739.flaps.map((f) => f.n);
export const AUTOBRAKE = ['RTO', 'OFF', '1', '2', '3', 'MAX'];
// Target deceleration (m/s^2) per autobrake setting.
export const AUTOBRAKE_DECEL = { '1': 1.22, '2': 1.52, '3': 2.13, MAX: 3.5 };
