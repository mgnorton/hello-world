// Dynamic weather engine.
// The large-scale state (winds aloft, pressure, temperature, cloud and rain fields) drifts with
// the steering flow and trends over time; thunderstorm cells are discrete objects with a
// life cycle (towering cumulus -> mature storm with heavy rain, lightning and turbulence ->
// collapse with microburst outflow). Everything is queried by the flight model, renderer,
// weather radar, METAR/ATIS generator and warnings.
import { DEG, RAD, KT, FT, clamp, lerp, smoothstep, mulberry, wrap360, type Vec3 } from '../core/math.ts';
import type { Projection } from '../world/geo.ts';
import type { SeedFields, SeedGrid } from './seed.ts';

const TISA0 = 15;

class Field {
  constructor(readonly g: SeedGrid, readonly data: Float32Array) {}
  sample(lat: number, lon: number): number {
    const g = this.g;
    const fy = clamp((lat - g.south) / g.step - 0.5, 0, g.rows - 1.001);
    const fx = clamp((lon - g.west) / g.step - 0.5, 0, g.cols - 1.001);
    const i = Math.floor(fy);
    const j = Math.floor(fx);
    const ty = fy - i;
    const tx = fx - j;
    const c = g.cols;
    const d = this.data;
    const a = d[i * c + j];
    const b = d[i * c + j + 1];
    const e = d[(i + 1) * c + j];
    const f = d[(i + 1) * c + j + 1];
    // NaN-aware (ceiling uses NaN for "none").
    if (Number.isNaN(a + b + e + f)) {
      const near = [a, b, e, f][(ty > 0.5 ? 2 : 0) + (tx > 0.5 ? 1 : 0)];
      return near;
    }
    return (a * (1 - tx) + b * tx) * (1 - ty) + (e * (1 - tx) + f * tx) * ty;
  }
}

export type CellStage = 'growing' | 'mature' | 'dissipating';

export interface StormCell {
  id: number;
  x: number;
  z: number;
  /** Core radius (m). */
  radius: number;
  /** Peak reflectivity at maturity (dBZ). */
  peak: number;
  age: number;
  life: number;
  vx: number;
  vz: number;
  top: number; // cloud top (m MSL)
  stage: CellStage;
  /** Current strength 0..1. */
  strength: number;
}

export interface LightningStrike {
  x: number;
  z: number;
  y: number;
  t: number;
  cloudToGround: boolean;
  cell: number;
}

export interface CloudLayer {
  base: number; // m MSL
  top: number; // m MSL
  cover: number; // 0..1
  type: 'cu' | 'st' | 'ac' | 'ci' | 'cb';
}

export interface WeatherSample {
  /** Mean wind (world frame, m/s) at the queried altitude. */
  wind: Vec3;
  windFrom: number; // true degrees
  windSpeed: number; // m/s
  qnhPa: number;
  tempC: number; // at altitude
  isaDev: number; // K
  dewpointC: number; // surface
  vis: number; // m at altitude
  precip: number; // mm/h
  inCloud: number; // 0..1
  turbulence: number; // 0..3
  vertical: number; // updraft (+) / downdraft (-) m/s
  ceiling: number; // m AGL (Infinity = none)
  layers: CloudLayer[];
  reflectivity: number; // dBZ
  icing: boolean;
}

export interface WeatherOptions {
  /** Multiplier on how quickly weather evolves (1 = real time). */
  evolution: number;
  seed: number;
}

export class WeatherSystem {
  readonly g: SeedGrid;
  time = 0;
  cells: StormCell[] = [];
  strikes: LightningStrike[] = [];
  private nextId = 1;
  private rnd: () => number;
  private readonly f: Record<string, Field>;
  private readonly levels: { alt: number; u: Field; v: Field; t: Field }[];
  /** Steering-flow drift of the whole pattern (m/s, local x/z). */
  drift: [number, number] = [0, 0];
  private spawnTimer = 0;

  constructor(readonly seed: SeedFields, readonly proj: Projection, readonly opts: WeatherOptions = { evolution: 1, seed: 1 }) {
    this.g = seed.grid;
    this.rnd = mulberry(opts.seed * 104729 + 17);
    const F = (a: Float32Array) => new Field(this.g, a);
    this.f = {
      u10: F(seed.u10), v10: F(seed.v10), gust: F(seed.gust), t2: F(seed.t2), td2: F(seed.td2), mslp: F(seed.mslp),
      vis: F(seed.vis), lcc: F(seed.lcc), mcc: F(seed.mcc), hcc: F(seed.hcc), refc: F(seed.refc), cape: F(seed.cape), ceil: F(seed.ceil),
    };
    this.levels = seed.levels.map((l) => ({ alt: l.alt, u: F(l.u), v: F(l.v), t: F(l.t) }));
    // Steering flow: ~70 % of the mean 850-500 hPa wind around the home airport.
    const [lat0, lon0] = proj.toLatLon(0, 0);
    let u = 0;
    let v = 0;
    for (const l of this.levels.slice(0, 3)) {
      u += l.u.sample(lat0, lon0);
      v += l.v.sample(lat0, lon0);
    }
    this.drift = [(u / 3) * 0.7, (-v / 3) * 0.7];
    this.cellsFromReflectivity();
    if (seed.convection > 0.5) this.spawnInitialStorms();
  }

  // ------------------------------------------------------------------ evolution

  /** Pattern offset: fields are sampled upstream of the query point as the pattern drifts. */
  private shifted(x: number, z: number): [number, number] {
    return this.proj.toLatLon(x - this.drift[0] * this.time, z - this.drift[1] * this.time);
  }

  private cellsFromReflectivity(): void {
    // Turn convective blobs in the snapshot (>= 40 dBZ) into storm cells.
    const g = this.g;
    const refc = this.seed.refc;
    const seen = new Uint8Array(refc.length);
    for (let k = 0; k < refc.length; k++) {
      if (refc[k] < 40 || seen[k]) continue;
      const stack = [k];
      let sx = 0;
      let sz = 0;
      let n = 0;
      let peak = 0;
      seen[k] = 1;
      while (stack.length) {
        const c = stack.pop()!;
        const i = Math.floor(c / g.cols);
        const j = c % g.cols;
        const lat = g.south + (i + 0.5) * g.step;
        const lon = g.west + (j + 0.5) * g.step;
        const [x, z] = this.proj.toLocal(lat, lon);
        sx += x;
        sz += z;
        n++;
        peak = Math.max(peak, refc[c]);
        for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const ii = i + di;
          const jj = j + dj;
          if (ii < 0 || jj < 0 || ii >= g.rows || jj >= g.cols) continue;
          const kk = ii * g.cols + jj;
          if (!seen[kk] && refc[kk] >= 40) {
            seen[kk] = 1;
            stack.push(kk);
          }
        }
      }
      this.addCell(sx / n, sz / n, { peak: Math.min(68, peak + 3), radius: 2500 + Math.sqrt(n) * 3000, age: 900 });
    }
  }

  private spawnInitialStorms(): void {
    for (let i = 0; i < 8; i++) {
      const ang = (200 + this.rnd() * 110) * DEG; // west to south-west of DFW
      const d = 25000 + this.rnd() * 140000;
      this.addCell(Math.sin(ang) * d, -Math.cos(ang) * d, { age: this.rnd() * 2400 });
    }
  }

  addCell(x: number, z: number, o: Partial<StormCell> = {}): StormCell {
    const peak = o.peak ?? 45 + this.rnd() * 22;
    const cell: StormCell = {
      id: this.nextId++, x, z,
      radius: o.radius ?? 2500 + this.rnd() * 3500,
      peak, age: o.age ?? 0, life: o.life ?? 2700 + this.rnd() * 2400,
      vx: this.drift[0] * (1.1 + this.rnd() * 0.3), vz: this.drift[1] * (1.1 + this.rnd() * 0.3),
      top: 9000 + (peak - 45) * 450 + this.rnd() * 2500,
      stage: 'growing', strength: 0,
    };
    this.cells.push(cell);
    return cell;
  }

  /** Advance the weather by dt seconds (already scaled by sim rate). */
  update(dt: number, focusX = 0, focusZ = 0): void {
    const e = dt * this.opts.evolution;
    this.time += e;
    // Storm cell life cycles.
    for (const c of this.cells) {
      c.age += e;
      c.x += c.vx * e;
      c.z += c.vz * e;
      const t = c.age / c.life;
      c.stage = t < 0.25 ? 'growing' : t < 0.7 ? 'mature' : 'dissipating';
      c.strength = t < 0.25 ? smoothstep(0, 0.25, t) : t < 0.7 ? 1 : 1 - smoothstep(0.7, 1, t);
      // Lightning from mature storms.
      if (c.strength > 0.6 && c.peak > 48) {
        const rate = ((c.peak - 45) / 20) * c.strength * 0.12; // strikes per second
        if (this.rnd() < rate * e) {
          const a = this.rnd() * Math.PI * 2;
          const r = this.rnd() * c.radius * 1.3;
          const cg = this.rnd() < 0.3;
          this.strikes.push({ x: c.x + Math.cos(a) * r, z: c.z + Math.sin(a) * r, y: cg ? 0 : 4000 + this.rnd() * 4000, t: this.time, cloudToGround: cg, cell: c.id });
        }
      }
    }
    this.cells = this.cells.filter((c) => c.age < c.life && Math.hypot(c.x - focusX, c.z - focusZ) < 400000);
    this.strikes = this.strikes.filter((s) => this.time - s.t < 3);
    // New storms where the air mass supports convection.
    if (this.seed.convection > 0) {
      this.spawnTimer -= e;
      if (this.spawnTimer <= 0) {
        this.spawnTimer = (240 + this.rnd() * 420) / this.seed.convection;
        const ang = this.rnd() * Math.PI * 2;
        const d = 20000 + this.rnd() * 120000;
        const x = focusX + Math.sin(ang) * d;
        const z = focusZ - Math.cos(ang) * d;
        const [lat, lon] = this.shifted(x, z);
        const cape = this.f.cape.sample(lat, lon);
        if (cape > 900 && this.cells.length < 30) this.addCell(x, z);
      }
    }
  }

  // ------------------------------------------------------------------ queries

  private trendHours(): number {
    return this.time / 3600;
  }

  /** Surface pressure reduced to sea level (Pa) at a point. */
  qnh(x: number, z: number): number {
    const [lat, lon] = this.shifted(x, z);
    const slow = Math.sin(this.time / 5400) * 0.6;
    return (this.f.mslp.sample(lat, lon) + this.seed.pressureTrend * this.trendHours() + slow) * 100;
  }

  surfaceTemp(x: number, z: number): { t: number; td: number } {
    const [lat, lon] = this.shifted(x, z);
    const t = this.f.t2.sample(lat, lon) + this.seed.tempTrend * Math.min(this.trendHours(), 4);
    const td = Math.min(t - 0.2, this.f.td2.sample(lat, lon));
    return { t, td };
  }

  /** Mean wind (u east, v north, m/s) at altitude h (m MSL) above ground elevation ground (m). */
  windUV(x: number, z: number, h: number, ground: number): [number, number] {
    const [lat, lon] = this.shifted(x, z);
    const agl = Math.max(0, h - ground);
    const su = this.f.u10.sample(lat, lon);
    const sv = this.f.v10.sample(lat, lon);
    // Surface friction layer: wind increases and veers with height up to ~600 m AGL.
    const lv = this.levels;
    if (h <= lv[0].alt) {
      const l0u = lv[0].u.sample(lat, lon);
      const l0v = lv[0].v.sample(lat, lon);
      const t = smoothstep(0, Math.max(300, lv[0].alt - ground), agl);
      const nearGround = agl < 10 ? 0.75 + 0.25 * (agl / 10) : 1;
      return [lerp(su, l0u, t) * nearGround, lerp(sv, l0v, t) * nearGround];
    }
    for (let i = 0; i < lv.length - 1; i++) {
      if (h <= lv[i + 1].alt) {
        const t = (h - lv[i].alt) / (lv[i + 1].alt - lv[i].alt);
        return [lerp(lv[i].u.sample(lat, lon), lv[i + 1].u.sample(lat, lon), t), lerp(lv[i].v.sample(lat, lon), lv[i + 1].v.sample(lat, lon), t)];
      }
    }
    const top = lv[lv.length - 1];
    const fade = 1 - smoothstep(top.alt, top.alt + 6000, h) * 0.3;
    return [top.u.sample(lat, lon) * fade, top.v.sample(lat, lon) * fade];
  }

  tempAt(x: number, z: number, h: number, ground: number): number {
    const [lat, lon] = this.shifted(x, z);
    const s = this.surfaceTemp(x, z).t;
    const lv = this.levels;
    if (h <= lv[0].alt) {
      const t0 = lv[0].t.sample(lat, lon);
      const span = Math.max(100, lv[0].alt - ground);
      return lerp(s, t0, clamp((h - ground) / span, 0, 1));
    }
    for (let i = 0; i < lv.length - 1; i++) {
      if (h <= lv[i + 1].alt) {
        const t = (h - lv[i].alt) / (lv[i + 1].alt - lv[i].alt);
        return lerp(lv[i].t.sample(lat, lon), lv[i + 1].t.sample(lat, lon), t);
      }
    }
    const top = lv[lv.length - 1];
    return Math.max(-57, top.t.sample(lat, lon) - 6.5 * ((h - top.alt) / 1000));
  }

  /** Cloud layers over a point (bases in m MSL). */
  layersAt(x: number, z: number, ground: number): CloudLayer[] {
    const [lat, lon] = this.shifted(x, z);
    const out: CloudLayer[] = [];
    const slow = (k: number) => 0.85 + 0.15 * Math.sin(this.time / 2700 + k + x / 30000 + z / 41000);
    const lcc = clamp(this.f.lcc.sample(lat, lon) * slow(1), 0, 1);
    if (lcc > 0.04) {
      const { t, td } = this.surfaceTemp(x, z);
      const ceil = this.f.ceil.sample(lat, lon);
      const lcl = clamp(125 * (t - td), 60, 3500);
      const base = ground + (Number.isFinite(ceil) && ceil > 0 ? Math.min(ceil, lcl * 1.5 + 200) : lcl);
      const stratus = lcc > 0.7 || base - ground < 600;
      out.push({ base, top: base + (stratus ? 350 + lcc * 500 : 600 + lcc * 1200), cover: lcc, type: stratus ? 'st' : 'cu' });
    }
    const mcc = clamp(this.f.mcc.sample(lat, lon) * slow(2), 0, 1);
    if (mcc > 0.05) out.push({ base: 4200, top: 4200 + 400 + mcc * 600, cover: mcc, type: 'ac' });
    const hcc = clamp(this.f.hcc.sample(lat, lon) * slow(3), 0, 1);
    if (hcc > 0.05) out.push({ base: 9500, top: 10200, cover: hcc, type: 'ci' });
    for (const c of this.cells) {
      const d = Math.hypot(x - c.x, z - c.z);
      if (d < c.radius * 2.2 && c.strength > 0.15) {
        const cover = clamp(1.2 - d / (c.radius * 2.2), 0, 1) * c.strength;
        if (cover > 0.05) out.push({ base: ground + 900, top: lerp(ground + 3000, c.top, c.strength), cover, type: 'cb' });
      }
    }
    return out;
  }

  /** Reflectivity (dBZ) at a point near the ground: stratiform field plus storm cells. */
  reflectivity(x: number, z: number): number {
    const [lat, lon] = this.shifted(x, z);
    let z0 = this.f.refc.sample(lat, lon);
    for (const c of this.cells) {
      const d = Math.hypot(x - c.x, z - c.z);
      if (d > c.radius * 3) continue;
      const core = Math.exp(-((d / c.radius) ** 2));
      const dbz = c.peak * c.strength * (0.55 + 0.45 * core) - (d > c.radius ? (d / c.radius - 1) * 18 : 0);
      if (dbz > z0) z0 = dbz;
    }
    return z0;
  }

  /** Storm-cell vertical air motion and outflow at a point (m/s, world frame). */
  private cellWind(x: number, z: number, h: number, ground: number): { w: Vec3; turb: number; dbz: number } {
    let wx = 0;
    let wy = 0;
    let wz = 0;
    let turb = 0;
    const agl = h - ground;
    for (const c of this.cells) {
      const dx = x - c.x;
      const dz = z - c.z;
      const d = Math.hypot(dx, dz);
      if (d > c.radius * 4 || c.strength < 0.05) continue;
      const r = d / c.radius;
      const core = Math.exp(-r * r);
      const inStorm = h < c.top;
      if (inStorm) turb = Math.max(turb, (c.peak - 30) / 12 * c.strength * Math.exp(-((r / 1.6) ** 2)));
      if (c.stage === 'dissipating' || (c.stage === 'mature' && c.peak > 55)) {
        // Downdraft that spreads out at the ground: a microburst.
        const mb = (c.stage === 'dissipating' ? 1.4 : 0.7) * c.strength;
        const down = -9 * mb * core * smoothstep(0, 200, agl);
        wy += down * (agl < 1500 ? 1 : 0.5);
        const outflow = 14 * mb * (r < 3 ? Math.sin(Math.min(Math.PI, r * 1.1)) : 0) * (1 - smoothstep(150, 900, agl));
        if (d > 1) {
          wx += (dx / d) * outflow;
          wz += (dz / d) * outflow;
        }
      } else if (inStorm && agl > 800) {
        wy += 8 * c.strength * core; // updraft
      }
    }
    return { w: [wx, wy, wz], turb: Math.min(3, turb), dbz: 0 };
  }

  /** Full sample for the flight model, instruments and effects. */
  sample(x: number, z: number, h: number, ground: number): WeatherSample {
    const [u, v] = this.windUV(x, z, h, ground);
    const cell = this.cellWind(x, z, h, ground);
    const wind: Vec3 = [u + cell.w[0], cell.w[1], -v + cell.w[2]];
    const tempC = this.tempAt(x, z, h, ground);
    const tIsa = TISA0 - 6.5 * Math.min(h, 11000) / 1000;
    const { td } = this.surfaceTemp(x, z);
    const layers = this.layersAt(x, z, ground);
    let inCloud = 0;
    let ceiling = Infinity;
    for (const l of layers) {
      if (l.cover >= 0.55 && l.base - ground < ceiling) ceiling = l.base - ground;
      if (h > l.base && h < l.top) {
        // Inside the layer's vertical extent: denser in the middle, patchy for broken layers.
        const patch = l.cover >= 0.9 ? 1 : smoothstep(0.35, 0.65, l.cover + 0.25 * Math.sin(x / 2300 + z / 1900 + this.time / 300));
        inCloud = Math.max(inCloud, patch * Math.min(1, Math.min(h - l.base, l.top - h) / 60));
      }
    }
    const dbz = this.reflectivity(x, z);
    const precipBelow = dbz > 15 ? Math.pow(Math.pow(10, dbz / 10) / 200, 1 / 1.6) : 0;
    const precip = h < (layers[0]?.top ?? 3000) + 2000 ? precipBelow : precipBelow * 0.5;
    const [lat, lon] = this.shifted(x, z);
    let vis = this.f.vis.sample(lat, lon) * (h - ground < 300 ? 1 : 1 + (h - ground) / 600);
    // Fog layer is shallow: above it the visibility opens up.
    if (vis < 3000 && h - ground > 120) vis = Math.max(vis, 3000 + (h - ground) * 40);
    if (precip > 0.2) vis = Math.min(vis, 25000 / (1 + precip * 0.6));
    if (inCloud > 0.5) vis = Math.min(vis, 120 + (1 - inCloud) * 800);
    // Mechanical turbulence near the ground in strong wind, clear-air turbulence at the jet.
    const spdKt = Math.hypot(u, v) / KT;
    let turb = cell.turb;
    if (h - ground < 900) turb = Math.max(turb, smoothstep(18, 40, spdKt) * 1.2 * (1 - smoothstep(300, 900, h - ground)));
    if (h > 8000) turb = Math.max(turb, smoothstep(110, 170, spdKt) * 1.1);
    if (inCloud > 0.3 && layers.some((l) => l.type === 'cu' && h > l.base && h < l.top)) turb = Math.max(turb, 0.6);
    const icing = inCloud > 0.4 && tempC < 2 && tempC > -15;
    return {
      wind, windFrom: wrap360(Math.atan2(-u, -v) * RAD), windSpeed: Math.hypot(u, v),
      qnhPa: this.qnh(x, z), tempC, isaDev: tempC - tIsa, dewpointC: td, vis, precip, inCloud,
      turbulence: turb, vertical: cell.w[1], ceiling, layers, reflectivity: dbz, icing,
    };
  }

  /** Gust factor at the surface (m/s above mean). */
  gustAt(x: number, z: number): number {
    const [lat, lon] = this.shifted(x, z);
    const [u, v] = [this.f.u10.sample(lat, lon), this.f.v10.sample(lat, lon)];
    let g = Math.max(0, this.f.gust.sample(lat, lon) - Math.hypot(u, v));
    for (const c of this.cells) {
      const d = Math.hypot(x - c.x, z - c.z);
      if (d < c.radius * 4) g = Math.max(g, 10 * c.strength * (1 - d / (c.radius * 4)));
    }
    return g;
  }

  // ------------------------------------------------------------------ reports

  /** METAR-style observation for an airport. */
  metar(ident: string, x: number, z: number, elevM: number, utc: Date): string {
    const s = this.sample(x, z, elevM + 10, elevM);
    const gust = this.gustAt(x, z);
    const spd = Math.round(s.windSpeed / KT);
    const dir = Math.round(s.windFrom / 10) * 10 || 360;
    const g = gust / KT > 9 && spd > 3 ? `G${Math.round(spd + gust / KT)}` : '';
    const wind = spd < 3 ? '00000KT' : `${String(dir).padStart(3, '0')}${String(spd).padStart(2, '0')}${g}KT`;
    const sm = s.vis / 1609.34;
    const vis = sm >= 10 ? '10SM' : sm >= 3 ? `${Math.round(sm)}SM` : sm >= 1 ? `${Math.round(sm * 2) / 2}SM`.replace('.5', ' 1/2') : sm >= 0.5 ? '1/2SM' : sm >= 0.25 ? '1/4SM' : 'M1/4SM';
    const wx: string[] = [];
    const ts = this.cells.some((c) => c.strength > 0.6 && Math.hypot(c.x - x, c.z - z) < 18000);
    const vcts = !ts && this.cells.some((c) => c.strength > 0.6 && Math.hypot(c.x - x, c.z - z) < 50000);
    if (s.precip > 0.3) wx.push(`${s.precip > 8 ? '+' : s.precip < 2.5 ? '-' : ''}${ts ? 'TS' : ''}${s.tempC < 0 ? 'SN' : s.precip < 0.8 && !ts ? 'DZ' : 'RA'}`);
    else if (ts) wx.push('TS');
    if (s.vis < 1000) wx.push('FG');
    else if (s.vis < 8000 && s.tempC - s.dewpointC < 3 && s.precip < 0.3) wx.push('BR');
    if (vcts) wx.push('VCTS');
    const layers = this.layersAt(x, z, elevM).sort((a, b) => a.base - b.base);
    const sky = layers.map((l) => {
      const code = l.cover < 0.25 ? 'FEW' : l.cover < 0.5 ? 'SCT' : l.cover < 0.88 ? 'BKN' : 'OVC';
      const hgt = String(Math.max(1, Math.round((l.base - elevM) / FT / 100))).padStart(3, '0');
      return `${code}${hgt}${l.type === 'cb' ? 'CB' : ''}`;
    });
    const vv = s.vis < 400 && layers.length && layers[0].base - elevM < 80 ? ['VV001'] : [];
    const temp = (c: number) => (c < 0 ? 'M' : '') + String(Math.abs(Math.round(c))).padStart(2, '0');
    const alt = Math.round((s.qnhPa / 100) * 0.0295299830714 * 100);
    const day = String(utc.getUTCDate()).padStart(2, '0');
    const hhmm = `${String(utc.getUTCHours()).padStart(2, '0')}${String(utc.getUTCMinutes()).padStart(2, '0')}`;
    const slp = String(Math.round((s.qnhPa / 100) * 10) % 1000).padStart(3, '0');
    return [ident, `${day}${hhmm}Z`, wind, vis, ...wx, ...(vv.length ? vv : sky.length ? sky : ['CLR']), `${temp(s.tempC)}/${temp(s.dewpointC)}`, `A${alt}`, 'RMK', 'AO2', `SLP${slp}`].join(' ');
  }
}

