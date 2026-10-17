/**
 * Pausing the engine behind an overlay.
 *
 * The load-bearing property is that it does not latch. A pause set for one modal must not survive the
 * modal closing, and a model the learner had already paused must not be resumed by the overlay
 * going away — both are one-line mistakes that only show up as "the model stopped" or "the model
 * won't stop", never as an error.
 */
import { describe, expect, it } from 'vitest';
import { anyOverlayOpen, shouldPauseRender } from './render-pause';

const none = {
  quizModalOpen: false,
  shortcutsModalOpen: false,
  shareModalOpen: false,
  galleryOpen: false,
  generateOpen: false,
  codeViewModalOpen: false,
  viewPresetsOpen: false,
};

describe('which overlays pause the engine', () => {
  it('sees every overlay the viewer can open', () => {
    expect(anyOverlayOpen(none)).toBe(false);
    for (const key of Object.keys(none) as (keyof typeof none)[]) {
      expect(anyOverlayOpen({ ...none, [key]: true }), key).toBe(true);
    }
  });

  it('sees two at once', () => {
    expect(anyOverlayOpen({ ...none, galleryOpen: true, generateOpen: true })).toBe(true);
  });
});

describe('whether rendering is paused', () => {
  it('pauses while an overlay is open', () => {
    expect(shouldPauseRender(true, false)).toBe(true);
  });

  it('does not latch: closing the overlay resumes a model that was running', () => {
    expect(shouldPauseRender(false, false)).toBe(false);
  });

  it('does not resume a model the learner had already paused', () => {
    // The failure mode of a latching implementation: the overlay closes and quietly starts a model
    // the learner stopped.
    expect(shouldPauseRender(false, true)).toBe(true);
    expect(shouldPauseRender(true, true)).toBe(true);
  });
});