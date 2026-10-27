// Synthesised sound: CFM56 engines, airflow, ground roll, rain, thunder, warnings, GPWS
// callouts (speech synthesis) and Morse identifiers of tuned navaids.
import { clamp, KT } from '../core/math.ts';
import type { Simulation } from '../core/sim.ts';

const SPEECH: Record<string, string> = {
  ra2500: 'twenty five hundred', ra1000: 'one thousand', ra500: 'five hundred', ra100: 'one hundred',
  ra50: 'fifty', ra40: 'forty', ra30: 'thirty', ra20: 'twenty', ra10: 'ten', minimums: 'minimums',
  approachingminimums: 'approaching minimums', retard: 'retard', pullup: 'pull up', sinkrate: 'sink rate',
  terrain: 'terrain, terrain', toolowgear: 'too low, gear', toolowflaps: 'too low, flaps', glideslope: 'glide slope',
  bankangle: 'bank angle', config: 'takeoff configuration', eighty: 'eighty knots', v1: 'vee one', rotate: 'rotate',
  positiverate: 'positive rate', windshear: 'windshear, windshear, windshear',
};
const URGENT = new Set(['pullup', 'terrain', 'sinkrate', 'bankangle', 'windshear']);

const MORSE: Record<string, string> = {
  A: '.-', B: '-...', C: '-.-.', D: '-..', E: '.', F: '..-.', G: '--.', H: '....', I: '..', J: '.---', K: '-.-', L: '.-..',
  M: '--', N: '-.', O: '---', P: '.--.', Q: '--.-', R: '.-.', S: '...', T: '-', U: '..-', V: '...-', W: '.--', X: '-..-',
  Y: '-.--', Z: '--..', 0: '-----', 1: '.----', 2: '..---', 3: '...--', 4: '....-', 5: '.....', 6: '-....', 7: '--...', 8: '---..', 9: '----.',
};

interface EngineVoice {
  roar: BiquadFilterNode;
  roarG: GainNode;
  osc: OscillatorNode;
  oscF: BiquadFilterNode;
  oscG: GainNode;
  buzz: OscillatorNode;
  buzzG: GainNode;
  detune: number;
}

export class SoundSystem {
  private ctx: AudioContext | null = null;
  enabled = true;
  volume = 0.8;
  private voice: SpeechSynthesisVoice | null = null;
  private master!: GainNode;
  private muffle!: BiquadFilterNode;
  private alerts!: GainNode;
  private engines: EngineVoice[] = [];
  private windF!: BiquadFilterNode;
  private windG!: GainNode;
  private rumbleF!: BiquadFilterNode;
  private rumbleG!: GainNode;
  private rainG!: GainNode;
  private shakerG!: GainNode;
  private clackG!: GainNode;
  private hornG!: GainNode;
  /** Morse ident monitoring for NAV 1 / NAV 2 / ADF. */
  identOn = { nav1: false, nav2: false, adf: false };
  private identNext = { nav1: 0, nav2: 0, adf: 0 };

  /** Must be called from a user gesture. */
  start(): void {
    if (this.ctx) {
      void this.ctx.resume();
      return;
    }
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    const ctx = new AC();
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = this.enabled ? this.volume : 0;
    this.muffle = ctx.createBiquadFilter();
    this.muffle.type = 'lowpass';
    this.muffle.frequency.value = 18000;
    this.muffle.connect(this.master);
    this.master.connect(ctx.destination);
    this.alerts = ctx.createGain();
    this.alerts.gain.value = 0.5;
    this.alerts.connect(this.master);

    const noise = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const d = noise.getChannelData(0);
    let b = 0;
    for (let i = 0; i < d.length; i++) {
      const w = Math.random() * 2 - 1;
      b = 0.97 * b + 0.03 * w;
      d[i] = w * 0.6 + b * 3;
    }

    const src = () => {
      const s = ctx.createBufferSource();
      s.buffer = noise;
      s.loop = true;
      s.start();
      return s;
    };
    this.engines = [0, 1].map((i) => {
      const n = src();
      const roar = ctx.createBiquadFilter();
      roar.type = 'bandpass';
      roar.Q.value = 0.7;
      const roarG = ctx.createGain();
      roarG.gain.value = 0;
      n.connect(roar).connect(roarG).connect(this.muffle);
      const osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      const oscF = ctx.createBiquadFilter();
      oscF.type = 'bandpass';
      oscF.Q.value = 8;
      const oscG = ctx.createGain();
      oscG.gain.value = 0;
      osc.connect(oscF).connect(oscG).connect(this.muffle);
      osc.start();
      const buzz = ctx.createOscillator();
      buzz.type = 'square';
      const buzzG = ctx.createGain();
      buzzG.gain.value = 0;
      const buzzF = ctx.createBiquadFilter();
      buzzF.type = 'lowpass';
      buzzF.frequency.value = 900;
      buzz.connect(buzzF).connect(buzzG).connect(this.muffle);
      buzz.start();
      return { roar, roarG, osc, oscF, oscG, buzz, buzzG, detune: i * 7 };
    });
    const loop = (filter: BiquadFilterType, freq: number, dest: AudioNode): [BiquadFilterNode, GainNode] => {
      const f = ctx.createBiquadFilter();
      f.type = filter;
      f.frequency.value = freq;
      const g = ctx.createGain();
      g.gain.value = 0;
      src().connect(f).connect(g).connect(dest);
      return [f, g];
    };
    [this.windF, this.windG] = loop('lowpass', 600, this.muffle);
    [this.rumbleF, this.rumbleG] = loop('lowpass', 90, this.master);
    [, this.rainG] = loop('highpass', 2500, this.master);
    const osc = (type: OscillatorType, freq: number, filter: BiquadFilterType | null, ffreq: number): GainNode => {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.value = freq;
      const g = ctx.createGain();
      g.gain.value = 0;
      if (filter) {
        const f = ctx.createBiquadFilter();
        f.type = filter;
        f.frequency.value = ffreq;
        o.connect(f).connect(g).connect(this.alerts);
      } else {
        o.connect(g).connect(this.alerts);
      }
      o.start();
      return g;
    };
    this.shakerG = osc('square', 28, 'lowpass', 400);
    this.clackG = osc('square', 9, 'highpass', 1200);
    this.hornG = osc('square', 520, null, 0);
    this.pickVoice();
  }

  private pickVoice(): void {
    if (!window.speechSynthesis) return;
    const choose = () => {
      const vs = window.speechSynthesis.getVoices();
      this.voice = vs.find((v) => /en[-_]US/i.test(v.lang) && /male|david|alex|daniel|fred/i.test(v.name)) ?? vs.find((v) => /^en/i.test(v.lang)) ?? null;
    };
    choose();
    window.speechSynthesis.onvoiceschanged = choose;
  }

  setMuted(m: boolean): void {
    this.enabled = !m;
    if (this.ctx) this.master.gain.value = m ? 0 : this.volume;
    if (m && window.speechSynthesis) window.speechSynthesis.cancel();
  }

  private speak(key: string): void {
    const s = SPEECH[key];
    if (!s || !this.enabled || !window.speechSynthesis) return;
    const u = new SpeechSynthesisUtterance(s);
    u.rate = 1.15;
    u.pitch = 0.75;
    u.volume = 0.9;
    if (this.voice) u.voice = this.voice;
    if (URGENT.has(key)) window.speechSynthesis.cancel();
    window.speechSynthesis.speak(u);
  }

  /** Short synthetic tones. */
  tone(kind: string): void {
    if (!this.ctx || !this.enabled) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.connect(g).connect(this.alerts);
    g.gain.value = 0;
    if (kind === 'apDisconnect') {
      o.type = 'sawtooth';
      for (let i = 0; i < 6; i++) o.frequency.setValueAtTime(i % 2 ? 640 : 900, t + i * 0.18);
      g.gain.setValueAtTime(0.25, t);
      g.gain.setValueAtTime(0, t + 1.1);
      o.start(t);
      o.stop(t + 1.2);
    } else if (kind === 'atDisconnect') {
      o.type = 'square';
      o.frequency.value = 1150;
      for (let i = 0; i < 3; i++) {
        g.gain.setValueAtTime(0.12, t + i * 0.25);
        g.gain.setValueAtTime(0, t + i * 0.25 + 0.12);
      }
      o.start(t);
      o.stop(t + 0.8);
    } else if (kind === 'chime') {
      o.type = 'sine';
      o.frequency.setValueAtTime(880, t);
      o.frequency.setValueAtTime(660, t + 0.25);
      g.gain.setValueAtTime(0.2, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.8);
      o.start(t);
      o.stop(t + 0.85);
    } else if (kind === 'touchdown') {
      this.burst(0.5, 0.12, 900, 0.6, 'bandpass');
      o.type = 'sine';
      o.frequency.setValueAtTime(70, t);
      o.frequency.exponentialRampToValueAtTime(35, t + 0.3);
      g.gain.setValueAtTime(0.5, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.35);
      o.start(t);
      o.stop(t + 0.4);
    } else if (kind === 'click') {
      o.type = 'square';
      o.frequency.value = 2200;
      g.gain.setValueAtTime(0.06, t);
      g.gain.setValueAtTime(0, t + 0.02);
      o.start(t);
      o.stop(t + 0.03);
    }
  }

  /** Filtered noise burst (touchdown thump, thunder). */
  private burst(seconds: number, decay: number, freq: number, gain: number, type: BiquadFilterType, delay = 0): void {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const buf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * seconds), ctx.sampleRate);
    const d = buf.getChannelData(0);
    let b = 0;
    for (let i = 0; i < d.length; i++) {
      b = 0.985 * b + 0.015 * (Math.random() * 2 - 1);
      d[i] = (Math.random() * 2 - 1) * 0.3 + b * 6;
      d[i] *= Math.exp(-i / (ctx.sampleRate * decay)) * (1 + 0.6 * Math.sin(i / (ctx.sampleRate * 0.21)));
    }
    const n = ctx.createBufferSource();
    n.buffer = buf;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.value = gain;
    n.connect(f).connect(g).connect(this.master);
    n.start(ctx.currentTime + delay);
  }

  /** Thunder from a strike `dist` metres away, arriving at the speed of sound. */
  thunder(dist: number): void {
    if (!this.ctx || !this.enabled || dist > 25000) return;
    const loud = clamp(1.2 - dist / 20000, 0.08, 1);
    this.burst(2.5 + dist / 8000, 0.5 + dist / 15000, dist < 3000 ? 600 : 220, loud * 0.9, 'lowpass', Math.min(dist / 343, 60));
  }

  /** Play a station identifier in Morse (1020 Hz tone, about 7 words per minute). */
  private morse(ident: string, freq = 1020): void {
    if (!this.ctx || !this.enabled) return;
    const ctx = this.ctx;
    const dot = 0.12;
    let t = ctx.currentTime + 0.05;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.frequency.value = freq;
    o.connect(g).connect(this.alerts);
    g.gain.setValueAtTime(0, t);
    for (const ch of ident.toUpperCase()) {
      for (const s of MORSE[ch] ?? '') {
        const len = s === '.' ? dot : dot * 3;
        g.gain.setValueAtTime(0.08, t);
        g.gain.setValueAtTime(0, t + len);
        t += len + dot;
      }
      t += dot * 2;
    }
    o.start();
    o.stop(t + 0.1);
  }

  handle(events: string[]): void {
    for (const e of events) {
      if (SPEECH[e]) this.speak(e);
      else this.tone(e);
    }
  }

  update(sim: Simulation, view: string, simTime: number): void {
    if (!this.ctx) return;
    const ac = sim.ac;
    const t = this.ctx.currentTime;
    const inside = view === 'cockpit';
    const paused = sim.paused || !!ac.crashed;
    this.muffle.frequency.setTargetAtTime(inside ? 1400 : 16000, t, 0.1);
    const extGain = inside ? 0.45 : 1;
    for (let i = 0; i < 2; i++) {
      const n = ac.engines[i].n1 / 100;
      const s = this.engines[i];
      const on = paused ? 0 : 1;
      s.roar.frequency.setTargetAtTime(180 + n * 900, t, 0.1);
      s.roarG.gain.setTargetAtTime(on * extGain * (0.04 + n * n * 0.32), t, 0.15);
      const whine = 120 + n * 2400 + s.detune;
      s.osc.frequency.setTargetAtTime(whine, t, 0.1);
      s.oscF.frequency.setTargetAtTime(whine, t, 0.1);
      s.oscG.gain.setTargetAtTime(on * extGain * (0.02 + 0.05 * n) * (inside ? 0.6 : 1), t, 0.15);
      s.buzz.frequency.setTargetAtTime(40 + n * 200, t, 0.1);
      s.buzzG.gain.setTargetAtTime(on * extGain * clamp((n - 0.75) * 0.25, 0, 0.05), t, 0.2);
    }
    const ias = ac.ias / KT;
    this.windF.frequency.setTargetAtTime(300 + ias * 12, t, 0.2);
    const wind = paused ? 0 : clamp((ias / 300) ** 2, 0, 1) * (inside ? 0.35 : 0.18) + ac.spoilerPos * 0.06 + ac.gearPos * clamp(ias / 250, 0, 1) * 0.08;
    this.windG.gain.setTargetAtTime(wind, t, 0.3);
    const rumble = ac.wow && !paused ? clamp(ac.gs / 60, 0, 1) * (ac.surfaceKind === 'runway' ? 0.35 : 0.8) : 0;
    this.rumbleF.frequency.setTargetAtTime(60 + clamp(ac.gs, 0, 80), t, 0.2);
    this.rumbleG.gain.setTargetAtTime(rumble, t, 0.1);
    const precip = ac.env?.precip ?? 0;
    this.rainG.gain.setTargetAtTime(paused ? 0 : clamp(precip / 25, 0, 0.25) * (inside ? 1 : 0.4), t, 0.5);
    const w = sim.warnings.active;
    this.shakerG.gain.setTargetAtTime(!paused && w.has('stall') ? 0.35 : 0, t, 0.03);
    this.clackG.gain.setTargetAtTime(!paused && w.has('overspeed') ? 0.25 : 0, t, 0.03);
    const hornOn = !paused && w.has('config') && Math.floor(t * 3) % 2 === 0;
    this.hornG.gain.setTargetAtTime(hornOn ? 0.1 : 0, t, 0.01);
    // Navaid identifiers repeat every ~10 s while monitored.
    const radios = sim.radios;
    const ids: ['nav1' | 'nav2' | 'adf', string, number][] = [
      ['nav1', radios.nav1.receiving ? radios.nav1.ident : '', 1020],
      ['nav2', radios.nav2.receiving ? radios.nav2.ident : '', 1020],
      ['adf', radios.adf.ident, 1020],
    ];
    for (const [k, ident, f] of ids) {
      if (!this.identOn[k] || !ident || paused) continue;
      if (simTime >= this.identNext[k]) {
        this.identNext[k] = simTime + 10;
        this.morse(ident, f);
      }
    }
  }
}
