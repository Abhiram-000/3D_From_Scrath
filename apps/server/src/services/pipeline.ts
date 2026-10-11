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
  type GenerationEvent,
  type GenerationPhase,
  type ModelBundle,
} from '@edu3d/contracts';
import { prepareProgram, describeViolations } from '@edu3d/sandbox';
import { apiSurface } from '@edu3d/engine';
import { auditModel } from './audit.ts';
import type { AiClient } from './ai-client.ts';
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
}

/** Terminal failures, mapped to the wire's error codes by the route. */
export interface PipelineFailure {
  code:
    | 'upstream_failed'
    | 'upstream_truncated'
    | 'upstream_refused'
    | 'upstream_quota'
    | 'generation_unrepairable'
    | 'generation_rejected';
  message: string;
  retryAfterSeconds?: number;
}

const nowSec = () => Date.now();

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
  | { ok: true; bundle: ModelBundle; audit: { score: number; deficiencies: string[] } }
  | { ok: false; failure: PipelineFailure }
> {
  const started = Date.now();

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
  };

  try {
    // ── Stage 1: prompt assembly ─────────────────────────────────────────────
    enter('prompt', 'Loading the generation contract…');
    const systemPrompt = buildGenerationPrompt({ complexity, tier: deps.tier });

    // ── Stage 2: the AI call ─────────────────────────────────────────────────
    enter('model', 'The model is designing your 3D scene…');
    charsWritten = 0;
    const first = await deps.ai.complete({
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: wrapTopic(topic) },
      ],
      maxOutputTokens: deps.maxOutputTokens,
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
    enter('extract', 'Reading the program the model wrote…');
    let prepared = prepareProgram(first.text, {
      apiSurface: apiSurface().qualified,
      finishReason: first.finishReason ?? undefined,
    });

    // Truncation is a named failure and never shipped. One re-ask is allowed: the program may be
    // complete on a second sample without the full prompt being re-sent (`04`).
    if (prepared.truncated) {
      deps.sink({
        type: 'notice',
        kind: 'warning',
        message: 'The reply was cut off; asking the model to finish it…',
        at: nowSec(),
      });
      const retry = await deps.ai.complete({
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
        maxOutputTokens: deps.maxOutputTokens,
        temperature: 0.3,
      });
      if (!retry.ok) {
        return { ok: false, failure: { code: mapAiFailure(retry.code), message: retry.message } };
      }
      prepared = prepareProgram(retry.text, {
        apiSurface: apiSurface().qualified,
        finishReason: retry.finishReason ?? undefined,
      });
      if (prepared.truncated) {
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
    let repairPasses = 0;
    let rawOutput = first.text;
    while (!prepared.ok && repairPasses < MAX_REPAIR_PASSES) {
      repairPasses += 1;
      enter('repair', `Repairing the program (pass ${repairPasses} of ${MAX_REPAIR_PASSES})…`);
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

      const repaired = await deps.ai.complete({
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: wrapTopic(topic) },
          { role: 'assistant', content: rawOutput },
          { role: 'user', content: buildRepairPrompt(prepared.code, errors) },
        ],
        maxOutputTokens: deps.maxOutputTokens,
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

    // ── Stage 5: audit (the headless dry run) ────────────────────────────────
    enter('build', 'Building the model to measure it…');
    let audit = auditModel({ code: prepared.instrumented, tier: deps.tier, seed: 0x5eed });
    if (!audit.ok) {
      // The program passed the gate but died at build time. One repair round is worth the money: the
      // error is specific and usually a one-line fix. Beyond that, fail honestly.
      if (repairPasses >= MAX_REPAIR_PASSES) {
        return { ok: false, failure: { code: 'generation_unrepairable', message: audit.message } };
      }
      deps.sink({
        type: 'notice',
        kind: 'repair',
        message: 'The program failed to build; asking the model to fix it…',
        at: nowSec(),
      });
      const fixed = await deps.ai.complete({
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: wrapTopic(topic) },
          { role: 'assistant', content: rawOutput },
          { role: 'user', content: buildRepairPrompt(prepared.code, [audit.message]) },
        ],
        maxOutputTokens: deps.maxOutputTokens,
        temperature: 0.2,
      });
      if (!fixed.ok) {
        return { ok: false, failure: { code: mapAiFailure(fixed.code), message: fixed.message } };
      }
      rawOutput = fixed.text;
      prepared = prepareProgram(fixed.text, {
        apiSurface: apiSurface().qualified,
        finishReason: fixed.finishReason ?? undefined,
      });
      if (!prepared.ok) {
        return {
          ok: false,
          failure: {
            code: 'generation_unrepairable',
            message:
              describeViolations(prepared.gate)[0] ?? 'The repaired program failed the gate.',
          },
        };
      }
      audit = auditModel({ code: prepared.instrumented, tier: deps.tier, seed: 0x5eed });
      if (!audit.ok) {
        return { ok: false, failure: { code: 'generation_unrepairable', message: audit.message } };
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
    if (audit.report.score < 72 && majorDeficiencies.length > 0) {
      refinementPasses = 1;
      enter('refine', 'Improving the model where it fell short…');
      deps.sink({
        type: 'notice',
        kind: 'refine',
        message: `The audit found ${majorDeficiencies.length} shortcomings; asking the model to fix them…`,
        at: nowSec(),
      });

      const refined = await deps.ai.complete({
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
        maxOutputTokens: deps.maxOutputTokens,
        temperature: 0.3,
      });
      if (refined.ok) {
        const reprepared = prepareProgram(refined.text, {
          apiSurface: apiSurface().qualified,
          finishReason: refined.finishReason ?? undefined,
        });
        if (reprepared.ok) {
          const reaudit = auditModel({
            code: reprepared.instrumented,
            tier: deps.tier,
            seed: 0x5eed,
          });
          // "Genuinely better" is score not worse AND fewer blockers — a degenerate second attempt
          // must never replace a decent first one (`04`).
          if (reaudit.ok && !reaudit.report.blocked && reaudit.report.score >= audit.report.score) {
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
        repairPasses,
        refinementPasses,
        durationMillis: Date.now() - started,
      },
    };

    return {
      ok: true,
      bundle,
      audit: {
        score: finalAudit.report.score,
        deficiencies: finalAudit.report.deficiencies.map((d) => `${d.finding} → ${d.instruction}`),
      },
    };
  } finally {
    stopHeartbeats();
  }
}

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
    default:
      return 'upstream_failed';
  }
}
