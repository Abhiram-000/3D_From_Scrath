/**
 * Store-level durability tests: the file store's write-through is where a defect is silent longest
 * — rows marked persisted but never written only show up as missing publishes after a restart.
 * Backfilling the coverage this file needed existed for routes (`app.test.ts`) but not for these
 * two failure modes:
 *
 *   1. `flush()` cleared `dirty` BEFORE awaiting the write: a failed write returned in-memory rows
 *      marked persisted — silent data loss. It now clears only after the rename commits, so a
 *      failed flush leaves the rows marked unpersisted and the next flush retries.
 *   2. eviction and replace dropped a row's snapshot file on the floor: the row count was bounded,
 *      the snapshot bytes behind it were not.
 */
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { FileStore, sniffSnapshot } from '../src/services/gallery-store.ts';
import { resolveConfig } from '../src/config/config.ts';

let dataDir: string;

afterAll(async () => {
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
});

const configFor = (dir: string) => resolveConfig({ EDU3D_DATA_DIR: dir });

const record = (name: string) => ({
  name,
  subject: 'mechanics',
  tags: [],
  bundle: { manifest: { name } },
});

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), 'edu3d-store-test-'));
});

describe('flush durability', () => {
  it('a failed write leaves rows marked unpersisted, and the retry persists them', async () => {
    const store = new FileStore(configFor(dataDir), 'unconfigured');
    await store.init();
    await store.put(record('survivor'));

    // Sabotage exactly the temp path flush writes to: a directory where the temp file must go
    // makes writeFile fail deterministically, without permission-dependent tricks.
    await mkdir(`${dataDir}/gallery.json.tmp`);
    await expect(store.flush()).rejects.toThrow();

    // Repair and retry. The old order (dirty=false before the write) would make this second flush
    // a no-op — the rows would reload as missing after a restart.
    await rm(`${dataDir}/gallery.json.tmp`, { recursive: true });
    await store.flush();

    const reloaded = new FileStore(configFor(dataDir), 'unconfigured');
    await reloaded.init();
    const list = await reloaded.list({ limit: 10, offset: 0 });
    expect(list.total).toBe(1);
    expect(list.entries[0]?.name).toBe('survivor');
  });
});

describe('snapshot files do not outlive their row', () => {
  it('delete removes the snapshot file the URL points at', async () => {
    const store = new FileStore(configFor(dataDir), 'unconfigured');
    await store.init();
    const bytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47]);
    const url = await store.putSnapshot(bytes, 'image/png');
    const file = path.join(dataDir, 'snapshots', url.split('/').pop() ?? '');
    expect(existsSync(file)).toBe(true);

    const published = await store.put({ ...record('with-picture'), snapshotUrl: url });
    const removed = await store.delete(published.id);
    expect(removed).toBe(true);
    expect(existsSync(file)).toBe(false);
  });

  it("eviction removes the evicted row's snapshot files, not just the rows", async () => {
    // MAX_FILE_ROWS is 500 (gallery-store.ts); push 501 oldest-first and the first row must die
    // together with its snapshot file.
    const store = new FileStore(configFor(dataDir), 'unconfigured');
    await store.init();
    const snapshotDir = path.join(dataDir, 'snapshots');
    const evictedUrl = '/api/snapshots/00000000-0000-4000-8000-000000000000.png';
    await mkdir(snapshotDir, { recursive: true });
    await writeFile(path.join(snapshotDir, path.basename(evictedUrl)), 'old');

    await store.put({ ...record('oldest'), snapshotUrl: evictedUrl });
    for (let i = 1; i <= 500; i += 1) {
      await store.put(record(`row-${i}`));
    }

    const list = await store.list({ limit: 600, offset: 0 });
    expect(list.total).toBe(500);
    expect(list.entries.some((entry) => entry.name === 'oldest')).toBe(false);
    // Removal is fire-and-forget from the eviction path; settle the microtask queue before judging.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(existsSync(path.join(snapshotDir, path.basename(evictedUrl)))).toBe(false);
  });

  it('a replaced publish drops the snapshot the new record no longer points at', async () => {
    const store = new FileStore(configFor(dataDir), 'unconfigured');
    await store.init();
    const bytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47]);
    const firstUrl = await store.putSnapshot(bytes, 'image/png');
    const firstFile = path.join(dataDir, 'snapshots', firstUrl.split('/').pop() ?? '');
    const published = await store.put({ ...record('v1'), snapshotUrl: firstUrl });

    const secondUrl = await store.putSnapshot(bytes, 'image/png');
    const republished = await store.put({
      ...record('v2'),
      id: published.id,
      snapshotUrl: secondUrl,
    });
    expect(republished.snapshotUrl).toBe(secondUrl);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(existsSync(firstFile)).toBe(false);

    // And the record's pointer round-trips: the sniffed bytes are still readable behind the URL.
    const served = await store.getSnapshot(republished.snapshotUrl?.split('/').pop() ?? '');
    expect(served?.mime).toBe('image/png');
    expect(sniffSnapshot(served?.bytes ?? new Uint8Array())).toBe('image/png');
  });
});
