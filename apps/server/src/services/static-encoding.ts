/**
 * The encoding a client will accept.
 *
 * The built site ships a compressed copy beside every compressible file, so serving a page costs
 * no CPU: the server reads the variant the client already said it can read. This module decides
 * which one that is, and nothing else — the filesystem check and the response live with the
 * static-site middleware.
 *
 * The rules that matter, and why:
 *
 *   - a client that asks for nothing gets the original bytes (never guess an encoding);
 *   - a client that explicitly refuses an encoding (`br;q=0`) must not be given it, because a
 *     client that says "not brotli" will not be able to read it;
 *   - when two encodings are equally acceptable, brotli wins, because it is smaller.
 */

/** The encodings this server produces. */
export type StaticEncoding = 'br' | 'gzip';

/** How much the client wants each encoding, and whether it refused it. */
interface Preference {
  encoding: StaticEncoding;
  /** The quality the client assigned, 0 meaning "not acceptable". */
  quality: number;
}

/** The preference order when qualities are equal: brotli is smaller than gzip. */
const PREFERENCE_ORDER: StaticEncoding[] = ['br', 'gzip'];

/**
 * Parse an `Accept-Encoding` header into the encodings this server produces.
 *
 * The header is a comma-separated list of tokens, each optionally carrying a quality value
 * (`br;q=0.8`). A token with no quality is quality 1. A quality of 0 is a refusal, not a
 * preference.
 */
function parsePreferences(header: string): Preference[] {
  const preferences: Preference[] = [];

  for (const token of header.split(',')) {
    const [rawName, ...parameters] = token.trim().split(';');
    const name = rawName?.trim().toLowerCase() ?? '';
    if (name === '') continue;

    // `*` means "anything you have", which for this server means the best thing it has.
    if (name === '*') {
      preferences.push({ encoding: 'br', quality: 1 });
      continue;
    }

    if (name !== 'br' && name !== 'gzip') continue;

    let quality = 1;
    for (const parameter of parameters) {
      const match = parameter.trim().match(/^q\s*=\s*([0-9.]+)$/i);
      if (!match?.[1]) continue;
      const parsed = Number.parseFloat(match[1]);
      if (Number.isFinite(parsed)) quality = parsed;
    }

    preferences.push({ encoding: name, quality });
  }

  return preferences;
}

/**
 * The encoding to serve, or null when the client wants nothing this server has.
 *
 * Null is the honest answer for a client that asked for `deflate` alone or for nothing at all:
 * the original bytes are then the correct response.
 */
export function preferredEncoding(
  acceptEncoding: string | undefined | null,
): StaticEncoding | null {
  if (!acceptEncoding) return null;

  const preferences = parsePreferences(acceptEncoding).filter(
    (preference) => preference.quality > 0,
  );
  if (preferences.length === 0) return null;

  let best: Preference | null = null;
  for (const preference of preferences) {
    if (!best) {
      best = preference;
      continue;
    }
    if (preference.quality > best.quality) {
      best = preference;
      continue;
    }
    if (preference.quality === best.quality) {
      // Equal quality: the smaller encoding wins.
      const order = PREFERENCE_ORDER.indexOf(preference.encoding);
      const bestOrder = PREFERENCE_ORDER.indexOf(best.encoding);
      if (order !== -1 && (bestOrder === -1 || order < bestOrder)) best = preference;
    }
  }

  return best?.encoding ?? null;
}
