/**
 * Minimal WebSocket server (RFC 6455), server-to-client text frames.
 * Enough for one JSON snapshot per tick. No third-party dependency,
 * so the car-side box does not need a package install.
 */
import { createHash } from 'node:crypto';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export function acceptKey(secKey) {
  return createHash('sha1').update(String(secKey) + GUID).digest('base64');
}

export function encodeFrame(opcode, payload) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const len = data.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  header[0] = 0x80 | (opcode & 0x0f);
  return Buffer.concat([header, data]);
}

export function encodeText(str) {
  return encodeFrame(0x1, Buffer.from(String(str)));
}

function encodeClose() {
  return encodeFrame(0x8, Buffer.alloc(0));
}

function encodePong(payload) {
  return encodeFrame(0xA, payload);
}

/**
 * Attach a WebSocket to an upgraded socket.
 * Calls `onClose` when the peer goes away. Client messages are consumed and ignored
 * (this socket is a broadcast of drive snapshots).
 */
export function acceptSocket(socket, req, onClose) {
  const key = req.headers['sec-websocket-key'];
  if (!key) {
    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    return null;
  }
  const headers = [
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${acceptKey(key)}`,
    '\r\n',
  ];
  socket.write(headers.join('\r\n'));

  let buf = Buffer.alloc(0);
  let alive = true;

  const fail = () => {
    if (!alive) return;
    alive = false;
    try { socket.destroy(); } catch (_) {}
    if (onClose) onClose();
  };

  socket.on('data', (chunk) => {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    while (alive) {
      if (buf.length < 2) return;
      const b1 = buf[1];
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let offset = 2;
      if (len === 126) {
        if (buf.length < 4) return;
        len = buf.readUInt16BE(2);
        offset = 4;
      } else if (len === 127) {
        if (buf.length < 10) return;
        const big = buf.readBigUInt64BE(2);
        if (big > BigInt(1_000_000)) return fail();
        len = Number(big);
        offset = 10;
      }
      const maskLen = masked ? 4 : 0;
      if (buf.length < offset + maskLen + len) return;
      const opcode = buf[0] & 0x0f;
      let payload = buf.subarray(offset + maskLen, offset + maskLen + len);
      if (masked) {
        const mask = buf.subarray(offset, offset + 4);
        payload = Buffer.from(payload);
        for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      }
      buf = buf.subarray(offset + maskLen + len);
      if (opcode === 0x8) {
        try { socket.end(encodeClose()); } catch (_) {}
        return fail();
      }
      if (opcode === 0x9) {
        try { socket.write(encodePong(payload)); } catch (_) { return fail(); }
      }
    }
  });
  socket.on('close', fail);
  socket.on('error', fail);

  return {
    send(text) {
      if (!alive) return false;
      try {
        socket.write(encodeText(text));
        return true;
      } catch (_) {
        fail();
        return false;
      }
    },
    close() {
      if (!alive) return;
      try { socket.end(encodeClose()); } catch (_) {}
      fail();
    },
  };
}
