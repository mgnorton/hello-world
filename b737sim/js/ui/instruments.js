// Glass cockpit displays drawn on 2D canvases: PFD, ND and EICAS.
import { clamp, wrap180, wrap360, DEG, RAD, KT, FT, FPM, NM, dirOf } from '../math.js';
import { B739, stallSpeed, FLAP_NAMES } from '../aircraftData.js';
import { casFromMach } from '../atmosphere.js';

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

function setup(canvas, w, h) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  const g = canvas.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  return g;
}

function text(g, s, x, y, color = C.white, size = 14, align = 'left', weight = '600') {
  g.fillStyle = color;
  g.font = `${weight} ${size}px "B612 Mono", "DejaVu Sans Mono", Menlo, Consolas, monospace`;
  g.textAlign = align;
  g.textBaseline = 'middle';
  g.fillText(s, x, y);
}

function box(g, x, y, w, h, stroke = C.white, fill = '#000', lw = 1.5) {
  g.fillStyle = fill;
  g.fillRect(x, y, w, h);
  g.strokeStyle = stroke;
  g.lineWidth = lw;
  g.strokeRect(x, y, w, h);
}

export class PFD {
  constructor(canvas) {
    this.canvas = canvas;
    this.W = 440;
    this.H = 440;
    this.g = setup(canvas, this.W, this.H);
    this.trend = 0;
    this.prevIas = 0;
  }

  draw(sim, dt) {
    const g = this.g;
    const ac = sim.ac;
    const ap = sim.ap;
    const W = this.W;
    g.fillStyle = C.bg;
    g.fillRect(0, 0, W, this.H);
    const iasKt = ac.ias / KT;
    const acc = (iasKt - this.prevIas) / Math.max(dt, 1e-3);
    this.prevIas = iasKt;
    this.trend += (acc * 10 - this.trend) * Math.min(1, dt * 1.5);
    this.drawAttitude(g, sim);
    this.drawSpeed(g, sim, iasKt);
    this.drawAltitude(g, sim);
    this.drawVsi(g, ac);
    this.drawHeading(g, sim);
    this.drawFma(g, ap.fma(), sim);
  }

  drawFma(g, f, sim) {
    const cols = [[10, 130], [140, 140], [280, 150]];
    g.strokeStyle = C.gray;
    g.lineWidth = 1;
    for (const [x, w] of cols) g.strokeRect(x, 4, w, 42);
    text(g, f.at, 75, 17, C.green, 15, 'center');
    text(g, f.roll, 210, 17, C.green, 15, 'center');
    text(g, f.rollArmed, 210, 36, C.white, 12, 'center');
    text(g, f.pitch, 355, 17, C.green, 15, 'center');
    text(g, f.pitchArmed, 355, 36, C.white, 12, 'center');
    const st = f.status;
    if (st) text(g, st, 205, 66, st === 'FD' ? C.green : C.green, st.length > 3 ? 16 : 18, 'center', '700');
    if (sim.ap.cmd === false && sim.apDiscFlash > 0) text(g, 'AP DISC', 205, 66, C.red, 16, 'center', '700');
  }

  drawAttitude(g, sim) {
    const ac = sim.ac;
    const ap = sim.ap;
    const cx = 205;
    const cy = 202;
    const ppd = 7.2; // pixels per degree of pitch
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
    // Pitch ladder.
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
    // Bank scale (rotates with the horizon).
    g.restore();
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
    // Roll pointer + slip indicator.
    g.rotate(-ac.roll * DEG);
    const bankWarn = Math.abs(ac.roll) > 35;
    g.fillStyle = bankWarn ? C.amber : C.white;
    g.beginPath();
    g.moveTo(0, -R + 1);
    g.lineTo(-7, -R + 12);
    g.lineTo(7, -R + 12);
    g.closePath();
    g.fill();
    const slip = clamp(-ac.beta * RAD * 4, -14, 14);
    g.fillRect(-8 + slip, -R + 14, 16, 4);
    g.restore();

    // Flight director bars.
    if (ap.fd || ap.cmd) {
      const fdOk = ap.lat || ap.vert;
      if (fdOk) {
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

    // Flight path vector (bird) when airborne.
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

    // ILS deviation.
    const appr = ap.approach;
    if (appr) {
      const ils = appr.ils(ac.pos[0], ac.pos[1], ac.pos[2]);
      if (ils.along > -appr.runway.length && ils.dme < 30 && Math.abs(ils.locDev) < 35) {
        text(g, `ILS${appr.id}`, 108, 88, C.white, 12);
        text(g, `DME ${ils.dme.toFixed(1)}`, 108, 104, C.white, 12);
        // Localizer scale (1 dot = 1.25 deg).
        const ly = 322;
        g.strokeStyle = C.white;
        g.lineWidth = 1.5;
        for (const d of [-2, -1, 1, 2]) {
          g.beginPath();
          g.arc(cx + d * 30, ly, 3.5, 0, Math.PI * 2);
          g.stroke();
        }
        const ldots = clamp(-ils.locDev / 1.25, -2.4, 2.4);
        g.fillStyle = C.magenta;
        diamond(g, cx + ldots * 30, ly, 8, 6);
        // Glide slope scale (1 dot = 0.35 deg).
        if (ils.along > 0) {
          const gx = 296;
          for (const d of [-2, -1, 1, 2]) {
            g.beginPath();
            g.arc(gx, cy + d * 30, 3.5, 0, Math.PI * 2);
            g.stroke();
          }
          const gdots = clamp(ils.gsDev / 0.35, -2.4, 2.4);
          diamond(g, gx, cy + gdots * 30, 6, 8);
        }
      }
    }
    // Radio altitude.
    const ra = ac.radioAlt / FT;
    if (ra < 2500 && !ac.wow) {
      const rs = ra < 10 ? Math.round(ra) : ra < 100 ? Math.round(ra / 2) * 2 : Math.round(ra / 10) * 10;
      text(g, String(rs), cx, 296, ra < 200 ? C.amber : C.white, 18, 'center', '700');
    }
    // Warnings.
    const w = sim.warnings.active;
    if (w.has('pullup') || w.has('terrain')) text(g, 'PULL UP', cx, 250, C.red, 22, 'center', '800');
    else if (w.has('stall')) text(g, 'STALL', cx, 250, C.red, 20, 'center', '800');
    if (ac.crashed) text(g, 'CRASH', cx, 150, C.red, 26, 'center', '800');
  }

  drawSpeed(g, sim, ias) {
    const ac = sim.ac;
    const ap = sim.ap;
    const x0 = 22;
    const w = 62;
    const top = 74;
    const bot = 336;
    const cy = 202;
    const ppk = 3.3; // px per knot
    g.fillStyle = C.tape;
    g.fillRect(x0, top, w, bot - top);
    g.save();
    g.beginPath();
    g.rect(x0, top, w + 30, bot - top);
    g.clip();
    const disp = Math.max(ias, 30);
    const y = (v) => cy - (v - disp) * ppk;
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
    // Maximum speed barber pole.
    const fl = B739.flaps[Math.round(ac.flapPos)];
    let vmax = Math.min(B739.vmo, casFromMach(B739.mmo, ac.atm) / KT);
    if (ac.flapPos > 0.1) vmax = Math.min(vmax, fl.vfe);
    if (ac.gearPos > 0.05) vmax = Math.min(vmax, 270);
    // Minimum speeds from current stall speed.
    const detent = clamp(Math.round(ac.flapPos), 0, 8);
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
    // V-speed bugs.
    const vsp = sim.vspeeds;
    const bugs = [];
    if (ac.wow || ac.airborneTime < 30) {
      if (ac.wow) bugs.push([vsp.v1, 'V1'], [vsp.vr, 'VR']);
      bugs.push([vsp.v2 + 15, '']);
    }
    if (!ac.wow) {
      const ref40 = sim.vspeeds.vref40;
      const flapBugs = [[ref40 + 70, 'UP'], [ref40 + 50, '1'], [ref40 + 30, '5'], [ref40 + 20, '15']];
      for (const b of flapBugs) bugs.push(b);
      if (ac.flapPos >= 5) bugs.push([sim.vspeeds.vref30, 'REF']);
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
    // Selected speed bug.
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
    // Trend vector.
    if (Math.abs(this.trend) > 2 && !ac.wow) {
      g.strokeStyle = C.green;
      g.lineWidth = 2;
      g.beginPath();
      g.moveTo(x0 + w - 2, cy);
      g.lineTo(x0 + w - 2, y(disp + this.trend));
      g.stroke();
    }
    g.restore();
    // Current speed readout.
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
    // Selected speed readout.
    text(g, ap.mcp.useMach ? `.${Math.round(ap.mcp.mach * 1000).toString().padStart(3, '0')}` : String(Math.round(ap.mcp.spd)), x0 + w / 2, top - 12, C.magenta, 15, 'center');
    // Mach / GS.
    if (ac.mach > 0.4) text(g, `.${Math.round(ac.mach * 1000).toString().padStart(3, '0')}`, x0 + w / 2, bot + 12, C.white, 14, 'center');
    else text(g, `GS ${Math.round(ac.gs / KT)}`, x0 + w / 2, bot + 12, C.white, 12, 'center');
  }

  drawAltitude(g, sim) {
    const ac = sim.ac;
    const ap = sim.ap;
    const x0 = 330;
    const w = 66;
    const top = 74;
    const bot = 336;
    const cy = 202;
    const alt = ac.pos[1] / FT;
    const ppf = 0.26;
    g.fillStyle = C.tape;
    g.fillRect(x0, top, w, bot - top);
    g.save();
    g.beginPath();
    g.rect(x0 - 12, top, w + 12, bot - top);
    g.clip();
    const y = (a) => cy - (a - alt) * ppf;
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
    // Ground reference (amber hatched band below runway elevation).
    const gnd = (ac.pos[1] - ac.radioAlt - 2.57) / FT;
    if (ac.radioAlt / FT < 1200) {
      g.fillStyle = 'rgba(255,176,0,0.55)';
      g.fillRect(x0, y(gnd), 8, bot - y(gnd));
    }
    // Selected altitude bug.
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
    // Current altitude box.
    box(g, x0 + 2, cy - 15, w, 30, C.white, '#000');
    const a = Math.round(alt / 20) * 20;
    const big = Math.floor(a / 1000);
    const small = String(Math.abs(a % 1000)).padStart(3, '0');
    text(g, big ? String(big) : '', x0 + 32, cy, C.white, 20, 'right', '700');
    text(g, small, x0 + 33, cy, C.white, 15, 'left', '700');
    // Selected altitude readout, highlighted when approaching it.
    const near = Math.abs(sel - alt) < 900 && Math.abs(sel - alt) > 200;
    if (near) box(g, x0, top - 24, w + 2, 22, C.white, '#000', 1);
    text(g, String(sel), x0 + w / 2 + 2, top - 12, C.magenta, 15, 'center');
    text(g, 'STD', x0 + w / 2, bot + 12, C.cyan, 13, 'center');
  }

  drawVsi(g, ac) {
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
    const map = (fpm) => {
      const s = Math.sign(fpm);
      const a = Math.abs(fpm);
      const px = a <= 1000 ? (a / 1000) * 60 : 60 + (Math.min(a, 6000) - 1000) / 5000 * 40;
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
  }

  drawHeading(g, sim) {
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
    // Heading bug.
    const ba = (ap.mcp.hdg - hdg - 90) * DEG;
    g.save();
    g.translate(cx + Math.cos(ba) * R, cy + Math.sin(ba) * R);
    g.rotate(ba + Math.PI / 2);
    g.strokeStyle = C.magenta;
    g.lineWidth = 2;
    g.strokeRect(-8, -2, 16, 8);
    g.restore();
    // Track line.
    const ta = (wrap360(ac.track - ap.magVar) - hdg - 90) * DEG;
    g.strokeStyle = C.white;
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(cx, cy);
    g.lineTo(cx + Math.cos(ta) * R, cy + Math.sin(ta) * R);
    g.stroke();
    g.restore();
    // Pointer and box.
    g.fillStyle = C.white;
    g.beginPath();
    g.moveTo(cx, cy - R + 1);
    g.lineTo(cx - 7, cy - R - 10);
    g.lineTo(cx + 7, cy - R - 10);
    g.fill();
    text(g, `${String(Math.round(hdg) % 360 || 360).padStart(3, '0')}`, cx, 346 + 6, C.white, 15, 'center', '700');
    text(g, `MAG`, cx + 38, 352, C.green, 11, 'center');
    text(g, `${String(Math.round(ap.mcp.hdg)).padStart(3, '0')} H`, 92, 372, C.magenta, 13, 'center');
  }
}

function diamond(g, x, y, hw, hh) {
  g.beginPath();
  g.moveTo(x, y - hh);
  g.lineTo(x + hw, y);
  g.lineTo(x, y + hh);
  g.lineTo(x - hw, y);
  g.closePath();
  g.fill();
}

function barber(g, x, y0, y1) {
  const top = Math.min(y0, y1);
  const bot = Math.max(y0, y1);
  if (bot < 0 || top > 500) return;
  g.fillStyle = '#000';
  g.fillRect(x, top, 6, bot - top);
  g.fillStyle = C.red;
  for (let y = top; y < bot; y += 12) g.fillRect(x, y, 6, Math.min(6, bot - y));
}

export class ND {
  constructor(canvas) {
    this.canvas = canvas;
    this.W = 440;
    this.H = 440;
    this.g = setup(canvas, this.W, this.H);
    this.ranges = [5, 10, 20, 40, 80, 160, 320];
    this.rangeIdx = 2;
  }

  get range() {
    return this.ranges[this.rangeIdx];
  }

  zoom(d) {
    this.rangeIdx = clamp(this.rangeIdx + d, 0, this.ranges.length - 1);
  }

  draw(sim) {
    const g = this.g;
    const ac = sim.ac;
    const ap = sim.ap;
    const W = this.W;
    const H = this.H;
    g.fillStyle = C.bg;
    g.fillRect(0, 0, W, H);
    const cx = W / 2;
    const cy = 360;
    const R = 290;
    const scale = R / (this.range * NM);
    const hdgT = ac.heading; // true heading (map oriented heading up)
    const hdgM = ap.magHeading;
    const toScreen = (x, z) => {
      const dx = x - ac.pos[0];
      const dz = z - ac.pos[2];
      const fwd = dx * Math.sin(hdgT * DEG) - dz * Math.cos(hdgT * DEG);
      const right = dx * Math.cos(hdgT * DEG) + dz * Math.sin(hdgT * DEG);
      return [cx + right * scale, cy - fwd * scale];
    };
    g.save();
    g.beginPath();
    g.rect(0, 30, W, H - 30);
    g.clip();
    // Range arcs.
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
    text(g, String(this.range / 2), cx - R / 2 * 0.86 - 8, cy - R / 2 * 0.5, C.white, 11, 'center');
    // Compass ticks on the arc.
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
    // Heading bug.
    const hb = (wrap180(ap.mcp.hdg - hdgM) - 90) * DEG;
    if (Math.abs(wrap180(ap.mcp.hdg - hdgM)) < 60) {
      g.save();
      g.translate(cx + Math.cos(hb) * R, cy + Math.sin(hb) * R);
      g.rotate(hb + Math.PI / 2);
      g.strokeStyle = C.magenta;
      g.lineWidth = 2;
      g.strokeRect(-9, -2, 18, 9);
      g.restore();
    }
    // Track line.
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

    // Airports.
    for (const a of sim.nav.airports) {
      const [sx, sy] = toScreen(a.x, a.z);
      if (sx < -20 || sx > W + 20 || sy < 0 || sy > H + 20) continue;
      if (this.range <= 40) {
        g.strokeStyle = C.white;
        g.lineWidth = 2;
        for (const rw of a.runways) {
          const d = dirOf(rw.heading);
          const [x1, y1] = toScreen(rw.cx - d[0] * rw.length / 2, rw.cz - d[2] * rw.length / 2);
          const [x2, y2] = toScreen(rw.cx + d[0] * rw.length / 2, rw.cz + d[2] * rw.length / 2);
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
      text(g, a.icao, sx + 10, sy + 10, C.cyan, 12);
    }
    // Localizer course line.
    if (ap.approach && (ap.latArmed === 'VOR/LOC' || ap.lat === 'VOR/LOC' || this.range <= 40)) {
      const e = ap.approach;
      const [x1, y1] = toScreen(e.tx, e.tz);
      const [fx, fz] = e.pointOnFinal(15 * NM);
      const [x2, y2] = toScreen(fx, fz);
      g.strokeStyle = C.magenta;
      g.globalAlpha = 0.6;
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
    const wps = plan.waypoints;
    for (let i = 1; i < wps.length; i++) {
      const [x1, y1] = toScreen(wps[i - 1].x, wps[i - 1].z);
      const [x2, y2] = toScreen(wps[i].x, wps[i].z);
      g.strokeStyle = i === plan.active ? C.magenta : i > plan.active ? C.white : C.gray;
      g.lineWidth = i === plan.active ? 2.5 : 1.5;
      g.beginPath();
      g.moveTo(x1, y1);
      g.lineTo(x2, y2);
      g.stroke();
    }
    for (let i = 0; i < wps.length; i++) {
      const w = wps[i];
      const [sx, sy] = toScreen(w.x, w.z);
      if (sx < -20 || sx > W + 20 || sy < 0 || sy > H + 20) continue;
      const col = i === plan.active ? C.magenta : C.white;
      g.fillStyle = col;
      star(g, sx, sy, 7);
      text(g, w.name, sx + 9, sy - 9, col, 12);
      if (w.alt && w.kind !== 'rwy') text(g, `${Math.round(w.alt / FT / 100) * 100}`, sx + 9, sy + 5, col, 10);
    }
    // Top of descent marker.
    const info = sim.routeInfo();
    g.restore();

    // Aircraft symbol.
    g.strokeStyle = C.white;
    g.lineWidth = 2.5;
    g.beginPath();
    g.moveTo(cx, cy - 16);
    g.lineTo(cx - 9, cy + 10);
    g.lineTo(cx + 9, cy + 10);
    g.closePath();
    g.stroke();
    // Header.
    g.fillStyle = '#000';
    g.fillRect(0, 0, W, 30);
    text(g, 'GS', 8, 15, C.white, 12);
    text(g, String(Math.round(ac.gs / KT)), 32, 15, C.white, 16, 'left', '700');
    text(g, 'TAS', 74, 15, C.white, 12);
    text(g, String(Math.round(ac.tas / KT)), 104, 15, C.white, 16, 'left', '700');
    const wp = plan.activeWp;
    if (wp) {
      text(g, wp.name, W - 8, 13, C.magenta, 15, 'right', '700');
      const eta = new Date(Date.now() + (info.nextDist * NM / Math.max(ac.gs, 50)) * 1000);
      text(g, `${info.nextDist.toFixed(1)} NM  ${eta.getUTCHours().toString().padStart(2, '0')}${eta.getUTCMinutes().toString().padStart(2, '0')}z`, W - 8, 30, C.white, 12, 'right');
    }
    text(g, `HDG ${String(Math.round(hdgM)).padStart(3, '0')} MAG`, cx, 15, C.green, 14, 'center', '700');
    // Wind.
    const w = ac.wind;
    const wspd = Math.hypot(w[0], w[2]) / KT;
    if (wspd > 1) {
      const from = wrap360(Math.atan2(-w[0], w[2]) * RAD);
      text(g, `${String(Math.round(wrap360(from - ap.magVar))).padStart(3, '0')}°/${Math.round(wspd)}`, 10, 60, C.white, 13);
      const rel = (from - hdgT + 180) * DEG;
      g.save();
      g.translate(28, 88);
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
    text(g, `${this.range} NM`, W - 8, H - 14, C.cyan, 12, 'right');
    text(g, `DEST ${sim.arrAirport.icao} ${info.remainingNm.toFixed(0)} NM`, 8, H - 14, C.white, 12);
  }
}

function star(g, x, y, r) {
  g.beginPath();
  for (let i = 0; i < 8; i++) {
    const a = (i * Math.PI) / 4;
    const rr = i % 2 ? r * 0.3 : r;
    g.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
  }
  g.closePath();
  g.fill();
}

export class EICAS {
  constructor(canvas) {
    this.canvas = canvas;
    this.W = 300;
    this.H = 440;
    this.g = setup(canvas, this.W, this.H);
  }

  dial(g, x, y, r, value, max, label, digital, warn, cmd) {
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

  draw(sim) {
    const g = this.g;
    const ac = sim.ac;
    const c = ac.controls;
    g.fillStyle = C.bg;
    g.fillRect(0, 0, this.W, this.H);
    const engs = ac.engines;
    for (let i = 0; i < 2; i++) {
      const e = engs[i];
      const x = 75 + i * 145;
      const cmdN1 = (c.reverse ? 21 + 61 * c.throttle[i] : 21 + 79.5 * c.throttle[i]);
      this.dial(g, x, 62, 44, e.n1, 110, 'N1', e.n1.toFixed(1), 104, cmdN1);
      if (e.reverser > 0.05) text(g, 'REV', x, 22, e.reverser > 0.95 ? C.green : C.amber, 13, 'center', '700');
      if (e.failed || !e.running) text(g, 'ENG FAIL', x, 22, C.amber, 12, 'center', '700');
      this.dial(g, x, 160, 36, e.egt, 1000, 'EGT', String(Math.round(e.egt)), 950);
    }
    // Secondary engine data.
    let y = 222;
    text(g, 'N2', 150, y, C.cyan, 11, 'center');
    text(g, engs[0].n2.toFixed(1), 70, y, C.white, 13, 'center');
    text(g, engs[1].n2.toFixed(1), 230, y, C.white, 13, 'center');
    y += 20;
    text(g, 'FF', 150, y, C.cyan, 11, 'center');
    text(g, (engs[0].ff * 3.6).toFixed(2), 70, y, C.white, 13, 'center');
    text(g, (engs[1].ff * 3.6).toFixed(2), 230, y, C.white, 13, 'center');
    text(g, 'KGH x1000', 150, y + 12, C.gray, 9, 'center');
    y += 38;
    // Fuel.
    box(g, 20, y - 14, 260, 44, C.gray, '#05080b', 1);
    text(g, 'FUEL KG', 32, y - 2, C.cyan, 11);
    text(g, Math.round(ac.fuel).toLocaleString('en-US'), 268, y - 2, ac.fuel < 1500 ? C.amber : C.white, 16, 'right', '700');
    text(g, `GW ${(ac.mass / 1000).toFixed(1)} T`, 32, y + 16, C.white, 11);
    text(g, `TRIM ${(4.5 + c.trim * 7).toFixed(1)}`, 268, y + 16, C.white, 11, 'right');
    y += 52;
    // Gear.
    const gearCol = ac.gearPos > 0.99 ? C.green : ac.gearPos < 0.01 ? C.gray : C.amber;
    const gearTxt = ac.gearPos > 0.99 ? 'DOWN' : ac.gearPos < 0.01 ? 'UP' : 'TRANSIT';
    if (gearTxt !== 'UP') {
      for (const [gx, gy] of [[150, y], [112, y + 26], [188, y + 26]]) {
        box(g, gx - 26, gy - 10, 52, 20, gearCol, '#000', 1.5);
        text(g, gearTxt === 'DOWN' ? 'DOWN' : '', gx, gy, gearCol, 11, 'center', '700');
        if (gearTxt === 'TRANSIT') {
          g.fillStyle = 'rgba(255,176,0,0.4)';
          g.fillRect(gx - 25, gy - 9, 50, 18);
        }
      }
    } else {
      text(g, 'GEAR UP', 150, y + 12, C.gray, 11, 'center');
    }
    text(g, 'GEAR', 38, y + 12, C.cyan, 11, 'center');
    // Flaps gauge.
    const fx = 262;
    g.strokeStyle = C.white;
    g.lineWidth = 1.5;
    g.strokeRect(fx - 7, y - 10, 14, 52);
    const fpos = ac.flapPos / 8;
    g.fillStyle = Math.abs(ac.flapPos - c.flapLever) > 0.05 ? C.amber : C.green;
    g.fillRect(fx - 6, y - 9, 12, 50 * fpos);
    text(g, 'FLAPS', fx - 12, y - 18, C.cyan, 10, 'right');
    text(g, FLAP_NAMES[c.flapLever], fx - 12, y + 30, C.green, 14, 'right', '700');
    y += 64;
    // Status line items.
    const items = [];
    if (c.parkingBrake) items.push(['PARKING BRAKE', C.amber]);
    if (c.speedbrakeArmed) items.push(['SPEEDBRAKE ARMED', C.green]);
    else if (ac.spoilerPos > 0.03) items.push([`SPEEDBRAKE ${ac.wow ? 'UP' : 'EXT'}`, ac.wow ? C.green : C.amber]);
    if (c.autobrake !== 'OFF') items.push([`AUTO BRAKE ${c.autobrake}${ac.autobrakeActive ? ' (ACT)' : ''}`, C.green]);
    if (ac.tailStrike) items.push(['TAIL STRIKE', C.red]);
    const w = sim.warnings.active;
    if (w.has('config')) items.push(['TAKEOFF CONFIG', C.red]);
    if (w.has('overspeed')) items.push(['OVERSPEED', C.red]);
    if (w.has('stall')) items.push(['STALL', C.red]);
    if (ac.fuel < 1500) items.push(['FUEL LOW', C.amber]);
    for (const d of ac.damage) items.push([d.toUpperCase(), C.amber]);
    for (let i = 0; i < Math.min(items.length, 6); i++) text(g, items[i][0], 150, y + i * 17, items[i][1], 13, 'center', '700');
  }
}

