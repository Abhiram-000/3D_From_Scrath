/**
 * Pointer coordinates for the engine.
 *
 * The viewer used to call `getBoundingClientRect()` on every `pointermove`, before it knew whether
 * this was a hover or a drag. At up to 120Hz that is a layout query per event on a document that is
 * frequently dirty — stats and metrics at 1Hz, hover on every target change — so each read can force
 * a synchronous style and layout flush. The rect cannot change during a gesture (the canvas is
 * `position: absolute; inset: 0` and the pointer is captured), and the `ResizeObserver` already fires
 * on exactly the events that can change it, so caching it there is both correct and free.
 *
 * Kept as a pure function so the coordinate arithmetic can be pinned without a DOM.
 */

/** The minimum a cached rect has to provide. */
export interface RectLike {
  left: number;
  top: number;
}

/** Client coordinates, expressed relative to the canvas's top-left corner. */
export function toCanvasPoint(
  clientX: number,
  clientY: number,
  rect: RectLike,
): { x: number; y: number } {
  return { x: clientX - rect.left, y: clientY - rect.top };
}

/**
 * Whether a pointer sample should be sent now or held until the next frame.
 *
 * `down` and `up` always go immediately: a click has to land on the pose the learner actually saw,
 * and deferring it by a frame is perceptible. `move` coalesces, because the worker already collapses
 * hover raycasts to one per frame and every extra message is a structured clone plus a task that
 * competes with the render loop for the worker's event loop.
 */
export function shouldSendPointerNow(kind: 'move' | 'down' | 'up'): boolean {
  return kind !== 'move';
}
