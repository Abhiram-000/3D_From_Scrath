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

describe('representation fidelity — moving parts that are static-shape lookalikes', () => {
  it('flags a spinning part with gear vocabulary built from a raw primitive', () => {
    // `01:45-50`: "a gear must be an involute profile, not trapezoid teeth… Enforce it in your
    // audit." The name claims the mechanism, the spin motion proves the part performs it, and the
    // builder recorded in the manifest says the geometry cannot deliver it.
    const result = audit(`
      scene.describe({ name: 'Gear train', description: 'A lookalike gear.',
        concept: 'gears mesh', objectives: ['see gears mesh'] });
      scene.param({ id: 'speed', kind: 'number', label: 'Speed', min: 0, max: 10, default: 5,
        affects: [{ channel: 'motionRate' }] });
      var m = mat.metal({});
      scene.mesh({ id: 'driveGear', name: 'Drive gear',
        geometry: geom.cylinder({ radius: 0.3, height: 0.06, segments: 16 }), material: m });
      scene.motion({ id: 'spin', partId: 'driveGear', kind: 'spin', axis: [0, 0, 1],
        rate: { param: 'speed' }, reason: 'The train turns at the speed the learner sets.' });
    `);
    expect(result.ok, result.ok ? '' : result.message).toBe(true);
    if (!result.ok) return;

    const flagged = deficienciesFor(result, 'representationFidelity')?.find(
      (d) => d.subjectId === 'driveGear',
    );
    expect(flagged, 'the lookalike gear must be flagged for refinement').toBeDefined();
    expect(flagged?.severity).toBe('major');
    expect(flagged?.instruction).toMatch(/gear/i);
  });

  it('flags a compressing part with spring vocabulary built from a raw primitive', () => {
    const result = audit(`
      scene.describe({ name: 'Spring', description: 'A lookalike spring.',
        concept: 'springs compress', objectives: ['see the spring compress'] });
      var m = mat.metal({});
      scene.mesh({ id: 'suspensionSpring', name: 'Coil spring',
        geometry: geom.cylinder({ radius: 0.1, height: 0.5, segments: 12 }), material: m });
      scene.motion({ id: 'compress', partId: 'suspensionSpring', kind: 'oscillate', axis: [0, 1, 0],
        rate: { const: 0.5 }, amplitude: { const: 0.1 }, reason: 'Compresses under load.' });
    `);
    expect(result.ok, result.ok ? '' : result.message).toBe(true);
    if (!result.ok) return;

    const flagged = deficienciesFor(result, 'representationFidelity')?.find(
      (d) => d.subjectId === 'suspensionSpring',
    );
    expect(flagged, 'the stacked-cylinder spring must be flagged for refinement').toBeDefined();
    expect(flagged?.severity).toBe('major');
    expect(flagged?.instruction).toMatch(/helix/i);
  });

  it('does not flag an honest wheel — a wheel is a cylinder, and 01 says nothing about wheels', () => {
    // The controller's ruling on the fix round: `01:45-50` names gears specifically ("trapezoid
    // teeth… visibly slip and jerk the moment the gear train turns"); wheel/pulley/cam was the
    // brief's extension beyond the spec, not the spec's demand. A raw cylinder named wheel with a
    // spin motion is honest geometry — flagging it sent a gear-specific instruction at major
    // severity down the paid refinement path, a false instruction on an honest model.
    const result = audit(`
      scene.describe({ name: 'Pulley rig', description: 'An honest wheel.',
        concept: 'wheels turn', objectives: ['see the wheel turn'] });
      scene.param({ id: 'speed', kind: 'number', label: 'Speed', min: 0, max: 10, default: 5,
        affects: [{ channel: 'motionRate' }] });
      var m = mat.metal({});
      scene.mesh({ id: 'driveWheel', name: 'Drive wheel',
        geometry: geom.cylinder({ radius: 0.3, height: 0.06, segments: 24 }), material: m });
      scene.motion({ id: 'spin', partId: 'driveWheel', kind: 'spin', axis: [0, 0, 1],
        rate: { param: 'speed' }, reason: 'The wheel turns at the speed the learner sets.' });
    `);
    expect(result.ok, result.ok ? '' : result.message).toBe(true);
    if (!result.ok) return;

    expect(
      deficienciesFor(result, 'representationFidelity'),
      'an honest primitive wheel must not be flagged',
    ).toEqual([]);
  });

  it('does not flag the same names when the geometry is motion-correct — the check reads provenance, not names', () => {
    // The pins that keep this honest: identical vocabulary, identical motion, but builder 'gear'
    // and 'helix'. A name-heuristic with no geometry signal would flag these and burn real API
    // money on false refinement instructions.
    const result = audit(`
      scene.describe({ name: 'Honest train', description: 'Real profiles.',
        concept: 'gears mesh', objectives: ['see real gears mesh'] });
      var m = mat.metal({});
      scene.mesh({ id: 'driveGear', name: 'Drive gear',
        geometry: geom.gear({ teeth: 20, module: 0.02, thickness: 0.04, bore: 0.03 }), material: m });
      scene.mesh({ id: 'governorSpring', name: 'Governor spring',
        geometry: geom.helix({ radius: 0.05, wireRadius: 0.008, turns: 6, pitch: 0.02 }), material: m });
      scene.motion({ id: 'spin', partId: 'driveGear', kind: 'spin', axis: [0, 0, 1],
        rate: { const: 1 }, reason: 'Turns.' });
      scene.motion({ id: 'compress', partId: 'governorSpring', kind: 'oscillate', axis: [0, 1, 0],
        rate: { const: 0.5 }, amplitude: { const: 0.01 }, reason: 'Compresses.' });
    `);
    expect(result.ok, result.ok ? '' : result.message).toBe(true);
    if (!result.ok) return;

    expect(
      deficienciesFor(result, 'representationFidelity'),
      'gear/helix builders are motion-correct representations',
    ).toEqual([]);
  });
});

describe('read-out liveness — a lying number', () => {
  it('flags a declared metric that is never published', () => {
    // The prompt promises "numbers on screen and motion on screen always agree". A metric declared
    // but never published has no number at all — the panel shows a read-out with nothing behind it.
    // Nothing checked this before: `callbacks.metricComputers` records the declaration, not a value.
    const result = audit(`
      scene.describe({ name: 'Dead readout', description: 'A metric with nothing behind it.',
        concept: 'read-outs must be live', objectives: ['watch the read-out'] });
      scene.param({ id: 'flow', kind: 'number', label: 'Flow', min: 0, max: 10, default: 5,
        affects: [{ channel: 'metric' }] });
      scene.metric({ id: 'output', label: 'Output force', unit: 'N' });
      var m = mat.metal({});
      scene.mesh({ id: 'p', name: 'P', geometry: geom.box({ size: [0.2, 0.2, 0.2] }), material: m });
      scene.onFrame(function (ctx) {
        ctx.part('p').setPosition(ctx.params.flow, 0, 0);
      });
    `);
    expect(result.ok, result.ok ? '' : result.message).toBe(true);
    if (!result.ok) return;

    const dead = deficienciesFor(result, 'information')?.find(
      (d) => d.subjectId === 'metric:output',
    );
    expect(dead, "metric 'output' is declared but never published — must be flagged").toBeDefined();
    expect(dead?.severity).toBe('major');
  });

  it('flags a published metric that never changes across the sweep', () => {
    // The lying number: a read-out whose value is a constant. The motion follows the slider, the
    // number does not move — exactly the disagreement the prompt forbids. Evidence discipline is
    // the sweep's own: causality by VALUE CHANGE across sweep points, never by the presence of a
    // ctx.metric call (which a frame callback makes every frame regardless).
    const result = audit(`
      scene.describe({ name: 'Frozen readout', description: 'A read-out that never moves.',
        concept: 'numbers must track the motion', objectives: ['compare number and motion'] });
      scene.param({ id: 'flow', kind: 'number', label: 'Flow', min: 0, max: 10, default: 5,
        affects: [{ channel: 'metric' }, { channel: 'transform' }] });
      scene.metric({ id: 'output', label: 'Output force', unit: 'N', formula: 'F = m x a' });
      var m = mat.metal({});
      scene.mesh({ id: 'p', name: 'P', geometry: geom.box({ size: [0.2, 0.2, 0.2] }), material: m });
      scene.onFrame(function (ctx) {
        ctx.part('p').setPosition(ctx.params.flow, 0, 0);
        ctx.metric('output', 42);
      });
    `);
    expect(result.ok, result.ok ? '' : result.message).toBe(true);
    if (!result.ok) return;

    const frozen = deficienciesFor(result, 'information')?.find(
      (d) => d.subjectId === 'metric:output',
    );
    expect(frozen, "metric 'output' is published but constant — must be flagged").toBeDefined();
    expect(frozen?.severity).toBe('major');
    expect(frozen?.instruction).toMatch(/ctx\.metric/);
  });

  it('credits a metric published from onFrame as a function of a parameter', () => {
    // The false-positive guard: a read-out derived from the parameters it summarizes is exactly
    // what the prompt asks for, and must pass untouched.
    const result = audit(`
      scene.describe({ name: 'Live readout', description: 'A read-out that tracks the control.',
        concept: 'numbers track the motion', objectives: ['compare number and motion'] });
      scene.param({ id: 'flow', kind: 'number', label: 'Flow', min: 0, max: 10, default: 5,
        affects: [{ channel: 'metric' }, { channel: 'transform' }] });
      scene.metric({ id: 'output', label: 'Output force', unit: 'N' });
      var m = mat.metal({});
      scene.mesh({ id: 'p', name: 'P', geometry: geom.box({ size: [0.2, 0.2, 0.2] }), material: m });
      scene.onFrame(function (ctx) {
        ctx.part('p').setPosition(ctx.params.flow, 0, 0);
        ctx.metric('output', ctx.params.flow * 1.2);
      });
    `);
    expect(result.ok, result.ok ? '' : result.message).toBe(true);
    if (!result.ok) return;

    expect(
      (result.report.deficiencies ?? []).filter((d) => d.subjectId === 'metric:output'),
      'a read-out derived from a live parameter is not a defect',
    ).toEqual([]);
  });
});

describe('referential integrity — every declared id must resolve', () => {
  it('flags dangling quiz, story, setParameters and affects references', () => {
    // Verified unchecked upstream: `scene.motion` and `scene.interaction` throw on a missing
    // partId at authoring time, but story targets, story setParameters, shot targets, quiz
    // evidence ids, motion pathIds, affects partIds and interaction targetIds are all captured
    // verbatim. The learner taps "show me the evidence" and nothing happens.
    const result = audit(`
      scene.describe({ name: 'Broken lesson', description: 'References that point nowhere.',
        concept: 'ids must resolve', objectives: ['find the evidence'] });
      scene.param({ id: 'speed', kind: 'number', label: 'Speed', min: 0, max: 10, default: 5,
        affects: [{ partId: 'ghostTarget', channel: 'visibility' }] });
      var m = mat.metal({});
      scene.mesh({ id: 'p', name: 'P', geometry: geom.box({ size: [0.2, 0.2, 0.2] }), material: m });
      scene.shot('ghostShot', { kind: 'flyTo', targetPartId: 'ghostShotTarget', duration: 1 });
      scene.story([
        { id: 'b1', title: 'Ghost', narration: 'This beat points at parts that do not exist.',
          targetPartId: 'ghostPart', setParameters: { ghostParam: 2 },
          shots: [{ kind: 'flyTo', targetPartId: 'ghostBeatTarget' }] },
      ]);
      scene.quiz([
        { id: 'q1', question: 'Where is the evidence?', options: ['A', 'B'], correctIndex: 0,
          explanation: 'A is right because it is; B is wrong because it is not.',
          evidencePartId: 'ghostEvidence' },
      ]);
      scene.motion({ id: 'drift', partId: 'p', kind: 'flowAlongPath', pathId: 'ghostPath',
        reason: 'Flows along an undeclared path.' });
      scene.onFrame(function (ctx) {
        ctx.part('p').setPosition(ctx.params.speed, 0, 0);
      });
    `);
    expect(result.ok, result.ok ? '' : result.message).toBe(true);
    if (!result.ok) return;

    const dangling = deficienciesFor(result, 'completeness') ?? [];
    const missing = new Set(dangling.map((d) => d.subjectId));
    for (const id of [
      'ghostPart',
      'ghostParam',
      'ghostBeatTarget',
      'ghostEvidence',
      'ghostPath',
      'ghostTarget',
      'ghostShotTarget',
    ]) {
      expect(missing.has(id), `dangling reference '${id}' must be flagged`).toBe(true);
    }
    expect(dangling[0]?.severity === 'major').toBe(true);
    // The completeness score must actually suffer, not just record findings.
    const completeness = result.report.dimensions.find((d) => d.dimension === 'completeness');
    expect(completeness && completeness.score < 100).toBe(true);
  });

  it('accepts a model whose ids all resolve', () => {
    // The false-positive guard: real ids, declared before use, must not be flagged.
    const result = audit(`
      scene.describe({ name: 'Intact lesson', description: 'Every id resolves.',
        concept: 'ids resolve', objectives: ['find the evidence'] });
      scene.param({ id: 'speed', kind: 'number', label: 'Speed', min: 0, max: 10, default: 5,
        affects: [{ partId: 'p', channel: 'visibility' }] });
      var m = mat.metal({});
      scene.mesh({ id: 'p', name: 'P', geometry: geom.cylinder({ radius: 0.2, height: 0.1, segments: 12 }),
        material: m });
      scene.shot('closeup', { kind: 'flyTo', targetPartId: 'p', duration: 1 });
      scene.story([
        { id: 'b1', title: 'Real', narration: 'This beat points at a part that exists.',
          targetPartId: 'p', setParameters: { speed: 2 },
          shots: [{ kind: 'flyTo', targetPartId: 'p' }] },
      ]);
      scene.quiz([
        { id: 'q1', question: 'Where is the evidence?', options: ['A', 'B'], correctIndex: 0,
          explanation: 'A is right because it is; B is wrong because it is not.',
          evidencePartId: 'p' },
      ]);
      scene.motion({ id: 'spin', partId: 'p', kind: 'spin', axis: [0, 0, 1],
        rate: { param: 'speed' }, reason: 'The learner sets the speed.' });
    `);
    expect(result.ok, result.ok ? '' : result.message).toBe(true);
    if (!result.ok) return;

    expect(deficienciesFor(result, 'completeness'), 'every id resolves — nothing to flag').toEqual(
      [],
    );
  });
});

describe('unit discipline — quantitative claims on physical controls', () => {
  it('flags a motion-rate parameter declared without a unit', () => {
    // `MotionDecl` fixes what a rate means per kind (rad/s, m/s, Hz); a parameter that supplies a
    // rate cannot leave it unstated and still be quantitative. `00`'s hard contract demands real
    // units; nothing enforced them on the declaration.
    const result = audit(`
      scene.describe({ name: 'Unitless rate', description: 'A speed with no unit.',
        concept: 'rates carry units', objectives: ['read the unit'] });
      scene.param({ id: 'speed', kind: 'number', label: 'Speed', min: 0, max: 10, default: 5,
        affects: [{ channel: 'motionRate' }] });
      var m = mat.metal({});
      scene.mesh({ id: 'wheel', name: 'Wheel',
        geometry: geom.cylinder({ radius: 0.3, height: 0.06, segments: 24 }), material: m });
      scene.motion({ id: 'spin', partId: 'wheel', kind: 'spin', axis: [0, 0, 1],
        rate: { param: 'speed' }, reason: 'The learner sets the turning speed.' });
    `);
    expect(result.ok, result.ok ? '' : result.message).toBe(true);
    if (!result.ok) return;

    const unitless = deficienciesFor(result, 'information')?.find((d) => d.subjectId === 'speed');
    expect(
      unitless,
      "parameter 'speed' drives a motion rate with no unit — must be flagged",
    ).toBeDefined();
    expect(unitless?.severity).toBe('minor');
  });

  it('flags an empty declared unit, and never flags a parameter that declares one', () => {
    const result = audit(`
      scene.describe({ name: 'Empty unit', description: 'unit: "" is not a unit.',
        concept: 'units must be stated', objectives: ['read the unit'] });
      scene.param({ id: 'speed', kind: 'number', label: 'Speed', min: 0, max: 10, default: 5,
        unit: '   ', affects: [{ channel: 'motionRate' }] });
      var m = mat.metal({});
      scene.mesh({ id: 'wheel', name: 'Wheel',
        geometry: geom.cylinder({ radius: 0.3, height: 0.06, segments: 24 }), material: m });
      scene.motion({ id: 'spin', partId: 'wheel', kind: 'spin', axis: [0, 0, 1],
        rate: { param: 'speed' }, reason: 'The learner sets the turning speed.' });
    `);
    expect(result.ok, result.ok ? '' : result.message).toBe(true);
    if (!result.ok) return;

    const empty = deficienciesFor(result, 'information')?.find((d) => d.subjectId === 'speed');
    expect(empty, 'an empty unit declaration is not quantitative — must be flagged').toBeDefined();
  });

  it('does not flag a rate parameter that declared its unit — the reference pattern', () => {
    const result = audit(`
      scene.describe({ name: 'Declared rate', description: 'rpm, stated.',
        concept: 'rates carry units', objectives: ['read the unit'] });
      scene.param({ id: 'rpm', kind: 'number', label: 'Speed', min: 0, max: 10, default: 5,
        unit: 'rpm', affects: [{ channel: 'motionRate' }] });
      var m = mat.metal({});
      scene.mesh({ id: 'wheel', name: 'Wheel',
        geometry: geom.cylinder({ radius: 0.3, height: 0.06, segments: 24 }), material: m });
      scene.motion({ id: 'spin', partId: 'wheel', kind: 'spin', axis: [0, 0, 1],
        rate: { param: 'rpm' }, reason: 'The learner sets the turning speed.' });
    `);
    expect(result.ok, result.ok ? '' : result.message).toBe(true);
    if (!result.ok) return;

    expect(
      deficienciesFor(result, 'information')?.find((d) => d.subjectId === 'rpm'),
    ).toBeUndefined();
  });
});

describe('shot vocabulary honesty — a declared shot with no player is a false promise', () => {
  // `00-GOAL.md` calls the shot vocabulary a core capability. Four kinds — cut, flyTo, dolly,
  // fovPull — are played by the viewer; the other five are legal in the schema but have no
  // player, so a model declaring one is promising a camera move that will not happen. The flag
  // must say so honestly instead of crediting a declaration the learner will never see.
  it('flags a named camera shot whose kind cannot play', () => {
    const result = audit(`
      scene.describe({ name: 'Crane promise', description: 'A crane shot that will never run.',
        concept: 'the camera rises to reveal', objectives: ['watch the reveal'] });
      var m = mat.metal({});
      scene.mesh({ id: 'p', name: 'P', geometry: geom.box({ size: [0.2, 0.2, 0.2] }), material: m });
      scene.shot('reveal', { kind: 'crane', distance: 1.5, duration: 2 });
      scene.story([
        { id: 'b1', title: 'Reveal', narration: 'The camera rises to show the whole assembly.' },
      ]);
    `);
    expect(result.ok, result.ok ? '' : result.message).toBe(true);
    if (!result.ok) return;

    const flagged = deficienciesFor(result, 'pedagogy')?.find((d) => d.subjectId === 'shot:reveal');
    expect(flagged, "shot 'reveal' (crane) has no player — must be flagged").toBeDefined();
    expect(flagged?.severity).toBe('minor');
    expect(flagged?.finding).toMatch(/crane/);
    expect(flagged?.instruction).toMatch(/flyTo/);
  });

  it('flags an unplayable shot inside a story beat', () => {
    const result = audit(`
      scene.describe({ name: 'Orbit promise', description: 'A beat whose orbit shot will not play.',
        concept: 'the camera circles the mechanism', objectives: ['see it from all sides'] });
      var m = mat.metal({});
      scene.mesh({ id: 'p', name: 'P', geometry: geom.box({ size: [0.2, 0.2, 0.2] }), material: m });
      scene.story([
        { id: 'b1', title: 'All sides', narration: 'The camera circles the part.',
          targetPartId: 'p', shots: [{ kind: 'orbit', sweep: 1.5, duration: 3 }] },
      ]);
    `);
    expect(result.ok, result.ok ? '' : result.message).toBe(true);
    if (!result.ok) return;

    const flagged = deficienciesFor(result, 'pedagogy')?.find((d) => d.subjectId === 'shot:b1#1');
    expect(flagged, 'beat shot 1 (orbit) has no player — must be flagged').toBeDefined();
    expect(flagged?.severity).toBe('minor');
  });

  it('flags an interaction playShot whose kind cannot play', () => {
    const result = audit(`
      scene.describe({ name: 'Pan promise', description: 'A click that promises a pan.',
        concept: 'clicking pans across the part', objectives: ['pan across the part'] });
      var m = mat.metal({});
      scene.mesh({ id: 'p', name: 'P', geometry: geom.box({ size: [0.2, 0.2, 0.2] }), material: m });
      scene.interaction({ partId: 'p', on: 'click', kind: 'playShot',
        shot: { kind: 'pan', sweep: 0.5, duration: 1 } });
      scene.story([
        { id: 'b1', title: 'One', narration: 'A beat so the model carries a story.' },
      ]);
    `);
    expect(result.ok, result.ok ? '' : result.message).toBe(true);
    if (!result.ok) return;

    const flagged = deficienciesFor(result, 'pedagogy')?.find(
      (d) => d.subjectId === 'shot:p(click)',
    );
    expect(flagged, 'the interaction pan shot has no player — must be flagged').toBeDefined();
    expect(flagged?.severity).toBe('minor');
  });

  it('does not flag the four playable kinds — the honest vocabulary passes clean', () => {
    const result = audit(`
      scene.describe({ name: 'Playable shorts', description: 'Only kinds the viewer can play.',
        concept: 'shots the camera really makes', objectives: ['watch each move'] });
      var m = mat.metal({});
      scene.mesh({ id: 'p', name: 'P', geometry: geom.box({ size: [0.2, 0.2, 0.2] }), material: m });
      scene.shot('a', { kind: 'cut', pose: { position: [1, 1, 1] } });
      scene.shot('b', { kind: 'flyTo', targetPartId: 'p', duration: 1 });
      scene.shot('c', { kind: 'dolly', distance: -0.5 });
      scene.shot('d', { kind: 'fovPull', fov: 35 });
      scene.story([
        { id: 'b1', title: 'One', narration: 'First beat.',
          targetPartId: 'p', shots: [{ kind: 'dolly', distance: -0.4 }, { kind: 'fovPull', fov: 38 }] },
      ]);
      scene.interaction({ partId: 'p', on: 'click', kind: 'playShot',
        shot: { kind: 'flyTo', targetPartId: 'p' } });
    `);
    expect(result.ok, result.ok ? '' : result.message).toBe(true);
    if (!result.ok) return;

    const shotFindings = (deficienciesFor(result, 'pedagogy') ?? []).filter(
      (d) => typeof d.subjectId === 'string' && d.subjectId.startsWith('shot:'),
    );
    expect(shotFindings, 'playable kinds must not be flagged').toEqual([]);
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

  it('accrues zero representation-fidelity deficiencies — its gears, spring and blades are real', () => {
    // The inverse guard for the lookalike check: the reference uses real involute gears, a true
    // helix spring, swept airfoils and an SDF-blended combustor. If the new check flags any of
    // them, the check is wrong, not the model.
    const result = audit(REFERENCE_MODEL_SOURCE);
    expect(result.ok, result.ok ? '' : result.message).toBe(true);
    if (!result.ok) return;

    expect(deficienciesFor(result, 'representationFidelity')).toEqual([]);
    const fidelity = result.report.dimensions.find((d) => d.dimension === 'representationFidelity');
    expect(fidelity?.score, 'gear + helix + sdf bonuses must survive the stricter check').toBe(100);
  });

  it('scores 91 with zero deficiencies — the read-out, reference and unit checks must not fire on the flagship', () => {
    // The controller's rule: "a stricter audit that rejects the flagship is wrong, not the model."
    // The reference publishes all three of its metrics from onFrame as functions of the parameters
    // they summarize, declares a unit on its rate parameter (rpm), is deliberately dimensionless
    // where reality is (bypass ratio), and every id it names resolves. Score 91 is the published
    // baseline; a change here means a check fired where no defect exists.
    const result = audit(REFERENCE_MODEL_SOURCE);
    expect(result.ok, result.ok ? '' : result.message).toBe(true);
    if (!result.ok) return;

    expect(result.report.deficiencies).toEqual([]);
    expect(result.report.score).toBe(91);
  });
});
