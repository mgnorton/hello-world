#!/usr/bin/env node
// Build public/data/navdata.dat (gzip JSON) for the scenery region from FAA data:
//   * NASR airports, runways (threshold coordinates, lighting, PAPI, ILS), navaids, fixes, airways
//   * CIFP procedures (SIDs, STARs, instrument approaches)
// Magnetic variation for airports comes from the World Magnetic Model (WMM-2025).
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { gunzipSync, gzipSync } from 'node:zlib';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const geomagnetism = require('geomagnetism');
const here = dirname(fileURLToPath(import.meta.url));
const OUT = join(here, '..', 'public', 'data');
const world = JSON.parse(readFileSync(join(OUT, 'world.json'), 'utf8'));
const BOX = world.terrainWide;
const MARGIN = 1.0; // degrees of navaids/fixes kept outside the scenery box for routing

const load = (pkg, file) => JSON.parse(gunzipSync(readFileSync(join(here, '..', 'node_modules', '@squawk', pkg, 'data', file))));
const inBox = (lat, lon, m = 0) => lat >= BOX.south - m && lat <= BOX.north + m && lon >= BOX.west - m && lon <= BOX.east + m;
const r6 = (v) => Math.round(v * 1e6) / 1e6;
const r1 = (v) => Math.round(v * 10) / 10;
const magModel = geomagnetism.model(new Date());
const declination = (lat, lon) => Math.round(magModel.point([lat, lon]).decl * 100) / 100;
const signedVar = (deg, dir) => (deg === undefined ? undefined : dir === 'W' ? -deg : deg);

function bearing(lat1, lon1, lat2, lon2) {
  const p1 = (lat1 * Math.PI) / 180;
  const p2 = (lat2 * Math.PI) / 180;
  const dl = ((lon2 - lon1) * Math.PI) / 180;
  const y = Math.sin(dl) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

// ---------------------------------------------------------------------------- airports
const airportsRaw = load('airport-data', 'airports.json.gz');
const airports = [];
for (const a of airportsRaw.records) {
  if (a.facilityType !== 'AIRPORT' || a.status !== 'OPEN' || a.useType !== 'PUBLIC') continue;
  if (!inBox(a.lat, a.lon)) continue;
  const runways = [];
  for (const rw of a.runways || []) {
    if (!rw.ends || rw.ends.length !== 2 || rw.ends.some((e) => e.lat === undefined)) continue;
    if (/^H/.test(rw.id)) continue; // helipads
    const [e0, e1] = rw.ends;
    const ends = [e0, e1].map((e, k) => {
      const other = k ? e0 : e1;
      const out = {
        id: e.id,
        lat: r6(e.lat), lon: r6(e.lon),
        elevFt: e.elevationFt ?? a.elevationFt,
        trueHdg: r1(bearing(e.lat, e.lon, other.lat, other.lon)),
      };
      if (e.displacedThresholdFt) out.displacedFt = e.displacedThresholdFt;
      if (e.thresholdCrossingHeightFt) out.tchFt = e.thresholdCrossingHeightFt;
      if (e.glidepathAngleDeg) out.gpa = e.glidepathAngleDeg;
      if (e.tdzElevationFt) out.tdzeFt = e.tdzElevationFt;
      if (e.vgsiType) out.vgsi = e.vgsiType;
      if (e.approachLights) out.als = e.approachLights;
      if (e.hasCenterlineLights) out.cl = 1;
      if (e.hasTdzLights) out.tdz = 1;
      if (e.hasReil) out.reil = 1;
      if (e.markingType) out.marking = e.markingType;
      if (e.ils) {
        out.ils = {
          ident: e.ils.identifier, freq: e.ils.localizerFrequencyMhz, magCrs: e.ils.localizerMagneticCourseDeg,
          gs: e.ils.glideSlopeAngleDeg ?? null, cat: e.ils.category, dme: !!e.ils.dmeChannel, type: e.ils.systemType,
        };
      }
      return out;
    });
    runways.push({
      id: rw.id, lengthFt: rw.lengthFt, widthFt: rw.widthFt, surface: rw.surfaceType || 'UNK',
      lighting: rw.lighting || null, ends,
    });
  }
  if (!runways.length) continue;
  const freqs = {};
  for (const f of a.frequencies || []) {
    const u = (f.use || '').toUpperCase();
    for (const k of ['ATIS', 'D-ATIS', 'TWR', 'GND', 'CTAF', 'APCH/DEP', 'ASOS', 'AWOS']) {
      if (u.startsWith(k) && !freqs[k]) freqs[k] = f.frequencyMhz;
    }
  }
  airports.push({
    id: a.faaId, icao: a.icao || null, name: a.name, city: a.city, state: a.state,
    lat: r6(a.lat), lon: r6(a.lon), elevFt: a.elevationFt, magVar: declination(a.lat, a.lon),
    towered: a.towerType ? !/NON/.test(a.towerType) : false, freqs, runways,
  });
}
airports.sort((x, y) => Math.max(...y.runways.map((r) => r.lengthFt)) - Math.max(...x.runways.map((r) => r.lengthFt)));

// ---------------------------------------------------------------------------- navaids
const navRaw = load('navaid-data', 'navaids.json.gz');
const navaids = [];
for (const n of navRaw.records) {
  if (!inBox(n.lat, n.lon, MARGIN)) continue;
  if (/DECOMMISSIONED|SHUTDOWN/.test(n.status || '')) continue;
  const isNdb = /NDB/.test(n.type);
  navaids.push({
    id: n.identifier, name: n.name, type: n.type, lat: r6(n.lat), lon: r6(n.lon), elevFt: n.elevationFt ?? 0,
    freq: isNdb ? n.frequencyKhz : n.frequencyMhz, unit: isNdb ? 'kHz' : 'MHz',
    cls: n.navaidClass || n.ndbClass || '', stationVar: signedVar(n.magneticVariationDeg, n.magneticVariationDirection) ?? 0,
    dme: /DME|TAC/.test(n.type),
  });
}

// ---------------------------------------------------------------------------- airways
const awyRaw = load('airway-data', 'airways.json.gz');
const airways = [];
for (const w of awyRaw.records) {
  const pts = w.waypoints || [];
  const keep = pts.some((p) => inBox(p.lat, p.lon));
  if (!keep) continue;
  airways.push({
    id: w.designation,
    pts: pts.map((p) => ({ id: p.identifier || p.name, lat: r6(p.lat), lon: r6(p.lon), mea: p.minimumEnrouteAltitudeFt ?? null })),
  });
}

// ---------------------------------------------------------------------------- procedures
const procRaw = load('procedure-data', 'procedures.json.gz');
const icaoSet = new Set(airports.map((a) => a.icao || `K${a.id}`));
const compactLeg = (l) => {
  const o = { pt: l.pathTerminator };
  if (l.fixIdentifier) o.fix = l.fixIdentifier;
  if (l.lat !== undefined) {
    o.lat = r6(l.lat);
    o.lon = r6(l.lon);
  }
  if (l.category) o.cat = l.category;
  if (l.courseDeg !== undefined) o.crs = l.courseDeg;
  if (l.distanceNm !== undefined) o.dist = l.distanceNm;
  if (l.altitudeConstraint) {
    const c = l.altitudeConstraint;
    o.alt = { d: c.descriptor || '@', a1: c.primaryFt ?? null, a2: c.secondaryFt ?? null };
  }
  if (l.speedConstraint) o.spd = { d: l.speedConstraint.descriptor || '@', kt: l.speedConstraint.speedKt };
  if (l.turnDirection) o.turn = l.turnDirection;
  if (l.isFlyover) o.flyover = 1;
  if (l.isFinalApproachFix) o.faf = 1;
  if (l.isMissedApproachPoint) o.map = 1;
  if (l.verticalAngleDeg !== undefined) o.va = l.verticalAngleDeg;
  if (l.recommendedNavaid) o.nav = l.recommendedNavaid;
  if (l.arcRadiusNm !== undefined) o.arc = l.arcRadiusNm;
  if (l.centerFixIdentifier) o.center = l.centerFixIdentifier;
  if (l.centerLat !== undefined) {
    o.clat = r6(l.centerLat);
    o.clon = r6(l.centerLon);
  }
  return o;
};
const procedures = [];
for (const p of procRaw.records) {
  const aps = (p.airports || []).filter((x) => icaoSet.has(x));
  if (!aps.length) continue;
  procedures.push({
    airports: aps, type: p.type, name: p.name, ident: p.identifier,
    runway: p.runway || null, approachType: p.approachType || null,
    common: (p.commonRoutes || []).map((r) => ({ airports: r.airports || null, legs: r.legs.map(compactLeg) })),
    transitions: (p.transitions || []).map((t) => ({ name: t.name, legs: t.legs.map(compactLeg) })),
    missed: p.missedApproach ? p.missedApproach.legs.map(compactLeg) : null,
  });
}

// ---------------------------------------------------------------------------- fixes
// Keep fixes in the region plus every fix referenced by kept airways or procedures.
const fixRaw = load('fix-data', 'fixes.json.gz');
const referenced = new Set();
for (const w of airways) for (const p of w.pts) referenced.add(p.id);
for (const p of procedures) {
  for (const r of [...p.common, ...p.transitions]) for (const l of r.legs) if (l.fix) referenced.add(l.fix);
  for (const l of p.missed || []) if (l.fix) referenced.add(l.fix);
}
const fixes = [];
for (const f of fixRaw.records) {
  if (inBox(f.lat, f.lon) || referenced.has(f.identifier)) {
    fixes.push({ id: f.identifier, lat: r6(f.lat), lon: r6(f.lon) });
  }
}

const out = {
  cycle: airportsRaw.meta.nasrCycleDate,
  cifpCycle: procRaw.meta.cifpCycleDate,
  generatedAt: new Date().toISOString(),
  magModel: 'WMM-2025',
  sources: 'FAA NASR 28-day subscription and FAA CIFP via @squawk/*-data packages; public domain US government data.',
  airports, navaids, fixes, airways, procedures,
};
mkdirSync(OUT, { recursive: true });
const json = JSON.stringify(out);
writeFileSync(join(OUT, 'navdata.dat'), gzipSync(json, { level: 9 }));
const counts = { airports: airports.length, runways: airports.reduce((s, a) => s + a.runways.length, 0), navaids: navaids.length, fixes: fixes.length, airways: airways.length, procedures: procedures.length };
console.log('navdata', counts, `${(json.length / 1e6).toFixed(2)} MB json`);
// Magnetic variation grid for the region (1 degree), interpolated at runtime.
const magGrid = [];
for (let lat = Math.floor(BOX.south); lat <= Math.ceil(BOX.north) + 1; lat++) {
  const row = [];
  for (let lon = Math.floor(BOX.west); lon <= Math.ceil(BOX.east) + 1; lon++) row.push(declination(lat, lon));
  magGrid.push(row);
}
world.magVar = { south: Math.floor(BOX.south), west: Math.floor(BOX.west), step: 1, grid: magGrid, model: 'WMM-2025', epoch: new Date().toISOString().slice(0, 10) };
world.navCycle = out.cycle;
writeFileSync(join(OUT, 'world.json'), JSON.stringify(world, null, 1));
