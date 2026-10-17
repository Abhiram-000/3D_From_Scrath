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
    expect(result.retryable).toBe(true);
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
