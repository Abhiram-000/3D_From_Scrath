/**
 * Precompression contract tests.
 *
 * The property under pin: a compressed copy is *the same bytes*, not a similar file. A build
 * step that silently corrupts an asset is worse than no build step at all, and it would only
 * show up as a broken page in production.
 */
import { brotliDecompress, gunzip } from 'node:zlib';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, stat, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { compressFile, precompressTree, shouldCompress } from './precompress.mjs';

const brotliDecompressAsync = promisify(brotliDecompress);
const gunzipAsync = promisify(gunzip);

let fixtureRoot: string;

beforeAll(async () => {
  fixtureRoot = await mkdtemp(join(tmpdir(), 'edu3d-precompress-'));
});

afterAll(async () => {
  await rm(fixtureRoot, { recursive: true, force: true });
});

describe('which files are worth compressing', () => {
  it('compresses the text the browser downloads', () => {
    expect(shouldCompress('/site/_app/immutable/worker.js')).toBe(true);
    expect(shouldCompress('/site/index.html')).toBe(true);
    expect(shouldCompress('/site/_app/immutable/app.css')).toBe(true);
  });

  it('leaves already-compressed formats alone', () => {
    // Compressing a PNG again costs build time and saves nothing.
    expect(shouldCompress('/site/favicon.png')).toBe(false);
    expect(shouldCompress('/site/font.woff2')).toBe(false);
  });

  it('does not compress its own output', () => {
    expect(shouldCompress('/site/app.js.br')).toBe(false);
    expect(shouldCompress('/site/app.js.gz')).toBe(false);
  });
});

describe('a compressed copy', () => {
  it('decompresses to exactly the original bytes', async () => {
    const file = join(fixtureRoot, 'app.js');
    const source = 'export const x = 1;\n'.repeat(500);
    await writeFile(file, source);

    await compressFile(file);

    const brotli = await readFile(`${file}.br`);
    const gzipped = await readFile(`${file}.gz`);
    expect((await brotliDecompressAsync(brotli)).toString()).toBe(source);
    expect((await gunzipAsync(gzipped)).toString()).toBe(source);
  });

  it('is smaller than the original', async () => {
    const file = join(fixtureRoot, 'bundle.js');
    await writeFile(file, 'const value = 42;\n'.repeat(2000));

    await compressFile(file);

    const original = (await stat(file)).size;
    const brotli = (await stat(`${file}.br`)).size;
    const gzipped = (await stat(`${file}.gz`)).size;
    expect(brotli).toBeLessThan(original);
    expect(gzipped).toBeLessThan(original);
  });
});

describe('compressing a built site', () => {
  it('compresses what it should and leaves the rest alone', async () => {
    const site = join(fixtureRoot, 'site');
    await mkdir(join(site, '_app'), { recursive: true });
    await writeFile(join(site, '_app', 'worker.js'), 'const worker = true;\n'.repeat(100));
    await writeFile(join(site, 'index.html'), '<!doctype html><title>edu3d</title>');
    await writeFile(join(site, 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]));

    const totals = await precompressTree(site);

    expect(totals.files).toBe(2);
    expect(totals.brotliBytes).toBeLessThan(totals.originalBytes);
    await expect(stat(join(site, '_app', 'worker.js.br'))).resolves.toBeTruthy();
    await expect(stat(join(site, 'logo.png.br'))).rejects.toThrow();
  });
});
