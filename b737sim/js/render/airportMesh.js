// Airport scenery: runways with markings, taxiways, apron, buildings, lights, PAPI and nearby city blocks.
import * as THREE from '../vendor/three.module.min.js';
import { dirOf, DEG } from '../math.js';
import { taxiwayLayout } from '../terrain.js';

let glowTexture = null;
export function getGlowTexture() {
  if (glowTexture) return glowTexture;
  const s = 64;
  const cv = document.createElement('canvas');
  cv.width = cv.height = s;
  const g = cv.getContext('2d');
  const grd = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  grd.addColorStop(0, 'rgba(255,255,255,1)');
  grd.addColorStop(0.18, 'rgba(255,255,255,0.85)');
  grd.addColorStop(0.45, 'rgba(255,255,255,0.18)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, s, s);
  glowTexture = new THREE.CanvasTexture(cv);
  return glowTexture;
}

function asphaltTexture(light = false) {
  const s = 256;
  const cv = document.createElement('canvas');
  cv.width = cv.height = s;
  const g = cv.getContext('2d');
  g.fillStyle = light ? '#8d8d88' : '#3b3c3e';
  g.fillRect(0, 0, s, s);
  const img = g.getImageData(0, 0, s, s);
  for (let i = 0; i < img.data.length; i += 4) {
    const n = (Math.random() - 0.5) * (light ? 26 : 22);
    img.data[i] += n;
    img.data[i + 1] += n;
    img.data[i + 2] += n;
  }
  g.putImageData(img, 0, 0);
  if (!light) {
    // Rubber deposits / patches.
    for (let k = 0; k < 30; k++) {
      g.fillStyle = `rgba(${20 + Math.random() * 20},${20 + Math.random() * 20},${22 + Math.random() * 20},0.25)`;
      g.fillRect(Math.random() * s, Math.random() * s, 10 + Math.random() * 60, 4 + Math.random() * 30);
    }
  } else {
    g.strokeStyle = 'rgba(60,60,60,0.35)';
    for (let k = 0; k <= s; k += 32) {
      g.beginPath(); g.moveTo(k, 0); g.lineTo(k, s); g.stroke();
      g.beginPath(); g.moveTo(0, k); g.lineTo(s, k); g.stroke();
    }
  }
  const t = new THREE.CanvasTexture(cv);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

function numberTexture(text) {
  const cv = document.createElement('canvas');
  cv.width = 256;
  cv.height = 256;
  const g = cv.getContext('2d');
  g.clearRect(0, 0, 256, 256);
  g.fillStyle = '#f2f2ee';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  const num = text.replace(/[LRC]$/, '');
  const suffix = text.slice(num.length);
  g.font = 'bold 120px Arial Narrow, Arial, sans-serif';
  if (suffix) {
    g.fillText(num, 128, 60);
    g.fillText(suffix, 128, 185);
  } else {
    g.fillText(num, 128, 128);
  }
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

/** Collect flat quads (in local airport frame) into one geometry. */
class QuadBatch {
  constructor() {
    this.pos = [];
    this.uv = [];
    this.idx = [];
  }
  /** Rectangle centred at (x,z) with heading (deg), length along heading, width across. */
  add(x, y, z, heading, length, width, uvScale = 0) {
    const d = dirOf(heading);
    const r = [-d[2], 0, d[0]];
    const hl = length / 2;
    const hw = width / 2;
    const base = this.pos.length / 3;
    const pts = [
      [x - d[0] * hl - r[0] * hw, z - d[2] * hl - r[2] * hw],
      [x - d[0] * hl + r[0] * hw, z - d[2] * hl + r[2] * hw],
      [x + d[0] * hl + r[0] * hw, z + d[2] * hl + r[2] * hw],
      [x + d[0] * hl - r[0] * hw, z + d[2] * hl - r[2] * hw],
    ];
    for (const [px, pz] of pts) {
      this.pos.push(px, y, pz);
      if (uvScale) this.uv.push(px / uvScale, pz / uvScale);
      else this.uv.push(0, 0);
    }
    this.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  build() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    const n = new Float32Array(this.pos.length);
    for (let i = 1; i < n.length; i += 3) n[i] = 1;
    g.setAttribute('normal', new THREE.BufferAttribute(n, 3));
    g.setIndex(this.idx);
    g.computeBoundingSphere();
    return g;
  }
}

class LightBatch {
  constructor() {
    this.pos = [];
    this.col = [];
  }
  add(x, y, z, r, g, b) {
    this.pos.push(x, y, z);
    this.col.push(r, g, b);
  }
  build(size) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    const mat = new THREE.PointsMaterial({
      size, sizeAttenuation: false, map: getGlowTexture(), vertexColors: true, transparent: true,
      depthWrite: false, blending: THREE.AdditiveBlending, fog: false,
    });
    const pts = new THREE.Points(geo, mat);
    pts.frustumCulled = false;
    return pts;
  }
}

const WHITE = [1, 0.95, 0.8];
const YELLOW = [1, 0.75, 0.2];
const GREEN = [0.2, 1, 0.35];
const RED = [1, 0.12, 0.08];
const BLUE = [0.25, 0.4, 1];

export class AirportScenery {
  constructor(airport, terrain) {
    this.airport = airport;
    this.group = new THREE.Group();
    this.lightGroups = [];
    this.flashers = [];
    this.papis = [];
    const e = airport.elevM;
    const asphalt = new THREE.MeshLambertMaterial({ map: asphaltTexture(false) });
    const concrete = new THREE.MeshLambertMaterial({ map: asphaltTexture(true) });
    const white = new THREE.MeshLambertMaterial({ color: 0xe8e8e2 });
    const yellow = new THREE.MeshLambertMaterial({ color: 0xd2a82a });
    for (const m of [asphalt, concrete]) {
      m.polygonOffset = true;
    }

    const runways = new QuadBatch();
    const marks = new QuadBatch();
    const taxi = new QuadBatch();
    const taxiMarks = new QuadBatch();
    const apronQ = new QuadBatch();
    const lights = new LightBatch();
    const taxiLights = new LightBatch();
    const approach = new LightBatch();

    for (const rw of airport.runways) {
      const d = dirOf(rw.heading);
      const r = [-d[2], 0, d[0]];
      runways.add(rw.cx, e + 0.12, rw.cz, rw.heading, rw.length + 60, rw.width + 6, 60);
      const L = rw.length;
      const W = rw.width;
      // Centerline dashes: 36 m stripe, 24 m gap.
      for (let s = -L / 2 + 120; s < L / 2 - 120; s += 60) {
        marks.add(rw.cx + d[0] * s, e + 0.2, rw.cz + d[2] * s, rw.heading, 36, 0.9);
      }
      // Side stripes.
      for (const side of [-1, 1]) {
        const off = W / 2 - 1.2;
        marks.add(rw.cx + r[0] * off * side, e + 0.2, rw.cz + r[2] * off * side, rw.heading, L - 10, 0.9);
      }
      // Lights along the runway.
      for (let s = -L / 2; s <= L / 2; s += 60) {
        for (const side of [-1, 1]) {
          const lx = rw.cx + d[0] * s + r[0] * (W / 2 + 1.5) * side;
          const lz = rw.cz + d[2] * s + r[2] * (W / 2 + 1.5) * side;
          lights.add(lx, e + 0.6, lz, ...WHITE);
        }
      }
      for (let s = -L / 2 + 15; s < L / 2; s += 30) {
        const fromEnd = Math.min(s + L / 2, L / 2 - s);
        const c = fromEnd < 300 ? RED : fromEnd < 900 && Math.round(s / 30) % 2 ? RED : WHITE;
        lights.add(rw.cx + d[0] * s, e + 0.3, rw.cz + d[2] * s, c[0] * 0.8, c[1] * 0.8, c[2] * 0.8);
      }

      for (const end of rw.ends) {
        const ed = dirOf(end.heading);
        const er = [-ed[2], 0, ed[0]];
        const tx = end.tx;
        const tz = end.tz;
        // Threshold piano keys.
        const keys = W > 50 ? 16 : 12;
        const keyW = 1.8;
        const spread = W - 6;
        for (let k = 0; k < keys; k++) {
          const across = -spread / 2 + (k + 0.5) * (spread / keys);
          if (Math.abs(across) < 3) continue;
          const cx = tx + ed[0] * 30 + er[0] * across;
          const cz = tz + ed[2] * 30 + er[2] * across;
          marks.add(cx, e + 0.2, cz, end.heading, 45, keyW);
        }
        // Threshold bar.
        marks.add(tx + ed[0] * 3, e + 0.2, tz + ed[2] * 3, end.heading, 3, W - 2);
        // Aiming point (300 m) and touchdown zone markings.
        for (const side of [-1, 1]) {
          const off = W / 2 - 10;
          marks.add(tx + ed[0] * 400 + er[0] * off * side, e + 0.2, tz + ed[2] * 400 + er[2] * off * side, end.heading, 45, 9);
          for (const [dist, n] of [[150, 3], [300, 3], [450, 2], [600, 2], [750, 1], [900, 1]]) {
            for (let k = 0; k < n; k++) {
              const o = off - 1 - k * 3.2;
              marks.add(tx + ed[0] * dist + er[0] * o * side, e + 0.2, tz + ed[2] * dist + er[2] * o * side, end.heading, 22, 1.8);
            }
          }
        }
        // Runway designation.
        const numMat = new THREE.MeshLambertMaterial({ map: numberTexture(end.id), transparent: true, depthWrite: false });
        const num = new THREE.Mesh(new THREE.PlaneGeometry(18, 36), numMat);
        // Text "up" points along the landing direction.
        num.quaternion.setFromEuler(new THREE.Euler(-Math.PI / 2, 0, 0)).premultiply(
          new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -end.heading * DEG),
        );
        num.position.set(tx + ed[0] * 95, e + 0.22, tz + ed[2] * 95);
        this.group.add(num);
        // Threshold (green, seen from approach) and end (red) lights.
        for (let a = -W / 2 - 4; a <= W / 2 + 4; a += 3) {
          lights.add(tx + er[0] * a - ed[0] * 1, e + 0.5, tz + er[2] * a - ed[2] * 1, ...GREEN);
        }
        for (let a = -W / 2; a <= W / 2; a += 4) {
          lights.add(tx + er[0] * a + ed[0] * 1, e + 0.5, tz + er[2] * a + ed[2] * 1, RED[0] * 0.6, RED[1] * 0.6, RED[2] * 0.6);
        }
        // Touchdown zone lights.
        for (let s = 60; s <= 900; s += 30) {
          for (const side of [-1, 1]) {
            for (let k = 0; k < 3; k++) {
              const a = (11 + k * 1.5) * side;
              lights.add(tx + ed[0] * s + er[0] * a, e + 0.3, tz + ed[2] * s + er[2] * a, 0.8, 0.78, 0.7);
            }
          }
        }
        // Approach lighting system (ALSF-II style, 900 m).
        const seq = [];
        for (let s = 30; s <= 900; s += 30) {
          const ax = tx - ed[0] * s;
          const az = tz - ed[2] * s;
          const h = Math.max(e + 0.5, terrain.height(ax, az) + 1.5);
          for (let k = -2; k <= 2; k++) approach.add(ax + er[0] * k * 1.0, h, az + er[2] * k * 1.0, ...WHITE);
          if (s === 300) for (let k = -7; k <= 7; k++) approach.add(ax + er[0] * k * 1.5, h, az + er[2] * k * 1.5, ...WHITE);
          if (s <= 300) for (const side of [-1, 1]) for (let k = 0; k < 3; k++) approach.add(ax + er[0] * (4 + k * 1.5) * side, h, az + er[2] * (4 + k * 1.5) * side, ...RED);
          if (s >= 330) seq.push([ax, h + 0.5, az]);
        }
        // Sequenced flashers ("the rabbit").
        if (seq.length) {
          const geo = new THREE.BufferGeometry();
          seq.reverse();
          geo.setAttribute('position', new THREE.Float32BufferAttribute(seq.flat(), 3));
          geo.setAttribute('color', new THREE.Float32BufferAttribute(new Array(seq.length * 3).fill(0), 3));
          const mat = new THREE.PointsMaterial({ size: 14, sizeAttenuation: false, map: getGlowTexture(), vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false });
          const pts = new THREE.Points(geo, mat);
          pts.frustumCulled = false;
          this.group.add(pts);
          this.flashers.push({ pts, n: seq.length });
          this.lightGroups.push(pts);
        }
        // PAPI on the left side abeam the glide slope origin.
        const px = tx + ed[0] * 300 - er[0] * (W / 2 + 15);
        const pz = tz + ed[2] * 300 - er[2] * (W / 2 + 15);
        const pgeo = new THREE.BufferGeometry();
        const ppos = [];
        for (let k = 0; k < 4; k++) ppos.push(px - er[0] * k * 9, e + 0.9, pz - er[2] * k * 9);
        pgeo.setAttribute('position', new THREE.Float32BufferAttribute(ppos, 3));
        pgeo.setAttribute('color', new THREE.Float32BufferAttribute(new Array(12).fill(1), 3));
        const pmat = new THREE.PointsMaterial({ size: 9, sizeAttenuation: false, map: getGlowTexture(), vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false });
        const papi = new THREE.Points(pgeo, pmat);
        papi.frustumCulled = false;
        this.group.add(papi);
        this.papis.push({ pts: papi, x: px, z: pz, y: e + 0.9, end });
        // PAPI housings.
        for (let k = 0; k < 4; k++) {
          const box = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.8, 1.2), new THREE.MeshLambertMaterial({ color: 0x333333 }));
          box.position.set(px - er[0] * k * 9, e + 0.5, pz - er[2] * k * 9);
          this.group.add(box);
        }
      }
    }

    // Taxiways and apron.
    for (const s of taxiwayLayout(airport)) {
      taxi.add(s.x, e + 0.08, s.z, s.heading, s.length + s.width, s.width, 60);
      taxiMarks.add(s.x, e + 0.15, s.z, s.heading, s.length, 0.5);
      const d = dirOf(s.heading);
      const r = [-d[2], 0, d[0]];
      for (let a = -s.length / 2; a <= s.length / 2; a += 45) {
        for (const side of [-1, 1]) {
          taxiLights.add(s.x + d[0] * a + r[0] * (s.width / 2 + 1) * side, e + 0.4, s.z + d[2] * a + r[2] * (s.width / 2 + 1) * side, ...BLUE);
        }
        taxiLights.add(s.x + d[0] * a, e + 0.2, s.z + d[2] * a, GREEN[0] * 0.6, GREEN[1] * 0.6, GREEN[2] * 0.6);
      }
    }
    const ap = airport.apron;
    apronQ.add(ap.x, e + 0.1, ap.z, ap.heading, ap.length, ap.depth, 80);

    const rMesh = new THREE.Mesh(runways.build(), asphalt);
    rMesh.receiveShadow = true;
    const tMesh = new THREE.Mesh(taxi.build(), asphalt);
    tMesh.receiveShadow = true;
    const aMesh = new THREE.Mesh(apronQ.build(), concrete);
    aMesh.receiveShadow = true;
    this.group.add(rMesh, tMesh, aMesh);
    this.group.add(new THREE.Mesh(marks.build(), white));
    this.group.add(new THREE.Mesh(taxiMarks.build(), yellow));

    this.edgeLights = lights.build(6);
    this.taxiLights = taxiLights.build(4);
    this.approachLights = approach.build(7);
    this.group.add(this.edgeLights, this.taxiLights, this.approachLights);
    this.lightGroups.push(this.edgeLights, this.taxiLights, this.approachLights);

    this.buildBuildings(airport, terrain);
    this.buildCity(airport, terrain);
  }

  buildBuildings(airport, terrain) {
    const ap = airport.apron;
    const e = airport.elevM;
    const d = dirOf(ap.heading);
    const r = [-d[2], 0, d[0]];
    const rot = -ap.heading * DEG;
    const glass = new THREE.MeshLambertMaterial({ color: 0x6d8090 });
    const wall = new THREE.MeshLambertMaterial({ color: 0xcfcac0 });
    const roof = new THREE.MeshLambertMaterial({ color: 0x9a9a9a });
    const place = (mesh, along, across, y) => {
      mesh.position.set(ap.x + d[0] * along + r[0] * across, e + y, ap.z + d[2] * along + r[2] * across);
      mesh.rotation.y = rot;
      mesh.castShadow = false;
      mesh.receiveShadow = true;
      this.group.add(mesh);
    };
    // Terminal along the far edge of the apron.
    const tl = ap.length * 0.8;
    const term = new THREE.Mesh(new THREE.BoxGeometry(60, 18, tl), glass);
    // BoxGeometry axes: x across, z along (rotated by heading so z aligns with -d).
    place(term, 0, ap.depth / 2 + 40, 9);
    const termRoof = new THREE.Mesh(new THREE.BoxGeometry(70, 2, tl + 10), roof);
    place(termRoof, 0, ap.depth / 2 + 40, 19);
    // Piers / jet bridges.
    for (let k = -3; k <= 3; k++) {
      const pier = new THREE.Mesh(new THREE.BoxGeometry(40, 5, 4), wall);
      place(pier, k * (tl / 7), ap.depth / 2 - 5, 5);
    }
    // Hangars.
    for (let k = 0; k < 3; k++) {
      const h = new THREE.Mesh(new THREE.BoxGeometry(70, 26, 80), wall);
      place(h, -ap.length / 2 - 60 - k * 95, ap.depth / 2 - 30, 13);
    }
    // Control tower.
    const tw = airport.tower;
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(3.5, 4.5, 55, 12), wall);
    shaft.position.set(tw.x, e + 27.5, tw.z);
    const cab = new THREE.Mesh(new THREE.CylinderGeometry(8, 6.5, 7, 12), glass);
    cab.position.set(tw.x, e + 58.5, tw.z);
    const cap = new THREE.Mesh(new THREE.CylinderGeometry(8.5, 8.5, 1.5, 12), roof);
    cap.position.set(tw.x, e + 62.5, tw.z);
    this.group.add(shaft, cab, cap);
    this.towerTop = new THREE.Vector3(tw.x, e + 60, tw.z);
    // Apron flood lights.
    const flood = new LightBatch();
    for (let k = -3; k <= 3; k++) {
      const x = ap.x + d[0] * k * (ap.length / 7) + r[0] * (ap.depth / 2 - 15);
      const z = ap.z + d[2] * k * (ap.length / 7) + r[2] * (ap.depth / 2 - 15);
      flood.add(x, e + 25, z, 1, 0.85, 0.6);
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.4, 25, 6), roof);
      pole.position.set(x, e + 12.5, z);
      this.group.add(pole);
    }
    const fl = flood.build(9);
    this.group.add(fl);
    this.lightGroups.push(fl);
    void terrain;
  }

  buildCity(airport, terrain) {
    // A few thousand buildings scattered around the airport, avoiding runways and approach paths.
    const rnd = mulberry(airport.icao.charCodeAt(1) * 991 + airport.icao.charCodeAt(3));
    const n = 2600;
    const geo = new THREE.BoxGeometry(1, 1, 1);
    geo.translate(0, 0.5, 0);
    const mat = new THREE.MeshLambertMaterial({ color: 0xffffff });
    const inst = new THREE.InstancedMesh(geo, mat, n);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const s = new THREE.Vector3();
    const p = new THREE.Vector3();
    const color = new THREE.Color();
    const cityLights = new LightBatch();
    let count = 0;
    const cityAngle = rnd() * Math.PI * 2;
    for (let tries = 0; tries < n * 4 && count < n; tries++) {
      // Cluster the city on one side of the field.
      const ang = cityAngle + (rnd() - 0.5) * 2.2;
      const dist = 3500 + Math.pow(rnd(), 0.7) * 11000;
      const x = airport.x + Math.sin(ang) * dist;
      const z = airport.z - Math.cos(ang) * dist;
      if (!clearOfRunways(airport, x, z)) continue;
      const h = terrain.height(x, z);
      if (h < -5 || Math.abs(h - airport.elevM) > 250) continue;
      const core = Math.max(0, 1 - (dist - 3500) / 6000);
      const height = 6 + rnd() * 14 + (rnd() < 0.08 * core ? 40 + rnd() * 110 : 0);
      const w = 14 + rnd() * 30;
      const l = 14 + rnd() * 40;
      p.set(x, h - 1, z);
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), cityAngle + Math.round(rnd() * 3) * Math.PI / 2);
      s.set(w, height, l);
      m.compose(p, q, s);
      inst.setMatrixAt(count, m);
      const shade = 0.55 + rnd() * 0.35;
      color.setRGB(shade, shade * (0.95 + rnd() * 0.05), shade * (0.88 + rnd() * 0.1));
      inst.setColorAt(count, color);
      if (rnd() < 0.7) cityLights.add(x, h + Math.min(height, 15) + 2, z, 1, 0.75 + rnd() * 0.2, 0.45 + rnd() * 0.3);
      count++;
    }
    inst.count = count;
    inst.instanceMatrix.needsUpdate = true;
    if (inst.instanceColor) inst.instanceColor.needsUpdate = true;
    inst.receiveShadow = true;
    this.group.add(inst);
    this.cityLights = cityLights.build(3);
    this.group.add(this.cityLights);
    this.lightGroups.push(this.cityLights);
  }

  /** Update lights (day/night intensity), PAPI colours and sequenced flashers. */
  update(time, camPos, night) {
    const daySize = 1 - night;
    this.edgeLights.material.size = 3 + night * 5;
    this.edgeLights.material.opacity = 0.35 + night * 0.65;
    this.taxiLights.material.size = 2 + night * 3;
    this.taxiLights.material.opacity = 0.2 + night * 0.8;
    this.approachLights.material.size = 4 + night * 5;
    this.approachLights.material.opacity = 0.4 + night * 0.6;
    this.cityLights.visible = night > 0.3;
    this.cityLights.material.opacity = night;
    for (const f of this.flashers) {
      const col = f.pts.geometry.attributes.color;
      const phase = (time * 2) % 1;
      const on = Math.floor(phase * f.n * 1.3);
      for (let i = 0; i < f.n; i++) {
        const v = i === on ? 1 : 0;
        col.setXYZ(i, v, v, v);
      }
      col.needsUpdate = true;
      f.pts.material.size = 10 + night * 10;
    }
    // PAPI: each unit shows white above its transition angle, red below.
    const trans = [3.5, 3.17, 2.83, 2.5];
    for (const p of this.papis) {
      const dx = camPos.x - p.x;
      const dz = camPos.z - p.z;
      const dist = Math.hypot(dx, dz);
      const ang = Math.atan2(camPos.y - p.y, dist) / DEG;
      const col = p.pts.geometry.attributes.color;
      for (let k = 0; k < 4; k++) {
        const w = ang > trans[3 - k];
        col.setXYZ(k, 1, w ? 0.95 : 0.1, w ? 0.85 : 0.06);
      }
      col.needsUpdate = true;
      p.pts.material.size = 7 + night * 4 + daySize * 2;
    }
  }

  dispose() {
    this.group.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) {
        if (o.material.map) o.material.map.dispose();
        o.material.dispose();
      }
    });
  }
}

function clearOfRunways(airport, x, z) {
  for (const rw of airport.runways) {
    const d = dirOf(rw.heading);
    const px = x - rw.cx;
    const pz = z - rw.cz;
    const along = Math.abs(px * d[0] + pz * d[2]);
    const across = Math.abs(px * -d[2] + pz * d[0]);
    if (along < rw.length / 2 + 900 && across < 1200) return false;
    // Approach corridors.
    if (along < rw.length / 2 + 16000 && across < 900 + (along - rw.length / 2) * 0.12) return false;
  }
  return true;
}

function mulberry(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Keeps scenery for airports near the aircraft loaded. */
export class AirportManager {
  constructor(scene, sim) {
    this.scene = scene;
    this.sim = sim;
    this.loaded = new Map();
    this.timer = 0;
  }
  update(dt, acPos, camPos, time, night) {
    this.timer -= dt;
    if (this.timer <= 0) {
      this.timer = 2;
      const want = this.sim.nav.near(acPos.x, acPos.z, 70000);
      for (const a of want) {
        if (!this.loaded.has(a.icao)) {
          const s = new AirportScenery(a, this.sim.terrain);
          this.scene.add(s.group);
          this.loaded.set(a.icao, s);
        }
      }
      for (const [k, s] of this.loaded) {
        if (!want.find((a) => a.icao === k)) {
          this.scene.remove(s.group);
          s.dispose();
          this.loaded.delete(k);
        }
      }
    }
    for (const s of this.loaded.values()) s.update(time, camPos, night);
  }
  towerFor(x, z) {
    let best = null;
    let bd = Infinity;
    for (const s of this.loaded.values()) {
      const d = Math.hypot(s.towerTop.x - x, s.towerTop.z - z);
      if (d < bd) {
        bd = d;
        best = s.towerTop;
      }
    }
    return best;
  }
}

