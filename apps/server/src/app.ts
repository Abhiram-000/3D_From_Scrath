/**
 * The Hono application: routes, middleware, error taxonomy.
 *
 * `04` requires an API surface that is "small, versioned, and documented", validation at the boundary,
 * and an error taxonomy that maps to client behavior. `06` adds the security headers, the origin
 * allow-list, token-guarded writes and layered rate limits. This file wires all of it; each service
 * it imports owns one concern.
 */
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { bodyLimit } from 'hono/body-limit';
import {
  DEFAULT_ERROR_MESSAGE,
  ERROR_STATUS,
  ChatRequest,
  GalleryListQuery,
  GenerateRequest,
  PublishRequest,
  QuizRequest,
  HEARTBEAT_INTERVAL_MS,
  type ApiError,
  type ChatEvent,
  type ErrorCode,
  type GenerationEvent,
  type ModelBundle,
} from '@edu3d/contracts';
import type { ServerConfig } from './config/config.ts';
import { type AiClient, type CompletionRequest } from './services/ai-client.ts';
import { runPipeline } from './services/pipeline.ts';
import { describeQueueFailure, type GenerationQueue } from './services/generation-queue.ts';
import { buildChatPrompt, buildQuizPrompt } from './services/prompts.ts';
import type { GalleryStore } from './services/gallery-store.ts';
import { sniffSnapshot, SNAPSHOT_MAX_BYTES } from './services/gallery-store.ts';
import {
  limitWith,
  connectionAddress,
  isBatteryExemption,
  BATTERY_REQUEST_HEADER,
  type LimiterSet,
} from './services/rate-limits.ts';
import { staticSiteMiddleware } from './services/static-pages.ts';
import { timingSafeEqual, createHash } from 'node:crypto';
import { validateQuizQuestions } from './services/quiz.ts';

export interface AppState {
  config: ServerConfig;
  ai: AiClient;
  store: GalleryStore;
  limiters: LimiterSet;
  /**
   * The global generation queue, when one is configured. Optional so every existing construction
   * site (tests, older wiring) keeps compiling without one — absence means the old unbounded
   * behavior, presence means generation admission is gated by the provider plan's concurrency.
   */
  genQueue?: GenerationQueue;
  /** Drain state: flipped by SIGTERM, reported by readiness (`06`). */
  draining: boolean;
  openStreams: number;
  startedAt: number;
  remoteAddress: string;
}

type AppContext = { Variables: { requestId: string; state: AppState } };

/** Bounded ids: enough to correlate a client report with a log line, nothing more. */
const newRequestId = (): string =>
  Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

/**
 * The request-body ceiling. 8 MiB dominates the largest legitimate request several times over —
 * the biggest publish payload any client legitimately sends is a bundle plus a snapshot image
 * capped at SNAPSHOT_MAX_BYTES (4 MiB, gallery-store.ts) — while bounding what one request can
 * buffer. A constant, not an env var: no legitimate deployment wants an unbounded request body,
 * and a ceiling every deployment can silently raise to `none` is not a ceiling.
 */
const BODY_LIMIT_BYTES = 8 * 1024 * 1024;

/**
 * The content-security policies, per response surface.
 *
 * EMPIRICAL grounding (Playwright/chromium, real HTTP, no CDP injection): under a single policy
 * with `script-src 'self' 'unsafe-inline'`, `new Function` throws EvalError BOTH in an inline
 * document script and inside the sandbox worker — because CSP is a per-response header, and the
 * worker's response carried the document policy. The comment that used to live here claimed
 * "Guests render in a worker, so the policy never constrains model code" — that was the false
 * premise that shipped the production blocker: the policy constrained model code precisely.
 *
 * So there are two policies:
 *
 * - `DOCUMENT_POLICY` — unchanged from the shipped default, stays strict. No `'unsafe-eval'`:
 *   the page chrome never compiles string JS. What it gives up in defense depth is nothing this
 *   app needs; what it keeps is the blast-radius limit if some page-level script injection
 *   happens. (Verified: the model build path never evaluates in the document; the viewer builds
 *   through the worker.)
 * - `WORKER_POLICY` — the document policy with ONE permissive addition: `'unsafe-eval'` added to
 *   `script-src`, granted only to responses whose URL is a built worker chunk. Why it must exist:
 *   `packages/sandbox/src/compile.ts` (the hosted `new Function` at the realm boundary) compiles
 *   the guest model with `new Function(...)` inside the sandbox worker — string-to-function compilation is the
 *   product. Without the allowance every enforced-CSP production deployment dies with
 *   EvalError before a single triangle renders. What is given up: code inside that worker can
 *   compile and run arbitrary string JS without browser-level gating — which is the platform's
 *   own intent (the guest is supposed to run), so the actual safety gate remains the sandbox's
 *   static source checker, not eval absence; the strictness of the document surface is preserved.
 */
const WORKER_CHUNK_PREFIX = '/_app/immutable/workers/';
export const DOCUMENT_POLICY =
  "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; " +
  "worker-src 'self' blob:; frame-ancestors 'self'; base-uri 'self'; form-action 'self'";
export const WORKER_POLICY = DOCUMENT_POLICY.replace(
  "script-src 'self' 'unsafe-inline'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
);

/** The policy for one response surface: built worker chunks get the compiler's allowance. */
export function cspPolicy(pathname: string, publicOrigin: string | null = null): string {
  const isWorkerChunk = pathname.startsWith(WORKER_CHUNK_PREFIX) && pathname.endsWith('.js');
  const policy = isWorkerChunk ? WORKER_POLICY : DOCUMENT_POLICY;
  // `PUBLIC_ORIGIN` is only set for a split deployment — API and frontend on different origins —
  // and that is the one case where same-origin `connect-src 'self'` would block the shipped
  // client's own fetches from the page's origin. The server never loosens anything else (the CSP
  // stays the shipped policy in every same-origin deployment, where PUBLIC_ORIGIN is unset and
  // `connect-src 'self'` remains exactly what it says).
  if (isWorkerChunk || !publicOrigin) return policy;
  return policy.replace("connect-src 'self'", `connect-src 'self' ${publicOrigin}`);
}

/**
 * The one error shape every endpoint returns (`04`, `06`): a code the client branches on, a message
 * written for a learner, a request id — never a stack, never provider internals.
 */
export function apiError(
  code: ErrorCode,
  message: string,
  requestId: string,
  retryAfterSeconds?: number,
) {
  return {
    error: {
      code,
      message,
      requestId,
      ...(retryAfterSeconds ? { retryAfterSeconds } : {}),
    } satisfies ApiError['error'],
  };
}

/**
 * Guard a write endpoint with the bearer token, compared in constant time (`06`).
 *
 * Fails closed. With NO token configured, writes are refused in production unless the operator
 * explicitly accepted open writes (`EDU3D_ALLOW_OPEN_WRITES=true`). The old guard returned `true`
 * whenever no token was set, so the boot-time refusal was the ONLY line of defense for anonymous
 * publishes and deletes — any reload of the same posture (an entrypoint that resolves env late, a
 * config edit mistimed mid-boot) served `POST /api/gallery` to the internet with a 201. The other
 * half of the same defect: a token-CONFIGURED server refused the browser's anonymous publish with
 * 401, and the share modal had no way to send one — the fix lives in share-modal.svelte, which
 * prompts for the token once, stores it, and sends `Authorization: Bearer`.
 */
function requireWriteToken(state: AppState, authorization: string | undefined): boolean {
  const { writeToken, allowOpenWrites } = state.config.security;
  if (!writeToken) return allowOpenWrites || !state.config.isProduction;
  const provided = authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!provided) return false;
  // Hash both sides then timingSafeEqual: naive === leaks length and prefix (`06`).
  const a = createHash('sha256').update(provided).digest();
  const b = createHash('sha256').update(writeToken).digest();
  return timingSafeEqual(a, b);
}

type PipelineResult = Awaited<ReturnType<typeof runPipeline>>;

/**
 * The reserved tag marking an entry as a SERVER auto-save rather than an explicit publish.
 *
 * Provenance without a contract change: `GalleryEntry.tags` already exists and is already returned
 * by `list`, so a reserved tag is the whole story — a future moderation pass can select auto-saved
 * entries with it, and a published entry simply does not carry it (the publish path writes its own
 * tag list). The string is reserved and documented here and in the `generation.ts` contract comment.
 */
export const AUTO_SAVE_TAG = 'auto';

/**
 * Persist a successful generation to the gallery store, swallowing any failure.
 *
 * This lives at the route/state boundary, NOT in `services/pipeline.ts`: the pipeline is the
 * testable core and is deliberately store-free, so a store handle is never threaded into it. It runs
 * exactly once per successful run, and ONLY on success — a failed, cancelled, drained or timed-out
 * generation never reaches here because the caller only invokes it on `result.ok`.
 *
 * The single most important behaviour: a store failure is LOGGED AND SWALLOWED. The learner already
 * waited minutes for their model; a gallery write that throws must never fail the generation. This is
 * the repo's "degrade, never die" rule — the returned id is null on any failure and the terminal
 * `ready` event simply carries no `galleryId`.
 */
async function autoSaveGeneration(state: AppState, bundle: ModelBundle): Promise<string | null> {
  if (!state.config.security.autoSaveGenerations) return null;
  try {
    const manifest = bundle.manifest ?? {};
    const tags = [AUTO_SAVE_TAG, ...(manifest.domain ? [manifest.domain] : [])];
    for (const parameter of manifest.parameters ?? []) {
      if (tags.length >= 8) break;
      if (
        typeof parameter.id === 'string' &&
        parameter.id.length > 0 &&
        !tags.includes(parameter.id)
      ) {
        tags.push(parameter.id);
      }
    }
    // `subdomain` is a finer hint than `domain`, but `GalleryEntry.subject` caps at 48 chars, so an
    // over-long subdomain falls back to the always-short domain. This keeps an auto-saved entry
    // parseable by the same `GalleryEntry` schema the gallery list is read with.
    const subdomain = manifest.subdomain;
    const subject =
      typeof subdomain === 'string' && subdomain.length > 0 && subdomain.length <= 48
        ? subdomain
        : (manifest.domain ?? 'other');
    const record = await state.store.put({
      name: manifest.name ?? 'Untitled model',
      subject,
      tags,
      bundle,
      // No server-rendered snapshot: the server never renders a pixel, so an auto-saved entry has
      // no thumbnail. The gallery renders that honestly (a labelled placeholder), never a broken img.
      snapshotUrl: null,
    });
    return record.id;
  } catch (error) {
    // Logged with intent, never swallowed silently (`09`): the generation still succeeds.
    console.warn(
      `[auto-save] a generation could not be saved to the gallery: ${(error as Error).message}`,
    );
    return null;
  }
}

/**
 * Run the generation pipeline holding one generation slot when the state carries a queue.
 *
 * The provider plan allows a fixed concurrency (often exactly one), generations take minutes, and
 * an admission gate the request can SEE is the difference between "waiting, honestly" and
 * "mysteriously hanging". While WAITING this helper emits heartbeats (phase `queued`) and one
 * explanatory `notice`, so the web client's stall detector — a heartbeat multiple — stays alive
 * through the queue; `onGranted` stops the interval exactly where the pipeline's own heartbeat
 * loop takes over. The interval deliberately lives here, not in the queue module: the queue stays
 * wire-free, and `/api/health` keeps answering immediately (depth is reported, never waited on).
 * For the non-streaming path the same events are buffered into the discarding sink and simply
 * never served.
 */
async function runWithGenerationSlot(
  state: AppState,
  run: () => Promise<PipelineResult>,
  options: { signal?: AbortSignal; sink?: (event: GenerationEvent) => void },
): Promise<PipelineResult> {
  const queue = state.genQueue;
  if (!queue) return run();
  const sink = options.sink ?? (() => {});
  const queuedAt = Date.now();
  let heartbeats: ReturnType<typeof setInterval> | null = setInterval(() => {
    sink({
      type: 'heartbeat',
      phase: 'queued',
      phaseSeconds: (Date.now() - queuedAt) / 1000,
      at: Date.now(),
    });
  }, HEARTBEAT_INTERVAL_MS);
  const stopHeartbeats = () => {
    if (heartbeats) {
      clearInterval(heartbeats);
      heartbeats = null;
    }
  };
  try {
    return await queue.run(run, {
      signal: options.signal,
      onQueued: (position, depth) =>
        sink({
          type: 'notice',
          kind: 'warning',
          message:
            `Waiting for a free generation slot — position ${position} of ${depth}. ` +
            'Your run starts as soon as the current one finishes.',
          at: Date.now(),
        }),
      onGranted: stopHeartbeats,
    });
  } catch (error) {
    // A queue refusal (wait timeout, drain, the learner leaving while queued) must still end the
    // stream with its proper terminal event — mapped onto the same taxonomy as any pipeline failure.
    const refusal = describeQueueFailure(error);
    if (refusal) return { ok: false as const, failure: refusal };
    throw error;
  } finally {
    stopHeartbeats();
  }
}

export function buildApp(state: AppState): Hono<AppContext> {
  const app = new Hono<AppContext>();
  const { config } = state;

  // ── Request id + structured logging context ───────────────────────────────
  app.use('*', async (context, next) => {
    const requestId = newRequestId();
    context.set('requestId', requestId);
    context.header('x-request-id', requestId);

    // forceHttps, now honoured: the proxy declares the client's scheme via x-forwarded-proto
    // (only meaningful with TRUST_PROXY set, which production requires), and an http request
    // under `forceHttps` gets a 308 before anything runs. The health checks hit loopback
    // directly and carry no proxy header, so they cannot redirect-loop; requests with no proxy
    // header are loopback by construction on this deployment shape and pass through untouched.
    if (config.security.forceHttps && context.req.header('x-forwarded-proto') === 'http') {
      const url = new URL(context.req.url);
      return context.redirect(`https://${url.host}${url.pathname}${url.search}`, 308);
    }
    return await next();
  });

  // ── Security headers (`06`) ───────────────────────────────────────────────
  app.use('*', async (context, next) => {
    await next();
    context.header('x-content-type-options', 'nosniff');
    context.header('referrer-policy', 'strict-origin-when-cross-origin');
    context.header('x-frame-options', 'SAMEORIGIN');
    if (config.security.hsts)
      context.header('strict-transport-security', 'max-age=31536000; includeSubDomains');

    // CSP, resolved in config and — before this middleware existed — printed in the startup
    // banner and then dropped. `enforce` ships a locked-down default (the platform is fully
    // self-contained: no external scripts, frames or forms); `report-only` observes without
    // breaking anything so deployments can test before they flip. The policy is selected PER
    // RESPONSE SURFACE (see `cspPolicy`): documents stay strict, built worker chunks carry the
    // one allowance the sandbox compiler requires — the shipped single-policy version broke
    // every model build in production with EvalError (verified in the browser; RED evidence in
    // tests/app.test.ts).
    if (config.security.csp !== 'off') {
      const policy = cspPolicy(new URL(context.req.url).pathname, config.publicOrigin);
      // Violations surface in the browser console; no report sink means no report noise and no
      // endpoint for a misconfigured client to spray.
      context.header('content-security-policy-report-only', policy);
      if (config.security.csp === 'enforce') context.header('content-security-policy', policy);
    }
  });

  // ── Request-body ceiling ─────────────────────────────────────────────────
  // Registered after the request id exists and BEFORE CORS and any limiter: an oversized body is
  // refused before it is parsed, before it spends a rate-limit bucket, and before anything reads
  // it into memory. Without this middleware one request could buffer an arbitrary body — every
  // byte of a publish request lands in RAM before validation has a say.
  app.use(
    '*',
    bodyLimit({
      maxSize: BODY_LIMIT_BYTES,
      onError: (context) =>
        context.json(
          apiError(
            'too_large',
            DEFAULT_ERROR_MESSAGE.too_large,
            context.get('requestId') ?? 'unknown',
          ),
          413,
        ),
    }),
  );

  // ── CORS: allow-list, never * in production (`06`) ────────────────────────
  app.use(
    '*',
    cors({
      origin: (origin) => (config.allowedOrigins.includes(origin) ? origin : undefined),
      allowHeaders: ['content-type', 'authorization'],
      allowMethods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
    }),
  );
  // Note on CORS preflights and the limiter: hono's cors middleware answers an OPTIONS preflight
  // itself and never calls `next`, so middleware registered after it — including the /api/*
  // limiter below — never observes them, and they consume no budget. That is the desired shape:
  // for a cross-origin deployment every learner fetch would otherwise pay double (preflight +
  // request), and a browser refused on a preflight reports the failure as opaque network noise
  // rather than a 429 it could message. Preflights are cheap, carry nothing to protect, and rate
  // limiting them would only penalize real browsers.

  // ── API limiter: everything under /api, with the health pair exempt ───────
  app.use('/api/*', async (context, next) => {
    // Health and readiness are exempt explicitly. The old comment claimed they were exempt "by
    // not going through it" — false: they are registered inside /api/* and paid for every
    // monitoring poll out of the same bucket, so a kubectl-watching classroom locked the service
    // out of its own budgets (`06`: monitoring must never do that). Exact matches, not prefixes,
    // so a hostile `/api/healthX` path still pays.
    if (context.req.path === '/api/health' || context.req.path === '/api/ready')
      return await next();
    const guard = limitWith(state.limiters.api, config.trustProxy, state.remoteAddress);
    const result = await guard(context, next);
    if (result) return result;
    return context.res;
  });

  // ── Health: liveness and readiness are separate (`06`) ────────────────────
  app.get('/api/health', (context) => {
    const draining = state.draining;
    return context.json({
      status: draining ? 'draining' : 'ok',
      uptimeSeconds: Math.floor((Date.now() - state.startedAt) / 1000),
      version: '0.1.0',
      capabilities: {
        ai: config.ai.configured,
        database: state.store.announcement.backend === 'postgres',
        snapshots: true,
      },
      storage: state.store.announcement.backend,
      warnings: [
        ...config.warnings.map((warning) => warning.message),
        ...(state.store.announcement.notice ? [state.store.announcement.notice] : []),
        ...state.store.announcement.warnings,
      ],
      openGenerationStreams: state.openStreams,
      // Queue depth, additive and immediate: monitoring pollutes nothing and waits on nothing.
      ...(state.genQueue ? { generationQueue: state.genQueue.stats() } : {}),
    });
  });

  app.get('/api/ready', (context) =>
    state.draining ? context.json({ status: 'draining' }, 503) : context.json({ status: 'ready' }),
  );

  // ── Generation: the streamed pipeline (`04`) ──────────────────────────────
  app.post('/api/generate', async (context) => {
    const requestId = context.get('requestId');

    // The topic battery is an HTTP client of this route, so without an exemption the generate
    // limiter counts its own topics against it and the battery records its 429s as build
    // failures. The exemption is explicit and narrow by construction: the battery's marker
    // header AND the actual loopback socket (read from the connection, never from a header an
    // internet client controls). Anything else — remote address, missing header, wrong value —
    // is limited exactly as before.
    if (
      !isBatteryExemption(context.req.header(BATTERY_REQUEST_HEADER), connectionAddress(context))
    ) {
      const guard = limitWith(state.limiters.generate, config.trustProxy, state.remoteAddress);
      const limited = await guard(context, async () => undefined);
      if (limited) return limited;
    }

    if (state.draining) {
      return context.json(apiError('draining', DEFAULT_ERROR_MESSAGE.draining, requestId), 503);
    }

    // Validation before the capability gate: "malformed input dies at the door with a 400, never
    // reaches the pipeline" (`04`) — and a client with a broken request should hear about the request,
    // not the server's key situation.
    const parsed = GenerateRequest.safeParse(await context.req.json().catch(() => null));
    if (!parsed.success) {
      return context.json(
        apiError('bad_request', DEFAULT_ERROR_MESSAGE.bad_request, requestId),
        400,
      );
    }
    const request = parsed.data;

    if (!config.ai.configured) {
      return context.json(
        apiError('capability_absent', DEFAULT_ERROR_MESSAGE.capability_absent, requestId),
        503,
      );
    }

    if (!request.stream) {
      // Non-streaming clients get the same payload as one JSON object — content negotiation, not a
      // separate endpoint (`04`). Internally it is the same pipeline with a discarding sink.
      const events: unknown[] = [];
      const result = await tracked(state, () =>
        runWithGenerationSlot(
          state,
          () =>
            runPipeline(request.topic, request.complexity, {
              ai: state.ai,
              sink: (event) => events.push(event),
              tier: request.tier ?? 'mid',
              maxOutputTokens: config.ai.maxOutputTokens,
              // The learner's connection, so a closed tab stops the run instead of letting it spend
              // up to three more provider calls on work nobody is waiting for (`04`).
              signal: context.req.raw.signal,
            }),
          { signal: context.req.raw.signal },
        ),
      );
      if (!result.ok) {
        const { failure } = result;
        return context.json(
          apiError(failure.code, failure.message, requestId, failure.retryAfterSeconds),
          ERROR_STATUS[failure.code] as 400 | 401 | 404 | 413 | 429 | 500 | 502 | 503,
        );
      }
      // Auto-save the successful run (store-free pipeline; the boundary persists). A store failure
      // yields null and the response is byte-identical to one with auto-save off.
      const galleryId = await autoSaveGeneration(state, result.bundle);
      return context.json({
        bundle: result.bundle,
        audit: result.audit,
        requestId,
        ...(galleryId ? { galleryId } : {}),
      });
    }

    // NDJSON: every event flushed at the write, never buffered (`04`).
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const encoder = new TextEncoder();
        // A closed controller means the client disconnected (`04`: "stop charging for work nobody
        // is waiting for; never write to a dead socket"). Every write checks, because the pipeline's
        // heartbeat timer fires on its own schedule and an enqueue into a closed controller is an
        // uncaught exception that would take the whole server down — one dropped reader must never
        // kill the process serving everyone else.
        let clientGone = false;
        const write = (event: unknown) => {
          if (clientGone) return;
          try {
            controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
          } catch {
            clientGone = true;
          }
        };
        state.openStreams += 1;
        try {
          write({
            type: 'phase',
            phase: 'queued',
            message: 'Sending your topic to the model…',
            at: Date.now(),
          });
          const result = await tracked(state, () =>
            runWithGenerationSlot(
              state,
              () =>
                runPipeline(request.topic, request.complexity, {
                  ai: state.ai,
                  sink: write,
                  tier: request.tier ?? 'mid',
                  maxOutputTokens: config.ai.maxOutputTokens,
                  // Same reason as the non-streaming path: the wait is long enough to be abandoned.
                  signal: context.req.raw.signal,
                }),
              // While queued, this sink carries the waiting notice and the heartbeats that keep
              // the client's stall detector alive (see runWithGenerationSlot).
              { signal: context.req.raw.signal, sink: write },
            ),
          );
          if (result.ok) {
            // Auto-save before the terminal event, so the ready event can carry the id the share
            // path uses to update this entry in place. A store failure yields null — and the learner
            // STILL receives `ready`. The gallery must never take the model down with it.
            const galleryId = await autoSaveGeneration(state, result.bundle);
            write({
              type: 'ready',
              bundle: result.bundle,
              audit: result.audit,
              ...(galleryId ? { galleryId } : {}),
              at: Date.now(),
            });
          } else {
            write({
              type: 'error',
              code: result.failure.code,
              message: result.failure.message,
              requestId,
              ...(result.failure.retryAfterSeconds
                ? { retryAfterSeconds: result.failure.retryAfterSeconds }
                : {}),
              at: Date.now(),
            });
          }
        } catch {
          // The catch-all the client depends on: a stream must end with exactly one terminal event.
          write({
            type: 'error',
            code: 'internal',
            message: DEFAULT_ERROR_MESSAGE.internal,
            requestId,
            at: Date.now(),
          });
        } finally {
          state.openStreams -= 1;
          // Closing an already-closed controller throws; guard it the same way.
          try {
            controller.close();
          } catch {
            /* the reader is already gone */
          }
        }
      },
    });

    return new Response(stream, {
      headers: {
        'content-type': 'application/x-ndjson; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        // Any proxy in the chain must not buffer: a heartbeat nobody sees is a dead socket (`04`).
        'x-accel-buffering': 'no',
        // A bare `new Response` does not carry the context headers the middleware staged (Hono
        // semantics), and a failed generation stream is exactly the event a learner reports —
        // correlation is the one thing it must carry (B6).
        'x-request-id': requestId,
      },
    });
  });

  // ── Chat: the tutor, streaming (`05`) ─────────────────────────────────────
  app.post('/api/chat', async (context) => {
    const requestId = context.get('requestId');
    const guard = limitWith(state.limiters.chat, config.trustProxy, state.remoteAddress);
    const limited = await guard(context, async () => undefined);
    if (limited) return limited;
    if (state.draining)
      return context.json(apiError('draining', DEFAULT_ERROR_MESSAGE.draining, requestId), 503);

    const parsed = ChatRequest.safeParse(await context.req.json().catch(() => null));
    if (!parsed.success)
      return context.json(
        apiError('bad_request', DEFAULT_ERROR_MESSAGE.bad_request, requestId),
        400,
      );
    const request = parsed.data;

    if (!config.ai.configured)
      return context.json(
        apiError('capability_absent', DEFAULT_ERROR_MESSAGE.capability_absent, requestId),
        503,
      );

    const systemPrompt = buildChatPrompt(
      request.persona,
      request.context ? JSON.stringify(request.context) : 'no model loaded',
    );
    // The same message list both paths send: the persona's system prompt, recent memory, the ask.
    const messages: CompletionRequest['messages'] = [
      { role: 'system', content: systemPrompt },
      ...request.history.slice(-12),
      { role: 'user', content: request.message },
    ];

    if (!request.stream) {
      // A caller that did not ask for a stream gets the one JSON object it always got — content
      // negotiation, not a second endpoint (`04`). This path is byte-identical to before streaming.
      const completion = await state.ai.complete({
        messages,
        maxOutputTokens: 2000,
        temperature: 0.6,
        timeoutMs: 60_000,
      });
      if (!completion.ok) {
        return context.json(
          apiError(
            completion.code === 'quota' ? 'upstream_quota' : 'upstream_failed',
            completion.message,
            requestId,
          ),
          (completion.code === 'quota' ? 429 : 502) as 429 | 502,
        );
      }
      return context.json({ text: completion.text, requestId });
    }

    // NDJSON: text deltas flushed the moment the provider writes them, then exactly ONE terminal
    // event (`done` | `error`) — the generation stream's event discipline (`05`, `04`). No
    // re-chunking: the deltas ARE the provider's own stream, so the bubble writes honestly instead
    // of the server replaying a blocking call on a timer.
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const encoder = new TextEncoder();
        // A closed controller means the learner navigated away — never write to a dead socket (`04`).
        let clientGone = false;
        const write = (event: ChatEvent) => {
          if (clientGone) return;
          try {
            controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
          } catch {
            clientGone = true;
          }
        };
        try {
          const completion = await state.ai.completeStream(
            {
              messages,
              maxOutputTokens: 2000,
              temperature: 0.6,
              timeoutMs: 60_000,
              // Cancel-on-navigate: a closed tab stops the provider call (`05`).
              signal: context.req.raw.signal,
            },
            (delta) => write({ type: 'delta', text: delta }),
          );
          if (completion.ok) {
            // The terminal success carries the authoritative full text; deltas were the view.
            write({ type: 'done', text: completion.text });
          } else {
            // The error taxonomy is unchanged: provider quota is `upstream_quota`, everything else
            // provider-shaped is `upstream_failed` — now on the terminal event rather than a JSON body.
            write({
              type: 'error',
              code: completion.code === 'quota' ? 'upstream_quota' : 'upstream_failed',
              message: completion.message,
              requestId,
            });
          }
        } catch {
          // The single terminal event the client depends on, even on an unforeseen throw.
          write({
            type: 'error',
            code: 'internal',
            message: DEFAULT_ERROR_MESSAGE.internal,
            requestId,
          });
        } finally {
          try {
            controller.close();
          } catch {
            /* the reader is already gone */
          }
        }
      },
    });
    return new Response(stream, {
      headers: {
        'content-type': 'application/x-ndjson; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        // Any proxy in the chain must not buffer a delta nobody sees until the end (`04`).
        'x-accel-buffering': 'no',
        // Bare Response bypasses the context headers — same as the generate stream (B6).
        'x-request-id': requestId,
      },
    });
  });

  // ── Quiz generation: the fallback path only (`05`) ────────────────────────
  app.post('/api/quiz', async (context) => {
    const requestId = context.get('requestId');
    const guard = limitWith(state.limiters.quiz, config.trustProxy, state.remoteAddress);
    const limited = await guard(context, async () => undefined);
    if (limited) return limited;
    const parsed = QuizRequest.safeParse(await context.req.json().catch(() => null));
    if (!parsed.success)
      return context.json(
        apiError('bad_request', DEFAULT_ERROR_MESSAGE.bad_request, requestId),
        400,
      );

    if (!config.ai.configured)
      return context.json(
        apiError('capability_absent', DEFAULT_ERROR_MESSAGE.capability_absent, requestId),
        503,
      );

    const summary = JSON.stringify(parsed.data.context);
    const completion = await state.ai.complete({
      messages: [
        {
          role: 'system',
          content: buildQuizPrompt(summary, parsed.data.count, parsed.data.difficulty),
        },
        { role: 'user', content: `Generate the questions now.` },
      ],
      maxOutputTokens: 4000,
      temperature: 0.5,
      timeoutMs: 60_000,
    });
    if (!completion.ok) {
      return context.json(apiError('upstream_failed', completion.message, requestId), 502);
    }

    const validated = validateQuizQuestions(completion.text);
    return context.json({ questions: validated.questions, dropped: validated.dropped, requestId });
  });

  // ── Gallery ───────────────────────────────────────────────────────────────
  app.get('/api/gallery', async (context) => {
    const query = GalleryListQuery.safeParse({
      subject: context.req.query('subject') || undefined,
      search: context.req.query('search') || undefined,
      limit: context.req.query('limit') || undefined,
      offset: context.req.query('offset') || undefined,
    });
    if (!query.success)
      return context.json(
        apiError('bad_request', DEFAULT_ERROR_MESSAGE.bad_request, context.get('requestId')),
        400,
      );
    const list = await state.store.list(query.data);
    return context.json({ ...list, limit: query.data.limit, offset: query.data.offset });
  });

  app.get('/api/gallery/:id', async (context) => {
    const id = context.req.param('id');
    // Anything not shaped like a UUID is rejected at the route, before the query layer (`06`).
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
      return context.json(
        apiError('bad_request', 'That model id is malformed.', context.get('requestId')),
        400,
      );
    }
    const record = await state.store.get(id);
    if (!record)
      return context.json(
        apiError('not_found', DEFAULT_ERROR_MESSAGE.not_found, context.get('requestId')),
        404,
      );
    return context.json(record);
  });

  app.post('/api/gallery', async (context) => {
    const requestId = context.get('requestId');
    const guard = limitWith(state.limiters.write, config.trustProxy, state.remoteAddress);
    const limited = await guard(context, async () => undefined);
    if (limited) return limited;
    if (!requireWriteToken(state, context.req.header('authorization'))) {
      return context.json(
        apiError('unauthorized', DEFAULT_ERROR_MESSAGE.unauthorized, requestId),
        401,
      );
    }

    const body = await context.req.json().catch(() => null);
    const parsed = PublishRequest.safeParse(body);
    if (!parsed.success)
      return context.json(
        apiError('bad_request', DEFAULT_ERROR_MESSAGE.bad_request, requestId),
        400,
      );

    let snapshotUrl: string | null = null;
    if (parsed.data.snapshot) {
      // Data-URL or base64; sniffed by magic bytes, never the client's claim (`06`).
      const base64 = parsed.data.snapshot.replace(/^data:[^,]+,/, '');
      const bytes = Buffer.from(base64, 'base64');
      if (bytes.byteLength > SNAPSHOT_MAX_BYTES) {
        return context.json(apiError('too_large', DEFAULT_ERROR_MESSAGE.too_large, requestId), 413);
      }
      const mime = sniffSnapshot(new Uint8Array(bytes));
      if (!mime) {
        return context.json(
          apiError(
            'bad_request',
            'That snapshot is not a recognised PNG, JPEG, WebP or AVIF image.',
            requestId,
          ),
          400,
        );
      }
      snapshotUrl = await state.store.putSnapshot(new Uint8Array(bytes), mime);
    }

    // The snapshot's pointer is a property OF THE RECORD, not of the blob: `GalleryEntry` (the
    // wire shape the gallery list renders) carries `snapshotUrl`, so the store persists it in its
    // own column and both `list` and `get` return it (B3). The bundle stays exactly the payload
    // the client sent — the model program and manifest the viewer loads.
    //
    // `galleryId` targets an existing entry — the one auto-save minted for this generation, or the
    // one the model was loaded from — so this publish UPDATES that row in place rather than adding a
    // duplicate. `put` already replaces by id, and `id: undefined` mints a fresh one exactly as
    // before, so an older client that sends no id is unaffected. Deliberately NOT gated by the write
    // token any differently: the token check ran above, unchanged — this only chooses the row.
    const record = await state.store.put({
      name: parsed.data.bundle.manifest?.name ?? 'Untitled model',
      subject: parsed.data.bundle.manifest?.domain ?? 'other',
      tags: [],
      bundle: parsed.data.bundle,
      snapshotUrl,
      ...(parsed.data.galleryId ? { id: parsed.data.galleryId } : {}),
    });
    return context.json({ id: record.id, shareUrl: `/viewer?model=${record.id}`, requestId }, 201);
  });

  app.delete('/api/gallery/:id', async (context) => {
    const requestId = context.get('requestId');
    const guard = limitWith(state.limiters.write, config.trustProxy, state.remoteAddress);
    const limited = await guard(context, async () => undefined);
    if (limited) return limited;
    if (!requireWriteToken(state, context.req.header('authorization'))) {
      return context.json(
        apiError('unauthorized', DEFAULT_ERROR_MESSAGE.unauthorized, requestId),
        401,
      );
    }
    const id = context.req.param('id');
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
      return context.json(apiError('bad_request', 'That model id is malformed.', requestId), 400);
    }
    const removed = await state.store.delete(id);
    if (!removed)
      return context.json(apiError('not_found', DEFAULT_ERROR_MESSAGE.not_found, requestId), 404);
    return context.json({ ok: true, requestId });
  });

  // Snapshots: served with immutable caching from their own path (`06`, `04`). They are registered
  // inside /api and DO pay the API limiter — the old comment here claimed they sat "off the API
  // budget", which was never true; the immutable cache header keeps the cost bounded because a
  // browser that has the image rarely asks again.
  app.get('/api/snapshots/:id', async (context) => {
    const requestId = context.get('requestId');
    const id = context.req.param('id');
    // Allow the file extension the fallback store appends, but reject path traversal outright.
    const safe = id.replace(/[^a-zA-Z0-9.-]/g, '');
    // Per-backend id shapes: the file store wrote `${uuid}.${ext}` to disk and keys lookups by
    // that whole name, so it gets the extension back; Postgres keys snapshot rows by the bare
    // uuid it minted. Without this translation the file-backed deployment — the zero-config
    // gallery — 404'd on every snapshot its own publish minted, because the route stripped the
    // extension single-mindedly.
    const snapshotId =
      state.store.announcement.backend === 'postgres' ? (safe.split('.')[0] ?? safe) : safe;
    const snapshot = await state.store.getSnapshot(snapshotId);
    if (!snapshot)
      return context.json(
        apiError('not_found', DEFAULT_ERROR_MESSAGE.not_found, context.get('requestId')),
        404,
      );
    return new Response(new Uint8Array(snapshot.bytes), {
      headers: {
        'content-type': snapshot.mime,
        'cache-control': 'public, max-age=31536000, immutable',
        'x-content-type-options': 'nosniff',
        // Bare Response: the correlation header must be explicit or it does not exist (B6).
        'x-request-id': requestId,
      },
    });
  });

  // ── Static frontend (mounted last: the API owns /api, everything else is pages) ──
  app.use('*', staticSiteMiddleware);

  // ── 404 with the same shape, so clients have one parser ───────────────────
  // API paths keep the JSON error; anything else already had its chance at a page above.
  app.notFound((context) => {
    const pathname = new URL(context.req.url).pathname;
    if (pathname.startsWith('/api/')) {
      return context.json(
        apiError('not_found', 'No such endpoint.', context.get('requestId')),
        404,
      );
    }
    return context.text('Not found.', 404);
  });

  // ── The catch-all: an unexpected fault carries a request id and nothing else ──
  app.onError((error, context) => {
    const requestId = context.get('requestId') ?? 'unknown';
    // Logged with intent, never swallowed (`09`): one line with the id the client saw.
    console.error(`[request ${requestId}] unhandled: ${(error as Error).message}`);
    return context.json(apiError('internal', DEFAULT_ERROR_MESSAGE.internal, requestId), 500);
  });

  return app;
}

/** Track open generation streams for the health endpoint (`04` observability). */
async function tracked<T>(state: AppState, run: () => Promise<T>): Promise<T> {
  state.openStreams += 1;
  try {
    return await run();
  } finally {
    state.openStreams -= 1;
  }
}
