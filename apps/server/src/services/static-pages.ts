/**
 * Static frontend serving: the built SvelteKit site, served from the API server.
 *
 * A single container serving both halves removes the entire "configure CORS, keep two deployments
 * in sync" class of problem: same origin always, share links resolve on the first request, and the
 * deploy is one `docker run` (`06`'s allow-list discipline still governs /api; these files are
 * public assets with no capability behind them).
 *
 * Hand-rolled rather than @hono/node-server's serveStatic: that helper resolves `root` against the
 * process CWD, which containers do not guarantee — this version resolves one absolute path at
 * startup and reads files directly. Twenty lines, no CWD dependence, no library ambiguity.
 *
 * Served from `apps/web/build/` when present; the server starts fine without it (API-only mode)
 * so the halves can still deploy separately (`09` allows two deploy roots).
 */
import { createReadStream, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import type { Context, Next } from 'hono';

/** Where the built site lives, overridable for unusual container layouts. */
const STATIC_ROOT = process.env.STATIC_ROOT
  ? path.resolve(process.env.STATIC_ROOT)
  : path.resolve(import.meta.dirname ?? '.', '../../../web/build');

const INDEX = path.join(STATIC_ROOT, 'index.html');
const HAS_BUILD = existsSync(INDEX);

/** Hashed assets get a year: the filename changes when the content does (`08`). */
const IMMUTABLE_PREFIXES = ['/_app/'];

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.json': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2',
  '.webmanifest': 'application/manifest+json',
};

/**
 * Serve one file as a Response. Streamed (a snapshot or large chunk never buffers in memory) with
 * the immutable cache header applied by the caller.
 */
function fileResponse(filePath: string, context: Context): Response {
  const stream = Readable.toWeb(createReadStream(filePath)) as ReadableStream<Uint8Array>;
  const type = MIME[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream';
  context.header('content-type', type);
  return context.body(stream);
}

/**
 * Mount the static site. Runs AFTER the /api routes (wired last in app.ts): /api is the API's
 * namespace always — an unknown API path falls to the JSON 404, never the SPA shell.
 */
export async function staticSiteMiddleware(context: Context, next: Next): Promise<Response | void> {
  if (!HAS_BUILD) {
    await next();
    return;
  }

  const pathname = decodeURIComponent(new URL(context.req.url).pathname);
  if (pathname.startsWith('/api/')) {
    await next();
    return;
  }

  // Resolve the request to a file inside the build (traversal-proof: the resolved path must
  // remain under STATIC_ROOT), falling back to the SPA shell for extensionless routes so deep
  // links (`/viewer?model=<id>`) resolve on a cold load. Extension-bearing misses 404 honestly.
  const candidate = path.join(STATIC_ROOT, pathname);
  let filePath: string | null = null;
  if (candidate.startsWith(STATIC_ROOT) && existsSync(candidate) && statSync(candidate).isFile()) {
    filePath = candidate;
  } else if (!/\.[a-zA-Z0-9]+$/.test(pathname)) {
    filePath = INDEX;
  }

  if (!filePath) {
    await next();
    return;
  }

  if (IMMUTABLE_PREFIXES.some((prefix) => pathname.startsWith(prefix))) {
    context.header('cache-control', 'public, max-age=31536000, immutable');
  }
  return fileResponse(filePath, context);
}
