/**
 * The AI provider client: typed retries, truncation detection, translated failures.
 *
 * Deliberately dependency-free `fetch` against the OpenAI-compatible chat API. `04` leaves the client
 * library to us and the config makes the base URL swappable, and every SDK here would be a wrapper
 * around one `fetch` whose retries we would have to disable to layer our own on top — ours must own the
 * retry decision because it is *typed*: "retries for the transient, never for the semantic".
 *
 * Every failure this module returns is one of the platform's `ErrorCode`s with learner-facing words
 * attached, so a route never sees a raw provider dump. That applies to provider BODIES too: a 4xx
 * body is logged server-side (it is diagnostics) and never echoed to the learner (it can carry
 * org ids, model inventory and internal quotas).
 *
 * Shutdown awareness (`06`): the process singleton drain signal is combined into every provider
 * fetch and backoff sleep, so SIGTERM stops in-flight provider work promptly and is reported as
 * its own `draining` failure — never as a fake timeout, and never retried.
 */
import type { ServerConfig } from '../config/config.ts';
import { HEARTBEAT_INTERVAL_MS, PIPELINE_ATTEMPT_TIMEOUT_MS } from '@edu3d/contracts';
import { lifecycle } from './lifecycle.ts';

/** What the pipeline asks a model for. */
export interface CompletionRequest {
  /** Conversation with the system prompt already assembled by the caller. */
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
  /** Configured ceiling, not a per-call guess (`00`: the budget is a constraint, not a target). */
  maxOutputTokens: number;
  /** Generation wants temperature low: code, not creative prose. */
  temperature?: number;
  /** Per-call timeout, milliseconds. Overrides the client default so chat can be snappier than generation. */
  timeoutMs?: number;
  /**
   * Called as the provider streams tokens, with the running character count — the learner's proof
   * of life during a minutes-long model phase (`07`: progress must be honest AND visible).
   */
  onProgress?: (chars: number) => void;
  /**
   * Called with each answer fragment as the provider writes it — the tutor _writing_, visibly,
   * instead of the learner waiting for the whole reply (`05`: answers stream token-by-token).
   *
   * Only `delta.content` is forwarded: `reasoning_content` counts toward `onProgress` but is not
   * part of the answer, so it is never shown. Supplying this (like `onProgress`) puts the provider
   * call into SSE mode, so the fragments are a VIEW of a call whose reassembly, failure
   * classification, retry and abort rules are otherwise identical — the terminal result is the
   * same `CompletionResult` `complete()` returns.
   */
  onDelta?: (delta: string) => void;
  /**
   * The learner's connection, not a timeout.
   *
   * A minutes-long generation routinely outlives the tab that asked for it. Without this the
   * server keeps paying for up to three more AI calls for work nobody is waiting for, which
   * `04:90` names explicitly: "Client disconnects mid-stream → stop charging for work nobody
   * is waiting for."
   */
  signal?: AbortSignal;
}

export type CompletionResult =
  | {
      ok: true;
      text: string;
      /** The provider's finish reason, when reported. `length` means the cap truncated the reply. */
      finishReason: string | null;
      usage: { promptTokens: number; completionTokens: number };
    }
  | {
      ok: false;
      code: AiFailureCode;
      message: string;
      retryable: boolean;
      retryAfterSeconds?: number;
      /**
       * The partial text the provider streamed before dying — only ever present on `truncated`.
       *
       * This IS the fix for the dominant generation failure: the measured failure class was a
       * stream cut mid-program (`upstream_truncated` on every failed battery topic), and asking a
       * model to re-write the COMPLETE program has the same cut probability the second time while
       * costing a full re-roll. Instead the pipeline treats the partial as an assistant turn and
       * asks for only the missing remainder, so the client must HAND OVER what arrived rather than
       * swallowing it into a bare failure. Deliberately NOT retried inside this client any more:
       * a client-side retry re-rolls the whole program (same cut odds, full price) — the
       * continuation in the pipeline is both cheaper and cut-resistant.
       */
      partialText?: string;
      /** The provider's reported usage for the truncated call, when it sent any. */
      usage?: { promptTokens: number; completionTokens: number };
    };

/** The failure vocabulary, kept local so the mapping to `ErrorCode` lives in one place. */
export type AiFailureCode =
  | 'quota'
  | 'refused'
  | 'truncated'
  | 'timeout'
  | 'network'
  | 'malformed'
  | 'status'
  /** The learner went away. Not a provider problem and not retryable — there is nobody to retry for. */
  | 'cancelled'
  /** 401/403: the server's own credentials are wrong. Not retryable — cascading or falling back
   * would burn more calls with the same wrong key while the operator gets no signal fast. */
  | 'auth'
  /** The server is draining (`06`). In-flight provider work is stopped and not retried; the
   * pipeline maps this onto the terminal `draining` error event the shutdown contract promises. */
  | 'draining';

/** Retry policy. Two retries with backoff — enough to ride out a blip, bounded so cost cannot run away (`04`). */
const MAX_ATTEMPTS = 3;

/**
 * Per-provider model cascades, tried in order when a failure is model-shaped (quota, demand, or
 * the model being retired — free tiers rotate names often).
 *
 * A cascade must only contain models that exist ON THAT PROVIDER: when FreeInference was made
 * primary, the old global list sent Gemini-only names there and every call died to a 404 — the
 * exact bug this table fixes. The configured model always goes first; these follow, newest first.
 */
const MODEL_CASCADES: Readonly<Record<string, readonly string[]>> = {
  'freeinference.org': ['deepseek-v4-flash', 'glm-5.1', 'qwen3.6-35b'],
  'generativelanguage.googleapis.com': ['gemini-3.8-flash', 'gemini-2.5-flash', 'gemini-2.0-flash'],
};

/**
 * Known per-model OUTPUT ceilings (provider /models data), and the floor below which a model can
 * never serve a generation-sized call.
 *
 * A cascade entry whose ceiling is BELOW the request's max tokens is a guaranteed truncation: the
 * model stops at its own ceiling mid-program and the run pays full price for a partial. The
 * measured example: `qwen3.6-35b` allows 8,192 output tokens — no program fits — yet it sat in the
 * FreeInference cascade as the third hop, so every quota/404 on the first two models advanced a
 * multi-minute generation request onto a model that structurally cannot answer it. Unknown models
 * are NOT excluded on suspicion (no data ≠ guilty); known-too-small ones always are.
 */
const MODEL_OUTPUT_CEILINGS: Readonly<Record<string, number>> = {
  // FreeInference (provider /models):
  'deepseek-v4-flash': 393_216,
  'glm-5.3-flash': 131_072,
  'qwen3.6-35b': 8_192,
  diffusiongemma: 8_192,
};
const BASE_BACKOFF_MS = 1_500;
/**
 * Per-call timeout for generation-sized requests, DEFINED from the shared contract's per-attempt
 * bound (330 s) rather than restated — `@edu3d/contracts` carries the full deadline invariant:
 * the server's overall deadline (`PIPELINE_DEADLINE_MS`) is sized from these per-attempt ceilings,
 * and the server ALWAYS sends a terminal event before any client timer fires. A per-model timeout
 * big enough to cover the measured 449 s run remains a long-term follow-up; the overall deadline
 * is what bounds the multiplicative worst case (cascade × retries × continuations) meanwhile.
 */
const REQUEST_TIMEOUT_MS = PIPELINE_ATTEMPT_TIMEOUT_MS;

/** A rough status → failure mapping. Everything unrecognised is `status` and retryable at this layer. */
function classifyStatus(status: number): AiFailure {
  // Auth failures are their own code, not `status`: under the old mapping the cascade advanced
  // and the cross-provider fallback was entered — a wrong AI_API_KEY burned 7 paid calls before
  // reporting. One call, one actionable message.
  if (status === 401 || status === 403) {
    return failure(
      'auth',
      'The AI service rejected this server’s credentials. Check AI_API_KEY.',
      false,
    );
  }
  if (status === 429) {
    return failure(
      'quota',
      'The AI service is out of quota right now. Wait a minute and try again.',
      true,
      60,
    );
  }
  if (status === 503) {
    // Gemini's free tier reports demand spikes as 503 UNAVAILABLE. Treated as quota-shaped: the
    // capacity will return, and "wait a minute" is the actionable instruction (`04`).
    return failure(
      'quota',
      'The AI service is busy right now (high demand). Wait a minute and try again.',
      true,
      60,
    );
  }
  if (status === 404) {
    // Free tiers rotate model names constantly; a 404 means THIS model is retired/absent, not that
    // the request was wrong. Classified `status` so the model cascade advances to the next entry
    // instead of dying here (the generic 4xx branch would mark it non-retryable and stop everything).
    return failure(
      'status',
      'The AI service no longer offers that model; trying the next one.',
      true,
    );
  }
  if (status >= 500) {
    return failure('status', 'The AI service failed to answer. Try again in a moment.', true);
  }
  // 4xx other than auth: our request shape is wrong somewhere. Not retryable — that would burn money.
  // The learner message is fixed on purpose: the body is logged server-side and must never reach
  // the wire (it can name keys, orgs and internal model inventory).
  return failure(
    'malformed',
    `The AI service rejected the request (HTTP ${status}). Try again in a moment.`,
    false,
  );
}

interface AiFailure {
  code: AiFailureCode;
  message: string;
  retryable: boolean;
  retryAfterSeconds?: number;
}

const failure = (
  code: AiFailureCode,
  message: string,
  retryable: boolean,
  retryAfterSeconds?: number,
): AiFailure => ({ code, message, retryable, retryAfterSeconds });

/**
 * Sleep with a dangling-timer escape: a learner abort or a drain abort resolves the wait early,
 * and the next loop iteration's pre-attempt checks refuse the spend. Without this a cancelled
 * request held its slot for the full provider-dictated (or exponential) backoff.
 *
 * `tick` makes a long wait prove life: called immediately and then every `HEARTBEAT_INTERVAL_MS`
 * until the wait ends. The pipeline's own heartbeat timer happened to cover these waits — that
 * coupling was accidental; now the wait itself proves the server is alive to the learner when a
 * provider's retry-after (60 s of the quota kind) would otherwise read as silence.
 */
const sleep = (ms: number, signal?: AbortSignal, tick?: () => void): Promise<void> =>
  new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    tick?.();
    const ticker = tick ? setInterval(tick, HEARTBEAT_INTERVAL_MS) : undefined;
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = () => {
      cleanup();
      resolve();
    };
    const cleanup = () => {
      clearTimeout(timer);
      if (ticker) clearInterval(ticker);
      signal?.removeEventListener('abort', onAbort);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });

/**
 * How a fetch/reader abort is classified once the wire is down, in priority order:
 * drain first (the server is leaving and moved first), then the learner's own abort, then the
 * client's own timeout. Distinguishing them is what makes SIGTERM honest: without it a drain
 * mid-stream was reported as `truncated` or `timeout` and the client never saw the shutdown
 * contract's terminal `draining` code.
 */
function classifyAbort(request: CompletionRequest, selfAbort?: AbortSignal): AiFailure {
  if (lifecycle.draining && !request.signal?.aborted) {
    return failure('draining', 'The server is restarting; this request was stopped.', false);
  }
  if (request.signal?.aborted) {
    return failure('cancelled', 'The request was cancelled.', false);
  }
  if (selfAbort?.aborted) {
    return failure(
      'timeout',
      'The AI service took too long to answer. Try again in a moment.',
      true,
    );
  }
  // An abort that is not ours at all: the provider dropped the connection mid-request.
  return failure('network', 'The AI service dropped the connection. Try again in a moment.', true);
}

export class AiClient {
  private readonly config: ServerConfig;

  constructor(config: ServerConfig) {
    this.config = config;
  }

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    // Drain check before anything is spent: a draining server starts no provider call.
    if (lifecycle.draining) {
      return { ok: false, ...drainingFailure() };
    }

    // The cascade starts with the configured model and continues with models that exist on the
    // SAME provider (a cross-provider name is a guaranteed 404 — see MODEL_CASCADES). Cascade hops
    // whose KNOWN output ceiling cannot hold this request's max tokens are skipped: advancing a
    // generation onto a model that stops at 8,192 tokens is a paid, guaranteed truncation.
    const cascade = this.cascadeFor(this.config.ai.baseUrl).filter((model) => {
      const ceiling = MODEL_OUTPUT_CEILINGS[model];
      if (ceiling === undefined || ceiling >= request.maxOutputTokens) return true;
      console.warn(
        `[ai-client] skipping cascade model ${model}: known ceiling ${ceiling} output tokens < requested ${request.maxOutputTokens}`,
      );
      return false;
    });
    const configuredCeiling = MODEL_OUTPUT_CEILINGS[this.config.ai.model];
    if (configuredCeiling !== undefined && configuredCeiling < request.maxOutputTokens) {
      console.warn(
        `[ai-client] configured model ${this.config.ai.model} has a known ceiling of ` +
          `${configuredCeiling} output tokens but the request asks for ${request.maxOutputTokens}; ` +
          'the provider will stop it mid-program — raise AI_MAX_OUTPUT_TOKENS only within the model’s ceiling.',
      );
    }
    const models = [this.config.ai.model, ...cascade.filter((m) => m !== this.config.ai.model)];
    let reported: CompletionResult | null = null;

    for (const model of models) {
      const result = await this.completeWithModel(model, request);
      if (result.ok) return result;
      reported = result;
      // Quota/demand and retired-model 404s justify moving to the next model; request-shaped
      // failures (auth, refusal, malformed), cancellations and drains do not — another model
      // would fail the same way, or there is nobody left to serve.
      if (result.code !== 'quota' && result.code !== 'status') break;
    }

    // The cross-provider fallback: an independent service with its own quota AND its own model
    // names. Reached ONLY when the primary failed with a provider-shaped failure — quota, demand,
    // outage, timeout or network — because re-sending auth problems, refusals or service-side
    // mistakes to a second provider just spends a second set of money on the same answer (`04`:
    // degraded modes are real modes, not a place to launder every failure).
    const fallback = this.config.ai.fallback;
    const primaryShaped = (
      result: CompletionResult,
    ): result is Extract<CompletionResult, { ok: false }> =>
      !result.ok &&
      (result.code === 'quota' ||
        result.code === 'status' ||
        result.code === 'timeout' ||
        result.code === 'network');

    if (fallback?.apiKey && reported && primaryShaped(reported)) {
      for (const model of [
        fallback.model,
        // Same output-ceiling rule as the primary cascade: a too-small fallback model is a paid
        // guaranteed truncation, not a resilience hop (see MODEL_OUTPUT_CEILINGS).
        ...this.cascadeFor(fallback.baseUrl).filter((model) => {
          const ceiling = MODEL_OUTPUT_CEILINGS[model];
          if (ceiling === undefined || ceiling >= request.maxOutputTokens) return true;
          console.warn(
            `[ai-client] skipping fallback cascade model ${model}: known ceiling ${ceiling} output tokens < requested ${request.maxOutputTokens}`,
          );
          return false;
        }),
      ]) {
        const crossed = await this.completeWithProvider(
          fallback.baseUrl,
          fallback.apiKey,
          model,
          request,
        );
        if (crossed.ok) return crossed;
        // The fallback was actually entered and failed too: its own final failure is the honest
        // report — e.g. primary quota → fallback network reports the reachability problem the
        // learner can act on about their own connection, not the stale primary story.
        reported = crossed;
        if (crossed.code !== 'quota' && crossed.code !== 'status') break;
      }
    }

    return reported as CompletionResult;
  }

  /**
   * A completion that also yields the answer as it is written.
   *
   * `05`: the tutor must be visibly writing, not silent for ten seconds and then dumping a
   * paragraph. This runs the IDENTICAL machinery as `complete()` — the same model cascade, typed
   * retries, drain/learner abort composition, per-attempt timeout and failure classification — and
   * resolves the identical `CompletionResult`. The one difference: provider SSE text is forwarded to
   * `onDelta` as each fragment lands, so a caller can render the answer before the call finishes.
   * Because nothing about the fetch path changes, the attempt timeout still aborts a stalled
   * stream and the classification of that abort is unchanged.
   */
  completeStream(
    request: CompletionRequest,
    onDelta: (delta: string) => void,
  ): Promise<CompletionResult> {
    return this.complete({ ...request, onDelta });
  }

  /** The same-provider model cascade for a base URL; empty when the provider is unknown. */
  private cascadeFor(baseUrl: string): readonly string[] {
    for (const [host, models] of Object.entries(MODEL_CASCADES)) {
      if (baseUrl.includes(host)) return models;
    }
    return [];
  }

  /** Every signal that should cut a wait short: the drain, plus the learner's when present. */
  private stopWaitSignal(request: CompletionRequest): AbortSignal {
    const signals = request.signal
      ? [lifecycle.drainSignal, request.signal]
      : [lifecycle.drainSignal];
    return AbortSignal.any(signals);
  }

  private async completeWithProvider(
    baseUrl: string,
    apiKey: string,
    model: string,
    request: CompletionRequest,
  ): Promise<CompletionResult> {
    const stopWait = this.stopWaitSignal(request);
    // The running char count, so a wait that overlaps streamed work can report "still at N chars"
    // instead of resetting the learner's counter to zero.
    let lastChars = 0;
    const tracked: CompletionRequest = {
      ...request,
      onProgress: (chars: number) => {
        lastChars = chars;
        request.onProgress?.(chars);
      },
    };
    const proveAlive = request.onProgress ? () => request.onProgress?.(lastChars) : undefined;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      const result = await this.attempt(model, tracked, attempt === MAX_ATTEMPTS, baseUrl, apiKey);
      if (result.ok) return result;
      if (!result.retryable || attempt === MAX_ATTEMPTS) return result;
      await sleep(BASE_BACKOFF_MS * 2 ** (attempt - 1), stopWait, proveAlive);
    }
    throw new Error('unreachable');
  }

  private async completeWithModel(
    model: string,
    request: CompletionRequest,
  ): Promise<CompletionResult> {
    const stopWait = this.stopWaitSignal(request);
    // Same streamed-char memory as `completeWithProvider`: the backoff tick reports the last
    // known count, never a silent minute and never a fake reset to zero.
    let lastChars = 0;
    const tracked: CompletionRequest = {
      ...request,
      onProgress: (chars: number) => {
        lastChars = chars;
        request.onProgress?.(chars);
      },
    };
    const proveAlive = request.onProgress ? () => request.onProgress?.(lastChars) : undefined;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      const result = await this.attempt(model, tracked, attempt === MAX_ATTEMPTS);
      if (result.ok) return result;

      // Non-retryable, or the final attempt: the failure stands for this model.
      if (!result.retryable || attempt === MAX_ATTEMPTS) return result;

      // A quota backoff is dictated by the provider; anything else is exponential. Both are
      // abortable: a cancelled run or a drain must not hold its slot through the wait — and both
      // are ALIVE: `proveAlive` ticks the caller's progress through the wait itself.
      const backoff = result.retryAfterSeconds
        ? result.retryAfterSeconds * 1000
        : BASE_BACKOFF_MS * 2 ** (attempt - 1);
      await sleep(backoff, stopWait, proveAlive);
    }
    // Unreachable: the loop returns on its last iteration.
    throw new Error('unreachable');
  }

  /** One HTTP attempt, including the abort timeout that keeps a dead provider from pinning a stream. */
  private async attempt(
    model: string,
    request: CompletionRequest,
    finalAttempt: boolean,
    baseUrlOverride?: string,
    apiKeyOverride?: string,
  ): Promise<CompletionResult> {
    const baseUrl = baseUrlOverride ?? this.config.ai.baseUrl;
    const apiKey = apiKeyOverride ?? this.config.ai.apiKey ?? '';

    // Two refusals BEFORE the request is even sent, because the attempt is the expensive part:
    //   - the learner closed the tab — a cancelled generation must not open a paid socket;
    //   - the server is draining (`06`) — no new provider work starts during shutdown.
    if (request.signal?.aborted) {
      return { ok: false, ...failure('cancelled', 'The request was cancelled.', false) };
    }
    if (lifecycle.draining) {
      return { ok: false, ...drainingFailure() };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), request.timeoutMs ?? REQUEST_TIMEOUT_MS);
    // Who fired the abort is knowable: this signal is ours alone (drain and the learner compose
    // in separately), so an AbortError caught downstream can always be attributed.
    const selfAbort = controller.signal;

    // Three reasons to stop the same fetch: our own timeout, the learner's connection going away,
    // and the server beginning to drain. Combining them means neither has to know about the other.
    const abortSignal = this.stopWaitSignal(request);
    const combined = AbortSignal.any([controller.signal, abortSignal]);

    try {
      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: request.messages,
          max_tokens: request.maxOutputTokens,
          temperature: request.temperature ?? 0.3,
          // Reasoning effort where supported: DeepSeek/GLM-class models take reasoning_effort.
          // 'high' was observed to consume the entire output budget on thinking before any code
          // was written (finish=length, empty content); 'medium' still plans thoroughly while
          // leaving room for the program itself. Unknown providers ignore the field.
          reasoning_effort: 'medium',
          // Streaming whenever the caller wants progress OR deltas, so token arrival is
          // observable instead of an opaque wait. The text is reassembled below either way;
          // behavior is identical.
          ...(request.onProgress || request.onDelta ? { stream: true } : {}),
        }),
        signal: combined,
      });

      if (!response.ok) {
        // The provider's body is server-side diagnostics only: logged here, never reflected back.
        const bodyText = await response.text().catch(() => '');
        console.warn(
          `[ai-client] provider ${response.status} from ${baseUrl}: ${bodyText.slice(0, 400)}`,
        );
        const classified = classifyStatus(response.status);
        return { ok: false, ...classified };
      }

      // Streaming mode: reassemble SSE chunks into the same shape the non-streaming path returns,
      // reporting character progress and forwarding text fragments as tokens arrive. Falls back to
      // JSON if the provider ignored `stream: true` (content-type is the tell).
      if (
        (request.onProgress || request.onDelta) &&
        (response.headers.get('content-type') ?? '').includes('text/event-stream')
      ) {
        return await this.consumeStream(response, request, selfAbort);
      }

      const json = (await response.json().catch(() => null)) as {
        choices?: Array<{
          message?: { content?: string | Array<{ text?: string }> };
          finish_reason?: string;
        }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      } | null;

      if (!json) {
        return {
          ok: false,
          ...failure('malformed', 'The AI service returned an unparseable reply. Try again.', true),
        };
      }

      const choice = json.choices?.[0];
      // Providers differ on content shape: string, or an array of typed parts. Both spellings are absorbed
      // here rather than in the pipeline (`04`: "the extraction and gate stages absorb variance").
      const content = choice?.message?.content;
      const text =
        typeof content === 'string'
          ? content
          : Array.isArray(content)
            ? content.map((part) => part?.text ?? '').join('')
            : '';

      if (!choice || text.length === 0) {
        // An empty reply on a non-refusal finish is malformed; a refusal finish is semantic.
        const finish = choice?.finish_reason ?? '';
        if (/refus|content_filter|safety/i.test(finish)) {
          return {
            ok: false,
            ...failure(
              'refused',
              'The AI declined this topic. Try describing it differently, or pick a related concept.',
              false,
            ),
          };
        }
        // `length` finish with empty content is the reasoning-model trap: the entire budget was
        // spent on thinking and the answer never started. Named as truncation (`04`: "truncation is
        // detected, never shipped") — the retry loop re-asks, and the cross-provider fallback takes
        // over if this provider keeps doing it.
        if (finish === 'length') {
          return {
            ok: false,
            ...failure(
              'truncated',
              'The response was cut off before the model was complete. Try again.',
              true,
            ),
          };
        }
        // Empty on a clean stop is a gateway flake (observed on long high-reasoning generations):
        // immediately retryable, and the notice surfaces it honestly.
        return {
          ok: false,
          ...failure('malformed', 'The AI returned an empty reply. Try again.', true),
        };
      }

      const finishReason = choice.finish_reason ?? null;
      return {
        ok: true,
        text,
        finishReason,
        usage: {
          promptTokens: json.usage?.prompt_tokens ?? 0,
          completionTokens: json.usage?.completion_tokens ?? 0,
        },
      };
    } catch (error) {
      if (lifecycle.draining && !request.signal?.aborted) {
        // Some runtimes surface a drain-aborted fetch as TypeError/terminated, not AbortError.
        return { ok: false, ...drainingFailure() };
      }
      if (error instanceof Error && error.name === 'AbortError') {
        return { ok: false, ...classifyAbort(request, selfAbort) };
      }
      return {
        ok: false,
        ...failure('network', 'The AI service could not be reached. Try again in a moment.', true),
      };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Consume an SSE stream, reassembling it into the non-streaming result shape.
   *
   * Chunks carry `delta.content` fragments (and `delta.reasoning_content` on reasoning models —
   * counted as progress too: thinking IS progress, it is just not text the program keeps). Each
   * content fragment is forwarded to `request.onDelta` as it arrives, so a caller can render the
   * answer live while this method still reassembles and classifies the whole call identically. The
   * finish reason arrives on the final chunk; usage where providers send it.
   */
  private async consumeStream(
    response: Response,
    request: CompletionRequest,
    selfAbort: AbortSignal,
  ): Promise<CompletionResult> {
    const onProgress = request.onProgress ?? (() => {});
    const reader = response.body?.getReader();
    if (!reader) {
      return { ok: false, ...failure('malformed', 'The AI stream closed unexpectedly.', true) };
    }

    const decoder = new TextDecoder();
    let buffer = '';
    let text = '';
    let reasoningChars = 0;
    let finishReason: string | null = null;
    let sawDone = false; // a terminal event ([DONE] sentinel or finish_reason) was seen
    let usage = { promptTokens: 0, completionTokens: 0 };
    let lastReport = 0;

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data:')) continue;
          const payload = trimmed.slice(5).trim();
          if (payload === '[DONE]') {
            sawDone = true;
            continue;
          }
          try {
            const chunk = JSON.parse(payload) as {
              choices?: Array<{
                delta?: { content?: string | Array<{ text?: string }>; reasoning_content?: string };
                finish_reason?: string | null;
              }>;
              usage?: { prompt_tokens?: number; completion_tokens?: number };
            };
            const choice = chunk.choices?.[0];
            if (choice?.finish_reason) {
              finishReason = choice.finish_reason;
              sawDone = true;
            }
            if (chunk.usage) {
              usage = {
                promptTokens: chunk.usage.prompt_tokens ?? usage.promptTokens,
                completionTokens: chunk.usage.completion_tokens ?? usage.completionTokens,
              };
            }
            const delta = choice?.delta;
            if (delta?.reasoning_content) reasoningChars += delta.reasoning_content.length;
            const content = delta?.content;
            if (typeof content === 'string') {
              text += content;
              if (content.length > 0) request.onDelta?.(content);
            } else if (Array.isArray(content)) {
              const piece = content.map((part) => part?.text ?? '').join('');
              text += piece;
              if (piece.length > 0) request.onDelta?.(piece);
            }

            // Throttled progress: every ~400 chars, so a fast stream does not spam the callback.
            const total = text.length + reasoningChars;
            if (total - lastReport >= 400) {
              lastReport = total;
              onProgress(total);
            }
          } catch {
            /* a malformed chunk never kills the stream; the next one usually heals it */
          }
        }
        // A terminal event means the provider is FINISHED writing — not that the socket closed.
        // This provider sends its finish_reason and then HOLDS THE CONNECTION OPEN, so waiting for
        // the `done` read never ended: a fully-written answer hung until the per-attempt timeout,
        // and the learner's composer stayed disabled forever. A completion is finished when the
        // provider says it is.
        //
        // Trade-off accepted: a provider that sends a usage frame AFTER its finish_reason loses
        // those token counts. That is safe because the classification below never keys on usage —
        // `sawDone` alone decides clean-finish vs truncation, and usage only ever rides along as
        // diagnostics on the truncation path.
        if (sawDone) break;
      }
      // Release the socket the moment we stop reading: a held-open body must not linger now that
      // the answer is in hand (an un-cancelled reader keeps the connection alive behind us).
      void reader.cancel().catch(() => {});
      onProgress(text.length + reasoningChars);
    } catch {
      // Whose abort was it? The drain, the learner, our own timeout, or (none of those) the
      // provider dropping its own stream — the last one is a truncation with text, a network
      // error without, NOT a timeout: blaming ourselves for the provider's socket death both
      // retried a half-dead run and misnamed it in the learner's diagnosis.
      if (lifecycle.draining && !request.signal?.aborted) {
        return { ok: false, ...drainingFailure() };
      }
      if (request.signal?.aborted) {
        return { ok: false, ...failure('cancelled', 'The request was cancelled.', false) };
      }
      if (selfAbort.aborted) {
        return {
          ok: false,
          ...failure(
            'timeout',
            'The AI service took too long to answer. Try again in a moment.',
            true,
          ),
        };
      }
      if (text.length === 0) {
        return { ok: false, ...failure('network', 'The AI stream was interrupted.', true) };
      }
      // Text arrived but the stream never reached a terminal event — the socket died mid-program.
      // `00`: "a half-generated model must be detected, refused and retried, never delivered." The
      // gate cannot judge this: it checks structure, not completeness, and a cut landing on a
      // statement boundary parses happily while being half a model. Operator diagnostics first:
      // the reported usage vs the configured cap tells a CAP-HIT (raise AI_MAX_OUTPUT_TOKENS) from
      // an early stream death (provider/gateway problem) — two different problems that both used
      // to surface as one opaque `upstream_truncated`.
      console.warn(
        `[ai-client] stream truncated from the provider after ${text.length} chars — ` +
          `reported usage ${usage.promptTokens} prompt / ${usage.completionTokens} completion tokens, configured cap ${request.maxOutputTokens}`,
      );
      return {
        ok: false,
        ...failure('truncated', 'The model stopped writing partway through. Try again.', false),
        partialText: text,
        ...(usage.promptTokens > 0 || usage.completionTokens > 0
          ? {
              usage: { promptTokens: usage.promptTokens, completionTokens: usage.completionTokens },
            }
          : {}),
      };
    }

    if (text.length === 0) {
      if (finishReason === 'length') {
        return {
          ok: false,
          ...failure(
            'truncated',
            'The response was cut off before the model was complete. Try again.',
            true,
          ),
        };
      }
      return {
        ok: false,
        ...failure('malformed', 'The AI returned an empty reply. Try again.', true),
      };
    }

    // Clean EOF with text but no terminal event: the socket closed before the provider finished
    // its turn. `finish_reason` and the `[DONE]` sentinel are what "the reply ended" MEANS on this
    // wire; absent them, the text is the first half of a program, regardless of how complete it
    // looks (a cut at a statement boundary parses happily). The same operator diagnostics as the
    // abort path: usage-vs-cap distinguishes a token cap from an early stream death.
    if (!sawDone) {
      console.warn(
        `[ai-client] stream closed without a terminal event after ${text.length} chars — ` +
          `reported usage ${usage.promptTokens} prompt / ${usage.completionTokens} completion tokens, configured cap ${request.maxOutputTokens}`,
      );
      // Retryable is FALSE on purpose: the client's retry re-rolled the whole program at full price
      // with the same cut odds — this was the measured 79-minute battery killer. The truncation (and
      // what arrived of it) is returned to the pipeline, whose continuation protocol asks for only
      // the missing remainder against the partial program as an assistant turn.
      return {
        ok: false,
        ...failure('truncated', 'The model stopped writing partway through. Try again.', false),
        partialText: text,
        ...(usage.promptTokens > 0 || usage.completionTokens > 0
          ? {
              usage: { promptTokens: usage.promptTokens, completionTokens: usage.completionTokens },
            }
          : {}),
      };
    }

    return { ok: true, text, finishReason, usage };
  }
}

/** The drain failure, shared by the early check, the fetch catch and the stream catch. */
function drainingFailure(): AiFailure {
  return failure('draining', 'The server is restarting; this request was stopped.', false);
}
