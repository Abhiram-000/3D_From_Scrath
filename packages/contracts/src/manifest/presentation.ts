/**
 * Camera and lighting declarations.
 *
 * Two rules from `00-GOAL.md` shape this file. First, framing on load is *authored*: "every model
 * opens with the full concept in view — the AI author sets the initial camera; auto-frame the
 * bounding sphere is the fallback, never the default answer." Second, the cinematic shot vocabulary
 * is a core capability the API must expose directly, so shots are first-class declarations rather
 * than ad-hoc per-frame math — which is also what lets story beats chain them.
 */
import { z } from 'zod';
import { AuthoredId, HexColor, Vec3, finite, finiteIn, shortText } from '../primitives.ts';

/** The authored opening frame. Absent target means "look at the model's centre". */
export const CameraPose = z.object({
  position: Vec3,
  target: Vec3.default([0, 0, 0]),
  /** Vertical field of view in degrees; 35–60 keeps a teaching frame free of wide-angle distortion. */
  fov: finiteIn(10, 120).default(45),
  up: Vec3.optional(),
});
export type CameraPose = z.infer<typeof CameraPose>;

/** Orbit limits so "the learner can never lose the model off-screen or zoom through the floor" (`00`). */
export const CameraLimits = z.object({
  minDistance: finite.positive().optional(),
  maxDistance: finite.positive().optional(),
  /** Polar angle clamps in radians, measured from +Y. Defaults keep the camera above the floor plane. */
  minPolarAngle: finiteIn(0, Math.PI).optional(),
  maxPolarAngle: finiteIn(0, Math.PI).optional(),
  /** Damping factor for orbit inertia: "smooth, not floaty". */
  damping: finiteIn(0, 1).default(0.08),
  /** Gentle idle orbit when the user is not interacting, so the model always feels alive (`00`). */
  autoRotate: z.boolean().default(true),
  autoRotateSpeed: finiteIn(-4, 4).default(0.35),
});
export type CameraLimits = z.infer<typeof CameraLimits>;

/**
 * The shot vocabulary. Every entry here is scriptable from the scene API and composable, because
 * `00` requires "orbit *while* dollying = a spiral shot".
 *
 * The nine kinds are exactly the moves `00-GOAL.md` promises in "The shot vocabulary": `cut` the
 * instant transition, `moveTo` the eased move, `flyTo` fly-to/focus, `orbit` the reveal orbit,
 * `follow` the follow shot, `dolly` push-in, `crane`, `pan`, and `fovPull` the zoom (FOV) pull.
 * Idle auto-rotation is deliberately *not* a shot kind — it is `CameraLimits.autoRotate`.
 * The authoring builder refuses anything else (`scene.ts`), and the prompt's API reference table
 * renders this union from `ShotKind.options`, so documentation, declaration and validation cannot
 * drift apart — a hand-maintained union once taught the model kinds no schema accepted, which lost
 * whole paid generations after a repair pass re-sent the same wrong table.
 */
export const ShotKind = z.enum([
  'cut',
  'moveTo',
  'flyTo',
  'orbit',
  'follow',
  'dolly',
  'crane',
  'pan',
  'fovPull',
]);
export type ShotKind = z.infer<typeof ShotKind>;

/**
 * Easing per shot, because `00` states the choice matters: ease-in-out for travel, ease-out for
 * landings, linear for follow shots.
 */
export const ShotEasing = z.enum(['linear', 'easeIn', 'easeOut', 'easeInOut']);
export type ShotEasing = z.infer<typeof ShotEasing>;

export const ShotDecl = z.object({
  kind: ShotKind,
  /** Seconds. A `cut` ignores this; everything else interpolates over it. */
  duration: finiteIn(0, 60).default(1.2),
  easing: ShotEasing.default('easeInOut'),
  /** Target part for `flyTo` / `follow`; resolved by id at playback, skipped honestly if missing (`05`). */
  targetPartId: AuthoredId.optional(),
  /** Explicit destination for `moveTo` / `cut`. */
  pose: CameraPose.partial().optional(),
  /** Signed distance for `dolly` (toward target when negative) and height delta for `crane`, metres. */
  distance: finite.optional(),
  /** Radians swept, for `orbit` and `pan`. */
  sweep: finite.optional(),
  /** Destination FOV for `fovPull`, degrees. */
  fov: finiteIn(10, 120).optional(),
  /** Margin multiplier when framing a part, so the part fills the view *with* breathing room. */
  margin: finiteIn(1, 4).default(1.35),
});
export type ShotDecl = z.infer<typeof ShotDecl>;

/**
 * A shot declaration as captured, defaults not yet applied — the same input-vs-output distinction
 * `ScalarSourceInput` and `MotionDeclInput` make in behavior.ts. Story-beat and interaction shots
 * reach the player straight from the authoring pass without a zod round-trip, so `duration`,
 * `easing` and `margin` can arrive absent; the player defaults them itself (see
 * `SHOT_DEFAULT_DURATION` in sandbox-worker.ts). A fully-defaulted `ShotDecl` is always assignable
 * to this shape, which is why parsed manifests still pass through unchanged.
 */
export type ShotDeclInput = z.input<typeof ShotDecl>;

/**
 * Lights.
 *
 * `00` requires that every model gets a sane default rig even if the AI writes no lighting code, so
 * these declarations *augment* a base rig rather than replacing it. `boundToParameter` is the
 * "semantic light" requirement: brightness bound to power, temperature or reaction rate.
 */
export const LightKind = z.enum(['ambient', 'hemisphere', 'directional', 'point', 'spot', 'rect']);
export type LightKind = z.infer<typeof LightKind>;

export const LightDecl = z.object({
  id: AuthoredId,
  kind: LightKind,
  color: HexColor.default('#ffffff'),
  /** Physical-ish intensity; the engine maps it per light type under one tone-mapping regime. */
  intensity: finite.min(0).max(1000).default(1),
  position: Vec3.optional(),
  target: Vec3.optional(),
  /** Cone half-angle in radians, spot lights only. */
  angle: finiteIn(0, Math.PI / 2).optional(),
  penumbra: finiteIn(0, 1).optional(),
  distance: finite.min(0).optional(),
  /**
   * Shadow casting is requested, not granted: `08` budgets shadow-casting lights per device tier
   * (LOW 0–1, MID 2, HIGH 4+) and downgrades the excess rather than freezing the tab.
   */
  castShadow: z.boolean().default(false),
  boundToParameter: AuthoredId.optional(),
});
export type LightDecl = z.infer<typeof LightDecl>;

/** Backdrop and tone settings; the engine keeps model contrast in both themes (`00`, `08`). */
export const EnvironmentDecl = z.object({
  /** A named preset rather than an asset URL: the sandbox has no network, by design. */
  preset: z.enum(['studio', 'void', 'horizon', 'lab', 'space', 'outdoor']).default('studio'),
  /** Overrides the theme-derived backdrop when the lesson needs a specific one (e.g. space = black). */
  backgroundDark: HexColor.optional(),
  backgroundLight: HexColor.optional(),
  /** Reference grid on the ground plane; useful for scale, noise otherwise. */
  grid: z.boolean().default(false),
  /** Exposure in stops, applied to tone mapping. */
  exposure: finiteIn(-4, 4).default(0),
  fog: z.object({ color: HexColor, near: finite.min(0), far: finite.min(0) }).optional(),
});
export type EnvironmentDecl = z.infer<typeof EnvironmentDecl>;

/** A declared color role: the semantic system the learner learns to read (`01`: color selection). */
export const ColorRole = z.object({
  id: AuthoredId,
  label: shortText(48),
  color: HexColor,
  /** What this role means — "carriers", "field", "boundary" — shown in the info panel's legend. */
  meaning: shortText(120),
});
export type ColorRole = z.infer<typeof ColorRole>;
