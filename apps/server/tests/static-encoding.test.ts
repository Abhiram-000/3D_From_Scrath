/**
 * Which precompressed variant to serve.
 *
 * The built site ships a compressed copy beside every compressible file, so the server never
 * spends CPU compressing on the fly — it picks the variant the client says it can read. The
 * decision is pure, so it is tested apart from the filesystem.
 *
 * The rules that matter: a client that does not ask for an encoding gets the original bytes; a
 * client that explicitly refuses an encoding (`br;q=0`) must not be given it; and when two
 * encodings are equally acceptable, brotli wins because it is smaller.
 */
import { describe, expect, it } from 'vitest';
import { preferredEncoding } from '../src/services/static-encoding.ts';

describe('the encoding a client will accept', () => {
  it('is none when the client asks for nothing', () => {
    expect(preferredEncoding(undefined)).toBeNull();
    expect(preferredEncoding('')).toBeNull();
  });

  it('is gzip when the client asks for gzip', () => {
    expect(preferredEncoding('gzip')).toBe('gzip');
  });

  it('is brotli when the client asks for brotli', () => {
    expect(preferredEncoding('br')).toBe('br');
  });

  it('prefers brotli when the client accepts both', () => {
    // Brotli is smaller, and a client that accepts both is better served by the smaller one.
    expect(preferredEncoding('gzip, deflate, br')).toBe('br');
  });

  it('respects a refusal', () => {
    // `br;q=0` is a client saying "not brotli", and serving it anyway would break the page.
    expect(preferredEncoding('br;q=0, gzip')).toBe('gzip');
    expect(preferredEncoding('gzip, br;q=0')).toBe('gzip');
  });

  it('respects a quality value', () => {
    expect(preferredEncoding('gzip;q=0.5, br;q=0.9')).toBe('br');
    expect(preferredEncoding('br;q=0.4, gzip;q=0.8')).toBe('gzip');
  });

  it('ignores an encoding this server does not produce', () => {
    // `deflate` is not on offer; the original bytes are the honest answer.
    expect(preferredEncoding('deflate')).toBeNull();
  });

  it('accepts anything when the client says anything', () => {
    expect(preferredEncoding('*')).toBe('br');
  });
});
