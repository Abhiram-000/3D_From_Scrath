/**
 * Precompress the built site.
 *
 * The viewer's sandbox worker is megabytes of JavaScript, and the server was shipping every byte
 * of it uncompressed on every load. Compressing at request time would fix the transfer but spend
 * CPU on every visitor; compressing once, at build time, costs nothing at runtime and compresses
 * better, because the compressor gets the whole file and a good quality setting.
 *
 * So the build writes a compressed copy beside each compressible file, and the server serves the
 * copy the client says it can read. The original stays in place: a client that wants no encoding
 * still gets a correct answer, and a file whose compressed copy is missing is not a failure.
 *
 * Usage: `node scripts/precompress.mjs [directory]` (defaults to the built site).
 */
import { brotliCompress, gzip, constants as zlibConstants } from 'node:zlib';
import { promisify } from 'node:util';
import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const brotliCompressAsync = promisify(brotliCompress);
const gzipAsync = promisify(gzip);

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** Where the built site lives when no directory is given. */
export const DEFAULT_TARGET = path.join(ROOT, 'apps/web/build');

/**
 * The file types worth compressing.
 *
 * Images, fonts and video are already compressed formats; compressing them again costs build
 * time and gains nothing. Everything textual is worth it — the worker bundle is the reason this
 * script exists.
 */
export const COMPRESSIBLE_EXTENSIONS = new Set([
  '.js',
  '.mjs',
  '.css',
  '.html',
  '.svg',
  '.json',
  '.webmanifest',
  '.txt',
  '.map',
  '.xml',
]);

/** Files at or below this size get the best compression quality; larger ones get a fast one. */
const SMALL_FILE_BYTES = 256 * 1024;

/** Whether a file is worth compressing. */
export function shouldCompress(filePath) {
  if (filePath.endsWith('.br') || filePath.endsWith('.gz')) return false;
  return COMPRESSIBLE_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

/**
 * Compress one file, writing `<file>.br` and `<file>.gz` beside it.
 *
 * The quality settings are split by size for a reason: brotli at its best setting is slow on a
 * multi-megabyte bundle, and the files a first paint waits for are the small ones.
 */
export async function compressFile(filePath) {
  const source = await readFile(filePath);
  const small = source.length <= SMALL_FILE_BYTES;

  const brotli = await brotliCompressAsync(source, {
    params: {
      [zlibConstants.BROTLI_PARAM_QUALITY]: small ? 11 : 5,
      [zlibConstants.BROTLI_PARAM_SIZE_HINT]: source.length,
    },
  });
  const gzipped = await gzipAsync(source, { level: small ? 9 : 6 });

  await writeFile(`${filePath}.br`, brotli);
  await writeFile(`${filePath}.gz`, gzipped);
  return { br: brotli.length, gzip: gzipped.length };
}

/** Every file under a directory, recursively. */
async function walk(root) {
  const entries = await readdir(root, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walk(full)));
    } else if (entry.isFile()) {
      files.push(full);
    }
  }
  return files;
}

/**
 * Compress every compressible file under a directory.
 *
 * Returns the totals, so the caller can report what the compression bought.
 */
export async function precompressTree(root) {
  const all = await walk(root);
  let files = 0;
  let originalBytes = 0;
  let brotliBytes = 0;
  let gzipBytes = 0;

  for (const file of all) {
    if (!shouldCompress(file)) continue;
    const info = await stat(file);
    const compressed = await compressFile(file);
    files += 1;
    originalBytes += info.size;
    brotliBytes += compressed.br;
    gzipBytes += compressed.gzip;
  }

  return { files, originalBytes, brotliBytes, gzipBytes };
}

/** The command-line entry point. */
async function main() {
  const target = process.argv[2] ? path.resolve(process.argv[2]) : DEFAULT_TARGET;
  try {
    await stat(target);
  } catch {
    console.error(`precompress: no such directory: ${target}`);
    process.exitCode = 1;
    return;
  }

  const totals = await precompressTree(target);
  const saved = totals.originalBytes - totals.brotliBytes;
  const percent = totals.originalBytes ? Math.round((saved / totals.originalBytes) * 100) : 0;
  console.log(
    `precompress: ${totals.files} files · ` +
      `${(totals.originalBytes / 1024 / 1024).toFixed(2)}MB → ` +
      `${(totals.brotliBytes / 1024 / 1024).toFixed(2)}MB brotli (${percent}% smaller) · ` +
      `${(totals.gzipBytes / 1024 / 1024).toFixed(2)}MB gzip`,
  );
}

// Run only when invoked directly, so the tests can import the functions.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
