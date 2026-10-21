/**
 * Layered rate limiting.
 *
 * `06` fixes the shape: "a general API limiter (generous — one model load makes several calls), a
 * tighter write limiter (writes are rarer and more consequential), and per-endpoint limiters for the
 * expensive AI paths... because a classroom behind one NAT address is one IP". Health checks are
 * exempt from the general bucket — "monitoring must never lock the service out of its own buckets" —
 * and that exemption is now applied explicitly where the middleware is registered (app.ts, the
 * /api/* limiter: an uploaded registration once ran these routes right past this module's own
 * exemption promise).
 *
 * Fixed-window counters in memory. Precise-enough for the ceilings involved, allocation-free per
 * request (a Map entry per key), and — unlike a token bucket — trivially explainable in the 429 it
 * returns: the window resets on the boundary, so "wait N seconds" is exact.
 */
import type { Context, Next } from 'hono';
import type { ServerConfig } from '../config/config.ts';

/** One bucket per key: the window's start second and the count within it. */
interface Window {
  resetAt: number;
  count: number;
}

export class RateLimiter {
  private readonly buckets = new Map<string, Window>();

  private readonly limit: number;
  private readonly windowMs: number;

  constructor(limit: number, windowMs: number) {
    this.limit = limit;
    this.windowMs = windowMs;
  }

  /** Record a hit and report what is left. */
  check(key: string, now = Date.now()): { allowed: boolean; retryAfterSeconds: number } {
    const existing = this.buckets.get(key);
    if (!existing || existing.resetAt <= now) {
      this.buckets.set(key, { resetAt: now + this.windowMs, count: 1 });
      return { allowed: true, retryAfterSeconds: 0 };
    }
    existing.count += 1;
    if (existing.count > this.limit) {
      return {
        allowed: false,
        retryAfterSeconds: Math.max(1, Math.ceil((existing.resetAt - now) / 1000)),
      };
    }
    return { allowed: true, retryAfterSeconds: 0 };
  }

  /** Drop expired buckets so the map cannot grow with one-off client keys. */
  sweep(now = Date.now()): void {
    for (const [key, bucket] of this.buckets) {
      if (bucket.resetAt <= now) this.buckets.delete(key);
    }
  }

  /** Live bucket count. Surfaced so the sweeper's effect is observable rather than assumed. */
  get size(): number {
    return this.buckets.size;
  }
}

/** The limiter set one server owns, built from its resolved config. */
export interface LimiterSet {
  api: RateLimiter;
  write: RateLimiter;
  generate: RateLimiter;
  chat: RateLimiter;
  quiz: RateLimiter;
}

/** Window sizes. One minute is coarse enough to absorb bursts, short enough to self-heal. */
const API_WINDOW_MS = 60_000;
const WRITE_WINDOW_MS = 60_000;
/** AI paths: five-minute windows, because a generation itself runs minutes (`04`). */
const AI_WINDOW_MS = 300_000;

export function buildLimiters(config: ServerConfig): LimiterSet {
  return {
    api: new RateLimiter(config.limits.api, API_WINDOW_MS),
    write: new RateLimiter(config.limits.write, WRITE_WINDOW_MS),
    generate: new RateLimiter(config.limits.generate, AI_WINDOW_MS),
    chat: new RateLimiter(config.limits.chat, AI_WINDOW_MS),
    quiz: new RateLimiter(config.limits.quiz, AI_WINDOW_MS),
  };
}

/**
 * Addresses a local network would use, which is what a reverse proxy's socket looks like from here.
 *
 * The distinction that makes the limiter safe: a *public* socket is the client itself, so any
 * forwarded header it sends is its own lie. A *private* socket means something inside the deployment
 * is in front of us and may have appended a genuine client address.
 *
 * The `::ffff:` arm is IPv4-mapped IPv6: on a dual-stack host a real proxied connection arrives
 * spelled that way (`::ffff:10.0.0.5`). Missing it skipped the forwarded path entirely and collapsed
 * every visitor of such a deployment onto the one socket bucket. A mapped public address
 * (`::ffff:203.0.113.9`) stays public — the mapping must not open the forwarded path for it.
 */
const PRIVATE_ADDRESS =
  /^(?:127\.|10\.|192\.168\.|169\.254\.|172\.(?:1[6-9]|2\d|3[01])\.|::1$|f[cd]|::ffff:(?:127\.|10\.|192\.168\.|169\.254\.|172\.(?:1[6-9]|2\d|3[01])\.))/i;

export function isPrivateAddress(address: string): boolean {
  return PRIVATE_ADDRESS.test(address);
}

/**
 * Derive the client identity for rate limiting.
 *
 * `X-Forwarded-For` is client-settable, and the append semantics are the whole game: each proxy
 * pass-through APPENDS the address it received from to the right-hand end of the header. So with
 * `TRUST_PROXY = n`, the last `n` entries are exactly the ones trusted proxies wrote, and the
 * address of the client is the leftmost of those: `hops[hops.length - n]`. Every entry further
 * left arrived from the client, pre-written, and rotating it must not rotate the bucket.
 *
 * The previous implementation walked one entry further left (`hops[len - n - 1]`), which is the
 * FIRST client-written line: a free bucket rotation, and on the generate limiter, free AI spend.
 * Verified live: 40 forged-header rotations against a limit-5 server produced zero 429s.
 *
 * The socket address is the one identity a client cannot forge, so it is the default and the
 * fallback: when the socket is public (no proxy is in front, the client is talking to us
 * directly), when no header is present, or when the header carries FEWER entries than trusted
 * proxies (`hops.length < n`, strict — some trusted hop never appended and the position
 * arithmetic cannot be trusted for that header).
 *
 * `06` calls trust-proxy "the single most consequential deployed-server setting". That remains true:
 * a deployment that sets `TRUST_PROXY` too high trusts more hops than actually exist, and too low
 * collapses distinct clients onto one bucket. Both directions are visible as throttling, which is
 * what the startup validation warning is for.
 */
export function clientKey(context: Context, trustProxy: number, remoteAddress: string): string {
  const socket = connectionAddress(context) ?? remoteAddress;
  if (trustProxy <= 0 || !isPrivateAddress(socket)) return socket;

  const forwarded = context.req.header('x-forwarded-for');
  if (!forwarded) return socket;

  // The header reads client, proxy1, proxy2… — each proxy appending the address it received from.
  const hops = forwarded
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  // Fewer entries than trusted proxies means some trusted hop never appended, so the position
  // arithmetic cannot be trusted for this header: the socket is the identity that still stands.
  if (hops.length < trustProxy) return socket;

  // The leftmost entry a trusted proxy actually wrote — an honest chain of n proxies produces
  // exactly n entries and this reads the first one; a client-padded chain reads the same position
  // but the padding sits further left than the trusted proxies' window.
  return hops[hops.length - trustProxy] ?? socket;
}

/**
 * Guard one route with its dedicated limiter. The health exemption is applied where the general
 * /api/* limiter is registered (app.ts); the per-endpoint limiters here are attachable one route at
 * a time, so nothing is "exempt by construction" — a registration passing through this helper is
 * limited.
 */
export function limitWith(
  limiter: RateLimiter,
  trustProxy: number,
  remoteAddress: string,
): (context: Context, next: Next) => Promise<Response | undefined> {
  return async (context, next) => {
    const key = clientKey(context, trustProxy, remoteAddress);
    const verdict = limiter.check(key);
    if (!verdict.allowed) {
      context.header('retry-after', String(verdict.retryAfterSeconds));
      return context.json(
        {
          error: {
            code: 'rate_limited',
            message: `Too many requests. Wait ${verdict.retryAfterSeconds}s and try again.`,
            requestId: context.get('requestId') as string,
            retryAfterSeconds: verdict.retryAfterSeconds,
          },
        },
        429,
      );
    }
    await next();
    return undefined;
  };
}

// ── The topic battery's narrow exemption from the generate limiter ──────────

/**
 * The header the topic battery sends on every generate call, and the exact value required.
 *
 * The battery is an HTTP client of this server (it streams from `/api/generate` like a browser
 * would), so the generate limiter would otherwise count its eight topics against the very bucket
 * it reads from — and record its own 429s as build failures, corrupting the measurement the
 * battery exists to take.
 */
export const BATTERY_REQUEST_HEADER = 'x-edu3d-battery';
export const BATTERY_REQUEST_VALUE = 'battery';

/**
 * The loopback spellings a real local connection can carry. `localhost` is deliberately absent:
 * this check reads socket addresses, not names a client could influence.
 */
const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

export function isLoopbackAddress(address: string | undefined): boolean {
  return address !== undefined && LOOPBACK_ADDRESSES.has(address);
}

/**
 * The remote address of the actual connection, or undefined when no socket backs the request.
 *
 * Mirrors `getConnInfo` from `@hono/node-server` but fails soft instead of throwing when `env`
 * carries no socket (a test harness, a non-node runtime), because the safe direction of this
 * check is "no address → no exemption". Only the socket is read: forwarded headers are client
 * controlled and must never decide an exemption.
 */
export function connectionAddress(context: Context): string | undefined {
  // `@hono/node-server` exposes the socket at `env.incoming.socket`; some runtimes hang the same
  // object off `env.server`. Both shapes are the same socket, so both are read rather than one
  // shape being asserted and the other silently undefined.
  const env = context.env as
    { server?: { incoming?: SocketBinding }; incoming?: SocketBinding } | undefined;
  const bindings = env?.server ?? env;
  return bindings?.incoming?.socket?.remoteAddress;
}

/** The slice of a node socket this module reads — one field, deliberately. */
interface SocketBinding {
  socket?: { remoteAddress?: string };
}

/**
 * True only when the battery's marker header AND a loopback socket are both present.
 *
 * Two conditions because either alone is unsafe: the header alone would let any internet client
 * exempt itself from the limiter by setting a string, and loopback alone would exempt every local
 * development browser. An internet client can set the header but can never be the loopback
 * socket — the socket is the one fact it cannot forge.
 */
export function isBatteryExemption(
  headerValue: string | undefined,
  remoteAddress: string | undefined,
): boolean {
  return headerValue === BATTERY_REQUEST_VALUE && isLoopbackAddress(remoteAddress);
}
