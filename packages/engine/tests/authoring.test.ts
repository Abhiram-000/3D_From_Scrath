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
import { execFile } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { prepareProgram, describeViolations, createGuard } from '@edu3d/sandbox';
import {
  BodyKind,
  EnvironmentDecl,
  InteractionDecl,
  InteractionKind,
  LightKind,
  ModelManifest,
  MotionKind,
  ParameterChannel,
  QuizQuestion,
  ShotEasing,
  ShotKind,
} from '@edu3d/contracts';
import { apiSurfaceSet, describeApiSurface } from '../src/authoring/api-surface.ts';
import { API_REFERENCE } from '../src/authoring/api-reference.ts';
import { authorModel, runFrame } from '../src/authoring/guest.ts';
import { applyMotions, type PartTransformLike } from '../src/runtime/motions.ts';
import { MINIMAL_MODEL_SOURCE, REFERENCE_MODEL_SOURCE } from '../src/reference/turbofan.ts';

/** Run a program the way the server does: extract, gate, instrument. */
const prepare = (source: string) => prepareProgram(source, { apiSurface: apiSurfaceSet() });

const execFileAsync = promisify(execFile);

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
    // Namespace headers group the authored reference; the per-member rendering itself (signature,
    // summary, example per member) is pinned by api-reference.test.ts.
    expect(describeApiSurface()).toMatch(/^geom:$/m);
    expect(describeApiSurface()).toMatch(/^scene:$/m);
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

    // `cutaway` must show a *visibility* write, not the coincidental material/transform writes any
    // frame callback produces — the channel its own declaration promises (affects: visibility).
    const cutawayWrites = result.builder.observedWrites.get('cutaway');
    expect(
      [...(cutawayWrites ?? [])],
      'cutaway must write the visibility channel it declares',
    ).toContain('visibility');
  });

  it('sweeps cutaway into a genuine visibility change, not a warning', () => {
    // The dead-control fix from the audit-honesty pass: the declaration always promised
    // `affects: [{ channel: 'visibility' }]`, but the handler only called scene.warn. Sweeping
    // both values must now leave observable visibility differences between the two nacelle halves.
    const result = author(REFERENCE_MODEL_SOURCE);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const nacelle = () => result.manifest.parts.find((part) => part.id === 'nacelle');
    const nacelleFull = () => result.manifest.parts.find((part) => part.id === 'nacelleFull');

    result.builder.sweepParameter('cutaway', true);
    const cutOpenVisible = nacelle()?.visible;
    const cutOpenFull = nacelleFull()?.visible;

    result.builder.sweepParameter('cutaway', false);
    const closedVisible = nacelle()?.visible;
    const closedFull = nacelleFull()?.visible;

    // true → the cutaway half shows and the closed half hides; false → swapped.
    expect(cutOpenVisible).toBe(true);
    expect(cutOpenFull).toBe(false);
    expect(closedVisible).toBe(false);
    expect(closedFull).toBe(true);
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

  it('rejects the follow and sequence motion kinds, naming the six it can declare', () => {
    // MotionDecl carries no targetPartId and no states list, so these two enum members are
    // unimplementable from the declaration schema. Accepting them silently produced a no-op
    // motion — the exact bug class this phase removes — so the declaration site must refuse
    // them as loudly as it refuses a part id that does not exist.
    for (const kind of ['follow', 'sequence']) {
      const result = author(`
        scene.describe({ name: 'Bad kind', description: 'Unimplementable.', concept: 'x', objectives: ['y'] });
        scene.mesh({ id: 'a', geometry: geom.box([1, 1, 1]), material: mat.metal({}) });
        scene.motion({ id: 'm', partId: 'a', kind: '${kind}', reason: 'should not get this far' });
      `);
      expect(result.ok, kind).toBe(false);
      if (result.ok) return;
      // The message must name the offending kind and list every supported one, so the fix is
      // a rewrite of the declaration, not a hunt through docs.
      expect(result.message).toMatch(new RegExp(`'${kind}'`));
      expect(result.message).toMatch(/spin/);
      expect(result.message).toMatch(/oscillate/);
      expect(result.message).toMatch(/orbit/);
      expect(result.message).toMatch(/translate/);
      expect(result.message).toMatch(/pulse/);
      expect(result.message).toMatch(/flowAlongPath/);
    }
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

/**
 * The shot vocabulary is a documented capability: the prompt's API reference table shows a
 * call, the model copies it, and the manifest schema validates the result. When the table and
 * the schema disagree, following the documentation is a guaranteed generation failure — the
 * repair pass re-sends the same table, so the bad call survives every repair budget and dies
 * as `generation_unrepairable: camera.shots.<id>.kind: Invalid option` after minutes of paid
 * generation. These tests weld the three surfaces together: authoring validation (fail the
 * build, cheaply, naming the legal kinds), the manifest schema, and the prompt table itself.
 */
describe('the cinematic shot vocabulary', () => {
  const PROGRAM_WITH_SHOT = (shotCall: string) => `
    scene.describe({ name: 'Shot', description: 'Camera vocabulary.', concept: 'x', objectives: ['y'] });
    scene.mesh({ id: 'a', geometry: geom.box([1, 1, 1]), material: mat.metal({}) });
    ${shotCall}
  `;

  it('builds the scene.shot example exactly as the prompt table documents it, and the manifest still validates', () => {
    // The literal call documented at API_REFERENCE['scene.shot'] — the pattern a generated
    // program is told to copy. Following it used to survive authoring, then die as
    // `camera.shots.<id>.kind: Invalid option` at manifest validation, 199 s into a real
    // generation. The documented example must produce a manifest the schema accepts.
    const example = API_REFERENCE['scene.shot']?.example ?? '';
    expect(example, 'the table must carry a scene.shot example').toMatch(/scene\.shot\(/);
    const result = author(PROGRAM_WITH_SHOT(example));
    expect(result.ok, result.ok ? '' : result.message).toBe(true);
    if (!result.ok) return;

    expect(Object.keys(result.manifest.camera.shots)).toHaveLength(1);
    const parsed = ModelManifest.safeParse(result.manifest);
    expect(
      parsed.success === true,
      JSON.stringify(parsed.success === true ? [] : parsed.error.issues),
    ).toBe(true);
  });

  it('a legal shot of every documented kind builds and its manifest validates', () => {
    const result = author(
      `${PROGRAM_WITH_SHOT(
        [
          ...ShotKind.options.map(
            (kind) =>
              `scene.shot('shot_${kind.replace(/([A-Z])/g, '_$1').toLowerCase()}', { kind: '${kind}' });`,
          ),
          'scene.shot("direct_dolly", { kind: \'dolly\', distance: -0.4, duration: 2 });',
          'scene.shot("direct_orbit", { kind: \'orbit\', sweep: 1.5, duration: 4 });',
        ].join('\n'),
      )}`,
    );
    expect(result.ok, result.ok ? '' : result.message).toBe(true);
    if (!result.ok) return;

    const kinds = Object.values(result.manifest.camera.shots).map((shot) => shot.kind);
    expect(new Set(kinds)).toEqual(new Set(ShotKind.options));
    const parsed = ModelManifest.safeParse(result.manifest);
    expect(parsed.success, JSON.stringify(parsed.success === true ? [] : parsed.error.issues)).toBe(
      true,
    );
  });

  it('refuses an invented shot kind at authoring, naming every legal kind', () => {
    // The generation failure reproduced at its source: a kind that survives the builder and is
    // only rejected at manifest validation costs a paid generation to discover. The build must
    // fail here, now, with the alternatives spelled out.
    for (const invented of ['closeUp', 'sweep']) {
      const result = author(PROGRAM_WITH_SHOT(`scene.shot('inside', { kind: '${invented}' });`));
      expect(result.ok, `${invented} must fail at authoring`).toBe(false);
      if (result.ok) return;
      expect(result.message).toMatch(new RegExp(`'${invented}'`));
      for (const legal of ShotKind.options) expect(result.message).toMatch(legal);
    }
  });

  it('refuses an invented story-beat shot kind at authoring, naming every legal kind', () => {
    // The story path is where the failing `camera.shots.bobClose` shot came from: beats and
    // named shots share the ShotDecl schema, so an invented kind must fail equally loudly
    // whichever way it arrives.
    const result = author(
      PROGRAM_WITH_SHOT(
        `scene.story([{ id: 'b1', title: 'The swing', narration: 'One idea per beat, as the schema requires.', shots: [{ kind: 'closeUp', targetPartId: 'a' }] }]);`,
      ),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toMatch(/'closeUp'/);
    for (const legal of ShotKind.options) expect(result.message).toMatch(legal);
  });

  it('accepts a story-beat shot of a legal kind', () => {
    const result = author(
      PROGRAM_WITH_SHOT(
        `scene.story([{ id: 'b1', title: 'The swing', narration: 'One idea per beat, as the schema requires.', shots: [{ kind: 'flyTo', targetPartId: 'a', duration: 2 }] }]);`,
      ),
    );
    expect(result.ok, result.ok ? '' : result.message).toBe(true);
    if (!result.ok) return;
    expect(result.manifest.story[0]?.shots[0]?.kind).toBe('flyTo');
  });

  it('refuses an interaction whose shot kind is invented, and whose kind is undocumented', () => {
    const badShot = author(
      PROGRAM_WITH_SHOT(
        `scene.interaction({ partId: 'a', kind: 'playShot', shot: { kind: 'closeUp', targetPartId: 'a' } });`,
      ),
    );
    expect(badShot.ok).toBe(false);
    if (!badShot.ok) expect(badShot.message).toMatch(/'closeUp'/);

    // 'toggle' was the documented kind; the schema (and every consumer) spells it 'toggleVisibility'.
    const badKind = author(
      PROGRAM_WITH_SHOT(`scene.interaction({ partId: 'a', kind: 'toggle', targetId: 'a' });`),
    );
    expect(badKind.ok).toBe(false);
    if (!badKind.ok) {
      expect(badKind.message).toMatch(/'toggle'/);
      for (const legal of InteractionKind.options) expect(badKind.message).toMatch(legal);
    }
  });

  it('rejects an invented easing at authoring, naming the documented curves', () => {
    const result = author(
      PROGRAM_WITH_SHOT(`scene.shot('inside', { kind: 'flyTo', easing: 'snappy' });`),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toMatch(/'snappy'/);
      for (const legal of ShotEasing.options) expect(result.message).toMatch(legal);
    }
  });
});

/**
 * The scalar-source and enum boundaries.
 *
 * The live generation that motivated these: `scene.motion({ id, partId, kind: 'spin', rate: 2 })`
 * — a bare number where the contract wants a `ScalarSource` — survived authoring, the static gate,
 * both repair passes and the whole audit, and died only as the terminal learner-facing
 * `motions.rate: Invalid input`, after ~55 minutes and several paid provider calls. Nothing refused
 * it at the boundary, so there was no cheap, actionable failure to repair from. Each test below
 * pins one such hole shut: authoring must refuse it, name every legal alternative, and — where the
 * intent is unambiguous, as with a bare number — coerce it instead.
 */
describe('scalar sources and enum fields are validated at the authoring boundary', () => {
  const PROGRAM = (declaration: string) => `
    scene.describe({ name: 'Boundary', description: 'Boundary checks.', concept: 'x', objectives: ['y'] });
    scene.param({ id: 'rpm', label: 'Speed', kind: 'number', min: 0, max: 10, default: 2 });
    scene.mesh({ id: 'a', geometry: geom.box([1, 1, 1]), material: mat.metal({}) });
    ${declaration}
  `;

  it('coerces a bare number rate to a constant scalar source', () => {
    const result = author(
      PROGRAM(`scene.motion({ id: 'm', partId: 'a', kind: 'spin', rate: 2, reason: 'Because.' });`),
    );
    expect(result.ok, result.ok ? '' : result.message).toBe(true);
    if (!result.ok) return;
    // A bare number is what the AI actually writes and what `{ const }` means: lossless, so it is
    // normalised rather than refused.
    expect(result.manifest.motions[0]?.rate).toEqual({ const: 2 });
  });

  it('accepts a parameter-bound rate unchanged', () => {
    const result = author(
      PROGRAM(
        `scene.motion({ id: 'm', partId: 'a', kind: 'spin', rate: { param: 'rpm', scale: 0.5 }, reason: 'Because.' });`,
      ),
    );
    expect(result.ok, result.ok ? '' : result.message).toBe(true);
    if (!result.ok) return;
    expect(result.manifest.motions[0]?.rate).toMatchObject({ param: 'rpm', scale: 0.5 });
  });

  it('refuses a bare id string rate and names the { param } form', () => {
    const result = author(
      PROGRAM(
        `scene.motion({ id: 'm', partId: 'a', kind: 'spin', rate: 'rpm', reason: 'Because.' });`,
      ),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toMatch(/rate/);
    // The message must name the two likely intents, with the author's own id echoed back.
    expect(result.message).toMatch(/\{ param: 'rpm' \}/);
    expect(result.message).toMatch(/\{ const/);
  });

  it('refuses a parameter reference that was never declared', () => {
    const result = author(
      PROGRAM(
        `scene.motion({ id: 'm', partId: 'a', kind: 'spin', rate: { param: 'absent' }, reason: 'Because.' });`,
      ),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toMatch(/parameter 'absent'/);
  });

  it('refuses a probe that names no declared physics probe', () => {
    const result = author(
      PROGRAM(
        `scene.motion({ id: 'm', partId: 'a', kind: 'oscillate', amplitude: { probe: 'ghost' }, reason: 'Because.' });`,
      ),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toMatch(/probe 'ghost'/);
  });

  it('accepts a probe declared in scene.physics', () => {
    const result = author(
      PROGRAM(
        `scene.physics({ bodies: [{ id: 'a', partId: 'a' }], probes: [{ id: 'speedProbe', bodyId: 'a', quantity: 'speed', label: 'Speed' }] });
         scene.motion({ id: 'm', partId: 'a', kind: 'oscillate', amplitude: { probe: 'speedProbe' }, reason: 'Because.' });`,
      ),
    );
    expect(result.ok, result.ok ? '' : result.message).toBe(true);
    if (!result.ok) return;
    expect(result.manifest.motions[0]?.amplitude).toMatchObject({ probe: 'speedProbe' });
  });

  it('applies the schema defaults to a physics declaration', () => {
    // The structural validator must reproduce what a zod round-trip produced: a bare body still
    // carries the world gravity, an inferred collider and the named-material/damping defaults.
    const result = author(PROGRAM(`scene.physics({ bodies: [{ id: 'b', partId: 'a' }] });`));
    expect(result.ok, result.ok ? '' : result.message).toBe(true);
    if (!result.ok) return;
    const physics = result.manifest.physics;
    expect(physics?.world.gravity).toEqual([0, -9.81, 0]);
    expect(physics?.world.stepHz).toBe(120);
    expect(physics?.bodies[0]?.kind).toBe('dynamic');
    expect(physics?.bodies[0]?.material.name).toBe('custom');
    expect(physics?.bodies[0]?.collider.shape).toBe('auto');
    expect(physics?.bodies[0]?.collider.sensor).toBe(false);
    expect(physics?.bodies[0]?.ccd).toBe(false);
    expect(physics?.bodies[0]?.canSleep).toBe(true);
    expect(physics?.bodies[0]?.gravityScale).toBe(1);
    expect(physics?.joints).toEqual([]);
    expect(physics?.probes).toEqual([]);
    // And the normalised declaration must satisfy the contract's own schema, or the audit — which
    // does parse the manifest — would reject what authoring accepted.
    const parsed = ModelManifest.safeParse(result.manifest);
    expect(parsed.success, JSON.stringify(parsed.success ? [] : parsed.error.issues)).toBe(true);
  });

  it('refuses a physics body bound to an undeclared part', () => {
    const result = author(PROGRAM(`scene.physics({ bodies: [{ id: 'b', partId: 'ghost' }] });`));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toMatch(/body 'b' targets part 'ghost'/);
  });

  it('refuses a joint or probe naming an undeclared body', () => {
    const joint = author(
      PROGRAM(
        `scene.physics({ bodies: [{ id: 'b', partId: 'a' }], joints: [{ id: 'j', kind: 'revolute', bodyA: 'ghost' }] });`,
      ),
    );
    expect(joint.ok).toBe(false);
    if (!joint.ok) expect(joint.message).toMatch(/bodyA 'ghost'/);

    const probe = author(
      PROGRAM(
        `scene.physics({ bodies: [{ id: 'b', partId: 'a' }], probes: [{ id: 'p', bodyId: 'ghost', quantity: 'speed', label: 'Speed' }] });`,
      ),
    );
    expect(probe.ok).toBe(false);
    if (!probe.ok) expect(probe.message).toMatch(/probe 'p' names body 'ghost'/);
  });

  it('refuses a motor bound to an undeclared parameter', () => {
    const result = author(
      PROGRAM(
        `scene.physics({ bodies: [{ id: 'b', partId: 'a' }], joints: [{ id: 'j', kind: 'revolute', bodyA: 'b', motor: { targetVelocity: 1, boundToParameter: 'absent' } }] });`,
      ),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toMatch(/bound to parameter 'absent'/);
  });

  it('refuses an unknown physics enum value, naming the legal ones', () => {
    // 'static' is what the api reference shows; the schema spells the fixed body kind 'fixed', which
    // is exactly the documentation/schema drift this boundary is meant to catch cheaply.
    const kind = author(
      PROGRAM(`scene.physics({ bodies: [{ id: 'b', partId: 'a', kind: 'static' }] });`),
    );
    expect(kind.ok).toBe(false);
    if (!kind.ok) {
      expect(kind.message).toMatch(/'static'/);
      for (const legal of BodyKind.options) expect(kind.message).toContain(legal);
    }

    const quantity = author(
      PROGRAM(
        `scene.physics({ bodies: [{ id: 'b', partId: 'a' }], probes: [{ id: 'p', bodyId: 'b', quantity: 'temperature', label: 'T' }] });`,
      ),
    );
    expect(quantity.ok).toBe(false);
    if (!quantity.ok) expect(quantity.message).toMatch(/'temperature'/);
  });

  it('refuses a motion pathId that names no declared path', () => {
    const result = author(
      PROGRAM(
        `scene.motion({ id: 'm', partId: 'a', kind: 'flowAlongPath', pathId: 'ghost', rate: 1, reason: 'Because.' });`,
      ),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toMatch(/path 'ghost'/);
  });

  it('accepts an interaction shot that omits kind, defaulting it as the signature documents', () => {
    // The documented interaction shot has `kind?` optional, and assertShotShape has always defaulted
    // it to 'flyTo'; the boundary parse must preserve that, not turn documented input into an error.
    const result = author(
      PROGRAM(`scene.interaction({ partId: 'a', kind: 'playShot', shot: { targetPartId: 'a' } });`),
    );
    expect(result.ok, result.ok ? '' : result.message).toBe(true);
    if (!result.ok) return;
    expect(result.manifest.interactions[0]?.shot?.kind).toBe('flyTo');
  });

  /** Each case pairs an authored value the schema rejects with the enum the message must recite. */
  const ENUM_CASES: Array<{
    field: string;
    value: string;
    declaration: string;
    legal: readonly string[];
  }> = [
    {
      field: 'light kind',
      value: 'glow',
      declaration: `scene.light({ id: 'l', kind: 'glow' });`,
      legal: LightKind.options,
    },
    {
      field: 'environment preset',
      value: 'neon',
      declaration: `scene.environment({ preset: 'neon' });`,
      legal: EnvironmentDecl.shape.preset.unwrap().options,
    },
    {
      field: 'quiz difficulty',
      value: 'trivia',
      declaration: `scene.quiz([{ id: 'q2', question: 'Why this?', options: ['a', 'b'], correctIndex: 0, explanation: 'a is right, and b is the tempting wrong one.', difficulty: 'trivia' }]);`,
      legal: QuizQuestion.shape.difficulty.unwrap().options,
    },
    {
      field: 'interaction trigger',
      value: 'scroll',
      declaration: `scene.interaction({ partId: 'a', kind: 'select', on: 'scroll' });`,
      legal: InteractionDecl.shape.on.options,
    },
    {
      field: 'parameter channel',
      value: 'colour',
      declaration: `scene.param({ id: 'p2', label: 'P2', kind: 'number', min: 0, max: 1, default: 0, affects: [{ channel: 'colour' }] });`,
      legal: ParameterChannel.options,
    },
    {
      field: 'motion kind',
      value: 'wobble',
      declaration: `scene.motion({ id: 'm2', partId: 'a', kind: 'wobble', reason: 'Because.' });`,
      legal: MotionKind.options.filter((kind) => kind !== 'follow' && kind !== 'sequence'),
    },
  ];

  for (const testCase of ENUM_CASES) {
    it(`refuses a bad ${testCase.field} and names every legal value`, () => {
      const result = author(PROGRAM(testCase.declaration));
      expect(result.ok, `${testCase.field} must fail at authoring`).toBe(false);
      if (result.ok) return;
      expect(result.message).toMatch(new RegExp(`'${testCase.value}'`));
      for (const legal of testCase.legal) expect(result.message).toContain(legal);
    });
  }

  it('still authors both reference models with the tightened boundary', () => {
    // The tightening must not make previously-legal authored input illegal: the reference turbofan
    // (parameter-bound motion, story setParameters, x-ray view mode, three quiz difficulties) and
    // the minimal pendulum must both build exactly as before.
    for (const source of [MINIMAL_MODEL_SOURCE, REFERENCE_MODEL_SOURCE]) {
      const result = author(source);
      expect(result.ok, result.ok ? '' : result.message).toBe(true);
    }
  });
});

/**
 * Model-authored, 3D-anchored labels.
 *
 * The capability `01` requires in place: a part that names itself beside the thing it names, so the
 * learner reads the word without opening a panel. These tests pin the two halves that must hold at
 * the authoring boundary — a valid label reaches the manifest, and an unknown `partId` is refused
 * where the generator can still fix it (exactly as `motion` refuses a dangling part).
 */
describe('model-authored labels', () => {
  const PROGRAM = (declaration: string) => `
    scene.describe({ name: 'Labelled', description: 'Names on the model.', concept: 'labels', objectives: ['read a name'] });
    scene.mesh({ id: 'axle', geometry: geom.cylinder({ radius: 0.02, height: 0.3 }), material: mat.metal({}) });
    ${declaration}
  `;

  it('records a label and emits it into the manifest', () => {
    const result = author(PROGRAM(`scene.label({ id: 'lblAxle', partId: 'axle', text: 'Axle' });`));
    expect(result.ok, result.ok ? '' : result.message).toBe(true);
    if (!result.ok) return;
    expect(result.manifest.labels).toHaveLength(1);
    expect(result.manifest.labels[0]).toEqual({ id: 'lblAxle', partId: 'axle', text: 'Axle' });
  });

  it('carries an optional offset through to the manifest', () => {
    const result = author(
      PROGRAM(
        `scene.label({ id: 'lblAxle', partId: 'axle', text: 'Axle', offset: [0, 0.08, 0] });`,
      ),
    );
    expect(result.ok, result.ok ? '' : result.message).toBe(true);
    if (!result.ok) return;
    expect(result.manifest.labels[0]?.offset).toEqual([0, 0.08, 0]);
  });

  it('refuses a label naming a part that does not exist, as loudly as a dangling motion', () => {
    const result = author(
      PROGRAM(`scene.label({ id: 'lblX', partId: 'nowhere', text: 'Ghost' });`),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toMatch(/label 'lblX'/);
    expect(result.message).toMatch(/nowhere/);
    expect(result.message).toMatch(/does not exist/);
  });

  it('refuses a duplicate label id', () => {
    const result = author(
      PROGRAM(`
        scene.label({ id: 'lblA', partId: 'axle', text: 'Axle' });
        scene.label({ id: 'lblA', partId: 'axle', text: 'Shaft' });
      `),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toMatch(/already used/);
  });

  it('truncates over-long label text and records a warning rather than failing the build', () => {
    const long = 'x'.repeat(80);
    const result = author(PROGRAM(`scene.label({ id: 'lblA', partId: 'axle', text: '${long}' });`));
    expect(result.ok, result.ok ? '' : result.message).toBe(true);
    if (!result.ok) return;
    expect(result.manifest.labels[0]?.text).toHaveLength(64);
    expect(result.manifest.warnings.join(' ')).toMatch(/truncated/);
  });
});

/**
 * The hardened guest realm.
 *
 * The browser guest runs in a realm where `@edu3d/sandbox` has replaced `Function` with a thrower and
 * frozen the intrinsics (layers 3–4 of the sandbox). zod's parse path touches `Function`, so any
 * runtime schema call inside `scene.ts` throws `Function is not available inside the model sandbox`
 * there — even though the identical call passes under `node:vm`, whose realm is not poisoned. A
 * `.safeParse` added to `scene.ts` once broke the whole browser authoring path this way; these tests
 * pin that the boundary validation is structural, and that its refusals still fire, with `Function`
 * poisoned. Spawned in a child process because `harden: true` poisons the real `globalThis`, which
 * would break every later test in this file — the same harness `host-admission.test.ts` uses.
 */
describe('the authoring boundary under the hardened guest realm', () => {
  const paths = {
    guest: fileURLToPath(new URL('../src/authoring/guest.ts', import.meta.url)),
    apiSurface: fileURLToPath(new URL('../src/authoring/api-surface.ts', import.meta.url)),
    sandbox: fileURLToPath(new URL('../../sandbox/src/index.ts', import.meta.url)),
  };

  const authorInHardenedRealm = async (
    source: string,
  ): Promise<{ ok: boolean; message: string; gateOk: boolean }> => {
    const script = [
      'const sandbox = await import(process.env.EDU3D_SANDBOX_PATH);',
      'const guest = await import(process.env.EDU3D_GUEST_PATH);',
      'const api = await import(process.env.EDU3D_API_PATH);',
      'const prepared = sandbox.prepareProgram(process.env.EDU3D_SOURCE, { apiSurface: api.apiSurfaceSet() });',
      'const verdict = { gateOk: prepared.ok, ok: false, message: "" };',
      'if (prepared.ok) {',
      '  const result = guest.authorModel({ code: prepared.instrumented, tier: "mid", seed: 5, harden: true });',
      '  verdict.ok = result.ok;',
      '  verdict.message = result.ok ? "" : result.message;',
      '}',
      "console.log('PROBE:' + JSON.stringify(verdict));",
    ].join('\n');
    const target = await mkdtemp(join(tmpdir(), 'edu3d-realm-probe-'));
    const file = join(target, 'probe.mjs');
    await writeFile(file, script);
    const run = await execFileAsync(process.execPath, ['--experimental-strip-types', file], {
      env: {
        ...process.env,
        EDU3D_SANDBOX_PATH: pathToFileURL(paths.sandbox).href,
        EDU3D_GUEST_PATH: pathToFileURL(paths.guest).href,
        EDU3D_API_PATH: pathToFileURL(paths.apiSurface).href,
        EDU3D_SOURCE: source,
      },
      timeout: 30_000,
    });
    const line = run.stdout.split('\n').find((entry) => entry.startsWith('PROBE:'));
    if (!line) throw new Error(`probe produced no verdict: ${run.stdout} ${run.stderr}`);
    return JSON.parse(line.slice('PROBE:'.length)) as {
      ok: boolean;
      message: string;
      gateOk: boolean;
    };
  };

  it('authors the reference model with Function poisoned', async () => {
    // The built-in reference model is the live trigger: it exercises the scalar-source, enum and
    // story-value boundaries, so a single runtime schema call anywhere in them fails this test.
    const verdict = await authorInHardenedRealm(REFERENCE_MODEL_SOURCE);
    expect(verdict.gateOk).toBe(true);
    expect(verdict.ok, verdict.message).toBe(true);
  }, 40_000);

  it('still fires the scalar-source refusal inside the hardened realm', async () => {
    const verdict = await authorInHardenedRealm(`
      scene.describe({ name: 'Refusal', description: 'A bare id string where a scalar source belongs.', concept: 'scalar sources', objectives: ['name the legal forms'] });
      scene.param({ id: 'rpm', label: 'Speed', kind: 'number', min: 0, max: 10, default: 2 });
      scene.mesh({ id: 'a', geometry: geom.box([1, 1, 1]), material: mat.metal({}) });
      scene.camera({ position: [2, 2, 2] });
      scene.motion({ id: 'm', partId: 'a', kind: 'spin', rate: 'rpm', reason: 'Because.' });
    `);
    expect(verdict.gateOk).toBe(true);
    expect(verdict.ok).toBe(false);
    // The refusal itself must be reachable with Function poisoned, not swallowed by the realm.
    expect(verdict.message).toMatch(/\{ param: 'rpm' \}/);
  }, 40_000);

  /**
   * The physics path is the one this realm test was added for: `scene.physics` used to call
   * `PhysicsDeclSchema.safeParse` at runtime, so every physics-declaring model failed to load in the
   * browser with `TypeError: Function is not available inside the model sandbox` while passing in
   * `node:vm`. The generation prompt now asks for `scene.physics` when the learner should perturb the
   * motion, so this is the path that had to keep working.
   */
  it('authors a physics-declaring model with Function poisoned', async () => {
    const verdict = await authorInHardenedRealm(`
      scene.describe({ name: 'Pendulum', description: 'A simulated pendulum.', concept: 'physics', objectives: ['predict the swing'] });
      scene.param({ id: 'rpm', label: 'Rotor speed', kind: 'number', min: 0, max: 300, default: 60 });
      scene.mesh({ id: 'bob', geometry: geom.sphere({ radius: 0.2 }), material: mat.metal({}), position: [0, 2, 0] });
      scene.camera({ position: [4, 2, 6], target: [0, 1, 0] });
      scene.physics({
        world: { gravity: [0, -9.81, 0] },
        bodies: [{ id: 'bobBody', partId: 'bob', kind: 'dynamic', material: { name: 'steel' } }],
        joints: [{ id: 'arm', kind: 'revolute', bodyA: 'bobBody', bodyB: null, axis: [0, 0, 1] }],
        probes: [{ id: 'bobSpeed', bodyId: 'bobBody', quantity: 'speed', label: 'Bob speed' }],
      });
    `);
    expect(verdict.gateOk).toBe(true);
    expect(verdict.ok, verdict.message).toBe(true);
  }, 40_000);

  it('still fires the physics cross-reference refusal inside the hardened realm', async () => {
    const verdict = await authorInHardenedRealm(`
      scene.describe({ name: 'Dangling', description: 'A joint naming no body.', concept: 'physics', objectives: ['o'] });
      scene.mesh({ id: 'bob', geometry: geom.sphere({ radius: 0.2 }), material: mat.metal({}), position: [0, 2, 0] });
      scene.camera({ position: [4, 2, 6], target: [0, 1, 0] });
      scene.physics({
        bodies: [{ id: 'bobBody', partId: 'bob' }],
        joints: [{ id: 'arm', kind: 'revolute', bodyA: 'ghostBody', bodyB: null }],
      });
    `);
    expect(verdict.gateOk).toBe(true);
    expect(verdict.ok).toBe(false);
    expect(verdict.message).toMatch(/bodyA 'ghostBody'/);
  }, 40_000);
});
