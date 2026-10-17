/**
 * When the ambient layer is worth creating at all.
 *
 * The viewer asked for `grid: false, spotlight: false` — it wanted no cursor system — and got the
 * ambient layer anyway, because the two colour blobs were created unconditionally before either
 * option was consulted. Those blobs are `filter: blur(60px)` on ~780px elements, animated to a
 * non-integer scale, sitting above an opaque WebGL canvas. A non-integer scale defeats Chrome's
 * cached filtered texture, so the blur re-rasterised every presented frame for the whole session.
 *
 * The decision is a pure function so it can be pinned here. It cannot be pinned through the DOM
 * because this suite runs in Node with no jsdom installed.
 */
import { describe, expect, it } from 'vitest';
import { ambientLayerRequested } from './ambient';

describe('whether to create the ambient layer', () => {
  it('declines when the caller asked for nothing, which is how the viewer uses it', () => {
    // The regression: this returned true, and the viewer paid for two blurred layers regardless.
    expect(ambientLayerRequested({ grid: false, spotlight: false, blobs: false })).toBe(false);
  });

  it('creates the layer if any single layer was requested', () => {
    expect(ambientLayerRequested({ grid: true, spotlight: false, blobs: false })).toBe(true);
    expect(ambientLayerRequested({ grid: false, spotlight: true, blobs: false })).toBe(true);
    expect(ambientLayerRequested({ grid: false, spotlight: false, blobs: true })).toBe(true);
  });

  it('defaults to creating everything, so the landing and loading pages are unchanged', () => {
    expect(ambientLayerRequested({})).toBe(true);
    expect(ambientLayerRequested()).toBe(true);
  });

  it('is a decision about the request, not about the runtime', () => {
    // `tracking` folds in `prefers-reduced-motion`, and a reduced-motion visitor must not cause the
    // blobs to reappear: whether to decorate at all is the caller's choice. Only the spotlight, which
    // draws a cursor, is allowed to depend on the runtime.
    expect(ambientLayerRequested({ grid: false, spotlight: false })).toBe(true);
    // Opting out of one layer never suppresses the others — they each default to on.
    expect(ambientLayerRequested({ blobs: false })).toBe(true);
    expect(ambientLayerRequested({ grid: false })).toBe(true);
    expect(ambientLayerRequested({ spotlight: false })).toBe(true);
  });
});