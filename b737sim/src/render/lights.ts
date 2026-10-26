// Point lights for airports and cities, drawn as one Points object per batch. A small shader
// handles what real fixtures do: directional / bi-coloured lenses (threshold green one way,
// runway-end red the other), PAPI colour by viewing angle, sequenced flashers, REILs,
// rotating beacons, obstruction lights, and fading in fog and daylight.
import * as THREE from 'three';
import { getGlowTexture } from './textures.ts';

export type RGB = readonly [number, number, number];
export const WHITE: RGB = [1, 0.93, 0.78];
export const YELLOW: RGB = [1, 0.78, 0.25];
export const GREEN: RGB = [0.25, 1, 0.45];
export const RED: RGB = [1, 0.12, 0.06];
export const BLUE: RGB = [0.3, 0.45, 1];
export const OFF: RGB = [0, 0, 0];

/** Light behaviours understood by the shader. */
export const FX = { STEADY: 0, SEQUENCED: 1, REIL: 2, PAPI: 3, BEACON: 4, OBSTRUCTION: 5 } as const;

export interface LightSpec {
  /** Colour seen from in front (the `facing` side), and from behind for bi-directional lights. */
  color: RGB;
  back?: RGB;
  /** True heading the lens faces (towards the observer), or undefined for omnidirectional. */
  facing?: number;
  /** Half-width of the beam in degrees for unidirectional lights (default 75). */
  beam?: number;
  size?: number;
  /** 0..1 how visible the light is in daylight (approach lights are bright, taxiway lights are not). */
  day?: number;
  fx?: number;
  /** Flasher phase (0..1), or the PAPI/VASI transition angle in degrees. */
  param?: number;
}

const VS = `
#include <common>
#include <logdepthbuf_pars_vertex>
attribute vec3 aCol;
attribute vec3 aBack;
attribute vec4 aDir;  // facing x, facing z, cos(beam), directional flag
attribute vec4 aFx;   // kind, param, day visibility, size
uniform float uScale, uTime, uFog, uNight;
varying vec3 vCol;
varying float vA;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * viewMatrix * wp;
  vec3 toCam = cameraPosition - wp.xyz;
  float dist = length(toCam);
  vec3 col = aCol;
  float a = 1.0;
  if (aDir.w > 0.5) {
    float f = dot(normalize(toCam.xz + 1e-4), aDir.xy);
    if (f < 0.0) { col = aBack; f = -f; }
    a *= smoothstep(aDir.z - 0.15, aDir.z + 0.1, f);
  }
  int kind = int(aFx.x + 0.5);
  if (kind == 1) {
    // Sequenced flasher ("rabbit"): a 20 ms burst twice a second running towards the runway.
    a *= step(fract(uTime * 2.0 - aFx.y), 0.07) * 2.5;
  } else if (kind == 2) {
    a *= step(fract(uTime * 1.0 + aFx.y), 0.05) * 2.5;
  } else if (kind == 3) {
    float ang = degrees(atan(toCam.y, length(toCam.xz)));
    col = ang > aFx.y ? vec3(1.0, 0.95, 0.85) : vec3(1.0, 0.1, 0.05);
  } else if (kind == 4) {
    a *= smoothstep(0.1, 0.0, abs(fract(uTime * 0.45 + aFx.y) - 0.05)) * 2.0;
  } else if (kind == 5) {
    a *= 0.35 + 0.65 * smoothstep(0.2, 0.5, fract(uTime * 0.5 + aFx.y)) * smoothstep(1.0, 0.7, fract(uTime * 0.5 + aFx.y));
  }
  a *= mix(aFx.z, 1.0, uNight);
  // Lights punch through haze further than unlit surfaces.
  float fog = exp(-uFog * uFog * dist * dist * 0.35);
  vA = a * fog;
  vCol = col;
  gl_PointSize = vA < 0.004 ? 0.0 : aFx.w * uScale * (0.55 + 0.45 * fog) * mix(0.75, 1.0, uNight);
  #include <logdepthbuf_vertex>
}`;

const FS = `
#include <common>
#include <logdepthbuf_pars_fragment>
uniform sampler2D uMap;
varying vec3 vCol;
varying float vA;
void main() {
  #include <logdepthbuf_fragment>
  vec4 t = texture2D(uMap, gl_PointCoord);
  gl_FragColor = vec4(vCol * t.rgb, t.a * min(vA, 2.5));
}`;

/** Shared uniforms so one per-frame update drives every light batch. */
export const lightUniforms = {
  uScale: { value: 1 },
  uTime: { value: 0 },
  uFog: { value: 0 },
  uNight: { value: 0 },
  uMap: { value: null as THREE.Texture | null },
};

let material: THREE.ShaderMaterial | null = null;
function lightMaterial(): THREE.ShaderMaterial {
  if (material) return material;
  lightUniforms.uMap.value = getGlowTexture();
  material = new THREE.ShaderMaterial({
    vertexShader: VS, fragmentShader: FS, uniforms: lightUniforms,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  });
  return material;
}

export class LightBatch {
  private pos: number[] = [];
  private col: number[] = [];
  private back: number[] = [];
  private dir: number[] = [];
  private fx: number[] = [];

  get count(): number {
    return this.pos.length / 3;
  }

  add(x: number, y: number, z: number, s: LightSpec): void {
    this.pos.push(x, y, z);
    this.col.push(...s.color);
    this.back.push(...(s.back ?? OFF));
    if (s.facing === undefined) {
      this.dir.push(0, 0, -1, 0);
    } else {
      const h = (s.facing * Math.PI) / 180;
      this.dir.push(Math.sin(h), -Math.cos(h), Math.cos(((s.beam ?? 75) * Math.PI) / 180), 1);
    }
    this.fx.push(s.fx ?? FX.STEADY, s.param ?? 0, s.day ?? 0.15, s.size ?? 6);
  }

  build(): THREE.Points | null {
    if (!this.count) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('aCol', new THREE.Float32BufferAttribute(this.col, 3));
    g.setAttribute('aBack', new THREE.Float32BufferAttribute(this.back, 3));
    g.setAttribute('aDir', new THREE.Float32BufferAttribute(this.dir, 4));
    g.setAttribute('aFx', new THREE.Float32BufferAttribute(this.fx, 4));
    g.computeBoundingSphere();
    const p = new THREE.Points(g, lightMaterial());
    p.frustumCulled = false;
    p.renderOrder = 5;
    return p;
  }
}

/** Per-frame update of all light batches. */
export function updateLights(time: number, night: number, fogDensity: number, pixelScale: number): void {
  lightUniforms.uTime.value = time;
  lightUniforms.uNight.value = night;
  lightUniforms.uFog.value = fogDensity;
  lightUniforms.uScale.value = pixelScale;
}
