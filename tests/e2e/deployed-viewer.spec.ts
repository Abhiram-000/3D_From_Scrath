/**
 * The deployed configuration — the one that actually ships.
 *
 * Every other spec in this directory is served by `vite preview`, which sets **no**
 * Content-Security-Policy. That is not a detail: the viewer compiles the AI's program with
 * `new Function`, the production policy governs the sandbox worker's response, and a policy without
 * `'unsafe-eval'` makes `compileGuest` throw `EvalError` before a single triangle renders. The whole
 * suite was green — and had to be green — while production could not build one model. These two
 * specs close that hole by asserting against the API process serving the built site on one origin,
 * policy enforced.
 *
 * Both are cheap and need no AI key: they exercise the reference model, not generation.
 */
import { expect, test } from '@playwright/test';
import { readdirSync } from 'node:fs';
import path from 'node:path';

/** The deployed origin, started by the second entry in `playwright.config.ts`'s webServer array. */
const DEPLOYED = 'http://127.0.0.1:4174';

/** The one built worker chunk. Reading it from disk keeps this independent of the page's requests. */
function workerChunk(): string {
  const dir = path.resolve('apps/web/build/_app/immutable/workers');
  const file = readdirSync(dir).find((f) => f.endsWith('.js'));
  if (!file) throw new Error(`no built worker chunk in ${dir} — run \`pnpm build\` first`);
  return `/_app/immutable/workers/${file}`;
}

test.describe('the deployed configuration', () => {
  test('serves the sandbox worker with the compiler allowance it requires', async ({ request }) => {
    // This is the assertion that would have caught the production blocker without a browser: the
    // worker's own response must carry `'unsafe-eval'`, because that response's policy is what
    // governs the worker's realm, and `compileGuest` cannot run without it.
    const response = await request.get(`${DEPLOYED}${workerChunk()}`);
    expect(response.status()).toBe(200);
    const policy = response.headers()['content-security-policy'] ?? '';
    expect(policy, 'the worker chunk must be served with an enforcing policy').toBeTruthy();
    expect(policy, 'the sandbox compiler needs unsafe-eval in the worker realm').toContain(
      "'unsafe-eval'",
    );
  });

  test('keeps the document policy strict, so the allowance reaches only the worker', async ({
    request,
  }) => {
    // The counterpart: widening the document to fix the worker would be the lazy fix and would trade
    // the page's XSS defence away for nothing. The page chrome never compiles string JS.
    const response = await request.get(`${DEPLOYED}/viewer`);
    expect(response.status()).toBe(200);
    const policy = response.headers()['content-security-policy'] ?? '';
    expect(policy).toBeTruthy();
    expect(policy, 'the document surface must not carry the worker’s allowance').not.toContain(
      "'unsafe-eval'",
    );
  });

  test('builds and renders the reference model under the enforced policy', async ({ page }) => {
    // The end-to-end claim, and the one a CSP regression breaks first: a model reaches the screen.
    // Triangles rather than a canvas, because a canvas that exists and draws nothing would pass a
    // visibility check.
    const evalErrors: string[] = [];
    page.on('pageerror', (error) => evalErrors.push(error.message));

    await page.goto(`${DEPLOYED}/viewer`);

    await expect(page.locator('[data-stat="triangles"] .stat-value')).not.toHaveText('—', {
      timeout: 90_000,
    });
    const triangles = Number.parseInt(
      (await page.locator('[data-stat="triangles"] .stat-value').textContent()) ?? '0',
      10,
    );
    expect(triangles, 'the reference model must render real geometry').toBeGreaterThan(0);

    // And it must not be a refusal dressed up as a render. This is the exact failure mode.
    const evalRefusals = evalErrors.filter((m) => /EvalError|Content Security Policy/i.test(m));
    expect(evalRefusals, evalRefusals.join('\n')).toHaveLength(0);
  });
});
