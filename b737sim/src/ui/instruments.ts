// Glass cockpit displays drawn on 2D canvases: PFD, ND (MAP / VOR / APP with real navaids,
// fixes, the FMC route and weather radar) and the upper EICAS.
import { clamp, wrap180, wrap360, DEG, RAD, KT, FT, FPM, NM } from '../core/math.ts';
import { B739, stallSpeed, FLAP_NAMES } from '../core/aircraftData.ts';
import { casFromMach, hPaToInHg } from '../core/atmosphere.ts';
import type { Simulation } from '../core/sim.ts';
import type { NavRadio } from '../nav/radios.ts';

type G = CanvasRenderingContext2D;

const C = {
  bg: '#000',
  white: '#f2f2f2',
  green: '#3fe05a',
  magenta: '#ff4cf0',
  cyan: '#33e0ff',
  amber: '#ffb000',
  red: '#ff2a2a',
  gray: '#5b6168',
  tape: '#3a4148',
  sky: '#1e6fd0',
  ground: '#8a5a2c',
};
const FONT = '"B612 Mono", "DejaVu Sans Mono", Menlo, Consolas, monospace';

function setup(canvas: HTMLCanvasElement, w: number, h: number): G {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  const g = canvas.getContext('2d')!;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  return g;
}

function text(g: G, s: string, x: number, y: number, color = C.white, size = 14, align: CanvasTextAlign = 'left', weight = '600'): void {
  g.fillStyle = color;
  g.font = `${weight} ${size}px ${FONT}`;
  g.textAlign = align;
  g.textBaseline = 'middle';
  g.fillText(s, x, y);
}

function box(g: G, x: number, y: number, w: number, h: number, stroke = C.white, fill = '#000', lw = 1.5): void {
  g.fillStyle = fill;
  g.fillRect(x, y, w, h);
  g.strokeStyle = stroke;
  g.lineWidth = lw;
  g.strokeRect(x, y, w, h);
}

function diamond(g: G, x: number, y: number, hw: number, hh: number): void {
  g.beginPath();
  g.moveTo(x, y - hh);
  g.lineTo(x + hw, y);
  g.lineTo(x, y + hh);
  g.lineTo(x - hw, y);
  g.closePath();
  g.fill();
}

function barber(g: G, x: number, y0: number, y1: number): void {
  const top = Math.min(y0, y1);
  const bot = Math.max(y0, y1);
  if (bot < 0 || top > 500) return;
  g.fillStyle = '#000';
  g.fillRect(x, top, 6, bot - top);
  g.fillStyle = C.red;
  for (let y = top; y < bot; y += 12) g.fillRect(x, y, 6, Math.min(6, bot - y));
}

const pad3 = (n: number): string => String(Math.round(wrap360(n)) % 360 || 360).padStart(3, '0');
const freqText = (r: NavRadio): string => r.active.toFixed(2);

export class PFD {
  readonly W = 440;
  readonly H = 440;
  private readonly g: G;
  private trend = 0;
  private prevIas = 0;
  /** Decision height (ft radio) for the MINS display. */
  minimums = 200;

  constructor(readonly canvas: HTMLCanvasElement) {
    this.g = setup(canvas, this.W, this.H);
  }

  draw(sim: Simulation, dt: number): void {
    const g = this.g;
    const ac = sim.ac;
    g.fillStyle = C.bg;
    g.fillRect(0, 0, this.W, this.H);
    const iasKt = ac.ias / KT;
    const acc = (iasKt - this.prevIas) / Math.max(dt, 1e-3);
    this.prevIas = iasKt;
    if (Number.isFinite(acc)) this.trend += (acc * 10 - this.trend) * Math.min(1, dt * 1.5);
    this.drawAttitude(g, sim);
    this.drawSpeed(g, sim, iasKt);
    this.drawAltitude(g, sim);
    this.drawVsi(g, sim);
    this.drawHeading(g, sim);
    this.drawFma(g, sim);
  }

  private drawFma(g: G, sim: Simulation): void {
    const f = sim.ap.fma();
    const cols: [number, number][] = [[10, 130], [140, 140], [280, 150]];
    g.strokeStyle = C.gray;
    g.lineWidth = 1;
    for (const [x, w] of cols) g.strokeRect(x, 4, w, 42);
    text(g, f.at, 75, 17, C.green, 15, 'center');
    text(g, f.roll, 210, 17, C.green, 15, 'center');
    text(g, f.rollArmed, 210, 36, C.white, 12, 'center');
    text(g, f.pitch, 355, 17, C.green, 15, 'center');
    text(g, f.pitchArmed, 355, 36, C.white, 12, 'center');
    if (f.status) text(g, f.status, 205, 66, C.green, f.status.length > 3 ? 16 : 18, 'center', '700');
    if (!sim.ap.cmd && sim.apDiscFlash > 0) text(g, 'AP DISC', 205, 66, C.red, 16, 'center', '700');
  }

  private drawAttitude(g: G, sim: Simulation): void {
    const ac = sim.ac;
    const ap = sim.ap;
    const cx = 205;
    const cy = 202;
    const ppd = 7.2;
    g.save();
    g.beginPath();
    g.roundRect(100, 74, 210, 262, 18);
    g.clip();
    g.translate(cx, cy);
    g.rotate(-ac.roll * DEG);
    const py = ac.pitch * ppd;
    g.fillStyle = C.sky;
    g.fillRect(-400, -800 + py, 800, 800);
    g.fillStyle = C.ground;
    g.fillRect(-400, py, 800, 800);
    g.strokeStyle = C.white;
    g.lineWidth = 2;
    g.beginPath();
    g.moveTo(-400, py);
    g.lineTo(400, py);
    g.stroke();
    g.lineWidth = 1.5;
    for (let p = -90; p <= 90; p += 2.5) {
      if (p === 0) continue;
      const y = py - p * ppd;
      if (Math.abs(y) > 120) continue;
      const major = p % 10 === 0;
      const half = major ? 38 : p % 5 === 0 ? 20 : 9;
      g.strokeStyle = C.white;
      g.beginPath();
      g.moveTo(-half, y);
      g.lineTo(half, y);
      g.stroke();
      if (major) {
        text(g, Math.abs(p).toString(), -half - 14, y, C.white, 12, 'center');
        text(g, Math.abs(p).toString(), half + 14, y, C.white, 12, 'center');
      }
    }
    g.restore();
    // Bank scale and pointer with slip indicator.
    g.save();
    g.translate(cx, cy);
    g.strokeStyle = C.white;
    g.lineWidth = 2;
    const R = 112;
    for (const a of [-60, -45, -30, -20, -10, 10, 20, 30, 45, 60]) {
      const len = Math.abs(a) % 30 === 0 ? 12 : 7;
      const t = (a - 90) * DEG;
      g.beginPath();
      g.moveTo(Math.cos(t) * R, Math.sin(t) * R);
      g.lineTo(Math.cos(t) * (R + len), Math.sin(t) * (R + len));
      g.stroke();
    }
    g.fillStyle = C.white;
    g.beginPath();
    g.moveTo(0, -R);
    g.lineTo(-7, -R - 11);
    g.lineTo(7, -R - 11);
    g.closePath();
    g.fill();
    g.rotate(-ac.roll * DEG);
    g.fillStyle = Math.abs(ac.roll) > 35 ? C.amber : C.white;
    g.beginPath();
    g.moveTo(0, -R + 1);
    g.lineTo(-7, -R + 12);
    g.lineTo(7, -R + 12);
    g.closePath();
    g.fill();
    const slip = clamp(-ac.beta * RAD * 4, -14, 14);
    g.fillRect(-8 + slip, -R + 14, 16, 4);
    g.restore();

    // Flight director.
    if ((ap.fd || ap.cmd) && (ap.lat || ap.vert)) {
      g.strokeStyle = C.magenta;
      g.lineWidth = 3;
      const fx = clamp(ap.fdRoll * 2.2, -70, 70);
      const fy = clamp(-ap.fdPitch * ppd, -90, 90);
      if (ap.lat) {
        g.beginPath();
        g.moveTo(cx + fx, cy - 75);
        g.lineTo(cx + fx, cy + 75);
        g.stroke();
      }
      if (ap.vert) {
        g.beginPath();
        g.moveTo(cx - 75, cy + fy);
        g.lineTo(cx + 75, cy + fy);
        g.stroke();
      }
    }
    // Aircraft symbol.
    g.fillStyle = '#000';
    g.strokeStyle = C.white;
    g.lineWidth = 2;
    for (const s of [-1, 1]) {
      g.beginPath();
      g.moveTo(cx + s * 30, cy - 4);
      g.lineTo(cx + s * 78, cy - 4);
      g.lineTo(cx + s * 78, cy + 4);
      g.lineTo(cx + s * 38, cy + 4);
      g.lineTo(cx + s * 38, cy + 16);
      g.lineTo(cx + s * 30, cy + 16);
      g.closePath();
      g.fill();
      g.stroke();
    }
    g.fillRect(cx - 5, cy - 5, 10, 10);
    g.strokeRect(cx - 5, cy - 5, 10, 10);

    // Flight path vector.
    if (!ac.wow && ac.gs > 30) {
      const gamma = Math.atan2(ac.vs, ac.gs) * RAD;
      const drift = wrap180(ac.track - ac.heading);
      const bx = cx + clamp(drift * ppd, -90, 90);
      const by = cy - (gamma - ac.pitch) * ppd;
      if (by > 80 && by < 330) {
        g.strokeStyle = C.white;
        g.lineWidth = 1.5;
        g.beginPath();
        g.arc(bx, by, 6, 0, Math.PI * 2);
        g.moveTo(bx - 18, by);
        g.lineTo(bx - 6, by);
        g.moveTo(bx + 6, by);
        g.lineTo(bx + 18, by);
        g.moveTo(bx, by - 6);
        g.lineTo(bx, by - 13);
        g.stroke();
      }
    }

    // ILS deviation from NAV 1.
    const n1 = sim.radios.nav1;
    if (n1.receiving && n1.kind === 'ils') {
      text(g, n1.ident, 108, 88, C.white, 12);
      text(g, n1.dmeNm !== null ? `DME ${n1.dmeNm.toFixed(1)}` : freqText(n1), 108, 104, C.white, 12);
      const ly = 322;
      g.strokeStyle = C.white;
      g.lineWidth = 1.5;
      for (const d of [-2, -1, 1, 2]) {
        g.beginPath();
        g.arc(cx + d * 30, ly, 3.5, 0, Math.PI * 2);
        g.stroke();
      }
      g.fillStyle = C.magenta;
      diamond(g, cx + clamp(-n1.cdiDots, -2.4, 2.4) * 30, ly, 8, 6);
      if (n1.gsDots !== null) {
        const gx = 296;
        for (const d of [-2, -1, 1, 2]) {
          g.beginPath();
          g.arc(gx, cy + d * 30, 3.5, 0, Math.PI * 2);
          g.stroke();
        }
        diamond(g, gx, cy + clamp(n1.gsDots, -2.4, 2.4) * 30, 6, 8);
      }
    }
    // Radio altitude and minimums.
    const ra = ac.radioAlt / FT;
    text(g, `RADIO`, 296, 84, C.green, 11, 'right');
    text(g, String(this.minimums), 296, 98, C.green, 13, 'right', '700');
    if (ra < 2500 && !ac.wow) {
      const rs = ra < 10 ? Math.round(ra) : ra < 100 ? Math.round(ra / 2) * 2 : Math.round(ra / 10) * 10;
      text(g, String(rs), cx, 296, ra < this.minimums ? C.amber : C.white, 18, 'center', '700');
      if (ra < this.minimums && ac.vs < 0) text(g, 'MINIMUMS', cx, 278, C.amber, 13, 'center', '700');
    }
    const w = sim.warnings.active;
    if (w.has('windshear')) text(g, 'WINDSHEAR', cx, 250, C.red, 22, 'center', '800');
    else if (w.has('pullup') || w.has('terrain')) text(g, 'PULL UP', cx, 250, C.red, 22, 'center', '800');
    else if (w.has('stall')) text(g, 'STALL', cx, 250, C.red, 20, 'center', '800');
    if (ac.crashed) text(g, 'CRASH', cx, 150, C.red, 26, 'center', '800');
  }

  private drawSpeed(g: G, sim: Simulation, ias: number): void {
    const ac = sim.ac;
    const ap = sim.ap;
    const x0 = 22;
    const w = 62;
    const top = 74;
    const bot = 336;
    const cy = 202;
    const ppk = 3.3;
    g.fillStyle = C.tape;
    g.fillRect(x0, top, w, bot - top);
    g.save();
    g.beginPath();
    g.rect(x0, top, w + 30, bot - top);
    g.clip();
    const disp = Math.max(ias, 30);
    const y = (v: number) => cy - (v - disp) * ppk;
    g.strokeStyle = C.white;
    g.lineWidth = 1.5;
    for (let v = Math.floor((disp - 45) / 10) * 10; v <= disp + 45; v += 10) {
      if (v < 30) continue;
      const yy = y(v);
      g.beginPath();
      g.moveTo(x0 + w - 10, yy);
      g.lineTo(x0 + w, yy);
      g.stroke();
      if (v % 20 === 0) text(g, String(v), x0 + w - 14, yy, C.white, 14, 'right');
    }
    const detent = clamp(Math.round(ac.flapPos), 0, 8);
    let vmax = Math.min(B739.vmo, casFromMach(B739.mmo, ac.air) / KT);
    if (ac.flapPos > 0.1) vmax = Math.min(vmax, B739.flaps[detent].vfe);
    if (ac.gearPos > 0.05) vmax = Math.min(vmax, 270);
    const vs = stallSpeed(ac.mass, detent) * (ac.nz > 1 ? Math.sqrt(clamp(ac.nz, 1, 2)) : 1);
    const vShaker = vs * 1.06;
    const vMinMan = vs * 1.3;
    barber(g, x0 + w - 6, y(vmax + 60), y(vmax));
    if (!ac.wow) {
      barber(g, x0 + w - 6, y(vShaker), y(vShaker - 80));
      g.strokeStyle = C.amber;
      g.lineWidth = 3;
      g.beginPath();
      g.moveTo(x0 + w - 4, y(vShaker));
      g.lineTo(x0 + w - 4, y(vMinMan));
      g.stroke();
    }
    const vsp = sim.vspeeds;
    const bugs: [number, string][] = [];
    if (ac.wow) bugs.push([vsp.v1, 'V1'], [vsp.vr, 'VR']);
    if (ac.wow || ac.airborneTime < 30) bugs.push([vsp.v2 + 15, '']);
    if (!ac.wow) {
      bugs.push([vsp.vref40 + 70, 'UP'], [vsp.vref40 + 50, '1'], [vsp.vref40 + 30, '5'], [vsp.vref40 + 20, '15']);
      if (ac.flapPos >= 5) bugs.push([vsp.vref30, 'REF']);
    }
    for (const [v, label] of bugs) {
      const yy = y(v);
      g.strokeStyle = C.green;
      g.lineWidth = 2;
      g.beginPath();
      g.moveTo(x0 + w, yy);
      g.lineTo(x0 + w + 8, yy);
      g.stroke();
      if (label) text(g, label, x0 + w + 10, yy, C.green, 11);
    }
    const sel = ap.targetIas() / KT;
    g.strokeStyle = C.magenta;
    g.lineWidth = 2;
    const sy = clamp(y(sel), top + 4, bot - 4);
    g.beginPath();
    g.moveTo(x0 + w, sy - 9);
    g.lineTo(x0 + w + 9, sy - 9);
    g.lineTo(x0 + w + 9, sy + 9);
    g.lineTo(x0 + w, sy + 9);
    g.lineTo(x0 + w + 4, sy);
    g.closePath();
    g.stroke();
    if (Math.abs(this.trend) > 2 && !ac.wow) {
      g.strokeStyle = C.green;
      g.lineWidth = 2;
      g.beginPath();
      g.moveTo(x0 + w - 2, cy);
      g.lineTo(x0 + w - 2, y(disp + this.trend));
      g.stroke();
    }
    g.restore();
    const over = ias > vmax + 1;
    const under = !ac.wow && ias < vMinMan;
    box(g, x0 - 2, cy - 15, w - 6, 30, C.white, '#000');
    g.beginPath();
    g.moveTo(x0 + w - 8, cy - 7);
    g.lineTo(x0 + w + 2, cy);
    g.lineTo(x0 + w - 8, cy + 7);
    g.fillStyle = '#000';
    g.fill();
    text(g, ias < 30 ? '---' : String(Math.round(ias)), x0 + w - 12, cy, over ? C.red : under ? C.amber : C.white, 20, 'right', '700');
    text(g, ap.mcp.useMach ? `.${Math.round(ap.mcp.mach * 1000).toString().padStart(3, '0')}` : String(Math.round(ap.mcp.spd)), x0 + w / 2, top - 12, C.magenta, 15, 'center');
    if (ac.mach > 0.4) text(g, `.${Math.round(ac.mach * 1000).toString().padStart(3, '0')}`, x0 + w / 2, bot + 12, C.white, 14, 'center');
    else text(g, `GS ${Math.round(ac.gs / KT)}`, x0 + w / 2, bot + 12, C.white, 12, 'center');
  }

  private drawAltitude(g: G, sim: Simulation): void {
    const ac = sim.ac;
    const ap = sim.ap;
    const x0 = 330;
    const w = 66;
    const top = 74;
    const bot = 336;
    const cy = 202;
    const alt = ac.altInd / FT;
    const ppf = 0.26;
    g.fillStyle = C.tape;
    g.fillRect(x0, top, w, bot - top);
    g.save();
    g.beginPath();
    g.rect(x0 - 12, top, w + 12, bot - top);
    g.clip();
    const y = (a: number) => cy - (a - alt) * ppf;
    g.strokeStyle = C.white;
    g.lineWidth = 1.5;
    for (let a = Math.floor((alt - 600) / 100) * 100; a <= alt + 600; a += 100) {
      const yy = y(a);
      g.beginPath();
      g.moveTo(x0, yy);
      g.lineTo(x0 + 8, yy);
      g.stroke();
      if (a % 200 === 0) text(g, String(a), x0 + w - 4, yy, C.white, 12, 'right');
    }
    // Ground reference below the radio altitude.
    if (ac.radioAlt / FT < 1200) {
      const gnd = alt - (ac.radioAlt - 2.57) / FT;
      g.fillStyle = 'rgba(255,176,0,0.55)';
      g.fillRect(x0, y(gnd), 8, bot - y(gnd));
    }
    const sel = ap.mcp.alt;
    const sy = clamp(y(sel), top + 4, bot - 4);
    g.strokeStyle = C.magenta;
    g.lineWidth = 2;
    g.beginPath();
    g.moveTo(x0, sy - 10);
    g.lineTo(x0 - 9, sy - 10);
    g.lineTo(x0 - 9, sy + 10);
    g.lineTo(x0, sy + 10);
    g.lineTo(x0 - 4, sy);
    g.closePath();
    g.stroke();
    g.restore();
    box(g, x0 + 2, cy - 15, w, 30, C.white, '#000');
    const a = Math.round(alt / 20) * 20;
    const big = Math.trunc(a / 1000);
    const small = String(Math.abs(a % 1000)).padStart(3, '0');
    text(g, big ? String(big) : a < 0 ? '-' : '', x0 + 32, cy, C.white, 20, 'right', '700');
    text(g, small, x0 + 33, cy, C.white, 15, 'left', '700');
    const near = Math.abs(sel - alt) < 900 && Math.abs(sel - alt) > 200;
    if (near) box(g, x0, top - 24, w + 2, 22, C.white, '#000', 1);
    text(g, String(sel), x0 + w / 2 + 2, top - 12, C.magenta, 15, 'center');
    // Barometric setting: STD, or QNH in inches (amber box if STD below the transition level).
    const baro = ac.baroStd ? 'STD' : `${hPaToInHg(ac.baroSetting / 100).toFixed(2)} IN`;
    const stdLow = ac.baroStd && alt < 17500 && ac.vs < 0;
    text(g, baro, x0 + w / 2, bot + 12, stdLow ? C.amber : C.green, 13, 'center', '700');
  }

  private drawVsi(g: G, sim: Simulation): void {
    const ac = sim.ac;
    const x0 = 402;
    const cy = 202;
    g.fillStyle = C.tape;
    g.beginPath();
    g.moveTo(x0, 96);
    g.lineTo(x0 + 22, 110);
    g.lineTo(x0 + 22, 294);
    g.lineTo(x0, 308);
    g.closePath();
    g.fill();
    const map = (fpm: number) => {
      const s = Math.sign(fpm);
      const a = Math.abs(fpm);
      const px = a <= 1000 ? (a / 1000) * 60 : 60 + ((Math.min(a, 6000) - 1000) / 5000) * 40;
      return cy - s * px;
    };
    g.strokeStyle = C.white;
    g.lineWidth = 1;
    for (const f of [-6000, -2000, -1000, -500, 0, 500, 1000, 2000, 6000]) {
      const yy = map(f);
      g.beginPath();
      g.moveTo(x0 + 2, yy);
      g.lineTo(x0 + (f % 1000 === 0 ? 9 : 6), yy);
      g.stroke();
      if (f && Math.abs(f) !== 500) text(g, String(Math.abs(f) / 1000), x0 + 15, yy, C.white, 10, 'center');
    }
    const vs = ac.vs / FPM;
    g.strokeStyle = C.white;
    g.lineWidth = 2.5;
    g.beginPath();
    g.moveTo(x0 + 34, cy);
    g.lineTo(x0 + 3, map(vs));
    g.stroke();
    if (Math.abs(vs) > 400) text(g, String(Math.round(vs / 50) * 50), x0 + 12, vs > 0 ? 86 : 318, C.white, 12, 'center');
    const ap = sim.ap;
    if (ap.vert === 'V/S') {
      g.strokeStyle = C.magenta;
      g.lineWidth = 2;
      const yy = map(ap.mcp.vs);
      g.beginPath();
      g.moveTo(x0 + 1, yy);
      g.lineTo(x0 + 14, yy);
      g.stroke();
    }
  }

  private drawHeading(g: G, sim: Simulation): void {
    const ac = sim.ac;
    const ap = sim.ap;
    const cx = 205;
    const cy = 520;
    const R = 160;
    const hdg = ap.magHeading;
    g.save();
    g.beginPath();
    g.rect(60, 352, 300, 88);
    g.clip();
    g.fillStyle = C.tape;
    g.beginPath();
    g.arc(cx, cy, R, 0, Math.PI * 2);
    g.fill();
    g.strokeStyle = C.white;
    g.lineWidth = 1.5;
    for (let d = 0; d < 360; d += 5) {
      const a = (d - hdg - 90) * DEG;
      const len = d % 10 === 0 ? 10 : 6;
      g.beginPath();
      g.moveTo(cx + Math.cos(a) * R, cy + Math.sin(a) * R);
      g.lineTo(cx + Math.cos(a) * (R - len), cy + Math.sin(a) * (R - len));
      g.stroke();
      if (d % 30 === 0) {
        g.save();
        g.translate(cx + Math.cos(a) * (R - 22), cy + Math.sin(a) * (R - 22));
        g.rotate(a + Math.PI / 2);
        text(g, String(d / 10), 0, 0, C.white, 13, 'center');
        g.restore();
      }
    }
    const ba = (ap.mcp.hdg - hdg - 90) * DEG;
    g.save();
    g.translate(cx + Math.cos(ba) * R, cy + Math.sin(ba) * R);
    g.rotate(ba + Math.PI / 2);
    g.strokeStyle = C.magenta;
    g.lineWidth = 2;
    g.strokeRect(-8, -2, 16, 8);
    g.restore();
    const ta = (wrap360(ac.track - ap.magVar) - hdg - 90) * DEG;
    g.strokeStyle = C.white;
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(cx, cy);
    g.lineTo(cx + Math.cos(ta) * R, cy + Math.sin(ta) * R);
    g.stroke();
    g.restore();
    g.fillStyle = C.white;
    g.beginPath();
    g.moveTo(cx, cy - R + 1);
    g.lineTo(cx - 7, cy - R - 10);
    g.lineTo(cx + 7, cy - R - 10);
    g.fill();
    text(g, pad3(hdg), cx, 352, C.white, 15, 'center', '700');
    text(g, 'MAG', cx + 38, 352, C.green, 11, 'center');
    text(g, `${pad3(ap.mcp.hdg)} H`, 92, 372, C.magenta, 13, 'center');
    text(g, `CRS ${pad3(sim.radios.nav1.course)}`, 330, 372, C.magenta, 12, 'center');
  }
}

// ------------------------------------------------------------------------------- ND

export type NdMode = 'MAP' | 'VOR' | 'APP';

export class ND {
  readonly W = 440;
  readonly H = 440;
  private readonly g: G;
  readonly ranges = [5, 10, 20, 40, 80, 160, 320];
  rangeIdx = 2;
  mode: NdMode = 'MAP';
  show = { wxr: true, sta: true, wpt: false, arpt: true };
  private wxr: HTMLCanvasElement;
  private wxrTimer = 0;
  private wxrRange = 0;

  constructor(readonly canvas: HTMLCanvasElement, readonly side: 1 | 2 = 1) {
    this.g = setup(canvas, this.W, this.H);
    this.wxr = document.createElement('canvas');
    this.wxr.width = 72;
    this.wxr.height = 40;
  }

  get range(): number {
    return this.ranges[this.rangeIdx];
  }

  zoom(d: number): void {
    this.rangeIdx = clamp(this.rangeIdx + d, 0, this.ranges.length - 1);
    this.wxrTimer = 0;
  }

  cycleMode(): void {
    this.mode = this.mode === 'MAP' ? 'VOR' : this.mode === 'VOR' ? 'APP' : 'MAP';
  }

  /** Weather radar: reflectivity sampled ahead of the aircraft into a small image. */
  private updateWxr(sim: Simulation, dt: number): void {
    this.wxrTimer -= dt;
    if (this.wxrTimer > 0 && this.wxrRange === this.range) return;
    this.wxrTimer = 0.5;
    this.wxrRange = this.range;
    const ac = sim.ac;
    const cv = this.wxr;
    const g = cv.getContext('2d')!;
    const img = g.createImageData(cv.width, cv.height);
    const rangeM = this.range * NM;
    const h = ac.heading * DEG;
    const sinH = Math.sin(h);
    const cosH = Math.cos(h);
    for (let j = 0; j < cv.height; j++) {
      for (let i = 0; i < cv.width; i++) {
        // Pixel -> forward/right distance (the image spans [-range, range] x [0, range]).
        const right = ((i + 0.5) / cv.width - 0.5) * 2 * rangeM;
        const fwd = (1 - (j + 0.5) / cv.height) * rangeM;
        if (Math.hypot(right, fwd) > rangeM || Math.abs(Math.atan2(right, fwd)) > 62 * DEG) continue;
        const x = ac.pos[0] + fwd * sinH + right * cosH;
        const z = ac.pos[2] - fwd * cosH + right * sinH;
        const dbz = sim.weather.reflectivity(x, z);
        if (dbz < 20) continue;
        const k = (j * cv.width + i) * 4;
        const [r, gg, b] = dbz >= 50 ? [255, 40, 255] : dbz >= 40 ? [255, 30, 30] : dbz >= 30 ? [255, 220, 0] : [20, 190, 40];
        img.data[k] = r;
        img.data[k + 1] = gg;
        img.data[k + 2] = b;
        img.data[k + 3] = 200;
      }
    }
    g.putImageData(img, 0, 0);
  }

  draw(sim: Simulation, dt: number): void {
    const g = this.g;
    g.fillStyle = C.bg;
    g.fillRect(0, 0, this.W, this.H);
    if (this.mode === 'MAP') this.drawMap(g, sim, dt);
    else this.drawRose(g, sim);
  }

  private drawMap(g: G, sim: Simulation, dt: number): void {
    const ac = sim.ac;
    const ap = sim.ap;
    const W = this.W;
    const H = this.H;
    const cx = W / 2;
    const cy = 360;
    const R = 290;
    const scale = R / (this.range * NM);
    const hdgT = ac.heading;
    const hdgM = ap.magHeading;
    const sinH = Math.sin(hdgT * DEG);
    const cosH = Math.cos(hdgT * DEG);
    const toScreen = (x: number, z: number): [number, number] => {
      const dx = x - ac.pos[0];
      const dz = z - ac.pos[2];
      const fwd = dx * sinH - dz * cosH;
      const right = dx * cosH + dz * sinH;
      return [cx + right * scale, cy - fwd * scale];
    };
    const onScreen = (sx: number, sy: number) => sx > -20 && sx < W + 20 && sy > 20 && sy < H + 20;
    g.save();
    g.beginPath();
    g.rect(0, 30, W, H - 30);
    g.clip();
    // Weather radar returns.
    if (this.show.wxr) {
      this.updateWxr(sim, dt);
      g.save();
      g.globalAlpha = 0.85;
      g.imageSmoothingEnabled = true;
      g.drawImage(this.wxr, cx - R, cy - R, 2 * R, R);
      g.restore();
    }
    g.strokeStyle = C.white;
    g.lineWidth = 1.5;
    g.beginPath();
    g.arc(cx, cy, R, Math.PI * 1.17, Math.PI * 1.83);
    g.stroke();
    g.strokeStyle = C.gray;
    g.setLineDash([4, 6]);
    g.beginPath();
    g.arc(cx, cy, R / 2, Math.PI * 1.1, Math.PI * 1.9);
    g.stroke();
    g.setLineDash([]);
    text(g, String(this.range / 2), cx - (R / 2) * 0.86 - 8, cy - (R / 2) * 0.5, C.white, 11, 'center');
    for (let d = 0; d < 360; d += 5) {
      const rel = wrap180(d - hdgM);
      if (Math.abs(rel) > 58) continue;
      const a = (rel - 90) * DEG;
      const len = d % 10 === 0 ? 11 : 6;
      g.strokeStyle = C.white;
      g.beginPath();
      g.moveTo(cx + Math.cos(a) * R, cy + Math.sin(a) * R);
      g.lineTo(cx + Math.cos(a) * (R + len), cy + Math.sin(a) * (R + len));
      g.stroke();
      if (d % 30 === 0) text(g, String(d / 10), cx + Math.cos(a) * (R + 22), cy + Math.sin(a) * (R + 22), C.white, 13, 'center');
    }
    if (Math.abs(wrap180(ap.mcp.hdg - hdgM)) < 60) {
      const hb = (wrap180(ap.mcp.hdg - hdgM) - 90) * DEG;
      g.save();
      g.translate(cx + Math.cos(hb) * R, cy + Math.sin(hb) * R);
      g.rotate(hb + Math.PI / 2);
      g.strokeStyle = C.magenta;
      g.lineWidth = 2;
      g.strokeRect(-9, -2, 18, 9);
      g.restore();
    }
    const trel = wrap180(ac.track - ac.heading);
    g.strokeStyle = C.white;
    g.lineWidth = 1;
    g.setLineDash([8, 6]);
    g.beginPath();
    g.moveTo(cx, cy);
    const ta = (trel - 90) * DEG;
    g.lineTo(cx + Math.cos(ta) * R, cy + Math.sin(ta) * R);
    g.stroke();
    g.setLineDash([]);

    const nav = sim.world.nav;
    const rangeM = this.range * NM * 1.3;
    // Fixes (waypoints) at short ranges.
    if (this.show.wpt && this.range <= 40) {
      g.strokeStyle = C.cyan;
      g.lineWidth = 1.2;
      for (const f of nav.fixes) {
        if (Math.abs(f.x - ac.pos[0]) > rangeM || Math.abs(f.z - ac.pos[2]) > rangeM) continue;
        const [sx, sy] = toScreen(f.x, f.z);
        if (!onScreen(sx, sy)) continue;
        g.beginPath();
        g.moveTo(sx, sy - 5);
        g.lineTo(sx + 5, sy + 4);
        g.lineTo(sx - 5, sy + 4);
        g.closePath();
        g.stroke();
        text(g, f.id, sx + 7, sy + 8, C.cyan, 10);
      }
    }
    // Navaids.
    if (this.show.sta) {
      for (const n of nav.navaids) {
        if (Math.abs(n.x - ac.pos[0]) > rangeM || Math.abs(n.z - ac.pos[2]) > rangeM) continue;
        const [sx, sy] = toScreen(n.x, n.z);
        if (!onScreen(sx, sy)) continue;
        const tuned = [sim.radios.nav1, sim.radios.nav2].some((r) => r.vor === n) || sim.radios.adf.station === n;
        const col = tuned ? C.green : C.cyan;
        g.strokeStyle = col;
        g.lineWidth = 1.5;
        if (n.isNdb) {
          g.setLineDash([2, 3]);
          g.beginPath();
          g.arc(sx, sy, 6, 0, Math.PI * 2);
          g.stroke();
          g.setLineDash([]);
        } else {
          g.beginPath();
          for (let k = 0; k < 6; k++) {
            const a = (k * Math.PI) / 3;
            g.lineTo(sx + Math.cos(a) * 6, sy + Math.sin(a) * 6);
          }
          g.closePath();
          g.stroke();
          if (n.raw.dme) {
            g.strokeRect(sx - 2, sy - 2, 4, 4);
          }
        }
        text(g, n.id, sx + 9, sy - 8, col, 11);
        if (this.range <= 20) text(g, n.raw.freq.toFixed(n.raw.unit === 'MHz' ? 2 : 0), sx + 9, sy + 5, col, 9);
      }
    }
    // Airports and runways.
    if (this.show.arpt) {
      for (const a of nav.airports) {
        if (Math.abs(a.x - ac.pos[0]) > rangeM || Math.abs(a.z - ac.pos[2]) > rangeM) continue;
        if (this.range >= 80 && a.longest < 1800) continue;
        const [sx, sy] = toScreen(a.x, a.z);
        if (!onScreen(sx, sy)) continue;
        if (this.range <= 20) {
          g.strokeStyle = C.white;
          g.lineWidth = 2;
          for (const rw of a.runways) {
            const [x1, y1] = toScreen(rw.ends[0].x, rw.ends[0].z);
            const [x2, y2] = toScreen(rw.ends[1].x, rw.ends[1].z);
            g.beginPath();
            g.moveTo(x1, y1);
            g.lineTo(x2, y2);
            g.stroke();
          }
        }
        g.strokeStyle = C.cyan;
        g.lineWidth = 1.5;
        g.beginPath();
        g.arc(sx, sy, 6, 0, Math.PI * 2);
        g.stroke();
        text(g, a.ident, sx + 10, sy + 10, C.cyan, 12);
      }
    }
    // Localizer course line.
    const loc = sim.radios.nav1.kind === 'ils' ? sim.radios.nav1.loc : null;
    if (loc) {
      const [x1, y1] = toScreen(loc.tx, loc.tz);
      const [fx, fz] = loc.pointOnFinal(15 * NM);
      const [x2, y2] = toScreen(fx, fz);
      g.strokeStyle = C.magenta;
      g.globalAlpha = 0.65;
      g.setLineDash([10, 8]);
      g.beginPath();
      g.moveTo(x1, y1);
      g.lineTo(x2, y2);
      g.stroke();
      g.setLineDash([]);
      g.globalAlpha = 1;
    }
    // Route.
    const plan = sim.plan;
    if (plan) {
      const legs = plan.legs;
      for (let i = 1; i < legs.length; i++) {
        const [x1, y1] = toScreen(legs[i - 1].x, legs[i - 1].z);
        const [x2, y2] = toScreen(legs[i].x, legs[i].z);
        const missed = legs[i].source === 'MISSED' && !plan.missedActive;
        g.strokeStyle = i === plan.active ? C.magenta : missed ? C.cyan : i > plan.active ? C.white : C.gray;
        g.lineWidth = i === plan.active ? 2.5 : 1.5;
        if (missed) g.setLineDash([6, 6]);
        g.beginPath();
        g.moveTo(x1, y1);
        g.lineTo(x2, y2);
        g.stroke();
        g.setLineDash([]);
      }
      for (let i = 0; i < legs.length; i++) {
        const l = legs[i];
        const [sx, sy] = toScreen(l.x, l.z);
        if (!onScreen(sx, sy)) continue;
        const col = i === plan.active ? C.magenta : C.white;
        g.fillStyle = col;
        g.beginPath();
        for (let k = 0; k < 8; k++) {
          const a = (k * Math.PI) / 4;
          const rr = k % 2 ? 2.1 : 7;
          g.lineTo(sx + Math.cos(a) * rr, sy + Math.sin(a) * rr);
        }
        g.closePath();
        g.fill();
        text(g, l.ident, sx + 9, sy - 9, col, 12);
        if (l.alt && !l.runway) {
          const a = l.alt;
          const s = a.kind === 'between' ? `${a.lo}A${a.hi}B` : `${a.lo}${a.kind === 'above' ? 'A' : a.kind === 'below' ? 'B' : ''}`;
          text(g, s, sx + 9, sy + 5, col, 10);
        }
      }
    }
    g.restore();

    // Bearing pointers: VOR 1 (narrow green) and VOR 2 / ADF (wide cyan).
    const ptr = (relDeg: number, color: string, wide: boolean) => {
      const a = (relDeg - 90) * DEG;
      g.strokeStyle = color;
      g.lineWidth = wide ? 3 : 1.8;
      g.beginPath();
      g.moveTo(cx + Math.cos(a) * (R - 6), cy + Math.sin(a) * (R - 6));
      g.lineTo(cx + Math.cos(a) * (R - 40), cy + Math.sin(a) * (R - 40));
      g.moveTo(cx - Math.cos(a) * (R - 6), cy - Math.sin(a) * (R - 6));
      g.lineTo(cx - Math.cos(a) * (R - 40), cy - Math.sin(a) * (R - 40));
      g.stroke();
    };
    const r1 = sim.radios.nav1;
    const r2 = sim.radios.nav2;
    const adf = sim.radios.adf;
    if (r1.receiving && r1.kind === 'vor') ptr(wrap180(r1.bearingTo - hdgM), C.green, false);
    if (r2.receiving && r2.kind === 'vor') ptr(wrap180(r2.bearingTo - hdgM), C.cyan, true);
    if (adf.station) ptr(wrap180(adf.relBearing), C.cyan, true);

    // Aircraft symbol.
    g.strokeStyle = C.white;
    g.lineWidth = 2.5;
    g.beginPath();
    g.moveTo(cx, cy - 16);
    g.lineTo(cx - 9, cy + 10);
    g.lineTo(cx + 9, cy + 10);
    g.closePath();
    g.stroke();
    this.header(g, sim, hdgM);
    // Footer: tuned stations.
    const vorLabel = (r: NavRadio, n: number) =>
      r.receiving ? `${r.kind === 'ils' ? 'ILS' : 'VOR'}${n} ${r.ident}${r.dmeNm !== null ? ` ${r.dmeNm.toFixed(1)}` : ''}` : `VOR${n} ${freqText(r)}`;
    text(g, vorLabel(r1, 1), 8, H - 30, r1.receiving ? C.green : C.gray, 11);
    text(g, adf.station ? `ADF ${adf.ident}` : vorLabel(r2, 2), 8, H - 14, adf.station || r2.receiving ? C.cyan : C.gray, 11);
    const flags = [this.show.wxr ? 'WXR' : '', this.show.sta ? 'STA' : '', this.show.wpt ? 'WPT' : '', this.show.arpt ? 'ARPT' : ''].filter(Boolean).join(' ');
    text(g, flags, W - 8, H - 30, C.cyan, 10, 'right');
    text(g, `${this.range} NM`, W - 8, H - 14, C.cyan, 12, 'right');
    const info = sim.routeInfo();
    if (info.todNm !== null && info.todNm > 0) text(g, `T/D ${info.todNm.toFixed(0)} NM`, cx, H - 14, C.green, 11, 'center');
  }

  private header(g: G, sim: Simulation, hdgM: number): void {
    const ac = sim.ac;
    const W = this.W;
    g.fillStyle = '#000';
    g.fillRect(0, 0, W, 30);
    text(g, 'GS', 8, 15, C.white, 12);
    text(g, String(Math.round(ac.gs / KT)), 32, 15, C.white, 16, 'left', '700');
    text(g, 'TAS', 74, 15, C.white, 12);
    text(g, String(Math.round(ac.tas / KT)), 104, 15, C.white, 16, 'left', '700');
    if (this.mode === 'MAP') {
      const leg = sim.plan?.activeLeg;
      const info = sim.routeInfo();
      if (leg) {
        text(g, leg.ident, W - 8, 13, C.magenta, 15, 'right', '700');
        const eta = new Date(sim.clock.getTime() + ((info.nextDist * NM) / Math.max(ac.gs, 50)) * 1000);
        text(g, `${info.nextDist.toFixed(1)} NM  ${String(eta.getUTCHours()).padStart(2, '0')}${String(eta.getUTCMinutes()).padStart(2, '0')}z`, W - 8, 30, C.white, 12, 'right');
      }
    }
    text(g, `HDG ${pad3(hdgM)} MAG`, W / 2, 15, C.green, 14, 'center', '700');
    const w = ac.wind;
    const wspd = Math.hypot(w[0], w[2]) / KT;
    if (wspd > 1) {
      const from = wrap360(Math.atan2(-w[0], w[2]) * RAD);
      text(g, `${pad3(from - sim.ap.magVar)}°/${Math.round(wspd)}`, 10, 48, C.white, 13);
      const rel = (from - ac.heading + 180) * DEG;
      g.save();
      g.translate(28, 76);
      g.rotate(rel);
      g.strokeStyle = C.white;
      g.lineWidth = 2;
      g.beginPath();
      g.moveTo(0, -14);
      g.lineTo(0, 14);
      g.moveTo(-5, 8);
      g.lineTo(0, 14);
      g.lineTo(5, 8);
      g.stroke();
      g.restore();
    }
  }

  /** VOR / APP mode: full compass rose with course pointer and deviation bar. */
  private drawRose(g: G, sim: Simulation): void {
    const ap = sim.ap;
    const W = this.W;
    const H = this.H;
    const cx = W / 2;
    const cy = 238;
    const R = 160;
    const hdgM = ap.magHeading;
    const r = this.side === 1 ? sim.radios.nav1 : sim.radios.nav2;
    g.strokeStyle = C.white;
    g.lineWidth = 1.5;
    g.beginPath();
    g.arc(cx, cy, R, 0, Math.PI * 2);
    g.stroke();
    for (let d = 0; d < 360; d += 5) {
      const a = (d - hdgM - 90) * DEG;
      const len = d % 10 === 0 ? 12 : 6;
      g.beginPath();
      g.moveTo(cx + Math.cos(a) * R, cy + Math.sin(a) * R);
      g.lineTo(cx + Math.cos(a) * (R - len), cy + Math.sin(a) * (R - len));
      g.stroke();
      if (d % 30 === 0) {
        g.save();
        g.translate(cx + Math.cos(a) * (R - 24), cy + Math.sin(a) * (R - 24));
        g.rotate(a + Math.PI / 2);
        text(g, String(d / 10), 0, 0, C.white, 14, 'center');
        g.restore();
      }
    }
    // Lubber line and heading bug.
    g.fillStyle = C.white;
    g.beginPath();
    g.moveTo(cx, cy - R - 2);
    g.lineTo(cx - 7, cy - R - 14);
    g.lineTo(cx + 7, cy - R - 14);
    g.fill();
    const hb = (ap.mcp.hdg - hdgM - 90) * DEG;
    g.save();
    g.translate(cx + Math.cos(hb) * R, cy + Math.sin(hb) * R);
    g.rotate(hb + Math.PI / 2);
    g.strokeStyle = C.magenta;
    g.lineWidth = 2;
    g.strokeRect(-9, -2, 18, 9);
    g.restore();
    // Course pointer and CDI.
    const crs = r.kind === 'ils' && r.loc ? r.loc.courseMag : r.course;
    g.save();
    g.translate(cx, cy);
    g.rotate((crs - hdgM) * DEG);
    g.strokeStyle = C.magenta;
    g.fillStyle = C.magenta;
    g.lineWidth = 3;
    g.beginPath();
    g.moveTo(0, -R + 14);
    g.lineTo(0, -60);
    g.moveTo(0, 60);
    g.lineTo(0, R - 14);
    g.stroke();
    g.beginPath();
    g.moveTo(0, -R + 4);
    g.lineTo(-8, -R + 20);
    g.lineTo(8, -R + 20);
    g.closePath();
    g.fill();
    g.strokeStyle = C.white;
    g.lineWidth = 1.5;
    const dotPx = 32;
    for (const d of [-2, -1, 1, 2]) {
      g.beginPath();
      g.arc(d * dotPx, 0, 4, 0, Math.PI * 2);
      g.stroke();
    }
    if (r.receiving) {
      const dev = clamp(-r.cdiDots, -2.5, 2.5) * dotPx;
      g.strokeStyle = C.magenta;
      g.lineWidth = 4;
      g.beginPath();
      g.moveTo(dev, -56);
      g.lineTo(dev, 56);
      g.stroke();
      if (r.toFrom) {
        g.fillStyle = C.white;
        g.beginPath();
        const s = r.toFrom === 'TO' ? -1 : 1;
        g.moveTo(0, s * 92);
        g.lineTo(-8, s * 78);
        g.lineTo(8, s * 78);
        g.closePath();
        g.fill();
      }
    } else {
      text(g, r.kind === 'ils' ? 'LOC' : 'VOR', 0, -20, C.red, 14, 'center', '700');
    }
    g.restore();
    // Aircraft symbol.
    g.strokeStyle = C.white;
    g.lineWidth = 2.5;
    g.beginPath();
    g.moveTo(cx, cy - 14);
    g.lineTo(cx, cy + 22);
    g.moveTo(cx - 18, cy);
    g.lineTo(cx + 18, cy);
    g.moveTo(cx - 7, cy + 18);
    g.lineTo(cx + 7, cy + 18);
    g.stroke();
    // Glide slope scale in APP mode.
    if (this.mode === 'APP') {
      const gx = W - 34;
      g.strokeStyle = C.white;
      g.lineWidth = 1.5;
      for (const d of [-2, -1, 1, 2]) {
        g.beginPath();
        g.arc(gx, cy + d * 32, 4, 0, Math.PI * 2);
        g.stroke();
      }
      g.beginPath();
      g.moveTo(gx - 12, cy);
      g.lineTo(gx + 12, cy);
      g.stroke();
      if (r.receiving && r.gsDots !== null) {
        g.fillStyle = C.magenta;
        diamond(g, gx, cy + clamp(r.gsDots, -2.5, 2.5) * 32, 7, 9);
      } else {
        text(g, 'G/S', gx, cy - 90, r.kind === 'ils' ? C.red : C.gray, 12, 'center', '700');
      }
    }
    this.header(g, sim, hdgM);
    const label = this.mode === 'APP' ? (r.kind === 'ils' ? 'ILS' : 'LOC') : 'VOR';
    text(g, `${label} ${this.side}`, W - 8, 46, C.green, 13, 'right', '700');
    text(g, freqText(r), W - 8, 62, C.white, 13, 'right');
    text(g, `CRS ${pad3(crs)}`, W - 8, 78, C.magenta, 13, 'right');
    text(g, r.receiving ? r.ident : '', W - 8, 94, C.white, 13, 'right', '700');
    text(g, r.dmeNm !== null && r.receiving ? `DME ${r.dmeNm.toFixed(1)}` : 'DME ---', W - 8, 110, C.white, 12, 'right');
    if (r.receiving && r.kind === 'vor') text(g, `R ${pad3(r.radial)} ${r.toFrom}`, 8, H - 14, C.green, 12);
  }
}

// ------------------------------------------------------------------------------- EICAS

export class EICAS {
  readonly W = 300;
  readonly H = 440;
  private readonly g: G;

  constructor(readonly canvas: HTMLCanvasElement) {
    this.g = setup(canvas, this.W, this.H);
  }

  private dial(g: G, x: number, y: number, r: number, value: number, max: number, label: string, digital: string, warn: number, cmd?: number): void {
    const a0 = Math.PI * 0.75;
    const span = Math.PI * 1.25;
    g.strokeStyle = C.white;
    g.lineWidth = 2;
    g.beginPath();
    g.arc(x, y, r, a0, a0 + span);
    g.stroke();
    const redA = a0 + span * clamp(warn / max, 0, 1);
    g.strokeStyle = C.red;
    g.lineWidth = 3;
    g.beginPath();
    g.moveTo(x + Math.cos(redA) * (r - 6), y + Math.sin(redA) * (r - 6));
    g.lineTo(x + Math.cos(redA) * (r + 6), y + Math.sin(redA) * (r + 6));
    g.stroke();
    const va = a0 + span * clamp(value / max, 0, 1.05);
    g.fillStyle = 'rgba(255,255,255,0.12)';
    g.beginPath();
    g.moveTo(x, y);
    g.arc(x, y, r - 2, a0, va);
    g.closePath();
    g.fill();
    g.strokeStyle = C.white;
    g.lineWidth = 3;
    g.beginPath();
    g.moveTo(x, y);
    g.lineTo(x + Math.cos(va) * (r - 3), y + Math.sin(va) * (r - 3));
    g.stroke();
    if (cmd !== undefined) {
      const ca = a0 + span * clamp(cmd / max, 0, 1.05);
      g.strokeStyle = C.white;
      g.lineWidth = 2;
      g.beginPath();
      g.moveTo(x + Math.cos(ca) * (r + 2), y + Math.sin(ca) * (r + 2));
      g.lineTo(x + Math.cos(ca) * (r + 9), y + Math.sin(ca) * (r + 9));
      g.stroke();
    }
    box(g, x - 4, y - r * 0.55 - 12, r + 4, 22, C.white, '#000', 1);
    text(g, digital, x + r - 4, y - r * 0.55 - 1, value > warn ? C.red : C.white, 15, 'right', '700');
    text(g, label, x, y + r * 0.55, C.cyan, 11, 'center');
  }

  draw(sim: Simulation): void {
    const g = this.g;
    const ac = sim.ac;
    const c = ac.controls;
    g.fillStyle = C.bg;
    g.fillRect(0, 0, this.W, this.H);
    const engs = ac.engines;
    // TAT / SAT.
    const sat = ac.air.T - 273.15;
    const tat = sat + (ac.tas * ac.tas) / 2010;
    text(g, `TAT ${tat >= 0 ? '+' : ''}${Math.round(tat)}c  SAT ${sat >= 0 ? '+' : ''}${Math.round(sat)}c`, 150, 10, C.white, 10, 'center');
    for (let i = 0; i < 2; i++) {
      const e = engs[i];
      const x = 75 + i * 145;
      const cmdN1 = c.reverse ? 21 + 61 * c.throttle[i] : 21 + 79.5 * c.throttle[i];
      this.dial(g, x, 68, 44, e.n1, 110, 'N1', e.n1.toFixed(1), 104, cmdN1);
      if (e.reverser > 0.05) text(g, 'REV', x, 26, e.reverser > 0.95 ? C.green : C.amber, 13, 'center', '700');
      if (e.failed || !e.running) text(g, 'ENG FAIL', x, 26, C.amber, 12, 'center', '700');
      this.dial(g, x, 166, 36, e.egt, 1000, 'EGT', String(Math.round(e.egt)), 950);
    }
    let y = 226;
    text(g, 'N2', 150, y, C.cyan, 11, 'center');
    text(g, engs[0].n2.toFixed(1), 70, y, C.white, 13, 'center');
    text(g, engs[1].n2.toFixed(1), 230, y, C.white, 13, 'center');
    y += 20;
    text(g, 'FF', 150, y, C.cyan, 11, 'center');
    text(g, (engs[0].ff * 3.6).toFixed(2), 70, y, C.white, 13, 'center');
    text(g, (engs[1].ff * 3.6).toFixed(2), 230, y, C.white, 13, 'center');
    text(g, 'KGH x1000', 150, y + 12, C.gray, 9, 'center');
    y += 36;
    box(g, 20, y - 14, 260, 44, C.gray, '#05080b', 1);
    text(g, 'FUEL KG', 32, y - 2, C.cyan, 11);
    text(g, Math.round(ac.fuel).toLocaleString('en-US'), 268, y - 2, ac.fuel < 1500 ? C.amber : C.white, 16, 'right', '700');
    text(g, `GW ${(ac.mass / 1000).toFixed(1)} T`, 32, y + 16, C.white, 11);
    text(g, `TRIM ${(4.5 + c.trim * 7).toFixed(1)}`, 268, y + 16, C.white, 11, 'right');
    y += 52;
    const gearCol = ac.gearPos > 0.99 ? C.green : ac.gearPos < 0.01 ? C.gray : C.amber;
    const gearTxt = ac.gearPos > 0.99 ? 'DOWN' : ac.gearPos < 0.01 ? 'UP' : 'TRANSIT';
    if (gearTxt !== 'UP') {
      for (const [gx, gy] of [[150, y], [112, y + 26], [188, y + 26]]) {
        box(g, gx - 26, gy - 10, 52, 20, gearCol, '#000', 1.5);
        if (gearTxt === 'DOWN') text(g, 'DOWN', gx, gy, gearCol, 11, 'center', '700');
        else {
          g.fillStyle = 'rgba(255,176,0,0.4)';
          g.fillRect(gx - 25, gy - 9, 50, 18);
        }
      }
    } else {
      text(g, 'GEAR UP', 150, y + 12, C.gray, 11, 'center');
    }
    text(g, 'GEAR', 38, y + 12, C.cyan, 11, 'center');
    const fx = 262;
    g.strokeStyle = C.white;
    g.lineWidth = 1.5;
    g.strokeRect(fx - 7, y - 10, 14, 52);
    g.fillStyle = Math.abs(ac.flapPos - c.flapLever) > 0.05 ? C.amber : C.green;
    g.fillRect(fx - 6, y - 9, 12, 50 * (ac.flapPos / 8));
    text(g, 'FLAPS', fx - 12, y - 18, C.cyan, 10, 'right');
    text(g, FLAP_NAMES[c.flapLever], fx - 12, y + 30, C.green, 14, 'right', '700');
    y += 64;
    const items: [string, string][] = [];
    if (c.parkingBrake) items.push(['PARKING BRAKE', C.amber]);
    if (c.speedbrakeArmed) items.push(['SPEEDBRAKE ARMED', C.green]);
    else if (ac.spoilerPos > 0.03) items.push([`SPEEDBRAKE ${ac.wow ? 'UP' : 'EXT'}`, ac.wow ? C.green : C.amber]);
    if (c.autobrake !== 'OFF') items.push([`AUTO BRAKE ${c.autobrake}${ac.autobrakeActive ? ' (ACT)' : ''}`, C.green]);
    if (ac.tailStrike) items.push(['TAIL STRIKE', C.red]);
    const w = sim.warnings.active;
    if (w.has('config')) items.push(['TAKEOFF CONFIG', C.red]);
    if (w.has('overspeed')) items.push(['OVERSPEED', C.red]);
    if (w.has('stall')) items.push(['STALL', C.red]);
    if (w.has('windshear')) items.push(['WINDSHEAR', C.red]);
    if (ac.env?.icing) items.push(['ICING - ANTI-ICE ON', C.amber]);
    if (ac.fuel < 1500) items.push(['FUEL LOW', C.amber]);
    for (const d of ac.damage) items.push([d.toUpperCase(), C.amber]);
    for (let i = 0; i < Math.min(items.length, 6); i++) text(g, items[i][0], 150, y + i * 17, items[i][1], 13, 'center', '700');
  }
}
