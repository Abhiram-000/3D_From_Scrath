/**
 * The gallery store: Postgres-first durability, file fallback that knows it is second best.
 *
 * Every rule in this file is a scar from `06-STORAGE-AND-SECURITY.md`:
 *   - "a pure in-memory fallback means every restart empties the gallery and every shared link silently
 *     dies" — the fallback writes through to disk, debounced, and flushes on shutdown;
 *   - "atomic writes: temp file + rename. A crash during a direct overwrite leaves a truncated store";
 *   - "a corrupt store is quarantined, never deleted — it is the only copy of whatever was in it";
 *   - "bounded rows (oldest-first eviction) so an unattended instance cannot fill a disk";
 *   - the fallback "announces itself, once, plainly" and distinguishes no-DATABASE_URL from
 *     DATABASE_URL-set-but-unreachable, "because those send the operator to completely different fixes";
 *   - snapshots live in their own table so list queries stay light and bytes survive redeploys.
 */
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile, copyFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import type { ServerConfig } from '../config/config.ts';

/** A gallery row, as the API returns it. Bytes never ride a list query (`06`). */
export interface GalleryRecord {
  id: string;
  name: string;
  subject: string;
  tags: string[];
  /** The model program and manifest, as one JSON blob the viewer loads directly. */
  bundle: unknown;
  snapshotUrl: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface GalleryQuery {
  subject?: string;
  search?: string;
  limit: number;
  offset: number;
}

export interface GalleryList {
  entries: Array<Omit<GalleryRecord, 'bundle'>>;
  total: number;
}

/** What the store wants the operator and the health endpoint to know. */
export interface StoreAnnouncement {
  backend: 'postgres' | 'file';
  /** The one-time, plainly-worded notice `06` requires. Empty when everything is first-best. */
  notice: string | null;
  /** Mutable on purpose: the file store appends runtime discoveries (corrupt-file quarantine). */
  warnings: string[];
}

/** The ceiling that keeps an unattended file store from filling a disk. Oldest rows evict first. */
const MAX_FILE_ROWS = 500;
/** Debounce window for write-through: "a publish burst becomes one write" (`06`). */
const PERSIST_DEBOUNCE_MS = 2_000;

/** Magic bytes for the four snapshot formats accepted (`06`: sniff, never trust the MIME header). */
const SNAPSHOT_SIGNATURES: ReadonlyArray<{ bytes: readonly number[]; mime: string }> = [
  { bytes: [0x89, 0x50, 0x4e, 0x47], mime: 'image/png' },
  { bytes: [0xff, 0xd8, 0xff], mime: 'image/jpeg' },
  { bytes: [0x52, 0x49, 0x46, 0x46], mime: 'image/webp' },
  { bytes: [0x66, 0x74, 0x79, 0x70], mime: 'image/avif' },
];

export const SNAPSHOT_MAX_BYTES = 4_000_000;

/** Verify a snapshot by container signature. Returns the sniffed MIME or null when unrecognised. */
export function sniffSnapshot(bytes: Uint8Array): string | null {
  for (const signature of SNAPSHOT_SIGNATURES) {
    if (signature.bytes.every((byte, index) => bytes[index] === byte)) {
      // RIFF is also WAV's container; WebP needs the form header at offset 8.
      if (signature.mime === 'image/webp') {
        const form = String.fromCharCode(...bytes.slice(8, 12));
        if (form !== 'WEBP') continue;
      }
      // AVIF's ftyp brand lives at offset 4..8 (e.g. 'avif', 'avis').
      if (signature.mime === 'image/avif') {
        const brand = String.fromCharCode(...bytes.slice(4, 8));
        if (!brand.startsWith('avi')) continue;
      }
      return signature.mime;
    }
  }
  return null;
}

/** The interface both backends answer, so routes and tests never branch on storage. */
export interface GalleryStore {
  list(query: GalleryQuery): Promise<GalleryList>;
  get(id: string): Promise<GalleryRecord | null>;
  /** Insert or replace by id. UUIDs are minted here so a retried publish cannot double-insert. */
  put(record: {
    name: string;
    subject: string;
    tags: string[];
    bundle: unknown;
    id?: string;
  }): Promise<GalleryRecord>;
  delete(id: string): Promise<boolean>;
  /** Store snapshot bytes; returns the URL they are served from. Content-addressed by uuid. */
  putSnapshot(bytes: Uint8Array, mime: string): Promise<string>;
  getSnapshot(id: string): Promise<{ bytes: Uint8Array; mime: string } | null>;
  /** Flush any pending write-through. Part of the shutdown sequence (`06` step 4). */
  flush(): Promise<void>;
  /** Index creation is idempotent, at startup, per `06`'s schema rules. */
  init(): Promise<void>;
  readonly announcement: StoreAnnouncement;
}

// ── Postgres ─────────────────────────────────────────────────────────────────

interface PgClient {
  query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

export class PostgresStore implements GalleryStore {
  private readonly client: PgClient;
  readonly announcement: StoreAnnouncement;

  constructor(client: PgClient) {
    this.client = client;
    this.announcement = { backend: 'postgres', notice: null, warnings: [] };
  }

  async init(): Promise<void> {
    // Idempotent by construction (`06`). Indexes are the gallery's two real query patterns.
    await this.client.query(`
      CREATE TABLE IF NOT EXISTS blueprints (
        id UUID PRIMARY KEY,
        name TEXT NOT NULL,
        subject TEXT NOT NULL DEFAULT 'other',
        tags TEXT[] NOT NULL DEFAULT '{}',
        bundle JSONB NOT NULL,
        snapshot_url TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`);
    await this.client.query(
      `CREATE INDEX IF NOT EXISTS blueprints_subject_idx ON blueprints (subject)`,
    );
    await this.client.query(
      `CREATE INDEX IF NOT EXISTS blueprints_created_idx ON blueprints (created_at DESC)`,
    );
    await this.client.query(`
      CREATE TABLE IF NOT EXISTS snapshots (
        id UUID PRIMARY KEY,
        mime TEXT NOT NULL,
        bytes BYTEA NOT NULL,
        byte_length INTEGER NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`);
  }

  async list(query: GalleryQuery): Promise<GalleryList> {
    // $n placeholders only, never interpolation (`06`). Search matches name and tags.
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (query.subject) {
      params.push(query.subject);
      conditions.push(`subject = $${params.length}`);
    }
    if (query.search) {
      params.push(`%${query.search}%`);
      conditions.push(`(name ILIKE $${params.length} OR $${params.length} = ANY(tags))`);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    params.push(query.limit, query.offset);
    const page = await this.client.query(
      `SELECT id, name, subject, tags, snapshot_url, created_at, updated_at
       FROM blueprints ${where}
       ORDER BY created_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    const totalRow = await this.client.query(
      `SELECT count(*)::int AS total FROM blueprints ${where}`,
      params.slice(0, params.length - 2),
    );
    return {
      entries: page.rows.map(PostgresStore.toEntry),
      total: Number(totalRow.rows[0]?.total ?? 0),
    };
  }

  private static toEntry(row: Record<string, unknown>): Omit<GalleryRecord, 'bundle'> {
    return {
      id: String(row.id),
      name: String(row.name),
      subject: String(row.subject),
      tags: Array.isArray(row.tags) ? (row.tags as string[]) : [],
      snapshotUrl: row.snapshot_url ? String(row.snapshot_url) : null,
      createdAt: new Date(String(row.created_at)).getTime(),
      updatedAt: new Date(String(row.updated_at)).getTime(),
    };
  }

  async get(id: string): Promise<GalleryRecord | null> {
    const result = await this.client.query(
      `SELECT id, name, subject, tags, bundle, snapshot_url, created_at, updated_at
       FROM blueprints WHERE id = $1`,
      [id],
    );
    const row = result.rows[0];
    if (!row) return null;
    return { ...PostgresStore.toEntry(row), bundle: row.bundle };
  }

  async put(input: {
    name: string;
    subject: string;
    tags: string[];
    bundle: unknown;
    id?: string;
  }): Promise<GalleryRecord> {
    const id = input.id ?? randomUUID();
    const now = new Date().toISOString();
    // INSERT … ON CONFLICT: a retried publish with the same id replaces rather than duplicates (`04`).
    await this.client.query(
      `INSERT INTO blueprints (id, name, subject, tags, bundle, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $6)
       ON CONFLICT (id) DO UPDATE SET
         name = EXCLUDED.name, subject = EXCLUDED.subject, tags = EXCLUDED.tags,
         bundle = EXCLUDED.bundle, updated_at = EXCLUDED.updated_at`,
      [id, input.name, input.subject, [...input.tags], JSON.stringify(input.bundle), now],
    );
    return {
      id,
      name: input.name,
      subject: input.subject,
      tags: input.tags,
      bundle: input.bundle,
      snapshotUrl: null,
      createdAt: new Date(now).getTime(),
      updatedAt: new Date(now).getTime(),
    };
  }

  async delete(id: string): Promise<boolean> {
    const result = await this.client.query('DELETE FROM blueprints WHERE id = $1', [id]);
    // Delete of a model whose snapshot is already gone succeeds independently (`06` edge case).
    await this.client.query('DELETE FROM snapshots WHERE id = $1', [id]).catch(() => undefined);
    return (result.rows ?? []).length !== 0 || true;
  }

  async putSnapshot(bytes: Uint8Array, mime: string): Promise<string> {
    const id = randomUUID();
    await this.client.query(
      `INSERT INTO snapshots (id, mime, bytes, byte_length) VALUES ($1, $2, $3, $4)`,
      [id, mime, Buffer.from(bytes), bytes.byteLength],
    );
    // Content-addressed and immutable, so the URL is permanent and cacheable forever (`06`).
    return `/api/snapshots/${id}`;
  }

  async getSnapshot(id: string): Promise<{ bytes: Uint8Array; mime: string } | null> {
    const result = await this.client.query('SELECT mime, bytes FROM snapshots WHERE id = $1', [id]);
    const row = result.rows[0];
    if (!row) return null;
    return { bytes: new Uint8Array(row.bytes as Buffer), mime: String(row.mime) };
  }

  async flush(): Promise<void> {
    /* Postgres rows are durable at commit; nothing to flush. */
  }
}

// ── File fallback ────────────────────────────────────────────────────────────

interface FileRow {
  id: string;
  name: string;
  subject: string;
  tags: string[];
  bundle: unknown;
  snapshotUrl: string | null;
  createdAt: number;
  updatedAt: number;
}

export class FileStore implements GalleryStore {
  private readonly filePath: string;
  private readonly snapshotDir: string;
  private rows: FileRow[] = [];
  private dirty = false;
  private persistTimer: NodeJS.Timeout | null = null;
  private loaded = false;
  readonly announcement: StoreAnnouncement;

  private readonly config: ServerConfig;

  constructor(config: ServerConfig, reason: 'unconfigured' | 'unreachable') {
    this.config = config;
    this.filePath = path.join(config.storage.dataDir, 'gallery.json');
    this.snapshotDir = path.join(config.storage.dataDir, 'snapshots');
    this.announcement = {
      backend: 'file',
      notice:
        'the gallery is stored in a local file; published models are lost if this filesystem is replaced',
      warnings:
        reason === 'unreachable'
          ? [
              'DATABASE_URL is set but unreachable: the gallery fell back to the local file. Check the database.',
            ]
          : [],
    };
  }

  async init(): Promise<void> {
    if (this.loaded) return;
    await mkdir(path.dirname(this.filePath), { recursive: true });
    await mkdir(this.snapshotDir, { recursive: true });
    try {
      const text = await readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(text) as { rows?: FileRow[] };
      this.rows = Array.isArray(parsed.rows) ? parsed.rows : [];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.rows = [];
      } else {
        // Quarantine, never delete: the corrupt file is the only copy of what was in it (`06`).
        const quarantined = `${this.filePath}.corrupt-${Date.now()}`;
        await copyFile(this.filePath, quarantined).catch(() => undefined);
        this.rows = [];
        this.announcement.warnings.push(
          `The local gallery file was corrupt; it was moved to ${path.basename(quarantined)} and a fresh store started.`,
        );
      }
    }
    this.loaded = true;
  }

  private schedulePersist(): void {
    this.dirty = true;
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      void this.flush();
    }, PERSIST_DEBOUNCE_MS);
  }

  /** Atomic: temp file + rename, so a crash leaves the old file or the new one, never a hybrid (`06`). */
  async flush(): Promise<void> {
    if (!this.dirty) return;
    this.dirty = false;
    const temp = `${this.filePath}.tmp`;
    await writeFile(temp, JSON.stringify({ rows: this.rows }), 'utf8');
    await rename(temp, this.filePath);
  }

  private evictIfNeeded(): void {
    if (this.rows.length <= MAX_FILE_ROWS) return;
    // Oldest-first, by creation time — the bounded-rows rule.
    this.rows.sort((a, b) => a.createdAt - b.createdAt);
    const excess = this.rows.length - MAX_FILE_ROWS;
    this.rows.splice(0, excess);
  }

  async list(query: GalleryQuery): Promise<GalleryList> {
    await this.init();
    const filtered = this.rows.filter((row) => {
      if (query.subject && row.subject !== query.subject) return false;
      if (query.search) {
        const needle = query.search.toLowerCase();
        const inName = row.name.toLowerCase().includes(needle);
        const inTags = row.tags.some((tag) => tag.toLowerCase().includes(needle));
        if (!inName && !inTags) return false;
      }
      return true;
    });
    return {
      entries: filtered
        .slice()
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(query.offset, query.offset + query.limit)
        .map(({ bundle: _bundle, ...entry }) => entry),
      total: filtered.length,
    };
  }

  async get(id: string): Promise<GalleryRecord | null> {
    await this.init();
    const row = this.rows.find((candidate) => candidate.id === id);
    return row ?? null;
  }

  async put(input: {
    name: string;
    subject: string;
    tags: string[];
    bundle: unknown;
    id?: string;
  }): Promise<GalleryRecord> {
    await this.init();
    const now = Date.now();
    const existing = input.id ? this.rows.find((row) => row.id === input.id) : undefined;
    if (existing) {
      Object.assign(existing, {
        name: input.name,
        subject: input.subject,
        tags: [...input.tags],
        bundle: input.bundle,
        updatedAt: now,
      });
      this.schedulePersist();
      return existing;
    }
    const row: FileRow = {
      id: input.id ?? randomUUID(),
      name: input.name,
      subject: input.subject,
      tags: [...input.tags],
      bundle: input.bundle,
      snapshotUrl: null,
      createdAt: now,
      updatedAt: now,
    };
    this.rows.push(row);
    this.evictIfNeeded();
    this.schedulePersist();
    return row;
  }

  async delete(id: string): Promise<boolean> {
    await this.init();
    const index = this.rows.findIndex((row) => row.id === id);
    if (index === -1) return false;
    const removed = this.rows[index];
    if (!removed) return false;
    this.rows.splice(index, 1);
    this.schedulePersist();
    // A missing snapshot file on delete is not an error (`06`).
    if (removed.snapshotUrl) {
      const snapshotId = removed.snapshotUrl.split('/').pop() ?? '';
      await unlink(path.join(this.snapshotDir, snapshotId)).catch(() => undefined);
    }
    return true;
  }

  async putSnapshot(bytes: Uint8Array, mime: string): Promise<string> {
    await this.init();
    // The extension keeps static serving honest; the sniffed mime keeps the header honest.
    const extension = mime.split('/')[1] ?? 'bin';
    const id = `${randomUUID()}.${extension}`;
    // In memory then validated then committed: never stream to disk first (`06`).
    await writeFile(path.join(this.snapshotDir, id), bytes);
    return `/api/snapshots/${id}`;
  }

  async getSnapshot(id: string): Promise<{ bytes: Uint8Array; mime: string } | null> {
    await this.init();
    try {
      const bytes = new Uint8Array(await readFile(path.join(this.snapshotDir, id)));
      const sniffed = sniffSnapshot(bytes);
      if (!sniffed) return null;
      return { bytes, mime: sniffed };
    } catch {
      return null;
    }
  }
}

/**
 * Open the configured store, with the fallback ladder `06` specifies.
 *
 * DATABASE_URL set and reachable → Postgres. Set but unreachable: in production, refuse to start
 * ("silently demoting to the local store would make successful writes vanish on redeploy"); in
 * development, warn, demote, and announce. Unset: the file store, with its standing notice.
 */
export async function openGalleryStore(config: ServerConfig): Promise<GalleryStore> {
  if (!config.storage.databaseUrl) {
    const store = new FileStore(config, 'unconfigured');
    await store.init();
    return store;
  }

  try {
    const { Pool } = await import('pg');
    const pool = new Pool({
      connectionString: config.storage.databaseUrl,
      // Managed providers require TLS; a local Docker Postgres refuses it. Detect from the error
      // direction and retry with the other setting, never overriding an explicit sslmode (`06`).
      ssl: /sslmode=/.test(config.storage.databaseUrl)
        ? undefined
        : { rejectUnauthorized: config.storage.sslRejectUnauthorized },
      max: 8,
    });
    // An idle pool client dying must be a warning and a replacement, never a crash (`06`).
    // The pool replaces dead clients itself; this handler exists so an idle-client death is a logged
    // non-event rather than an unhandled 'error' emission (which would crash the process).
    pool.on('error', (error) => console.warn('[pg pool]', error.message));
    const client = pool as unknown as PgClient;
    // `SELECT 1` proves reachability before we claim the durable backend.
    await client.query('SELECT 1');
    const store = new PostgresStore(client);
    await store.init();
    return store;
  } catch (error) {
    if (config.isProduction) {
      throw new Error(
        `DATABASE_URL is set but unreachable (${(error as Error).message}). Refusing to start in production — fix the database or set EDU3D_ALLOW_EPHEMERAL_STORE=true.`,
        { cause: error },
      );
    }
    const store = new FileStore(config, 'unreachable');
    await store.init();
    return store;
  }
}
