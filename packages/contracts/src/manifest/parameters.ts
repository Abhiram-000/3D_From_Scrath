/**
 * Parameters: the controls the learner drags, and the contract that each one must actually *do*
 * something.
 *
 * `00-GOAL.md` states the rule this file exists to make checkable: "a parameter that only moves a
 * slider is a broken parameter... a control that changes nothing is rejected, not shipped." The
 * declaration below therefore carries not just widget metadata but the parameter's declared targets,
 * which the audit's dry-run sweep verifies against what the model's frame callbacks actually wrote.
 */
import { z } from 'zod';
import { AuthoredId, HexColor, UnitLabel, finite, optionalText, shortText } from '../primitives.ts';

/** Widget kinds the parameters panel can render. Each maps to one owner in the panel (`03` R4). */
export const ParameterKind = z.enum(['number', 'boolean', 'color', 'choice']);
export type ParameterKind = z.infer<typeof ParameterKind>;

/**
 * What a parameter is allowed to influence.
 *
 * Declaring the channel makes the audit's verdict specific: a `speed` parameter that only ever
 * changed a material color is reported as such, rather than merely "changes something".
 */
export const ParameterChannel = z.enum([
  'transform',
  'material',
  'visibility',
  'motionRate',
  'physics',
  'camera',
  'metric',
  'geometry',
]);
export type ParameterChannel = z.infer<typeof ParameterChannel>;

const ParameterBase = z.object({
  id: AuthoredId,
  label: shortText(64),
  description: optionalText(400),
  /**
   * The real quantities of the concept — voltage, mass flow, gear ratio (`00`). Units are displayed
   * next to the value so the read-out is quantitative rather than cosmetic.
   */
  unit: UnitLabel.optional(),
  /** Parts and channels this parameter claims to drive; verified by the dry-run sweep. */
  affects: z
    .array(z.object({ partId: AuthoredId.optional(), channel: ParameterChannel }))
    .max(64)
    .default([]),
  /** Ordering hint for the panel; ties break on declaration order. */
  order: z.number().int().min(0).max(999).default(0),
});

export const NumberParameter = ParameterBase.extend({
  kind: z.literal('number'),
  min: finite,
  max: finite,
  step: finite.positive().optional(),
  default: finite,
  /** Log scale for quantities spanning decades (frequency, concentration) so the slider stays usable. */
  scale: z.enum(['linear', 'log']).default('linear'),
  /** Decimal places for the read-out; the panel's single formatting owner reads this (`03` R4). */
  precision: z.number().int().min(0).max(6).optional(),
});

export const BooleanParameter = ParameterBase.extend({
  kind: z.literal('boolean'),
  default: z.boolean(),
});

export const ColorParameter = ParameterBase.extend({
  kind: z.literal('color'),
  default: HexColor,
});

export const ChoiceParameter = ParameterBase.extend({
  kind: z.literal('choice'),
  options: z
    .array(z.object({ value: shortText(48), label: shortText(64) }))
    .min(2)
    .max(12),
  default: shortText(48),
});

export const ParameterDecl = z.discriminatedUnion('kind', [
  NumberParameter,
  BooleanParameter,
  ColorParameter,
  ChoiceParameter,
]);
export type ParameterDecl = z.infer<typeof ParameterDecl>;

/** Current values keyed by parameter id. Numbers, booleans, hex strings and choice values only. */
export const ParameterValues = z.record(
  AuthoredId,
  z.union([finite, z.boolean(), z.string().max(64)]),
);
export type ParameterValues = z.infer<typeof ParameterValues>;

/**
 * A derived read-out shown beside the model.
 *
 * `00` requires the numbers on screen and the motion on screen to agree, which only holds if both
 * are computed from the same source. The expression is evaluated by the model's own code inside the
 * sandbox and published as a value — the UI never evaluates anything.
 */
export const MetricDecl = z.object({
  id: AuthoredId,
  label: shortText(64),
  unit: UnitLabel.optional(),
  precision: z.number().int().min(0).max(6).default(2),
  /** Human-readable formula shown in the info panel, e.g. `T = 2π√(L/g)`. Display only. */
  formula: optionalText(200),
  /** Where the number comes from: the model's own computation, or a physics measurement (`02` R6). */
  source: z.enum(['model', 'physics']).default('model'),
});
export type MetricDecl = z.infer<typeof MetricDecl>;
