/**
 * The error taxonomy shared by the server and both clients.
 *
 * `04-BACKEND.md` requires an "error taxonomy that maps to client behavior" and is specific about the
 * mapping that matters most: a missing capability is **503, not 500** — "the server is fine, the
 * capability isn't". Codes live here so the client can branch on a stable string instead of parsing
 * prose, and so the words shown to a learner are written once, next to the reason they exist.
 */
import { z } from 'zod';

export const ErrorCode = z.enum([
  /** 400 — the request was malformed or out of bounds. The client must fix it, not retry it. */
  'bad_request',
  /** 401 — a write endpoint requires the bearer token and did not get a valid one. */
  'unauthorized',
  /** 404 — no such gallery id / model. */
  'not_found',
  /** 413 — payload above the configured ceiling. */
  'too_large',
  /** 429 — rate limited; `retryAfterSeconds` says when, because "wait" without a number is useless. */
  'rate_limited',
  /** 502 — the AI provider failed in a way we could not translate into an action. */
  'upstream_failed',
  /** 502 — the provider's reply was cut off. Named separately: never ship half a model (`04`). */
  'upstream_truncated',
  /** 502 — the provider declined the topic. Semantic, so it must not be retried automatically. */
  'upstream_refused',
  /** 429/502 — provider quota exhausted; actionable words, not a raw upstream error. */
  'upstream_quota',
  /** 503 — no AI key configured. Generation/chat/quiz are off; gallery and viewer still work (`04`). */
  'capability_absent',
  /** 503 — the process is draining for a redeploy. In-flight streams are told, not severed (`06`). */
  'draining',
  /**
   * 499-adjacent: the client went away mid-generation. The run stops instead of spending more
   * provider calls on work nobody is waiting for (`04`). It is a named code rather than a silent
   * stop so a client that reconnected can tell this apart from a generation that genuinely failed.
   */
  'cancelled',
  /** 500 — the AI wrote code that never passed the gate, even after bounded repair. */
  'generation_unrepairable',
  /** 500 — the model built but the audit rejected it as unusable (e.g. an empty scene). */
  'generation_rejected',
  /** 500 — an unexpected fault. Carries a request id and nothing else (`06`). */
  'internal',
]);
export type ErrorCode = z.infer<typeof ErrorCode>;

/**
 * The one error shape every endpoint returns.
 *
 * `message` is for the learner and must say what to do next; `detail` is optional operator-facing
 * context that is safe to show (a phase name, a count) — never a stack trace, never a provider dump.
 */
export const ApiError = z.object({
  error: z.object({
    code: ErrorCode,
    message: z.string().max(500),
    detail: z.string().max(1000).optional(),
    requestId: z.string().max(64),
    retryAfterSeconds: z.number().int().positive().optional(),
  }),
});
export type ApiError = z.infer<typeof ApiError>;

/** HTTP status for each code, so route handlers cannot drift from the taxonomy. */
export const ERROR_STATUS: Readonly<Record<ErrorCode, number>> = Object.freeze({
  bad_request: 400,
  unauthorized: 401,
  not_found: 404,
  too_large: 413,
  rate_limited: 429,
  upstream_failed: 502,
  upstream_truncated: 502,
  upstream_refused: 502,
  upstream_quota: 429,
  capability_absent: 503,
  draining: 503,
  /** The client hung up; nothing is listening for this status, but it must never read as a 5xx fault. */
  cancelled: 499,
  generation_unrepairable: 500,
  generation_rejected: 500,
  internal: 500,
});

/**
 * Whether a failure is worth retrying automatically.
 *
 * `04`: "retries for the transient, never for the semantic". A 429/503/timeout retries with backoff
 * because a minutes-long generation must not die to a blip; a safety refusal or a bad request fails
 * fast, because retrying a semantic rejection just spends money to be refused again.
 */
export const RETRYABLE: Readonly<Record<ErrorCode, boolean>> = Object.freeze({
  /** Retrying for someone who left is spending money on an audience of zero. */
  cancelled: false,
  bad_request: false,
  unauthorized: false,
  not_found: false,
  too_large: false,
  rate_limited: true,
  upstream_failed: true,
  upstream_truncated: true,
  upstream_refused: false,
  upstream_quota: true,
  capability_absent: false,
  draining: true,
  generation_unrepairable: false,
  generation_rejected: false,
  internal: true,
});

/**
 * Default learner-facing wording.
 *
 * Written here rather than at each throw site so the platform speaks with one voice, and so the rule
 * from `03` — "'Backend not running — start it with `npm run server`' beats 'Network error' the way a
 * teacher beats a shrug" — is enforced by the default rather than by whoever is typing.
 */
export const DEFAULT_ERROR_MESSAGE: Readonly<Record<ErrorCode, string>> = Object.freeze({
  cancelled: 'The generation was stopped because you left the page.',
  bad_request: 'That request could not be understood. Check the topic and try again.',
  unauthorized: 'This action needs a write token. Add it to your settings and retry.',
  not_found: 'That model no longer exists. It may have been deleted.',
  too_large: 'That was too large to accept. Try something shorter.',
  rate_limited: 'Too many requests in a short time. Wait a moment and try again.',
  upstream_failed: 'The AI service failed to answer. Try again in a moment.',
  upstream_truncated: 'The response was cut off before the model was complete. Try again.',
  upstream_refused:
    'The AI declined this topic. Try describing it differently, or pick a related concept.',
  upstream_quota: 'The AI service is out of quota right now. Wait a minute and try again.',
  capability_absent: 'AI generation is not configured on this server. The gallery still works.',
  draining: 'The server is restarting — your request was interrupted. Try again in a moment.',
  generation_unrepairable:
    'The AI produced code that could not be fixed. Try again, or rephrase the topic.',
  generation_rejected:
    'The generated model was empty or unusable, so it was refused rather than shown. Try again.',
  internal: 'Something went wrong on our side. Try again; the request id below helps us trace it.',
});
