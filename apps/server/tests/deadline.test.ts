/**
 * The pipeline's overall deadline — the invariant that the server ALWAYS sends a terminal event
 * before any client timer fires, in its server half.
 *
 * The old shape had no overall wall: only per-attempt provider bounds, multiplied by the cascade's
 * models × retries and the pipeline's continuations × repairs. The client's flat 6-minute total
 * therefore always fired first, and every long-but-alive generation was mislabelled "the model
 * stopped responding". These tests pin the server's ownership of the wall:
 *
 *   1. a run that outlives `PIPELINE_DEADLINE_MS` ends with the server's OWN named error —
 *      never a client-style cancel, never an abort with no terminal event;
 *   2. the run keeps proving life (heartbeats) right up to that moment;
 *   3. the contract arithmetic that makes the invariant checkable holds: queue wait + deadline +
 *      margin < client backstop.
 *
 * The fake clock (vitest fake timers) drives the run past the 39.5-minute deadline in fake time —
 * the stub AI streams proof-of-life forever and never answers, which is exactly the shape of the
 * failure class in question (long AND alive, then the wall).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CLIENT_BACKSTOP_MARGIN_MS,
  CLIENT_TOTAL_BACKSTOP_MS,
  GENERATION_QUEUE_MAX_WAIT_MS,
  PIPELINE_DEADLINE_MS,
} from '@edu3d/contracts';
import type { AiClient } from '../src/services/ai-client.ts';
import { runPipeline } from '../src/services/pipeline.ts';

/**
 * An AI that streams proof-of-life forever and never answers. On the deadline's abort it resolves
 * exactly the way the real ai-client classifies a request-signal abort: a non-retryable
 * 'cancelled' failure. The pipeline must NOT let that classification stand in for the deadline.
 */
const endlessAi = {
  complete: (request: { onProgress?: (chars: number) => void; signal?: AbortSignal }) =>
    new Promise((resolve) => {
      const beat = setInterval(() => request.onProgress?.(0), 1_000);
      request.signal?.addEventListener(
        'abort',
        () => {
          clearInterval(beat);
          resolve({
            ok: false as const,
            code: 'cancelled',
            message: 'The request was cancelled.',
            retryable: false,
          });
        },
        { once: true },
      );
    }),
} as unknown as AiClient;

afterEach(() => {
  vi.useRealTimers();
});

/** Drive the fake clock to the deadline plus document-grace, letting every intermediate timer run. */
async function outliveDeadline(): Promise<void> {
  await vi.advanceTimersByTimeAsync(PIPELINE_DEADLINE_MS + 5_000);
}

describe('the pipeline overall deadline', () => {
  it(
    'ends a run that outlives the deadline with the server’s own named error — never a cancel',
    { timeout: 30_000 },
    async () => {
      vi.useFakeTimers();
      const pending = runPipeline('a topic that runs forever', 'balanced', {
        ai: endlessAi,
        sink: () => {},
        tier: 'mid',
        maxOutputTokens: 8_192,
      });
      await outliveDeadline();
      const result = await pending;

      expect(result.ok).toBe(false);
      if (result.ok) return;
      // The deadline abort surfaces inside the ai-client as 'cancelled'; the terminal failure the
      // LEARNER sees must be the deadline's — a cancellation is for someone who left, and nobody
      // left. The failure names the wall, in its own words.
      expect(result.failure.code).toBe('upstream_failed');
      expect(result.failure.message).toMatch(/overall time limit/);
      expect(result.failure.message).toContain(
        String(Number((PIPELINE_DEADLINE_MS / 60_000).toFixed(1))),
      );
    },
  );

  it(
    'keeps proving life — heartbeats flow for the whole run, up to and including the deadline',
    { timeout: 30_000 },
    async () => {
      vi.useFakeTimers();
      const events: unknown[] = [];
      const pending = runPipeline('a very long topic', 'balanced', {
        ai: endlessAi,
        sink: (event) => events.push(event),
        tier: 'mid',
        maxOutputTokens: 8_192,
      });
      await outliveDeadline();
      await pending;

      const heartbeats = events.filter((event) => (event as { type: string }).type === 'heartbeat');
      // ~1 heartbeat per 10s across a 39.5-minute run — progress was visible the whole way, which
      // is what keeps the client's stall detector (40s of TRUE silence) honest during long runs.
      expect(heartbeats.length).toBeGreaterThan(PIPELINE_DEADLINE_MS / 60_000);
    },
  );

  it('keeps the contract arithmetic: queue + deadline + margin < the client backstop', () => {
    expect(GENERATION_QUEUE_MAX_WAIT_MS + PIPELINE_DEADLINE_MS).toBeLessThan(
      CLIENT_TOTAL_BACKSTOP_MS,
    );
    expect(CLIENT_TOTAL_BACKSTOP_MS - GENERATION_QUEUE_MAX_WAIT_MS - PIPELINE_DEADLINE_MS).toBe(
      CLIENT_BACKSTOP_MARGIN_MS,
    );
  });

  it('a run that finishes well inside the budget is untouched by the deadline machinery', async () => {
    const fastAi = {
      complete: async () => ({
        ok: true as const,
        text: '```javascript\nconst x = 1;\n```',
        finishReason: 'stop',
        usage: { promptTokens: 1, completionTokens: 1 },
      }),
    } as unknown as AiClient;
    const result = await runPipeline('deliberately unbuildable', 'balanced', {
      ai: fastAi,
      sink: () => {},
      tier: 'mid',
      maxOutputTokens: 8_192,
    });
    // Whatever the pipeline's verdict on THIS program, the failure must not be the deadline's —
    // the wall only speaks when it is actually reached.
    if (!result.ok) expect(result.failure.message).not.toMatch(/overall time limit/);
  });
});
