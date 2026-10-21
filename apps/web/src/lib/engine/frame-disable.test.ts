/**
 * The guest frame callback's circuit breaker.
 *
 * The audit found that one throwing — or 13× overrunning — guest callback froze far more than
 * itself: the disable guarded a block that also contained the declared-motion application and the
 * transform sync (including the physics pose), so "the model is still explorable" was half a lie,
 * and there was no way back short of loading a new model.
 *
 * The policy here is the extracted shape of the fix: the disable scopes to the guest callback
 * *alone*, and it is a circuit breaker, not a life sentence — one probation run per retry window,
 * recovering fully on success, re-arming the window on failure.
 */
import { describe, expect, it } from 'vitest';
import {
  FRAME_RETRY_PROBE_MS,
  createFrameDisableState,
  frameCallbackDecision,
  frameCallbackFailed,
  frameCallbackRecovered,
} from './frame-disable';

describe('a healthy callback', () => {
  it('runs every frame, with no probation attached', () => {
    const decision = frameCallbackDecision(createFrameDisableState(), 1_000);
    expect(decision.run).toBe(true);
    expect(decision.probation).toBe(false);
  });
});

describe('a disabled callback', () => {
  it('stops running on the next frame', () => {
    const state = frameCallbackFailed(createFrameDisableState(), 1_000);
    const decision = frameCallbackDecision(state, 1_500);
    expect(decision.run).toBe(false);
  });

  it('is not retried before the retry window elapses', () => {
    const state = frameCallbackFailed(createFrameDisableState(), 1_000);
    const decision = frameCallbackDecision(state, 1_000 + FRAME_RETRY_PROBE_MS - 1);
    expect(decision.run).toBe(false);
  });

  it('gets exactly one probation run once the window has elapsed', () => {
    const state = frameCallbackFailed(createFrameDisableState(), 1_000);
    const at = 1_000 + FRAME_RETRY_PROBE_MS;
    expect(frameCallbackDecision(state, at)).toEqual({ run: true, probation: true });
  });
});

describe('a probation run that fails', () => {
  it('re-arms the retry clock instead of looping probes every frame', () => {
    const disabled = frameCallbackFailed(createFrameDisableState(), 1_000);
    const at = 1_000 + FRAME_RETRY_PROBE_MS;
    expect(frameCallbackDecision(disabled, at).probation).toBe(true);
    // The probe throws: the failure is stamped at the probe's own time, so the next window is a
    // full probe period away — one run per window, not one run per frame once past the threshold.
    const rearmed = frameCallbackFailed(disabled, at + 5);
    expect(frameCallbackDecision(rearmed, at + 6).run).toBe(false);
    expect(frameCallbackDecision(rearmed, at + 5 + FRAME_RETRY_PROBE_MS).probation).toBe(true);
  });
});

describe('a recovery', () => {
  it('returns the callback to unconditional service', () => {
    const recovered = frameCallbackRecovered();
    expect(recovered.disabled).toBe(false);
    expect(frameCallbackDecision(recovered, 2_000)).toEqual({ run: true, probation: false });
  });
});
