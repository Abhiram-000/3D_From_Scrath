/**
 * The audit: headless dry run, measurable scoring, enumerated deficiencies.
 *
 * `01` requires that "'good' must be machine-checkable to drive refinement", and the mechanism is the
 * one this platform is uniquely positioned for: the server *runs the AI's actual code* in `node:vm`
 * (`authorInNodeVm`) and measures what it does. A parameter that writes nothing is observed, not
 * guessed; liveliness is counted frames, not a vibe. Every dimension score below is computed from a
 * proxy the dry run can measure, per `01`'s "scored by proxy signals the audit can measure".
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
import { authorInNodeVm } from '@edu3d/engine';

/** Sweep samples per parameter: min, quarter, default, three-quarters, max. Enough to catch a dead binding. */
const SWEEP_FRACTIONS = [0, 0.25, 0.5, 0.75, 1] as const;

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

  // ── Parameter leverage: the sweep `00` makes provable ──────────────────────
  const leverageEvidence: string[] = [];
  let liveParameters = 0;
  for (const parameter of manifest.parameters) {
    if (parameter.kind !== 'number') {
      // Boolean/choice/color parameters are swept by toggling; a write anywhere counts.
      builder.sweepParameter(
        parameter.id,
        parameter.kind === 'boolean' ? !parameter.default : parameter.default,
      );
      if ((builder.observedWrites.get(parameter.id)?.size ?? 0) > 0) liveParameters += 1;
      continue;
    }
    const span = parameter.max - parameter.min || 1;
    for (const fraction of SWEEP_FRACTIONS) {
      builder.sweepParameter(parameter.id, parameter.min + span * fraction);
    }
    const writes = builder.observedWrites.get(parameter.id);
    if (writes && writes.size > 0) {
      liveParameters += 1;
      leverageEvidence.push(`'${parameter.id}' wrote: ${[...writes].join(', ')}`);
    } else {
      deficiencies.push({
        dimension: 'parameterLeverage',
        severity: 'major',
        finding: `Parameter '${parameter.id}' changes nothing visible when swept across its whole range.`,
        instruction: `Bind '${parameter.id}' to real behavior: use it in an onFrame callback to drive motion, emissive intensity or color of the parts it claims to affect (ctx.params.${parameter.id}).`,
        subjectId: parameter.id,
      });
    }
  }
  const parameterFraction =
    manifest.parameters.length === 0 ? 0 : liveParameters / manifest.parameters.length;
  dimensions.push(
    score('parameterLeverage', parameterFraction === 0 ? 0.2 : parameterFraction, leverageEvidence),
  );

  // ── Liveliness: frames actually wrote to parts ────────────────────────────
  const touched = builder.touchedParts();
  const movableParts = manifest.parts.filter((part) => part.kind !== 'group').length;
  const touchedFraction = movableParts === 0 ? 0 : Math.min(1, touched.size / Math.min(12, movableParts));
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
    score('information', infoFraction, [`${informational.length}/${movableParts} parts carry info text`]),
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
  const completenessEvidence: string[] = [`root parts: ${manifest.parts.filter((p) => p.parentId === null).length}`];
  const hasHero = manifest.parts.some((part) => part.hero);
  if (hasHero) completenessEvidence.push('hero part declared');
  const completeness =
    0.4 + (hasHero ? 0.2 : 0) + Math.min(0.2, manifest.parts.length / 150) + (manifest.parameters.length > 0 ? 0.1 : 0) + (manifest.motions.length > 0 ? 0.1 : 0);
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
  const gearParts = manifest.parts.filter((part) => part.geometry?.builder === 'gear' || part.geometry?.builder === 'gearProfile');
  if (gearParts.length > 0) fidelityEvidence.push(`${gearParts.length} involute gear parts`);
  const helixParts = manifest.parts.filter((part) => part.geometry?.builder === 'helix');
  if (helixParts.length > 0) fidelityEvidence.push(`${helixParts.length} true helical parts`);
  if (gearParts.length > 0) fidelity += 0.1;
  if (helixParts.length > 0) fidelity += 0.1;
  if (buildersUsed.has('sdf')) {
    fidelity += 0.1;
    fidelityEvidence.push('organic forms via SDF blending');
  }
  const primitiveOnly = manifest.parts.length > 8 && [...buildersUsed].every((builder) =>
    ['box', 'sphere', 'cylinder', 'cone', 'torus', 'disc', 'plane', 'capsule'].includes(builder ?? ''),
  );
  if (primitiveOnly) {
    fidelity -= 0.5;
    fidelityEvidence.push('assembled from raw primitives only');
    deficiencies.push({
      dimension: 'representationFidelity',
      severity: 'major',
      finding: 'The model is assembled only from raw primitives, so no shape is matched to its behavior.',
      instruction:
        'Use motion-correct builders: geom.gear for gears, geom.gearProfile + extrude for real teeth, helix + sweep for springs, geom.path + particles for flow, sdf/parametric for organic forms. A static lookalike is exposed the moment the model moves.',
    });
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
  dimensions.push(
    score('cleanliness', hasHero ? 0.8 : 0.5, ['focal hierarchy from hero flags']),
  );
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

  const weighted =
    dimensions.reduce((sum, dimension) => sum + dimension.score * AUDIT_WEIGHTS[dimension.dimension], 0);
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
