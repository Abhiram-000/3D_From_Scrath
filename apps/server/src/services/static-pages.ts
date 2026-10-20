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
import { preferredEncoding } from './static-encoding.ts';

/** Where the built site lives, overridable for unusual container layouts. */
const STATIC_ROOT = process.env.STATIC_ROOT
  ? path.resolve(process.env.STATIC_ROOT)
  : path.resolve(import.meta.dirname ?? '.', '../../../web/build');

const INDEX = path.join(STATIC_ROOT, 'index.html');

/**
 * Whether this process will actually serve a built frontend.
 *
 * Exported so `main.ts` can hand the config resolver the same answer this middleware acts on. If the two
 * disagreed the consequences are both bad and both silent: a server refusing to boot over a frontend it
 * is serving, or booting certain it serves one it does not. Probing `index.html` rather than the
 * directory is deliberate — a build interrupted midway leaves the directory present and the site
 * unreachable, and a directory check would call that deployment single-origin.
 */
export const STATIC_SITE_PRESENT = existsSync(INDEX);

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
 *
 * `typePath` is the file the *type* is taken from, which is not the file being read when that is a
 * precompressed copy: a `.br` file is still JavaScript.
 */
function fileResponse(filePath: string, context: Context, typePath: string = filePath): Response {
  const stream = Readable.toWeb(createReadStream(filePath)) as ReadableStream<Uint8Array>;
  const type = MIME[path.extname(typePath).toLowerCase()] ?? 'application/octet-stream';
  context.header('content-type', type);
  return context.body(stream);
}

/**
 * The precompressed copy of a file, if the client can read one.
 *
 * The build writes a compressed copy beside every compressible file, so this costs one `exists`
 * check and no CPU. A missing copy is not a failure: the original bytes are always a correct
 * answer, and a file that was not worth compressing has none.
 */
function encodedVariant(
  filePath: string,
  acceptEncoding: string | undefined,
): { file: string; encoding: 'br' | 'gzip' } | null {
  const encoding = preferredEncoding(acceptEncoding);
  if (!encoding) return null;
  const suffix = encoding === 'br' ? '.br' : '.gz';
  const candidate = `${filePath}${suffix}`;
  if (!existsSync(candidate)) return null;
  return { file: candidate, encoding };
}

/**
 * Mount the static site. Runs AFTER the /api routes (wired last in app.ts): /api is the API's
 * namespace always — an unknown API path falls to the JSON 404, never the SPA shell.
 */
export async function staticSiteMiddleware(context: Context, next: Next): Promise<Response | void> {
  if (!STATIC_SITE_PRESENT) {
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

  // The precompressed copy, when the client can read one. `Vary` is set either way: a cache that
  // saw an uncompressed response must not hand it to a client that only speaks brotli.
  const variant = encodedVariant(filePath, context.req.header('accept-encoding'));
  // Appended, not replaced: `Vary` is a list, and a cache that saw an uncompressed response must
  // not hand it to a client that only speaks brotli.
  context.header('vary', 'Accept-Encoding', { append: true });
  if (variant) {
    context.header('content-encoding', variant.encoding);
    return fileResponse(variant.file, context, filePath);
  }

  return fileResponse(filePath, context);
}
