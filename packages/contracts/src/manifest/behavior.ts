/**
 * Motion, interaction and story declarations — the parts of a model that make it *alive*.
 *
 * `00-GOAL.md`: "the default state of a model is motion", and stillness is a defect. Motion is
 * declared here rather than left entirely to per-frame callbacks for one reason: declared motion is
 * *auditable*. A model whose only animation is an opaque closure cannot be checked for "does the
 * speed parameter change anything"; a model whose spin rate is declared as `bind('speed')` can be.
 * Arbitrary per-frame logic remains available through `scene.onFrame` — this is the fast, checkable
 * path, not the only one.
 */
import { z } from 'zod';
import { AuthoredId, Vec3, finite, finiteIn, optionalText, shortText } from '../primitives.ts';
import { ShotDecl } from './presentation.ts';

/**
 * A scalar source: a constant, a parameter reference, or a named signal the runtime publishes
 * (elapsed time, a physics probe, a metric). This is what lets "rate, direction and amplitude come
 * from the model's own parameters" (`00`) be verified rather than hoped for.
 */
export const ScalarSource = z.union([
  z.object({ const: finite }),
  z.object({ param: AuthoredId, scale: finite.default(1), offset: finite.default(0) }),
  z.object({ signal: z.enum(['time', 'frame', 'simTime']), scale: finite.default(1) }),
  z.object({ probe: AuthoredId, scale: finite.default(1), offset: finite.default(0) }),
]);
export type ScalarSource = z.infer<typeof ScalarSource>;

/** Motion archetypes with correct physical meaning; anything else goes through `onFrame`. */
export const MotionKind = z.enum([
  'spin',
  'oscillate',
  'orbit',
  'translate',
  'pulse',
  'flowAlongPath',
  'follow',
  'sequence',
]);
export type MotionKind = z.infer<typeof MotionKind>;

export const MotionDecl = z.object({
  id: AuthoredId,
  partId: AuthoredId,
  kind: MotionKind,
  /** Rotation or translation axis, part-local. */
  axis: Vec3.default([0, 1, 0]),
  /** rad/s for spin and orbit, m/s for translate, Hz for oscillate and pulse. */
  rate: ScalarSource.prefault({ const: 1 }),
  /** Metres or radians, for oscillate/translate/pulse. */
  amplitude: ScalarSource.optional(),
  /** Radians, so a set of orbiting bodies can be distributed rather than synchronised. */
  phase: finite.default(0),
  /** Centre of revolution for `orbit`, world space. */
  center: Vec3.optional(),
  /** Path id for `flowAlongPath`; the path is declared by the model as a curve. */
  pathId: AuthoredId.optional(),
  /** Whether this motion runs while the model is paused. Almost always false; glow pulses may differ. */
  runsWhilePaused: z.boolean().default(false),
  /** Why this part moves — read by the audit, which rejects motion that exists "for animation". */
  reason: optionalText(240),
});
export type MotionDecl = z.infer<typeof MotionDecl>;

/** A named 3D path the model authored: flow lines, orbits, camera rails, particle routes. */
export const PathDecl = z.object({
  id: AuthoredId,
  /** Sampled points in world space; the engine fits a smooth curve through them. */
  points: z.array(Vec3).min(2).max(4096),
  closed: z.boolean().default(false),
  /** Rendered as a visible line when true — a flow path the learner can see (`01`). */
  visible: z.boolean().default(false),
});
export type PathDecl = z.infer<typeof PathDecl>;

/** What clicking or hovering a part can trigger beyond selection. */
export const InteractionKind = z.enum([
  'select',
  'toggleVisibility',
  'setParameter',
  'playShot',
  'startStoryBeat',
  'applyImpulse',
  'custom',
]);
export type InteractionKind = z.infer<typeof InteractionKind>;

export const InteractionDecl = z.object({
  partId: AuthoredId,
  on: z.enum(['click', 'doubleClick', 'hover', 'longPress']),
  kind: InteractionKind,
  /** Target parameter for `setParameter`, part for `toggleVisibility`, etc. */
  targetId: AuthoredId.optional(),
  value: z.union([finite, z.boolean(), z.string().max(64)]).optional(),
  shot: ShotDecl.optional(),
  /** Impulse in newton-seconds for `applyImpulse`. */
  impulse: Vec3.optional(),
  /** Id of a sandbox callback registered by the model, for `custom`. */
  handlerId: AuthoredId.optional(),
  hint: optionalText(160),
});
export type InteractionDecl = z.infer<typeof InteractionDecl>;

/**
 * A story beat. `05-CONVERSATION-LAYER.md` requires 3–6 beats following the causal arc, each
 * targeting a real named part and teaching one idea; the audit resolves every target and rejects
 * empty narration.
 */
export const StoryBeat = z.object({
  id: AuthoredId,
  title: shortText(120),
  narration: shortText(1200),
  /** The part this beat is about; the camera focuses it. A dangling target skips the move, not the beat. */
  targetPartId: AuthoredId.optional(),
  /** Camera choreography for this beat; defaults to an eased fly-to of the target. */
  shots: z.array(ShotDecl).max(6).default([]),
  /** Parameter values set on entry, so the phenomenon demonstrates itself at this step (`05`). */
  setParameters: z
    .record(AuthoredId, z.union([finite, z.boolean(), z.string().max(64)]))
    .optional(),
  /** Seconds to hold before auto-advance when narration is off; the reading-time default applies otherwise. */
  holdSeconds: finiteIn(1, 60).optional(),
  /** Visual mode the beat wants (x-ray for an internals beat, explode for a layout beat). */
  viewMode: z.enum(['normal', 'xray', 'wireframe', 'explode']).optional(),
});
export type StoryBeat = z.infer<typeof StoryBeat>;

/**
 * An authored quiz question. `05`'s authored-first rule makes these the primary path: they were
 * written for this exact model, cost nothing to use, and work with the backend down.
 */
export const QuizQuestion = z.object({
  id: AuthoredId,
  question: shortText(400),
  options: z.array(shortText(200)).min(2).max(6),
  /** Index into `options`. Out-of-range questions are dropped, never rendered (`05`). */
  correctIndex: z.number().int().min(0).max(5),
  /** Why the right answer is right *and* why the tempting wrong one is wrong. */
  explanation: shortText(800),
  difficulty: z.enum(['recall', 'application', 'synthesis']).default('application'),
  /** Part or parameter the learner can touch to check the answer themselves. */
  evidencePartId: AuthoredId.optional(),
});
export type QuizQuestion = z.infer<typeof QuizQuestion>;
