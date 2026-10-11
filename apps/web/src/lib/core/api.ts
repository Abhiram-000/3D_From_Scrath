/**
 * The browser's client for the backend API.
 *
 * One module owns every `fetch` the web app makes, because streaming discipline is easy to lose when
 * it is copied between call sites (`04`: heartbeats, terminal-event guarantees, stall detection). The
 * loading page and the viewer's Generate dialog both go through `generateStream`, which is why the
 * previous version's bug — the two entries behaving differently for the same action — cannot recur
 * here.
 */
import { STALL_HEARTBEATS, HEARTBEAT_INTERVAL_MS, type GenerationEvent, type ModelBundle } from '@edu3d/contracts';

/** Where the API lives. The dev proxy and production same-origin both answer at `/api`. */
export const API_BASE = '/api';

/** The server sends a heartbeat every ~10s; 4 missed beats is a stall, not a slow provider (`04`). */
export const STALL_TIMEOUT_MS = STALL_HEARTBEATS * HEARTBEAT_INTERVAL_MS;
/** An absolute ceiling: progress or not, no run outlives this (`04` idle watchdog complement). */
export const TOTAL_TIMEOUT_MS = 6 * 60_000;

export interface GenerateOptions {
  topic: string;
  complexity?: 'simple' | 'balanced' | 'detailed' | 'maximum';
  tier?: 'low' | 'mid' | 'high';
  signal?: AbortSignal;
  onEvent?: (event: GenerationEvent) => void;
}

export type GenerateOutcome =
  | { ok: true; bundle: ModelBundle; audit?: { score: number; deficiencies: string[] } }
  | { ok: false; code: string; message: string; retryAfterSeconds?: number };

/**
 * Run a generation, consuming the NDJSON stream.
 *
 * Every event — heartbeats included — proves the run is alive, so the stall detector measures from
 * the last event rather than from a wall clock. A stream that ends without a terminal event is itself
 * a failure (`04`), which is the one case the provider's own error handling cannot produce for us.
 */
export async function generateStream(options: GenerateOptions): Promise<GenerateOutcome> {
  const controller = new AbortController();
  const abortOuter = () => controller.abort();
  options.signal?.addEventListener('abort', abortOuter, { once: true });

  let lastEventAt = Date.now();
  const stallTimer = setInterval(() => {
    if (Date.now() - lastEventAt > STALL_TIMEOUT_MS) controller.abort();
  }, HEARTBEAT_INTERVAL_MS);
  const totalTimer = setTimeout(() => controller.abort(), TOTAL_TIMEOUT_MS);

  try {
    const response = await fetch(`${API_BASE}/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        topic: options.topic,
        complexity: options.complexity ?? 'detailed',
        tier: options.tier,
        stream: true,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      // Non-streaming failures arrive with the standard error envelope.
      const body = (await response.json().catch(() => null)) as
        | { error?: { code?: string; message?: string; retryAfterSeconds?: number } }
        | null;
      return {
        ok: false,
        code: body?.error?.code ?? 'internal',
        message: body?.error?.message ?? 'The server could not start this generation.',
        ...(body?.error?.retryAfterSeconds ? { retryAfterSeconds: body.error.retryAfterSeconds } : {}),
      };
    }

    const reader = response.body?.getReader();
    if (!reader) {
      return { ok: false, code: 'internal', message: 'This browser cannot read the generation stream.' };
    }

    const decoder = new TextDecoder();
    let buffer = '';
    let terminal: GenerateOutcome | null = null;

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // NDJSON: events are newline-delimited; a partial last line stays buffered.
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.length === 0) continue;
        let event: GenerationEvent;
        try {
          event = JSON.parse(trimmed) as GenerationEvent;
        } catch {
          continue;
        }
        lastEventAt = Date.now();
        options.onEvent?.(event);

        if (event.type === 'ready') {
          terminal = { ok: true, bundle: event.bundle, ...(event.audit ? { audit: event.audit } : {}) };
        } else if (event.type === 'error') {
          terminal = {
            ok: false,
            code: event.code,
            message: event.message,
            ...(event.retryAfterSeconds ? { retryAfterSeconds: event.retryAfterSeconds } : {}),
          };
        }
      }
    }

    // The rule the client depends on: no terminal event means the stream itself failed.
    return terminal ?? { ok: false, code: 'internal', message: 'The connection ended before the model was ready. Try again.' };
  } catch (error) {
    if ((error as Error).name === 'AbortError') {
      return options.signal?.aborted
        ? { ok: false, code: 'aborted', message: 'Generation was cancelled.' }
        : { ok: false, code: 'stalled', message: 'The model stopped responding. Try again in a moment.' };
    }
    return { ok: false, code: 'network', message: 'The server could not be reached. Is the backend running?' };
  } finally {
    clearInterval(stallTimer);
    clearTimeout(totalTimer);
    options.signal?.removeEventListener('abort', abortOuter);
  }
}

/** A small typed fetch for the non-streaming endpoints. Errors come back as values, never throws. */
export async function apiFetch<T>(path: string, init?: RequestInit): Promise<{ ok: true; data: T } | { ok: false; code: string; message: string }> {
  try {
    const response = await fetch(`${API_BASE}${path}`, init);
    const body = (await response.json().catch(() => null)) as (T & { error?: { code: string; message: string } }) | null;
    if (!response.ok) {
      return {
        ok: false,
        code: body?.error?.code ?? `http_${response.status}`,
        message: body?.error?.message ?? 'The request failed.',
      };
    }
    return { ok: true, data: body as T };
  } catch {
    return { ok: false, code: 'network', message: 'The server could not be reached.' };
  }
}

/**
 * The generated bundle's handoff between pages — THE single owner of the storage contract.
 *
 * History worth not repeating: three call sites once used two different naming schemes
 * (`edu3d.bundle` vs `edu3d.bundle.code`), the loading page wrote one, the viewer read the other,
 * and EVERY generated model silently fell back to the reference turbofan. All bundle persistence
 * goes through these functions now; nothing touches the raw keys.
 *
 * Stored as one JSON document under one key so the code, manifest and raw bundle can never
 * disagree about which generation they came from.
 */
const BUNDLE_KEY = 'edu3d.bundle.v2';

export interface StoredBundle {
  code: string;
  manifest: unknown;
  /** The full wire bundle, kept for the diagnostics/code panel. */
  raw?: unknown;
}

/** Store the generated bundle. Returns false when storage is unavailable (private mode). */
export function storeBundle(bundle: StoredBundle): boolean {
  try {
    sessionStorage.setItem(BUNDLE_KEY, JSON.stringify(bundle));
    return true;
  } catch {
    return false;
  }
}

/**
 * Take the generated bundle: returns it and clears storage (one generation → one load), or null
 * when none is waiting. A corrupt entry is discarded rather than trusted — a half-written bundle
 * must not render.
 */
export function takeBundle(): StoredBundle | null {
  try {
    const raw = sessionStorage.getItem(BUNDLE_KEY);
    if (raw === null) return null;
    sessionStorage.removeItem(BUNDLE_KEY);
    const parsed = JSON.parse(raw) as StoredBundle;
    if (typeof parsed?.code !== 'string' || parsed.code.length === 0) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Peek without consuming: the code panel wants the raw output for the CURRENT model even after load. */
export function peekBundleCode(): string | null {
  try {
    // The take on load clears the waiting key; the panel re-stores what it needs under the same
    // shape, so a peek is the same parse without the remove.
    const raw = sessionStorage.getItem(BUNDLE_KEY);
    if (raw === null) return null;
    const parsed = JSON.parse(raw) as StoredBundle;
    return typeof parsed?.code === 'string' ? parsed.code : null;
  } catch {
    return null;
  }
}

export function storeTopic(topic: string): void {
  try {
    sessionStorage.setItem('edu3d.topic', topic);
  } catch {
    /* the loading page reads it from the URL query as a fallback */
  }
}

export function takeTopic(): string {
  try {
    return (sessionStorage.getItem('edu3d.topic') ?? '').trim();
  } catch {
    return '';
  }
}
