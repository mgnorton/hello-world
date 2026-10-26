// Weather visuals driven by the WeatherSystem: cumulus fields and storm towers as instanced
// billboards, stratus / altocumulus / cirrus decks as noise-shaded planes, rain shafts under
// storms, rain streaks around the camera, lightning bolts and flashes.
import * as THREE from 'three';
import { clamp, lerp, hash2, mulberry, smoothstep } from '../core/math.ts';
import type { WeatherSystem, CloudLayer } from '../weather/weather.ts';
import type { WorldData } from '../world/worldData.ts';

const CU_CELL = 1600;
const CU_RADIUS = 38000;
const MAX_PUFFS = 14000;

function puffTexture(): THREE.Texture {
  const s = 128;
  const cv = document.createElement('canvas');
  cv.width = cv.height = s;
  const g = cv.getContext('2d')!;
  const rnd = mulberry(11);
  for (let k = 0; k < 26; k++) {
    const a = rnd() * Math.PI * 2;
    const r = Math.pow(rnd(), 0.7) * s * 0.28;
    const x = s / 2 + Math.cos(a) * r;
    const y = s / 2 + Math.sin(a) * r * 0.8;
    const rad = s * (0.12 + rnd() * 0.16);
    const grd = g.createRadialGradient(x, y, 0, x, y, rad);
    const b = 200 + rnd() * 55;
    grd.addColorStop(0, `rgba(${b},${b},${b},0.55)`);
    grd.addColorStop(1, `rgba(${b},${b},${b},0)`);
    g.fillStyle = grd;
    g.fillRect(0, 0, s, s);
  }
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

const PUFF_VS = `
#include <common>
#include <logdepthbuf_pars_vertex>
attribute vec3 aOffset;
attribute vec4 aParams; // size, alpha, height shade 0 (base) .. 1 (top), rotation
uniform vec3 uDrift, uSunCol, uAmb, uFogCol, uSunDir;
uniform float uFog;
varying vec2 vUv;
varying float vA;
varying vec3 vCol;
void main() {
  vec3 center = aOffset + uDrift;
  vec4 mv = viewMatrix * vec4(center, 1.0);
  float c = cos(aParams.w), s = sin(aParams.w);
  mv.xy += mat2(c, -s, s, c) * position.xy * aParams.x;
  gl_Position = projectionMatrix * mv;
  vUv = uv;
  float dist = length(mv.xyz);
  float fog = exp(-uFog * uFog * dist * dist * 0.5);
  // Lit tops, grey bases; the side towards the sun is brighter.
  vec3 toCam = normalize(cameraPosition - center);
  float sunSide = 0.5 + 0.5 * dot(-toCam, uSunDir);
  vec3 col = uAmb * mix(0.55, 1.0, aParams.z) + uSunCol * mix(0.25, 1.0, aParams.z) * mix(0.75, 1.15, sunSide);
  vCol = mix(uFogCol, col, fog);
  vA = aParams.y * smoothstep(aParams.x * 0.3, aParams.x * 1.2, dist) * mix(0.25, 1.0, fog);
  #include <logdepthbuf_vertex>
}`;
const PUFF_FS = `
#include <common>
#include <logdepthbuf_pars_fragment>
uniform sampler2D uMap;
varying vec2 vUv;
varying float vA;
varying vec3 vCol;
void main() {
  #include <logdepthbuf_fragment>
  vec4 t = texture2D(uMap, vUv);
  float a = t.a * vA;
  if (a < 0.01) discard;
  gl_FragColor = vec4(vCol * (0.8 + 0.25 * t.r), a);
}`;

const DECK_VS = `
#include <common>
#include <logdepthbuf_pars_vertex>
varying vec3 vW;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vW = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
  #include <logdepthbuf_vertex>
}`;
const DECK_FS = `
#include <common>
#include <logdepthbuf_pars_fragment>
uniform float uCover, uScale, uFog, uAlpha, uTop, uRadius;
uniform vec3 uColBelow, uColAbove, uFogCol;
uniform vec2 uOffset, uCenter;
varying vec3 vW;
float hh(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hh(i), hh(i + vec2(1, 0)), u.x), mix(hh(i + vec2(0, 1)), hh(i + vec2(1, 1)), u.x), u.y);
}
float fbm(vec2 p) {
  float v = 0.0, a = 0.5;
  for (int i = 0; i < 5; i++) { v += a * vnoise(p); p = p * 2.03 + 17.1; a *= 0.5; }
  return v;
}
void main() {
  #include <logdepthbuf_fragment>
  vec2 p = (vW.xz - uOffset) / uScale;
  float n = fbm(p);
  float th = 1.0 - uCover;
  float a = smoothstep(th - 0.08, th + 0.12, n);
  float dist = length(vW - cameraPosition);
  float fog = exp(-uFog * uFog * dist * dist * 0.5);
  float edge = 1.0 - smoothstep(uRadius * 0.7, uRadius, length(vW.xz - uCenter));
  bool above = cameraPosition.y > vW.y;
  vec3 col = above ? uColAbove * (0.85 + 0.25 * n) : uColBelow * (0.75 + 0.35 * (1.0 - n));
  col = mix(uFogCol, col, fog);
  float alpha = a * uAlpha * edge * mix(0.35, 1.0, fog);
  if (alpha < 0.01) discard;
  gl_FragColor = vec4(col, alpha);
}`;

const SHAFT_VS = `
#include <common>
#include <logdepthbuf_pars_vertex>
varying float vH;
varying float vDist;
void main() {
  vH = uv.y;
  vec4 w = modelMatrix * vec4(position, 1.0);
  vDist = length(w.xyz - cameraPosition);
  gl_Position = projectionMatrix * viewMatrix * w;
  #include <logdepthbuf_vertex>
}`;
const SHAFT_FS = `
#include <common>
#include <logdepthbuf_pars_fragment>
uniform vec3 uCol, uFogCol;
uniform float uAlpha, uFog;
varying float vH;
varying float vDist;
void main() {
  #include <logdepthbuf_fragment>
  float fog = exp(-uFog * uFog * vDist * vDist * 0.5);
  float a = uAlpha * smoothstep(0.0, 0.25, vH) * (0.6 + 0.4 * vH) * mix(0.3, 1.0, fog) * smoothstep(400.0, 3000.0, vDist);
  gl_FragColor = vec4(mix(uFogCol, uCol, fog), a);
}`;

interface Deck {
  mesh: THREE.Mesh;
  uniforms: Record<string, THREE.IUniform>;
}

export class WeatherView {
  readonly group = new THREE.Group();
  private readonly puffGeo: THREE.InstancedBufferGeometry;
  private readonly puffMesh: THREE.Mesh;
  private readonly puffUniforms: Record<string, THREE.IUniform>;
  private readonly offsets: Float32Array;
  private readonly params: Float32Array;
  private readonly decks: Deck[] = [];
  private shafts: THREE.Mesh[] = [];
  private readonly shaftMat: THREE.ShaderMaterial;
  private readonly rain: THREE.LineSegments;
  private readonly rainPos: Float32Array;
  private readonly rainSeed: Float32Array;
  private readonly bolts: { line: THREE.Line; until: number }[] = [];
  private seenStrikes = new Set<string>();
  private rebuildTimer = 0;
  /** Strikes this frame for audio: distance (m) from the camera. */
  newStrikes: { dist: number; cg: boolean }[] = [];

  constructor(readonly scene: THREE.Scene, readonly weather: WeatherSystem, readonly world: WorldData) {
    const base = new THREE.PlaneGeometry(1, 1);
    this.puffGeo = new THREE.InstancedBufferGeometry();
    this.puffGeo.index = base.index;
    this.puffGeo.setAttribute('position', base.getAttribute('position'));
    this.puffGeo.setAttribute('uv', base.getAttribute('uv'));
    this.offsets = new Float32Array(MAX_PUFFS * 3);
    this.params = new Float32Array(MAX_PUFFS * 4);
    this.puffGeo.setAttribute('aOffset', new THREE.InstancedBufferAttribute(this.offsets, 3).setUsage(THREE.DynamicDrawUsage));
    this.puffGeo.setAttribute('aParams', new THREE.InstancedBufferAttribute(this.params, 4).setUsage(THREE.DynamicDrawUsage));
    this.puffGeo.instanceCount = 0;
    this.puffUniforms = {
      uMap: { value: puffTexture() }, uDrift: { value: new THREE.Vector3() }, uSunCol: { value: new THREE.Color() },
      uAmb: { value: new THREE.Color() }, uFogCol: { value: new THREE.Color() }, uSunDir: { value: new THREE.Vector3(0, 1, 0) }, uFog: { value: 0 },
    };
    this.puffMesh = new THREE.Mesh(this.puffGeo, new THREE.ShaderMaterial({
      vertexShader: PUFF_VS, fragmentShader: PUFF_FS, uniforms: this.puffUniforms, transparent: true, depthWrite: false,
    }));
    this.puffMesh.frustumCulled = false;
    this.puffMesh.renderOrder = 8;
    this.group.add(this.puffMesh);

    for (let i = 0; i < 3; i++) {
      const uniforms: Record<string, THREE.IUniform> = {
        uCover: { value: 0 }, uScale: { value: 6000 }, uFog: { value: 0 }, uAlpha: { value: 0.95 }, uTop: { value: 0 }, uRadius: { value: 90000 },
        uColBelow: { value: new THREE.Color() }, uColAbove: { value: new THREE.Color() }, uFogCol: { value: new THREE.Color() },
        uOffset: { value: new THREE.Vector2() }, uCenter: { value: new THREE.Vector2() },
      };
      const geo = new THREE.CircleGeometry(90000, 48);
      geo.rotateX(-Math.PI / 2);
      const mesh = new THREE.Mesh(geo, new THREE.ShaderMaterial({
        vertexShader: DECK_VS, fragmentShader: DECK_FS, uniforms, transparent: true, depthWrite: false, side: THREE.DoubleSide,
      }));
      mesh.frustumCulled = false;
      mesh.visible = false;
      mesh.renderOrder = 7;
      this.group.add(mesh);
      this.decks.push({ mesh, uniforms });
    }

    this.shaftMat = new THREE.ShaderMaterial({
      vertexShader: SHAFT_VS, fragmentShader: SHAFT_FS, transparent: true, depthWrite: false, side: THREE.DoubleSide,
      uniforms: { uCol: { value: new THREE.Color(0.38, 0.42, 0.48) }, uFogCol: { value: new THREE.Color() }, uAlpha: { value: 0.45 }, uFog: { value: 0 } },
    });

    const N = 4000;
    this.rainPos = new Float32Array(N * 6);
    this.rainSeed = new Float32Array(N * 3).map(() => Math.random());
    const rg = new THREE.BufferGeometry();
    rg.setAttribute('position', new THREE.BufferAttribute(this.rainPos, 3).setUsage(THREE.DynamicDrawUsage));
    this.rain = new THREE.LineSegments(rg, new THREE.LineBasicMaterial({ color: 0xaab4c0, transparent: true, opacity: 0.35, depthWrite: false }));
    this.rain.frustumCulled = false;
    this.rain.visible = false;
    this.group.add(this.rain);
    scene.add(this.group);
  }

  /** Rebuild cumulus and storm puffs around the camera from the current weather state. */
  private rebuild(cam: THREE.Vector3): void {
    const W = this.weather;
    const dx = W.drift[0] * W.time;
    const dz = W.drift[1] * W.time;
    // Pattern space: clouds are placed on a grid that drifts with the steering flow.
    const px = cam.x - dx;
    const pz = cam.z - dz;
    let n = 0;
    this.builtAt = W.time;
    /** Add a puff at a world position. */
    const push = (x: number, y: number, z: number, size: number, alpha: number, shade: number) => {
      if (n >= MAX_PUFFS) return;
      this.offsets[n * 3] = x;
      this.offsets[n * 3 + 1] = y;
      this.offsets[n * 3 + 2] = z;
      this.params[n * 4] = size;
      this.params[n * 4 + 1] = alpha;
      this.params[n * 4 + 2] = shade;
      this.params[n * 4 + 3] = hash2(Math.round(x), Math.round(z)) * 6.28;
      n++;
    };
    // Storm towers first so they are never squeezed out.
    for (const c of W.cells) {
      if (c.strength < 0.12) continue;
      const d = Math.hypot(c.x - cam.x, c.z - cam.z);
      if (d > 160000) continue;
      const ground = this.world.height(c.x, c.z);
      const base = ground + 900;
      const top = lerp(ground + 3000, c.top, c.strength);
      const rnd = mulberry(c.id * 7919);
      const r = c.radius * (0.6 + 0.4 * c.strength);
      const count = d > 60000 ? 40 : 90;
      for (let k = 0; k < count; k++) {
        const t = Math.pow(rnd(), 0.8);
        const y = base + t * (top - base) * 0.92;
        const rr = r * (0.9 - 0.35 * t) * Math.sqrt(rnd());
        const a = rnd() * Math.PI * 2;
        push(c.x + Math.cos(a) * rr, y, c.z + Math.sin(a) * rr, 1500 + rnd() * 1800 * (1 - t * 0.4), 0.9, 0.15 + t * 0.85);
      }
      // Anvil spreading downwind at the tropopause in mature storms.
      if (c.stage !== 'growing') {
        const ang = Math.atan2(c.vz, c.vx);
        for (let k = 0; k < 30; k++) {
          const along = rnd() * r * 3.2;
          const across = (rnd() - 0.5) * r * (1.4 + along / r);
          push(c.x + Math.cos(ang) * along - Math.sin(ang) * across, top - 300 - rnd() * 700, c.z + Math.sin(ang) * along + Math.cos(ang) * across,
            2600 + rnd() * 2400, 0.75 * c.strength, 0.95);
        }
      }
    }
    // Fair-weather cumulus field.
    const i0 = Math.floor((px - CU_RADIUS) / CU_CELL);
    const i1 = Math.floor((px + CU_RADIUS) / CU_CELL);
    const j0 = Math.floor((pz - CU_RADIUS) / CU_CELL);
    const j1 = Math.floor((pz + CU_RADIUS) / CU_CELL);
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const cx = (i + 0.5) * CU_CELL;
        const cz = (j + 0.5) * CU_CELL;
        if (Math.hypot(cx - px, cz - pz) > CU_RADIUS) continue;
        const h = hash2(i, j);
        const wx = cx + dx;
        const wz = cz + dz;
        const ground = this.world.height(wx, wz);
        const layer = W.layersAt(wx, wz, ground).find((l) => l.type === 'cu');
        if (!layer || h > layer.cover * 1.1) continue;
        const rnd = mulberry(i * 73856093 ^ j * 19349663);
        const thick = layer.top - layer.base;
        const size = 350 + layer.cover * 500;
        const count = 4 + Math.floor(rnd() * 6 + layer.cover * 6);
        const ox = cx + (rnd() - 0.5) * CU_CELL * 0.6;
        const oz = cz + (rnd() - 0.5) * CU_CELL * 0.6;
        for (let k = 0; k < count; k++) {
          const t = rnd();
          const spread = size * (1.2 - t * 0.6);
          push(ox + dx + (rnd() - 0.5) * spread * 2, layer.base + t * thick * 0.8 + size * 0.3, oz + dz + (rnd() - 0.5) * spread * 2,
            size * (0.8 + rnd() * 0.6), 0.85, 0.25 + t * 0.75);
        }
      }
    }
    this.puffGeo.instanceCount = n;
    (this.puffGeo.getAttribute('aOffset') as THREE.InstancedBufferAttribute).needsUpdate = true;
    (this.puffGeo.getAttribute('aParams') as THREE.InstancedBufferAttribute).needsUpdate = true;

    // Rain shafts below storms.
    for (const s of this.shafts) {
      this.group.remove(s);
      s.geometry.dispose();
    }
    this.shafts = [];
    for (const c of W.cells) {
      if (c.strength < 0.35 || c.peak < 45) continue;
      if (Math.hypot(c.x - cam.x, c.z - cam.z) > 120000) continue;
      const ground = this.world.height(c.x, c.z);
      const geo = new THREE.CylinderGeometry(c.radius * 0.55, c.radius * 0.8, 1000, 20, 1, true);
      geo.translate(0, 500, 0);
      const m = new THREE.Mesh(geo, this.shaftMat);
      m.position.set(c.x, ground - 50, c.z);
      m.frustumCulled = false;
      m.userData.cell = c;
      m.renderOrder = 6;
      this.group.add(m);
      this.shafts.push(m);
    }
  }

  private updateDecks(cam: THREE.Vector3, layers: CloudLayer[], light: { sun: THREE.Color; amb: THREE.Color; fogCol: THREE.Color; fog: number; day: number }): void {
    const W = this.weather;
    const decks = layers.filter((l) => l.type === 'st' || l.type === 'ac' || l.type === 'ci' || (l.type === 'cu' && l.cover > 0.7));
    for (let i = 0; i < this.decks.length; i++) {
      const d = this.decks[i];
      const l = decks[i];
      d.mesh.visible = !!l;
      if (!l) continue;
      const u = d.uniforms;
      const thin = l.type === 'ci' ? 0.45 : l.type === 'ac' ? 0.85 : 1;
      u.uCover.value = clamp(l.cover, 0, 1);
      u.uScale.value = l.type === 'ci' ? 14000 : l.type === 'ac' ? 3500 : 7000;
      u.uAlpha.value = (l.type === 'ci' ? 0.5 : 0.97) * thin;
      u.uFog.value = light.fog;
      (u.uFogCol.value as THREE.Color).copy(light.fogCol);
      const below = (u.uColBelow.value as THREE.Color).copy(light.amb).multiplyScalar(l.type === 'st' ? 0.75 : 0.9).add(light.sun.clone().multiplyScalar(0.12));
      if (l.cover > 0.85) below.multiplyScalar(0.85);
      (u.uColAbove.value as THREE.Color).copy(light.amb).add(light.sun);
      (u.uOffset.value as THREE.Vector2).set(W.drift[0] * W.time, W.drift[1] * W.time);
      (u.uCenter.value as THREE.Vector2).set(cam.x, cam.z);
      // Seen from below we look at the base; from above at the top.
      const y = cam.y < (l.base + l.top) / 2 ? l.base : l.top;
      d.mesh.position.set(cam.x, y, cam.z);
    }
  }

  update(dt: number, simTime: number, cam: THREE.Vector3, camVel: THREE.Vector3, light: { sunDir: THREE.Vector3; sun: THREE.Color; amb: THREE.Color; fogCol: THREE.Color; fog: number; day: number }, flash: (k: number) => void): void {
    const W = this.weather;
    this.rebuildTimer -= dt;
    if (this.rebuildTimer <= 0 || this.puffGeo.instanceCount === 0) {
      this.rebuildTimer = 8;
      this.rebuild(cam);
    }
    const u = this.puffUniforms;
    (u.uSunCol.value as THREE.Color).copy(light.sun);
    (u.uAmb.value as THREE.Color).copy(light.amb);
    (u.uFogCol.value as THREE.Color).copy(light.fogCol);
    (u.uSunDir.value as THREE.Vector3).copy(light.sunDir);
    u.uFog.value = light.fog;
    // Puff offsets were written in world space at rebuild time; shift them with the drift since then.
    (u.uDrift.value as THREE.Vector3).set(W.drift[0] * (W.time - this.builtAt), 0, W.drift[1] * (W.time - this.builtAt));
    const ground = this.world.height(cam.x, cam.z);
    this.updateDecks(cam, W.layersAt(cam.x, cam.z, ground), light);
    const sm = this.shaftMat.uniforms;
    (sm.uFogCol.value as THREE.Color).copy(light.fogCol);
    sm.uFog.value = light.fog;
    (sm.uCol.value as THREE.Color).setRGB(0.36, 0.4, 0.46).multiplyScalar(0.3 + 0.7 * light.day);
    for (const s of this.shafts) {
      const c = s.userData.cell as { x: number; z: number; strength: number };
      s.position.x = c.x;
      s.position.z = c.z;
      const top = this.world.height(c.x, c.z) + 900;
      s.scale.y = (top - s.position.y) / 1000;
    }

    // Rain streaks in a box around the camera, drawn along the relative airflow.
    const precip = W.sample(cam.x, cam.z, cam.y, ground).precip;
    this.rain.visible = precip > 0.15;
    if (this.rain.visible) {
      const N = this.rainPos.length / 6;
      const active = Math.min(N, Math.floor(N * clamp(precip / 12, 0.15, 1)));
      const box = 70;
      const fall = new THREE.Vector3(0, -8.5, 0).sub(camVel);
      const len = clamp(fall.length() * 0.035, 0.6, 5);
      fall.normalize().multiplyScalar(len);
      for (let k = 0; k < N; k++) {
        const o = k * 6;
        if (k >= active) {
          this.rainPos.fill(0, o, o + 6);
          continue;
        }
        const s = k * 3;
        const x = cam.x + (((this.rainSeed[s] * 9973 - cam.x) % box) + box) % box - box / 2;
        const z = cam.z + (((this.rainSeed[s + 2] * 7919 - cam.z) % box) + box) % box - box / 2;
        const y = cam.y + ((((this.rainSeed[s + 1] * box * 37 - simTime * 8.5 - cam.y) % box) + box) % box) - box / 2;
        this.rainPos[o] = x;
        this.rainPos[o + 1] = y;
        this.rainPos[o + 2] = z;
        this.rainPos[o + 3] = x + fall.x;
        this.rainPos[o + 4] = y + fall.y;
        this.rainPos[o + 5] = z + fall.z;
      }
      (this.rain.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
      (this.rain.material as THREE.LineBasicMaterial).opacity = 0.18 + 0.25 * smoothstep(0, 1, light.day + 0.2);
    }

    // Lightning.
    this.newStrikes = [];
    for (const s of W.strikes) {
      const key = `${s.cell}:${s.t.toFixed(3)}`;
      if (this.seenStrikes.has(key)) continue;
      this.seenStrikes.add(key);
      const d = Math.hypot(s.x - cam.x, s.z - cam.z);
      if (d > 150000) continue;
      this.newStrikes.push({ dist: Math.hypot(d, cam.y - (s.cloudToGround ? 0 : s.y)), cg: s.cloudToGround });
      flash(clamp(1.4 - d / 40000, 0.05, 1));
      if (s.cloudToGround || d < 40000) this.addBolt(s.x, s.z, s.cloudToGround ? this.world.height(s.x, s.z) : s.y - 1500, s.cloudToGround ? 4500 : s.y + 500, simTime);
    }
    if (this.seenStrikes.size > 400) this.seenStrikes = new Set([...this.seenStrikes].slice(-100));
    for (let i = this.bolts.length - 1; i >= 0; i--) {
      const b = this.bolts[i];
      const mat = b.line.material as THREE.LineBasicMaterial;
      const left = b.until - simTime;
      mat.opacity = left > 0 ? (Math.sin(left * 60) > -0.3 ? 1 : 0.2) : 0;
      if (left <= 0) {
        this.group.remove(b.line);
        b.line.geometry.dispose();
        mat.dispose();
        this.bolts.splice(i, 1);
      }
    }
  }

  private builtAt = 0;

  private addBolt(x: number, z: number, y0: number, y1: number, now: number): void {
    const pts: THREE.Vector3[] = [];
    let px = x;
    let pz = z;
    const segs = 24;
    for (let k = 0; k <= segs; k++) {
      const y = lerp(y1, y0, k / segs);
      pts.push(new THREE.Vector3(px, y, pz));
      px += (Math.random() - 0.5) * 380;
      pz += (Math.random() - 0.5) * 380;
    }
    const geo = new THREE.BufferGeometry().setFromPoints(pts);
    const line = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: 0xe8eeff, transparent: true, opacity: 1, depthWrite: false }));
    line.frustumCulled = false;
    line.renderOrder = 9;
    this.group.add(line);
    this.bolts.push({ line, until: now + 0.35 });
  }

  /** Force a rebuild (e.g. after the weather preset changes). */
  invalidate(): void {
    this.rebuildTimer = 0;
  }

  get puffCount(): number {
    return this.puffGeo.instanceCount;
  }
}
