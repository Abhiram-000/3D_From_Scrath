/**
 * Rate limiting: identity and bucket lifecycle.
 *
 * The property that matters is that a client cannot mint itself a fresh bucket by sending a header.
 * `06` calls trust-proxy "the single most consequential deployed-server setting" — and a client that
 * controls the identity string controls the limiter.
 */
import { describe, expect, it } from 'vitest';
import { RateLimiter, clientKey, isBatteryExemption, connectionAddress } from '../src/services/rate-limits.ts';
import type { Context } from 'hono';

/** A context carrying one header and one socket address — the only two identity inputs. */
function request(headers: Record<string, string>, remoteAddress?: string): Context {
  const socket = { remoteAddress };
  const env = remoteAddress === undefined ? {} : { incoming: { socket } };
  return {
    req: { header: (name: string) => headers[name] },
    env,
  } as unknown as Context;
}

describe('clientKey — a client cannot choose its own bucket', () => {
  it('uses the socket address, which a client cannot forge', () => {
    const key = clientKey(request({ 'x-forwarded-for': '1.2.3.4' }, '203.0.113.9'), 0, '127.0.0.1');
    expect(key).toBe('203.0.113.9');
  });

  it('ignores x-forwarded-for from a directly-connected public client', () => {
    // The socket is a public address, so it IS the client — the header is noise a client chose.
    const key = clientKey(request({ 'x-forwarded-for': '9.9.9.9' }, '203.0.113.9'), 1, '127.0.0.1');
    expect(key).toBe('203.0.113.9');
  });

  it('cannot be given unlimited buckets by rotating a forged header', () => {
    const limiter = new RateLimiter(3, 60_000);
    const socket = '203.0.113.9';
    // Three forged headers, three allowed calls — all landing in one bucket because the socket is
    // the identity.
    for (const forged of ['1.1.1.1', '2.2.2.2', '3.3.3.3']) {
      expect(limiter.check(clientKey(request({ 'x-forwarded-for': forged }, socket), 1, socket)).allowed)
        .toBe(true);
    }
    // The fourth carries a header never seen before, and is refused anyway — a new forged value
    // does not buy a new bucket.
    expect(
      limiter.check(clientKey(request({ 'x-forwarded-for': '4.4.4.4' }, socket), 1, socket)).allowed,
    ).toBe(false);
  });

  it('reads x-forwarded-for only from a private socket, where an edge proxy must be in front', () => {
    const forwarded = { 'x-forwarded-for': '1.2.3.4, 203.0.113.9' };
    // Private socket + TRUST_PROXY=1 → the edge appended the real client; take it.
    expect(clientKey(request(forwarded, '10.0.0.1'), 1, '127.0.0.1')).toBe('1.2.3.4');
    // Same header, public socket → no proxy, so the header is the client's own lie.
    expect(clientKey(request(forwarded, '203.0.113.9'), 1, '127.0.0.1')).toBe('203.0.113.9');
  });

  it('skips exactly TRUST_PROXY hops from the right', () => {
    const key = clientKey(
      request({ 'x-forwarded-for': '1.2.3.4, 10.0.0.7, 10.0.0.8' }, '10.0.0.9'),
      2,
      '127.0.0.1',
    );
    expect(key).toBe('1.2.3.4');
  });

  it('falls back to the socket when the header has fewer entries than trusted proxies', () => {
    // One entry but two trusted proxies: the header cannot have come through them, so whatever is
    // in it was supplied by the client. The socket is the only identity left standing.
    expect(clientKey(request({ 'x-forwarded-for': '1.2.3.4' }, '10.0.0.9'), 2, '127.0.0.1')).toBe(
      '10.0.0.9',
    );
  });

  it('falls back to the socket when no header is present', () => {
    expect(clientKey(request({}, '203.0.113.9'), 1, '127.0.0.1')).toBe('203.0.113.9');
  });
});

describe('RateLimiter.sweep — the bucket map cannot grow without bound', () => {
  it('drops only buckets whose window has elapsed', () => {
    const limiter = new RateLimiter(5, 1_000);
    limiter.check('stale', 0); // window closes at 1000
    limiter.check('fresh', 1_200); // window closes at 2200
    limiter.sweep(1_500);
    expect(limiter.size).toBe(1);
    limiter.sweep(2_500);
    expect(limiter.size).toBe(0);
  });
});

describe('the battery exemption cannot be self-granted', () => {
  it('needs both the marker header and a loopback socket', () => {
    expect(isBatteryExemption('battery', '127.0.0.1')).toBe(true);
    expect(isBatteryExemption('battery', '203.0.113.9')).toBe(false);
    expect(isBatteryExemption(undefined, '127.0.0.1')).toBe(false);
  });

  it('reads only the socket, never a forwarded header, for the exemption', () => {
    expect(
      connectionAddress(request({ 'x-forwarded-for': '127.0.0.1' }, '203.0.113.9')),
    ).toBe('203.0.113.9');
  });
});