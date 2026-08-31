/**
 * Dev-mode input probe — what actually reaches this page in the car.
 *
 * WHY IT EXISTS
 *   The owner cannot scroll while driving and there is no way to tell why. The
 *   candidates are not distinguishable by looking at the screen:
 *
 *     the car never sends the event at all       -> nothing to fix here
 *     it sends it and something swallows it      -> ours, and findable
 *     it arrives and the handler ignores it      -> ours, and findable
 *
 *   Every instrument we had could only see the third. manual-shift.js keeps a
 *   tally, but it is a listener like any other: it cannot count an event that
 *   was stopped before it, and it is now dev-gated, so it may not even be
 *   running. Guessing at this has been wrong twice already — the plan assumed
 *   `wheel`, the car reported `key`, and then the on-screen buttons worked
 *   while the wheel did not.
 *
 * HOW IT ANSWERS THAT
 *   Two listeners per event type on `window`: one in the CAPTURE phase, which
 *   runs before anything else on the page, and one in the BUBBLE phase, which
 *   runs after everything. The pair reads:
 *
 *     arrived 0                 the car does not send this. Not our bug.
 *     arrived 12, survived 12   it reaches us intact; the handler is at fault
 *     arrived 12, survived 0    something on this page is eating it
 *
 *   ...but ONLY for events that bubble. `scroll` on an element does not, so it
 *   can never reach a bubble listener on window and always reads 0. The first
 *   four real traces all showed `scroll 74/0` and it meant nothing at all —
 *   see the note on bump(). Non-bubbling kinds print `–` rather than a number.
 *
 *   Nothing here can interfere with what it measures: every listener is
 *   `passive` where the browser allows it and none of them call
 *   preventDefault or stopPropagation.
 *
 * READABLE WHILE DRIVING
 *   The trace button wrote its answer into an 8 px badge as one long line,
 *   which is unreadable in a moving car and cannot be scrolled. This paints a
 *   panel instead: large type, one row per input, no scrolling, and a tap
 *   target sized for a car screen. Counts, not a stream — a wheel fires dozens
 *   of events a second and a log would scroll away the thing being looked for.
 *
 * Dev mode only. Loaded on demand, and stopped with the rest of the dev tools.
 */

/** Event types worth naming. Anything not here still shows up under `other`. */
const KINDS = [
  'wheel', 'keydown', 'keyup', 'pointerdown', 'pointerup',
  'touchstart', 'touchmove', 'touchend', 'scroll', 'gesturestart',
];

const fmtAgo = (ms) => (ms == null ? '—' : ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`);

export function startDevInput({ getState } = {}) {
  // kind -> { arrived, survived, bubbling, lastAt, detail }
  //
  // `bubbling` is why survived is only meaningful for SOME events, and getting
  // this wrong sent the first read of four real drives chasing a phantom:
  // every trace showed `scroll  arrived 74 / survived 0` in red, which reads
  // as "something is eating every scroll". It is not. A scroll fired on an
  // element has bubbles:false, so it can never reach a bubble-phase listener
  // on window — survived 0 is the DOM working correctly. Measured directly:
  // element scroll -> arrived 5, survived 0, bubbles false.
  //
  // So survived is compared only where the event actually bubbles, and a
  // non-bubbling event says so instead of pretending to be a defect.
  const tally = new Map();
  const bump = (kind, phase, detail, bubbles) => {
    let e = tally.get(kind);
    if (!e) { e = { arrived: 0, survived: 0, bubbling: null, lastAt: 0, detail: '' }; tally.set(kind, e); }
    if (phase === 'capture') {
      e.arrived++;
      e.lastAt = performance.now();
      if (bubbles != null) e.bubbling = e.bubbling === false ? false : bubbles;
      if (detail) e.detail = detail;
    } else e.survived++;
  };

  /** What made this event interesting, in as few characters as possible. */
  const detailOf = (kind, ev) => {
    try {
      if (kind === 'wheel') return `d${ev.deltaY > 0 ? '+' : ''}${Math.round(ev.deltaY)}`;
      if (kind === 'keydown' || kind === 'keyup') return ev.key === ' ' ? 'Space' : String(ev.key).slice(0, 10);
      if (kind === 'scroll') return `y${Math.round(window.scrollY)}`;
      if (kind.startsWith('touch')) return `${(ev.touches && ev.touches.length) || 0}f`;
      if (kind.startsWith('pointer')) return String(ev.pointerType || '').slice(0, 6);
    } catch (_) { /* a detail is never worth an exception */ }
    return '';
  };

  const bound = [];
  for (const kind of KINDS) {
    const cap = (ev) => bump(kind, 'capture', detailOf(kind, ev), !!ev.bubbles);
    const bub = () => bump(kind, 'bubble', null, null);
    // passive so this can never be the thing that blocks a scroll it is here
    // to explain. capture:true puts us ahead of every other listener.
    try { window.addEventListener(kind, cap, { capture: true, passive: true }); } catch (_) { continue; }
    try { window.addEventListener(kind, bub, { capture: false, passive: true }); } catch (_) { /* capture is the important half */ }
    bound.push([kind, cap, bub]);
  }

  /* ------------------------------------------------------------- panel -- */

  const panel = document.createElement('div');
  panel.className = 'dev-input-panel';
  panel.hidden = true;
  panel.innerHTML = `
    <div class="dip-head">
      <span class="dip-title">INPUT — ที่เข้าถึงหน้าเว็บจริง</span>
      <button type="button" class="dip-btn" data-act="reset">ล้าง</button>
      <button type="button" class="dip-btn" data-act="close">ปิด</button>
    </div>
    <div class="dip-legend">arrived = รถส่งมา · survived = ไม่มีใครกิน (– = event นี้ไม่ bubble เทียบไม่ได้)</div>
    <div class="dip-rows"></div>
    <div class="dip-drive"></div>`;
  document.body.appendChild(panel);

  const rowsEl = panel.querySelector('.dip-rows');
  const driveEl = panel.querySelector('.dip-drive');

  panel.addEventListener('click', (ev) => {
    const act = ev.target && ev.target.dataset && ev.target.dataset.act;
    if (act === 'close') api.hide();
    if (act === 'reset') { tally.clear(); paint(); }
  });

  let raf = 0;
  let lastPaint = 0;

  function paint() {
    const now = performance.now();
    // Every kind that has EVER fired, plus the ones being watched for that
    // have not. A row reading 0 is the answer as often as a row reading 40.
    const names = [...new Set([...KINDS, ...tally.keys()])];
    const live = names.filter((k) => tally.has(k));
    const silent = names.filter((k) => !tally.has(k));
    live.sort((a, b) => tally.get(b).arrived - tally.get(a).arrived);

    let html = '';
    for (const k of live) {
      const e = tally.get(k);
      // Only a BUBBLING event can be judged this way. See the note on bump().
      const eaten = e.bubbling === true && e.survived < e.arrived;
      const survivedCell = e.bubbling === false ? '–' : e.survived;
      html += `<div class="dip-row${eaten ? ' eaten' : ''}">`
        + `<span class="dip-k">${k}</span>`
        + `<span class="dip-n">${e.arrived}</span>`
        + `<span class="dip-n">${survivedCell}</span>`
        + `<span class="dip-d">${e.detail || ''}</span>`
        + `<span class="dip-t">${fmtAgo(e.lastAt ? now - e.lastAt : null)}</span>`
        + '</div>';
    }
    if (silent.length) {
      html += `<div class="dip-row dip-silent"><span class="dip-k">ไม่มาเลย</span>`
        + `<span class="dip-quiet">${silent.join(' · ')}</span></div>`;
    }
    rowsEl.innerHTML = html || '<div class="dip-row dip-silent">ยังไม่มี input เข้ามา</div>';

    // The one input the app actually drives on. See the one-input principle:
    // everything else in this engine is derived from speed over time, so if
    // this line is wrong nothing downstream can be right.
    const s = (typeof getState === 'function' && getState()) || {};
    driveEl.textContent = [
      `GPS ${(s.geoSpeed ?? 0).toFixed(1)}`,
      `ใช้จริง ${(s.activeSpeed ?? 0).toFixed(1)} km/h`,
      `${(s.accelKmhps ?? 0) >= 0 ? '+' : ''}${(s.accelKmhps ?? 0).toFixed(2)} km/h/s`,
      `${(s.fixHz ?? 0).toFixed(1)} Hz`,
      `±${Math.round(s.geoAccuracy ?? 0)} m`,
    ].join('  ·  ');
  }

  function loop(t) {
    raf = requestAnimationFrame(loop);
    if (t - lastPaint < 200) return;      // 5 Hz is plenty to read
    lastPaint = t;
    paint();
  }

  const api = {
    show() {
      panel.hidden = false;
      if (!raf) raf = requestAnimationFrame(loop);
      paint();
    },
    hide() {
      panel.hidden = true;
      if (raf) { cancelAnimationFrame(raf); raf = 0; }
    },
    toggle() { return panel.hidden ? (api.show(), true) : (api.hide(), false); },
    visible: () => !panel.hidden,
    /** The tally, for the drive trace to carry home. */
    snapshot: () => [...tally.entries()].map(([kind, e]) => ({
      kind, arrived: e.arrived, survived: e.survived, bubbling: e.bubbling, detail: e.detail,
    })),
    stop() {
      api.hide();
      for (const [kind, cap, bub] of bound) {
        try { window.removeEventListener(kind, cap, { capture: true }); } catch (_) {}
        try { window.removeEventListener(kind, bub, { capture: false }); } catch (_) {}
      }
      bound.length = 0;
      tally.clear();
      panel.remove();
    },
  };
  return api;
}

export default { startDevInput };
