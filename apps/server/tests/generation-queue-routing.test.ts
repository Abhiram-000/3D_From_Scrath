/**
 * Generation admission: concurrent learners against a ONE-concurrent provider.
 *
 * AFTER (this file's HTTP proof): three concurrent `/api/generate` streams, a stub provider that
 * REFUSES a second concurrent request (the real body:
 * `{"code":"concurrency_limit_exceeded","message":"Too many concurrent requests (limit: 1)"}`),
 * and the real generation queue in front of the pipeline — all three succeed in sequence, the
 * queued ones carry the waiting `notice`, `/api/health` shows the depth while they wait, and the
 * stub records ZERO concurrency refusals.
 *
 * BEFORE (the state this change replaced): the same three requests without a queue fail — the
 * second and third hit the provider's concurrency limit mid-flight and end in terminal errors.
 * Modeled with a fast fake AI rather than the HTTP stub deliberately: the real client's 429
 * posture is a provider-dictated 60-second backoff per attempt — precisely the mechanism that
 * stretched the measured run past 79 minutes — and a test must not reproduce a 15-minute wait to
 * point at it. The fake enforces the same invariant (never two `complete` calls at once) and
 * fails fast exactly the way a contended key does.
 */
import { describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { REFERENCE_MODEL_SOURCE } from '@edu3d/engine';
import type { GenerationEvent } from '@edu3d/contracts';
import { buildApp, type AppState } from '../src/app.ts';
import { resolveConfig } from '../src/config/config.ts';
import { AiClient, type AiClient as AiClientType } from '../src/services/ai-client.ts';
import { createGenerationQueue } from '../src/services/generation-queue.ts';
import { createLifecycle } from '../src/services/lifecycle.ts';
import { buildLimiters } from '../src/services/rate-limits.ts';
import type { GalleryStore, StoreAnnouncement } from '../src/services/gallery-store.ts';

// ── Stub provider: refuses concurrent requests like the real free-tier plan ────────────────

async function startOneConcurrentProvider(): Promise<{
  url: string;
  close: () => Promise<void>;
  refusals: () => number;
}> {
  let inflight = 0;
  let refused = 0;
  const server: Server = createServer((req, res) => {
    req.resume(); // drain the body; the stub only counts concurrency, it never reads it
    req.on('end', () => {
      if (inflight >= 1) {
        refused += 1;
        res.writeHead(429, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            code: 'concurrency_limit_exceeded',
            message: 'Too many concurrent requests (limit: 1)',
          }),
        );
        return;
      }
      inflight += 1;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      // The reference program in a few chunks, a genuine finish, then release the slot.
      for (let i = 0; i < REFERENCE_MODEL_SOURCE.length; i += 1000) {
        res.write(
          `data: ${JSON.stringify({
            choices: [{ delta: { content: REFERENCE_MODEL_SOURCE.slice(i, i + 1000) } }],
          })}\n\n`,
        );
      }
      res.write(
        `data: ${JSON.stringify({
          choices: [{ delta: {}, finish_reason: 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 1000 },
        })}\n\n`,
      );
      res.write('data: [DONE]\n\n');
      res.end(() => {
        inflight -= 1;
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    refusals: () => refused,
  };
}

/** The contended fake: same invariant as the real provider, failures land in seconds not minutes. */
function contendedFakeAi(): AiClientType {
  let current = 0;
  return {
    complete: async () => {
      if (current >= 1) {
        // What the real provider answers a contender with, minus the 60 s backoff.
        return {
          ok: false as const,
          code: 'quota' as const,
          message: 'Too many concurrent requests (limit: 1)',
          retryable: true as const,
          retryAfterSeconds: 1,
        };
      }
      current += 1;
      try {
        await new Promise((r) => setTimeout(r, 150));
        return {
          ok: true as const,
          text: '```javascript\n' + REFERENCE_MODEL_SOURCE.trim() + '\n```',
          finishReason: 'stop' as const,
          usage: { promptTokens: 10, completionTokens: 1000 },
        };
      } finally {
        current -= 1;
      }
    },
  } as unknown as AiClientType;
}

// ── App wiring ──────────────────────────────────────────────────────────────────────────────

const announcement: StoreAnnouncement = { backend: 'memory' as never, notice: null, warnings: [] };
const memoryStore = (): GalleryStore =>
  ({
    announcement,
    list: async () => ({ entries: [], total: 0 }),
    get: async () => null,
    put: async () => {
      throw new Error('not used');
    },
    delete: async () => false,
    putSnapshot: async () => {
      throw new Error('not used');
    },
    getSnapshot: async () => null,
    flush: async () => {},
    close: async () => {},
    init: async () => {},
  }) as unknown as GalleryStore;

function stateFor(ai: AiClientType, withQueue: boolean): AppState {
  const config = resolveConfig({
    AI_API_KEY: 'stub-key',
    AI_BASE_URL: 'http://stub.invalid/v1',
    AI_MODEL: 'stub-model',
    EDU3D_API_RATE_LIMIT: '6000',
    EDU3D_GENERATE_RATE_LIMIT: '6000',
  });
  const lifecycle = createLifecycle();
  return {
    config,
    ai,
    store: memoryStore(),
    limiters: buildLimiters(config),
    ...(withQueue
      ? {
          genQueue: createGenerationQueue({
            limit: 1,
            maxWaitMs: 60_000,
            drainSignal: lifecycle.drainSignal,
          }),
        }
      : {}),
    draining: false,
    openStreams: 0,
    startedAt: Date.now(),
    remoteAddress: '127.0.0.1',
  };
}

/** POST one streaming generate and collect the parsed NDJSON events. */
async function generate(
  app: ReturnType<typeof buildApp>,
  topic: string,
): Promise<GenerationEvent[]> {
  const response = await app.request('/api/generate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ topic, complexity: 'simple', stream: true }),
  });
  const text = await response.text();
  return text
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as GenerationEvent);
}

const waitingNotices = (events: GenerationEvent[]): number =>
  events.filter(
    (event) => event.type === 'notice' && /Waiting for a free generation slot/.test(event.message),
  ).length;

describe('three concurrent generates against a one-concurrent provider', () => {
  it(
    'BEFORE — no queue: the contended requests fail instead of waiting',
    { timeout: 60_000 },
    async () => {
      const { app } = ((): { app: ReturnType<typeof buildApp> } => {
        const state = stateFor(contendedFakeAi(), false);
        return { app: buildApp(state) };
      })();
      const [a, b, c] = await Promise.all([
        generate(app, 'topic one'),
        generate(app, 'topic two'),
        generate(app, 'topic three'),
      ]);
      const terminals = [a, b, c].map((events) => events.at(-1));
      const succeeded = terminals.filter((event) => event?.type === 'ready');
      const quotaFails = terminals.filter(
        (event) => event?.type === 'error' && event.code === 'upstream_quota',
      );
      expect(succeeded).toHaveLength(1); // one got through; the provider allows one
      expect(quotaFails.length).toBeGreaterThanOrEqual(1); // the rest were refused, not queued
    },
  );

  it(
    'AFTER — the real queue: all three succeed in sequence, queued ones carry the waiting notice, zero provider refusals',
    { timeout: 120_000 },
    async () => {
      const stub = await startOneConcurrentProvider();
      try {
        const config = resolveConfig({
          AI_API_KEY: 'stub-key',
          AI_BASE_URL: stub.url,
          AI_MODEL: 'stub-model',
          EDU3D_API_RATE_LIMIT: '6000',
          EDU3D_GENERATE_RATE_LIMIT: '6000',
        });
        const lifecycle = createLifecycle();
        const state: AppState = {
          config,
          ai: new AiClient(config),
          store: memoryStore(),
          limiters: buildLimiters(config),
          genQueue: createGenerationQueue({
            limit: 1,
            maxWaitMs: 60_000,
            drainSignal: lifecycle.drainSignal,
          }),
          draining: false,
          openStreams: 0,
          startedAt: Date.now(),
          remoteAddress: '127.0.0.1',
        };
        const app = buildApp(state);

        // Poll health WHILE the queue is busy: the depth must be observable, not mysterious.
        let deepestWait = 0;
        let done = false;
        const healthPoll = (async () => {
          while (!done) {
            const response = await app.request('/api/health');
            const body = (await response.json()) as {
              generationQueue?: { waiting: number; running: number; limit: number };
            };
            if (body.generationQueue) {
              deepestWait = Math.max(deepestWait, body.generationQueue.waiting);
              expect(body.generationQueue.limit).toBe(1);
            }
            await new Promise((r) => setTimeout(r, 20));
          }
        })();

        const [a, b, c] = await Promise.all([
          generate(app, 'topic one'),
          generate(app, 'topic two'),
          generate(app, 'topic three'),
        ]);
        done = true;
        await healthPoll;

        // All three reached ready, and none was refused by the provider.
        const terminals = [a, b, c].map((events) => events.at(-1));
        expect(terminals.every((event) => event?.type === 'ready')).toBe(true);
        expect(stub.refusals()).toBe(0);

        // The queued ones saw the waiting notice; whoever went first (never queued) did not.
        const counts = [waitingNotices(a), waitingNotices(b), waitingNotices(c)].sort(
          (x, y) => y - x,
        );
        expect(counts[0]).toBe(1); // a queued learner was told it is waiting
        expect(counts[1]).toBe(1); // and so was the second queued one
        expect(counts[2]).toBe(0); // the first request never queued
        expect(deepestWait).toBeGreaterThanOrEqual(1); // health showed the depth while waiting
      } finally {
        await stub.close();
      }
    },
  );
});
