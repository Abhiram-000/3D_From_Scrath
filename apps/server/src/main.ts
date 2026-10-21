/**
 * The server entry: resolve, validate, serve, drain.
 *
 * The startup contract (`06`, `08`): resolve everything once, list every problem, refuse to start when
 * production is unsafe. The shutdown sequence, in order and each step for a reason (`06`):
 *   1. arm the hard-exit timer FIRST — every later step is bounded, and a process that refuses to
 *      die loses everything the drain was for (arming it first is what keeps that guarantee honest);
 *   2. drain — the lifecycle flag aborts in-flight provider calls and makes the pipeline's phase
 *      checks convert every open generation stream into the terminal `draining` error event; the
 *      readiness flag fails 503 so the load balancer stops routing;
 *   3. stop accepting connections — idle sockets closed, in-flight requests run to completion;
 *   4. wait for the streams to be TOLD — `waitUntilQuiet` bounds this wait, and only then do the
 *      debounced local writes flush and the store close (persistence must not race a stream whose
 *      final event has not been delivered yet);
 *   5. exit 0.
 *
 * An `uncaughtException` is NOT this sequence: process state is unknown, so it fails loudly (
 * exit 1) instead of pretending a graceful finish happened.
 */
import { serve } from '@hono/node-server';
import pino from 'pino';
import type { Server as HttpServer } from 'node:http';
import { resolveConfig, formatStartupReport, shouldRefuseToStart } from './config/config.ts';
import { buildApp, type AppState } from './app.ts';
import { AiClient } from './services/ai-client.ts';
import { createGenerationQueue } from './services/generation-queue.ts';
import { lifecycle } from './services/lifecycle.ts';
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
    // The global generation gate: one process-wide queue bounded by the provider plan's
    // concurrency (`AI_MAX_CONCURRENCY`, default 1 — the observed free-tier hard limit) and a
    // bounded wait. Built ONCE here, because the limit is a fact about the provider account, not
    // per-request state; the drain signal is shared so a queued learner gets the terminal
    // `draining` event, never a severed socket.
    genQueue: createGenerationQueue({
      limit: config.ai.maxConcurrency,
      maxWaitMs: config.ai.queueMaxWaitMs,
      drainSignal: lifecycle.drainSignal,
    }),
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
      'uncaught exception',
    );
    // Unknown process state is not a graceful drain: fail loudly (`06` separates shutdown modes).
    process.exit(1);
  });

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;

    // 1. Arm the hard timer FIRST. The old sequence armed it last and scheduled a 500 ms exit,
    //    which cut streams mid-flight and, worse, made every bounded step's bound ornamental.
    const hardExit = setTimeout(() => {
      console.error('shutdown exceeded the hard-exit timer; forcing exit');
      process.exit(1);
    }, SHUTDOWN_HARD_EXIT_MS);

    console.log(
      `\n${signal} received — draining (in-flight requests finish, streams are told, hard exit in ${SHUTDOWN_HARD_EXIT_MS / 1000}s)`,
    );

    // 2. Drain: the lifecycle aborts in-flight provider calls, the pipeline converts open
    //    generation streams into their terminal `draining` event, and readiness fails 503.
    //    (state.draining stays for the routes that read it directly.)
    state.draining = true;
    lifecycle.beginDrain();
    clearInterval(limiterSweep);

    // 3. Stop accepting new connections and drop the idle keep-alive ones; in-flight requests
    //    are told, not severed.
    //
    //    The close PROMISE is deliberately NOT awaited: it resolves only when the last
    //    keep-alive socket closes, and a streaming client's socket goes idle the moment its
    //    terminal event is delivered but then just sits there. Awaiting it here deadlocks the
    //    drain — the hard timer fires at 15 s and the process exits 1 WITH NOTHING FLUSHED,
    //    which is exactly the failure the bounded sequence exists to prevent. Accept-stop is
    //    synchronous; the two bounded steps below own the sequencing.
    //    (`closeIdleConnections` is http-server-only; hono's `ServerType` unions in http2, so
    //    reach it through the node http surface the listener actually is.)
    const nodeServer = server as unknown as HttpServer;
    nodeServer.closeIdleConnections();
    nodeServer.close((error) => {
      if (error) logger.warn({ error: String(error) }, 'server close error');
    });

    // 4. Wait for the streams to be told (bounded): the pipeline's phase checks and its
    //    provider-signal aborts end each generation with its terminal event, and this resolves
    //    as the count falls to zero. Persistence happens AFTER, so "streams are told" is a
    //    promise the server actually keeps.
    await lifecycle.waitUntilQuiet(SHUTDOWN_HARD_EXIT_MS);

    // 4b. One bounded grace turn: "quiet" means every generation RETURNED and its terminal
    //     event was ENQUEUED — but enqueued is not transmitted. Without this, process.exit
    //     can drop the still-buffered socket write and the learner sees a severed socket
    //     instead of the terminal `draining` event: the original 500 ms exit-kill bug back
    //     again, wearing a different hat. Half a second is far under the hard cap and more
    //     than enough turns for a local write to reach the wire.
    const FLUSH_GRACE_MS = 500;
    await new Promise<void>((resolve) => setTimeout(resolve, FLUSH_GRACE_MS));

    // 5. Flush the store's pending write-through, then release its resources — the Postgres pool
    //    ends (open clients would hold the process open past the hard-exit timer) and the file
    //    store's last debounced write hits disk.
    try {
      await store.flush();
      await store.close();
    } catch (error) {
      logger.warn({ error: (error as Error).message }, 'store flush during shutdown');
    }

    // 6. Exit 0, with the timer cleared so no crash-report noise follows a clean finish.
    clearTimeout(hardExit);
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

void main();
