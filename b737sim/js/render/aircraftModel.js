// Procedural Boeing 737-900 model with animated control surfaces, gear and lights.
// Model frame matches the flight model body frame: +x nose, +y up, +z right wing.
import * as THREE from '../vendor/three.module.min.js';
import { DEG, clamp } from '../math.js';
import { getGlowTexture } from './airportMesh.js';

const NOSE_X = 19.5;
const TAIL_X = -22.6;
const LEN = NOSE_X - TAIL_X;

/** Fuselage cross-section at station x: top, bottom (y) and half width. */
function section(x) {
  if (x >= 13) {
    const s = clamp((NOSE_X - x) / 6.5, 0, 1);
    const fv = Math.sqrt(Math.max(0, 1 - Math.pow(1 - s, 2.3)));
    const fw = Math.sqrt(Math.max(0, 1 - Math.pow(1 - s, 2.1)));
    return { top: -0.5 + 2.5 * fv, bot: -0.5 - 1.5 * fv, w: 1.88 * fw };
  }
  if (x <= -11) {
    const s = clamp((x - TAIL_X) / 11.6, 0, 1);
    const u = 1 - s;
    return { top: 2.0 - 0.6 * Math.pow(u, 1.5), bot: -2.0 + 3.0 * Math.pow(u, 0.9), w: 1.88 * (0.1 + 0.9 * Math.pow(s, 0.8)) };
  }
  return { top: 2.0, bot: -2.0, w: 1.88 };
}

function fuselageGeometry() {
  const stations = [];
  for (let i = 0; i <= 40; i++) stations.push(NOSE_X - 6.5 * (1 - Math.cos((i / 40) * Math.PI / 2)));
  for (let x = 12.5; x > -11; x -= 1.5) stations.push(x);
  for (let i = 0; i <= 30; i++) stations.push(-11 - 11.6 * (i / 30));
  const seg = 48;
  const pos = [];
  const uv = [];
  const idx = [];
  for (let k = 0; k < stations.length; k++) {
    const x = stations[k];
    const s = section(x);
    const yc = (s.top + s.bot) / 2;
    const h = (s.top - s.bot) / 2;
    for (let j = 0; j <= seg; j++) {
      const th = (j / seg) * Math.PI * 2;
      // Slightly squarer lower lobe.
      const c = Math.cos(th);
      const hh = c < 0 ? h * (1 + 0.04 * Math.sin(th) ** 2) : h;
      pos.push(x, yc + hh * c, s.w * Math.sin(th));
      uv.push((x - TAIL_X) / LEN, j / seg);
    }
  }
  const row = seg + 1;
  for (let k = 0; k < stations.length - 1; k++) {
    for (let j = 0; j < seg; j++) {
      const a = k * row + j;
      const b = a + 1;
      const c = a + row;
      const d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** Livery texture: u along the fuselage (tail -> nose), v around (0 = top, 0.25 right, 0.5 belly, 0.75 left). */
function liveryTextures() {
  const W = 4096;
  const H = 512;
  const cv = document.createElement('canvas');
  cv.width = W;
  cv.height = H;
  const g = cv.getContext('2d');
  const em = document.createElement('canvas');
  em.width = W;
  em.height = H;
  const ge = em.getContext('2d');
  ge.fillStyle = '#000';
  ge.fillRect(0, 0, W, H);
  const X = (x) => ((x - TAIL_X) / LEN) * W;
  const V = (deg) => (deg / 360) * H;
  // Base colours.
  g.fillStyle = '#f4f5f7';
  g.fillRect(0, 0, W, H);
  // Belly.
  g.fillStyle = '#c3c8cf';
  g.fillRect(0, V(122), W, V(116));
  // Cheat lines below the windows.
  for (const [a, b] of [[100, 112], [248, 260]]) {
    g.fillStyle = '#16325c';
    g.fillRect(X(-19), V(a), X(19.4) - X(-19), V(b - a));
  }
  for (const [a, b] of [[113, 116], [244, 247]]) {
    g.fillStyle = '#d6202c';
    g.fillRect(X(-18), V(a), X(19.2) - X(-18), V(b - a));
  }
  // Tail cone in fin colour.
  g.fillStyle = '#16325c';
  g.beginPath();
  g.moveTo(X(-22.6), 0);
  g.lineTo(X(-14), 0);
  g.lineTo(X(-18), H);
  g.lineTo(X(-22.6), H);
  g.closePath();
  g.globalAlpha = 0.0;
  g.fill();
  g.globalAlpha = 1;
  // Passenger windows: right side ~66 deg, left ~294 deg.
  const winPitch = 0.508;
  for (const side of [66, 294]) {
    for (let x = -15.6; x < 12.6; x += winPitch) {
      if (Math.abs(x - 1.2) < 0.3 || Math.abs(x - 0.0) < 0.3) continue; // overwing exits gap
      const wx = X(x);
      const wy = V(side);
      g.fillStyle = '#1b2430';
      g.beginPath();
      g.ellipse(wx, wy, 6, 8, 0, 0, Math.PI * 2);
      g.fill();
      ge.fillStyle = '#ffd99a';
      ge.beginPath();
      ge.ellipse(wx, wy, 5, 7, 0, 0, Math.PI * 2);
      ge.fill();
    }
    // Doors.
    g.strokeStyle = '#9aa1aa';
    g.lineWidth = 2;
    for (const [dx, dw] of [[14.6, 0.86], [-16.6, 0.8], [1.0, 0.5], [0.0, 0.5]]) {
      g.strokeRect(X(dx - dw / 2), V(side - 12), X(dw) - X(0), V(26));
    }
  }
  // Cockpit windows (dark band on the nose).
  g.fillStyle = '#121820';
  for (const side of [1, -1]) {
    const c = side > 0 ? 0 : 360;
    const poly = [
      [18.65, c + side * 4], [18.25, c + side * 30], [17.55, c + side * 54], [16.85, c + side * 70],
      [16.6, c + side * 62], [17.25, c + side * 44], [17.85, c + side * 22], [18.25, c + side * 3],
    ];
    g.beginPath();
    poly.forEach(([x, d], i) => (i ? g.lineTo(X(x), V(d)) : g.moveTo(X(x), V(d))));
    g.closePath();
    g.fill();
  }
  // Frames between cockpit windows.
  g.strokeStyle = '#e8e8e8';
  g.lineWidth = 3;
  for (const d of [3, 30, 52, 357, 330, 308]) {
    g.beginPath();
    g.moveTo(X(18.7), V(d));
    g.lineTo(X(16.7), V(d + (d < 180 ? 8 : -8)));
    g.stroke();
  }
  // Titles.
  g.font = 'bold 52px Arial, sans-serif';
  g.fillStyle = '#16325c';
  g.textBaseline = 'middle';
  g.save();
  g.translate(X(4), V(44));
  g.fillText('SKYLINE', 0, 0);
  g.restore();
  g.save();
  g.translate(X(4), V(316));
  g.rotate(Math.PI);
  g.fillText('SKYLINE', -g.measureText('SKYLINE').width, 0);
  g.restore();
  g.font = 'bold 18px Arial, sans-serif';
  g.fillStyle = '#555';
  g.fillText('N739SK', X(-15), V(96));
  const tex = new THREE.CanvasTexture(cv);
  tex.flipY = false;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  const etex = new THREE.CanvasTexture(em);
  etex.flipY = false;
  etex.colorSpace = THREE.SRGBColorSpace;
  return { tex, etex };
}

function finTexture() {
  const cv = document.createElement('canvas');
  cv.width = 512;
  cv.height = 512;
  const g = cv.getContext('2d');
  g.fillStyle = '#16325c';
  g.fillRect(0, 0, 512, 512);
  g.fillStyle = '#d6202c';
  g.beginPath();
  g.moveTo(0, 360);
  g.lineTo(512, 250);
  g.lineTo(512, 290);
  g.lineTo(0, 400);
  g.fill();
  // Logo: stylised swoosh.
  g.fillStyle = '#f4f5f7';
  g.beginPath();
  g.arc(256, 190, 90, Math.PI * 0.9, Math.PI * 2.1);
  g.arc(286, 170, 70, Math.PI * 2.1, Math.PI * 0.9, true);
  g.fill();
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** NACA-style airfoil half thickness at chord fraction s. */
function thickness(s, t) {
  return 5 * t * (0.2969 * Math.sqrt(s) - 0.126 * s - 0.3516 * s * s + 0.2843 * s ** 3 - 0.1036 * s ** 4);
}

/**
 * Loft a lifting surface through sections {le:[x,y,z], chord, t}. axis is the thickness axis index
 * (1 = y for horizontal surfaces, 2 = z for vertical ones). chordRange limits the chord fraction used.
 */
function loft(sections, axis = 1, camber = 0.02, c0 = 0, c1 = 1, closeTip = true) {
  const N = 14;
  const prof = [];
  // Upper surface TE -> LE, then lower LE -> TE.
  for (let i = N; i >= 0; i--) prof.push([i / N, 1]);
  for (let i = 1; i <= N; i++) prof.push([i / N, -1]);
  const pos = [];
  const idx = [];
  const P = prof.length;
  for (const sec of sections) {
    for (const [f, side] of prof) {
      const s = c0 + (c1 - c0) * (1 - Math.cos(f * Math.PI)) / 2;
      const th = thickness(Math.max(s, 1e-4), sec.t) * sec.chord;
      const cam = camber * sec.chord * 4 * s * (1 - s);
      const p = [sec.le[0] - s * sec.chord, sec.le[1], sec.le[2]];
      p[axis] += side * th + (axis === 1 ? cam : 0);
      pos.push(...p);
    }
  }
  for (let k = 0; k < sections.length - 1; k++) {
    for (let i = 0; i < P - 1; i++) {
      const a = k * P + i;
      const b = a + 1;
      const c = a + P;
      const d = c + 1;
      // Vertical surfaces (thickness along z) need the opposite winding to face outward.
      if (axis === 2) idx.push(a, b, c, b, d, c);
      else idx.push(a, c, b, b, c, d);
    }
  }
  if (closeTip) {
    // Cap both ends with a fan.
    for (const k of [0, sections.length - 1]) {
      const base = k * P;
      for (let i = 1; i < N; i++) {
        const a = base + i;
        const b = base + P - 1 - i;
        const a2 = base + i + 1;
        const b2 = base + P - 2 - i;
        if ((k === 0) !== (axis === 2)) idx.push(a, a2, b, a2, b2, b);
        else idx.push(a, b, a2, a2, b, b2);
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

function mirrorZ(geo) {
  const g = geo.clone();
  g.scale(1, 1, -1);
  // Flip winding.
  const idx = g.index.array;
  for (let i = 0; i < idx.length; i += 3) {
    const t = idx[i + 1];
    idx[i + 1] = idx[i + 2];
    idx[i + 2] = t;
  }
  g.computeVertexNormals();
  return g;
}

/** Wing planform helpers (right wing, z > 0). */
const WING = {
  rootZ: 1.5, kinkZ: 5.6, tipZ: 17.1,
  le(z) { return 3.85 - (z - 1.88) * Math.tan(27 * DEG); },
  te(z) {
    if (z <= this.kinkZ) return -3.55 - (z - 1.5) * 0.02;
    const t = (z - this.kinkZ) / (this.tipZ - this.kinkZ);
    return -3.63 + t * (-5.2 + 3.63);
  },
  y(z) { return -1.08 + (z - 1.88) * Math.tan(6 * DEG); },
  chord(z) { return this.le(z) - this.te(z); },
  thick(z) { return z < this.kinkZ ? 0.15 - (z / this.kinkZ) * 0.02 : 0.13 - ((z - this.kinkZ) / (this.tipZ - this.kinkZ)) * 0.03; },
};

/** A control surface panel hinged along a line; returns {pivot, mesh, axis}. */
function hingedPanel(z0, z1, fracStart, fracEnd, material, opts = {}) {
  // Panel spans chord fractions [fracStart, fracEnd] of the local wing chord between z0 and z1.
  const secs = [z0, z1].map((z) => {
    const ch = WING.chord(z);
    const le = WING.le(z) - fracStart * ch;
    return { le: [le, WING.y(z) + (opts.yOff || 0), z], chord: (fracEnd - fracStart) * ch, t: opts.t ?? 0.05 };
  });
  const geo = loft(secs, 1, 0, 0, 1);
  const hinge0 = new THREE.Vector3(secs[0].le[0], secs[0].le[1], z0);
  const hinge1 = new THREE.Vector3(secs[1].le[0], secs[1].le[1], z1);
  const mid = hinge0.clone().add(hinge1).multiplyScalar(0.5);
  geo.translate(-mid.x, -mid.y, -mid.z);
  const mesh = new THREE.Mesh(geo, material);
  const pivot = new THREE.Group();
  pivot.position.copy(mid);
  pivot.add(mesh);
  const axis = hinge1.clone().sub(hinge0).normalize();
  return { pivot, mesh, axis, base: mid.clone() };
}

export class AircraftModel {
  constructor() {
    this.root = new THREE.Group();
    this.surfaces = [];
    const { tex, etex } = liveryTextures();
    this.bodyMat = new THREE.MeshPhongMaterial({ map: tex, emissiveMap: etex, emissive: 0x000000, shininess: 70, specular: 0x666666 });
    const white = new THREE.MeshPhongMaterial({ color: 0xeef0f3, shininess: 60, specular: 0x555555 });
    const wingMat = new THREE.MeshPhongMaterial({ color: 0xc9ced6, shininess: 50, specular: 0x666666, side: THREE.DoubleSide });
    const flapMat = new THREE.MeshPhongMaterial({ color: 0xb8bec6, shininess: 40, specular: 0x444444, side: THREE.DoubleSide });
    const navy = new THREE.MeshPhongMaterial({ color: 0x16325c, shininess: 50, side: THREE.DoubleSide });
    const dark = new THREE.MeshPhongMaterial({ color: 0x222428, shininess: 20 });
    const metal = new THREE.MeshPhongMaterial({ color: 0x9aa0a8, shininess: 90, specular: 0xaaaaaa });
    const tire = new THREE.MeshLambertMaterial({ color: 0x151515 });
    const nacelle = new THREE.MeshPhongMaterial({ color: 0xeef0f3, shininess: 60, specular: 0x555555, side: THREE.DoubleSide });
    this.materials = { white, wingMat, flapMat, navy, dark, metal, tire, nacelle };

    // Fuselage.
    const fus = new THREE.Mesh(fuselageGeometry(), this.bodyMat);
    this.root.add(fus);

    // Wings (with wing-to-body fairing).
    const wingSecs = (zs) => zs.map((z) => ({ le: [WING.le(z), WING.y(z), z], chord: WING.chord(z), t: WING.thick(z) }));
    const zs = [WING.rootZ, 3.5, WING.kinkZ, 9, 13, WING.tipZ];
    const rw = loft(wingSecs(zs), 1, 0.025);
    this.root.add(new THREE.Mesh(rw, wingMat), new THREE.Mesh(mirrorZ(rw), wingMat));
    const fairing = new THREE.Mesh(new THREE.SphereGeometry(1, 24, 12), white);
    fairing.scale.set(6.2, 0.9, 2.05);
    fairing.position.set(0.2, -1.45, 0);
    this.root.add(fairing);

    // Blended winglets.
    for (const side of [1, -1]) {
      const z = WING.tipZ;
      const wl = loft([
        { le: [WING.le(z) - 0.05, WING.y(z) - 0.05, 0], chord: WING.chord(z) * 0.98, t: 0.09 },
        { le: [WING.le(z) - 0.55, WING.y(z) + 0.6, 0.18], chord: 1.0, t: 0.09 },
        { le: [WING.le(z) - 1.55, WING.y(z) + 2.45, 0.42], chord: 0.6, t: 0.08 },
      ].map((s) => ({ ...s, le: [s.le[0], s.le[1], (z + s.le[2]) * side] })), 2, 0);
      // Thickness along z for the vertical part: loft along y.
      this.root.add(new THREE.Mesh(wl, navy));
    }

    // Horizontal stabilizer.
    const hs = loft([
      { le: [-14.1, 0.32, 0.4], chord: 4.1, t: 0.1 },
      { le: [-18.0, 1.12, 7.15], chord: 1.4, t: 0.09 },
    ], 1, 0);
    this.root.add(new THREE.Mesh(hs, white), new THREE.Mesh(mirrorZ(hs), white));

    // Vertical fin with livery.
    const fin = loft([
      { le: [-11.6, 1.5, 0], chord: 6.9, t: 0.12 },
      { le: [-17.5, 9.8, 0], chord: 2.3, t: 0.1 },
    ], 2, 0);
    // UVs for the fin texture from its side projection.
    const fp = fin.attributes.position;
    const fuv = new Float32Array(fp.count * 2);
    for (let i = 0; i < fp.count; i++) {
      fuv[i * 2] = (fp.getX(i) + 19.8) / 8.4;
      fuv[i * 2 + 1] = (fp.getY(i) - 1.5) / 8.3;
    }
    fin.setAttribute('uv', new THREE.BufferAttribute(fuv, 2));
    const finMat = new THREE.MeshPhongMaterial({ map: finTexture(), shininess: 50, specular: 0x444444 });
    this.root.add(new THREE.Mesh(fin, finMat));
    // Dorsal fillet.
    const dorsal = loft([
      { le: [-8.0, 1.95, 0], chord: 3.8, t: 0.05 },
      { le: [-11.4, 2.6, 0], chord: 1.2, t: 0.12 },
    ], 2, 0);
    this.root.add(new THREE.Mesh(dorsal, navy));

    this.buildControlSurfaces(flapMat, wingMat, white);
    this.buildEngines(white, navy, dark, metal);
    this.buildGear(metal, tire, dark);
    this.buildLights();
    this.buildCockpit();

    this.root.traverse((o) => {
      if (o.isMesh) {
        o.castShadow = true;
        o.receiveShadow = false;
      }
    });
    this.fanAngle = [0, 0];
    this.wheelAngle = 0;
  }

  buildControlSurfaces(flapMat, wingMat, white) {
    const add = (name, panel, sideSign) => {
      this.root.add(panel.pivot);
      this.surfaces.push({ name, ...panel, side: sideSign });
    };
    for (const side of [1, -1]) {
      const mk = (z0, z1, f0, f1, mat, opts) => {
        const p = hingedPanel(z0, z1, f0, f1, mat, opts);
        if (side < 0) {
          p.mesh.geometry = mirrorZ(p.mesh.geometry);
          p.pivot.position.z *= -1;
          p.axis.z *= -1;
          p.base.z *= -1;
        }
        return p;
      };
      // Trailing edge flaps (Fowler) — hidden inside the wing when retracted.
      add('flapIn', mk(2.2, WING.kinkZ + 0.2, 0.72, 0.99, flapMat, { t: 0.06, yOff: -0.02 }), side);
      add('flapOut', mk(WING.kinkZ + 0.5, 12.6, 0.70, 0.98, flapMat, { t: 0.07, yOff: -0.02 }), side);
      add('aileron', mk(12.8, 16.4, 0.76, 1.0, wingMat, { t: 0.06 }), side);
      // Leading edge slats.
      add('slat', mk(6.0, 16.6, 0.0, 0.16, wingMat, { t: 0.11, yOff: -0.005 }), side);
      // Spoilers on the upper surface.
      for (let k = 0; k < 6; k++) {
        const z0 = 3.0 + k * 1.55;
        const p = mk(z0, z0 + 1.45, 0.58, 0.74, flapMat, { t: 0.012, yOff: 0.2 + 0.0 });
        add('spoiler', p, side);
        p.index = k;
      }
      // Elevator.
      const el = loft([
        { le: [-17.3, 0.34, 0.5], chord: 1.1, t: 0.05 },
        { le: [-19.1, 1.12, 7.0], chord: 0.45, t: 0.05 },
      ], 1, 0);
      const h0 = new THREE.Vector3(-17.3, 0.34, 0.5);
      const h1 = new THREE.Vector3(-19.1, 1.12, 7.0);
      if (side < 0) {
        h0.z *= -1;
        h1.z *= -1;
      }
      const mid = h0.clone().add(h1).multiplyScalar(0.5);
      const eg = side < 0 ? mirrorZ(el) : el;
      eg.translate(-mid.x, -mid.y, -mid.z);
      const pivot = new THREE.Group();
      pivot.position.copy(mid);
      pivot.add(new THREE.Mesh(eg, white));
      this.root.add(pivot);
      this.surfaces.push({ name: 'elevator', pivot, axis: h1.clone().sub(h0).normalize(), base: mid, side });
    }
    // Rudder.
    const rud = loft([
      { le: [-16.8, 1.7, 0], chord: 1.75, t: 0.07 },
      { le: [-19.4, 9.6, 0], chord: 0.8, t: 0.07 },
    ], 2, 0);
    const r0 = new THREE.Vector3(-16.8, 1.7, 0);
    const r1 = new THREE.Vector3(-19.4, 9.6, 0);
    const rmid = r0.clone().add(r1).multiplyScalar(0.5);
    rud.translate(-rmid.x, -rmid.y, -rmid.z);
    const rp = new THREE.Group();
    rp.position.copy(rmid);
    rp.add(new THREE.Mesh(rud, this.materials.navy));
    this.root.add(rp);
    this.surfaces.push({ name: 'rudder', pivot: rp, axis: r1.clone().sub(r0).normalize(), base: rmid, side: 1 });
  }

  buildEngines(white, navy, dark, metal) {
    this.fans = [];
    this.reversers = [];
    const prof = [];
    // Nacelle lathe profile (radius, axial position from inlet).
    const pts = [[0.78, 0.0], [0.93, 0.05], [1.0, 0.25], [1.03, 0.8], [1.02, 1.6], [0.97, 2.4], [0.9, 3.1], [0.78, 3.6], [0.72, 3.65], [0.7, 3.4]];
    for (const [r, a] of pts) prof.push(new THREE.Vector2(r, -a));
    const nacGeo = new THREE.LatheGeometry(prof, 36);
    nacGeo.rotateZ(Math.PI / 2); // lathe axis y -> x (inlet at +x)
    const lipGeo = new THREE.TorusGeometry(0.86, 0.075, 8, 36);
    lipGeo.rotateY(Math.PI / 2);
    const coreGeo = new THREE.CylinderGeometry(0.62, 0.42, 1.3, 24);
    coreGeo.rotateZ(Math.PI / 2);
    const plugGeo = new THREE.ConeGeometry(0.4, 0.9, 20);
    plugGeo.rotateZ(Math.PI / 2);
    const spinGeo = new THREE.ConeGeometry(0.3, 0.6, 20);
    spinGeo.rotateZ(-Math.PI / 2);
    const fanTex = (() => {
      const cv = document.createElement('canvas');
      cv.width = cv.height = 256;
      const g = cv.getContext('2d');
      g.fillStyle = '#2a2c30';
      g.fillRect(0, 0, 256, 256);
      g.translate(128, 128);
      for (let i = 0; i < 24; i++) {
        g.rotate((Math.PI * 2) / 24);
        g.fillStyle = i % 2 ? '#8d9299' : '#777b82';
        g.beginPath();
        g.moveTo(0, 0);
        g.quadraticCurveTo(70, 30, 128, 6);
        g.lineTo(128, -10);
        g.quadraticCurveTo(60, 0, 0, 0);
        g.fill();
      }
      const t = new THREE.CanvasTexture(cv);
      t.colorSpace = THREE.SRGBColorSpace;
      return t;
    })();
    const fanMat = new THREE.MeshPhongMaterial({ map: fanTex, shininess: 80 });
    for (const side of [-1, 1]) {
      const g = new THREE.Group();
      g.position.set(6.25, -1.25, 4.9 * side);
      const nac = new THREE.Mesh(nacGeo, this.materials.nacelle);
      nac.scale.set(1, 0.94, 1);
      const lip = new THREE.Mesh(lipGeo, metal);
      lip.position.x = -0.03;
      lip.scale.set(1, 0.94, 1);
      const core = new THREE.Mesh(coreGeo, dark);
      core.position.x = -3.75;
      core.scale.set(0.75, 0.85, 0.85);
      const plug = new THREE.Mesh(plugGeo, metal);
      plug.position.x = -4.45;
      plug.scale.set(0.8, 0.85, 0.85);
      const fan = new THREE.Mesh(new THREE.CircleGeometry(0.8, 32), fanMat);
      fan.rotation.y = Math.PI / 2;
      fan.position.x = -0.35;
      const spin = new THREE.Mesh(spinGeo, metal);
      spin.position.x = -0.15;
      const inner = new THREE.Mesh(new THREE.CylinderGeometry(0.82, 0.82, 0.4, 32, 1, true), dark);
      inner.rotation.z = Math.PI / 2;
      inner.position.x = -0.2;
      inner.material = new THREE.MeshLambertMaterial({ color: 0x2a2c30, side: THREE.BackSide });
      // Thrust reverser sleeve (translates aft when deployed).
      const sleeve = new THREE.Mesh(new THREE.CylinderGeometry(1.0, 0.93, 0.9, 36, 1, true), white);
      sleeve.rotation.z = Math.PI / 2;
      sleeve.position.x = -2.7;
      g.add(nac, lip, core, plug, fan, spin, inner, sleeve);
      // Pylon.
      const pylon = new THREE.Mesh(new THREE.BoxGeometry(3.2, 0.42, 0.32), white);
      pylon.position.set(-3.6, 0.78, 0);
      pylon.rotation.z = 0.06;
      g.add(pylon);
      // Navy accent band.
      const band = new THREE.Mesh(new THREE.CylinderGeometry(1.035, 1.035, 0.25, 36, 1, true), navy);
      band.rotation.z = Math.PI / 2;
      band.position.x = -0.9;
      g.add(band);
      this.root.add(g);
      this.fans.push(fan);
      this.reversers.push(sleeve);
    }
  }

  buildGear(metal, tire, dark) {
    const wheel = (r, w) => {
      const g = new THREE.Group();
      const t = new THREE.Mesh(new THREE.CylinderGeometry(r, r, w, 24), tire);
      t.rotation.x = Math.PI / 2;
      const hub = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.55, r * 0.55, w + 0.02, 16), metal);
      hub.rotation.x = Math.PI / 2;
      g.add(t, hub);
      return g;
    };
    this.mainGear = [];
    for (const side of [-1, 1]) {
      const pivot = new THREE.Group();
      pivot.position.set(-1.2, -1.25, 2.86 * side);
      const strut = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 1.0, 10), metal);
      strut.position.y = -0.45;
      const lower = new THREE.Group();
      const piston = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 0.6, 10), metal);
      piston.position.y = -0.95;
      const axle = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 1.1, 8), metal);
      axle.rotation.x = Math.PI / 2;
      axle.position.y = -0.93;
      const w1 = wheel(0.57, 0.42);
      w1.position.set(0, -0.93, 0.45);
      const w2 = wheel(0.57, 0.42);
      w2.position.set(0, -0.93, -0.45);
      lower.add(piston, axle, w1, w2);
      const brace = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 1.3, 6), dark);
      brace.position.set(0.0, -0.4, -0.5 * side);
      brace.rotation.x = 0.7 * side;
      pivot.add(strut, lower, brace);
      this.root.add(pivot);
      this.mainGear.push({ pivot, lower, wheels: [w1, w2], side });
    }
    const npivot = new THREE.Group();
    npivot.position.set(16.0, -1.45, 0);
    const nstrut = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 0.8, 10), metal);
    nstrut.position.y = -0.35;
    const nlower = new THREE.Group();
    const nwa = wheel(0.36, 0.28);
    nwa.position.set(0, -0.94, 0.24);
    const nwb = wheel(0.36, 0.28);
    nwb.position.set(0, -0.94, -0.24);
    const npiston = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 0.4, 8), metal);
    npiston.position.y = -0.78;
    nlower.add(nwa, nwb, npiston);
    npivot.add(nstrut, nlower);
    // Taxi light on the nose strut.
    this.root.add(npivot);
    this.noseGear = { pivot: npivot, lower: nlower, wheels: [nwa, nwb] };
  }

  buildLights() {
    const glow = getGlowTexture();
    const sprite = (color, size) => {
      const m = new THREE.SpriteMaterial({ map: glow, color, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false });
      const s = new THREE.Sprite(m);
      s.scale.set(size, size, 1);
      return s;
    };
    this.navLights = [];
    const red = sprite(0xff2020, 1.6);
    red.position.set(-4.7, 0.45, -17.15);
    const green = sprite(0x20ff40, 1.6);
    green.position.set(-4.7, 0.45, 17.15);
    const tail = sprite(0xffffff, 1.3);
    tail.position.set(-22.55, 1.25, 0);
    this.navLights.push(red, green, tail);
    this.strobes = [];
    for (const p of [[-4.9, 0.45, -17.2], [-4.9, 0.45, 17.2], [-22.6, 1.25, 0]]) {
      const s = sprite(0xffffff, 6);
      s.position.set(...p);
      this.strobes.push(s);
    }
    this.beacons = [];
    for (const y of [2.08, -2.05]) {
      const s = sprite(0xff1a10, 3);
      s.position.set(-2, y, 0);
      this.beacons.push(s);
    }
    for (const s of [...this.navLights, ...this.strobes, ...this.beacons]) this.root.add(s);

    // Landing lights in the wing roots.
    this.landingLights = [];
    for (const side of [-1, 1]) {
      const spot = new THREE.SpotLight(0xfff4e0, 0, 1600, 13 * DEG, 0.45, 1.2);
      spot.position.set(3.0, -1.0, 2.7 * side);
      spot.target.position.set(80, -9, 9 * side);
      this.root.add(spot, spot.target);
      const g = sprite(0xfff6e8, 5);
      g.position.set(3.1, -0.98, 2.7 * side);
      this.root.add(g);
      this.landingLights.push({ spot, glow: g });
    }
  }

  buildCockpit() {
    // Simple flight deck visible only from the cockpit camera (eye at x 17.15, y 0.98, z -0.53).
    const g = new THREE.Group();
    const panelMat = new THREE.MeshLambertMaterial({ color: 0x3a4048 });
    const darkMat = new THREE.MeshLambertMaterial({ color: 0x1a1d22 });
    const frameMat = new THREE.MeshLambertMaterial({ color: 0x2c3036 });
    // Glareshield (top edge ~16 deg below the eye) and the main panel under it.
    const glare = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.06, 2.3), darkMat);
    glare.position.set(18.02, 0.75, 0);
    const panel = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.8, 2.3), panelMat);
    panel.position.set(17.86, 0.33, 0);
    panel.rotation.z = 0.18;
    const ped = new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.55, 0.5), panelMat);
    ped.position.set(17.3, -0.12, 0);
    // Thin window posts leaning back.
    const posts = [];
    for (const [x, z] of [[18.25, 0], [17.78, -0.98], [17.78, 0.98], [17.05, -1.3], [17.05, 1.3]]) {
      const p = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.72, 0.05), frameMat);
      p.position.set(x - 0.15, 1.1, z);
      p.rotation.z = 0.45;
      posts.push(p);
    }
    const header = new THREE.Mesh(new THREE.BoxGeometry(0.35, 0.05, 2.5), frameMat);
    header.position.set(17.85, 1.43, 0);
    const ceiling = new THREE.Mesh(new THREE.BoxGeometry(1.9, 0.05, 2.6), darkMat);
    ceiling.position.set(16.75, 1.5, 0);
    const sill = [-1, 1].map((sd) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.06, 0.25), panelMat);
      m.position.set(16.9, 0.62, sd * 1.32);
      return m;
    });
    g.add(glare, panel, ped, header, ceiling, ...posts, ...sill);
    // Screens textured with the live instrument canvases (set by the app).
    this.screens = [];
    for (const z of [-0.86, -0.6, 0.0, 0.6, 0.86]) {
      const w = z === 0 ? 0.2 : 0.21;
      const m = new THREE.Mesh(new THREE.PlaneGeometry(w, w), new THREE.MeshBasicMaterial({ color: 0x050608 }));
      m.position.set(17.82, 0.5, z);
      m.rotation.set(0, -Math.PI / 2, 0);
      m.rotateX(-0.18);
      g.add(m);
      this.screens.push(m);
    }
    g.visible = false;
    this.cockpit = g;
    this.root.add(g);
  }

  /** Attach canvases to the flight deck screens: [captPFD, captND, eicas, foND, foPFD]. */
  setScreens(canvases) {
    canvases.forEach((cv, i) => {
      if (!cv || !this.screens[i]) return;
      const t = new THREE.CanvasTexture(cv);
      t.colorSpace = THREE.SRGBColorSpace;
      this.screens[i].material = new THREE.MeshBasicMaterial({ map: t, toneMapped: false });
      this.screens[i].userData.tex = t;
    });
  }

  update(ac, dt, time, opts) {
    const r = this.root;
    r.position.set(ac.pos[0], ac.pos[1], ac.pos[2]);
    r.quaternion.set(ac.q[1], ac.q[2], ac.q[3], ac.q[0]);
    const c = ac.controls;
    const flapDeg = [0, 1, 2, 5, 10, 15, 25, 30, 40];
    const fi = Math.floor(ac.flapPos);
    const ff = ac.flapPos - fi;
    const flapAngle = flapDeg[fi] + ((flapDeg[Math.min(8, fi + 1)] ?? 40) - flapDeg[fi]) * ff;
    const flapExt = clamp(flapAngle / 40, 0, 1);
    const slatExt = ac.flapPos > 0.05 ? (ac.flapPos >= 4 ? 1 : 0.6) : 0;
    this.slatAnim = (this.slatAnim ?? 0) + clamp(slatExt - (this.slatAnim ?? 0), -dt / 3, dt / 3);
    const q = new THREE.Quaternion();
    for (const s of this.surfaces) {
      // Hinge axes run outboard (+z on the right wing, -z on the left), so a trailing-edge-down
      // deflection d is a rotation of d * side about the hinge axis.
      let ted = 0;
      const off = new THREE.Vector3();
      switch (s.name) {
        case 'flapIn':
        case 'flapOut':
          ted = flapAngle * DEG * (s.name === 'flapIn' ? 1 : 0.95);
          off.set(-flapExt * 1.1, -flapExt * 0.25, 0);
          break;
        case 'aileron':
          // Right stick: right aileron up, left aileron down.
          ted = -clamp(c.roll, -1, 1) * 18 * DEG * s.side;
          break;
        case 'slat':
          // Slats droop forward and down; rotating trailing edge up about the leading edge.
          ted = -this.slatAnim * 20 * DEG;
          off.set(this.slatAnim * 0.35, -this.slatAnim * 0.18, 0);
          break;
        case 'spoiler': {
          const roll = clamp(c.roll, -1, 1);
          // Flight spoilers assist roll on the down-going wing.
          const rollSp = Math.max(0, roll * s.side) * (s.index >= 1 && s.index <= 4 ? 1 : 0) * 0.7;
          ted = -Math.max(ac.spoilerPos, rollSp) * 45 * DEG;
          break;
        }
        case 'elevator':
          ted = -clamp(c.pitch, -1, 1) * 20 * DEG;
          break;
        default:
      }
      let ang = ted * s.side;
      // Rudder hinge points up; right pedal swings the trailing edge to the right (+z).
      if (s.name === 'rudder') ang = clamp(c.yaw, -1, 1) * 25 * DEG;
      q.setFromAxisAngle(s.axis, ang);
      s.pivot.quaternion.copy(q);
      s.pivot.position.copy(s.base).add(off);
    }
    // Engines.
    for (let i = 0; i < 2; i++) {
      const e = ac.engines[i];
      this.fanAngle[i] += (e.n1 / 100) * 85 * dt;
      this.fans[i].rotation.x = this.fanAngle[i];
      this.reversers[i].position.x = -2.7 - e.reverser * 0.7;
    }
    // Gear.
    const g = ac.gearPos;
    const ret = 1 - g;
    this.wheelAngle += (ac.gs / 0.57) * dt * (ac.wow ? 1 : 0);
    for (let k = 0; k < 2; k++) {
      const m = this.mainGear[k];
      m.pivot.rotation.x = ret * 88 * DEG * -m.side;
      const comp = ac.gearCompression[k + 1] || 0;
      m.lower.position.y = Math.min(comp, 0.5);
      for (const w of m.wheels) w.rotation.z = -this.wheelAngle;
    }
    const n = this.noseGear;
    n.pivot.rotation.z = ret * 92 * DEG;
    n.lower.position.y = Math.min(ac.gearCompression[0] || 0, 0.4);
    const steer = ac.wow ? clamp(c.yaw + c.tiller, -1, 1) * (ac.gs < 15 ? 60 : 7) * DEG : 0;
    n.lower.rotation.y = -steer;
    for (const w of n.wheels) w.rotation.z = -this.wheelAngle * 1.6;
    this.mainGear.forEach((m) => (m.pivot.visible = g > 0.02));
    n.pivot.visible = g > 0.02;

    // Lights.
    const L = opts.lights;
    const night = opts.night;
    for (const s of this.navLights) s.visible = L.nav;
    const strobeOn = L.strobe && (time % 1.2 < 0.06 || (time % 1.2 > 0.14 && time % 1.2 < 0.2));
    for (const s of this.strobes) s.visible = strobeOn;
    const beaconOn = L.beacon && time % 1.0 < 0.12;
    for (const s of this.beacons) s.visible = beaconOn;
    for (const l of this.landingLights) {
      l.spot.intensity = L.landing ? 9000 * (0.3 + night) : 0;
      l.glow.visible = L.landing;
      const gs = 1.2 + night * 4;
      l.glow.scale.set(gs, gs, 1);
    }
    this.bodyMat.emissive.setRGB(night * 0.9, night * 0.85, night * 0.7);
    this.cockpit.visible = !!opts.cockpit;
    if (opts.cockpit) for (const s of this.screens) if (s.userData.tex) s.userData.tex.needsUpdate = true;
  }
}
