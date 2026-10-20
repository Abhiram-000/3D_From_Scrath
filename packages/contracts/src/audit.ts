/**
 * The audit's vocabulary: what "good" means in machine-checkable terms.
 *
 * `01-MODELS.md` states the reason this file exists: "Because 'good' must be machine-checkable to
 * drive refinement, your audit scores models against these dimensions." The dimensions below are that
 * list, and the deficiency shape is what `04` sends back into a refinement pass — "specific,
 * enumerated instructions... because targeted revision beats re-rolling."
 */
import { z } from 'zod';
import { shortText } from './primitives.ts';

/** The scoring dimensions, taken directly from `01`'s audit section. */
export const AuditDimension = z.enum([
  'cleanliness',
  'attractiveness',
  'information',
  'completeness',
  'representationFidelity',
  'materialSemantics',
  'colorSemantics',
  'parameterLeverage',
  'detailEconomics',
  'liveliness',
  'pedagogy',
  'budget',
]);
export type AuditDimension = z.infer<typeof AuditDimension>;

/**
 * Dimension weights.
 *
 * `01` leaves the weights to us and says so. These are set by teaching consequence: a model that is
 * incomplete or teaches with static-shape lookalikes is *wrong*, while one that is merely plain is
 * weak — so completeness, information and parameter leverage outweigh attractiveness. Attractiveness
 * is still weighted, because `01` is explicit that "a model that is correct but ugly loses the learner
 * before it can teach". Weights sum to 1.
 */
export const AUDIT_WEIGHTS: Readonly<Record<AuditDimension, number>> = Object.freeze({
  completeness: 0.14,
  information: 0.13,
  parameterLeverage: 0.13,
  representationFidelity: 0.11,
  liveliness: 0.09,
  pedagogy: 0.09,
  cleanliness: 0.07,
  colorSemantics: 0.06,
  materialSemantics: 0.06,
  attractiveness: 0.05,
  detailEconomics: 0.04,
  budget: 0.03,
});

/**
 * How serious a finding is.
 *
 * `blocker` means the model must not ship at all — an empty scene, a part tree with no root. `major`
 * is what a refinement pass is for. `minor` is recorded and shown in diagnostics but never costs a
 * learner a wait.
 */
export const DeficiencySeverity = z.enum(['blocker', 'major', 'minor']);
export type DeficiencySeverity = z.infer<typeof DeficiencySeverity>;

/**
 * One enumerated deficiency.
 *
 * `instruction` is written *for the model that will fix it* — imperative and specific, in the style
 * `01` demands: "the turbine blades are boxes, loft them", "the temperature parameter changes nothing
 * visible". A finding without an actionable instruction is a complaint, and complaints do not improve
 * a second draft.
 */
export const Deficiency = z.object({
  dimension: AuditDimension,
  severity: DeficiencySeverity,
  /** What is wrong, stated as fact. */
  finding: shortText(300),
  /** What to do about it, addressed to the generator. */
  instruction: shortText(400),
  /** The part, parameter or light the finding is about, when it is about one. */
  subjectId: shortText(64).optional(),
});
export type Deficiency = z.infer<typeof Deficiency>;

export const DimensionScore = z.object({
  dimension: AuditDimension,
  /** 0–100. Computed from measurable proxies only; nothing here is a subjective judgement. */
  score: z.number().min(0).max(100),
  /** The measurements behind the score, so a low number is explainable in diagnostics. */
  evidence: z.array(shortText(200)).max(12).default([]),
});
export type DimensionScore = z.infer<typeof DimensionScore>;

export const AuditReport = z.object({
  /** Weighted total, 0–100. */
  score: z.number().min(0).max(100),
  dimensions: z.array(DimensionScore),
  deficiencies: z.array(Deficiency).max(64),
  /** True when at least one blocker was found: the model is refused, not shown (`04` edge cases). */
  blocked: z.boolean(),
  /** Milliseconds the audit took; recorded because CPU cost on the request path must stay visible. */
  durationMillis: z.number().min(0),
});
export type AuditReport = z.infer<typeof AuditReport>;

/**
 * The score below which a refinement pass is worth its money.
 *
 * One pass only, per `04`: "the revision is accepted only if it is *genuinely better* (fewer errors,
 * score not worse) — a degenerate second attempt must never replace a decent first one."
 *
 * There is deliberately no companion *rejection* threshold. One existed (35) and was never
 * enforced; measuring why is more useful than enforcing it would have been. A model that builds at
 * all scores about 36 or more — a single box with no parameters, no motion and nothing to teach
 * measures 36, because the raw proxies for the dimensions start from non-zero bases (completeness
 * at 0.4, fidelity at 0.7). A rejection threshold of 35 therefore cannot fire. A rule that cannot
 * fire is worse than no rule: it reads as a policy while enforcing nothing. If a rejection rule is
 * wanted, its threshold has to be calibrated against that floor, which is a product decision and
 * not one to make by writing a number in a constant.
 */
export const REFINEMENT_THRESHOLD = 72;
