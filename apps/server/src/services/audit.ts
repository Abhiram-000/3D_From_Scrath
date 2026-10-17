/**
 * The audit: headless dry run, measurable scoring, enumerated deficiencies.
 *
 * `01` requires that "'good' must be machine-checkable to drive refinement", and the mechanism is the
 * one this platform is uniquely positioned for: the server *runs the AI's actual code* in `node:vm`
 * (`authorInNodeVm`) and measures what it does. A parameter that changes nothing is observed, not
 * guessed — by differencing quantised model state between sweep points, because write presence
 * alone is coincidental evidence (a frame callback writes every frame regardless of parameter
 * values); liveliness is counted frames, not a vibe. Every dimension score below is computed from
 * a proxy the dry run can measure, per `01`'s "scored by proxy signals the audit can measure".
 *
 * Deficiencies are written *for the generator that will fix them* — imperative and specific — because
 * `04` sends them straight back as the refinement prompt and "a finding without an actionable
 * instruction is a complaint".
 */
import {
  AUDIT_WEIGHTS,
  DEVICE_BUDGETS,
  type AuditReport,
  type Deficiency,
  type DeviceTier,
  type DimensionScore,
  type ModelManifest,
} from '@edu3d/contracts';
// Direct subpath: the Node host imports `node:vm` and must stay out of any browser-reachable barrel.
import { authorInNodeVm } from '@edu3d/engine/node-host';

/** Sweep samples per parameter: min, quarter, default, three-quarters, max. Enough to catch a dead binding. */
const SWEEP_FRACTIONS = [0, 0.25, 0.5, 0.75, 1] as const;

/**
 * Builders that carry no authored profile — raw primitives. A mechanism part assembled from these
 * is the "static-shape lookalike" `01:45-50` rejects; every other builder (gear, gearProfile,
 * helix, sweep, revolve, extrude, pipe, sdf, mesh, parametric…) represents a deliberate shape
 * choice and is none of the audit's business.
 */
const RAW_PRIMITIVE_BUILDERS = new Set([
  'box',
  'sphere',
  'cylinder',
  'cone',
  'torus',
  'disc',
  'plane',
  'capsule',
]);

/**
 * Part-name vocabulary that claims a gear; `cog` is the same word. `01:45-50` names gears
 * specifically — "trapezoid teeth… visibly slip and jerk the moment the gear train turns" — and
 * the instruction this check emits is gear-specific. Wheels, pulleys and cams are deliberately
 * absent: the spec demands nothing of them, a wheel honestly *is* a cylinder, and flagging one
 * sent a gear instruction down the paid refinement path on an honest model. All three signals
 * must still agree before the audit speaks — the name claims the mechanism, a motion targeting
 * the part proves it performs it, and `geometry.builder` (the manifest's per-part provenance)
 * says whether the representation can deliver it. A name alone is not evidence: false
 * refinement instructions burn real API money.
 */
const GEAR_VOCABULARY = /gear|cog/i;

/** Spring vocabulary, paired with compress-like motion kinds (oscillate/translate/pulse). */
const SPRING_VOCABULARY = /spring|coil/i;

/**
 * Sample times for the differential sweep, in seconds. Time 0 alone is blind to bindings that
 * modulate time — `sin(t · frequency)` is 0 at t = 0 for *every* frequency — so each value is
 * also sampled at 1 s. Only states sampled at the same time are ever compared, so a time-driven
 * write (a flicker) can never read as parameter causality.
 */
const SWEEP_TIMES = [0, 1] as const;

/**
 * The values each parameter kind is swept across.
 *
 * Numbers get the fraction ladder plus the default — a sin-driven binding can coincide at two
 * fractions, and six distinct samples make that negligible. Booleans, choices and colors are
 * enumerable kinds: sweep every value the widget can take (for colors, whose space is continuous,
 * the default plus two fixed probes).
 */
function sweepValuesFor(
  parameter: ModelManifest['parameters'][number],
): Array<number | boolean | string> {
  if (parameter.kind === 'number') {
    const span = parameter.max - parameter.min || 1;
    return [
      ...new Set([
        ...SWEEP_FRACTIONS.map((fraction) => parameter.min + span * fraction),
        parameter.default,
      ]),
    ];
  }
  if (parameter.kind === 'boolean') return [false, true];
  if (parameter.kind === 'choice') {
    return [...new Set([...parameter.options.map((option) => option.value), parameter.default])];
  }
  return [...new Set([parameter.default, '#ff0000', '#00ff00'])];
}

export interface AuditInput {
  /** Instrumented source, exactly what the browser will run. */
  code: string;
  tier: DeviceTier;
  seed: number;
}

export type AuditOutcome =
  | { ok: true; report: AuditReport; manifest: ModelManifest }
  | { ok: false; message: string; timedOut: boolean };

/**
 * Score one dimension from its measurable proxies, collecting evidence lines.
 *
 * Scores are deliberately transparent arithmetic (proportion × 100), because `01` requires that "a low
 * number is explainable in diagnostics" — a weighted black box is not.
 */
function score(
  dimension: DimensionScore['dimension'],
  fraction: number,
  evidence: readonly string[],
): DimensionScore {
  return {
    dimension,
    score: Math.round(Math.max(0, Math.min(1, fraction)) * 100),
    evidence: evidence.slice(0, 12),
  };
}

/**
 * Run the full audit over a prepared program.
 *
 * Never throws: a build failure is an audit outcome the pipeline turns into a repairable error, not an
 * exception that escapes the request.
 */
export function auditModel(input: AuditInput): AuditOutcome {
  const started = Date.now();
  const build = authorInNodeVm({ code: input.code, tier: input.tier, seed: input.seed });

  if (!build.ok) {
    return { ok: false, message: build.message, timedOut: build.timedOut };
  }

  const { manifest, builder } = build;
  const deficiencies: Deficiency[] = [];
  const dimensions: DimensionScore[] = [];

  // ── Parameter leverage: the differential sweep `00` makes provable ─────────
  //
  // `00:210`: "a control that changes nothing is rejected, not shipped." Write *presence* cannot
  // prove that — a frame callback writes every frame regardless of parameter values, so crediting
  // writes false-passes every model with an onFrame. Causality is proven by *value change*: the
  // quantised observable state must differ between sweep points taken at the same sample time.
  const leverageEvidence: string[] = [];
  let liveParameters = 0;

  // Declarative causality: a motion whose rate/amplitude binds `{ param: id }` executes that
  // binding every frame via the applicator, so the parameter is live by declaration — the audit
  // does not need to re-run the binding to know the slider is wired to motion.
  const motionBoundParams = new Set<string>();
  for (const motion of manifest.motions) {
    for (const source of [motion.rate, motion.amplitude]) {
      if (
        source &&
        typeof source === 'object' &&
        'param' in source &&
        typeof source.param === 'string'
      ) {
        motionBoundParams.add(source.param);
      }
    }
  }

  for (const parameter of manifest.parameters) {
    const values = sweepValuesFor(parameter);
    for (const time of SWEEP_TIMES) {
      for (const value of values) builder.sweepParameter(parameter.id, value, time);
    }
    const points = builder.sweepStates.get(parameter.id) ?? [];
    const changedInSlice = SWEEP_TIMES.some((time) => {
      const states = points.filter((point) => point.time === time).map((point) => point.state);
      return new Set(states).size > 1;
    });
    if (changedInSlice || motionBoundParams.has(parameter.id)) {
      liveParameters += 1;
      leverageEvidence.push(
        changedInSlice
          ? `'${parameter.id}': visible state changed across its sweep`
          : `'${parameter.id}': drives a declared motion's rate/amplitude`,
      );
    } else {
      deficiencies.push({
        dimension: 'parameterLeverage',
        severity: 'major',
        finding: `Parameter '${parameter.id}' changes nothing visible when swept across its whole range.`,
        instruction: `Bind '${parameter.id}' to real behavior: use it in an onFrame callback to drive motion, emissive intensity or color of the parts it claims to affect (ctx.params.${parameter.id}), or declare it as a motion's rate/amplitude (rate: { param: '${parameter.id}' }).`,
        subjectId: parameter.id,
      });
    }
  }
  // Hand back the model as it was built: the manifest this audit returns is the one that ships,
  // and it must not carry the last sweep point's parameter values and poses.
  builder.endParameterSweep();
  const parameterFraction =
    manifest.parameters.length === 0 ? 0 : liveParameters / manifest.parameters.length;
  dimensions.push(
    score('parameterLeverage', parameterFraction === 0 ? 0.2 : parameterFraction, leverageEvidence),
  );

  // ── Liveliness: frames actually wrote to parts ────────────────────────────
  const touched = builder.touchedParts();
  const movableParts = manifest.parts.filter((part) => part.kind !== 'group').length;
  const touchedFraction =
    movableParts === 0 ? 0 : Math.min(1, touched.size / Math.min(12, movableParts));
  dimensions.push(
    score('liveliness', touchedFraction, [
      `${touched.size} parts received frame writes`,
      `${manifest.motions.length} declared motions`,
    ]),
  );
  if (touched.size === 0 && manifest.motions.length === 0) {
    deficiencies.push({
      dimension: 'liveliness',
      severity: 'major',
      finding: 'No part moves: no declared motions and no frame callback wrote to any part.',
      instruction:
        'The default state of a model is motion. Add scene.motion(...) for continuous motion and/or an onFrame callback that drives the mechanism — rates bound to the parameters you declared.',
    });
  }

  // ── Information: named parts with info text ───────────────────────────────
  const informational = manifest.parts.filter((part) => part.info && part.kind !== 'group');
  const infoFraction = movableParts === 0 ? 0 : informational.length / movableParts;
  dimensions.push(
    score('information', infoFraction, [
      `${informational.length}/${movableParts} parts carry info text`,
    ]),
  );
  if (infoFraction < 0.5) {
    deficiencies.push({
      dimension: 'information',
      severity: 'major',
      finding: `Only ${informational.length} of ${movableParts} parts have info text.`,
      instruction:
        'Every selectable part needs info: { title, summary, bullets }. A part the learner can select but that says nothing is a wasted click.',
    });
  }

  // ── Completeness: structure exists, no orphan single-child chains ──────────
  const completenessEvidence: string[] = [
    `root parts: ${manifest.parts.filter((p) => p.parentId === null).length}`,
  ];
  const hasHero = manifest.parts.some((part) => part.hero);
  if (hasHero) completenessEvidence.push('hero part declared');
  const completeness =
    0.4 +
    (hasHero ? 0.2 : 0) +
    Math.min(0.2, manifest.parts.length / 150) +
    (manifest.parameters.length > 0 ? 0.1 : 0) +
    (manifest.motions.length > 0 ? 0.1 : 0);
  dimensions.push(score('completeness', completeness, completenessEvidence));
  if (!hasHero) {
    deficiencies.push({
      dimension: 'cleanliness',
      severity: 'minor',
      finding: 'No hero part is declared, so the model has no declared focal hierarchy.',
      instruction:
        'Mark the two or three parts the lesson is about with hero: true so detail survives quality adaptation and the eye lands deliberately.',
    });
  }

  // ── Representation fidelity: motion-correct builders ──────────────────────
  const buildersUsed = new Set(manifest.parts.map((part) => part.geometry?.builder));
  const fidelityEvidence: string[] = [];
  let fidelity = 0.7;
  // The canonical defect from `01`: boxy gears, stacked-cylinder springs, static flow dots.
  const gearParts = manifest.parts.filter(
    (part) => part.geometry?.builder === 'gear' || part.geometry?.builder === 'gearProfile',
  );
  if (gearParts.length > 0) fidelityEvidence.push(`${gearParts.length} involute gear parts`);
  const helixParts = manifest.parts.filter((part) => part.geometry?.builder === 'helix');
  if (helixParts.length > 0) fidelityEvidence.push(`${helixParts.length} true helical parts`);
  if (gearParts.length > 0) fidelity += 0.1;
  if (helixParts.length > 0) fidelity += 0.1;
  if (buildersUsed.has('sdf')) {
    fidelity += 0.1;
    fidelityEvidence.push('organic forms via SDF blending');
  }
  const primitiveOnly =
    manifest.parts.length > 8 &&
    [...buildersUsed].every((builder) =>
      ['box', 'sphere', 'cylinder', 'cone', 'torus', 'disc', 'plane', 'capsule'].includes(
        builder ?? '',
      ),
    );
  if (primitiveOnly) {
    fidelity -= 0.5;
    fidelityEvidence.push('assembled from raw primitives only');
    deficiencies.push({
      dimension: 'representationFidelity',
      severity: 'major',
      finding:
        'The model is assembled only from raw primitives, so no shape is matched to its behavior.',
      instruction:
        'Use motion-correct builders: geom.gear for gears, geom.gearProfile + extrude for real teeth, helix + sweep for springs, geom.path + particles for flow, sdf/parametric for organic forms. A static lookalike is exposed the moment the model moves.',
    });
  }

  // ── Per-part lookalikes: mechanism names on raw primitives that move ───────
  // `01:45-50` names this defect class exactly — trapezoid teeth and stacked cylinders are
  // exposed *the moment the model moves*, which is precisely when a learner is watching. The
  // narrowest honest check the manifest's provenance supports: name + motion + builder, all
  // three, per part. The whole-model primitive penalty above stays as the coarse sibling.
  const motionKindsByPart = new Map<string, Set<string>>();
  for (const motion of manifest.motions) {
    const kinds = motionKindsByPart.get(motion.partId) ?? new Set<string>();
    kinds.add(motion.kind);
    motionKindsByPart.set(motion.partId, kinds);
  }
  let lookalikes = 0;
  for (const part of manifest.parts) {
    const builder = part.geometry?.builder;
    if (!builder || !RAW_PRIMITIVE_BUILDERS.has(builder)) continue;
    const kinds = motionKindsByPart.get(part.id);
    if (!kinds) continue;

    if (kinds.has('spin') && GEAR_VOCABULARY.test(part.name)) {
      lookalikes += 1;
      deficiencies.push({
        dimension: 'representationFidelity',
        severity: 'major',
        finding: `Part '${part.id}' ('${part.name}') spins, but its geometry is the raw primitive '${builder}' — a mechanism part named for its motion must be built to perform it.`,
        instruction: `Rebuild '${part.id}' with geom.gear / gearProfile for an involute profile — trapezoid teeth visibly slip the moment the train turns.`,
        subjectId: part.id,
      });
    } else if (
      (kinds.has('oscillate') || kinds.has('translate') || kinds.has('pulse')) &&
      SPRING_VOCABULARY.test(part.name)
    ) {
      lookalikes += 1;
      deficiencies.push({
        dimension: 'representationFidelity',
        severity: 'major',
        finding: `Part '${part.id}' ('${part.name}') compresses, but its geometry is the raw primitive '${builder}' — a spring that cannot compress is a picture of a spring.`,
        instruction: `Rebuild '${part.id}' with geom.helix — stacked cylinders cannot compress.`,
        subjectId: part.id,
      });
    }
  }
  if (lookalikes > 0) {
    fidelity -= 0.2;
    fidelityEvidence.push(`${lookalikes} moving parts are raw-primitive lookalikes`);
  }
  dimensions.push(score('representationFidelity', fidelity, fidelityEvidence));

  // ── Pedagogy: objectives, story, quiz ─────────────────────────────────────
  const pedagogyEvidence: string[] = [
    `${manifest.pedagogy.objectives.length} objectives`,
    `${manifest.story.length} story beats`,
    `${manifest.quiz.length} authored quiz questions`,
  ];
  const pedagogy =
    0.3 +
    Math.min(0.2, manifest.pedagogy.objectives.length / 4) +
    Math.min(0.25, manifest.story.length / 5) +
    Math.min(0.25, manifest.quiz.length / 5);
  dimensions.push(score('pedagogy', pedagogy, pedagogyEvidence));
  if (manifest.story.length === 0) {
    deficiencies.push({
      dimension: 'pedagogy',
      severity: 'major',
      finding: 'The model declares no story beats.',
      instruction:
        'Author 3–6 story beats with scene.story([...]) following the causal arc (setup → mechanism → intermediate → result → why it matters), each targeting a real part id.',
    });
  }
  if (manifest.quiz.length === 0) {
    deficiencies.push({
      dimension: 'pedagogy',
      severity: 'minor',
      finding: 'The model ships no quiz questions.',
      instruction:
        'Author quiz questions with scene.quiz([...]): 4 options, one correct, distractors built from real misconceptions, explanations for both outcomes.',
    });
  }

  // ── Color and material semantics ──────────────────────────────────────────
  const colorFraction = manifest.colorRoles.length >= 3 ? 1 : manifest.colorRoles.length / 3;
  dimensions.push(
    score('colorSemantics', Math.min(1, 0.3 + colorFraction), [
      `${manifest.colorRoles.length} declared color roles`,
    ]),
  );
  if (manifest.colorRoles.length === 0) {
    deficiencies.push({
      dimension: 'colorSemantics',
      severity: 'minor',
      finding: 'No color roles are declared, so color carries no meaning the learner can learn.',
      instruction:
        'Declare roles with scene.colorRole({ id, label, color, meaning }) — one for carriers, one for boundaries, one for energy, one for outputs — and apply them consistently.',
    });
  }
  const materialKinds = new Set(
    manifest.parts.filter((part) => part.material).map((part) => part.material?.archetype),
  );
  dimensions.push(
    score('materialSemantics', Math.min(1, 0.3 + materialKinds.size / 5), [
      `material archetypes used: ${[...materialKinds].join(', ')}`,
    ]),
  );

  // ── Cleanliness and attractiveness proxies ────────────────────────────────
  dimensions.push(score('cleanliness', hasHero ? 0.8 : 0.5, ['focal hierarchy from hero flags']));
  const delightSignals =
    (manifest.environment?.preset !== 'studio' ? 1 : 0) +
    (manifest.lights.length > 0 ? 1 : 0) +
    (manifest.camera.shots && Object.keys(manifest.camera.shots).length > 0 ? 1 : 0);
  dimensions.push(
    score('attractiveness', 0.4 + delightSignals * 0.2, [
      `authored lights: ${manifest.lights.length}`,
      `authored shots: ${Object.keys(manifest.camera.shots).length}`,
    ]),
  );

  // ── Detail economics and budget ───────────────────────────────────────────
  const instanced = manifest.cost.instancedSets > 0;
  dimensions.push(
    score('detailEconomics', instanced ? 0.9 : 0.6, [
      `${manifest.cost.instancedSets} instanced sets, ${manifest.cost.instances} instances`,
      `${manifest.cost.uniqueGeometries} unique geometries for ${manifest.cost.parts} parts`,
    ]),
  );
  const budgetTable = DEVICE_BUDGETS[input.tier];
  const budgetFraction = manifest.cost.triangles <= budgetTable.maxTriangles ? 1 : 0;
  dimensions.push(
    score('budget', budgetFraction, [
      `${manifest.cost.triangles} triangles vs ${budgetTable.maxTriangles} budget`,
      `${manifest.cost.drawCalls} draw calls vs ${budgetTable.maxDrawCalls}`,
    ]),
  );
  if (manifest.cost.drawCalls > budgetTable.maxDrawCalls) {
    deficiencies.push({
      dimension: 'detailEconomics',
      severity: 'major',
      finding: `The model issues ${manifest.cost.drawCalls} draw calls; this device's budget is ${budgetTable.maxDrawCalls}.`,
      instruction:
        'Repeated or static structure must be instanced (scene.instances) or authored as one component placed many times — not individual meshes.',
    });
  }

  // ── Blockers ──────────────────────────────────────────────────────────────
  // `01`: "blocker means the model must not ship at all". An empty tree or no describe() already failed
  // the build above, so the blockers here are the two structural emptinesses that can still occur.
  if (manifest.parts.length === 0) {
    deficiencies.push({
      dimension: 'completeness',
      severity: 'blocker',
      finding: 'The model built with no parts.',
      instruction: 'Declare parts with scene.mesh({...}) — an empty scene cannot teach.',
    });
  }

  const weighted = dimensions.reduce(
    (sum, dimension) => sum + dimension.score * AUDIT_WEIGHTS[dimension.dimension],
    0,
  );
  const blocked = deficiencies.some((deficiency) => deficiency.severity === 'blocker');

  return {
    ok: true,
    manifest,
    report: {
      score: Math.round(weighted),
      dimensions,
      deficiencies,
      blocked,
      durationMillis: Date.now() - started,
    },
  };
}
