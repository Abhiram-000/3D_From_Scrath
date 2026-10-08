/**
 * Playwright configuration.
 *
 * The E2E suite exists to prove the things unit tests structurally cannot: that the sandbox worker actually spawns,
 * that WebGL renders on a real device profile, and that the kill switch recovers the page. `09` requires "E2E for
 * the flows a user actually takes (real browser, desktop *and* phone profiles)", and `08` requires the phone
 * profile specifically — the majority of real users are on one.
 *
 * The preview server is used rather than the dev server so the suite exercises the *built* output: chunking,
 * worker bundling and asset hashing are all part of what can break, and none of them exist in dev.
 */
import { defineConfig, devices } from '@playwright/test';

/** Port kept distinct from the dev server's 5173 so a running `pnpm dev` does not collide with a test run. */
const PORT = 4173;

export default defineConfig({
  testDir: './tests/e2e',
  // A model build runs marching cubes on the reference turbofan, so a generous per-test budget is honest rather
  // than lax. A hang still fails, just later.
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  // One worker: every test drives a real WebGL context, and several at once on a CI container thrash the GPU
  // emulation badly enough to produce failures that are about the harness rather than the code.
  workers: 1,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],

  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },

  projects: [
    {
      name: 'desktop',
      use: {
        ...devices['Desktop Chrome'],
        launchOptions: {
          args: [
            // Headless Chromium has no GPU, so WebGL2 comes from SwiftShader. Without these flags the context
            // creation fails and every 3D test fails for a reason that has nothing to do with the platform.
            '--use-gl=angle',
            '--use-angle=swiftshader',
            '--enable-unsafe-swiftshader',
          ],
        },
      },
    },
    {
      // `08`'s design centre is a mid-range phone, so the phone profile is a first-class project rather than an
      // afterthought: layout collapse, touch targets and tier detection all only happen here.
      name: 'phone',
      use: {
        ...devices['Pixel 7'],
        launchOptions: {
          args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
        },
      },
    },
  ],

  webServer: {
    command: `pnpm --filter @edu3d/web exec vite preview --port ${PORT} --strictPort`,
    url: `http://127.0.0.1:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
