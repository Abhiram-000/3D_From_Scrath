/**
 * The generation pipeline: topic → validated model, streamed as NDJSON.
 *
 * `04` fixes the stages and the order: prompt assembly → AI call → extract code → static gate →
 * bounded self-repair → audit → one refinement pass → persist. Each stage reports a phase event as it
 * begins, heartbeats cover the silences, and exactly one terminal event ends the stream.
 *
 * The three money rules encoded here (`04` "Cost management"):
 *   - retries for the transient, never for the semantic (the AiClient owns that);
 *   - self-repair capped at 2 passes, "because each pass costs money";
 *   - exactly one refinement pass, "accepted only if genuinely better — a degenerate second attempt
 *     must never replace a decent first one".
 */
import {
  HEARTBEAT_INTERVAL_MS,
  PIPELINE_DEADLINE_MS,
  REFINEMENT_THRESHOLD,
  ModelManifest,
  type AuditReport,
  type GenerationEvent,
  type GenerationPhase,
  type ModelBundle,
  type ModelManifest as ManifestShape,
} from '@edu3d/contracts';
import { prepareProgram, describeViolations } from '@edu3d/sandbox';
import { apiSurface } from '@edu3d/engine';
import { auditModelAsync } from './audit-worker.ts';
import type { AiClient, CompletionResult } from './ai-client.ts';
import { lifecycle as defaultLifecycle, type LifecycleService } from './lifecycle.ts';
import {
  PROMPT_VERSION,
  buildGenerationPrompt,
  buildRefinementPrompt,
  buildRepairPrompt,
  wrapTopic,
} from './prompts.ts';

export const MAX_REPAIR_PASSES = 2;

/**
 * Which wall stopped a truncated reply — the runtime half of the diagnosis the provider's /models
 * data motivated. The remedies differ completely, so the pipeline says which one it saw:
 *
 *   - `output_cap` — reported completion tokens reached OUR configured ceiling. The wall is ours;
 *     the remedy is raising `AI_MAX_OUTPUT_TOKENS` (now 131,072 — the provider permits 393,216 on
 *     deepseek-v4-flash, so we were asking for 6× less than the model allows).
 *   - `early_stream` — the provider reported usage BELOW our cap, yet the reply is incomplete:
 *     either the gateway cut the stream, or the model is a reasoning model whose thinking tokens
 *     are not counted in `completion_tokens` and consumed budget invisibly. The cap raise only
 *     helps the second variant; the continuation protocol handles both.
 *   - `unreported` — no usage arrived at all (premature socket death): nothing to compare, the
 *     provider died before accounting for anything.
 */
export type TruncationWall = 'output_cap' | 'early_stream' | 'unreported';

export function classifyTruncationWall(
  usage: { completionTokens: number } | undefined,
  maxOutputTokens: number,
): TruncationWall {
  if (usage && usage.completionTokens >= maxOutputTokens) return 'output_cap';
  if (usage && usage.completionTokens > 0) return 'early_stream';
  return 'unreported';
}

/**
 * Bounded continuation passes: how many times a cut-off reply may be CONTINUED on top of the first
 * attempt (so a program may be assembled from up to `1 + MAX_CONTINUATION_PASSES` pieces).
 *
 * Why continuation and not the old complete-re-ask: every measured generation failure was
 * `upstream_truncated`, on exactly the topics needing the longest programs, and the old remedy —
 * send the partial back, ask for the COMPLETE program again — has the same probability of being
 * cut a second time while paying a full re-roll. That is why those topics failed twice and gave
 * up. A continuation sends the partial as an ASSISTANT turn and asks for only the missing
 * remainder: the model's output budget goes to new code instead of re-emitting what already
 * arrived, and each pass resumes from further along. Three is the bound because every pass is
 * still a multi-minute paid call; past that, failing with an honest diagnosis beats stacking
 * more attempts on a provider that is out of room. (Wire-visible constant: it bounds how long a
 * truncation-recovering run may take, roughly `(1 + 3) × one_generation` in the worst case.)
 */
export const MAX_CONTINUATION_PASSES = 3;

/** The sink the pipeline emits into — a real stream, or the buffer the non-streaming path reads. */
export interface PipelineSink {
  (event: GenerationEvent): void;
}

export interface PipelineDeps {
  ai: AiClient;
  sink: PipelineSink;
  /** Tier the request came from, so the prompt and the audit price against that device. */
  tier: 'low' | 'mid' | 'high';
  maxOutputTokens: number;
  /**
   * The learner's connection. Checked before every AI call and forwarded to the provider fetch, so a
   * closed tab stops the run rather than letting it burn three more calls for nobody.
   *
   * The run's provider calls are signalled with `AbortSignal.any([deps.signal, deadline])`, so the
   * overall deadline (`PIPELINE_DEADLINE_MS`) aborts in-flight provider work too.
   */
  signal?: AbortSignal;
  /**
   * Drain signal + generation counter, defaulted to the process singleton. The pipeline checks
   * it at every phase boundary so a draining server turns in-flight streams into the terminal
   * `draining` error event the shutdown contract promises, and spends no further provider calls.
   */
  lifecycle?: LifecycleService;
}

/** Terminal failures, mapped to the wire's error codes by the route. */
export interface PipelineFailure {
  code:
    | 'upstream_failed'
    | 'upstream_truncated'
    | 'upstream_refused'
    | 'upstream_quota'
    | 'generation_unrepairable'
    | 'generation_rejected'
    /** The drain was flipped mid-run (`06`): the terminal event the shutdown contract promises. */
    | 'draining'
    /** The learner closed the tab. Not a failure anyone will read — the stream is already gone. */
    | 'cancelled'
    /**
     * The bounded generation-queue wait ran out (services/generation-queue.ts → 429). An existing
     * `ErrorCode` — the honest name for "the server is at its provider concurrency and the wait
     * for a slot expired", with a retry-after telling the client when to come back.
     */
    | 'rate_limited'
    /** An unexpected fault inside the pipeline itself — carries `internal`'s honest status. */
    | 'internal';
  message: string;
  retryAfterSeconds?: number;
}

/** Real provider spend for the run, recorded in provenance (`04`: cost visibility per generation). */
export interface ProviderUsage {
  promptTokens: number;
  completionTokens: number;
}

/**
 * The terminal failure for a run that outlived the server's OVERALL deadline
 * (`PIPELINE_DEADLINE_MS` in `@edu3d/contracts`, with the invariant written next to the numbers).
 *
 * The code is the taxonomy's `upstream_failed` — a run that dies to stacked provider latency and
 * retries IS an upstream death — but the MESSAGE must name itself: "the model stopped responding"
 * is false here, and so is a bare internal fault. The learner gets the deadline and the remedy.
 */
export function deadlineFailure(): PipelineFailure {
  return {
    code: 'upstream_failed',
    message:
      `This generation ran past the server's overall time limit (${PIPELINE_DEADLINE_MS / 60_000} ` +
      'minutes) and was stopped. Try again — a shorter or simpler topic usually finishes sooner.',
  };
}

/**
 * The marker the deadline machinery throws once the wall is exceeded. `runPipeline` never lets it
 * escape — its catch converts it to `deadlineFailure()` — but throwing is what lets the deadline
 * cut through every stage (paid calls, their backoffs, phase boundaries) without each one having
 * to know the shape of the terminal failure.
 */
class PipelineDeadlineElapsedError extends Error {
  constructor() {
    super('the overall pipeline deadline elapsed');
    this.name = 'PipelineDeadlineElapsedError';
  }
}

const nowSec = () => Date.now();

/**
 * Truncation/refusal detection on the REPLY as a whole — the server-side half of "truncation is
 * detected, never shipped".
 *
 * `prepareProgram`'s own signals (`finishReason === 'length'`, brace depth, unterminated
 * strings/comments) miss two classes of cut:
 *   1. a fenced block whose closing fence never arrived — the reply stopped mid-program (the
 *      overwhelmingly common streamed cut) even when the code tail happens to parse and balance;
 *   2. a token-budget reply where the provider under-reports `length` but the usage it DID
 *      report hit the output cap exactly — the cap is the truncation, whatever `finish_reason`
 *      claims;
 *   3. a parse error lying on the program's last lines — the reply stopped mid-statement.
 *
 * A legitimately complete program closes its fence, sits under the cap with a genuine `stop`,
 * and parses clean — none of the signals above fire on it. A signal never refuses a program
 * outright: it routes the run into the bounded continuation protocol (`MAX_CONTINUATION_PASSES`
 * re-asks for only the missing remainder), so even a border case costs one small call, not a refusal.
 */
function replyLooksCut(
  rawReply: string,
  prepared: ReturnType<typeof prepareProgram>,
  maxOutputTokens: number,
  usage?: { completionTokens: number },
): boolean {
  // 1. An unclosed fence: count line-anchored ``` markers; each open expects its close, and the
  //    prompt demands ONE fenced program block — an odd count means the cut landed inside it.
  const fenceMarkers = (rawReply.match(/^[ \t]*```/gm) ?? []).length;
  if (fenceMarkers > 0 && fenceMarkers % 2 === 1) return true;

  // 2. The output cap was hit: the provider reported usage and it reached the configured ceiling.
  if (usage && maxOutputTokens > 0 && usage.completionTokens >= maxOutputTokens) return true;

  // 3. A syntax failure lying on the program's final lines: the reply stopped mid-statement.
  if (!prepared.gate.ok) {
    const lastLine = prepared.code.trimEnd().split('\n').length;
    return prepared.gate.violations.some(
      (v) => v.kind === 'syntax' && typeof v.line === 'number' && Math.abs(v.line - lastLine) <= 2,
    );
  }
  return false;
}

/** A fenced block, with or without a language tag (same shape `prepareProgram` extracts). */
const CLOSED_FENCE = /```(?:javascript|js|jsx|typescript|ts)?[ \t]*\r?\n([\s\S]*?)\r?\n?[ \t]*```/g;
/** An opening fence line whether or not its block was ever closed. */
const OPEN_FENCE = /```(?:javascript|js|jsx|typescript|ts)?[ \t]*\r?\n/;

/** The largest CLOSED fenced block in a reply, or null when there is none. */
function largestClosedFence(raw: string): string | null {
  const blocks = [...raw.matchAll(CLOSED_FENCE)].map((match) => match[1] ?? '');
  if (blocks.length === 0) return null;
  return blocks.reduce((longest, block) => (block.length > longest.length ? block : longest));
}

/** First non-empty, trimmed line of a line list — the seam/restart anchor. */
function firstNonEmptyLine(lines: string[]): string {
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return '';
}

/**
 * Join a partial program and its continuation into one fenced program.
 *
 * Returns the RAW reply to feed into `prepareProgram` and `replyLooksCut` and to hand to later
 * repair prompts — always exactly one CLOSED fence, so fence parity is restored by construction.
 *
 * The seam cases, in the order they are handled:
 *   1. **Restart** — the model ignored "continue" and rewrote the whole program (observed under
 *      the old complete-re-ask instruction). Detected by its first line matching the partial's
 *      first line; a rewrite supersedes the partial, so it ships alone.
 *   2. **Echoed tail** — the model repeats the last line(s) before continuing (models asked to
 *      "continue from where you stopped" routinely echo one or two lines). Bounded suffix/prefix
 *      line match drops the repeated span. A single-line echo only counts when the line is
 *      substantive (≥ 5 chars): an echo of `});` is too ambiguous to match on and is left to the
 *      gate + repair loop instead of risking a silently wrong dedupe.
 *   3. **Mid-token seam** — the cut landed inside a statement, so the continuation's first
 *      characters ARE the rest of the partial's last line: joined with no separator
 *      (`const radius = 0.` + `5;` → `const radius = 0.5;`).
 *   4. **Clean seam** — the partial's last line ended a statement; joined with a newline.
 *   5. **Everything else** — a seam the model phrased in a way these rules did not predict will
 *      usually fail the static gate ON THE SEAM LINES, which is not wasted: the existing bounded
 *      repair loop (stage 4) sends the model its own stitched code plus the exact violations, and
 *      a seam fix is precisely the one-line-specific-error repair that loop was built for.
 */
export function stitchContinuation(partialReply: string, continuationReply: string): string {
  // ── Head: what the provider wrote before the cut ──
  // A streamed cut usually opens a fence it never closes; a cap cut with text after the fence
  // closed leaves a stray closing fence. Both are dropped — we only keep code.
  let head = partialReply;
  const open = head.match(OPEN_FENCE);
  if (open?.index !== undefined) head = head.slice(open.index + open[0].length);
  head = head.replace(/```[ \t]*\s*$/, '');

  // ── Continuation body: closed fence first, then content after an opening fence, else the raw
  // reply (minus one leading prose line when the model ignored the fence instruction entirely —
  // a line with no code punctuation in it before the first code-shaped line).
  let contBody = largestClosedFence(continuationReply);
  if (contBody === null) {
    const contOpen = continuationReply.match(OPEN_FENCE);
    contBody =
      contOpen?.index !== undefined
        ? continuationReply.slice(contOpen.index + contOpen[0].length)
        : continuationReply.trim();
    if (contOpen?.index === undefined) {
      const lines = contBody.split('\n');
      const firstCode = lines.findIndex(
        (line) =>
          /^\s*(import\b|const\b|let\b|var\b|function\b|\/\/|\/\*|for\b|if\b|return\b|export\b)/.test(
            line,
          ) || line.includes('ctx.'),
      );
      if (firstCode > 0) contBody = lines.slice(firstCode).join('\n');
    }
  }
  contBody = contBody.trim();
  const contLines = contBody.split('\n');
  const headLines = head.split('\n');

  // 1. Restart: the continuation begins with the partial's own first line.
  const contFirst = firstNonEmptyLine(contLines);
  const headFirst = firstNonEmptyLine(headLines);
  if (contFirst.length > 0 && contFirst === headFirst) {
    return '```javascript\n' + contBody + '\n```';
  }

  // 2. Echoed tail: longest suffix of the head that the continuation repeats as its prefix.
  //    Line-granularity (not char) because models echo whole lines, and capped so a pathological
  //    reply cannot cost an unbounded scan.
  const MAX_OVERLAP_LINES = 24;
  let overlap = 0;
  const headTrimmed = headLines.map((line) => line.trimEnd());
  for (let n = Math.min(MAX_OVERLAP_LINES, headLines.length, contLines.length); n >= 1; n -= 1) {
    const suffix = headTrimmed.slice(headLines.length - n).join('\n');
    const prefix = contLines
      .slice(0, n)
      .map((line) => line.trimEnd())
      .join('\n');
    if (suffix.length > 0 && suffix === prefix && (n >= 2 || suffix.length >= 5)) {
      overlap = n;
      break;
    }
  }
  const joinLines = overlap > 0 ? headLines.slice(0, headLines.length - overlap) : headLines;

  // 3./4. The seam: the continuation resumes whatever line the head stopped in. If that line is a
  // complete statement (or a blank/closed block), the continuation starts a NEW line; if it is
  // half-written, the continuation's first characters complete it — no separator. On a direct
  // join, trailing BLANK lines of the head are dropped first: a fence-stripped partial often
  // carries one, and `...frag\n` + `` would put the continuation's mid-line characters on a line
  // of their own — a stealth syntax error exactly at the seam.
  const lastJoinLine = firstNonEmptyLine([...joinLines].reverse());
  const statementComplete =
    joinLines.length === 0 || /(^|[^\\])[;{}]$/.test(lastJoinLine) || lastJoinLine.endsWith('*/');
  const separator = joinLines.length === 0 || statementComplete ? '\n' : '';
  // Drop the head's trailing blank lines ONLY on a direct join: a fence-stripped partial often
  // carries one, and `...frag\n` + `` would put the continuation's mid-line characters on a line
  // of their own — a stealth syntax error exactly at the seam. On a newline join the head's own
  // trailing blank lines are content (a blank line between sections) and must survive.
  if (separator === '') {
    while (joinLines.length > 0 && joinLines.at(-1)?.trim() === '') joinLines.pop();
  }

  const body = (joinLines.join('\n') + separator + contBody).replace(/^\n+/, '');
  return '```javascript\n' + body + '\n```';
}

/**
 * The continuation instruction sent with the partial program as an assistant turn (`04`: prompts
 * are assembled in one module per concern; this one exists because it is protocol, not persuasion).
 *
 * Output-length discipline lives here deliberately: comments and restated instructions are not
 * content, so the instruction forbids re-emitting them — and forbids repeating code already sent,
 * which was the failure mode of the old complete-re-ask. The 5-line PLAN/FACTS/... block and the
 * per-part info text are content and are untouched; this prompt only asks for the REMAINDER of the
 * program, never for less model.
 */
function buildContinuationPrompt(partialProgram: string): string {
  // Anchor: the last two written lines, so "where it stopped" is unambiguous even though the
  // assistant turn above carries the whole partial. (Candidates for the seam, not instructions.)
  const tail = partialProgram
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .slice(-2)
    .join('\n');
  return [
    'Your reply above stopped partway through the program.',
    'Continue from EXACTLY where it stopped: the first characters you write must be the very next characters of the program — they may complete a line you were in the middle of.',
    'Do NOT repeat any code written before the cut, do NOT restart the program, do NOT restate your plan or the platform instructions.',
    'Write ONLY the missing remainder of the program, in one fenced JavaScript block, with no prose before or after it.',
    'Comments are not content: add none except where a line is genuinely non-obvious, and do not re-emit comment sections you already wrote.',
    '',
    'For reference, the program so far ends with these lines:',
    '```',
    tail,
    '```',
  ].join('\n');
}

/** Every contracts-schema violation the manifest would 400 on at publish (`ModelManifest`). */
function manifestIssues(manifest: ManifestShape): string[] {
  const checked = ModelManifest.safeParse(manifest);
  if (checked.success) return [];
  return checked.error.issues
    .filter((issue) => !isEngineOwnedField(issue))
    .slice(0, 16)
    .map(
      (issue) =>
        `${issue.path.filter((part) => typeof part !== 'number').join('.')}: ${issue.message}`,
    );
}

/**
 * Engine-owned serialization fields are not authoring decisions, so they are not repairable by
 * the model and must not fail a legitimate run: the engine's geometry dedup key (`cacheKey`)
 * used to exceed the contract's 512-char cap on composite geometry (measured 3,114 chars on the
 * reference turbofan's swept bypass ribbon) with NOTHING about the model's plan being wrong.
 * Exclude them so the manifest gate judges only the model's own choices (counts, lengths of
 * authored strings, numeric ranges).
 *
 * The engine now emits contract-bounded keys (a fixed-length digest past 512 — see
 * `packages/engine/src/geometry/factory.ts`), so an over-cap key no longer occurs on current
 * builds; the exclusion stays as belt-and-braces for manifests authored by an older engine
 * build still resident in the gallery, which must remain readable and re-publishable.
 */
function isEngineOwnedField(issue: { path: PropertyKey[] }): boolean {
  return issue.path.length > 0 && issue.path[issue.path.length - 1] === 'cacheKey';
}

/**
 * Run the pipeline. Never throws — every failure is a returned value the route turns into the
 * terminal `error` event, because "a stream that ends without a terminal event is itself treated as a
 * failure by the client" and an exception escaping here would end it exactly that way.
 */
export async function runPipeline(
  topic: string,
  complexity: 'simple' | 'balanced' | 'detailed' | 'maximum',
  deps: PipelineDeps,
): Promise<
  | {
      ok: true;
      bundle: ModelBundle;
      audit: { score: number; deficiencies: string[]; unboundParameterIds: string[] };
    }
  | { ok: false; failure: PipelineFailure }
> {
  const started = Date.now();
  const lifecycle = deps.lifecycle ?? defaultLifecycle;
  lifecycle.beginGeneration();

  // ── The overall deadline: the server ALWAYS terminates before any client timer fires ────────
  // The invariant and its arithmetic live with the numbers (`PIPELINE_DEADLINE_MS` in
  // `@edu3d/contracts`). The old shape had no overall wall at all — only per-attempt bounds — so a
  // run's multiplicative worst case (cascades × retries × continuations × repairs) was many times
  // the client's timer, and the client always gave up first, blanking the server's diagnosis. The
  // deadline is enforced on this run's own wall clock; hitting it aborts the in-flight provider
  // work through `runSignal` and the error is converted to `deadlineFailure()` in the catch below.
  const deadlineAt = started + PIPELINE_DEADLINE_MS;
  const deadlineController = new AbortController();
  const runSignal = deps.signal
    ? AbortSignal.any([deps.signal, deadlineController.signal])
    : deadlineController.signal;
  const deadlineTimer = setInterval(() => {
    if (Date.now() >= deadlineAt) deadlineController.abort();
  }, 1_000);

  // ── Heartbeat loop: the thing that makes silence diagnostic (`04` stage 5) ──────────────
  let heartbeatsStopped = false;
  const phaseStart = { phase: 'queued' as GenerationPhase, at: Date.now() };
  /** Characters the provider has streamed in the current phase — the learner's proof of life. */
  let charsWritten = 0;
  const heartbeatTimer = setInterval(() => {
    if (heartbeatsStopped) return;
    deps.sink({
      type: 'heartbeat',
      phase: phaseStart.phase,
      phaseSeconds: (Date.now() - phaseStart.at) / 1000,
      ...(charsWritten > 0 ? { charsWritten } : {}),
      at: nowSec(),
    });
  }, HEARTBEAT_INTERVAL_MS);
  const enter = (phase: GenerationPhase, message: string) => {
    phaseStart.phase = phase;
    phaseStart.at = Date.now();
    deps.sink({ type: 'phase', phase, message, at: nowSec() });
  };
  const stopHeartbeats = () => {
    heartbeatsStopped = true;
    clearInterval(heartbeatTimer);
    clearInterval(deadlineTimer);
    lifecycle.endGeneration(); // mirrored to finish(): no double release
  };

  /**
   * Paid provider calls for the run. Every `deps.ai.complete` goes through here so both the
   * correction-count in provenance and the real token spend are one consistent measurement —
   * a bundle used to report `repairPasses: 0` after the truncation re-ask had already spent a
   * call the learner paid for.
   */
  let providerCalls = 0;
  const providerUsage: ProviderUsage = { promptTokens: 0, completionTokens: 0 };
  const spend = async (request: {
    messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
    temperature: number;
    onProgress?: (chars: number) => void;
  }): Promise<CompletionResult> => {
    providerCalls += 1;
    const result = await deps.ai.complete({
      messages: request.messages,
      maxOutputTokens: deps.maxOutputTokens,
      temperature: request.temperature,
      // `runSignal`, not the learner's bare signal: the deadline must reach the provider fetch and
      // its backoff sleeps too, or an in-flight call would pin the stream past the client timers.
      signal: runSignal,
      onProgress: request.onProgress,
    });
    if (result.ok) {
      providerUsage.promptTokens += result.usage.promptTokens;
      providerUsage.completionTokens += result.usage.completionTokens;
    }
    // Post-call deadline gate. The deadline abort surfaces from the client as its own non-retryable
    // 'cancelled' classification; the deadline outranks that translation — the honest terminal
    // failure is the one that names the wall. (The learner's own abort still maps to 'cancelled'.)
    if (deps.signal?.aborted) return result;
    if (Date.now() >= deadlineAt) {
      deadlineController.abort();
      throw new PipelineDeadlineElapsedError();
    }
    return result;
  };

  /** The drain checks the shutdown contract promised (`06`): before each paid call and phase. */
  const drainCheck = (): PipelineFailure | null => {
    // Phase boundaries are the deadline's second checkpoint: between two paid calls, where the
    // post-call gate in `spend` does not apply. Throwing is safe here — every call site sits
    // inside runPipeline's try, and the catch reads the deadline failure, never this throw.
    if (Date.now() >= deadlineAt) {
      deadlineController.abort();
      throw new PipelineDeadlineElapsedError();
    }
    if (!lifecycle.draining) return null;
    return { code: 'draining', message: 'The server is restarting — the run stopped mid-stream.' };
  };

  try {
    // ── Stage 1: prompt assembly ─────────────────────────────────────────────
    const drained = drainCheck();
    if (drained) return { ok: false, failure: drained };
    enter('prompt', 'Loading the generation contract…');
    const systemPrompt = buildGenerationPrompt({ complexity, tier: deps.tier });

    // ── Stage 2: the AI call ─────────────────────────────────────────────────
    enter('model', 'The model is designing your 3D scene…');
    charsWritten = 0;
    // Checked here as well as inside the client: the repair and refinement stages each spend a call,
    // and the gap between "learner closed the tab" and "next stage begins" is where the money leaks.
    if (deps.signal?.aborted) {
      return {
        ok: false,
        failure: { code: 'cancelled', message: 'The request was cancelled.' },
      };
    }
    const firstFailure = drainCheck();
    if (firstFailure) return { ok: false, failure: firstFailure };
    const first = await spend({
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: wrapTopic(topic) },
      ],
      temperature: 0.4,
      onProgress: (chars) => {
        charsWritten = chars;
        // Immediate sink on progress: the heartbeat interval is 10s, but a learner staring at a
        // stalled bar needs the number the moment it moves (`07`).
        deps.sink({
          type: 'heartbeat',
          phase: 'model',
          phaseSeconds: (Date.now() - phaseStart.at) / 1000,
          charsWritten: chars,
          at: nowSec(),
        });
      },
    });
    // The truncation handoff: a stream that died mid-program now ARRIVES as a failure carrying
    // its partial text (`partialText`, set by the AI client). That partial is real minutes of
    // provider work — measured as the dominant failure — and the continuation protocol below
    // spends it instead of discarding it and re-rolling everything.
    let replyText: string;
    let replyFinish: string | null;
    let replyUsage = { promptTokens: 0, completionTokens: 0 };
    if (first.ok) {
      replyText = first.text;
      replyFinish = first.finishReason;
      replyUsage = first.usage;
    } else if (
      first.code === 'truncated' &&
      typeof first.partialText === 'string' &&
      first.partialText.trim().length > 0
    ) {
      replyText = first.partialText;
      // A truncated call is still real spend; count it in the run's provider accounting.
      if (first.usage) {
        replyUsage = first.usage;
        providerUsage.promptTokens += first.usage.promptTokens;
        providerUsage.completionTokens += first.usage.completionTokens;
      }
      replyFinish = null;
    } else {
      return {
        ok: false,
        failure: {
          code: mapAiFailure(first.code),
          message: first.message,
          ...(first.retryAfterSeconds ? { retryAfterSeconds: first.retryAfterSeconds } : {}),
        },
      };
    }

    // ── Stage 3: extract + gate ──────────────────────────────────────────────
    // One call, two jobs: the program is read out of the reply *and* checked against the
    // sandbox rules. The sentence says both, because the learner is waiting through both.
    enter('extract', 'Reading the program the model wrote and checking it against the rules…');
    let prepared = prepareProgram(replyText, {
      apiSurface: apiSurface().qualified,
      finishReason: replyFinish ?? undefined,
    });
    // The reply, reassembled as the pipeline will carry it forward — after a cut it is the
    // stitched program (below), and the repair prompt's assistant turn and the bundle diagnostics
    // must both point at the same text the provider's work produced.
    let rawOutput = replyText;

    // ── The continuation protocol (`MAX_CONTINUATION_PASSES`) ────────────────
    // `replyLooksCut` says the program is incomplete — a cap hit, an unclosed fence, or a syntax
    // error lying on the last lines. Instead of failing, and instead of re-asking for a COMPLETE
    // program (same cut probability, full price — the reason every measured failure failed twice),
    // the partial is sent back as an ASSISTANT turn and the model is asked for ONLY the missing
    // remainder. Each pass resumes from further along, so the wall becomes an iteration.
    let continuations = 0;
    // `lastContinuationComplete`: a continuation that the CLIENT saw end truncated may have been
    // cut on a statement boundary (invisible to the gate, invisible to `replyLooksCut` — that is
    // exactly the stealth cut) — but we KNOW the tail never arrived. The loop keeps going until
    // a continuation ends cleanly; the seam rules absorb whatever echo the next pass adds.
    let lastContinuationComplete: boolean | null = null;
    while (
      replyLooksCut(rawOutput, prepared, deps.maxOutputTokens, replyUsage) ||
      lastContinuationComplete === false
    ) {
      // Name the wall once, server-side: cap vs early cut vs unreported tells the operator which
      // remedy applies (raise the cap / live with the gateway / nothing observable). The provider's
      // /models data says our cap sits far BELOW what the model permits, so `output_cap` here means
      // our own ceiling is still the binding constraint.
      if (continuations === 0) {
        const wall = classifyTruncationWall(replyUsage, deps.maxOutputTokens);
        console.warn(
          `[pipeline] reply truncated (${wall}): reported usage ${replyUsage.promptTokens} prompt / ` +
            `${replyUsage.completionTokens} completion tokens against a ${deps.maxOutputTokens}-token cap` +
            `${wall === 'output_cap' ? ' — our cap is the wall' : ''}`,
        );
      }
      if (continuations >= MAX_CONTINUATION_PASSES) {
        // Bounded, honest end: the seam diagnosis so far plus WHICH wall kept winning — the
        // remedy differs completely (raise the cap vs gateway death), so say which one it saw.
        const wall = classifyTruncationWall(replyUsage, deps.maxOutputTokens);
        const wallLine =
          wall === 'output_cap'
            ? `Our output cap (${deps.maxOutputTokens} tokens) is still the binding constraint.`
            : wall === 'early_stream'
              ? 'The provider reports usage below the cap yet the program never finished.'
              : 'The provider died before reporting any usage.';
        return {
          ok: false,
          failure: {
            code: 'upstream_truncated',
            message:
              `The model ran out of writing room ${continuations + 1} times and still could not ` +
              `finish the program. ${wallLine} Try again — a simpler phrasing of the topic often fits.`,
          },
        };
      }
      continuations += 1;
      // Truncation is made VISIBLE here (`notice`), not swallowed: the learner sees the model ran
      // out of room and that the server is rescuing the work, pass by bounded pass.
      deps.sink({
        type: 'notice',
        kind: 'retry',
        message:
          `The model ran out of room partway through; asking it to continue from where it stopped ` +
          `(pass ${continuations} of ${MAX_CONTINUATION_PASSES})…`,
        at: nowSec(),
      });
      const cutFailure = drainCheck();
      if (cutFailure) return { ok: false, failure: cutFailure };
      if (deps.signal?.aborted) {
        return {
          ok: false,
          failure: { code: 'cancelled', message: 'The request was cancelled.' },
        };
      }
      charsWritten = 0;
      const cont = await spend({
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: wrapTopic(topic) },
          { role: 'assistant', content: rawOutput },
          { role: 'user', content: buildContinuationPrompt(prepared.code) },
        ],
        temperature: 0.2,
        onProgress: (chars) => {
          charsWritten = chars;
          // Same proof-of-life as the model phase, reported against the extract phase the run is
          // actually in — the phase never rewinds, the bar never moves backwards.
          deps.sink({
            type: 'heartbeat',
            phase: phaseStart.phase,
            phaseSeconds: (Date.now() - phaseStart.at) / 1000,
            charsWritten: chars,
            at: nowSec(),
          });
        },
      });
      // The continuation itself may be cut (long programs may take two or three continuations —
      // the point of bounding at three). A cut continuation still carries usable partial text.
      const contText = cont.ok
        ? cont.text
        : cont.code === 'truncated' && cont.partialText && cont.partialText.trim().length > 0
          ? cont.partialText
          : null;
      if (contText === null) {
        if (cont.ok) throw new Error('unreachable: an ok completion always yields text');
        return {
          ok: false,
          failure: {
            code: mapAiFailure(cont.code),
            message: cont.message,
            ...(cont.retryAfterSeconds ? { retryAfterSeconds: cont.retryAfterSeconds } : {}),
          },
        };
      }
      lastContinuationComplete = cont.ok;
      if (cont.ok) {
        replyUsage = cont.usage;
        replyFinish = cont.finishReason;
      } else {
        // Truncated continuation: count its spend, then loop — `replyLooksCut` below will see the
        // still-unclosed program and schedule the next pass.
        if (cont.usage) {
          replyUsage = cont.usage;
          providerUsage.promptTokens += cont.usage.promptTokens;
          providerUsage.completionTokens += cont.usage.completionTokens;
        }
        replyFinish = null;
      }
      // Stitch: one closed fence back, seam rules per `stitchContinuation`. If the seam lands
      // badly, the gate fails on the seam lines and the stage-4 repair loop owns the fix.
      rawOutput = stitchContinuation(rawOutput, contText);
      prepared = prepareProgram(rawOutput, {
        apiSurface: apiSurface().qualified,
        finishReason: replyFinish ?? undefined,
      });
    }

    // ── Stage 4: bounded self-repair ─────────────────────────────────────────
    let gateRepairPasses = 0;
    while (!prepared.ok && gateRepairPasses < MAX_REPAIR_PASSES) {
      gateRepairPasses += 1;
      enter('repair', `Repairing the program (pass ${gateRepairPasses} of ${MAX_REPAIR_PASSES})…`);
      const errors = [
        ...(prepared.truncated ? ['The reply was cut off before the program ended.'] : []),
        ...describeViolations(prepared.gate),
      ];
      deps.sink({
        type: 'notice',
        kind: 'repair',
        message: `The program failed the safety gate; asking the model to fix ${errors.length} issue${errors.length === 1 ? '' : 's'}…`,
        at: nowSec(),
      });

      const repairFailure = drainCheck();
      if (repairFailure) return { ok: false, failure: repairFailure };
      const repaired = await spend({
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: wrapTopic(topic) },
          { role: 'assistant', content: rawOutput },
          { role: 'user', content: buildRepairPrompt(prepared.code, errors) },
        ],
        temperature: 0.2,
      });
      if (!repaired.ok) {
        return {
          ok: false,
          failure: { code: mapAiFailure(repaired.code), message: repaired.message },
        };
      }
      rawOutput = repaired.text;
      prepared = prepareProgram(repaired.text, {
        apiSurface: apiSurface().qualified,
        finishReason: repaired.finishReason ?? undefined,
      });
    }

    if (!prepared.ok) {
      return {
        ok: false,
        failure: {
          code: 'generation_unrepairable',
          message: `The AI produced code that could not be fixed after ${MAX_REPAIR_PASSES} repair passes. Try again, or rephrase the topic.`,
        },
      };
    }

    // ── helper: one repair round after an audit failure (build error or schema violation) ──
    // Budget permitting, one paid repair is worth the money: the error is specific and usually
    // a one-line fix. Beyond the gate-repair budget, fail honestly. On success the re-audit
    // outcome is handed back for the schema checks that follow.
    async function repairAfterAuditFailure(reason: {
      ok: false;
      message: string;
      timedOut: boolean;
    }): Promise<{ ok: false; failure: PipelineFailure } | { auditAfter: AuditSuccess }> {
      const spent = gateRepairPasses;
      if (spent >= MAX_REPAIR_PASSES) {
        return {
          ok: false as const,
          failure: {
            code: 'generation_unrepairable' as const,
            message: reason.message,
          },
        };
      }
      gateRepairPasses += 1;
      deps.sink({
        type: 'notice',
        kind: 'repair',
        message: reason.timedOut
          ? 'The model took too long to build; asking for a leaner version…'
          : 'The program failed to build; asking the model to fix it…',
        at: nowSec(),
      });
      const drainFail = drainCheck();
      if (drainFail) return { ok: false as const, failure: drainFail };
      const fixed = await spend({
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: wrapTopic(topic) },
          { role: 'assistant', content: rawOutput },
          { role: 'user', content: buildRepairPrompt(prepared.code, [reason.message]) },
        ],
        temperature: 0.2,
      });
      if (!fixed.ok) {
        return {
          ok: false as const,
          failure: { code: mapAiFailure(fixed.code), message: fixed.message },
        };
      }
      rawOutput = fixed.text;
      prepared = prepareProgram(fixed.text, {
        apiSurface: apiSurface().qualified,
        finishReason: fixed.finishReason ?? undefined,
      });
      if (!prepared.ok) {
        return {
          ok: false as const,
          failure: {
            code: 'generation_unrepairable' as const,
            message:
              describeViolations(prepared.gate)[0] ?? 'The repaired program failed the gate.',
          },
        };
      }
      const auditAfter = await auditModelAsync({
        code: prepared.instrumented,
        tier: deps.tier,
        seed: 0x5eed,
      });
      if (!auditAfter.ok) {
        return {
          ok: false as const,
          failure: { code: 'generation_unrepairable' as const, message: auditAfter.message },
        };
      }
      return { auditAfter };
    }

    // ── Stage 5: audit (the headless dry run) ────────────────────────────────
    // One call again: the model is built *and* measured, and the measurement is what the
    // twelve-dimension audit is made of. The sentence says both. The audit runs on a worker
    // thread so a `node:vm` build can never freeze the request loop while it runs.
    enter('build', 'Building the model and checking what it teaches…');
    const buildFailure = drainCheck();
    if (buildFailure) return { ok: false, failure: buildFailure };
    let audit = await auditModelAsync({
      code: prepared.instrumented,
      tier: deps.tier,
      seed: 0x5eed,
    });
    if (!audit.ok) {
      // The program passed the gate but died at build (or sweep-budget) time. One repair round is
      // worth the money: the error is specific and usually a one-line fix. Beyond that, fail honestly.
      const repairRound = await repairAfterAuditFailure(audit);
      if ('failure' in repairRound) return repairRound;
      audit = repairRound.auditAfter;
      // Fall through with the re-audited result; schema issues handled below.
    }

    // The manifest is validated exactly once at the boundary it crosses (`ModelManifest` is what
    // publish re-parses): an over-cap manifest used to ship as `ready` and then 400 on publish,
    // discarding the learner's share.
    let issues = audit.ok ? manifestIssues(audit.manifest) : [];
    if (issues.length > 0) {
      const repairRound = await repairAfterAuditFailure({
        ok: false,
        message: `The model broke the platform's manifest schema: ${issues[0]}`,
        timedOut: false,
      });
      if ('failure' in repairRound) return repairRound;
      audit = repairRound.auditAfter;
      issues = audit.ok ? manifestIssues(audit.manifest) : [];
      if (issues.length > 0) {
        return {
          ok: false,
          failure: {
            code: 'generation_unrepairable',
            message: `The AI's model still breaks the platform's manifest schema after a repair pass: ${issues[0]}`,
          },
        };
      }
    }

    if (audit.report.blocked) {
      return {
        ok: false,
        failure: {
          code: 'generation_rejected',
          message:
            'The generated model was empty or unusable, so it was refused rather than shown. Try again.',
        },
      };
    }

    // ── Stage 6: one refinement pass, accepted only if genuinely better ──────
    let finalAudit = audit;
    let refinementPasses = 0;
    const majorDeficiencies = audit.report.deficiencies.filter((d) => d.severity === 'major');
    if (audit.report.score < REFINEMENT_THRESHOLD && majorDeficiencies.length > 0) {
      refinementPasses = 1;
      enter('refine', 'Improving the model where it fell short…');
      deps.sink({
        type: 'notice',
        kind: 'refine',
        message: `The audit found ${majorDeficiencies.length} shortcomings; asking the model to fix them…`,
        at: nowSec(),
      });

      const refineFailure = drainCheck();
      if (refineFailure) return { ok: false, failure: refineFailure };
      const refined = await spend({
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: wrapTopic(topic) },
          { role: 'assistant', content: rawOutput },
          {
            role: 'user',
            content: buildRefinementPrompt(
              prepared.code,
              majorDeficiencies.map((d) => `${d.finding} → ${d.instruction}`),
            ),
          },
        ],
        temperature: 0.3,
      });
      if (refined.ok) {
        const reprepared = prepareProgram(refined.text, {
          apiSurface: apiSurface().qualified,
          finishReason: refined.finishReason ?? undefined,
        });
        if (reprepared.ok) {
          const reaudit = await auditModelAsync({
            code: reprepared.instrumented,
            tier: deps.tier,
            seed: 0x5eed,
          });
          const schemaIssues = reaudit.ok ? manifestIssues(reaudit.manifest) : ['schema invalid'];
          // "Genuinely better" per the shared contract (`audit.ts:104-108`): fewer errors AND
          // score not worse. Score alone let a refinement that added unbound parameters (score
          // 20, one new MAJOR deficiency each) replace a better-scored-but-more-honest model.
          if (
            reaudit.ok &&
            !reaudit.report.blocked &&
            schemaIssues.length === 0 &&
            isGenuinelyBetter(audit.report, reaudit.report)
          ) {
            prepared = reprepared;
            finalAudit = reaudit;
            rawOutput = refined.text;
          }
        }
      }
      // A failed refinement keeps the first model: the learner still gets something good.
    }

    // ── Stage 7: ready ───────────────────────────────────────────────────────
    enter('ready', 'Your 3D model is ready!');
    const bundle: ModelBundle = {
      manifest: finalAudit.manifest,
      code: prepared.code,
      // The instrumented twin: the audit above validated THIS string, so it is what must run in
      // the browser — shipping `code` instead meant no model that reached a learner ever had the
      // loop guard (the cheap layer of the sandbox's five never executed).
      runtime: prepared.instrumented,
      rawOutput,
      provenance: {
        topic,
        promptVersion: PROMPT_VERSION,
        // Every paid correction call — truncation re-ask, gate repairs, build repair — is real
        // money the learner waited for; reporting only the gate-repair loop under-counted the
        // spend (a 4-provider-call bundle carried repairPasses: 0).
        repairPasses: Math.max(0, providerCalls - 1) + refinementPasses,
        refinementPasses,
        durationMillis: Date.now() - started,
        // Extra observability fields: zod strips unknown keys on the wire (publish re-parses),
        // but measurement consumers reading the raw stream (the topic battery) see real spend.
        // The spread is deliberate: excess-property checks must not see through to the
        // manifest type — these keys exist at runtime and are dropped by zod, by design.
        ...({ providerCalls, usage: { ...providerUsage } } as Record<string, unknown>),
      },
    };

    return {
      ok: true,
      bundle,
      audit: {
        score: finalAudit.report.score,
        deficiencies: finalAudit.report.deficiencies.map((d) => `${d.finding} → ${d.instruction}`),
        // Structured binding data for measurement consumers (the topic battery's bindingCount):
        // the parameter ids the audit's parameterLeverage deficiencies accuse, by dimension and
        // subjectId. The prose above is for humans; equality against these ids is for machines —
        // substring matching over the prose once counted a `mass` parameter because "massive".
        unboundParameterIds: finalAudit.report.deficiencies
          .filter((d) => d.dimension === 'parameterLeverage' && d.subjectId !== undefined)
          .map((d) => d.subjectId as string),
      },
    };
  } catch (error) {
    // Every exception becomes an audit outcome the route can send as a terminal event — a guest
    // loop-budget overrun or an unexpected fault never escapes the pipeline again.
    if (error instanceof PipelineDeadlineElapsedError)
      return { ok: false, failure: deadlineFailure() };
    return { ok: false, failure: classifyEscape(error) };
  } finally {
    stopHeartbeats();
  }
}

/** The audit outcome's success shape — what `repairAfterAuditFailure` hands back when it fixed things. */
type AuditSuccess = { ok: true; report: AuditReport; manifest: ManifestShape };

/**
 * The refinement contract's full acceptance rule (`packages/contracts/src/audit.ts:104-108`):
 * "the revision is accepted only if it is *genuinely better* (fewer errors, score not worse)".
 * Score alone accepted second attempts that had scored higher by ADDING deficiencies.
 */
export function isGenuinelyBetter(original: AuditReport, revision: AuditReport): boolean {
  if (revision.deficiencies.length >= original.deficiencies.length) return false;
  return revision.score >= original.score;
}

/** Map an escaping exception to its honest terminal code — the pipeline itself still returns. */
function classifyEscape(error: unknown): PipelineFailure {
  const asError =
    error && typeof error === 'object' ? (error as { name?: string; message?: string }) : null;
  const name = asError?.name ?? '';
  const message = asError?.message ?? String(error);
  const budget =
    name === 'GuestBudgetError' ||
    name === 'GuestTimeoutError' ||
    /exceeded .* loop iterations|took too long|compute budget/i.test(message);
  if (budget) {
    return {
      code: 'generation_unrepairable',
      message: `${message.slice(0, 400)}`,
    };
  }
  return {
    code: 'internal',
    message:
      'Something went wrong while building your model. Try again; the request id below helps us trace it.',
  };
} // DEBUG-PROBE-REMOVE

/** Map the AI client's local failure vocabulary onto the wire's error codes. */
function mapAiFailure(code: string): PipelineFailure['code'] {
  switch (code) {
    case 'quota':
      return 'upstream_quota';
    case 'refused':
      return 'upstream_refused';
    case 'truncated':
      return 'upstream_truncated';
    case 'malformed':
      return 'upstream_failed';
    case 'cancelled':
      return 'cancelled';
    case 'draining':
      return 'draining';
    // `auth` surfaces with its actionable message ("Check AI_API_KEY") as an upstream failure:
    // retrying or cascading a credential problem only spends more of the wrong credentials.
    case 'auth':
      return 'upstream_failed';
    default:
      return 'upstream_failed';
  }
}
