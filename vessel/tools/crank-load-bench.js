/**
 * CRANK audio-thread load bench — dev harness, not shipped.
 *
 * WHY IT EXISTS
 *   The owner reports the sound snatching exactly when the car's MCU has to
 *   draw the Autopilot visualisation. Every instrument this project already has
 *   watches the MAIN thread (tick jitter, tick stalls, fps). None of them can
 *   see the thread that actually makes the sound. So "the MCU is busy" has
 *   never been turned into a number, and every fix for it would be a guess.
 *
 *   This does not need a car. OfflineAudioContext renders the REAL node graph
 *   as fast as the machine can, so the wall-clock time it takes IS the cost of
 *   the DSP — nothing else is in the loop. Render the same graph with one piece
 *   removed and the difference is that piece's price.
 *
 *   That is the input the fix needs: you cannot decide what to shed under load
 *   until you know what each thing costs and what it is worth.
 *
 * WHAT IT IS NOT
 *   Not a quality measurement. It says what a node COSTS, never how it SOUNDS.
 *   Anything this bench says is cheap to remove still has to clear
 *   offline-bench before it can be removed for real. See LAW 7.
 *
 * USAGE, in the page console (any page that can import /js):
 *   const lb = await import('/vessel/tools/crank-load-bench.js');
 *   await lb.costs();                  // ranked table, jz-crank
 *   await lb.costs('civic-crank');
 *   await lb.costs('jz-crank', { secs: 20, repeats: 7 });
 *
 * READING IT
 *   ms        median wall-clock to render `secs` of audio
 *   xRT       how many times faster than real time (higher = cheaper)
 *   saved%    against the shipped graph. NEGATIVE means it got more expensive.
 *   noise     spread of the SHIPPED variant across its own repeats. A saving
 *             smaller than this is not a saving, it is the machine breathing.
 */

import { CrankAudio } from '/js/crank-audio.js';
import { getProfileById } from '/js/profiles.js';
import { CRANK_RIGS } from '/js/crank-rigs.js';

const SR = 48000;

/**
 * Build the real engine on an offline context and hold it at a steady drive.
 *
 * Steady on purpose: a moving drive would make each variant render a different
 * signal, and a DynamicsCompressor's cost depends on what it is fed. Holding
 * one operating point is what makes the columns comparable.
 */
async function build(profileId, secs) {
  const profile = getProfileById(profileId);
  if (!profile) throw new Error(`no such profile: ${profileId}`);
  if (!profile.crank) throw new Error(`${profileId} is not a CRANK profile`);
  const oc = new OfflineAudioContext(2, Math.round(SR * secs), SR);
  const audio = new CrankAudio();
  audio.setProfile(profile);
  await audio.start({ ctx: oc, manualTick: true });
  audio.setMasterVolume?.(0.8);
  // Past the starter, so the crank bed is not part of what we time.
  audio._crankUntil = 0;
  // Mid-pull: every voice open, boost up, nothing at a rail. Ticked a few times
  // so the setTargetAtTime ramps have somewhere to sit before the render.
  for (let i = 0; i < 40; i++) {
    audio.setSpeed(72, { throttle: 0.55, brake: 0, accelKmhps: 3.2 });
    audio._tick(0.02);
  }
  return { oc, audio };
}

/** One render, timed. `strip` runs on the built graph just before rendering. */
async function timeOne(profileId, secs, strip) {
  const { oc, audio } = await build(profileId, secs);
  if (strip) strip(audio, audio._nodes, audio._voices);
  const t0 = performance.now();
  await oc.startRendering();
  const ms = performance.now() - t0;
  audio.running = false;              // never stop(): the context is not ours
  return ms;
}

/**
 * MIN, not mean or median.
 *
 * The first cut used a median and reported +-32% noise, which made every row
 * except the all-at-once one unreadable. That is the wrong estimator for a
 * timing: interference only ever ADDS time. A GC pause, the dev server, the
 * OS scheduler -- each one can make a render slower and none of them can make
 * it faster. So the fastest run of N is the closest any of them got to the
 * cost of the DSP alone, and the spread above it is the machine, not the code.
 */
const best = (a) => Math.min(...a);

/**
 * The variants.
 *
 * Each one removes ONE thing, so the table is a price list and not a bundle.
 * `inaudible` marks the ones whose removal cannot change the sound by
 * construction — the node is already multiplied by an exact zero, or is not in
 * the signal path at all. Those are free. Everything else is a trade.
 */
const VARIANTS = {
  shipped: null,

  // Voice B exists only to crossfade a card change. Its five oscillators are
  // started at t0 and its whole chain renders every quantum into a gain node
  // whose value is exactly 0. It has never been heard and cannot be.
  'no-idle-voice': (a, n, v) => {
    const idle = a._active === 'a' ? 'b' : 'a';
    v[idle].voiceGain.disconnect();
  },

  // Rear HRTF panner: two convolutions per quantum, the single most expensive
  // node type in WebAudio. Audible — it is what puts the exhaust behind you.
  'no-hrtf': (a, n) => { n.rearPanner.disconnect(); n.rearDelay.connect(n.rearGain); },

  // Cabin IR convolver.
  'no-reverb': (a, n) => { n.reverb.disconnect(); },

  // 2x oversampling on the rasp waveshaper, both voices.
  'no-oversample': (a, n, v) => { for (const k of Object.keys(v)) v[k].shape.oversample = 'none'; },

  'no-density': (a, n) => {
    n.density.disconnect(); n.makeup.disconnect();
    n.makeup.connect(n.densityMakeup);
  },

  'no-limiter': (a, n) => {
    n.limiter.disconnect(); n.densityMakeup.disconnect();
    n.densityMakeup.connect(n.master);
  },

  // The analyser only feeds the on-screen spectrum.
  'no-analyser': (a, n) => {
    n.analyser.disconnect(); n.safety.disconnect();
    n.safety.connect(n.ctxDest || a.ctx.destination);
  },

  // The floor: everything above, at once. Not a proposal — the budget headroom.
  'stripped': (a, n, v) => {
    const idle = a._active === 'a' ? 'b' : 'a';
    v[idle].voiceGain.disconnect();
    for (const k of Object.keys(v)) v[k].shape.oversample = 'none';
    n.rearPanner.disconnect(); n.rearDelay.connect(n.rearGain);
    n.reverb.disconnect();
  },
};

const INAUDIBLE = new Set(['no-idle-voice']);

export async function costs(profileId = 'jz-crank', { secs = 20, repeats = 9 } = {}) {
  const names = Object.keys(VARIANTS);
  const out = {};
  // One full pass thrown away. The very first render of a variant pays for JIT
  // warm-up and for the pages the graph just allocated, and that cost lands on
  // whichever variant happens to go first.
  for (const name of names) await timeOne(profileId, secs, VARIANTS[name]);
  // Interleave the repeats rather than running each variant's block together —
  // a machine that warms up or throttles mid-run would otherwise hand the cost
  // to whichever variant happened to be scheduled late.
  for (let r = 0; r < repeats; r++) {
    for (const name of names) {
      const ms = await timeOne(profileId, secs, VARIANTS[name]);
      (out[name] ||= []).push(ms);
    }
  }
  const base = best(out.shipped);
  // Spread of the SHIPPED variant's own best half — how much two honest
  // measurements of identical code still disagree by.
  const sorted = [...out.shipped].sort((x, y) => x - y);
  const half = sorted.slice(0, Math.max(2, sorted.length >> 1));
  const noisePct = ((half[half.length - 1] - half[0]) / base) * 100;

  const rows = names.map((name) => {
    const ms = best(out[name]);
    const savedPct = ((base - ms) / base) * 100;
    return {
      variant: name,
      ms: +ms.toFixed(1),
      xRT: +((secs * 1000) / ms).toFixed(1),
      'saved%': +savedPct.toFixed(1),
      verdict: name === 'shipped' ? '—'
        : Math.abs(savedPct) < noisePct ? 'noise'
          : INAUDIBLE.has(name) ? 'FREE' : 'trade',
    };
  }).sort((a, b) => b['saved%'] - a['saved%']);

  console.log(`profile ${profileId} · ${secs}s render · ${repeats} repeats`);
  console.log(`shipped ${base.toFixed(1)} ms · noise ±${noisePct.toFixed(1)}% — anything under that is not a saving`);
  console.table(rows);
  return { profileId, base, noisePct, rows, raw: out };
}

/**
 * Does the card crossfade still work once the idle voice is parked?
 *
 * Parking the unused A/B voice is only free if it is back on the bus before
 * anything fades INTO it. Get that wrong and the failure is total and silent:
 * the old voice fades out, the new one is not connected, and the engine simply
 * stops. Loud bugs get found; this one would not.
 *
 * So: render the real graph through a real card change and read the level
 * either side of it. Offline, so there is nothing to hear and nothing to
 * misremember.
 *
 *   await lb.swapContinuity();
 *   -> { beforeRms, afterRms, gapMs, ok }
 *
 * gapMs is the longest run of near-silence anywhere in the render. A crossfade
 * dips; a disconnected voice never comes back.
 */
export async function swapContinuity(fromId = 'jz-crank', toId = 'civic-crank', secs = 8) {
  const from = getProfileById(fromId);
  const to = getProfileById(toId);
  const oc = new OfflineAudioContext(2, Math.round(SR * secs), SR);
  const audio = new CrankAudio();
  audio.setProfile(from);
  await audio.start({ ctx: oc, manualTick: true });
  audio.setMasterVolume?.(0.8);
  audio._crankUntil = 0;
  // Warm BOTH profile docs into the instance cache first. _swapProfile awaits a
  // fetch, and an offline render does not wait for the network -- an uncached
  // swap would land after the render had already finished and the test would
  // pass by never having swapped at all.
  await audio._loadDoc(audio._rigUrl);
  const toUrl = CRANK_RIGS[toId];
  if (toUrl) await audio._loadDoc(toUrl);

  const STEP = 1024;
  const dt = STEP / SR;
  const swapAt = secs / 2;
  let swapped = false;
  for (let f = 0; f + STEP <= SR * secs; f += STEP) {
    const t = f / SR;
    oc.suspend(t).then(() => {
      audio.setSpeed(72, { throttle: 0.55, brake: 0, accelKmhps: 3.2 });
      if (!swapped && t >= swapAt) { swapped = true; audio.setProfile(to); }
      audio._tick(dt);
      oc.resume();
    });
  }
  const buf = await oc.startRendering();
  audio.running = false;

  const ch = buf.getChannelData(0);
  const win = Math.round(SR * 0.05);
  const rmsAt = (from0, to0) => {
    let acc = 0, n = 0;
    for (let q = from0; q < to0 && q < ch.length; q++) { acc += ch[q] * ch[q]; n++; }
    return Math.sqrt(acc / Math.max(1, n));
  };
  const before = rmsAt(Math.round(SR * (swapAt - 1.5)), Math.round(SR * swapAt));
  const after = rmsAt(Math.round(SR * (swapAt + 1.5)), Math.round(SR * (swapAt + 3)));

  // Longest run of windows under a fortieth of the pre-swap level (-32 dB).
  let gapWins = 0, worst = 0;
  for (let q = 0; q + win < ch.length; q += win) {
    if (rmsAt(q, q + win) < before / 40) { gapWins++; if (gapWins > worst) worst = gapWins; }
    else gapWins = 0;
  }
  const out = {
    swapped,
    beforeRms: +before.toFixed(5),
    afterRms: +after.toFixed(5),
    afterDb: +(20 * Math.log10(Math.max(1e-9, after / before))).toFixed(1),
    gapMs: Math.round(worst * (win / SR) * 1000),
    ok: swapped && after > before / 4 && worst * (win / SR) < 0.3,
  };
  console.log('[swapContinuity]', out);
  return out;
}

export default { costs, swapContinuity };
