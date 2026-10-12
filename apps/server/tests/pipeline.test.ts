/**
 * Generation-pipeline bundle tests.
 *
 * The pipeline's five-layer sandbox story has a hole that only an end-to-end assertion can keep
 * closed: it *validated* the instrumented program (loop guard spliced in) but *shipped* the clean
 * one, so no model that reached a browser ever ran the guard — the cheap layer of the five never
 * executed, and a runaway loop in the wild was bounded only by the 25 s build grace and
 * `worker.terminate()`. The bundle must now carry both strings: `code` stays clean for the
 * diagnostics panel, `runtime` is what actually executes.
 *
 * The fake AI returns the hand-authored reference turbofan — a real, gate-passing,
 * audit-passing program — so this exercises the same extract → gate → instrument → audit path
 * production takes, with the only substitution being the provider.
 */
import { describe, expect, it } from 'vitest';
import { REFERENCE_MODEL_SOURCE } from '@edu3d/engine';
import type { AiClient } from '../src/services/ai-client.ts';
import { runPipeline } from '../src/services/pipeline.ts';

/**
 * An AI that always answers with the reference model.
 *
 * Cast rather than subclassed: `AiClient` is a concrete class whose constructor wants a config and
 * whose only pipeline-relevant member is `complete`; constructing a real one would drag in fetch
 * and timeouts this test has no use for.
 */
const referenceAi = {
  complete: async () => ({
    ok: true as const,
    text: REFERENCE_MODEL_SOURCE,
    finishReason: 'stop',
    usage: { promptTokens: 1, completionTokens: 1 },
  }),
} as unknown as AiClient;

describe('the generated bundle', () => {
  it('ships the instrumented program as runtime while code stays clean for the diagnostics panel', async () => {
    const result = await runPipeline('a turbofan engine', 'balanced', {
      ai: referenceAi,
      sink: () => {},
      tier: 'mid',
      maxOutputTokens: 8192,
    });
    // The reference model passes the gate and the audit, so the pipeline reaches Stage 7.
    expect(result.ok, result.ok ? '' : result.failure.message).toBe(true);
    if (!result.ok) return;

    expect(result.bundle.runtime).toContain('__edu3d_tick');
    expect(result.bundle.code).not.toContain('__edu3d_tick');
    // The two strings are the same program before instrumentation, so the shipped pair must differ.
    expect(result.bundle.runtime).not.toBe(result.bundle.code);
  });

  it('reports unbound parameters structurally, so metrics never grep prose', async () => {
    // bindingCount in the topic battery is subjectId equality against this array. Prose matching
    // here would reintroduce the "massive".includes("mass") false positive on the measurement
    // path, so the pipeline must publish the audit's parameterLeverage subject ids verbatim.
    const result = await runPipeline('a turbofan engine', 'balanced', {
      ai: referenceAi,
      sink: () => {},
      tier: 'mid',
      maxOutputTokens: 8192,
    });
    expect(result.ok, result.ok ? '' : result.failure.message).toBe(true);
    if (!result.ok) return;

    const unbound = result.audit.unboundParameterIds;
    expect(Array.isArray(unbound)).toBe(true);
    // The reference model binds every parameter through motion declarations or frame writes, so
    // the structured list must be empty — and an entry here must name a real parameter id.
    const parameterIds = result.bundle.manifest.parameters.map((parameter) => parameter.id);
    for (const id of unbound ?? []) expect(parameterIds).toContain(id);
  });

  it('keeps validating the instrumented source — a program with a runaway loop is still refused, never shipped', { timeout: 60000 },
  async () => {
    // The gate admits the loop; only the guard inside the instrumented source stops it at audit
    // time. If the pipeline ever validated the clean string instead, this program would hang the
    // audit rather than fail it — the exact regression this pins.
    const runaway = `${REFERENCE_MODEL_SOURCE}\nwhile (true) { }\n`;
    const result = await runPipeline('a turbofan engine', 'balanced', {
      ai: {
        complete: async () => ({
          ok: true as const,
          text: runaway,
          finishReason: 'stop',
          usage: { promptTokens: 1, completionTokens: 1 },
        }),
      } as unknown as AiClient,
      sink: () => {},
      tier: 'mid',
      maxOutputTokens: 8192,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe('generation_unrepairable');
  });
});
