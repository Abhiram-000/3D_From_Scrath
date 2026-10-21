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
 * Three measure families extend that discipline to claims the audit used to let pass:
 *
 *  - **Read-out liveness** (the sweep's evidence discipline, applied to published metrics): a
 *    declared read-out whose quantised value never differs across any sweep point — or that is
 *    never published at all — is a lying number, the same defect class `parameterLeverage` catches
 *    for sliders. Scored and reported under `information` (read-outs are information surfaces);
 *    deliberately not under `parameterLeverage`, because the pipeline harvests *that* dimension's
 *    subjectIds into `unboundParameterIds` and a metric id must never travel as a parameter id.
 *  - **Referential integrity**: story targets, story `setParameters`, shot targets, quiz evidence
 *    ids, `affects.partId` entries, motion `pathId`s and interaction targetIds are captured
 *    verbatim by the authoring pass with no resolution check (unlike `motion.partId` and
 *    `interaction.partId`, which `scene.ts` throws on at authoring time). A dangling id is a
 *    broken lesson — the learner taps "show me the evidence" and nothing happens — so every
 *    declared id must resolve, scored under `completeness`.
 *  - **Unit discipline on physical controls**: a number parameter that supplies a declared motion's
 *    rate/amplitude or feeds the physics solver, declared with no unit (or an empty one), is not
 *    quantitative — `00`'s hard contract demands real units. Severity is deliberately `minor`:
 *    dimensionless factors are legitimate, so the finding instructs rather than accuses, and a
 *    minor never triggers the paid refinement pass.
 *
 *  - **Shot honesty**: the schema keeps all nine `ShotKind`s legal because `00-GOAL.md` specifies
 *    them, but the viewer's player covers four (`cut`, `flyTo`, `dolly`, `fovPull`). A declared
 *    kind with no player is a promised camera move that will not happen — flagged under
 *    `pedagogy` at `minor` severity, naming the playable vocabulary, rather than credited. The
 *    reference turbofan declares only `flyTo` shots, so the exemplar stays unflagged.
 *
 * What the audit deliberately does **not** claim, because a manifest cannot carry the evidence:
 * whether a constant is real, a proportion is right, a causal direction is correct or a formula is
 * true — textbook *accuracy* has no machine-checkable dimension here and lives in the prompt's
 * self-check rubric (see `packages/contracts/src/audit.ts`); neither does plain-language
 * understandability. `prompts.ts` states that boundary rather than implying otherwise.
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
import { GuestBudgetError, GuestTimeoutError } from '@edu3d/sandbox';

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

  // ── Read-out evidence: quantised metric values observed at every sweep point ──
  //
  // The sweep runs the guest's parameterChange + frame callbacks at sampled parameter values and
  // times; whatever `ctx.metric(id, …)` published during each point is recorded. A declared
  // read-out is judged live by the SAME discipline as a parameter — value change across sweep
  // points, never the mere presence of a publish call, which a frame callback makes every frame
  // regardless. Two inherited limits are stated, not hidden: effects below the 3-decimal sweep
  // quantum or appearing only after t = 1 s read as dead (the sweep's false-dead direction), and a
  // guest-side closure that drifts on its own (an accumulating counter) would read live without
  // tracking anything factual — the check proves the number moves, not that it tells the truth.
  const SWEEP_QUANTUM_DECIMALS = 3;
  const quantiseValue = (value: number): number => {
    const scaled = Math.round(value * 10 ** SWEEP_QUANTUM_DECIMALS) / 10 ** SWEEP_QUANTUM_DECIMALS;
    return Object.is(scaled, -0) ? 0 : scaled;
  };
  const metricValueHistory = new Map<string, Set<number>>();
  const observeMetrics = (): void => {
    for (const [id, value] of Object.entries(builder.currentMetrics())) {
      const values = metricValueHistory.get(id) ?? new Set<number>();
      values.add(quantiseValue(value));
      metricValueHistory.set(id, values);
    }
  };
  // Build-time published values first: a metric computed once at authoring and never again shows
  // up here as one constant repeated through the baseline of every later point.
  observeMetrics();

  // A budget/timeout failure while the audit drives guest callbacks is an audit OUTCOME (a
  // repairable build failure the pipeline routes to repair), never an exception that escapes.
  const budgetFailure = (error: unknown, during: string) => {
    const detail =
      error instanceof GuestBudgetError || error instanceof GuestTimeoutError
        ? ((error as { message?: string }).message ?? 'compute budget exhausted')
        : error && typeof error === 'object' && 'message' in error
          ? String((error as { message: unknown }).message)
          : String(error);
    return {
      ok: false as const,
      message: `The model exceeded its compute budget while the audit ${during} (${detail}). Reduce per-frame loop work so the model can be measured reliably.`,
      timedOut: true,
    };
  };

  for (const parameter of manifest.parameters) {
    const values = sweepValuesFor(parameter);
    // The sweep runs guest frame callbacks whose loop guard is still armed with the BUILD's
    // deadline (the node host arms it once, `node-host.ts`). A heavy build can therefore
    // exhaust the shared budget mid-sweep — caught here so the loop guard's
    // `GuestBudgetError`/`GuestTimeoutError` becomes an audit OUTCOME (a repairable build
    // failure the pipeline routes to repair), never an exception that escapes the audit.
    // (Root cause — re-arm the guard per phase — lives in packages/engine; reported.)
    let sweepError: unknown = null;
    try {
      for (const time of SWEEP_TIMES) {
        for (const value of values) {
          builder.sweepParameter(parameter.id, value, time);
          observeMetrics();
        }
      }
    } catch (error) {
      sweepError = error;
    }
    if (sweepError !== null) {
      return budgetFailure(sweepError, 'swept its parameters');
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

  // A model with no parameters never ran a frame above (the sweep is how frames get driven), so
  // its read-outs have no observations yet. Two probe frames at the sweep's own sample times give
  // the time dimension of the evidence; parameter responsiveness is unjudgeable here by
  // construction — there is nothing to sweep — and is not claimed.
  if (manifest.parameters.length === 0 && manifest.metrics.length > 0) {
    let probeError: unknown = null;
    try {
      for (const time of SWEEP_TIMES) {
        builder.runFrame(time, 1 / 60);
        observeMetrics();
      }
    } catch (error) {
      probeError = error;
    }
    if (probeError !== null) {
      return budgetFailure(probeError, 'ran its frame callbacks');
    }
  }

  // ── Read-out liveness: a dead read-out is a defect, not a decoration ───────
  //
  // `00` promises "numbers on screen and motion on screen always agree". The audit cannot read
  // formulas, but it can observe values: a declared read-out that never published (no number
  // behind the panel at all) or published one quantised value across every sweep point of every
  // parameter at both sample times (a number no control or motion moves) fails the promise.
  // Scored under `information` — read-outs are learner-facing information surfaces. Deliberately
  // NOT under `parameterLeverage`: the pipeline collects that dimension's subjectIds into
  // `unboundParameterIds` for the topic battery, and a metric id must never travel as a parameter
  // id. `source: 'physics'` read-outs are exempt from the variation judgement: their values come
  // from solver probes the headless pass cannot step, so judging them here would flag every
  // honest physical-simulation model.
  const metricEvidence: string[] = [];
  let deadMetrics = 0;
  for (const metric of manifest.metrics) {
    if (metric.source === 'physics') {
      metricEvidence.push(`'${metric.id}': physics-sourced; measured by the runtime solver`);
      continue;
    }
    const values = metricValueHistory.get(metric.id);
    if (values === undefined || values.size === 0) {
      deadMetrics += 1;
      deficiencies.push({
        dimension: 'information',
        severity: 'major',
        finding: `Read-out '${metric.id}' ('${metric.label}') is declared but the model never publishes a value for it — the panel shows a read-out with no number behind it.`,
        instruction: `Publish it every frame with ctx.metric('${metric.id}', value) inside onFrame, computed from the same parameters that drive the motion it summarizes — or remove the declaration if it has no live source.`,
        subjectId: `metric:${metric.id}`,
      });
      continue;
    }
    if (values.size === 1) {
      deadMetrics += 1;
      const published = [...values][0];
      deficiencies.push({
        dimension: 'information',
        severity: 'major',
        finding: `Read-out '${metric.id}' published ${published} and never changed across the audit's sweep of every parameter at both sample times — a number on screen that no control or motion moves.`,
        instruction: `Derive ctx.metric('${metric.id}', …) from the parameters or motion behind what it labels, so number and motion share a source. If it is genuinely constant (a physical constant), replace the live read-out with static info facts on a part.`,
        subjectId: `metric:${metric.id}`,
      });
      continue;
    }
    metricEvidence.push(`'${metric.id}': value changed across the sweep`);
  }
  if (manifest.metrics.length > 0 && metricEvidence.length === 0) {
    // Unreachable in practice, but evidence must never be asserted from silence.
    metricEvidence.push(`${manifest.metrics.length} read-outs declared`);
  }
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

  // ── Information: named parts with info text, live read-outs, stated units ─
  const informational = manifest.parts.filter((part) => part.info && part.kind !== 'group');
  const infoFraction = movableParts === 0 ? 0 : informational.length / movableParts;

  // Unit discipline: physical controls must state what their number means.
  //
  // The line drawn deliberately: only where the platform FIXES the meaning does a missing unit
  // have an evidence-backed answer. A motion rate is rad/s, m/s or Hz per `MotionDecl`; the
  // physics layer is defined in SI units. Everywhere else — transform channels can drive
  // dimensionless scale factors (the reference model's bypass ratio is honestly unitless), some
  // read-outs are ratios — a unit cannot be demanded without a dimensional-analysis engine the
  // audit refuses to invent. All findings here are `minor`: dimensionless factors are legitimate,
  // so the finding instructs rather than accuses, and a minor never starts the paid refinement
  // pass. `minor` therefore costs diagnostics, never API money, on a false positive.
  let unitIssues = 0;
  const flagUnit = (subjectId: string, finding: string, instruction: string): void => {
    unitIssues += 1;
    deficiencies.push({
      dimension: 'information',
      severity: 'minor',
      finding,
      instruction,
      subjectId,
    });
  };
  for (const parameter of manifest.parameters) {
    const declared = parameter.unit?.trim();
    if (declared !== undefined && declared === '') {
      flagUnit(
        parameter.id,
        `Parameter '${parameter.id}' declares an empty unit, which renders as no unit at all.`,
        `State the real unit — the value is read as a quantity — or remove the unit field if the control genuinely has none.`,
      );
      continue;
    }
    if (declared !== undefined || parameter.kind !== 'number') continue;
    if (motionBoundParams.has(parameter.id)) {
      flagUnit(
        parameter.id,
        `Parameter '${parameter.id}' drives a declared motion's rate or amplitude but states no unit.`,
        `Declare what its number means — spin/orbit rates are rad/s, translation m/s, oscillation Hz — or, if it is a dimensionless factor, say so explicitly (unit: '×').`,
      );
    } else if (
      manifest.physics &&
      parameter.affects.some((affect) => affect.channel === 'physics')
    ) {
      flagUnit(
        parameter.id,
        `Parameter '${parameter.id}' feeds the physics solver without a unit.`,
        `The physics layer is defined in SI units: declare the parameter's unit (kg, N, m/s, Pa, …), or 'ratio' if it is a dimensionless factor.`,
      );
    }
  }
  for (const metric of manifest.metrics) {
    if (metric.unit !== undefined && metric.unit.trim() === '') {
      flagUnit(
        `metric:${metric.id}`,
        `Read-out '${metric.id}' declares an empty unit, which renders as no unit at all.`,
        `State the real unit for the read-out's value (kN, m/s, K, …) or remove the unit field.`,
      );
    }
  }

  const unitPenalty = Math.min(0.15, unitIssues * 0.05);
  const readOutPenalty = Math.min(0.3, deadMetrics * 0.15);
  const informationFraction = Math.max(0, infoFraction - unitPenalty - readOutPenalty);
  const informationEvidence = [
    `${informational.length}/${movableParts} parts carry info text`,
    ...metricEvidence,
  ];
  if (unitIssues > 0) {
    informationEvidence.push(`${unitIssues} physical controls without a stated unit`);
  }
  dimensions.push(score('information', informationFraction, informationEvidence));
  // The deficiency condition reads the RAW fraction: dead read-outs and missing units already
  // produce their own specific findings, and a penalised composite must not also emit a misleading
  // "parts carry no info text" complaint.
  if (infoFraction < 0.5) {
    deficiencies.push({
      dimension: 'information',
      severity: 'major',
      finding: `Only ${informational.length} of ${movableParts} parts have info text.`,
      instruction:
        'Every selectable part needs info: { title, summary, bullets }. A part the learner can select but that says nothing is a wasted click.',
    });
  }

  // ── Shot honesty: a declared shot the viewer cannot play is a false promise ─
  //
  // `00-GOAL.md` makes the shot vocabulary "a core capability, not a nice-to-have", and the
  // schema keeps all nine kinds legal. But the viewer's player covers exactly four of them —
  // `cut`, `flyTo`, `dolly`, `fovPull` — and a model declaring one of the other five is promising
  // a camera move the learner will never see. The honest reading is a *completeness* gap in the
  // scripted lesson: the beat still narrates and its target still receives the default focus
  // move, so nothing is broken-to-the-learner, only the declared choreography beyond it is
  // missing. That is a `pedagogy` finding at `minor` severity deliberately: a `major` would send
  // the model to the paid refinement pass for following a prompt the platform itself cannot yet
  // honour — burning API money on a platform gap the model author cannot fix from their side. A
  // minor costs diagnostics and states the playable vocabulary, which becomes true the hour the
  // next player lands.
  const PLAYABLE_SHOT_KINDS = new Set(['cut', 'flyTo', 'dolly', 'fovPull']);
  const flagShot = (shot: { kind: string }, subjectId: string): void => {
    if (PLAYABLE_SHOT_KINDS.has(shot.kind)) return;
    deficiencies.push({
      dimension: 'pedagogy',
      severity: 'minor',
      finding: `A '${shot.kind}' shot is declared (under '${subjectId}') but the viewer cannot play that kind yet — the camera move this beat or interaction promises will not happen.`,
      instruction:
        `Replace the shot's kind with one the viewer plays — 'cut', 'flyTo', 'dolly' or 'fovPull' ` +
        `(e.g. scene.shot('x', { kind: 'flyTo', targetPartId: 'partId' })) — or drop the shot; ` +
        `'${shot.kind}' is a legal kind but has no player, so the declared move silently does nothing.`,
      subjectId,
    });
  };

  // ── Referential integrity: every declared id must resolve ──────────────────  //
  // `scene.motion` and `scene.interaction` throw on a missing partId at authoring time, so those
  // never reach the audit. Everything else is captured verbatim with no resolution check: story
  // targets, story `setParameters`, shot targets (in `camera.shots` and inside beat `shots`),
  // quiz evidence ids, `affects.partId` entries, motion `pathId`s and interaction `targetId`s. A
  // dangling id is a broken lesson — the learner taps "show me the evidence" and nothing happens,
  // or a beat sets a parameter that is not there — so it scores under completeness: the declared
  // teaching surface is not whole.
  const partIds = new Set(manifest.parts.map((part) => part.id));
  const parameterIds = new Set(manifest.parameters.map((parameter) => parameter.id));
  const pathIds = new Set(manifest.paths.map((path) => path.id));
  const dangling: Array<{ source: string; missingId: string; instruction: string }> = [];
  const claimPart = (partId: string | undefined, source: string, instruction: string): void => {
    if (partId !== undefined && !partIds.has(partId)) {
      dangling.push({ source, missingId: partId, instruction });
    }
  };
  for (const beat of manifest.story) {
    claimPart(
      beat.targetPartId,
      `story beat '${beat.id}'`,
      `point the beat's targetPartId at a real part id (scene.mesh / scene.instances / scene.place) or drop the target — the camera move silently skips a missing part.`,
    );
    for (const key of Object.keys(beat.setParameters ?? {})) {
      if (!parameterIds.has(key)) {
        dangling.push({
          source: `story beat '${beat.id}'`,
          missingId: key,
          instruction: `setParameters must name declared parameter ids — '${key}' is not one; declare it with scene.param or drop the assignment.`,
        });
      }
    }
    for (const [index, shot] of beat.shots.entries()) {
      claimPart(
        shot.targetPartId,
        `story beat '${beat.id}' shot`,
        `set the shot's targetPartId to a real part id, or drop it.`,
      );
      flagShot(shot, `shot:${beat.id}#${index + 1}`);
    }
  }
  for (const question of manifest.quiz) {
    if (
      question.evidencePartId !== undefined &&
      !partIds.has(question.evidencePartId) &&
      !parameterIds.has(question.evidencePartId)
    ) {
      dangling.push({
        source: `quiz question '${question.id}'`,
        missingId: question.evidencePartId,
        instruction: `evidencePartId must name a part or parameter the learner can inspect to verify the answer themselves.`,
      });
    }
  }
  for (const motion of manifest.motions) {
    if (motion.pathId !== undefined && !pathIds.has(motion.pathId)) {
      dangling.push({
        source: `motion '${motion.id}'`,
        missingId: motion.pathId,
        instruction: `declare the path with scene.path('${motion.pathId}', geom.path([...])) or drop the motion — a flow with no path flows nowhere.`,
      });
    }
  }
  for (const parameter of manifest.parameters) {
    for (const affect of parameter.affects) {
      claimPart(
        affect.partId,
        `parameter '${parameter.id}'`,
        `an affects entry's partId must name a real part — a claim about a part that does not exist verifies nothing.`,
      );
    }
  }
  for (const [shotId, shot] of Object.entries(manifest.camera.shots)) {
    claimPart(
      shot.targetPartId,
      `camera shot '${shotId}'`,
      `set the shot's targetPartId to a real part id, or drop it.`,
    );
    flagShot(shot, `shot:${shotId}`);
  }
  for (const interaction of manifest.interactions) {
    if (
      interaction.kind === 'setParameter' &&
      interaction.targetId !== undefined &&
      !parameterIds.has(interaction.targetId)
    ) {
      dangling.push({
        source: `interaction on '${interaction.partId}' (${interaction.on})`,
        missingId: interaction.targetId,
        instruction: `setParameter's targetId must name a declared parameter id.`,
      });
    }
    if (
      interaction.kind === 'toggleVisibility' &&
      interaction.targetId !== undefined &&
      !partIds.has(interaction.targetId)
    ) {
      dangling.push({
        source: `interaction on '${interaction.partId}' (${interaction.on})`,
        missingId: interaction.targetId,
        instruction: `toggleVisibility's targetId must name a real part id.`,
      });
    }
    if (interaction.shot) {
      flagShot(interaction.shot, `shot:${interaction.partId}(${interaction.on})`);
    }
  }
  // Bound the finding list: 64 deficiencies is the schema's ceiling and refinement reads them as
  // numbered instructions — the first eight name their subject; any rest aggregate into one line.
  const MAX_DANGLING_FINDINGS = 8;
  for (const ref of dangling.slice(0, MAX_DANGLING_FINDINGS)) {
    deficiencies.push({
      dimension: 'completeness',
      severity: 'major',
      finding: `${ref.source} references '${ref.missingId}', which does not exist in the manifest — that part of the lesson silently does nothing.`,
      instruction: ref.instruction,
      subjectId: ref.missingId,
    });
  }
  if (dangling.length > MAX_DANGLING_FINDINGS) {
    deficiencies.push({
      dimension: 'completeness',
      severity: 'major',
      finding: `${dangling.length} declared references do not resolve (${new Set(dangling.map((ref) => ref.missingId)).size} distinct missing ids); the first ${MAX_DANGLING_FINDINGS} are listed individually.`,
      instruction: `Fix every reference in the story, quiz, shots, motions and parameter declarations so each names a declared part, parameter or path.`,
      subjectId: dangling[MAX_DANGLING_FINDINGS]?.missingId,
    });
  }
  const danglingPenalty = Math.min(0.4, new Set(dangling.map((ref) => ref.missingId)).size * 0.1);

  // ── Completeness: structure exists, no orphan single-child chains ──────────
  const completenessEvidence: string[] = [
    `root parts: ${manifest.parts.filter((p) => p.parentId === null).length}`,
  ];
  const hasHero = manifest.parts.some((part) => part.hero);
  if (hasHero) completenessEvidence.push('hero part declared');
  if (danglingPenalty > 0) {
    completenessEvidence.push(
      `${new Set(dangling.map((ref) => ref.missingId)).size} dangling reference(s)`,
    );
  }
  const completeness =
    0.4 +
    (hasHero ? 0.2 : 0) +
    Math.min(0.2, manifest.parts.length / 150) +
    (manifest.parameters.length > 0 ? 0.1 : 0) +
    (manifest.motions.length > 0 ? 0.1 : 0) -
    danglingPenalty;
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
