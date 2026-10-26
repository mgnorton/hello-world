// Application entry: menu, flight lifecycle, input actions, HUD and render loop.
import * as THREE from './vendor/three.module.min.js';
import { Simulation, DEFAULT_OPTIONS } from './sim.js';
import { AIRPORT_LIST, routeDistanceNm } from './navigation.js';
import { B739, vSpeeds, FLAP_NAMES, AUTOBRAKE } from './aircraftData.js';
import { clamp, wrap360, KT, FT, FPM } from './math.js';
import { World } from './render/world.js';
import { AircraftModel } from './render/aircraftModel.js';
import { AirportManager } from './render/airportMesh.js';
import { CameraRig } from './render/cameras.js';
import { PFD, ND, EICAS } from './ui/instruments.js';
import { InputManager, KEY_HELP } from './ui/controls.js';
import { SoundSystem } from './audio.js';

const $ = (id) => document.getElementById(id);
const STORE_KEY = 'skyline737.options';

function loadOptions() {
  try {
    const s = JSON.parse(localStorage.getItem(STORE_KEY) || '{}');
    return { ...DEFAULT_OPTIONS, ...s };
  } catch {
    return { ...DEFAULT_OPTIONS };
  }
}
function saveOptions(o) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(o));
  } catch { /* storage unavailable */ }
}

class App {
  constructor() {
    this.canvas = $('scene');
    this.renderer = null;
    this.sim = null;
    this.sound = new SoundSystem();
    this.options = loadOptions();
    this.lights = { landing: true, nav: true, strobe: true, beacon: true };
    this.compact = window.innerWidth < 700 || window.innerHeight < 560;
    this.showInstruments = !this.compact;
    this.instrSize = 'normal';
    this.hudTimer = 0;
    this.instTimer = 0;
    this.lastTime = performance.now();
    this.messageEls = [];
    this.input = new InputManager(this.canvas, (a, v) => this.action(a, v));
    this.input.onLook = (dx, dy) => this.rig && this.rig.drag(dx, dy);
    this.input.onWheel = (d) => this.rig && this.rig.wheel(d);
    if (matchMedia('(pointer: coarse)').matches) document.body.classList.add('touch');
    this.input.bindTouchStick($('touch-stick'), document.querySelector('#touch-stick .knob-dot'));
    this.pfd = new PFD($('pfd'));
    this.nd = new ND($('nd'));
    this.eicas = new EICAS($('eicas'));
    this.buildMenu();
    this.bindHud();
    window.addEventListener('resize', () => this.resize());
    requestAnimationFrame((t) => this.loop(t));
  }

  // --- Menu ------------------------------------------------------------------
  buildMenu() {
    const o = this.options;
    const fillAirports = (sel, value) => {
      sel.innerHTML = AIRPORT_LIST.map((a) => `<option value="${a.icao}">${a.icao} — ${a.name}</option>`).join('');
      sel.value = value;
    };
    const fillRunways = (sel, icao, value) => {
      const a = AIRPORT_LIST.find((x) => x.icao === icao);
      sel.innerHTML = a.runways.map((r) => `<option value="${r}">${r}</option>`).join('');
      sel.value = a.runways.includes(value) ? value : a.runways[0];
    };
    fillAirports($('o-dep'), o.dep);
    fillAirports($('o-arr'), o.arr);
    fillRunways($('o-depRwy'), o.dep, o.depRwy);
    fillRunways($('o-arrRwy'), o.arr, o.arrRwy);
    $('o-dep').onchange = () => { fillRunways($('o-depRwy'), $('o-dep').value); this.refreshMenu(); };
    $('o-arr').onchange = () => { fillRunways($('o-arrRwy'), $('o-arr').value); this.refreshMenu(); };
    const alts = [];
    for (let fl = 100; fl <= 410; fl += 10) alts.push(fl * 100);
    $('o-cruiseAlt').innerHTML = alts.map((a) => `<option value="${a}">FL${a / 100}</option>`).join('');
    $('o-cruiseAlt').value = o.cruiseAlt;
    $('o-start').value = o.start;
    for (const k of ['pax', 'fuel', 'hour', 'windDir', 'windSpeed', 'gust', 'cloudBase', 'visibility']) $(`o-${k}`).value = o[k];
    $('o-turbulence').value = o.turbulence;
    $('o-clouds').value = o.clouds;
    $('o-autoTrim').checked = o.autoTrim;
    $('o-apOnApproach').checked = o.apOnApproach;
    $('menu').querySelectorAll('input,select').forEach((el) => el.addEventListener('input', () => this.refreshMenu()));
    $('fly-btn').onclick = () => this.startFlight(this.readMenu());
    $('help-btn').onclick = () => this.action('help');
    $('help-body').innerHTML = KEY_HELP.map(([k, d]) => `<div><kbd>${k}</kbd></div><div>${d}</div>`).join('');
    this.refreshMenu();
  }

  readMenu() {
    const n = (id) => parseFloat($(id).value);
    return {
      dep: $('o-dep').value, depRwy: $('o-depRwy').value, arr: $('o-arr').value, arrRwy: $('o-arrRwy').value,
      start: $('o-start').value, cruiseAlt: n('o-cruiseAlt'), pax: n('o-pax'), fuel: n('o-fuel'), hour: n('o-hour'),
      windDir: n('o-windDir'), windSpeed: n('o-windSpeed'), gust: n('o-gust'), turbulence: n('o-turbulence'),
      clouds: $('o-clouds').value, cloudBase: n('o-cloudBase'), visibility: n('o-visibility'),
      autoTrim: $('o-autoTrim').checked, apOnApproach: $('o-apOnApproach').checked,
    };
  }

  refreshMenu() {
    const o = this.readMenu();
    const hh = Math.floor(o.hour);
    $('o-hour-v').textContent = `${String(hh).padStart(2, '0')}:${o.hour % 1 ? '30' : '00'}`;
    $('o-pax-v').textContent = o.pax;
    $('o-fuel-v').textContent = o.fuel.toLocaleString('en-US');
    $('o-windDir-v').textContent = `${String(o.windDir).padStart(3, '0')}°`;
    $('o-windSpeed-v').textContent = `${o.windSpeed} kt`;
    $('o-gust-v').textContent = o.gust ? `+${o.gust} kt` : 'none';
    $('o-cloudBase-v').textContent = `${o.cloudBase} ft`;
    $('o-visibility-v').textContent = `${o.visibility} km`;
    const dist = routeDistanceNm(o.dep, o.arr);
    const tripFuel = dist * 11.5 + 1800; // rough: ~11.5 kg/nm + reserves
    $('o-route').innerHTML = `Route <b>${o.dep} → ${o.arr}</b>: ${Math.round(dist)} nm great-circle.<br>Suggested fuel ≈ <b>${Math.round(Math.min(B739.maxFuel, tripFuel + 2500)).toLocaleString('en-US')} kg</b>` +
      (dist > 3000 ? '<br><span style="color:#ffb000">Beyond the 737-900 range (~2,700 nm)!</span>' : '');
    const zfw = B739.oew + o.pax * B739.paxMass;
    const tow = zfw + o.fuel;
    const v = vSpeeds(tow, 3, Math.min(tow, B739.mlw));
    const warn = [];
    if (zfw > B739.mzfw) warn.push('ZFW over limit');
    if (tow > B739.mtow) warn.push('TOW over MTOW');
    $('o-weights').innerHTML = `ZFW <b>${(zfw / 1000).toFixed(1)} t</b> · TOW <b>${(tow / 1000).toFixed(1)} t</b> (MTOW 79.0 t)<br>` +
      `Flaps 5: V1 <b>${v.v1}</b> VR <b>${v.vr}</b> V2 <b>${v.v2}</b> · Vref30 <b>${v.vref30}</b>` +
      (warn.length ? `<br><span style="color:#ffb000">${warn.join(', ')}</span>` : '');
  }

  // --- Flight lifecycle -----------------------------------------------------
  startFlight(opts) {
    this.options = opts;
    saveOptions(opts);
    this.sound.start();
    $('menu').classList.add('hidden');
    $('pause-menu').classList.add('hidden');
    $('report').classList.add('hidden');
    $('loading').classList.remove('hidden');
    // Let the loading overlay paint before the heavy scenery build.
    setTimeout(() => this.buildFlight(opts), 30);
  }

  disposeFlight() {
    if (!this.world) return;
    this.world.scene.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) {
        const ms = Array.isArray(o.material) ? o.material : [o.material];
        for (const m of ms) {
          if (m.map) m.map.dispose();
          m.dispose();
        }
      }
    });
    this.world = null;
  }

  buildFlight(opts) {
    this.disposeFlight();
    const sim = new Simulation(opts);
    this.sim = sim;
    if (!this.renderer) {
      this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true, logarithmicDepthBuffer: true, powerPreference: 'high-performance' });
    }
    this.world = new World(this.renderer, sim);
    this.model = new AircraftModel();
    this.model.setScreens([$('pfd'), $('nd'), $('eicas'), $('nd'), $('pfd')]);
    this.world.scene.add(this.model.root);
    this.airports = new AirportManager(this.world.scene, sim);
    this.rig = new CameraRig(this.world.camera);
    this.rig.set('chase');
    const night = 1 - this.world.dayFactor;
    this.lights = { landing: opts.start !== 'cruise', nav: true, strobe: true, beacon: true };
    this.resize();
    // Prime scenery around the aircraft synchronously.
    const ac = sim.ac;
    const p = new THREE.Vector3(...ac.pos);
    this.model.update(ac, 0, 0, { lights: this.lights, night, cockpit: false });
    this.rig.update(ac, this.model, 0.016, null, (x, z) => sim.terrain.height(x, z));
    this.world.update(this.world.camera.position, p, true);
    this.airports.update(10, p, this.world.camera.position, 0, night);
    $('loading').classList.add('hidden');
    $('hud').classList.remove('hidden');
    this.applyInstrumentVisibility();
    this.lastTime = performance.now();
    this.shownReports = 0;
    this.crashShown = false;
    this.flapButtons();
    this.updateHud(true);
    for (const m of sim.messages) this.toast(m.text, m.kind);
    sim.messages.length = 0;
  }

  resize() {
    if (!this.world) return;
    this.world.resize(window.innerWidth, window.innerHeight);
  }

  // --- Main loop -------------------------------------------------------------
  loop(now) {
    requestAnimationFrame((t) => this.loop(t));
    // rAF timestamps can precede a performance.now() taken later in the same frame.
    const dt = clamp((now - this.lastTime) / 1000, 0, 0.1);
    this.lastTime = Math.max(this.lastTime, now);
    const sim = this.sim;
    if (!sim || !this.world) return;
    const pilot = this.input.poll(dt);
    // Joystick throttle lever, if present.
    if (this.input.gamepadThrottle !== null) {
      const v = this.input.gamepadThrottle;
      if (this.lastPadThrottle === undefined || Math.abs(v - this.lastPadThrottle) > 0.01) {
        this.setThrottle(v);
        this.lastPadThrottle = v;
      }
    }
    // Continuous inputs: trim keys, cockpit look keys handled via held keys.
    if (this.brakeButton) {
      pilot.brakeL = Math.max(pilot.brakeL, 1);
      pilot.brakeR = Math.max(pilot.brakeR, 1);
    }
    sim.update(dt, pilot);
    this.handleSimEvents();

    const ac = sim.ac;
    const time = sim.elapsed;
    const night = 1 - this.world.dayFactor;
    const cockpit = this.rig.mode === 'cockpit';
    this.model.update(ac, sim.paused ? 0 : dt * sim.timeScale, time, { lights: this.lights, night, cockpit });
    const acPos = this.model.root.position;
    const tower = this.airports.towerFor(acPos.x, acPos.z);
    this.rig.update(ac, this.model, dt, tower, (x, z) => sim.terrain.surface(x, z).h);
    // Camera shake from buffet / ground roll in the cockpit.
    if (cockpit && !sim.paused) {
      const shake = (ac.buffet || 0) * 0.02 + (ac.wow ? Math.min(ac.gs / 80, 1) * 0.004 : 0);
      if (shake > 0) {
        this.world.camera.position.x += (Math.random() - 0.5) * shake;
        this.world.camera.position.y += (Math.random() - 0.5) * shake;
      }
    }
    this.world.update(this.world.camera.position, acPos);
    this.airports.update(dt, acPos, this.world.camera.position, time, night);
    this.world.render();

    this.instTimer -= dt;
    if (this.instTimer <= 0 && (this.showInstruments || cockpit)) {
      this.instTimer = 1 / 30;
      this.pfd.draw(sim, 1 / 30);
      this.nd.draw(sim);
      this.eicas.draw(sim);
    }
    this.hudTimer -= dt;
    if (this.hudTimer <= 0) {
      this.hudTimer = 0.1;
      this.updateHud();
    }
    this.sound.update(sim, this.rig.mode);
  }

  handleSimEvents() {
    const sim = this.sim;
    for (const m of sim.messages) this.toast(m.text, m.kind);
    sim.messages.length = 0;
    const q = sim.warnings.queue;
    if (q.length) {
      this.sound.handle(q);
      if (q.includes('apDisconnect')) sim.apDiscFlash = 3;
      q.length = 0;
    }
    if (sim.apDiscFlash > 0) sim.apDiscFlash -= 0.016;
    if (sim.landingReports.length > this.shownReports) {
      this.shownReports = sim.landingReports.length;
      this.sound.tone('touchdown');
      const r = sim.landingReports[sim.landingReports.length - 1];
      // Show the report once the aircraft has slowed down.
      this.pendingReport = r;
    }
    if (this.pendingReport && sim.ac.gs < 15 * KT && sim.ac.wow) {
      this.showReport(this.pendingReport);
      this.pendingReport = null;
    }
    if (sim.ac.crashed && !this.crashShown) {
      this.crashShown = true;
      setTimeout(() => this.showCrash(sim.ac.crashed), 1200);
    }
  }

  // --- Actions ---------------------------------------------------------------
  setThrottle(v) {
    const sim = this.sim;
    if (!sim) return;
    const ap = sim.ap;
    const c = sim.ac.controls;
    if (ap.atArm && ['MCP SPD', 'N1', 'RETARD'].includes(ap.at)) {
      ap.toggleAT();
      this.toast('Autothrottle disconnected (manual thrust)', 'warn');
    }
    const t = clamp(v, 0, 1);
    c.throttle = [t, t];
  }

  action(name, arg) {
    const sim = this.sim;
    // Global actions that work without a flight.
    if (name === 'help') {
      $('help').classList.remove('hidden');
      return;
    }
    if (name === 'closeHelp') {
      $('help').classList.add('hidden');
      return;
    }
    if (name === 'fullscreen') {
      if (!document.fullscreenElement) document.documentElement.requestFullscreen?.();
      else document.exitFullscreen?.();
      return;
    }
    if (!sim) return;
    const ac = sim.ac;
    const c = ac.controls;
    const ap = sim.ap;
    this.sound.tone('click');
    switch (name) {
      case 'throttle': this.setThrottle(c.throttle[0] + arg); break;
      case 'trim': c.trim = clamp(c.trim + arg * 0.03, -1, 1); break;
      case 'trimUp': c.trim = clamp(c.trim + 0.05, -1, 1); break;
      case 'trimDn': c.trim = clamp(c.trim - 0.05, -1, 1); break;
      case 'flaps': c.flapLever = clamp(c.flapLever + arg, 0, 8); this.toast(`Flaps ${FLAP_NAMES[c.flapLever]}`); break;
      case 'setFlaps': c.flapLever = arg; break;
      case 'gear':
        if (ac.wow && c.gearDown) { this.toast('Gear lever locked (weight on wheels)', 'warn'); break; }
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
        if (!ac.wow) { this.toast('Reversers only available on the ground', 'warn'); break; }
        c.reverse = !c.reverse;
        if (ap.atArm && c.reverse) { ap.atArm = false; ap.at = null; }
        c.throttle = [0, 0];
        this.toast(c.reverse ? 'Reverse thrust — advance throttle' : 'Reversers stowed');
        break;
      case 'parkingBrake': c.parkingBrake = !c.parkingBrake; this.toast(`Parking brake ${c.parkingBrake ? 'set' : 'released'}`); break;
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
        if (ac.wow) { this.toast('Autopilot cannot be engaged on the ground', 'warn'); break; }
        ap.engage(!ap.cmd);
        break;
      case 'at': ap.toggleAT(); break;
      case 'fd': ap.fd = !ap.fd; break;
      case 'hdgSel': ap.hdgSel(); break;
      case 'lnav': ap.lnav(); break;
      case 'loc': ap.loc(); break;
      case 'app': ap.app(); this.toast(ap.vertArmed === 'G/S' ? `APP armed — ILS ${ap.approach.id}` : 'APP disarmed'); break;
      case 'lvlChg': ap.lvlChg(); break;
      case 'vs': ap.setVS(); break;
      case 'altHold': ap.altHold(); break;
      case 'toga':
        if (ac.wow && c.parkingBrake) this.toast('Release the parking brake (Shift+B)', 'warn');
        if (!ap.atArm) { ap.atArm = true; }
        ap.toga();
        if (!ac.wow) { c.throttle = [Math.max(c.throttle[0], 0.9), Math.max(c.throttle[1], 0.9)]; }
        break;
      case 'co':
        if (ap.mcp.useMach) ap.mcp.spd = Math.round(ac.ias / KT);
        else ap.mcp.mach = Math.round(ac.mach * 100) / 100;
        ap.mcp.useMach = !ap.mcp.useMach;
        break;
      case 'mcpHdg': ap.mcp.hdg = wrap360(ap.mcp.hdg + arg); break;
      case 'mcpAlt': ap.mcp.alt = clamp(ap.mcp.alt + arg, 0, 41000); break;
      case 'mcpSpd':
        if (ap.mcp.useMach) ap.mcp.mach = clamp(Math.round((ap.mcp.mach + arg * 0.002) * 100) / 100, 0.4, 0.82);
        else ap.mcp.spd = clamp(ap.mcp.spd + arg, 100, 340);
        break;
      case 'mcpVs': ap.mcp.vs = clamp(ap.mcp.vs + arg, -6000, 6000); break;
      case 'camera':
        this.rig.cycle(arg || 1);
        $('cam-label').textContent = this.rig.label;
        break;
      case 'mouseYoke':
        $('yoke-mark').classList.toggle('hidden', !arg);
        this.toast(arg ? 'Mouse yoke ON — hold left button and move to fly' : 'Mouse yoke off');
        break;
      case 'instruments':
        if (!this.showInstruments) { this.showInstruments = true; this.instrSize = 'normal'; }
        else if (this.instrSize === 'normal') this.instrSize = 'big';
        else this.showInstruments = false;
        this.applyInstrumentVisibility();
        break;
      case 'map':
        this.instrSize = this.instrSize === 'map' ? 'normal' : 'map';
        this.showInstruments = true;
        if (this.instrSize === 'map') this.nd.rangeIdx = Math.max(this.nd.rangeIdx, 4);
        this.applyInstrumentVisibility();
        break;
      case 'ndIn': this.nd.zoom(-1); break;
      case 'ndOut': this.nd.zoom(1); break;
      case 'mcp': $('mcp').classList.toggle('hidden'); break;
      case 'lights':
        this.lights.landing = !this.lights.landing;
        this.toast(`Landing lights ${this.lights.landing ? 'on' : 'off'}`);
        break;
      case 'simRate': {
        const rates = [0.5, 1, 2, 4];
        const i = rates.indexOf(sim.timeScale);
        sim.timeScale = rates[clamp(i + arg, 0, rates.length - 1)];
        this.toast(`Simulation rate ${sim.timeScale}x`);
        break;
      }
      case 'pause':
      case 'menu':
        sim.paused = !sim.paused;
        $('pause-menu').classList.toggle('hidden', !sim.paused);
        $('p-autotrim').checked = sim.assists.autoTrim;
        break;
      case 'resume': sim.paused = false; $('pause-menu').classList.add('hidden'); break;
      case 'restart': this.startFlight(this.options); break;
      case 'mainmenu':
        sim.paused = true;
        $('pause-menu').classList.add('hidden');
        $('report').classList.add('hidden');
        $('hud').classList.add('hidden');
        $('menu').classList.remove('hidden');
        this.sim = null;
        this.disposeFlight();
        break;
      case 'closeReport':
        $('report').classList.add('hidden');
        if (!ac.crashed) sim.paused = false;
        break;
      case 'fail1': ac.engines[0].failed = true; this.toast('Engine 1 failure', 'warn'); break;
      case 'fail2': ac.engines[1].failed = true; this.toast('Engine 2 failure', 'warn'); break;
      case 'fixall': for (const e of ac.engines) e.failed = false; this.toast('Failures cleared'); break;
      case 'flapsUp': c.flapLever = clamp(c.flapLever - 1, 0, 8); break;
      case 'flapsDown': c.flapLever = clamp(c.flapLever + 1, 0, 8); break;
      default:
    }
  }

  applyInstrumentVisibility() {
    const el = $('instruments');
    el.classList.toggle('hidden', !this.showInstruments);
    el.classList.toggle('big', this.instrSize === 'big');
    el.classList.toggle('map-only', this.instrSize === 'map');
  }

  // --- HUD -------------------------------------------------------------------
  bindHud() {
    document.querySelectorAll('[data-act]').forEach((b) => {
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        this.action(b.dataset.act);
      });
    });
    // MCP knobs with press-and-hold repeat.
    document.querySelectorAll('[data-knob]').forEach((b) => {
      let timer = null;
      const step = (big) => {
        const d = parseInt(b.dataset.d, 10) * (big ? 10 : 1);
        const k = b.dataset.knob;
        if (k === 'spd') this.action('mcpSpd', d);
        if (k === 'hdg') this.action('mcpHdg', d);
        if (k === 'alt') this.action('mcpAlt', d * 100);
        if (k === 'vs') this.action('mcpVs', d * 100);
        this.updateHud();
      };
      b.addEventListener('pointerdown', (e) => {
        step(e.shiftKey);
        let n = 0;
        timer = setInterval(() => step(++n > 8), 140);
      });
      const stop = () => clearInterval(timer);
      b.addEventListener('pointerup', stop);
      b.addEventListener('pointerleave', stop);
      b.addEventListener('pointercancel', stop);
    });
    document.querySelectorAll('.knob output').forEach((o) => {
      o.addEventListener('wheel', (e) => {
        e.preventDefault();
        const btn = o.parentElement.querySelector('[data-d="1"]');
        const k = btn.dataset.knob;
        const d = e.deltaY < 0 ? 1 : -1;
        if (k === 'spd') this.action('mcpSpd', d);
        if (k === 'hdg') this.action('mcpHdg', d * (e.shiftKey ? 10 : 1));
        if (k === 'alt') this.action('mcpAlt', d * (e.shiftKey ? 1000 : 100));
        if (k === 'vs') this.action('mcpVs', d * 100);
      }, { passive: false });
    });
    this.bindSlider($('throttle'), (v) => this.setThrottle(v));
    this.bindSlider($('spoiler'), (v) => {
      if (!this.sim) return;
      const c = this.sim.ac.controls;
      c.speedbrake = Math.round((1 - v) * 20) / 20;
      c.speedbrakeArmed = false;
    });
    $('p-sound').onchange = (e) => this.sound.setMuted(!e.target.checked);
    $('p-autotrim').onchange = (e) => { if (this.sim) this.sim.assists.autoTrim = e.target.checked; };
    $('mcp').classList.toggle('hidden', this.compact);
  }

  bindSlider(el, onValue) {
    const set = (e) => {
      const r = el.getBoundingClientRect();
      const v = clamp(1 - (e.clientY - r.top) / r.height, 0, 1);
      onValue(v);
    };
    el.addEventListener('pointerdown', (e) => {
      el.setPointerCapture(e.pointerId);
      el.dragging = true;
      set(e);
    });
    el.addEventListener('pointermove', (e) => el.dragging && set(e));
    el.addEventListener('pointerup', () => (el.dragging = false));
    el.addEventListener('pointercancel', () => (el.dragging = false));
  }

  flapButtons() {
    const box = $('flap-detents');
    box.innerHTML = '';
    FLAP_NAMES.forEach((n, i) => {
      const b = document.createElement('button');
      b.textContent = n;
      b.onclick = () => this.action('setFlaps', i);
      box.appendChild(b);
    });
  }

  updateHud() {
    const sim = this.sim;
    if (!sim) return;
    const ac = sim.ac;
    const c = ac.controls;
    const ap = sim.ap;
    const info = sim.routeInfo();
    $('t-gs').textContent = Math.round(ac.gs / KT);
    $('t-ias').textContent = Math.round(ac.ias / KT);
    $('t-alt').textContent = Math.round(ac.pos[1] / FT).toLocaleString('en-US');
    $('t-vs').textContent = Math.round(ac.vs / FPM / 10) * 10;
    $('t-hdg').textContent = String(Math.round(ap.magHeading) % 360).padStart(3, '0');
    $('t-dest-l').textContent = sim.arrAirport.icao;
    $('t-dist').textContent = `${Math.round(info.remainingNm)} nm`;
    const ete = info.ete;
    $('t-ete').textContent = `${Math.floor(ete / 3600)}:${String(Math.floor((ete % 3600) / 60)).padStart(2, '0')}`;
    $('t-fuel').textContent = `${(ac.fuel / 1000).toFixed(1)}t`;
    $('t-rate').textContent = `${sim.timeScale}x`;
    $('cam-label').textContent = this.rig.label + (this.input.mouseYoke ? ' · mouse yoke' : '');
    // Levers.
    const thr = c.throttle[0];
    const th = $('throttle');
    th.querySelector('.fill').style.height = `${thr * 100}%`;
    th.querySelector('.handle').style.top = `${(1 - thr) * 100}%`;
    $('thr-val').textContent = `${c.reverse ? 'REV ' : ''}${Math.round(ac.engines[0].n1)}%`;
    $('b-rev').classList.toggle('on', c.reverse);
    const sp = $('spoiler');
    sp.querySelector('.fill').style.height = `${c.speedbrake * 100}%`;
    sp.querySelector('.handle').style.top = `${c.speedbrake * 100}%`;
    $('b-arm').classList.toggle('on', c.speedbrakeArmed);
    $('trim-val').textContent = (4.5 + c.trim * 7).toFixed(1);
    [...$('flap-detents').children].forEach((b, i) => {
      b.classList.toggle('sel', i === c.flapLever);
      b.classList.toggle('moving', i === c.flapLever && Math.abs(ac.flapPos - c.flapLever) > 0.05);
    });
    // Bottom bar.
    const gb = $('b-gear');
    gb.classList.toggle('on', ac.gearPos > 0.99);
    gb.classList.toggle('warn', ac.gearPos > 0.01 && ac.gearPos < 0.99);
    $('b-ab').querySelector('em').textContent = c.autobrake;
    $('b-ab').classList.toggle('on', c.autobrake !== 'OFF');
    $('b-park').classList.toggle('warn', c.parkingBrake);
    $('b-brake').classList.toggle('on', !!this.brakeButton || ac.controls.brakeL > 0.1);
    $('b-lights').classList.toggle('on', this.lights.landing);
    $('b-ap').classList.toggle('on', ap.cmd);
    $('b-inst').classList.toggle('on', this.showInstruments);
    // MCP.
    $('m-spd-l').textContent = ap.mcp.useMach ? 'MACH' : 'IAS';
    $('m-spd').textContent = ap.mcp.useMach ? ap.mcp.mach.toFixed(2) : Math.round(ap.mcp.spd);
    $('m-hdg').textContent = String(Math.round(ap.mcp.hdg) % 360).padStart(3, '0');
    $('m-alt').textContent = ap.mcp.alt;
    $('m-vs').textContent = ap.vert === 'V/S' ? (ap.mcp.vs > 0 ? '+' : '') + ap.mcp.vs : '';
    const lamp = (id, on, armed) => {
      const el = $(id);
      el.classList.toggle('on', !!on);
      el.classList.toggle('armed', !on && !!armed);
    };
    lamp('m-at', ap.atArm);
    lamp('m-lvlchg', ap.vert === 'MCP SPD');
    lamp('m-hdgsel', ap.lat === 'HDG SEL');
    lamp('m-lnav', ap.lat === 'LNAV');
    lamp('m-loc', ap.lat === 'VOR/LOC', ap.latArmed === 'VOR/LOC');
    lamp('m-app', ap.vert === 'G/S' || ap.vert === 'FLARE', ap.vertArmed === 'G/S');
    lamp('m-alth', ap.vert === 'ALT HOLD');
    lamp('m-vsb', ap.vert === 'V/S');
    lamp('m-cmd', ap.cmd);
    lamp('m-fd', ap.fd);
  }

  toast(text, kind = 'info') {
    const box = $('messages');
    const el = document.createElement('div');
    el.className = `msg ${kind}`;
    el.textContent = text;
    box.appendChild(el);
    while (box.children.length > 4) box.removeChild(box.firstChild);
    setTimeout(() => el.remove(), kind === 'crash' ? 8000 : 3500);
  }

  showReport(r) {
    const sim = this.sim;
    const bad = r.grade.startsWith('Very') || r.grade === 'Hard';
    $('r-title').textContent = 'Landing report';
    const rows = [
      ['Vertical speed', `${r.vs} fpm`],
      ['Touchdown G', `${r.g} g`],
      ['Airspeed', `${r.ias} kt (Vref ${sim.vspeeds.vref30})`],
      ['Pitch / roll', `${r.pitch}° / ${r.roll}°`],
      ['Crab angle', `${r.crab}°`],
      ['Runway', r.runway],
      ['Past threshold', r.fromThreshold !== null ? `${r.fromThreshold} ft` : '—'],
      ['Centerline offset', r.centerline !== null ? `${r.centerline} ft` : '—'],
      ['Fuel remaining', `${Math.round(sim.ac.fuel)} kg`],
    ];
    $('r-body').innerHTML = `<div class="grade ${bad ? 'bad' : ''}">${r.grade}</div><table>${rows.map(([a, b]) => `<tr><td>${a}</td><td>${b}</td></tr>`).join('')}</table>`;
    $('report').classList.remove('hidden');
  }

  showCrash(reason) {
    $('r-title').textContent = 'Crash';
    $('r-body').innerHTML = `<div class="grade bad">${reason}</div><p class="hint">The flight has ended. Restart to try again.</p>`;
    $('report').classList.remove('hidden');
  }
}

window.app = new App();
