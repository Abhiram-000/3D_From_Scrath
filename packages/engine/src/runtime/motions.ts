/**
 * Declared-motion application — the runtime half of `scene.motion()`.
 *
 * `00-GOAL.md`: "the default state of a model is motion." The declaration side existed (the builder
 * captures `scene.motion()` into `manifest.motions`, the audit scores it, tests assert it) but
 * nothing applied it — the flagship model's fan stood still while its readouts moved. This module
 * is the missing consumer: given the authored base transforms and a scalar context, it writes the
 * animated pose into the live transforms the renderer reads.
 *
 * Two rules shape everything here:
 *
 * 1. **Absolute, never accumulated.** Every pose is computed from the authored base plus `elapsed`
 *    — never `rotation += …`. That is what makes reset exact, time-scrub exact, and a parameter
 *    change deterministic: the same inputs always yield the same pose, so this module holds no
 *    state of its own.
 *
 * 2. **Zero NaN, ever.** A single non-finite component silently breaks frustum culling and
 *    raycasting for a whole subtree (`08-PERFORMANCE-AND-DEVICES.md:108`), and the physics
 *    quarantine exists because of that class. Every scalar that enters a transform passes a
 *    finiteness guard; a non-finite source contributes 0 for that tick.
 *
 * Purity is load-bearing: no DOM, no Three.js, no Node APIs — the identical module runs under
 * Vitest and inside the browser worker, so what the tests prove is what the learner sees.
 */
import type { MotionDeclInput, ScalarSourceInput } from '@edu3d/contracts';

// ── Named constants ──────────────────────────────────────────────────────────

/** Radians in one turn. `oscillate` and `pulse` rates are Hz, so their phase term is 2π·rate·t. */
const TAU = Math.PI * 2;

/**
 * Lower bound for the pulse scale factor. A factor of exactly zero collapses the part (degenerate
 * matrix, NaN normals); a negative one mirrors it — geometry corruption either way. 1e-6 keeps the
 * part numerically valid while effectively invisible at full negative amplitude.
 */
const PULSE_MIN_FACTOR = 1e-6;

/**
 * Assumed frame rate when a host that tracks no frame counter binds `{ signal: 'frame' }`.
 * Deriving the counter from elapsed at 60 fps keeps a frame-bound rate plausible rather than 0.
 */
const FALLBACK_FPS = 60;

/** Threshold on |sin(y)| — the asin slot of the XYZ decomposition: at or above it (approaching 1, i.e. Y ≈ ±90°) the Euler triple is gimbal-locked. */
const GIMBAL_EPSILON = 1 - 1e-6;

// ── Scalar resolution ────────────────────────────────────────────────────────

/** Everything resolveScalar may read from the running model. */
export interface ScalarContext {
  params: Readonly<Record<string, number>>;
  /** Model time in seconds — the same clock runFrame uses. */
  elapsed: number;
  /**
   * Wall-clock seconds — advanced by the host even while the model is paused. Consumed only by
   * `runsWhilePaused` motions (and only while paused): the pausable clock freezes with the model,
   * so without this field a paused pulse recomputed the same scale every frame and the schema's
   * own "glow pulses may differ" example was unreachable.
   */
  unpausedElapsed?: number;
  /** Monotonic frame counter, if the host tracks one; else derive from elapsed at 60fps. */
  frame?: number;
  /** Physics probe read-outs by id, when a model runs physics. */
  probes?: Readonly<Record<string, number>>;
}

/**
 * The NaN quarantine gate. Applied to every value on its way into a transform: a non-finite source
 * is clamped to 0 for this tick rather than propagated — NaN poisons the render graph in ways that
 * never throw and are therefore never debugged from a stack trace.
 */
function finiteOrZero(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

/**
 * Resolve a ScalarSource to one finite number.
 *
 * Missing bindings resolve to 0, never NaN: a `param` the model never declared is an authoring
 * defect the audit reports, not a reason to corrupt the transform at 60 fps.
 *
 * The parameter is the *input* shape of the schema: the builder captures the guest's declaration
 * verbatim — `{ param: 'rpm' }` arrives without the schema's `scale: 1, offset: 0` defaults
 * applied, and the manifest never round-trips through zod on the load path. `scale` and `offset`
 * are therefore read through an `in` guard with defaults rather than trusted, because
 * `x * undefined` is NaN, the exact poison this module exists to keep out.
 */
export function resolveScalar(source: ScalarSourceInput, ctx: ScalarContext): number {
  const scale = 'scale' in source && typeof source.scale === 'number' ? source.scale : 1;
  const offset = 'offset' in source && typeof source.offset === 'number' ? source.offset : 0;
  let value: number;
  if ('const' in source) {
    value = source.const;
  } else if ('param' in source) {
    const param = ctx.params[source.param];
    value = (typeof param === 'number' ? param : 0) * scale + offset;
  } else if ('signal' in source) {
    // `time` and `simTime` are the same clock here — the worker advances both from `elapsed`;
    // the distinction exists so an author can say which they *mean*.
    const signal =
      source.signal === 'frame' ? (ctx.frame ?? ctx.elapsed * FALLBACK_FPS) : ctx.elapsed;
    value = signal * scale;
  } else {
    const probe = ctx.probes?.[source.probe];
    value = (typeof probe === 'number' ? probe : 0) * scale + offset;
  }
  return finiteOrZero(value);
}

// ── The host contract ────────────────────────────────────────────────────────

export interface PartTransformLike {
  position: [number, number, number] | number[];
  rotation?: [number, number, number] | number[];
  scale: [number, number, number] | number[];
}

export interface MotionHost {
  /** Declared motions as the builder captured them — defaults inside scalar sources may be absent. */
  motions: readonly MotionDeclInput[];
  /** The authored transform captured at load — never mutated by the applicator. */
  baseTransform(partId: string): PartTransformLike | undefined;
  /**
   * The live transform the renderer reads — mutated in place, every tick.
   *
   * The caller must have reset it to base (per motion-driven part) before the model's own frame
   * code ran this tick. That ordering is what lets an applicator be stateless and still compose
   * with `onFrame`: live holds `base ⊕ this tick's onFrame writes`, the motion composes on top,
   * and neither the motion's last-tick output nor `onFrame`'s intent is lost. Without the reset,
   * composing here would accumulate.
   */
  liveTransform(partId: string): PartTransformLike | undefined;
  /** Resolved path geometry for flowAlongPath: t in [0,1) → world position. */
  pointOnPath?(pathId: string, t: number): [number, number, number] | undefined;
}

// ── Vector and quaternion helpers (self-contained; the module may import nothing else) ──

type Vec3Tuple = [number, number, number];

/**
 * Module scratch, hoisted so a frame allocates nothing per motion.
 *
 * Every helper below reads into these slots and every case writes component-wise into the live
 * transform it already owns, so the per-motion temporaries of the original implementation (five
 * `readVec3` triples, the frame delta, two quaternion objects and an Euler triple per motion, per
 * frame, forever) are gone. Aliasing is safe because the slots are consumed synchronously inside
 * one case: nothing here escapes the loop iteration that filled it, `resolveScalar` is pure
 * arithmetic, and this module never re-enters itself.
 *
 * The live arrays themselves are written in place (`live.position[0] = …`), never replaced. That is
 * safe by the worker's contract: the host's pre-frame reset repopulates every motion-driven part
 * from its authored base before model code runs, so the buffer the applicator mutates is the host's
 * copy, not a shared manifest constant. A transform channel that starts undefined is allocated once
 * per part lifetime — the first write — and never again.
 */
const AXIS: Vec3Tuple = [0, 0, 0];
const BASE_POSITION: Vec3Tuple = [0, 0, 0];
const LIVE_POSITION: Vec3Tuple = [0, 0, 0];
const LIVE_ROTATION: Vec3Tuple = [0, 0, 0];
const BASE_SCALE: Vec3Tuple = [1, 1, 1];
const LIVE_SCALE: Vec3Tuple = [1, 1, 1];
const FRAME_DELTA: Vec3Tuple = [0, 0, 0];
const CENTER: Vec3Tuple = [0, 0, 0];
const RADIUS: Vec3Tuple = [0, 0, 0];
const ROTATED: Vec3Tuple = [0, 0, 0];
const EULER_OUT: Vec3Tuple = [0, 0, 0];

/**
 * One reusable scalar context for the scoped-clock path. Rebuilt per motion into the same object —
 * fields assigned, nothing spread — because `{ ...ctx }` per motion per frame was a context-shaped
 * allocation the audit could count from source.
 */
const SCOPED: { params: ScalarContext['params']; elapsed: number; unpausedElapsed?: number } = {
  params: undefined as unknown as ScalarContext['params'],
  elapsed: 0,
};

/** Read a transform triple with the quarantine applied — a NaN component reads as 0. */
function readVec3Into(
  out: Vec3Tuple,
  value: readonly number[] | undefined,
  fallback: Vec3Tuple,
): void {
  if (!value) {
    out[0] = fallback[0];
    out[1] = fallback[1];
    out[2] = fallback[2];
    return;
  }
  out[0] = finiteOrZero(value[0] ?? 0);
  out[1] = finiteOrZero(value[1] ?? 0);
  out[2] = finiteOrZero(value[2] ?? 0);
}

/**
 * Normalise an axis into `out`, or return false when it has no usable direction.
 *
 * A zero (or non-finite) axis is authorable — the schema only demands finite components — but it
 * has no angle to rotate through and no direction to travel, so the motion is a documented no-op
 * rather than a NaN factory (`NaN / 0` is exactly the poison this file refuses to produce).
 */
function normaliseAxisInto(out: Vec3Tuple, axis: readonly number[] | undefined): boolean {
  readVec3Into(out, axis, AXIS_ZERO);
  const length = Math.hypot(out[0], out[1], out[2]);
  if (!Number.isFinite(length) || length < 1e-12) return false;
  out[0] /= length;
  out[1] /= length;
  out[2] /= length;
  return true;
}

const AXIS_ZERO: Vec3Tuple = [0, 0, 0];
/** The identity fallback a transform channel reads as when a part was authored without one. */
const UNIT_SCALE: Vec3Tuple = [1, 1, 1];

// Quaternion arithmetic runs in four number locals rather than objects: the two conversions below
// are the only places w/x/y/z travel together, and a boxed {w,x,y,z} per motion per frame was the
// second-largest allocation in the loop.

/** Write the Euler (XYZ order) form of the quaternion `qw..qz` into `out`. */
function eulerFromQuatInto(out: Vec3Tuple, qw: number, qx: number, qy: number, qz: number): void {
  // m13 of the rotation matrix — the asin slot for XYZ order.
  const sinY = 2 * (qx * qz + qw * qy);
  if (Math.abs(sinY) < GIMBAL_EPSILON) {
    out[0] = Math.atan2(2 * (qw * qx - qy * qz), 1 - 2 * (qx * qx + qy * qy));
    out[1] = Math.asin(Math.max(-1, Math.min(1, sinY)));
    out[2] = Math.atan2(2 * (qw * qz - qx * qy), 1 - 2 * (qy * qy + qz * qz));
    return;
  }
  // Gimbal lock: Y is ±90°, so X and Z are one degree of freedom. Convention (Three.js's): keep Z
  // at 0 and fold the freedom into X, which keeps the result continuous for a spinning part.
  out[0] = Math.atan2(2 * (qx * qy + qw * qz), 2 * (qw * qy - qx * qz));
  out[1] = Math.asin(Math.max(-1, Math.min(1, sinY)));
  out[2] = 0;
}

/** Write the quaternion of the XYZ Euler triple in `e` into the four fields of `out`. */
function quatFromEulerInto(out: NumberQuartet, e: Vec3Tuple): void {
  const cx = Math.cos(e[0] / 2);
  const sx = Math.sin(e[0] / 2);
  const cy = Math.cos(e[1] / 2);
  const sy = Math.sin(e[1] / 2);
  const cz = Math.cos(e[2] / 2);
  const sz = Math.sin(e[2] / 2);
  out.w = cx * cy * cz - sx * sy * sz;
  out.x = sx * cy * cz + cx * sy * sz;
  out.y = cx * sy * cz - sx * cy * sz;
  out.z = cx * cy * sz + sx * sy * cz;
}

/** Write the quaternion of axis (unit) and angle into the four fields of `out`. */
function quatFromAxisInto(out: NumberQuartet, axis: Vec3Tuple, angle: number): void {
  const half = angle / 2;
  const s = Math.sin(half);
  out.w = Math.cos(half);
  out.x = axis[0] * s;
  out.y = axis[1] * s;
  out.z = axis[2] * s;
}

/**
 * Multiply `a × b` (`b` = local axis rotation for spin, right-composed; reversed order for orbit's
 * left composition) into `out`; then convert to the Euler triple in `euler`.
 */
function composeQuatInto(
  out: NumberQuartet,
  a: NumberQuartet,
  b: NumberQuartet,
  euler: Vec3Tuple,
): void {
  const w = a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z;
  const x = a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y;
  const y = a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x;
  const z = a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w;
  out.w = w;
  out.x = x;
  out.y = y;
  out.z = z;
  eulerFromQuatInto(euler, w, x, y, z);
}

type NumberQuartet = { w: number; x: number; y: number; z: number };
const QUAT_LIVE: NumberQuartet = { w: 1, x: 0, y: 0, z: 0 };
const QUAT_AXIS: NumberQuartet = { w: 1, x: 0, y: 0, z: 0 };

/**
 * Rodrigues rotation of the vector in `v` about the unit `axis`, written into `out`.
 *
 * Used for orbit, where the *position vector* revolves; cheaper and clearer than building a
 * quaternion for a point that never needs interpolation.
 */
function rotateAboutAxisInto(out: Vec3Tuple, v: Vec3Tuple, axis: Vec3Tuple, angle: number): void {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const dot = axis[0] * v[0] + axis[1] * v[1] + axis[2] * v[2];
  const oneMinusCos = 1 - cos;
  const cx = axis[1] * v[2] - axis[2] * v[1];
  const cy = axis[2] * v[0] - axis[0] * v[2];
  const cz = axis[0] * v[1] - axis[1] * v[0];
  out[0] = v[0] * cos + cx * sin + axis[0] * dot * oneMinusCos;
  out[1] = v[1] * cos + cy * sin + axis[1] * dot * oneMinusCos;
  out[2] = v[2] * cos + cz * sin + axis[2] * dot * oneMinusCos;
}

/** The wrap fraction for flowAlongPath: any real t → [0, 1). Floor-wrap stays exact for negative t. */
function pathFraction(t: number): number {
  return t - Math.floor(t);
}

/**
 * Write a transform channel by components — in place when the array exists (the every-frame case,
 * and the reason this helper exists), allocated once when a part was authored without the channel
 * (the original code replaced the array unconditionally, which is what the per-frame garbage was).
 * Mutating the host's arrays is the contract: the pre-frame reset repopulates every motion-driven
 * part from its authored base, so the applicator owns the buffer's contents for the tick.
 */
function setVec3(
  live: PartTransformLike,
  channel: 'position' | 'rotation' | 'scale',
  x: number,
  y: number,
  z: number,
): void {
  const target = live[channel];
  if (target) {
    target[0] = x;
    target[1] = y;
    target[2] = z;
    return;
  }
  if (channel === 'rotation') live.rotation = [x, y, z];
  else if (channel === 'scale') live.scale = [x, y, z];
  else live.position = [x, y, z];
}

// ── Application ──────────────────────────────────────────────────────────────

/**
 * Apply every declared motion for one tick.
 *
 * Per motion: skip when paused unless `runsWhilePaused`; skip parts the host cannot resolve (the
 * declaration site already rejects unknown part ids — this is the belt to that braces for a
 * manifest that somehow carries a dangling reference); compute from the authored base, compose
 * with whatever the model's own frame code left in the live transform, and write back in place.
 *
 * Never throws: a motion that cannot be evaluated (degenerate axis, unsampleable path) is skipped
 * for the tick. The frame loop must not die over presentation, and the audit is where authoring
 * defects are reported.
 */
export function applyMotions(host: MotionHost, ctx: ScalarContext, paused: boolean): void {
  for (const motion of host.motions) {
    if (paused && !motion.runsWhilePaused) continue;

    const base = host.baseTransform(motion.partId);
    const live = host.liveTransform(motion.partId);
    // A dangling part id is a no-op, not a crash: the declaration site throws on it, so reaching
    // here means a hand-built manifest — the applicator still owes the frame loop its life.
    if (!base || !live) continue;

    if (!normaliseAxisInto(AXIS, motion.axis)) continue;

    // `base` is the anchor of the absolute pose; `live` carries this tick's onFrame writes.
    readVec3Into(BASE_POSITION, base.position, AXIS_ZERO);
    readVec3Into(LIVE_POSITION, live.position ?? BASE_POSITION, BASE_POSITION);
    readVec3Into(LIVE_ROTATION, live.rotation, AXIS_ZERO);
    readVec3Into(BASE_SCALE, base.scale, UNIT_SCALE);
    readVec3Into(LIVE_SCALE, live.scale, BASE_SCALE);

    // What onFrame displaced this tick, measured against the authored base. Position-channel
    // motions re-apply this delta after computing their own absolute pose, so model code that
    // tracks a target and declared motion that animates the same part coexist: neither clobbers
    // the other. (Rotation channels compose quaternion-side instead — see the per-kind comments.)
    FRAME_DELTA[0] = LIVE_POSITION[0] - BASE_POSITION[0];
    FRAME_DELTA[1] = LIVE_POSITION[1] - BASE_POSITION[1];
    FRAME_DELTA[2] = LIVE_POSITION[2] - BASE_POSITION[2];

    // The clock this motion runs on. While paused, a runsWhilePaused motion consumes the host's
    // always-advancing wall clock when one is provided — the whole point of the flag — while every
    // other motion keeps the pausable clock and is skipped below anyway. The scoped context (built
    // only when the clocks differ) makes rate/amplitude resolution read the same clock as the
    // phase, so `{ signal: 'time' }` sources stay consistent with the motion's own timeline.
    const clock =
      paused && motion.runsWhilePaused && ctx.unpausedElapsed !== undefined
        ? ctx.unpausedElapsed
        : ctx.elapsed;
    let scoped: ScalarContext = ctx;
    if (clock !== ctx.elapsed) {
      SCOPED.params = ctx.params;
      SCOPED.elapsed = clock;
      SCOPED.unpausedElapsed = undefined;
      scoped = SCOPED;
    }

    // `clock` is the whole timeline for this motion; phase distributes a set of same-rate motions
    // around a turn. A manifest missing its rate entirely (hand-built) resolves to 0 — still,
    // never NaN.
    const phase = motion.phase ?? 0;
    const rate = resolveScalar(motion.rate ?? { const: 0 }, scoped);
    const angle = finiteOrZero(rate * clock + phase);

    switch (motion.kind) {
      case 'spin': {
        // Compose on the RIGHT of the live orientation: the axis is part-local (the schema's
        // words), so a part authored at a tilt keeps its tilt while spinning about its own shaft.
        // Composing onto live (not base) is what preserves an onFrame rotation write; the host's
        // pre-frame reset is what keeps that composition from accumulating.
        quatFromEulerInto(QUAT_LIVE, LIVE_ROTATION);
        quatFromAxisInto(QUAT_AXIS, AXIS, angle);
        composeQuatInto(QUAT_AXIS, QUAT_LIVE, QUAT_AXIS, EULER_OUT);
        setVec3(live, 'rotation', EULER_OUT[0], EULER_OUT[1], EULER_OUT[2]);
        break;
      }

      case 'oscillate': {
        // rate is Hz, amplitude is metres (resolved through the same context so a slider can
        // drive stroke as directly as it drives speed).
        const amplitude = resolveScalar(motion.amplitude ?? { const: 1 }, scoped);
        const offset = finiteOrZero(amplitude * Math.sin(TAU * rate * clock + phase));
        setVec3(
          live,
          'position',
          LIVE_POSITION[0] + AXIS[0] * offset,
          LIVE_POSITION[1] + AXIS[1] * offset,
          LIVE_POSITION[2] + AXIS[2] * offset,
        );
        break;
      }

      case 'orbit': {
        // Revolve the position vector about `center` (world/parent space; default origin),
        // preserving the authored radius, and compose the same angle on the LEFT of the part's
        // own orientation so it stays tidally locked like an orbiting body.
        readVec3Into(CENTER, motion.center, AXIS_ZERO);
        RADIUS[0] = BASE_POSITION[0] - CENTER[0];
        RADIUS[1] = BASE_POSITION[1] - CENTER[1];
        RADIUS[2] = BASE_POSITION[2] - CENTER[2];
        rotateAboutAxisInto(ROTATED, RADIUS, AXIS, angle);
        setVec3(
          live,
          'position',
          CENTER[0] + ROTATED[0] + FRAME_DELTA[0],
          CENTER[1] + ROTATED[1] + FRAME_DELTA[1],
          CENTER[2] + ROTATED[2] + FRAME_DELTA[2],
        );
        quatFromAxisInto(QUAT_AXIS, AXIS, angle);
        quatFromEulerInto(QUAT_LIVE, LIVE_ROTATION);
        composeQuatInto(QUAT_LIVE, QUAT_AXIS, QUAT_LIVE, EULER_OUT);
        setVec3(live, 'rotation', EULER_OUT[0], EULER_OUT[1], EULER_OUT[2]);
        break;
      }

      case 'translate': {
        // rate is m/s: displacement is velocity × time, amplitude scaling it (default 1).
        const amplitude = resolveScalar(motion.amplitude ?? { const: 1 }, scoped);
        const distance = finiteOrZero(amplitude * rate * clock);
        setVec3(
          live,
          'position',
          LIVE_POSITION[0] + AXIS[0] * distance,
          LIVE_POSITION[1] + AXIS[1] * distance,
          LIVE_POSITION[2] + AXIS[2] * distance,
        );
        break;
      }

      case 'pulse': {
        // rate is Hz. The factor breathes in [1, 1 + amplitude] for positive amplitude and is
        // clamped at PULSE_MIN_FACTOR below, so an over-negative amplitude shrinks the part to
        // (effectively) nothing instead of inverting it — a mirrored mesh is geometry corruption.
        const amplitude = resolveScalar(motion.amplitude ?? { const: 1 }, scoped);
        const wave = 0.5 + 0.5 * Math.sin(TAU * rate * clock + phase);
        // A non-finite wave is a host bug upstream (a NaN clock reached the applicator). Every
        // other kind degrades to "hold still"; pulse must too — holding at unity — rather than
        // clamp to PULSE_MIN_FACTOR, which quietly collapsed the part to near-invisibility.
        const factor = Number.isFinite(wave)
          ? Math.max(PULSE_MIN_FACTOR, finiteOrZero(1 + amplitude * wave))
          : 1;
        setVec3(
          live,
          'scale',
          finiteOrZero(LIVE_SCALE[0] * factor),
          finiteOrZero(LIVE_SCALE[1] * factor),
          finiteOrZero(LIVE_SCALE[2] * factor),
        );
        break;
      }

      case 'flowAlongPath': {
        // Position = the path sampled at the wrapped fraction. No sampler or no such path: skip
        // silently — the audit's missing-path dimension is where that defect is reported, and a
        // frame loop that throws takes the whole model down with it.
        if (!host.pointOnPath) continue;
        const point = host.pointOnPath(motion.pathId ?? '', pathFraction(angle));
        if (!point) continue;
        setVec3(
          live,
          'position',
          finiteOrZero(point[0]) + FRAME_DELTA[0],
          finiteOrZero(point[1]) + FRAME_DELTA[1],
          finiteOrZero(point[2]) + FRAME_DELTA[2],
        );
        break;
      }

      case 'follow':
      case 'sequence': {
        // Unimplementable from MotionDecl (no targetPartId, no states list); the declaration site
        // rejects both, so arriving here means a hand-built manifest. Skip rather than throw —
        // same rule as the dangling part id above.
        continue;
      }
    }
  }
}
