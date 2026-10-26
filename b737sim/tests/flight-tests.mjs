// Headless flight tests: run with `node b737sim/tests/flight-tests.mjs`.
// Flies scripted scenarios through the real flight model + autopilot and checks
// the results against expected B737-900 behaviour.
import { Simulation } from '../js/sim.js';
import { KT, FT, FPM, NM } from '../js/math.js';

const VERBOSE = process.argv.includes('-v');
let failures = 0;

function check(name, cond, detail = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  if (!cond) failures++;
}

const neutral = () => ({ pitch: 0, roll: 0, yaw: 0, tiller: 0, brakeL: 0, brakeR: 0 });

function fly(sim, seconds, onStep, log = 10) {
  const dt = 1 / 30;
  let t = 0;
  let nextLog = 0;
  while (t < seconds) {
    const pilot = neutral();
    if (onStep && onStep(sim, t, pilot) === false) break;
    sim.update(dt, pilot);
    t += dt;
    if (VERBOSE && t >= nextLog) {
      nextLog += log;
      const ac = sim.ac;
      const f = sim.ap.fma();
      console.log(
        `  t=${t.toFixed(0).padStart(4)} ias=${(ac.ias / KT).toFixed(0).padStart(3)} alt=${(ac.pos[1] / FT).toFixed(0).padStart(6)} ` +
        `ra=${(ac.radioAlt / FT).toFixed(0).padStart(5)} vs=${(ac.vs / FPM).toFixed(0).padStart(5)} pit=${ac.pitch.toFixed(1)} ` +
        `rol=${ac.roll.toFixed(1)} hdg=${ac.heading.toFixed(0)} trk=${ac.track.toFixed(0)} n1=${ac.engines[0].n1.toFixed(0)} ` +
        `trim=${ac.controls.trim.toFixed(2)} ${f.at}|${f.roll}/${f.rollArmed}|${f.pitch}/${f.pitchArmed}|${f.status} ${ac.crashed || ''}`,
      );
    }
    if (sim.ac.crashed) break;
  }
  return t;
}

// 1. Approach with autoland ----------------------------------------------------
{
  console.log('\n== Autoland: KPDX 10R from 13 nm ==');
  const sim = new Simulation({ start: 'approach', dep: 'KSEA', arr: 'KPDX', arrRwy: '10R', windSpeed: 8, windDir: 140 });
  const ac = sim.ac;
  const vref = sim.vspeeds.vref30;
  let configured = false;
  let stopped = false;
  fly(sim, 600, (s, t) => {
    const ils = s.arrEnd.ils(ac.pos[0], ac.pos[1], ac.pos[2]);
    // Configure like a crew would.
    if (ils.along < 9 * NM && ac.controls.flapLever < 5) ac.controls.flapLever = 5;
    if (ils.along < 7.5 * NM && !configured) {
      configured = true;
      ac.controls.gearDown = true;
      ac.controls.flapLever = 7;
      ac.controls.speedbrakeArmed = true;
      s.ap.mcp.spd = vref + 5;
    }
    if (ac.wow && ac.groundTime > 1.5) {
      s.ap.atArm = false;
      // Reverse thrust down to 60 kt, then idle.
      const rev = ac.gs > 60 * KT;
      ac.controls.reverse = rev;
      ac.controls.throttle = rev ? [0.6, 0.6] : [0, 0];
    }
    if (ac.wow && ac.gs < 2) {
      stopped = true;
      return false;
    }
  });
  const r = sim.landingReports[0];
  check('landed without crash', !ac.crashed && !!r, ac.crashed || '');
  if (r) {
    check('touchdown rate 0..-400 fpm', r.vs > -400 && r.vs < 0, `${r.vs} fpm (${r.grade})`);
    check('touchdown on runway', r.runway.includes('10R'), r.runway);
    check('touchdown within 100 ft of centerline', Math.abs(r.centerline) < 100, `${r.centerline} ft`);
    check('touchdown 500-2800 ft past threshold', r.fromThreshold > 500 && r.fromThreshold < 2800, `${r.fromThreshold} ft`);
  }
  check('stopped on runway', stopped && ac.surfaceKind === 'runway');
}

// 2. Takeoff, then AP climb with LNAV + LVL CHG --------------------------------
{
  console.log('\n== Takeoff KSEA 16L, AP climb ==');
  const sim = new Simulation({ start: 'runway', dep: 'KSEA', depRwy: '16L', arr: 'KPDX', windSpeed: 5, windDir: 170 });
  const ac = sim.ac;
  const ap = sim.ap;
  const vs = sim.vspeeds;
  let liftoff = null;
  let maxPitch = 0;
  let tailstrike = false;
  ac.controls.parkingBrake = false;
  ac.controls.speedbrakeArmed = false;
  ap.toga();
  fly(sim, 360, (s, t, pilot) => {
    const ias = ac.ias / KT;
    if (ac.wow && ias > vs.vr) pilot.pitch = Math.min(0.8, 0.12 * (11 - ac.pitch) - 0.6 * ac.w[2] * 57.3 * 0.2);
    if (!ac.wow && !ap.cmd) {
      liftoff = liftoff ?? { t, ias, dist: Math.hypot(ac.pos[0] - s.depEnd.tx, ac.pos[2] - s.depEnd.tz) };
      // Follow FD manually until 400 ft.
      pilot.pitch = Math.max(-0.5, Math.min(0.6, 0.1 * ap.fdPitch - 0.3 * ac.w[2] * 57.3 * 0.2));
      if (ac.radioAlt > 400 * FT) {
        ac.controls.gearDown = false;
        ap.engage(true);
        ap.setLat('LNAV');
        ap.lvlChg();
        ap.mcp.spd = 220;
      }
    }
    if (ap.cmd && ac.pos[1] > 3000 * FT && ac.controls.flapLever > 0) {
      ac.controls.flapLever = 0;
      ap.mcp.spd = 250;
    }
    maxPitch = Math.max(maxPitch, ac.pitch);
    tailstrike = tailstrike || ac.tailStrike;
  });
  check('lifted off', !!liftoff, liftoff ? `${liftoff.ias.toFixed(0)} kt after ${liftoff.dist.toFixed(0)} m` : '');
  check('liftoff distance 900-2400 m', liftoff && liftoff.dist > 900 && liftoff.dist < 2400);
  check('no tail strike', !tailstrike);
  check('no crash', !ac.crashed, ac.crashed || '');
  check('climbing on LNAV', ap.lat === 'LNAV' && sim.plan.active >= 2, `active wp ${sim.plan.activeWp?.name}`);
  check('altitude above 8000 ft', ac.pos[1] / FT > 8000, `${(ac.pos[1] / FT).toFixed(0)} ft`);
  check('speed held near 250 kt', Math.abs(ac.ias / KT - 250) < 15, `${(ac.ias / KT).toFixed(0)} kt`);
}

// 3. Cruise: hold altitude and Mach ---------------------------------------------
{
  console.log('\n== Cruise KSEA-KLAX ==');
  const sim = new Simulation({ start: 'cruise', dep: 'KSEA', arr: 'KLAX', cruiseAlt: 35000, turbulence: 1 });
  const ac = sim.ac;
  const startAlt = ac.pos[1];
  const startFuel = ac.fuel;
  fly(sim, 300);
  check('altitude held within 100 ft', Math.abs(ac.pos[1] - startAlt) < 100 * FT, `${((ac.pos[1] - startAlt) / FT).toFixed(0)} ft`);
  check('Mach ~0.78', Math.abs(ac.mach - 0.78) < 0.02, ac.mach.toFixed(3));
  const burnPerHour = ((startFuel - ac.fuel) / 300) * 3600;
  check('fuel burn 2000-3200 kg/h', burnPerHour > 2000 && burnPerHour < 3200, `${burnPerHour.toFixed(0)} kg/h`);
  // Descend with LVL CHG.
  sim.ap.mcp.alt = 24000;
  sim.ap.lvlChg();
  fly(sim, 400);
  check('descended to FL240 and captured', Math.abs(ac.pos[1] / FT - 24000) < 150 && sim.ap.vert === 'ALT HOLD', `${(ac.pos[1] / FT).toFixed(0)} ft ${sim.ap.vert}`);
  // Heading select turn.
  sim.ap.mcp.hdg = Math.round((ac.heading - sim.ap.magVar + 90 + 360) % 360);
  sim.ap.hdgSel();
  fly(sim, 120);
  const err = ((sim.ap.mcp.hdg + sim.ap.magVar - ac.heading + 540) % 360) - 180;
  check('HDG SEL turn complete', Math.abs(err) < 3, `${err.toFixed(1)} deg`);
}

// 4. Manual hands-off stability with auto-trim -----------------------------------
{
  console.log('\n== Hands-off stability (auto-trim) ==');
  const sim = new Simulation({ start: 'final', dep: 'KSEA', arr: 'KSEA', arrRwy: '34R', windSpeed: 0 });
  const ac = sim.ac;
  const p0 = ac.pitch;
  fly(sim, 20);
  check('pitch stable hands-off on final', Math.abs(ac.pitch - p0) < 3, `${p0.toFixed(1)} -> ${ac.pitch.toFixed(1)}`);
  check('wings level', Math.abs(ac.roll) < 5, ac.roll.toFixed(1));
}

console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
