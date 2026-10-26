#!/usr/bin/env python3
"""Build the real-world terrain and land-cover grids for the KDFW region.

Sources (both public, read straight from AWS open data):
  * Elevation: Mapzen/Tilezen "terrarium" terrain tiles (USGS 3DEP/NED in the US).
  * Land cover: ESA WorldCover 10 m 2021 v200 (CC BY 4.0), cloud-optimized GeoTIFFs.

Outputs (in public/data/):
  terrain_wide.dat, terrain_metro.dat   int16 heights (0.25 m units), gzip
  landcover_wide.dat, landcover_metro.dat  uint8 class index, gzip
  world.json   grid metadata (bounds, steps, sizes, class table)

Usage:  python3 tools/build_terrain.py   (needs numpy, pillow, rasterio)
"""
import concurrent.futures as cf
import gzip
import io
import json
import math
import os
import ssl
import sys
import urllib.request

import numpy as np
from PIL import Image

OUT = os.path.join(os.path.dirname(__file__), '..', 'public', 'data')
HOME = {'icao': 'KDFW', 'lat': 32.89723305, 'lon': -97.03769472}

# Whole scenery region: Oklahoma City to Austin/Houston, Abilene to Texarkana's west.
WIDE = {'south': 29.8, 'north': 35.6, 'west': -100.0, 'east': -94.2}
# High-resolution Dallas-Fort Worth metroplex box.
METRO = {'south': 32.35, 'north': 33.45, 'west': -97.75, 'east': -96.35}

WIDE_DEM_STEP = 0.004      # ~440 m N-S
METRO_DEM_STEP = 0.001     # ~110 m
WIDE_LC_STEP = 0.002       # ~220 m
METRO_LC_STEP = 0.00035    # ~39 m

# ESA WorldCover class codes -> compact index used by the shader.
CLASSES = [
    (0, 'none'), (10, 'tree'), (20, 'shrub'), (30, 'grass'), (40, 'crop'), (50, 'built'),
    (60, 'bare'), (70, 'snow'), (80, 'water'), (90, 'wetland'), (95, 'mangrove'), (100, 'moss'),
]
CODE_TO_INDEX = np.zeros(256, dtype=np.uint8)
for i, (code, _) in enumerate(CLASSES):
    CODE_TO_INDEX[code] = i

CTX = ssl.create_default_context()


def fetch(url, tries=4):
    for k in range(tries):
        try:
            with urllib.request.urlopen(url, context=CTX, timeout=60) as r:
                return r.read()
        except Exception as e:  # noqa: BLE001 - retry any transient failure
            if k == tries - 1:
                raise
            print(f'  retry {url}: {e}', file=sys.stderr)


def merc_px(lat, lon, z):
    n = 256 * 2 ** z
    x = (lon + 180) / 360 * n
    y = (1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2 * n
    return x, y


def terrarium_mosaic(box, z):
    """Download terrarium tiles covering box at zoom z; return (heights, x0px, y0px)."""
    x0, y1 = merc_px(box['south'], box['west'], z)
    x1, y0 = merc_px(box['north'], box['east'], z)
    tx0, tx1 = int(x0 // 256), int(x1 // 256)
    ty0, ty1 = int(y0 // 256), int(y1 // 256)
    w = (tx1 - tx0 + 1) * 256
    h = (ty1 - ty0 + 1) * 256
    mosaic = np.zeros((h, w), dtype=np.float32)
    jobs = [(tx, ty) for ty in range(ty0, ty1 + 1) for tx in range(tx0, tx1 + 1)]
    print(f'  terrarium z{z}: {len(jobs)} tiles')

    def get(job):
        tx, ty = job
        data = fetch(f'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{tx}/{ty}.png')
        img = np.asarray(Image.open(io.BytesIO(data)).convert('RGB'), dtype=np.float32)
        return job, img[..., 0] * 256 + img[..., 1] + img[..., 2] / 256 - 32768

    with cf.ThreadPoolExecutor(16) as ex:
        for (tx, ty), hgt in ex.map(get, jobs):
            mosaic[(ty - ty0) * 256:(ty - ty0 + 1) * 256, (tx - tx0) * 256:(tx - tx0 + 1) * 256] = hgt
    return mosaic, tx0 * 256, ty0 * 256


def sample_grid(box, step, z):
    mosaic, ox, oy = terrarium_mosaic(box, z)
    rows = int(round((box['north'] - box['south']) / step)) + 1
    cols = int(round((box['east'] - box['west']) / step)) + 1
    lats = box['south'] + np.arange(rows) * step
    lons = box['west'] + np.arange(cols) * step
    n = 256 * 2 ** z
    px = (lons + 180) / 360 * n - ox - 0.5
    py = (1 - np.arcsinh(np.tan(np.radians(lats))) / np.pi) / 2 * n - oy - 0.5
    X, Y = np.meshgrid(px, py)
    x0 = np.clip(np.floor(X).astype(int), 0, mosaic.shape[1] - 2)
    y0 = np.clip(np.floor(Y).astype(int), 0, mosaic.shape[0] - 2)
    fx = X - x0
    fy = Y - y0
    a = mosaic[y0, x0]
    b = mosaic[y0, x0 + 1]
    c = mosaic[y0 + 1, x0]
    d = mosaic[y0 + 1, x0 + 1]
    hgt = (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy
    return despike(hgt), rows, cols


def despike(h):
    """Replace data voids / spikes (> 120 m from the 3x3 median) with that median."""
    p = np.pad(h, 1, mode='edge')
    stack = np.stack([p[1 + dy:p.shape[0] - 1 + dy, 1 + dx:p.shape[1] - 1 + dx]
                      for dy in (-1, 0, 1) for dx in (-1, 0, 1)])
    med = np.median(stack, axis=0)
    bad = (np.abs(h - med) > 120) | (h < -5)
    print(f'  despiked {int(bad.sum())} samples')
    return np.maximum(np.where(bad, med, h), 0)


def landcover_grid(box, step):
    import rasterio
    from rasterio.enums import Resampling
    from rasterio.windows import from_bounds

    rows = int(round((box['north'] - box['south']) / step))
    cols = int(round((box['east'] - box['west']) / step))
    out = np.zeros((rows, cols), dtype=np.uint8)
    lat_tiles = range(int(math.floor(box['south'] / 3) * 3), int(math.ceil(box['north'] / 3) * 3), 3)
    lon_tiles = range(int(math.floor(box['west'] / 3) * 3), int(math.ceil(box['east'] / 3) * 3), 3)
    for la in lat_tiles:
        for lo in lon_tiles:
            name = f'N{la:02d}W{-lo:03d}'
            url = ('/vsicurl/https://esa-worldcover.s3.eu-central-1.amazonaws.com/v200/2021/map/'
                   f'ESA_WorldCover_10m_2021_v200_{name}_Map.tif')
            s = max(box['south'], la)
            n = min(box['north'], la + 3)
            w = max(box['west'], lo)
            e = min(box['east'], lo + 3)
            if s >= n or w >= e:
                continue
            r0 = int(round((s - box['south']) / step))
            r1 = int(round((n - box['south']) / step))
            c0 = int(round((w - box['west']) / step))
            c1 = int(round((e - box['west']) / step))
            print(f'  worldcover {name}: rows {r0}-{r1} cols {c0}-{c1}')
            with rasterio.open(url) as ds:
                win = from_bounds(w, s, e, n, transform=ds.transform)
                arr = ds.read(1, window=win, out_shape=(r1 - r0, c1 - c0), resampling=Resampling.mode)
            # Raster rows run north->south; our grid rows run south->north.
            out[r0:r1, c0:c1] = CODE_TO_INDEX[arr[::-1, :]]
    return out, rows, cols


def write_gz(name, arr):
    path = os.path.join(OUT, name)
    with open(path, 'wb') as f:
        f.write(gzip.compress(arr.tobytes(), 9))
    print(f'  wrote {name}: {os.path.getsize(path) / 1e6:.2f} MB')


def main():
    os.makedirs(OUT, exist_ok=True)
    os.environ.setdefault('GDAL_DISABLE_READDIR_ON_OPEN', 'EMPTY_DIR')
    meta = {'home': HOME, 'sources': {
        'elevation': 'Tilezen terrarium terrain tiles (USGS 3DEP/NED), AWS Open Data',
        'landcover': 'ESA WorldCover 10m 2021 v200, CC BY 4.0 (c) ESA WorldCover project / Contains modified Copernicus Sentinel data (2021)',
    }, 'classes': [c[1] for c in CLASSES]}

    print('wide terrain')
    hgt, rows, cols = sample_grid(WIDE, WIDE_DEM_STEP, 10)
    write_gz('terrain_wide.dat', np.round(hgt * 4).astype('<i2'))
    meta['terrainWide'] = {**WIDE, 'step': WIDE_DEM_STEP, 'rows': rows, 'cols': cols, 'scale': 0.25}

    print('metro terrain')
    hgt, rows, cols = sample_grid(METRO, METRO_DEM_STEP, 11)
    write_gz('terrain_metro.dat', np.round(hgt * 4).astype('<i2'))
    meta['terrainMetro'] = {**METRO, 'step': METRO_DEM_STEP, 'rows': rows, 'cols': cols, 'scale': 0.25}

    print('wide land cover')
    lc, rows, cols = landcover_grid(WIDE, WIDE_LC_STEP)
    write_gz('landcover_wide.dat', lc)
    meta['landcoverWide'] = {**WIDE, 'step': WIDE_LC_STEP, 'rows': rows, 'cols': cols}

    print('metro land cover')
    lc, rows, cols = landcover_grid(METRO, METRO_LC_STEP)
    write_gz('landcover_metro.dat', lc)
    meta['landcoverMetro'] = {**METRO, 'step': METRO_LC_STEP, 'rows': rows, 'cols': cols}

    with open(os.path.join(OUT, 'world.json'), 'w') as f:
        json.dump(meta, f, indent=1)
    print('done')


if __name__ == '__main__':
    main()
