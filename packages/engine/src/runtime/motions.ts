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

/** Half-angle epsilon inside which a Y rotation of ±90° is treated as gimbal lock. */
const GIMBAL_EPSILON = 1 - 1e-6;

// ── Scalar resolution ────────────────────────────────────────────────────────

/** Everything resolveScalar may read from the running model. */
export interface ScalarContext {
  params: Readonly<Record<string, number>>;
  /** Model time in seconds — the same clock runFrame uses. */
  elapsed: number;
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
type Quat = { w: number; x: number; y: number; z: number };

/** Read a transform triple with the quarantine applied — a NaN component reads as 0. */
function readVec3(value: readonly number[] | undefined, fallback: Vec3Tuple): Vec3Tuple {
  if (!value) return [...fallback];
  return [finiteOrZero(value[0] ?? 0), finiteOrZero(value[1] ?? 0), finiteOrZero(value[2] ?? 0)];
}

/**
 * Normalise an axis, or return null when it has no usable direction.
 *
 * A zero (or non-finite) axis is authorable — the schema only demands finite components — but it
 * has no angle to rotate through and no direction to travel, so the motion is a documented no-op
 * rather than a NaN factory (`NaN / 0` is exactly the poison this file refuses to produce).
 */
function normaliseAxis(axis: readonly number[] | undefined): Vec3Tuple | null {
  const v = readVec3(axis, [0, 0, 0]);
  const length = Math.hypot(v[0], v[1], v[2]);
  if (!Number.isFinite(length) || length < 1e-12) return null;
  return [v[0] / length, v[1] / length, v[2] / length];
}

function quatFromAxisAngle(axis: Vec3Tuple, angle: number): Quat {
  const half = angle / 2;
  const s = Math.sin(half);
  return { w: Math.cos(half), x: axis[0] * s, y: axis[1] * s, z: axis[2] * s };
}

function quatMultiply(a: Quat, b: Quat): Quat {
  return {
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
  };
}

/**
 * Euler (XYZ order) → quaternion, matching Three.js's default Euler order so a pose computed here
 * renders with exactly the orientation the numbers imply (`object.rotation.set` is XYZ too).
 */
function quatFromEulerXyz(euler: Vec3Tuple): Quat {
  const cx = Math.cos(euler[0] / 2);
  const sx = Math.sin(euler[0] / 2);
  const cy = Math.cos(euler[1] / 2);
  const sy = Math.sin(euler[1] / 2);
  const cz = Math.cos(euler[2] / 2);
  const sz = Math.sin(euler[2] / 2);
  return {
    w: cx * cy * cz - sx * sy * sz,
    x: sx * cy * cz + cx * sy * sz,
    y: cx * sy * cz - sx * cy * sz,
    z: cx * cy * sz + sx * sy * cz,
  };
}

/**
 * Quaternion → Euler (XYZ order), the inverse of `quatFromEulerXyz`.
 *
 * Rotation composition is quaternion work (Euler addition lies as soon as two axes are involved);
 * the pair of conversions is what lets a spin compose with an authored tilt and still be stored in
 * the Euler triple the manifest and the renderer speak.
 */
function eulerFromQuatXyz(q: Quat): Vec3Tuple {
  // m13 of the rotation matrix — the asin slot for XYZ order.
  const sinY = 2 * (q.x * q.z + q.w * q.y);
  if (Math.abs(sinY) < GIMBAL_EPSILON) {
    return [
      Math.atan2(2 * (q.w * q.x - q.y * q.z), 1 - 2 * (q.x * q.x + q.y * q.y)),
      Math.asin(Math.max(-1, Math.min(1, sinY))),
      Math.atan2(2 * (q.w * q.z - q.x * q.y), 1 - 2 * (q.y * q.y + q.z * q.z)),
    ];
  }
  // Gimbal lock: Y is ±90°, so X and Z are one degree of freedom. Convention (Three.js's): keep Z
  // at 0 and fold the freedom into X, which keeps the result continuous for a spinning part.
  return [
    Math.atan2(2 * (q.x * q.y + q.w * q.z), 2 * (q.w * q.y - q.x * q.z)),
    Math.asin(Math.max(-1, Math.min(1, sinY))),
    0,
  ];
}

/**
 * Rotate a vector about a unit axis (Rodrigues's formula).
 *
 * Used for orbit, where the *position vector* revolves; cheaper and clearer than building a
 * quaternion for a point that never needs interpolation.
 */
function rotateAboutAxis(v: Vec3Tuple, axis: Vec3Tuple, angle: number): Vec3Tuple {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const dot = axis[0] * v[0] + axis[1] * v[1] + axis[2] * v[2];
  const cross: Vec3Tuple = [
    axis[1] * v[2] - axis[2] * v[1],
    axis[2] * v[0] - axis[0] * v[2],
    axis[0] * v[1] - axis[1] * v[0],
  ];
  const oneMinusCos = 1 - cos;
  return [
    v[0] * cos + cross[0] * sin + axis[0] * dot * oneMinusCos,
    v[1] * cos + cross[1] * sin + axis[1] * dot * oneMinusCos,
    v[2] * cos + cross[2] * sin + axis[2] * dot * oneMinusCos,
  ];
}

/** The wrap fraction for flowAlongPath: any real t → [0, 1). Floor-wrap stays exact for negative t. */
function pathFraction(t: number): number {
  return t - Math.floor(t);
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

    const axis = normaliseAxis(motion.axis);
    if (!axis) continue;

    // `base` is the anchor of the absolute pose; `live` carries this tick's onFrame writes.
    const basePosition = readVec3(base.position, [0, 0, 0]);
    const livePosition = readVec3(live.position, basePosition);
    const liveRotation = readVec3(live.rotation, [0, 0, 0]);
    const baseScale = readVec3(base.scale, [1, 1, 1]);
    const liveScale = readVec3(live.scale, baseScale);

    // What onFrame displaced this tick, measured against the authored base. Position-channel
    // motions re-apply this delta after computing their own absolute pose, so model code that
    // tracks a target and declared motion that animates the same part coexist: neither clobbers
    // the other. (Rotation channels compose quaternion-side instead — see the per-kind comments.)
    const frameDelta: Vec3Tuple = [
      livePosition[0] - basePosition[0],
      livePosition[1] - basePosition[1],
      livePosition[2] - basePosition[2],
    ];

    // `elapsed` is the whole clock; phase distributes a set of same-rate motions around a turn.
    // A manifest missing its rate entirely (hand-built) resolves to 0 — still, never NaN.
    const phase = motion.phase ?? 0;
    const rate = resolveScalar(motion.rate ?? { const: 0 }, ctx);
    const angle = finiteOrZero(rate * ctx.elapsed + phase);

    switch (motion.kind) {
      case 'spin': {
        // Compose on the RIGHT of the live orientation: the axis is part-local (the schema's
        // words), so a part authored at a tilt keeps its tilt while spinning about its own shaft.
        // Composing onto live (not base) is what preserves an onFrame rotation write; the host's
        // pre-frame reset is what keeps that composition from accumulating.
        const q = quatMultiply(quatFromEulerXyz(liveRotation), quatFromAxisAngle(axis, angle));
        live.rotation = eulerFromQuatXyz(q);
        break;
      }

      case 'oscillate': {
        // rate is Hz, amplitude is metres (resolved through the same context so a slider can
        // drive stroke as directly as it drives speed).
        const amplitude = resolveScalar(motion.amplitude ?? { const: 1 }, ctx);
        const offset = finiteOrZero(amplitude * Math.sin(TAU * rate * ctx.elapsed + phase));
        live.position = [
          livePosition[0] + axis[0] * offset,
          livePosition[1] + axis[1] * offset,
          livePosition[2] + axis[2] * offset,
        ];
        break;
      }

      case 'orbit': {
        // Revolve the position vector about `center` (world/parent space; default origin),
        // preserving the authored radius, and compose the same angle on the LEFT of the part's
        // own orientation so it stays tidally locked like an orbiting body.
        const center = readVec3(motion.center, [0, 0, 0]);
        const radius: Vec3Tuple = [
          basePosition[0] - center[0],
          basePosition[1] - center[1],
          basePosition[2] - center[2],
        ];
        const revolved = rotateAboutAxis(radius, axis, angle);
        live.position = [
          center[0] + revolved[0] + frameDelta[0],
          center[1] + revolved[1] + frameDelta[1],
          center[2] + revolved[2] + frameDelta[2],
        ];
        const q = quatMultiply(quatFromAxisAngle(axis, angle), quatFromEulerXyz(liveRotation));
        live.rotation = eulerFromQuatXyz(q);
        break;
      }

      case 'translate': {
        // rate is m/s: displacement is velocity × time, amplitude scaling it (default 1).
        const amplitude = resolveScalar(motion.amplitude ?? { const: 1 }, ctx);
        const distance = finiteOrZero(amplitude * rate * ctx.elapsed);
        live.position = [
          livePosition[0] + axis[0] * distance,
          livePosition[1] + axis[1] * distance,
          livePosition[2] + axis[2] * distance,
        ];
        break;
      }

      case 'pulse': {
        // rate is Hz. The factor breathes in [1, 1 + amplitude] for positive amplitude and is
        // clamped at PULSE_MIN_FACTOR below, so an over-negative amplitude shrinks the part to
        // (effectively) nothing instead of inverting it — a mirrored mesh is geometry corruption.
        const amplitude = resolveScalar(motion.amplitude ?? { const: 1 }, ctx);
        const wave = 0.5 + 0.5 * Math.sin(TAU * rate * ctx.elapsed + phase);
        const factor = Math.max(PULSE_MIN_FACTOR, finiteOrZero(1 + amplitude * wave));
        live.scale = [
          finiteOrZero(liveScale[0] * factor),
          finiteOrZero(liveScale[1] * factor),
          finiteOrZero(liveScale[2] * factor),
        ];
        break;
      }

      case 'flowAlongPath': {
        // Position = the path sampled at the wrapped fraction. No sampler or no such path: skip
        // silently — the audit's missing-path dimension is where that defect is reported, and a
        // frame loop that throws takes the whole model down with it.
        if (!host.pointOnPath) continue;
        const point = host.pointOnPath(motion.pathId ?? '', pathFraction(angle));
        if (!point) continue;
        live.position = [
          finiteOrZero(point[0]) + frameDelta[0],
          finiteOrZero(point[1]) + frameDelta[1],
          finiteOrZero(point[2]) + frameDelta[2],
        ];
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
