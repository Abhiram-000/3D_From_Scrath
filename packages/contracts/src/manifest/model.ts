/**
 * The model manifest: the complete, serialisable description a generated model produces.
 *
 * This is the artifact that crosses every boundary in the platform — sandbox → host, server → client,
 * database row → viewer — so it is the one shape everything agrees on. It exists because of `PLAN.md`
 * §A2: the AI's program runs once against the authoring API and yields this, and only then is it
 * realized into Three.js objects. Consequences worth stating, since they justify the design:
 *
 *   - the server can audit and price a model with no browser and no GPU (`04` stage 4, `08` admission)
 *   - the tutor's context is extracted from here, bounded, rather than from a raw program (`05`)
 *   - realization can fail without disturbing the model already on screen (`03` R2, atomic swap)
 *
 * Nothing in here contains a GPU handle, a closure, or a URL. Callbacks stay in the sandbox and are
 * referenced by id.
 */
import { z } from 'zod';
import { AuthoredId, EpochMillis, finite, optionalText, shortText } from '../primitives.ts';
import { PartTree } from './parts.ts';
import { MetricDecl, ParameterDecl } from './parameters.ts';
import {
  CameraLimits,
  CameraPose,
  ColorRole,
  EnvironmentDecl,
  LightDecl,
  ShotDecl,
} from './presentation.ts';
import { PhysicsDecl } from './physics.ts';
import { InteractionDecl, MotionDecl, PathDecl, QuizQuestion, StoryBeat } from './behavior.ts';

/**
 * The domain classification the AI performs *before* choosing a representation (`00`, the domain
 * spectrum). `other` is deliberately present and deliberately not a failure: an unlisted domain
 * (music theory, law, linguistics) is handled by the same reasoning, and refusing to classify must
 * never become refusing to build.
 */
export const Domain = z.enum([
  'mechanics',
  'electronics',
  'fields',
  'chemistry',
  'biology',
  'earth',
  'astronomy',
  'mathematics',
  'architecture',
  'computing',
  'economics',
  'history',
  'everyday',
  'other',
]);
export type Domain = z.infer<typeof Domain>;

/** The teaching declaration: what this model claims to teach, checked by the audit against content. */
export const Pedagogy = z.object({
  concept: shortText(240),
  /** What the learner should be able to do afterwards. The audit checks the story covers these. */
  objectives: z.array(shortText(240)).min(1).max(8),
  studentLevel: z.enum(['primary', 'secondary', 'undergraduate', 'expert']).default('secondary'),
  /** Named principles or laws the model demonstrates. */
  principles: z.array(shortText(200)).max(8).default([]),
  /**
   * Declared simplifications. `01` requires exaggeration to be honest: "declare it in the model's own
   * info text, so the learner knows they are looking at an analogy, not a scale model."
   */
  simplifications: z.array(shortText(240)).max(8).default([]),
  /** What connects to what and which way causality flows (`01`, step 3 of the design order). */
  relationships: z
    .array(
      z.object({
        from: shortText(64),
        to: shortText(64),
        kind: shortText(48),
        note: optionalText(200),
      }),
    )
    .max(64)
    .default([]),
});
export type Pedagogy = z.infer<typeof Pedagogy>;

/** Measured build cost, produced by the authoring pass before any GPU allocation (`08`). */
export const BuildCost = z.object({
  parts: z.number().int().nonnegative(),
  /** Distinct GPU geometries after structural dedup — the number that actually costs memory. */
  uniqueGeometries: z.number().int().nonnegative(),
  uniqueMaterials: z.number().int().nonnegative(),
  triangles: z.number().int().nonnegative(),
  vertices: z.number().int().nonnegative(),
  /** Instanced sets cost one draw call each, which is the whole point of counting them separately. */
  drawCalls: z.number().int().nonnegative(),
  instancedSets: z.number().int().nonnegative(),
  instances: z.number().int().nonnegative(),
  shadowCastingLights: z.number().int().nonnegative(),
  physicsBodies: z.number().int().nonnegative(),
  /** Wall-clock milliseconds the authoring pass took inside the sandbox. */
  authorMillis: finite.min(0),
});
export type BuildCost = z.infer<typeof BuildCost>;

/** Ids of callbacks the model registered in the sandbox, so the host knows what it may invoke. */
export const CallbackRegistry = z.object({
  /** True when the model registered a per-frame update function. */
  hasFrame: z.boolean().default(false),
  /** True when the model registered a parameter-change reaction. */
  hasParameterChange: z.boolean().default(false),
  /** Ids of custom interaction handlers referenced by `InteractionDecl.handlerId`. */
  interactionHandlers: z.array(AuthoredId).max(128).default([]),
  /** Ids of metric computations the model publishes each frame. */
  metricComputers: z.array(AuthoredId).max(64).default([]),
});
export type CallbackRegistry = z.infer<typeof CallbackRegistry>;

export const ModelManifest = z.object({
  /** Manifest format version. Bumped only for breaking shape changes; readers must check it. */
  formatVersion: z.literal(1),
  name: shortText(120),
  description: shortText(2000),
  domain: Domain,
  subdomain: optionalText(80),
  pedagogy: Pedagogy,

  parts: PartTree,
  colorRoles: z.array(ColorRole).max(16).default([]),
  lights: z.array(LightDecl).max(24).default([]),
  /**
   * `prefault` rather than `default`: it feeds `{}` through the schema so the nested field defaults
   * apply, where `default` would demand a fully-formed output object at every call site.
   */
  environment: EnvironmentDecl.prefault({}),
  camera: z.object({
    initial: CameraPose,
    limits: CameraLimits.prefault({}),
    /** Named shots the model authored, replayable from story beats and interactions. */
    shots: z.record(AuthoredId, ShotDecl).default({}),
  }),

  parameters: z.array(ParameterDecl).max(24).default([]),
  metrics: z.array(MetricDecl).max(16).default([]),
  motions: z.array(MotionDecl).max(512).default([]),
  paths: z.array(PathDecl).max(64).default([]),
  interactions: z.array(InteractionDecl).max(256).default([]),
  physics: PhysicsDecl.optional(),

  story: z.array(StoryBeat).max(12).default([]),
  quiz: z.array(QuizQuestion).max(20).default([]),

  cost: BuildCost,
  callbacks: CallbackRegistry.prefault({}),

  /** Non-fatal problems the authoring pass reported: clamped values, dropped duplicates, fallbacks used. */
  warnings: z.array(shortText(240)).max(64).default([]),
  createdAt: EpochMillis,
});
export type ModelManifest = z.infer<typeof ModelManifest>;

/**
 * A manifest paired with the code that produced it and the provenance of the generation.
 *
 * The viewer's diagnostics panel shows "what the AI actually produced vs. what runs" (`03` R8), which
 * only works if the raw code travels with the model. It is stored, never executed outside the sandbox.
 */
export const ModelBundle = z.object({
  manifest: ModelManifest,
  /** The exact program the sandbox ran, after extraction and repair. */
  code: z.string().max(1_500_000),
  /**
   * Instrumented source — what actually executes in the browser, loop guard included.
   *
   * The pipeline validates the instrumented program (the loop guard is the cheap layer of the
   * sandbox's five), but `code` must stay clean of `__edu3d_tick` noise because the learner reads
   * it in the diagnostics panel. Both needs are real; the fix is to carry both strings. Optional
   * because bundles published before this field existed still have to load — the worker falls back
   * to `code`, guarded the old (expensive) way.
   */
  runtime: z
    .string()
    // Instrumentation adds a tick call per loop body, so runtime can exceed code's 1.5 MB cap;
    // `rawOutput`'s 2 MB bound is the established precedent for the larger of the two strings.
    .max(2_000_000)
    .optional(),
  /** The provider's untouched reply, kept for diagnostics when it differed from `code`. */
  rawOutput: z.string().max(2_000_000).optional(),
  provenance: z
    .object({
      topic: shortText(2000),
      model: shortText(80).optional(),
      promptVersion: shortText(40).optional(),
      repairPasses: z.number().int().min(0).max(8).default(0),
      refinementPasses: z.number().int().min(0).max(4).default(0),
      durationMillis: finite.min(0).optional(),
    })
    .optional(),
});
export type ModelBundle = z.infer<typeof ModelBundle>;
