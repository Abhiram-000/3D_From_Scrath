/**
 * Rate limiting: identity and bucket lifecycle.
 *
 * The property that matters is that a client cannot mint itself a fresh bucket by sending a header.
 * `06` calls trust-proxy "the single most consequential deployed-server setting" — and a client that
 * controls the identity string controls the limiter.
 *
 * The XFF semantics these expectations encode: each proxy in front **appends** the address it
 * received from, so with `TRUST_PROXY = n` the last `n` entries of `X-Forwarded-For` are exactly the
 * entries written by trusted proxies, and the client is at `hops[len - n]` — the furthest-left entry
 * a trusted proxy actually saw. Every entry further left is client-written and forgeable. The
 * previous implementation walked one entry further left (`hops[len - n - 1]`), which was the
 * client's own line: a free bucket rotation, and on the generate limiter, unlimited AI spend.
 */
import { describe, expect, it } from 'vitest';
import {
  RateLimiter,
  clientKey,
  isBatteryExemption,
  connectionAddress,
  isPrivateAddress,
} from '../src/services/rate-limits.ts';
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
      expect(
        limiter.check(clientKey(request({ 'x-forwarded-for': forged }, socket), 1, socket)).allowed,
      ).toBe(true);
    }
    // The fourth carries a header never seen before, and is refused anyway — a new forged value
    // does not buy a new bucket.
    expect(
      limiter.check(clientKey(request({ 'x-forwarded-for': '4.4.4.4' }, socket), 1, socket))
        .allowed,
    ).toBe(false);
  });

  it('cannot be given unlimited buckets by rotating a forged header BEHIND a trusted proxy', () => {
    // The live-bypass shape the limiter shipped with: TRUST_PROXY=1, private socket, and the
    // header the edge would deliver after appending what it received — `<client line>, ` + the
    // real address. The forged part rotates per request; the appended entry never moves.
    const limiter = new RateLimiter(3, 60_000);
    const socket = '10.0.0.1';
    for (const forged of ['1.1.1.1', '2.2.2.2', '3.3.3.3']) {
      expect(
        limiter.check(
          clientKey(request({ 'x-forwarded-for': `${forged}, 198.51.100.5` }, socket), 1, socket),
        ).allowed,
        forged,
      ).toBe(true);
    }
    expect(
      limiter.check(
        clientKey(request({ 'x-forwarded-for': '4.4.4.4, 198.51.100.5' }, socket), 1, socket),
      ).allowed,
    ).toBe(false);
  });

  it('reads x-forwarded-for only from a private socket, where an edge proxy must be in front', () => {
    // One appending proxy, honest client, client-forged first line: what arrives is
    // `1.2.3.4, 10.0.0.1` where 10.0.0.1 is what the edge appended. The appended entry — the LAST
    // one — is the client the edge actually saw; the leading entry is whatever the client chose to
    // write. (The old expectation here pinned the opposite reading and called the appended entry
    // forgeable — which is the bypass this block now refuses.)
    const forwarded = { 'x-forwarded-for': '1.2.3.4, 198.51.100.5' };
    expect(clientKey(request(forwarded, '10.0.0.1'), 1, '127.0.0.1')).toBe('198.51.100.5');
    // Same header from a public socket → no trusted proxy exists, so the header is a lie overall.
    expect(clientKey(request(forwarded, '203.0.113.9'), 1, '127.0.0.1')).toBe('203.0.113.9');
  });

  it('with two trusted hops, the client sits at len−2 and left-padding cannot move it', () => {
    // Two appending proxies turned an honest (no client header) `C, P1` into `--, C, P1`… the
    // concrete wire: a padded header puts the forged lines leftmost; the two proxy-written entries
    // stay rightmost. The client entry is the leftmost of those: `hops[len - 2]`.
    const padded = { 'x-forwarded-for': '1.2.3.4, 10.0.0.7, 10.0.0.8' };
    expect(clientKey(request(padded, '10.0.0.9'), 2, '127.0.0.1')).toBe('10.0.0.7');
  });

  it('an honest chain with no client-written prefix still resolves to the client', () => {
    // THE opposite failure the old guard had: `hops.length <= trustProxy` fell back to the socket,
    // so with a single appending proxy and an honest client (`C` written by that one proxy, header
    // length exactly == trustProxy) every client behind the proxy collapsed onto ONE bucket.
    // An honest chain of n trusted proxies produces exactly n entries: trustworthy entries count.
    const honest = { 'x-forwarded-for': '198.51.100.5' };
    expect(clientKey(request(honest, '10.0.0.1'), 1, '127.0.0.1')).toBe('198.51.100.5');
    const twoHops = { 'x-forwarded-for': '198.51.100.5, 10.0.0.7' };
    expect(clientKey(request(twoHops, '10.0.0.1'), 2, '127.0.0.1')).toBe('198.51.100.5');
  });

  it('falls back to the socket when the header has FEWER entries than trusted proxies', () => {
    // One entry but two trusted proxies: some trusted hop never appended, so the position
    // arithmetic cannot be trusted for this header. The socket is the only identity left standing.
    // (`hops.length < trustProxy`, strict: an honest chain has exactly `trustProxy` entries and
    // must not fall back — see the test above.)
    expect(clientKey(request({ 'x-forwarded-for': '1.2.3.4' }, '10.0.0.9'), 2, '127.0.0.1')).toBe(
      '10.0.0.9',
    );
  });

  it('falls back to the socket when no header is present', () => {
    expect(clientKey(request({}, '203.0.113.9'), 1, '127.0.0.1')).toBe('203.0.113.9');
  });
});

describe('isPrivateAddress — the private-socket signature in every spelling a dual-stack host uses', () => {
  it('recognises IPv4-mapped IPv6 sockets as private, so a proxy is detected there too', () => {
    // On a dual-stack host the proxied connection can arrive as `::ffff:10.0.0.5`. Missing it
    // skipped the forwarded path entirely and collapsed every client onto the socket bucket.
    expect(isPrivateAddress('::ffff:10.0.0.5')).toBe(true);
    expect(isPrivateAddress('::ffff:172.16.0.9')).toBe(true);
    expect(isPrivateAddress('::ffff:192.168.1.2')).toBe(true);
    expect(isPrivateAddress('::ffff:127.0.0.1')).toBe(true);
    // Mapped PUBLIC addresses are still public — the forward path must not open for them.
    expect(isPrivateAddress('::ffff:203.0.113.9')).toBe(false);
    expect(isPrivateAddress('203.0.113.9')).toBe(false);
    expect(isPrivateAddress('10.0.0.5')).toBe(true);
    expect(isPrivateAddress('172.31.200.1')).toBe(true);
    expect(isPrivateAddress('172.32.0.1')).toBe(false);
    expect(isPrivateAddress('fc00::1')).toBe(true);
    expect(isPrivateAddress('2001:db8::1')).toBe(false);
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
    expect(connectionAddress(request({ 'x-forwarded-for': '127.0.0.1' }, '203.0.113.9'))).toBe(
      '203.0.113.9',
    );
  });
});
