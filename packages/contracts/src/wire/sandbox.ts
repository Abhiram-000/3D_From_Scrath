/**
 * The sandbox protocol: every message that crosses the boundary between the host and the untrusted
 * guest realm, plus the static gate's verdict shape.
 *
 * This is the narrowest interface in the platform and deliberately the most explicit. `00-GOAL.md`
 * makes it the one absolute rule — AI code "runs sandboxed, with access to the scene API and nothing
 * else" — and a protocol defined as data is what lets the same guest run in a browser Worker and in
 * `node:vm` for the headless audit, with no capability difference between them.
 */
import { z } from 'zod';
import { AuthoredId, finite, shortText } from '../primitives.ts';
import { MAX_LABELS, ModelManifest } from '../manifest/model.ts';
import { DeviceTier } from '../budgets.ts';
import { MAX_ANNOTATIONS_PER_MODEL } from '../settings.ts';

/** Why the gate rejected a program. Each maps to a specific repair instruction (`04` stage 3). */
export const GateViolationKind = z.enum([
  'syntax',
  /** `import`, `import()`, `export` — a module boundary is a capability the guest must not have. */
  'module_syntax',
  /** `eval`, `Function`, `with`, `new Function` — dynamic code would bypass the whole gate. */
  'dynamic_code',
  /** A forbidden global: `fetch`, `document`, `postMessage`, `Worker`, `localStorage`, … */
  'forbidden_global',
  /** A call to a scene-API name the engine does not export — usually a hallucinated helper. */
  'unknown_api',
  /** Reaching for `__proto__`, `constructor.constructor`, `prototype` mutation. */
  'prototype_access',
  /** Program larger than the ceiling, or nesting deeper than the parser guard allows. */
  'shape_limit',
  /** A loop the instrumentation could not guard, e.g. a labelled continue it cannot rewrite safely. */
  'unguardable_loop',
]);
export type GateViolationKind = z.infer<typeof GateViolationKind>;

export const GateViolation = z.object({
  kind: GateViolationKind,
  /** What was found, in words the repair prompt can act on. */
  message: shortText(300),
  line: z.number().int().min(0).optional(),
  column: z.number().int().min(0).optional(),
  /** The offending identifier or snippet, truncated. Shown in diagnostics. */
  snippet: shortText(200).optional(),
});
export type GateViolation = z.infer<typeof GateViolation>;

export const GateResult = z.object({
  ok: z.boolean(),
  violations: z.array(GateViolation).max(64).default([]),
  /** Program bytes after extraction, so truncation and bloat are both visible. */
  byteLength: z.number().int().min(0),
  /** Loops the instrumentation guarded. Zero loops in a 300-part model is itself a signal. */
  guardedLoops: z.number().int().min(0),
  /** Scene-API functions the program actually calls; feeds the audit's "did it use the API" evidence. */
  apiCalls: z.array(shortText(64)).max(256).default([]),
});
export type GateResult = z.infer<typeof GateResult>;

/** Host → guest: build this program under this budget. */
const buildRequest = z.object({
  type: z.literal('build'),
  requestId: shortText(64),
  /** Instrumented source. The guest never receives raw provider output. */
  code: z.string().max(1_500_000),
  tier: DeviceTier,
  /** Wall-clock milliseconds the authoring pass may take before the watchdog terminates the realm. */
  deadlineMs: z.number().int().positive().max(60_000),
  /** Seed for the guest's deterministic PRNG, so procedural variation is reproducible. */
  seed: z.number().int().nonnegative(),
});

/** Host → guest: the learner changed a parameter. */
const setParameterRequest = z.object({
  type: z.literal('setParameter'),
  id: AuthoredId,
  value: z.union([finite, z.boolean(), z.string().max(64)]),
});

/** Host → guest: advance one frame. `dt` is clamped by the host before it is sent (`02`, `08`). */
const frameRequest = z.object({
  type: z.literal('frame'),
  /** Seconds since the previous frame, clamped so a backgrounded tab cannot fast-forward the model. */
  dt: finite.min(0).max(0.25),
  /** Total elapsed model time, seconds — the authored clock, unaffected by the render rate. */
  elapsed: finite.min(0),
  paused: z.boolean(),
});

/** Host → guest: invoke a custom interaction handler the model registered. */
const invokeRequest = z.object({
  type: z.literal('invoke'),
  handlerId: AuthoredId,
  partId: AuthoredId.optional(),
});

/** Host → guest: release everything. Idempotent, and tolerant of partial prior failures (`02` R7). */
const disposeRequest = z.object({ type: z.literal('dispose') });

export const SandboxRequest = z.discriminatedUnion('type', [
  buildRequest,
  setParameterRequest,
  frameRequest,
  invokeRequest,
  disposeRequest,
]);
export type SandboxRequest = z.infer<typeof SandboxRequest>;

/** Guest → host: the authoring pass succeeded; here is the description of what it declared. */
const builtResponse = z.object({
  type: z.literal('built'),
  requestId: shortText(64),
  manifest: ModelManifest,
});

/**
 * Guest → host: the authoring pass threw.
 *
 * `00`: "a model that fails to build, crashes, or hangs must not take the viewer down. Show the error,
 * keep the page alive, offer a retry." So a guest fault is a *message*, not an exception that escapes.
 */
const failedResponse = z.object({
  type: z.literal('failed'),
  requestId: shortText(64),
  message: shortText(500),
  /** Guest-side stack, trimmed. Shown in the diagnostics panel; never surfaced to a learner. */
  stack: shortText(4000).optional(),
  /** True when the failure was the deadline, so the host can say "ran too long" rather than "crashed". */
  timedOut: z.boolean().default(false),
});

/**
 * Guest → host: per-frame writes, batched.
 *
 * Batching exists because a message per part per frame would cost more than the render. Transforms
 * travel as a flat `Float32Array`-compatible number list plus an id index, so the host can apply them
 * without allocating per part — the zero-allocation hot path `08` requires.
 */
const frameUpdateResponse = z.object({
  type: z.literal('frameUpdate'),
  /** Part ids in the same order as the packed transform data. */
  partIds: z.array(AuthoredId).max(4000),
  /** 10 floats per part: position(3), quaternion(4), scale(3). */
  transforms: z.array(finite).max(40_000),
  /** Material channel writes: `[index, emissiveIntensity, opacity, r, g, b]` per entry. */
  materialWrites: z.array(finite).max(24_000).default([]),
  /** Visibility flips as `[partIdIndex, 0|1]`. */
  visibilityWrites: z.array(z.number().int()).max(8_000).default([]),
  /** Metric values the model published this frame, keyed by metric id. */
  metrics: z.record(AuthoredId, finite).default({}),
});

/** Guest → host: a non-fatal problem the guest wants recorded (clamped value, skipped duplicate). */
const warningResponse = z.object({
  type: z.literal('warning'),
  message: shortText(300),
});

/** Guest → host: liveness during a long authoring pass, so the watchdog can tell slow from hung. */
const aliveResponse = z.object({
  type: z.literal('alive'),
  /** Parts declared so far — progress the host can show while a 300-part model is being written. */
  parts: z.number().int().min(0),
});

const disposedResponse = z.object({ type: z.literal('disposed') });

export const SandboxResponse = z.discriminatedUnion('type', [
  builtResponse,
  failedResponse,
  frameUpdateResponse,
  warningResponse,
  aliveResponse,
  disposedResponse,
]);
export type SandboxResponse = z.infer<typeof SandboxResponse>;

/** Floats per part in a packed `frameUpdate`: position(3) + quaternion(4) + scale(3). */
export const TRANSFORM_STRIDE = 10;

/** Floats per material write: index + emissive + opacity + rgb. */
export const MATERIAL_WRITE_STRIDE = 6;

/**
 * Ceilings the guest enforces on itself and the gate enforces on the source.
 *
 * Chosen from the failure they prevent, not from an idea of how big a model "should" be: `00` requires
 * 300-part ambition to be normal, so these are set where a runaway loop exhausts memory rather than
 * where a large model would be inconvenienced.
 */
export const SANDBOX_LIMITS = Object.freeze({
  /** Program size. A 300-part model written with component reuse is far under this. */
  maxCodeBytes: 1_500_000,
  /** Authoring pass deadline. Long enough for marching cubes on a complex SDF, short enough to kill. */
  buildDeadlineMs: 20_000,
  /** Per-frame deadline. A frame callback that exceeds it repeatedly gets the model paused, not killed. */
  frameDeadlineMs: 50,
  /** Consecutive frame overruns before the host pauses the model and says so. */
  frameOverrunLimit: 12,
  /** Total vertices one program may generate, across all geometries, before it is refused. */
  maxTotalVertices: 6_000_000,
  /** Iterations allowed in a single guarded loop before it throws. */
  maxLoopIterations: 20_000_000,
});

/**
 * Host ↔ worker view RPCs.
 *
 * A different dialect from the guest program protocol above: these messages never reach the guest
 * realm and no untrusted code can observe or answer them. They live in this file because they cross
 * the same sandbox boundary and must move with it — a pin the page stores and a point the worker
 * projects are two halves of one contract (`03` R7). They are deliberately *not* members of
 * `SandboxRequest`/`SandboxResponse`, which are the guest-facing dialect.
 */

/**
 * One pinned note's world point, reduced to exactly what projection consumes.
 *
 * `Annotation` in `settings.ts` is the persisted learner record — text, timestamp and all. The worker
 * needs none of that: it needs an id to answer with and a point to project, and sending the rest
 * across the boundary every frame would be paying to clone prose the worker cannot read.
 */
export const AnnotationPin = z.object({
  id: z.string().min(1).max(64),
  /** World-space point on the model; re-projected every frame as the camera moves (`03` R7). */
  point: z.tuple([finite, finite, finite]),
});
export type AnnotationPin = z.infer<typeof AnnotationPin>;

/** Host → worker: raycast this screen point against the realized scene and report the world hit. */
export const PointPickRequest = z.object({
  type: z.literal('pickPoint'),
  /** Correlates the reply, so two picks in flight cannot swap answers. */
  requestId: shortText(64),
  /** Canvas-space pixels, origin top-left — the same space pointer messages already use. */
  x: finite,
  y: finite,
});
export type PointPickRequest = z.infer<typeof PointPickRequest>;

/** Worker → host: where a pick ray landed, or an honest miss. */
export const PointPickResponse = z.object({
  type: z.literal('pickedPoint'),
  requestId: shortText(64),
  /**
   * The world-space point the ray struck, or `null` when it hit nothing. Never a guessed origin: a
   * pin placed at the model's centre because the click missed is a note attached to nothing.
   */
  point: z.tuple([finite, finite, finite]).nullable(),
  /** The nearest selectable part the ray passed through, when the geometry belongs to one. */
  partId: AuthoredId.nullable(),
});
export type PointPickResponse = z.infer<typeof PointPickResponse>;

/** Host → worker: this is the whole pin set; project these and forget any other. */
export const SetAnnotationsRequest = z.object({
  type: z.literal('setAnnotations'),
  /** Capped like the persisted list, so a stuck click cannot make the per-frame projection unbounded. */
  pins: z.array(AnnotationPin).max(MAX_ANNOTATIONS_PER_MODEL),
});
export type SetAnnotationsRequest = z.infer<typeof SetAnnotationsRequest>;

/**
 * One pin's screen position for this frame.
 *
 * `x`/`y` are present only when `visible`. A point behind the camera or outside the frustum has no
 * honest screen position — projecting it anyway mirrors it through the origin, which is how a pin
 * lands on the opposite side of the screen — so the visibility flag is the whole answer and the
 * coordinates are omitted rather than fabricated (`03` R7: pins "hide behind the camera").
 */
export const ProjectedAnnotation = z.object({
  id: z.string().min(1).max(64),
  visible: z.boolean(),
  /** Canvas-space pixels, origin top-left. Absent unless `visible`. */
  x: finite.optional(),
  y: finite.optional(),
});
export type ProjectedAnnotation = z.infer<typeof ProjectedAnnotation>;

/** Worker → host: every pin's position this frame. Sent at most once per presented frame, never when idle. */
export const AnnotationProjectionResponse = z.object({
  type: z.literal('annotationPositions'),
  pins: z.array(ProjectedAnnotation).max(MAX_ANNOTATIONS_PER_MODEL),
});
export type AnnotationProjectionResponse = z.infer<typeof AnnotationProjectionResponse>;

/**
 * One model-authored label's screen position.
 *
 * The same honesty rule as `ProjectedAnnotation`, for the same reason: a labelled part behind the
 * camera or outside the frustum has no screen position, and projecting it anyway mirrors it to the
 * wrong side of the screen. `visible: false` with no coordinates is the whole answer.
 *
 * Unlike a pin, a label's *prose* does not travel here. The word is manifest data the page already
 * holds (`manifest.labels`), keyed by `id`; re-sending it every frame would pay to clone prose the
 * overlay can look up. `id` is the join key.
 */
export const ProjectedLabel = z.object({
  id: z.string().min(1).max(64),
  visible: z.boolean(),
  /** Canvas-space pixels, origin top-left. Absent unless `visible`. */
  x: finite.optional(),
  y: finite.optional(),
});
export type ProjectedLabel = z.infer<typeof ProjectedLabel>;

/**
 * Worker → host: every model label's position, recomputed only when a labelled part may have moved.
 *
 * One-shot by design: a label on a static part is projected once and not again, so a model with
 * labels the learner is not looking at costs nothing per frame. The id set is bounded by `MAX_LABELS`,
 * the same ceiling the manifest enforces.
 */
export const LabelProjectionResponse = z.object({
  type: z.literal('labelPositions'),
  labels: z.array(ProjectedLabel).max(MAX_LABELS),
});
export type LabelProjectionResponse = z.infer<typeof LabelProjectionResponse>;

/**
 * The hard stops every clip is bounded by.
 *
 * `03` R8 allows "a duration cap", and the reason is the same one that governs the rest of this
 * platform: an export that can run until the tab dies is an export that eventually does. Both limits
 * are enforced in the worker itself, not merely offered to the caller.
 */
export const VIDEO_CLIP_LIMITS = Object.freeze({ maxSeconds: 10, maxBytes: 24_000_000 });

/**
 * What the device can actually do about video export.
 *
 * `03` R8 promises video clip recording, but `MediaRecorder` and `captureStream` do not exist on an
 * `OffscreenCanvas` in any browser, so the only honest route is WebCodecs (`VideoEncoder`). When the
 * probe reports `supported: false`, the UI can say "recording is not available on this device"
 * instead of offering a button that does nothing.
 */
export const VideoRecordingCapability = z.object({
  supported: z.boolean(),
  /** The WebCodecs codec string the probe accepted, when supported. */
  codec: z.string().max(32).optional(),
  /** Learner-facing explanation of why recording is unavailable. Absent when it is available. */
  reason: z.string().max(200).optional(),
  /** Hard cap on clip length, seconds. */
  maxSeconds: z.number().positive(),
  /** Hard cap on encoded bytes, so a clip can never grow without bound. */
  maxBytes: z.number().int().positive(),
});
export type VideoRecordingCapability = z.infer<typeof VideoRecordingCapability>;
