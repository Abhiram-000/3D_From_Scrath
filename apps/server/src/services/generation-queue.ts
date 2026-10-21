/**
 * The bounded global generation queue.
 *
 * The provider plan permits EXACTLY ONE concurrent request — an observed 429 body says so:
 * `{"code":"concurrency_limit_exceeded","message":"Too many concurrent requests (limit: 1)"}`.
 * Generations run 3–8 minutes, and until this module existed there was NO cap on concurrent
 * generations anywhere (only a per-IP request-rate limiter, which bounds request *starts*, not
 * minutes-long provider runs). So a second learner got a failed run, and the same key's own 429
 * retries collided with each other — the measured cause of a multi-topic run stretching past 79
 * minutes.
 *
 * The concurrency limit is a property of the PLAN being paid for, so it is configurable
 * (`AI_MAX_CONCURRENCY`, default 1) and documented in both env examples. Waiting is bounded
 * (`AI_QUEUE_MAX_WAIT_MS`): an overloaded server fails a request quickly and honestly
 * (`rate_limited`, with a retry-after number) instead of parking it silently behind a queue of
 * minute-long provider calls.
 *
 * Non-negotiables honoured here:
 *   - the event loop is never blocked — the wait is a resolved promise, not a spin (the audit was
 *     just moved off-thread; this module must not undo that class of fix);
 *   - drain-aware — a waiter whose drain signal fires is rejected with `QueueDrainedError`, which
 *     the route maps onto the terminal `draining` event the shutdown contract promises: a queued
 *     learner is TOLD, not severed;
 *   - FIFO — `shift()` grants the head of the wait list, first come, first served, no starvation;
 *   - observable — `stats()` reports depth for `/api/health`, and `onQueued`/`onGranted` let the
 *     route emit the waiting notice and heartbeats that keep the client's stall detector alive.
 */
import type { ErrorCode } from '@edu3d/contracts';

/** Rejected when the bounded queue wait elapsed without a slot. Maps to `rate_limited` (429). */
export class QueueWaitTimeoutError extends Error {
  constructor(maxWaitMs: number) {
    super(`the generation queue wait exceeded ${Math.round(maxWaitMs / 1000)}s`);
    this.name = 'QueueWaitTimeoutError';
  }
}

/** Rejected because the server is draining. Maps to the terminal `draining` event. */
export class QueueDrainedError extends Error {
  constructor() {
    super('The server is restarting; this queued request was stopped.');
    this.name = 'QueueDrainedError';
  }
}

/** Rejected because the learner's own connection went away while queued. Maps to `cancelled`. */
export class QueueCancelledError extends Error {
  constructor() {
    super('The request was cancelled while waiting in the generation queue.');
    this.name = 'QueueCancelledError';
  }
}

export interface GenerationQueueStats {
  /** Configured slot count — the provider plan's concurrency limit. */
  limit: number;
  /** Configured bounded wait, milliseconds. */
  maxWaitMs: number;
  /** Tasks currently holding a slot. */
  running: number;
  /** Tasks waiting for a slot — the depth `/api/health` exposes. */
  waiting: number;
}

export interface QueueRunOptions {
  /** The learner's connection: a queued request must not hold a place for an audience of zero. */
  signal?: AbortSignal;
  /**
   * Called once, when the task enters the queue and must wait (never for an immediately-granted
   * slot), with the 1-based position and the depth — the material for the "waiting behind N
   * generations" notice.
   */
  onQueued?: (position: number, depth: number) => void;
  /**
   * Called when the slot is actually granted — immediately for a fast path grant. The route stops
   * its own wait-side heartbeat interval here so the pipeline's heartbeats take over alone.
   */
  onGranted?: () => void;
}

/** The wire taxonomy entries a queue refusal maps onto, in the route's `PipelineFailure` shape. */
export interface QueueRouteFailure {
  code: Extract<ErrorCode, 'rate_limited' | 'draining' | 'cancelled'>;
  message: string;
  retryAfterSeconds?: number;
}

/** Map a queue refusal onto the wire's error taxonomy; `null` when the error is not a refusal. */
export function describeQueueFailure(error: unknown): QueueRouteFailure | null {
  if (error instanceof QueueWaitTimeoutError) {
    return {
      code: 'rate_limited',
      message:
        'The server is at its AI provider limit and the wait for a free generation slot ran out. Try again shortly.',
      retryAfterSeconds: 30,
    };
  }
  if (error instanceof QueueDrainedError) {
    return { code: 'draining', message: 'The server is restarting — the run stopped mid-stream.' };
  }
  if (error instanceof QueueCancelledError) {
    return { code: 'cancelled', message: 'The request was cancelled.' };
  }
  return null;
}

interface Waiter {
  grant: () => void;
  fail: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  /** Detaches the per-waiter abort listener; called on grant, timeout, abort and drain. */
  cleanup: () => void;
  /** Fires when the learner's abort signal (or the drain, composed by the caller's check) trips. */
  onAbort: () => void;
}

export interface GenerationQueue {
  /** Hold one slot for the duration of `task`, FIFO among concurrent callers. */
  run<T>(task: () => Promise<T>, options?: QueueRunOptions): Promise<T>;
  /** Current depth for observability (`/api/health`). Answers immediately, never waits. */
  stats(): GenerationQueueStats;
}

export function createGenerationQueue(options: {
  limit: number;
  maxWaitMs: number;
  /** The process drain signal: on abort, every waiter is told, never severed. */
  drainSignal: AbortSignal;
}): GenerationQueue {
  const limit = Math.max(1, Math.floor(options.limit));
  const maxWaitMs = options.maxWaitMs;
  let running = 0;
  /** FIFO: `shift()` grants the head — first come, first served, no starvation by re-bidding. */
  const waiters: Waiter[] = [];

  const failWaiter = (waiter: Waiter, error: Error): void => {
    clearTimeout(waiter.timer);
    waiter.cleanup();
    waiter.fail(error);
  };

  // The drain is a one-way door: every queued waiter gets the terminal `draining` story (via the
  // route's mapping), in-flight tasks still finish and release, but nothing new is granted.
  options.drainSignal.addEventListener(
    'abort',
    () => {
      for (const waiter of waiters.splice(0)) failWaiter(waiter, new QueueDrainedError());
    },
    { once: true },
  );

  const grantNext = (): void => {
    if (options.drainSignal.aborted) return; // waiters were already failed by the drain
    const waiter = waiters.shift();
    if (!waiter) return;
    clearTimeout(waiter.timer);
    waiter.cleanup();
    running += 1;
    waiter.grant();
  };

  return {
    run<T>(task: () => Promise<T>, runOptions?: QueueRunOptions): Promise<T> {
      // Two refusals before any queuing, mirroring the AI client's own pre-flight checks: a
      // draining server starts no generation, and an already-cancelled request must not take a
      // slot from someone who is waiting.
      if (options.drainSignal.aborted) return Promise.reject(new QueueDrainedError());
      if (runOptions?.signal?.aborted) return Promise.reject(new QueueCancelledError());

      // The invariant that makes FIFO real: waiters exist only while every slot is busy, so
      // `running < limit` alone decides fast-path vs queue. The increment is synchronous, which
      // makes the fast-path decision atomic per event-loop turn — no two callers can both win it.
      const acquire = (): Promise<() => void> => {
        if (running < limit) {
          running += 1;
          runOptions?.onGranted?.();
          return Promise.resolve(() => {
            running -= 1;
            grantNext();
          });
        }
        return new Promise<() => void>((resolve, reject) => {
          const waiter: Waiter = {
            grant: () => {
              runOptions?.onGranted?.();
              resolve(() => {
                running -= 1;
                grantNext();
              });
            },
            fail: (error) => reject(error),
            timer: setTimeout(() => {
              const index = waiters.indexOf(waiter);
              if (index >= 0) waiters.splice(index, 1);
              reject(new QueueWaitTimeoutError(maxWaitMs));
            }, maxWaitMs),
            cleanup: () => {
              runOptions?.signal?.removeEventListener('abort', waiter.onAbort);
            },
            onAbort: () => {
              const index = waiters.indexOf(waiter);
              if (index >= 0) waiters.splice(index, 1);
              reject(
                options.drainSignal.aborted && !runOptions?.signal?.aborted
                  ? new QueueDrainedError()
                  : new QueueCancelledError(),
              );
            },
          };
          runOptions?.signal?.addEventListener('abort', waiter.onAbort, { once: true });
          // Push FIRST, then notify: `runOptions?.onQueued?.(waiters.push(waiter), …)` would
          // short-circuit the push together with the call when no options are passed — a queued
          // task must be in the FIFO even when nobody asked to be told about it.
          const position = waiters.push(waiter);
          runOptions?.onQueued?.(position, waiters.length);
        });
      };

      return (async () => {
        const release = await acquire();
        try {
          return await task();
        } finally {
          release();
        }
      })();
    },
    stats: () => ({ limit, maxWaitMs, running, waiting: waiters.length }),
  };
}
