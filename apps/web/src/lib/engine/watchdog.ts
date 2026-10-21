/**
 * The watchdog's patience.
 *
 * The viewer must survive a model that hangs, so the worker is killed when it stops proving it is
 * alive. The hard part is that "alive" is measured in milliseconds of silence, and the slowest
 * moments of a model's life are also the ones where it cannot send anything: compiling, realizing
 * and — above all — presenting its first frame, which is when the graphics pipeline compiles every
 * shader the model needs.
 *
 * The policy is therefore two questions, kept apart on purpose:
 *
 *   - *How long may the worker be silent before it has ever presented a frame?* The answer is the
 *     cap, not the base. A first frame on a software rasterizer can take tens of seconds, and
 *     judging it by a fast device's rules is what killed healthy models on slow ones.
 *   - *How long may it be silent afterwards?* The answer follows the frames it has already
 *     presented: a device whose frames take a second gets a second of silence, because the only
 *     thing that distinguishes a slow frame from a dead worker is the worker itself saying so.
 *
 * Extracted here, free of the DOM, so the policy can be tested as arithmetic.
 *
 * The trade-off this policy makes, stated plainly because it is a real one: the worst case for
 * catching a genuinely wedged worker gets *longer*. A worker that hangs during its first frame is
 * now tolerated for the cap rather than four seconds, so a learner waits longer before the viewer
 * offers them a retry. The guarantee itself is unchanged — a wedged worker sends nothing at all, so
 * it crosses any threshold eventually — and the alternative was worse in the other direction: on a
 * slow device the four-second rule killed models that were working, and a kill is not a retry it
 * recovers from, it is the model being taken away.
 */

/** Watchdog thresholds. Each is a number with a reason, not a guess. */
export const WATCHDOG = {
  /**
   * Minimum milliseconds without proof of life before the worker is considered hung.
   *
   * The worker beats every second, and *any* message from it proves the event loop is turning.
   * Four seconds is four missed beats — comfortably beyond a slow frame or a GC pause on an
   * ordinary device, and short enough that a learner has not yet decided the page is broken.
   */
  heartbeatTimeoutMs: 4_000,

  /**
   * How many average frames of slack the adaptive timeout grants.
   *
   * A device whose frames genuinely take a second needs a longer silence than one whose frames
   * take 16 ms, or every slow-but-alive model is executed. Six frames past the average is far
   * enough that only a truly wedged loop (which sends nothing, ever) can cross it.
   */
  frameSlackMultiplier: 6,

  /**
   * The ceiling on the patience, so a pathological frame measurement cannot disable the watchdog
   * entirely — and so the "no frame yet" window is bounded.
   */
  maxHeartbeatTimeoutMs: 30_000,

  /**
   * Grace period after a load request before heartbeat monitoring resumes, per device tier.
   *
   * A build legitimately blocks the worker's event loop for seconds, and the worker's own build
   * deadline is what bounds the guest code — but realization and shader compilation sit outside
   * that deadline. The grace is tier-scaled for the same reason the silence rule is scaled with
   * measured frame time: the cost is several times higher on a weak device.
   */
  buildGraceMsByTier: {
    low: 60_000,
    mid: 40_000,
    high: 25_000,
  },
} as const;

/** The device tiers the grace is scaled for. */
export type WatchdogTier = keyof typeof WATCHDOG.buildGraceMsByTier;

/** What the worker has told us about itself so far. */
export interface LivenessEvidence {
  /** Whether the worker has presented a frame and reported its cost. */
  hasMeasuredFrame: boolean;
  /** The worker's most recent measured frame cost, in milliseconds. */
  frameMillis: number;
}

/**
 * How long the worker may be silent before it is killed.
 *
 * Before the first measured frame there is nothing to adapt to, and the frame in question is the
 * most expensive one the worker will ever present — the one that compiles every shader. A model
 * that is merely slow there must not be mistaken for a model that is hung.
 */
export function heartbeatTimeoutMs(evidence: LivenessEvidence): number {
  if (!evidence.hasMeasuredFrame) return WATCHDOG.maxHeartbeatTimeoutMs;

  const adaptive =
    WATCHDOG.heartbeatTimeoutMs + evidence.frameMillis * WATCHDOG.frameSlackMultiplier;
  return Math.min(WATCHDOG.maxHeartbeatTimeoutMs, Math.max(WATCHDOG.heartbeatTimeoutMs, adaptive));
}

/** The grace a load is given on a given tier, in milliseconds. */
export function buildGraceMs(tier: WatchdogTier): number {
  return WATCHDOG.buildGraceMsByTier[tier];
}

/**
 * Page-level evidence about whether the page could have produced a frame at all.
 *
 * Both states below stop the *worker's* rAF, which stops its stats and heartbeats — silence that
 * says "the learner is away", nothing about the worker. A hidden tab is the easy case. The harder
 * one is the fully occluded (or minimized) window: `document.visibilityState` still says "visible",
 * but rAF stalls there too. The main thread's own rAF clock is the shared probe — if nothing has
 * fired a frame callback in a while, the worker's rAF is stalled for the same reason.
 */
export interface PageRenderEvidence {
  /** `document.hidden`, read at tick time. */
  hidden: boolean;
  /** Milliseconds since a main-thread `requestAnimationFrame` last fired. */
  msSinceRaf: number;
}

/**
 * How long a "visible" page may go without a frame callback before the window must be treated as
 * occluded or minimized. A rendering page fires rAF every ~16 ms; the browsers that pause rAF for
 * occlusion or energy saving pause it for far longer than this. Generous enough never to catch a
 * busy main thread, far below the minute-scale throttling the states below produce.
 */
export const RAF_SILENCE_GAP_MS = 5_000;

/** Whether the worker's silence could be the page's doing rather than the worker's. */
export function renderSuppressed(evidence: PageRenderEvidence): boolean {
  return evidence.hidden || evidence.msSinceRaf > RAF_SILENCE_GAP_MS;
}

/**
 * The watchdog's mutable judgement state, one instance per worker.
 *
 * `wasSuppressed` is the fix for the demo-killer: the old code *refreshed* `lastHeartbeatAt` on
 * every hidden tick, which kept the value honest until the browser throttled even the refresh —
 * and then the return tick measured a 60 s gap against a 30 s threshold and executed a healthy
 * model. Now a suppressed tick records that a suppression happened; the first tick that sees the
 * suppression lifted re-arms a full fresh window instead of measuring across the gap.
 */
export interface WatchdogState {
  /** The last time the worker proved liveness — or the last re-arm. */
  lastHeartbeatAt: number;
  /** True from the first tick that saw suppression until the first tick that sees it lifted. */
  wasSuppressed: boolean;
  /** True after the dev warning for the current silence episode has been issued. */
  warned: boolean;
}

export interface WatchdogTickInput {
  state: WatchdogState;
  nowMs: number;
  /** The page could not have produced a frame; see `renderSuppressed`. */
  suppressed: boolean;
  /** The load grace's deadline, or 0 when no load is in flight. */
  graceUntil: number;
  /** The silence threshold for this worker, already adapted to its measured frames. */
  timeoutMs: number;
}

export interface WatchdogTickVerdict {
  /** The state to persist (last heartbeat, suppression latch, warn latch). */
  state: WatchdogState;
  /** A dev-only warning for an approaching kill, or null. */
  warn: string | null;
  /** Kill the worker: its silence crossed the threshold while the page was provably able to render. */
  kill: boolean;
}

/** The single kill sentence, kept beside the judgement that fires it. */
export const WATCHDOG_KILL_REASON =
  'This model stopped responding and was stopped to keep the page usable. You can try generating it again.';

/**
 * One 1 Hz watchdog tick, as pure arithmetic.
 *
 * Order matters, and every early return is a case the watchdog must refuse to judge:
 * the build grace, then the page's own frame suppression, then the suppression *release* — and
 * only then the silence itself, measured from the last heartbeat or the last re-arm.
 */
export function judgeWatchdogTick(tick: WatchdogTickInput): WatchdogTickVerdict {
  const { state, nowMs, suppressed, graceUntil, timeoutMs } = tick;

  // A build legitimately blocks the worker's loop: judging silence inside the grace period
  // executes work that was going to finish.
  if (graceUntil > nowMs) return { state, warn: null, kill: false };

  if (suppressed) {
    // Do NOT refresh the heartbeat here — that is the old demo-killer's move. Record that the
    // gap was unwitnessed; the return tick does the forgiving.
    return {
      state: { ...state, wasSuppressed: true, warned: false },
      warn: null,
      kill: false,
    };
  }

  if (state.wasSuppressed) {
    // First tick after the page can render again. The worker's rAF was stopped for the whole gap,
    // so the measured silence says how long the learner was away, not whether the worker hung.
    // Re-arm a full fresh window: a live worker posts within about a second of returning (its own
    // rAF resumed with the page's), and a wedged one crosses the fresh window as surely as ever.
    return {
      state: { lastHeartbeatAt: nowMs, wasSuppressed: false, warned: false },
      warn: null,
      kill: false,
    };
  }

  const silence = nowMs - state.lastHeartbeatAt;
  if (silence > timeoutMs) {
    return { state: { ...state, warned: false }, warn: null, kill: true };
  }

  const warn =
    silence > timeoutMs * 0.7 && !state.warned
      ? `worker silent ${(silence / 1000).toFixed(1)}s — watchdog fires in ~${Math.max(
          0,
          Math.round((timeoutMs - silence) / 1000),
        )}s`
      : null;

  return { state: warn ? { ...state, warned: true } : state, warn, kill: false };
}
