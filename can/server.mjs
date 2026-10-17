/**
 * Local drive server for Tesla Active Sound.
 *
 * Reads a CAN stream (or a mock), decodes the signals in signals.model3.json,
 * and pushes one JSON snapshot over WebSocket at --hz (default 50, the same
 * clock the audio engine already runs). Optionally serves this repo so the
 * Tesla browser can open http://<this-machine>:8787/ on the same network.
 *
 *   node can/server.mjs
 *   node can/server.mjs --source socketcan --iface can0
 *   node can/server.mjs --source serial --device /dev/ttyUSB0 --baud 115200
 *   node can/server.mjs --source lines --file capture.log
 *   node can/server.mjs --source lines --file -          # stdin
 *   node can/server.mjs --parser slcan --no-static
 *
 * The adapter protocol is pluggable (can/parse.mjs). "tita"/"Tida" is not assumed.
 * Frame IDs in the default signal file are community Model 3 layouts and are
 * marked unverified — confirm them on the car before trusting a live bus.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDecoder, toWire } from './decode.mjs';
import { openSource } from './sources.mjs';
import { acceptSocket } from './ws.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
};

function arg(name, fallback = undefined) {
  const flag = `--${name}`;
  const i = process.argv.indexOf(flag);
  if (i === -1) return fallback;
  const next = process.argv[i + 1];
  if (next == null || next.startsWith('--')) return true;
  return next;
}

function help() {
  console.log(`Tesla Active Sound — CAN / mock drive server

  node can/server.mjs [--port 8787] [--host 0.0.0.0]
                      [--source mock|socketcan|serial|lines]
                      [--iface can0] [--device /dev/ttyUSB0] [--baud 115200]
                      [--file capture.log] [--parser auto|slcan|candump|plain|json]
                      [--signals can/signals.model3.json] [--hz 50] [--no-static]

Mock is the default and needs no CAN hardware. SocketCAN shells out to candump
(can-utils). Serial expects a tty that emits text frames; the vendor protocol
is not assumed. See docs/CAN.md.
`);
}

function loadConfig(file) {
  const abs = path.isAbsolute(file) ? file : path.resolve(ROOT, file);
  return JSON.parse(fs.readFileSync(abs, 'utf8'));
}

function safeFile(urlPath) {
  const decoded = decodeURIComponent(urlPath.split('?')[0]);
  const rel = (decoded === '/' ? 'index.html' : decoded).replace(/^\/+/, '');
  const abs = path.normalize(path.join(ROOT, rel));
  if (!abs.startsWith(ROOT + path.sep) && abs !== ROOT) return null;
  if (abs.includes(`${path.sep}.git${path.sep}`) || abs.endsWith(`${path.sep}.git`)) return null;
  return abs;
}

export function startServer(opts = {}) {
  const port = Number(opts.port ?? arg('port', 8787));
  const host = opts.host ?? arg('host', '0.0.0.0');
  const sourceKind = opts.source ?? (arg('source', 'mock'));
  const hz = Math.max(1, Number(opts.hz ?? arg('hz', 50)));
  const serveStatic = opts.static !== undefined ? opts.static !== false && opts.static !== 'false' : arg('no-static', false) !== true;
  const signalsPath = opts.signals ?? arg('signals', path.join('can', 'signals.model3.json'));
  const config = opts.config || loadConfig(signalsPath);
  const parser = opts.parser ?? arg('parser', 'auto');
  const decoder = createDecoder(config);
  const clients = new Set();
  let latest = null;
  let lastFrameAt = 0;
  let sourceError = null;

  const source = openSource(sourceKind === true ? 'mock' : sourceKind, {
    config,
    hz,
    iface: opts.iface ?? arg('iface', 'can0'),
    device: opts.device ?? arg('device', '/dev/ttyUSB0'),
    baud: Number(opts.baud ?? arg('baud', 115200)),
    file: opts.file ?? arg('file', '-'),
    parser: parser === true ? 'auto' : parser,
  });

  function noteFrame(frame) {
    if (frame.error) {
      sourceError = String(frame.error);
      console.error('[can]', sourceError);
      return;
    }
    lastFrameAt = Date.now();
    if (frame.json) {
      latest = { t: Date.now(), source: source.name, ...frame.json };
      return;
    }
    decoder.push(frame);
    latest = toWire(decoder.values(), source.name);
  }

  const flush = setInterval(() => {
    if (!latest) return;
    if (Date.now() - lastFrameAt > 500) return;
    const payload = JSON.stringify(latest);
    for (const client of clients) client.send(payload);
  }, Math.round(1000 / hz));

  const server = http.createServer((req, res) => {
    const url = req.url || '/';
    if (url.startsWith('/__can/info')) {
      const body = JSON.stringify({
        ok: true,
        source: source.name,
        hz,
        signals: config.name || 'custom',
        signalsVerified: config.verified === true,
        ws: `ws://<this-host>:${port}/`,
        error: sourceError,
      });
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      res.end(body);
      return;
    }
    if (!serveStatic) {
      res.writeHead(404);
      res.end('static serving is off');
      return;
    }
    const file = safeFile(url);
    if (!file) {
      res.writeHead(403);
      res.end('forbidden');
      return;
    }
    fs.stat(file, (err, st) => {
      if (err || !st.isFile()) {
        res.writeHead(404);
        res.end('not found');
        return;
      }
      const ext = path.extname(file).toLowerCase();
      res.writeHead(200, {
        'Content-Type': MIME[ext] || 'application/octet-stream',
        'Cache-Control': 'no-store',
      });
      fs.createReadStream(file).pipe(res);
    });
  });

  server.on('upgrade', (req, socket) => {
    const client = acceptSocket(socket, req, () => clients.delete(client));
    if (!client) return;
    clients.add(client);
    if (latest) client.send(JSON.stringify(latest));
  });

  source.start(noteFrame);

  const listening = new Promise((resolve) => {
    server.listen(port, host, () => resolve({ port, host }));
  });

  return {
    port,
    host,
    hz,
    source: source.name,
    config,
    server,
    listening,
    close() {
      clearInterval(flush);
      source.stop();
      for (const c of clients) c.close();
      clients.clear();
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  if (arg('help', false) === true || process.argv.includes('-h')) {
    help();
    process.exit(0);
  }
  const running = startServer();
  running.listening.then(({ port, host }) => {
    console.log(`[can] ${running.source} → ws://${host}:${port}/  (${running.hz} Hz)`);
    console.log(`[can] signals: ${running.config.name || 'custom'}  verified: ${running.config.verified === true}`);
    if (arg('no-static', false) !== true) {
      console.log(`[can] site:  http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${port}/`);
    }
    if (running.config.verified !== true) {
      console.log('[can] frame IDs are UNVERIFIED community Model 3 layouts — confirm on the car');
    }
  });
}
