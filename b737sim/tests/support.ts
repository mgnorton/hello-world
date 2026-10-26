// Test helpers: load the real-world data from public/data with node's fs/zlib.
import { readFileSync, existsSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { join } from 'node:path';
import { loadWorld, type WorldData } from '../src/world/worldData.ts';
import type { Simulation, PilotInput } from '../src/core/sim.ts';
import { KT, FT, FPM } from '../src/core/math.ts';

const dataDir = join(import.meta.dirname ?? '.', '..', 'public', 'data');

let cached: Promise<WorldData> | null = null;
export function world(): Promise<WorldData> {
  cached ??= loadWorld({
    bytes: async (p) => new Uint8Array(readFileSync(join(dataDir, p))),
    gunzip: async (d) => new Uint8Array(gunzipSync(d)),
    text: async (p) => (existsSync(join(dataDir, p)) ? readFileSync(join(dataDir, p), 'utf8') : null),
  });
  return cached;
}

export const neutral = (): PilotInput => ({ pitch: 0, roll: 0, yaw: 0, tiller: 0, brakeL: 0, brakeR: 0 });

/** Fly the sim for `seconds`, calling onStep each 1/30 s; return false from onStep to stop. */
export function fly(sim: Simulation, seconds: number, onStep?: (t: number, pilot: PilotInput) => boolean | void, logEvery = 0): number {
  const dt = 1 / 30;
  let t = 0;
  let nextLog = 0;
  while (t < seconds) {
    const pilot = neutral();
    if (onStep && onStep(t, pilot) === false) break;
    sim.update(dt, pilot);
    t += dt;
    if (logEvery && t >= nextLog) {
      nextLog += logEvery;
      const ac = sim.ac;
      const f = sim.ap.fma();
      console.log(
        `  t=${t.toFixed(0).padStart(4)} ias=${(ac.ias / KT).toFixed(0).padStart(3)} alt=${(ac.altInd / FT).toFixed(0).padStart(6)} ` +
        `ra=${(ac.radioAlt / FT).toFixed(0).padStart(5)} vs=${(ac.vs / FPM).toFixed(0).padStart(5)} pit=${ac.pitch.toFixed(1)} ` +
        `hdg=${ac.heading.toFixed(0)} trk=${ac.track.toFixed(0)} n1=${ac.engines[0].n1.toFixed(0)} wp=${sim.plan?.activeLeg?.ident ?? ''} ` +
        `${f.at}|${f.roll}/${f.rollArmed}|${f.pitch}/${f.pitchArmed}|${f.status} ${ac.crashed ?? ''}`,
      );
    }
    if (sim.ac.crashed) break;
  }
  return t;
}

export const VERBOSE = !!process.env.VERBOSE;
