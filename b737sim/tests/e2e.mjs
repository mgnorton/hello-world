#!/usr/bin/env node
// End-to-end check in a real browser (Playwright + Chromium): serves dist/, loads the real-world
// data, starts several flights and saves screenshots. Fails on page errors or if a flight
// does not start. Usage: npm run e2e   (screenshots go to $SHOTS or ./e2e-shots)
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync, mkdirSync } from 'node:fs';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Use a project-local Playwright if installed (npm i -D playwright), else a global one via NODE_PATH.
const { chromium } = await import('playwright').catch(() => createRequire(import.meta.url)('playwright'));
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
const shots = process.env.SHOTS || join(root, 'e2e-shots');
mkdirSync(shots, { recursive: true });
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };

const server = createServer((req, res) => {
  let p = decodeURIComponent((req.url || '/').split('?')[0]);
  if (p.endsWith('/')) p += 'index.html';
  const file = join(dist, p);
  if (!file.startsWith(dist) || !existsSync(file) || statSync(file).isDirectory()) {
    res.writeHead(404);
    res.end();
    return;
  }
  res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' });
  res.end(readFileSync(file));
}).listen(0);
const port = server.address().port;

const scenarios = [
  { name: 'dfw-takeoff-17R', opts: { dep: 'KDFW', depRwySel: '17R', arr: 'KAUS', start: 'runway', hour: 14, weather: 'live' }, camera: 'chase', seconds: 3 },
  { name: 'dfw-cockpit-17R', opts: { dep: 'KDFW', depRwySel: '17R', arr: 'KAUS', start: 'runway', hour: 14, weather: 'clear' }, camera: 'cockpit', seconds: 3 },
  { name: 'dfw-approach-17C-orbit', opts: { dep: 'KAUS', arr: 'KDFW', arrRwySel: '17C', approachSel: 'auto', start: 'approach', hour: 16, weather: 'clear' }, camera: 'orbit', seconds: 4 },
  { name: 'dfw-final-night', opts: { dep: 'KAUS', arr: 'KDFW', arrRwySel: '17C', start: 'final', hour: 21, weather: 'clear' }, camera: 'cockpit', seconds: 4 },
  { name: 'storms', opts: { dep: 'KDFW', arr: 'KAUS', start: 'cruise', hour: 17, weather: 'storms', cruiseAlt: 24000 }, camera: 'chase', seconds: 4, panel: 'wx' },
  { name: 'front-ifr-final', opts: { dep: 'KAUS', arr: 'KDFW', arrRwySel: '35C', start: 'final', hour: 10, weather: 'front' }, camera: 'chase', seconds: 4 },
  // Release the brakes and press TO/GA at 4x: the aircraft must accelerate down 17R.
  { name: 'dfw-takeoff-roll', opts: { dep: 'KDFW', depRwySel: '17R', arr: 'KAUS', start: 'runway', hour: 9, weather: 'live' }, camera: 'flyby', seconds: 1, simSeconds: 30,
    actions: ['parkingBrake', 'toga'], rate: 4, expect: (s) => s.ias > 60 || `expected the takeoff roll to reach 60 kt, got ${s.ias}` },
  { name: 'dfw-tower', opts: { dep: 'KDFW', depRwySel: '18L', arr: 'KIAH', start: 'runway', hour: 18.5, weather: 'live' }, camera: 'tower', seconds: 3, panel: 'radios' },
];

const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 760 } });
const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(`console: ${m.text()}`);
});
let failed = false;
try {
  await page.goto(`http://localhost:${port}/`);
  await page.waitForFunction(() => !document.getElementById('fly-btn').disabled, null, { timeout: 60000 });
  console.log('data loaded:', await page.textContent('#load-status'));
  await page.screenshot({ path: join(shots, '00-menu.png') });
  for (const [i, s] of scenarios.entries()) {
    if (process.env.ONLY && !s.name.includes(process.env.ONLY)) continue;
    const t0 = Date.now();
    await page.evaluate((o) => {
      const app = window.app;
      app.action('mainmenu');
      const m = { ...app.readMenu(), sidSel: 'auto', starSel: 'auto', approachSel: 'auto', depRwySel: 'auto', arrRwySel: 'auto', ...o };
      app.startFlight(m);
    }, s.opts);
    await page.waitForFunction(() => window.app.sim && !document.getElementById('hud').classList.contains('hidden'), null, { timeout: 90000 });
    await page.evaluate(({ camera, panel, actions, rate }) => {
      const app = window.app;
      app.rig.set(camera);
      if (panel) app.action(panel);
      for (const a of actions ?? []) app.action(a);
      if (rate) app.sim.timeScale = rate;
    }, { camera: s.camera, panel: s.panel, actions: s.actions, rate: s.rate });
    await page.waitForTimeout(s.seconds * 1000);
    // Software WebGL is slow; wait for simulated time where the check depends on it.
    if (s.simSeconds) await page.waitForFunction((t) => window.app.sim.elapsed >= t, s.simSeconds, { timeout: 240000, polling: 500 });
    const state = await page.evaluate(() => {
      const a = window.app;
      const ac = a.sim.ac;
      return {
        t: Math.round(a.sim.elapsed), n1: Math.round(ac.engines[0].n1), brake: ac.controls.parkingBrake, thr: ac.controls.throttle[0].toFixed(2),
        alt: Math.round(ac.altInd / 0.3048), ias: Math.round(ac.ias / 0.514444), crashed: ac.crashed, fma: a.sim.ap.fma(),
        airports: a.airports.count, buildings: a.city.count, puffs: a.wxView.puffCount, nav1: `${a.sim.radios.nav1.active} ${a.sim.radios.nav1.ident}`,
        legs: a.sim.plan?.legs.length ?? 0, metar: a.sim.metar(a.sim.arrAirport),
        calls: a.renderer.info.render.calls, tris: a.renderer.info.render.triangles,
      };
    });
    console.log(`${s.name} (${((Date.now() - t0) / 1000).toFixed(1)} s):`, JSON.stringify(state));
    const verdict = s.expect ? s.expect(state) : true;
    if (verdict !== true) {
      failed = true;
      console.error(`  ${verdict}`);
    }
    if (state.crashed) {
      failed = true;
      console.error(`  crashed: ${state.crashed}`);
    }
    await page.screenshot({ path: join(shots, `${String(i + 1).padStart(2, '0')}-${s.name}.png`) });
  }
} catch (e) {
  failed = true;
  console.error(e);
} finally {
  await browser.close();
  server.close();
}
const real = errors.filter((e) => !/GPU stall|WebGL: INVALID|Automatic fallback to software WebGL/i.test(e));
if (real.length) {
  failed = true;
  console.error('Errors in the page:\n  ' + [...new Set(real)].slice(0, 20).join('\n  '));
}
console.log(failed ? 'E2E FAILED' : `E2E passed; screenshots in ${shots}`);
process.exit(failed ? 1 : 0);
