/**
 * The API client's error-carrying contracts, pinned where the wire meets the caller.
 *
 * Two properties are load-bearing enough to test rather than trust:
 *   1. `API_BASE` is one constant every fetch is built from, defaulting to the same-origin `/api` —
 *      the split-deployment override (`PUBLIC_API_BASE`) must not silently change the dev/default
 *      behaviour.
 *   2. the server's 429 envelope carries `retryAfterSeconds`, and both the streaming and
 *      non-streaming clients deliver it to the caller — a retryable rate limit must be *tellable*,
 *      not a bare "the request failed".
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { API_BASE, apiFetch, generateStream } from './api';

afterEach(() => {
  vi.unstubAllGlobals();
});

function fetchAnswering(status: number, body: unknown): ReturnType<typeof vi.fn> {
  return vi.fn(
    async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
  );
}

describe('API_BASE', () => {
  it('defaults to the same-origin /api', () => {
    // The dev proxy, the one-container deploy and every existing deployment answer here; the
    // default must hold so nothing changes for them.
    expect(API_BASE).toBe('/api');
  });
});

describe('apiFetch', () => {
  it('carries the server retryAfterSeconds on a rate-limited answer', async () => {
    vi.stubGlobal(
      'fetch',
      fetchAnswering(429, {
        error: { code: 'rate_limited', message: 'Too many requests.', retryAfterSeconds: 30 },
      }),
    );

    const result = await apiFetch<unknown>('/gallery');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('rate_limited');
      expect(result.message).toBe('Too many requests.');
      expect(result.retryAfterSeconds).toBe(30);
    }
  });

  it('omits retryAfterSeconds when the server did not send one', async () => {
    vi.stubGlobal('fetch', fetchAnswering(500, { error: { code: 'internal', message: 'Boom.' } }));

    const result = await apiFetch<unknown>('/gallery');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.retryAfterSeconds).toBeUndefined();
  });
});

describe('generateStream', () => {
  it('carries retryAfterSeconds from a non-streaming failure envelope', async () => {
    // A 429 before the stream starts is the ordinary rate-limit shape: a plain error envelope.
    vi.stubGlobal(
      'fetch',
      fetchAnswering(429, {
        error: { code: 'rate_limited', message: 'Slow down.', retryAfterSeconds: 12 },
      }),
    );

    const outcome = await generateStream({ topic: 'how a jet engine works' });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.code).toBe('rate_limited');
      expect(outcome.retryAfterSeconds).toBe(12);
    }
  });

  it('targets API_BASE for the generate call', async () => {
    const fetchSpy = fetchAnswering(429, { error: { code: 'rate_limited', message: 'x' } });
    vi.stubGlobal('fetch', fetchSpy);

    await generateStream({ topic: 'how a jet engine works' });
    expect(fetchSpy).toHaveBeenCalledWith(
      `${API_BASE}/generate`,
      expect.objectContaining({ method: 'POST' }),
    );
  });
});
