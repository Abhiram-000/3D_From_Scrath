/**
 * Auto-save on success: the server persists its own successful generation.
 *
 * These are route-level tests because the behaviour lives at the route/state boundary, not in the
 * store-free pipeline. The proofs this file owns:
 *   - a successful generation creates exactly ONE gallery entry, with `snapshotUrl: null` and a
 *     name taken from the manifest;
 *   - a FAILED generation creates NONE;
 *   - a store that THROWS does not fail the generation — the learner still receives `ready`
 *     (the repo's "degrade, never die" rule);
 *   - `EDU3D_AUTO_SAVE_GENERATIONS=false` creates none;
 *   - publishing after an auto-save UPDATES that entry instead of adding a second.
 *
 * The stub AI returns the shipped reference program (fenced, as the provider does), so the pipeline
 * reaches `ready` through the REAL gate/audit path — the same end-to-end shape
 * `generation-queue-routing.test.ts` already drives. The store is a hand-rolled recording fake so a
 * `put` can be observed, counted, and made to throw on demand.
 */
import { describe, expect, it } from 'vitest';
import { REFERENCE_MODEL_SOURCE } from '@edu3d/engine';
import type { GenerationEvent } from '@edu3d/contracts';
import { buildApp, type AppState } from '../src/app.ts';
import { resolveConfig } from '../src/config/config.ts';
import type { AiClient as AiClientType } from '../src/services/ai-client.ts';
import { buildLimiters } from '../src/services/rate-limits.ts';
import type {
  GalleryRecord,
  GalleryStore,
  StoreAnnouncement,
} from '../src/services/gallery-store.ts';

/** The stub that always replies with the reference program — a real, gate-clean, auditable model. */
function referenceAi(): AiClientType {
  return {
    complete: async () => ({
      ok: true as const,
      text: '```javascript\n' + REFERENCE_MODEL_SOURCE.trim() + '\n```',
      finishReason: 'stop' as const,
      usage: { promptTokens: 10, completionTokens: 1000 },
    }),
  } as unknown as AiClientType;
}

/** The stub that always fails — the pipeline returns `ok: false` and nothing must be saved. */
function failingAi(): AiClientType {
  return {
    complete: async () => ({
      ok: false as const,
      code: 'network' as const,
      message: 'the provider is unavailable',
      retryable: true as const,
    }),
  } as unknown as AiClientType;
}

/** A gallery store that records every `put` and can be told to throw, so both truths are observable. */
function recordingStore(options: { throwOnPut?: boolean } = {}): GalleryStore & {
  puts: Array<Record<string, unknown>>;
} {
  const puts: Array<Record<string, unknown>> = [];
  const recorded = new Map<string, GalleryRecord>();
  const announcement: StoreAnnouncement = { backend: 'file', notice: null, warnings: [] };
  let seq = 0;
  return {
    puts,
    announcement,
    init: async () => {},
    list: async () => ({
      entries: [...recorded.values()].map(({ bundle: _bundle, ...entry }) => entry),
      total: recorded.size,
    }),
    get: async (id: string) => recorded.get(id) ?? null,
    put: async (input: {
      name: string;
      subject: string;
      tags: string[];
      bundle: unknown;
      id?: string;
      snapshotUrl?: string | null;
    }) => {
      if (options.throwOnPut) throw new Error('the gallery store is down');
      // Count the call and remember the entry, so a publish-then-check sees an UPDATE (same id,
      // same count) rather than a second insert.
      puts.push(input as unknown as Record<string, unknown>);
      seq += 1;
      const id = input.id ?? `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`;
      const now = Date.now();
      const record: GalleryRecord = {
        id,
        name: input.name,
        subject: input.subject,
        tags: input.tags,
        bundle: input.bundle,
        snapshotUrl: input.snapshotUrl ?? null,
        createdAt: now,
        updatedAt: now,
      };
      recorded.set(id, record);
      return record;
    },
    delete: async (id: string) => recorded.delete(id),
    putSnapshot: async () => '/api/snapshots/00000000-0000-4000-8000-000000000999.png',
    getSnapshot: async () => null,
    flush: async () => {},
    close: async () => {},
  } as unknown as GalleryStore & { puts: Array<Record<string, unknown>> };
}

function stateFor(
  ai: AiClientType,
  store: GalleryStore,
  env: Record<string, string | undefined> = {},
): AppState {
  const config = resolveConfig({
    AI_API_KEY: 'stub-key',
    AI_BASE_URL: 'http://stub.invalid/v1',
    AI_MODEL: 'stub-model',
    EDU3D_API_RATE_LIMIT: '6000',
    EDU3D_GENERATE_RATE_LIMIT: '6000',
    ...env,
  });
  return {
    config,
    ai,
    store,
    limiters: buildLimiters(config),
    draining: false,
    openStreams: 0,
    startedAt: Date.now(),
    remoteAddress: '127.0.0.1',
  };
}

/** POST one streaming generate and return the parsed NDJSON events. */
async function generate(app: ReturnType<typeof buildApp>): Promise<GenerationEvent[]> {
  const response = await app.request('/api/generate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ topic: 'a turbofan engine', complexity: 'simple', stream: true }),
  });
  const text = await response.text();
  return text
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as GenerationEvent);
}

const TIMEOUT = { timeout: 120_000 } as const;

describe('auto-save on a successful generation', () => {
  it(
    'saves exactly ONE entry, with a null snapshot and a manifest-derived name, and carries its id on ready',
    TIMEOUT,
    async () => {
      const store = recordingStore();
      const app = buildApp(stateFor(referenceAi(), store));

      const events = await generate(app);
      const ready = events.at(-1);
      expect(ready?.type).toBe('ready');

      // Exactly one gallery write, no bytes: the server never renders a pixel.
      expect(store.puts).toHaveLength(1);
      const saved = store.puts[0];
      expect(saved?.snapshotUrl).toBeNull();
      expect(typeof saved?.name).toBe('string');
      expect((saved?.name as string).length).toBeGreaterThan(0);
      expect(Array.isArray(saved?.tags)).toBe(true);
      expect(saved?.tags as string[]).toContain('auto');

      // The terminal event carries the id the write minted, so publish can update it in place.
      if (ready?.type === 'ready') {
        expect(ready.galleryId).toBeDefined();
      }
    },
  );

  it('a FAILED generation saves nothing', TIMEOUT, async () => {
    const store = recordingStore();
    const app = buildApp(stateFor(failingAi(), store));

    const events = await generate(app);
    const terminal = events.at(-1);
    expect(terminal?.type).toBe('error');
    expect(store.puts).toHaveLength(0);
  });

  it(
    'a store that THROWS does not fail the generation — the learner still receives ready',
    TIMEOUT,
    async () => {
      const store = recordingStore({ throwOnPut: true });
      const app = buildApp(stateFor(referenceAi(), store));

      const events = await generate(app);
      const terminal = events.at(-1);
      expect(terminal?.type).toBe('ready');
      // A store failure means no id, but the model itself is delivered regardless.
      if (terminal?.type === 'ready') {
        expect(terminal.galleryId).toBeUndefined();
        expect(terminal.bundle.code.length).toBeGreaterThan(0);
      }
      expect(store.puts).toHaveLength(0);
    },
  );

  it('EDU3D_AUTO_SAVE_GENERATIONS=false saves nothing', TIMEOUT, async () => {
    const store = recordingStore();
    const app = buildApp(stateFor(referenceAi(), store, { EDU3D_AUTO_SAVE_GENERATIONS: 'false' }));

    const events = await generate(app);
    const terminal = events.at(-1);
    expect(terminal?.type).toBe('ready');
    expect(store.puts).toHaveLength(0);
    if (terminal?.type === 'ready') expect(terminal.galleryId).toBeUndefined();
  });

  it(
    'publishing after an auto-save UPDATES that entry instead of adding a second',
    TIMEOUT,
    async () => {
      const store = recordingStore();
      const app = buildApp(stateFor(referenceAi(), store));

      const events = await generate(app);
      const ready = events.at(-1);
      expect(ready?.type).toBe('ready');
      const galleryId = ready?.type === 'ready' ? ready.galleryId : undefined;
      expect(galleryId).toBeDefined();
      expect(store.puts).toHaveLength(1);

      // Publish the same model, targeting the auto-saved id.
      const published = await app.request('/api/gallery', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          bundle: ready?.type === 'ready' ? ready.bundle : undefined,
          galleryId,
        }),
      });
      expect(published.status).toBe(201);
      const { id } = (await published.json()) as { id: string };

      // Same row, not a second one: the publish replaced in place, and returned the same id.
      expect(id).toBe(galleryId);
      const list = (await (await app.request('/api/gallery')).json()) as {
        entries: Array<{ id: string }>;
        total: number;
      };
      expect(list.total).toBe(1);
      expect(list.entries.filter((entry) => entry.id === galleryId)).toHaveLength(1);
    },
  );
});
