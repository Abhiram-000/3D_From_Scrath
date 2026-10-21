/**
 * The browser's client for the backend API.
 *
 * One module owns every `fetch` the web app makes, because streaming discipline is easy to lose when
 * it is copied between call sites (`04`: heartbeats, terminal-event guarantees, stall detection). The
 * loading page and the viewer's Generate dialog both go through `generateStream`, which is why the
 * previous version's bug — the two entries behaving differently for the same action — cannot recur
 * here. The tutor's answer streams through `chatStream` for the same reason (`05`): one owner of the
 * NDJSON-parsing and one-terminal-event rule, however many call sites grow around it.
 */
import {
  COMPLEXITY_IDS,
  STALL_HEARTBEATS,
  HEARTBEAT_INTERVAL_MS,
  CLIENT_TOTAL_BACKSTOP_MS,
  type ComplexityPreference,
  type ChatEvent,
  type ChatPersona,
  type GenerationEvent,
  type HealthResponse,
  type ModelBundle,
  type ModelContext,
} from '@edu3d/contracts';

/**
 * Where the API lives.
 *
 * Same-origin `/api` by default — that is what the dev proxy, the one-container deploy and every
 * existing deployment use, and what `svelte.config.js`'s static adapter assumes. A split deployment
 * (static shell on a CDN, Hono API on another origin) sets `PUBLIC_API_BASE` at build time via
 * SvelteKit's `PUBLIC_*` convention, e.g. `PUBLIC_API_BASE=https://api.example.edu3d`; every fetch
 * in this module is built from this one constant, so one variable moves the whole client and
 * nothing else changes.
 *
 * The other half of a split deploy is server-side and deliberately NOT fixed here: the server's CSP
 * pins `connect-src 'self'`, so pointing the client at another origin will be blocked by that
 * policy until the server widens it (and adds the origin to its CORS allow-list — `PUBLIC_ORIGIN` /
 * `ALLOWED_ORIGINS`). Without that half, every call fails with a CSP violation, not a 404. Those
 * changes belong to `apps/server`; this constant only moves the client.
 */
const configuredBase = import.meta.env.PUBLIC_API_BASE;
export const API_BASE =
  typeof configuredBase === 'string' && configuredBase.trim().length > 0
    ? configuredBase.trim().replace(/\/+$/, '')
    : '/api';

/** The server sends a heartbeat every ~10s; 4 missed beats is a stall, not a slow provider (`04`). */
export const STALL_TIMEOUT_MS = STALL_HEARTBEATS * HEARTBEAT_INTERVAL_MS;

/**
 * The backstop, not the limiter: the plain 6-minute ceiling this once was fired long before the
 * server's own (previously nonexistent) overall bound could speak, so every long-but-alive
 * generation died as "the model stopped responding" — a lie about a slow run. It is now DERIVED
 * from the shared contract (`CLIENT_TOTAL_BACKSTOP_MS`): the server's bounded queue wait + the
 * server's overall pipeline deadline + a teardown margin, so the server ALWAYS sends a terminal
 * event before this fires. The stall detector above — refresh by every event, heartbeats
 * included — stays exactly as it is: that one is the hang detector, and it works.
 */
export const TOTAL_TIMEOUT_MS = CLIENT_TOTAL_BACKSTOP_MS;

export interface GenerateOptions {
  topic: string;
  complexity?: ComplexityPreference;
  tier?: 'low' | 'mid' | 'high';
  /**
   * `GenerateRequest.domain` is deliberately NOT plumbed through here, on purpose rather than by
   * omission: no call site knows the domain of the topic the learner just typed. The loading page
   * has nothing but the topic string, and the viewer's only known `manifest.domain` belongs to the
   * *previous* topic — sending it would bias classification towards the old subject, which is
   * worse than the hint's benefit. The server's own classification is trusted instead; if a call
   * site one day holds a domain for the topic at hand (e.g. a category chip carrying its domain),
   * add the field here and send it.
   */
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
  // Which timer fired must remain knowable at the catch below — a self-abort for silence and a
  // self-abort for sheer length are different truths with different words, and an unattributed
  // AbortError folds them into one (the bug that made every long generation "a stall").
  let totalFired = false;
  const totalTimer = setTimeout(() => {
    totalFired = true;
    controller.abort();
  }, TOTAL_TIMEOUT_MS);

  try {
    const response = await fetch(`${API_BASE}/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        topic: options.topic,
        complexity: options.complexity ?? DEFAULT_COMPLEXITY,
        tier: options.tier,
        stream: true,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      // Non-streaming failures arrive with the standard error envelope.
      const body = (await response.json().catch(() => null)) as {
        error?: { code?: string; message?: string; retryAfterSeconds?: number };
      } | null;
      return {
        ok: false,
        code: body?.error?.code ?? 'internal',
        message: body?.error?.message ?? 'The server could not start this generation.',
        ...(body?.error?.retryAfterSeconds
          ? { retryAfterSeconds: body.error.retryAfterSeconds }
          : {}),
      };
    }

    const reader = response.body?.getReader();
    if (!reader) {
      return {
        ok: false,
        code: 'internal',
        message: 'This browser cannot read the generation stream.',
      };
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
          terminal = {
            ok: true,
            bundle: event.bundle,
            ...(event.audit ? { audit: event.audit } : {}),
          };
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
    return (
      terminal ?? {
        ok: false,
        code: 'internal',
        message: 'The connection ended before the model was ready. Try again.',
      }
    );
  } catch (error) {
    if ((error as Error).name === 'AbortError') {
      // Three distinct realities, in attribution order: the caller's own cancel, the backstop
      // (the server missed its deadline — a server fault, never a silent model), and genuine
      // silence. One shared 'stalled' sentence used to cover the last two.
      if (options.signal?.aborted) {
        return { ok: false, code: 'aborted', message: 'Generation was cancelled.' };
      }
      if (totalFired) {
        return {
          ok: false,
          code: 'run_overrun',
          message:
            'This generation ran far longer than the server allows without reporting. ' +
            'Try again in a moment.',
        };
      }
      return {
        ok: false,
        code: 'stalled',
        message: 'The model stopped responding. Try again in a moment.',
      };
    }
    return {
      ok: false,
      code: 'network',
      message: 'The server could not be reached. Is the backend running?',
    };
  } finally {
    clearInterval(stallTimer);
    clearTimeout(totalTimer);
    options.signal?.removeEventListener('abort', abortOuter);
  }
}

export interface ChatStreamOptions {
  message: string;
  persona: ChatPersona;
  /** Recent exchange only, so "why does it do that?" works after the previous answer (`05`). */
  history: Array<{ role: 'user' | 'assistant'; content: string }>;
  context?: ModelContext;
  /** The learner's connection: navigating away abandons the tutor's in-flight answer (`05`). */
  signal?: AbortSignal;
  /** Called with each fragment as it arrives, so the bubble can visibly write. */
  onDelta?: (text: string) => void;
}

export type ChatOutcome =
  | { ok: true; text: string }
  | { ok: false; code: string; message: string; retryAfterSeconds?: number };

/**
 * One tutor exchange, consuming the NDJSON chat stream (`05`).
 *
 * This is the generation stream's discipline in miniature: deltas are forwarded as they arrive
 * (`onDelta`), the server ends the stream with EXACTLY ONE terminal event (`done` | `error`), and a
 * stream that ends without one is itself a failure (`04`) — the same rule `generateStream` enforces,
 * which is why the parsing lives here rather than being re-implemented at the panel. The resolved
 * terminal outcome is what re-enables the composer. Answers are short — the route caps the provider
 * at 60 s and 2,000 tokens — so the stall/backstop timers generation needs are deliberately not
 * repeated: any provider silence ends as the server's own timeout `error` event.
 */
export async function chatStream(options: ChatStreamOptions): Promise<ChatOutcome> {
  try {
    const response = await fetch(`${API_BASE}/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        message: options.message,
        persona: options.persona,
        history: options.history,
        context: options.context,
        stream: true,
      }),
      signal: options.signal,
    });

    if (!response.ok) {
      // A failure before the stream starts (rate limit, drain, bad request) is the plain envelope.
      const body = (await response.json().catch(() => null)) as {
        error?: { code?: string; message?: string; retryAfterSeconds?: number };
      } | null;
      return {
        ok: false,
        code: body?.error?.code ?? 'internal',
        message: body?.error?.message ?? 'The tutor could not answer right now.',
        ...(body?.error?.retryAfterSeconds
          ? { retryAfterSeconds: body.error.retryAfterSeconds }
          : {}),
      };
    }

    const reader = response.body?.getReader();
    if (!reader) {
      return { ok: false, code: 'internal', message: 'This browser cannot read the chat stream.' };
    }

    const decoder = new TextDecoder();
    let buffer = '';
    let text = '';
    let terminal: ChatOutcome | null = null;

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
        let event: ChatEvent;
        try {
          event = JSON.parse(trimmed) as ChatEvent;
        } catch {
          continue;
        }
        if (event.type === 'delta') {
          text += event.text;
          options.onDelta?.(event.text);
        } else if (event.type === 'done') {
          // The terminal success carries the authoritative full text; deltas were the view. Fall
          // back to what arrived if a provider sent an empty terminal payload.
          terminal = { ok: true, text: event.text.length > 0 ? event.text : text };
        } else if (event.type === 'error') {
          terminal = { ok: false, code: event.code, message: event.message };
        }
        if (terminal) break;
      }
      if (terminal) break;
    }

    // Release the reader either way; a terminal event means the server is already closing.
    await reader.cancel().catch(() => {});

    return (
      terminal ?? {
        ok: false,
        code: 'internal',
        message: 'The tutor’s reply ended before it was finished. Try again.',
      }
    );
  } catch (error) {
    if ((error as Error).name === 'AbortError') {
      // The learner navigated away: not a failure to explain, just a cancelled exchange.
      return { ok: false, code: 'aborted', message: 'Chat was cancelled.' };
    }
    return { ok: false, code: 'network', message: 'The server could not be reached.' };
  }
}

/** A small typed fetch for the non-streaming endpoints. Errors come back as values, never throws.
 *
 * A rate-limited answer (429) carries the server's `retryAfterSeconds`, so the call site can tell
 * the learner when to come back rather than leaving the failure unexplained.
 */
export async function apiFetch<T>(
  path: string,
  init?: RequestInit,
): Promise<
  { ok: true; data: T } | { ok: false; code: string; message: string; retryAfterSeconds?: number }
> {
  try {
    const response = await fetch(`${API_BASE}${path}`, init);
    const body = (await response.json().catch(() => null)) as
      (T & { error?: { code: string; message: string; retryAfterSeconds?: number } }) | null;
    if (!response.ok) {
      return {
        ok: false,
        code: body?.error?.code ?? `http_${response.status}`,
        message: body?.error?.message ?? 'The request failed.',
        ...(body?.error?.retryAfterSeconds
          ? { retryAfterSeconds: body.error.retryAfterSeconds }
          : {}),
      };
    }
    return { ok: true, data: body as T };
  } catch {
    return { ok: false, code: 'network', message: 'The server could not be reached.' };
  }
}

/**
 * One health probe, for callers that want to say what a deployment can do *before* the learner
 * commits to a wait. `HealthResponse.capabilities.ai` is the meaningful one client-side: with no
 * AI configured, warning at the point of input is honest; discovering it as a failure four minutes
 * into a stream is not (`04`: capability_absent is a first-class, explained state).
 *
 * Unreachable is a normal answer here — split deployments, offline previews, a CDN without an API
 * behind it. Callers must treat `!result.ok` as "unknown", never as "capability absent": missing
 * evidence of a capability is not evidence of its absence.
 */
export function fetchHealth(): Promise<
  | { ok: true; data: HealthResponse }
  | { ok: false; code: string; message: string; retryAfterSeconds?: number }
> {
  return apiFetch<HealthResponse>('/health');
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
 *
 * The page that takes it — the viewer — becomes the single owner of the answer to "what program
 * is on screen now". It holds the returned `StoredBundle` in page state and hands `code` (plus
 * `storedRuntime(bundle)`) down to the share and code panels as props. Nothing re-reads the
 * storage key afterward, and that is the point: a gallery load or a Generate swap replaces the
 * model on screen without touching this key, so any later storage peek would go stale and publish
 * a stale program under the new model's manifest — the exact lie this file once shipped, hidden
 * behind a comment claiming a panel "re-stores what it needs" (it never did). One owner, no peeks.
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

/**
 * The instrumented twin of `code`, when the bundle carries one.
 *
 * `raw` is the full wire bundle, which is what makes this free: the server put `runtime` next to
 * `code` and the whole document was stored as-is. Callers that lack it (the reference source, a
 * pre-guard gallery entry) get undefined and load the clean string, as they always did.
 */
export function storedRuntime(bundle: StoredBundle): string | undefined {
  const runtime = (bundle.raw as { runtime?: unknown } | undefined)?.runtime;
  return typeof runtime === 'string' && runtime.length > 0 ? runtime : undefined;
}

export function storeTopic(topic: string): void {
  try {
    sessionStorage.setItem('edu3d.topic', topic);
  } catch {
    /* a lost topic costs the learner their words, and the loading page reports that loss honestly
       — there is no silent fallback to invent one from */
  }
}

/**
 * Read the topic back. The single reader is the loading page, and it goes through here rather
 * than touching the raw key, so `edu3d.topic` has one writer and one reader and the key name
 * lives in this file alone.
 */
export function takeTopic(): string {
  try {
    return (sessionStorage.getItem('edu3d.topic') ?? '').trim();
  } catch {
    return '';
  }
}

/**
 * The learner's chosen depth, carried across the landing → loading navigation.
 *
 * Kept beside the topic because it is the same decision: "here is what I want built, and how
 * thoroughly". `DEFAULT_COMPLEXITY` is deliberately the same value the server defaults to, so a
 * browser with no stored preference behaves exactly as it did before the control existed.
 */
export const DEFAULT_COMPLEXITY: ComplexityPreference = 'detailed';

export function storeComplexity(complexity: ComplexityPreference): void {
  try {
    sessionStorage.setItem('edu3d.complexity', complexity);
  } catch {
    /* a non-persisted preference is not worth failing a generation over */
  }
}

export function takeComplexity(): ComplexityPreference {
  try {
    const raw = sessionStorage.getItem('edu3d.complexity');
    return COMPLEXITY_IDS.includes(raw as ComplexityPreference)
      ? (raw as ComplexityPreference)
      : DEFAULT_COMPLEXITY;
  } catch {
    return DEFAULT_COMPLEXITY;
  }
}
