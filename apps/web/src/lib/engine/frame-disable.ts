/**
 * The guest frame callback's circuit breaker.
 *
 * `SANDBOX_LIMITS.frameOverrunLimit` overruns — or one throw — used to set a `frameDisabled` flag
 * that gated a block containing far more than the callback: the declared-motion application and
 * the transform sync (with the physics pose) went dark with it. A broken *animation* froze the
 * *model*: the notice's "still explorable" was half true, and the only reset was loading a
 * different model, so the state was also unrecoverable.
 *
 * The fix is scope plus recovery, as policy:
 *  - **Scope.** The disable touches the guest callback alone. Declared motion and the transform
 *    sync run unconditionally, so physics keeps stepping into a pose that is actually applied.
 *  - **Recovery.** A disable grants exactly one probation run per retry window
 *    (`FRAME_RETRY_PROBE_MS`). A probation that throws or overruns re-arms the window — one run
 *    per window, never one per frame — and one that holds its budget clears the disable entirely.
 *
 * Pure arithmetic, no DOM and no three, so the isolation and the recovery are both testable.
 */

/** The disable state the worker holds per model. */
export interface FrameDisableState {
  disabled: boolean;
  /** `performance.now()` when the set was applied (or its last probation re-applied it). */
  disabledAtMs: number;
}

/**
 * How long a disabled callback stays dark before the runtime gives it one frame to prove itself.
 *
 * Long enough that a busy site (a GC-pressure spike, a slow device under load) does not turn every
 * recovery attempt into a fresh stall; short enough that a transient fault — a parameter that
 * briefly made the model's per-frame work explode — is back within seconds of the pressure ending.
 */
export const FRAME_RETRY_PROBE_MS = 10_000;

export interface FrameCallbackDecision {
  /** Run the guest callback this frame? */
  run: boolean;
  /** True when this run is the single probation frame of a retry window. */
  probation: boolean;
}

/** The initial state: the callback is in full service. */
export function createFrameDisableState(): FrameDisableState {
  return { disabled: false, disabledAtMs: 0 };
}

/**
 * Should the guest callback run this frame?
 *
 * A disabled callback is skipped until its window elapses, then granted *one* probation run; the
 * `probation` flag tells the caller to treat failure as a re-arm rather than a second notice-spam.
 */
export function frameCallbackDecision(
  state: FrameDisableState,
  nowMs: number,
): FrameCallbackDecision {
  if (!state.disabled) return { run: true, probation: false };
  if (nowMs - state.disabledAtMs >= FRAME_RETRY_PROBE_MS) return { run: true, probation: true };
  return { run: false, probation: false };
}

/**
 * The callback failed — a throw, or sustained overruns. Stamps the failure time, which is what
 * starts (or restarts) the retry window: a failed probation naturally schedules the next probe a
 * full window later, because its stamp is the probe's own moment.
 */
export function frameCallbackFailed(
  _previous: FrameDisableState,
  nowMs: number,
): FrameDisableState {
  return { disabled: true, disabledAtMs: nowMs };
}

/** Any run that held its budget clears the disable entirely. */
export function frameCallbackRecovered(): FrameDisableState {
  return createFrameDisableState();
}
