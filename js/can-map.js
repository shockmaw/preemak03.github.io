/**
 * CAN snapshot → the drive inputs AudioEngine (and the other runtimes) already take.
 *
 * This is app-system input, not a sound profile. It does not touch tone, waveguide
 * lengths, cylinder counts, or anything inside update(). The engines still derive
 * their own RPM from road speed through the profile gearbox — `rpmProxy` is the
 * motor/axle speed expressed in a combustion-tach band so the dash and a log can
 * see it. It is passed through setSpeed extras and ignored by the synth on purpose:
 * writing it into `_rpm` would bypass every profile (LAW 2).
 *
 * Wire snapshot (all fields optional; null = "not on this bus"):
 *   speedKmh, accelKmhps, accelMps2,
 *   pedal (0..1, or 0..100), brake (0..1),
 *   regen (0..1) or regenLight (0/1) + torqueNm,
 *   motorRpm  (drive-unit / axle RPM — see CAN_MAP.axleIsMotorShaft)
 *
 * Tunables live in CAN_MAP. Change them here, not in the engine.
 */

export const CAN_MAP = {
  /** Below this (km/h) the car is stopped. Hysteresis with movingKmh. */
  standstillKmh: 0.8,
  /** Must exceed this to leave the standstill latch. */
  movingKmh: 1.6,
  /** One-sample speed jump larger than this (and previous speed > 8) is a broken frame. */
  teleportKmh: 40,
  /** Hard ceiling. Above this the frame is ignored and the previous speed is kept. */
  maxSpeedKmh: 320,
  /** Reject absurd acceleration (km/h per second). */
  maxAccelKmhps: 80,

  /**
   * Rolling circumference of a Model 3 rear tire (235/45R18 is about 2.06 m).
   * Used only when the snapshot has motor/axle RPM and no vehicle-speed signal.
   */
  wheelCircumferenceM: 2.06,
  /**
   * The community Model 3 DBC signal DI_axleSpeed is the axle after the reduction,
   * so the default treats motorRpm as wheel-side RPM.
   * Set true if the bus actually reports motor-shaft RPM, and set motorGearRatio.
   */
  axleIsMotorShaft: false,
  /** Rear reduction. Used only when axleIsMotorShaft is true. Model 3 is ~9:1. */
  motorGearRatio: 9.0,
  /**
   * Telemetry scale: axle RPM × gain ≈ a combustion tach at the same road speed.
   * ~650 axle rpm at 80 km/h × 4 ≈ 2600, a plausible top-gear cruise.
   * Not written into the synth.
   */
  rpmProxyGain: 4,

  /** Fallback throttle: accelKmhps / this = 1.0 when the pedal signal is absent. */
  throttleFromAccelKmhps: 16,

  /** |torque| below this is not regen (sensor noise around zero). */
  regenTorqueDeadbandNm: 8,
  /** Negative torque that counts as regen = 1. */
  regenTorqueFullNm: 120,
  /**
   * Regen lamp with no torque magnitude still means "the car is regenerating".
   * 0.75 × regenAccelKmhps crosses the classic overrun latch (~−10 km/h/s,
   * because decelLoad > 0.38 and accelRef is 26). Lower it if the lamp is chatty.
   */
  regenFlagFloor: 0.75,
  /**
   * Engine-facing decel (km/h/s) at regen = 1, used only when the measured
   * accel is not already showing decel. Real accel wins once it is more
   * negative than regenMinDecelKmhps.
   */
  regenAccelKmhps: 14,
  regenMinDecelKmhps: 2,
  /** How much of `regen` is copied onto the brake input crank/vessel already read. */
  regenBrakeScale: 0.85,

  /** Differentiation window when neither accel field is present. */
  diffMinDt: 0.02,
  diffMaxDt: 1.0,
  /** EMA weight on a differentiated accel (measured accel is not smoothed here). */
  diffSmooth: 0.45,
};

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

function finite(v) {
  const n = +v;
  return Number.isFinite(n) ? n : null;
}

function unitInterval(v) {
  const n = finite(v);
  if (n == null) return null;
  if (n > 1 && n <= 100) return clamp(n / 100, 0, 1);
  return clamp(n, 0, 1);
}

/** Wheel-side RPM from the snapshot's motorRpm field. */
export function wheelRpmFromMotor(motorRpm, C = CAN_MAP) {
  const rpm = finite(motorRpm);
  if (rpm == null) return null;
  const mag = Math.abs(rpm);
  if (C.axleIsMotorShaft) {
    const ratio = C.motorGearRatio > 0 ? C.motorGearRatio : 1;
    return mag / ratio;
  }
  return mag;
}

export function speedFromWheelRpm(wheelRpm, C = CAN_MAP) {
  if (wheelRpm == null || !C.wheelCircumferenceM) return null;
  return (wheelRpm / 60) * C.wheelCircumferenceM * 3.6;
}

/**
 * 0..1 regen from an explicit field, or from the lamp + signed torque.
 * Positive torque is drive; negative torque is regen.
 */
export function regenAmount(frame, C = CAN_MAP) {
  const direct = unitInterval(frame && frame.regen);
  if (direct != null && frame.regen != null) return direct;
  const light = frame && frame.regenLight != null && +frame.regenLight > 0.5;
  let fromTorque = 0;
  const tq = finite(frame && frame.torqueNm);
  if (tq != null && tq < -C.regenTorqueDeadbandNm && C.regenTorqueFullNm > 0) {
    fromTorque = clamp(-tq / C.regenTorqueFullNm, 0, 1);
  }
  if (light) return Math.max(fromTorque, C.regenFlagFloor);
  return fromTorque;
}

function measuredAccel(frame, speed, mem, C, nowMs) {
  const direct = finite(frame && frame.accelKmhps);
  if (direct != null) return direct;
  const mps = finite(frame && frame.accelMps2);
  if (mps != null) return mps * 3.6;
  if (mem.prevSpeed != null && mem.prevT) {
    const dt = (nowMs - mem.prevT) / 1000;
    if (dt >= C.diffMinDt && dt <= C.diffMaxDt) {
      const raw = (speed - mem.prevSpeed) / dt;
      const w = clamp(C.diffSmooth, 0, 1);
      mem.accelSmooth = mem.accelSmooth * (1 - w) + raw * w;
      return mem.accelSmooth;
    }
  }
  return mem.accelSmooth || 0;
}

/**
 * @param {object} frame  CAN snapshot
 * @param {object} mem    persistent { prevSpeed, prevT, stopped, accelSmooth }
 * @param {object} [C]
 * @param {number} [nowMs]
 * @returns {object} drive inputs
 */
export function mapCanFrame(frame, mem, C = CAN_MAP, nowMs = Date.now()) {
  const src = frame || {};
  let speed = finite(src.speedKmh);
  const wheelRpm = wheelRpmFromMotor(src.motorRpm, C);
  if (speed == null && wheelRpm != null) speed = speedFromWheelRpm(wheelRpm, C);
  if (speed == null) speed = mem.prevSpeed != null ? mem.prevSpeed : 0;

  if (speed > C.maxSpeedKmh) speed = mem.prevSpeed != null ? mem.prevSpeed : 0;
  if (speed < 0) speed = 0;

  if (mem.prevSpeed != null && mem.prevSpeed > 8 && Math.abs(speed - mem.prevSpeed) > C.teleportKmh) {
    const jump = speed - mem.prevSpeed;
    speed = mem.prevSpeed + Math.sign(jump) * C.teleportKmh;
  }

  let accel = measuredAccel(src, speed, mem, C, nowMs);
  accel = clamp(accel, -C.maxAccelKmhps, C.maxAccelKmhps);

  const rawForLatch = speed;
  if (mem.stopped ? rawForLatch < C.movingKmh : rawForLatch < C.standstillKmh) {
    mem.stopped = true;
    speed = 0;
    if (Math.abs(accel) < 1.5) accel = 0;
  } else {
    mem.stopped = false;
  }

  const regen = regenAmount(src, C);
  if (regen > 0.05 && accel > -C.regenMinDecelKmhps) {
    const hinted = -regen * C.regenAccelKmhps;
    accel = Math.min(accel, hinted);
  }

  const pedal = unitInterval(src.pedal);
  let throttle;
  if (pedal != null && src.pedal != null) throttle = pedal;
  else throttle = clamp(Math.max(0, accel) / (C.throttleFromAccelKmhps || 16), 0, 1);

  let brake = unitInterval(src.brake);
  if (brake == null) brake = 0;
  brake = clamp(Math.max(brake, regen * C.regenBrakeScale), 0, 1);
  if (speed < 1 && throttle < 0.05 && accel >= -0.5) brake = 0;

  const rpmProxy = wheelRpm != null ? wheelRpm * C.rpmProxyGain : null;

  mem.prevSpeed = speed;
  mem.prevT = nowMs;
  mem.accelSmooth = accel;

  return {
    speedKmh: speed,
    accelKmhps: accel,
    throttle,
    brake,
    regen,
    rpmProxy,
    motorRpm: finite(src.motorRpm),
    source: src.source || null,
  };
}

export function createDriveMapper(overrides) {
  const C = overrides ? { ...CAN_MAP, ...overrides } : CAN_MAP;
  const mem = { prevSpeed: null, prevT: 0, stopped: true, accelSmooth: 0 };
  return {
    constants: C,
    reset() {
      mem.prevSpeed = null;
      mem.prevT = 0;
      mem.stopped = true;
      mem.accelSmooth = 0;
    },
    map(frame, nowMs = Date.now()) {
      return mapCanFrame(frame, mem, C, nowMs);
    },
  };
}
