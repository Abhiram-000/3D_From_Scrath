/**
 * Whether the engine should be paused.
 *
 * A modal is open over a live WebGL canvas. `viewer.css` claimed the render
 * loop stops while one is open — it did not, and no handler paused it — so the worker kept
 * presenting frames behind an overlay that the compositor was simultaneously re-filtering. That is
 * the freeze the stylesheet's own comment was written about.
 *
 * It is a pure function because the interesting part is that it must NOT latch. Reading the current
 * pause state on every call is what makes a model that was already paused stay paused when the modal
 * closes, and what stops a pause set for one modal from leaking into the next model.
 */

/** True when any overlay is open. */
export function anyOverlayOpen(state: {
  quizModalOpen: boolean;
  shortcutsModalOpen: boolean;
  shareModalOpen: boolean;
  galleryOpen: boolean;
  generateOpen: boolean;
  codeViewModalOpen: boolean;
  viewPresetsOpen: boolean;
  /**
   * Settings joined the set late, and optional so the existing callers and tests keep compiling:
   * a missing flag reads as "no settings dialog", which is the only meaning it can have.
   *
   * Story mode is deliberately NOT here. Its beats move the camera from inside the worker's frame
   * loop, so pausing the engine while the story teller is talking would freeze the very choreography
   * the mode exists to show.
   */
  settingsOpen?: boolean;
}): boolean {
  return (
    state.quizModalOpen ||
    state.shortcutsModalOpen ||
    state.shareModalOpen ||
    state.galleryOpen ||
    state.generateOpen ||
    state.codeViewModalOpen ||
    state.viewPresetsOpen ||
    Boolean(state.settingsOpen)
  );
}

/**
 * Whether the engine should be paused right now.
 *
 * Reads `paused` rather than latching it, which is the whole contract: a model already paused stays
 * paused when its modal closes, and one paused by a modal resumes when it does.
 */
export function shouldPauseRender(overlayOpen: boolean, paused: boolean): boolean {
  return overlayOpen || paused;
}
