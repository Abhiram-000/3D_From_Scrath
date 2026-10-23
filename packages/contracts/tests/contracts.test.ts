/**
 * Contract-level assertions.
 *
 * These tests exist because every other layer trusts these schemas. `02-PHYSICS.md` requires
 * non-finite values to be rejected "before they reach the solver", `06` requires ids to be rejected
 * "at the route before the query layer ever sees it", and `08` requires the budget table to be the one
 * number both the pricing pass and the runtime read. Each of those is a claim about this package, so
 * each gets a test here rather than a comment somewhere downstream.
 */
import { describe, expect, it } from 'vitest';
import {
  DEVICE_BUDGETS,
  ERROR_STATUS,
  ErrorCode,
  AUDIT_WEIGHTS,
  AuditDimension,
  MAX_LABELS,
  ModelLabel,
  ModelManifest,
  ParameterDecl,
  PartNode,
  QUALITY_LADDER,
  RETRYABLE,
  Vec3,
  finite,
  AuthoredId,
  AuditSummary,
  GenerationEvent,
  PHASE_WEIGHT,
  GenerationPhase,
  isTerminalEvent,
  SANDBOX_LIMITS,
  TRANSFORM_STRIDE,
  ShotKind,
  ShotDecl,
  ShotEasing,
} from '../src/index.ts';

describe('primitives', () => {
  it('rejects NaN and Infinity, which a plain number schema would accept', () => {
    expect(finite.safeParse(1.5).success).toBe(true);
    expect(finite.safeParse(Number.NaN).success).toBe(false);
    expect(finite.safeParse(Number.POSITIVE_INFINITY).success).toBe(false);
    expect(finite.safeParse(Number.NEGATIVE_INFINITY).success).toBe(false);
  });

  it('rejects a vector with any non-finite component', () => {
    expect(Vec3.safeParse([0, 1, 2]).success).toBe(true);
    expect(Vec3.safeParse([0, Number.NaN, 2]).success).toBe(false);
    expect(Vec3.safeParse([0, 1]).success).toBe(false);
  });

  it('constrains authored ids to a shape that is safe as a key and a label', () => {
    expect(AuthoredId.safeParse('turbineBlade_03').success).toBe(true);
    expect(AuthoredId.safeParse('9lives').success).toBe(false);
    expect(AuthoredId.safeParse('drop table;').success).toBe(false);
    expect(AuthoredId.safeParse('<script>').success).toBe(false);
    expect(AuthoredId.safeParse('').success).toBe(false);
  });
});

describe('the shot vocabulary', () => {
  it('carries exactly the vocabulary `00-GOAL.md` promises, each kind mapping to one promised move', () => {
    // cut = the instant transition, moveTo = the eased move, flyTo = fly-to/focus,
    // orbit = the reveal orbit, follow = the follow shot, dolly = dolly/push-in,
    // crane = the crane, pan = the pan, fovPull = the zoom (FOV) pull. Auto-rotate is
    // deliberately NOT a shot kind: it is CameraLimits.autoRotate, an idle state.
    expect([...ShotKind.options]).toEqual([
      'cut',
      'moveTo',
      'flyTo',
      'orbit',
      'follow',
      'dolly',
      'crane',
      'pan',
      'fovPull',
    ]);
  });

  it('rejects the invented kinds stale documentation taught models to copy', () => {
    // 'sweep' and 'closeUp' were shown as legal in the prompt's API reference table while no
    // schema accepted them — the exact makeup of a real `generation_unrepairable` run (a model
    // copied the documented example, and the repair pass re-sent the same table).
    expect(ShotKind.safeParse('sweep').success).toBe(false);
    expect(ShotKind.safeParse('closeUp').success).toBe(false);
    expect(ShotDecl.safeParse({ kind: 'closeUp', targetPartId: 'demo' }).success).toBe(false);
  });

  it('accepts a full shot declaration, and fills the defaults playback reads', () => {
    const parsed = ShotDecl.parse({
      kind: 'flyTo',
      targetPartId: 'demo',
      duration: 2,
    });
    expect(parsed.easing).toBe('easeInOut');
    expect(parsed.margin).toBe(1.35);
  });

  it('rejects an easing outside the documented curves', () => {
    expect(ShotEasing.safeParse('snappy').success).toBe(false);
    expect(ShotDecl.safeParse({ kind: 'flyTo', easing: 'snappy' }).success).toBe(false);
  });
});

describe('part nodes', () => {
  const minimal = {
    id: 'root',
    parentId: null,
    kind: 'group',
    name: 'Root',
    transform: {},
  };

  it('fills the defaults a realizer depends on', () => {
    const parsed = PartNode.parse(minimal);
    expect(parsed.transform.position).toEqual([0, 0, 0]);
    expect(parsed.transform.scale).toEqual([1, 1, 1]);
    expect(parsed.selectable).toBe(true);
    expect(parsed.visible).toBe(true);
    expect(parsed.hero).toBe(false);
    expect(parsed.staticGeometry).toBe(false);
  });

  it('accepts a geometry produced by any builder name, since the shape list is not closed', () => {
    // The point of this test is the *absence* of an enum: a builder the contract never heard of is
    // fine, because the static gate validates names against the engine's live API surface instead.
    const withNovelBuilder = PartNode.parse({
      ...minimal,
      kind: 'mesh',
      geometry: {
        builder: 'gyroidLattice',
        cacheKey: 'gyroid:1',
        triangles: 4096,
        vertices: 2048,
        modifiers: ['twist', 'shell'],
      },
    });
    expect(withNovelBuilder.geometry?.builder).toBe('gyroidLattice');
    expect(withNovelBuilder.geometry?.modifiers).toEqual(['twist', 'shell']);
    expect(withNovelBuilder.geometry?.decimated).toBe(false);
  });

  it('rejects a builder name that is not a plain identifier', () => {
    const result = PartNode.safeParse({
      ...minimal,
      kind: 'mesh',
      geometry: { builder: 'fetch(); //', cacheKey: 'x', triangles: 1, vertices: 3 },
    });
    expect(result.success).toBe(false);
  });
});

describe('parameters', () => {
  it('discriminates widget kinds so the panel has one owner per type', () => {
    const number = ParameterDecl.parse({
      kind: 'number',
      id: 'speed',
      label: 'Rotor speed',
      min: 0,
      max: 3000,
      default: 1200,
      unit: 'rpm',
    });
    // The narrowing is the assertion: a discriminated union means the panel branches once, on `kind`,
    // and every type-specific field is only reachable inside that branch.
    expect(number.kind).toBe('number');
    if (number.kind === 'number') {
      expect(number.scale).toBe('linear');
      expect(number.max).toBe(3000);
    }

    const choice = ParameterDecl.parse({
      kind: 'choice',
      id: 'mode',
      label: 'Mode',
      options: [
        { value: 'a', label: 'A' },
        { value: 'b', label: 'B' },
      ],
      default: 'a',
    });
    expect(choice.kind).toBe('choice');
    if (choice.kind === 'choice') {
      expect(choice.options).toHaveLength(2);
    }
  });

  it('requires at least two options for a choice, because one option is not a control', () => {
    const result = ParameterDecl.safeParse({
      kind: 'choice',
      id: 'mode',
      label: 'Mode',
      options: [{ value: 'a', label: 'A' }],
      default: 'a',
    });
    expect(result.success).toBe(false);
  });
});

describe('model manifest', () => {
  /** The smallest manifest a realizer must accept: one part, a camera, a cost. */
  const minimalManifest = {
    formatVersion: 1 as const,
    name: 'Test model',
    description: 'A single group, enough to exercise the schema.',
    domain: 'mechanics' as const,
    pedagogy: {
      concept: 'nothing in particular',
      objectives: ['exist'],
    },
    parts: [{ id: 'root', parentId: null, kind: 'group' as const, name: 'Root', transform: {} }],
    camera: { initial: { position: [3, 2, 4] } },
    cost: {
      parts: 1,
      uniqueGeometries: 0,
      uniqueMaterials: 0,
      triangles: 0,
      vertices: 0,
      drawCalls: 0,
      instancedSets: 0,
      instances: 0,
      shadowCastingLights: 0,
      physicsBodies: 0,
      authorMillis: 1,
    },
    createdAt: 1,
  };

  it('applies nested defaults for environment, camera limits and callbacks', () => {
    const parsed = ModelManifest.parse(minimalManifest);
    // `prefault` is what makes these fill in; a plain `.default({})` would have demanded full objects.
    expect(parsed.environment.preset).toBe('studio');
    expect(parsed.environment.grid).toBe(false);
    expect(parsed.camera.limits.autoRotate).toBe(true);
    expect(parsed.camera.limits.damping).toBeGreaterThan(0);
    expect(parsed.callbacks.hasFrame).toBe(false);
    expect(parsed.story).toEqual([]);
    expect(parsed.quiz).toEqual([]);
    expect(parsed.labels).toEqual([]);
  });

  it('refuses a manifest with an empty part tree, because a blank scene is never shipped', () => {
    const result = ModelManifest.safeParse({ ...minimalManifest, parts: [] });
    expect(result.success).toBe(false);
  });
});

describe('model labels', () => {
  const valid = { id: 'lblAxle', partId: 'axle', text: 'Axle' };

  it('accepts a bounded label with an optional offset and no offset by default', () => {
    const parsed = ModelLabel.parse(valid);
    expect(parsed.id).toBe('lblAxle');
    expect(parsed.partId).toBe('axle');
    expect(parsed.text).toBe('Axle');
    expect(parsed.offset).toBeUndefined();

    const withOffset = ModelLabel.parse({ ...valid, offset: [0, 0.08, 0] });
    expect(withOffset.offset).toEqual([0, 0.08, 0]);
  });

  it('refuses label text past 64 characters, so a pin stays a name and not a paragraph', () => {
    expect(ModelLabel.safeParse({ ...valid, text: 'x'.repeat(64) }).success).toBe(true);
    expect(ModelLabel.safeParse({ ...valid, text: 'x'.repeat(65) }).success).toBe(false);
  });

  it('refuses an empty string label — a pin with no word names nothing', () => {
    expect(ModelLabel.safeParse({ ...valid, text: '' }).success).toBe(false);
  });

  it('refuses a malformed partId, because a label must name a real part id shape', () => {
    expect(ModelLabel.safeParse({ ...valid, partId: '9bad' }).success).toBe(false);
    expect(ModelLabel.safeParse({ ...valid, partId: '<script>' }).success).toBe(false);
  });

  it('refuses a non-finite offset — a label floating at NaN has no honest place on screen', () => {
    expect(ModelLabel.safeParse({ ...valid, offset: [0, Number.NaN, 0] }).success).toBe(false);
    expect(ModelLabel.safeParse({ ...valid, offset: [0, 0] }).success).toBe(false);
  });

  it('caps a manifest at MAX_LABELS labels', () => {
    const label = (index: number) => ({ id: `lbl${index}`, partId: 'root', text: 'Root' });
    const manifest = (count: number) => ({
      formatVersion: 1 as const,
      name: 'Labelled',
      description: 'Enough labels to exercise the cap.',
      domain: 'mechanics' as const,
      pedagogy: { concept: 'labels', objectives: ['read a name on the model'] },
      parts: [{ id: 'root', parentId: null, kind: 'group' as const, name: 'Root', transform: {} }],
      labels: Array.from({ length: count }, (_, index) => label(index)),
      camera: { initial: { position: [3, 2, 4] } },
      cost: {
        parts: 1,
        uniqueGeometries: 0,
        uniqueMaterials: 0,
        triangles: 0,
        vertices: 0,
        drawCalls: 0,
        instancedSets: 0,
        instances: 0,
        shadowCastingLights: 0,
        physicsBodies: 0,
        authorMillis: 1,
      },
      createdAt: 1,
    });
    expect(MAX_LABELS).toBe(64);
    expect(ModelManifest.safeParse(manifest(MAX_LABELS)).success).toBe(true);
    expect(ModelManifest.safeParse(manifest(MAX_LABELS + 1)).success).toBe(false);
  });
});

describe('error taxonomy', () => {
  it('gives every code a status, so a route cannot invent one', () => {
    for (const code of ErrorCode.options) {
      expect(ERROR_STATUS[code], code).toBeTypeOf('number');
      expect(RETRYABLE[code], code).toBeTypeOf('boolean');
    }
  });

  it('maps an absent capability to 503 rather than 500', () => {
    // The distinction 04 insists on: the server is fine, the capability is not.
    expect(ERROR_STATUS.capability_absent).toBe(503);
    expect(ERROR_STATUS.draining).toBe(503);
    expect(ERROR_STATUS.internal).toBe(500);
  });

  it('never retries a semantic refusal, and always retries a transient failure', () => {
    expect(RETRYABLE.upstream_refused).toBe(false);
    expect(RETRYABLE.bad_request).toBe(false);
    expect(RETRYABLE.rate_limited).toBe(true);
    expect(RETRYABLE.upstream_quota).toBe(true);
  });
});

describe('generation stream', () => {
  it('recognises exactly the two terminal events', () => {
    const phase = GenerationEvent.parse({
      type: 'phase',
      phase: 'model',
      message: 'Designing your scene…',
      at: 1,
    });
    expect(isTerminalEvent(phase)).toBe(false);

    const failure = GenerationEvent.parse({
      type: 'error',
      code: 'upstream_truncated',
      message: 'cut off',
      requestId: 'req_1234',
      at: 2,
    });
    expect(isTerminalEvent(failure)).toBe(true);
  });

  it('carries the audit’s unbound parameter ids, defaulting to empty for older servers', () => {
    // Structured measurement data for the topic battery: subjectId equality, never prose
    // matching. Optional with a default so older servers' events still parse.
    const withIds = AuditSummary.parse({ score: 80, unboundParameterIds: ['dead'] });
    expect(withIds.unboundParameterIds).toEqual(['dead']);

    const legacy = AuditSummary.parse({ score: 80 });
    expect(legacy.unboundParameterIds).toEqual([]);
  });

  it('weights every phase, so the progress model can ease without inventing milestones', () => {
    for (const phase of GenerationPhase.options) {
      expect(PHASE_WEIGHT[phase], phase).toBeGreaterThan(0);
    }
    const total = Object.values(PHASE_WEIGHT).reduce((sum, weight) => sum + weight, 0);
    expect(total).toBeCloseTo(1, 5);
  });
});

describe('device budgets', () => {
  it('increases monotonically with tier', () => {
    const { low, mid, high } = DEVICE_BUDGETS;
    expect(low.maxTriangles).toBeLessThan(mid.maxTriangles);
    expect(mid.maxTriangles).toBeLessThan(high.maxTriangles);
    expect(low.maxDrawCalls).toBeLessThan(mid.maxDrawCalls);
    expect(mid.maxDrawCalls).toBeLessThan(high.maxDrawCalls);
    expect(low.maxShadowLights).toBeLessThanOrEqual(mid.maxShadowLights);
    expect(low.targetFps).toBeLessThan(mid.targetFps);
  });

  it('matches the numbers 08 states as contracts', () => {
    expect(DEVICE_BUDGETS.low.maxTriangles).toBe(150_000);
    expect(DEVICE_BUDGETS.mid.maxTriangles).toBe(600_000);
    expect(DEVICE_BUDGETS.high.maxTriangles).toBe(2_000_000);
    expect(DEVICE_BUDGETS.low.targetFps).toBe(30);
    expect(DEVICE_BUDGETS.mid.targetFps).toBe(50);
    expect(DEVICE_BUDGETS.high.targetFps).toBe(58);
  });

  it('lets even a low-tier device afford a large instanced set, since it is one draw call', () => {
    expect(DEVICE_BUDGETS.low.maxInstances).toBeGreaterThan(DEVICE_BUDGETS.low.maxDrawCalls * 10);
  });

  it('steps the quality ladder down least-damage-first', () => {
    // 08 fixes this order and its reasoning: pixel ratio is the cheapest visible loss, geometry and
    // physics detail are the most expensive to the lesson.
    expect(QUALITY_LADDER[0]).toBe('pixelRatio');
    expect(QUALITY_LADDER.indexOf('geometryDetail')).toBeGreaterThan(
      QUALITY_LADDER.indexOf('shadows'),
    );
    expect(QUALITY_LADDER.at(-1)).toBe('flatShading');
  });

  it('freezes the budget table so no consumer can retune it at runtime', () => {
    expect(Object.isFrozen(DEVICE_BUDGETS)).toBe(true);
    expect(Object.isFrozen(DEVICE_BUDGETS.mid)).toBe(true);
  });
});

describe('audit weights', () => {
  it('covers every dimension and sums to one', () => {
    for (const dimension of AuditDimension.options) {
      expect(AUDIT_WEIGHTS[dimension], dimension).toBeGreaterThan(0);
    }
    const total = Object.values(AUDIT_WEIGHTS).reduce((sum, weight) => sum + weight, 0);
    expect(total).toBeCloseTo(1, 5);
  });

  it('weights correctness above decoration', () => {
    expect(AUDIT_WEIGHTS.completeness).toBeGreaterThan(AUDIT_WEIGHTS.attractiveness);
    expect(AUDIT_WEIGHTS.parameterLeverage).toBeGreaterThan(AUDIT_WEIGHTS.detailEconomics);
  });
});

describe('sandbox limits', () => {
  it('bounds a runaway program without bounding an ambitious one', () => {
    // 00 requires 300-part assemblies to be ordinary, so these ceilings sit far above that ambition.
    expect(SANDBOX_LIMITS.maxTotalVertices).toBeGreaterThan(1_000_000);
    expect(SANDBOX_LIMITS.maxCodeBytes).toBeGreaterThan(200_000);
    expect(SANDBOX_LIMITS.buildDeadlineMs).toBeGreaterThan(5_000);
    expect(TRANSFORM_STRIDE).toBe(10);
  });
});
