// Aural and visual warnings: GPWS, windshear, stall, overspeed, takeoff config, callouts.
import { FT, FPM, KT } from './math.ts';
import { B739 } from './aircraftData.ts';
import type { Simulation } from './sim.ts';

export type WarningId =
  | 'stall' | 'overspeed' | 'config' | 'pullup' | 'sinkrate' | 'terrain' | 'toolowgear' | 'toolowflaps'
  | 'glideslope' | 'bankangle' | 'windshear';

export class Warnings {
  active = new Set<WarningId>();
  /** One-shot sounds / callouts for the audio system. */
  queue: string[] = [];
  private prevRa = 1e9;
  private calls = new Set<string | number>();
  private raRate = 0;
  private cooldown: Record<string, number> = {};
  private v1Called = false;
  private rotateCalled = false;
  private eightyCalled = false;
  private posRateCalled = false;
  private prevIas = 0;
  private iasTrend = 0;
  private altAlerted = false;
  private lastMcpAlt = 0;

  constructor(readonly sim: Simulation) {}

  trigger(name: string): void {
    this.queue.push(name);
  }

  private say(name: string, cooldown = 4): void {
    const t = this.sim.elapsed;
    if (this.cooldown[name] !== undefined && t - this.cooldown[name] < cooldown) return;
    this.cooldown[name] = t;
    this.queue.push(name);
  }

  update(dt: number): void {
    const sim = this.sim;
    const ac = sim.ac;
    const c = ac.controls;
    const raFt = ac.radioAlt / FT;
    const vsFpm = ac.vs / FPM;
    const iasKt = ac.ias / KT;
    const act = new Set<WarningId>();
    if (dt > 0) {
      this.raRate += (((raFt - this.prevRa) / dt) * 60 - this.raRate) * Math.min(1, dt * 2);
      this.iasTrend += (((iasKt - this.prevIas) / dt) - this.iasTrend) * Math.min(1, dt * 1.5);
    }
    this.prevIas = iasKt;

    if (ac.stallWarning) act.add('stall');
    const flapLimit = B739.flaps[Math.round(ac.flapPos)].vfe;
    if (iasKt > B739.vmo + 2 || ac.mach > B739.mmo + 0.005 || (ac.flapPos > 0.2 && iasKt > flapLimit + 3) || (ac.gearPos > 0.05 && iasKt > 275)) {
      act.add('overspeed');
    }
    if (ac.wow && Math.max(c.throttle[0], c.throttle[1]) > 0.6 && iasKt < 100) {
      const flapOk = c.flapLever >= 1 && c.flapLever <= 6 && Math.abs(ac.flapPos - c.flapLever) < 0.1;
      if (!flapOk || c.speedbrake > 0.05 || c.parkingBrake || c.trim < -0.3 || c.trim > 0.75) act.add('config');
    }
    if (!ac.wow && ac.airborneTime > 5) {
      if (raFt < 2500 && raFt > 30) {
        if (vsFpm < -(1600 + raFt * 1.6)) act.add('pullup');
        else if (vsFpm < -(1100 + raFt * 1.1)) act.add('sinkrate');
      }
      if (raFt < 1800 && raFt > 50 && this.raRate < -4500 && ac.gearPos < 0.5) act.add('terrain');
      if (raFt < 500 && raFt > 30 && ac.gearPos < 0.9 && iasKt < 190 && vsFpm < 0) act.add('toolowgear');
      else if (raFt < 245 && raFt > 30 && ac.flapPos < 5.5 && ac.gearPos > 0.9 && vsFpm < 0 && iasKt < 160) act.add('toolowflaps');
      const loc = sim.radios.nav1.kind === 'ils' && sim.radios.nav1.receiving ? sim.radios.nav1 : null;
      if (loc && loc.gsDots !== null && raFt < 1000 && raFt > 50 && ac.gearPos > 0.9 && Math.abs(loc.cdiDots) < 2 && loc.gsDots > 1.3) {
        act.add('glideslope');
      }
      if (Math.abs(ac.roll) > 35 + (raFt > 2500 ? 5 : 0)) act.add('bankangle');
      // Reactive windshear: rapid loss of airspeed with a downdraft below 1500 ft.
      if (raFt < 1500 && raFt > 20 && this.iasTrend < -2.2 && ac.env.vertical < -2.5) act.add('windshear');
    }
    // Altitude alert: chime when approaching the MCP altitude.
    const mcp = sim.ap.mcp.alt;
    if (mcp !== this.lastMcpAlt) {
      this.lastMcpAlt = mcp;
      this.altAlerted = false;
    }
    const toGo = Math.abs(mcp - ac.altInd / FT);
    if (!this.altAlerted && !ac.wow && toGo < 900 && toGo > 300 && Math.abs(vsFpm) > 300) {
      this.altAlerted = true;
      this.queue.push('chime');
    }
    // Altitude callouts on approach.
    if (!ac.wow && ac.airborneTime > 10 && vsFpm < -100) {
      for (const h of [2500, 1000, 500, 100, 50, 40, 30, 20, 10]) {
        if (this.prevRa > h && raFt <= h && !this.calls.has(h)) {
          this.calls.add(h);
          this.queue.push(`ra${h}`);
        }
      }
      const da = 200;
      if (this.prevRa > da + 100 && raFt <= da + 100 && !this.calls.has('appmin')) {
        this.calls.add('appmin');
        this.queue.push('approachingminimums');
      }
      if (this.prevRa > da && raFt <= da && !this.calls.has('min')) {
        this.calls.add('min');
        this.queue.push('minimums');
      }
      if (raFt < 25 && raFt > 3 && Math.max(c.throttle[0], c.throttle[1]) > 0.12 && !this.calls.has('retard')) {
        this.calls.add('retard');
        this.queue.push('retard');
      }
    }
    if (raFt > 3000) this.calls.clear();
    if (ac.wow && ac.groundTime > 1) {
      const vs = sim.vspeeds;
      if (iasKt > 80 && !this.eightyCalled && c.throttle[0] > 0.5) {
        this.eightyCalled = true;
        this.queue.push('eighty');
      }
      if (iasKt > vs.v1 && !this.v1Called && c.throttle[0] > 0.5) {
        this.v1Called = true;
        this.queue.push('v1');
      }
      if (iasKt > vs.vr && !this.rotateCalled && c.throttle[0] > 0.5) {
        this.rotateCalled = true;
        this.queue.push('rotate');
      }
      if (iasKt < 40) {
        this.v1Called = false;
        this.rotateCalled = false;
        this.eightyCalled = false;
        this.posRateCalled = false;
      }
    }
    if (!ac.wow && ac.airborneTime > 1 && ac.airborneTime < 15 && vsFpm > 300 && !this.posRateCalled && this.rotateCalled) {
      this.posRateCalled = true;
      this.queue.push('positiverate');
    }
    this.prevRa = raFt;
    const voice: Partial<Record<WarningId, string>> = {
      pullup: 'pullup', sinkrate: 'sinkrate', terrain: 'terrain', toolowgear: 'toolowgear', toolowflaps: 'toolowflaps',
      glideslope: 'glideslope', bankangle: 'bankangle', config: 'config', windshear: 'windshear',
    };
    for (const k of act) {
      const v = voice[k];
      if (v) this.say(v, k === 'config' ? 3 : 2.5);
    }
    this.active = act;
  }
}

