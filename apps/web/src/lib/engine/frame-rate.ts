/**
 * Frame rate measurement.
 *
 * The status bar's "FPS" must answer "how many times did this page present a picture per second".
 * It used to answer a different question — `1000 / meanFrameMillis` — which is how fast a frame
 * *could* complete, not how often one actually ran.
 *
 * Those two numbers agree only when the loop runs unthrottled and never stalls. When it stalls
 * they diverge without limit, and they diverge in the worst direction: a page that has presented
 * nothing for half a minute still reported 68, because the last frames it managed to run were fast.
 * The number therefore read healthiest exactly when the viewer was least alive.
 *
 * Measured on the reference model under a software rasterizer: reported 67.97 fps while the
 * render loop advanced 0 frames in 29 seconds of wall time.
 */

/** Upper bound on the reported rate, so a burst of catch-up frames cannot claim a nonsense number. */
export const MAX_REPORTED_FPS = 240;

/**
 * Frames presented per second between two samples.
 *
 * Returns 0 when no frames were presented — including when the window is degenerate — because a
 * frozen loop must never be reported as a healthy frame rate.
 */
export function computeFrameRate(
  frames: number,
  previousFrames: number,
  nowMs: number,
  previousNowMs: number,
): number {
  const windowMs = nowMs - previousNowMs;
  const presented = frames - previousFrames;
  if (windowMs <= 0 || presented <= 0) return 0;
  return Math.min(MAX_REPORTED_FPS, (presented * 1000) / windowMs);
}