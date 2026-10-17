/**
 * WebSocket drive listener.
 *
 * Replaces the GPS watch. The page does not read geolocation. A local server
 * (can/server.mjs) pushes JSON snapshots; this class reconnects on its own and
 * reports when the stream has gone quiet so the app can ease to idle.
 *
 * URL resolution, first match wins:
 *   1. ?ws=ws://host:port
 *   2. ?port=8787     → ws://<page hostname>:8787  (wss if the page is https)
 *   3. localStorage tas-can-url
 *   4. ws://<page host>:<page port or 8787>
 *
 * An https page cannot open ws:// (mixed content). Use the local http server
 * in the car browser, or put TLS in front of the socket and use wss://.
 * See docs/CAN.md.
 */

export const CAN_STALE_MS = 400;
const RETRY_BASE_MS = 400;
const RETRY_MAX_MS = 8000;
const URL_KEY = 'tas-can-url';

export function defaultCanUrl(loc = typeof location !== 'undefined' ? location : null) {
  const page = loc || { protocol: 'http:', hostname: '127.0.0.1', port: '', search: '' };
  let params;
  try {
    params = new URLSearchParams(page.search || '');
  } catch (_) {
    params = new URLSearchParams();
  }
  const explicit = params.get('ws');
  if (explicit) return explicit.trim();
  const scheme = page.protocol === 'https:' ? 'wss' : 'ws';
  const portParam = params.get('port');
  if (portParam) return `${scheme}://${page.hostname}:${portParam}`;
  try {
    const saved = localStorage.getItem(URL_KEY);
    if (saved) return saved;
  } catch (_) {}
  const port = page.port || '8787';
  return `${scheme}://${page.hostname}:${port}`;
}

export function rememberCanUrl(url) {
  try {
    if (url) localStorage.setItem(URL_KEY, url);
  } catch (_) {}
}

export class CanLink {
  constructor() {
    this.url = '';
    /** off | connecting | live | stale | error */
    this.status = 'off';
    this.sample = null;
    this.lastMsgMs = 0;
    this.msgHz = 0;
    this.error = null;
    this._ws = null;
    this._want = false;
    this._retry = 0;
    this._timer = 0;
    this._listeners = new Set();
    this._lastGapTs = 0;
  }

  onUpdate(fn) {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  _emit() {
    const payload = {
      status: this.status,
      url: this.url,
      sample: this.sample,
      msgHz: this.msgHz,
      error: this.error,
      ageMs: this.lastMsgMs ? Math.max(0, performance.now() - this.lastMsgMs) : null,
    };
    for (const fn of this._listeners) {
      try { fn(payload); } catch (_) {}
    }
  }

  isFresh(now = performance.now()) {
    return this.status !== 'off' && this.lastMsgMs > 0 && now - this.lastMsgMs <= CAN_STALE_MS && !!this.sample;
  }

  /** Call from the frame loop so a quiet socket becomes `stale` without waiting for a close. */
  poll(now = performance.now()) {
    if (!this._want || !this._ws || this._ws.readyState !== 1) return this.status;
    const fresh = this.lastMsgMs > 0 && now - this.lastMsgMs <= CAN_STALE_MS;
    const next = fresh ? 'live' : 'stale';
    if (next !== this.status) {
      this.status = next;
      this._emit();
    }
    return this.status;
  }

  start(url) {
    this._want = true;
    this.url = (url || defaultCanUrl()).trim();
    this._retry = 0;
    this._clearTimer();
    this._closeSocket();
    this._connect();
  }

  stop() {
    this._want = false;
    this._clearTimer();
    this._closeSocket();
    this.status = 'off';
    this.error = null;
    this._emit();
  }

  _clearTimer() {
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = 0;
    }
  }

  _closeSocket() {
    const ws = this._ws;
    this._ws = null;
    if (!ws) return;
    ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null;
    try { ws.close(); } catch (_) {}
  }

  _schedule() {
    if (!this._want) return;
    const delay = Math.min(RETRY_MAX_MS, Math.round(RETRY_BASE_MS * Math.pow(1.7, this._retry)));
    this._retry = Math.min(this._retry + 1, 8);
    this._clearTimer();
    this._timer = setTimeout(() => this._connect(), delay);
  }

  _connect() {
    if (!this._want) return;
    this._closeSocket();
    this.status = 'connecting';
    this.error = null;
    this._emit();
    let ws;
    try {
      ws = new WebSocket(this.url);
    } catch (err) {
      this.status = 'error';
      this.error = err && err.message ? err.message : 'bad url';
      this._emit();
      this._schedule();
      return;
    }
    this._ws = ws;
    ws.onopen = () => {
      if (ws !== this._ws) return;
      this._retry = 0;
      this.status = this.isFresh() ? 'live' : 'connecting';
      this.error = null;
      this._emit();
    };
    ws.onmessage = (ev) => {
      if (ws !== this._ws) return;
      this._onMessage(ev.data);
    };
    ws.onerror = () => {
      if (ws !== this._ws) return;
      this.error = 'socket error';
    };
    ws.onclose = () => {
      if (ws !== this._ws) return;
      this._ws = null;
      if (!this._want) return;
      this.status = 'error';
      this._emit();
      this._schedule();
    };
  }

  _onMessage(data) {
    let msg;
    try {
      msg = typeof data === 'string' ? JSON.parse(data) : null;
    } catch (_) {
      return;
    }
    if (!msg || typeof msg !== 'object') return;
    const now = performance.now();
    if (this._lastGapTs) {
      const gap = (now - this._lastGapTs) / 1000;
      if (gap > 0.005 && gap < 2) {
        const hz = 1 / gap;
        this.msgHz = this.msgHz ? this.msgHz * 0.7 + hz * 0.3 : hz;
      }
    }
    this._lastGapTs = now;
    this.lastMsgMs = now;
    this.sample = msg;
    this.status = 'live';
    this.error = null;
    this._emit();
  }
}
