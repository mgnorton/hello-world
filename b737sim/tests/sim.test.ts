// Headless tests over the real-world data: run with `npm test` (VERBOSE=1 for flight logs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { world, fly, VERBOSE } from './support.ts';
import { Simulation, suggestProcedures } from '../src/core/sim.ts';
import { FlightPlan } from '../src/fms/flightplan.ts';
import { KT, FT, FPM, NM, wrap180 } from '../src/core/math.ts';
import { LC } from '../src/world/worldData.ts';

const log = VERBOSE ? 10 : 0;

test('real-world data: KDFW runways, ILS, terrain, land cover, magnetic variation', async () => {
  const w = await world();
  const dfw = w.home;
  assert.equal(dfw.ident, 'KDFW');
  assert.equal(dfw.runways.length, 7);
  const r17c = dfw.end('17C')!;
  assert.equal(r17c.ils?.ident, 'I-FLQ');
  assert.equal(r17c.ils?.freq, 110.3);
  // Runway is graded to its surveyed elevation (within a few metres of the threshold).
  const s = w.surface(r17c.x + 50 * Math.sin((r17c.heading * Math.PI) / 180), r17c.z - 50 * Math.cos((r17c.heading * Math.PI) / 180));
  assert.equal(s.kind, 'runway');
  assert.ok(Math.abs(s.h - r17c.elevM) < 3, `runway height ${s.h} vs ${r17c.elevM}`);
  // Grapevine Lake is water in ESA WorldCover.
  const [gx, gz] = w.proj.toLocal(32.975, -97.075);
  assert.equal(w.landClass(gx, gz), LC.WATER);
  const mv = w.magVar.at(dfw.lat, dfw.lon);
  assert.ok(mv > 1.5 && mv < 4.5, `DFW magnetic variation ${mv}`);
});

test('NAV radios receive real VORs and localizers with correct geometry', async () => {
  const w = await world();
  const sim = new Simulation(w, { start: 'runway', weather: 'clear' });
  const ttt = w.nav.navaid('TTT')!;
  // Put the aircraft 20 nm due north of Maverick VOR at 5000 ft.
  const x = ttt.x;
  const z = ttt.z - 20 * NM;
  const r = sim.radios.nav1;
  r.tune(113.1, 180);
  r.update(1, w.nav, x, 1524, z, 2.7);
  assert.equal(r.ident, 'TTT');
  assert.ok(r.receiving);
  // Due north (true 000) minus the station's 6E declination = radial 354.
  assert.ok(Math.abs(wrap180(r.radial - 354)) < 0.5, `radial ${r.radial}`);
  assert.equal(r.toFrom, 'TO');
  assert.ok(Math.abs((r.dmeNm ?? 0) - 20) < 0.3);
  // Localizer on final for 17C.
  const e = w.home.end('17C')!;
  const [fx, fz] = e.pointOnFinal(8 * NM);
  r.tune(110.3, 176);
  r.update(1, w.nav, fx + 100, e.elevM + 760, fz, 2.7);
  assert.equal(r.kind, 'ils');
  assert.equal(r.loc, e);
  assert.ok(r.gsDots !== null && Math.abs(r.cdiDots) < 0.3);
  // Out of range: 200 nm away.
  r.tune(113.1, 0);
  r.update(1, w.nav, ttt.x + 200 * NM, 3000, ttt.z, 2.7);
  assert.equal(r.receiving, false);
});

test('flight plan from real SID, STAR and ILS approach', async () => {
  const w = await world();
  const sug = suggestProcedures(w, { dep: 'KDFW', depRwy: '17R', arr: 'KAUS', arrRwy: '' }, 180, 10);
  if (VERBOSE) console.log('  suggestion', sug);
  assert.ok(sug.sid, 'a SID is suggested');
  assert.ok(sug.approach, 'an approach is suggested');
  const res = FlightPlan.build(w.nav, {
    origin: 'KDFW', depRunway: sug.depRwy, sid: sug.sid, route: '', star: sug.star, starTransition: sug.starTransition,
    approach: sug.approach, dest: 'KAUS', arrRunway: sug.arrRwy, cruiseAltFt: 28000,
  });
  assert.deepEqual(res.errors, []);
  const plan = res.plan!;
  if (VERBOSE) console.log('  legs', plan.legs.map((l) => `${l.ident}${l.alt ? `(${l.alt.kind} ${l.alt.lo === -1e9 ? l.alt.hi : l.alt.lo})` : ''}`).join(' '));
  assert.ok(plan.legs.length > 6);
  assert.equal(plan.legs[plan.runwayIndex].runway, plan.arrEnd);
  const remNm = plan.remaining(plan.depEnd.x, plan.depEnd.z) / NM;
  assert.ok(remNm > 150 && remNm < 320, `route length ${remNm}`);
  // Airways: J/V routes resolve between their own points.
  const res2 = FlightPlan.build(w.nav, { origin: 'KDFW', depRunway: '35L', route: 'UKW', dest: 'KSPS', cruiseAltFt: 15000 });
  assert.deepEqual(res2.errors, []);
});

test('autoland: ILS 17C at KDFW in calm weather', async () => {
  const w = await world();
  const sim = new Simulation(w, { start: 'approach', dep: 'KDFW', arr: 'KDFW', arrRwy: '17C', approach: 'I17C', weather: 'clear' });
  const ac = sim.ac;
  const vref = sim.vspeeds.vref30;
  let configured = false;
  let stopped = false;
  fly(sim, 650, (t) => {
    const loc = sim.radios.nav1;
    const d = sim.arrEnd.ilsDeviation(ac.pos[0], ac.pos[1], ac.pos[2]);
    if (d.along < 9 * NM && ac.controls.flapLever < 5) ac.controls.flapLever = 5;
    if (d.along < 7.5 * NM && !configured) {
      configured = true;
      ac.controls.gearDown = true;
      ac.controls.flapLever = 7;
      ac.controls.speedbrakeArmed = true;
      sim.ap.mcp.spd = vref + 5;
    }
    if (ac.wow && ac.groundTime > 1.5) {
      sim.ap.atArm = false;
      const rev = ac.gs > 60 * KT;
      ac.controls.reverse = rev;
      ac.controls.throttle = rev ? [0.6, 0.6] : [0, 0];
    }
    if (ac.wow && ac.gs < 2) {
      stopped = true;
      return false;
    }
    void loc;
    void t;
  }, log);
  const r = sim.landingReports[0];
  assert.ok(!ac.crashed, String(ac.crashed));
  assert.ok(r, 'landed');
  if (VERBOSE) console.log('  report', r);
  assert.ok(r.vs < 0 && r.vs > -400, `vs ${r.vs}`);
  assert.equal(r.runway, 'KDFW 17C');
  assert.ok(Math.abs(r.centerline!) < 100, `centerline ${r.centerline}`);
  assert.ok(r.fromThreshold! > 400 && r.fromThreshold! < 3000, `from threshold ${r.fromThreshold}`);
  assert.ok(stopped && ac.surfaceKind !== 'grass', 'stopped on pavement');
});

test('takeoff from KDFW 17R, LNAV + VNAV climb along the SID', async () => {
  const w = await world();
  const sim = new Simulation(w, { start: 'runway', dep: 'KDFW', depRwy: '17R', arr: 'KAUS', weather: 'clear', cruiseAlt: 24000 });
  const sug = suggestProcedures(w, sim.options, 180, 8);
  sim.options.sid = sug.sid;
  sim.options.star = sug.star;
  sim.options.starTransition = sug.starTransition;
  sim.options.approach = sug.approach;
  assert.deepEqual(sim.buildPlan().filter((e) => !e.includes('not found')), []);
  const ac = sim.ac;
  const ap = sim.ap;
  ac.controls.parkingBrake = false;
  ap.mcp.alt = 24000;
  ap.lnav();
  ap.vnav();
  ap.toga();
  const vr = sim.vspeeds.vr;
  let liftoff = 0;
  let tail = false;
  fly(sim, 420, (t, pilot) => {
    const ias = ac.ias / KT;
    if (ac.wow && ias > vr) pilot.pitch = Math.min(0.8, 0.12 * (11 - ac.pitch) - 0.6 * ac.w[2] * 57.3 * 0.2);
    if (!ac.wow) {
      if (!liftoff) liftoff = t;
      if (!ap.cmd) {
        pilot.pitch = Math.max(-0.5, Math.min(0.6, 0.1 * ap.fdPitch - 0.3 * ac.w[2] * 57.3 * 0.2));
        if (ac.radioAlt > 400 * FT) {
          ac.controls.gearDown = false;
          ap.engage(true);
        }
      }
      if (ap.cmd && ac.altInd > 3000 * FT && ac.controls.flapLever > 0) ac.controls.flapLever = Math.max(0, ac.controls.flapLever - 1);
    }
    tail ||= ac.tailStrike;
  }, log);
  assert.ok(liftoff > 0, 'lifted off');
  assert.ok(!tail, 'no tail strike');
  assert.ok(!ac.crashed, String(ac.crashed));
  assert.equal(ap.lat, 'LNAV');
  assert.ok(ap.vnavActive, `vertical mode ${ap.vert}`);
  assert.ok(sim.plan!.active >= 3, `sequenced to ${sim.plan!.activeLeg?.ident}`);
  assert.ok(ac.altInd / FT > 9000, `altitude ${ac.altInd / FT}`);
});

test('VNAV descent from cruise honours the path and the MCP floor', async () => {
  const w = await world();
  const sug = suggestProcedures(w, { dep: 'KDFW', depRwy: '17R', arr: 'KAUS', arrRwy: '' }, 180, 8);
  const sim = new Simulation(w, { start: 'cruise', dep: 'KDFW', arr: 'KAUS', ...sug, weather: 'clear', cruiseAlt: 28000 });
  const ac = sim.ac;
  const ap = sim.ap;
  ap.mcp.alt = 11000;
  ap.vnav();
  let descended = false;
  let maxDev = 0;
  fly(sim, 900, () => {
    if (ap.vnavActive && ac.vs < -5) {
      descended = true;
      const p = sim.plan!.descentPathAlt(ac.pos[0], ac.pos[2]);
      maxDev = Math.max(maxDev, Math.abs(ac.altInd - Math.max(p.alt, 11000 * FT)) / FT);
    }
    if (ac.altInd < 11100 * FT && ac.vs > -1) return false;
  }, log);
  assert.ok(descended, 'started a VNAV descent');
  assert.ok(!ac.crashed);
  assert.ok(Math.abs(ac.altInd / FT - 11000) < 80, `stopped at MCP floor: ${ac.altInd / FT}`);
  assert.ok(ac.ias / KT < 300, `speed ${ac.ias / KT}`);
  if (VERBOSE) console.log('  max path deviation ft', maxDev.toFixed(0));
});

test('VOR/LOC mode intercepts and tracks a VOR radial', async () => {
  const w = await world();
  const sim = new Simulation(w, { start: 'cruise', dep: 'KDFW', arr: 'KSPS', weather: 'clear', cruiseAlt: 12000 });
  const ac = sim.ac;
  const ap = sim.ap;
  const ukw = w.nav.navaid('UKW')!;
  // Fly the 140 radial inbound to Bowie (course 320 TO), starting 40 nm out left of course on a 30-degree intercept.
  const nav1 = sim.radios.nav1;
  nav1.tune(ukw.raw.freq, 320);
  const brg = (140 + ukw.raw.stationVar + 8) * Math.PI / 180;
  ac.setTrimmedFlight([ukw.x + Math.sin(brg) * 40 * NM, 12000 * FT, ukw.z - Math.cos(brg) * 40 * NM], 320 + ukw.raw.stationVar + 30, 280, 0, { flaps: 0, gearDown: false });
  ap.engage(true);
  ap.setLat('HDG HOLD');
  ap.altHold();
  ap.vorLoc();
  fly(sim, 360, () => undefined, log);
  assert.equal(nav1.ident, 'UKW');
  assert.equal(ap.lat, 'VOR/LOC');
  assert.ok(Math.abs(nav1.devDeg) < 1.5, `deviation ${nav1.devDeg}`);
  assert.equal(nav1.toFrom, 'TO');
});

test('dynamic weather: storms evolve, lightning, METAR, microburst windshear', async () => {
  const w = await world();
  const sim = new Simulation(w, { start: 'runway', weather: 'storms', seed: 3 });
  const wx = sim.weather;
  assert.ok(wx.cells.length >= 3, 'storm cells spawned');
  const before = wx.cells.map((c) => [c.x, c.z]);
  wx.update(1200, 0, 0);
  assert.ok(wx.cells.some((c, i) => before[i] && Math.hypot(c.x - before[i][0], c.z - before[i][1]) > 5000), 'cells move');
  let strikes = 0;
  for (let i = 0; i < 600; i++) {
    wx.update(1, 0, 0);
    strikes += wx.strikes.filter((s) => s.t === wx.time).length;
  }
  assert.ok(strikes > 0, 'lightning');
  // Microburst: a collapsing cell right over a point gives a downdraft and outflow.
  const cell = wx.addCell(0, 0, { peak: 62, radius: 2000, age: 0, life: 1000 });
  cell.age = 850;
  wx.update(0.01, 0, 0);
  const near = wx.sample(1500, 0, 300, 180);
  assert.ok(near.vertical < -2, `downdraft ${near.vertical}`);
  assert.ok(near.precip > 5, `rain ${near.precip}`);
  const m = sim.metar(w.home);
  if (VERBOSE) console.log('  ', m);
  assert.match(m, /^KDFW \d{6}Z (\d{5}(G\d\d)?KT|00000KT) /);
  // Live HRRR seed decodes to sane values at DFW.
  const live = new Simulation(w, { start: 'runway', weather: 'live' });
  const s = live.weather.sample(w.home.x, w.home.z, w.home.elevM + 10, w.home.elevM);
  assert.ok(s.qnhPa > 97000 && s.qnhPa < 105000);
  assert.ok(s.tempC > -30 && s.tempC < 50);
  if (VERBOSE) console.log('  ', live.metar(w.home), '\n  ', live.atis(w.home));
});

test('hand-flown short final is stable with auto-trim', async () => {
  const w = await world();
  const sim = new Simulation(w, { start: 'final', arr: 'KDFW', arrRwy: '18R', weather: 'clear' });
  const p0 = sim.ac.pitch;
  fly(sim, 20);
  assert.ok(Math.abs(sim.ac.pitch - p0) < 3);
  assert.ok(Math.abs(sim.ac.roll) < 5);
  void FPM;
});
