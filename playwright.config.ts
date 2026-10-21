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
import { tmpdir } from 'node:os';

/** Port kept distinct from the dev server's 5173 so a running `pnpm dev` does not collide with a test run. */
const PORT = 4173;

/** The deployed configuration's port — the API process serving the built site, distinct from preview. */
const API_PORT = 4174;

export default defineConfig({
  testDir: './tests/e2e',
  // A model build runs marching cubes on the reference turbofan, so a generous per-test budget is honest rather
  // than lax. A hang still fails, just later.
  // Generous, and deliberately so. A model load is authoring plus realization plus first-frame
  // shader compilation on a software rasterizer, which measured anywhere from 16s to 44s per run on
  // the same scene. At the previous 90s the page load alone could consume the budget and leave a
  // test failing on timeout rather than on behaviour — a flaky suite is worse than no suite, because
  // it teaches people to re-run it.
  timeout: 180_000,
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

  // Two servers, deliberately. `vite preview` is what the *dev* flow looks like, and the suite has
  // always driven it. It is also, critically, NOT the configuration that ships: preview sets no
  // Content-Security-Policy, so a viewer that renders there can still refuse to compile a single
  // model in production. That is exactly how a fatal CSP bug shipped and stayed invisible through a
  // green suite. The second server below IS the deployed shape — the API process serving the built
  // site on one origin, policy enforced — so `deployed-viewer.spec.ts` can assert against it.
  webServer: [
    {
      // `--host 127.0.0.1` is load-bearing, not decoration. Vite's preview server binds `localhost`,
      // which resolves to ::1 first on many systems, so the process is listening on IPv6 while the
      // `url` below probes IPv4 — the readiness check then never passes and every test fails for a
      // reason that has nothing to do with the code under test. Pinning the bind to IPv4 makes the
      // address in `url` the address the server actually holds.
      command: `pnpm --filter @edu3d/web exec vite preview --host 127.0.0.1 --port ${PORT} --strictPort`,
      url: `http://127.0.0.1:${PORT}`,
      // Never reuse a server we did not start. A preview server left over from an earlier run serves
      // a stale build directory: hashed chunk names 404, the page renders as an empty fallback shell,
      // and the whole suite fails in a way that looks like an application bug.
      reuseExistingServer: false,
      timeout: 120_000,
      stdout: 'ignore',
      stderr: 'pipe',
    },
    {
      // The deployed configuration: one origin, the built site, CSP enforced. `EDU3D_WRITE_TOKEN` is
      // required in production (the server refuses to boot without it) and `ALLOW_EPHEMERAL_STORE`
      // accepts the file-backed gallery, so the API needs no database to come up here. Port 4174,
      // distinct from the preview port, so both can run at once.
      command:
        `NODE_ENV=production PORT=${API_PORT} HOST=127.0.0.1 TRUST_PROXY=0 ` +
        `EDU3D_ALLOW_EPHEMERAL_STORE=true EDU3D_WRITE_TOKEN=e2e-read-only ` +
        `EDU3D_DATA_DIR=${tmpdir()}/edu3d-e2e-gallery ` +
        `pnpm --filter @edu3d/server exec node --experimental-strip-types src/main.ts`,
      url: `http://127.0.0.1:${API_PORT}/api/health`,
      reuseExistingServer: false,
      timeout: 120_000,
      stdout: 'ignore',
      stderr: 'pipe',
    },
  ],
});
