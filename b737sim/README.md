# Skyline 737: a Boeing 737-900 simulator based at KDFW

A flight simulator in the spirit of Infinite Flight, built around operating one aircraft
properly, the **Boeing 737-900** (CFM56-7B27), over the **real** Dallas/Fort Worth region:

- **Real geography.** USGS 3DEP elevation and ESA WorldCover 10 m land cover for about
  640 × 540 km of North Texas (Lake Lewisville, Grapevine Lake, the Trinity River, the
  Dallas and Fort Worth skylines, AT&T Stadium), plus every public airport in the region
  from the FAA database.
- **Real navigation aids.** FAA NASR + CIFP (cycle 2026-10-29): VORs, NDBs and DMEs on
  their real frequencies, ILS localizers and glide slopes with their real courses and
  idents, 4,600+ fixes, airways, and the real SIDs, STARs and instrument approaches. The
  FMC builds its route from them, and the radios receive stations by line of sight.
- **Dynamic weather.** Starts from a NOAA HRRR analysis (winds and temperatures aloft,
  clouds, visibility, pressure, reflectivity, CAPE) or a scenario preset, then evolves:
  the pattern drifts with the steering winds, thunderstorms grow, mature and decay,
  throw lightning and microbursts, and pressure and temperature trend. METARs, the ATIS,
  the altimeter, wet runways, icing and windshear alerts all follow it.

Home base is **KDFW**: its 7 runways, ALSF-2/MALSR approach lights, PAPIs, the five
terminals along International Parkway and the real D-ATIS runway flow.

## Testing it

There are three ways, from quickest to most thorough.

1. **Play it in your browser.** A build is published as a private claude.ai artifact:
   <https://claude.ai/artifact/HC8hZgE2G3pZfP7LbBMEQR>. It opens on desktop, tablet or
   phone with nothing to install. It is private to its owner until shared from the page's
   Share menu.
2. **Run it locally** (Node 20+):
   ```bash
   cd b737sim
   npm install
   npm run dev        # builds and serves http://localhost:8000, rebuilding on change
   ```
3. **Automated tests:**
   ```bash
   npm test           # 9 headless flight tests (no browser), under 10 seconds
   npm run typecheck  # strict TypeScript over the whole project
   npm run e2e        # real Chromium: loads the data, flies 8 scenarios, saves screenshots to e2e-shots/
   ```
   The headless tests fly the real procedures: an autoland on ILS 17C at KDFW, a takeoff from
   17R climbing in LNAV/VNAV along the SID, a VNAV descent that must hold the path and the
   MCP floor, a VOR radial intercept on the real Maverick VOR, the hand-flown short final,
   and checks of the data (runway coordinates, ILS frequencies, terrain and lake positions,
   magnetic variation) and of the weather engine (storm life cycle, lightning, microburst
   windshear, METAR). `npm run e2e` needs Playwright with Chromium (`npm i -D playwright`
   and `npx playwright install chromium` if you don't already have it).

## Why TypeScript + WebGL instead of C++ or Unity

You asked for the language best suited to the outcome, and said you were not sold on HTML.
What this project uses is not "an HTML page" but a typed application: about 10,800 lines of
**TypeScript** (strict mode) compiled by esbuild, rendering through **WebGL** with three.js.
HTML is only the 10-line host document and the overlay panels. The reasons:

- **Reach is Infinite Flight's defining feature.** One link runs on Windows, macOS, Linux,
  iPhone, iPad and Android with no install, store review or per-platform build. That is also
  what made it possible to hand you a tested build without access to your machine.
- **Performance is not the bottleneck.** The flight model runs at 240 Hz and costs about
  1 ms per frame in JavaScript's JIT. Frame time is spent on the GPU, where WebGL issues
  the same draw calls a native OpenGL/Metal app would. A native C++ build would win on
  photoreal whole-planet scenery, VR, or cockpit hardware (yokes, MCP panels, motion
  platforms). None of those are needed for a 737 simulator over one region.
- **One language from data to cockpit.** The flight model, autopilot, FMC, weather and
  instruments are plain TypeScript modules with no DOM in them, so the same code runs in the
  browser and in Node for the automated tests. Unity (C#) or Unreal (C++) would split this
  across an engine editor, platform SDKs and a separate test harness.
- **Strict types catch the real bugs.** Units (metres vs feet vs knots), true vs magnetic
  headings and optional data (an ILS that may not exist) are where flight software goes wrong.
  `tsc --strict` checks all of it before anything runs.

If you later want a native desktop build (for hardware panels or VR), the simulation core in
`src/core`, `src/fms`, `src/nav` and `src/weather` has no browser dependencies and can be
embedded in an Electron/Tauri shell, or ported module by module.

## Flying it

The in-app **Controls** button lists every key. The short version:

| Action | Keys |
| --- | --- |
| Pitch / roll / rudder | Arrows, Z / X (or gamepad, joystick, mouse yoke with Y, touch stick) |
| Throttle, TO/GA | + / − or PgUp / PgDn, Shift+T |
| Flaps, gear, speedbrake | [ / ], G, / (K arms it) |
| Brakes, parking brake, autobrake | B (hold), Shift+B, J |
| Autopilot | A (CMD), T (A/T), H (HDG SEL), N (LNAV), Shift+N (VNAV), L (LVL CHG), V (V/S), O (ALT HOLD), M (APP), Shift+M (VOR LOC) |
| MCP heading / altitude / speed | Ctrl + arrows, Ctrl + PgUp / PgDn |
| Altimeter | Q (local QNH), Shift+Q (STD) |
| ND | E / Shift+E range, Ctrl+E MAP/VOR/APP, W weather radar |
| Cameras, pause, sim rate | C / Shift+C, P or Esc, < / > |

On screen: **RADIOS** tunes NAV 1/2 and ADF (with Morse idents), **FMC** shows the route legs
and does direct-to, **WX** shows METARs, the ATIS and nearby storms.

A first flight: release the parking brake (Shift+B), TO/GA (Shift+T), rotate at VR, gear up,
then A, N and Shift+N to fly the real SID in LNAV/VNAV. The pause menu can drop a thunderstorm
30 nm ahead of you.

## Real-world data

All data is in `public/data/` (8 MB, gzip) and is rebuilt by scripts in `tools/`:

| File | Source | Rebuild |
| --- | --- | --- |
| `terrain_*.dat`, `landcover_*.dat`, `world.json` | USGS 3DEP via Tilezen terrain tiles; ESA WorldCover 10 m 2021 (CC BY 4.0) | `npm run data:terrain` (Python: numpy, pillow, rasterio) |
| `navdata.dat` | FAA NASR + CIFP (via the `@squawk/*-data` packages); WMM-2025 magnetic variation | `npm run data:nav` |
| `weather_seed.json` | NOAA HRRR analysis on AWS Open Data | `npm run data:weather` (Python: numpy, eccodes) |

Run `npm run data:weather` before a session to start from the current real weather. The
artifact can't fetch live data from the internet, so it starts from the snapshot in the build
and evolves it. Locally the same script refreshes it.

Approximations, stated plainly: the FAA publishes runways but not taxiway or building
geometry, so taxiways, aprons and hangars are generated from the runway layout (DFW's five
terminals are hand-placed to within about 100 m). City buildings are generated where the
land cover is built-up, with the tall downtown towers placed individually.

## Project layout

```
src/core      flight model, atmosphere, aircraft data, autopilot/autothrottle, warnings, session
src/fms       flight plan from CIFP procedures and airways, VNAV path
src/nav       NAV/ADF receivers (line of sight, real stations)
src/weather   HRRR seed decoding, presets, evolving weather engine, METAR
src/world     projection, magnetic variation, FAA database, terrain/land cover, airport layout
src/render    terrain tiles and land-cover shader, airports and lighting, city, clouds/rain/lightning, aircraft, cameras
src/ui        PFD/ND/EICAS, input, sound
tests         headless flight tests (node:test) and the browser e2e test
tools         esbuild build/dev server/artifact export, data pipeline
legacy-js     the first JavaScript version, kept for reference
```

`npm run artifact` produces `artifact/`, the folder published as the claude.ai link.
