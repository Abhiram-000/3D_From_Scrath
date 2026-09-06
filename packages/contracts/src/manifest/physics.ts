/**
 * Physics declarations, in SI units.
 *
 * `02-PHYSICS.md` sets the rule that shapes this file: mass and inertia derive from the collider's
 * true volume and the material's real density *by default*, with authored overrides for non-uniform
 * internals. So a body declaration names a material rather than a mass, and the mass field is the
 * exception. Colliders are declared separately from render geometry because `02` R3 demands the
 * solver resolve what the learner sees touching — a cylinder collides as a cylinder — which means the
 * collider must be derivable from the part's geometry but overridable when it is not.
 */
import { z } from 'zod';
import { AuthoredId, Vec3, finite, finiteIn, shortText } from '../primitives.ts';

/**
 * Named materials with real densities (kg/m³), friction and restitution. The point of naming them is
 * `02`'s "materials you can identify blind": steel rings and slides to a stop, rubber grips, ice
 * glides — distinct properties applied consistently teach material science without a word of text.
 */
export const PhysicsMaterialName = z.enum([
  'steel',
  'aluminium',
  'brass',
  'iron',
  'wood',
  'rubber',
  'plastic',
  'glass',
  'concrete',
  'ice',
  'foam',
  'water',
  'custom',
]);
export type PhysicsMaterialName = z.infer<typeof PhysicsMaterialName>;

export const PhysicsMaterialDecl = z.object({
  name: PhysicsMaterialName.default('custom'),
  /** kg/m³. Water is 1000; steel ~7850; foam ~30. Zero or negative is rejected before the solver (`02`). */
  density: finite.positive().max(30000).optional(),
  friction: finiteIn(0, 4).optional(),
  restitution: finiteIn(0, 1).optional(),
  linearDamping: finiteIn(0, 20).optional(),
  angularDamping: finiteIn(0, 20).optional(),
});
export type PhysicsMaterialDecl = z.infer<typeof PhysicsMaterialDecl>;

/**
 * Body kinds map to the solver's own vocabulary. `kinematic` is the bridge `01` calls a requirement:
 * "animated colliders that genuinely push simulated bodies... a conveyor belt that passes *through*
 * the crates it should carry is a broken lesson."
 */
export const BodyKind = z.enum(['dynamic', 'kinematic', 'fixed']);
export type BodyKind = z.infer<typeof BodyKind>;

export const ColliderShape = z.enum([
  'auto',
  'box',
  'sphere',
  'capsule',
  'cylinder',
  'cone',
  'convexHull',
  'trimesh',
  'heightfield',
]);
export type ColliderShape = z.infer<typeof ColliderShape>;

export const ColliderDecl = z.object({
  /** `auto` derives the shape from the part's render geometry — the fidelity default (`02` R3). */
  shape: ColliderShape.default('auto'),
  /** Half-extents for box, radius/halfHeight for round shapes. Interpreted per shape by the engine. */
  size: Vec3.optional(),
  radius: finite.positive().optional(),
  halfHeight: finite.positive().optional(),
  offset: Vec3.optional(),
  /** Sensor colliders report contacts without resolving them — the trigger volume for teaching events. */
  sensor: z.boolean().default(false),
});
export type ColliderDecl = z.infer<typeof ColliderDecl>;

export const BodyDecl = z.object({
  id: AuthoredId,
  /** The part whose transform this body drives (or follows, when kinematic). */
  partId: AuthoredId,
  kind: BodyKind.default('dynamic'),
  material: PhysicsMaterialDecl.prefault({ name: 'custom' }),
  collider: ColliderDecl.prefault({ shape: 'auto' }),
  /** kg. Overrides the density-derived mass; present only for non-uniform internals (`02` R2). */
  mass: finite.positive().max(1e9).optional(),
  centerOfMass: Vec3.optional(),
  linearVelocity: Vec3.optional(),
  angularVelocity: Vec3.optional(),
  /** Continuous collision detection: required for a fast body versus a thin wall (`02` edge cases). */
  ccd: z.boolean().default(false),
  /** Sleeping is correct for settled scenes, but a parameter change must wake what it affects (`02` R5). */
  canSleep: z.boolean().default(true),
  gravityScale: finiteIn(-10, 10).default(1),
});
export type BodyDecl = z.infer<typeof BodyDecl>;

export const JointKind = z.enum(['revolute', 'prismatic', 'fixed', 'spherical', 'rope', 'spring']);
export type JointKind = z.infer<typeof JointKind>;

export const JointDecl = z.object({
  id: AuthoredId,
  kind: JointKind,
  bodyA: AuthoredId,
  /** Null anchors the joint to the world — a pendulum's pivot, a motor's stator mount. */
  bodyB: AuthoredId.nullable(),
  anchorA: Vec3.default([0, 0, 0]),
  anchorB: Vec3.default([0, 0, 0]),
  /** Rotation or sliding axis, joint-local. */
  axis: Vec3.optional(),
  /** Radians for revolute, metres for prismatic. Enforced by the solver, asserted by tests (`02`). */
  limits: z.tuple([finite, finite]).optional(),
  /** A motor turns a joint into a driven mechanism; `targetVelocity` is retargetable live (`02` R5). */
  motor: z
    .object({
      targetVelocity: finite.optional(),
      targetPosition: finite.optional(),
      maxForce: finite.min(0).max(1e9).default(1e4),
      stiffness: finite.min(0).optional(),
      damping: finite.min(0).optional(),
      boundToParameter: AuthoredId.optional(),
    })
    .optional(),
  restLength: finite.min(0).optional(),
});
export type JointDecl = z.infer<typeof JointDecl>;

/**
 * World settings. `02` R4 requires the same scene to evolve identically on a 30 Hz phone and a
 * 144 Hz desktop, so the simulation advances on its own fixed clock at `stepHz` and rendering
 * interpolates — the frame rate never changes the physics.
 */
export const PhysicsWorldDecl = z.object({
  gravity: Vec3.default([0, -9.81, 0]),
  stepHz: finiteIn(30, 480).default(120),
  /** Solver iterations; more is stiffer and costlier. Tier-capped by the budget system. */
  substeps: z.number().int().min(1).max(16).default(4),
  /** Deterministic when the scene asks for it (reproducible teaching demos), free when it asks (`00`). */
  deterministic: z.boolean().default(false),
  /** Seed used when deterministic, so a demo replays identically across reloads. */
  seed: z.number().int().nonnegative().default(1),
  /** Playback speed for slow-motion teaching; the underlying math is unchanged (`02` interaction). */
  timeScale: finiteIn(0.01, 4).default(1),
  /** Whether the learner may grab and throw bodies. */
  grabbable: z.boolean().default(true),
});
export type PhysicsWorldDecl = z.infer<typeof PhysicsWorldDecl>;

/** A measured quantity the model wants surfaced next to the simulation (`02` R6). */
export const PhysicsProbeDecl = z.object({
  id: AuthoredId,
  bodyId: AuthoredId,
  quantity: z.enum([
    'speed',
    'height',
    'kineticEnergy',
    'potentialEnergy',
    'totalEnergy',
    'momentum',
    'angularSpeed',
    'contactForce',
  ]),
  label: shortText(64),
});
export type PhysicsProbeDecl = z.infer<typeof PhysicsProbeDecl>;

export const PhysicsDecl = z.object({
  world: PhysicsWorldDecl.prefault({}),
  bodies: z.array(BodyDecl).max(512).default([]),
  joints: z.array(JointDecl).max(256).default([]),
  probes: z.array(PhysicsProbeDecl).max(32).default([]),
});
export type PhysicsDecl = z.infer<typeof PhysicsDecl>;
