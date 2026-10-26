// Airports, local map projection, ILS geometry and the flight plan.
import { DEG, RAD, FT, NM, wrap180, wrap360, bearingOf, dirOf } from './math.js';

const R_EARTH = 6371000;

// Approximate airport data. Runways: [ids, true heading of first id, length, width, offset east (m), offset north (m)].
// Lengths are in feet unless suffixed with 'm' in the comment-free numbers below (all converted to metres at load).
const RAW = [
  ['KSEA', 'Seattle-Tacoma Intl', 47.4490, -122.3093, 433, 15, [
    [['16L', '34R'], 179.9, 11901, 150, 260, 0],
    [['16C', '34C'], 179.9, 9426, 150, 16, 120],
    [['16R', '34L'], 179.9, 8500, 150, -500, 450],
  ]],
  ['KPDX', 'Portland Intl', 45.5887, -122.5975, 31, 15, [
    [['10R', '28L'], 114.0, 11000, 150, 0, -500],
    [['10L', '28R'], 114.0, 9825, 150, 300, 400],
  ]],
  ['KSFO', 'San Francisco Intl', 37.6189, -122.3750, 13, 13, [
    [['28L', '10R'], 297.9, 11381, 200, 300, -250],
    [['28R', '10L'], 297.9, 11870, 200, 410, -40],
    [['19L', '01R'], 207.9, 8650, 200, -560, 250],
  ]],
  ['KLAX', 'Los Angeles Intl', 33.9425, -118.4081, 125, 12, [
    [['25L', '07R'], 262.9, 11095, 200, 0, -680],
    [['25R', '07L'], 262.9, 11095, 150, -150, -450],
    [['24L', '06R'], 262.9, 10885, 150, 0, 640],
    [['24R', '06L'], 262.9, 8926, 150, -350, 860],
  ]],
  ['KLAS', 'Las Vegas Harry Reid Intl', 36.0840, -115.1537, 2181, 11, [
    [['26L', '08R'], 269.0, 10526, 150, 0, -700],
    [['26R', '08L'], 269.0, 9775, 150, 0, -480],
    [['19R', '01L'], 195.0, 8988, 150, 450, 300],
  ]],
  ['KDEN', 'Denver Intl', 39.8561, -104.6737, 5434, 8, [
    [['16R', '34L'], 180.0, 16000, 200, -2900, -800],
    [['16L', '34R'], 180.0, 12000, 150, 2500, 1800],
    [['17R', '35L'], 180.0, 12000, 150, 1900, -1800],
    [['25', '07'], 90.0, 12000, 150, -700, 3000],
  ]],
  ['KJFK', 'New York JFK Intl', 40.6398, -73.7789, 13, -13, [
    [['04L', '22R'], 31.0, 12079, 200, -700, 300],
    [['13R', '31L'], 121.0, 14511, 200, 300, -500],
    [['04R', '22L'], 31.0, 8400, 150, 600, -800],
    [['13L', '31R'], 121.0, 10000, 150, 1200, 800],
  ]],
  ['KBOS', 'Boston Logan Intl', 42.3656, -71.0096, 20, -14, [
    [['04R', '22L'], 35.0, 10005, 150, 0, 0],
    [['15R', '33L'], 150.0, 10083, 150, 500, -200],
    [['27', '09'], 78.0, 7000, 150, 200, 600],
  ]],
  ['KATL', 'Atlanta Hartsfield-Jackson', 33.6367, -84.4281, 1026, -5, [
    [['08L', '26R'], 90.0, 9000, 150, 0, 1450],
    [['08R', '26L'], 90.0, 10000, 150, 0, 1180],
    [['09L', '27R'], 90.0, 12390, 150, 0, -1000],
    [['09R', '27L'], 90.0, 9000, 150, 300, -1260],
  ]],
  ['KORD', "Chicago O'Hare Intl", 41.9786, -87.9048, 672, -4, [
    [['10L', '28R'], 90.0, 13000, 150, 0, 900],
    [['10C', '28C'], 90.0, 10800, 200, 400, 0],
    [['09R', '27L'], 90.0, 7967, 150, -1200, -1300],
  ]],
  ['KMIA', 'Miami Intl', 25.7959, -80.2870, 8, -7, [
    [['09', '27'], 90.0, 13016, 150, 0, -700],
    [['08R', '26L'], 83.0, 10506, 200, 0, 500],
    [['12', '30'], 120.0, 9355, 150, 300, -100],
  ]],
  ['PHNL', 'Honolulu Daniel K. Inouye', 21.3187, -157.9225, 13, 10, [
    [['08L', '26R'], 90.0, 12300, 150, 0, 300],
    [['08R', '26L'], 90.0, 12000, 200, 600, -800],
    [['04R', '22L'], 50.0, 9000, 150, -900, 500],
  ]],
  ['EGLL', 'London Heathrow', 51.4700, -0.4543, 83, -1, [
    [['27R', '09L'], 269.7, 12802, 164, 0, 700],
    [['27L', '09R'], 269.7, 12008, 164, 0, -700],
  ]],
  ['EHAM', 'Amsterdam Schiphol', 52.3105, 4.7683, -11, 2, [
    [['18R', '36L'], 183.0, 12467, 197, -2500, 1500],
    [['06', '24'], 58.0, 11483, 148, 0, 200],
    [['18C', '36C'], 183.0, 10827, 148, 0, -500],
    [['27', '09'], 267.0, 11329, 148, 600, -1500],
  ]],
  ['LFPG', 'Paris Charles de Gaulle', 49.0097, 2.5479, 392, 1, [
    [['27R', '09L'], 266.0, 13829, 148, 0, 1200],
    [['26L', '08R'], 266.0, 13780, 197, 0, -1300],
    [['27L', '09R'], 266.0, 8858, 197, 1000, 850],
  ]],
  ['EDDF', 'Frankfurt am Main', 50.0379, 8.5622, 364, 3, [
    [['25C', '07C'], 250.0, 13123, 197, 0, 0],
    [['25R', '07L'], 250.0, 13123, 197, -400, -500],
    [['18', '36'], 180.0, 13123, 148, -2800, -500],
  ]],
  ['RJTT', 'Tokyo Haneda', 35.5494, 139.7798, 35, -7, [
    [['34R', '16L'], 337.0, 9840, 197, 800, 0],
    [['34L', '16R'], 337.0, 11024, 197, -300, 0],
    [['22', '04'], 214.0, 8202, 197, 1500, 1200],
  ]],
  ['VHHH', 'Hong Kong Intl', 22.3080, 113.9185, 28, -3, [
    [['07L', '25R'], 73.0, 12467, 197, 0, -800],
    [['07R', '25L'], 73.0, 12467, 197, 0, 800],
  ]],
  ['YSSY', 'Sydney Kingsford Smith', -33.9461, 151.1772, 21, 13, [
    [['16R', '34L'], 168.0, 12999, 148, 0, 0],
    [['16L', '34R'], 168.0, 8300, 148, 1000, -300],
    [['25', '07'], 77.0, 8300, 148, 0, 1600],
  ]],
  ['OMDB', 'Dubai Intl', 25.2532, 55.3657, 62, 2, [
    [['12L', '30R'], 120.0, 14590, 197, -200, 200],
    [['12R', '30L'], 120.0, 13124, 197, 200, -200],
  ]],
];

export class Runway {
  constructor(airport, ids, hdg, lenFt, widFt, cx, cz) {
    this.airport = airport;
    this.ids = ids;
    this.heading = hdg;           // true heading of ids[0]
    this.length = lenFt * FT;
    this.width = widFt * FT;
    this.cx = cx;
    this.cz = cz;
    this.elev = airport.elevM;
    const d = dirOf(hdg);
    const half = this.length / 2;
    // End 0: landing on ids[0] means approaching from the threshold at the "back" of hdg.
    this.ends = [0, 1].map((k) => {
      const sign = k === 0 ? -1 : 1;
      const tx = cx + d[0] * half * sign;
      const tz = cz + d[2] * half * sign;
      const heading = k === 0 ? hdg : wrap360(hdg + 180);
      return new RunwayEnd(this, ids[k], heading, tx, tz);
    });
  }

  /** Is (x,z) inside the paved runway (plus margin, m)? */
  contains(x, z, margin = 0) {
    const d = dirOf(this.heading);
    const dx = x - this.cx;
    const dz = z - this.cz;
    const along = dx * d[0] + dz * d[2];
    const across = dx * -d[2] + dz * d[0];
    return Math.abs(along) <= this.length / 2 + margin && Math.abs(across) <= this.width / 2 + margin;
  }
}

export class RunwayEnd {
  constructor(runway, id, heading, tx, tz) {
    this.runway = runway;
    this.id = id;
    this.heading = heading; // true direction of travel when landing/departing
    this.tx = tx;
    this.tz = tz;
    this.gsAngle = 3.0;
    this.tch = 50 * FT;
  }
  get airport() { return this.runway.airport; }
  get elev() { return this.runway.elev; }
  get name() { return `${this.airport.icao} ${this.id}`; }
  get magHeading() { return wrap360(this.heading - this.airport.magVar); }

  /** Point along the extended centerline: positive `dist` is before the threshold (on approach). */
  pointOnFinal(dist) {
    const d = dirOf(this.heading);
    return [this.tx - d[0] * dist, this.tz - d[2] * dist];
  }

  /**
   * ILS deviations for a position. Returns
   * { along: distance to threshold along course (m, + on approach), xtk: cross track (m, + = right of course),
   *   locDev: angle (deg, + = aircraft right of course), gsDev: angle (deg, + = above path), dme (nm) }.
   */
  ils(x, y, z) {
    const d = dirOf(this.heading);
    const dx = x - this.tx;
    const dz = z - this.tz;
    const along = -(dx * d[0] + dz * d[2]);
    const xtk = dx * -d[2] + dz * d[0];
    // Localizer antenna ~300 m beyond the far end.
    const locDist = along + this.runway.length + 300;
    const locDev = Math.atan2(xtk, Math.max(1, locDist)) * RAD;
    // Glide slope antenna abeam the touchdown zone, ~300 m past the threshold.
    const gsDist = along + 300;
    const h = y - this.elev;
    const gsDev = Math.atan2(h, Math.max(1, gsDist)) * RAD - this.gsAngle;
    const dme = Math.hypot(gsDist, xtk) / NM;
    return { along, xtk, locDev, gsDev, dme, gsDist, h };
  }
}

export class Airport {
  constructor(raw, proj) {
    const [icao, name, lat, lon, elevFt, magVar, rwys] = raw;
    this.icao = icao;
    this.name = name;
    this.lat = lat;
    this.lon = lon;
    this.elevFt = elevFt;
    this.elevM = elevFt * FT;
    this.magVar = magVar;
    const [x, z] = proj.toLocal(lat, lon);
    this.x = x;
    this.z = z;
    this.runways = rwys.map(([ids, hdg, len, wid, ox, oz]) => new Runway(this, ids, hdg, len, wid, x + ox, z - oz));
    this.ends = this.runways.flatMap((r) => r.ends);
    // Terminal / apron placed beside the main runway.
    const main = this.runways[0];
    const d = dirOf(main.heading);
    const side = 1;
    const off = main.width / 2 + 420;
    this.apron = {
      x: main.cx + -d[2] * off * side,
      z: main.cz + d[0] * off * side,
      heading: main.heading,
      length: Math.min(main.length * 0.7, 1800),
      depth: 320,
    };
    // Control tower sits at the edge of the apron.
    this.tower = {
      x: this.apron.x + -d[2] * 230 + d[0] * this.apron.length * 0.45,
      z: this.apron.z + d[0] * 230 + d[2] * this.apron.length * 0.45,
    };
  }

  end(id) {
    return this.ends.find((e) => e.id === id);
  }

  /** Pick the runway end best aligned with the wind (blowing FROM windDir). */
  bestEnd(windDir) {
    let best = this.ends[0];
    let bestScore = -Infinity;
    for (const e of this.ends) {
      const head = Math.cos((e.heading - windDir) * DEG);
      const score = head * 10 + e.runway.length / 1000;
      if (score > bestScore) {
        bestScore = score;
        best = e;
      }
    }
    return best;
  }
}

/** Equirectangular projection around an origin; adequate for regional flights. */
export class Projection {
  constructor(lat0, lon0) {
    this.lat0 = lat0;
    this.lon0 = lon0;
    this.cos0 = Math.cos(lat0 * DEG);
    // Absolute offset of the origin, used to keep procedural terrain anchored to the earth.
    this.ox = lon0 * DEG * R_EARTH * this.cos0;
    this.oz = -lat0 * DEG * R_EARTH;
  }
  toLocal(lat, lon) {
    const dLon = wrap180(lon - this.lon0);
    return [dLon * DEG * R_EARTH * this.cos0, -(lat - this.lat0) * DEG * R_EARTH];
  }
  toLatLon(x, z) {
    return [this.lat0 - z / R_EARTH * RAD, this.lon0 + x / (R_EARTH * this.cos0) * RAD];
  }
}

export const AIRPORT_LIST = RAW.map((r) => ({ icao: r[0], name: r[1], lat: r[2], lon: r[3], runways: r[6].flatMap((w) => w[0]) }));

/** Great-circle distance in nm between two airports in the raw list. */
export function routeDistanceNm(a, b) {
  const A = RAW.find((r) => r[0] === a);
  const B = RAW.find((r) => r[0] === b);
  if (!A || !B) return 0;
  const p1 = A[2] * DEG;
  const p2 = B[2] * DEG;
  const dl = (B[3] - A[3]) * DEG;
  const c = Math.sin(p1) * Math.sin(p2) + Math.cos(p1) * Math.cos(p2) * Math.cos(dl);
  return (Math.acos(Math.max(-1, Math.min(1, c))) * R_EARTH) / NM;
}

export class NavDatabase {
  constructor(depIcao) {
    const dep = RAW.find((r) => r[0] === depIcao) || RAW[0];
    this.proj = new Projection(dep[2], dep[3]);
    this.airports = RAW.map((r) => new Airport(r, this.proj));
  }
  airport(icao) {
    return this.airports.find((a) => a.icao === icao);
  }
  nearest(x, z, maxDist = Infinity) {
    let best = null;
    let bd = maxDist;
    for (const a of this.airports) {
      const d = Math.hypot(a.x - x, a.z - z);
      if (d < bd) {
        bd = d;
        best = a;
      }
    }
    return best;
  }
  /** Airports within `radius` m of (x, z). */
  near(x, z, radius) {
    return this.airports.filter((a) => Math.hypot(a.x - x, a.z - z) < radius);
  }
}

export class Waypoint {
  constructor(name, x, z, alt = null, kind = 'fix') {
    this.name = name;
    this.x = x;
    this.z = z;
    this.alt = alt;   // altitude constraint (m MSL) or null
    this.kind = kind; // 'fix' | 'rwy' | 'faf' | 'dep'
  }
}

export class FlightPlan {
  constructor(depEnd, arrEnd, cruiseAltFt) {
    this.dep = depEnd;
    this.arr = arrEnd;
    this.cruiseAlt = cruiseAltFt * FT;
    this.waypoints = [];
    this.active = 1;
    this.build();
  }

  build() {
    const wps = [];
    const dep = this.dep;
    const arr = this.arr;
    wps.push(new Waypoint(`RW${dep.id}`, dep.tx, dep.tz, dep.elev, 'rwy'));
    // Climb-out fix on the extended runway centerline.
    const dd = dirOf(dep.heading);
    const depLen = dep.runway.length + 7 * NM;
    wps.push(new Waypoint(`${dep.airport.icao.slice(1)}${dep.id}`, dep.tx + dd[0] * depLen, dep.tz + dd[2] * depLen, null, 'dep'));

    const total = Math.hypot(arr.tx - dep.tx, arr.tz - dep.tz);
    const ifDist = 14 * NM;
    const fafDist = 6 * NM;
    const [ifx, ifz] = arr.pointOnFinal(ifDist);
    const [ffx, ffz] = arr.pointOnFinal(fafDist);
    if (total > 60 * NM) {
      // En-route fixes every ~150 nm along the straight line, named like real 5-letter fixes.
      const last = wps[wps.length - 1];
      const legLen = Math.hypot(ifx - last.x, ifz - last.z);
      const n = Math.floor(legLen / (150 * NM));
      for (let i = 1; i <= n; i++) {
        const t = i / (n + 1);
        wps.push(new Waypoint(fixName(i, dep, arr), last.x + (ifx - last.x) * t, last.z + (ifz - last.z) * t, null, 'fix'));
      }
    }
    // If the arrival comes from the "wrong" side, add a fix abeam the final course to make a downwind/base.
    const lastWp = wps[wps.length - 1];
    const inbound = bearingOf(ifx - lastWp.x, ifz - lastWp.z);
    const turn = wrap180(arr.heading - inbound);
    if (Math.abs(turn) > 75 && total > 25 * NM) {
      const side = turn > 0 ? -1 : 1; // side of the final course we are arriving from
      const ad = dirOf(arr.heading);
      const [bx, bz] = arr.pointOnFinal(ifDist + 4 * NM);
      const off = 7 * NM;
      wps.push(new Waypoint('BASE', bx + -ad[2] * off * side, bz + ad[0] * off * side, arr.elev + 4000 * FT, 'fix'));
    }
    wps.push(new Waypoint(`CF${arr.id}`, ifx, ifz, arr.elev + 3000 * FT, 'fix'));
    wps.push(new Waypoint(`FF${arr.id}`, ffx, ffz, arr.elev + 1900 * FT, 'faf'));
    wps.push(new Waypoint(`RW${arr.id}`, arr.tx, arr.tz, arr.elev + arr.tch, 'rwy'));
    this.waypoints = wps;
    this.active = 1;
  }

  get activeWp() {
    return this.waypoints[this.active] || null;
  }
  get prevWp() {
    return this.waypoints[Math.max(0, this.active - 1)];
  }

  /** Remaining distance along the route from (x,z), in metres. */
  remaining(x, z) {
    let d = 0;
    let px = x;
    let pz = z;
    for (let i = this.active; i < this.waypoints.length; i++) {
      const w = this.waypoints[i];
      d += Math.hypot(w.x - px, w.z - pz);
      px = w.x;
      pz = w.z;
    }
    return d;
  }

  /** Jump to the waypoint nearest ahead of a position (used when spawning mid-route). */
  syncTo(x, z, headingDeg) {
    let best = this.active;
    let bd = Infinity;
    for (let i = 1; i < this.waypoints.length; i++) {
      const w = this.waypoints[i];
      const brg = bearingOf(w.x - x, w.z - z);
      if (Math.abs(wrap180(brg - headingDeg)) > 80) continue;
      const d = Math.hypot(w.x - x, w.z - z);
      if (d < bd) {
        bd = d;
        best = i;
      }
    }
    this.active = best;
  }
}

function fixName(i, dep, arr) {
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const seed = (dep.airport.icao.charCodeAt(1) * 7 + arr.airport.icao.charCodeAt(2) * 13 + i * 31) | 0;
  let s = '';
  let v = seed;
  for (let k = 0; k < 5; k++) {
    s += letters[v % 26];
    v = (v * 17 + 11 + k * 5) % 9973;
  }
  return s;
}

