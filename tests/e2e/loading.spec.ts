/**
 * End-to-end tests for the loading page.
 *
 * The claim under test is the one the platform makes to a learner who is waiting: the progress
 * bar and the stage chips say what is *actually happening*.
 *
 * The bug these exist for: the bar moved and the chips did not. The page copied the bar and the
 * status line into its own reactive state, but read the stage chips straight from a class
 * instance — and Svelte does not proxy class instances, so those reads never invalidated. The
 * chips sat on "Thinking" for the whole run while the bar climbed to 100%.
 *
 * The generation stream is scripted here rather than generated for real: the protocol is the
 * thing under test, so the events are the real ones, in the real order, with the real shapes. The
 * server's own sentences are sent, and the page is required to show them.
 */
import { expect, test } from '@playwright/test';

/** The events a real generation emits, in the order the pipeline emits them. */
const SCRIPTED_RUN = [
  { type: 'phase', phase: 'queued', message: 'Sending your topic to the model…', at: 0 },
  { type: 'phase', phase: 'prompt', message: 'Loading the generation contract…', at: 1 },
  { type: 'phase', phase: 'model', message: 'The model is designing your 3D scene…', at: 2 },
  {
    type: 'phase',
    phase: 'extract',
    message: 'Reading the program the model wrote and checking it against the rules…',
    at: 3,
  },
  {
    type: 'phase',
    phase: 'build',
    message: 'Building the model and checking what it teaches…',
    at: 4,
  },
  { type: 'phase', phase: 'ready', message: 'Your 3D model is ready!', at: 5 },
  // The terminal event: the stream must end with exactly one, or the client calls it a failure.
  { type: 'ready', bundle: { code: '', manifest: { parts: [] }, raw: {} }, at: 6 },
] as const;

test.describe('the loading page', () => {
  test('advances the stage chips as the server announces phases', async ({ page }) => {
    await page.addInitScript(() => {
      sessionStorage.setItem('edu3d.topic', 'a working steam turbine');
    });

    // The generation stream, scripted. The protocol is real; only the provider is not.
    await page.route('**/api/generate', async (route) => {
      const body = `${SCRIPTED_RUN.map((event) => JSON.stringify(event)).join('\n')}\n`;
      await route.fulfill({ status: 200, contentType: 'application/x-ndjson', body });
    });

    // The page navigates to the viewer when the model is ready. The navigation is left pending
    // on purpose: the page under test stays on screen, so the assertions are about the loading
    // page and not about a race with a redirect.
    await page.route('**/viewer', async () => {
      await new Promise(() => {});
    });

    await page.goto('/loading');

    // The chips advanced: the stage the server last announced is the active one, and every
    // stage before it is completed. Before the fix, all four chips stayed on the first one.
    const ready = page.locator('#stage-ready');
    await expect(ready).toHaveClass(/active/, { timeout: 15_000 });
    await expect(page.locator('#stage-thinking')).toHaveClass(/completed/);
    await expect(page.locator('#stage-generating')).toHaveClass(/completed/);
    await expect(page.locator('#stage-compiling')).toHaveClass(/completed/);
  });

  test('shows the sentence the server sent', async ({ page }) => {
    await page.addInitScript(() => {
      sessionStorage.setItem('edu3d.topic', 'a working steam turbine');
    });

    await page.route('**/api/generate', async (route) => {
      const body = `${SCRIPTED_RUN.map((event) => JSON.stringify(event)).join('\n')}\n`;
      await route.fulfill({ status: 200, contentType: 'application/x-ndjson', body });
    });
    await page.route('**/viewer', async () => {
      await new Promise(() => {});
    });

    await page.goto('/loading');

    // The wording is the server's, not a copy the client keeps: a copy is a claim about
    // somebody else's behaviour, and it drifts.
    await expect(page.locator('.status-message')).toHaveText('Your 3D model is ready!', {
      timeout: 15_000,
    });
  });

  test('moves the bar to the end of a finished run', async ({ page }) => {
    await page.addInitScript(() => {
      sessionStorage.setItem('edu3d.topic', 'a working steam turbine');
    });

    await page.route('**/api/generate', async (route) => {
      const body = `${SCRIPTED_RUN.map((event) => JSON.stringify(event)).join('\n')}\n`;
      await route.fulfill({ status: 200, contentType: 'application/x-ndjson', body });
    });
    await page.route('**/viewer', async () => {
      await new Promise(() => {});
    });

    await page.goto('/loading');

    const bar = page.locator('.progress-bar');
    await expect(bar).toHaveAttribute('aria-valuenow', '100', { timeout: 15_000 });
  });
});
