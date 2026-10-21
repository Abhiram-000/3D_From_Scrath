/**
 * The lifecycle service: the drain signal and the generation counter the process waits on.
 *
 * `06` documents the shutdown contract ("in-flight requests finish, streams are told, hard
 * exit in 15s"). Its two halves that used to exist only in the header comment live here:
 *
 *   - **drain** — flipped by the composition root in `main.ts` when the signal arrives; the
 *     AI client stops starting new provider calls, aborts in-flight ones (its signal is
 *     combined into every fetch), and the pipeline's phase checks return the `draining`
 *     failure so every open stream ends with the terminal `error` event the protocol demands;
 *   - **open generations** — a counter the pipeline owns for exactly the lifetime of one
 *     `runPipeline` call. `waitUntilQuiet` is what lets shutdown WAIT for streams to be told
 *     a terminal event before flushing and exiting, bounded by whichever timer the caller
 *     passes — never an excuse to hang the process.
 *
 * This is a deliberately small, dependency-free module: it sits between `main.ts` (mutates),
 * `ai-client.ts` (reads, and waits on a drain abort when retrying) and `pipeline.ts` (reads
 * at each phase boundary, counts its own lifetime).
 */

export interface LifecycleService {
  /** True once `beginDrain` has fired. Read at every pipeline phase boundary. */
  readonly draining: boolean;
  /** Aborted by `beginDrain`; combined into provider fetch signals so they stop promptly. */
  readonly drainSignal: AbortSignal;
  beginDrain(): void;
  /** Count of in-flight `runPipeline` invocations — incremented first, decremented in finally. */
  readonly openGenerations: number;
  beginGeneration(): void;
  endGeneration(): void;
  /**
   * Resolves when `openGenerations` reaches 0 (before or after the drain), or immediately at
   * drain when nothing is open. Bounded by `timeoutModeMs` so a wedged generation cannot hold
   * shutdown forever — the composition root's hard timer stays the absolute bound.
   */
  waitUntilQuiet(timeoutMs: number): Promise<void>;
}

export function createLifecycle(): LifecycleService {
  let draining = false;
  const controller = new AbortController();
  let open = 0;
  const quietWaiters = new Set<() => void>();

  const resolveWaiters = () => {
    const waiters = [...quietWaiters];
    quietWaiters.clear();
    for (const wait of waiters) wait();
  };

  const releaseIfQuiet = () => {
    if (open === 0) resolveWaiters();
  };

  const lifecycle: LifecycleService = {
    get draining() {
      return draining;
    },
    get drainSignal() {
      return controller.signal;
    },
    get openGenerations() {
      return open;
    },
    beginDrain() {
      draining = true;
      controller.abort();
      releaseIfQuiet();
    },
    beginGeneration() {
      open += 1;
    },
    endGeneration() {
      open = Math.max(0, open - 1);
      releaseIfQuiet();
    },
    waitUntilQuiet(timeoutMs: number): Promise<void> {
      if (open === 0) return Promise.resolve();
      return new Promise<void>((resolve) => {
        let settled = false;
        const done = () => {
          if (settled) return;
          settled = true;
          clearTimeout(cap);
          quietWaiters.delete(done);
          resolve();
        };
        const cap = setTimeout(done, timeoutMs);
        quietWaiters.add(done);
        releaseIfQuiet();
      });
    },
  };

  return lifecycle;
}

/**
 * The process-wide instance. The composition root mutates it; the AI client and the pipeline
 * read it. Module state rather than injected configuration is deliberate: `app.ts` constructs
 * the shared `AiClient`, so a constructor-injected lifecycle would touch a file this change
 * is not scoped to — the singleton keeps the drain wired with no route changes at all.
 */
export const lifecycle: LifecycleService = createLifecycle();
