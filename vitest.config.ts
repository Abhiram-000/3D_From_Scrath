/**
 * Vitest workspace configuration.
 *
 * One runner covers every package because `09` requires one `verify` gate, and because most of this
 * platform's logic is deliberately environment-free: the engine, the sandbox gate, the audit and the
 * physics assertions all run in Node with no browser, no GPU and no AI key. Only the few suites that
 * genuinely need a DOM opt into jsdom, per-file, via `// @vitest-environment jsdom`.
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Node by default: an accidental jsdom default would hide DOM dependencies the engine must not have.
    environment: 'node',
    include: [
      'packages/*/src/**/*.test.ts',
      'packages/*/tests/**/*.test.ts',
      'apps/*/tests/**/*.test.ts',
      // Repo-level gate scripts (check-secrets and friends) are tested where they live, in scripts/.
      'scripts/*.test.ts',
    ],
    exclude: ['**/node_modules/**', '**/dist/**', '**/.svelte-kit/**', '**/tests/e2e/**'],
    reporters: ['default'],
    // Long enough for a marching-cubes build or a physics settle, short enough that a hang is a failure.
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
