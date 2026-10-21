/**
 * Route-level tests: the middleware chain `buildApp` builds actually reaches a response with what
 * the routes claim.
 *
 * This repo had NO route-level tests when a global-middleware defect shipped (the production CSP
 * broke every browser-side model build and nothing failed anywhere). These tests drive
 * `app.request(...)` through the real chain: the CSP per surface, the write-token posture, the
 * health exemption from the API limiter, the request-body ceiling, and the snapshot id shapes both
 * storage backends accept. A unit test over a string constant only ever tested a string constant
 * against itself; these test the response.
 */
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type z } from 'zod';
import { ModelBundle } from '@edu3d/contracts';
import { REFERENCE_MODEL_SOURCE, apiSurfaceSet } from '@edu3d/engine';
import { prepareProgram } from '@edu3d/sandbox';
import { buildApp, type AppState } from '../src/app.ts';
import { resolveConfig } from '../src/config/config.ts';
import { auditModel } from '../src/services/audit.ts';
import type { AiClient } from '../src/services/ai-client.ts';
import {
  FileStore,
  type GalleryStore,
  type StoreAnnouncement,
} from '../src/services/gallery-store.ts';
import { buildLimiters } from '../src/services/rate-limits.ts';
import type { Hono } from 'hono';

/** The two policies responses must carry, written here by hand — independent of the source. */
const DOCUMENT_POLICY =
  "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; " +
  "worker-src 'self' blob:; frame-ancestors 'self'; base-uri 'self'; form-action 'self'";
const WORKER_POLICY = DOCUMENT_POLICY.replace(
  "script-src 'self' 'unsafe-inline'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
);

/** Where the built frontend lives for the static-serving assertions, when a build exists at all. */
const WORKERS_DIR = fileURLToPath(
  new URL('../../web/build/_app/immutable/workers/', import.meta.url),
);

/**
 * The publish bundle fixture, minted once per run.
 *
 * Deliberately hand-built from the contracts instead of through `runPipeline`: the authoring pass
 * (packages/engine, apps/server's audit worker) is another lane's in-flight work in this shared
 * tree, and these route tests must not inherit its transient state. Every field the schema does
 * NOT default is present, so the fixture is a real `ModelBundle` — validated below with the same
 * schema `PublishRequest` re-parses.
 */
type Bundle = z.infer<typeof ModelBundle>;
let referenceBundle: Bundle;
/** The real engine-authored bundle: gate + instrument + headless audit of the shipped reference. */
let turbofanBundle: Bundle;

/** One temp root per run: the file store writes here across every suite in this file. */
let dataDir: string;

afterAll(async () => {
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
});

beforeAll(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), 'edu3d-app-test-'));
  const validated = ModelBundle.safeParse({
    manifest: {
      formatVersion: 1,
      name: 'Reference turbofan',
      description: 'A one-part stand-in for the engine reference model, built to the contracts.',
      domain: 'mechanics',
      pedagogy: {
        concept: 'How air moves through a turbofan engine',
        objectives: ['Name the fan and core sections of a turbofan engine.'],
      },
      parts: [
        {
          id: 'Fancase',
          parentId: null,
          kind: 'mesh',
          name: 'Fan case',
          transform: { position: [0, 0, 0], scale: [1, 1, 1] },
          geometry: {
            builder: 'mesh',
            cacheKey: 'turbofan-fan-case-1',
            triangles: 12,
            vertices: 8,
          },
        },
      ],
      camera: { initial: { position: [4, 2, 4], target: [0, 0, 0] } },
      cost: {
        parts: 1,
        uniqueGeometries: 1,
        uniqueMaterials: 1,
        triangles: 12,
        vertices: 8,
        drawCalls: 1,
        instancedSets: 0,
        instances: 0,
        shadowCastingLights: 0,
        physicsBodies: 0,
        authorMillis: 1,
      },
      createdAt: 1_700_000_000_000,
    },
    code: REFERENCE_MODEL_SOURCE,
  });
  if (!validated.success) {
    throw new Error(
      `fixture must be schema-valid: ${validated.error.issues
        .slice(0, 4)
        .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
        .join('; ')}`,
    );
  }
  // HISTORY (B1b, now fixed): this fixture's real-world counterpart — the pipeline's authoring
  // output — used to be NOT this clean: the engine's structural geometry keying produced a
  // marching-cubes `geometry.cacheKey` of 3114 chars on the reference turbofan while `contracts`
  // caps `cacheKey` at 512, so a REAL pipeline bundle failed `ModelBundle`/`PublishRequest`
  // parsing and could not be published at all. The engine now emits contract-bounded keys; the
  // `turbofanBundle` fixture below publishes what the engine really authors, not this stand-in.
  referenceBundle = validated.data;

  // The REAL publish fixture: authored by the engine exactly the way the pipeline authors a
  // generated model (gate + instrument, then the headless audit). The hand-built fixture above
  // can never catch B1b — its cache keys are invented strings — while this one carries whatever
  // the engine actually emitted, including any over-cap structural key.
  const prepared = prepareProgram(REFERENCE_MODEL_SOURCE, { apiSurface: apiSurfaceSet() });
  if (!prepared.ok) {
    throw new Error(
      `the reference turbofan must pass the gate: ${JSON.stringify(prepared.gate).slice(0, 300)}`,
    );
  }
  const built = auditModel({ code: prepared.instrumented, tier: 'mid', seed: 7 });
  if (!built.ok) {
    throw new Error(`the reference turbofan must audit clean: ${built.message}`);
  }
  const rawBundle = {
    manifest: built.manifest,
    code: prepared.code,
    runtime: prepared.instrumented,
    provenance: { topic: 'a turbofan engine' },
  };
  const authored = ModelBundle.safeParse(rawBundle);
  if (!authored.success) {
    // Deliberately NOT fatal: the publish test below drives the raw bundle through the real route,
    // so the failure shows up as the route's own 400 — the honest RED evidence — instead of a
    // fixture-build throw that never reaches the wire.
    console.warn(
      `[fixture] a real engine manifest is not publishable as-is: ${authored.error.issues
        .slice(0, 4)
        .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
        .join('; ')}`,
    );
  }
  turbofanBundle = (authored.success
    ? authored.data
    : rawBundle) as unknown as typeof referenceBundle;
});

/** A publish snapshot the sniff accepts: the PNG magic is the header, nothing more is needed. */
const pngBytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const pngDataUrl = `data:image/png;base64,${Buffer.from(pngBytes).toString('base64')}`;

/** An AI client whose `complete` is never touched by these routes, so a call would be loud. */
const neverAi = {
  complete: async () => {
    throw new Error('no AI call should happen in these tests');
  },
} as unknown as AiClient;

type TestApp = Hono<{ Variables: { requestId: string; state: AppState } }>;

/** Build the app from one env, with the file store rooted at this run's temp dir. */
function appFor(
  env: Record<string, string | undefined>,
  ai: AiClient = neverAi,
): {
  app: TestApp;
  state: AppState;
} {
  const config = resolveConfig({ EDU3D_DATA_DIR: dataDir, ...env });
  const state: AppState = {
    config,
    ai,
    store: new FileStore(config, 'unconfigured'),
    limiters: buildLimiters(config),
    draining: false,
    openStreams: 0,
    startedAt: Date.now(),
    remoteAddress: '127.0.0.1',
  };
  return { app: buildApp(state) as TestApp, state };
}

/**
 * A store that records how routes call `getSnapshot` — the Postgres stand-in — so the exact id the
 * route chooses is observed, not inferred from a 404.
 */
function recordingStore(backend: 'postgres'): GalleryStore & { receivedIds: string[] } {
  const receivedIds: string[] = [];
  return {
    receivedIds,
    list: async () => ({ entries: [], total: 0 }),
    get: async () => null,
    put: async () => {
      throw new Error('not used here');
    },
    delete: async () => false,
    putSnapshot: async () => {
      throw new Error('not used here');
    },
    getSnapshot: async (id: string) => {
      receivedIds.push(id);
      return { bytes: pngBytes, mime: 'image/png' };
    },
    flush: async () => {},
    close: async () => {},
    init: async () => {},
    announcement: { backend, notice: null, warnings: [] } as StoreAnnouncement,
  } as unknown as GalleryStore & { receivedIds: string[] };
}

const bodyOf = async (response: Response): Promise<{ error?: { code?: string } }> => {
  try {
    return (await response.json()) as { error?: { code?: string } };
  } catch {
    return {};
  }
};

describe('the served CSP', () => {
  const enforceEnv = { EDU3D_CSP: 'enforce' } as Record<string, string | undefined>;

  it('document routes carry the document policy, verbatim', async () => {
    const { app } = appFor(enforceEnv);
    for (const route of ['/', '/viewer']) {
      const response = await app.request(route);
      expect(response.headers.get('content-security-policy'), route).toBe(DOCUMENT_POLICY);
      expect(response.headers.get('content-security-policy-report-only'), route).toBe(
        DOCUMENT_POLICY,
      );
    }
  });

  it('the worker chunk response carries the worker policy — the allowance the compiler requires', async () => {
    // Route-level regression guard over a real build: if the served worker response loses the
    // eval allowance it needs, every model dies with EvalError in production again.
    const files = await readdir(WORKERS_DIR).catch(() => [] as string[]);
    const workers = files.filter(
      (name) => name.startsWith('sandbox-worker-') && name.endsWith('.js'),
    );
    expect(workers.length, 'no built sandbox-worker chunk in apps/web/build').toBeGreaterThan(0);
    const { app } = appFor(enforceEnv);
    for (const name of workers) {
      const response = await app.request(`/_app/immutable/workers/${name}`);
      expect(response.status, name).toBe(200);
      expect(response.headers.get('content-security-policy'), name).toBe(WORKER_POLICY);
      expect(response.headers.get('content-security-policy-report-only'), name).toBe(WORKER_POLICY);
    }
  });

  it('a report-only deployment observes instead of enforcing', async () => {
    const { app } = appFor({ EDU3D_CSP: 'report-only' });
    const response = await app.request('/viewer');
    expect(response.headers.get('content-security-policy')).toBeNull();
    expect(response.headers.get('content-security-policy-report-only')).toBe(DOCUMENT_POLICY);
  });
});

describe('the write posture', () => {
  const productionEnv = {
    NODE_ENV: 'production',
    TRUST_PROXY: '1',
    DATABASE_URL: 'postgres://user:pass@db.example/edu3d',
    AI_API_KEY: 'test-key',
    PUBLIC_ORIGIN: 'https://edu3d.example',
  } as Record<string, string | undefined>;

  it('denies anonymous writes in production with no token and no acceptance (fail closed)', async () => {
    // RED evidence target: before the fix this route answered 201 and the same anonymous caller
    // could delete the whole gallery.
    const { app } = appFor(productionEnv);
    const published = await app.request('/api/gallery', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ bundle: referenceBundle }),
    });
    expect(published.status).toBe(401);
    expect((await bodyOf(published)).error?.code).toBe('unauthorized');
  });

  it('denies anonymous delete in production with no token and no acceptance', async () => {
    const { app } = appFor(productionEnv);
    const response = await app.request('/api/gallery/0e4c669b-8a17-4f15-a159-3cbe4d1e2441', {
      method: 'DELETE',
    });
    expect(response.status).toBe(401);
    expect((await bodyOf(response)).error?.code).toBe('unauthorized');
  });

  it('a token-protected deployment publishes with its bearer and refuses without it', async () => {
    const token = 's3cret-classroom-token';
    const { app } = appFor({ ...productionEnv, EDU3D_WRITE_TOKEN: token });

    const refused = await app.request('/api/gallery', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ bundle: referenceBundle }),
    });
    expect(refused.status, 'no header').toBe(401);

    const wrong = await app.request('/api/gallery', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer wrong' },
      body: JSON.stringify({ bundle: referenceBundle }),
    });
    expect(wrong.status, 'wrong token').toBe(401);
    expect((await bodyOf(wrong)).error?.code).toBe('unauthorized');

    const accepted = await app.request('/api/gallery', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ bundle: referenceBundle }),
    });
    expect(accepted.status, 'right token').toBe(201);
    const { id } = (await accepted.json()) as { id: string };

    // The enumerate-and-delete path an anonymous caller could otherwise take, both directions.
    const unauthenticatedDelete = await app.request(`/api/gallery/${id}`, { method: 'DELETE' });
    expect(unauthenticatedDelete.status).toBe(401);
    const authenticatedDelete = await app.request(`/api/gallery/${id}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(authenticatedDelete.status).toBe(200);
  });

  it('explicit acceptance keeps open writes possible in production, and the token absent', async () => {
    const { app } = appFor({ ...productionEnv, EDU3D_ALLOW_OPEN_WRITES: 'true' });
    const response = await app.request('/api/gallery', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ bundle: referenceBundle }),
    });
    expect(response.status).toBe(201);
  });

  it('development keeps its open local posture', async () => {
    const { app } = appFor({});
    const response = await app.request('/api/gallery', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ bundle: referenceBundle }),
    });
    expect(response.status).toBe(201);
  });
});

describe('health and readiness are exempt from the API limiter', () => {
  const limiterEnv = { EDU3D_API_RATE_LIMIT: '2' } as Record<string, string | undefined>;

  it('/api/health never rate-limits, whatever else shares the budget', async () => {
    const { app } = appFor(limiterEnv);
    for (let i = 0; i < 5; i += 1) {
      const response = await app.request('/api/health');
      expect(response.status, `probe ${i + 1}`).toBe(200);
    }
  });

  it('/api/ready never rate-limits either', async () => {
    const { app } = appFor(limiterEnv);
    for (let i = 0; i < 5; i += 1) {
      const response = await app.request('/api/ready');
      expect(response.status, `probe ${i + 1}`).toBe(200);
    }
  });

  it('the limiter still collects the rest of /api', async () => {
    const { app } = appFor(limiterEnv);
    for (let i = 0; i < 2; i += 1) {
      const response = await app.request('/api/gallery');
      expect(response.status, `allowed ${i + 1}`).toBe(200);
    }
    const limited = await app.request('/api/gallery');
    expect(limited.status).toBe(429);
    expect((await bodyOf(limited)).error?.code).toBe('rate_limited');
  });
});

describe('the request-body ceiling', () => {
  const limiterEnv = { EDU3D_RATE_LIMIT: '6000', EDU3D_API_RATE_LIMIT: '6000' } as Record<
    string,
    string | undefined
  >;

  it('refuses an oversized body with the standard envelope before parsing it', async () => {
    const limitBytes = 8 * 1024 * 1024;
    const { app } = appFor(limiterEnv);
    // Exactly one byte over the ceiling, declared honestly in the length header — which is the
    // input `hono/body-limit` can refuse without reading a single body byte.
    const huge = Buffer.alloc(limitBytes + 1, 0x78).toString('utf8');
    const response = await app.request('/api/generate', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': String(huge.length) },
      body: huge,
    });
    expect(response.status).toBe(413);
    expect((await bodyOf(response)).error?.code).toBe('too_large');
  });

  it('an undeclared oversized body is also refused (chunked, by streaming count)', async () => {
    const limitBytes = 8 * 1024 * 1024;
    const { app } = appFor(limiterEnv);
    const huge = Buffer.alloc(limitBytes + 1, 0x78).toString('utf8');
    const response = await app.request('/api/generate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: huge,
    });
    expect(response.status).toBe(413);
  });

  it('lets a normal body through and answers from the pipeline gate, not the ceiling', async () => {
    const { app } = appFor(limiterEnv);
    const response = await app.request('/api/generate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ topic: 'a turbofan engine' }),
    });
    // No AI key in this environment → 503 capability_absent is the honest answer. A 413 here would
    // mean the ceiling swallowed legitimate traffic.
    expect(response.status).toBe(503);
    expect((await bodyOf(response)).error?.code).toBe('capability_absent');
  });
});

describe('snapshots round-trip through both stores', () => {
  it('the file store serves the snapshot the publish returned the URL for', async () => {
    const { app } = appFor({});
    const published = await app.request('/api/gallery', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ bundle: referenceBundle, snapshot: pngDataUrl }),
    });
    expect(published.status).toBe(201);
    const { id } = (await published.json()) as { id: string };

    // The POINTER lives on the record itself, not buried inside the bundle (B3): the gallery list
    // renders `entry.snapshotUrl`, so a publish that stored a snapshot must make it appear there.
    const record = (await (await app.request(`/api/gallery/${id}`)).json()) as {
      snapshotUrl: string | null;
    };
    expect(record.snapshotUrl).toMatch(/^\/api\/snapshots\//);

    const list = (await (await app.request('/api/gallery')).json()) as {
      entries: Array<{ id: string; snapshotUrl: string | null }>;
    };
    const entry = list.entries.find((candidate) => candidate.id === id);
    expect(entry?.snapshotUrl).toBe(record.snapshotUrl);

    const snapshot = await app.request(record.snapshotUrl ?? '');
    expect(snapshot.status).toBe(200);
    expect(snapshot.headers.get('content-type')).toBe('image/png');
    // Same bytes in, same bytes out: the URL the store minted works as-is.
    expect(Buffer.from(new Uint8Array(await snapshot.arrayBuffer()))).toEqual(
      Buffer.from(pngBytes),
    );
  });

  it('the Postgres store is asked for the bare uuid the URL carries an extension over', async () => {
    const store = recordingStore('postgres');
    const config = resolveConfig({ EDU3D_DATA_DIR: dataDir });
    const state: AppState = {
      config,
      ai: neverAi,
      store,
      limiters: buildLimiters(config),
      draining: false,
      openStreams: 0,
      startedAt: Date.now(),
      remoteAddress: '127.0.0.1',
    };
    const app = buildApp(state);
    const response = await app.request('/api/snapshots/7d1f6f2e-1111-4bbb-8ccc-9f0a2b3c4d5e.png');
    expect(response.status).toBe(200);
    expect(store.receivedIds).toEqual(['7d1f6f2e-1111-4bbb-8ccc-9f0a2b3c4d5e']);
  });

  it('traversal probes are refused, not resolved', async () => {
    const { app } = appFor({});
    const response = await app.request('/api/snapshots/..%2f..%2fgallery.json');
    expect(response.status).toBe(404);
  });
});

describe('behind a trusted proxy, headers cannot rotate the limiter bucket', () => {
  it('per-request forged lines share one bucket — the appended entry is the identity', async () => {
    // What a single appending edge delivers on the wire: `<whatever the client wrote>, ` +
    // the real client address it received from. The appended entry is constant; the forged
    // prefix rotates. The bucket key must not follow the rotation.
    const { app, state } = appFor({ EDU3D_API_RATE_LIMIT: '3', TRUST_PROXY: '1' });
    let limited = 0;
    for (let i = 0; i < 6; i += 1) {
      const response = await app.request('/api/gallery', {
        headers: { 'x-forwarded-for': `10.9.${i}.9, 198.51.100.5` },
      });
      if (response.status === 429) limited += 1;
    }
    // Cap is 3/min on one key: three pass, three are refused. Before the fix the forged line WAS
    // the key, all six passed, and the same gap opened the generate limiter (unlimited AI spend).
    expect(limited).toBe(3);
    expect(state.limiters.api.size).toBe(1);
  });
});

describe('publishing what the engine really authors', () => {
  it('the reference turbofan — with every cache key the engine emitted — publishes', async () => {
    // B1b regression: the engine's structural keys were unbounded JSON (3,114 chars on this very
    // model's swept bypass ribbon) while `GeometryRef.cacheKey` caps at 512, so `POST /api/gallery`
    // answered 400 to the platform's own exemplar. The engine must emit contract-bounded keys.
    const { app } = appFor({});
    const published = await app.request('/api/gallery', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ bundle: turbofanBundle, snapshot: pngDataUrl }),
    });
    expect(published.status, JSON.stringify(await published.json())).toBe(201);

    // And the stored record still says the model it is: the snapshot pointer on the record, not
    // buried in the bundle, and every emitted cache key within the contract's bound.
    const list = (await (await app.request('/api/gallery')).json()) as {
      entries: Array<{ id: string; snapshotUrl: string | null; name: string }>;
    };
    const entry = list.entries[0];
    expect(entry?.snapshotUrl).toMatch(/^\/api\/snapshots\//);
    expect(entry?.name).toMatch(/turbofan/i);

    const record = (await (await app.request(`/api/gallery/${entry?.id ?? ''}`)).json()) as {
      snapshotUrl: string | null;
      bundle: { manifest: { parts: Array<{ geometry?: { cacheKey: string } }> } };
    };
    expect(record.snapshotUrl).toMatch(/^\/api\/snapshots\//);
    const keys = record.bundle.manifest.parts.flatMap((part) =>
      part.geometry ? [part.geometry.cacheKey] : [],
    );
    expect(keys.length).toBeGreaterThan(0);
    for (const cacheKey of keys) {
      expect(cacheKey.length, cacheKey.slice(0, 64)).toBeLessThanOrEqual(512);
    }
  });

  it('the reader-proven gallery shows the turbofan by name', async () => {
    const { app } = appFor({});
    await app.request('/api/gallery', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ bundle: turbofanBundle }),
    });
    const list = (await (await app.request('/api/gallery')).json()) as {
      entries: Array<{ name: string }>;
    };
    expect(list.entries[0]?.name).toMatch(/turbofan/i);
  });
});

describe('correlation ids reach the responses that bypass context.json', () => {
  it('the generate NDJSON stream carries x-request-id', async () => {
    // The route-built `new Response(...)` does not inherit the middleware's c.header — the fixing
    // evidence: before B6 this asserted null while every JSON route had the header.
    const { app } = appFor({ AI_API_KEY: 'test-key' });
    const response = await app.request('/api/generate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ topic: 'a turbofan engine', stream: true }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/x-ndjson');
    expect(response.headers.get('x-request-id')).toBeTruthy();

    const firstEvent = JSON.parse((await response.text()).split('\n')[0] ?? '{}') as {
      type?: string;
    };
    expect(firstEvent.type).toBe('phase');
  });

  it('the chat NDJSON stream carries x-request-id', async () => {
    const chattyAi = {
      complete: async () => ({ ok: true, text: 'Because the fan pushes air.' }),
    } as unknown as AiClient;
    const { app } = appFor({ AI_API_KEY: 'test-key' }, chattyAi);
    const response = await app.request('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'why does the fan spin?', stream: true }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/x-ndjson');
    expect(response.headers.get('x-request-id')).toBeTruthy();
    await response.text();
  });

  it('the snapshot response carries x-request-id', async () => {
    const { app } = appFor({});
    const published = await app.request('/api/gallery', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ bundle: referenceBundle, snapshot: pngDataUrl }),
    });
    expect(published.status).toBe(201);
    const { id } = (await published.json()) as { id: string };
    const record = (await (await app.request(`/api/gallery/${id}`)).json()) as {
      snapshotUrl: string | null;
    };
    const snapshot = await app.request(record.snapshotUrl ?? '');
    expect(snapshot.status).toBe(200);
    expect(snapshot.headers.get('x-request-id')).toBeTruthy();
  });
});

describe('the CSP follows the configured origins', () => {
  it('a split deployment (PUBLIC_ORIGIN set) adds the origin to connect-src', async () => {
    const { app } = appFor({
      EDU3D_CSP: 'enforce',
      PUBLIC_ORIGIN: 'https://edu3d.example',
    });
    const response = await app.request('/viewer');
    const policy = response.headers.get('content-security-policy');
    expect(policy).toContain("connect-src 'self' https://edu3d.example");
  });

  it('same-origin deployments keep the strict shipped policy untouched', async () => {
    const { app } = appFor({ EDU3D_CSP: 'enforce' });
    const response = await app.request('/viewer');
    const policy = response.headers.get('content-security-policy');
    expect(policy).toContain("connect-src 'self';");
    expect(policy).not.toContain('edu3d.example');
  });
});
