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
import { ModelManifest } from '../manifest/model.ts';
import { DeviceTier } from '../budgets.ts';

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
