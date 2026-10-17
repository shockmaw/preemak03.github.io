/**
 * Line parsers for adapters that are not SocketCAN.
 *
 * The transmitter name in the request was "tita" / "Tida" — spelling and vendor
 * protocol are unknown, so nothing here is tied to one product. `auto` accepts
 * the text formats USB-CAN adapters commonly emit. To support a new device,
 * add a function to PARSERS and start the server with `--parser <name>`.
 *
 * Each parser returns { id, data: Uint8Array } or { json } or null.
 */

function hexToBytes(hex) {
  const clean = hex.replace(/\s+/g, '');
  if (!clean || clean.length % 2) return null;
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    const byte = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
    if (!Number.isFinite(byte)) return null;
    out[i] = byte;
  }
  return out;
}

export function parseJson(line) {
  const s = line.trim();
  if (!s.startsWith('{')) return null;
  try {
    const json = JSON.parse(s);
    if (json && typeof json === 'object') return { json };
  } catch (_) {}
  return null;
}

/** candump / candump -L : `(ts) can0 257#0102` or `257#0102`. */
export function parseCandump(line) {
  const s = line.trim();
  const m = s.match(/(?:^|\s)([0-9A-Fa-f]{3,8})#([0-9A-Fa-f]*)$/);
  if (!m) return null;
  const data = hexToBytes(m[2]);
  if (!data) return null;
  return { id: Number.parseInt(m[1], 16), data };
}

/**
 * Lawicel / SLCAN: `tIIILDD..` (11-bit) or `TIIIIIIIILDD..` (29-bit).
 * Also accepts a trailing `\r` already stripped by the line reader.
 */
export function parseSlcan(line) {
  const s = line.trim();
  let idHex;
  let rest;
  if (/^t[0-9A-Fa-f]{3}[0-8]/.test(s)) {
    idHex = s.slice(1, 4);
    rest = s.slice(4);
  } else if (/^T[0-9A-Fa-f]{8}[0-8]/.test(s)) {
    idHex = s.slice(1, 9);
    rest = s.slice(9);
  } else {
    return null;
  }
  const dlc = Number.parseInt(rest[0], 10);
  if (!Number.isFinite(dlc)) return null;
  const data = hexToBytes(rest.slice(1, 1 + dlc * 2));
  if (!data || data.length !== dlc) return null;
  return { id: Number.parseInt(idHex, 16), data };
}

/**
 * `599 01020304` or `0x257 01 02 03 04`.
 * A token with a-f or a 0x prefix is hex. Digits only are decimal, so the
 * Model 3 speed frame can be written `599` (not 0x257).
 */
export function parsePlain(line) {
  const s = line.trim();
  const m = s.match(/^(0x[0-9A-Fa-f]+|[0-9A-Fa-f]+)\s+([0-9A-Fa-f\s]+)$/);
  if (!m) return null;
  const idTok = m[1];
  const hex = idTok.startsWith('0x') || idTok.startsWith('0X') || /[A-Fa-f]/.test(idTok);
  const id = Number.parseInt(hex ? idTok.replace(/^0x/i, '') : idTok, hex ? 16 : 10);
  if (!Number.isFinite(id)) return null;
  const data = hexToBytes(m[2]);
  if (!data) return null;
  return { id, data };
}

export function parseAuto(line) {
  const s = line.trim();
  if (!s || s.startsWith('#')) return null;
  return parseJson(s) || parseCandump(s) || parseSlcan(s) || parsePlain(s);
}

export const PARSERS = {
  auto: parseAuto,
  json: parseJson,
  candump: parseCandump,
  slcan: parseSlcan,
  plain: parsePlain,
};

export function parseLine(line, which = 'auto') {
  const fn = PARSERS[which] || PARSERS.auto;
  return fn(line);
}
