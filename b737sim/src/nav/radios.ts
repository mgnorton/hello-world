// VHF NAV receivers (VOR / localizer + glide slope / DME) and ADF, tuned to real stations.
import { FT, NM, RAD, wrap180, wrap360 } from '../core/math.ts';
import type { NavDB, Navaid, RunwayEnd } from '../world/navdb.ts';

export type NavKind = 'vor' | 'ils' | null;

/** Is a VHF NAV frequency a localizer channel (108.10-111.95 MHz, odd tenths)? */
export function isLocalizerFreq(mhz: number): boolean {
  if (mhz < 108 || mhz >= 112) return false;
  const tenths = Math.floor(Math.round(mhz * 100) / 10) % 10;
  return tenths % 2 === 1;
}

/** Line-of-sight radio horizon (nm) between an aircraft at height h (ft) and a station. */
export function radioHorizonNm(aircraftFtAboveStation: number, antennaFt = 30): number {
  return 1.23 * (Math.sqrt(Math.max(0, aircraftFtAboveStation)) + Math.sqrt(antennaFt));
}

export class NavRadio {
  active: number;
  standby: number;
  /** Selected course (OBS), magnetic degrees. */
  course: number;
  kind: NavKind = null;
  vor: Navaid | null = null;
  loc: RunwayEnd | null = null;
  /** Morse ident of the received station, if any. */
  ident = '';
  receiving = false;
  // VOR outputs
  radial = 0; // magnetic radial FROM the station (station declination)
  bearingTo = 0; // magnetic bearing TO the station
  toFrom: 'TO' | 'FROM' | '' = '';
  // Deviation (dots): + = aircraft right of course => fly left
  cdiDots = 0;
  gsDots: number | null = null;
  dmeNm: number | null = null;
  /** Deviation in degrees (VOR or localizer). */
  devDeg = 0;
  private timer = 0;

  constructor(readonly name: string, freq: number, course: number) {
    this.active = freq;
    this.standby = 110.3;
    this.course = course;
  }

  swap(): void {
    [this.active, this.standby] = [this.standby, this.active];
    this.timer = 0;
  }

  tune(freq: number, course?: number): void {
    this.active = Math.round(freq * 100) / 100;
    if (course !== undefined) this.course = wrap360(course);
    this.timer = 0;
  }

  /** Update receiver outputs for an aircraft at local (x, y, z). Called often; tunes at 4 Hz. */
  update(dt: number, db: NavDB, x: number, y: number, z: number, magVarHere: number): void {
    this.timer -= dt;
    if (this.timer <= 0) {
      this.timer = 0.25;
      this.select(db, x, y, z);
    }
    if (!this.receiving) return;
    if (this.kind === 'ils' && this.loc) {
      const e = this.loc;
      const d = e.ilsDeviation(x, y, z);
      // Localizer coverage: +-35 deg within 10 nm, +-10 deg to 18 nm (front course only).
      const off = Math.abs(d.locDev);
      const rangeOk = d.along > -e.runway.lengthM && ((off < 35 && d.dme < 10) || (off < 12 && d.dme < 25));
      if (!rangeOk) {
        this.receiving = false;
        return;
      }
      this.devDeg = d.locDev;
      this.cdiDots = d.locDev / 1.25;
      this.gsDots = e.ils?.gs && d.along > 0 && d.dme < 12 ? -d.gsDev / 0.35 : null;
      this.dmeNm = e.ils?.dme ? d.dme : null;
      this.toFrom = 'TO';
      this.radial = wrap360(e.courseMag + 180);
      this.bearingTo = wrap360(Math.atan2(e.tx - x, -(e.tz - z)) * RAD - magVarHere);
    } else if (this.kind === 'vor' && this.vor) {
      const s = this.vor;
      const dx = x - s.x;
      const dz = z - s.z;
      const brgFromTrue = wrap360(Math.atan2(dx, -dz) * RAD);
      this.radial = wrap360(brgFromTrue - s.raw.stationVar);
      this.bearingTo = wrap360(brgFromTrue + 180 - magVarHere);
      const fromDev = wrap180(this.radial - this.course);
      if (Math.abs(fromDev) <= 90) {
        this.toFrom = 'FROM';
        this.devDeg = fromDev;
      } else {
        this.toFrom = 'TO';
        this.devDeg = -wrap180(this.radial - this.course - 180);
      }
      this.cdiDots = this.devDeg / 5;
      this.gsDots = null;
      const slant = Math.hypot(dx, dz, y - s.elevM) / NM;
      this.dmeNm = s.raw.dme ? slant : null;
    }
  }

  private select(db: NavDB, x: number, y: number, z: number): void {
    const f = this.active;
    this.receiving = false;
    this.vor = null;
    this.loc = null;
    this.kind = null;
    this.ident = '';
    if (isLocalizerFreq(f)) {
      let best: RunwayEnd | null = null;
      let bd = Infinity;
      for (const e of db.localizers(f)) {
        const d = Math.hypot(e.tx - x, e.tz - z);
        if (d < bd && d < 30 * NM) {
          bd = d;
          best = e;
        }
      }
      if (best) {
        const horizon = radioHorizonNm((y - best.elevM) / FT, 20);
        if (bd / NM <= Math.max(horizon, 2)) {
          this.kind = 'ils';
          this.loc = best;
          this.ident = (best.ils?.ident ?? '').replace(/^I-/, 'I');
          this.receiving = true;
        }
      }
      return;
    }
    let best: Navaid | null = null;
    let bd = Infinity;
    for (const n of db.navaidsOnFreq(f, 'MHz')) {
      if (!n.isVor) continue;
      const d = Math.hypot(n.x - x, n.z - z);
      if (d < bd) {
        bd = d;
        best = n;
      }
    }
    if (!best) return;
    const nm = bd / NM;
    const horizon = radioHorizonNm((y - best.elevM) / FT);
    if (nm <= Math.min(best.rangeNm * 1.15, horizon)) {
      this.kind = 'vor';
      this.vor = best;
      this.ident = best.id;
      this.receiving = true;
    }
  }
}

export class AdfRadio {
  freq = 0; // kHz
  station: Navaid | null = null;
  /** Relative bearing to the station (deg, 0 = nose). */
  relBearing = 0;
  ident = '';
  private timer = 0;

  update(dt: number, db: NavDB, x: number, z: number, headingTrue: number): void {
    this.timer -= dt;
    if (this.timer <= 0) {
      this.timer = 0.5;
      this.station = null;
      this.ident = '';
      let bd = Infinity;
      for (const n of db.navaidsOnFreq(this.freq, 'kHz')) {
        const d = Math.hypot(n.x - x, n.z - z) / NM;
        if (d < n.rangeNm && d < bd) {
          bd = d;
          this.station = n;
          this.ident = n.id;
        }
      }
    }
    if (this.station) {
      const brg = wrap360(Math.atan2(this.station.x - x, -(this.station.z - z)) * RAD);
      this.relBearing = wrap360(brg - headingTrue);
    }
  }
}

export class RadioStack {
  nav1 = new NavRadio('NAV 1', 113.1, 180);
  nav2 = new NavRadio('NAV 2', 116.2, 180);
  adf = new AdfRadio();
  /** Set by the FMC: keep the approach ILS tuned automatically. */
  autotune = true;

  update(dt: number, db: NavDB, x: number, y: number, z: number, headingTrue: number, magVarHere: number): void {
    this.nav1.update(dt, db, x, y, z, magVarHere);
    this.nav2.update(dt, db, x, y, z, magVarHere);
    this.adf.update(dt, db, x, z, headingTrue);
  }
}
