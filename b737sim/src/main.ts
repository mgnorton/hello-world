// Application entry: loads the real-world data, builds the menu from the FAA database, runs
// the flight (simulation, renderer, instruments, sound) and drives the HUD panels.
import * as THREE from 'three';
import { Simulation, DEFAULT_OPTIONS, suggestProcedures, type SimOptions, type LandingReport } from './core/sim.ts';
import { B739, vSpeeds, FLAP_NAMES, AUTOBRAKE } from './core/aircraftData.ts';
import { clamp, wrap360, KT, FT, FPM, NM, RAD } from './core/math.ts';
import { hPaToInHg } from './core/atmosphere.ts';
import { loadWorld, type WorldData, type DataSource } from './world/worldData.ts';
import type { Airport } from './world/navdb.ts';
import { gcDistanceNm } from './world/geo.ts';
import { FlightPlan } from './fms/flightplan.ts';
import { WeatherSystem } from './weather/weather.ts';
import { PRESETS, decodeSeed, presetSeed, type PresetId, type CustomWeather } from './weather/seed.ts';
import { WorldView } from './render/world.ts';
import { AircraftModel } from './render/aircraftModel.ts';
import { AirportManager, updateAirportMaterials } from './render/airports.ts';
import { CityView } from './render/city.ts';
import { WeatherView } from './render/weatherView.ts';
import { updateLights } from './render/lights.ts';
import { CameraRig } from './render/cameras.ts';
import { PFD, ND, EICAS } from './ui/instruments.ts';
import { InputManager, KEY_HELP, type Action } from './ui/controls.ts';
import { SoundSystem } from './ui/audio.ts';

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;
const STORE_KEY = 'skyline737.v2.options';

type MenuOptions = SimOptions & { sidSel: string; starSel: string; approachSel: string; depRwySel: string; arrRwySel: string };

const DEFAULT_CUSTOM: CustomWeather = { windDir: 180, windKt: 10, gustKt: 0, visKm: 15, cloudBaseFt: 3500, cover: 0.4, tempC: 22, qnhHpa: 1015, convection: 0 };

function loadOptions(): MenuOptions {
  const base: MenuOptions = { ...DEFAULT_OPTIONS, custom: { ...DEFAULT_CUSTOM }, sidSel: 'auto', starSel: 'auto', approachSel: 'auto', depRwySel: 'auto', arrRwySel: 'auto' };
  try {
    const s = JSON.parse(localStorage.getItem(STORE_KEY) || '{}') as Partial<MenuOptions>;
    return { ...base, ...s, custom: { ...DEFAULT_CUSTOM, ...(s.custom ?? {}) } };
  } catch {
    return base;
  }
}
function saveOptions(o: MenuOptions): void {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(o));
  } catch {
    // Storage may be unavailable (private mode, sandbox); options are just not remembered.
  }
}

const titleCase = (s: string) => s.toLowerCase().replace(/\b[a-z]/g, (m) => m.toUpperCase());

/** Decode base64 text into bytes. */
function fromBase64(s: string): Uint8Array {
  const bin = atob(s.replace(/\s+/g, ''));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * Browser data loader: files sit next to the page; gzip is undone with DecompressionStream.
 * Hosts that only serve text (the claude.ai artifact) get `<name>.b64.txt` copies instead.
 */
const base64Data = document.querySelector('meta[name="skyline-data"]')?.getAttribute('content') === 'base64';
const browserSource: DataSource = {
  async bytes(p) {
    const name = base64Data ? `${p}.b64.txt` : p;
    const r = await fetch(new URL(`data/${name}`, document.baseURI));
    if (!r.ok) throw new Error(`${name}: HTTP ${r.status}`);
    return base64Data ? fromBase64(await r.text()) : new Uint8Array(await r.arrayBuffer());
  },
  async gunzip(d) {
    const stream = new Blob([d]).stream().pipeThrough(new DecompressionStream('gzip'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  },
  async text(p) {
    const r = await fetch(new URL(`data/${p}`, document.baseURI));
    return r.ok ? r.text() : null;
  },
};

class App {
  readonly canvas = $<HTMLCanvasElement>('scene');
  world: WorldData | null = null;
  renderer: THREE.WebGLRenderer | null = null;
  sim: Simulation | null = null;
  view: WorldView | null = null;
  model: AircraftModel | null = null;
  airports: AirportManager | null = null;
  city: CityView | null = null;
  wxView: WeatherView | null = null;
  rig: CameraRig | null = null;
  readonly sound = new SoundSystem();
  options = loadOptions();
  lights = { landing: true, nav: true, strobe: true, beacon: true };
  compact = window.innerWidth < 700 || window.innerHeight < 560;
  showInstruments = !this.compact;
  instrSize: 'normal' | 'big' | 'map' = 'normal';
  private hudTimer = 0;
  private instTimer = 0;
  private lastInstDraw = 0;
  private panelTimer = 0;
  private envTimer = 0;
  private lastTime = performance.now();
  private shownReports = 0;
  private pendingReport: LandingReport | null = null;
  private crashShown = false;
  private brakeButton = false;
  private lastPadThrottle: number | null = null;
  private wet = 0;
  private env = { vis: 40000, inCloud: 0, overcast: 0 };
  private nearTimer = 0;
  private legsKey = '';
  readonly input: InputManager;
  readonly pfd = new PFD($<HTMLCanvasElement>('pfd'));
  readonly nd = new ND($<HTMLCanvasElement>('nd'));
  readonly eicas = new EICAS($<HTMLCanvasElement>('eicas'));
  private previewWx = new Map<string, WeatherSystem>();
  private airportList: Airport[] = [];

  constructor() {
    this.input = new InputManager(this.canvas, (a, v) => this.action(a, v));
    this.input.onLook = (dx, dy) => this.rig?.drag(dx, dy);
    this.input.onWheel = (d) => this.rig?.wheel(d);
    if (matchMedia('(pointer: coarse)').matches) document.body.classList.add('touch');
    this.input.bindTouchStick($('touch-stick'), document.querySelector<HTMLElement>('#touch-stick .knob-dot')!);
    $('help-body').innerHTML = KEY_HELP.map(([k, d]) => `<div><kbd>${k}</kbd></div><div>${d}</div>`).join('');
    $('help-btn').onclick = () => this.action('help');
    this.bindHud();
    window.addEventListener('resize', () => this.resize());
    void this.load();
    requestAnimationFrame((t) => this.loop(t));
  }

  private async load(): Promise<void> {
    const status = $('load-status');
    try {
      this.world = await loadWorld(browserSource, (msg, f) => {
        status.textContent = `Loading real-world data: ${msg}… ${Math.round(f * 100)}%`;
      });
    } catch (e) {
      status.innerHTML = `<b>Could not load the scenery data.</b> ${String(e)}`;
      return;
    }
    const w = this.world;
    const nav = w.meta;
    status.innerHTML = `Terrain: USGS 3DEP · Land cover: ESA WorldCover 10 m · FAA NASR + CIFP cycle <b>${nav.navCycle}</b> · ` +
      `${w.nav.airports.length} airports, ${w.nav.navaids.length} navaids, ${w.nav.fixes.length} fixes` +
      (w.weatherSeed ? ` · NOAA HRRR weather valid <b>${w.weatherSeed.validTime}</b>` : '');
    this.buildMenu();
    $<HTMLButtonElement>('fly-btn').disabled = false;
  }

  // --------------------------------------------------------------------------- menu

  private previewWeather(o: MenuOptions): WeatherSystem {
    const w = this.world!;
    const key = `${o.weather}:${JSON.stringify(o.weather === 'custom' ? o.custom : '')}:${o.seed}`;
    let wx = this.previewWx.get(key);
    if (!wx) {
      const grid = w.weatherSeed?.grid ?? { south: 29.8, west: -100, step: 0.1, rows: 58, cols: 58 };
      const seed = o.weather === 'live' && w.weatherSeed ? decodeSeed(w.weatherSeed) : presetSeed(o.weather === 'live' ? 'clear' : o.weather, grid, o.custom, o.seed);
      wx = new WeatherSystem(seed, w.proj, { evolution: 0, seed: o.seed });
      this.previewWx.set(key, wx);
    }
    return wx;
  }

  private buildMenu(): void {
    const w = this.world!;
    const o = this.options;
    this.airportList = w.nav.airports
      .filter((a) => a.runways.some((r) => r.paved && r.lengthM >= 1500))
      .sort((a, b) => (a.ident === 'KDFW' ? -1 : b.ident === 'KDFW' ? 1 : a.ident.localeCompare(b.ident)));
    const fillAirports = (sel: HTMLSelectElement, value: string) => {
      sel.innerHTML = this.airportList.map((a) => `<option value="${a.ident}">${a.ident} — ${titleCase(a.name)}</option>`).join('');
      sel.value = this.airportList.some((a) => a.ident === value) ? value : 'KDFW';
    };
    fillAirports($('o-dep'), o.dep);
    fillAirports($('o-arr'), o.arr);
    const alts: number[] = [];
    for (let fl = 50; fl <= 410; fl += 10) alts.push(fl * 100);
    $('o-cruiseAlt').innerHTML = alts.map((a) => `<option value="${a}">${a < 18000 ? `${a} ft` : `FL${a / 100}`}</option>`).join('');
    $<HTMLSelectElement>('o-cruiseAlt').value = String(o.cruiseAlt);
    $('o-weather').innerHTML = PRESETS.map((p) => `<option value="${p.id}">${p.name}</option>`).join('');
    const set = (id: string, v: string | number | boolean) => {
      const el = $<HTMLInputElement>(id);
      if (el.type === 'checkbox') el.checked = !!v;
      else el.value = String(v);
    };
    set('o-weather', o.weather);
    set('o-weatherRate', o.weatherRate);
    set('o-start', o.start);
    set('o-route', o.route);
    for (const k of ['pax', 'fuel', 'hour'] as const) set(`o-${k}`, o[k]);
    for (const k of ['windDir', 'windKt', 'gustKt', 'visKm', 'cloudBaseFt', 'cover', 'convection'] as const) set(`o-${k}`, o.custom![k]);
    set('o-autoTrim', o.autoTrim);
    set('o-apOnApproach', o.apOnApproach);
    this.fillProcedures(o);
    const changed = (e: Event) => {
      const id = (e.target as HTMLElement).id;
      const m = this.readMenu();
      if (id === 'o-dep') Object.assign(m, { depRwySel: 'auto', sidSel: 'auto' });
      if (id === 'o-arr') Object.assign(m, { arrRwySel: 'auto', starSel: 'auto', approachSel: 'auto' });
      if (id === 'o-depRwy') m.sidSel = 'auto';
      if (id === 'o-arrRwy') m.approachSel = 'auto';
      if (['o-dep', 'o-arr', 'o-depRwy', 'o-arrRwy', 'o-weather'].includes(id) || id.startsWith('o-wind')) this.fillProcedures(m);
      this.refreshMenu();
    };
    $('menu').querySelectorAll('input,select').forEach((el) => el.addEventListener('change', changed));
    $('menu').querySelectorAll('input[type=range]').forEach((el) => el.addEventListener('input', () => this.refreshMenu()));
    $('fly-btn').onclick = () => this.startFlight(this.readMenu());
    this.refreshMenu();
  }

  /** Runway, SID, STAR and approach lists for the chosen airports, with wind-based suggestions. */
  private fillProcedures(o: MenuOptions): void {
    const w = this.world!;
    const db = w.nav;
    const dep = db.airport(o.dep) ?? w.home;
    const arr = db.airport(o.arr) ?? w.home;
    const wx = this.previewWeather(o);
    const wind = (ap: Airport) => {
      const s = wx.sample(ap.x, ap.z, ap.elevM + 10, ap.elevM);
      return { from: s.windFrom, kt: s.windSpeed / KT };
    };
    const dw = wind(dep);
    const aw = wind(arr);
    const depAuto = dep.bestEnd(dw.from, dw.kt);
    const arrAuto = arr.bestEnd(aw.from, aw.kt);
    const ends = (ap: Airport) => ap.ends.filter((e) => e.runway.paved && e.runway.lengthM >= 1500);
    const rwOpts = (ap: Airport, auto: string) =>
      `<option value="auto">Auto: ${auto} (into wind)</option>` +
      ends(ap).map((e) => `<option value="${e.id}">${e.id} · ${Math.round(e.runway.raw.lengthFt)} ft${e.ils ? ` · ILS ${e.ils.freq.toFixed(2)}` : ''}</option>`).join('');
    $('o-depRwy').innerHTML = rwOpts(dep, depAuto.id);
    $('o-arrRwy').innerHTML = rwOpts(arr, arrAuto.id);
    $<HTMLSelectElement>('o-depRwy').value = ends(dep).some((e) => e.id === o.depRwySel) ? o.depRwySel : 'auto';
    $<HTMLSelectElement>('o-arrRwy').value = ends(arr).some((e) => e.id === o.arrRwySel) ? o.arrRwySel : 'auto';
    const depRwy = o.depRwySel !== 'auto' && dep.end(o.depRwySel) ? o.depRwySel : depAuto.id;
    const arrRwy = o.arrRwySel !== 'auto' && arr.end(o.arrRwySel) ? o.arrRwySel : arrAuto.id;
    const sug = suggestProcedures(w, { dep: dep.ident, depRwy, arr: arr.ident, arrRwy }, aw.from, aw.kt);
    const procOpts = (list: { ident: string; name: string }[], auto: string | null) =>
      `<option value="auto">Auto: ${auto ?? 'none'}</option><option value="">None</option>` +
      [...new Map(list.map((p) => [p.ident, p])).values()].map((p) => `<option value="${p.ident}">${p.ident}${p.name && p.name !== p.ident ? ` (${p.name})` : ''}</option>`).join('');
    const pick = (id: string, v: string, list: { ident: string }[]) => {
      $<HTMLSelectElement>(id).value = v === 'auto' || v === '' || list.some((p) => p.ident === v) ? v : 'auto';
    };
    const sids = db.proceduresFor(dep.ident, 'SID');
    const stars = db.proceduresFor(arr.ident, 'STAR');
    const apps = db.proceduresFor(arr.ident, 'IAP').filter((p) => p.runway === arrRwy);
    $('o-sid').innerHTML = procOpts(sids, sug.sid);
    $('o-star').innerHTML = procOpts(stars, sug.star ? `${sug.star}${sug.starTransition ? `.${sug.starTransition}` : ''}` : null);
    $('o-approach').innerHTML = procOpts(apps.map((p) => ({ ident: p.ident, name: p.name })), sug.approach);
    pick('o-sid', o.sidSel, sids);
    pick('o-star', o.starSel, stars);
    pick('o-approach', o.approachSel, apps);
  }

  private readMenu(): MenuOptions {
    const v = (id: string) => $<HTMLInputElement>(id).value;
    const n = (id: string) => parseFloat(v(id));
    const ck = (id: string) => $<HTMLInputElement>(id).checked;
    return {
      ...this.options,
      dep: v('o-dep'), arr: v('o-arr'), depRwySel: v('o-depRwy') || 'auto', arrRwySel: v('o-arrRwy') || 'auto',
      sidSel: v('o-sid') ?? 'auto', starSel: v('o-star') ?? 'auto', approachSel: v('o-approach') ?? 'auto',
      route: v('o-route').trim().toUpperCase(), start: v('o-start') as SimOptions['start'], cruiseAlt: n('o-cruiseAlt'),
      pax: n('o-pax'), fuel: n('o-fuel'), hour: n('o-hour'), weather: v('o-weather') as PresetId, weatherRate: n('o-weatherRate'),
      custom: {
        ...DEFAULT_CUSTOM, windDir: n('o-windDir'), windKt: n('o-windKt'), gustKt: n('o-gustKt'), visKm: n('o-visKm'),
        cloudBaseFt: n('o-cloudBaseFt'), cover: n('o-cover'), convection: n('o-convection'),
      },
      autoTrim: ck('o-autoTrim'), apOnApproach: ck('o-apOnApproach'),
    };
  }

  /** Resolve "auto" choices into concrete runways and procedures. */
  private resolve(m: MenuOptions): SimOptions {
    const w = this.world!;
    const dep = w.nav.airport(m.dep) ?? w.home;
    const arr = w.nav.airport(m.arr) ?? w.home;
    const wx = this.previewWeather(m);
    const s = (ap: Airport) => wx.sample(ap.x, ap.z, ap.elevM + 10, ap.elevM);
    const dw = s(dep);
    const aw = s(arr);
    const depRwy = m.depRwySel !== 'auto' ? m.depRwySel : dep.bestEnd(dw.windFrom, dw.windSpeed / KT).id;
    const arrRwy = m.arrRwySel !== 'auto' ? m.arrRwySel : arr.bestEnd(aw.windFrom, aw.windSpeed / KT).id;
    const sug = suggestProcedures(w, { dep: dep.ident, depRwy, arr: arr.ident, arrRwy }, aw.windFrom, aw.windSpeed / KT);
    const choose = (sel: string, auto: string | null) => (sel === 'auto' ? auto : sel || null);
    const star = choose(m.starSel, sug.star);
    return {
      ...m, dep: dep.ident, arr: arr.ident, depRwy, arrRwy, sid: choose(m.sidSel, sug.sid), sidTransition: null,
      star, starTransition: m.starSel === 'auto' ? sug.starTransition : null, approach: choose(m.approachSel, sug.approach),
    };
  }

  private refreshMenu(): void {
    if (!this.world) return;
    const m = this.readMenu();
    const o = this.resolve(m);
    const hh = Math.floor(m.hour);
    $('o-hour-v').textContent = `${String(hh).padStart(2, '0')}:${m.hour % 1 ? '30' : '00'} CT`;
    $('o-pax-v').textContent = String(m.pax);
    $('o-fuel-v').textContent = m.fuel.toLocaleString('en-US');
    const c = m.custom!;
    $('o-windDir-v').textContent = `${String(c.windDir).padStart(3, '0')}°`;
    $('o-windKt-v').textContent = `${c.windKt} kt`;
    $('o-gustKt-v').textContent = c.gustKt ? `+${c.gustKt} kt` : 'none';
    $('o-visKm-v').textContent = `${c.visKm.toFixed(1)} km`;
    $('o-cloudBaseFt-v').textContent = `${c.cloudBaseFt} ft`;
    $('o-cover-v').textContent = `${Math.round(c.cover * 8)}/8`;
    $('o-convection-v').textContent = c.convection < 0.05 ? 'none' : c.convection < 0.4 ? 'isolated' : c.convection < 0.75 ? 'scattered' : 'outbreak';
    $('o-custom').classList.toggle('hidden', m.weather !== 'custom');
    const w = this.world;
    const dep = w.nav.airport(o.dep)!;
    const arr = w.nav.airport(o.arr)!;
    // Preview the flight plan with the real procedures.
    const res = FlightPlan.build(w.nav, {
      origin: o.dep, depRunway: o.depRwy, sid: o.sid, route: o.route, star: o.star, starTransition: o.starTransition,
      approach: o.approach, dest: o.arr, arrRunway: o.arrRwy, cruiseAltFt: o.cruiseAlt,
    });
    const gc = gcDistanceNm(dep.lat, dep.lon, arr.lat, arr.lon);
    const routeNm = res.plan ? res.plan.remaining(res.plan.depEnd.x, res.plan.depEnd.z) / NM : gc;
    const tripFuel = routeNm * 11.5 + 1800;
    const problems = [...res.errors, ...res.warnings];
    $('o-routeinfo').innerHTML = `<b>${o.dep} ${o.depRwy}</b> ${o.sid ?? ''} ${o.route} ${o.star ?? ''} ${o.approach ?? ''} <b>${o.arr} ${o.arrRwy}</b><br>` +
      `${res.plan ? `${res.plan.legs.length} legs, ` : ''}${Math.round(routeNm)} nm by route (${Math.round(gc)} nm direct). ` +
      `Suggested fuel ≈ <b>${Math.round(Math.min(B739.maxFuel, tripFuel + 2500)).toLocaleString('en-US')} kg</b>` +
      (problems.length ? `<br><span style="color:var(--amber)">${problems.slice(0, 3).join('<br>')}</span>` : '');
    const zfw = B739.oew + m.pax * B739.paxMass;
    const tow = zfw + m.fuel;
    const v = vSpeeds(tow, 3, Math.min(tow, B739.mlw));
    const warn: string[] = [];
    if (zfw > B739.mzfw) warn.push('ZFW over limit');
    if (tow > B739.mtow) warn.push('TOW over MTOW');
    $('o-weights').innerHTML = `ZFW <b>${(zfw / 1000).toFixed(1)} t</b> · TOW <b>${(tow / 1000).toFixed(1)} t</b> (MTOW ${(B739.mtow / 1000).toFixed(1)} t)<br>` +
      `Flaps 5: V1 <b>${v.v1}</b> VR <b>${v.vr}</b> V2 <b>${v.v2}</b> · Vref30 <b>${v.vref30}</b>` +
      (warn.length ? `<br><span style="color:var(--amber)">${warn.join(', ')}</span>` : '');
    const wx = this.previewWeather(m);
    const preset = PRESETS.find((p) => p.id === m.weather);
    const metar = wx.metar(dep.ident, dep.x, dep.z, dep.elevM, new Date());
    $('o-wxinfo').innerHTML = `${preset?.blurb ?? ''}${m.weather === 'live' && w.weatherSeed ? ` Valid ${w.weatherSeed.validTime}.` : ''}<br><span class="mono">${metar}</span>`;
  }

  // --------------------------------------------------------------------------- flight lifecycle

  startFlight(m: MenuOptions): void {
    this.options = m;
    saveOptions(m);
    this.sound.start();
    $('menu').classList.add('hidden');
    $('pause-menu').classList.add('hidden');
    $('report').classList.add('hidden');
    $('loading').classList.remove('hidden');
    $('loading-text').textContent = 'Building scenery…';
    setTimeout(() => this.buildFlight(this.resolve(m)), 30);
  }

  private disposeFlight(): void {
    if (!this.view) return;
    this.view.scene.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.geometry) mesh.geometry.dispose();
    });
    this.view = null;
  }

  private buildFlight(opts: SimOptions): void {
    const world = this.world!;
    this.disposeFlight();
    if (!this.renderer) {
      try {
        this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true, logarithmicDepthBuffer: true, powerPreference: 'high-performance' });
      } catch (e) {
        $('loading').classList.add('hidden');
        $('fatal-text').textContent = `WebGL is not available in this browser (${String(e)}).`;
        $('fatal').classList.remove('hidden');
        return;
      }
    }
    const sim = new Simulation(world, opts);
    this.sim = sim;
    const view = new WorldView(this.renderer, world, opts.hour);
    this.view = view;
    this.model = new AircraftModel();
    this.model.setScreens([$<HTMLCanvasElement>('pfd'), $<HTMLCanvasElement>('nd'), $<HTMLCanvasElement>('eicas'), $<HTMLCanvasElement>('nd'), $<HTMLCanvasElement>('pfd')]);
    view.scene.add(this.model.root);
    this.airports = new AirportManager(view.scene, world);
    this.city = new CityView(view.scene, world, this.airports.ground);
    this.wxView = new WeatherView(view.scene, sim.weather, world);
    this.rig = new CameraRig(view.camera);
    this.rig.set(opts.start === 'runway' ? 'chase' : 'chase');
    this.lights = { landing: opts.start !== 'cruise', nav: true, strobe: true, beacon: true };
    this.resize();
    const ac = sim.ac;
    const night = 1 - view.dayFactor;
    this.model.update(ac, 0, 0, { lights: this.lights, night, cockpit: false });
    this.rig.update(ac, this.model, 0.016, null, (x, z) => world.height(x, z));
    const cam = view.camera.position;
    view.prime(cam);
    this.airports.prime(cam);
    this.city.prime(cam);
    const g = world.height(ac.pos[0], ac.pos[2]);
    this.wet = clamp(sim.weather.sample(ac.pos[0], ac.pos[2], g + 2, g).precip / 3, 0, 1);
    this.envTimer = 0;
    $('loading').classList.add('hidden');
    $('hud').classList.remove('hidden');
    $<HTMLSelectElement>('w-rate').value = String(opts.weatherRate);
    this.applyInstrumentVisibility();
    this.lastTime = performance.now();
    this.shownReports = 0;
    this.crashShown = false;
    this.pendingReport = null;
    this.legsKey = '';
    this.nd.resetWxr();
    this.flapButtons();
    this.updateHud();
    for (const msg of sim.messages) this.toast(msg.text, msg.kind);
    sim.messages.length = 0;
    for (const e of sim.planErrors.slice(0, 2)) this.toast(e, 'warn');
  }

  private resize(): void {
    this.view?.resize(window.innerWidth, window.innerHeight);
  }

  // --------------------------------------------------------------------------- main loop

  private loop(now: number): void {
    requestAnimationFrame((t) => this.loop(t));
    const dt = clamp((now - this.lastTime) / 1000, 0, 0.1);
    this.lastTime = Math.max(this.lastTime, now);
    const sim = this.sim;
    const view = this.view;
    if (!sim || !view || !this.model || !this.rig || !this.airports || !this.city || !this.wxView) return;
    const pilot = this.input.poll(dt);
    if (this.input.gamepadThrottle !== null) {
      const v = this.input.gamepadThrottle;
      if (this.lastPadThrottle === null || Math.abs(v - this.lastPadThrottle) > 0.01) {
        this.setThrottle(v);
        this.lastPadThrottle = v;
      }
    }
    if (this.brakeButton) {
      pilot.brakeL = 1;
      pilot.brakeR = 1;
    }
    sim.update(dt, pilot);
    this.handleSimEvents();

    const ac = sim.ac;
    const world = sim.world;
    const time = sim.elapsed;
    const night = 1 - view.dayFactor;
    const cockpit = this.rig.mode === 'cockpit';
    const simDt = sim.paused ? 0 : dt * sim.timeScale;
    this.model.update(ac, simDt, time, { lights: this.lights, night, cockpit });
    const acPos = this.model.root.position;
    this.rig.update(ac, this.model, dt, this.airports.towerFor(acPos.x, acPos.z), (x, z) => world.height(x, z));
    const cam = view.camera.position;
    if (cockpit && !sim.paused) {
      const shake = (ac.buffet || 0) * 0.02 + (ac.wow ? Math.min(ac.gs / 80, 1) * 0.004 : 0) + (ac.env?.turbulence ?? 0) * 0.004;
      if (shake > 0) {
        cam.x += (Math.random() - 0.5) * shake;
        cam.y += (Math.random() - 0.5) * shake;
      }
    }
    // Weather around the camera (sampled a few times a second).
    this.envTimer -= dt;
    if (this.envTimer <= 0) {
      this.envTimer = 0.25;
      const g = world.height(cam.x, cam.z);
      const s = sim.weather.sample(cam.x, cam.z, cam.y, g);
      let overcast = 0;
      for (const l of s.layers) if (l.base > cam.y) overcast = Math.max(overcast, l.cover * (l.type === 'ci' ? 0.25 : l.type === 'ac' ? 0.6 : 1));
      this.env = { vis: s.vis, inCloud: s.inCloud, overcast };
      const ag = world.height(ac.pos[0], ac.pos[2]);
      const target = clamp(sim.weather.sample(ac.pos[0], ac.pos[2], ag + 2, ag).precip / 3, 0, 1);
      // Pavement gets wet quickly in rain and dries over tens of minutes.
      this.wet += (target - this.wet) * clamp((0.25 * sim.timeScale * Math.max(0.2, sim.weather.opts.evolution)) / (target > this.wet ? 90 : 1200), 0, 1);
    }
    view.update(dt, cam, acPos, this.env.vis, this.env.inCloud, this.env.overcast, this.wet);
    this.airports.update(dt, cam);
    this.city.update(cam, night);
    const v = new THREE.Vector3(ac.vel[0], ac.vel[1], ac.vel[2]);
    const sun = view.sun.color.clone().multiplyScalar(view.sun.intensity / 3.2);
    const amb = view.hemi.color.clone().multiplyScalar(view.hemi.intensity * 0.55);
    this.wxView.update(simDt, time, cam, v, { sunDir: view.sunDir, sun, amb, fogCol: view.fog.color, fog: view.fog.density, day: view.dayFactor }, (k) => {
      view.flash = Math.max(view.flash, k);
    });
    for (const s of this.wxView.newStrikes) this.sound.thunder(s.dist);
    updateLights(time, clamp(night + this.env.overcast * 0.35 + (this.env.vis < 5000 ? 0.4 : 0), 0, 1), view.fog.density, this.renderer!.getPixelRatio());
    updateAirportMaterials(this.wet, night);
    view.render();

    this.instTimer -= dt;
    if (this.instTimer <= 0 && (this.showInstruments || cockpit)) {
      this.instTimer = 1 / 30;
      // Real time since the last draw (frames can be slow), scaled like the simulation.
      const instDt = clamp((now - this.lastInstDraw) / 1000, 1 / 120, 0.5) * (sim.paused ? 0 : sim.timeScale);
      this.lastInstDraw = now;
      this.pfd.draw(sim, Math.max(instDt, 1e-3));
      this.nd.draw(sim, instDt);
      this.eicas.draw(sim);
    }
    this.hudTimer -= dt;
    if (this.hudTimer <= 0) {
      this.hudTimer = 0.1;
      this.updateHud();
    }
    this.panelTimer -= dt;
    if (this.panelTimer <= 0) {
      this.panelTimer = 0.5;
      this.updatePanels();
    }
    this.sound.update(sim, this.rig.mode, time);
  }

  private handleSimEvents(): void {
    const sim = this.sim!;
    for (const m of sim.messages) this.toast(m.text, m.kind);
    sim.messages.length = 0;
    const q = sim.warnings.queue;
    if (q.length) {
      this.sound.handle(q);
      q.length = 0;
    }
    if (sim.landingReports.length > this.shownReports) {
      this.shownReports = sim.landingReports.length;
      this.sound.tone('touchdown');
      this.pendingReport = sim.landingReports[sim.landingReports.length - 1];
    }
    if (this.pendingReport && sim.ac.gs < 15 * KT && sim.ac.wow) {
      this.showReport(this.pendingReport);
      this.pendingReport = null;
    }
    if (sim.ac.crashed && !this.crashShown) {
      this.crashShown = true;
      const reason = sim.ac.crashed;
      setTimeout(() => this.showCrash(reason), 1200);
    }
  }

  // --------------------------------------------------------------------------- actions

  private setThrottle(v: number): void {
    const sim = this.sim;
    if (!sim) return;
    const ap = sim.ap;
    if (ap.atArm && (ap.at === 'MCP SPD' || ap.at === 'N1' || ap.at === 'RETARD' || ap.at === 'FMC SPD')) {
      ap.toggleAT();
      this.toast('Autothrottle disconnected (manual thrust)', 'warn');
    }
    const t = clamp(v, 0, 1);
    sim.ac.controls.throttle = [t, t];
  }

  action(name: Action | string, arg?: number | boolean): void {
    const sim = this.sim;
    if (name === 'help') {
      $('help').classList.remove('hidden');
      return;
    }
    if (name === 'closeHelp') {
      $('help').classList.add('hidden');
      return;
    }
    if (name === 'fullscreen') {
      const p = document.fullscreenElement ? document.exitFullscreen?.() : document.documentElement.requestFullscreen?.();
      p?.catch(() => this.toast('Fullscreen is not available here', 'warn'));
      return;
    }
    if (!sim || !this.rig) return;
    const ac = sim.ac;
    const c = ac.controls;
    const ap = sim.ap;
    const n = typeof arg === 'number' ? arg : 0;
    this.sound.tone('click');
    switch (name) {
      case 'throttle': this.setThrottle(c.throttle[0] + n); break;
      case 'trim': c.trim = clamp(c.trim + n * 0.03, -1, 1); break;
      case 'trimUp': c.trim = clamp(c.trim + 0.05, -1, 1); break;
      case 'trimDn': c.trim = clamp(c.trim - 0.05, -1, 1); break;
      case 'flaps':
        c.flapLever = clamp(c.flapLever + n, 0, 8);
        this.toast(`Flaps ${FLAP_NAMES[c.flapLever]}`);
        break;
      case 'setFlaps': c.flapLever = n; break;
      case 'gear':
        if (ac.wow && c.gearDown) {
          this.toast('Gear lever locked (weight on wheels)', 'warn');
          break;
        }
        c.gearDown = !c.gearDown;
        this.toast(`Gear ${c.gearDown ? 'down' : 'up'}`);
        break;
      case 'speedbrake':
        c.speedbrakeArmed = false;
        c.speedbrake = c.speedbrake < 0.25 ? 0.5 : c.speedbrake < 0.75 ? 1 : 0;
        this.toast(`Speedbrake ${c.speedbrake === 0 ? 'down' : c.speedbrake === 0.5 ? 'flight detent' : 'up'}`);
        break;
      case 'armSpeedbrake':
        c.speedbrakeArmed = !c.speedbrakeArmed;
        if (c.speedbrakeArmed) c.speedbrake = 0;
        this.toast(c.speedbrakeArmed ? 'Speedbrake armed' : 'Speedbrake disarmed');
        break;
      case 'reverse':
        if (!ac.wow) {
          this.toast('Reversers only available on the ground', 'warn');
          break;
        }
        c.reverse = !c.reverse;
        if (ap.atArm && c.reverse) {
          ap.atArm = false;
          ap.at = null;
        }
        c.throttle = [0, 0];
        this.toast(c.reverse ? 'Reverse thrust: advance the throttle' : 'Reversers stowed');
        break;
      case 'parkingBrake':
        c.parkingBrake = !c.parkingBrake;
        this.toast(`Parking brake ${c.parkingBrake ? 'set' : 'released'}`);
        break;
      case 'brake': this.brakeButton = !this.brakeButton; break;
      case 'autobrake': {
        const i = AUTOBRAKE.indexOf(c.autobrake);
        c.autobrake = AUTOBRAKE[(i + 1) % AUTOBRAKE.length];
        ac.autobrakeActive = false;
        ac.autobrakeDisarmed = false;
        this.toast(`Autobrake ${c.autobrake}`);
        break;
      }
      case 'ap':
        if (ac.wow) {
          this.toast('Autopilot cannot be engaged on the ground', 'warn');
          break;
        }
        ap.engage(!ap.cmd);
        break;
      case 'at': ap.toggleAT(); break;
      case 'fd': ap.fd = !ap.fd; break;
      case 'hdgSel': ap.hdgSel(); break;
      case 'lnav': ap.lnav(); break;
      case 'vnav': ap.vnav(); break;
      case 'vorLoc':
        ap.vorLoc();
        this.toast(ap.latArmed === 'VOR/LOC' || ap.lat === 'VOR/LOC' ? `VOR/LOC armed on NAV 1 ${sim.radios.nav1.active.toFixed(2)} CRS ${String(Math.round(sim.radios.nav1.course)).padStart(3, '0')}` : 'VOR/LOC disarmed');
        break;
      case 'app':
        ap.app();
        this.toast(ap.vertArmed === 'G/S' || ap.vert === 'G/S' ? `APP armed: ${sim.radios.nav1.ident || sim.radios.nav1.active.toFixed(2)}` : 'APP disarmed (tune an ILS on NAV 1)');
        break;
      case 'lvlChg': ap.lvlChg(); break;
      case 'vs': ap.setVS(); break;
      case 'altHold': ap.altHold(); break;
      case 'toga':
        if (ac.wow && c.parkingBrake) this.toast('Release the parking brake (Shift+B)', 'warn');
        if (!ap.atArm) ap.atArm = true;
        ap.toga();
        if (!ac.wow) c.throttle = [Math.max(c.throttle[0], 0.9), Math.max(c.throttle[1], 0.9)];
        break;
      case 'co':
        if (ap.mcp.useMach) ap.mcp.spd = Math.round(ac.ias / KT);
        else ap.mcp.mach = Math.round(ac.mach * 100) / 100;
        ap.mcp.useMach = !ap.mcp.useMach;
        break;
      case 'mcpHdg': ap.mcp.hdg = wrap360(ap.mcp.hdg + n); break;
      case 'mcpAlt': ap.mcp.alt = clamp(ap.mcp.alt + n, 0, 41000); break;
      case 'mcpSpd':
        if (ap.mcp.useMach) ap.mcp.mach = clamp(Math.round((ap.mcp.mach + n * 0.002) * 100) / 100, 0.4, 0.82);
        else ap.mcp.spd = clamp(ap.mcp.spd + n, 100, 340);
        break;
      case 'mcpVs': ap.mcp.vs = clamp(ap.mcp.vs + n, -6000, 6000); break;
      case 'mcpCrs': sim.radios.nav1.course = wrap360(sim.radios.nav1.course + n); break;
      case 'baro':
        sim.setBaro(false);
        this.toast(`Altimeter ${hPaToInHg(ac.baroSetting / 100).toFixed(2)} (local QNH)`);
        break;
      case 'baroStd':
        sim.setBaro(true);
        this.toast('Altimeter STD 29.92');
        break;
      case 'camera':
        this.rig.cycle(n || 1);
        break;
      case 'mouseYoke':
        $('yoke-mark').classList.toggle('hidden', !arg);
        this.toast(arg ? 'Mouse yoke ON: hold the left button and move to fly' : 'Mouse yoke off');
        break;
      case 'instruments':
        if (!this.showInstruments) {
          this.showInstruments = true;
          this.instrSize = 'normal';
        } else if (this.instrSize === 'normal') this.instrSize = 'big';
        else this.showInstruments = false;
        this.applyInstrumentVisibility();
        break;
      case 'map':
        this.instrSize = this.instrSize === 'map' ? 'normal' : 'map';
        this.showInstruments = true;
        if (this.instrSize === 'map') {
          this.nd.rangeIdx = Math.max(this.nd.rangeIdx, 3);
          this.nd.mode = 'MAP';
        }
        this.applyInstrumentVisibility();
        break;
      case 'ndIn': this.nd.zoom(-1); break;
      case 'ndOut': this.nd.zoom(1); break;
      case 'ndRange': this.nd.zoom(n); break;
      case 'ndMode': this.nd.cycleMode(); this.toast(`ND ${this.nd.mode}`); break;
      case 'wxr': this.nd.show.wxr = !this.nd.show.wxr; this.toast(`Weather radar ${this.nd.show.wxr ? 'on' : 'off'}`); break;
      case 'ndSta': this.nd.show.sta = !this.nd.show.sta; break;
      case 'ndWpt': this.nd.show.wpt = !this.nd.show.wpt; break;
      case 'mcp': $('mcp').classList.toggle('hidden'); break;
      case 'radios': case 'fmc': case 'wx': this.togglePanel(name); break;
      case 'lights':
        this.lights.landing = !this.lights.landing;
        this.toast(`Landing lights ${this.lights.landing ? 'on' : 'off'}`);
        break;
      case 'simRate': {
        const rates = [0.5, 1, 2, 4];
        const i = rates.indexOf(sim.timeScale);
        sim.timeScale = rates[clamp(i + n, 0, rates.length - 1)];
        this.toast(`Simulation rate ${sim.timeScale}x`);
        break;
      }
      case 'pause':
      case 'menu':
        sim.paused = !sim.paused;
        $('pause-menu').classList.toggle('hidden', !sim.paused);
        $<HTMLInputElement>('p-autotrim').checked = sim.assists.autoTrim;
        break;
      case 'resume':
        sim.paused = false;
        $('pause-menu').classList.add('hidden');
        break;
      case 'restart': this.startFlight(this.options); break;
      case 'mainmenu':
        sim.paused = true;
        for (const id of ['pause-menu', 'report', 'hud']) $(id).classList.add('hidden');
        $('menu').classList.remove('hidden');
        this.sim = null;
        this.disposeFlight();
        this.refreshMenu();
        break;
      case 'closeReport':
        $('report').classList.add('hidden');
        if (!ac.crashed) sim.paused = false;
        break;
      case 'fail1': ac.engines[0].failed = true; this.toast('Engine 1 failure', 'warn'); break;
      case 'fail2': ac.engines[1].failed = true; this.toast('Engine 2 failure', 'warn'); break;
      case 'fixall': for (const e of ac.engines) e.failed = false; this.toast('Failures cleared'); break;
      case 'spawnStorm': {
        const h = ac.track * (Math.PI / 180);
        const d = 30 * NM;
        sim.weather.addCell(ac.pos[0] + Math.sin(h) * d, ac.pos[2] - Math.cos(h) * d, { age: 900, peak: 60 });
        this.wxView?.invalidate();
        this.toast('A thunderstorm is building 30 nm ahead. Check the weather radar.', 'warn');
        break;
      }
      default:
    }
  }

  private togglePanel(id: 'radios' | 'fmc' | 'wx'): void {
    for (const p of ['radios', 'fmc', 'wx'] as const) {
      const el = $(p);
      el.classList.toggle('hidden', p !== id || !el.classList.contains('hidden'));
    }
    this.nearTimer = 0;
    this.legsKey = '';
    this.updatePanels();
  }

  private applyInstrumentVisibility(): void {
    const el = $('instruments');
    el.classList.toggle('hidden', !this.showInstruments);
    el.classList.toggle('big', this.instrSize === 'big');
    el.classList.toggle('map-only', this.instrSize === 'map');
  }

  // --------------------------------------------------------------------------- HUD & panels

  private bindHud(): void {
    document.querySelectorAll<HTMLElement>('[data-act]').forEach((b) => {
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        this.action(b.dataset.act!);
      });
    });
    const knob = (k: string, d: number) => {
      if (k === 'spd') this.action('mcpSpd', d);
      if (k === 'hdg') this.action('mcpHdg', d);
      if (k === 'alt') this.action('mcpAlt', d * 100);
      if (k === 'vs') this.action('mcpVs', d * 100);
      if (k === 'crs') this.action('mcpCrs', d);
      this.updateHud();
    };
    const repeat = (b: HTMLElement, step: (big: boolean) => void) => {
      let timer: number | undefined;
      b.addEventListener('pointerdown', (e) => {
        step(e.shiftKey);
        let n = 0;
        timer = window.setInterval(() => step(++n > 8), 140);
      });
      const stop = () => window.clearInterval(timer);
      b.addEventListener('pointerup', stop);
      b.addEventListener('pointerleave', stop);
      b.addEventListener('pointercancel', stop);
    };
    document.querySelectorAll<HTMLElement>('[data-knob]').forEach((b) => {
      repeat(b, (big) => knob(b.dataset.knob!, parseInt(b.dataset.d!, 10) * (big ? 10 : 1)));
    });
    document.querySelectorAll<HTMLElement>('.knob output').forEach((o) => {
      o.addEventListener('wheel', (e) => {
        e.preventDefault();
        const btn = o.parentElement!.querySelector<HTMLElement>('[data-d="1"]');
        if (!btn) return;
        const d = e.deltaY < 0 ? 1 : -1;
        knob(btn.dataset.knob!, d * (e.shiftKey ? 10 : 1));
      }, { passive: false });
    });
    this.bindSlider($('throttle'), (v) => this.setThrottle(v));
    this.bindSlider($('spoiler'), (v) => {
      if (!this.sim) return;
      const c = this.sim.ac.controls;
      c.speedbrake = Math.round((1 - v) * 20) / 20;
      c.speedbrakeArmed = false;
    });
    $<HTMLInputElement>('p-sound').onchange = (e) => this.sound.setMuted(!(e.target as HTMLInputElement).checked);
    $<HTMLInputElement>('p-autotrim').onchange = (e) => {
      if (this.sim) this.sim.assists.autoTrim = (e.target as HTMLInputElement).checked;
    };
    // The MCP panel covers part of the view; show it by default only on wide screens.
    $('mcp').classList.toggle('hidden', window.innerWidth < 1500);
    // Radios.
    for (const k of ['nav1', 'nav2'] as const) {
      const sby = $<HTMLInputElement>(`r-${k}-sby`);
      sby.addEventListener('change', () => {
        const f = parseFloat(sby.value);
        if (this.sim && f >= 108 && f <= 117.95) this.sim.radios[k].standby = Math.round(f * 20) / 20;
        this.updatePanels();
      });
    }
    document.querySelectorAll<HTMLElement>('[data-swap]').forEach((b) => b.addEventListener('click', () => {
      if (!this.sim) return;
      this.sim.radios[b.dataset.swap as 'nav1' | 'nav2'].swap();
      this.sim.radios.autotune = false;
      this.updatePanels();
    }));
    document.querySelectorAll<HTMLElement>('[data-crs]').forEach((b) => repeat(b, (big) => {
      if (!this.sim) return;
      const r = this.sim.radios[b.dataset.crs as 'nav1' | 'nav2'];
      r.course = wrap360(r.course + parseInt(b.dataset.d!, 10) * (big ? 10 : 1));
      this.updatePanels();
    }));
    document.querySelectorAll<HTMLInputElement>('[data-ident]').forEach((cb) => cb.addEventListener('change', () => {
      this.sound.identOn[cb.dataset.ident as 'nav1' | 'nav2' | 'adf'] = cb.checked;
    }));
    const adf = $<HTMLInputElement>('r-adf');
    adf.addEventListener('change', () => {
      const f = parseFloat(adf.value);
      if (this.sim && f >= 190 && f <= 1750) this.sim.radios.adf.freq = Math.round(f);
    });
    $<HTMLInputElement>('r-autotune').addEventListener('change', (e) => {
      if (!this.sim) return;
      this.sim.radios.autotune = (e.target as HTMLInputElement).checked;
      if (this.sim.radios.autotune) this.sim.autotune(true);
    });
    $('r-near').addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>('button[data-freq]');
      if (!b || !this.sim) return;
      const f = parseFloat(b.dataset.freq!);
      if (b.dataset.unit === 'kHz') {
        this.sim.radios.adf.freq = f;
        this.toast(`ADF tuned ${f} kHz (${b.dataset.id})`);
      } else {
        this.sim.radios.nav1.standby = f;
        this.toast(`NAV 1 standby ${f.toFixed(2)} (${b.dataset.id}). Press ⇄ to make it active.`);
      }
      this.updatePanels();
    });
    $('f-legs').addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>('button[data-leg]');
      if (!b || !this.sim?.plan) return;
      const i = parseInt(b.dataset.leg!, 10);
      this.sim.plan.directTo(i);
      if (!this.sim.ac.wow) this.sim.ap.lnav();
      this.toast(`DIRECT TO ${this.sim.plan.legs[i].ident}`);
      this.legsKey = '';
      this.updatePanels();
    });
    $<HTMLSelectElement>('w-rate').addEventListener('change', (e) => {
      if (this.sim) this.sim.weather.opts.evolution = parseFloat((e.target as HTMLSelectElement).value);
    });
  }

  private bindSlider(el: HTMLElement, onValue: (v: number) => void): void {
    let dragging = false;
    const set = (e: PointerEvent) => {
      const r = el.getBoundingClientRect();
      onValue(clamp(1 - (e.clientY - r.top) / r.height, 0, 1));
    };
    el.addEventListener('pointerdown', (e) => {
      el.setPointerCapture(e.pointerId);
      dragging = true;
      set(e);
    });
    el.addEventListener('pointermove', (e) => dragging && set(e));
    el.addEventListener('pointerup', () => (dragging = false));
    el.addEventListener('pointercancel', () => (dragging = false));
  }

  private flapButtons(): void {
    const box = $('flap-detents');
    box.innerHTML = '';
    FLAP_NAMES.forEach((n, i) => {
      const b = document.createElement('button');
      b.textContent = n;
      b.onclick = () => this.action('setFlaps', i);
      box.appendChild(b);
    });
  }

  private updateHud(): void {
    const sim = this.sim;
    if (!sim || !this.rig) return;
    const ac = sim.ac;
    const c = ac.controls;
    const ap = sim.ap;
    const info = sim.routeInfo();
    $('t-gs').textContent = String(Math.round(ac.gs / KT));
    $('t-ias').textContent = String(Math.round(ac.ias / KT));
    $('t-alt').textContent = Math.round(ac.altInd / FT).toLocaleString('en-US');
    $('t-vs').textContent = String(Math.round(ac.vs / FPM / 10) * 10);
    $('t-hdg').textContent = String(Math.round(ap.magHeading) % 360 || 360).padStart(3, '0');
    $('t-dest-l').textContent = sim.arrAirport.ident;
    $('t-dist').textContent = `${Math.round(info.remainingNm)} nm`;
    const ete = info.ete;
    $('t-ete').textContent = `${Math.floor(ete / 3600)}:${String(Math.floor((ete % 3600) / 60)).padStart(2, '0')}`;
    $('t-fuel').textContent = `${(ac.fuel / 1000).toFixed(1)}t`;
    $('t-rate').textContent = `${sim.timeScale}x`;
    $('cam-label').textContent = this.rig.label + (this.input.mouseYoke ? ' · mouse yoke' : '');
    const thr = c.throttle[0];
    const th = $('throttle');
    th.querySelector<HTMLElement>('.fill')!.style.height = `${thr * 100}%`;
    th.querySelector<HTMLElement>('.handle')!.style.top = `${(1 - thr) * 100}%`;
    $('thr-val').textContent = `${c.reverse ? 'REV ' : ''}${Math.round(ac.engines[0].n1)}%`;
    $('b-rev').classList.toggle('on', c.reverse);
    const sp = $('spoiler');
    sp.querySelector<HTMLElement>('.fill')!.style.height = `${c.speedbrake * 100}%`;
    sp.querySelector<HTMLElement>('.handle')!.style.top = `${c.speedbrake * 100}%`;
    $('b-arm').classList.toggle('on', c.speedbrakeArmed);
    $('trim-val').textContent = (4.5 + c.trim * 7).toFixed(1);
    [...$('flap-detents').children].forEach((b, i) => {
      b.classList.toggle('sel', i === c.flapLever);
      b.classList.toggle('moving', i === c.flapLever && Math.abs(ac.flapPos - c.flapLever) > 0.05);
    });
    const gb = $('b-gear');
    gb.classList.toggle('on', ac.gearPos > 0.99);
    gb.classList.toggle('warn', ac.gearPos > 0.01 && ac.gearPos < 0.99);
    $('b-ab').querySelector('em')!.textContent = c.autobrake;
    $('b-ab').classList.toggle('on', c.autobrake !== 'OFF');
    $('b-park').classList.toggle('warn', c.parkingBrake);
    $('b-brake').classList.toggle('on', this.brakeButton || c.brakeL > 0.1);
    $('b-lights').classList.toggle('on', this.lights.landing);
    $('b-ap').classList.toggle('on', ap.cmd);
    $('b-inst').classList.toggle('on', this.showInstruments);
    for (const p of ['radios', 'fmc', 'wx']) $(`b-${p}`).classList.toggle('on', !$(p).classList.contains('hidden'));
    $('m-spd-l').textContent = ap.mcp.useMach ? 'MACH' : 'IAS';
    $('m-spd').textContent = ap.mcp.useMach ? ap.mcp.mach.toFixed(2) : String(Math.round(ap.mcp.spd));
    $('m-hdg').textContent = String(Math.round(ap.mcp.hdg) % 360).padStart(3, '0');
    $('m-alt').textContent = String(ap.mcp.alt);
    $('m-crs').textContent = String(Math.round(sim.radios.nav1.course) % 360).padStart(3, '0');
    $('m-vs').textContent = ap.vert === 'V/S' ? (ap.mcp.vs > 0 ? '+' : '') + ap.mcp.vs : '';
    $('m-baro').textContent = ac.baroStd ? 'QNH' : hPaToInHg(ac.baroSetting / 100).toFixed(2);
    $('m-std').classList.toggle('on', ac.baroStd);
    const lamp = (id: string, on: boolean, armed = false) => {
      const el = $(id);
      el.classList.toggle('on', on);
      el.classList.toggle('armed', !on && armed);
    };
    lamp('m-at', ap.atArm);
    lamp('m-vnav', !!ap.vert?.startsWith('VNAV'), ap.vertArmed === 'VNAV');
    lamp('m-lvlchg', ap.vert === 'MCP SPD');
    lamp('m-hdgsel', ap.lat === 'HDG SEL');
    lamp('m-lnav', ap.lat === 'LNAV', ap.latArmed === 'LNAV');
    lamp('m-loc', ap.lat === 'VOR/LOC', ap.latArmed === 'VOR/LOC');
    lamp('m-app', ap.vert === 'G/S' || ap.vert === 'FLARE', ap.vertArmed === 'G/S');
    lamp('m-alth', ap.vert === 'ALT HOLD');
    lamp('m-vsb', ap.vert === 'V/S');
    lamp('m-cmd', ap.cmd);
    lamp('m-fd', ap.fd);
  }

  private updatePanels(): void {
    const sim = this.sim;
    if (!sim) return;
    const ac = sim.ac;
    const r = sim.radios;
    if (!$('radios').classList.contains('hidden')) {
      for (const k of ['nav1', 'nav2'] as const) {
        const radio = r[k];
        $(`r-${k}-act`).textContent = radio.active.toFixed(2);
        const sby = $<HTMLInputElement>(`r-${k}-sby`);
        if (document.activeElement !== sby) sby.value = radio.standby.toFixed(2);
        $(`r-${k}-crs`).textContent = String(Math.round(radio.course) % 360).padStart(3, '0');
        $(`r-${k}-rx`).textContent = radio.receiving ? `${radio.ident}${radio.dmeNm !== null ? ` ${radio.dmeNm.toFixed(1)} NM` : ''}` : 'no signal';
      }
      const adf = $<HTMLInputElement>('r-adf');
      if (document.activeElement !== adf) adf.value = r.adf.freq ? String(r.adf.freq) : '';
      $('r-adf-rx').textContent = r.adf.station ? r.adf.ident : r.adf.freq ? 'no signal' : '';
      $<HTMLInputElement>('r-autotune').checked = r.autotune;
      this.nearTimer -= 0.5;
      if (this.nearTimer <= 0) {
        this.nearTimer = 5;
        const near = sim.world.nav.navaids
          .filter((n) => n.isVor || n.isNdb)
          .map((n) => ({ n, d: Math.hypot(n.x - ac.pos[0], n.z - ac.pos[2]) / NM }))
          .sort((a, b) => a.d - b.d)
          .slice(0, 10);
        $('r-near').innerHTML = near.map(({ n, d }) => {
          const brg = wrap360(Math.atan2(n.x - ac.pos[0], -(n.z - ac.pos[2])) * RAD - sim.ap.magVar);
          const f = n.raw.unit === 'MHz' ? n.raw.freq.toFixed(2) : String(n.raw.freq);
          return `<button data-freq="${n.raw.freq}" data-unit="${n.raw.unit}" data-id="${n.id}"><b>${n.id}</b><span>${titleCase(n.raw.name)} ${n.raw.type}</span><span>${f} · ${String(Math.round(brg)).padStart(3, '0')}° ${d.toFixed(0)} NM</span></button>`;
        }).join('');
      }
    }
    if (!$('fmc').classList.contains('hidden')) {
      const plan = sim.plan;
      const o = sim.options;
      $('f-summary').innerHTML = plan
        ? `<b>${sim.depAirport.ident} ${sim.depEnd.id}</b> ${o.sid ?? ''} ${o.route} ${o.star ?? ''}${o.starTransition ? `.${o.starTransition}` : ''} ${o.approach ?? ''} <b>${sim.arrAirport.ident} ${sim.arrEnd.id}</b><br>` +
          `CRZ ${o.cruiseAlt >= 18000 ? `FL${o.cruiseAlt / 100}` : `${o.cruiseAlt} ft`} · ${Math.round(sim.routeInfo().remainingNm)} NM to go`
        : 'No route';
      const key = plan ? `${plan.active}:${plan.legs.length}:${Math.round(ac.pos[0] / 2000)}:${Math.round(ac.pos[2] / 2000)}` : '';
      if (plan && key !== this.legsKey) {
        this.legsKey = key;
        let html = '';
        let lastSrc = '';
        let px = ac.pos[0];
        let pz = ac.pos[2];
        plan.legs.forEach((l, i) => {
          if (l.source !== lastSrc || (i > 0 && l.via !== plan.legs[i - 1].via)) {
            html += `<div class="src">${l.source}${l.via ? ` · ${l.via}` : ''}</div>`;
            lastSrc = l.source;
          }
          let dist = '';
          if (i >= plan.active && l.type === 'fix') {
            dist = `${(Math.hypot(l.x - px, l.z - pz) / NM).toFixed(0)} NM`;
            px = l.x;
            pz = l.z;
          }
          const a = l.alt;
          const alt = a ? (a.kind === 'between' ? `${a.lo}A ${a.hi}B` : `${a.lo}${a.kind === 'above' ? 'A' : a.kind === 'below' ? 'B' : ''}`) : l.untilAltM ? `${Math.round(l.untilAltM / FT)}` : '';
          const cls = i === plan.active ? 'active' : i < plan.active ? 'done' : '';
          html += `<button data-leg="${i}" class="${cls}"><b>${l.ident}</b><span>${l.speedKt ? `${l.speedKt}/` : ''}${alt}</span><span>${l.type === 'course' ? `${String(Math.round(wrap360(l.course! - sim.ap.magVar))).padStart(3, '0')}°` : ''}</span><span>${dist}</span></button>`;
        });
        $('f-legs').innerHTML = html;
      }
    }
    if (!$('wx').classList.contains('hidden')) {
      const W = sim.weather;
      $('w-src').textContent = sim.options.weather === 'live' ? `${W.seed.source}, valid ${W.seed.validTime}; evolving since.` : PRESETS.find((p) => p.id === sim.options.weather)?.name ?? '';
      const near = sim.world.nav.airports
        .filter((a) => a.longest > 1500)
        .reduce<Airport | null>((b, a) => (!b || Math.hypot(a.x - ac.pos[0], a.z - ac.pos[2]) < Math.hypot(b.x - ac.pos[0], b.z - ac.pos[2]) ? a : b), null);
      const aps = [sim.depAirport, sim.arrAirport, near].filter((a, i, arr): a is Airport => !!a && arr.indexOf(a) === i);
      $('w-metar').textContent = aps.map((a) => sim.metar(a)).join('\n');
      const atisAp = ac.wow && Math.hypot(sim.depAirport.x - ac.pos[0], sim.depAirport.z - ac.pos[2]) < 8000 ? sim.depAirport : sim.arrAirport;
      $('w-atis').textContent = sim.atis(atisAp);
      const cells = W.cells
        .filter((c) => c.strength > 0.15)
        .map((c) => ({ c, d: Math.hypot(c.x - ac.pos[0], c.z - ac.pos[2]) / NM }))
        .sort((a, b) => a.d - b.d);
      $('w-cells').textContent = cells.length
        ? `${cells.length} active cell${cells.length > 1 ? 's' : ''}.\n` + cells.slice(0, 4).map(({ c, d }) => {
          const brg = wrap360(Math.atan2(c.x - ac.pos[0], -(c.z - ac.pos[2])) * RAD - sim.ap.magVar);
          return `${String(Math.round(brg)).padStart(3, '0')}° ${d.toFixed(0)} NM  ${Math.round(c.peak * c.strength)} dBZ  tops FL${Math.round(c.top / FT / 100)}  ${c.stage}`;
        }).join('\n')
        : 'No thunderstorms nearby.';
    }
  }

  toast(text: string, kind: 'info' | 'warn' | 'crash' | 'landing' = 'info'): void {
    const box = $('messages');
    const el = document.createElement('div');
    el.className = `msg ${kind}`;
    el.textContent = text;
    box.appendChild(el);
    while (box.children.length > 4) box.removeChild(box.firstChild!);
    setTimeout(() => el.remove(), kind === 'crash' ? 8000 : 4500);
  }

  private showReport(r: LandingReport): void {
    const sim = this.sim!;
    const bad = r.grade.startsWith('Very') || r.grade === 'Hard';
    $('r-title').textContent = 'Landing report';
    const rows: [string, string][] = [
      ['Vertical speed', `${r.vs} fpm`],
      ['Touchdown G', `${r.g} g`],
      ['Airspeed', `${r.ias} kt (Vref ${sim.vspeeds.vref30})`],
      ['Pitch / roll', `${r.pitch}° / ${r.roll}°`],
      ['Crab angle', `${r.crab}°`],
      ['Runway', r.runway],
      ['Past threshold', r.fromThreshold !== null ? `${r.fromThreshold} ft` : '—'],
      ['Centerline offset', r.centerline !== null ? `${r.centerline} ft` : '—'],
      ['Windshear', r.windshear ? 'encountered' : 'none'],
      ['Fuel remaining', `${Math.round(sim.ac.fuel)} kg`],
    ];
    $('r-body').innerHTML = `<div class="grade ${bad ? 'bad' : ''}">${r.grade}</div><table>${rows.map(([a, b]) => `<tr><td>${a}</td><td>${b}</td></tr>`).join('')}</table>`;
    $('report').classList.remove('hidden');
  }

  private showCrash(reason: string): void {
    $('r-title').textContent = 'Crash';
    $('r-body').innerHTML = '';
    const g = document.createElement('div');
    g.className = 'grade bad';
    g.textContent = reason;
    const p = document.createElement('p');
    p.className = 'hint';
    p.textContent = 'The flight has ended. Restart to try again.';
    $('r-body').append(g, p);
    $('report').classList.remove('hidden');
  }
}

(window as unknown as { app: App }).app = new App();
