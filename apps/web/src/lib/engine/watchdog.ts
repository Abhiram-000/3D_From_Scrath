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
