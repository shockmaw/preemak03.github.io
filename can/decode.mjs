/**
 * Tiny Intel-endian signal codec.
 * DBC `@1` / little-endian: startBit is the least significant bit.
 * Physical = raw * factor + offset.
 */

export function extractIntel(data, startBit, length, signed) {
  const len = length | 0;
  if (len <= 0 || len > 32) return 0;
  let raw = 0;
  for (let i = 0; i < len; i++) {
    const bit = startBit + i;
    const byte = bit >> 3;
    if (byte >= data.length) break;
    if ((data[byte] >> (bit & 7)) & 1) raw |= 1 << i;
  }
  if (signed && (raw & (1 << (len - 1)))) raw -= 1 << len;
  return raw;
}

export function insertIntel(data, startBit, length, raw) {
  const len = length | 0;
  if (len <= 0 || len > 32) return;
  let v = raw | 0;
  if (v < 0) v += 1 << len;
  for (let i = 0; i < len; i++) {
    const bit = startBit + i;
    const byte = bit >> 3;
    const mask = 1 << (bit & 7);
    if (byte >= data.length) return;
    if ((v >> i) & 1) data[byte] |= mask;
    else data[byte] &= ~mask;
  }
}

export function encodeSignal(data, sig, physical) {
  const factor = sig.factor == null ? 1 : sig.factor;
  const offset = sig.offset || 0;
  const raw = Math.round((physical - offset) / (factor || 1));
  insertIntel(data, sig.startBit | 0, sig.length | 0, raw);
}

export function decodeSignal(data, sig) {
  const raw = extractIntel(data, sig.startBit | 0, sig.length | 0, !!sig.signed);
  if (Array.isArray(sig.invalidRaw) && sig.invalidRaw.includes(raw)) {
    return { raw, value: null, invalid: true };
  }
  const factor = sig.factor == null ? 1 : sig.factor;
  const offset = sig.offset || 0;
  return { raw, value: raw * factor + offset, invalid: false };
}

export function indexSignals(config) {
  const byFrame = new Map();
  for (const sig of config.signals || []) {
    const id = normalizeId(sig.frame);
    if (!byFrame.has(id)) byFrame.set(id, []);
    byFrame.get(id).push(sig);
  }
  return byFrame;
}

export function normalizeId(id) {
  if (typeof id === 'number') return id >>> 0;
  const s = String(id).trim();
  return Number.parseInt(s, s.startsWith('0x') || s.startsWith('0X') ? 16 : 10) >>> 0;
}

export function createDecoder(config) {
  const byFrame = indexSignals(config);
  const last = new Map();
  return {
    config,
    push(frame) {
      const id = normalizeId(frame.id);
      const sigs = byFrame.get(id);
      if (!sigs) return false;
      const data = frame.data instanceof Uint8Array ? frame.data : Uint8Array.from(frame.data);
      let hit = false;
      for (const sig of sigs) {
        const decoded = decodeSignal(data, sig);
        last.set(sig.name, { ...decoded, t: frame.ts || Date.now() });
        hit = true;
      }
      return hit;
    },
    values() {
      const out = {};
      for (const [name, row] of last) out[name] = row.value;
      return out;
    },
  };
}

/**
 * Decoder values → the JSON the browser maps.
 * pedalPct is 0..100; brakeState is the DBC enum (0 off, 1 on).
 */
export function toWire(values, source) {
  const pedalPct = values.pedalPct;
  let pedal = null;
  if (pedalPct != null && pedalPct <= 100) pedal = pedalPct / 100;
  let brake = null;
  if (values.brakeState === 0) brake = 0;
  else if (values.brakeState === 1) brake = 1;
  return {
    t: Date.now(),
    speedKmh: values.speedKmh ?? null,
    accelMps2: values.accelMps2 ?? null,
    pedal,
    brake,
    regenLight: values.regenLight ?? null,
    motorRpm: values.motorRpm ?? null,
    torqueNm: values.torqueNm ?? null,
    source: source || null,
  };
}

/** Pack a physical snapshot into the frames this config knows. Returns [{id, data}]. */
export function encodeSnapshot(config, physical) {
  const byFrame = indexSignals(config);
  const frames = [];
  for (const [id, sigs] of byFrame) {
    const data = new Uint8Array(8);
    let used = false;
    for (const sig of sigs) {
      if (physical[sig.name] == null) continue;
      encodeSignal(data, sig, physical[sig.name]);
      used = true;
    }
    if (used) frames.push({ id, data });
  }
  return frames;
}
