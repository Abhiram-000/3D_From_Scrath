/**
 * The bounded global generation queue.
 *
 * The provider plan allows ONE concurrent request and generations run minutes; the queue is what
 * a second learner instead of a failed run. Pinned here: the concurrency limit is enforced (a
 * task can never see company), FIFO order (first come, first served — the dashboard-shaped
 * alternative is starvation), the bounded wait fails honestly, the drain tells every waiter (the
 * shutdown contract's "streams are told, not severed"), a learner going away releases the place,
 * and the refusal mapping lands on the same wire taxonomy every other failure uses.
 */
import { describe, expect, it } from 'vitest';
import { createLifecycle } from '../src/services/lifecycle.ts';
import {
  createGenerationQueue,
  describeQueueFailure,
  QueueCancelledError,
  QueueDrainedError,
  QueueWaitTimeoutError,
} from '../src/services/generation-queue.ts';

/** Records the peak number of tasks that overlapped inside `task`. */
async function peakConcurrency(
  queue: ReturnType<typeof createGenerationQueue>,
  count: number,
  task: () => Promise<void>,
): Promise<number> {
  let running = 0;
  let peak = 0;
  await Promise.all(
    Array.from({ length: count }, () =>
      queue.run(async () => {
        running += 1;
        peak = Math.max(peak, running);
        await task();
        running -= 1;
      }),
    ),
  );
  return peak;
}

/**
 * A promise with its opener, typed honestly: TS's control-flow analysis cannot see the executor
 * assignment, so a hand-rolled `let release = null` narrows to `never` at the call site.
 */
function gate(): { wait: Promise<void>; open: () => void } {
  let open!: () => void;
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open };
}

describe('a generation queue', () => {
  it('never runs more than `limit` tasks at once', async () => {
    const lifecycle = createLifecycle();
    const queue = createGenerationQueue({
      limit: 1,
      maxWaitMs: 5_000,
      drainSignal: lifecycle.drainSignal,
    });
    const peak = await peakConcurrency(queue, 4, () => new Promise((r) => setTimeout(r, 10)));
    expect(peak).toBe(1);
  });

  it('grants queued tasks in FIFO order', async () => {
    const lifecycle = createLifecycle();
    const queue = createGenerationQueue({
      limit: 1,
      maxWaitMs: 5_000,
      drainSignal: lifecycle.drainSignal,
    });
    const order: number[] = [];
    const hold = gate();
    const first = queue.run(async () => {
      order.push(1);
      await hold.wait; // hold the only slot until the others have queued
    });
    const queued = [2, 3, 4].map((n) =>
      queue.run(async () => {
        order.push(n);
      }),
    );
    await new Promise((r) => setTimeout(r, 10)); // let 2–4 queue behind 1
    hold.open();
    await Promise.all([first, ...queued]);
    expect(order).toEqual([1, 2, 3, 4]);
  });

  it('fails a waiter that waits past the bounded wait, honestly', async () => {
    const lifecycle = createLifecycle();
    const queue = createGenerationQueue({
      limit: 1,
      maxWaitMs: 50,
      drainSignal: lifecycle.drainSignal,
    });
    const holder = queue.run(() => new Promise((r) => setTimeout(r, 300)));
    await expect(
      queue.run(async () => {
        throw new Error('should never run');
      }),
    ).rejects.toBeInstanceOf(QueueWaitTimeoutError);
    await holder;
    // The queue still works after a timeout: the failed waiter must not have wedged it.
    expect(await queue.run(async () => 'recovered')).toBe('recovered');
  });

  it('tells queued waiters on drain instead of leaving them severed', async () => {
    const lifecycle = createLifecycle();
    const queue = createGenerationQueue({
      limit: 1,
      maxWaitMs: 60_000,
      drainSignal: lifecycle.drainSignal,
    });
    const holder = queue.run(() => new Promise((r) => setTimeout(r, 300)));
    const rejected = queue.run(async () => 'never');
    await new Promise((r) => setTimeout(r, 10)); // let the second task queue
    lifecycle.beginDrain();
    await expect(rejected).rejects.toBeInstanceOf(QueueDrainedError);
    await holder;
  });

  it('refuses new work while draining', async () => {
    const lifecycle = createLifecycle();
    const queue = createGenerationQueue({
      limit: 1,
      maxWaitMs: 60_000,
      drainSignal: lifecycle.drainSignal,
    });
    lifecycle.beginDrain();
    await expect(queue.run(async () => 'never')).rejects.toBeInstanceOf(QueueDrainedError);
  });

  it('releases a waiter whose learner connection went away while queued', async () => {
    const lifecycle = createLifecycle();
    const queue = createGenerationQueue({
      limit: 1,
      maxWaitMs: 60_000,
      drainSignal: lifecycle.drainSignal,
    });
    const holder = queue.run(() => new Promise((r) => setTimeout(r, 200)));
    const controller = new AbortController();
    const rejected = queue.run(async () => 'never', { signal: controller.signal });
    await new Promise((r) => setTimeout(r, 10));
    controller.abort();
    await expect(rejected).rejects.toBeInstanceOf(QueueCancelledError);
    await holder;
  });

  it('reports depth for /api/health and never blocks the caller asking for it', async () => {
    const lifecycle = createLifecycle();
    const queue = createGenerationQueue({
      limit: 1,
      maxWaitMs: 60_000,
      drainSignal: lifecycle.drainSignal,
    });
    expect(queue.stats()).toEqual({ limit: 1, maxWaitMs: 60_000, running: 0, waiting: 0 });
    const hold = gate();
    const held = queue.run(() => hold.wait);
    const waiting = queue.run(() => Promise.resolve());
    await new Promise((r) => setTimeout(r, 5));
    expect(queue.stats()).toMatchObject({ running: 1, waiting: 1 });
    hold.open();
    await Promise.all([held, waiting]);
    expect(queue.stats()).toMatchObject({ running: 0, waiting: 0 });
  });

  it('calls onQueued exactly when a request must wait, and onGranted when the slot arrives', async () => {
    const lifecycle = createLifecycle();
    const queue = createGenerationQueue({
      limit: 1,
      maxWaitMs: 60_000,
      drainSignal: lifecycle.drainSignal,
    });
    const queuedPositions: number[] = [];
    let grantedFirst = 0;
    let grantedSecond = 0;
    const hold = gate();
    const first = queue.run(() => hold.wait, { onGranted: () => void (grantedFirst += 1) });
    const second = queue.run(() => Promise.resolve(), {
      onQueued: (position) => queuedPositions.push(position),
      onGranted: () => void (grantedSecond += 1),
    });
    await new Promise((r) => setTimeout(r, 5));
    expect(queuedPositions).toEqual([1]); // queued once, with its FIFO position
    hold.open();
    await Promise.all([first, second]);
    expect(grantedFirst).toBe(1);
    expect(grantedSecond).toBe(1);
  });

  it('maps its refusals onto the wire taxonomy', () => {
    expect(describeQueueFailure(new QueueWaitTimeoutError(900_000))?.code).toBe('rate_limited');
    expect(describeQueueFailure(new QueueWaitTimeoutError(1))?.retryAfterSeconds).toBeDefined();
    expect(describeQueueFailure(new QueueDrainedError())?.code).toBe('draining');
    expect(describeQueueFailure(new QueueCancelledError())?.code).toBe('cancelled');
    expect(describeQueueFailure(new Error('unrelated'))).toBeNull();
  });
});
