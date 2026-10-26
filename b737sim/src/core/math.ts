// Vector / quaternion helpers and unit constants for the flight model.
// Kept independent of three.js so the physics runs headless in tests.
//
// World frame: x = east, y = up, z = south (three.js convention, -z = north).
// Body frame:  x = forward (nose), y = up (top of fuselage), z = right wing.

export type Vec3 = [number, number, number];
/** Quaternion as [w, x, y, z]. */
export type Quat = [number, number, number, number];

export const DEG = Math.PI / 180;
export const RAD = 180 / Math.PI;
export const KT = 0.514444; // m/s per knot
export const FT = 0.3048; // m per foot
export const FPM = FT / 60; // m/s per ft/min
export const NM = 1852; // m per nautical mile
export const G0 = 9.80665;

export const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
export const smoothstep = (e0: number, e1: number, x: number): number => {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
};
/** Wrap an angle in degrees to [-180, 180). */
export const wrap180 = (a: number): number => ((((a + 180) % 360) + 360) % 360) - 180;
/** Wrap an angle in degrees to [0, 360). */
export const wrap360 = (a: number): number => ((a % 360) + 360) % 360;
/** Exponential smoothing factor for a time constant. */
export const expK = (dt: number, tau: number): number => 1 - Math.exp(-dt / Math.max(1e-6, tau));

export const v3 = {
  add: (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]],
  sub: (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
  scale: (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s],
  dot: (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
  cross: (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]],
  len: (a: Vec3): number => Math.hypot(a[0], a[1], a[2]),
  norm: (a: Vec3): Vec3 => {
    const l = Math.hypot(a[0], a[1], a[2]) || 1;
    return [a[0] / l, a[1] / l, a[2] / l];
  },
};

export const quat = {
  mul(a: Quat, b: Quat): Quat {
    return [
      a[0] * b[0] - a[1] * b[1] - a[2] * b[2] - a[3] * b[3],
      a[0] * b[1] + a[1] * b[0] + a[2] * b[3] - a[3] * b[2],
      a[0] * b[2] - a[1] * b[3] + a[2] * b[0] + a[3] * b[1],
      a[0] * b[3] + a[1] * b[2] - a[2] * b[1] + a[3] * b[0],
    ];
  },
  axisAngle(axis: Vec3, angle: number): Quat {
    const s = Math.sin(angle / 2);
    return [Math.cos(angle / 2), axis[0] * s, axis[1] * s, axis[2] * s];
  },
  normalize(q: Quat): Quat {
    const l = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
    return [q[0] / l, q[1] / l, q[2] / l, q[3] / l];
  },
  /** Rotate a body-frame vector into the world frame. */
  rotate(q: Quat, v: Vec3): Vec3 {
    const [w, x, y, z] = q;
    const tx = 2 * (y * v[2] - z * v[1]);
    const ty = 2 * (z * v[0] - x * v[2]);
    const tz = 2 * (x * v[1] - y * v[0]);
    return [v[0] + w * tx + (y * tz - z * ty), v[1] + w * ty + (z * tx - x * tz), v[2] + w * tz + (x * ty - y * tx)];
  },
  /** Rotate a world-frame vector into the body frame. */
  rotateInv(q: Quat, v: Vec3): Vec3 {
    return quat.rotate([q[0], -q[1], -q[2], -q[3]], v);
  },
  /** Integrate body angular velocity (rad/s, body frame) over dt. */
  integrate(q: Quat, w: Vec3, dt: number): Quat {
    const dq = quat.mul(q, [0, w[0], w[1], w[2]]);
    return quat.normalize([q[0] + 0.5 * dq[0] * dt, q[1] + 0.5 * dq[1] * dt, q[2] + 0.5 * dq[2] * dt, q[3] + 0.5 * dq[3] * dt]);
  },
  /** Orientation from aviation Euler angles (radians): heading clockwise from north, pitch nose-up, roll right-wing-down. */
  fromEuler(heading: number, pitch: number, roll: number): Quat {
    const qYaw = quat.axisAngle([0, 1, 0], -heading);
    const qBase = quat.axisAngle([0, 1, 0], Math.PI / 2); // body x -> north
    const qPitch = quat.axisAngle([0, 0, 1], pitch);
    const qRoll = quat.axisAngle([1, 0, 0], roll);
    return quat.normalize(quat.mul(quat.mul(quat.mul(qYaw, qBase), qPitch), qRoll));
  },
  toEuler(q: Quat): { heading: number; pitch: number; roll: number } {
    const f = quat.rotate(q, [1, 0, 0]);
    const r = quat.rotate(q, [0, 0, 1]);
    const u = quat.rotate(q, [0, 1, 0]);
    const heading = Math.atan2(f[0], -f[2]);
    const pitch = Math.asin(clamp(f[1], -1, 1));
    const roll = Math.atan2(-r[1], u[1]);
    return { heading: heading < 0 ? heading + 2 * Math.PI : heading, pitch, roll };
  },
};

/** Ground track / heading in degrees for a world-frame horizontal vector. */
export const bearingOf = (dx: number, dz: number): number => wrap360(Math.atan2(dx, -dz) * RAD);
/** Unit horizontal direction (x, z) for a bearing in degrees, as a Vec3 with y = 0. */
export const dirOf = (brgDeg: number): Vec3 => [Math.sin(brgDeg * DEG), 0, -Math.cos(brgDeg * DEG)];

/** Deterministic hash of two integers to [0, 1). */
export function hash2(ix: number, iz: number): number {
  let h = (ix * 374761393 + iz * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Small seeded PRNG (mulberry32). */
export function mulberry(seed: number): () => number {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
