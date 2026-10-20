/**
 * The theme key's two homes.
 *
 * The key is defined once, in `@edu3d/contracts`, and used by the app directly. The pre-paint
 * script in `app.html` cannot import it — a module request would land after paint, which is the
 * very thing that script exists to prevent — so it mirrors the value as a literal.
 *
 * That mirror was previously a *different* literal ('edu3d-theme' against the contract's
 * 'edu3d.theme'), which meant the learner's theme was written under one key and read under
 * another: every visit after the first flashed the theme they had chosen away. Nothing caught it,
 * because nothing was looking at the pair.
 *
 * This test looks at the pair. It reads the real `app.html`, because the risk is not in a value
 * the test can construct — it is in the file as it ships.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { THEME_STORAGE_KEY } from '@edu3d/contracts';

const appHtml = readFileSync(fileURLToPath(new URL('./app.html', import.meta.url)), 'utf8');

describe('the theme key', () => {
  it('is the one the pre-paint script reads', () => {
    // The script must read the contract's key, not a copy of an older idea of it.
    expect(appHtml).toContain(`localStorage.getItem('${THEME_STORAGE_KEY}')`);
  });

  it('is not read under any other name', () => {
    // The bug this pins: a second key that looks plausible ('edu3d-theme') sitting beside the real
    // one, so half the app writes and the other half reads.
    const keys = [...appHtml.matchAll(/localStorage\.getItem\('([^']+)'\)/g)].map(
      (match) => match[1],
    );
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) {
      expect(key).toBe(THEME_STORAGE_KEY);
    }
  });
});
