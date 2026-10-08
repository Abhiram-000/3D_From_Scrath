/**
 * Layered rate limiting.
 *
 * `06` fixes the shape: "a general API limiter (generous — one model load makes several calls), a
 * tighter write limiter (writes are rarer and more consequential), and per-endpoint limiters for the
 * expensive AI paths... because a classroom behind one NAT address is one IP". Health checks are
 * exempt from every bucket — "monitoring must never lock the service out of its own buckets".
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
 * Derive the client identity for rate limiting.
 *
 * With `TRUST_PROXY` resolved from configuration (`06`: "the single most consequential deployed-server
 * setting"), the client IP is taken from `x-forwarded-for` only for the configured number of hops.
 * Hono's `c.env` does not carry the socket address on every runtime, so the remote address is passed
 * in at wiring time; behind an unconfigured proxy every visitor sharing the router IP is the known
 * failure this function exists to prevent.
 */
export function clientKey(context: Context, trustProxy: number, remoteAddress: string): string {
  if (trustProxy > 0) {
    const forwarded = context.req.header('x-forwarded-for');
    if (forwarded) {
      // The header lists client, proxy1, proxy2… — take from the right, past `trustProxy` hops.
      const hops = forwarded.split(',').map((item) => item.trim()).filter(Boolean);
      const index = Math.max(0, hops.length - trustProxy - 1);
      return hops[index] ?? remoteAddress;
    }
  }
  return remoteAddress;
}

/** Guard an AI-expensive path with its dedicated limiter. Health is exempt by construction. */
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
