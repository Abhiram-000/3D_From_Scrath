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

afterEach(() => vi.unstubAllGlobals());

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
