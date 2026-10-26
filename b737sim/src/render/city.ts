// Buildings: generic blocks wherever ESA WorldCover marks the ground as built-up (streamed in
// tiles around the camera), plus the real skylines of downtown Dallas and Fort Worth, Las
// Colinas and the Arlington stadiums so the view out of DFW matches the real horizon.
import * as THREE from 'three';
import { DEG, mulberry, hash2 } from '../core/math.ts';
import { LC, type WorldData } from '../world/worldData.ts';
import type { GroundSampler } from './airports.ts';
import { LightBatch, FX, RED, WHITE, type RGB } from './lights.ts';

const TILE = 1500;
const RADIUS = 7000;
const STEP = 42;
/** Downtown cores where generic buildings get taller: [lat, lon, radius m, max height m]. */
const CORES: [number, number, number, number][] = [
  [32.781, -96.8, 2600, 90], // Dallas
  [32.754, -97.331, 1800, 70], // Fort Worth
  [32.873, -96.94, 1500, 60], // Las Colinas
  [32.736, -97.108, 1600, 30], // Arlington
  [32.925, -96.82, 1500, 40], // Galleria / LBJ
  [33.08, -96.82, 2000, 45], // Legacy, Plano
];

/** Notable towers: [name, lat, lon, height m, footprint w x d m, shape]. Positions approximate. */
type Shape = 'box' | 'prism' | 'reunion' | 'stadium' | 'ballpark' | 'spire';
const LANDMARKS: [string, number, number, number, number, number, Shape, number?][] = [
  ['Bank of America Plaza', 32.779, -96.803, 281, 48, 48, 'box', 0x3d5a55],
  ['Renaissance Tower', 32.7826, -96.8003, 270, 42, 42, 'spire', 0x6c7f8c],
  ['Comerica Bank Tower', 32.7837, -96.7988, 239, 46, 40, 'box', 0x8f8a80],
  ['JPMorgan Chase Tower', 32.7856, -96.7987, 224, 44, 44, 'box', 0x7b8794],
  ['Fountain Place', 32.784, -96.8031, 220, 56, 56, 'prism', 0x5a7d7a],
  ['Thanksgiving Tower', 32.783, -96.8014, 196, 40, 40, 'box', 0x6a6f78],
  ['Energy Plaza', 32.7841, -96.7963, 191, 40, 40, 'box', 0x8a8f96],
  ['Trammell Crow Center', 32.7887, -96.8009, 209, 42, 42, 'box', 0xb3a68f],
  ['Santander Tower', 32.7811, -96.7979, 180, 38, 38, 'box', 0x8b929a],
  ['Ross Tower', 32.7874, -96.7985, 150, 36, 36, 'box', 0x8a7b6a],
  ['Reunion Tower', 32.7755, -96.8089, 171, 30, 30, 'reunion'],
  ['Burnett Plaza', 32.7518, -97.3317, 172, 44, 44, 'box', 0x5d6873],
  ['Wells Fargo Tower', 32.7535, -97.3305, 165, 40, 40, 'box', 0x6f7c88],
  ['Frost Tower', 32.7547, -97.3296, 141, 36, 36, 'box', 0x7d8a96],
  ['City Center Tower II', 32.7557, -97.332, 167, 40, 36, 'box', 0x4f5a66],
  ['Omni Fort Worth', 32.7494, -97.3274, 117, 40, 36, 'box', 0x8c8478],
  ['Williams Square', 32.8723, -96.9389, 110, 50, 30, 'box', 0x6b6e70],
  ['Texas Commerce Tower Las Colinas', 32.8741, -96.9421, 130, 36, 36, 'box', 0x7a8592],
  ['AT&T Stadium', 32.7473, -97.0945, 75, 280, 230, 'stadium'],
  ['Globe Life Field', 32.7473, -97.0847, 70, 210, 210, 'ballpark'],
];

const BUILD_VS_EXTRA = /* glsl */ `
varying vec3 vCityWorld;
varying vec3 vCityNormal;`;

/** Lambert material with night-time lit windows on walls (by world position, no textures). */
function cityMaterial(night: { value: number }): THREE.MeshLambertMaterial {
  const m = new THREE.MeshLambertMaterial({ color: 0xffffff });
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uNight = night;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>' + BUILD_VS_EXTRA)
      .replace('#include <project_vertex>', `#include <project_vertex>
#ifdef USE_INSTANCING
  vCityWorld = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).xyz;
  vCityNormal = normalize(mat3(modelMatrix * instanceMatrix) * objectNormal);
#else
  vCityWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;
  vCityNormal = normalize(mat3(modelMatrix) * objectNormal);
#endif`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
uniform float uNight;
varying vec3 vCityWorld;
varying vec3 vCityNormal;
float cityHash(vec2 p) { p = fract(p * vec2(234.34, 435.345)); p += dot(p, p + 34.23); return fract(p.x * p.y); }`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
  if (uNight > 0.01 && abs(vCityNormal.y) < 0.5) {
    vec2 cell = vec2(floor((vCityWorld.x + vCityWorld.z) / 3.2), floor(vCityWorld.y / 3.6));
    vec2 f = fract(vec2((vCityWorld.x + vCityWorld.z) / 3.2, vCityWorld.y / 3.6));
    float win = step(0.62, cityHash(cell)) * step(0.15, f.x) * step(f.x, 0.85) * step(0.25, f.y) * step(f.y, 0.8);
    totalEmissiveRadiance += vec3(1.0, 0.78, 0.48) * win * uNight * 0.9;
  }`);
  };
  return m;
}

interface Tile {
  mesh: THREE.InstancedMesh | null;
  lights: THREE.Points | null;
}

export class CityView {
  readonly group = new THREE.Group();
  private readonly night = { value: 0 };
  private readonly material: THREE.MeshLambertMaterial;
  private readonly box: THREE.BufferGeometry;
  private tiles = new Map<string, Tile>();
  private queue: [number, number][] = [];
  private center: string | null = null;
  private readonly cores: { x: number; z: number; r: number; h: number }[];
  private readonly exclusions: { x0: number; x1: number; z0: number; z1: number }[];
  readonly landmarks = new THREE.Group();
  private readonly landmarkMats: THREE.Material[] = [];

  constructor(readonly scene: THREE.Scene, readonly world: WorldData, private readonly ground: GroundSampler) {
    this.material = cityMaterial(this.night);
    this.box = new THREE.BoxGeometry(1, 1, 1);
    this.box.translate(0, 0.5, 0);
    this.cores = CORES.map(([lat, lon, r, h]) => {
      const [x, z] = world.proj.toLocal(lat, lon);
      return { x, z, r, h };
    });
    // Keep generic buildings off airport property: the box around each airport's runways.
    this.exclusions = world.nav.airports.filter((a) => a.longest > 600).map((a) => {
      const xs = a.ends.map((e) => e.x);
      const zs = a.ends.map((e) => e.z);
      const m = a.longest > 2500 ? 500 : 250;
      return { x0: Math.min(...xs) - m, x1: Math.max(...xs) + m, z0: Math.min(...zs) - m, z1: Math.max(...zs) + m };
    });
    scene.add(this.group, this.landmarks);
    this.buildLandmarks();
  }

  private excluded(x: number, z: number): boolean {
    for (const e of this.exclusions) if (x > e.x0 && x < e.x1 && z > e.z0 && z < e.z1) return true;
    return false;
  }

  private buildTile(ti: number, tj: number): Tile {
    const W = this.world;
    const rnd = mulberry(ti * 92821 + tj * 68917 + 7);
    const mats: THREE.Matrix4[] = [];
    const cols: THREE.Color[] = [];
    const lights = new LightBatch();
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    const x0 = ti * TILE;
    const z0 = tj * TILE;
    const n = TILE / STEP;
    // Street-grid orientation per neighbourhood (most DFW suburbs are on a north-south grid).
    const gridRot = (hash2(Math.floor(x0 / 4000), Math.floor(z0 / 4000)) - 0.5) * 30 * DEG;
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const x = x0 + (i + 0.2 + rnd() * 0.6) * STEP;
        const z = z0 + (j + 0.2 + rnd() * 0.6) * STEP;
        if (W.landClass(x, z) !== LC.BUILT) continue;
        if (this.excluded(x, z)) continue;
        let core = 0;
        let coreH = 0;
        for (const c of this.cores) {
          const d = Math.hypot(x - c.x, z - c.z);
          const w = Math.max(0, 1 - d / c.r);
          if (w > core) {
            core = w;
            coreH = c.h;
          }
        }
        if (rnd() > 0.42 + core * 0.4) continue;
        let h = 4 + rnd() * 6;
        let w = 12 + rnd() * 14;
        let l = 14 + rnd() * 22;
        if (rnd() < 0.06 + core * 0.25) {
          // Offices, apartments, warehouses.
          h = 10 + rnd() * 18;
          w = 25 + rnd() * 30;
          l = 25 + rnd() * 45;
        }
        if (core > 0 && rnd() < core * core * 0.7) {
          h = 20 + Math.pow(rnd(), 1.6) * coreH * (0.4 + core);
          w = 22 + rnd() * 18;
          l = w * (0.8 + rnd() * 0.6);
        }
        const gy = this.ground.at(x, z);
        q.setFromAxisAngle(up, gridRot + (rnd() < 0.15 ? Math.PI / 4 : 0));
        mats.push(new THREE.Matrix4().compose(new THREE.Vector3(x, gy - 1.5, z), q, new THREE.Vector3(w, h + 1.5, l)));
        const shade = 0.5 + rnd() * 0.38;
        const warm = rnd();
        cols.push(new THREE.Color().setRGB(shade * (0.98 + warm * 0.06), shade * (0.95 + warm * 0.03), shade * (0.9 - warm * 0.04)));
        if (h > 45) lights.add(x, gy + h + 1, z, { color: RED, fx: FX.OBSTRUCTION, param: rnd(), size: 4, day: 0.2 });
        else if (rnd() < 0.25) lights.add(x + w * 0.6, gy + 6, z, { color: [1, 0.72, 0.38], size: 2.5, day: 0 });
      }
    }
    let mesh: THREE.InstancedMesh | null = null;
    if (mats.length) {
      mesh = new THREE.InstancedMesh(this.box, this.material, mats.length);
      mats.forEach((m, k) => {
        mesh!.setMatrixAt(k, m);
        mesh!.setColorAt(k, cols[k]);
      });
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      mesh.computeBoundingSphere();
      mesh.receiveShadow = true;
      this.group.add(mesh);
    }
    const pts = lights.build();
    if (pts) this.group.add(pts);
    return { mesh, lights: pts };
  }

  private buildLandmarks(): void {
    const lights = new LightBatch();
    const glass = (hex: number) => {
      const m = new THREE.MeshPhongMaterial({ color: hex, shininess: 70, specular: 0x667788 });
      this.landmarkMats.push(m);
      return m;
    };
    const concrete = new THREE.MeshLambertMaterial({ color: 0xc9c4ba });
    const roofWhite = new THREE.MeshPhongMaterial({ color: 0xe6e8ea, shininess: 40, specular: 0x444444 });
    this.landmarkMats.push(concrete, roofWhite);
    const outline = (x: number, y0: number, z: number, w: number, d: number, h: number, color: RGB, step = 6) => {
      // Edge outline lights (e.g. Bank of America Plaza's green argon outline).
      for (let y = y0; y <= y0 + h; y += step) {
        for (const [sx, sz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) lights.add(x + sx * w / 2, y, z + sz * d / 2, { color, size: 3.5, day: 0 });
      }
      for (let a = -w / 2; a <= w / 2; a += step) for (const sz of [-1, 1]) lights.add(x + a, y0 + h, z + sz * d / 2, { color, size: 3.5, day: 0 });
    };
    for (const [name, lat, lon, h, w, d, shape, color] of LANDMARKS) {
      const [x, z] = this.world.proj.toLocal(lat, lon);
      const gy = this.ground.at(x, z) - 1;
      let obj: THREE.Object3D;
      switch (shape) {
        case 'prism': {
          const g = new THREE.CylinderGeometry(w * 0.12, w * 0.72, h, 4, 1);
          g.translate(0, h / 2, 0);
          obj = new THREE.Mesh(g, glass(color ?? 0x667788));
          obj.rotation.y = Math.PI / 4;
          break;
        }
        case 'spire': {
          const grp = new THREE.Group();
          const body = new THREE.Mesh(new THREE.BoxGeometry(w, h * 0.8, d).translate(0, h * 0.4, 0), glass(color ?? 0x667788));
          const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.6, 1.5, h * 0.2, 6).translate(0, h * 0.9, 0), concrete);
          grp.add(body, mast);
          obj = grp;
          outline(x, gy + h * 0.8, z, w, d, 0.1, [0.95, 0.95, 1], 4);
          break;
        }
        case 'reunion': {
          const grp = new THREE.Group();
          const shaft = new THREE.Mesh(new THREE.CylinderGeometry(4.5, 6.5, h - 18, 12).translate(0, (h - 18) / 2, 0), concrete);
          const ball = new THREE.Mesh(new THREE.SphereGeometry(15, 24, 16).translate(0, h - 10, 0), glass(0x8899aa));
          grp.add(shaft, ball);
          obj = grp;
          // The geodesic dome's lights.
          for (let k = 0; k < 160; k++) {
            const t = Math.acos(1 - (2 * (k + 0.5)) / 160);
            const p = k * 2.399963;
            if (Math.cos(t) < -0.3) continue;
            lights.add(x + 15.3 * Math.sin(t) * Math.cos(p), gy + h - 10 + 15.3 * Math.cos(t), z + 15.3 * Math.sin(t) * Math.sin(p), { color: WHITE, size: 2.6, day: 0 });
          }
          break;
        }
        case 'stadium': {
          const g = new THREE.SphereGeometry(1, 40, 14, 0, Math.PI * 2, 0, Math.PI / 2);
          const m = new THREE.Mesh(g, roofWhite);
          m.scale.set(w / 2, h, d / 2);
          m.rotation.y = 20 * DEG;
          obj = m;
          break;
        }
        case 'ballpark': {
          const g = new THREE.CylinderGeometry(w / 2, w / 2 + 6, h * 0.7, 32, 1);
          g.translate(0, h * 0.35, 0);
          const grp = new THREE.Group();
          grp.add(new THREE.Mesh(g, concrete));
          const roof = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 8, 0, Math.PI * 2, 0, Math.PI / 2), roofWhite);
          roof.scale.set(w / 2, h * 0.3, w / 2);
          roof.position.y = h * 0.7;
          grp.add(roof);
          obj = grp;
          break;
        }
        default: {
          obj = new THREE.Mesh(new THREE.BoxGeometry(w, h, d).translate(0, h / 2, 0), glass(color ?? 0x667788));
          if (name === 'Bank of America Plaza') outline(x, gy, z, w, d, h, [0.2, 1, 0.4]);
        }
      }
      obj.position.set(x, gy, z);
      obj.name = name;
      obj.traverse((o) => {
        if ((o as THREE.Mesh).isMesh) {
          o.castShadow = false;
          o.receiveShadow = true;
        }
      });
      this.landmarks.add(obj);
      if (h > 60) lights.add(x, gy + h + 2, z, { color: RED, fx: FX.OBSTRUCTION, param: (x * 0.013) % 1, size: 5, day: 0.25 });
    }
    const pts = lights.build();
    if (pts) this.landmarks.add(pts);
  }

  update(camPos: THREE.Vector3, night: number, budgetMs = 4): void {
    this.night.value = night;
    const ci = Math.floor(camPos.x / TILE);
    const cj = Math.floor(camPos.z / TILE);
    const high = camPos.y > 3600;
    const key = `${ci},${cj},${high}`;
    // Generic buildings only near the ground; above ~12,000 ft the land-cover texture carries the city.
    const r = high ? 0 : Math.ceil(RADIUS / TILE);
    if (key !== this.center) {
      this.center = key;
      const want = new Set<string>();
      const list: [number, number, number][] = [];
      for (let j = -r; j <= r; j++) {
        for (let i = -r; i <= r; i++) {
          if (Math.hypot(i, j) * TILE > RADIUS + TILE) continue;
          want.add(`${ci + i},${cj + j}`);
          list.push([ci + i, cj + j, Math.hypot(i, j)]);
        }
      }
      if (r === 0) want.clear();
      for (const [k, t] of this.tiles) {
        if (want.has(k)) continue;
        if (t.mesh) {
          this.group.remove(t.mesh);
          t.mesh.dispose();
        }
        if (t.lights) {
          this.group.remove(t.lights);
          t.lights.geometry.dispose();
        }
        this.tiles.delete(k);
      }
      this.queue = r === 0 ? [] : list.filter(([i, j]) => !this.tiles.has(`${i},${j}`)).sort((a, b) => a[2] - b[2]).map(([i, j]) => [i, j]);
    }
    const t0 = performance.now();
    while (this.queue.length && performance.now() - t0 < budgetMs) {
      const [i, j] = this.queue.shift()!;
      this.tiles.set(`${i},${j}`, this.buildTile(i, j));
    }
  }

  /** Re-evaluate the tile set even if the camera has not crossed a tile boundary (e.g. after climbing). */
  refresh(): void {
    this.center = null;
  }

  prime(camPos: THREE.Vector3): void {
    this.center = null;
    this.update(camPos, this.night.value, 1e9);
  }

  get count(): number {
    let n = 0;
    for (const t of this.tiles.values()) n += t.mesh?.count ?? 0;
    return n;
  }
}
