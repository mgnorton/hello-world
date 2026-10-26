// Scene setup: renderer, sky, sun & time of day, fog, LOD terrain tiles over the real DEM,
// textured in a shader from ESA WorldCover land-cover classes.
import * as THREE from 'three';
import { clamp, lerp, smoothstep, DEG } from '../core/math.ts';
import type { WorldData, GridMeta } from '../world/worldData.ts';

const FINE = 8000;
const FINE_R = 4;
const COARSE = 64000;
const COARSE_R = 3;
const COARSE_SEG = 32;
const lodFor = (ring: number): number => (ring <= 1 ? 64 : ring <= 2 ? 32 : 16);
/** Vertex spacing of the most detailed terrain tiles; airport surfaces are draped on this grid. */
export const GROUND_GRID = FINE / lodFor(0);

// Class colours (sRGB, late-October North Texas): none, tree, shrub, grass, crop, built, bare, snow, water, wetland, mangrove, moss.
const PALETTE: [number, number, number][] = [
  [0.45, 0.47, 0.3], [0.2, 0.27, 0.13], [0.42, 0.4, 0.26], [0.56, 0.53, 0.34], [0.5, 0.45, 0.3], [0.47, 0.46, 0.45],
  [0.62, 0.56, 0.44], [0.95, 0.95, 0.97], [0.1, 0.2, 0.28], [0.3, 0.36, 0.24], [0.2, 0.3, 0.2], [0.5, 0.5, 0.4],
];

function detailTexture(): THREE.Texture {
  const s = 256;
  const data = new Uint8Array(s * s * 4);
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const base = new Float32Array(s * s).map(() => rnd());
  for (let y = 0; y < s; y++) {
    for (let x = 0; x < s; x++) {
      let v = 0;
      let n = 0;
      for (let k = -2; k <= 2; k++) {
        v += base[((y + k + s) % s) * s + x] + base[y * s + ((x + k + s) % s)];
        n += 2;
      }
      const g = 200 + (v / n - 0.5) * 140 + (base[y * s + x] - 0.5) * 50;
      const i = (y * s + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = clamp(g, 0, 255);
      data[i + 3] = 255;
    }
  }
  const t = new THREE.DataTexture(data, s, s);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = 8;
  t.needsUpdate = true;
  return t;
}

function classTexture(meta: GridMeta, data: Uint8Array): THREE.DataTexture {
  const t = new THREE.DataTexture(data, meta.cols, meta.rows, THREE.RedFormat, THREE.UnsignedByteType);
  t.unpackAlignment = 1;
  t.magFilter = THREE.NearestFilter;
  t.minFilter = THREE.NearestFilter;
  t.generateMipmaps = false;
  t.needsUpdate = true;
  return t;
}

export class TerrainMaterial {
  readonly material: THREE.MeshLambertMaterial;
  readonly uniforms: Record<string, THREE.IUniform>;
  constructor(world: WorldData) {
    const p = world.proj;
    const lw = world.lcWide.meta;
    const lm = world.lcMetro.meta;
    this.uniforms = {
      uLcWide: { value: classTexture(lw, world.lcWide.data) },
      uLcMetro: { value: classTexture(lm, world.lcMetro.data) },
      uWide: { value: new THREE.Vector4(lw.west, lw.south, lw.step, 0) },
      uWideSize: { value: new THREE.Vector2(lw.cols, lw.rows) },
      uMetro: { value: new THREE.Vector4(lm.west, lm.south, lm.step, 0) },
      uMetroSize: { value: new THREE.Vector2(lm.cols, lm.rows) },
      uProj: { value: new THREE.Vector4(p.lat0, p.lon0, p.mPerDegLat, p.mPerDegLon) },
      uPalette: { value: PALETTE.map(([r, g, b]) => new THREE.Color().setRGB(r, g, b, THREE.SRGBColorSpace)) },
      uNight: { value: 0 },
      uSky: { value: new THREE.Color(0x8fb4d8) },
      uWet: { value: 0 },
    };
    const m = new THREE.MeshLambertMaterial({ map: detailTexture() });
    m.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, this.uniforms);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vWorld;')
        .replace('#include <project_vertex>', '#include <project_vertex>\nvWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>
varying vec3 vWorld;
uniform sampler2D uLcWide, uLcMetro;
uniform vec4 uWide, uMetro, uProj;
uniform vec2 uWideSize, uMetroSize;
uniform vec3 uPalette[12];
uniform float uNight, uWet;
uniform vec3 uSky;
float h21(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
int lcAt(vec2 ll, out float inMetro) {
  vec2 m = (ll - uMetro.xy) / uMetro.z;
  inMetro = 0.0;
  if (m.x >= 0.0 && m.y >= 0.0 && m.x < uMetroSize.x && m.y < uMetroSize.y) {
    inMetro = 1.0;
    return int(texelFetch(uLcMetro, ivec2(m), 0).r * 255.0 + 0.5);
  }
  vec2 w = clamp((ll - uWide.xy) / uWide.z, vec2(0.0), uWideSize - 1.0);
  return int(texelFetch(uLcWide, ivec2(w), 0).r * 255.0 + 0.5);
}
vec3 landColor(int c, vec2 xz) {
  vec3 col = uPalette[c];
  float n = h21(floor(xz / 380.0));
  if (c == 4) {
    // Crop fields: patchwork of ploughed earth, winter wheat and stubble.
    vec3 f = n < 0.33 ? vec3(0.36, 0.28, 0.19) : n < 0.66 ? vec3(0.33, 0.42, 0.2) : vec3(0.62, 0.55, 0.36);
    col = mix(col, f, 0.75);
  } else if (c == 1) {
    col *= 0.8 + 0.4 * h21(floor(xz / 90.0));
  } else if (c == 3 || c == 2) {
    col *= 0.88 + 0.24 * h21(floor(xz / 220.0));
  } else if (c == 5) {
    // Built-up: roofs, lawns and a street grid.
    vec2 g = fract(xz / 140.0);
    float street = step(g.x, 0.07) + step(g.y, 0.07);
    float r = h21(floor(xz / 22.0));
    col = r < 0.35 ? vec3(0.36, 0.42, 0.27) : vec3(0.45 + r * 0.25);
    col = mix(col, vec3(0.26, 0.26, 0.27), clamp(street, 0.0, 1.0));
  }
  return col;
}
`)
        .replace('#include <map_fragment>', `
  vec2 ll = vec2(uProj.y + vWorld.x / uProj.w, uProj.x - vWorld.z / uProj.z);
  float inMetro;
  // Blend the four surrounding cells (aligned to the grid in use) so class edges are smooth.
  vec2 mm = (ll - uMetro.xy) / uMetro.z;
  bool inM = mm.x >= 1.0 && mm.y >= 1.0 && mm.x < uMetroSize.x - 1.0 && mm.y < uMetroSize.y - 1.0;
  float stepDeg = inM ? uMetro.z : uWide.z;
  vec2 origin = inM ? uMetro.xy : uWide.xy;
  vec2 cellF = (ll - origin) / stepDeg - 0.5;
  vec2 fr = fract(cellF);
  vec2 base = origin + (floor(cellF) + 0.5) * stepDeg;
  int c00 = lcAt(base, inMetro);
  int c10 = lcAt(base + vec2(stepDeg, 0.0), inMetro);
  int c01 = lcAt(base + vec2(0.0, stepDeg), inMetro);
  int c11 = lcAt(base + vec2(stepDeg), inMetro);
  vec3 land = mix(mix(landColor(c00, vWorld.xz), landColor(c10, vWorld.xz), fr.x), mix(landColor(c01, vWorld.xz), landColor(c11, vWorld.xz), fr.x), fr.y);
  float water = mix(mix(float(c00 == 8), float(c10 == 8), fr.x), mix(float(c01 == 8), float(c11 == 8), fr.x), fr.y);
  vec4 detail = texture2D(map, vWorld.xz / 260.0) * 0.6 + texture2D(map, vWorld.xz / 37.0) * 0.4;
  land *= mix(detail.rgb * 1.15, vec3(1.0), water);
  land *= 1.0 - uWet * 0.25 * (1.0 - water);
  // Water reflects the sky at grazing angles.
  vec3 viewDir = normalize(cameraPosition - vWorld);
  float fres = pow(1.0 - clamp(viewDir.y, 0.0, 1.0), 4.0);
  vec3 waterCol = mix(uPalette[8], uSky * 0.8, fres * 0.85);
  diffuseColor.rgb = mix(land, waterCol, smoothstep(0.35, 0.65, water));
  float builtW = mix(mix(float(c00 == 5), float(c10 == 5), fr.x), mix(float(c01 == 5), float(c11 == 5), fr.x), fr.y);
`)
        .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
  if (uNight > 0.01 && builtW > 0.3) {
    // City lights: street lamps along the grid and lit windows.
    vec2 g = fract(vWorld.xz / 140.0);
    float lamp = smoothstep(0.06, 0.0, min(g.x, g.y)) * step(0.4, h21(floor(vWorld.xz / 35.0)));
    float win = step(0.86, h21(floor(vWorld.xz / 18.0)));
    float dist = length(cameraPosition - vWorld);
    float glow = (lamp * 0.9 + win * 0.6) * builtW * uNight;
    totalEmissiveRadiance += vec3(1.0, 0.72, 0.38) * glow * mix(1.0, 2.5, smoothstep(2000.0, 20000.0, dist));
  }
`);
    };
    this.material = m;
  }
}

class TerrainTiles {
  readonly group = new THREE.Group();
  private fine = new Map<string, { mesh: THREE.Mesh; seg: number }>();
  private coarse = new Map<string, { mesh: THREE.Mesh; overlaps: boolean }>();
  private center: [number, number] | null = null;
  private queue: { i: number; j: number; seg: number; ring: number }[] = [];

  constructor(scene: THREE.Scene, readonly world: WorldData, readonly material: THREE.Material) {
    scene.add(this.group);
  }

  private buildTile(x0: number, z0: number, size: number, seg: number, skirt: boolean, hole: ((x: number, z: number) => boolean) | null): THREE.Mesh {
    const W = this.world;
    const n = seg + 1;
    const step = size / seg;
    const hb = new Float32Array((n + 2) * (n + 2));
    for (let j = -1; j <= n; j++) for (let i = -1; i <= n; i++) hb[(j + 1) * (n + 2) + (i + 1)] = W.height(x0 + i * step, z0 + j * step);
    const H = (i: number, j: number) => hb[(j + 1) * (n + 2) + (i + 1)];
    const vcount = n * n + (skirt ? 4 * n : 0);
    const pos = new Float32Array(vcount * 3);
    const nor = new Float32Array(vcount * 3);
    const cx = x0 + size / 2;
    const cz = z0 + size / 2;
    let v = 0;
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const dx = (H(i + 1, j) - H(i - 1, j)) / (2 * step);
        const dz = (H(i, j + 1) - H(i, j - 1)) / (2 * step);
        const inv = 1 / Math.hypot(dx, 1, dz);
        pos[v * 3] = x0 + i * step - cx;
        pos[v * 3 + 1] = H(i, j);
        pos[v * 3 + 2] = z0 + j * step - cz;
        nor[v * 3] = -dx * inv;
        nor[v * 3 + 1] = inv;
        nor[v * 3 + 2] = -dz * inv;
        v++;
      }
    }
    const idx: number[] = [];
    for (let j = 0; j < seg; j++) {
      for (let i = 0; i < seg; i++) {
        if (hole && hole(x0 + (i + 0.5) * step, z0 + (j + 0.5) * step)) continue;
        const a = j * n + i;
        idx.push(a, a + n, a + 1, a + 1, a + n, a + n + 1);
      }
    }
    if (skirt) {
      const edge: number[] = [];
      for (let i = 0; i < n; i++) edge.push(i);
      for (let j = 0; j < n; j++) edge.push(j * n + seg);
      for (let i = seg; i >= 0; i--) edge.push(seg * n + i);
      for (let j = seg; j >= 0; j--) edge.push(j * n);
      const base = v;
      for (let k = 0; k < edge.length && v < vcount; k++) {
        const s = edge[k];
        pos[v * 3] = pos[s * 3];
        pos[v * 3 + 1] = pos[s * 3 + 1] - Math.max(25, step * 0.5);
        pos[v * 3 + 2] = pos[s * 3 + 2];
        nor[v * 3 + 1] = 1;
        v++;
      }
      const m = Math.min(edge.length, vcount - base);
      for (let k = 0; k < m - 1; k++) {
        const a = edge[k];
        const b = edge[k + 1];
        idx.push(a, b, base + k, b, base + k + 1, base + k, a, base + k, b, b, base + k, base + k + 1);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    geo.setIndex(idx);
    geo.computeBoundingSphere();
    const mesh = new THREE.Mesh(geo, this.material);
    mesh.position.set(cx, 0, cz);
    mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    return mesh;
  }

  private fineBounds() {
    const c = this.center!;
    return { x0: (c[0] - FINE_R) * FINE, x1: (c[0] + FINE_R + 1) * FINE, z0: (c[1] - FINE_R) * FINE, z1: (c[1] + FINE_R + 1) * FINE };
  }

  update(x: number, z: number, budgetMs: number): void {
    const ci = Math.floor(x / FINE);
    const cj = Math.floor(z / FINE);
    if (!this.center || this.center[0] !== ci || this.center[1] !== cj) {
      this.center = [ci, cj];
      const want = new Map<string, { i: number; j: number; seg: number; ring: number }>();
      for (let j = -FINE_R; j <= FINE_R; j++) {
        for (let i = -FINE_R; i <= FINE_R; i++) {
          const ring = Math.max(Math.abs(i), Math.abs(j));
          want.set(`${ci + i},${cj + j}`, { i: ci + i, j: cj + j, seg: lodFor(ring), ring });
        }
      }
      for (const [k, t] of this.fine) {
        if (!want.has(k)) {
          this.group.remove(t.mesh);
          t.mesh.geometry.dispose();
          this.fine.delete(k);
        }
      }
      this.queue = [...want.values()].filter((w) => this.fine.get(`${w.i},${w.j}`)?.seg !== w.seg).sort((a, b) => a.ring - b.ring);
      this.updateCoarse(x, z);
    }
    const t0 = performance.now();
    while (this.queue.length && performance.now() - t0 < budgetMs) {
      const w = this.queue.shift()!;
      const key = `${w.i},${w.j}`;
      const mesh = this.buildTile(w.i * FINE, w.j * FINE, FINE, w.seg, true, null);
      const old = this.fine.get(key);
      if (old) {
        this.group.remove(old.mesh);
        old.mesh.geometry.dispose();
      }
      this.group.add(mesh);
      this.fine.set(key, { mesh, seg: w.seg });
    }
  }

  private updateCoarse(x: number, z: number): void {
    const ci = Math.floor(x / COARSE);
    const cj = Math.floor(z / COARSE);
    const fb = this.fineBounds();
    const hole = (px: number, pz: number) => px > fb.x0 && px < fb.x1 && pz > fb.z0 && pz < fb.z1;
    const want = new Set<string>();
    for (let j = -COARSE_R; j <= COARSE_R; j++) for (let i = -COARSE_R; i <= COARSE_R; i++) want.add(`${ci + i},${cj + j}`);
    for (const [k, t] of this.coarse) {
      if (!want.has(k)) {
        this.group.remove(t.mesh);
        t.mesh.geometry.dispose();
        this.coarse.delete(k);
      }
    }
    for (const k of want) {
      const [i, j] = k.split(',').map(Number);
      const x0 = i * COARSE;
      const z0 = j * COARSE;
      const overlaps = !(x0 + COARSE <= fb.x0 || x0 >= fb.x1 || z0 + COARSE <= fb.z0 || z0 >= fb.z1);
      const t = this.coarse.get(k);
      if (!t) {
        const mesh = this.buildTile(x0, z0, COARSE, COARSE_SEG, false, overlaps ? hole : null);
        mesh.position.y -= 3;
        mesh.updateMatrix();
        this.group.add(mesh);
        this.coarse.set(k, { mesh, overlaps });
      } else if (overlaps || t.overlaps) {
        const n = COARSE_SEG + 1;
        const step = COARSE / COARSE_SEG;
        const idx: number[] = [];
        for (let jj = 0; jj < COARSE_SEG; jj++) {
          for (let ii = 0; ii < COARSE_SEG; ii++) {
            if (hole(x0 + (ii + 0.5) * step, z0 + (jj + 0.5) * step)) continue;
            const a = jj * n + ii;
            idx.push(a, a + n, a + 1, a + 1, a + n, a + n + 1);
          }
        }
        t.mesh.geometry.setIndex(idx);
        t.overlaps = overlaps;
      }
    }
  }

  get pending(): number {
    return this.queue.length;
  }
}

const SKY_VS = `
varying vec3 vDir;
void main() {
  vDir = normalize(position);
  vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  gl_Position = p.xyww;
}`;
const SKY_FS = `
uniform vec3 zenith, horizon, ground, sunDir, sunColor;
uniform float stars;
varying vec3 vDir;
float hash(vec3 p) { return fract(sin(dot(p, vec3(12.9898, 78.233, 37.719))) * 43758.5453); }
void main() {
  vec3 d = normalize(vDir);
  float h = d.y;
  vec3 col = mix(horizon, zenith, pow(clamp(h, 0.0, 1.0), 0.45));
  col = mix(col, ground, smoothstep(0.0, -0.08, h));
  float s = max(dot(d, sunDir), 0.0);
  col += sunColor * (pow(s, 900.0) * 6.0 + pow(s, 12.0) * 0.25 + pow(s, 3.0) * 0.08 * (1.0 - clamp(h * 3.0, 0.0, 1.0)));
  if (stars > 0.0 && h > 0.0) {
    vec3 q = floor(d * 420.0);
    float st = step(0.9975, hash(q));
    col += vec3(st * stars * (0.5 + 0.5 * hash(q + 3.0)));
  }
  gl_FragColor = vec4(col, 1.0);
}`;

export class WorldView {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(60, 1, 0.1, 700000);
  readonly sun = new THREE.DirectionalLight(0xffffff, 3);
  readonly hemi = new THREE.HemisphereLight(0xbfd8ff, 0x4a5a3a, 1.0);
  readonly fog = new THREE.FogExp2(0xaaccee, 0.00003);
  readonly terrainMat: TerrainMaterial;
  private readonly tiles: TerrainTiles;
  private readonly sky: THREE.Mesh;
  private readonly skyUniforms: Record<string, THREE.IUniform>;
  sunDir = new THREE.Vector3(0, 1, 0);
  dayFactor = 1;
  horizonColor = new THREE.Color();
  /** 0..1 how overcast the sky above the camera is (from the weather). */
  overcast = 0;
  /** Extra light from a lightning flash (decays quickly). */
  flash = 0;
  private baseSun = 3;
  private baseHemi = 1;
  private baseHorizon = new THREE.Color();
  private baseZenith = new THREE.Color();

  constructor(readonly renderer: THREE.WebGLRenderer, readonly world: WorldData, hour: number) {
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    const scene = this.scene;
    this.skyUniforms = {
      zenith: { value: new THREE.Color() }, horizon: { value: new THREE.Color() }, ground: { value: new THREE.Color() },
      sunDir: { value: new THREE.Vector3(0, 1, 0) }, sunColor: { value: new THREE.Color() }, stars: { value: 0 },
    };
    this.sky = new THREE.Mesh(
      new THREE.SphereGeometry(1, 32, 16),
      new THREE.ShaderMaterial({ vertexShader: SKY_VS, fragmentShader: SKY_FS, uniforms: this.skyUniforms, side: THREE.BackSide, depthWrite: false, depthTest: false }),
    );
    this.sky.renderOrder = -10;
    this.sky.frustumCulled = false;
    this.sky.scale.setScalar(1000);
    scene.add(this.sky);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    const sc = this.sun.shadow.camera;
    sc.left = -45;
    sc.right = 45;
    sc.top = 45;
    sc.bottom = -45;
    sc.near = 1;
    sc.far = 800;
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.05;
    scene.add(this.sun, this.sun.target, this.hemi);
    scene.fog = this.fog;
    this.terrainMat = new TerrainMaterial(world);
    this.tiles = new TerrainTiles(scene, world, this.terrainMat.material);
    this.setTime(hour);
  }

  setTime(hour: number): void {
    // Sun path for late October in Dallas: sunrise ~07:40, sunset ~18:40 local.
    const t = ((hour - 7.6) / 11) * Math.PI;
    const elev = Math.sin(t) * 46 * DEG;
    const az = (105 + ((hour - 7.6) / 11) * 150) * DEG;
    const dir = new THREE.Vector3(Math.sin(az) * Math.cos(elev), Math.sin(elev), -Math.cos(az) * Math.cos(elev));
    this.sunDir = dir;
    const se = Math.sin(elev);
    const day = smoothstep(-0.12, 0.25, se);
    const dusk = Math.exp(-Math.pow(se / 0.18, 2));
    this.dayFactor = day;
    this.baseZenith.setRGB(lerp(0.004, 0.1, day), lerp(0.006, 0.28, day), lerp(0.02, 0.68, day));
    this.baseHorizon.setRGB(lerp(0.02, 0.6, day) + dusk * 0.55, lerp(0.025, 0.74, day) + dusk * 0.18, lerp(0.05, 0.92, day) - dusk * 0.1);
    const u = this.skyUniforms;
    (u.ground.value as THREE.Color).setRGB(lerp(0.01, 0.22, day), lerp(0.012, 0.26, day), lerp(0.015, 0.3, day));
    (u.sunDir.value as THREE.Vector3).copy(dir);
    (u.sunColor.value as THREE.Color).setRGB(1, lerp(0.55, 0.92, smoothstep(0, 0.4, se)), lerp(0.3, 0.8, smoothstep(0, 0.4, se))).multiplyScalar(day);
    u.stars.value = 1 - smoothstep(-0.15, 0.02, se);
    this.baseSun = 3.2 * smoothstep(-0.02, 0.2, se);
    this.sun.color.setRGB(1, lerp(0.6, 0.97, smoothstep(0, 0.35, se)), lerp(0.4, 0.92, smoothstep(0, 0.35, se)));
    this.baseHemi = lerp(0.35, 1.1, day);
    this.hemi.color.setRGB(lerp(0.12, 0.75, day), lerp(0.15, 0.85, day), lerp(0.28, 1.0, day));
    this.hemi.groundColor.setRGB(lerp(0.05, 0.3, day), lerp(0.05, 0.33, day), lerp(0.06, 0.25, day));
    this.renderer.toneMappingExposure = lerp(1.6, 1.0, day);
    this.terrainMat.uniforms.uNight.value = 1 - smoothstep(-0.05, 0.12, se);
    this.applyWeatherLight();
  }

  /** Dim and grey the sky and sun under overcast skies. */
  private applyWeatherLight(): void {
    const o = this.overcast;
    const grey = new THREE.Color().setRGB(0.42, 0.45, 0.5).multiplyScalar(0.25 + 0.75 * this.dayFactor);
    const u = this.skyUniforms;
    (u.zenith.value as THREE.Color).copy(this.baseZenith).lerp(grey.clone().multiplyScalar(0.8), o * 0.85);
    this.horizonColor.copy(this.baseHorizon).lerp(grey, o * 0.8);
    (u.horizon.value as THREE.Color).copy(this.horizonColor);
    this.fog.color.copy(this.horizonColor);
    this.sun.intensity = this.baseSun * (1 - 0.8 * o);
    this.hemi.intensity = this.baseHemi * (1 - 0.25 * o) + this.flash * 3;
    (this.terrainMat.uniforms.uSky.value as THREE.Color).copy(this.horizonColor);
  }

  resize(w: number, h: number): void {
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  /** Per-frame update: terrain streaming, fog/visibility, sun shadow camera. */
  update(dt: number, camPos: THREE.Vector3, acPos: THREE.Vector3, vis: number, inCloud: number, overcast: number, wet: number, budgetMs = 5): void {
    this.tiles.update(camPos.x, camPos.z, budgetMs);
    this.sky.position.copy(camPos);
    this.overcast += (overcast - this.overcast) * Math.min(1, dt * 0.5);
    this.flash = Math.max(0, this.flash - dt * 6);
    this.applyWeatherLight();
    let eff = vis * (1 + Math.max(0, camPos.y) / 2500);
    if (inCloud > 0.05) eff = lerp(eff, 90, inCloud);
    this.fog.density = 1.9 / clamp(eff, 60, 400000);
    if (inCloud > 0.3) this.fog.color.lerp(new THREE.Color(0.75, 0.77, 0.8).multiplyScalar(0.3 + 0.7 * this.dayFactor), inCloud);
    this.terrainMat.uniforms.uWet.value = wet;
    const d = this.sunDir;
    this.sun.position.set(acPos.x + d.x * 400, acPos.y + d.y * 400, acPos.z + d.z * 400);
    this.sun.target.position.copy(acPos);
  }

  /** Build all nearby terrain before the first frame. */
  prime(camPos: THREE.Vector3): void {
    this.tiles.update(camPos.x, camPos.z, 1e9);
  }

  render(): void {
    this.renderer.render(this.scene, this.camera);
  }
}
