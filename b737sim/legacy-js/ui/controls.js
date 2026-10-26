// Pilot input: keyboard, gamepad/joystick, mouse yoke and an on-screen touch stick.
import { clamp } from '../math.js';

export const KEY_HELP = [
  ['Arrow Up / Down', 'Pitch (nose down / nose up)'],
  ['Arrow Left / Right', 'Roll'],
  ['Z / X', 'Rudder & nosewheel steering'],
  ['+ / -  or  PgUp / PgDn', 'Throttle up / down'],
  ['Shift+T', 'TO/GA'],
  ['R', 'Toggle thrust reversers (on ground)'],
  ['[ / ]  or F6 / F7', 'Flaps up / down one detent'],
  ['G', 'Landing gear'],
  ['/', 'Speedbrake: down / flight detent / up'],
  ['K', 'Arm speedbrake'],
  ['B (hold)', 'Wheel brakes'],
  ['Shift+B', 'Parking brake'],
  ['J', 'Cycle autobrake (RTO, OFF, 1, 2, 3, MAX)'],
  ['Home / End', 'Pitch trim nose down / nose up'],
  ['A', 'Autopilot CMD on/off'],
  ['T', 'Autothrottle arm on/off'],
  ['H / N / L / V / O', 'HDG SEL / LNAV / LVL CHG / V/S / ALT HOLD'],
  ['M', 'APP (approach) arm'],
  ['Ctrl + ← → ↑ ↓', 'MCP heading bug / altitude'],
  ['Ctrl + PgUp / PgDn', 'MCP speed'],
  ['C / Shift+C', 'Next / previous camera'],
  ['Mouse drag (right)', 'Look around / orbit camera; wheel = zoom'],
  ['Y', 'Toggle mouse yoke (hold left button to fly)'],
  ['I', 'Show / hide instruments'],
  ['P / Esc', 'Pause / menu'],
  ['< / >', 'Simulation rate'],
  ['F', 'Fullscreen'],
];

export class InputManager {
  constructor(canvas, onAction) {
    this.canvas = canvas;
    this.onAction = onAction;
    this.keys = new Set();
    this.axes = { pitch: 0, roll: 0, yaw: 0 };
    this.mouseYoke = false;
    this.mouseDown = false;
    this.mouse = { x: 0, y: 0 };
    this.touch = { active: false, x: 0, y: 0 };
    this.gamepadThrottle = null;
    this.brake = 0;
    this.lookDrag = null;
    this.onLook = null;
    this.onWheel = null;
    this.bind();
  }

  bind() {
    window.addEventListener('keydown', (e) => {
      if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT')) return;
      const k = e.key;
      const firstPress = !this.keys.has(k.toLowerCase());
      this.keys.add(k.toLowerCase());
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', 'Home', 'End', ' ', 'F6', 'F7', '/'].includes(k)) e.preventDefault();
      if (!firstPress && !['+', '=', '-', '_', 'PageUp', 'PageDown', 'Home', 'End', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(k)) return;
      this.keyAction(e);
    });
    window.addEventListener('keyup', (e) => {
      this.keys.delete(e.key.toLowerCase());
    });
    window.addEventListener('blur', () => this.keys.clear());
    const cv = this.canvas;
    cv.addEventListener('contextmenu', (e) => e.preventDefault());
    cv.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'touch') return;
      if (e.button === 0 && this.mouseYoke) {
        this.mouseDown = true;
        this.mouse = { x: e.clientX, y: e.clientY };
      } else {
        this.lookDrag = { x: e.clientX, y: e.clientY };
      }
      cv.setPointerCapture(e.pointerId);
    });
    cv.addEventListener('pointermove', (e) => {
      if (this.mouseDown) this.mouse = { x: e.clientX, y: e.clientY };
      if (this.lookDrag) {
        const dx = e.clientX - this.lookDrag.x;
        const dy = e.clientY - this.lookDrag.y;
        this.lookDrag = { x: e.clientX, y: e.clientY };
        if (this.onLook) this.onLook(dx, dy);
      }
    });
    const up = (e) => {
      this.mouseDown = false;
      this.lookDrag = null;
      try { cv.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    };
    cv.addEventListener('pointerup', up);
    cv.addEventListener('pointercancel', up);
    cv.addEventListener('wheel', (e) => {
      e.preventDefault();
      if (this.onWheel) this.onWheel(e.deltaY);
    }, { passive: false });
    // Touch: one finger drag on the scene = look; the stick element handles flying.
    let touchLook = null;
    cv.addEventListener('touchstart', (e) => {
      if (e.touches.length === 1) touchLook = { x: e.touches[0].clientX, y: e.touches[0].clientY };
    }, { passive: true });
    cv.addEventListener('touchmove', (e) => {
      if (touchLook && e.touches.length === 1 && this.onLook) {
        const t = e.touches[0];
        this.onLook(t.clientX - touchLook.x, t.clientY - touchLook.y);
        touchLook = { x: t.clientX, y: t.clientY };
      }
    }, { passive: true });
    cv.addEventListener('touchend', () => (touchLook = null), { passive: true });
  }

  /** Bind an on-screen virtual stick element. */
  bindTouchStick(el, knob) {
    const update = (e) => {
      const r = el.getBoundingClientRect();
      const x = clamp(((e.clientX - r.left) / r.width) * 2 - 1, -1, 1);
      const y = clamp(((e.clientY - r.top) / r.height) * 2 - 1, -1, 1);
      this.touch = { active: true, x, y };
      knob.style.transform = `translate(${x * 38}px, ${y * 38}px)`;
    };
    el.addEventListener('pointerdown', (e) => {
      el.setPointerCapture(e.pointerId);
      update(e);
    });
    el.addEventListener('pointermove', (e) => {
      if (this.touch.active) update(e);
    });
    const end = () => {
      this.touch = { active: false, x: 0, y: 0 };
      knob.style.transform = '';
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
  }

  keyAction(e) {
    const k = e.key;
    const lk = k.toLowerCase();
    const a = (name, arg) => this.onAction(name, arg);
    if (e.ctrlKey || e.metaKey) {
      if (k === 'ArrowLeft') a('mcpHdg', e.shiftKey ? -10 : -1);
      else if (k === 'ArrowRight') a('mcpHdg', e.shiftKey ? 10 : 1);
      else if (k === 'ArrowUp') a('mcpAlt', 1000);
      else if (k === 'ArrowDown') a('mcpAlt', -1000);
      else if (k === 'PageUp') a('mcpSpd', 5);
      else if (k === 'PageDown') a('mcpSpd', -5);
      else return;
      e.preventDefault();
      return;
    }
    switch (k) {
      case '+': case '=': a('throttle', 0.02); return;
      case '-': case '_': a('throttle', -0.02); return;
      case 'PageUp': a('throttle', 0.1); return;
      case 'PageDown': a('throttle', -0.1); return;
      case 'Home': a('trim', -1); return;
      case 'End': a('trim', 1); return;
      case '[': case 'F6': a('flaps', -1); return;
      case ']': case 'F7': a('flaps', 1); return;
      case '/': a('speedbrake'); return;
      case '<': case ',': a('simRate', -1); return;
      case '>': case '.': a('simRate', 1); return;
      case 'Escape': a('menu'); return;
      case 'ArrowUp': case 'ArrowDown': case 'ArrowLeft': case 'ArrowRight': return;
      default:
    }
    if (e.shiftKey) {
      if (lk === 't') return a('toga');
      if (lk === 'b') return a('parkingBrake');
      if (lk === 'c') return a('camera', -1);
    }
    switch (lk) {
      case 'g': a('gear'); break;
      case 'k': a('armSpeedbrake'); break;
      case 'r': a('reverse'); break;
      case 'j': a('autobrake'); break;
      case 'a': a('ap'); break;
      case 't': a('at'); break;
      case 'h': a('hdgSel'); break;
      case 'n': a('lnav'); break;
      case 'l': a('lvlChg'); break;
      case 'v': a('vs'); break;
      case 'o': a('altHold'); break;
      case 'm': a('app'); break;
      case 'c': a('camera', 1); break;
      case 'y': this.mouseYoke = !this.mouseYoke; a('mouseYoke', this.mouseYoke); break;
      case 'i': a('instruments'); break;
      case 'p': a('pause'); break;
      case 'f': a('fullscreen'); break;
      case '?': a('help'); break;
      default:
    }
  }

  /** Continuous inputs; dt in seconds. Returns pilot control demands. */
  poll(dt) {
    const k = this.keys;
    const ramp = (cur, target, rate) => cur + clamp(target - cur, -rate * dt, rate * dt);
    const ctrl = k.has('control') || k.has('meta');
    let tp = 0;
    let tr = 0;
    let ty = 0;
    if (!ctrl) {
      if (k.has('arrowdown')) tp += 0.75;
      if (k.has('arrowup')) tp -= 0.75;
      if (k.has('arrowleft')) tr -= 0.8;
      if (k.has('arrowright')) tr += 0.8;
    }
    if (k.has('z')) ty -= 1;
    if (k.has('x')) ty += 1;
    // Keyboard controls ramp in and spring back.
    this.axes.pitch = ramp(this.axes.pitch, tp, tp ? 1.6 : 3);
    this.axes.roll = ramp(this.axes.roll, tr, tr ? 2.5 : 4);
    this.axes.yaw = ramp(this.axes.yaw, ty, ty ? 2 : 3);
    let pitch = this.axes.pitch;
    let roll = this.axes.roll;
    let yaw = this.axes.yaw;
    let brake = k.has('b') && !k.has('shift') ? 1 : 0;

    // Mouse yoke.
    if (this.mouseYoke && this.mouseDown) {
      const w = window.innerWidth;
      const h = window.innerHeight;
      roll = clamp((this.mouse.x - w / 2) / (w * 0.3), -1, 1);
      pitch = clamp((this.mouse.y - h / 2) / (h * 0.3), -1, 1);
    }
    // Touch stick.
    if (this.touch.active) {
      roll = this.touch.x;
      pitch = this.touch.y;
    }
    // Gamepad / joystick.
    this.gamepadThrottle = null;
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    for (const gp of pads) {
      if (!gp || !gp.connected) continue;
      const dz = (v) => (Math.abs(v) < 0.06 ? 0 : (v - Math.sign(v) * 0.06) / 0.94);
      const ax = gp.axes;
      if (Math.abs(dz(ax[0])) > 0 || Math.abs(dz(ax[1])) > 0) {
        roll = dz(ax[0]);
        pitch = dz(ax[1]);
      }
      if (gp.mapping === 'standard') {
        if (ax.length > 2 && Math.abs(dz(ax[2])) > 0) yaw = dz(ax[2]);
        const up = gp.buttons[7]?.value || 0;
        const dn = gp.buttons[6]?.value || 0;
        if (up > 0.05 || dn > 0.05) this.onAction('throttle', (up - dn) * dt * 0.5);
        this.padButtons(gp);
        if (gp.buttons[1]?.pressed) brake = 1;
      } else if (ax.length >= 3) {
        // Typical joystick: axis 2 = throttle lever, axis 5 or 3 = twist rudder.
        this.gamepadThrottle = clamp((1 - ax[2]) / 2, 0, 1);
        const rz = ax.length > 5 ? ax[5] : ax[3];
        if (rz !== undefined && Math.abs(dz(rz)) > 0) yaw = dz(rz);
        if (gp.buttons[0]?.pressed) brake = 1;
      }
    }
    this.brake = ramp(this.brake, brake, 3);
    return {
      pitch: clamp(pitch, -1, 1),
      roll: clamp(roll, -1, 1),
      yaw: clamp(yaw, -1, 1),
      tiller: 0,
      brakeL: this.brake,
      brakeR: this.brake,
    };
  }

  padButtons(gp) {
    if (!this.prevButtons) this.prevButtons = [];
    const map = { 0: 'gear', 2: 'ap', 3: 'camera', 4: 'flapsUp', 5: 'flapsDown', 8: 'pause', 9: 'menu', 12: 'trimDown', 13: 'trimUp', 14: 'speedbrake', 15: 'reverse' };
    gp.buttons.forEach((b, i) => {
      const was = this.prevButtons[i];
      if (b.pressed && !was && map[i]) {
        const m = map[i];
        if (m === 'flapsUp') this.onAction('flaps', -1);
        else if (m === 'flapsDown') this.onAction('flaps', 1);
        else if (m === 'trimDown') this.onAction('trim', -1);
        else if (m === 'trimUp') this.onAction('trim', 1);
        else if (m === 'camera') this.onAction('camera', 1);
        else this.onAction(m);
      }
      this.prevButtons[i] = b.pressed;
    });
  }

  /** Is a key currently held (for continuous trim / look). */
  held(name) {
    return this.keys.has(name);
  }
}
