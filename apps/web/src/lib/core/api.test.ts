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
  vi.useRealTimers();
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

/**
 * The two self-aborts a client can suffer must be distinguishable truths — a silent feed
 * ("the model stopped responding") and a run that is merely long are different failures, and
 * today BOTH arrive in the same AbortError with no way to tell which timer fired.
 *
 * The streams below are hand-built ReadableStreams: the client's `fetch` signal is the client's
 * OWN AbortController, so the test hooks the stream to error when that signal fires — the same
 * coupling a real socket has (aborting a fetch tears down its body). That lets fake timers drive
 * the client's stall and backstop timers around a body that never ends on its own.
 */
describe('generateStream timers: stall vs overrun', () => {
  const ABORT_ERROR = () => new DOMException('The operation was aborted.', 'AbortError');

  interface HangingStream {
    /** Beat: one heartbeat on the wire. */
    beat: () => void;
    /** Tear the stream down with an AbortError (what a real aborting fetch does to its body). */
    error: () => void;
  }

  /** A body that never ends unless beaten or errored, hooked to the fetch signal. */
  function hangForeverStream(): HangingStream {
    const encoder = new TextEncoder();
    let ctl: ReadableStreamDefaultController<Uint8Array> | undefined;
    const error = () => {
      try {
        ctl?.error(ABORT_ERROR());
      } catch {
        /* already errored — second teardown is a no-op by construction */
      }
    };
    const heartbeatLine = encoder.encode(
      JSON.stringify({ type: 'heartbeat', phase: 'model', phaseSeconds: 1, at: 0 }) + '\n',
    );
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: unknown, init?: RequestInit) => {
        const stream = new ReadableStream<Uint8Array>({
          start(c) {
            ctl = c;
            init?.signal?.addEventListener('abort', error, { once: true });
          },
        });
        return Promise.resolve(
          new Response(stream, { headers: { 'content-type': 'application/x-ndjson' } }),
        );
      }),
    );
    return {
      beat: () => {
        try {
          ctl?.enqueue(heartbeatLine);
        } catch {
          /* stream gone: the run already ended */
        }
      },
      error,
    };
  }

  it('a stream that even the stall detector never trips outlives the old flat total', async () => {
    // RED-first proof of the invariant: with heartbeats arriving every ~10s the client is
    // demonstrably alive, so past the old flat 6-minute total it must STILL be waiting —
    // the server's terminal event owns that moment, and the client cannot preempt it.
    vi.useFakeTimers();
    const stream = hangForeverStream();
    const outer = new AbortController();
    const pending = generateStream({ topic: 'a long but healthy topic', signal: outer.signal });
    let settled = false;
    pending.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );

    // 400 fake seconds of tucked-in heartbeats — well past the old 6-minute total, every gap
    // far under the 40s stall window. Not one of these timers may end the wait.
    for (let second = 0; second < 40; second++) {
      await vi.advanceTimersByTimeAsync(9_500);
      stream.beat();
      await vi.advanceTimersByTimeAsync(500);
    }
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false); // RED evidence: today this is ALREADY settled, code 'stalled'

    // Settle the run ourselves and prove the client never self-aborted.
    outer.abort();
    const outcome = await pending;
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe('aborted');
  });

  it('outliving the client backstop is its own failure — distinct code, distinct sentence', async () => {
    // The backstop exists for the impossible case (the server missed its own deadline). When it
    // fires it must NOT tell the learner "the model stopped responding" — nothing is silent.
    vi.useFakeTimers();
    const stream = hangForeverStream();
    const pending = generateStream({ topic: 'a topic that outruns every server deadline' });

    // 3_450 fake seconds of continuous liveness — past the client's total backstop.
    for (let second = 0; second < 345; second++) {
      await vi.advanceTimersByTimeAsync(9_500);
      stream.beat();
      await vi.advanceTimersByTimeAsync(500);
    }

    const outcome = await pending;
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      // Its own code — never the stall story.
      expect(outcome.code).toBe('run_overrun');
      expect(outcome.message).not.toBe('The model stopped responding. Try again in a moment.');
    }
  });

  it('a true silence still reads as a stall — the fix must not disarm the hang detector', async () => {
    vi.useFakeTimers();
    // No body at all: fetch pends until the client's own abort rejects it, like a dead socket.
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: unknown, init?: RequestInit) => {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(ABORT_ERROR()), { once: true });
        });
      }),
    );
    const pending = generateStream({ topic: 'a topic on a silent wire' });
    // The stall check ticks every 10s and fires on the 5th tick (50s of silence > 40s budget),
    // so the fake clock must pass beyond 50s for the abort to happen at all.
    await vi.advanceTimersByTimeAsync(55_000);
    const outcome = await pending;

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.code).toBe('stalled');
      expect(outcome.message).toBe('The model stopped responding. Try again in a moment.');
    }
  });
});
