/**
 * CRANK stall bench — dev harness, not shipped.
 *
 * WHY IT EXISTS
 *   The owner reports the sound snatching exactly when the car has to draw the
 *   Autopilot visualisation, and describes the artefact precisely: the feel of
 *   dragging a record needle back and forth. That is a LEVEL discontinuity, and
 *   until now nothing here could produce one on demand.
 *
 *   What a busy MCU does to this engine is starve the 20 ms control interval.
 *   No parameter moves for a while, then one tick arrives carrying all of the
 *   elapsed time at once. That is entirely a matter of WHEN _tick is called and
 *   with what dt — so an offline render, where both can be dictated, reproduces
 *   it exactly. No car, no Autopilot, no waiting for it to happen.
 *
 * FAITHFUL IN THE DETAIL THAT MATTERS
 *   The dt clamp lives in the setInterval callback, not in _tick, and it
 *   DISCARDS any dt over 250 ms in favour of the nominal interval. So a 300 ms
 *   stall does not hand the model 300 ms of road; it hands it one ordinary tick
 *   and leaves the model a third of a second behind, which it then closes at
 *   whatever rate the caps allow. Both halves are reproduced below, or these
 *   numbers would be describing a different bug.
 *
 * USAGE, in the page console:
 *   const sb = await import('/vessel/tools/crank-stall-bench.js');
 *   await sb.stallSweep();                 // the table the ceiling came from
 *   await sb.stallSweep('civic-crank');
 *   await sb.repeatability();              // what the render noise actually is
 */

import { CrankAudio } from '/js/crank-audio.js';
import { getProfileById } from '/js/profiles.js';

const SR = 48000;

/** Short-window envelope of a rendered buffer, in dB. */
function envelopeDb(ch, sr, winMs) {
  const win = Math.max(1, Math.round((sr * winMs) / 1000));
  const out = new Float32Array(Math.floor(ch.length / win));
  for (let w = 0; w < out.length; w++) {
    let acc = 0;
    for (let q = w * win; q < (w + 1) * win; q++) acc += ch[q] * ch[q];
    out[w] = 20 * Math.log10(Math.max(1e-7, Math.sqrt(acc / win)));
  }
  return out;
}

/**
 * Render a steady drive punctuated by tick starvation.
 *
 *   stallMs  how long the control thread goes away for
 *   everyS   how often that happens
 *   cap      level ceiling in dB/s; null = the shipped const, 0 = guard off
 */
export async function stallRender(profileId = 'jz-crank', {
  secs = 24, stallMs = 220, everyS = 3, cap = null, seed = 1,
} = {}) {
  const profile = getProfileById(profileId);
  if (!profile || !profile.crank) throw new Error(`not a CRANK profile: ${profileId}`);
  const oc = new OfflineAudioContext(2, Math.round(SR * secs), SR);
  const audio = new CrankAudio();
  audio.setProfile(profile);
  await audio.start({ ctx: oc, manualTick: true });
  audio.setMasterVolume?.(0.8);
  if (cap != null) audio._levelCeilDbPerSec = cap;

  const STEP = 1024;                    // 21.3 ms against the engine's own 20
  const tickS = STEP / SR;
  const stallAt = [];
  for (let x = 2; x < secs - 1; x += everyS) stallAt.push(x);

  // Deterministic road, driven the way the owner drives, so that two caps are
  // compared on the same metre of tarmac rather than on two different drives.
  let rnd = seed;
  const noise = () => {
    rnd = (rnd * 1103515245 + 12345) & 0x7fffffff;
    return rnd / 0x7fffffff - 0.5;
  };

  let owed = 0;
  const ticks = [];
  for (let f = 0; f + STEP <= SR * secs; f += STEP) {
    const t = f / SR;
    oc.suspend(t).then(() => {
      const inStall = stallAt.some((x) => t >= x && t < x + stallMs / 1000);
      // Speed keeps arriving throughout. app.js writes it from the GPS
      // listener; it is only the ENGINE tick that the busy MCU stops.
      const kmh = 55 + 14 * Math.sin(t * 0.55) + noise() * 0.6;
      const acc = 7.7 * Math.cos(t * 0.55) + noise() * 0.4;
      audio.setSpeed(Math.max(0, kmh), {
        throttle: Math.max(0, Math.min(1, 0.3 + acc / 12)),
        brake: 0,
        accelKmhps: acc,
      });
      owed += tickS;
      if (inStall) { oc.resume(); return; }        // the tick simply never ran
      let dt = owed;
      if (!(dt > 0) || dt > 0.25) dt = (audio.tickMs || 20) / 1000;
      owed = 0;
      audio._tick(dt);
      // The LEVEL trajectory, read straight off the params.
      //
      // The first cut measured the acoustic envelope in 10 ms windows and the
      // numbers were nonsense: at 2000 rpm the crank fundamental is 16.7 Hz,
      // a 60 ms period, so a 10 ms window measures individual combustion
      // pulses rather than the envelope riding on them. It reported the same
      // 6 dB "jump" inside a stall and outside one, because both were just the
      // engine firing. Measure the thing the guard actually controls instead:
      // the gain values the tick delivers.
      const vv = audio._voices[audio._active];
      const n = audio._nodes;
      ticks.push({
        t,
        dt,
        hz: vv.oscL.frequency.value,
        rpm: audio.rpm,
        lvl: n.dynGain.gain.value * (
          vv.exhaustGain.gain.value + vv.intakeGain.gain.value
          + vv.combGain.gain.value + vv.mechGain.gain.value + vv.turboGain.gain.value),
      });
      oc.resume();
    });
  }
  const buf = await oc.startRendering();
  audio.running = false;
  return { buf, ticks, stallAt, stallMs };
}

/**
 * THE RECORD-NEEDLE METRIC.
 *
 * A snatch is a level discontinuity, so measure exactly that — but measure it
 * on the LEVEL, not on the waveform. See the note at the tick loop for why an
 * acoustic envelope cannot answer this: below about 100 ms the window is
 * shorter than the engine's own firing period, so it reads combustion pulses
 * and calls them jumps. The gain trajectory has no such floor, and it is
 * precisely what the ceiling in crank-audio.js governs.
 *
 * Reported separately for the moments just after a stall ends and for the rest
 * of the drive, because a guard that simply flattened the whole engine would
 * otherwise look like a success.
 */
export function scratchOf({ ticks, stallAt, stallMs }, { afterS = 0.45 } = {}) {
  const inWindow = (t) => stallAt.some((x) => {
    const end = x + stallMs / 1000;
    return t >= end - 0.05 && t < end + afterS;
  });
  let worstStall = 0;
  let worstElse = 0;
  let worstSt = 0;
  const jumps = [];
  for (let k = 1; k < ticks.length; k++) {
    const a = ticks[k - 1];
    const b = ticks[k];
    const dt = b.t - a.t;
    if (dt <= 0 || b.t < 1.5) continue;
    const db = Math.abs(20 * Math.log10(Math.max(1e-5, b.lvl) / Math.max(1e-5, a.lvl)));
    if (Number.isFinite(db)) {
      if (inWindow(b.t)) { jumps.push(db); if (db > worstStall) worstStall = db; }
      else if (db > worstElse) worstElse = db;
    }
    const st = Math.abs(12 * Math.log2(Math.max(1e-6, b.hz) / Math.max(1e-6, a.hz)));
    if (st / dt > worstSt) worstSt = st / dt;
  }
  jumps.sort((x, y) => x - y);
  return {
    // The single worst level step delivered after a stall, in dB. This is the
    // needle drag: how far the loudness moves in one automation ramp.
    scratchDb: +worstStall.toFixed(2),
    scratchP90: +(jumps.length ? jumps[Math.floor(jumps.length * 0.9)] : 0).toFixed(2),
    // The same measurement away from any stall. If the guard is working, the
    // two converge; if they were always equal, the stall was never the cause.
    baselineDb: +worstElse.toFixed(2),
    pitchStPerSec: +worstSt.toFixed(1),
  };
}

/**
 * HOW MUCH OF THE REAL DRIVE THE CEILING COSTS.
 *
 * The other side of the trade, and the only reason not to set the cap at
 * 1 dB/s and go home. A rate limit cannot tell a glitch from a driver lifting
 * off. Squeeze it far enough and a lift stops dropping, a shift stops ducking,
 * and the engine becomes a drone — smooth precisely because it has stopped
 * responding to the road. That is the OTHER way to sound broken.
 *
 * rangeDb is the distance from the quietest cruise to the loudest pull. If the
 * ceiling is doing damage, this is where it shows first.
 */
export function dynamicsOf({ buf }) {
  const db = envelopeDb(buf.getChannelData(0), SR, 200);
  const live = [];
  for (let w = Math.round(1500 / 200); w < db.length; w++) if (db[w] > -70) live.push(db[w]);
  live.sort((a, b) => a - b);
  const at = (p) => live[Math.min(live.length - 1, Math.floor(live.length * p))];
  return { rangeDb: +(at(0.95) - at(0.05)).toFixed(2), p50Db: +at(0.5).toFixed(2) };
}

/**
 * The render is not deterministic — the engine breathes on Math.random() for
 * rev wander, idle hunt and pops. Run the SAME cap twice and the spread is the
 * floor under every other number in the sweep. Read this before believing a
 * small rangeLost.
 */
export async function repeatability(profileId = 'jz-crank', cap = null, n = 4) {
  const rows = [];
  for (let k = 0; k < n; k++) {
    const r = await stallRender(profileId, { cap, seed: 1 });
    rows.push({ run: k, ...scratchOf(r), ...dynamicsOf(r) });
  }
  const span = (key) => +(Math.max(...rows.map((r) => r[key])) - Math.min(...rows.map((r) => r[key]))).toFixed(2);
  const out = { rows, spread: { scratchDb: span('scratchDb'), rangeDb: span('rangeDb'), p50Db: span('p50Db') } };
  console.table(rows);
  console.log('spread of identical settings:', out.spread);
  return out;
}

/**
 * The sweep the ceiling's value came from.
 *
 *   await sb.stallSweep();
 *
 * Row `off` is the guard disabled — what shipped before it existed. Pick the
 * TIGHTEST cap whose rangeLost is still inside the spread that repeatability()
 * reports, because that is the most guard available for no cost to the drive.
 */
export async function stallSweep(profileId = 'jz-crank', caps = [0, 240, 160, 120, 96, 72, 48, 24, 12]) {
  const rows = [];
  for (const cap of caps) {
    const r = await stallRender(profileId, { cap });
    rows.push({ cap: cap === 0 ? 'off' : cap, ...scratchOf(r), ...dynamicsOf(r) });
  }
  const off = rows[0];
  for (const r of rows) {
    r.scratchCut = +(off.scratchDb - r.scratchDb).toFixed(2);
    r.rangeLost = +(off.rangeDb - r.rangeDb).toFixed(2);
  }
  console.table(rows);
  return rows;
}

export default { stallRender, stallSweep, repeatability, scratchOf, dynamicsOf };
