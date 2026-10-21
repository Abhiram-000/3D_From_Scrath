/**
 * The background-tab demo-killer, in a real browser.
 *
 * The audit's failure: a healthy model executed for the crime of being in a background tab. This
 * spec reproduces the probe's exact sequence — model built and measured, `document.hidden`
 * flipped to true through the same surface the browser would use (`visibilitychange` fires), a
 * hidden period, the return — and then holds the line: the kill sentence must be absent for the
 * **entire** post-return watch window (>= the 30 s pre-frame cap), polled every 500 ms rather than
 * sampled once, with the renderer still publishing measured fps at the end.
 *
 * The guard's window is deliberately longer than the failure it guards: the original version of
 * this spec watched 5 s after return while the kill it was written for landed at ~7 s, and passed
 * straight through a live reproduction. A guard that cannot fail on its bug is not a guard.
 *
 * No generation: the reference model is the fixture, like the rest of the viewer suite.
 */
import { expect, test, type Page } from '@playwright/test';

/** Wait until the worker has authored, priced and realized the model (same signal as viewer.spec). */
async function waitForModel(page: Page): Promise<void> {
  await expect(page.locator('[data-stat="fps"] .stat-value')).not.toHaveText('—', {
    timeout: 60_000,
  });
}

/** Milliseconds since the navigation started — the timeline's shared clock. */
async function elapsed(page: Page): Promise<string> {
  return await page.evaluate(() => String(Math.round(performance.now())));
}

test('returning to a hidden tab does not kill the model', async ({ page }) => {
  test.setTimeout(240_000);

  // Full console capture: the kill's mechanism must be attributable from the timeline, not guessed.
  const timeline: string[] = [];
  page.on('console', (message) => {
    timeline.push(`[console] ${message.text()}`);
  });

  const t0 = Date.now();
  const stamp = async (label: string): Promise<string> => {
    const at = await elapsed(page);
    const wall = ((Date.now() - t0) / 1000).toFixed(1);
    timeline.push(`t=${at}ms (wall ${wall}s) ${label}`);
    return at;
  };

  await page.goto('/viewer');
  await waitForModel(page);
  await stamp('model built and measured');

  // Declare the tab hidden — the same surface the browser toggles.
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { value: true, configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await stamp('declared hidden');

  // Hold the hidden state long enough for several watchdog ticks.
  await page.waitForTimeout(6_000);

  // Return.
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { value: false, configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await stamp('declared visible again');

  const visibleAt = await elapsed(page);
  const returnWall = (Date.now() - t0) / 1000;

  // The whole post-return watch window: >= the 30 s pre-frame cap, sampled every 500 ms — the
  // window must be LONGER than the bug's latency, or the guard is decoration.
  const watch = 32_000;
  let lastFps = '';
  for (let waited = 0; waited < watch; waited += 500) {
    await page.waitForTimeout(500);

    const killVisible = await page
      .getByText('This model stopped responding')
      .count()
      .catch(() => 1);
    if (killVisible > 0) {
      await stamp('*** KILLED ***');
      break;
    }
    // Track that the renderer is still publishing measured values (not the em-dash of a dead engine).
    lastFps = (await page.locator('[data-stat="fps"] .stat-value').textContent()) ?? '';
    if (waited % 5_000 === 0) await stamp(`alive; fps text="${lastFps}"`);
  }

  const killCount = await page.getByText('This model stopped responding').count();
  // Always emit the captured timeline: the mechanism must be attributable from the run itself.
  console.log(`\n===== background-tab timeline (returned at wall ${returnWall.toFixed(1)}s) =====`);
  for (const line of timeline) console.log(line);
  console.log('===== end timeline =====\n');

  expect(killCount, 'the watchdog killed the model after the tab returned').toBe(0);
  expect(lastFps.trim(), 'the renderer stopped publishing a measured fps').not.toBe('—');
  expect(
    lastFps.trim(),
    `no measured fps published (returned at wall ${returnWall.toFixed(1)}s; visibleAt=${visibleAt})`,
  ).not.toBe('');
});
