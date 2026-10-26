// Synthesised sound: CFM56 engines, airflow, ground roll, warnings and GPWS callouts.
import { clamp, KT } from './math.js';

const SPEECH = {
  ra2500: 'twenty five hundred', ra1000: 'one thousand', ra500: 'five hundred', ra100: 'one hundred',
  ra50: 'fifty', ra40: 'forty', ra30: 'thirty', ra20: 'twenty', ra10: 'ten', minimums: 'minimums',
  retard: 'retard', pullup: 'pull up', sinkrate: 'sink rate', terrain: 'terrain, terrain',
  toolowgear: 'too low, gear', toolowflaps: 'too low, flaps', glideslope: 'glide slope',
  bankangle: 'bank angle', config: 'takeoff configuration', eighty: 'eighty knots', v1: 'vee one',
  rotate: 'rotate', positiverate: 'positive rate',
};

export class SoundSystem {
  constructor() {
    this.ctx = null;
    this.enabled = true;
    this.volume = 0.8;
    this.voice = null;
  }

  /** Must be called from a user gesture. */
  start() {
    if (this.ctx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctx = new AC();
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = this.volume;
    // Cabin muffling filter (closed in cockpit view).
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
      // Slightly pink noise.
      const w = Math.random() * 2 - 1;
      b = 0.97 * b + 0.03 * w;
      d[i] = w * 0.6 + b * 3;
    }
    const src = (buf) => {
      const s = ctx.createBufferSource();
      s.buffer = buf;
      s.loop = true;
      s.start();
      return s;
    };
    this.engines = [0, 1].map((i) => {
      const n = src(noise);
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
    // Airflow.
    const wn = src(noise);
    this.windF = ctx.createBiquadFilter();
    this.windF.type = 'lowpass';
    this.windG = ctx.createGain();
    this.windG.gain.value = 0;
    wn.connect(this.windF).connect(this.windG).connect(this.muffle);
    // Ground rumble.
    const rn = src(noise);
    this.rumbleF = ctx.createBiquadFilter();
    this.rumbleF.type = 'lowpass';
    this.rumbleF.frequency.value = 90;
    this.rumbleG = ctx.createGain();
    this.rumbleG.gain.value = 0;
    rn.connect(this.rumbleF).connect(this.rumbleG).connect(this.master);
    // Stick shaker.
    this.shaker = ctx.createOscillator();
    this.shaker.type = 'square';
    this.shaker.frequency.value = 28;
    this.shakerG = ctx.createGain();
    this.shakerG.gain.value = 0;
    const shF = ctx.createBiquadFilter();
    shF.type = 'lowpass';
    shF.frequency.value = 400;
    this.shaker.connect(shF).connect(this.shakerG).connect(this.alerts);
    this.shaker.start();
    // Overspeed clacker / config horn.
    this.clacker = ctx.createOscillator();
    this.clacker.type = 'square';
    this.clacker.frequency.value = 9;
    this.clackG = ctx.createGain();
    this.clackG.gain.value = 0;
    const clF = ctx.createBiquadFilter();
    clF.type = 'highpass';
    clF.frequency.value = 1200;
    this.clacker.connect(clF).connect(this.clackG).connect(this.alerts);
    this.clacker.start();
    this.horn = ctx.createOscillator();
    this.horn.type = 'square';
    this.horn.frequency.value = 520;
    this.hornG = ctx.createGain();
    this.hornG.gain.value = 0;
    this.horn.connect(this.hornG).connect(this.alerts);
    this.horn.start();
    this.lastSpeak = 0;
    this.pickVoice();
  }

  pickVoice() {
    if (!window.speechSynthesis) return;
    const choose = () => {
      const vs = window.speechSynthesis.getVoices();
      this.voice = vs.find((v) => /en[-_]US/i.test(v.lang) && /male|david|alex|daniel|fred/i.test(v.name)) ||
        vs.find((v) => /^en/i.test(v.lang)) || null;
    };
    choose();
    window.speechSynthesis.onvoiceschanged = choose;
  }

  setMuted(m) {
    this.enabled = !m;
    if (this.master) this.master.gain.value = m ? 0 : this.volume;
  }

  speak(key) {
    const s = SPEECH[key];
    if (!s || !this.enabled || !window.speechSynthesis) return;
    const u = new SpeechSynthesisUtterance(s);
    u.rate = 1.15;
    u.pitch = 0.75;
    u.volume = 0.9;
    if (this.voice) u.voice = this.voice;
    // GPWS warnings interrupt routine callouts.
    if (['pullup', 'terrain', 'sinkrate', 'bankangle'].includes(key)) window.speechSynthesis.cancel();
    window.speechSynthesis.speak(u);
  }

  /** Short synthetic tones. */
  tone(kind) {
    if (!this.ctx || !this.enabled) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.connect(g).connect(this.alerts);
    g.gain.value = 0;
    if (kind === 'apDisconnect') {
      // Wailer.
      o.type = 'sawtooth';
      for (let i = 0; i < 6; i++) {
        o.frequency.setValueAtTime(i % 2 ? 640 : 900, t + i * 0.18);
      }
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
      const n = ctx.createBufferSource();
      const buf = ctx.createBuffer(1, ctx.sampleRate * 0.5, ctx.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * Math.exp(-i / (ctx.sampleRate * 0.12));
      n.buffer = buf;
      const f = ctx.createBiquadFilter();
      f.type = 'bandpass';
      f.frequency.value = 900;
      const ng = ctx.createGain();
      ng.gain.value = 0.6;
      n.connect(f).connect(ng).connect(this.master);
      n.start();
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

  handle(events) {
    for (const e of events) {
      if (SPEECH[e]) this.speak(e);
      else this.tone(e);
    }
  }

  update(sim, view) {
    if (!this.ctx) return;
    const ac = sim.ac;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const inside = view === 'cockpit';
    const paused = sim.paused || !!ac.crashed;
    this.muffle.frequency.setTargetAtTime(inside ? 1400 : 16000, t, 0.1);
    const extGain = inside ? 0.45 : 1;
    for (let i = 0; i < 2; i++) {
      const e = ac.engines[i];
      const n = e.n1 / 100;
      const s = this.engines[i];
      const on = paused ? 0 : 1;
      s.roar.frequency.setTargetAtTime(180 + n * 900, t, 0.1);
      s.roarG.gain.setTargetAtTime(on * extGain * (0.04 + n * n * 0.32), t, 0.15);
      const whine = 120 + n * 2400 + s.detune;
      s.osc.frequency.setTargetAtTime(whine, t, 0.1);
      s.oscF.frequency.setTargetAtTime(whine, t, 0.1);
      s.oscG.gain.setTargetAtTime(on * extGain * (0.02 + 0.05 * n) * (inside ? 0.6 : 1), t, 0.15);
      // Fan "buzzsaw" at high N1.
      s.buzz.frequency.setTargetAtTime(40 + n * 200, t, 0.1);
      s.buzzG.gain.setTargetAtTime(on * extGain * clamp((n - 0.75) * 0.25, 0, 0.05), t, 0.2);
    }
    const ias = ac.ias / KT;
    this.windF.frequency.setTargetAtTime(300 + ias * 12, t, 0.2);
    this.windG.gain.setTargetAtTime(paused ? 0 : clamp((ias / 300) ** 2, 0, 1) * (inside ? 0.35 : 0.18) + ac.spoilerPos * 0.06 + ac.gearPos * clamp(ias / 250, 0, 1) * 0.08, t, 0.3);
    const rumble = ac.wow && !paused ? clamp(ac.gs / 60, 0, 1) * (ac.surfaceKind === 'runway' ? 0.35 : 0.8) : 0;
    this.rumbleG.gain.setTargetAtTime(rumble, t, 0.1);
    const w = sim.warnings.active;
    this.shakerG.gain.setTargetAtTime(!paused && w.has('stall') ? 0.35 : 0, t, 0.03);
    this.clackG.gain.setTargetAtTime(!paused && w.has('overspeed') ? 0.25 : 0, t, 0.03);
    const hornOn = !paused && w.has('config') && Math.floor(t * 3) % 2 === 0;
    this.hornG.gain.setTargetAtTime(hornOn ? 0.1 : 0, t, 0.01);
  }
}
