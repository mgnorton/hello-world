# Skyline 737 — a Boeing 737-900 flight simulator

A browser flight simulator in the spirit of Infinite Flight, built around operating
one aircraft properly: the **Boeing 737-900** with CFM56-7B27 engines. It runs entirely
client-side (no build step, no server code) with a vendored copy of three.js.

## Running it

ES modules need to be served over HTTP (opening `index.html` from disk won't work):

```bash
cd b737sim
python3 -m http.server 8000
# then open http://localhost:8000
```

Any static host works too (GitHub Pages, Netlify, `npx serve`, …). Everything, including
three.js, is in this folder, so it also works offline.

Requires a WebGL-capable browser (Chrome, Edge, Firefox, Safari). Desktop gives the full
experience; phones and tablets get a touch stick and a compact layout.

## What's in it

**Flight model** (`js/fdm.js`)
- Six-degree-of-freedom rigid body integrated at 240 Hz.
- Stability-derivative aerodynamics with per-flap-detent lift/drag/pitching moment
  (UP, 1, 2, 5, 10, 15, 25, 30, 40), stall and post-stall with wing drop, ground effect,
  Mach-dependent buffet margin and wave drag, gear and speedbrake drag, yaw damper.
- CFM56-7B27 model: spool-up lag, thrust lapse with altitude and Mach, EGT, N2, fuel flow
  from TSFC, thrust reversers, engine failures; fuel burn reduces weight.
- Spring/damper landing gear with tyre friction, nosewheel steering (tiller at low speed,
  pedals at speed), differential and parking brakes, anti-skid braking and autobrakes
  (RTO, 1, 2, 3, MAX), auto speedbrake deployment on touchdown/RTO.
- Tail-strike, engine-pod, wingtip, belly and water contact detection; hard landing /
  over-g / overspeed structural limits.
- Tuned to real numbers: V-speeds from weight, ~8° liftoff attitude, ~2–3° approach
  pitch at Vref30, ~2,300 kg/h at FL350 M0.78.

**Autopilot / autothrottle** (`js/autopilot.js`) — 737NG MCP logic:
HDG SEL, HDG HOLD, LNAV, VOR/LOC, APP (G/S), ALT HOLD / ALT ACQ, V/S, LVL CHG (speed on
pitch), TO/GA (takeoff and go-around), automatic IAS/Mach changeover, **autoland**
(LAND 3 annunciation, flare, retard, rollout on the centerline), A/T modes N1,
MCP SPD, RETARD, THR HLD, ARM. Flight director bars when the AP is off.

**Glass cockpit** (`js/ui/instruments.js`)
- PFD: attitude, flight path vector, FD, speed tape with V1/VR/V2/REF and flap-maneuver
  bugs, trend vector, barber poles (Vmo/Mmo/flap/gear placards, stick-shaker and
  minimum-maneuver speeds), altitude tape with selected-altitude bug, VSI, heading arc,
  FMA, ILS localizer and glideslope deviation, radio altitude.
- ND: map mode with the flight plan, airports and runways, localizer course, wind,
  GS/TAS, next waypoint/ETA, 5–320 nm ranges (also a full-screen map).
- EICAS: N1/EGT dials with thrust-lever command markers, N2, fuel flow, fuel quantity,
  gross weight, stab trim, gear, flaps and system status messages.

**Warnings and sound** (`js/sim.js`, `js/audio.js`) — synthesised engine roar, fan
whine and buzz-saw, wind and runway rumble, stick shaker, overspeed clacker, takeoff
config horn, AP-disconnect wailer, and voice callouts: 80 knots, V1, rotate, positive
rate, 2500 … 10, minimums, retard, sink rate, pull up, terrain, too low gear/flaps,
glideslope, bank angle.

**World** (`js/render/`)
- 20 major airports (approximate layouts) with runway markings, taxiways, apron,
  terminal and tower, edge/centerline/TDZ lights, ALSF approach lights with sequenced
  flashers and working PAPIs.
- Procedural LOD terrain with water, forest, rock and snow; approach corridors kept clear.
- Time of day (sun, sky, stars, night lighting, lit cabin windows), clouds you can fly
  into, visibility, wind with altitude, gusts and turbulence.
- Detailed procedural 737-900 model: winglets, CFM56 nacelles with spinning fans,
  Fowler flaps, slats, spoilers, ailerons, elevators, rudder, reversers, retracting
  gear, nav/strobe/beacon/landing lights.
- Cameras: cockpit (with live screens), chase, external orbit, tower, fly-by, wing.

**Game flow** — pick departure/arrival airports and runways, start lined up, on a
13 nm ILS final, on 5 nm short final, or in cruise; set passengers and fuel (weights
and V-speeds are computed), weather and time; receive a landing report (vertical
speed, g, touchdown point, centerline offset). Failures can be triggered from the
pause menu.

## Controls

| Key | Action |
| --- | --- |
| Arrow Up / Down | Pitch (nose down / nose up) |
| Arrow Left / Right | Roll (also steers the nosewheel when slow on the ground) |
| Z / X | Rudder & nosewheel steering |
| + / − , PgUp / PgDn | Throttle |
| Shift+T | TO/GA |
| R | Thrust reversers (on the ground) |
| [ / ] or F6 / F7 | Flaps up / down |
| G | Gear |
| / | Speedbrake (down → flight detent → up), K arms it |
| B (hold) / Shift+B | Brakes / parking brake |
| J | Autobrake (RTO, OFF, 1, 2, 3, MAX) |
| Home / End | Stab trim nose down / nose up |
| A, T | Autopilot CMD, autothrottle |
| H, N, L, V, O, M | HDG SEL, LNAV, LVL CHG, V/S, ALT HOLD, APP |
| Ctrl + arrows, Ctrl + PgUp/PgDn | MCP heading / altitude / speed |
| C / Shift+C | Cycle cameras; right-drag to look, wheel to zoom |
| Y | Mouse yoke (hold left button) |
| I | Instruments size / hide |
| P or Esc | Pause menu |
| < / > | Simulation rate (0.5×–4×) |

Gamepads use the standard mapping (left stick flies, right stick X rudder, triggers
throttle, bumpers flaps, A gear, B brakes, X autopilot, Y camera). Joysticks with a
throttle lever are detected automatically. On touch screens use the on-screen stick and
the throttle/flap levers.

### A first flight

1. Start "Lined up on the departure runway". Release the parking brake (**Shift+B**).
2. Press **Shift+T** (TO/GA): the autothrottle sets takeoff thrust.
3. At **VR** (the "rotate" callout) pull back smoothly to ~15° nose up, following the
   magenta flight director.
4. After "positive rate", raise the gear (**G**). Retract flaps on the speed-tape bugs.
5. Engage the autopilot (**A**), **LNAV** (N) and **LVL CHG** (L) — it climbs along the
   route to the MCP altitude. Use LVL CHG or V/S with a lower MCP altitude to descend.
6. Near the destination, press **APP** (M). Configure: flaps 30, gear down, speedbrake
   armed (K), autobrake 2, MCP speed Vref+5. The autopilot can land the aircraft; or
   disconnect (A) and hand-fly using the PAPI and ILS.

## Code layout

```
b737sim/
  index.html, css/style.css     UI shell
  js/math.js                    vectors, quaternions, units
  js/atmosphere.js              ISA, airspeed conversions, wind & turbulence
  js/aircraftData.js            737-900 data, flap table, V-speeds
  js/fdm.js                     flight dynamics, engines, gear, brakes, systems
  js/autopilot.js               AFDS and autothrottle
  js/navigation.js              airports, runways, ILS, flight plan, projection
  js/terrain.js                 procedural terrain shared by physics and graphics
  js/sim.js                     simulation session, scenarios, warnings, landing reports
  js/audio.js                   Web Audio synthesis and speech callouts
  js/render/                    three.js world, airports, aircraft model, cameras
  js/ui/                        PFD/ND/EICAS displays and input devices
  js/main.js                    app glue, menus, HUD, render loop
  js/vendor/three.module.min.js three.js r160 (MIT)
  tests/flight-tests.mjs        headless flight tests
```

The simulation core (`fdm`, `autopilot`, `sim`, …) has no browser dependencies, so it
can be flown headlessly:

```bash
node b737sim/tests/flight-tests.mjs      # add -v for a flight log
```

The tests fly an autoland at KPDX, a takeoff and LNAV/LVL CHG climb from KSEA, cruise
Mach/altitude hold with fuel-burn checks, a descent with altitude capture, a HDG SEL
turn and a hands-off stability check.

## Disclaimer

For entertainment and learning only — not for real-world flight training. Aircraft
performance, airport layouts and procedures are approximations. "Skyline" is a
fictional airline.
