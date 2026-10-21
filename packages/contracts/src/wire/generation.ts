/**
 * The generation wire protocol: NDJSON events streamed from the server while a model is built.
 *
 * `07-UI-UX.md` makes the loading page's honesty a core UX decision — "the bar only passes a milestone
 * when the phase behind it has *actually started*" — which is only possible if the server names its
 * phases. `04-BACKEND.md` adds the heartbeat: "a minutes-long model call that reports nothing is
 * indistinguishable from a dead socket, and the heartbeat is what makes silence diagnostic."
 *
 * Two rules the client depends on and this file encodes:
 *   1. every stream ends with exactly one terminal event (`ready` or `error`);
 *   2. a stream that ends without one is itself treated as a failure (`04`).
 */
import { z } from 'zod';
import { shortText } from '../primitives.ts';
import { ErrorCode } from './errors.ts';
import { ModelBundle } from '../manifest/model.ts';

/**
 * Pipeline phases, in the order they occur.
 *
 * The loading page maps these onto its four visible stages (Thinking → Generating → Compiling →
 * Ready); keeping the wire vocabulary finer-grained than the UI's means the UI can regroup without a
 * protocol change.
 */
/**
 * The wire vocabulary of generation phases, in the order they happen.
 *
 * Exported as an array as well as a type because the *order* is part of the contract: a client
 * that has no milestone for one of these phases still needs to know where it falls, so it can land
 * on the last milestone before it instead of ignoring it.
 */
export const GENERATION_PHASES = [
  'queued',
  'prompt',
  'model',
  'extract',
  'gate',
  'repair',
  'build',
  'audit',
  'refine',
  'persist',
  'ready',
] as const;

export const GenerationPhase = z.enum(GENERATION_PHASES);
export type GenerationPhase = z.infer<typeof GenerationPhase>;

/** Fraction of the whole run each phase is *nominally* worth, used only to ease within a stage. */
export const PHASE_WEIGHT: Readonly<Record<GenerationPhase, number>> = Object.freeze({
  queued: 0.01,
  prompt: 0.03,
  model: 0.55,
  extract: 0.02,
  gate: 0.03,
  repair: 0.08,
  build: 0.08,
  audit: 0.07,
  refine: 0.1,
  persist: 0.02,
  ready: 0.01,
});

const phaseEvent = z.object({
  type: z.literal('phase'),
  phase: GenerationPhase,
  /** Learner-facing sentence for this phase: "The model is designing your 3D scene…". */
  message: shortText(200),
  at: z.number().int().nonnegative(),
});

const heartbeatEvent = z.object({
  type: z.literal('heartbeat'),
  phase: GenerationPhase,
  /** Seconds elapsed in the current phase, so a stalled provider is visibly a stall, not a mystery. */
  phaseSeconds: z.number().min(0),
  /** Characters the provider has streamed this phase — proof of life while the program is written. */
  charsWritten: z.number().int().nonnegative().optional(),
  at: z.number().int().nonnegative(),
});

/**
 * A non-fatal event worth showing: a retried provider call, a repair pass, a refinement.
 *
 * `04`'s final image includes "one student's provider call dies to a 429 and is retried invisibly
 * inside the same stream" — invisible to the *flow*, but not undisclosed: the diagnostics panel shows
 * these, which is how a repaired model stops being a mystery.
 */
const noticeEvent = z.object({
  type: z.literal('notice'),
  kind: z.enum(['retry', 'repair', 'refine', 'downgrade', 'warning']),
  message: shortText(300),
  at: z.number().int().nonnegative(),
});

/**
 * The audit summary carried on terminal generation payloads (the ready event and the
 * non-streaming response share it).
 *
 * `unboundParameterIds` is the structured half of the battery's bindingCount: the parameter ids
 * the audit's `parameterLeverage` deficiencies accuse, so measurement code does subjectId
 * equality instead of grepping deficiency prose (where a parameter named `mass` matched the word
 * "massive"). Optional with a default so events from servers predating the field still parse.
 */
export const AuditSummary = z.object({
  score: z.number().min(0).max(100),
  deficiencies: z.array(shortText(300)).max(64).default([]),
  unboundParameterIds: z.array(shortText(64)).max(24).default([]),
});
export type AuditSummary = z.infer<typeof AuditSummary>;

/** Terminal success. Carries the whole bundle so the viewer needs no second round trip. */
const readyEvent = z.object({
  type: z.literal('ready'),
  bundle: ModelBundle,
  /** Audit score and deficiency list ride along so the client and analytics see generation quality (`04`). */
  audit: AuditSummary.optional(),
  /** Gallery id when the pipeline persisted the model as part of the run. */
  modelId: z.string().uuid().optional(),
  at: z.number().int().nonnegative(),
});

/** Terminal failure. The same taxonomy the non-streaming path returns, so clients share one handler. */
const errorEvent = z.object({
  type: z.literal('error'),
  code: ErrorCode,
  message: shortText(500),
  requestId: z.string().max(64),
  retryAfterSeconds: z.number().int().positive().optional(),
  at: z.number().int().nonnegative(),
});

export const GenerationEvent = z.discriminatedUnion('type', [
  phaseEvent,
  heartbeatEvent,
  noticeEvent,
  readyEvent,
  errorEvent,
]);
export type GenerationEvent = z.infer<typeof GenerationEvent>;

/** Convenience type guard for the two events that end a stream. */
export const isTerminalEvent = (event: GenerationEvent): boolean =>
  event.type === 'ready' || event.type === 'error';

/**
 * Interval between heartbeats during silent phases.
 *
 * `04` specifies ~10 s. The client's stall detector uses a multiple of this (not a bare timeout) so a
 * slow provider and a dead socket are distinguishable, which is the whole reason heartbeats exist.
 */
export const HEARTBEAT_INTERVAL_MS = 10_000;

/** Heartbeats missed before the client declares a stall and offers a retry (`07`, stall vs failure). */
export const STALL_HEARTBEATS = 4;

// ── The deadline invariant ─────────────────────────────────────────────────────────────────────
//
// THE DEADLINE INVARIANT: the server ALWAYS sends a terminal event before any client timer fires.
// Two client timers exist and must stay distinguishable (`STALL_HEARTBEATS × HEARTBEAT_INTERVAL_MS`
// measures true silence; the client's TOTAL is only a backstop), so the server's numbers are sized
// from the run's actual budgeted worst case — never inherited from a client constant:
//
//   client stall window .......... 40 s of true silence (liveness, heartbeats included)
//   server overall deadline ...... GENERATION_QUEUE_MAX_WAIT_MS + PIPELINE_DEADLINE_MS + detection
//   client backstop .............. CLIENT_TOTAL_BACKSTOP_MS  (strictly greater, see the arithmetic)
//
//   queue wait (≤ 900 s, AI_QUEUE_MAX_WAIT_MS default)
// + pipeline deadline (max 7 paid calls × 330 s per call + 60 s grace) = 2_370 s
// + deadline detection (≤ 1 s tick) + abort propagation + terminal write
// < client backstop = 900 + 2_370 + 120 = 3_390 s
//
// — so even a run that consumes its entire budget with the queue fully waited is still TOLD by the
// server before the client's backstop fires. The client's OWN aborts are then attributable: the
// stall detector means the model stopped responding; the backstop means the server broke THIS
// invariant, not that the feed went silent.

/**
 * Per-attempt provider timeout. The server's ai-client imports THIS constant (`REQUEST_TIMEOUT_MS`
 * is defined from it) so the per-attempt bound cannot drift from the deadline arithmetic above.
 */
export const PIPELINE_ATTEMPT_TIMEOUT_MS = 330_000;

/**
 * The most paid provider calls ONE pipeline run may budget, by design:
 * 1 generation + 3 continuation passes + 2 repair passes + 1 refinement pass = 7.
 * (The ai-client's model-cascade retries can multiply any ONE of these; the overall deadline is
 * what bounds that product — see the invariant above.)
 */
export const PIPELINE_MAX_PAID_CALLS = 7;

/**
 * Slack past the last paid call budget for extraction, gating, the audit's headless build and the
 * terminal write — stages that are bounded but not per-call.
 */
export const PIPELINE_DEADLINE_GRACE_MS = 60_000;

/**
 * The server's single OVERALL pipeline deadline: `PIPELINE_MAX_PAID_CALLS` budgets taken at their
 * per-attempt ceiling plus the bounded non-provider stages. 7 × 330 s + 60 s = 2_370 s (39.5 min).
 * `runPipeline` enforces this on its own wall clock and terminates the run — including aborting an
 * in-flight provider call — with a terminal error that names the deadline.
 */
export const PIPELINE_DEADLINE_MS =
  PIPELINE_MAX_PAID_CALLS * PIPELINE_ATTEMPT_TIMEOUT_MS + PIPELINE_DEADLINE_GRACE_MS;

/**
 * The bounded generation-queue wait the server also enforces before the pipeline starts
 * (mirrors the `AI_QUEUE_MAX_WAIT_MS` default in `apps/server/src/config/config.ts`; an env
 * override shifts it server-side only — the client backstop must stay above it under defaults).
 */
export const GENERATION_QUEUE_MAX_WAIT_MS = 900_000;

/**
 * Margin between the server's last possible terminal moment and the client's backstop: deadline
 * detection (1 s tick), abort propagation through the provider fetch, and the final socket write.
 */
export const CLIENT_BACKSTOP_MARGIN_MS = 120_000;

/**
 * The client's TOTAL backstop: queue wait + the server's overall deadline + margin. Strictly above
 * every server-side bound under default configuration — which is what makes the deadline invariant
 * above checkable: if this ever fires, the server, not the model, failed to report.
 */
export const CLIENT_TOTAL_BACKSTOP_MS =
  GENERATION_QUEUE_MAX_WAIT_MS + PIPELINE_DEADLINE_MS + CLIENT_BACKSTOP_MARGIN_MS;
