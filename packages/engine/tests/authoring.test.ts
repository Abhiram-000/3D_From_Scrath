/**
 * The end-to-end authoring test: gate → instrument → sandbox → manifest.
 *
 * This is the P1 gate from `PLAN.md`, and it is the first test in the suite that exercises the whole boundary at
 * once. It matters because every layer being individually correct does not mean the sequence is: the ordering
 * that makes the sandbox work (compile before harden), the descriptor that keeps the gate and the engine in
 * agreement, and the manifest's own validation all only meet here.
 *
 * The reference turbofan is the fixture rather than a toy, deliberately. `00-GOAL.md` requires 300-part
 * multi-system assemblies to be *ordinary*, so the test that proves the pipeline works should be one.
 */
import { describe, expect, it } from 'vitest';
import { prepareProgram, describeViolations, createGuard } from '@edu3d/sandbox';
import { apiSurfaceSet, describeApiSurface } from '../src/authoring/api-surface.ts';
import { authorModel, runFrame } from '../src/authoring/guest.ts';
import { applyMotions, type PartTransformLike } from '../src/runtime/motions.ts';
import { MINIMAL_MODEL_SOURCE, REFERENCE_MODEL_SOURCE } from '../src/reference/turbofan.ts';

/** Run a program the way the server does: extract, gate, instrument. */
const prepare = (source: string) => prepareProgram(source, { apiSurface: apiSurfaceSet() });

/**
 * Author a program the way the browser worker does.
 *
 * `harden: false` because hardening deletes capabilities from the *test process* realm, which would break every
 * later test in the file. The hardening path has its own dedicated suite in `packages/sandbox`.
 */
const author = (source: string) => {
  const prepared = prepare(source);
  expect(prepared.ok, describeViolations(prepared.gate).join('\n')).toBe(true);
  return authorModel({ code: prepared.instrumented, tier: 'mid', seed: 7, harden: false });
};

describe('the API surface descriptor', () => {
  it('is derived from the real factories, so the gate cannot drift from the engine', () => {
    const surface = apiSurfaceSet();
    // A sample across every namespace: if any of these is missing, the descriptor stopped reflecting the code.
    for (const member of [
      'scene.describe',
      'scene.mesh',
      'scene.instances',
      'scene.defineComponent',
      'scene.onFrame',
      'geom.mesh',
      'geom.sdf',
      'geom.sweep',
      'geom.revolve',
      'geom.pattern.radial',
      'geom.field.smoothUnion',
      'mat.metal',
      'mat.glass',
      'M.sin',
      'M.TAU',
      'random.float',
      'console.log',
    ]) {
      expect(surface.has(member), member).toBe(true);
    }
  });

  it('does not advertise anything the engine does not export', () => {
    const surface = apiSurfaceSet();
    expect(surface.has('geom.magicRocket')).toBe(false);
    expect(surface.has('scene.fetch')).toBe(false);
  });

  it('renders deterministic prompt documentation', () => {
    // A prompt that reorders between runs invalidates response caching and makes A/B comparison meaningless.
    expect(describeApiSurface()).toBe(describeApiSurface());
    expect(describeApiSurface()).toMatch(/^geom: /m);
    expect(describeApiSurface()).toMatch(/^scene: /m);
  });
});

describe('the minimal reference model', () => {
  it('passes the gate, builds, and produces a valid manifest', () => {
    const result = author(MINIMAL_MODEL_SOURCE);
    expect(result.ok, result.ok ? '' : result.message).toBe(true);
    if (!result.ok) return;

    expect(result.manifest.name).toBe('Simple pendulum');
    expect(result.manifest.parts.length).toBeGreaterThanOrEqual(3);
    expect(result.manifest.parameters).toHaveLength(1);
    expect(result.manifest.callbacks.hasFrame).toBe(true);
    expect(result.manifest.cost.triangles).toBeGreaterThan(0);
  });

  it('proves its parameter actually drives geometry, by sweeping it', () => {
    // The mechanism behind `00`'s rule that "a control that changes nothing is rejected, not shipped": set the
    // parameter, run a frame, and observe which channels were written.
    const result = author(MINIMAL_MODEL_SOURCE);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    result.builder.sweepParameter('length', 2);
    const writes = result.builder.observedWrites.get('length');
    expect(writes, 'the length parameter should have written something').toBeDefined();
    expect([...(writes ?? [])]).toContain('transform');
  });

  it('publishes a metric whose value follows the parameter', () => {
    const result = author(MINIMAL_MODEL_SOURCE);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    result.builder.setParameter('length', 0.25);
    result.builder.runFrame(0);
    const short = result.builder.currentMetrics().period as number;

    result.builder.setParameter('length', 2);
    result.builder.runFrame(0);
    const long = result.builder.currentMetrics().period as number;

    // T = 2π√(L/g): a longer pendulum has a longer period. The numbers on screen come from the same source as
    // the motion, which is the point of publishing metrics from the model's own frame code.
    expect(long).toBeGreaterThan(short);
    expect(short).toBeCloseTo(2 * Math.PI * Math.sqrt(0.25 / 9.80665), 3);
  });

  it('moves the model when a frame runs', () => {
    const result = author(MINIMAL_MODEL_SOURCE);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const guard = createGuard();
    const before = result.manifest.parts.find((part) => part.id === 'bob')?.transform.position[1];
    const frame = runFrame(result.builder, guard, 0.4, 1 / 60, false);
    expect(frame.ok).toBe(true);
    const after = result.manifest.parts.find((part) => part.id === 'bob')?.transform.position[1];
    // The bob's own y is length-driven, so it should be defined at both points; the *rotation* is what swings.
    expect(before).toBeDefined();
    expect(after).toBeDefined();
    expect(result.builder.touchedParts().size).toBeGreaterThan(0);
  });
});

describe('the reference turbofan', () => {
  it('passes the gate', () => {
    const prepared = prepare(REFERENCE_MODEL_SOURCE);
    expect(prepared.ok, describeViolations(prepared.gate).join('\n')).toBe(true);
    expect(prepared.gate.guardedLoops).toBeGreaterThan(0);
  });

  it('builds a multi-system assembly with hundreds of meaningful parts', () => {
    const result = author(REFERENCE_MODEL_SOURCE);
    expect(result.ok, result.ok ? '' : result.message).toBe(true);
    if (!result.ok) return;

    const manifest = result.manifest;
    // Seven compressor stages, each a placed component with a disc and an instanced blade set, plus the fan,
    // combustor, turbine, accessory drive, fuel system and nacelle.
    expect(manifest.parts.length).toBeGreaterThan(25);
    expect(manifest.cost.instancedSets).toBeGreaterThanOrEqual(9);
    expect(manifest.cost.instances).toBeGreaterThan(200);
  });

  it('prices instanced sets as one draw call each', () => {
    // `08`: "N × geometry cost, 1 × draw call." The saving must show up in the measured cost, or the pricing is
    // decorative.
    const result = author(REFERENCE_MODEL_SOURCE);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const { cost } = result.manifest;
    expect(cost.drawCalls).toBeLessThan(cost.parts + cost.instances);
    // Far more triangles on screen than draw calls to issue them: exactly what instancing buys.
    expect(cost.triangles).toBeGreaterThan(cost.drawCalls * 100);
  });

  it('deduplicates repeated geometry so a component placed seven times costs one build', () => {
    const result = author(REFERENCE_MODEL_SOURCE);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // The compressor stages differ in radius, so each has its own geometry — but the blade geometry within a
    // stage is shared across its instances, and the gears/discs that repeat exactly are deduplicated.
    const { cost } = result.manifest;
    expect(cost.uniqueGeometries).toBeLessThan(cost.parts);
    expect(result.builder.geometry.stats.hits).toBeGreaterThan(0);
  });

  it('uses the whole expressive range rather than primitives alone', () => {
    // The check that the API's ceiling is actually reachable: a swept airfoil, an SDF blend, a raw computed mesh,
    // an involute gear and a true helical sweep all appear in one model.
    const result = author(REFERENCE_MODEL_SOURCE);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const builders = new Set(
      result.manifest.parts.map((part) => part.geometry?.builder).filter(Boolean) as string[],
    );
    expect(builders).toContain('sweep');
    expect(builders).toContain('sdf');
    expect(builders).toContain('mesh');
    expect(builders).toContain('gear');
    expect(builders).toContain('helix');
    expect(builders).toContain('pipe');
    expect(builders).toContain('revolve');
  });

  it('declares colour roles, so colour reads as category', () => {
    const result = author(REFERENCE_MODEL_SOURCE);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const roles = result.manifest.colorRoles.map((role) => role.id);
    expect(roles).toContain('coldAir');
    expect(roles).toContain('hotGas');
    expect(roles).toContain('rotating');
    // Every role carries a stated meaning, which is what the info panel's legend shows.
    for (const role of result.manifest.colorRoles) expect(role.meaning.length).toBeGreaterThan(3);
  });

  it('gives selectable parts something to say', () => {
    // `01`: "a part the learner can select but that says nothing is a wasted click."
    const result = author(REFERENCE_MODEL_SOURCE);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const selectableMeshes = result.manifest.parts.filter(
      (part) => part.selectable && part.kind !== 'group',
    );
    const withInfo = selectableMeshes.filter((part) => part.info?.title);
    // Not every stage blade needs prose, but the majority of selectable parts must carry information.
    expect(withInfo.length / selectableMeshes.length).toBeGreaterThan(0.4);
  });

  it('authors an opening camera rather than relying on auto-framing', () => {
    // `00`: "the AI author sets the initial camera; auto-frame the bounding sphere is the fallback, never the
    // default answer." The fallback pushes a warning, so its absence is the assertion.
    const result = author(REFERENCE_MODEL_SOURCE);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.manifest.camera.initial.position).not.toEqual([0, 0, 0]);
    expect(result.manifest.warnings.some((warning) => /auto-framed/.test(warning))).toBe(false);
  });

  it('declares motion whose rate comes from a parameter', () => {
    const result = author(REFERENCE_MODEL_SOURCE);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const spin = result.manifest.motions.find((motion) => motion.id === 'spoolSpin');
    expect(spin).toBeDefined();
    expect(spin?.rate).toHaveProperty('param', 'spoolRpm');
    // Every declared motion states why the part moves, which the audit reads to reject motion-for-animation.
    for (const motion of result.manifest.motions) expect(motion.reason).toBeTruthy();
  });

  it("spins the spool at the slider's speed — the flagship regression test", () => {
    // The bug this whole phase removes: the spool-speed slider moved the thrust readouts (they
    // come from onFrame) while the fan stood perfectly still, because nothing anywhere applied
    // manifest.motions. This is the strongest browser-less proof: load the reference source
    // through the same gate → instrument → author path the worker uses, then apply declared
    // motion at two slider values and require *different rotations*, not just any rotation.
    const result = author(REFERENCE_MODEL_SOURCE);
    expect(result.ok, result.ok ? '' : result.message).toBe(true);
    if (!result.ok) return;

    const nodes = new Map(result.manifest.parts.map((part) => [part.id, part]));
    const snapshot = (transform: PartTransformLike): PartTransformLike => ({
      position: [...transform.position],
      ...(transform.rotation ? { rotation: [...transform.rotation] } : {}),
      scale: [...transform.scale],
    });
    // The authored base per motion-driven part, captured at load exactly as the worker does.
    const bases = new Map<string, PartTransformLike>();
    for (const motion of result.manifest.motions) {
      const transform = nodes.get(motion.partId)?.transform;
      if (transform && !bases.has(motion.partId)) bases.set(motion.partId, snapshot(transform));
    }

    const spoolRotationAt = (rpm: number, elapsed: number): number => {
      // Host reset → model frame code → apply motions: the worker's exact per-frame order.
      for (const [id, base] of bases) {
        const live = nodes.get(id)?.transform;
        if (!live) continue;
        live.position = [...base.position] as [number, number, number];
        live.rotation = base.rotation
          ? ([...base.rotation] as [number, number, number])
          : undefined;
        live.scale = [...base.scale] as [number, number, number];
      }
      result.builder.setParameter('spoolRpm', rpm);
      result.builder.runFrame(elapsed, 1 / 60, false);
      const params = Object.fromEntries(
        Object.entries(result.builder.currentParameters()).filter(
          (entry): entry is [string, number] => typeof entry[1] === 'number',
        ),
      );
      applyMotions(
        {
          motions: result.manifest.motions,
          baseTransform: (id) => bases.get(id),
          liveTransform: (id) => nodes.get(id)?.transform,
        },
        { params, elapsed },
        false,
      );
      return (nodes.get('spool')?.transform.rotation ?? [0, 0, 0])[2];
    };

    // spoolSpin: rate = spoolRpm × 0.000105 rad/s about z, so t = 1 s turns the fan by exactly
    // that angle — the readouts and the rotation come from the same parameter at last.
    const idle = spoolRotationAt(1_500, 1);
    const flatOut = spoolRotationAt(9_000, 1);
    expect(idle).toBeCloseTo(1_500 * 0.000105, 6);
    expect(flatOut).toBeCloseTo(9_000 * 0.000105, 6);
    expect(flatOut).not.toBeCloseTo(idle, 6);
  });

  it('proves every parameter drives something', () => {
    // The audit's core measurement, run here as a test: sweep each parameter to its extremes and require that
    // some channel was written. A parameter that writes nothing is a provable deficiency.
    const result = author(REFERENCE_MODEL_SOURCE);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    for (const parameter of result.manifest.parameters) {
      if (parameter.kind === 'number') {
        result.builder.sweepParameter(parameter.id, parameter.max);
        result.builder.sweepParameter(parameter.id, parameter.min);
      } else if (parameter.kind === 'boolean') {
        result.builder.sweepParameter(parameter.id, !parameter.default);
      }
    }

    // The three numeric parameters all feed the frame callback, so each should show writes.
    for (const id of ['spoolRpm', 'fuelFlow', 'bypassRatio']) {
      const writes = result.builder.observedWrites.get(id);
      expect(writes, `parameter '${id}' wrote nothing`).toBeDefined();
      expect((writes as Set<string>).size).toBeGreaterThan(0);
    }
  });

  it('carries a story that follows the causal arc and targets real parts', () => {
    const result = author(REFERENCE_MODEL_SOURCE);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const story = result.manifest.story;
    // `05`: 3–6 beats for most concepts.
    expect(story.length).toBeGreaterThanOrEqual(3);
    expect(story.length).toBeLessThanOrEqual(6);

    const partIds = new Set(result.manifest.parts.map((part) => part.id));
    for (const beat of story) {
      expect(beat.narration.length).toBeGreaterThan(40);
      if (beat.targetPartId) expect(partIds.has(beat.targetPartId), beat.targetPartId).toBe(true);
    }
    // No dangling story target warning.
    expect(result.manifest.warnings.some((warning) => /does not exist/.test(warning))).toBe(false);
  });

  it('carries authored quiz questions with valid answers and real distractors', () => {
    const result = author(REFERENCE_MODEL_SOURCE);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.manifest.quiz.length).toBeGreaterThanOrEqual(3);
    for (const question of result.manifest.quiz) {
      expect(question.options.length).toBeGreaterThanOrEqual(2);
      expect(question.correctIndex).toBeLessThan(question.options.length);
      // The explanation must address the tempting wrong answer, not merely restate the right one.
      expect(question.explanation.length).toBeGreaterThan(60);
    }
  });

  it('stays inside a mid-tier device budget', () => {
    const result = author(REFERENCE_MODEL_SOURCE);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Priced before allocation, which is what makes admission control possible at all (`08`).
    expect(result.manifest.cost.triangles).toBeLessThan(600_000);
    expect(result.manifest.cost.drawCalls).toBeLessThan(400);
  });

  it('runs a frame without throwing, and the frame changes the model', () => {
    const result = author(REFERENCE_MODEL_SOURCE);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const guard = createGuard();
    for (const time of [0, 0.25, 0.5, 1]) {
      const frame = runFrame(result.builder, guard, time, 1 / 60, false);
      expect(frame.ok, frame.ok ? '' : frame.message).toBe(true);
    }

    const touched = result.builder.touchedParts();
    expect(touched.has('flameVolume')).toBe(true);
    expect(touched.has('exhaustPlume')).toBe(true);
  });

  it('completes the authoring pass well inside the build deadline', () => {
    const result = author(REFERENCE_MODEL_SOURCE);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The turbofan includes a marching-cubes combustor at resolution 52, which is the expensive step. If this
    // regresses badly, the sandbox watchdog would start killing legitimate builds.
    expect(result.durationMs).toBeLessThan(15_000);
  });
});

describe('authoring failures are reported, never thrown', () => {
  it('reports a model that never described itself', () => {
    // `00`: a model that fails to build "must not take the viewer down. Show the error, keep the page alive."
    const result = author(`scene.group({ id: 'root' });`);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toMatch(/scene\.describe/);
  });

  it('reports a model that declared no parts', () => {
    const result = author(`
      scene.describe({ name: 'Empty', description: 'Nothing at all.', concept: 'x', objectives: ['y'] });
    `);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toMatch(/no parts/i);
  });

  it('reports a duplicate part id with an actionable instruction', () => {
    const result = author(`
      scene.describe({ name: 'Dup', description: 'Two parts, one id.', concept: 'x', objectives: ['y'] });
      var m = mat.metal({});
      var g = geom.box([1, 1, 1]);
      scene.mesh({ id: 'a', geometry: g, material: m });
      scene.mesh({ id: 'a', geometry: g, material: m });
    `);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toMatch(/already used/);
    expect(result.message).toMatch(/append an index/);
  });

  it('reports a part naming a parent that does not exist', () => {
    const result = author(`
      scene.describe({ name: 'Orphan', description: 'Bad parent.', concept: 'x', objectives: ['y'] });
      scene.mesh({
        id: 'child',
        parentId: 'nowhere',
        geometry: geom.box([1, 1, 1]),
        material: mat.metal({}),
      });
    `);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toMatch(/does not exist/);
  });

  it('reports an undeclared colour role rather than silently using grey', () => {
    const result = author(`
      scene.describe({ name: 'Role', description: 'Missing role.', concept: 'x', objectives: ['y'] });
      scene.mesh({ id: 'a', geometry: geom.box([1, 1, 1]), material: mat.metal({ role: 'ghost' }) });
    `);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toMatch(/colorRole/);
  });

  it('drops an unanswerable quiz question instead of rendering it', () => {
    // `05`'s canonical failure: "every answer was wrong, including the right one."
    const result = author(`
      scene.describe({ name: 'Quiz', description: 'Bad question.', concept: 'x', objectives: ['y'] });
      scene.mesh({ id: 'a', geometry: geom.box([1, 1, 1]), material: mat.metal({}) });
      scene.camera({ position: [2, 2, 2] });
      scene.quiz([
        { id: 'bad', question: 'Which?', options: ['only one'], correctIndex: 5, explanation: 'n/a' },
        {
          id: 'good',
          question: 'Which is larger?',
          options: ['a', 'b'],
          correctIndex: 1,
          explanation: 'b is larger than a by definition here.',
        },
      ]);
    `);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.manifest.quiz).toHaveLength(1);
    expect(result.manifest.quiz[0]?.id).toBe('good');
    expect(result.manifest.warnings.some((warning) => /dropped/.test(warning))).toBe(true);
  });

  it('terminates a runaway loop instead of hanging the build', () => {
    const prepared = prepare(`
      scene.describe({ name: 'Runaway', description: 'Infinite.', concept: 'x', objectives: ['y'] });
      while (true) { }
    `);
    expect(prepared.ok).toBe(true);
    const result = authorModel({
      code: prepared.instrumented,
      tier: 'mid',
      seed: 1,
      harden: false,
      deadlineMs: 200,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.timedOut).toBe(true);
  });

  it('routes guest console output to the log rather than the real console', () => {
    const result = author(`
      scene.describe({ name: 'Logs', description: 'Talks.', concept: 'x', objectives: ['y'] });
      console.log('building', 42);
      scene.mesh({ id: 'a', geometry: geom.box([1, 1, 1]), material: mat.metal({}) });
      scene.camera({ position: [2, 2, 2] });
    `);
    expect(result.ok).toBe(true);
    expect(result.logs.map((entry) => entry.message)).toContain('building 42');
  });
});
