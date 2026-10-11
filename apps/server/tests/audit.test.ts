/**
 * Audit honesty tests: the sweep must prove *causal* linkage, not write presence.
 *
 * `00-GOAL.md:210`: "a control that changes nothing is rejected, not shipped." The sweep used to
 * run `onFrame` inside every sweep point and credit any write to the parameter being swept — and
 * because a frame callback writes every frame regardless of parameter values, **every model with an
 * `onFrame` passed every parameter**. The reference turbofan shipped a dead `cutaway` control
 * through exactly that hole.
 *
 * These tests pin the three properties the honest sweep must hold:
 *
 *   1. a parameter whose value never changes any observable state is deficient (the false-negative
 *      killer — this exact model false-passed before the fix);
 *   2. a parameter *read inside* `onFrame` (value-driven writes) is credited — the pattern
 *      `00:206` endorses, and the reason the fix may not simply drop `onFrame` from the sweep;
 *   3. a parameter bound to a declared motion's rate/amplitude is credited by declaration — the
 *      Phase 1a applicator executes that binding every frame, so the audit need not re-run it.
 *
 * Plus the regression guard that rules them all: the reference turbofan audits clean — a stricter
 * audit that rejects the flagship is wrong, not the model.
 */
import { describe, expect, it } from 'vitest';
import { prepareProgram } from '@edu3d/sandbox';
import { REFERENCE_MODEL_SOURCE, apiSurfaceSet } from '@edu3d/engine';
import { auditModel } from '../src/services/audit.ts';

/** Audit a raw source the way the pipeline does: gate + instrument, then run the audit. */
const audit = (source: string) => {
  const prepared = prepareProgram(source, { apiSurface: apiSurfaceSet() });
  expect(prepared.ok, 'test model must pass the gate').toBe(true);
  return auditModel({ code: prepared.instrumented, tier: 'mid', seed: 7 });
};

const deficienciesFor = (result: ReturnType<typeof auditModel>, dimension: string) =>
  result.ok ? result.report.deficiencies.filter((d) => d.dimension === dimension) : null;

describe('parameter leverage — the differential sweep', () => {
  it('reports a parameter deficient when its value changes nothing, even though onFrame writes every frame', () => {
    // The false-negative killer. The frame callback writes the part's rotation every frame —
    // writes that happen regardless of 'dead' — so the old write-presence accounting credited
    // 'dead' and the model shipped a control that changes nothing.
    const result = audit(`
      scene.describe({ name: 'Dead control', description: 'A model whose control does nothing.',
        concept: 'a control must change something', objectives: ['notice the dead control'] });
      scene.param({ id: 'dead', kind: 'number', label: 'Dead', min: 0, max: 10, default: 5,
        affects: [{ channel: 'transform' }] });
      var m = mat.metal({});
      scene.mesh({ id: 'spinner', name: 'Spinner',
        geometry: geom.cylinder({ radius: 0.2, height: 0.1, segments: 12 }), material: m });
      scene.onFrame(function (ctx) {
        ctx.part('spinner').setRotation(0, ctx.time, 0);
      });
    `);
    expect(result.ok, result.ok ? '' : result.message).toBe(true);
    if (!result.ok) return;

    const dead = deficienciesFor(result, 'parameterLeverage')?.find((d) => d.subjectId === 'dead');
    expect(dead, "parameter 'dead' must be reported as changing nothing visible").toBeDefined();
    expect(dead?.severity).toBe('major');
  });

  it('credits a parameter read inside onFrame — value-driven writes are real causality', () => {
    // The false-positive guard, and the pin that the fix did NOT take the naive path of removing
    // the frame dispatch from the sweep: 'x' drives position through ctx.params, exactly the
    // pattern `00:206` endorses ("the motion and physics follow the parameter").
    const result = audit(`
      scene.describe({ name: 'Live control', description: 'A model whose control works.',
        concept: 'a control that works', objectives: ['see the control work'] });
      scene.param({ id: 'x', kind: 'number', label: 'X', min: -1, max: 1, default: 0,
        affects: [{ channel: 'transform' }] });
      var m = mat.metal({});
      scene.mesh({ id: 'p', name: 'P', geometry: geom.box({ size: [0.2, 0.2, 0.2] }), material: m });
      scene.onFrame(function (ctx) {
        ctx.part('p').setPosition(ctx.params.x, 0, 0);
      });
    `);
    expect(result.ok, result.ok ? '' : result.message).toBe(true);
    if (!result.ok) return;

    expect(deficienciesFor(result, 'parameterLeverage')?.some((d) => d.subjectId === 'x')).toBe(
      false,
    );
  });

  it('credits a parameter that only drives a declared motion rate — declarative causality', () => {
    // No frame writes at all: the binding lives in the declaration (`rate: { param: 'rpm' }`),
    // which the Phase 1a applicator executes every frame. The audit does not need to re-run the
    // binding to know it is causal — a spin whose rate is the parameter *is* the parameter made
    // visible.
    const result = audit(`
      scene.describe({ name: 'Declared motion', description: 'Rate from a parameter.',
        concept: 'declared motion is auditable', objectives: ['see the spin follow the slider'] });
      scene.param({ id: 'rpm', kind: 'number', label: 'Speed', min: 0, max: 10, default: 5,
        affects: [{ channel: 'motionRate' }] });
      var m = mat.metal({});
      scene.mesh({ id: 'wheel', name: 'Wheel',
        geometry: geom.cylinder({ radius: 0.3, height: 0.06, segments: 24 }), material: m });
      scene.motion({ id: 'spin', partId: 'wheel', kind: 'spin', axis: [0, 0, 1],
        rate: { param: 'rpm' }, reason: 'The learner sets the turning speed.' });
    `);
    expect(result.ok, result.ok ? '' : result.message).toBe(true);
    if (!result.ok) return;

    expect(deficienciesFor(result, 'parameterLeverage')?.some((d) => d.subjectId === 'rpm')).toBe(
      false,
    );
  });
});

describe('the reference turbofan — the regression guard', () => {
  it('audits clean on parameter leverage: every control, including cutaway, provably drives something', () => {
    // The flagship must survive the stricter audit. Before the cutaway toggle was implemented
    // this failed with 'cutaway' deficient — which was correct: the control was dead, and the
    // audit had finally noticed.
    const result = audit(REFERENCE_MODEL_SOURCE);
    expect(result.ok, result.ok ? '' : result.message).toBe(true);
    if (!result.ok) return;

    expect(deficienciesFor(result, 'parameterLeverage')).toEqual([]);
  });
});
