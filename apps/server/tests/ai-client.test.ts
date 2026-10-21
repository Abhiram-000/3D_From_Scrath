/**
 * The AI client's completion paths that decide whether a half-written program reaches the gate.
 *
 * `00:145` is the rule under test: "a half-generated model must be detected, refused and retried,
 * never delivered." A model that is 90% written and then cut off is not a model — it is a syntax
 * error that happens to parse, or a scene with a silently missing half.
 *
 * The streams below are built as real multi-chunk `ReadableStream`s. A `Response` constructed from an
 * array of strings does NOT deliver one chunk per element under Node's undici — only the first is
 * surfaced — which silently truncates any assertion about later frames.
 */
import { describe, expect, it, vi, afterEach } from 'vitest';
import { AiClient } from '../src/services/ai-client.ts';
import { resolveConfig } from '../src/config/config.ts';

const config = resolveConfig({ AI_API_KEY: 'test-key', AI_MODEL: 'test-model' });

/** A response body that emits each frame as its own chunk, then closes. */
function sse(frames: string[]): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const frame of frames) controller.enqueue(encoder.encode(frame));
        controller.close();
      },
    }),
    { headers: { 'content-type': 'text/event-stream' } },
  );
}

/** The same, but the socket dies instead of closing: an aborted mid-stream response. */
function interruptedSse(frames: string[]): Response {
  const encoder = new TextEncoder();
  let index = 0;
  return new Response(
    new ReadableStream({
      pull(controller) {
        if (index >= frames.length) {
          controller.error(new DOMException('stream aborted', 'AbortError'));
          return;
        }
        controller.enqueue(encoder.encode(frames[index]));
        index += 1;
      },
    }),
    { headers: { 'content-type': 'text/event-stream' } },
  );
}

/**
 * The `sse` shape, but the socket is NEVER closed: the terminal chunk arrives and the provider then
 * holds the connection open. This is the real provider's behaviour that made a finished answer hang
 * until the attempt timeout — the read loop must end on the terminal event, not on the close.
 */
function heldSse(frames: string[]): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const frame of frames) controller.enqueue(encoder.encode(frame));
        // Deliberately no controller.close(): the body stays open after the finish frame.
      },
    }),
    { headers: { 'content-type': 'text/event-stream' } },
  );
}

/** A content frame. */
const delta = (text: string) =>
  `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n`;

/** The terminal frame every OpenAI-compatible provider sends: empty delta, finish reason. */
const finish = (reason: string) =>
  `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: reason }] })}\n`;

const DONE = 'data: [DONE]\n';

/** Answer with one response body, without the retry cascade re-reading a consumed stream. */
function respondWith(body: () => Response): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => body()),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  // Some tests below drive fake timers (a provider-dictated backoff); without restoring the real
  // clock here, every later test's own timers freeze and hang their 20s budget.
  vi.useRealTimers();
});

describe('a stream that dies mid-program', () => {
  it('refuses partial text rather than reporting success', { timeout: 20_000 }, async () => {
    // The provider never sent a terminal frame — the socket simply died. Before the fix this
    // returned { ok: true } and the partial program walked into the gate as a finished model.
    respondWith(() =>
      interruptedSse([delta('const shaft = 1;\nfunction cut('), delta('  return shaft;')]),
    );

    const result = await new AiClient(config).complete({
      maxOutputTokens: 4096,
      messages: [{ role: 'user', content: 'a cutaway' }],
      onProgress: () => {},
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable — the assertion above must fail first');
    expect(result.code).toBe('truncated');
    // Deliberately NOT retryable here any more: a client-side retry re-rolls the WHOLE program at
    // full price with the same cut probability — the measured 79-minute failure mode. The partial
    // text rides back to the pipeline, whose continuation protocol asks for only the remainder.
    expect(result.retryable).toBe(false);
  });

  it(
    'reports nothing written at all as a network failure, not truncation',
    { timeout: 20_000 },
    async () => {
      respondWith(() => interruptedSse([]));

      const result = await new AiClient(config).complete({
        maxOutputTokens: 4096,
        messages: [{ role: 'user', content: 'anything' }],
        onProgress: () => {},
      });

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('unreachable');
      expect(result.code).toBe('network');
    },
  );

  it('still accepts a stream that completed on its own terms', async () => {
    respondWith(() => sse([delta('const a = 1;'), delta('const b = 2;'), finish('stop'), DONE]));

    const result = await new AiClient(config).complete({
      maxOutputTokens: 4096,
      messages: [{ role: 'user', content: 'a complete model' }],
      onProgress: () => {},
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    // Both content frames were read — a parser that dropped the second would still look correct.
    expect(result.text).toBe('const a = 1;const b = 2;');
    expect(result.finishReason).toBe('stop');
  });

  it('accepts a MAX_TOKENS stop with content — the provider said it was finished', async () => {
    respondWith(() => sse([delta('const a = 1;'), finish('length'), DONE]));

    const result = await new AiClient(config).complete({
      maxOutputTokens: 4096,
      messages: [{ role: 'user', content: 'a long model' }],
      onProgress: () => {},
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.finishReason).toBe('length');
  });
});
describe('a learner who closed the tab', () => {
  it('spends no provider call when the request is already cancelled', async () => {
    const fetchMock = vi.fn(async () => sse([delta('x'), finish('stop'), DONE]));
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();
    controller.abort();

    const result = await new AiClient(config).complete({
      maxOutputTokens: 4096,
      messages: [{ role: 'user', content: 'anything' }],
      onProgress: () => {},
      signal: controller.signal,
    });

    // The refusal has to happen BEFORE the request leaves: the call is the expensive part, and
    // retrying a cancelled generation is spending money on an audience of zero.
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.code).toBe('cancelled');
    expect(result.retryable).toBe(false);
  });

  it('does not retry a cancellation', { timeout: 20_000 }, async () => {
    const fetchMock = vi.fn(async () => sse([delta('x'), finish('stop'), DONE]));
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();
    controller.abort();

    await new AiClient(config).complete({
      maxOutputTokens: 4096,
      messages: [{ role: 'user', content: 'anything' }],
      onProgress: () => {},
      signal: controller.signal,
    });

    // One attempt, not three: a cancelled run must not spend the retry budget either.
    expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(1);
  });

  it('still completes normally when the signal never fires', async () => {
    respondWith(() => sse([delta('const a = 1;'), finish('stop'), DONE]));

    const result = await new AiClient(config).complete({
      maxOutputTokens: 4096,
      messages: [{ role: 'user', content: 'a complete model' }],
      onProgress: () => {},
      signal: new AbortController().signal,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.text).toBe('const a = 1;');
  });
});

describe('credentials: an auth failure fails fast and keeps its actionable message', () => {
  const authConfig = resolveConfig({
    AI_API_KEY: 'wrong-key',
    AI_MODEL: 'primary-model',
    AI_BASE_URL: 'https://freeinference.org/v1',
    FALLBACK_AI_API_KEY: 'fb-key',
    FALLBACK_AI_BASE_URL: 'https://fallback.example/v1',
    FALLBACK_AI_MODEL: 'fb-model',
  });

  it(
    'spends exactly one provider call on a wrong key — not the cascade, not the fallback',
    { timeout: 20_000 },
    async () => {
      // The old behaviour: 401/403 was coded `status`, the cascade advanced on the CODE, and the
      // cross-provider fallback was entered on ANY failure — a wrong AI_API_KEY burned 7 paid
      // calls before reporting anything.
      const calls: string[] = [];
      vi.stubGlobal(
        'fetch',
        vi.fn(async (_url: unknown, init: { body: string }) => {
          calls.push(JSON.parse(init.body).model);
          return new Response('{"error":"bad key"}', {
            status: 401,
            headers: { 'content-type': 'application/json' },
          });
        }),
      );
      const result = await new AiClient(authConfig).complete({
        maxOutputTokens: 100,
        messages: [{ role: 'user', content: 'x' }],
      });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('unreachable');
      expect(result.code, 'auth is its own named failure, not generic `status`').toBe('auth');
      expect(result.retryable).toBe(false);
      expect(result.message).toMatch(/AI_API_KEY|credentials/i);
      expect(calls, `one call for a wrong key, got ${JSON.stringify(calls)}`).toEqual([
        'primary-model',
      ]);
    },
  );

  it(
    'keeps the auth message when the (not entered) fallback keeps failing',
    { timeout: 20_000 },
    async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async (_url: unknown, init: { body: string }) => {
          const model = JSON.parse(init.body).model;
          return model.startsWith('fb')
            ? new Response('{"error":"upstream gone"}', { status: 500 })
            : new Response('{"error":"bad key"}', { status: 401 });
        }),
      );
      const result = await new AiClient(authConfig).complete({
        maxOutputTokens: 100,
        messages: [{ role: 'user', content: 'x' }],
      });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('unreachable');
      expect(result.message).toMatch(/AI_API_KEY|credentials/i);
    },
  );
});

describe('the cross-provider fallback is for a throttled/down/retired primary only', () => {
  const fbConfig = resolveConfig({
    AI_API_KEY: 'k',
    AI_MODEL: 'primary-model',
    FALLBACK_AI_API_KEY: 'fb',
    FALLBACK_AI_MODEL: 'fb-model',
  });
  const json = (body: object) =>
    new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });

  it('does not re-send a safety refusal to a second provider', { timeout: 20_000 }, async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: unknown, init: { body: string }) => {
        calls.push(JSON.parse(init.body).model);
        return json({ choices: [{ message: { content: '' }, finish_reason: 'content_filter' }] });
      }),
    );
    const result = await new AiClient(fbConfig).complete({
      maxOutputTokens: 100,
      messages: [{ role: 'user', content: 'refused topic' }],
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.code).toBe('refused');
    expect(calls, `a refusal must cost one call, got ${JSON.stringify(calls)}`).toEqual([
      'primary-model',
    ]);
  });

  it(
    'does not re-send a request-shaped (malformed) failure to a second provider',
    { timeout: 20_000 },
    async () => {
      const calls: string[] = [];
      vi.stubGlobal(
        'fetch',
        vi.fn(async (_url: unknown, init: { body: string }) => {
          calls.push(JSON.parse(init.body).model);
          return new Response('{"error":"bad shape"}', {
            status: 400,
            headers: { 'content-type': 'application/json' },
          });
        }),
      );
      const result = await new AiClient(fbConfig).complete({
        maxOutputTokens: 100,
        messages: [{ role: 'user', content: 'x' }],
      });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('unreachable');
      expect(calls).toEqual(['primary-model']);
    },
  );

  it(
    'still crosses providers when the primary is down (the case the fallback exists for)',
    { timeout: 30_000 },
    async () => {
      const calls: string[] = [];
      vi.stubGlobal(
        'fetch',
        vi.fn(async (_url: unknown, init: { body: string }) => {
          const model = JSON.parse(init.body).model;
          calls.push(model);
          if (model.startsWith('fb'))
            return json({
              choices: [{ message: { content: 'const ok = 1;' }, finish_reason: 'stop' }],
              usage: {},
            });
          // 502: the primary is down — a `status` failure, retryable, without a provider-dictated
          // wait (so the test stays fast; the 429 path carries its own 60 s backoff).
          return new Response('{"error":"upstream down"}', {
            status: 502,
            headers: { 'content-type': 'application/json' },
          });
        }),
      );
      const result = await new AiClient(fbConfig).complete({
        maxOutputTokens: 100,
        messages: [{ role: 'user', content: 'x' }],
      });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('unreachable');
      expect(result.text).toBe('const ok = 1;');
      const distinct = new Set(calls);
      expect(distinct.has('primary-model')).toBe(true);
      expect(distinct.has('fb-model')).toBe(true);
    },
  );
});

describe('client failures carry no provider internals', () => {
  it(
    'returns a fixed learner-facing message on a provider 4xx and logs the body server-side, never echoing keys/orgs',
    { timeout: 20_000 },
    async () => {
      const rawBody = JSON.stringify({
        error: {
          message: 'Model `primary-model` not owned by org sk-LIVE-secret123 (org-9f83aa91)',
        },
      });
      vi.stubGlobal(
        'fetch',
        vi.fn(
          async () =>
            new Response(rawBody, { status: 400, headers: { 'content-type': 'application/json' } }),
        ),
      );
      const result = await new AiClient(config).complete({
        maxOutputTokens: 100,
        messages: [{ role: 'user', content: 'x' }],
      });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('unreachable');
      expect(result.message).not.toContain('sk-');
      expect(result.message).not.toContain('org-');
      expect(result.message).not.toContain('primary-model` not owned');
    },
  );
});

describe('backoff is abortable', () => {
  it(
    'a cancelled request does not hold its slot through the quota backoff',
    { timeout: 20_000 },
    async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(
          async () =>
            new Response('{"error":"quota"}', {
              status: 429,
              headers: { 'content-type': 'application/json' },
            }),
        ),
      );
      const controller = new AbortController();
      const t0 = Date.now();
      const pending = new AiClient(config).complete({
        maxOutputTokens: 100,
        messages: [{ role: 'user', content: 'x' }],
        signal: controller.signal,
      });
      // The provider said wait 60 s; the learner aborted at 200 ms — the client must not sleep
      // 60 s holding the request (and a cancelled request resolves promptly).
      setTimeout(() => controller.abort(), 200);
      const result = await pending;
      const elapsed = Date.now() - t0;
      expect(result.ok).toBe(false);
      expect(
        elapsed,
        `cancelled after the abort must not wait out the backoff (${elapsed} ms)`,
      ).toBeLessThan(5_000);
    },
  );
});

/**
 * The output-ceiling cascade filter: a model whose KNOWN ceiling cannot hold the request's max
 * tokens must never be advanced to. Provider /models data: `qwen3.6-35b` allows 8,192 output
 * tokens — no program fits — and it sat in the FreeInference cascade as the third hop, so every
 * 404/quota on the first two models advanced a multi-minute generation onto a model that
 * structurally cannot answer it: a paid, guaranteed truncation.
 */
describe('the cascade never advances a generation onto a model that cannot hold it', () => {
  it(
    'skips qwen3.6-35b (8,192-token ceiling) for a 131,072-token request, keeps unknown-ceiling models',
    { timeout: 45_000 },
    async () => {
      const freeinference = resolveConfig({
        AI_API_KEY: 'test-key',
        AI_BASE_URL: 'https://freeinference.org/v1',
        AI_MODEL: 'primary-model',
        AI_MAX_OUTPUT_TOKENS: '131072',
      });
      const requestedModels: string[] = [];
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        // Every eligible model 404s (the "retired model" path — retryable, advances the cascade).
        // The non-streaming reply shape is used: these calls carry no onProgress.
        vi.stubGlobal(
          'fetch',
          vi.fn(async (_url: unknown, init: { body: string }) => {
            requestedModels.push((JSON.parse(init.body) as { model: string }).model);
            return new Response('{"error":"no such model"}', {
              status: 404,
              headers: { 'content-type': 'application/json' },
            });
          }),
        );
        const result = await new AiClient(freeinference).complete({
          maxOutputTokens: 131_072,
          messages: [{ role: 'user', content: 'x' }],
        });
        expect(result.ok).toBe(false);
        // The configured model first, then ONLY the models that can hold 131,072 output tokens.
        // `qwen3.6-35b` (ceiling 8,192) is skipped with a warning; `glm-5.1` has no known ceiling
        // so it is NOT excluded on suspicion.
        expect([...new Set(requestedModels)]).toEqual([
          'primary-model',
          'deepseek-v4-flash',
          'glm-5.1',
        ]);
        expect(warnSpy.mock.calls.some((call) => String(call[0]).includes('qwen3.6-35b'))).toBe(
          true,
        );
      } finally {
        warnSpy.mockRestore();
        vi.unstubAllGlobals();
      }
    },
  );
});

/**
 * A provider-dictated wait must prove liveness while it runs. The 429 retry-after carries the
 * provider's number (60s) — until the wait itself emitted, that whole minute was silence for the
 * learner, kept alive only by the pipeline's heartbeat timer coupling, which was accidental.
 */
describe('a provider-dictated backoff', () => {
  it(
    'announces itself as progress — a long wait is liveness, not silence',
    { timeout: 20_000 },
    async () => {
      vi.useFakeTimers();
      // Every attempt answers immediately with the 429; the only time that passes is the
      // backoff the provider dictated (60s, three attempts → two waits).
      let attempts = 0;
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => {
          attempts += 1;
          return new Response(JSON.stringify({ error: { message: 'rate limited' } }), {
            status: 429,
            headers: { 'content-type': 'application/json' },
          });
        }),
      );
      const progress = vi.fn();
      const pending = new AiClient(config).complete({
        maxOutputTokens: 4096,
        messages: [{ role: 'user', content: 'x' }],
        onProgress: progress,
      });

      // 200 fake seconds: attempt(0s) → wait(60s) → attempt(60s) → wait(120s) → attempt(120s).
      await vi.advanceTimersByTimeAsync(200_000);
      const result = await pending;

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('quota');
      expect(attempts).toBe(3);
      // The two 60-second waits emitted their own proof of life — more progress calls than
      // attempts, which is only possible if the waits themselves ticked.
      expect(progress).toHaveBeenCalled();
      expect(progress.mock.calls.length).toBeGreaterThan(attempts);
    },
  );
});

/**
 * A streaming completion must hand the answer over as the provider writes it, not after the call
 * ends — `05`: "answers should stream token-by-token into the bubble — the tutor is writing,
 * visibly."
 *
 * These pin the two properties the chat route depends on: fragments observed while the call is
 * still open, and the per-attempt timeout still cutting a stream that never writes (a stalled
 * stream is a timeout, exactly as on the non-streaming path — never a silent hang).
 */
describe('a streaming completion yields text as it is written', () => {
  /** Poll until `condition` holds, so a microtask ordering is never the thing under test. */
  async function until(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
    const start = Date.now();
    while (!condition()) {
      if (Date.now() - start > timeoutMs) throw new Error('condition was never met');
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }

  it('forwards each fragment before the completion resolves', { timeout: 20_000 }, async () => {
    const encoder = new TextEncoder();
    let push!: (frame: string) => void;
    let close!: () => void;
    // A hand-fed SSE body: the test IS the provider, so it decides exactly when the answer ends.
    const body = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          push = (frame) => controller.enqueue(encoder.encode(frame));
          close = () => controller.close();
        },
      }),
      { headers: { 'content-type': 'text/event-stream' } },
    );
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => body),
    );

    const deltas: string[] = [];
    let settled = false;
    const pending = new AiClient(config)
      .completeStream(
        { maxOutputTokens: 4096, messages: [{ role: 'user', content: 'a tutor answered live' }] },
        (fragment) => deltas.push(fragment),
      )
      .then((result) => {
        settled = true;
        return result;
      });

    push(delta('Air '));
    push(delta('moves.'));
    await until(() => deltas.length === 2);

    // The load-bearing assertion: both fragments were in the learner's hands while the call was
    // STILL open. An implementation that surfaces text only after the completion fails here.
    expect(settled).toBe(false);
    expect(deltas).toEqual(['Air ', 'moves.']);

    push(finish('stop'));
    push(DONE);
    close();

    const result = await pending;
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.text).toBe('Air moves.');
  });

  it('the attempt timeout aborts a stalled stream', { timeout: 20_000 }, async () => {
    // A provider that accepted the request and then wrote nothing. The per-attempt timeout must
    // still fire through the streaming path — the same selfAbort the non-streaming path uses.
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: unknown, init?: RequestInit) => {
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            init?.signal?.addEventListener(
              'abort',
              () => {
                try {
                  controller.error(new DOMException('aborted', 'AbortError'));
                } catch {
                  /* already gone */
                }
              },
              { once: true },
            );
          },
        });
        return Promise.resolve(
          new Response(body, { headers: { 'content-type': 'text/event-stream' } }),
        );
      }),
    );

    const deltas: string[] = [];
    const result = await new AiClient(config).completeStream(
      {
        maxOutputTokens: 4096,
        messages: [{ role: 'user', content: 'a silent provider' }],
        timeoutMs: 40,
      },
      (fragment) => deltas.push(fragment),
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    // Same classification as a stalled non-streaming call: our own timeout, retryable — never a
    // learner cancellation and never the provider's socket death.
    expect(result.code).toBe('timeout');
    expect(result.retryable).toBe(true);
    expect(deltas).toEqual([]);
  });

  it(
    'resolves on the provider’s terminal chunk even though the body never closes',
    { timeout: 20_000 },
    async () => {
      // The live bug: the provider sends finish_reason and then holds the socket open. The read
      // loop must end on the finish, not on a close that never comes — otherwise a fully-written
      // answer hangs until the attempt timeout and the learner's composer never re-enables.
      respondWith(() =>
        heldSse([delta('const a = 1;\n'), delta('const b = 2;\n'), finish('stop'), DONE]),
      );

      const deltas: string[] = [];
      const startedAt = Date.now();
      const result = await new AiClient(config).completeStream(
        { maxOutputTokens: 4096, messages: [{ role: 'user', content: 'x' }], timeoutMs: 30_000 },
        (fragment) => deltas.push(fragment),
      );
      const elapsed = Date.now() - startedAt;

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('unreachable');
      expect(result.text).toBe('const a = 1;\nconst b = 2;\n');
      // Clean finish, from the finish_reason chunk — the same classification the closed-body path
      // produces. Nothing here may depend on the socket closing.
      expect(result.finishReason).toBe('stop');
      expect(deltas).toEqual(['const a = 1;\n', 'const b = 2;\n']);
      // The proof it ended on the provider's own finish, not on the 30 s attempt timeout.
      expect(elapsed, `resolved in ${elapsed} ms`).toBeLessThan(2_000);
    },
  );

  it(
    'still refuses a body that closes with text but no terminal event',
    { timeout: 20_000 },
    async () => {
      // The preserved conclusion, pinned: a clean EOF with text and no finish_reason / [DONE] is a
      // mid-program cut — handed back with `partialText`, not retried here. The early exit above must
      // not change this; it only changes WHEN the loop stops, not what it concludes.
      respondWith(() => sse([delta('const a = 1;')]));

      const result = await new AiClient(config).completeStream(
        { maxOutputTokens: 4096, messages: [{ role: 'user', content: 'x' }] },
        () => {},
      );

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('unreachable');
      expect(result.code).toBe('truncated');
      expect(result.retryable).toBe(false);
      expect(result.partialText).toBe('const a = 1;');
    },
  );
});
