#!/usr/bin/env python3
"""Snapshot real-world weather for the scenery region from NOAA's HRRR model.

Downloads only the needed GRIB2 messages (HTTP byte ranges from the .idx files) of the
latest HRRR analysis on AWS Open Data (s3://noaa-hrrr-bdp-pds), and averages them onto a
0.1 degree grid. The simulator's weather engine starts from this snapshot and evolves it.

Usage:  python3 tools/build_weather.py [YYYYMMDDHH]   (needs numpy, eccodes)
"""
import datetime as dt
import json
import os
import ssl
import sys
import tempfile
import urllib.request

import numpy as np

OUT = os.path.join(os.path.dirname(__file__), '..', 'public', 'data')
BUCKET = 'https://noaa-hrrr-bdp-pds.s3.amazonaws.com'
STEP = 0.1
CTX = ssl.create_default_context()

SFC_FIELDS = {
    'REFC:entire atmosphere': 'refc',
    'VIS:surface': 'vis',
    'GUST:surface': 'gust',
    'MSLMA:mean sea level': 'mslp',
    'TMP:2 m above ground': 't2',
    'DPT:2 m above ground': 'td2',
    'UGRD:10 m above ground': 'u10',
    'VGRD:10 m above ground': 'v10',
    'LCDC:low cloud layer': 'lcc',
    'MCDC:middle cloud layer': 'mcc',
    'HCDC:high cloud layer': 'hcc',
    'HGT:cloud ceiling': 'ceil',
    'CAPE:surface': 'cape',
}
LEVELS = [850, 700, 500, 300, 250]
ISA_ALT = {850: 1457, 700: 3012, 500: 5574, 300: 9164, 250: 10363}


def get(url, rng=None):
    req = urllib.request.Request(url, headers={'Range': f'bytes={rng[0]}-{rng[1]}'} if rng else {})
    with urllib.request.urlopen(req, context=CTX, timeout=120) as r:
        return r.read()


def find_cycle(arg):
    if arg:
        t = dt.datetime.strptime(arg, '%Y%m%d%H')
        return t
    now = dt.datetime.now(dt.timezone.utc).replace(minute=0, second=0, microsecond=0, tzinfo=None)
    for back in range(1, 8):
        t = now - dt.timedelta(hours=back)
        url = f'{BUCKET}/hrrr.{t:%Y%m%d}/conus/hrrr.t{t:%H}z.wrfprsf00.grib2.idx'
        try:
            get(url)
            return t
        except Exception:  # noqa: BLE001 - try the previous cycle
            continue
    raise SystemExit('no recent HRRR cycle found')


def fetch_messages(t, product, wanted):
    """Return {short_name: (values, lats, lons)} for idx entries matching `wanted` keys."""
    import eccodes

    base = f'{BUCKET}/hrrr.{t:%Y%m%d}/conus/hrrr.t{t:%H}z.{product}.grib2'
    lines = get(base + '.idx').decode().strip().split('\n')
    entries = []
    for i, ln in enumerate(lines):
        parts = ln.split(':')
        start = int(parts[1])
        end = int(lines[i + 1].split(':')[1]) - 1 if i + 1 < len(lines) else None
        key = f'{parts[3]}:{parts[4]}'
        if key in wanted and parts[5].startswith('anl'):
            entries.append((key, start, end))
    out = {}
    for key, start, end in entries:
        data = get(base, (start, end if end is not None else start + 20_000_000))
        with tempfile.NamedTemporaryFile(suffix='.grib2') as f:
            f.write(data)
            f.flush()
            with open(f.name, 'rb') as fh:
                gid = eccodes.codes_grib_new_from_file(fh)
                vals = eccodes.codes_get_values(gid)
                lats = eccodes.codes_get_array(gid, 'latitudes')
                lons = eccodes.codes_get_array(gid, 'longitudes')
                missing = eccodes.codes_get(gid, 'missingValue')
                eccodes.codes_release(gid)
        lons = np.where(lons > 180, lons - 360, lons)
        vals = np.where(vals == missing, np.nan, vals)
        out[wanted[key]] = (vals, lats, lons)
        print(f'  {product} {key}: {len(vals)} points')
    return out


def regrid(vals, lats, lons, box, rows, cols):
    i = np.floor((lats - box['south']) / STEP).astype(int)
    j = np.floor((lons - box['west']) / STEP).astype(int)
    ok = (i >= 0) & (i < rows) & (j >= 0) & (j < cols) & np.isfinite(vals)
    idx = i[ok] * cols + j[ok]
    s = np.bincount(idx, weights=vals[ok], minlength=rows * cols)
    n = np.bincount(idx, minlength=rows * cols)
    with np.errstate(invalid='ignore'):
        g = s / n
    return g.reshape(rows, cols)


def main():
    world = json.load(open(os.path.join(OUT, 'world.json')))
    box = world['terrainWide']
    rows = int(round((box['north'] - box['south']) / STEP))
    cols = int(round((box['east'] - box['west']) / STEP))
    t = find_cycle(sys.argv[1] if len(sys.argv) > 1 else None)
    print(f'HRRR cycle {t:%Y-%m-%d %H}Z, grid {rows}x{cols}')
    sfc = fetch_messages(t, 'wrfsfcf00', SFC_FIELDS)
    lvl_keys = {}
    for p in LEVELS:
        for v in ('UGRD', 'VGRD', 'TMP'):
            lvl_keys[f'{v}:{p} mb'] = f'{v}{p}'
    prs = fetch_messages(t, 'wrfprsf00', lvl_keys)

    def q(name, src, scale, offset=0.0):
        vals, la, lo = src[name]
        g = regrid(vals + offset, la, lo, box, rows, cols)
        g = np.where(np.isfinite(g), g, np.nanmean(g) if np.isfinite(g).any() else 0)
        return np.round(g * scale).astype(int).flatten().tolist()

    # HRRR winds are grid-relative on its Lambert grid; rotate to earth-relative (LoV = 262.5 E).
    def rotate(u_name, v_name, src):
        u, la, lo = src[u_name]
        v = src[v_name][0]
        lov = -97.5
        lat1 = 38.5
        n = np.sin(np.radians(lat1))
        ang = n * np.radians(lo - lov)
        ue = np.cos(ang) * u + np.sin(ang) * v
        ve = -np.sin(ang) * u + np.cos(ang) * v
        src[u_name] = (ue, la, lo)
        src[v_name] = (ve, la, lo)

    rotate('u10', 'v10', sfc)
    for p in LEVELS:
        rotate(f'UGRD{p}', f'VGRD{p}', prs)

    seed = {
        'source': 'NOAA HRRR analysis (AWS Open Data, s3://noaa-hrrr-bdp-pds)',
        'validTime': f'{t:%Y-%m-%dT%H}:00Z',
        'grid': {'south': box['south'], 'west': box['west'], 'step': STEP, 'rows': rows, 'cols': cols},
        'units': {'wind': 'm/s x10', 'temp': 'C x10', 'mslp': 'hPa x10', 'vis': 'm', 'ceil': 'm AGL (-1 none)',
                  'cloud': '%', 'refc': 'dBZ', 'cape': 'J/kg'},
        'sfc': {
            'u10': q('u10', sfc, 10), 'v10': q('v10', sfc, 10), 'gust': q('gust', sfc, 10),
            't2': q('t2', sfc, 10, -273.15), 'td2': q('td2', sfc, 10, -273.15),
            'mslp': q('mslp', sfc, 0.1), 'vis': q('vis', sfc, 1),
            'lcc': q('lcc', sfc, 1), 'mcc': q('mcc', sfc, 1), 'hcc': q('hcc', sfc, 1),
            'refc': q('refc', sfc, 1), 'cape': q('cape', sfc, 1),
        },
        'levels': [],
    }
    # Ceiling: HRRR uses a huge value for "no ceiling"; keep -1 for none.
    vals, la, lo = sfc['ceil']
    vals = np.where(vals > 15000, np.nan, vals)
    g = regrid(vals, la, lo, box, rows, cols)
    seed['sfc']['ceil'] = np.where(np.isfinite(g), np.round(g), -1).astype(int).flatten().tolist()
    for p in LEVELS:
        seed['levels'].append({
            'p': p, 'alt': ISA_ALT[p],
            'u': q(f'UGRD{p}', prs, 10), 'v': q(f'VGRD{p}', prs, 10), 't': q(f'TMP{p}', prs, 10, -273.15),
        })
    path = os.path.join(OUT, 'weather_seed.json')
    with open(path, 'w') as f:
        json.dump(seed, f, separators=(',', ':'))
    print(f'wrote {path}: {os.path.getsize(path) / 1e3:.0f} kB')


if __name__ == '__main__':
    main()
