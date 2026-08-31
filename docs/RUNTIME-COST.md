# TAS Runtime cost audit (why “just tuning” is not enough)

User report: stutter **and** GPS speed lagging the real car.  
That pattern is **system load / stacked smoothing**, not only Classic JSON fields.

## Things that were “off” but still burning CPU

| Feature | How it looked “off” | Real cost |
|---------|---------------------|-----------|
| **Waveguide worklet** | `tone.waveguide: 0` / gain 0 | Still **loaded on every AudioEngine.init** and **process() every sample** (mix only scales output) |
| **50 Hz update loop** | Engine not “driving” | Started at **init**, not only while `running` |
| **VesselAudio import** | Classic-only Online set | Static import of `vessel-audio.js` on every boot |
| **Stacked GPS EMA** | “Anti-stutter” | geo EMA × app lag × audio lag → **speed trails car** |

## Features that stay (always-on cost — known)

| Piece | Note |
|-------|------|
| HRTF rear + Convolver reverb | Day-1 Classic path; not removed this pass |
| compressor + dynGain + limiter | Dyn model chain |
| 5-speed gearbox | Physics, not profile |

## Cleanups applied (tas-v38)

1. **Waveguide lazy + dispose** — create only if `tone.waveguide > 0`; full disconnect when off  
2. **Update loop only while running**  
3. **`vessel-rigs.js`** + dynamic `import('./vessel-audio.js')` for VESSEL cards only  
4. **Revert multi-layer GPS lag** — track real speed again (light filters only)  

## CRANK, 2026-08-31 — the rule broken again, in the newest engine

Owner report: the sound snatches exactly when the car has to draw the Autopilot
visualisation. Measured with `vessel/tools/crank-load-bench.js` (real graph on an
OfflineAudioContext; the render's wall-clock time IS the DSP cost).

CRANK builds its engine voice **twice**, A and B, so a card change can crossfade
instead of clicking. Both were connected and both rendered every quantum — five
oscillators, a 2x oversampled shaper, seven filters, a delay and two panners —
into a gain node whose value was the number `0`.

| removed | saved | audible? |
|---|---|---|
| **idle A/B voice** | **16.8%** | **no — it was multiplied by an exact zero** |
| cabin convolver | 20.0% | yes, the tail |
| limiter / density | 6.5 / 6.4% | yes |
| 2x oversample | 5.8% | yes, aliasing |
| rear HRTF panner | 3.1% | yes |
| analyser | 0.4% | (noise) |

Fixed by disconnecting the idle voice and reconnecting it just before a
crossfade. Blink pulls from the destination, so a subtree with no path there is
not processed at all — `disconnect()` is genuinely off, `gain = 0` is not.

Before/after on the same machine, 20 s renders, min of 9, noise ±1.7%:
**759.7 ms → 640.6 ms (26.3x → 31.2x realtime, −15.7%)**, and the bench's own
`no-idle-voice` row then reads −0.4% because there is nothing left to remove.
`offline-bench.compare` against the reconnected graph: every phase `noise`,
0.33 dB overall, against 0.19 dB for identical code compared with itself.

## Rule for future features

> **Disabled must mean not allocated / not processing.**  
> `gain = 0` on a live AudioWorklet is **not** off.  
> Neither is `gain = 0` on a native node. Nor is a spare voice kept warm for a
> crossfade that happens once an hour. If it is not being heard, it must not be
> connected.

See also: `docs/CLASSIC-CONTRACT.md` (profile SoT) vs this file (app/runtime budget).
