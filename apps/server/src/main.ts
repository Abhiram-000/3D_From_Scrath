/**
 * The server entry: resolve, validate, serve, drain.
 *
 * The startup contract (`06`, `08`): resolve everything once, list every problem, refuse to start when
 * production is unsafe. The shutdown sequence, in order and each step for a reason (`06`):
 *   1. flip the drain flag — readiness fails 503 so the load balancer stops routing;
 *   2. stop accepting connections — in-flight requests run to completion;
 *   3. notify every open generation stream — a learner one to three minutes in gets a terminal
 *      "server is restarting" event instead of a severed socket;
 *   4. flush and close — debounced local writes flushed, store closed;
 *   5. exit, guaranteed by a hard timer — a process that refuses to die loses everything step 4 was for.
 */
import { serve } from '@hono/node-server';
import pino from 'pino';
import { resolveConfig, formatStartupReport, shouldRefuseToStart } from './config/config.ts';
import { buildApp, type AppState } from './app.ts';
import { AiClient } from './services/ai-client.ts';
import { buildLimiters } from './services/rate-limits.ts';
import { openGalleryStore } from './services/gallery-store.ts';
import { STATIC_SITE_PRESENT } from './services/static-pages.ts';

/** Hard exit deadline. Generous enough for a flush; absolute, so nothing can hang the process (`06`). */
const SHUTDOWN_HARD_EXIT_MS = 15_000;

async function main(): Promise<void> {
  // dotenv for local development; real environment variables always win (`06`).
  try {
    await import('dotenv/config');
  } catch {
    /* dotenv is optional in production, where env comes from the platform. */
  }

  // The filesystem probe lives here, at the boundary, rather than inside the resolver: PUBLIC_ORIGIN is
  // only load-bearing when this process has no built frontend to serve, and the answer comes from the
  // same module that decides whether to serve one.
  const config = resolveConfig(process.env, { staticSitePresent: STATIC_SITE_PRESENT });
  const logger = pino({
    level: config.logging.level,
    ...(config.logging.pretty ? { transport: { target: 'pino-pretty' } } : {}),
  });

  console.log(formatStartupReport(config));

  if (shouldRefuseToStart(config)) {
    console.error('\nRefusing to start: fix the configuration problems above.');
    process.exit(1);
  }

  let store;
  try {
    store = await openGalleryStore(config);
  } catch (error) {
    console.error(`\n${(error as Error).message}`);
    process.exit(1);
  }
  if (store.announcement.notice) {
    console.log(`\nnotice: ${store.announcement.notice}`);
  }

  const state: AppState = {
    config,
    ai: new AiClient(config),
    store,
    limiters: buildLimiters(config),
    draining: false,
    openStreams: 0,
    startedAt: Date.now(),
    // Fallback only: `clientKey` reads the real socket per request and uses this when the runtime
    // provides none. A constant here is why it must never be the primary source.
    remoteAddress: '127.0.0.1',
  };

  // Expired limiter buckets accumulate one entry per distinct client identity forever otherwise —
  // the sweep existed and was never called. Half the shortest window is frequent enough that a
  // bucket lives at most half a window past its own expiry.
  const LIMITER_SWEEP_MS = 30_000;
  const limiterSweep = setInterval(
    () => Object.values(state.limiters).forEach((limiter) => limiter.sweep()),
    LIMITER_SWEEP_MS,
  );
  limiterSweep.unref();

  const app = buildApp(state);
  const server = serve({ fetch: app.fetch, port: config.port, hostname: config.host }, (info) => {
    console.log(`\nedu3d server listening on http://${info.address}:${info.port}`);
  });

  // An idle pool client dying is a warning and a replacement, never a crash (`06`).
  server.on('error', (error) => logger.warn({ error: error.message }, 'server error'));

  // One stray rejected promise must not take the server down outside any request cycle (`06`).
  process.on('unhandledRejection', (reason) => {
    logger.error({ reason: String(reason) }, 'unhandled rejection');
  });
  process.on('uncaughtException', (error) => {
    logger.error(
      { error: error.message, stack: error.stack?.split('\n').slice(0, 4).join(' ') },
      'uncaught exception — draining',
    );
    void shutdown('uncaught exception');
  });

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(
      `\n${signal} received — draining (in-flight requests finish, streams are told, hard exit in ${SHUTDOWN_HARD_EXIT_MS / 1000}s)`,
    );

    // 1. Drain flag: readiness fails, new expensive requests are refused with an explanation.
    state.draining = true;

    // 2. Stop accepting new connections; let in-flight requests complete.
    server.close();
    clearInterval(limiterSweep);

    // 3. Notify open streams. The generation streams are inside ReadableStream bodies; the drain flag
    //    makes the next pipeline phase check fail into a terminal error event, and the hard exit below
    //    bounds how long a wedged stream can hold the process.
    // 4. Flush the store's pending write-through.
    try {
      await store.flush();
    } catch (error) {
      logger.warn({ error: (error as Error).message }, 'store flush during shutdown');
    }

    // 5. Exit, guaranteed.
    setTimeout(() => process.exit(0), 500).unref();
    setTimeout(() => {
      console.error('shutdown exceeded the hard-exit timer; forcing exit');
      process.exit(1);
    }, SHUTDOWN_HARD_EXIT_MS).unref();
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

void main();
