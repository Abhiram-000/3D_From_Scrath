/**
 * The AI provider client: typed retries, truncation detection, translated failures.
 *
 * Deliberately dependency-free `fetch` against the OpenAI-compatible chat API. `04` leaves the client
 * library to us and the config makes the base URL swappable, and every SDK here would be a wrapper
 * around one `fetch` whose retries we would have to disable to layer our own on top — ours must own the
 * retry decision because it is *typed*: "retries for the transient, never for the semantic".
 *
 * Every failure this module returns is one of the platform's `ErrorCode`s with learner-facing words
 * attached, so a route never sees a raw provider dump.
 */
import type { ServerConfig } from '../config/config.ts';

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
}

export type CompletionResult =
  | {
      ok: true;
      text: string;
      /** The provider's finish reason, when reported. `length` means the cap truncated the reply. */
      finishReason: string | null;
      usage: { promptTokens: number; completionTokens: number };
    }
  | { ok: false; code: AiFailureCode; message: string; retryable: boolean; retryAfterSeconds?: number };

/** The failure vocabulary, kept local so the mapping to `ErrorCode` lives in one place. */
export type AiFailureCode =
  | 'quota'
  | 'refused'
  | 'truncated'
  | 'timeout'
  | 'network'
  | 'malformed'
  | 'status';

/** Retry policy. Two retries with backoff — enough to ride out a blip, bounded so cost cannot run away (`04`). */
const MAX_ATTEMPTS = 3;

/**
 * The model cascade, tried in order when a provider failure is model-shaped (quota, demand, retired).
 *
 * Gemini's free tier throttles per-model: a demand spike on the newest flash should not kill a
 * generation when the previous flash still has headroom. The configured model always goes first;
 * these are the fallbacks, newest to oldest.
 */
const MODEL_FALLBACKS = ['gemini-3.8-flash', 'gemini-flash-latest', 'gemini-2.5-flash'] as const;
const BASE_BACKOFF_MS = 1_500;
/** Per-call timeout for generation-sized requests. A deep-reasoning model writing a full program
 *  over the complete API surface routinely takes 4-8 minutes on a free tier; 180s aborted the
 *  stream mid-body, which surfaced as "unparseable reply" rather than the timeout it was. */
const REQUEST_TIMEOUT_MS = 540_000;

/** A rough status → failure mapping. Everything unrecognised is `status` and retryable at this layer. */
function classifyStatus(status: number, bodyText: string): AiFailure {
  if (status === 401 || status === 403) {
    return failure('status', 'The AI service rejected this server’s credentials. Check AI_API_KEY.', false);
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
  if (status >= 500) {
    return failure('status', 'The AI service failed to answer. Try again in a moment.', true);
  }
  // 4xx other than auth: our request shape is wrong somewhere. Not retryable — that would burn money.
  return failure('malformed', `The AI service rejected the request: ${bodyText.slice(0, 200)}`, false);
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

/** Sleep without a dangling timer on shutdown. */
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class AiClient {
  private readonly config: ServerConfig;

  constructor(config: ServerConfig) {
    this.config = config;
  }

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    // The cascade starts with the configured model; each model-shaped failure moves to the next.
    const models = [this.config.ai.model, ...MODEL_FALLBACKS.filter((m) => m !== this.config.ai.model)];
    let lastFailure: CompletionResult | null = null;

    for (const model of models) {
      const result = await this.completeWithModel(model, request);
      if (result.ok) return result;
      lastFailure = result;
      // Only quota/demand failures justify switching models; anything else is request-shaped or fatal.
      if (result.code !== 'quota') break;
    }

    // The cross-provider fallback: an independent service with its own quota. Reached only when
    // every model of the primary provider is throttled or down — the learner's minutes-long wait
    // must not die because one free tier had a bad afternoon (`04`: degraded modes are real modes).
    const fallback = this.config.ai.fallback;
    if (fallback?.apiKey && lastFailure && !lastFailure.ok) {
      const crossed = await this.completeWithProvider(
        fallback.baseUrl,
        fallback.apiKey,
        fallback.model,
        request,
      );
      if (crossed.ok) return crossed;
    }

    return lastFailure as CompletionResult;
  }

  private async completeWithProvider(
    baseUrl: string,
    apiKey: string,
    model: string,
    request: CompletionRequest,
  ): Promise<CompletionResult> {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      const result = await this.attempt(model, request, attempt === MAX_ATTEMPTS, baseUrl, apiKey);
      if (result.ok) return result;
      if (!result.retryable || attempt === MAX_ATTEMPTS) return result;
      await sleep(BASE_BACKOFF_MS * 2 ** (attempt - 1));
    }
    throw new Error('unreachable');
  }

  private async completeWithModel(
    model: string,
    request: CompletionRequest,
  ): Promise<CompletionResult> {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      const result = await this.attempt(model, request, attempt === MAX_ATTEMPTS);
      if (result.ok) return result;

      // Non-retryable, or the final attempt: the failure stands for this model.
      if (!result.retryable || attempt === MAX_ATTEMPTS) return result;

      // A quota backoff is dictated by the provider; anything else is exponential.
      const backoff = result.retryAfterSeconds
        ? result.retryAfterSeconds * 1000
        : BASE_BACKOFF_MS * 2 ** (attempt - 1);
      await sleep(backoff);
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
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), request.timeoutMs ?? REQUEST_TIMEOUT_MS);
    const baseUrl = baseUrlOverride ?? this.config.ai.baseUrl;
    const apiKey = apiKeyOverride ?? this.config.ai.apiKey ?? '';

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
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const bodyText = await response.text().catch(() => '');
        const classified = classifyStatus(response.status, bodyText);
        if (!classified.retryable || finalAttempt) return { ok: false, ...classified };
        return { ok: false, ...classified };
      }

      const json = (await response.json().catch(() => null)) as
        | {
            choices?: Array<{
              message?: { content?: string | Array<{ text?: string }> };
              finish_reason?: string;
            }>;
            usage?: { prompt_tokens?: number; completion_tokens?: number };
          }
        | null;

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
            ...failure('truncated', 'The response was cut off before the model was complete. Try again.', true),
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
      if (error instanceof Error && error.name === 'AbortError') {
        return {
          ok: false,
          ...failure(
            'timeout',
            'The AI service took too long to answer. Try again in a moment.',
            true,
          ),
        };
      }
      return {
        ok: false,
        ...failure('network', 'The AI service could not be reached. Try again in a moment.', true),
      };
    } finally {
      clearTimeout(timer);
    }
  }
}
