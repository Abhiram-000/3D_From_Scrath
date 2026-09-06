/**
 * The part tree: what the AI's program declared as scene content, in serialisable form.
 *
 * This is the manifest half of the two-stage build described in `PLAN.md` §A2. The AI program runs
 * once against the authoring API and produces this description; only afterwards is it realized into
 * Three.js objects. Keeping the description free of GPU handles is what lets the server audit a
 * model, price it against a device budget, and build the tutor's context — all without a browser.
 *
 * Note what this file deliberately does *not* do: it does not enumerate the shapes a model may
 * contain. `00-GOAL.md` is explicit that "the ceiling is the API, not the schema" — a closed geometry
 * enum would reintroduce exactly the LEGO limit the code-writing design exists to escape. So geometry
 * is identified here by the *name of the builder that produced it* plus its measured cost, and the
 * authoritative list of builders lives in the engine's API surface descriptor, which the static gate
 * and the generation prompt both read. Adding a builder therefore extends the platform's expressive
 * range without touching this contract.
 */
import { z } from 'zod';
import {
  AuthoredId,
  HexColor,
  Quat,
  Vec3,
  finite,
  optionalText,
  shortText,
} from '../primitives.ts';

/**
 * What a node contributes to the scene. `instances` is the cheap path for repetition that `08` makes
 * a budget line rather than an optimisation: a 38-blade fan is one draw call, not 38.
 */
export const PartKind = z.enum([
  'group',
  'mesh',
  'instances',
  'points',
  'line',
  'sprite',
  'label',
  'helper',
]);
export type PartKind = z.infer<typeof PartKind>;

/**
 * Material archetypes, not free-form shaders. `01-MODELS` requires materials to be *semantic* — the
 * learner should identify substance on sight — and caps the vocabulary deliberately: "a model with
 * five material archetypes used meaningfully reads as designed; a model with fifty ad-hoc materials
 * reads as noise." Unlike geometry, restraint here is the feature.
 */
export const MaterialArchetype = z.enum([
  'metal',
  'matte',
  'plastic',
  'glass',
  'translucent',
  'emissive',
  'toon',
  'wire',
  'fluid',
  'organic',
  'gradient',
]);
export type MaterialArchetype = z.infer<typeof MaterialArchetype>;

/**
 * The name of the geometry builder that produced a shape, e.g. `revolve`, `sweep`, `sdf`, `mesh`.
 *
 * Bounded as an identifier rather than an enum on purpose (see the file header). Validation that the
 * name is real happens where the truth lives: the static gate checks calls against the engine's
 * exported API surface before the code ever runs.
 */
export const GeometryBuilderName = z
  .string()
  .min(1)
  .max(48)
  .regex(/^[a-z][A-Za-z0-9]*$/, 'builder names are lowerCamelCase identifiers');
export type GeometryBuilderName = z.infer<typeof GeometryBuilderName>;

/**
 * A geometry's identity and cost, without its buffers.
 *
 * `cacheKey` is the structural hash `08` requires for deduplication: identical specs map to one GPU
 * object, so a 200-bolt assembly costs one bolt's worth of memory. `triangles` is measured by the
 * builder at authoring time, before any GPU allocation, which is what makes admission pricing
 * possible ("a budget breach is never discovered as a stutter; it is prevented as a number").
 */
export const GeometryRef = z.object({
  builder: GeometryBuilderName,
  cacheKey: z.string().min(1).max(512),
  triangles: z.number().int().nonnegative(),
  vertices: z.number().int().nonnegative(),
  /**
   * Modifiers applied after the base build, in order — `['twist', 'subdivide', 'weld']`. Recorded for
   * diagnostics and for the audit, which reads modifier use as evidence of authored detail rather
   * than default primitives.
   */
  modifiers: z.array(GeometryBuilderName).max(24).default([]),
  /** True when the shape was downgraded to fit the device budget, so the status bar can be honest. */
  decimated: z.boolean().default(false),
  /** Radius of the geometry's bounding sphere, metres. Culling and framing both depend on it (`08`). */
  boundingRadius: finite.min(0).optional(),
});
export type GeometryRef = z.infer<typeof GeometryRef>;

/** A material's identity and the semantic choices the audit reads (`01`: material semantics). */
export const MaterialRef = z.object({
  archetype: MaterialArchetype,
  cacheKey: z.string().min(1).max(512),
  color: HexColor.optional(),
  /** The declared color role this material belongs to, when the model uses roles (`01`: color roles). */
  role: AuthoredId.optional(),
  emissiveIntensity: finite.min(0).max(64).optional(),
  opacity: finite.min(0).max(1).optional(),
  transmission: finite.min(0).max(1).optional(),
  metalness: finite.min(0).max(1).optional(),
  roughness: finite.min(0).max(1).optional(),
  /** True when a procedural texture drives this surface (a heat map, brushed direction) — `01`. */
  procedural: z.boolean().default(false),
  /** Set when emissive or color is driven by a parameter — the "model as its own instrument" rule. */
  boundToParameter: AuthoredId.optional(),
});
export type MaterialRef = z.infer<typeof MaterialRef>;

/** Position / orientation / scale as authored. Euler is accepted; the engine normalises to quaternion. */
export const Transform = z.object({
  position: Vec3.default([0, 0, 0]),
  rotation: Vec3.optional(),
  quaternion: Quat.optional(),
  scale: Vec3.default([1, 1, 1]),
});
export type Transform = z.infer<typeof Transform>;

/**
 * What a part says about itself when selected or hovered.
 *
 * `03` R3 makes this the platform's core gesture, and `01` makes it a quality gate: "a part the
 * learner can select but that says nothing is a wasted click." The audit counts parts without info.
 */
export const PartInfo = z.object({
  title: shortText(120),
  summary: optionalText(1200),
  bullets: z.array(shortText(240)).max(8).default([]),
  tags: z.array(shortText(32)).max(12).default([]),
  /** Authored quantitative facts, e.g. `{ label: 'Bore', value: '86 mm' }`. Displayed, never parsed. */
  facts: z
    .array(z.object({ label: shortText(48), value: shortText(64) }))
    .max(12)
    .default([]),
});
export type PartInfo = z.infer<typeof PartInfo>;

/** One placement of an instanced set. `08`: N × geometry cost, 1 × draw call. */
export const InstancePlacement = z.object({
  transform: Transform,
  /** Optional per-instance label so a click can report *which* blade was hit (`03` R3). */
  label: shortText(64).optional(),
  colorOverride: HexColor.optional(),
});
export type InstancePlacement = z.infer<typeof InstancePlacement>;

/**
 * Upper bound on placements in a single instanced set.
 *
 * High on purpose: a phyllotaxis of 20 000 leaves, a scatter of rivets, or an electron cloud are all
 * one draw call, so the honest limit is memory for the transform buffer rather than render cost. The
 * device budget prices the set; this cap only stops a runaway loop from allocating unboundedly.
 */
export const MAX_INSTANCES_PER_SET = 40000;

/** Upper bound on vertices in a single point cloud, for the same reason. */
export const MAX_POINTS_PER_CLOUD = 200000;

/**
 * A node in the model's tree.
 *
 * Declared with an explicit `parentId` rather than nested `children`: the tree arrives from the
 * sandbox already flattened parent-first, and a bounded, non-recursive schema is both faster to
 * validate and impossible to blow the stack on hostile nesting.
 */
export const PartNode = z.object({
  id: AuthoredId,
  parentId: AuthoredId.nullable(),
  kind: PartKind,
  name: shortText(120),
  /** Function group this part belongs to, so hierarchy reads as the machine's block diagram (`01`). */
  group: shortText(64).optional(),
  /**
   * The reusable component definition this part was placed from, when it came from one. Recorded
   * because component reuse is how `00` requires 300-part ambition to stay affordable: "an engine
   * with 300 parts is built from a few parameterized definitions, not 300 hand-written blocks."
   */
  component: shortText(64).optional(),
  transform: Transform,
  geometry: GeometryRef.optional(),
  material: MaterialRef.optional(),
  info: PartInfo.optional(),
  /** Instanced placements; present only for `kind: 'instances'`. */
  instances: z.array(InstancePlacement).max(MAX_INSTANCES_PER_SET).optional(),
  /** Whether a click selects this part. Structural scaffolding opts out; anything explanatory opts in. */
  selectable: z.boolean().default(true),
  visible: z.boolean().default(true),
  /** Offset direction for exploded view; the engine derives one from the bounds when absent (`00`). */
  explodeOffset: Vec3.optional(),
  /** True when this part is one of the two or three the lesson is *about* (`01`: focal hierarchy). */
  hero: z.boolean().default(false),
  /** Marks scaffolding that may be merged into shared buffers because it never moves (`08`). */
  staticGeometry: z.boolean().default(false),
  /**
   * Distance-based detail ladder, coarsest last. Chosen by screen-space size at runtime, not raw
   * distance, so it adapts to any camera FOV (`08`).
   */
  lod: z
    .array(z.object({ geometry: GeometryRef, screenFraction: finite.min(0).max(1) }))
    .max(4)
    .optional(),
});
export type PartNode = z.infer<typeof PartNode>;

/**
 * Upper bound on distinct nodes in one model.
 *
 * `00` demands "full multi-system assemblies with hundreds of meaningful parts", and instanced sets
 * count as one node each, so this ceiling is far above the ambition it must not constrain. It exists
 * only so a runaway generator cannot exhaust memory before the budget system can price the model.
 */
export const MAX_PARTS = 20000;

/** The full part list, parent-first so a consumer can rebuild the tree in one pass. */
export const PartTree = z.array(PartNode).min(1).max(MAX_PARTS);
export type PartTree = z.infer<typeof PartTree>;
