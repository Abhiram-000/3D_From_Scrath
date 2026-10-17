/**
 * Pointer coordinates and the send-now decision.
 *
 * The load-bearing case is `down`: deferring a click by a frame is perceptible, because the learner
 * acted on the pose they saw, and hover coalescing must not extend to it.
 */
import { describe, expect, it } from 'vitest';
import { shouldSendPointerNow, toCanvasPoint } from './pointer';

describe('pointer coordinates', () => {
  it('are relative to the canvas, not the viewport', () => {
    const rect = { left: 340, top: 60 };
    expect(toCanvasPoint(340, 60, rect)).toEqual({ x: 0, y: 0 });
    expect(toCanvasPoint(440, 160, rect)).toEqual({ x: 100, y: 100 });
  });

  it('handles a pointer above or left of the canvas without wrapping', () => {
    // A drag that leaves the captured element reports client coordinates outside the rect. These must
    // go negative, not wrap: the worker clamps them, and a wrapped value would hover the opposite edge.
    const rect = { left: 340, top: 60 };
    expect(toCanvasPoint(300, 40, rect)).toEqual({ x: -40, y: -20 });
  });
});

describe('which pointer samples are sent immediately', () => {
  it('sends presses and releases at once', () => {
    expect(shouldSendPointerNow('down')).toBe(true);
    expect(shouldSendPointerNow('up')).toBe(true);
  });

  it('coalesces moves, because the worker already does one raycast per frame', () => {
    expect(shouldSendPointerNow('move')).toBe(false);
  });
});
