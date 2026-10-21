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
 * outright: it routes the run into the one-bounded continuation re-ask, so even a border case
 * costs one call, not a refusal.
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
 * the model and must not fail a legitimate run: the engine's geometry dedup key (`cacheKey`,
 * JSON-serialized builder spec) can exceed the contract's 512-char cap on composite geometry
 * (measured 3,114 chars on the reference turbofan's swept bypass ribbon) with NOTHING about the
 * model's plan being wrong. Exclude them so the manifest gate judges only the model's own
 * choices (counts, lengths of authored strings, numeric ranges).
 *
 * NOTE for the cross-lane follow-up: publish re-parses the same schema, so an over-cap
 * `cacheKey` still 400s a valid model there — the engine (or the contract) has to fix the
 * serialization itself; this gate refuses to spend a repair pass on a one-line prompt error.
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
    signal?: AbortSignal;
    onProgress?: (chars: number) => void;
  }): Promise<CompletionResult> => {
    providerCalls += 1;
    const result = await deps.ai.complete({
      messages: request.messages,
      maxOutputTokens: deps.maxOutputTokens,
      temperature: request.temperature,
      signal: request.signal,
      onProgress: request.onProgress,
    });
    if (result.ok) {
      providerUsage.promptTokens += result.usage.promptTokens;
      providerUsage.completionTokens += result.usage.completionTokens;
    }
    return result;
  };

  /** The drain checks the shutdown contract promised (`06`): before each paid call and phase. */
  const drainCheck = (): PipelineFailure | null => {
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
      signal: deps.signal,
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
    if (!first.ok) {
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
    let prepared = prepareProgram(first.text, {
      apiSurface: apiSurface().qualified,
      finishReason: first.finishReason ?? undefined,
    });
    // The provider's untouched reply, exactly as received — the repair prompt's assistant turn
    // and the bundle diagnostics must both point at the program the provider actually wrote.
    let rawOutput = first.text;

    // Truncation is a named failure and never shipped. One re-ask is allowed: the program may be
    // complete on a second sample without the full prompt being re-sent (`04`).
    if (
      replyLooksCut(first.text, prepared, deps.maxOutputTokens, first.ok ? first.usage : undefined)
    ) {
      deps.sink({
        type: 'notice',
        kind: 'warning',
        message: 'The reply was cut off; asking the model to finish it…',
        at: nowSec(),
      });
      const cutFailure = drainCheck();
      if (cutFailure) return { ok: false, failure: cutFailure };
      const retry = await spend({
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: wrapTopic(topic) },
          { role: 'assistant', content: first.text },
          {
            role: 'user',
            content:
              'Your reply was cut off before the program was complete. Return the COMPLETE program in one fenced block.',
          },
        ],
        temperature: 0.3,
        signal: deps.signal,
      });
      if (!retry.ok) {
        return { ok: false, failure: { code: mapAiFailure(retry.code), message: retry.message } };
      }
      // The correction call is real money: count it in the bundle's repair accounting.
      rawOutput = retry.text;
      prepared = prepareProgram(retry.text, {
        apiSurface: apiSurface().qualified,
        finishReason: retry.finishReason ?? undefined,
      });
      if (
        replyLooksCut(
          retry.text,
          prepared,
          deps.maxOutputTokens,
          retry.ok ? retry.usage : undefined,
        )
      ) {
        return {
          ok: false,
          failure: {
            code: 'upstream_truncated',
            message: 'The response was cut off before the model was complete. Try again.',
          },
        };
      }
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
        signal: deps.signal,
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
        signal: deps.signal,
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
        signal: deps.signal,
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
