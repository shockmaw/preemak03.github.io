/**
 * Pluggable frame sources. Each returns { start(emit), stop() }.
 * emit({ id, data, ts }) for a CAN frame, or emit({ json }) for an already-decoded snapshot.
 */
import { spawn, execFile } from 'node:child_process';
import fs from 'node:fs';
import readline from 'node:readline';
import { encodeSnapshot } from './decode.mjs';
import { parseLine } from './parse.mjs';

const WHEEL_M = 2.06;

function wheelRpm(speedKmh) {
  return (Math.max(0, speedKmh) / 3.6 / WHEEL_M) * 60;
}

/**
 * A 20 s loop: idle, pull to 90, cruise, regen to a stop.
 * Deterministic so a test can wait and see the speed change.
 */
export function mockPhysics(tSec) {
  const T = ((tSec % 20) + 20) % 20;
  if (T < 2) return { speed: 0, pedal: 0, regen: 0, brake: 0, accel: 0 };
  if (T < 7) {
    const u = (T - 2) / 5;
    return { speed: 90 * u, pedal: 0.75, regen: 0, brake: 0, accel: 18 };
  }
  if (T < 12) return { speed: 90, pedal: 0.12, regen: 0, brake: 0, accel: 0 };
  if (T < 16) {
    const u = (T - 12) / 4;
    return { speed: 90 * (1 - u), pedal: 0, regen: 0.85, brake: 0, accel: -22.5 };
  }
  return { speed: 0, pedal: 0, regen: 0, brake: 0, accel: 0 };
}

export function mockPhysical(tSec) {
  const p = mockPhysics(tSec);
  return {
    speedKmh: p.speed,
    pedalPct: p.pedal * 100,
    brakeState: p.brake > 0.5 ? 1 : 0,
    regenLight: p.regen > 0.2 ? 1 : 0,
    motorRpm: wheelRpm(p.speed),
    torqueNm: p.regen > 0 ? -120 * p.regen : p.pedal * 180,
    accelMps2: p.accel / 3.6,
  };
}

export function openMock({ config, hz = 50 }) {
  let timer = null;
  const t0 = Date.now();
  return {
    name: 'mock',
    start(emit) {
      const period = Math.max(10, Math.round(1000 / hz));
      timer = setInterval(() => {
        const t = (Date.now() - t0) / 1000;
        const physical = mockPhysical(t);
        const frames = encodeSnapshot(config, physical);
        const ts = Date.now();
        for (const frame of frames) emit({ id: frame.id, data: frame.data, ts });
      }, period);
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}

export function openSocketcan({ iface = 'can0' }) {
  let child = null;
  return {
    name: 'socketcan',
    start(emit) {
      child = spawn('candump', ['-L', iface], { stdio: ['ignore', 'pipe', 'pipe'] });
      child.once('error', (err) => {
        emit({ error: err.code === 'ENOENT'
          ? 'candump not found. Install can-utils (apt install can-utils) or use --source lines.'
          : err.message });
      });
      const rl = readline.createInterface({ input: child.stdout });
      rl.on('line', (line) => {
        const parsed = parseLine(line, 'candump');
        if (parsed && parsed.data) emit({ id: parsed.id, data: parsed.data, ts: Date.now() });
      });
      let errBuf = '';
      child.stderr.on('data', (chunk) => {
        errBuf += chunk.toString();
        if (errBuf.length > 400) errBuf = errBuf.slice(-400);
      });
      child.on('exit', (code) => {
        if (code) emit({ error: `candump ${iface} exited ${code}${errBuf ? `: ${errBuf.trim()}` : ''}` });
      });
    },
    stop() {
      if (child) child.kill('SIGTERM');
      child = null;
    },
  };
}

function stty(device, baud) {
  return new Promise((resolve) => {
    execFile('stty', ['-F', device, String(baud), 'raw', '-echo'], (err) => {
      resolve(err || null);
    });
  });
}

export function openSerial({ device = '/dev/ttyUSB0', baud = 115200, parser = 'auto' }) {
  let stream = null;
  let rl = null;
  return {
    name: 'serial',
    async start(emit) {
      const ttyErr = await stty(device, baud);
      if (ttyErr) {
        emit({
          error: `stty ${device} @ ${baud} failed (${ttyErr.message}). ` +
            'The adapter was not assumed to be any one vendor — if it is not a tty that emits text frames, use --source lines or add a parser.',
        });
      }
      try {
        stream = fs.createReadStream(device, { flags: 'r' });
      } catch (err) {
        emit({ error: `cannot open ${device}: ${err.message}` });
        return;
      }
      stream.on('error', (err) => emit({ error: `serial ${device}: ${err.message}` }));
      rl = readline.createInterface({ input: stream });
      rl.on('line', (line) => deliverLine(line, parser, emit));
    },
    stop() {
      if (rl) rl.close();
      if (stream) stream.destroy();
      rl = null;
      stream = null;
    },
  };
}

export function openLines({ file = '-', parser = 'auto' }) {
  let stream = null;
  let rl = null;
  return {
    name: 'lines',
    start(emit) {
      if (file === '-' || file === 'stdin') {
        stream = process.stdin;
      } else {
        try {
          stream = fs.createReadStream(file);
        } catch (err) {
          emit({ error: `cannot read ${file}: ${err.message}` });
          return;
        }
        stream.on('error', (err) => emit({ error: `lines ${file}: ${err.message}` }));
      }
      rl = readline.createInterface({ input: stream });
      rl.on('line', (line) => deliverLine(line, parser, emit));
    },
    stop() {
      if (rl) rl.close();
      if (stream && stream !== process.stdin) stream.destroy();
      rl = null;
      stream = null;
    },
  };
}

function deliverLine(line, parser, emit) {
  const parsed = parseLine(line, parser);
  if (!parsed) return;
  if (parsed.json) emit({ json: parsed.json });
  else if (parsed.data) emit({ id: parsed.id, data: parsed.data, ts: Date.now() });
}

export function openSource(kind, opts) {
  switch (kind) {
    case 'socketcan':
    case 'can':
      return openSocketcan(opts);
    case 'serial':
    case 'usb':
      return openSerial(opts);
    case 'lines':
    case 'file':
    case 'stdin':
      return openLines(opts);
    case 'mock':
    default:
      return openMock(opts);
  }
}
