/**
 * The contract for the status bar's frame rate.
 *
 * The load-bearing case is the stall: the old `1000 / meanFrameMillis` reported 68fps for a page
 * that had presented nothing for 29 seconds, so the one number a learner or a developer would use
 * to decide whether the viewer was alive read healthiest exactly when it was dead.
 */
import { describe, expect, it } from 'vitest';
import { MAX_REPORTED_FPS, computeFrameRate } from './frame-rate';

describe('the reported frame rate', () => {
  it('is frames presented per second', () => {
    // 60 frames in one second is 60fps.
    expect(computeFrameRate(60, 0, 1000, 0)).toBe(60);
    // 30 in one second is 30fps, however fast each frame's work was.
    expect(computeFrameRate(30, 0, 1000, 0)).toBe(30);
  });

  it('is zero for a loop that presented nothing, however fast its last frames were', () => {
    // The measured failure: the frames that did run took 14.7ms each, which the old formula turned
    // into "68fps" while the loop advanced 0 frames in 29 seconds of wall time.
    const stalled = computeFrameRate(36, 36, 30_000, 1_000);
    expect(stalled).toBe(0);
    // The control: this is what the status bar used to claim for that same state.
    expect(1000 / 14.71).toBeGreaterThan(60);
  });

  it('measures across the window between two samples, not from zero', () => {
    // 600 frames total, 120 of them inside this second.
    expect(computeFrameRate(600, 480, 5000, 4000)).toBe(120);
  });

  it('is zero on the first publish rather than Infinity', () => {
    // No previous sample means no window. Reporting Infinity would render as "∞" in the status bar.
    expect(computeFrameRate(0, 0, 5000, 0)).toBe(0);
    expect(computeFrameRate(40, 40, 5000, 5000)).toBe(0);
  });

  it('caps a catch-up burst so it cannot claim an impossible rate', () => {
    expect(computeFrameRate(10_000, 0, 1000, 0)).toBe(MAX_REPORTED_FPS);
  });
});
