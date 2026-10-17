# CAN drive input

The page used to poll GPS. It now listens on a WebSocket. A small Node server on the same
network reads the car (or a mock) and pushes JSON. The synthesis is unchanged: `AudioEngine`
still turns **road speed, throttle, brake, and acceleration** into RPM through the profile
gearbox. Nothing in this path writes waveguide lengths, cylinder counts, or tone.

```
adapter (SocketCAN / serial / lines / mock)
        │  CAN frames
        ▼
can/server.mjs  ── decode signals.model3.json ── WebSocket JSON @ 50 Hz
        │
        ▼
js/can-link.js   reconnect + stale timer
        ▼
js/can-map.js    tunable map → { speedKmh, accelKmhps, throttle, brake, rpmProxy }
        ▼
js/app.js        audio.setSpeed(...)
        ▼
AudioEngine / Crank / Vessel / Turbine   (RPM still comes from speed + the profile)
```

`rpmProxy` is the motor/axle speed scaled into a combustion-tach band for the diag line.
It is passed through `setSpeed` extras and **ignored by the synth**. Writing it into `_rpm`
would skip every profile's gearbox.

---

## 1. Run it (no car)

From the repo root, Node 18+:

```bash
node can/server.mjs
```

Then open **http://127.0.0.1:8787/** (or the machine's LAN address). The page sees
`GET /__can/info` and switches itself to CAN. Press **Start**. The mock loop is 20 seconds:
idle, pull to 90 km/h, cruise, regen back to a stop. The speed ring and the engine follow it.

```bash
node can/self-check.mjs    # decode + map + a live mock socket
node can/server.mjs --help
```

Tap the **CAN** chip to fall back to the Sim slider. The server URL is the **CAN server**
field in the tune sheet, `localStorage` key `tas-can-url`, or a query:

| Query | Result |
|---|---|
| `?ws=ws://192.168.1.20:8787` | that socket |
| `?port=8787` | `ws://<page hostname>:8787` (`wss` if the page itself is https) |
| `?can=1` or `?mode=can` | connect on load, even if `/__can/info` is absent |

Default with no query and no saved URL: `ws://<page host>:<page port, or 8787>`.

The socket reconnects on its own (0.4 s, then longer, capped at 8 s). If no JSON arrives for
400 ms (`CAN_STALE_MS` in `js/can-link.js`) the app eases speed and load back to idle instead
of holding the last pull. Those two rates are `CAN_IDLE_SPEED` and `CAN_IDLE_LOAD` in `js/app.js`.

---

## 2. What the JSON looks like

One object per message. Every field is optional; `null` means "not on this bus".

```json
{
  "t": 1710000000000,
  "speedKmh": 48.2,
  "accelMps2": 1.4,
  "accelKmhps": 5.0,
  "pedal": 0.35,
  "brake": 0,
  "regenLight": 0,
  "regen": null,
  "motorRpm": 420,
  "torqueNm": 80,
  "source": "mock"
}
```

`pedal` and `regen` may also be sent as 0..100. `accelKmhps` wins over `accelMps2` when both
are present.

### Mapping (`js/can-map.js`, object `CAN_MAP`)

| Constant | Default | What it does |
|---|---|---|
| `standstillKmh` / `movingKmh` | 0.8 / 1.6 | Parked noise becomes 0. Hysteresis so a crawl does not flicker idle. |
| `wheelCircumferenceM` | 2.06 | Model 3 235/45R18. Used only when there is axle RPM and no vehicle speed. |
| `axleIsMotorShaft` | `false` | The community signal `DI_axleSpeed` is **after** the reduction. Set `true` and `motorGearRatio` (default 9) if your bus reports shaft RPM. |
| `rpmProxyGain` | 4 | Telemetry only. ~650 axle rpm at 80 km/h × 4 ≈ 2600 on a tach. |
| `throttleFromAccelKmhps` | 16 | Pedal missing: this accel is throttle 1.0. |
| `regenFlagFloor` | 0.75 | A regen lamp with no torque magnitude. |
| `regenAccelKmhps` | 14 | Engine-facing decel at regen = 1, **only** when measured accel is not already negative. |
| `regenMinDecelKmhps` | 2 | Real decel more negative than this is kept. The lamp does not invent a harder stop. |
| `regenBrakeScale` | 0.85 | Copied onto `brake`, which crank and vessel already fold into decel. |
| `regenTorqueFullNm` | 120 | Negative torque that counts as regen = 1. |
| `teleportKmh` | 40 | One-sample jump larger than this, above 8 km/h, is clamped. |

Throttle comes from the accelerator pedal when the snapshot has one. Otherwise it is the
positive accel divided by `throttleFromAccelKmhps`.

Regen becomes overrun/decel like this:

- Crank and vessel already do `decelLoad = max(decel from accel, brake × 0.85)`. The mapper
  puts regen on `brake`, so a lift-off reads as overrun on those engines even when the
  accel sample is mild.
- Classic recomputes throttle and brake from acceleration inside the engine (that math was
  not changed). It enters overrun when decel is past about **−10 km/h/s** (`0.38 × accelRef 26`).
  A measured decel is passed through. A regen **lamp with no accel sample** is given
  `−regen × regenAccelKmhps`, which at the defaults crosses that latch. If you want the lamp
  to win even when a mild accel is present, raise `regenMinDecelKmhps`.

---

## 3. The server

`can/server.mjs` serves the static site and the socket on the same port (default **8787**,
bind `0.0.0.0`). `--no-static` is the socket only. `--hz 50` is the push rate: CAN is read
as fast as frames arrive, and the **latest** snapshot is forwarded at `--hz`. 50 matches the
audio clock. Higher is legal (`--hz 100`) but the Tesla MCU does not benefit past the audio tick.

### Sources

| `--source` | What it reads |
|---|---|
| `mock` (default) | The 20 s drive loop, packed through the same signal file as a real bus. |
| `socketcan` | `candump -L <iface>` (`--iface can0`). Needs `can-utils`. No native Node addon. |
| `serial` | A tty (`--device /dev/ttyUSB0 --baud 115200`). `stty` sets raw mode, then lines are parsed. |
| `lines` | A file or stdin (`--file capture.log`, `--file -`). |

### Adapter ("tita" / "Tida")

The transmitter name in the request was unclear, and no vendor protocol is assumed.
`can/parse.mjs` accepts what USB-CAN adapters usually emit:

- SLCAN / Lawicel: `t25780102030405060708`
- candump: `(1234.5) can0 257#0102030405060708`
- plain: `599 AABBCCDD` (digits-only id is decimal; `0x257` or any a–f is hex)
- a JSON snapshot, one object per line

`--parser auto` (default) tries those in that order. A different device gets a new function
in `PARSERS` and `--parser <name>`. Nothing named tita/Tida is hardcoded.

### Signal file — unverified Model 3

`can/signals.model3.json` is a DBC-style table (frame id, start bit, length, factor, offset,
signed). **`verified` is false.** The layouts were copied from community files and have not
been confirmed on this car:

| Signal | Frame | DBC name | Community file |
|---|---|---|---|
| `speedKmh` | 599 | `DI_vehicleSpeed` | onyx-m2 `tesla_model3.dbc` — 12 bits at bit 12, ×0.08 − 40, km/h |
| `pedalPct` | 280 | `DI_accelPedalPos` | `tesla_model3_vehicle.dbc` — bit 32, ×0.4 percent. Raw 255 is SNA. |
| `regenLight` | 280 | `DI_regenLight` | bit 26 |
| `brakeState` | 280 | `DI_brakePedalState` | bit 19, 0 off / 1 on |
| `motorRpm` | 264 | `DI_axleSpeed` | ×0.1 RPM, **axle after the gear reduction**, not shaft RPM |
| `torqueNm` | 264 | `DI_torqueActual` | ×2 Nm, negative = regen |
| `accelMps2` | 273 | `RCM_longitudinalAccel` | bit 0, signed ×0.00125 m/s² |

Model S `tesla_can.dbc` uses different ids for similar names. Do not mix the files.
Edit the JSON; the server does not hardcode frame ids. Intel (`@1`) bit numbering: start bit
is the least significant bit.

---

## 4. Point the Tesla browser at it

The car and the computer running `node can/server.mjs` must be on the same network
(the car's Wi-Fi, or a phone hotspot both have joined). Find the computer's address
(`ip addr`, or the Windows script in `serve.bat` prints one) and in the Tesla browser open:

```
http://192.168.1.20:8787/
```

Use the **http** address the server prints, not the GitHub Pages https URL.

Press **Start** once (the browser will not start audio without a tap). The CAN chip should
read **CAN Live** and the speed ring should move with the car, or with the mock if that is
the source. Drive lock still blanks the other controls while `speed > 0`; it releases after
about 3 seconds stopped. Push-to-start always works.

### https, ws, and wss

The Tesla browser is Chromium. A page loaded over **https** (GitHub Pages, any TLS host)
will **refuse `ws://`**. That is mixed content: a secure page is not allowed to open a
cleartext socket, so the chip sits on **CAN Error** and the toast says to open the local
http page instead. There is no client-side workaround.

| Page | Socket that works |
|---|---|
| `http://192.168.1.20:8787/` (this server) | `ws://192.168.1.20:8787/` on the same port |
| `https://…github.io/…` | does **not** work with `ws://` to the car |
| `https://…` and a TLS reverse proxy on the socket | `wss://that-host/` only |

If you later put the server behind TLS, set the tune-sheet URL to `wss://…` (or open the
page itself from that https origin so the default scheme follows the page). Until then,
bookmark `http://<lan-ip>:8787/` in the car. The service worker does not register on
`localhost`, but it does on a LAN IP; the cache name is bumped when the shell changes so
the car picks up the new scripts on the next online load.

The server binds the whole interface and has no authentication. Run it on a network you
trust. It is not a cloud service.

---

## 5. Waveguide length and cylinder count (do not retune here)

This section is how to tune **later**, in a profile, for tire and wind noise in the cabin.
The numbers below are the ones in the tree today. This change does not edit them.

Road noise in the Tesla cabin is mostly a broadband rumble from about 80 Hz to 400 Hz that
gets louder with speed. A pipe note that lands in that band disappears into the road; a note
above it reads as exhaust.

Length becomes a delay at `SPEED_OF_SOUND = 343` m/s in `js/dsp/waveguide.js`
(`meters / 343`, one way). The quarter-wave you hear is about `343 / (4 × length)`.

### Classic (`AudioEngine._waveguideOptsFromProfile`)

These lengths are **constants in `js/audio-engine.js`**, not fields in the classic JSON.
The mix and the cylinder count are:

| Knob | Where | Today |
|---|---|---|
| Cylinder count | `engine.cylinders` in `assets/classic/{id}.classic.json` (`CLASSIC_LIMITS` 0..16, `assets/classic/fields.json`) | per profile |
| Waveguide on/off and wet mix | `tone.waveguide` 0..1. **0 means the worklet is not loaded.** | off unless the profile sets it |
| Intake length | `intakeLenM` | 0.38 m → ~226 Hz |
| Primary / header | `exhaustLenM` | 0.55 m → ~156 Hz (inside road noise; the upper harmonics are what cut through) |
| Extractor | `extractorLenM` | 0.42 m |
| Tailpipe | `straightPipeLenM` | 1.05 m → ~82 Hz (cabin boom, easy to lose under the road) |
| Crank spacing | equal steps `i / cylinders` | — |

`CompactWaveguideEngine` in `js/dsp/waveguide.js` uses 0.35 / 0.55 / 0.4 / 1.1 m if a length
is omitted. The procedural firing rate also uses the cylinder count:
`(pitchRpm / 60) × (cylinders / 2)` for a four-stroke. That is identity, not a cabin trim.

### VESSEL

Only if `synthesis.waveguide` is true. Lengths come from the rig, in metres (or mm ÷ 1000):

- `pipe.intakeLenM`, or `engine.intake_len`
- `pipe.exhaustLenM`, or `engine.header_len_prim`
- `pipe.extractorLenM`
- `pipe.tailpipeLenM` or `pipe.straightPipeLenM`, or `engine.tailpipe_len`
- wet gain: `synthesis.waveguideGain` (default 0.28)

Cylinder count is the engine definition in the rig, not a Classic JSON field.

### How to sit above road noise

Change a **profile** (or, for the classic lengths, add a real field and validate it — do not
silently edit the constants in `update()`).

- A **shorter header** (`exhaustLenM` toward ~0.4 m) moves the scavenge note up, out of the
  tire band. A long-tube header (~0.8 m) sits deeper in the rumble.
- A **shorter tail** (`straightPipeLenM`) lifts the boom off the cabin's low resonance.
  Longer makes it louder in the same band as the road and easier to mistake for drone.
- **More cylinders** raise the firing frequency at the same RPM, which also climbs out of
  the rumble. That changes which engine the profile is. Use it only when the profile is
  supposed to be that engine.
- **`tone.waveguide`** is the wet mix. In a loud cabin a higher mix is what makes the pipe
  audible; too high and it covers the rest of the synth. Tune per card.
- `exhaustLpfHz` on the classic path is derived from `tone.filterRedline` and capped at
  1400 Hz. A lower cutoff gets dull and sinks under road noise. If that needs to move,
  it belongs in the profile, not as a hidden clamp.

Do not change `SPEED_OF_SOUND` to tune pitch. Change the length.
