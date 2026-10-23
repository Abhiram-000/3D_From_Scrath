/**
 * The `scene` namespace: the authoring API the AI's program is written against.
 *
 * This is the product. `00-GOAL.md`: "The scene API design — this is the product. What the API exposes is what
 * the AI can build."
 *
 * It is the first half of the two-stage build in `PLAN.md` §A2. The program runs *once* against this surface
 * and produces two things: a `ModelManifest` (pure data, serialisable, GPU-free) and a set of registered
 * callbacks that stay live in the sandbox realm for per-frame work. Nothing here creates a Three.js object, so
 * the same code path runs in the browser worker and in `node:vm` for the headless audit — which is what makes
 * server-side auditing, admission pricing and provable parameter leverage possible at all.
 *
 * Design rules that show up everywhere below:
 *
 *  - **Declare, then react.** Structure is declared once; behaviour that must vary per frame goes through
 *    `onFrame`, which receives capability-scoped handles so every write is attributable to a declared target.
 *  - **Every id is checked at the boundary.** A duplicate or malformed id is a hard error with a sentence the
 *    repair pass can act on, because a dangling reference discovered at render time is much harder to explain.
 *  - **Warnings, not silent fixes.** Clamped values and dropped duplicates are recorded on the manifest so the
 *    diagnostics panel and the audit can both see what the engine changed.
 */
import {
  type BuildCost,
  type CameraPose,
  type Domain,
  type InteractionDecl,
  type MetricDecl,
  type ModelLabel,
  type ModelManifest,
  type MotionDecl,
  type ParameterDecl,
  type PartNode,
  type PathDecl,
  type Pedagogy,
  type PhysicsDecl,
  type QuizQuestion,
  type ScalarSource,
  type ShotDecl,
  type StoryBeat,
  BodyKind,
  ColliderShape,
  EnvironmentDecl as EnvironmentDeclSchema,
  InteractionDecl as InteractionDeclSchema,
  InteractionKind,
  JointKind,
  LightKind,
  MAX_INSTANCES_PER_SET,
  MAX_LABELS,
  MAX_PARTS,
  MotionKind,
  ParameterChannel,
  PhysicsMaterialName,
  PhysicsProbeDecl as PhysicsProbeDeclSchema,
  QuizQuestion as QuizQuestionSchema,
  ScalarSource as ScalarSourceSchema,
  ShotEasing,
  ShotKind,
  StoryBeat as StoryBeatSchema,
} from '@edu3d/contracts';
import { GeometryFactory, type GeometryHandle, type PathHandle } from '../geometry/factory.ts';
import { MaterialFactory, type MaterialHandle } from '../materials/factory.ts';
import type { Placement } from '../geometry/patterns.ts';
import { clamp } from '../math/index.ts';

/** Thrown when a program declares something the engine must refuse. Messages address the generator. */
export class SceneError extends Error {
  /** Class field ([[Define]] semantics): survives the frozen Error.prototype after realm hardening, where a constructor assignment ([[Set]]) throws. */
  override name = 'SceneError';
  constructor(message: string) {
    super(message);
  }
}

const ID_PATTERN = /^[A-Za-z][A-Za-z0-9_.-]*$/;

/**
 * Validation-helper rule for this file: **never call a schema at guest-realm runtime.**
 *
 * `scene.ts` executes inside the untrusted guest realm, where `@edu3d/sandbox` replaces `Function`
 * with a thrower and freezes the intrinsics. zod's parse path touches `Function`, so any
 * `.parse()`/`.safeParse()` here throws `Function is not available inside the model sandbox` — which
 * is why a `.safeParse` added to this file broke the whole browser authoring path while passing in
 * `node:vm`, whose realm is not poisoned. Everything below therefore validates structurally
 * (`typeof`, `Array.isArray`, `Number.isFinite`, membership in a precomputed `Set`) and the closed
 * vocabularies still come from the contract — read off a schema's `.options`/`.shape` at module
 * scope, which is a property read. What is forbidden is a schema *parse*:
 * `ZodType.parse`/`safeParse` build or run a validator that touches `Function`, so neither may appear
 * on a runtime path in this file. The one schema method still used, `.unwrap()` on a wrapped enum, is
 * a module-scope property read, not a parse.
 */

/** True for a finite number — the only numbers a manifest accepts. */
const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

/** True for a `Vec3`: exactly three finite numbers. */
const isVec3 = (value: unknown): value is [number, number, number] =>
  Array.isArray(value) && value.length === 3 && value.every(isFiniteNumber);

/** Mirrors the contract's `HexColor`; a pattern rather than a schema call, per the rule above. */
const HEX_COLOR_PATTERN = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

/**
 * The three signals `ScalarSource` accepts, read from the schema's own enum at module scope.
 *
 * `.options` is a property read, so it is safe in the guest realm; calling the schema would not be.
 */
const SCALAR_SIGNAL_SET: ReadonlySet<string> = new Set(
  (
    ScalarSourceSchema.options as ReadonlyArray<{
      shape: Record<string, { options?: readonly string[] }>;
    }>
  ).flatMap((option) => option.shape['signal']?.options ?? []),
);

/** The signal branch of a `ScalarSource`, derived from the contract type rather than restated. */
type ScalarSignal = Extract<ScalarSource, { signal: unknown }>['signal'];

const isScalarSignal = (value: unknown): value is ScalarSignal =>
  typeof value === 'string' && SCALAR_SIGNAL_SET.has(value);

/** The refusal for a malformed authored camera pose; `field` and `reason` name what is wrong. */
const poseRefusal = (label: string, field: string, reason: string): string =>
  `${label}: ${field} — ${reason}. A pose is { position: [x, y, z], target?: [x, y, z], fov?: degrees }.`;

/** The refusal for a malformed authored fog block. */
const fogRefusal = (label: string, field: string, reason: string): string =>
  `${label}: ${field} — ${reason}. Fog is { color: '#rrggbb', near: metres, far: metres }.`;

/**
 * A type-guard form of `Array.prototype.includes`, so an enum membership test narrows the value to
 * the contract's own member type instead of forcing a cast at the copy site.
 */
const enumMember = <T extends string>(options: readonly T[], value: string): value is T =>
  (options as readonly string[]).includes(value);

/**
 * Refuse an authored value that is not a member of the contract's own enum, naming every legal one.
 *
 * `options` is read off the schema that validates the manifest, so the refusal cannot drift from
 * what validation accepts. The failure this moves: a value that survived authoring, the static gate
 * and both repair passes only to die as a terminal `Invalid option` sentence, minutes into a paid
 * generation. The narrowed member is returned, so a call site copies a proven value rather than
 * casting author input into the manifest.
 */
const assertEnum = <T extends string>(
  value: unknown,
  options: readonly T[],
  label: string,
  what: string,
): T => {
  const text = String(value);
  if (!enumMember(options, text)) {
    throw new SceneError(
      `${label} uses '${text}', which is not one of the platform's ${what}. ` +
        `Supported values: ${options.join(', ')}.`,
    );
  }
  return text;
};

/**
 * The scalar a manifest accepts where an interaction or story value is named: a finite number, a
 * boolean, or a bounded string. Anything else used to ride through as a cast and die at manifest
 * validation, after the generation had already been paid for.
 */
const assertValueScalar = (value: unknown, label: string): number | boolean | string => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string' && value.length <= 64) return value;
  throw new SceneError(
    `${label} must be a finite number, a boolean, or a string of at most 64 characters.`,
  );
};

/**
 * The refusal for a scalar that is not one of the contract's four `ScalarSource` shapes.
 *
 * Written for the mistake that actually happens — a bare number, or a bare id string, where the
 * contract wants `{ const }`/`{ param }` — so it names the two likely intents concretely rather than
 * only reciting the union. `label` names the call site so the repair pass can find it.
 */
const scalarSourceRefusal = (label: string, value: unknown): string => {
  const paramExample = typeof value === 'string' ? `{ param: '${value}' }` : `{ param: 'rpm' }`;
  const seen = typeof value === 'string' ? `'${value}'` : (JSON.stringify(value) ?? String(value));
  return (
    `${label} must be a scalar source — { const: n } | { param: 'id' } | ` +
    `{ signal: 'time' | 'frame' | 'simTime' } | { probe: 'id' }. ` +
    `A bare number means a constant; a parameter reference is ${paramExample}. Got ${seen}.`
  );
};

/**
 * Camera shots are a documented capability the model is told to copy, so an invented kind used to
 * survive the whole build and die only at manifest validation — minutes into a *paid* generation,
 * as `generation_unrepairable: camera.shots.<id>.kind: Invalid option`, because the repair pass
 * re-sends the same documentation that taught the kind. Named shots, story-beat shots and
 * interaction shots share `ShotDecl`, so they share one refusal here at the boundary, in the same
 * house style as an unknown part id: hard, immediate, and naming every legal alternative.
 */
const SHOT_KIND_LIST = ShotKind.options.join(', ');
const SHOT_EASING_LIST = ShotEasing.options.join(', ');

/** Motion kinds a declaration can express: the wire enum minus the two it keeps for compatibility only. */
const MOTION_KIND_LIST = MotionKind.options.filter(
  (kind) => kind !== 'follow' && kind !== 'sequence',
);

/** The rest of the closed vocabularies, each read off the schema that validates the manifest. */
const LIGHT_KIND_LIST = LightKind.options;
const PARAMETER_CHANNEL_LIST = ParameterChannel.options;
const ENVIRONMENT_PRESET_LIST = EnvironmentDeclSchema.shape.preset.unwrap().options;
const INTERACTION_ON_LIST = InteractionDeclSchema.shape.on.options;
const QUIZ_DIFFICULTY_LIST = QuizQuestionSchema.shape.difficulty.unwrap().options;
const BODY_KIND_LIST = BodyKind.options;
const COLLIDER_SHAPE_LIST = ColliderShape.options;
const JOINT_KIND_LIST = JointKind.options;
const PHYSICS_MATERIAL_LIST = PhysicsMaterialName.options;
const PHYSICS_QUANTITY_LIST = PhysicsProbeDeclSchema.shape.quantity.options;

/** Reflected from the `StoryBeat` schema, so this list cannot drift from what manifest validation accepts. */
const ViewModeList = StoryBeatSchema.shape.viewMode.unwrap().options;

/**
 * Throw unless the raw authored shot object carries a legal kind and easing, and hand back the two
 * proven members. `label` names the call site.
 */
const assertShotShape = (
  label: string,
  kind: unknown,
  easing: unknown,
): { kind: ShotKind; easing: ShotEasing } => {
  const kindText = String(kind ?? 'flyTo');
  if (!enumMember(ShotKind.options, kindText)) {
    throw new SceneError(
      `${label} uses shot kind '${kindText}', which is not one of the platform's shot kinds. ` +
        `Supported kinds: ${SHOT_KIND_LIST} ` +
        `(e.g. scene.shot('myShot', { kind: 'flyTo', targetPartId: 'partId' })).`,
    );
  }
  const easingText = String(easing ?? 'easeInOut');
  if (!enumMember(ShotEasing.options, easingText)) {
    throw new SceneError(
      `${label} uses easing '${easingText}', which is not one of the platform's shot curves. ` +
        `Supported easings: ${SHOT_EASING_LIST}.`,
    );
  }
  return { kind: kindText, easing: easingText };
};

/** The same refusal for `scene.interaction`'s own kind, which types the interaction, not a camera move. */
const assertInteractionKind = (partId: string, kind: unknown): InteractionKind => {
  const kindText = String(kind ?? 'select');
  if (!enumMember(InteractionKind.options, kindText)) {
    throw new SceneError(
      `interaction on part '${partId}' uses kind '${kindText}', which is not one of the ` +
        `platform's interaction kinds. Supported kinds: ${InteractionKind.options.join(', ')} ` +
        `('playShot' takes a shot object; 'custom' takes a handlerId).`,
    );
  }
  return kindText;
};

// ── Structural validation of `scene.physics` ────────────────────────────────
//
// `scene.physics` runs inside the guest realm, so it cannot use `PhysicsDeclSchema.safeParse`: the
// sandbox poisons `Function` and zod's parse touches it. These functions validate the declaration by
// hand, apply the same defaults the schema applies (so an omitted field behaves exactly as it did
// through zod), and read the closed vocabularies from the contract's enums at module scope. The
// cross-references to declared parts and parameters are resolved in `SceneBuilder.toManifest`,
// because a model may declare physics before the parts and parameters it names.

/** Read an authored id against the contract's `AuthoredId` shape. */
const authoredId = (value: unknown, label: string): string => {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) {
    throw new SceneError(`${label} must be an id like 'bobBody' — [A-Za-z][A-Za-z0-9_.-]*.`);
  }
  return value;
};

/** Read a bounded finite number. */
const boundedNumber = (
  value: unknown,
  label: string,
  min = -Infinity,
  max = Infinity,
  minExclusive = false,
): number => {
  const bad = !isFiniteNumber(value) || (minExclusive ? value <= min : value < min) || value > max;
  if (bad) {
    const bounds = minExclusive
      ? `greater than ${min}${Number.isFinite(max) ? ` and at most ${max}` : ''}`
      : Number.isFinite(min) || Number.isFinite(max)
        ? `between ${min} and ${max}`
        : '';
    throw new SceneError(`${label} must be a finite number${bounds ? ` ${bounds}` : ''}.`);
  }
  return value;
};

/** Read an optional bounded finite number, returning `undefined` when the field is absent. */
const optionalBoundedNumber = (
  value: unknown,
  label: string,
  min = -Infinity,
  max = Infinity,
): number | undefined => (value === undefined ? undefined : boundedNumber(value, label, min, max));

/** Read an integer in an inclusive range. */
const integerIn = (value: unknown, label: string, min: number, max: number): number => {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new SceneError(`${label} must be an integer between ${min} and ${max}.`);
  }
  return value;
};

/** Read a `Vec3`. */
const vec3 = (value: unknown, label: string): [number, number, number] => {
  if (!isVec3(value)) {
    throw new SceneError(`${label} must be a triple of finite numbers like [0, -9.81, 0].`);
  }
  return value;
};

/** Read a two-number tuple, as a joint's `limits` is declared. */
const pair = (value: unknown, label: string): [number, number] => {
  if (!Array.isArray(value) || value.length !== 2 || !value.every(isFiniteNumber)) {
    throw new SceneError(`${label} must be a pair of finite numbers like [0, 1].`);
  }
  return value as [number, number];
};

/** Read bounded text, as a probe `label` is declared. */
const boundedText = (value: unknown, label: string, max: number): string => {
  if (typeof value !== 'string' || value.length < 1 || value.length > max) {
    throw new SceneError(`${label} must be text of 1 to ${max} characters.`);
  }
  return value;
};

/** Read an optional object field, refusing a present non-object in the declaration's voice. */
const optionalObject = (
  value: unknown,
  label: string,
  example: string,
): Record<string, unknown> => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new SceneError(`${label} must be an object like ${example}.`);
  }
  return value as Record<string, unknown>;
};

const parsePhysicsMaterial = (
  value: unknown,
  label: string,
): PhysicsDecl['bodies'][number]['material'] => {
  if (value === undefined) return { name: 'custom' };
  const raw = optionalObject(value, label, "{ name: 'steel', density: 7850 }");
  return {
    name: assertEnum(
      raw.name ?? 'custom',
      PHYSICS_MATERIAL_LIST,
      `${label} name`,
      'physics materials',
    ),
    ...(raw.density !== undefined
      ? { density: boundedNumber(raw.density, `${label} density`, 0, 30000, true) }
      : {}),
    ...(raw.friction !== undefined
      ? { friction: boundedNumber(raw.friction, `${label} friction`, 0, 4) }
      : {}),
    ...(raw.restitution !== undefined
      ? { restitution: boundedNumber(raw.restitution, `${label} restitution`, 0, 1) }
      : {}),
    ...(raw.linearDamping !== undefined
      ? { linearDamping: boundedNumber(raw.linearDamping, `${label} linearDamping`, 0, 20) }
      : {}),
    ...(raw.angularDamping !== undefined
      ? { angularDamping: boundedNumber(raw.angularDamping, `${label} angularDamping`, 0, 20) }
      : {}),
  };
};

const parsePhysicsCollider = (
  value: unknown,
  label: string,
): PhysicsDecl['bodies'][number]['collider'] => {
  if (value === undefined) return { shape: 'auto', sensor: false };
  const raw = optionalObject(value, label, "{ shape: 'box', size: [1, 1, 1] }");
  return {
    shape: assertEnum(
      raw.shape ?? 'auto',
      COLLIDER_SHAPE_LIST,
      `${label} shape`,
      'collider shapes',
    ),
    ...(raw.size !== undefined ? { size: vec3(raw.size, `${label} size`) } : {}),
    ...(raw.radius !== undefined
      ? { radius: boundedNumber(raw.radius, `${label} radius`, 0, Infinity, true) }
      : {}),
    ...(raw.halfHeight !== undefined
      ? { halfHeight: boundedNumber(raw.halfHeight, `${label} halfHeight`, 0, Infinity, true) }
      : {}),
    ...(raw.offset !== undefined ? { offset: vec3(raw.offset, `${label} offset`) } : {}),
    sensor: raw.sensor === true,
  };
};

const parsePhysicsBody = (value: unknown, index: number): PhysicsDecl['bodies'][number] => {
  const label = `scene.physics body ${index + 1}`;
  const raw = optionalObject(value, label, "{ id: 'bobBody', partId: 'bob' }");
  return {
    id: authoredId(raw.id, `${label} id`),
    partId: authoredId(raw.partId, `${label} partId`),
    kind: assertEnum(raw.kind ?? 'dynamic', BODY_KIND_LIST, `${label} kind`, 'body kinds'),
    material: parsePhysicsMaterial(raw.material, `${label} material`),
    collider: parsePhysicsCollider(raw.collider, `${label} collider`),
    ...(raw.mass !== undefined
      ? { mass: boundedNumber(raw.mass, `${label} mass`, 0, 1e9, true) }
      : {}),
    ...(raw.centerOfMass !== undefined
      ? { centerOfMass: vec3(raw.centerOfMass, `${label} centerOfMass`) }
      : {}),
    ...(raw.linearVelocity !== undefined
      ? { linearVelocity: vec3(raw.linearVelocity, `${label} linearVelocity`) }
      : {}),
    ...(raw.angularVelocity !== undefined
      ? { angularVelocity: vec3(raw.angularVelocity, `${label} angularVelocity`) }
      : {}),
    ccd: raw.ccd === true,
    canSleep: raw.canSleep !== false,
    gravityScale: optionalBoundedNumber(raw.gravityScale, `${label} gravityScale`, -10, 10) ?? 1,
  };
};

const parsePhysicsMotor = (
  value: unknown,
  label: string,
): NonNullable<PhysicsDecl['joints'][number]['motor']> => {
  const raw = optionalObject(value, label, '{ targetVelocity: 3, maxForce: 1000 }');
  return {
    ...(raw.targetVelocity !== undefined
      ? { targetVelocity: boundedNumber(raw.targetVelocity, `${label} targetVelocity`) }
      : {}),
    ...(raw.targetPosition !== undefined
      ? { targetPosition: boundedNumber(raw.targetPosition, `${label} targetPosition`) }
      : {}),
    maxForce: optionalBoundedNumber(raw.maxForce, `${label} maxForce`, 0, 1e9) ?? 1e4,
    ...(raw.stiffness !== undefined
      ? { stiffness: boundedNumber(raw.stiffness, `${label} stiffness`, 0) }
      : {}),
    ...(raw.damping !== undefined
      ? { damping: boundedNumber(raw.damping, `${label} damping`, 0) }
      : {}),
    ...(raw.boundToParameter !== undefined
      ? { boundToParameter: authoredId(raw.boundToParameter, `${label} boundToParameter`) }
      : {}),
  };
};

const parsePhysicsJoint = (value: unknown, index: number): PhysicsDecl['joints'][number] => {
  const label = `scene.physics joint ${index + 1}`;
  const raw = optionalObject(
    value,
    label,
    "{ id: 'arm', kind: 'revolute', bodyA: 'bobBody', bodyB: null }",
  );
  return {
    id: authoredId(raw.id, `${label} id`),
    kind: assertEnum(raw.kind, JOINT_KIND_LIST, `${label} kind`, 'joint kinds'),
    bodyA: authoredId(raw.bodyA, `${label} bodyA`),
    // `null` anchors the joint to the world; the api reference documents `bodyB?`, so an absent
    // field is the same intent as an explicit null rather than a failure.
    bodyB:
      raw.bodyB === undefined || raw.bodyB === null
        ? null
        : authoredId(raw.bodyB, `${label} bodyB`),
    anchorA: raw.anchorA === undefined ? [0, 0, 0] : vec3(raw.anchorA, `${label} anchorA`),
    anchorB: raw.anchorB === undefined ? [0, 0, 0] : vec3(raw.anchorB, `${label} anchorB`),
    ...(raw.axis !== undefined ? { axis: vec3(raw.axis, `${label} axis`) } : {}),
    ...(raw.limits !== undefined ? { limits: pair(raw.limits, `${label} limits`) } : {}),
    ...(raw.motor !== undefined ? { motor: parsePhysicsMotor(raw.motor, `${label} motor`) } : {}),
    ...(raw.restLength !== undefined
      ? { restLength: boundedNumber(raw.restLength, `${label} restLength`, 0) }
      : {}),
  };
};

const parsePhysicsProbe = (value: unknown, index: number): PhysicsDecl['probes'][number] => {
  const label = `scene.physics probe ${index + 1}`;
  const raw = optionalObject(
    value,
    label,
    "{ id: 'speed', bodyId: 'bobBody', quantity: 'speed', label: 'Speed' }",
  );
  return {
    id: authoredId(raw.id, `${label} id`),
    bodyId: authoredId(raw.bodyId, `${label} bodyId`),
    quantity: assertEnum(
      raw.quantity,
      PHYSICS_QUANTITY_LIST,
      `${label} quantity`,
      'probe quantities',
    ),
    label: boundedText(raw.label, `${label} label`, 64),
  };
};

/** Read an optional array of declaration objects, enforcing the schema's element cap. */
const physicsArray = (value: unknown, label: string, max: number): unknown[] => {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new SceneError(`${label} must be an array.`);
  if (value.length > max) throw new SceneError(`${label} may hold at most ${max} entries.`);
  return value;
};

const PHYSICS_WORLD_DEFAULTS: PhysicsDecl['world'] = {
  gravity: [0, -9.81, 0],
  stepHz: 120,
  substeps: 4,
  deterministic: false,
  seed: 1,
  timeScale: 1,
  grabbable: true,
};

const parsePhysicsWorld = (value: unknown): PhysicsDecl['world'] => {
  if (value === undefined) return { ...PHYSICS_WORLD_DEFAULTS };
  const raw = optionalObject(value, 'scene.physics world', '{ gravity: [0, -9.81, 0] }');
  return {
    gravity: raw.gravity === undefined ? [0, -9.81, 0] : vec3(raw.gravity, 'physics world gravity'),
    stepHz: optionalBoundedNumber(raw.stepHz, 'physics world stepHz', 30, 480) ?? 120,
    substeps:
      raw.substeps === undefined ? 4 : integerIn(raw.substeps, 'physics world substeps', 1, 16),
    deterministic: raw.deterministic === true,
    seed:
      raw.seed === undefined
        ? 1
        : integerIn(raw.seed, 'physics world seed', 0, Number.MAX_SAFE_INTEGER),
    timeScale: optionalBoundedNumber(raw.timeScale, 'physics world timeScale', 0.01, 4) ?? 1,
    grabbable: raw.grabbable !== false,
  };
};

/**
 * Validate a `scene.physics` declaration structurally and return it with the schema's defaults
 * applied, so the manifest carries exactly what a zod round-trip would have produced.
 */
const parsePhysicsDeclaration = (spec: unknown): PhysicsDecl => {
  if (spec !== undefined && (spec === null || typeof spec !== 'object' || Array.isArray(spec))) {
    throw new SceneError('scene.physics expects an object like { bodies: [{ id, partId }] }.');
  }
  const raw = (spec ?? {}) as Record<string, unknown>;
  return {
    world: parsePhysicsWorld(raw.world),
    bodies: physicsArray(raw.bodies, 'scene.physics bodies', 512).map(parsePhysicsBody),
    joints: physicsArray(raw.joints, 'scene.physics joints', 256).map(parsePhysicsJoint),
    probes: physicsArray(raw.probes, 'scene.physics probes', 32).map(parsePhysicsProbe),
  };
};

/**
 * A per-frame handle onto one declared part.
 *
 * The narrow write surface that makes parameter leverage provable: every setter records which channel it
 * touched, so the dry-run sweep in `04` can report "the temperature parameter changes nothing visible" as a
 * fact rather than a suspicion.
 */
export interface PartRef {
  readonly id: string;
  setPosition(x: number, y: number, z: number): void;
  setRotation(x: number, y: number, z: number): void;
  setScale(x: number, y: number, z: number): void;
  setVisible(visible: boolean): void;
  /** Emissive intensity, for the "model as its own instrument" binding. */
  setEmissive(intensity: number): void;
  setOpacity(opacity: number): void;
  setColor(hex: string): void;
  /** Current authored position, so incremental motion can read before it writes. */
  position(): readonly [number, number, number];
  rotation(): readonly [number, number, number];
}

/** What a frame callback receives. Deliberately small: a clock, the parameters, and part handles. */
/** The internal, writable shape of the reused frame context. Callers only ever see `FrameContext`. */
interface MutableFrameContext extends Omit<FrameContext, 'time' | 'dt' | 'paused' | 'probes'> {
  time: number;
  dt: number;
  paused: boolean;
  probes: Readonly<Record<string, number>>;
}

export interface FrameContext {
  /** Seconds since the model started, authored time — unaffected by the render rate (`02` R4). */
  readonly time: number;
  /** Seconds since the previous frame, already clamped by the host so a backgrounded tab cannot jump. */
  readonly dt: number;
  readonly paused: boolean;
  /** Live parameter values by id. */
  readonly params: Readonly<Record<string, number | boolean | string>>;
  /** Physics measurements published by the solver, by probe id (`02` R6). */
  readonly probes: Readonly<Record<string, number>>;
  part(id: string): PartRef;
  /** Publish a derived value so the UI read-out and the motion cannot disagree (`00`). */
  metric(id: string, value: number): void;
  /** Retarget a joint motor while the scene runs (`02` R5). */
  motor(jointId: string, targetVelocity: number): void;
}

/** Registered callbacks, kept in the realm rather than serialised. */
export interface CallbackTable {
  frame: Array<(ctx: FrameContext) => void>;
  parameterChange: Array<(id: string, value: number | boolean | string) => void>;
  select: Array<(partId: string) => void>;
  interactions: Map<string, (partId: string) => void>;
}

/** Which channels each parameter was observed to write, filled by the dry-run sweep. */
export type ObservedWrites = Map<string, Set<string>>;

/**
 * One recorded sweep point: the quantised observable state of the whole model, and the time it
 * was sampled at. Consumers compare points *within the same time* only (see `SWEEP_TIMES` in the
 * audit) — comparing across times would make every time-driven write read as parameter causality.
 */
export interface SweepPoint {
  time: number;
  state: string;
}

/**
 * Decimal places a swept value is rounded to before sweep points are compared.
 *
 * Models are authored in metres, radians, 0–1 opacity and 0–64 emissive intensity, so three
 * decimals puts the change threshold at a millimetre / milliradian / a thousandth of a unit — far
 * below the smallest effect a learner can see (the reference model's subtlest binding moves a
 * channel by ~0.02) and far above the float jitter of recomputing the same expression, which is
 * exactly the band an honest differential sweep must draw its line in.
 */
const SWEEP_QUANTUM_DECIMALS = 3;

/** Quantise one number to the sweep's comparison precision, normalising −0 so it equals 0. */
const quantise = (value: number): number => {
  const scaled = Math.round(value * 10 ** SWEEP_QUANTUM_DECIMALS) / 10 ** SWEEP_QUANTUM_DECIMALS;
  return Object.is(scaled, -0) ? 0 : scaled;
};

interface PartRecord {
  node: PartNode;
  /** Set on any frame that wrote to this part, so the audit can see which parts are actually alive. */
  touchedChannels: Set<string>;
}

/**
 * The scene builder.
 *
 * Holds every declaration the program makes, then emits a validated manifest. One instance per build; disposing
 * it releases the geometry and material caches with it.
 */
export class SceneBuilder {
  readonly geometry = new GeometryFactory();
  readonly materials = new MaterialFactory();

  private readonly parts = new Map<string, PartRecord>();
  private readonly order: string[] = [];
  private readonly parameters = new Map<string, ParameterDecl>();
  private readonly parameterValues = new Map<string, number | boolean | string>();
  private readonly metrics = new Map<string, MetricDecl>();
  private readonly metricValues = new Map<string, number>();
  private readonly motions: MotionDecl[] = [];
  private readonly paths = new Map<string, PathDecl>();
  private readonly interactions: InteractionDecl[] = [];
  private readonly lights: ModelManifest['lights'][number][] = [];
  private readonly shots = new Map<string, ShotDecl>();
  private readonly story: StoryBeat[] = [];
  private readonly quiz: QuizQuestion[] = [];
  /**
   * Model-authored, 3D-anchored labels: a word the learner reads beside the part it names.
   *
   * Kept as a list (order is display order) plus an id set, so a duplicate id is refused the same
   * way a duplicate part id is — a label the viewer cannot key is a label it cannot render.
   */
  private readonly labels: ModelLabel[] = [];
  private readonly labelIds = new Set<string>();
  private readonly components = new Map<string, (ctx: ComponentContext) => void>();
  private readonly warnings: string[] = [];

  private describeCalled = false;
  private name = 'Untitled model';
  private description = '';
  private domain: Domain = 'other';
  private subdomain: string | undefined;
  private pedagogy: Pedagogy | undefined;
  private cameraPose: CameraPose | undefined;
  private cameraLimits: ModelManifest['camera']['limits'] | undefined;
  private environment: ModelManifest['environment'] | undefined;
  private physics: PhysicsDecl | undefined;

  /** The active parent while a component body runs, so `place` can nest without the author passing parents. */
  private parentStack: string[] = [];

  readonly callbacks: CallbackTable = {
    frame: [],
    parameterChange: [],
    select: [],
    interactions: new Map(),
  };

  /** Channels each parameter wrote during a dry run, keyed by parameter id. */
  readonly observedWrites: ObservedWrites = new Map();
  /** The parameter currently being swept, so writes can be attributed to it. */
  private sweepingParameter: string | null = null;

  /**
   * Quantised model state at each sweep point, keyed by parameter id — the evidence the
   * differential sweep compares. A parameter is causally live only if these states differ between
   * points sampled at the same time; write presence alone proves nothing, because a frame
   * callback writes every frame regardless of any parameter's value.
   */
  readonly sweepStates: Map<string, SweepPoint[]> = new Map();

  /**
   * The authored state every sweep point starts from: parameter values, part transforms,
   * visibility, materials, metrics and motor targets, deep-copied at the first sweep call.
   *
   * Restoring it before each point is what makes a point's snapshot a pure function of
   * (parameter value, sample time). Without the restore, incremental frame code
   * (`rotation += rate·dt`) accumulates across points and every parameter looks live — the same
   * false pass the differential sweep exists to remove, arriving through the back door.
   */
  private sweepBaseline: {
    parameterValues: Array<[string, number | boolean | string]>;
    parts: Array<
      [
        string,
        {
          position: [number, number, number];
          rotation: [number, number, number] | undefined;
          scale: [number, number, number];
          visible: boolean;
          /** The authored material reference; sweep-time setters fork copies, so this object is never mutated. */
          material: PartNode['material'];
        },
      ]
    >;
    metrics: Array<[string, number]>;
    motors: Array<[string, number]>;
  } | null = null;

  private authorStart = 0;

  dispose(): void {
    this.geometry.dispose();
    this.materials.dispose();
    this.parts.clear();
    // A part reference closes over its node; with `parts` gone it must not survive.
    this.partRefs.clear();
    this.frameContext = null;
    this.order.length = 0;
    this.parameters.clear();
    this.callbacks.frame.length = 0;
    this.callbacks.parameterChange.length = 0;
    this.callbacks.select.length = 0;
    this.callbacks.interactions.clear();
    this.labels.length = 0;
    this.labelIds.clear();
  }

  // ── Validation helpers ────────────────────────────────────────────────────

  private requireId(value: unknown, what: string): string {
    if (typeof value !== 'string' || !ID_PATTERN.test(value) || value.length > 64) {
      throw new SceneError(
        `${what} must be an id starting with a letter and containing only letters, digits, '_', '.' or '-'. Received ${typeof value === 'string' ? `'${value}'` : typeof value}.`,
      );
    }
    return value;
  }

  private requireText(value: unknown, what: string, max: number): string {
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new SceneError(`${what} must be a non-empty string.`);
    }
    if (value.length > max) {
      this.warnings.push(`${what} was truncated from ${value.length} to ${max} characters.`);
      return value.slice(0, max);
    }
    return value;
  }

  private optionalNumber(value: unknown, what: string): number | undefined {
    if (value === undefined) return undefined;
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new SceneError(`${what} must be a finite number. Received ${String(value)}.`);
    }
    return value;
  }

  private vec3(
    value: unknown,
    what: string,
    fallback?: readonly [number, number, number],
  ): [number, number, number] {
    if (value === undefined && fallback) return [...fallback] as [number, number, number];
    if (!Array.isArray(value) || value.length < 3) {
      throw new SceneError(`${what} must be [x, y, z].`);
    }
    const out: [number, number, number] = [0, 0, 0];
    for (let i = 0; i < 3; i += 1) {
      const component = value[i];
      if (typeof component !== 'number' || !Number.isFinite(component)) {
        throw new SceneError(
          `${what}[${i}] must be a finite number. Received ${String(component)}.`,
        );
      }
      out[i] = component;
    }
    return out;
  }

  /** Register a part, rejecting duplicates and unknown parents. */
  private addPart(node: PartNode): string {
    if (this.parts.has(node.id)) {
      throw new SceneError(
        `Part id '${node.id}' is already used. Every part needs a unique id — append an index when placing repeated parts.`,
      );
    }
    if (this.parts.size >= MAX_PARTS) {
      throw new SceneError(
        `This model declares more than ${MAX_PARTS} parts. Use scene.instances() for repeated geometry instead of one part each.`,
      );
    }
    if (node.parentId !== null && !this.parts.has(node.parentId)) {
      throw new SceneError(
        `Part '${node.id}' names parent '${node.parentId}', which has not been created yet. Declare parents before children.`,
      );
    }
    this.parts.set(node.id, { node, touchedChannels: new Set() });
    this.order.push(node.id);
    return node.id;
  }

  /** Resolve the effective parent: explicit argument, else the enclosing component, else the root. */
  private resolveParent(explicit: unknown, forId: string): string | null {
    if (explicit === null) return null;
    if (typeof explicit === 'string') {
      const parent = this.requireId(explicit, `part '${forId}' parentId`);
      if (!this.parts.has(parent)) {
        throw new SceneError(
          `Part '${forId}' names parent '${parent}', which does not exist. Declare the parent group first.`,
        );
      }
      return parent;
    }
    const enclosing = this.parentStack[this.parentStack.length - 1];
    if (enclosing) return enclosing;
    // The first part declared with no parent becomes the root; later orphans attach to it, because a manifest
    // with two roots cannot be framed or exploded coherently.
    const existingRoot = this.order.find((id) => this.parts.get(id)?.node.parentId === null);
    return existingRoot ?? null;
  }

  private transform(spec: Record<string, unknown>): PartNode['transform'] {
    return {
      position: this.vec3(spec.position, 'position', [0, 0, 0]),
      ...(spec.rotation !== undefined ? { rotation: this.vec3(spec.rotation, 'rotation') } : {}),
      scale:
        spec.scale === undefined
          ? [1, 1, 1]
          : typeof spec.scale === 'number'
            ? [spec.scale, spec.scale, spec.scale]
            : this.vec3(spec.scale, 'scale'),
    };
  }

  private info(spec: unknown, partId: string): PartNode['info'] | undefined {
    if (!spec || typeof spec !== 'object') return undefined;
    const source = spec as Record<string, unknown>;
    if (source.title === undefined) return undefined;
    return {
      title: this.requireText(source.title, `part '${partId}' info.title`, 120),
      ...(typeof source.summary === 'string' && source.summary.trim().length > 0
        ? { summary: source.summary.slice(0, 1200) }
        : {}),
      bullets: Array.isArray(source.bullets)
        ? source.bullets
            .filter((item): item is string => typeof item === 'string')
            .slice(0, 8)
            .map((item) => item.slice(0, 240))
        : [],
      tags: Array.isArray(source.tags)
        ? source.tags
            .filter((item): item is string => typeof item === 'string')
            .slice(0, 12)
            .map((item) => item.slice(0, 32))
        : [],
      facts: Array.isArray(source.facts)
        ? (source.facts as Array<Record<string, unknown>>)
            .filter((fact) => typeof fact?.label === 'string' && typeof fact?.value === 'string')
            .slice(0, 12)
            .map((fact) => ({
              label: String(fact.label).slice(0, 48),
              value: String(fact.value).slice(0, 64),
            }))
        : [],
    };
  }

  /** Record that a channel was written, and attribute it to the parameter being swept, if any. */
  private noteWrite(partId: string, channel: string): void {
    const record = this.parts.get(partId);
    if (record) record.touchedChannels.add(channel);
    if (this.sweepingParameter) {
      const set = this.observedWrites.get(this.sweepingParameter) ?? new Set<string>();
      set.add(channel);
      this.observedWrites.set(this.sweepingParameter, set);
    }
  }

  // ── Dry-run support, used by the audit ────────────────────────────────────

  /**
   * Set a parameter, run the reaction and frame callbacks, and record the *observable state* the
   * point produced — not just which channels were written.
   *
   * The frame dispatch stays (deliberately): many legitimate models drive parameters from inside
   * `onFrame` (`00:206` endorses exactly that), and removing it would false-flag every one of
   * them. What changed is the verdict the audit draws: writes are coincidental evidence (a frame
   * callback writes every frame regardless of parameter values); the *differential* between
   * points' recorded states is the causal proof.
   */
  sweepParameter(id: string, value: number | boolean | string, ctxTime = 0): void {
    if (!this.parameters.has(id)) return;
    this.sweepBaseline ??= this.captureSweepBaseline();
    this.restoreSweepBaseline();
    this.parameterValues.set(id, value);
    this.sweepingParameter = id;
    try {
      for (const callback of this.callbacks.parameterChange) callback(id, value);
      const ctx = this.createFrameContext(ctxTime, 1 / 60, false);
      for (const callback of this.callbacks.frame) callback(ctx);
      const points = this.sweepStates.get(id) ?? [];
      points.push({ time: ctxTime, state: this.sweepStateSignature() });
      this.sweepStates.set(id, points);
    } finally {
      this.sweepingParameter = null;
    }
  }

  /**
   * Restore the authored state after sweeping, so the manifest the audit returns — and anything
   * that inspects the builder afterwards — sees the model as built, not as the last sweep point
   * left it.
   */
  endParameterSweep(): void {
    if (!this.sweepBaseline) return;
    this.restoreSweepBaseline();
  }

  /** Snapshot the authored state the first sweep finds, before any point has mutated it. */
  private captureSweepBaseline() {
    return {
      parameterValues: [...this.parameterValues.entries()],
      parts: this.order.map((id) => {
        const node = (this.parts.get(id) as PartRecord).node;
        return [
          id,
          {
            position: [...node.transform.position] as [number, number, number],
            rotation: node.transform.rotation
              ? ([...node.transform.rotation] as [number, number, number])
              : undefined,
            scale: [...node.transform.scale] as [number, number, number],
            visible: node.visible,
            material: node.material,
          },
        ] as [
          string,
          {
            position: [number, number, number];
            rotation: [number, number, number] | undefined;
            scale: [number, number, number];
            visible: boolean;
            material: PartNode['material'];
          },
        ];
      }),
      metrics: [...this.metricValues.entries()],
      motors: [...this.motorTargets.entries()],
    };
  }

  /** Put the baseline back: parameters, transforms, visibility, materials, metrics, motors. */
  private restoreSweepBaseline(): void {
    if (!this.sweepBaseline) return;
    this.parameterValues.clear();
    for (const [key, value] of this.sweepBaseline.parameterValues)
      this.parameterValues.set(key, value);
    for (const [id, entry] of this.sweepBaseline.parts) {
      const record = this.parts.get(id);
      if (!record) continue;
      record.node.transform.position = [...entry.position];
      record.node.transform.rotation = entry.rotation ? [...entry.rotation] : undefined;
      record.node.transform.scale = [...entry.scale];
      record.node.visible = entry.visible;
      record.node.material = entry.material;
    }
    this.metricValues.clear();
    for (const [key, value] of this.sweepBaseline.metrics) this.metricValues.set(key, value);
    this.motorTargets.clear();
    for (const [key, value] of this.sweepBaseline.motors) this.motorTargets.set(key, value);
  }

  /**
   * Serialise the observable state every part channel a frame callback can write — transform,
   * visibility, material color/emissive/opacity — plus published metrics and motor targets, with
   * numbers quantised. A deterministic string per point is all the comparison needs: same string
   * at every point of one time slice means the swept parameter changed nothing visible.
   */
  private sweepStateSignature(): string {
    const snapshot: unknown[] = [];
    for (const id of this.order) {
      const node = (this.parts.get(id) as PartRecord).node;
      snapshot.push([
        id,
        node.transform.position.map(quantise),
        (node.transform.rotation ?? [0, 0, 0]).map(quantise),
        node.transform.scale.map(quantise),
        node.visible ? 1 : 0,
        node.material?.color ?? null,
        node.material?.emissiveIntensity !== undefined
          ? quantise(node.material.emissiveIntensity)
          : null,
        node.material?.opacity !== undefined ? quantise(node.material.opacity) : null,
      ]);
    }
    snapshot.push([...this.metricValues.entries()].map(([key, value]) => [key, quantise(value)]));
    snapshot.push([...this.motorTargets.entries()].map(([key, value]) => [key, quantise(value)]));
    return JSON.stringify(snapshot);
  }

  /** Run one frame without attributing writes — used to check liveliness. */
  runFrame(time: number, dt = 1 / 60, paused = false): void {
    const ctx = this.createFrameContext(time, dt, paused);
    for (const callback of this.callbacks.frame) callback(ctx);
  }

  /**
   * Publish solver measurements, so `ctx.probes` in the next frame carries what the solver actually
   * did (`02` R6: "numbers on screen and motion on screen must never disagree").
   */
  publishProbes(probes: Readonly<Record<string, number>>): void {
    this.publishedProbes = { ...probes };
  }

  /** Probes from the most recent solver step; read into every frame context. */
  private publishedProbes: Readonly<Record<string, number>> = {};

  /** Parts whose channels were written during any frame — the audit's liveliness evidence. */
  touchedParts(): Map<string, Set<string>> {
    const result = new Map<string, Set<string>>();
    for (const [id, record] of this.parts) {
      if (record.touchedChannels.size > 0) result.set(id, record.touchedChannels);
    }
    return result;
  }

  /**
   * The per-frame context handed to callbacks.
   *
   * Built once and reused, not rebuilt per frame. This used to construct a Proxy and its handler, a
   * `partRefCache` Map, a part-ref factory, the context literal and three method closures on every
   * single frame — and because the cache was created *inside* this method, every `ctx.part(id)` was a
   * guaranteed miss, so each part a model's frame code touched also allocated an object with nine
   * closures of its own. That is roughly 80 allocations per frame, every frame, forever.
   *
   * All of it can be reused safely, because nothing here is per-frame state:
   *
   *   - `params` is a live proxy over `parameterValues`, a Map that outlives every frame;
   *   - `part()` closes over `this`, so its result stays valid as long as the part exists;
   *   - `metric()` and `motor()` write to Maps on `this`.
   *
   * Only `time`, `dt`, `paused` and `probes` vary, so those four fields are assigned per frame and
   * nothing else is touched. A frame now allocates zero objects for the context itself.
   *
   * The part-ref cache is a field rather than a local, and is cleared wherever `parts` is, so a
   * reference can never outlive the node it closes over.
   */
  createFrameContext(time: number, dt: number, paused: boolean): FrameContext {
    const cached = this.frameContext;
    if (cached) {
      cached.time = time;
      cached.dt = dt;
      cached.paused = paused;
      cached.probes = this.publishedProbes;
      return cached;
    }

    // A live proxy rather than a copy: copying every parameter every frame is the exact allocation
    // this method exists to avoid, and a proxy reads the live Map the host writes.
    const params = new Proxy(
      {},
      {
        get: (_target, key: string) => this.parameterValues.get(key),
        has: (_target, key: string) => this.parameterValues.has(key),
        ownKeys: () => [...this.parameterValues.keys()],
        getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true }),
      },
    ) as Readonly<Record<string, number | boolean | string>>;

    const context: MutableFrameContext = {
      time,
      dt,
      paused,
      params,
      probes: this.publishedProbes,
      part: (id: string) => {
        const hit = this.partRefs.get(id);
        if (hit) return hit;
        const made = this.makePartRef(id);
        this.partRefs.set(id, made);
        return made;
      },
      metric: (id: string, value: number) => {
        if (!Number.isFinite(value)) return;
        this.metricValues.set(id, value);
        this.noteWrite('__metrics', 'metric');
      },
      motor: (jointId: string, targetVelocity: number) => {
        if (!Number.isFinite(targetVelocity)) return;
        // Recorded as a physics write; the physics world reads the value on its next step.
        this.motorTargets.set(jointId, targetVelocity);
        this.noteWrite('__physics', 'physics');
      },
    };

    this.frameContext = context;
    return context;
  }

  /** The single reusable frame context; null until the first frame builds it. */
  private frameContext: MutableFrameContext | null = null;
  /** Part references, cached across frames. Cleared with `parts`. */
  private readonly partRefs = new Map<string, PartRef>();

  /** Build one part reference. Hoisted so the closure is created once per part, not once per frame. */
  private makePartRef(id: string): PartRef {
    const record = this.parts.get(id);
    if (!record) {
      throw new SceneError(
        `ctx.part('${id}') does not exist. Check the id matches a part declared during the build.`,
      );
    }
    const node = record.node;
    return {
      id,
      setPosition: (x, y, z) => {
        if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return;
        node.transform.position = [x, y, z];
        this.noteWrite(id, 'transform');
      },
      setRotation: (x, y, z) => {
        if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return;
        node.transform.rotation = [x, y, z];
        this.noteWrite(id, 'transform');
      },
      setScale: (x, y, z) => {
        if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return;
        node.transform.scale = [x, y, z];
        this.noteWrite(id, 'transform');
      },
      setVisible: (visible) => {
        node.visible = !!visible;
        this.noteWrite(id, 'visibility');
      },
      setEmissive: (intensity) => {
        if (!Number.isFinite(intensity)) return;
        if (node.material)
          node.material = { ...node.material, emissiveIntensity: clamp(intensity, 0, 64) };
        this.noteWrite(id, 'material');
      },
      setOpacity: (opacity) => {
        if (!Number.isFinite(opacity)) return;
        if (node.material) node.material = { ...node.material, opacity: clamp(opacity, 0, 1) };
        this.noteWrite(id, 'material');
      },
      setColor: (hex) => {
        if (typeof hex !== 'string' || !/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(hex)) return;
        if (node.material) node.material = { ...node.material, color: hex };
        this.noteWrite(id, 'material');
      },
      position: () => node.transform.position,
      rotation: () => node.transform.rotation ?? [0, 0, 0],
    };
  }

  /** Live motor targets, read by the physics world each step (`02` R5: retargetable at runtime). */
  readonly motorTargets = new Map<string, number>();

  /** Current metric values, for the UI read-out. */
  currentMetrics(): Record<string, number> {
    return Object.fromEntries(this.metricValues);
  }

  /** Current parameter values, for the panel and for the manifest's defaults round-trip. */
  currentParameters(): Record<string, number | boolean | string> {
    return Object.fromEntries(this.parameterValues);
  }

  /** Apply a parameter change from the UI, notifying the model's own reaction callbacks. */
  setParameter(id: string, value: number | boolean | string): void {
    if (!this.parameters.has(id)) return;
    this.parameterValues.set(id, value);
    for (const callback of this.callbacks.parameterChange) callback(id, value);
  }

  // ── The facade ────────────────────────────────────────────────────────────

  createFacade(): Readonly<Record<string, unknown>> {
    const facade = {
      /**
       * Declare what the model is and what it teaches.
       *
       * Required. `01`'s design order starts with the concept, and the audit checks the story and parts against
       * the objectives declared here — a model that declares nothing cannot be checked for teaching anything.
       */
      describe: (spec: {
        name: string;
        description: string;
        domain?: Domain;
        subdomain?: string;
        concept: string;
        objectives: string[];
        level?: 'primary' | 'secondary' | 'undergraduate' | 'expert';
        principles?: string[];
        simplifications?: string[];
        relationships?: Array<{ from: string; to: string; kind: string; note?: string }>;
      }): void => {
        this.name = this.requireText(spec?.name, 'describe.name', 120);
        this.description = this.requireText(spec?.description, 'describe.description', 2000);
        this.domain = (spec?.domain ?? 'other') as Domain;
        this.subdomain =
          typeof spec?.subdomain === 'string' ? spec.subdomain.slice(0, 80) : undefined;

        const objectives = Array.isArray(spec?.objectives)
          ? spec.objectives.filter(
              (item): item is string => typeof item === 'string' && item.trim().length > 0,
            )
          : [];
        if (objectives.length === 0) {
          throw new SceneError(
            'describe.objectives must list at least one thing the learner should be able to do after using this model.',
          );
        }

        this.pedagogy = {
          concept: this.requireText(spec?.concept, 'describe.concept', 240),
          objectives: objectives.slice(0, 8).map((item) => item.slice(0, 240)),
          studentLevel: spec?.level ?? 'secondary',
          principles: (spec?.principles ?? [])
            .slice(0, 8)
            .map((item) => String(item).slice(0, 200)),
          simplifications: (spec?.simplifications ?? [])
            .slice(0, 8)
            .map((item) => String(item).slice(0, 240)),
          relationships: (spec?.relationships ?? []).slice(0, 64).map((item) => ({
            from: String(item.from).slice(0, 64),
            to: String(item.to).slice(0, 64),
            kind: String(item.kind).slice(0, 48),
            ...(item.note ? { note: String(item.note).slice(0, 200) } : {}),
          })),
        };
        this.describeCalled = true;
      },

      /**
       * Declare a colour role — the semantic system the learner learns to read (`01`).
       *
       * "After a minute, the learner stops reading labels and starts reading *colour as category* — that is the
       * win."
       */
      colorRole: (spec: { id: string; label: string; color: string; meaning: string }): void => {
        this.materials.declareRole({
          id: this.requireId(spec?.id, 'colorRole.id'),
          label: this.requireText(spec?.label, 'colorRole.label', 48),
          color: spec.color as `#${string}`,
          meaning: this.requireText(spec?.meaning, 'colorRole.meaning', 120),
        });
      },

      /** A container node. Groups should follow function, so selecting a group selects a concept (`01`). */
      group: (spec: {
        id: string;
        name?: string;
        parentId?: string | null;
        position?: unknown;
        rotation?: unknown;
        scale?: unknown;
        group?: string;
      }): string => {
        const id = this.requireId(spec?.id, 'group.id');
        return this.addPart({
          id,
          parentId: this.resolveParent(spec?.parentId, id),
          kind: 'group',
          name: typeof spec?.name === 'string' ? spec.name.slice(0, 120) : id,
          ...(spec?.group ? { group: String(spec.group).slice(0, 64) } : {}),
          transform: this.transform(spec as Record<string, unknown>),
          selectable: false,
          visible: true,
          hero: false,
          staticGeometry: false,
        });
      },

      /** A renderable part. The core declaration: geometry + material + meaning. */
      mesh: (spec: {
        id: string;
        geometry: GeometryHandle;
        material: MaterialHandle;
        name?: string;
        parentId?: string | null;
        position?: unknown;
        rotation?: unknown;
        scale?: unknown;
        group?: string;
        info?: unknown;
        selectable?: boolean;
        visible?: boolean;
        hero?: boolean;
        static?: boolean;
        explodeOffset?: unknown;
      }): string => {
        const id = this.requireId(spec?.id, 'mesh.id');
        const geometryRef = this.geometry.resolve(spec?.geometry);
        if (!geometryRef) {
          throw new SceneError(
            `mesh '${id}' needs a geometry created by a geom.* function. Received ${typeof spec?.geometry}.`,
          );
        }
        const materialRef = this.materials.resolve(spec?.material);
        if (!materialRef) {
          throw new SceneError(
            `mesh '${id}' needs a material created by a mat.* function. Received ${typeof spec?.material}.`,
          );
        }

        return this.addPart({
          id,
          parentId: this.resolveParent(spec?.parentId, id),
          kind: 'mesh',
          name: typeof spec?.name === 'string' ? spec.name.slice(0, 120) : id,
          ...(spec?.group ? { group: String(spec.group).slice(0, 64) } : {}),
          transform: this.transform(spec as Record<string, unknown>),
          geometry: {
            builder: spec.geometry.builder,
            cacheKey: spec.geometry.cacheKey,
            triangles: spec.geometry.triangles,
            vertices: spec.geometry.vertices,
            modifiers: [...spec.geometry.modifiers],
            decimated: false,
            boundingRadius: spec.geometry.boundingRadius,
          },
          material: materialRef,
          ...(this.info(spec?.info, id) ? { info: this.info(spec?.info, id) } : {}),
          selectable: spec?.selectable !== false,
          visible: spec?.visible !== false,
          hero: spec?.hero === true,
          staticGeometry: spec?.static === true,
          ...(spec?.explodeOffset
            ? { explodeOffset: this.vec3(spec.explodeOffset, 'explodeOffset') }
            : {}),
        });
      },

      /**
       * An instanced set: one geometry, many placements, one draw call.
       *
       * The mechanism `00` requires for affordable ambition and `08` prices as "N × geometry cost, 1 × draw
       * call". Placements come from `geom.pattern.*` or from the model's own loop.
       */
      instances: (spec: {
        id: string;
        geometry: GeometryHandle;
        material: MaterialHandle;
        placements: readonly Placement[];
        name?: string;
        parentId?: string | null;
        group?: string;
        info?: unknown;
        selectable?: boolean;
        hero?: boolean;
      }): string => {
        const id = this.requireId(spec?.id, 'instances.id');
        if (!Array.isArray(spec?.placements) || spec.placements.length === 0) {
          throw new SceneError(
            `instances '${id}' needs a non-empty placements array. Use geom.pattern.radial(...) or build one in a loop.`,
          );
        }
        if (spec.placements.length > MAX_INSTANCES_PER_SET) {
          throw new SceneError(
            `instances '${id}' has ${spec.placements.length} placements, over the ${MAX_INSTANCES_PER_SET} limit for one set. Split it into several sets.`,
          );
        }
        const geometryHandle = spec?.geometry;
        const materialRef = this.materials.resolve(spec?.material);
        if (!this.geometry.resolve(geometryHandle) || !materialRef) {
          throw new SceneError(
            `instances '${id}' needs a geometry from geom.* and a material from mat.*.`,
          );
        }

        return this.addPart({
          id,
          parentId: this.resolveParent(spec?.parentId, id),
          kind: 'instances',
          name: typeof spec?.name === 'string' ? spec.name.slice(0, 120) : id,
          ...(spec?.group ? { group: String(spec.group).slice(0, 64) } : {}),
          transform: { position: [0, 0, 0], scale: [1, 1, 1] },
          geometry: {
            builder: geometryHandle.builder,
            cacheKey: geometryHandle.cacheKey,
            triangles: geometryHandle.triangles,
            vertices: geometryHandle.vertices,
            modifiers: [...geometryHandle.modifiers],
            decimated: false,
            boundingRadius: geometryHandle.boundingRadius,
          },
          material: materialRef,
          instances: spec.placements.map((placement) => ({
            transform: {
              position: [...placement.position] as [number, number, number],
              ...(placement.rotation
                ? { rotation: [...placement.rotation] as [number, number, number] }
                : {}),
              scale: placement.scale
                ? ([...placement.scale] as [number, number, number])
                : [1, 1, 1],
            },
            ...(placement.label ? { label: placement.label.slice(0, 64) } : {}),
          })),
          ...(this.info(spec?.info, id) ? { info: this.info(spec?.info, id) } : {}),
          selectable: spec?.selectable !== false,
          visible: true,
          hero: spec?.hero === true,
          staticGeometry: false,
        });
      },

      /** A point cloud — particle fields, electron clouds, star catalogues. */
      points: (spec: {
        id: string;
        geometry: GeometryHandle;
        material: MaterialHandle;
        name?: string;
        parentId?: string | null;
        info?: unknown;
      }): string => {
        const id = this.requireId(spec?.id, 'points.id');
        const materialRef = this.materials.resolve(spec?.material);
        if (!this.geometry.resolve(spec?.geometry) || !materialRef) {
          throw new SceneError(
            `points '${id}' needs a geometry from geom.points and a material from mat.*.`,
          );
        }
        return this.addPart({
          id,
          parentId: this.resolveParent(spec?.parentId, id),
          kind: 'points',
          name: typeof spec?.name === 'string' ? spec.name.slice(0, 120) : id,
          transform: { position: [0, 0, 0], scale: [1, 1, 1] },
          geometry: {
            builder: spec.geometry.builder,
            cacheKey: spec.geometry.cacheKey,
            triangles: 0,
            vertices: spec.geometry.vertices,
            modifiers: [],
            decimated: false,
            boundingRadius: spec.geometry.boundingRadius,
          },
          material: materialRef,
          ...(this.info(spec?.info, id) ? { info: this.info(spec?.info, id) } : {}),
          selectable: false,
          visible: true,
          hero: false,
          staticGeometry: false,
        });
      },

      /**
       * Define a reusable subassembly.
       *
       * `00`'s affordability rule in API form: "an engine with 300 parts is built from a few parameterized
       * definitions, not 300 hand-written blocks." The body receives a context whose `mesh`/`group` calls are
       * automatically parented and id-prefixed, so a component can be placed many times without id collisions.
       */
      defineComponent: (name: string, body: (ctx: ComponentContext) => void): void => {
        const id = this.requireId(name, 'defineComponent name');
        if (typeof body !== 'function') {
          throw new SceneError(`defineComponent('${id}') needs a function body.`);
        }
        this.components.set(id, body);
      },

      /** Place a defined component, prefixing every id inside it. */
      place: (
        component: string,
        spec: {
          id: string;
          parentId?: string | null;
          position?: unknown;
          rotation?: unknown;
          scale?: unknown;
          params?: Record<string, unknown>;
        },
      ): string => {
        const componentName = this.requireId(component, 'place component name');
        const body = this.components.get(componentName);
        if (!body) {
          throw new SceneError(
            `Component '${componentName}' has not been defined. Call scene.defineComponent('${componentName}', ...) first.`,
          );
        }
        const instanceId = this.requireId(spec?.id, 'place.id');

        // The placement's own group node anchors the component, so the whole subassembly moves as one.
        const anchor = this.addPart({
          id: instanceId,
          parentId: this.resolveParent(spec?.parentId, instanceId),
          kind: 'group',
          name: instanceId,
          group: componentName,
          component: componentName,
          transform: this.transform(spec as Record<string, unknown>),
          selectable: false,
          visible: true,
          hero: false,
          staticGeometry: false,
        });

        this.parentStack.push(anchor);
        try {
          body(this.createComponentContext(anchor, instanceId, spec?.params ?? {}));
        } finally {
          this.parentStack.pop();
        }
        return anchor;
      },

      /**
       * Declare a parameter.
       *
       * `00`: "Every user-facing control must visibly and meaningfully change what the model does." The `affects`
       * list is the model's own claim about what it drives; the dry-run sweep verifies it, and a parameter that
       * writes nothing becomes an enumerated deficiency rather than a shipped disappointment.
       */
      param: (spec: Record<string, unknown>): string => {
        const id = this.requireId(spec?.id, 'param.id');
        if (this.parameters.has(id)) {
          throw new SceneError(`Parameter '${id}' is declared twice.`);
        }
        if (this.parameters.size >= 24) {
          throw new SceneError(
            'A model may declare at most 24 parameters; more than that overwhelms the panel.',
          );
        }

        const kind = spec?.kind ?? 'number';
        const label = this.requireText(spec?.label, `param '${id}' label`, 64);
        const affects = Array.isArray(spec?.affects)
          ? (spec.affects as Array<Record<string, unknown>>).slice(0, 64).map((entry) => ({
              ...(typeof entry.partId === 'string' ? { partId: entry.partId } : {}),
              // Validated against the contract's own channel enum: a channel no consumer knows
              // used to reach the manifest as a cast and fail after the generation was paid for.
              channel: assertEnum(
                entry.channel ?? 'transform',
                PARAMETER_CHANNEL_LIST,
                `parameter '${id}' affects entry`,
                'parameter channels',
              ),
            }))
          : [];

        const base = {
          id,
          label,
          ...(typeof spec?.description === 'string'
            ? { description: spec.description.slice(0, 400) }
            : {}),
          ...(typeof spec?.unit === 'string' ? { unit: spec.unit.slice(0, 16) } : {}),
          affects,
          order: this.parameters.size,
        };

        let decl: ParameterDecl;
        if (kind === 'boolean') {
          const value = spec?.default === true;
          decl = { ...base, kind: 'boolean', default: value };
          this.parameterValues.set(id, value);
        } else if (kind === 'color') {
          const value = typeof spec?.default === 'string' ? spec.default : '#ffffff';
          decl = { ...base, kind: 'color', default: value as `#${string}` };
          this.parameterValues.set(id, value);
        } else if (kind === 'choice') {
          const options = Array.isArray(spec?.options)
            ? (spec.options as Array<Record<string, unknown>>)
                .filter((option) => typeof option?.value === 'string')
                .slice(0, 12)
                .map((option) => ({
                  value: String(option.value).slice(0, 48),
                  label: String(option.label ?? option.value).slice(0, 64),
                }))
            : [];
          if (options.length < 2) {
            throw new SceneError(
              `Choice parameter '${id}' needs at least two options; one option is not a control.`,
            );
          }
          const value =
            typeof spec?.default === 'string'
              ? spec.default
              : (options[0] as { value: string }).value;
          decl = { ...base, kind: 'choice', options, default: value };
          this.parameterValues.set(id, value);
        } else {
          const min = this.optionalNumber(spec?.min, `param '${id}' min`) ?? 0;
          const max = this.optionalNumber(spec?.max, `param '${id}' max`) ?? 1;
          if (max <= min) {
            throw new SceneError(
              `Parameter '${id}' has max (${max}) not greater than min (${min}).`,
            );
          }
          const value = clamp(
            this.optionalNumber(spec?.default, `param '${id}' default`) ?? min,
            min,
            max,
          );
          decl = {
            ...base,
            kind: 'number',
            min,
            max,
            default: value,
            scale: spec?.scale === 'log' ? 'log' : 'linear',
            ...(spec?.step !== undefined
              ? { step: this.optionalNumber(spec.step, 'step') as number }
              : {}),
            ...(spec?.precision !== undefined
              ? { precision: clamp(Math.floor(Number(spec.precision)), 0, 6) }
              : {}),
          };
          this.parameterValues.set(id, value);
        }

        this.parameters.set(id, decl);
        return id;
      },

      /** Declare a derived read-out. Values are published from the model's own frame code (`00`). */
      metric: (spec: {
        id: string;
        label: string;
        unit?: string;
        formula?: string;
        precision?: number;
        source?: 'model' | 'physics';
      }): string => {
        const id = this.requireId(spec?.id, 'metric.id');
        this.metrics.set(id, {
          id,
          label: this.requireText(spec?.label, `metric '${id}' label`, 64),
          ...(spec?.unit ? { unit: String(spec.unit).slice(0, 16) } : {}),
          ...(spec?.formula ? { formula: String(spec.formula).slice(0, 200) } : {}),
          precision: clamp(Math.floor(spec?.precision ?? 2), 0, 6),
          source: spec?.source === 'physics' ? 'physics' : 'model',
        });
        return id;
      },

      /**
       * Declare motion.
       *
       * Declared motion is *auditable* motion: a spin whose rate is `{ param: 'rpm' }` can be checked, where an
       * opaque closure cannot. Arbitrary per-frame logic remains available through `onFrame`.
       */
      motion: (spec: Record<string, unknown>): void => {
        const id = this.requireId(spec?.id, 'motion.id');
        const partId = this.requireId(spec?.partId, `motion '${id}' partId`);
        if (!this.parts.has(partId)) {
          throw new SceneError(`motion '${id}' targets part '${partId}', which does not exist.`);
        }
        // The wire enum keeps `follow` and `sequence` for compatibility, but a motion declaration
        // cannot express them: no targetPartId, no states list. Accepting one stored a motion no
        // runtime could apply — a silent no-op wearing the audit's score — so it is refused here,
        // as loudly as a dangling part id.
        const kind = String(spec?.kind ?? 'spin');
        if (kind === 'follow' || kind === 'sequence') {
          throw new SceneError(
            `motion '${id}' uses kind '${kind}', which a motion declaration cannot express. ` +
              `Supported kinds: spin, oscillate, orbit, translate, pulse, flowAlongPath.`,
          );
        }
        // Validated against the contract's own motion enum: only the two unimplementable kinds were
        // refused before, so any other invented kind rode through to manifest validation.
        const motionKind = assertEnum(kind, MOTION_KIND_LIST, `motion '${id}'`, 'motion kinds');
        this.motions.push({
          id,
          partId,
          kind: motionKind,
          axis: this.vec3(spec?.axis, 'motion axis', [0, 1, 0]),
          // The live failure this boundary exists for: `rate: 2` and `rate: 'rpm'` are refused (or
          // coerced) here, where the generator can still fix them, instead of at the audit.
          rate: this.scalarSource(spec?.rate ?? { const: 1 }, `motion '${id}' rate`),
          ...(spec?.amplitude !== undefined
            ? { amplitude: this.scalarSource(spec.amplitude, `motion '${id}' amplitude`) }
            : {}),
          phase: this.optionalNumber(spec?.phase, 'motion phase') ?? 0,
          ...(spec?.center ? { center: this.vec3(spec.center, 'motion center') } : {}),
          ...(spec?.pathId
            ? { pathId: this.requirePathId(String(spec.pathId), `motion '${id}' pathId`) }
            : {}),
          runsWhilePaused: spec?.runsWhilePaused === true,
          ...(typeof spec?.reason === 'string' ? { reason: spec.reason.slice(0, 240) } : {}),
        });
      },

      /** Register a named 3D path: flow lines, orbits, particle routes, camera rails. */
      path: (spec: { id: string; path: PathHandle; visible?: boolean }): string => {
        const id = this.requireId(spec?.id, 'path.id');
        const resolved = this.geometry.resolvePath(spec?.path);
        if (!resolved) {
          throw new SceneError(
            `path '${id}' needs a path created by geom.path() or geom.splinePath().`,
          );
        }
        const points: Array<[number, number, number]> = [];
        for (let i = 0; i < resolved.points.length; i += 3) {
          points.push([
            resolved.points[i] as number,
            resolved.points[i + 1] as number,
            resolved.points[i + 2] as number,
          ]);
        }
        this.paths.set(id, {
          id,
          points,
          closed: resolved.closed,
          visible: spec?.visible === true,
        });
        return id;
      },

      /** Add a light. Augments the default rig rather than replacing it (`00`: never lit flat or pitch black). */
      light: (spec: Record<string, unknown>): void => {
        const id = this.requireId(spec?.id, 'light.id');
        this.lights.push({
          id,
          kind: assertEnum(spec?.kind ?? 'point', LIGHT_KIND_LIST, `light '${id}'`, 'light kinds'),
          color: (typeof spec?.color === 'string' ? spec.color : '#ffffff') as `#${string}`,
          intensity: clamp(this.optionalNumber(spec?.intensity, 'light intensity') ?? 1, 0, 1000),
          ...(spec?.position ? { position: this.vec3(spec.position, 'light position') } : {}),
          ...(spec?.target ? { target: this.vec3(spec.target, 'light target') } : {}),
          ...(spec?.angle !== undefined
            ? { angle: clamp(Number(spec.angle), 0, Math.PI / 2) }
            : {}),
          ...(spec?.penumbra !== undefined ? { penumbra: clamp(Number(spec.penumbra), 0, 1) } : {}),
          ...(spec?.distance !== undefined ? { distance: Math.max(0, Number(spec.distance)) } : {}),
          castShadow: spec?.castShadow === true,
          ...(spec?.boundTo ? { boundToParameter: String(spec.boundTo) } : {}),
        });
      },

      /**
       * Set the opening camera framing.
       *
       * `00`: "every model opens with the full concept in view — the AI author sets the initial camera; auto-frame
       * the bounding sphere is the fallback, never the default answer."
       */
      camera: (spec: {
        position: unknown;
        target?: unknown;
        fov?: number;
        limits?: Record<string, unknown>;
      }): void => {
        this.cameraPose = {
          position: this.vec3(spec?.position, 'camera position'),
          target: this.vec3(spec?.target, 'camera target', [0, 0, 0]),
          fov: clamp(this.optionalNumber(spec?.fov, 'camera fov') ?? 45, 10, 120),
        };
        if (spec?.limits) {
          const limits = spec.limits;
          this.cameraLimits = {
            ...(limits.minDistance !== undefined
              ? { minDistance: Number(limits.minDistance) }
              : {}),
            ...(limits.maxDistance !== undefined
              ? { maxDistance: Number(limits.maxDistance) }
              : {}),
            ...(limits.minPolarAngle !== undefined
              ? { minPolarAngle: Number(limits.minPolarAngle) }
              : {}),
            ...(limits.maxPolarAngle !== undefined
              ? { maxPolarAngle: Number(limits.maxPolarAngle) }
              : {}),
            damping: clamp(Number(limits.damping ?? 0.08), 0, 1),
            autoRotate: limits.autoRotate !== false,
            autoRotateSpeed: clamp(Number(limits.autoRotateSpeed ?? 0.35), -4, 4),
          };
        }
      },

      /** Register a named cinematic shot, replayable from a story beat or an interaction (`00`). */
      shot: (name: string, spec: Record<string, unknown>): void => {
        const id = this.requireId(name, 'shot name');
        // assertShotShape proves kind and easing are contract members and hands them back; the pose
        // is validated against `CameraPose` rather than trusted as an opaque cast.
        const { kind, easing } = assertShotShape(`shot '${id}'`, spec?.kind, spec?.easing);
        const pose = spec?.pose ? this.shotPose(spec.pose, `shot '${id}' pose`) : undefined;
        this.shots.set(id, {
          kind,
          duration: clamp(Number(spec?.duration ?? 1.2), 0, 60),
          easing,
          ...(spec?.targetPartId ? { targetPartId: String(spec.targetPartId) } : {}),
          ...(pose ? { pose } : {}),
          ...(spec?.distance !== undefined ? { distance: Number(spec.distance) } : {}),
          ...(spec?.sweep !== undefined ? { sweep: Number(spec.sweep) } : {}),
          ...(spec?.fov !== undefined ? { fov: clamp(Number(spec.fov), 10, 120) } : {}),
          margin: clamp(Number(spec?.margin ?? 1.35), 1, 4),
        });
      },

      /** Set the backdrop and tone. The engine keeps model contrast in both themes (`00`, `08`). */
      environment: (spec: Record<string, unknown>): void => {
        this.environment = {
          preset: assertEnum(
            spec?.preset ?? 'studio',
            ENVIRONMENT_PRESET_LIST,
            'environment',
            'presets',
          ),
          ...(typeof spec?.backgroundDark === 'string'
            ? { backgroundDark: spec.backgroundDark as `#${string}` }
            : {}),
          ...(typeof spec?.backgroundLight === 'string'
            ? { backgroundLight: spec.backgroundLight as `#${string}` }
            : {}),
          grid: spec?.grid === true,
          exposure: clamp(Number(spec?.exposure ?? 0), -4, 4),
          ...(spec?.fog ? { fog: this.environmentFog(spec.fog, 'environment fog') } : {}),
        };
      },

      /** Declare a story beat. 3–6 beats following the causal arc (`05`). */
      story: (beats: Array<Record<string, unknown>>): void => {
        if (!Array.isArray(beats)) throw new SceneError('scene.story expects an array of beats.');
        for (const beat of beats.slice(0, 12)) {
          const id = this.requireId(beat?.id, 'story beat id');
          const beatShots = Array.isArray(beat?.shots) ? beat.shots.slice(0, 6) : [];
          // Beat shots ride the same ShotDecl schema as named shots, so an invented kind must be
          // refused with the same message the named-shot builder gives — the story path is where
          // the failing `camera.shots.bobClose` came from.
          for (const [index, shot] of beatShots.entries()) {
            const entry = (shot ?? {}) as Record<string, unknown>;
            assertShotShape(`story beat '${id}' shot ${index + 1}`, entry.kind, entry.easing);
          }
          // The view mode is validated against the `StoryBeat` schema's own union and handed back, so
          // a mode the schema would reject fails here rather than at manifest validation.
          const rawViewMode = beat?.viewMode;
          let viewMode: StoryBeat['viewMode'];
          if (rawViewMode !== undefined) {
            const viewModeText = String(rawViewMode);
            if (!enumMember(ViewModeList, viewModeText)) {
              throw new SceneError(
                `story beat '${id}' uses viewMode '${viewModeText}', which is not one of the ` +
                  `platform's view modes. Supported modes: ${ViewModeList.join(', ')}.`,
              );
            }
            viewMode = viewModeText;
          }
          const setParameters = this.storySetParameters(beat?.setParameters, id);
          this.story.push({
            id,
            title: this.requireText(beat?.title, `beat '${id}' title`, 120),
            narration: this.requireText(beat?.narration, `beat '${id}' narration`, 1200),
            ...(beat?.targetPartId ? { targetPartId: String(beat.targetPartId) } : {}),
            shots: beatShots as ShotDecl[],
            ...(setParameters ? { setParameters } : {}),
            ...(beat?.holdSeconds !== undefined
              ? { holdSeconds: clamp(Number(beat.holdSeconds), 1, 60) }
              : {}),
            ...(viewMode !== undefined ? { viewMode } : {}),
          });
        }
      },

      /**
       * Declare quiz questions.
       *
       * `05`'s authored-first rule makes these the primary path: they were written for this exact model, cost
       * nothing to use, and work with the backend down. Unusable questions are dropped here rather than shown.
       */
      quiz: (questions: Array<Record<string, unknown>>): void => {
        if (!Array.isArray(questions))
          throw new SceneError('scene.quiz expects an array of questions.');
        for (const question of questions.slice(0, 20)) {
          const id = this.requireId(question?.id, 'quiz question id');
          const options = Array.isArray(question?.options)
            ? question.options
                .filter((option): option is string => typeof option === 'string')
                .slice(0, 6)
            : [];
          const correctIndex = Number(question?.correctIndex);

          // The canonical failure `05` exists to prevent: "every answer was wrong, including the right one".
          if (
            options.length < 2 ||
            !Number.isInteger(correctIndex) ||
            correctIndex < 0 ||
            correctIndex >= options.length
          ) {
            this.warnings.push(
              `Quiz question '${id}' was dropped: it needs at least two options and a correctIndex inside that range.`,
            );
            continue;
          }

          this.quiz.push({
            id,
            question: this.requireText(question?.question, `question '${id}' text`, 400),
            options: options.map((option) => option.slice(0, 200)),
            correctIndex,
            explanation: this.requireText(
              question?.explanation,
              `question '${id}' explanation`,
              800,
            ),
            difficulty: assertEnum(
              question?.difficulty ?? 'application',
              QUIZ_DIFFICULTY_LIST,
              `quiz question '${id}'`,
              'difficulty levels',
            ),
            ...(question?.evidencePartId
              ? { evidencePartId: String(question.evidencePartId) }
              : {}),
          });
        }
      },

      /** Declare an interaction beyond selection. */
      interaction: (spec: Record<string, unknown>): void => {
        const partId = this.requireId(spec?.partId, 'interaction.partId');
        if (!this.parts.has(partId)) {
          throw new SceneError(`interaction targets part '${partId}', which does not exist.`);
        }
        // A kind the schema rejects used to ride through as `any` and die only at manifest
        // validation — and the documented example itself used 'toggle', which no schema accepts.
        // 'playShot' carries an inline shot, validated with the same refusal as scene.shot.
        const kind = assertInteractionKind(partId, spec?.kind);
        // The inline shot reaches the player straight from the authoring pass, so its fields are
        // validated structurally here rather than copied through as an opaque cast.
        const shot =
          spec?.shot !== undefined && spec.shot !== null
            ? this.interactionShot(
                spec.shot as Record<string, unknown>,
                `interaction shot on part '${partId}'`,
              )
            : undefined;
        this.interactions.push({
          partId,
          on: assertEnum(
            spec?.on ?? 'click',
            INTERACTION_ON_LIST,
            `interaction on part '${partId}'`,
            'trigger events',
          ),
          kind,
          ...(spec?.targetId ? { targetId: String(spec.targetId) } : {}),
          ...(spec?.value !== undefined
            ? { value: assertValueScalar(spec.value, `interaction on part '${partId}' value`) }
            : {}),
          ...(shot ? { shot } : {}),
          ...(spec?.impulse ? { impulse: this.vec3(spec.impulse, 'interaction impulse') } : {}),
          ...(spec?.handlerId ? { handlerId: String(spec.handlerId) } : {}),
          ...(typeof spec?.hint === 'string' ? { hint: spec.hint.slice(0, 160) } : {}),
        });
      },

      /**
       * Register per-frame logic.
       *
       * The escape hatch that keeps the AI a programmer rather than a form-filler: arbitrary state machines,
       * custom motion laws, conditional behaviour. Runs inside the sandbox on the learner's device, receiving
       * capability-scoped handles so every write is attributable.
       */
      onFrame: (callback: (ctx: FrameContext) => void): void => {
        if (typeof callback !== 'function')
          throw new SceneError('scene.onFrame expects a function.');
        if (this.callbacks.frame.length >= 16) {
          throw new SceneError('At most 16 onFrame callbacks; combine them into one function.');
        }
        this.callbacks.frame.push(callback);
      },

      /** React to a parameter change outside the frame loop — for work too expensive to redo every frame. */
      onParameterChange: (
        callback: (id: string, value: number | boolean | string) => void,
      ): void => {
        if (typeof callback !== 'function')
          throw new SceneError('scene.onParameterChange expects a function.');
        this.callbacks.parameterChange.push(callback);
      },

      /** React to a part being selected. */
      onSelect: (callback: (partId: string) => void): void => {
        if (typeof callback !== 'function')
          throw new SceneError('scene.onSelect expects a function.');
        this.callbacks.select.push(callback);
      },

      /** Register a named handler an interaction can invoke. */
      onInteraction: (id: string, callback: (partId: string) => void): void => {
        const handlerId = this.requireId(id, 'onInteraction id');
        if (typeof callback !== 'function')
          throw new SceneError('scene.onInteraction expects a function.');
        this.callbacks.interactions.set(handlerId, callback);
      },

      /** Declare the physics world. Absent means the model animates rather than simulates (`01`). */
      physics: (spec: PhysicsDecl): void => {
        // Validated structurally here rather than through `PhysicsDeclSchema.safeParse`: this runs
        // inside the guest realm, where the sandbox poisons `Function` and zod's parse touches it, so
        // a schema call throws `Function is not available inside the model sandbox`. Normalising at
        // the declaration means every later reader gets the schema's defaults — storing the spec
        // verbatim left `bodies` absent and crashed `computeCost` outright. References to declared
        // parts and parameters are resolved in `toManifest`, once the whole program has run, because
        // a model may declare physics before the parts it names (the physics fixtures do exactly that).
        this.physics = parsePhysicsDeclaration(spec);
      },

      /** Record a non-fatal note for the diagnostics panel. */
      warn: (message: string): void => {
        if (typeof message === 'string' && message.trim().length > 0) {
          this.warnings.push(message.slice(0, 240));
        }
      },

      /**
       * Put a word on the model, beside the part it names.
       *
       * The label is what makes a part self-describing *in place*: `01` requires it, and a name that
       * lives only in a side panel or a hover tooltip is the spatial-contiguity failure Mayer's
       * evidence measures (median 1.10 for words near the picture). A generated model that names its
       * own parts this way is understandable without a click.
       *
       * `id` keys the label (unique, like every authored id); `partId` must name a declared part —
       * checked here, where the generator can still fix it, exactly as `motion`/`story` resolve their
       * references. `offset` lifts the label off the part's own position, in metres.
       */
      label: (spec: { id: string; partId: string; text: string; offset?: unknown }): string => {
        const id = this.requireId(spec?.id, 'label.id');
        if (this.labelIds.has(id)) {
          throw new SceneError(`Label id '${id}' is already used. Every label needs a unique id.`);
        }
        if (this.labels.length >= MAX_LABELS) {
          throw new SceneError(
            `This model declares more than ${MAX_LABELS} labels. A label is a word beside a part, not a paragraph — name the parts the lesson is about.`,
          );
        }
        const partId = this.requireId(spec?.partId, `label '${id}' partId`);
        if (!this.parts.has(partId)) {
          throw new SceneError(
            `label '${id}' names part '${partId}', which does not exist. Declare the part before labelling it.`,
          );
        }
        this.labels.push({
          id,
          partId,
          text: this.requireText(spec?.text, `label '${id}' text`, 64),
          ...(spec?.offset !== undefined
            ? { offset: this.vec3(spec.offset, `label '${id}' offset`) }
            : {}),
        });
        this.labelIds.add(id);
        return id;
      },
    };

    return Object.freeze(facade);
  }

  /** The context a component body receives: parented and id-prefixed automatically. */
  private createComponentContext(
    anchorId: string,
    prefix: string,
    params: Record<string, unknown>,
  ): ComponentContext {
    const facade = this.createFacade() as Record<string, (spec: Record<string, unknown>) => string>;

    const prefixed = (spec: Record<string, unknown>): Record<string, unknown> => ({
      ...spec,
      // Ids are prefixed so the same component can be placed many times without collisions — the whole reason
      // component reuse works for a 300-part assembly.
      id: `${prefix}.${String(spec.id)}`,
      parentId: spec.parentId === undefined ? anchorId : spec.parentId,
    });

    return {
      params,
      anchorId,
      group: (spec) => facade.group?.(prefixed(spec)) as string,
      mesh: (spec) => facade.mesh?.(prefixed(spec)) as string,
      instances: (spec) => facade.instances?.(prefixed(spec)) as string,
      points: (spec) => facade.points?.(prefixed(spec)) as string,
      /** Fully-qualified id of something declared inside this component, for later reference. */
      id: (local: string) => `${prefix}.${local}`,
    };
  }

  // ── Boundary validation for values copied into the manifest ────────────────

  /**
   * Validate an authored scalar source, accepting a bare finite number as the `{ const }` shorthand.
   *
   * The defect this exists for, from a live generation: `scene.motion({ ..., rate: 2 })` — a bare
   * number where the contract wants a `ScalarSource` — survived the static gate, both repair passes
   * and the whole audit, and surfaced only as the terminal `motions.rate: Invalid input`, with no
   * chance to repair. The shorthand is coerced rather than refused because it is what the AI actually
   * writes and the meaning is unambiguous. Two of the four legal shapes name ids, so `param` and
   * `probe` are checked against the ids declared *so far*: a dangling parameter or probe is the same
   * defect class as a dangling part id, and is refused here while the generator can still fix it.
   */
  private scalarSource(value: unknown, label: string): ScalarSource {
    if (isFiniteNumber(value)) return { const: value };
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      const source = value as Record<string, unknown>;
      if ('const' in source) {
        if (!isFiniteNumber(source.const)) {
          throw new SceneError(`${label}: const — expected a finite number.`);
        }
        return { const: source.const };
      }
      if ('param' in source) {
        if (typeof source.param !== 'string') {
          throw new SceneError(scalarSourceRefusal(label, value));
        }
        if (!this.parameters.has(source.param)) {
          throw new SceneError(
            `${label} references parameter '${source.param}', which has not been declared. ` +
              `Declare it with scene.param({ id: '${source.param}', ... }) before this motion.`,
          );
        }
        return {
          param: source.param,
          scale: this.finiteOrDefault(source.scale, 1, `${label} param scale`),
          offset: this.finiteOrDefault(source.offset, 0, `${label} param offset`),
        };
      }
      if ('signal' in source) {
        if (!isScalarSignal(source.signal)) {
          throw new SceneError(
            `${label}: signal — expected one of ${[...SCALAR_SIGNAL_SET]
              .map((name) => `'${name}'`)
              .join(', ')}.`,
          );
        }
        return {
          signal: source.signal,
          scale: this.finiteOrDefault(source.scale, 1, `${label} signal scale`),
        };
      }
      if ('probe' in source) {
        if (typeof source.probe !== 'string') {
          throw new SceneError(scalarSourceRefusal(label, value));
        }
        if (!this.isKnownProbeId(source.probe)) {
          throw new SceneError(
            `${label} references probe '${source.probe}', which no declared physics probe publishes. ` +
              `Declare it in scene.physics({ probes: [{ id: '${source.probe}', bodyId, quantity, label }] }).`,
          );
        }
        return {
          probe: source.probe,
          scale: this.finiteOrDefault(source.scale, 1, `${label} probe scale`),
          offset: this.finiteOrDefault(source.offset, 0, `${label} probe offset`),
        };
      }
    }
    throw new SceneError(scalarSourceRefusal(label, value));
  }

  /** Read an optional finite number, falling back to the contract default when the field is absent. */
  private finiteOrDefault(value: unknown, fallback: number, label: string): number {
    if (value === undefined) return fallback;
    if (isFiniteNumber(value)) return value;
    throw new SceneError(`${label} must be a finite number when present.`);
  }

  /** Whether a `{ probe }` source names a physics probe the model actually declared (`02` R6). */
  private isKnownProbeId(probe: string): boolean {
    return (this.physics?.probes ?? []).some((decl) => decl.id === probe);
  }

  /** Refuse a motion path id that names no declared `scene.path`, the way a part id is refused. */
  private requirePathId(value: string, label: string): string {
    if (!this.paths.has(value)) {
      const known = [...this.paths.keys()];
      throw new SceneError(
        `${label} names path '${value}', which has not been declared. ` +
          `Declare it with scene.path({ id: '${value}', path: geom.path([...]) }) before this motion.` +
          (known.length > 0 ? ` Declared paths: ${known.join(', ')}.` : ''),
      );
    }
    return value;
  }

  /**
   * Resolve a physics declaration's cross-references once every part and parameter is known.
   *
   * Deferred from `scene.physics` because a model may declare physics before the parts and parameters
   * it names — the platform's own physics fixtures do — so a "declared so far" check there would
   * refuse legal programs. A dangling reference is the same defect class as a dangling part id:
   * refused here, at the end of the authoring pass, minutes before the audit would have.
   */
  private validatePhysicsReferences(): void {
    const physics = this.physics;
    if (!physics) return;

    const bodyIds = new Set(physics.bodies.map((body) => body.id));
    for (const body of physics.bodies) {
      if (!this.parts.has(body.partId)) {
        throw new SceneError(
          `physics body '${body.id}' targets part '${body.partId}', which does not exist. ` +
            `Declare it with scene.mesh({ id: '${body.partId}', ... }) before this body.`,
        );
      }
    }
    for (const joint of physics.joints) {
      if (!bodyIds.has(joint.bodyA)) {
        throw new SceneError(
          `physics joint '${joint.id}' names bodyA '${joint.bodyA}', which no declared body has. ` +
            `Declare it in scene.physics({ bodies: [...] }) first.`,
        );
      }
      if (joint.bodyB !== null && !bodyIds.has(joint.bodyB)) {
        throw new SceneError(
          `physics joint '${joint.id}' names bodyB '${joint.bodyB}', which no declared body has ` +
            `(use null to anchor the joint to the world).`,
        );
      }
      const boundTo = joint.motor?.boundToParameter;
      if (boundTo !== undefined && !this.parameters.has(boundTo)) {
        throw new SceneError(
          `physics joint '${joint.id}' motor is bound to parameter '${boundTo}', which has not been declared. ` +
            `Declare it with scene.param({ id: '${boundTo}', ... }) first.`,
        );
      }
    }
    for (const probe of physics.probes) {
      if (!bodyIds.has(probe.bodyId)) {
        throw new SceneError(
          `physics probe '${probe.id}' names body '${probe.bodyId}', which no declared body has. ` +
            `Declare it in scene.physics({ bodies: [...] }) first.`,
        );
      }
    }
  }

  /**
   * Validate an authored camera pose structurally against the contract's partial `CameraPose`. A pose
   * that survives here is one the realizer can apply; a malformed one used to reach the manifest as a
   * cast and fail at validation, after the generation was paid for.
   */
  private shotPose(value: unknown, label: string): NonNullable<ShotDecl['pose']> {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new SceneError(poseRefusal(label, 'pose', 'expected an object'));
    }
    const raw = value as Record<string, unknown>;
    const pose: NonNullable<ShotDecl['pose']> = {};
    for (const key of ['position', 'target', 'up'] as const) {
      const component = raw[key];
      if (component === undefined) continue;
      if (!isVec3(component)) {
        throw new SceneError(poseRefusal(label, key, 'expected three finite numbers'));
      }
      pose[key] = component;
    }
    if (raw.fov !== undefined) {
      if (!isFiniteNumber(raw.fov) || raw.fov < 10 || raw.fov > 120) {
        throw new SceneError(poseRefusal(label, 'fov', 'expected degrees between 10 and 120'));
      }
      pose.fov = raw.fov;
    }
    return pose;
  }

  /**
   * Validate an authored inline shot structurally against the contract's `ShotDecl`, filling the
   * defaults the schema declares. `kind` and `easing` are proven by `assertShotShape` first, so an
   * omitted one takes its documented default rather than failing.
   */
  private interactionShot(value: Record<string, unknown>, label: string): ShotDecl {
    const { kind, easing } = assertShotShape(label, value.kind, value.easing);
    return {
      kind,
      duration: this.boundedShotNumber(value.duration, 1.2, 0, 60, label, 'duration'),
      easing,
      ...(value.targetPartId !== undefined
        ? { targetPartId: this.shotId(value.targetPartId, label, 'targetPartId') }
        : {}),
      ...(value.pose !== undefined ? { pose: this.shotPose(value.pose, `${label} pose`) } : {}),
      ...(value.distance !== undefined
        ? { distance: this.finiteShotNumber(value.distance, label, 'distance') }
        : {}),
      ...(value.sweep !== undefined
        ? { sweep: this.finiteShotNumber(value.sweep, label, 'sweep') }
        : {}),
      ...(value.fov !== undefined
        ? { fov: this.boundedShotNumber(value.fov, 45, 10, 120, label, 'fov') }
        : {}),
      margin: this.boundedShotNumber(value.margin, 1.35, 1, 4, label, 'margin'),
    };
  }

  /** Read a bounded finite number for an authored shot, or throw naming the field and its range. */
  private boundedShotNumber(
    value: unknown,
    fallback: number,
    min: number,
    max: number,
    label: string,
    field: string,
  ): number {
    if (value === undefined) return fallback;
    if (!isFiniteNumber(value) || value < min || value > max) {
      throw new SceneError(
        `${label}: ${field} — expected a finite number between ${min} and ${max}.`,
      );
    }
    return value;
  }

  /** Read an unbounded finite number for an authored shot. */
  private finiteShotNumber(value: unknown, label: string, field: string): number {
    if (!isFiniteNumber(value)) {
      throw new SceneError(`${label}: ${field} — expected a finite number.`);
    }
    return value;
  }

  /** Read an authored id for a shot field, matching the contract's `AuthoredId` shape. */
  private shotId(value: unknown, label: string, field: string): string {
    if (typeof value !== 'string' || !ID_PATTERN.test(value)) {
      throw new SceneError(`${label}: ${field} — expected an id like 'partId'.`);
    }
    return value;
  }

  /**
   * Validate an authored fog block structurally against the contract's `EnvironmentDecl.fog`. The
   * bounds and the hex pattern mirror the contract rather than restating the schema call.
   */
  private environmentFog(
    value: unknown,
    label: string,
  ): NonNullable<ModelManifest['environment']['fog']> {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new SceneError(fogRefusal(label, 'fog', 'expected an object'));
    }
    const raw = value as Record<string, unknown>;
    if (typeof raw.color !== 'string' || !HEX_COLOR_PATTERN.test(raw.color)) {
      throw new SceneError(fogRefusal(label, 'color', "expected '#rgb' or '#rrggbb'"));
    }
    if (!isFiniteNumber(raw.near) || raw.near < 0) {
      throw new SceneError(fogRefusal(label, 'near', 'expected a non-negative number'));
    }
    if (!isFiniteNumber(raw.far) || raw.far < 0) {
      throw new SceneError(fogRefusal(label, 'far', 'expected a non-negative number'));
    }
    return { color: raw.color as `#${string}`, near: raw.near, far: raw.far };
  }

  /**
   * Validate a beat's parameter writes: each key must name a declared parameter and each value one
   * of the scalars the manifest accepts. A dangling key or an object value used to ride through as a
   * cast and fail at manifest validation, after the generation was paid for.
   */
  private storySetParameters(
    value: unknown,
    beatId: string,
  ): Record<string, number | boolean | string> | undefined {
    if (value === undefined) return undefined;
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new SceneError(
        `story beat '${beatId}' setParameters must be an object of parameter ids to values.`,
      );
    }
    const result: Record<string, number | boolean | string> = {};
    for (const [paramId, rawValue] of Object.entries(value as Record<string, unknown>)) {
      if (!this.parameters.has(paramId)) {
        throw new SceneError(
          `story beat '${beatId}' sets parameter '${paramId}', which has not been declared. ` +
            `Declare it with scene.param({ id: '${paramId}', ... }) first.`,
        );
      }
      result[paramId] = assertValueScalar(
        rawValue,
        `story beat '${beatId}' setParameters['${paramId}']`,
      );
    }
    return result;
  }

  // ── Manifest emission ─────────────────────────────────────────────────────

  beginTiming(): void {
    this.authorStart = Date.now();
  }

  /**
   * Emit the manifest.
   *
   * Every check that would otherwise become a confusing render-time failure happens here: a model with no parts,
   * a story beat pointing at a part that no longer exists, a motion on a deleted part. `04`'s audit consumes the
   * result, so a fault detected here becomes an enumerated instruction rather than a blank canvas.
   */
  toManifest(): ModelManifest {
    if (!this.describeCalled || !this.pedagogy) {
      throw new SceneError(
        'The model never called scene.describe({ name, description, concept, objectives }). Declare what the model teaches before building it.',
      );
    }
    if (this.parts.size === 0) {
      throw new SceneError(
        'The model declared no parts. A scene with no geometry cannot teach anything.',
      );
    }

    // Every part and parameter is now declared, so the physics declaration's cross-references can be
    // resolved. A dangling one is a hard refusal, not a warning: a body bound to a part that does not
    // exist is a solver that silently does nothing.
    this.validatePhysicsReferences();

    const nodes = this.order.map((id) => (this.parts.get(id) as PartRecord).node);

    // Dangling story targets are downgraded to warnings rather than errors: `05` requires one bad target to skip
    // its camera move, not to kill the tour.
    for (const beat of this.story) {
      if (beat.targetPartId && !this.parts.has(beat.targetPartId)) {
        this.warnings.push(
          `Story beat '${beat.id}' targets part '${beat.targetPartId}', which does not exist; its camera move will be skipped.`,
        );
      }
    }

    const cost = this.computeCost(nodes);

    return {
      formatVersion: 1,
      name: this.name,
      description: this.description,
      domain: this.domain,
      ...(this.subdomain ? { subdomain: this.subdomain } : {}),
      pedagogy: this.pedagogy,
      parts: nodes,
      labels: this.labels,
      colorRoles: this.materials.declaredRoles().map((role) => ({
        id: role.id,
        label: role.label,
        color: role.color,
        meaning: role.meaning,
      })),
      lights: this.lights,
      environment: this.environment ?? {
        preset: 'studio',
        grid: false,
        exposure: 0,
      },
      camera: {
        // The authored pose is required by `00`; auto-framing is the fallback the realizer applies when absent.
        initial: this.cameraPose ?? this.deriveCamera(nodes),
        limits: this.cameraLimits ?? {
          damping: 0.08,
          autoRotate: true,
          autoRotateSpeed: 0.35,
        },
        shots: Object.fromEntries(this.shots),
      },
      parameters: [...this.parameters.values()],
      metrics: [...this.metrics.values()],
      motions: this.motions,
      paths: [...this.paths.values()],
      interactions: this.interactions,
      ...(this.physics ? { physics: this.physics } : {}),
      story: this.story,
      quiz: this.quiz,
      cost,
      callbacks: {
        hasFrame: this.callbacks.frame.length > 0,
        hasParameterChange: this.callbacks.parameterChange.length > 0,
        interactionHandlers: [...this.callbacks.interactions.keys()],
        metricComputers: [...this.metrics.keys()],
      },
      warnings: [...this.warnings, ...this.geometry.warnings, ...this.materials.warnings].slice(
        0,
        64,
      ),
      createdAt: Date.now(),
    };
  }

  /** Measure the build. Every number comes from the declarations, not from an estimate (`08`). */
  private computeCost(nodes: PartNode[]): BuildCost {
    const geometryKeys = new Set<string>();
    const materialKeys = new Set<string>();
    let triangles = 0;
    let vertices = 0;
    let drawCalls = 0;
    let instancedSets = 0;
    let instances = 0;

    for (const node of nodes) {
      if (node.material) materialKeys.add(node.material.cacheKey);
      if (!node.geometry) continue;
      geometryKeys.add(node.geometry.cacheKey);

      if (node.kind === 'instances') {
        const count = node.instances?.length ?? 0;
        instancedSets += 1;
        instances += count;
        // The whole point of instancing: N × geometry cost, 1 × draw call (`08`).
        triangles += node.geometry.triangles * count;
        vertices += node.geometry.vertices;
        drawCalls += 1;
        continue;
      }

      triangles += node.geometry.triangles;
      vertices += node.geometry.vertices;
      drawCalls += 1;
    }

    return {
      parts: nodes.length,
      uniqueGeometries: geometryKeys.size,
      uniqueMaterials: materialKeys.size,
      triangles,
      vertices,
      drawCalls,
      instancedSets,
      instances,
      shadowCastingLights: this.lights.filter((light) => light.castShadow).length,
      physicsBodies: this.physics?.bodies.length ?? 0,
      authorMillis: Math.max(0, Date.now() - this.authorStart),
    };
  }

  /**
   * Fallback camera framing.
   *
   * `00` calls auto-framing "the fallback, never the default answer", so this exists only for models that did not
   * call `scene.camera`. The 2.4× distance and 25° elevation put a typical assembly comfortably in frame from a
   * three-quarter view, which reads as a deliberate product shot rather than an axis-aligned diagram.
   */
  private deriveCamera(nodes: PartNode[]): CameraPose {
    let radius = 1;
    for (const node of nodes) {
      const nodeRadius = node.geometry?.boundingRadius ?? 0;
      const distance = Math.hypot(...node.transform.position) + nodeRadius;
      if (distance > radius) radius = distance;
    }
    const distance = radius * 2.4;
    const elevation = 25 * (Math.PI / 180);
    this.warnings.push(
      'The model did not set an opening camera, so the view was auto-framed. Call scene.camera({ position, target }) to frame the concept deliberately.',
    );
    return {
      position: [
        distance * Math.cos(elevation) * 0.7,
        distance * Math.sin(elevation),
        distance * Math.cos(elevation) * 0.7,
      ],
      target: [0, 0, 0],
      fov: 45,
    };
  }
}

/** What a component body receives. Ids are prefixed and parents wired automatically. */
export interface ComponentContext {
  readonly params: Record<string, unknown>;
  readonly anchorId: string;
  group(spec: Record<string, unknown>): string;
  mesh(spec: Record<string, unknown>): string;
  instances(spec: Record<string, unknown>): string;
  points(spec: Record<string, unknown>): string;
  id(local: string): string;
}
