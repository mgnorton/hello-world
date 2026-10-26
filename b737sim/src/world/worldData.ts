// Real-world terrain, land cover and airport surfaces for the KDFW region.
import { lerp, smoothstep } from '../core/math.ts';
import { Projection, MagVar, type MagVarMeta } from './geo.ts';
import { NavDB, type Airport, type Runway, type NavDataJson } from './navdb.ts';
import { airportLayout, onPavement } from './airportLayout.ts';
import type { WeatherSeed } from '../weather/seed.ts';

export interface GridMeta {
  south: number;
  north: number;
  west: number;
  east: number;
  step: number;
  rows: number;
  cols: number;
  scale?: number;
}

export interface WorldMeta {
  home: { icao: string; lat: number; lon: number };
  sources: Record<string, string>;
  classes: string[];
  terrainWide: GridMeta;
  terrainMetro: GridMeta;
  landcoverWide: GridMeta;
  landcoverMetro: GridMeta;
  magVar: MagVarMeta;
  navCycle: string;
}

/** ESA WorldCover classes as indices into world.json `classes`. */
export const LC = {
  NONE: 0, TREE: 1, SHRUB: 2, GRASS: 3, CROP: 4, BUILT: 5, BARE: 6, SNOW: 7, WATER: 8, WETLAND: 9, MANGROVE: 10, MOSS: 11,
} as const;

export type SurfaceKind = 'runway' | 'paved' | 'grass' | 'water';
export interface Surface {
  h: number;
  kind: SurfaceKind;
  water: boolean;
}

/** Byte loader abstraction so the same code runs in the browser and in node tests. */
export interface DataSource {
  bytes(path: string): Promise<Uint8Array>;
  gunzip(data: Uint8Array): Promise<Uint8Array>;
  text(path: string): Promise<string | null>;
}

class HeightGrid {
  constructor(readonly meta: GridMeta, readonly data: Int16Array) {}
  inside(lat: number, lon: number, marginDeg = 0): boolean {
    const m = this.meta;
    return lat >= m.south + marginDeg && lat <= m.north - marginDeg && lon >= m.west + marginDeg && lon <= m.east - marginDeg;
  }
  sample(lat: number, lon: number): number {
    const m = this.meta;
    const fy = Math.max(0, Math.min(m.rows - 1.001, (lat - m.south) / m.step));
    const fx = Math.max(0, Math.min(m.cols - 1.001, (lon - m.west) / m.step));
    const i = Math.floor(fy);
    const j = Math.floor(fx);
    const ty = fy - i;
    const tx = fx - j;
    const c = m.cols;
    const d = this.data;
    const s = m.scale ?? 1;
    const a = d[i * c + j];
    const b = d[i * c + j + 1];
    const e = d[(i + 1) * c + j];
    const f = d[(i + 1) * c + j + 1];
    return ((a * (1 - tx) + b * tx) * (1 - ty) + (e * (1 - tx) + f * tx) * ty) * s;
  }
}

class ClassGrid {
  constructor(readonly meta: GridMeta, readonly data: Uint8Array) {}
  inside(lat: number, lon: number): boolean {
    const m = this.meta;
    return lat >= m.south && lat < m.north && lon >= m.west && lon < m.east;
  }
  at(lat: number, lon: number): number {
    const m = this.meta;
    const i = Math.floor((lat - m.south) / m.step);
    const j = Math.floor((lon - m.west) / m.step);
    if (i < 0 || j < 0 || i >= m.rows || j >= m.cols) return LC.GRASS;
    return this.data[i * m.cols + j];
  }
}

interface Pad {
  runway?: Runway;
  airport: Airport;
  cx: number;
  cz: number;
  dx: number;
  dz: number;
  halfLen: number;
  halfWid: number;
  blend: number;
  flatH?: number;
}

const PAD_CELL = 5000;

export class WorldData {
  readonly proj: Projection;
  readonly magVar: MagVar;
  readonly nav: NavDB;
  private readonly demWide: HeightGrid;
  private readonly demMetro: HeightGrid;
  readonly lcWide: ClassGrid;
  readonly lcMetro: ClassGrid;
  private readonly padGrid = new Map<string, Pad[]>();
  private readonly airportGrid = new Map<string, Airport[]>();

  constructor(
    readonly meta: WorldMeta,
    files: { terrainWide: Int16Array; terrainMetro: Int16Array; landcoverWide: Uint8Array; landcoverMetro: Uint8Array },
    navJson: NavDataJson,
    readonly weatherSeed: WeatherSeed | null,
  ) {
    this.proj = new Projection(meta.home.lat, meta.home.lon);
    this.magVar = new MagVar(meta.magVar);
    this.demWide = new HeightGrid(meta.terrainWide, files.terrainWide);
    this.demMetro = new HeightGrid(meta.terrainMetro, files.terrainMetro);
    this.lcWide = new ClassGrid(meta.landcoverWide, files.landcoverWide);
    this.lcMetro = new ClassGrid(meta.landcoverMetro, files.landcoverMetro);
    this.nav = new NavDB(navJson, this.proj, this.magVar);
    this.buildPads();
  }

  get home(): Airport {
    return this.nav.airport(this.meta.home.icao)!;
  }

  private addToGrid<T>(grid: Map<string, T[]>, x: number, z: number, r: number, item: T): void {
    for (let i = Math.floor((x - r) / PAD_CELL); i <= Math.floor((x + r) / PAD_CELL); i++) {
      for (let j = Math.floor((z - r) / PAD_CELL); j <= Math.floor((z + r) / PAD_CELL); j++) {
        const k = `${i},${j}`;
        const list = grid.get(k) ?? [];
        list.push(item);
        grid.set(k, list);
      }
    }
  }

  private buildPads(): void {
    for (const ap of this.nav.airports) {
      this.addToGrid(this.airportGrid, ap.x, ap.z, 4000, ap);
      for (const r of ap.runways) {
        const d = [Math.sin((r.heading * Math.PI) / 180), -Math.cos((r.heading * Math.PI) / 180)];
        const big = r.lengthM > 1800;
        const pad: Pad = {
          runway: r, airport: ap, cx: r.cx, cz: r.cz, dx: d[0], dz: d[1],
          halfLen: r.lengthM / 2 + (big ? 200 : 60), halfWid: r.widthM / 2 + (big ? 200 : 40), blend: big ? 400 : 150,
        };
        this.addToGrid(this.padGrid, r.cx, r.cz, r.lengthM / 2 + 800, pad);
      }
      for (const p of airportLayout(ap).pavements) {
        if (p.kind !== 'apron') continue;
        const d = [Math.sin((p.heading * Math.PI) / 180), -Math.cos((p.heading * Math.PI) / 180)];
        const [lat, lon] = this.proj.toLatLon(p.x, p.z);
        const pad: Pad = {
          airport: ap, cx: p.x, cz: p.z, dx: d[0], dz: d[1], halfLen: p.length / 2 + 40, halfWid: p.width / 2 + 40,
          blend: 200, flatH: this.demHeight(lat, lon),
        };
        this.addToGrid(this.padGrid, p.x, p.z, p.length / 2 + 400, pad);
      }
    }
  }

  /** Raw DEM elevation (m), metro grid where available, blended into the wide grid at its edge. */
  demHeight(lat: number, lon: number): number {
    const wide = this.demWide.sample(lat, lon);
    const m = this.demMetro.meta;
    if (!this.demMetro.inside(lat, lon)) return wide;
    // Blend over the outer 0.05 degrees of the metro grid.
    const edge = Math.min(lat - m.south, m.north - lat, lon - m.west, m.east - lon);
    const w = smoothstep(0, 0.05, edge);
    return lerp(wide, this.demMetro.sample(lat, lon), w);
  }

  /** Terrain elevation (m MSL) at local (x, z), with runways and aprons graded flat. */
  height(x: number, z: number): number {
    const [lat, lon] = this.proj.toLatLon(x, z);
    let h = this.demHeight(lat, lon);
    const pads = this.padGrid.get(`${Math.floor(x / PAD_CELL)},${Math.floor(z / PAD_CELL)}`);
    if (!pads) return h;
    let bestW = 0;
    let padH = h;
    for (const p of pads) {
      const rx = x - p.cx;
      const rz = z - p.cz;
      const along = rx * p.dx + rz * p.dz;
      const across = rx * -p.dz + rz * p.dx;
      const ex = Math.max(0, Math.abs(along) - p.halfLen);
      const ez = Math.max(0, Math.abs(across) - p.halfWid);
      const e = Math.hypot(ex, ez);
      if (e >= p.blend) continue;
      const w = 1 - smoothstep(0, p.blend, e);
      if (w > bestW) {
        bestW = w;
        padH = p.runway ? p.runway.elevAt(along) : (p.flatH ?? h);
      }
    }
    if (bestW > 0) h = lerp(h, padH, bestW);
    return h;
  }

  /** Land-cover class at local (x, z). */
  landClass(x: number, z: number): number {
    const [lat, lon] = this.proj.toLatLon(x, z);
    return this.lcMetro.inside(lat, lon) ? this.lcMetro.at(lat, lon) : this.lcWide.at(lat, lon);
  }

  airportsAt(x: number, z: number): Airport[] {
    return this.airportGrid.get(`${Math.floor(x / PAD_CELL)},${Math.floor(z / PAD_CELL)}`) ?? [];
  }

  /** Surface under a point for the physics: elevation and what the wheels are rolling on. */
  surface(x: number, z: number): Surface {
    const h = this.height(x, z);
    for (const ap of this.airportsAt(x, z)) {
      for (const r of ap.runways) {
        if (r.contains(x, z, 1.5)) return { h, kind: r.paved ? 'runway' : 'grass', water: false };
      }
      if (onPavement(airportLayout(ap), x, z)) return { h, kind: 'paved', water: false };
    }
    const cls = this.landClass(x, z);
    if (cls === LC.WATER) return { h, kind: 'water', water: true };
    return { h, kind: 'grass', water: false };
  }
}

// ------------------------------------------------------------------- loading

function toInt16(u8: Uint8Array): Int16Array {
  const buf = u8.byteOffset % 2 === 0 ? u8 : u8.slice();
  return new Int16Array(buf.buffer, buf.byteOffset, buf.byteLength / 2);
}

async function maybeGunzip(src: DataSource, data: Uint8Array): Promise<Uint8Array> {
  return data[0] === 0x1f && data[1] === 0x8b ? src.gunzip(data) : data;
}

export async function loadWorld(src: DataSource, onProgress?: (msg: string, frac: number) => void): Promise<WorldData> {
  const step = (msg: string, f: number) => onProgress?.(msg, f);
  step('Reading region', 0.02);
  const meta = JSON.parse((await src.text('world.json'))!) as WorldMeta;
  const names = ['terrain_wide', 'terrain_metro', 'landcover_wide', 'landcover_metro', 'navdata'] as const;
  const labels = ['Elevation (USGS 3DEP)', 'Metroplex elevation', 'Land cover (ESA WorldCover)', 'Metroplex land cover', 'FAA navigation data'];
  const raw: Uint8Array[] = [];
  for (let i = 0; i < names.length; i++) {
    step(labels[i], 0.05 + (i / names.length) * 0.8);
    raw.push(await maybeGunzip(src, await src.bytes(`${names[i]}.dat`)));
  }
  step('Weather snapshot', 0.88);
  const seedText = await src.text('weather_seed.json');
  const seed = seedText ? (JSON.parse(seedText) as WeatherSeed) : null;
  const nav = JSON.parse(new TextDecoder().decode(raw[4])) as NavDataJson;
  step('Building world', 0.92);
  return new WorldData(meta, {
    terrainWide: toInt16(raw[0]), terrainMetro: toInt16(raw[1]), landcoverWide: raw[2], landcoverMetro: raw[3],
  }, nav, seed);
}
