/**
 * Decode, map, parse, and a live mock-server round trip.
 *   node can/self-check.mjs
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDecoder, encodeSnapshot, toWire } from './decode.mjs';
import { parseLine } from './parse.mjs';
import { startServer } from './server.mjs';
import { createDriveMapper, mapCanFrame } from '../js/can-map.js';
import fs from 'node:fs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(fs.readFileSync(path.join(HERE, 'signals.model3.json'), 'utf8'));
let failed = 0;

function check(name, cond) {
  if (!cond) {
    failed += 1;
    console.error('FAIL', name);
  } else {
    console.log('ok  ', name);
  }
}

function near(a, b, tol = 0.6) {
  return Math.abs(a - b) <= tol;
}

const physical = {
  speedKmh: 80,
  pedalPct: 40,
  brakeState: 0,
  regenLight: 1,
  motorRpm: 650,
  torqueNm: -90,
  accelMps2: -1.5,
};
const decoder = createDecoder(config);
for (const frame of encodeSnapshot(config, physical)) decoder.push(frame);
const values = decoder.values();
check('speed roundtrip', near(values.speedKmh, 80, 0.1));
check('pedal roundtrip', near(values.pedalPct, 40, 0.5));
check('regen bit', values.regenLight === 1);
check('brake enum', values.brakeState === 0);
check('axle rpm roundtrip', near(values.motorRpm, 650, 0.15));
check('torque roundtrip', near(values.torqueNm, -90, 2));
check('accel roundtrip', near(values.accelMps2, -1.5, 0.01));

const wire = toWire(values, 'test');
check('wire pedal 0..1', near(wire.pedal, 0.4, 0.01));
check('wire keeps measured accel', near(wire.accelMps2, -1.5, 0.01));

const mem = { prevSpeed: null, prevT: 0, stopped: false, accelSmooth: 0 };
const mapped = mapCanFrame(wire, mem, undefined, 1000);
check('pedal becomes throttle', near(mapped.throttle, 0.4, 0.02));
check('measured decel kept', near(mapped.accelKmhps, -1.5 * 3.6, 0.05));
check('regen still raises brake', mapped.brake > 0.4);
check('rpm proxy from axle', mapped.rpmProxy != null && mapped.rpmProxy > 2000);

const noPedal = mapCanFrame(
  { speedKmh: 30, accelKmhps: 8 },
  { prevSpeed: null, prevT: 0, stopped: false, accelSmooth: 0 },
  undefined,
  2000,
);
check('throttle falls back to accel', near(noPedal.throttle, 0.5, 0.02));

const lamp = mapCanFrame(
  { speedKmh: 60, regenLight: 1 },
  { prevSpeed: null, prevT: 0, stopped: false, accelSmooth: 0 },
  undefined,
  3000,
);
check('regen lamp eases into overrun decel', lamp.accelKmhps <= -10);

const strong = mapCanFrame(
  { speedKmh: 60, accelKmhps: -8, regenLight: 1, torqueNm: -40 },
  { prevSpeed: null, prevT: 0, stopped: false, accelSmooth: 0 },
  undefined,
  4000,
);
check('real decel is not replaced', near(strong.accelKmhps, -8, 0.05));

const fromMotor = mapCanFrame(
  { motorRpm: 600 },
  { prevSpeed: null, prevT: 0, stopped: false, accelSmooth: 0 },
  undefined,
  5000,
);
const expectSpeed = (600 / 60) * 2.06 * 3.6;
check('speed from axle rpm', near(fromMotor.speedKmh, expectSpeed, 0.2));

const mapper = createDriveMapper();
mapper.map({ speedKmh: 0.4 }, 6000);
const held = mapper.map({ speedKmh: 0.4 }, 6200);
check('standstill latch', held.speedKmh === 0);
const moving = mapper.map({ speedKmh: 3 }, 6400);
check('standstill releases', near(moving.speedKmh, 3, 0.01));

const dumped = parseLine('(1466010733.100) can0 257#0102030405060708', 'auto');
check('candump line', dumped && dumped.id === 0x257 && dumped.data.length === 8);
const slcan = parseLine('t10880102030405060708', 'auto');
check('slcan line', slcan && slcan.id === 0x108 && slcan.data.length === 8);
const plain = parseLine('599 AABBCCDD', 'auto');
check('plain decimal id', plain && plain.id === 599 && plain.data.length === 4);
const asJson = parseLine('{"speedKmh":12,"pedal":0.2}', 'auto');
check('json line', asJson && asJson.json && asJson.json.speedKmh === 12);

const running = startServer({ port: 0, host: '127.0.0.1', source: 'mock', static: false, hz: 50 });
await running.listening;
const addr = running.server.address();
const samples = [];
const ws = new WebSocket(`ws://127.0.0.1:${addr.port}/`);
await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('ws open timeout')), 3000);
  ws.addEventListener('open', () => { clearTimeout(t); resolve(); });
  ws.addEventListener('error', () => { clearTimeout(t); reject(new Error('ws error')); });
});
await new Promise((resolve) => {
  const t = setTimeout(resolve, 8000);
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    samples.push(msg.speedKmh);
    if (samples.length > 400) { clearTimeout(t); resolve(); }
  });
});
ws.close();
await running.close();
const speeds = samples.filter((n) => Number.isFinite(n));
const min = Math.min(...speeds);
const max = Math.max(...speeds);
check('mock stream has samples', speeds.length > 20);
check('mock stream speed moves', max - min > 30);
check('mock stream tags source', samples.length > 0);

if (failed) {
  console.error(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log('\nself-check passed');
