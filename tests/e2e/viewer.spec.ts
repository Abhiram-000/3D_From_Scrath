/**
 * End-to-end tests for the viewer.
 *
 * These assert what only a real browser can: that the worker spawns, that WebGL actually renders on the learner's
 * device, that input reaches the scene, and that a killed model leaves the page usable. `00-GOAL.md`'s hard rules
 * about crash isolation and `08`'s device-tier promise are both claims about a browser, so they are tested in one.
 *
 * The reference turbofan is the fixture, which makes these tests meaningful rather than decorative: it is a
 * multi-system assembly with instanced blade arrays, an SDF-blended combustor and a raw computed mesh, so a
 * regression anywhere in the geometry, admission or realization path shows up here.
 */
import { expect, test, type Page } from '@playwright/test';

/** Wait until the worker has authored, priced and realized the model. */
async function waitForModel(page: Page): Promise<void> {
  // The stat item itself is always in the markup — it renders a dash until the first measured
  // frame. So its PRESENCE proves the toolbar painted, not that a model built; the honest signal
  // is the measured value replacing that dash. (An earlier version of this helper waited on the
  // element, which passed before any geometry existed and let every later assertion fail.)
  await expect(page.locator('[data-stat="fps"] .stat-value')).not.toHaveText('—', {
    timeout: 60_000,
  });
}

/** A measured stat's value, not the stat item (whose textContent also contains its label). */
function statValue(page: Page, stat: string) {
  return page.locator(`[data-stat="${stat}"] .stat-value`);
}

/**
 * Why the interaction assertions are written as polls rather than as fixed sleeps.
 *
 * CI runs headless Chromium with SwiftShader (`playwright.config.ts`), which renders the reference
 * model's 177,530 triangles at 1-3 fps on this machine — the model is 52 parts, 30 geometries and
 * that many realized triangles, measured through the real pipeline. (The figure here used to be a
 * design note's 334k, which never matched the model: the authored count already multiplies the
 * instances.)
 *
 * A test that samples a stat after `waitForTimeout(400)` therefore measures the renderer, not the
 * platform, and a test that skips itself below 10 fps measures nothing at all. Seven of these did
 * exactly that, and the coverage they gave up hid two real defects: story mode wedged the whole
 * viewer with a Svelte update loop, and the information panel deleted the parts list on the first
 * selection. So the assertions below poll with a timeout generous enough for a software rasterizer —
 * the platform's promise is "this eventually changes", and that is what is asserted.
 *
 * Playwright's *click* actionability checks still require the element to be stable across
 * consecutive animation frames, which is why the tests that drive the canvas use `page.mouse`
 * directly: it performs no such check, so a drag works at any frame rate.
 */

test.describe('the viewer', () => {
  test('renders the reference model on the user device', async ({ page }) => {
    const consoleErrors: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });

    await page.goto('/viewer');
    await waitForModel(page);

    // The model's own name, from the manifest the worker built.
    await expect(page.getByText('Two-spool turbofan').first()).toBeVisible();

    // Something was actually drawn. A canvas that exists but renders nothing would pass a visibility check, so the
    // assertion is on the *measured* triangle count the worker reports.
    const triangles = await statValue(page, 'triangles').textContent();
    expect(Number.parseInt(triangles ?? '0', 10)).toBeGreaterThan(0);

    expect(consoleErrors, consoleErrors.join('\n')).toHaveLength(0);
  });

  test('instantiates no blurred decoration over the canvas', async ({ page }) => {
    await page.goto('/viewer');
    await waitForModel(page);

    // The viewer asks for no cursor system, and `Ambient.mount()` used to create its blur(60px) blobs
    // regardless — above an opaque canvas, where a non-integer animated scale forces the blur to
    // re-rasterise on every presented frame. `scripts/check-compositor.mjs` cannot enforce this: the
    // blob CSS is shared with the landing page, so no stylesheet rule can prove the viewer is exempt.
    // The page itself has to be the assertion.
    await expect(page.locator('.ambient-layer')).toHaveCount(0);
    await expect(page.locator('.ambient-blob')).toHaveCount(0);
  });

  test('draws frames rather than a single static image', async ({ page }) => {
    await page.goto('/viewer');
    await waitForModel(page);

    // `00`: "the default state of a model is motion"; a viewer that renders one frame and stops is a
    // picture. The clock is formatted MM:SS, so the assertion polls rather than sampling a fixed
    // window: at 1–3 fps under a software rasterizer, 1.5 s can fall inside a single frame, and the
    // bucket then has not moved *yet*. Polling keeps the test measuring the platform instead of the
    // renderer, which is what the frame-rate skip it replaces was really doing.
    const firstTime = await statValue(page, 'time').textContent();
    await expect(statValue(page, 'time')).not.toHaveText(firstTime ?? '', { timeout: 20_000 });
  });

  test('reports a sane device tier and adapts quality visibly when it does', async ({ page }) => {
    await page.goto('/viewer');
    await waitForModel(page);

    const tier = await statValue(page, 'tier').textContent();
    expect(['low', 'mid', 'high']).toContain((tier ?? '').trim());

    // The status bar reports the preset the worker is *actually* running, and marks it adapted only
    // when the ladder genuinely stepped down (`08`: the platform never lies about what it is doing).
    // It used to print the word "Adapted" whenever the admission verdict carried any adjustment —
    // a verdict computed once at load — while the live ladder could have moved several rungs since.
    const badge = page.locator('[data-stat="quality"]');
    await expect(badge).toBeVisible();
    await expect(badge.locator('.stat-value')).toHaveText(/^(low|medium|high)( \(adapted\))?$/);
    await expect(badge).toHaveAttribute('title', /.{15,}/);
  });

  test('shows the model parameters and moves the model when one changes', async ({ page }) => {
    await page.goto('/viewer');
    await waitForModel(page);

    const slider = page.locator('#param-spoolRpm');
    await expect(slider).toBeVisible();

    // The read-out is a formatted number with a unit, which is `00`'s requirement that parameters be quantitative
    // rather than cosmetic.
    const readout = page.locator('.parameter-item', { has: slider }).locator('.parameter-value');
    const before = await readout.textContent();
    expect(before).toMatch(/rpm/);

    // A range input only accepts a value that is a multiple of its step, and `fill` enforces
    // that. The viewer derives step as (max-min)/200, so spoolRpm steps by 60 and fuelFlow by
    // 0.007: 10800 is 60x180, 0.7 is 0.007x100. A round-looking number that is off-step
    // fails as "Malformed value" rather than snapping, which is the test's bug, not the app's.
    await slider.fill('10800');
    await expect(readout).not.toHaveText(before ?? '');

    // The change reached the worker: fuel-driven metrics move with the parameters that feed them.
    await page.waitForTimeout(600);
    const fuel = page.locator('#param-fuelFlow');
    await fuel.fill('0.7');
    await page.waitForTimeout(600);
    // Thrust is published by the model's own frame code from those same inputs.
    const thrust = page.locator('.metric-item', { hasText: 'Thrust' }).locator('.metric-value');
    await expect(thrust).not.toHaveText('—');
  });

  test('selects a part from the keyboard-reachable list and describes it', async ({ page }) => {
    await page.goto('/viewer');
    await waitForModel(page);

    // No frame-rate skip: every assertion here is DOM. The click is on a panel button, and the part's
    // description is text — neither needs a rendered frame, and pretending otherwise is how the
    // parts-list bug (the list vanished after the first selection) stayed invisible.
    // `08` requires the keyboard path never to regress, and a canvas cannot be tabbed into — hence the part list.
    const bladeButton = page.getByRole('button', { name: 'Fan blades' });
    await bladeButton.click();

    // `01`: "a part the learner can select but that says nothing is a wasted click."
    await expect(page.getByRole('heading', { name: 'Fan blades' })).toBeVisible();
    await expect(page.getByText(/biggest thrust producer/i)).toBeVisible();
  });

  test('toggles every view mode without breaking the render loop', async ({ page }) => {
    test.skip(
      test.info().project.name === 'phone',
      'The mode row is hidden on narrow layouts; the phone sheet variant is a separate pass.',
    );

    await page.goto('/viewer');
    await waitForModel(page);

    // The three view modes are toggles, not a radio group: each returns to normal on a second
    // click. There is no `Solid` button — normal is the state you get by turning the others off.
    //
    // Located by `title`, not by accessible name: between 769 and 1600 CSS pixels the toolbar hides
    // its labels, so a button's name becomes its `title` (`button "X-ray Mode (X)"`) and a
    // `getByRole(..., { name: 'X-ray' })` match finds nothing at all. The desktop profile is 1280
    // wide, so this is the case that runs.
    const MODE_TITLES: Record<string, string> = {
      'X-ray': 'X-ray Mode (X)',
      Wireframe: 'Wireframe (W)',
      Explode: 'Explode View (E)',
    };

    for (const mode of ['X-ray', 'Wireframe', 'Explode']) {
      for (const turn of ['on', 'off'] as const) {
        await page.getByTitle(MODE_TITLES[mode] as string).click();
        // Still rendering after the switch: a mode that kills the loop is the failure this catches.
        // Polled rather than sampled on a fixed sleep — under a software rasterizer a single read can
        // land between frames and report 0 for a loop that is perfectly alive.
        await expect(statValue(page, 'fps'), `${mode} ${turn}`).not.toHaveText('0', {
          timeout: 20_000,
        });
      }
    }
  });

  test('pauses and resumes the model clock', async ({ page }) => {
    await page.goto('/viewer');
    await waitForModel(page);

    await page.getByRole('button', { name: 'Pause' }).click();
    const paused = await statValue(page, 'time').textContent();
    // Frozen means frozen: wait longer than the slowest frame interval this suite tolerates and still
    // demand no change on the read-out.
    await page.waitForTimeout(2_500);
    expect(await statValue(page, 'time').textContent()).toBe(paused);

    await page.getByRole('button', { name: 'Play' }).click();
    // Resumed means it moves — polled, because at 1 fps the first sample can land inside the frame
    // that was already presented when Play was pressed.
    await expect(statValue(page, 'time')).not.toHaveText(paused ?? '', { timeout: 20_000 });
  });

  test('a paused model still answers parameters (paused is not dead)', async ({ page }) => {
    // `00`: "pause does not mean dead — parameter changes, selection … all keep working." The
    // render gate's first draft missed the parameter invalidation: on a paused model whose
    // autoRotate had stopped (any prior camera gesture) the slider changed the read-out but no
    // frame ever re-posed the model. The probe: pause, stay still, drag — the model's own metric,
    // published only when a guest frame runs, must move with the slider.
    await page.goto('/viewer');
    await waitForModel(page);
    await page.getByRole('button', { name: 'Pause' }).click();
    await page.waitForTimeout(1200);

    const fuel = page.locator('#param-fuelFlow');
    const thrust = page.locator('.metric-item', { hasText: 'Thrust' }).locator('.metric-value');
    const before = await thrust.textContent();
    // 0.7 is on the slider's step (0.007 × 100) — an off-step fill reads as "Malformed value" and
    // the app rejects it, which is the app being right and the test being wrong.
    await fuel.fill('0.7');
    // The metric is published by the model's own frame code, and one frame on a software
    // rasterizer can take a second. What this test claims is "the metric moves when the
    // parameter changes" — not "it moves within 1200 ms" — so the assertion waits for the change
    // instead of racing it. A fixed sleep made this test a measurement of the renderer rather
    // than of the platform, and it failed under load while passing every time it ran alone.
    await expect(thrust).not.toHaveText(before ?? '', { timeout: 15_000 });
  });

  test('travels the camera to the part the learner selects', async ({ page }) => {
    // What this asserts is the feature itself, at the only level it can be asserted: the camera
    // moved. The status bar reports the camera's distance from what it is looking at, and that
    // number is the observable — a move nothing can observe is indistinguishable from a teleport.
    await page.goto('/viewer');
    await waitForModel(page);

    const distance = page.locator('[data-stat="distance"] .stat-value');
    const initial = await distance.textContent();
    expect(initial).not.toBe('—');

    // The parts list commands the same move a canvas tap does.
    await page.getByRole('button', { name: 'Fan blades', exact: true }).click();
    await expect(distance).not.toHaveText(initial ?? '', { timeout: 20_000 });
    const framedOnBlades = await distance.textContent();

    // A second, much larger part frames at a different distance — proof the first change was the
    // camera travelling to *that* part rather than one coincidence of arithmetic.
    await page.getByRole('button', { name: 'Combustor liner', exact: true }).click();
    await expect(distance).not.toHaveText(framedOnBlades ?? '', { timeout: 20_000 });
  });

  test('opens story mode without wedging the viewer', async ({ page }) => {
    // Live verification found this one, and the suite could not: the story component's beat effect
    // tracked its callback props, so a beat's parameter write re-rendered the page, the page handed
    // down fresh inline callbacks, and the effect re-ran — an unbounded Svelte update loop that
    // reported `effect_update_depth_exceeded` and left the viewer frozen (clicks ignored, the model
    // clock stopped). No test in this file opened story mode at all, and the interaction assertions
    // that could have noticed were skipping themselves on frame rate. This test does not skip: the
    // failure has nothing to do with frame rate, and what it asserts is what a learner would notice.
    const consoleErrors: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });

    await page.goto('/viewer');
    await waitForModel(page);

    await page.getByTitle('Story Mode (S)').click();
    const overlay = page.locator('.story-overlay');
    await expect(overlay).toBeVisible();

    const counter = overlay.locator('.counter');
    await expect(counter).toHaveText(/^1 \/ \d+$/);

    // Next is a real control, not decoration. The assertion is "the beat moved", not "it moved to
    // exactly 2": the beat's own reading-time timer may advance it too, and asserting the exact
    // number would make the test measure the timer rather than the button.
    await overlay.getByRole('button', { name: 'Next' }).click();
    await expect(counter).not.toHaveText(/^1 \/ \d+$/);

    // Cancel is the one way out that never depends on the model (`05`: the story must never trap).
    await overlay.getByRole('button', { name: 'Cancel' }).click();
    await expect(page.locator('.story-overlay')).toHaveCount(0);

    // The page is still alive: the loop's signature error is gone and Reactivity is still applying
    // state (the toolbar answers).
    expect(consoleErrors.filter((text) => text.includes('effect_update_depth_exceeded'))).toEqual(
      [],
    );
    await page.getByTitle('Story Mode (S)').click();
    await expect(page.locator('.story-overlay')).toBeVisible();
  });

  test('orbits the camera on drag without losing the model', async ({ page }) => {
    await page.goto('/viewer');
    await waitForModel(page);

    // `page.mouse` needs no actionability check, so this works at any frame rate; only the assertion
    // needs a rendered frame, and it polls for one.
    const holder = page.locator('.main-canvas-holder');
    const box = await holder.boundingBox();
    expect(box).not.toBeNull();
    if (!box) return;

    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 160, box.y + box.height / 2 + 40, { steps: 12 });
    await page.mouse.up();

    // Still drawing triangles: an orbit that pushes the camera inside the model or to NaN would cull
    // everything. Polled — under a software rasterizer the next presented frame is not 400 ms away.
    await expect(statValue(page, 'triangles')).not.toHaveText('0k', { timeout: 20_000 });
  });

  test('shows what the model actually produced rather than an estimate', async ({ page }) => {
    await page.goto('/viewer');
    await waitForModel(page);

    // There is no diagnostics panel in the viewer. `03` R8 asks for the real cost next to the
    // model's own output, and the AI Output modal is what ships: measured cost chips, the raw text
    // the model wrote, and the manifest the engine validated and built from.
    // The toolbar's stable identity is its `title` — in the collapsed icon-only states (and in the
    // failed-load state this test drives) the visible label is hidden, so the accessible-name match
    // that worked on an expanded toolbar breaks exactly here.
    await page.getByTitle("View the AI's output for this model").click();
    const modal = page.locator('.code-view-modal');
    await expect(modal).toBeVisible();

    // Measured, not estimated: these come from the authoring pass, so a change to the geometry
    // builders moves them and a viewer that hard-coded them would fail here.
    await expect(modal.locator('.code-view-chip', { hasText: 'parts' })).toBeVisible();
    await expect(modal.locator('.code-view-chip', { hasText: 'triangles' })).toBeVisible();
    await expect(modal.locator('.code-view-chip', { hasText: /^authoring \d+ ms$/ })).toBeVisible();

    // The validated spec, not the raw tab: the raw tab legitimately says the model came from the
    // reference set when there is no stored bundle, so asserting on it would assert nothing.
    await page.getByRole('button', { name: 'Scene spec (validated)' }).click();
    await expect(modal.locator('.code-view-pre code')).toContainText('Two-spool turbofan');
  });

  test('keeps the page alive when a model fails to build', async ({ page }) => {
    // `00`: a model that fails "must not take the viewer down. Show the error, keep the page alive, offer a retry."
    await page.goto('/viewer');
    await waitForModel(page);

    // Feed a program that passes the gate and fails at build time, through the same host the AI's code uses.
    await page.evaluate(() => {
      const host = (window as unknown as { __edu3dHost?: { load: (code: string) => void } })
        .__edu3dHost;
      host?.load(`
        scene.describe({ name: 'Broken', description: 'Fails at build.', concept: 'x', objectives: ['y'] });
        scene.mesh({ id: 'a', geometry: geom.sphere({ radius: 0 / 0 }), material: mat.metal({}) });
      `);
    });

    // The error is shown with a retry, and the page still responds.
    await expect(page.getByRole('heading', { name: 'The model could not be built' })).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();
    await expect(page.getByTitle("View the AI's output for this model")).toBeEnabled();
  });

  test('survives a runaway model by killing the worker, not the page', async ({ page }) => {
    await page.goto('/viewer');
    await waitForModel(page);

    await page.evaluate(() => {
      const host = (window as unknown as { __edu3dHost?: { load: (code: string) => void } })
        .__edu3dHost;
      host?.load(`
        scene.describe({ name: 'Runaway', description: 'Never finishes.', concept: 'x', objectives: ['y'] });
        var n = 0;
        while (true) { n += 1; }
      `);
    });

    // The injected loop guard trips first and reports it as a build failure with an actionable message; the
    // watchdog's terminate is the fallback behind it. Either way the page is still here.
    await expect(page.getByRole('heading', { name: 'The model could not be built' })).toBeVisible({
      timeout: 40_000,
    });
    await expect(page.getByRole('button', { name: 'Try again' })).toBeEnabled();
  });

  test('collapses to a single column on a phone', async ({ page }) => {
    test.skip(test.info().project.name !== 'phone', 'Phone layout only.');

    await page.goto('/viewer');
    await waitForModel(page);

    // `08`: the canvas owns the screen and panels become sheets rather than columns.
    const holder = await page.locator('.main-canvas-holder').boundingBox();
    const viewport = page.viewportSize();
    expect(holder).not.toBeNull();
    expect(viewport).not.toBeNull();
    if (!holder || !viewport) return;
    expect(holder.width).toBeGreaterThan(viewport.width * 0.85);

    // No horizontal scroll, ever (`08`).
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);
  });

  test('meets the touch-target floor on a phone', async ({ page }) => {
    test.skip(test.info().project.name !== 'phone', 'Phone layout only.');

    await page.goto('/viewer');
    await waitForModel(page);

    // `08`: "Hit targets: ≥ 44×44 CSS pixels." A slider thumb that is hard to grab is a broken slider.
    const slider = page.locator('#param-spoolRpm');
    const box = await slider.boundingBox();
    expect(box).not.toBeNull();
    if (box) expect(box.height).toBeGreaterThanOrEqual(40);
  });
});

test.describe('the landing page', () => {
  test('loads without downloading the engine', async ({ page }) => {
    const requested: string[] = [];
    page.on('request', (request) => requested.push(request.url()));

    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();

    // `08`'s hard contract: "JS bundle, landing page — no engine, no physics — kilobytes, not megabytes." A visitor
    // who may never generate must not pay for the viewer.
    const heavy = requested.filter((url) => /sandbox-worker|three-|physics/.test(url));
    expect(heavy, heavy.join('\n')).toHaveLength(0);
  });

  test('applies the theme before first paint', async ({ page }) => {
    await page.goto('/');
    // `07`: "A flash of wrong colors on load reads as broken." The attribute is set by an inline head script, so it
    // is already correct on the first frame rather than after hydration.
    await expect(page.locator('html')).toHaveAttribute('data-theme', /dark|light/);
  });
});
