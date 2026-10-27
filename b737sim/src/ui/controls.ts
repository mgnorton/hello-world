// Pilot input: keyboard, gamepad/joystick, mouse yoke and an on-screen touch stick.
import { clamp } from '../core/math.ts';
import type { PilotInput } from '../core/sim.ts';

export const KEY_HELP: [string, string][] = [
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
  ['Shift+N', 'VNAV'],
  ['M / Shift+M', 'APP arm / VOR LOC arm'],
  ['Ctrl + Arrows', 'MCP heading bug / altitude'],
  ['Ctrl + PgUp / PgDn', 'MCP speed'],
  ['Q / Shift+Q', 'Altimeter: set local QNH / STD'],
  ['W', 'ND weather radar on/off'],
  ['E / Shift+E', 'ND range out / in; Ctrl+E cycles MAP / VOR / APP'],
  ['C / Shift+C', 'Next / previous camera'],
  ['Mouse drag (right)', 'Look around / orbit camera; wheel = zoom'],
  ['Y', 'Toggle mouse yoke (hold left button to fly)'],
  ['I', 'Show / hide instruments'],
  ['P / Esc', 'Pause / menu'],
  ['< / >', 'Simulation rate'],
  ['F', 'Fullscreen'],
];

export type Action =
  | 'throttle' | 'trim' | 'flaps' | 'speedbrake' | 'armSpeedbrake' | 'simRate' | 'menu' | 'toga' | 'parkingBrake' | 'camera'
  | 'gear' | 'reverse' | 'autobrake' | 'ap' | 'at' | 'hdgSel' | 'lnav' | 'vnav' | 'lvlChg' | 'vs' | 'altHold' | 'app' | 'vorLoc'
  | 'mouseYoke' | 'instruments' | 'pause' | 'fullscreen' | 'help' | 'mcpHdg' | 'mcpAlt' | 'mcpSpd' | 'baro' | 'baroStd'
  | 'wxr' | 'ndRange' | 'ndMode';

export type ActionHandler = (name: Action, arg?: number | boolean) => void;

const HOLD_REPEAT = new Set(['+', '=', '-', '_', 'PageUp', 'PageDown', 'Home', 'End', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']);
const PREVENT = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', 'Home', 'End', ' ', 'F6', 'F7', '/']);

export class InputManager {
  keys = new Set<string>();
  axes = { pitch: 0, roll: 0, yaw: 0 };
  mouseYoke = false;
  private mouseDown = false;
  private mouse = { x: 0, y: 0 };
  private touch = { active: false, x: 0, y: 0 };
  /** Absolute throttle lever position from a joystick throttle axis, if one is present. */
  gamepadThrottle: number | null = null;
  private brake = 0;
  private lookDrag: { x: number; y: number } | null = null;
  private prevButtons: boolean[] = [];
  onLook: ((dx: number, dy: number) => void) | null = null;
  onWheel: ((delta: number) => void) | null = null;

  constructor(readonly canvas: HTMLCanvasElement, readonly onAction: ActionHandler) {
    this.bind();
  }

  private bind(): void {
    window.addEventListener('keydown', (e) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA')) return;
      const k = e.key;
      const firstPress = !this.keys.has(k.toLowerCase());
      this.keys.add(k.toLowerCase());
      if (PREVENT.has(k)) e.preventDefault();
      if (!firstPress && !HOLD_REPEAT.has(k)) return;
      this.keyAction(e);
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.key.toLowerCase()));
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
        this.onLook?.(dx, dy);
      }
    });
    const up = (e: PointerEvent) => {
      this.mouseDown = false;
      this.lookDrag = null;
      try {
        cv.releasePointerCapture(e.pointerId);
      } catch {
        // Pointer capture may already be released.
      }
    };
    cv.addEventListener('pointerup', up);
    cv.addEventListener('pointercancel', up);
    cv.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.onWheel?.(e.deltaY);
    }, { passive: false });
    // Touch: one-finger drag on the scene looks around; the stick element flies.
    let touchLook: { x: number; y: number } | null = null;
    let pinch: number | null = null;
    cv.addEventListener('touchstart', (e) => {
      if (e.touches.length === 1) touchLook = { x: e.touches[0].clientX, y: e.touches[0].clientY };
      if (e.touches.length === 2) pinch = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
    }, { passive: true });
    cv.addEventListener('touchmove', (e) => {
      if (touchLook && e.touches.length === 1) {
        const t = e.touches[0];
        this.onLook?.(t.clientX - touchLook.x, t.clientY - touchLook.y);
        touchLook = { x: t.clientX, y: t.clientY };
      } else if (pinch !== null && e.touches.length === 2) {
        const d = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
        this.onWheel?.((pinch - d) * 4);
        pinch = d;
      }
    }, { passive: true });
    cv.addEventListener('touchend', () => {
      touchLook = null;
      pinch = null;
    }, { passive: true });
  }

  /** Bind an on-screen virtual stick element. */
  bindTouchStick(el: HTMLElement, knob: HTMLElement): void {
    const update = (e: PointerEvent) => {
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

  private keyAction(e: KeyboardEvent): void {
    const k = e.key;
    const lk = k.toLowerCase();
    const a = (name: Action, arg?: number | boolean) => this.onAction(name, arg);
    if (e.ctrlKey || e.metaKey) {
      if (k === 'ArrowLeft') a('mcpHdg', e.shiftKey ? -10 : -1);
      else if (k === 'ArrowRight') a('mcpHdg', e.shiftKey ? 10 : 1);
      else if (k === 'ArrowUp') a('mcpAlt', 1000);
      else if (k === 'ArrowDown') a('mcpAlt', -1000);
      else if (k === 'PageUp') a('mcpSpd', 5);
      else if (k === 'PageDown') a('mcpSpd', -5);
      else if (lk === 'e') a('ndMode');
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
      case '?': a('help'); return;
      case 'ArrowUp': case 'ArrowDown': case 'ArrowLeft': case 'ArrowRight': return;
      default:
    }
    if (e.shiftKey) {
      if (lk === 't') return a('toga');
      if (lk === 'b') return a('parkingBrake');
      if (lk === 'c') return a('camera', -1);
      if (lk === 'n') return a('vnav');
      if (lk === 'm') return a('vorLoc');
      if (lk === 'q') return a('baroStd');
      if (lk === 'e') return a('ndRange', -1);
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
      case 'q': a('baro'); break;
      case 'w': a('wxr'); break;
      case 'e': a('ndRange', 1); break;
      case 'c': a('camera', 1); break;
      case 'y':
        this.mouseYoke = !this.mouseYoke;
        a('mouseYoke', this.mouseYoke);
        break;
      case 'i': a('instruments'); break;
      case 'p': a('pause'); break;
      case 'f': a('fullscreen'); break;
      default:
    }
  }

  /** Continuous inputs; dt in seconds. Returns pilot control demands. */
  poll(dt: number): PilotInput {
    const k = this.keys;
    const ramp = (cur: number, target: number, rate: number) => cur + clamp(target - cur, -rate * dt, rate * dt);
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
    this.axes.pitch = ramp(this.axes.pitch, tp, tp ? 1.6 : 3);
    this.axes.roll = ramp(this.axes.roll, tr, tr ? 2.5 : 4);
    this.axes.yaw = ramp(this.axes.yaw, ty, ty ? 2 : 3);
    let pitch = this.axes.pitch;
    let roll = this.axes.roll;
    let yaw = this.axes.yaw;
    let brake = k.has('b') && !k.has('shift') ? 1 : 0;
    if (this.mouseYoke && this.mouseDown) {
      roll = clamp((this.mouse.x - window.innerWidth / 2) / (window.innerWidth * 0.3), -1, 1);
      pitch = clamp((this.mouse.y - window.innerHeight / 2) / (window.innerHeight * 0.3), -1, 1);
    }
    if (this.touch.active) {
      roll = this.touch.x;
      pitch = this.touch.y;
    }
    this.gamepadThrottle = null;
    // A sandboxed frame may refuse the Gamepad API by throwing.
    let pads: (Gamepad | null)[] = [];
    try {
      pads = navigator.getGamepads ? navigator.getGamepads() : [];
    } catch {
      pads = [];
    }
    for (const gp of pads) {
      if (!gp || !gp.connected) continue;
      const dz = (v: number) => (Math.abs(v) < 0.06 ? 0 : (v - Math.sign(v) * 0.06) / 0.94);
      const ax = gp.axes;
      if (Math.abs(dz(ax[0])) > 0 || Math.abs(dz(ax[1])) > 0) {
        roll = dz(ax[0]);
        pitch = dz(ax[1]);
      }
      if (gp.mapping === 'standard') {
        if (ax.length > 2 && Math.abs(dz(ax[2])) > 0) yaw = dz(ax[2]);
        const upT = gp.buttons[7]?.value || 0;
        const dnT = gp.buttons[6]?.value || 0;
        if (upT > 0.05 || dnT > 0.05) this.onAction('throttle', (upT - dnT) * dt * 0.5);
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
    return { pitch: clamp(pitch, -1, 1), roll: clamp(roll, -1, 1), yaw: clamp(yaw, -1, 1), tiller: 0, brakeL: this.brake, brakeR: this.brake };
  }

  private padButtons(gp: Gamepad): void {
    const map: Record<number, [Action, number?]> = {
      0: ['gear'], 2: ['ap'], 3: ['camera', 1], 4: ['flaps', -1], 5: ['flaps', 1], 8: ['pause'], 9: ['menu'],
      12: ['trim', -1], 13: ['trim', 1], 14: ['speedbrake'], 15: ['reverse'],
    };
    gp.buttons.forEach((b, i) => {
      if (b.pressed && !this.prevButtons[i] && map[i]) this.onAction(map[i][0], map[i][1]);
      this.prevButtons[i] = b.pressed;
    });
  }

  held(name: string): boolean {
    return this.keys.has(name);
  }
}
