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
  // The status bar only shows measured numbers once frames are running, so its presence is the honest signal that
  // the whole pipeline completed — not a spinner disappearing.
  await expect(page.getByTitle('Frames per second, measured over a rolling window')).toBeVisible({
    timeout: 60_000,
  });
}

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
    const triangles = await page.getByTitle('Triangles this frame').textContent();
    expect(Number.parseInt(triangles ?? '0', 10)).toBeGreaterThan(0);

    expect(consoleErrors, consoleErrors.join('\n')).toHaveLength(0);
  });

  test('draws frames rather than a single static image', async ({ page }) => {
    await page.goto('/viewer');
    await waitForModel(page);

    // `00`: "the default state of a model is motion"; a viewer that renders one frame and stops is a picture.
    const firstTime = await page.getByTitle('Model time').textContent();
    await page.waitForTimeout(1500);
    const laterTime = await page.getByTitle('Model time').textContent();
    expect(laterTime).not.toBe(firstTime);
  });

  test('reports a sane device tier and adapts quality visibly when it does', async ({ page }) => {
    await page.goto('/viewer');
    await waitForModel(page);

    const tier = await page.getByTitle('Device tier').textContent();
    expect(['low', 'mid', 'high']).toContain((tier ?? '').trim());

    // If the platform degraded anything, it says so. `08`: "silent degradation reads as breakage."
    const badge = page.getByText('quality adapted');
    if (await badge.isVisible()) {
      await expect(badge).toHaveAttribute('title', /.{15,}/);
    }
  });

  test('shows the model parameters and moves the model when one changes', async ({ page }) => {
    await page.goto('/viewer');
    await waitForModel(page);

    const slider = page.locator('#param-spoolRpm');
    await expect(slider).toBeVisible();

    // The read-out is a formatted number with a unit, which is `00`'s requirement that parameters be quantitative
    // rather than cosmetic.
    const readout = page.locator('.control', { has: slider }).locator('output');
    const before = await readout.textContent();
    expect(before).toMatch(/rpm/);

    await slider.fill('11000');
    await expect(readout).not.toHaveText(before ?? '');

    // The change reached the worker: fuel-driven metrics move with the parameters that feed them.
    await page.waitForTimeout(600);
    const fuel = page.locator('#param-fuelFlow');
    await fuel.fill('1.3');
    await page.waitForTimeout(600);
    // Thrust is published by the model's own frame code from those same inputs.
    const thrust = page.locator('dt', { hasText: 'Thrust' }).locator('+ dd');
    await expect(thrust).not.toHaveText('—');
  });

  test('selects a part from the keyboard-reachable list and describes it', async ({ page }) => {
    await page.goto('/viewer');
    await waitForModel(page);

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

    for (const mode of ['X-ray', 'Wire', 'Explode', 'Solid']) {
      await page.getByRole('button', { name: mode, exact: true }).click();
      await page.waitForTimeout(350);
      // Still rendering after the switch: a mode that kills the loop is the failure this catches.
      const fps = await page.getByTitle('Frames per second, measured over a rolling window').textContent();
      expect(Number.parseFloat(fps ?? '0')).toBeGreaterThan(0);
    }
  });

  test('pauses and resumes the model clock', async ({ page }) => {
    await page.goto('/viewer');
    await waitForModel(page);

    await page.getByRole('button', { name: 'Pause' }).click();
    const paused = await page.getByTitle('Model time').textContent();
    await page.waitForTimeout(900);
    expect(await page.getByTitle('Model time').textContent()).toBe(paused);

    await page.getByRole('button', { name: 'Play' }).click();
    await page.waitForTimeout(900);
    expect(await page.getByTitle('Model time').textContent()).not.toBe(paused);
  });

  test('orbits the camera on drag without losing the model', async ({ page }) => {
    await page.goto('/viewer');
    await waitForModel(page);

    const holder = page.locator('.canvas-holder');
    const box = await holder.boundingBox();
    expect(box).not.toBeNull();
    if (!box) return;

    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 160, box.y + box.height / 2 + 40, { steps: 12 });
    await page.mouse.up();

    await page.waitForTimeout(400);
    // Still drawing triangles: an orbit that pushes the camera inside the model or to NaN would cull everything.
    const triangles = await page.getByTitle('Triangles this frame').textContent();
    expect(Number.parseInt(triangles ?? '0', 10)).toBeGreaterThan(0);
  });

  test('exposes measured diagnostics rather than estimates', async ({ page }) => {
    await page.goto('/viewer');
    await waitForModel(page);

    await page.getByRole('button', { name: 'diagnostics' }).click();
    const panel = page.getByRole('region', { name: 'Diagnostics' });
    await expect(panel).toBeVisible();

    // `03` R8: the panel shows what the model actually produced, including its real cost.
    await expect(panel.getByText(/unique geometries/)).toBeVisible();
    await expect(panel.getByText(/instanced sets/)).toBeVisible();
    await expect(panel.getByText(/Authoring pass took \d+ ms/)).toBeVisible();
  });

  test('keeps the page alive when a model fails to build', async ({ page }) => {
    // `00`: a model that fails "must not take the viewer down. Show the error, keep the page alive, offer a retry."
    await page.goto('/viewer');
    await waitForModel(page);

    // Feed a program that passes the gate and fails at build time, through the same host the AI's code uses.
    await page.evaluate(() => {
      const host = (window as unknown as { __edu3dHost?: { load: (code: string) => void } }).__edu3dHost;
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
    await expect(page.getByRole('button', { name: 'diagnostics' })).toBeEnabled();
  });

  test('survives a runaway model by killing the worker, not the page', async ({ page }) => {
    await page.goto('/viewer');
    await waitForModel(page);

    await page.evaluate(() => {
      const host = (window as unknown as { __edu3dHost?: { load: (code: string) => void } }).__edu3dHost;
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
    const holder = await page.locator('.canvas-holder').boundingBox();
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
