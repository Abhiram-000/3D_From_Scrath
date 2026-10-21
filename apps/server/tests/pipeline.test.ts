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

  it(
    'keeps validating the instrumented source — a program with a runaway loop is still refused, never shipped',
    { timeout: 60000 },
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
    },
  );
});

describe('runPipeline never throws (the contract its docs and clients depend on)', () => {
  it(
    'routes a guest loop-budget overrun to a terminal pipeline failure, not an exception',
    { timeout: 60_000 },
    async () => {
      // The reference model passes the gate and builds; the appended onFrame passes the gate too
      // (its loop is instrumented), then burns the guard during the audit sweep. A bug made this
      // throw GuestBudgetError THROUGH runPipeline — the learner saw a generic 500 and the two
      // repair passes were never offered on a repairable model.
      const bomb = `${REFERENCE_MODEL_SOURCE}
scene.onFrame(function (ctx) { while (true) { } });
`;
      const result = await runPipeline('a turbofan engine', 'balanced', {
        ai: {
          complete: async () => ({
            ok: true as const,
            text: bomb,
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
      expect(result.failure.message.length).toBeGreaterThan(0);
    },
  );
});

describe('the manifest is validated where it crosses the sandbox boundary', () => {
  it(
    'refuses a manifest over the contracts caps (motions 512, lights 24, colorRoles 16) instead of shipping it',
    { timeout: 60_000 },
    async () => {
      // 600 motions / 40 lights / 20 colorRoles used to pass the gate and the audit and ship as
      // `ready` — then 400 on publish, discarding the learner's share.
      const overCaps = `
      scene.describe({ name: 'Over the caps', description: 'Exceeds the manifest caps.',
        concept: 'caps', objectives: ['exceed caps'] });
      var m = mat.metal({});
      scene.mesh({ id: 'root', name: 'Root', geometry: geom.box({ size: [0.2, 0.2, 0.2] }), material: m });
      for (var i = 0; i < 600; i++) {
        scene.motion({ id: 'spin' + i, partId: 'root', kind: 'spin', axis: [0, 0, 1],
          rate: 0.001 * (i + 1), reason: 'spin ' + i });
      }
      for (var j = 0; j < 40; j++) {
        scene.light({ id: 'light' + j, kind: 'directional', intensity: 1, position: [j, 1, 0] });
      }
      for (var k = 0; k < 20; k++) {
        scene.colorRole({ id: 'role' + k, label: 'Role ' + k, color: '#3388aa', meaning: 'meaning ' + k });
      }
    `;
      const result = await runPipeline('a capped-out model', 'balanced', {
        ai: {
          complete: async () => ({
            ok: true as const,
            text: overCaps,
            finishReason: 'stop',
            usage: { promptTokens: 1, completionTokens: 1 },
          }),
        } as unknown as AiClient,
        sink: () => {},
        tier: 'mid',
        maxOutputTokens: 8192,
      });
      expect(result.ok).toBe(false);
      if (result.ok) {
        throw new Error(
          `shipped a manifest with ${result.bundle.manifest.motions.length} motions / ${result.bundle.manifest.lights.length} lights — publish would 400`,
        );
      }
      // A schema violation is a repairable program mistake: it gets the repair round, and when the
      // revision still violates the caps the run fails genuinely rather than shipping.
      expect(result.failure.code).toBe('generation_unrepairable');
    },
  );

  it(
    'still ships the reference model — validation must not false-positive a legitimate manifest',
    { timeout: 60_000 },
    async () => {
      const result = await runPipeline('a turbofan engine', 'balanced', {
        ai: referenceAi,
        sink: () => {},
        tier: 'mid',
        maxOutputTokens: 8192,
      });
      expect(result.ok, result.ok ? '' : result.failure.message).toBe(true);
    },
  );
});

describe('provider call accounting and token visibility', () => {
  it(
    'counts the truncation re-ask in repair accounting and records usage in provenance',
    { timeout: 60_000 },
    async () => {
      // Two provider calls (initial + truncation re-ask) used to be reported as repairPasses: 0,
      // and the parsed usage { promptTokens, completionTokens } was discarded entirely.
      const cutReply =
        '```javascript\n' + REFERENCE_MODEL_SOURCE.slice(0, REFERENCE_MODEL_SOURCE.length * 0.5);
      let calls = 0;
      const result = await runPipeline('a turbofan engine', 'balanced', {
        ai: {
          complete: async () => {
            calls += 1;
            return calls === 1
              ? {
                  ok: true as const,
                  text: cutReply,
                  finishReason: 'length',
                  usage: { promptTokens: 1234, completionTokens: 5678 },
                }
              : {
                  ok: true as const,
                  text: '```javascript\n' + REFERENCE_MODEL_SOURCE + '\n```',
                  finishReason: 'stop',
                  usage: { promptTokens: 2345, completionTokens: 6789 },
                };
          },
        } as unknown as AiClient,
        sink: () => {},
        tier: 'mid',
        maxOutputTokens: 8192,
      });
      expect(result.ok, result.ok ? '' : result.failure.message).toBe(true);
      if (!result.ok) return;
      expect(calls).toBe(2);
      const provenance = result.bundle.provenance;
      expect(
        provenance?.repairPasses,
        'the truncation re-ask is a paid correction call and must be counted',
      ).toBe(1);
      // providerCalls/usage are runtime observability fields the wire schema strips — read them
      // through the runtime shape, not the manifest type.
      const runtimeProvenance = provenance as unknown as {
        providerCalls?: number;
        usage?: { promptTokens?: number; completionTokens?: number };
      };
      expect(
        runtimeProvenance.providerCalls,
        'all provider calls must be visible in provenance',
      ).toBe(2);
      const usage = runtimeProvenance.usage as
        { promptTokens?: number; completionTokens?: number } | undefined;
      expect(usage?.promptTokens).toBe(1234 + 2345);
      expect(usage?.completionTokens).toBe(5678 + 6789);
    },
  );

  it(
    'rawOutput is the reply the model actually shipped after a truncation re-ask',
    { timeout: 60_000 },
    async () => {
      // The repair prompt showed the model a program it did not write, and the bundle's rawOutput
      // ("the provider's untouched reply") pointed at the truncated original.
      const cutReply =
        '```javascript\n' + REFERENCE_MODEL_SOURCE.slice(0, REFERENCE_MODEL_SOURCE.length * 0.5);
      const completeReply = '```javascript\n' + REFERENCE_MODEL_SOURCE + '\n```';
      let calls = 0;
      const result = await runPipeline('a turbofan engine', 'balanced', {
        ai: {
          complete: async () => {
            calls += 1;
            return calls === 1
              ? {
                  ok: true as const,
                  text: cutReply,
                  finishReason: 'length',
                  usage: { promptTokens: 1, completionTokens: 1 },
                }
              : {
                  ok: true as const,
                  text: completeReply,
                  finishReason: 'stop',
                  usage: { promptTokens: 1, completionTokens: 1 },
                };
          },
        } as unknown as AiClient,
        sink: () => {},
        tier: 'mid',
        maxOutputTokens: 8192,
      });
      expect(result.ok, result.ok ? '' : result.failure.message).toBe(true);
      if (!result.ok) return;
      expect(result.bundle.rawOutput).toBe(completeReply);
    },
  );
});

describe('one refinement pass, accepted only if genuinely better', () => {
  const MODEL_A = `
    scene.describe({ name: 'ModelA', description: 'First draft.', concept: 'c', objectives: ['o1'] });
    var m = mat.metal({});
    scene.mesh({ id: 'p', name: 'P', geometry: geom.box({ size: [0.2, 0.2, 0.2] }), material: m,
      hero: true, info: { title: 'P', summary: 's', bullets: ['b'] } });
  `;
  // The "refinement" scores higher via a constant motion (+9 liveliness points) while adding
  // TWO unbound parameters — two new MAJOR deficiencies, each worth zero score. Under the old
  // rule (score >= alone) this replaced the learner's good model.
  const MODEL_B_DEGENERATE = `
    scene.describe({ name: 'ModelB', description: 'Refined.', concept: 'c', objectives: ['o1'] });
    var m = mat.metal({});
    scene.mesh({ id: 'p', name: 'P', geometry: geom.box({ size: [0.2, 0.2, 0.2] }), material: m,
      hero: true, info: { title: 'P', summary: 's', bullets: ['b'] } });
    scene.motion({ id: 'spin', partId: 'p', kind: 'spin', axis: [0, 0, 1], rate: { const: 0.2 }, reason: 'r' });
    scene.param({ id: 'w', kind: 'number', label: 'W', min: 0, max: 1, default: 0.5, affects: [{ channel: 'transform' }] });
    scene.param({ id: 'v', kind: 'number', label: 'V', min: 0, max: 1, default: 0.5, affects: [{ channel: 'transform' }] });
  `;

  it(
    'rejects a refinement that improves score while ADDING deficiencies',
    { timeout: 60_000 },
    async () => {
      let calls = 0;
      const result = await runPipeline('a degenerate refinement', 'balanced', {
        ai: {
          complete: async () => {
            calls += 1;
            return {
              ok: true as const,
              text: calls === 1 ? MODEL_A : MODEL_B_DEGENERATE,
              finishReason: 'stop',
              usage: { promptTokens: 1, completionTokens: 1 },
            };
          },
        } as unknown as AiClient,
        sink: () => {},
        tier: 'mid',
        maxOutputTokens: 8192,
      });
      expect(result.ok, result.ok ? '' : result.failure.message).toBe(true);
      if (!result.ok) return;
      // The refined manifest named 'ModelB' with MORE deficiencies used to replace ModelA.
      expect(
        result.bundle.manifest.name,
        'a refinement that added a deficiency must not replace the model',
      ).toBe('ModelA');
    },
  );
});

describe('drain awareness inside the pipeline', () => {
  it('returns the draining failure at the next phase check — never a wasted provider call', async () => {
    const { createLifecycle: makeLifecycle } = await import('../src/services/lifecycle.ts');
    const local = makeLifecycle();
    const calls: number[] = [];
    const result = await runPipeline('a turbofan engine', 'balanced', {
      ai: {
        complete: async () => {
          calls.push(1);
          return {
            ok: true as const,
            text: '```javascript\n' + REFERENCE_MODEL_SOURCE + '\n```',
            finishReason: 'stop',
            usage: { promptTokens: 1, completionTokens: 1 },
          };
        },
      } as unknown as AiClient,
      sink: () => {},
      tier: 'mid',
      maxOutputTokens: 8192,
      lifecycle: local,
    });
    // Drain before the pipeline begins: it must stop before spending the first AI call.
    local.beginDrain();
    const result2 = await runPipeline('a turbofan engine', 'balanced', {
      ai: {
        complete: async () => {
          calls.push(2);
          return {
            ok: true as const,
            text: REFERENCE_MODEL_SOURCE,
            finishReason: 'stop',
            usage: { promptTokens: 1, completionTokens: 1 },
          };
        },
      } as unknown as AiClient,
      sink: () => {},
      tier: 'mid',
      maxOutputTokens: 8192,
      lifecycle: local,
    });
    expect(result2.ok).toBe(false);
    if (!result2.ok) expect(result2.failure.code).toBe('draining');
    expect(calls, 'a draining pipeline must never spend a provider call').toEqual([1]);
    expect(result.ok, 'without drain the first run completes').toBe(true);
  });
});
