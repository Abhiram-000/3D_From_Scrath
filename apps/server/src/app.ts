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
import {
  DEFAULT_ERROR_MESSAGE,
  ERROR_STATUS,
  ChatRequest,
  GalleryListQuery,
  GenerateRequest,
  PublishRequest,
  QuizRequest,
  type ApiError,
  type ErrorCode,
} from '@edu3d/contracts';
import type { ServerConfig } from './config/config.ts';
import { type AiClient } from './services/ai-client.ts';
import { runPipeline } from './services/pipeline.ts';
import { buildChatPrompt, buildQuizPrompt } from './services/prompts.ts';
import type { GalleryStore } from './services/gallery-store.ts';
import { sniffSnapshot, SNAPSHOT_MAX_BYTES } from './services/gallery-store.ts';
import { limitWith, type LimiterSet } from './services/rate-limits.ts';
import { timingSafeEqual, createHash } from 'node:crypto';
import { validateQuizQuestions } from './services/quiz.ts';

export interface AppState {
  config: ServerConfig;
  ai: AiClient;
  store: GalleryStore;
  limiters: LimiterSet;
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
 * The one error shape every endpoint returns (`04`, `06`): a code the client branches on, a message
 * written for a learner, a request id — never a stack, never provider internals.
 */
export function apiError(code: ErrorCode, message: string, requestId: string, retryAfterSeconds?: number) {
  return { error: { code, message, requestId, ...(retryAfterSeconds ? { retryAfterSeconds } : {}) } satisfies ApiError['error'] };
}

/** Guard a write endpoint with the bearer token, compared in constant time (`06`). */
function requireWriteToken(state: AppState, authorization: string | undefined): boolean {
  if (!state.config.security.writeToken) return true; // Opt-in by default for local use.
  const provided = authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!provided) return false;
  // Hash both sides then timingSafeEqual: naive === leaks length and prefix (`06`).
  const a = createHash('sha256').update(provided).digest();
  const b = createHash('sha256').update(state.config.security.writeToken).digest();
  return timingSafeEqual(a, b);
}

export function buildApp(state: AppState): Hono<AppContext> {
  const app = new Hono<AppContext>();
  const { config } = state;

  // ── Request id + structured logging context ───────────────────────────────
  app.use('*', async (context, next) => {
    const requestId = newRequestId();
    context.set('requestId', requestId);
    context.header('x-request-id', requestId);
    await next();
  });

  // ── Security headers (`06`) ───────────────────────────────────────────────
  app.use('*', async (context, next) => {
    await next();
    context.header('x-content-type-options', 'nosniff');
    context.header('referrer-policy', 'strict-origin-when-cross-origin');
    context.header('x-frame-options', 'SAMEORIGIN');
    if (config.security.hsts) context.header('strict-transport-security', 'max-age=31536000; includeSubDomains');
  });

  // ── CORS: allow-list, never * in production (`06`) ────────────────────────
  app.use(
    '*',
    cors({
      origin: (origin) => (config.allowedOrigins.includes(origin) ? origin : undefined),
      allowHeaders: ['content-type', 'authorization'],
      allowMethods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
    }),
  );

  // ── General API limiter on everything; health exempt by not going through it ──
  app.use('/api/*', async (context, next) => {
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
    });
  });

  app.get('/api/ready', (context) =>
    state.draining ? context.json({ status: 'draining' }, 503) : context.json({ status: 'ready' }),
  );

  // ── Generation: the streamed pipeline (`04`) ──────────────────────────────
  app.post('/api/generate', async (context) => {
    const requestId = context.get('requestId');

    const guard = limitWith(state.limiters.generate, config.trustProxy, state.remoteAddress);
    const limited = await guard(context, async () => undefined);
    if (limited) return limited;

    if (state.draining) {
      return context.json(apiError('draining', DEFAULT_ERROR_MESSAGE.draining, requestId), 503);
    }

    // Validation before the capability gate: "malformed input dies at the door with a 400, never
    // reaches the pipeline" (`04`) — and a client with a broken request should hear about the request,
    // not the server's key situation.
    const parsed = GenerateRequest.safeParse(await context.req.json().catch(() => null));
    if (!parsed.success) {
      return context.json(apiError('bad_request', DEFAULT_ERROR_MESSAGE.bad_request, requestId), 400);
    }
    const request = parsed.data;

    if (!config.ai.configured) {
      return context.json(apiError('capability_absent', DEFAULT_ERROR_MESSAGE.capability_absent, requestId), 503);
    }

    if (!request.stream) {
      // Non-streaming clients get the same payload as one JSON object — content negotiation, not a
      // separate endpoint (`04`). Internally it is the same pipeline with a discarding sink.
      const events: unknown[] = [];
      const result = await tracked(state, () =>
        runPipeline(request.topic, request.complexity, {
          ai: state.ai,
          sink: (event) => events.push(event),
          tier: request.tier ?? 'mid',
          maxOutputTokens: config.ai.maxOutputTokens,
        }),
      );
      if (!result.ok) {
        const { failure } = result;
        return context.json(
          apiError(failure.code, failure.message, requestId, failure.retryAfterSeconds),
          ERROR_STATUS[failure.code] as 400 | 401 | 404 | 413 | 429 | 500 | 502 | 503,
        );
      }
      return context.json({
        bundle: result.bundle,
        audit: result.audit,
        requestId,
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
          write({ type: 'phase', phase: 'queued', message: 'Sending your topic to the model…', at: Date.now() });
          const result = await tracked(state, () =>
            runPipeline(request.topic, request.complexity, {
              ai: state.ai,
              sink: write,
              tier: request.tier ?? 'mid',
              maxOutputTokens: config.ai.maxOutputTokens,
            }),
          );
          if (result.ok) {
            write({ type: 'ready', bundle: result.bundle, audit: result.audit, at: Date.now() });
          } else {
            write({ type: 'error', code: result.failure.code, message: result.failure.message, requestId, ...(result.failure.retryAfterSeconds ? { retryAfterSeconds: result.failure.retryAfterSeconds } : {}), at: Date.now() });
          }
        } catch {
          // The catch-all the client depends on: a stream must end with exactly one terminal event.
          write({ type: 'error', code: 'internal', message: DEFAULT_ERROR_MESSAGE.internal, requestId, at: Date.now() });
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
      },
    });
  });

  // ── Chat: the tutor, streaming (`05`) ─────────────────────────────────────
  app.post('/api/chat', async (context) => {
    const requestId = context.get('requestId');
    const guard = limitWith(state.limiters.chat, config.trustProxy, state.remoteAddress);
    const limited = await guard(context, async () => undefined);
    if (limited) return limited;
    if (state.draining) return context.json(apiError('draining', DEFAULT_ERROR_MESSAGE.draining, requestId), 503);

    const parsed = ChatRequest.safeParse(await context.req.json().catch(() => null));
    if (!parsed.success) return context.json(apiError('bad_request', DEFAULT_ERROR_MESSAGE.bad_request, requestId), 400);
    const request = parsed.data;

    if (!config.ai.configured) return context.json(apiError('capability_absent', DEFAULT_ERROR_MESSAGE.capability_absent, requestId), 503);

    const systemPrompt = buildChatPrompt(request.persona, request.context ? JSON.stringify(request.context) : 'no model loaded');
    const completion = await state.ai.complete({
      messages: [
        { role: 'system', content: systemPrompt },
        ...request.history.slice(-12),
        { role: 'user', content: request.message },
      ],
      maxOutputTokens: 2000,
      temperature: 0.6,
      timeoutMs: 60_000,
    });

    if (!completion.ok) {
      return context.json(
        apiError(completion.code === 'quota' ? 'upstream_quota' : 'upstream_failed', completion.message, requestId),
        (completion.code === 'quota' ? 429 : 502) as 429 | 502,
      );
    }

    if (!request.stream) {
      return context.json({ text: completion.text, requestId });
    }

    const encoder = new TextEncoder();
    // Chunked into deltas so the bubble visibly writes; the transport is the same NDJSON as generation.
    const chunks = completion.text.match(/[\s\S]{1,60}/g) ?? [];
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(encoder.encode(`${JSON.stringify({ type: 'delta', text: chunk })}\n`));
          await new Promise((resolve) => setTimeout(resolve, 15));
        }
        controller.enqueue(encoder.encode(`${JSON.stringify({ type: 'done', text: completion.text })}\n`));
        controller.close();
      },
    });
    return new Response(stream, {
      headers: { 'content-type': 'application/x-ndjson; charset=utf-8', 'x-accel-buffering': 'no' },
    });
  });

  // ── Quiz generation: the fallback path only (`05`) ────────────────────────
  app.post('/api/quiz', async (context) => {
    const requestId = context.get('requestId');
    const guard = limitWith(state.limiters.quiz, config.trustProxy, state.remoteAddress);
    const limited = await guard(context, async () => undefined);
    if (limited) return limited;
    const parsed = QuizRequest.safeParse(await context.req.json().catch(() => null));
    if (!parsed.success) return context.json(apiError('bad_request', DEFAULT_ERROR_MESSAGE.bad_request, requestId), 400);

    if (!config.ai.configured) return context.json(apiError('capability_absent', DEFAULT_ERROR_MESSAGE.capability_absent, requestId), 503);

    const summary = JSON.stringify(parsed.data.context);
    const completion = await state.ai.complete({
      messages: [
        { role: 'system', content: buildQuizPrompt(summary, parsed.data.count, parsed.data.difficulty) },
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
    if (!query.success) return context.json(apiError('bad_request', DEFAULT_ERROR_MESSAGE.bad_request, context.get('requestId')), 400);
    const list = await state.store.list(query.data);
    return context.json({ ...list, limit: query.data.limit, offset: query.data.offset });
  });

  app.get('/api/gallery/:id', async (context) => {
    const id = context.req.param('id');
    // Anything not shaped like a UUID is rejected at the route, before the query layer (`06`).
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
      return context.json(apiError('bad_request', 'That model id is malformed.', context.get('requestId')), 400);
    }
    const record = await state.store.get(id);
    if (!record) return context.json(apiError('not_found', DEFAULT_ERROR_MESSAGE.not_found, context.get('requestId')), 404);
    return context.json(record);
  });

  app.post('/api/gallery', async (context) => {
    const requestId = context.get('requestId');
    const guard = limitWith(state.limiters.write, config.trustProxy, state.remoteAddress);
    const limited = await guard(context, async () => undefined);
    if (limited) return limited;
    if (!requireWriteToken(state, context.req.header('authorization'))) {
      return context.json(apiError('unauthorized', DEFAULT_ERROR_MESSAGE.unauthorized, requestId), 401);
    }

    const body = await context.req.json().catch(() => null);
    const parsed = PublishRequest.safeParse(body);
    if (!parsed.success) return context.json(apiError('bad_request', DEFAULT_ERROR_MESSAGE.bad_request, requestId), 400);

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
        return context.json(apiError('bad_request', 'That snapshot is not a recognised PNG, JPEG, WebP or AVIF image.', requestId), 400);
      }
      snapshotUrl = await state.store.putSnapshot(new Uint8Array(bytes), mime);
    }

    const record = await state.store.put({
      name: parsed.data.bundle.manifest?.name ?? 'Untitled model',
      subject: parsed.data.bundle.manifest?.domain ?? 'other',
      tags: [],
      bundle: { ...parsed.data.bundle, snapshotUrl },
    });
    return context.json({ id: record.id, shareUrl: `/viewer?model=${record.id}`, requestId }, 201);
  });

  app.delete('/api/gallery/:id', async (context) => {
    const requestId = context.get('requestId');
    const guard = limitWith(state.limiters.write, config.trustProxy, state.remoteAddress);
    const limited = await guard(context, async () => undefined);
    if (limited) return limited;
    if (!requireWriteToken(state, context.req.header('authorization'))) {
      return context.json(apiError('unauthorized', DEFAULT_ERROR_MESSAGE.unauthorized, requestId), 401);
    }
    const id = context.req.param('id');
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
      return context.json(apiError('bad_request', 'That model id is malformed.', requestId), 400);
    }
    const removed = await state.store.delete(id);
    if (!removed) return context.json(apiError('not_found', DEFAULT_ERROR_MESSAGE.not_found, requestId), 404);
    return context.json({ ok: true, requestId });
  });

  // Snapshots: served with immutable caching from their own path, off the API budget (`06`, `04`).
  app.get('/api/snapshots/:id', async (context) => {
    const id = context.req.param('id');
    // Allow the file extension the fallback store appends, but reject path traversal outright.
    const safe = id.replace(/[^a-zA-Z0-9.-]/g, '');
    const snapshot = await state.store.getSnapshot(safe.split('.')[0] ?? safe);
    if (!snapshot) return context.json(apiError('not_found', DEFAULT_ERROR_MESSAGE.not_found, context.get('requestId')), 404);
    return new Response(new Uint8Array(snapshot.bytes), {
      headers: { 'content-type': snapshot.mime, 'cache-control': 'public, max-age=31536000, immutable', 'x-content-type-options': 'nosniff' },
    });
  });

  // ── 404 with the same shape, so clients have one parser ───────────────────
  app.notFound((context) =>
    context.json(apiError('not_found', 'No such endpoint.', context.get('requestId')), 404),
  );

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
