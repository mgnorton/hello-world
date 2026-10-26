// Scene setup: renderer, sky, sun & time of day, fog, LOD terrain tiles, water and clouds.
import * as THREE from '../vendor/three.module.min.js';
import { fbm, WATER_LEVEL } from '../terrain.js';
import { clamp, lerp, smoothstep, DEG, FT } from '../math.js';

const FINE = 8000;      // fine tile size (m)
const FINE_R = 4;       // fine tiles radius (in tiles)
const COARSE = 64000;   // coarse tile size (m)
const COARSE_R = 3;
const COARSE_SEG = 32;

function lodFor(ring) {
  if (ring <= 1) return 64;
  if (ring <= 2) return 32;
  return 16;
}

/** Approximate sRGB -> linear for vertex colours. */
const lin = (c) => c * c;

export function terrainColor(h, slope, x, z, out) {
  const n = fbm(x / 1700 + 3.1, z / 1700 - 1.7, 2);
  const field = fbm(x / 420, z / 420, 1);
  let r;
  let g;
  let b;
  if (h < WATER_LEVEL + 3) {
    r = 0.72; g = 0.66; b = 0.48; // beach / mud flats
  } else {
    // Patchwork of fields and meadows, blended smoothly to avoid blocky vertex colours.
    const dry = smoothstep(0.1, 0.45, field);
    const lush = smoothstep(-0.15, -0.45, field);
    r = 0.36 + 0.14 * dry - 0.09 * lush;
    g = 0.46 + 0.01 * dry - 0.06 * lush;
    b = 0.22 + 0.06 * dry - 0.05 * lush;
    r += n * 0.06; g += n * 0.07; b += n * 0.03;
    // Forest at mid elevations.
    const forest = smoothstep(500, 1100, h + n * 300) * (1 - smoothstep(1900, 2300, h));
    r = lerp(r, 0.17, forest); g = lerp(g, 0.28, forest); b = lerp(b, 0.14, forest);
    // Rock on high ground and steep slopes.
    const rock = Math.max(smoothstep(1900, 2400, h + n * 250), smoothstep(0.55, 0.9, slope));
    r = lerp(r, 0.46, rock); g = lerp(g, 0.43, rock); b = lerp(b, 0.40, rock);
    // Snow caps.
    const snow = smoothstep(2650, 2900, h + n * 300) * (1 - smoothstep(0.8, 1.1, slope));
    r = lerp(r, 0.94, snow); g = lerp(g, 0.95, snow); b = lerp(b, 0.98, snow);
  }
  out[0] = lin(r);
  out[1] = lin(g);
  out[2] = lin(b);
}

function makeDetailTexture() {
  const s = 256;
  const cv = document.createElement('canvas');
  cv.width = cv.height = s;
  const g = cv.getContext('2d');
  const img = g.createImageData(s, s);
  for (let y = 0; y < s; y++) {
    for (let x = 0; x < s; x++) {
      const v = 0.82 + 0.18 * (0.5 * fbm(x / 9, y / 9, 3) + 0.5 * fbm(x / 2.5, y / 2.5, 2));
      const i = (y * s + x) * 4;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = clamp(v, 0, 1) * 255;
      img.data[i + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(cv);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 4;
  return t;
}

/** Streams terrain tiles around the camera. */
class TerrainTiles {
  constructor(scene, terrain) {
    this.scene = scene;
    this.terrain = terrain;
    this.material = new THREE.MeshLambertMaterial({ vertexColors: true, map: makeDetailTexture() });
    this.fine = new Map();
    this.coarse = new Map();
    this.center = null;
    this.queue = [];
    this.group = new THREE.Group();
    scene.add(this.group);
  }

  buildTile(x0, z0, size, seg, skirt, holeFn) {
    const T = this.terrain;
    const n = seg + 1;
    const step = size / seg;
    // Heights including a one-cell border for normals.
    const hb = new Float32Array((n + 2) * (n + 2));
    for (let j = -1; j <= n; j++) {
      for (let i = -1; i <= n; i++) {
        hb[(j + 1) * (n + 2) + (i + 1)] = Math.max(T.height(x0 + i * step, z0 + j * step), WATER_LEVEL - 40);
      }
    }
    const H = (i, j) => hb[(j + 1) * (n + 2) + (i + 1)];
    const skirtCount = skirt ? 4 * n : 0;
    const vcount = n * n + skirtCount;
    const pos = new Float32Array(vcount * 3);
    const nor = new Float32Array(vcount * 3);
    const col = new Float32Array(vcount * 3);
    const uv = new Float32Array(vcount * 2);
    const cx = x0 + size / 2;
    const cz = z0 + size / 2;
    const c3 = [0, 0, 0];
    let v = 0;
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const wx = x0 + i * step;
        const wz = z0 + j * step;
        const h = H(i, j);
        const dx = (H(i + 1, j) - H(i - 1, j)) / (2 * step);
        const dz = (H(i, j + 1) - H(i, j - 1)) / (2 * step);
        const inv = 1 / Math.hypot(dx, 1, dz);
        pos[v * 3] = wx - cx;
        pos[v * 3 + 1] = h;
        pos[v * 3 + 2] = wz - cz;
        nor[v * 3] = -dx * inv;
        nor[v * 3 + 1] = inv;
        nor[v * 3 + 2] = -dz * inv;
        terrainColor(h, Math.hypot(dx, dz), wx, wz, c3);
        col[v * 3] = c3[0];
        col[v * 3 + 1] = c3[1];
        col[v * 3 + 2] = c3[2];
        uv[v * 2] = wx / 300;
        uv[v * 2 + 1] = wz / 300;
        v++;
      }
    }
    const idx = [];
    for (let j = 0; j < seg; j++) {
      for (let i = 0; i < seg; i++) {
        if (holeFn && holeFn(x0 + (i + 0.5) * step, z0 + (j + 0.5) * step)) continue;
        const a = j * n + i;
        const b = a + 1;
        const c = a + n;
        const d = c + 1;
        idx.push(a, c, b, b, c, d);
      }
    }
    if (skirt) {
      // Vertical skirts hide cracks between neighbouring LODs.
      const edge = [];
      for (let i = 0; i < n; i++) edge.push(i);                    // north edge (j=0)
      for (let j = 0; j < n; j++) edge.push(j * n + seg);          // east
      for (let i = seg; i >= 0; i--) edge.push(seg * n + i);       // south
      for (let j = seg; j >= 0; j--) edge.push(j * n);             // west
      const base = v;
      for (let k = 0; k < edge.length && v < vcount; k++) {
        const s = edge[k];
        pos[v * 3] = pos[s * 3];
        pos[v * 3 + 1] = pos[s * 3 + 1] - Math.max(30, step * 0.6);
        pos[v * 3 + 2] = pos[s * 3 + 2];
        nor[v * 3 + 1] = 1;
        col[v * 3] = col[s * 3];
        col[v * 3 + 1] = col[s * 3 + 1];
        col[v * 3 + 2] = col[s * 3 + 2];
        uv[v * 2] = uv[s * 2];
        uv[v * 2 + 1] = uv[s * 2 + 1];
        v++;
      }
      const m = Math.min(edge.length, vcount - base);
      for (let k = 0; k < m - 1; k++) {
        const a = edge[k];
        const b = edge[k + 1];
        const a2 = base + k;
        const b2 = base + k + 1;
        idx.push(a, b, a2, b, b2, a2, a, a2, b, b, a2, b2);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geo.setIndex(idx);
    geo.computeBoundingSphere();
    const mesh = new THREE.Mesh(geo, this.material);
    mesh.position.set(cx, 0, cz);
    mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    return mesh;
  }

  fineBounds() {
    const c = this.center;
    return {
      x0: (c[0] - FINE_R) * FINE, x1: (c[0] + FINE_R + 1) * FINE,
      z0: (c[1] - FINE_R) * FINE, z1: (c[1] + FINE_R + 1) * FINE,
    };
  }

  /** Update tiles for a camera position. budgetMs limits work per frame. */
  update(x, z, budgetMs = 6, force = false) {
    const ci = Math.floor(x / FINE);
    const cj = Math.floor(z / FINE);
    const moved = !this.center || this.center[0] !== ci || this.center[1] !== cj;
    if (moved) {
      this.center = [ci, cj];
      const want = new Map();
      for (let j = -FINE_R; j <= FINE_R; j++) {
        for (let i = -FINE_R; i <= FINE_R; i++) {
          const ring = Math.max(Math.abs(i), Math.abs(j));
          want.set(`${ci + i},${cj + j}`, { i: ci + i, j: cj + j, seg: lodFor(ring), ring });
        }
      }
      this.wantFine = want;
      // Remove tiles that are out of range entirely.
      for (const [k, t] of this.fine) {
        if (!want.has(k)) {
          this.group.remove(t.mesh);
          t.mesh.geometry.dispose();
          this.fine.delete(k);
        }
      }
      this.queue = [...want.values()]
        .filter((w) => !this.fine.has(`${w.i},${w.j}`) || this.fine.get(`${w.i},${w.j}`).seg !== w.seg)
        .sort((a, b) => a.ring - b.ring);
      this.updateCoarse(x, z);
    }
    const t0 = performance.now();
    while (this.queue.length && (force || performance.now() - t0 < budgetMs)) {
      const w = this.queue.shift();
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

  updateCoarse(x, z) {
    const ci = Math.floor(x / COARSE);
    const cj = Math.floor(z / COARSE);
    const fb = this.fineBounds();
    const hole = (px, pz) => px > fb.x0 && px < fb.x1 && pz > fb.z0 && pz < fb.z1;
    const want = new Set();
    for (let j = -COARSE_R; j <= COARSE_R; j++) {
      for (let i = -COARSE_R; i <= COARSE_R; i++) want.add(`${ci + i},${cj + j}`);
    }
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
      let t = this.coarse.get(k);
      if (!t) {
        const mesh = this.buildTile(x0, z0, COARSE, COARSE_SEG, false, overlaps ? hole : null);
        mesh.position.y -= 2; // keep coarse tiles just below fine ones where they meet
        mesh.updateMatrix();
        this.group.add(mesh);
        this.coarse.set(k, { mesh, overlaps: overlaps ? 1 : 0, fb });
      } else if (overlaps || t.overlaps) {
        // Rebuild the index buffer to cut out the area covered by fine tiles.
        const seg = COARSE_SEG;
        const n = seg + 1;
        const step = COARSE / seg;
        const idx = [];
        for (let jj = 0; jj < seg; jj++) {
          for (let ii = 0; ii < seg; ii++) {
            if (hole(x0 + (ii + 0.5) * step, z0 + (jj + 0.5) * step)) continue;
            const a = jj * n + ii;
            idx.push(a, a + n, a + 1, a + 1, a + n, a + n + 1);
          }
        }
        t.mesh.geometry.setIndex(idx);
        t.overlaps = overlaps ? 1 : 0;
      }
    }
  }

  get pending() {
    return this.queue.length;
  }
}

function makeCloudTexture() {
  const s = 128;
  const cv = document.createElement('canvas');
  cv.width = cv.height = s;
  const g = cv.getContext('2d');
  for (let k = 0; k < 14; k++) {
    const x = s / 2 + (Math.random() - 0.5) * s * 0.45;
    const y = s / 2 + (Math.random() - 0.5) * s * 0.25;
    const r = s * (0.18 + Math.random() * 0.16);
    const grd = g.createRadialGradient(x, y, 0, x, y, r);
    grd.addColorStop(0, 'rgba(255,255,255,0.55)');
    grd.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grd;
    g.fillRect(0, 0, s, s);
  }
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

const SKY_VS = `
varying vec3 vDir;
void main() {
  vDir = normalize(position);
  vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  gl_Position = p.xyww;
}`;
const SKY_FS = `
uniform vec3 zenith;
uniform vec3 horizon;
uniform vec3 ground;
uniform vec3 sunDir;
uniform vec3 sunColor;
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

export class World {
  constructor(renderer, sim) {
    this.sim = sim;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.0;
    this.renderer = renderer;
    const scene = new THREE.Scene();
    this.scene = scene;
    this.camera = new THREE.PerspectiveCamera(60, 1, 0.1, 700000);

    // Sky dome drawn first, always behind everything.
    this.skyUniforms = {
      zenith: { value: new THREE.Color() }, horizon: { value: new THREE.Color() }, ground: { value: new THREE.Color() },
      sunDir: { value: new THREE.Vector3(0, 1, 0) }, sunColor: { value: new THREE.Color() }, stars: { value: 0 },
    };
    const sky = new THREE.Mesh(
      new THREE.SphereGeometry(1, 32, 16),
      new THREE.ShaderMaterial({ vertexShader: SKY_VS, fragmentShader: SKY_FS, uniforms: this.skyUniforms, side: THREE.BackSide, depthWrite: false, depthTest: false }),
    );
    sky.renderOrder = -10;
    sky.frustumCulled = false;
    sky.scale.setScalar(1000);
    this.sky = sky;
    scene.add(sky);

    this.sun = new THREE.DirectionalLight(0xffffff, 3);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    const sc = this.sun.shadow.camera;
    sc.left = -45; sc.right = 45; sc.top = 45; sc.bottom = -45; sc.near = 1; sc.far = 800;
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.05;
    scene.add(this.sun);
    scene.add(this.sun.target);
    this.hemi = new THREE.HemisphereLight(0xbfd8ff, 0x4a5a3a, 1.0);
    scene.add(this.hemi);

    this.fog = new THREE.FogExp2(0xaaccee, 0.00003);
    scene.fog = this.fog;

    this.tiles = new TerrainTiles(scene, sim.terrain);

    // Water plane follows the camera.
    const water = new THREE.Mesh(
      new THREE.PlaneGeometry(1400000, 1400000),
      new THREE.MeshPhongMaterial({ color: 0x1b4a66, specular: 0x8899aa, shininess: 90 }),
    );
    water.rotation.x = -Math.PI / 2;
    water.position.y = WATER_LEVEL;
    water.receiveShadow = true;
    this.water = water;
    scene.add(water);

    this.setupClouds();
    this.setTime(sim.options.hour ?? 13);
  }

  setupClouds() {
    const wx = this.sim.weather;
    const counts = { clear: 0, few: 70, scattered: 180, broken: 380, overcast: 600 };
    const n = counts[wx.clouds] ?? 0;
    this.cloudBase = wx.cloudBase * FT;
    this.cloudCover = wx.clouds;
    this.clouds = new THREE.Group();
    this.cloudSpan = 70000;
    if (n === 0) return;
    const tex = makeCloudTexture();
    this.cloudMat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, fog: true, color: 0xffffff, opacity: 0.95 });
    for (let i = 0; i < n; i++) {
      const s = new THREE.Sprite(this.cloudMat);
      const size = 900 + Math.random() * 1800;
      s.scale.set(size * 1.8, size * 0.8, 1);
      s.position.set((Math.random() - 0.5) * this.cloudSpan, this.cloudBase + Math.random() * 500 + size * 0.25, (Math.random() - 0.5) * this.cloudSpan);
      this.clouds.add(s);
    }
    this.scene.add(this.clouds);
  }

  setTime(hour) {
    this.hour = hour;
    // Simple sun path: rises in the east at 06:00, sets in the west at 20:00.
    const t = ((hour - 6) / 14) * Math.PI;
    const elev = Math.sin(t) * 62 * DEG;
    const az = (90 + ((hour - 6) / 14) * 180) * DEG;
    const dir = new THREE.Vector3(Math.sin(az) * Math.cos(elev), Math.sin(elev), -Math.cos(az) * Math.cos(elev));
    this.sunDir = dir;
    const day = smoothstep(-0.12, 0.25, Math.sin(elev));
    const dusk = Math.exp(-Math.pow(Math.sin(elev) / 0.18, 2));
    this.dayFactor = day;
    const zen = new THREE.Color().setRGB(lerp(0.004, 0.10, day), lerp(0.006, 0.28, day), lerp(0.02, 0.68, day));
    const hor = new THREE.Color().setRGB(
      lerp(0.02, 0.60, day) + dusk * 0.55, lerp(0.025, 0.74, day) + dusk * 0.18, lerp(0.05, 0.92, day) - dusk * 0.1,
    );
    const ground = new THREE.Color().setRGB(lerp(0.01, 0.22, day), lerp(0.012, 0.26, day), lerp(0.015, 0.3, day));
    const u = this.skyUniforms;
    u.zenith.value.copy(zen);
    u.horizon.value.copy(hor);
    u.ground.value.copy(ground);
    u.sunDir.value.copy(dir);
    u.sunColor.value.setRGB(1.0, lerp(0.55, 0.92, smoothstep(0, 0.4, Math.sin(elev))), lerp(0.3, 0.8, smoothstep(0, 0.4, Math.sin(elev)))).multiplyScalar(day);
    u.stars.value = 1 - smoothstep(-0.15, 0.02, Math.sin(elev));
    this.horizonColor = hor;
    this.fog.color.copy(hor);
    // Lights.
    this.sun.intensity = 3.2 * smoothstep(-0.02, 0.2, Math.sin(elev));
    this.sun.color.setRGB(1, lerp(0.6, 0.97, smoothstep(0, 0.35, Math.sin(elev))), lerp(0.4, 0.92, smoothstep(0, 0.35, Math.sin(elev))));
    this.hemi.intensity = lerp(0.35, 1.1, day);
    this.hemi.color.setRGB(lerp(0.12, 0.75, day), lerp(0.15, 0.85, day), lerp(0.28, 1.0, day));
    this.hemi.groundColor.setRGB(lerp(0.05, 0.3, day), lerp(0.05, 0.33, day), lerp(0.06, 0.25, day));
    this.renderer.toneMappingExposure = lerp(1.6, 1.0, day);
    if (this.cloudMat) this.cloudMat.color.setRGB(lerp(0.035, 1, day) + dusk * 0.25, lerp(0.04, 1, day) + dusk * 0.08, lerp(0.06, 1, day));
  }

  resize(w, h) {
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  /** Per-frame update: terrain streaming, fog, sun shadow, clouds. */
  update(camPos, acPos, force = false) {
    this.tiles.update(camPos.x, camPos.z, force ? 1e9 : 5, force);
    this.sky.position.copy(camPos);
    this.water.position.x = Math.round(camPos.x / 1000) * 1000;
    this.water.position.z = Math.round(camPos.z / 1000) * 1000;
    // Visibility grows with altitude (thinner haze aloft); inside clouds it collapses.
    const vis = this.sim.weather.visibility * 1000;
    const alt = Math.max(0, camPos.y);
    let eff = vis * (1 + alt / 2500);
    const inCloud = this.cloudCover && this.cloudCover !== 'clear' && this.cloudCover !== 'few' &&
      alt > this.cloudBase && alt < this.cloudBase + 700;
    if (inCloud) eff = this.cloudCover === 'scattered' ? 2500 : 400;
    this.fog.density = 1.9 / clamp(eff, 300, 400000);
    this.inCloud = inCloud;
    // Shadow camera follows the aircraft.
    const d = this.sunDir;
    this.sun.position.set(acPos.x + d.x * 400, acPos.y + d.y * 400, acPos.z + d.z * 400);
    this.sun.target.position.copy(acPos);
    // Recycle clouds around the camera.
    if (this.clouds.children.length) {
      const span = this.cloudSpan;
      for (const s of this.clouds.children) {
        const dx = s.position.x - camPos.x;
        const dz = s.position.z - camPos.z;
        if (dx > span / 2) s.position.x -= span;
        else if (dx < -span / 2) s.position.x += span;
        if (dz > span / 2) s.position.z -= span;
        else if (dz < -span / 2) s.position.z += span;
      }
    }
  }

  render() {
    this.renderer.render(this.scene, this.camera);
  }
}
