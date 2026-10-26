// Airport scenery built from the FAA data: each runway end's real marking class (precision,
// non-precision, basic), displaced thresholds, approach lighting system type (ALSF-2, ALSF-1,
// MALSR, MALS, ODALS, RLLS), PAPI/VASI type and side, centreline / touchdown-zone lights,
// REILs and edge-light intensity. Taxiways, aprons and buildings come from airportLayout.
import * as THREE from 'three';
import { DEG, FT, dirOf, wrap360 } from '../core/math.ts';
import type { WorldData } from '../world/worldData.ts';
import type { Airport, Runway, RunwayEnd } from '../world/navdb.ts';
import { airportLayout, type Building } from '../world/airportLayout.ts';
import { GROUND_GRID } from './world.ts';
import { LightBatch, FX, WHITE, YELLOW, GREEN, RED, BLUE, OFF, type RGB } from './lights.ts';

/** Height of the rendered terrain mesh (finest LOD triangulation) so pavement drapes exactly on it. */
export class GroundSampler {
  private cache = new Map<number, number>();
  constructor(readonly world: WorldData) {}
  private node(i: number, j: number): number {
    const k = i * 131071 + j;
    let h = this.cache.get(k);
    if (h === undefined) {
      h = this.world.height(i * GROUND_GRID, j * GROUND_GRID);
      this.cache.set(k, h);
    }
    return h;
  }
  at(x: number, z: number): number {
    const gx = x / GROUND_GRID;
    const gz = z / GROUND_GRID;
    const i = Math.floor(gx);
    const j = Math.floor(gz);
    const fx = gx - i;
    const fz = gz - j;
    const h00 = this.node(i, j);
    const h10 = this.node(i + 1, j);
    const h01 = this.node(i, j + 1);
    const h11 = this.node(i + 1, j + 1);
    if (fx + fz <= 1) return h00 + (h10 - h00) * fx + (h01 - h00) * fz;
    return h11 + (h01 - h11) * (1 - fx) + (h10 - h11) * (1 - fz);
  }
  clear(): void {
    if (this.cache.size > 200000) this.cache.clear();
  }
}

/** Flat rectangles draped on the ground, merged into one geometry. */
class Quads {
  private pos: number[] = [];
  private uv: number[] = [];
  private idx: number[] = [];
  constructor(private readonly ground: GroundSampler) {}

  /**
   * Rectangle centred on (x, z): `length` along true heading `heading`, `width` across, `lift` metres
   * above the terrain mesh. uvScale > 0 maps world metres to texture repeats; 0 maps the quad to 0..1.
   */
  rect(x: number, z: number, heading: number, length: number, width: number, lift: number, uvScale = 0, maxSeg = 80): void {
    const d = dirOf(heading);
    const rx = -d[2];
    const rz = d[0];
    const nl = Math.max(1, Math.ceil(length / maxSeg));
    const nw = Math.max(1, Math.ceil(width / maxSeg));
    const base = this.pos.length / 3;
    for (let i = 0; i <= nl; i++) {
      for (let j = 0; j <= nw; j++) {
        const a = (i / nl - 0.5) * length;
        const c = (j / nw - 0.5) * width;
        const px = x + d[0] * a + rx * c;
        const pz = z + d[2] * a + rz * c;
        this.pos.push(px, this.ground.at(px, pz) + lift, pz);
        if (uvScale) this.uv.push(px / uvScale, pz / uvScale);
        else this.uv.push(j / nw, i / nl);
      }
    }
    for (let i = 0; i < nl; i++) {
      for (let j = 0; j < nw; j++) {
        const a = base + i * (nw + 1) + j;
        const b = a + nw + 1;
        this.tri(a, a + 1, b);
        this.tri(a + 1, b + 1, b);
      }
    }
  }

  /** Push a triangle wound to face up. */
  private tri(a: number, b: number, c: number): void {
    const p = this.pos;
    const ux = p[b * 3] - p[a * 3];
    const uz = p[b * 3 + 2] - p[a * 3 + 2];
    const vx = p[c * 3] - p[a * 3];
    const vz = p[c * 3 + 2] - p[a * 3 + 2];
    if (uz * vx - ux * vz >= 0) this.idx.push(a, b, c);
    else this.idx.push(a, c, b);
  }

  get empty(): boolean {
    return this.idx.length === 0;
  }

  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setIndex(this.idx);
    g.computeVertexNormals();
    g.computeBoundingSphere();
    return g;
  }
}

// ------------------------------------------------------------------ shared materials

function pavementTexture(concrete: boolean): THREE.Texture {
  const s = 256;
  const cv = document.createElement('canvas');
  cv.width = cv.height = s;
  const g = cv.getContext('2d')!;
  g.fillStyle = concrete ? '#9a9993' : '#47484a';
  g.fillRect(0, 0, s, s);
  const img = g.getImageData(0, 0, s, s);
  for (let i = 0; i < img.data.length; i += 4) {
    const n = (Math.random() - 0.5) * (concrete ? 24 : 20);
    img.data[i] += n;
    img.data[i + 1] += n;
    img.data[i + 2] += n;
  }
  g.putImageData(img, 0, 0);
  if (concrete) {
    // Slab joints every 25 ft.
    g.strokeStyle = 'rgba(70,70,70,0.35)';
    for (let k = 0; k <= s; k += 32) {
      g.beginPath(); g.moveTo(k, 0); g.lineTo(k, s); g.stroke();
      g.beginPath(); g.moveTo(0, k); g.lineTo(s, k); g.stroke();
    }
  }
  for (let k = 0; k < 24; k++) {
    g.fillStyle = `rgba(25,25,28,${concrete ? 0.12 : 0.2})`;
    g.fillRect(Math.random() * s, Math.random() * s, 10 + Math.random() * 50, 4 + Math.random() * 25);
  }
  const t = new THREE.CanvasTexture(cv);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

function designationTexture(id: string): THREE.Texture {
  const cv = document.createElement('canvas');
  cv.width = 128;
  cv.height = 300;
  const g = cv.getContext('2d')!;
  g.fillStyle = '#f2f2ee';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  const num = id.replace(/[LRC]$/, '');
  const suffix = id.slice(num.length);
  g.font = 'bold 118px "Arial Narrow", Arial, sans-serif';
  g.save();
  g.scale(0.62, 1);
  // Number on top (further down the runway), letter nearest the threshold.
  g.fillText(num, 64 / 0.62, suffix ? 70 : 150);
  if (suffix) g.fillText(suffix, 64 / 0.62, 228);
  g.restore();
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

interface SharedMats {
  asphalt: THREE.MeshPhongMaterial;
  concrete: THREE.MeshPhongMaterial;
  turf: THREE.MeshLambertMaterial;
  white: THREE.MeshLambertMaterial;
  yellow: THREE.MeshLambertMaterial;
  glass: THREE.MeshPhongMaterial;
  wall: THREE.MeshLambertMaterial;
  roof: THREE.MeshLambertMaterial;
  box: THREE.MeshLambertMaterial;
}
let shared: SharedMats | null = null;
function mats(): SharedMats {
  if (shared) return shared;
  shared = {
    asphalt: new THREE.MeshPhongMaterial({ map: pavementTexture(false), shininess: 6, specular: 0x101010 }),
    concrete: new THREE.MeshPhongMaterial({ map: pavementTexture(true), shininess: 6, specular: 0x101010 }),
    turf: new THREE.MeshLambertMaterial({ color: 0x6b7442 }),
    white: new THREE.MeshLambertMaterial({ color: 0xeeeee8 }),
    yellow: new THREE.MeshLambertMaterial({ color: 0xd9ad2c }),
    glass: new THREE.MeshPhongMaterial({ color: 0x6f8496, shininess: 80, specular: 0x8899aa, emissive: 0x000000 }),
    wall: new THREE.MeshLambertMaterial({ color: 0xd2cdc2 }),
    roof: new THREE.MeshLambertMaterial({ color: 0x9c9c9a }),
    box: new THREE.MeshLambertMaterial({ color: 0x3a3a3a }),
  };
  return shared;
}

/** Darken pavement and make it glossy when wet; light up terminal windows at night. */
export function updateAirportMaterials(wet: number, night: number): void {
  const m = mats();
  for (const p of [m.asphalt, m.concrete]) {
    p.specular.setScalar(0.06 + wet * 0.45);
    p.shininess = 6 + wet * 70;
    p.color.setScalar(1 - wet * 0.3);
  }
  m.glass.emissive.setRGB(night * 0.55, night * 0.45, night * 0.3);
}

// ------------------------------------------------------------------ runway helpers

type MarkClass = 0 | 1 | 2 | 3; // none, basic, non-precision, precision
const markClass = (e: RunwayEnd): MarkClass => {
  const m = e.raw.marking;
  return m === 'PIR' ? 3 : m === 'NPI' ? 2 : m === 'NONE' ? 0 : 1;
};

const thresholdStripes = (widthFt: number): number => (widthFt <= 60 ? 4 : widthFt <= 75 ? 6 : widthFt <= 100 ? 8 : widthFt <= 150 ? 12 : 16);

/** Local frame of a runway end: along (m past the landing threshold) and across (m right of centreline). */
class EndFrame {
  readonly d: [number, number];
  readonly r: [number, number];
  constructor(readonly end: RunwayEnd) {
    const d = dirOf(end.heading);
    this.d = [d[0], d[2]];
    this.r = [-d[2], d[0]];
  }
  at(along: number, across: number): [number, number] {
    const e = this.end;
    return [e.tx + this.d[0] * along + this.r[0] * across, e.tz + this.d[1] * along + this.r[1] * across];
  }
  /** Facing towards aircraft approaching this end. */
  get toApproach(): number {
    return wrap360(this.end.heading + 180);
  }
}

export class AirportScenery {
  readonly group = new THREE.Group();
  readonly towerTop: THREE.Vector3 | null;
  private readonly textures: THREE.Texture[] = [];
  private readonly materials: THREE.Material[] = [];
  private readonly geometries: THREE.BufferGeometry[] = [];

  constructor(readonly airport: Airport, readonly world: WorldData, private readonly ground: GroundSampler) {
    const m = mats();
    const pave = new Quads(ground);
    const conc = new Quads(ground);
    const turf = new Quads(ground);
    const white = new Quads(ground);
    const yellow = new Quads(ground);
    const lights = new LightBatch();
    const lit = airport.runways.some((r) => r.raw.lighting);

    for (const rw of airport.runways) {
      if (/^H/.test(rw.id) || rw.raw.surface.includes('WATER')) continue;
      if (!rw.paved) {
        turf.rect(rw.cx, rw.cz, rw.heading, rw.lengthM, rw.widthM, 0.08);
        continue;
      }
      (rw.raw.surface.includes('CONC') ? conc : pave).rect(rw.cx, rw.cz, rw.heading, rw.lengthM, rw.widthM, 0.12, 50);
      this.markRunway(rw, white);
      if (rw.raw.lighting) this.lightRunway(rw, lights);
    }

    // Taxiways, aprons, hold lines and taxiway lights.
    const layout = airportLayout(airport);
    for (const p of layout.pavements) {
      const target = p.kind === 'apron' ? conc : pave;
      target.rect(p.x, p.z, p.heading, p.length + (p.kind === 'taxiway' ? p.width : 0), p.width, p.kind === 'apron' ? 0.09 : 0.1, 50);
      if (p.kind !== 'taxiway') continue;
      yellow.rect(p.x, p.z, p.heading, p.length, 0.35, 0.16);
      const d = dirOf(p.heading);
      const rx = -d[2];
      const rz = d[0];
      if (lit) {
        for (let a = -p.length / 2; a <= p.length / 2; a += 50) {
          for (const side of [-1, 1]) {
            const x = p.x + d[0] * a + rx * (p.width / 2 + 1) * side;
            const z = p.z + d[2] * a + rz * (p.width / 2 + 1) * side;
            lights.add(x, ground.at(x, z) + 0.4, z, { color: BLUE, size: 4, day: 0.04 });
          }
        }
      }
      // Hold-short markings and runway guard lights where a connector meets a runway.
      for (const rw of airport.runways) {
        const { along, across } = rw.local(p.x, p.z);
        const perpendicular = Math.abs(Math.cos((p.heading - rw.heading) * DEG)) < 0.2;
        if (!perpendicular || Math.abs(along) > rw.lengthM / 2 || Math.abs(across) > p.length / 2 + rw.widthM) continue;
        const hold = Math.min(rw.lengthM > 1800 ? 85 : 60, Math.abs(across) + p.length / 2 - 5);
        const rd = dirOf(rw.heading);
        const sgn = Math.sign(across) || 1;
        const hx = rw.cx + rd[0] * along + -rd[2] * hold * sgn;
        const hz = rw.cz + rd[2] * along + rd[0] * hold * sgn;
        for (let k = 0; k < 4; k++) {
          const off = (k - 1.5) * 0.6 * sgn;
          yellow.rect(hx + -rd[2] * off, hz + rd[0] * off, rw.heading, p.width - 1, 0.3, 0.17, 0, 200);
        }
        if (lit) {
          for (const side of [-1, 1]) {
            const x = hx + rd[0] * (p.width / 2 + 2) * side;
            const z = hz + rd[2] * (p.width / 2 + 2) * side;
            lights.add(x, ground.at(x, z) + 0.8, z, {
              color: YELLOW, facing: wrap360(rw.heading + 90 * sgn), beam: 60, fx: FX.REIL, param: side > 0 ? 0 : 0.5, size: 6, day: 0.5,
            });
          }
        }
      }
    }

    for (const b of layout.buildings) this.addBuilding(b, lights);
    this.towerTop = layout.tower ? new THREE.Vector3(layout.tower.x, ground.at(layout.tower.x, layout.tower.z) + layout.tower.height + 2, layout.tower.z) : null;

    // Rotating beacon (white/green for a land airport) at lit airports.
    if (lit) {
      const bp = this.towerTop ?? new THREE.Vector3(airport.x, ground.at(airport.x, airport.z) + 25, airport.z);
      lights.add(bp.x, bp.y + 4, bp.z, { color: WHITE, fx: FX.BEACON, param: 0, size: 11, day: 0.05 });
      lights.add(bp.x, bp.y + 4, bp.z, { color: GREEN, fx: FX.BEACON, param: 0.5, size: 11, day: 0.05 });
    }

    const add = (q: Quads, mat: THREE.Material, order: number) => {
      if (q.empty) return;
      const geo = q.build();
      this.geometries.push(geo);
      const mesh = new THREE.Mesh(geo, mat);
      mesh.receiveShadow = true;
      mesh.renderOrder = order;
      mesh.matrixAutoUpdate = false;
      this.group.add(mesh);
    };
    add(turf, m.turf, 0);
    add(conc, m.concrete, 1);
    add(pave, m.asphalt, 1);
    add(white, m.white, 2);
    add(yellow, m.yellow, 2);
    const pts = lights.build();
    if (pts) {
      this.geometries.push(pts.geometry);
      this.group.add(pts);
    }
  }

  // --------------------------------------------------------------- markings

  private markRunway(rw: Runway, q: Quads): void {
    const W = rw.widthM;
    const cls = Math.max(markClass(rw.ends[0]), markClass(rw.ends[1])) as MarkClass;
    if (cls === 0) return;
    const L = rw.lengthM;
    const lift = 0.2;
    // Centreline: 120 ft stripes, 80 ft gaps, between the designation areas.
    const clW = cls === 3 ? 0.9 : cls === 2 ? 0.6 : 0.45;
    const e0 = rw.ends[0];
    const start = e0.displacedM + 125;
    const end = L - rw.ends[1].displacedM - 125;
    const d = dirOf(rw.heading);
    const x0 = rw.cx - d[0] * (L / 2);
    const z0 = rw.cz - d[2] * (L / 2);
    for (let s = start; s + 36.6 <= end; s += 61) {
      q.rect(x0 + d[0] * (s + 18.3), z0 + d[2] * (s + 18.3), rw.heading, 36.6, clW, lift);
    }
    // Side stripes on precision runways.
    if (cls === 3) {
      const len = L - e0.displacedM - rw.ends[1].displacedM;
      const mid = e0.displacedM + len / 2;
      for (const side of [-1, 1]) {
        const off = (W / 2 - 1.2) * side;
        q.rect(x0 + d[0] * mid - d[2] * off, z0 + d[2] * mid + d[0] * off, rw.heading, len, 0.9, lift, 0, 200);
      }
    }
    for (const e of rw.ends) this.markEnd(e, q, lift);
  }

  private markEnd(e: RunwayEnd, q: Quads, lift: number): void {
    const f = new EndFrame(e);
    const rw = e.runway;
    const W = rw.widthM;
    const cls = markClass(e);
    const h = e.heading;
    const put = (along: number, across: number, len: number, wid: number) => {
      const [x, z] = f.at(along, across);
      q.rect(x, z, h, len, wid, lift);
    };
    if (cls === 0) return;
    // Displaced threshold: 10 ft bar across the runway and arrows in the displaced area.
    if (e.displacedM > 20) {
      put(-1.5, 0, 3, W);
      for (let s = 20; s < e.displacedM - 15; s += 61) {
        const tip = -s;
        put(tip - 18, 0, 36, 0.9);
        for (const side of [-1, 1]) {
          const [x, z] = f.at(tip - 3.4, side * 2.1);
          q.rect(x, z, wrap360(h - side * 32), 8, 0.9, lift);
        }
      }
    }
    if (cls >= 2) {
      // Threshold stripes: 150 ft x 5.75 ft, starting 20 ft past the threshold.
      const n = thresholdStripes(rw.raw.widthFt) / 2;
      for (let k = 0; k < n; k++) {
        const fromEdge = (5 + 5.75 / 2 + k * 11.5) * FT;
        for (const side of [-1, 1]) put(6.1 + 22.85, side * (W / 2 - fromEdge), 45.7, 1.75);
      }
    }
    // Designation: 60 ft characters, number further down the runway than the letter.
    const dLen = Math.min(42, W * 1.2);
    const dWid = Math.min(18, W * 0.5);
    const dAt = (cls >= 2 ? 58 : 6) + dLen / 2;
    const tex = designationTexture(e.id);
    this.textures.push(tex);
    const dq = new Quads(this.ground);
    const [dx, dz] = f.at(dAt, 0);
    dq.rect(dx, dz, h, dLen, dWid, lift + 0.01);
    const geo = dq.build();
    this.geometries.push(geo);
    const mat = new THREE.MeshLambertMaterial({ map: tex, transparent: true, depthWrite: false });
    this.materials.push(mat);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.renderOrder = 3;
    this.group.add(mesh);
    const avail = rw.lengthM - e.displacedM - e.opposite.displacedM;
    const inner = Math.min(11, W * 0.24);
    // Aiming point: 150 ft x 30 ft bars starting 1000 ft from the threshold.
    if (cls >= 2 && avail >= 1280) {
      for (const side of [-1, 1]) put(305 + 22.85, side * (inner + 4.55), 45.7, 9.1);
    }
    // Touchdown-zone bars on precision runways: 3-2-2-1-1 pattern at 500 ft spacing.
    if (cls === 3) {
      const pattern: [number, number][] = [[500, 3], [1500, 2], [2000, 2], [2500, 1], [3000, 1]];
      for (const [ft, bars] of pattern) {
        const along = ft * FT;
        if (along > avail / 2 - 60) break;
        for (let k = 0; k < bars; k++) {
          for (const side of [-1, 1]) put(along + 11.4, side * (inner + 0.9 + k * 3.35), 22.9, 1.83);
        }
      }
    }
  }

  // --------------------------------------------------------------- lighting

  private lightRunway(rw: Runway, lights: LightBatch): void {
    const g = this.ground;
    const W = rw.widthM;
    const L = rw.lengthM;
    const [e0, e1] = rw.ends;
    const instrument = !!(e0.ils || e1.ils || markClass(e0) >= 2 || markClass(e1) >= 2);
    const intensity = rw.raw.lighting === 'HIGH' ? 1 : rw.raw.lighting === 'MEDIUM' ? 0.8 : 0.6;
    const d = dirOf(rw.heading);
    const x0 = rw.cx - d[0] * (L / 2);
    const z0 = rw.cz - d[2] * (L / 2);
    const pt = (s: number, across: number): [number, number, number] => {
      const x = x0 + d[0] * s - d[2] * across;
      const z = z0 + d[2] * s + d[0] * across;
      return [x, g.at(x, z), z];
    };
    const face0 = wrap360(e0.heading + 180);
    // Edge lights every 200 ft; the last 2000 ft show yellow, displaced areas red to landing traffic.
    const nEdge = Math.max(2, Math.round(L / 61));
    for (let k = 0; k <= nEdge; k++) {
      const s = (k / nEdge) * L;
      const c0: RGB = s < e0.displacedM ? RED : instrument && L - s < 610 ? YELLOW : WHITE;
      const c1: RGB = L - s < e1.displacedM ? RED : instrument && s < 610 ? YELLOW : WHITE;
      for (const side of [-1, 1]) {
        const [x, y, z] = pt(s, side * (W / 2 + 1.5));
        lights.add(x, y + 0.45, z, { color: c0, back: c1, facing: face0, beam: 90, size: 5.5 * intensity, day: 0.1 });
      }
    }
    // Centreline lights every 50 ft: red/white alternating 3000-1000 ft from the end, red the last 1000 ft.
    if (e0.raw.cl || e1.raw.cl) {
      const sA = e0.displacedM;
      const sB = L - e1.displacedM;
      let k = 0;
      for (let s = sA + 7.6; s < sB; s += 15.24, k++) {
        const col = (remaining: number): RGB => (remaining < 305 ? RED : remaining < 914 ? (k % 2 ? RED : WHITE) : WHITE);
        const [x, y, z] = pt(s, 0.6);
        lights.add(x, y + 0.2, z, { color: col(sB - s), back: col(s - sA), facing: face0, beam: 90, size: 4, day: 0.08 });
      }
    }
    for (const e of rw.ends) this.lightEnd(e, lights);
  }

  private lightEnd(e: RunwayEnd, lights: LightBatch): void {
    const g = this.ground;
    const f = new EndFrame(e);
    const W = e.runway.widthM;
    const face = f.toApproach;
    const add = (along: number, across: number, lift: number, spec: Parameters<LightBatch['add']>[3]) => {
      const [x, z] = f.at(along, across);
      lights.add(x, g.at(x, z) + lift, z, spec);
    };
    // Threshold (green towards the approach) and runway end (red towards the runway).
    const nT = Math.max(4, Math.round(W / 3.05));
    for (let k = 0; k <= nT; k++) {
      const a = (k / nT - 0.5) * W;
      if (e.displacedM > 20) {
        add(0, a, 0.4, { color: GREEN, facing: face, beam: 80, size: 6, day: 0.15 });
        add(-e.displacedM, a, 0.4, { color: OFF, back: RED, facing: face, beam: 90, size: 5, day: 0.1 });
      } else {
        add(0, a, 0.4, { color: GREEN, back: RED, facing: face, beam: 90, size: 6, day: 0.15 });
      }
    }
    if (e.displacedM > 20 || e.raw.als) {
      // Threshold wing bars outboard of the edges.
      for (const side of [-1, 1]) for (let k = 1; k <= 5; k++) add(0, side * (W / 2 + k * 3), 0.4, { color: GREEN, facing: face, beam: 80, size: 6, day: 0.15 });
    }
    // Touchdown-zone lights: barrettes of three from 100 ft to 3000 ft.
    if (e.raw.tdz) {
      for (let ft = 100; ft <= 3000; ft += 100) {
        for (const side of [-1, 1]) {
          for (let k = 0; k < 3; k++) add(ft * FT, side * (11 + k * 1.52), 0.15, { color: WHITE, facing: face, beam: 75, size: 4.5, day: 0.15 });
        }
      }
    }
    // Runway end identifier lights.
    if (e.raw.reil) {
      for (const side of [-1, 1]) add(-3, side * (W / 2 + 12), 1, { color: WHITE, facing: face, beam: 30, fx: FX.REIL, size: 11, day: 0.8 });
    }
    this.approachLights(e, f, lights);
    this.vgsi(e, f, lights);
  }

  private approachLights(e: RunwayEnd, f: EndFrame, lights: LightBatch): void {
    const als = e.raw.als;
    if (!als) return;
    const g = this.ground;
    const face = f.toApproach;
    const elev = e.elevM;
    const add = (distFt: number, acrossFt: number, spec: Parameters<LightBatch['add']>[3]) => {
      const [x, z] = f.at(-distFt * FT, acrossFt * FT);
      lights.add(x, Math.max(elev + 0.6, g.at(x, z) + 1.2), z, { beam: 40, day: 0.6, size: 6.5, facing: face, ...spec });
    };
    const barrette = (distFt: number, color: RGB = WHITE) => {
      for (let k = -2; k <= 2; k++) add(distFt, k * 3.5, { color });
    };
    const crossbar = (distFt: number, halfFt: number) => {
      for (let a = 10; a <= halfFt; a += 5) for (const s of [-1, 1]) add(distFt, s * a, { color: WHITE });
    };
    const flashers = (dists: number[]) => {
      const sorted = [...dists].sort((a, b) => b - a);
      sorted.forEach((ft, i) => add(ft, 0, { color: WHITE, fx: FX.SEQUENCED, param: i / sorted.length, size: 12, day: 0.9, beam: 30 }));
    };
    const range = (a: number, b: number, step: number) => {
      const out: number[] = [];
      for (let v = a; v <= b + 1e-6; v += step) out.push(v);
      return out;
    };
    switch (als) {
      case 'ALSF2':
        range(100, 2400, 100).forEach((ft) => barrette(ft));
        crossbar(500, 25);
        crossbar(1000, 50);
        for (const ft of range(100, 1000, 100)) for (const s of [-1, 1]) for (let k = 0; k < 3; k++) add(ft, s * (37.5 + k * 5), { color: RED });
        flashers(range(1000, 2400, 100));
        break;
      case 'ALSF1':
        range(100, 2400, 100).forEach((ft) => barrette(ft));
        crossbar(1000, 50);
        for (const s of [-1, 1]) for (let k = 0; k < 3; k++) add(100, s * (25 + k * 5), { color: RED });
        flashers(range(1000, 2400, 100));
        break;
      case 'MALSR':
      case 'MALS':
      case 'MALSF':
        range(200, 1400, 200).forEach((ft) => barrette(ft));
        crossbar(1000, 33);
        if (als === 'MALSR') flashers(range(1600, 2400, 200));
        if (als === 'MALSF') flashers([1000, 1200, 1400]);
        break;
      case 'ODALS': {
        const seq = [1500, 1200, 900, 600, 300];
        seq.forEach((ft, i) => add(ft, 0, { color: WHITE, fx: FX.SEQUENCED, param: i / 7, size: 12, day: 0.9 }));
        for (const s of [-1, 1]) add(0, s * (e.runway.raw.widthFt / 2 + 40), { color: WHITE, fx: FX.SEQUENCED, param: 5 / 7, size: 12, day: 0.9 });
        break;
      }
      case 'RLLS':
        for (let grp = 0; grp < 4; grp++) for (let k = 0; k < 3; k++) {
          add(4500 - grp * 1000 - k * 100, 0, { color: WHITE, fx: FX.SEQUENCED, param: (grp * 3 + k) / 12, size: 11, day: 0.9 });
        }
        break;
      default:
        range(200, 1400, 200).forEach((ft) => barrette(ft));
    }
  }

  private vgsi(e: RunwayEnd, f: EndFrame, lights: LightBatch): void {
    const v = e.raw.vgsi;
    if (!v) return;
    const g = this.ground;
    const W = e.runway.widthM;
    const face = f.toApproach;
    const gpa = e.gpa;
    const side = /R$/.test(v) ? 1 : -1;
    const boxes: [number, number][] = [];
    const unit = (along: number, fromEdge: number, angle: number) => {
      const across = side * (W / 2 + fromEdge);
      const [x, z] = f.at(along, across);
      lights.add(x, g.at(x, z) + 0.9, z, { color: WHITE, facing: face, beam: 25, fx: FX.PAPI, param: angle, size: 9, day: 0.95 });
      boxes.push([x, z]);
    };
    if (v.startsWith('PAPI')) {
      const along = Math.max(150, e.gsOffset);
      const n = v.includes('-2') ? 2 : 4;
      const angles = n === 4 ? [gpa + 0.5, gpa + 0.17, gpa - 0.17, gpa - 0.5] : [gpa + 0.25, gpa - 0.25];
      angles.forEach((a, k) => unit(along, 15 + k * 9, a));
    } else if (v.startsWith('VASI')) {
      const n = v.includes('-4') ? 2 : 1;
      for (let k = 0; k < n; k++) {
        unit(180, 15 + k * 9, gpa - 0.5);
        unit(390, 15 + k * 9, gpa + 0.5);
      }
    }
    const geo = new THREE.BoxGeometry(1.2, 0.8, 1.2);
    this.geometries.push(geo);
    const m = mats();
    for (const [x, z] of boxes) {
      const b = new THREE.Mesh(geo, m.box);
      b.position.set(x, g.at(x, z) + 0.4, z);
      b.rotation.y = (90 - e.heading) * DEG;
      this.group.add(b);
    }
  }

  // --------------------------------------------------------------- buildings

  private addBuilding(b: Building, lights: LightBatch): void {
    const m = mats();
    const y0 = this.ground.at(b.x, b.z) - 1;
    const rot = (90 - b.heading) * DEG;
    if (b.kind === 'tower') {
      const shaft = new THREE.Mesh(new THREE.CylinderGeometry(3.5, 4.5, b.height, 12), m.wall);
      shaft.position.set(b.x, y0 + b.height / 2, b.z);
      const cab = new THREE.Mesh(new THREE.CylinderGeometry(8, 6.5, 7, 12), m.glass);
      cab.position.set(b.x, y0 + b.height + 3.5, b.z);
      const cap = new THREE.Mesh(new THREE.CylinderGeometry(8.6, 8.6, 1.4, 12), m.roof);
      cap.position.set(b.x, y0 + b.height + 7.6, b.z);
      for (const o of [shaft, cab, cap]) {
        this.geometries.push(o.geometry);
        this.group.add(o);
      }
      lights.add(b.x, y0 + b.height + 9.5, b.z, { color: RED, fx: FX.OBSTRUCTION, param: 0, size: 6, day: 0.3 });
      return;
    }
    let geo: THREE.BufferGeometry;
    if (b.arc) {
      // Half-ring terminal (DFW style): extrude a half annulus and stand it up.
      const r1 = b.arc;
      const r0 = r1 - b.width;
      const s = new THREE.Shape();
      s.absarc(0, 0, r1, -Math.PI / 2, Math.PI / 2, false);
      s.absarc(0, 0, r0, Math.PI / 2, -Math.PI / 2, true);
      geo = new THREE.ExtrudeGeometry(s, { depth: b.height, bevelEnabled: false, curveSegments: 24 });
      geo.rotateX(-Math.PI / 2);
    } else {
      geo = new THREE.BoxGeometry(b.length, b.height, b.width);
      geo.translate(0, b.height / 2, 0);
    }
    this.geometries.push(geo);
    const mesh = new THREE.Mesh(geo, b.kind === 'terminal' ? m.glass : m.wall);
    mesh.position.set(b.x, y0, b.z);
    mesh.rotation.y = rot;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    this.group.add(mesh);
    // Roof slab.
    if (!b.arc) {
      const roof = new THREE.Mesh(new THREE.BoxGeometry(b.length + 2, 1.2, b.width + 2), m.roof);
      roof.position.set(b.x, y0 + b.height + 0.6, b.z);
      roof.rotation.y = rot;
      this.geometries.push(roof.geometry);
      this.group.add(roof);
    }
    // Apron flood lights along the airside face.
    const d = dirOf(b.heading);
    const n = Math.max(2, Math.round(b.length / 120));
    for (let k = 0; k < n; k++) {
      const t = k / (n - 1) - 0.5;
      // Along / across the building's frame: around the outside of a half ring, or along a straight face.
      const [a, c] = b.arc ? [(b.arc + 60) * Math.cos(t * Math.PI), (b.arc + 60) * Math.sin(t * Math.PI)] : [t * b.length * 0.9, b.width / 2 + 25];
      const x = b.x + d[0] * a - d[2] * c;
      const z = b.z + d[2] * a + d[0] * c;
      lights.add(x, this.ground.at(x, z) + 24, z, { color: [1, 0.82, 0.55], size: 8, day: 0 });
    }
  }

  dispose(): void {
    for (const g of this.geometries) g.dispose();
    for (const t of this.textures) t.dispose();
    for (const m of this.materials) m.dispose();
  }
}

/** Streams airport scenery in and out around the camera. */
export class AirportManager {
  private loaded = new Map<string, AirportScenery>();
  private timer = 0;
  private queue: Airport[] = [];
  readonly ground: GroundSampler;

  constructor(readonly scene: THREE.Scene, readonly world: WorldData, readonly radius = 45000) {
    this.ground = new GroundSampler(world);
  }

  update(dt: number, camPos: THREE.Vector3, budgetMs = 6): void {
    this.timer -= dt;
    if (this.timer <= 0) {
      this.timer = 2;
      const want = this.world.nav.airportsNear(camPos.x, camPos.z, this.radius)
        .sort((a, b) => Math.hypot(a.x - camPos.x, a.z - camPos.z) - Math.hypot(b.x - camPos.x, b.z - camPos.z));
      const ids = new Set(want.map((a) => a.id));
      for (const [k, s] of this.loaded) {
        if (!ids.has(k)) {
          this.scene.remove(s.group);
          s.dispose();
          this.loaded.delete(k);
        }
      }
      this.queue = want.filter((a) => !this.loaded.has(a.id));
      this.ground.clear();
    }
    const t0 = performance.now();
    while (this.queue.length && performance.now() - t0 < budgetMs) {
      const a = this.queue.shift()!;
      const s = new AirportScenery(a, this.world, this.ground);
      this.scene.add(s.group);
      this.loaded.set(a.id, s);
    }
  }

  /** Build everything in range immediately (before the first frame). */
  prime(camPos: THREE.Vector3): void {
    this.timer = 0;
    this.update(0, camPos, 1e9);
  }

  towerFor(x: number, z: number): THREE.Vector3 | null {
    let best: THREE.Vector3 | null = null;
    let bd = Infinity;
    for (const s of this.loaded.values()) {
      if (!s.towerTop) continue;
      const d = Math.hypot(s.towerTop.x - x, s.towerTop.z - z);
      if (d < bd) {
        bd = d;
        best = s.towerTop;
      }
    }
    return best;
  }

  get count(): number {
    return this.loaded.size;
  }
}
