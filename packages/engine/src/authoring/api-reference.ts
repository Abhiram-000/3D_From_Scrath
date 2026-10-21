/**
 * The authored API reference: *how to call* every member of the guest API.
 *
 * `buildApiSurface()` (api-surface.ts) reflects over the live facades and is the source of truth for
 * *what exists* — the static gate checks calls against it, and the gate must never be widened or
 * narrowed by documentation. But runtime reflection cannot recover TypeScript parameter types, so
 * this table carries the other half of the contract: the call shape, what it is for, and a minimal
 * correct call. `00-GOAL.md:134` names why this table exists: the contract must be in the prompt,
 * "because the model cannot follow rules it was never told" — a prompt carrying bare names produced
 * invented argument shapes that the gate rejected as `unknown_api`, and a repair prompt re-sending
 * the same name-only list just had the model guess again.
 *
 * Every entry below was written by reading the facade implementations — `geometry/factory.ts`
 * (`geom`), `authoring/scene.ts` (`scene`), `materials/factory.ts` (`mat`), `math/index.ts` (`M`),
 * `geometry/patterns.ts` (`geom.pattern`) and the host-provided `console`/`random` in
 * `authoring/guest.ts`. The signatures state required vs optional (`?`) and reflect the *validation
 * branches*, not the TypeScript annotations: `requireFinite`/`requireVec3`/`clampSegments` and the
 * `SceneError` throws are the real contract, because those are the branches a generated program
 * actually hits.
 *
 * Drift is impossible in either direction because `tests/api-reference.test.ts` welds this table to
 * the reflective surface: every surface member must have an entry, and every entry must name a real
 * member. A builder added to the engine without documentation fails the build; documentation for a
 * removed builder fails the build.
 *
 * The same discipline applies to the closed vocabularies the table spells out: the shot-kind,
 * shot-easing and interaction-kind unions are rendered from the frozen zod enums in `@edu3d/contracts`
 * (`presentation.ts` / `behavior.ts`) rather than retyped — a hand-maintained union once taught the
 * model `sweep` and `closeUp`, kinds no schema accepted, and following that documentation lost real
 * generations to `camera.shots.<id>.kind: Invalid option`. The weld test covers the table entries
 * against the same enums, in both directions, so neither side can move alone.
 *
 * This module is pure data — its only imports are the contract enums it renders, no DOM, no engine
 * code — so the server can import it into prompt assembly and the whole table stays tree-shakeable,
 * printable and diffable.
 */

import {
  BodyKind,
  InteractionKind,
  JointKind,
  LightKind,
  ShotEasing,
  ShotKind,
  StoryBeat as StoryBeatSchema,
} from '@edu3d/contracts';

/** Quoted unions rendered from the contract enums — the table must not retype what the schema owns. */
const SHOT_KIND_UNION = ShotKind.options.map((kind) => `'${kind}'`).join('|');
const SHOT_EASING_UNION = ShotEasing.options.map((curve) => `'${curve}'`).join('|');
const INTERACTION_KIND_UNION = InteractionKind.options.map((kind) => `'${kind}'`).join('|');
/**
 * Rendered for the same reason the shot unions are. This one was retyped by hand and drifted: the
 * signature taught `'area'` — a kind `LightKind` has never accepted — while omitting `ambient`,
 * `hemisphere` and `rect`, so a model that copied the documentation was refused at authoring (and,
 * before the authoring boundary learned to refuse it, died minutes later on manifest validation).
 */
const LIGHT_KIND_UNION = LightKind.options.map((kind) => `'${kind}'`).join('|');
/**
 * The physics vocabularies, rendered for the same reason. This signature taught a body kind
 * `'static'` that `BodyKind` has never accepted (`fixed` is the word), so a model copying the
 * documentation could not declare a static body at all — and a wrong enum in the prompt costs a
 * generation, which is the most expensive bug this table can have.
 */
const BODY_KIND_UNION = BodyKind.options.map((kind) => `'${kind}'`).join('|');
const JOINT_KIND_UNION = JointKind.options.map((kind) => `'${kind}'`).join('|');
const VIEW_MODE_UNION = StoryBeatSchema.shape.viewMode
  .unwrap()
  .options.map((mode) => `'${mode}'`)
  .join('|');

/** One reference entry: the call shape, the purpose, and a copy-pasteable correct call. */
export interface ApiReferenceEntry {
  /**
   * The call shape with argument names and types, starting with the qualified name —
   * e.g. `gear({ teeth: number, module: number, thickness: number, bore?: number }): GeometryHandle`.
   * Required fields carry types; useful optionals carry `?`; rarely-load-bearing ones are elided
   * with `…`. Types are spelled in the notation a model writes: `[x,y,z]` for vectors, radians
   * stated where a value is an angle.
   */
  signature: string;
  /** One line: what it is for, in the vocabulary of a model author choosing between builders. */
  summary: string;
  /** A minimal correct call, copy-pasteable into a generated program. */
  example: string;
}

/**
 * The table, keyed by qualified member name exactly as `apiSurfaceSet()` spells it.
 *
 * Ordering inside each namespace block is alphabetical by member, matching the renderer, so the
 * file reads the way the prompt renders and a missing entry is easy to spot in a diff.
 */
export const API_REFERENCE: Readonly<Record<string, ApiReferenceEntry>> = Object.freeze({
  // ── console: host-provided, bounded ────────────────────────────────────────
  'console.log': {
    signature: 'console.log(...values: any): void',
    summary:
      'Debug logging to the diagnostics panel (capped at 200 entries); the only console you have.',
    example: "console.log('bob angle', theta)",
  },
  'console.warn': {
    signature: 'console.warn(...values: any): void',
    summary: 'Non-fatal warning to the diagnostics panel; use for states a learner could mistake.',
    example: "console.warn('ratio below 1', ratio)",
  },
  'console.error': {
    signature: 'console.error(...values: any): void',
    summary: 'Error-level log to the diagnostics panel; never throws, never stops the build.',
    example: "console.error('unexpected', value)",
  },

  // ── random: host-provided, seeded (deterministic per build) ────────────────
  'random.float': {
    signature: 'random.float(): number',
    summary:
      'Uniform pseudo-random number in [0, 1). Seeded per build, so a model is reproducible.',
    example: 'var jitter = (random.float() - 0.5) * 0.01',
  },
  'random.range': {
    signature: 'random.range(min: number, max: number): number',
    summary: 'Uniform pseudo-random number in [min, max).',
    example: 'var height = random.range(0.2, 0.6)',
  },
  'random.int': {
    signature: 'random.int(min: number, max: number): number',
    summary: 'Pseudo-random integer, both ends inclusive.',
    example: 'var variant = random.int(0, 2)',
  },
  'random.pick': {
    signature: 'random.pick(items: any[]): any',
    summary: 'One element chosen pseudo-randomly; undefined for an empty array.',
    example: "var tone = random.pick(['#c8a04f', '#8a8f96', '#5b93c9'])",
  },
  'random.unitVector': {
    signature: 'random.unitVector(): [x, y, z]',
    summary:
      'Uniformly distributed direction on the unit sphere (no corner bias) — scatter of directions, not positions.',
    example: 'var dir = random.unitVector()',
  },

  // ── M: pure math. Constants first, then functions, alphabetical within groups ──
  'M.PI': {
    signature: 'M.PI: number = 3.141592653589793',
    summary: 'π — radians in a half turn (use TAU for a full turn).',
    example: 'M.sin(M.PI / 2)',
  },
  'M.TAU': {
    signature: 'M.TAU: number = 6.283185307179586',
    summary:
      '2π — radians in one full revolution (a complete turn); the natural modulus for any rotation.',
    example: 'M.wrap(angle, M.TAU)',
  },
  'M.HALF_PI': {
    signature: 'M.HALF_PI: number = 1.5707963267948966',
    summary: 'π/2 — radians in a quarter turn (a right angle).',
    example: 'M.remap(t, 0, 1, -M.HALF_PI, M.HALF_PI)',
  },
  'M.DEG': {
    signature: 'M.DEG: number = 0.017453292519943295',
    summary: 'Multiply degrees by this to get radians (π/180).',
    example: 'var pitch = 15 * M.DEG',
  },
  'M.RAD': {
    signature: 'M.RAD: number = 57.29577951308232',
    summary: 'Multiply radians by this to get degrees (180/π).',
    example: 'var degrees = theta * M.RAD',
  },
  'M.GRAVITY': {
    signature: 'M.GRAVITY: number = 9.80665',
    summary: 'Standard gravity, m/s² (the same default the physics world uses).',
    example: 'var weight = mass * M.GRAVITY',
  },
  'M.GOLDEN_ANGLE': {
    signature: 'M.GOLDEN_ANGLE: number = 2.399963229728653',
    summary: 'The golden angle in radians (≈137.5°) — even packing for phyllotaxis and spirals.',
    example: 'var angle = i * M.GOLDEN_ANGLE',
  },
  'M.E': {
    signature: 'M.E: number = 2.718281828459045',
    summary: "Euler's number (the base of natural growth and decay).",
    example: 'M.pow(M.E, -damping * t)',
  },
  'M.SQRT2': {
    signature: 'M.SQRT2: number = 1.4142135623730951',
    summary: '√2 (a unit square’s diagonal).',
    example: 'var diagonal = side * M.SQRT2',
  },
  'M.abs': {
    signature: 'M.abs(x: number): number',
    summary: 'Absolute value.',
    example: 'M.abs(-2)',
  },
  'M.acos': {
    signature: 'M.acos(x: number): number',
    summary: 'Inverse cosine in radians; input clamped conceptually to [-1, 1].',
    example: 'M.acos(0.5)',
  },
  'M.add': {
    signature: 'M.add(a: [x,y,z], b: [x,y,z]): [x,y,z]',
    summary: 'Component-wise vector addition.',
    example: 'M.add([1, 0, 0], [0, 1, 0])',
  },
  'M.angleDelta': {
    signature: 'M.angleDelta(from: number, to: number): number',
    summary: 'Shortest signed angular difference in radians — never the long way round.',
    example: 'M.angleDelta(current, target)',
  },
  'M.asin': {
    signature: 'M.asin(x: number): number',
    summary: 'Inverse sine in radians.',
    example: 'M.asin(0.5)',
  },
  'M.atan': {
    signature: 'M.atan(x: number): number',
    summary: 'Inverse tangent in radians.',
    example: 'M.atan(1)',
  },
  'M.atan2': {
    signature: 'M.atan2(y: number, x: number): number',
    summary: 'Angle of the point (x, y) — yaw from a direction vector.',
    example: 'M.atan2(dir[0], dir[2])',
  },
  'M.cbrt': {
    signature: 'M.cbrt(x: number): number',
    summary: 'Cube root — the correct scale factor when volume is the conserved quantity.',
    example: 'M.cbrt(volume)',
  },
  'M.ceil': {
    signature: 'M.ceil(x: number): number',
    summary: 'Round up to the nearest integer.',
    example: 'M.ceil(2.1)',
  },
  'M.clamp': {
    signature: 'M.clamp(value: number, min: number, max: number): number',
    summary: 'Constrain to [min, max].',
    example: 'M.clamp(t, 0, 1)',
  },
  'M.compose': {
    signature: 'M.compose(translation: [x,y,z], rotation: [rx,ry,rz], scale: [x,y,z]): Mat4',
    summary:
      'Column-major 4×4 from translation, XYZ Euler rotation (radians) and scale — matches the renderer exactly.',
    example: 'M.compose([0, 1, 0], [0, M.HALF_PI, 0], [1, 1, 1])',
  },
  'M.cos': {
    signature: 'M.cos(x: number): number',
    summary: 'Cosine of an angle in radians.',
    example: 'M.cos(angle)',
  },
  'M.cosh': {
    signature: 'M.cosh(x: number): number',
    summary: 'Hyperbolic cosine.',
    example: 'M.cosh(1)',
  },
  'M.createRandom': {
    signature:
      'M.createRandom(seed: number): { float(), range(min, max), int(min, max), pick(items), unitVector() }',
    summary:
      'Your own seeded generator, for scatter that must stay stable across a single run of a loop.',
    example: 'var rng = M.createRandom(42)',
  },
  'M.cross': {
    signature: 'M.cross(a: [x,y,z], b: [x,y,z]): [x,y,z]',
    summary: 'Cross product — the normal of the plane spanned by a and b.',
    example: 'M.cross([1, 0, 0], [0, 1, 0])',
  },
  'M.deg': {
    signature: 'M.deg(radians: number): number',
    summary: 'Convert radians to degrees.',
    example: 'M.deg(M.HALF_PI)',
  },
  'M.distance': {
    signature: 'M.distance(a: [x,y,z], b: [x,y,z]): number',
    summary: 'Euclidean distance between two points.',
    example: 'M.distance(pressureA, pressureB)',
  },
  'M.dot': {
    signature: 'M.dot(a: [x,y,z], b: [x,y,z]): number',
    summary: 'Dot product — projection of a onto b; zero when perpendicular.',
    example: 'M.dot(force, leverArm)',
  },
  'M.easeBack': {
    signature: 'M.easeBack(t: number): number',
    summary: 'Cubic with elastic overshoot — a mechanism that snaps into place.',
    example: 'M.easeBack(t)',
  },
  'M.easeIn': {
    signature: 'M.easeIn(t: number): number',
    summary: 'Cubic ease-in: slow start, accelerating exit.',
    example: 'M.easeIn(t)',
  },
  'M.easeInOut': {
    signature: 'M.easeInOut(t: number): number',
    summary: 'Cubic ease both ends — the default for camera moves and reveals.',
    example: 'M.easeInOut(t)',
  },
  'M.easeOut': {
    signature: 'M.easeOut(t: number): number',
    summary: 'Cubic ease-out: fast start, settling exit.',
    example: 'M.easeOut(t)',
  },
  'M.exp': {
    signature: 'M.exp(x: number): number',
    summary: 'e to the power x — exponential growth and decay.',
    example: 'M.exp(-k * t)',
  },
  'M.fbm': {
    signature:
      'M.fbm(x: number, y: number, z: number, octaves?: number, persistence?: number): number',
    summary:
      'Fractal value noise in [0, 1] — terrain, bark, corrosion; richer than a single noise3 call.',
    example: 'var roughness = M.fbm(x * 3, y * 3, z * 3, 4)',
  },
  'M.fibonacciSphere': {
    signature: 'M.fibonacciSphere(count: number, radius?: number): [x,y,z][]',
    summary:
      'Evenly spread points on a sphere (no polar clustering) — electron shells, constellations.',
    example: 'var electrons = M.fibonacciSphere(12, 0.4)',
  },
  'M.floor': {
    signature: 'M.floor(x: number): number',
    summary: 'Round down to the nearest integer.',
    example: 'M.floor(2.9)',
  },
  'M.hash1': {
    signature: 'M.hash1(x: number): number',
    summary: 'Deterministic hash to [0, 1) — stable per-position randomness.',
    example: 'M.hash1(i)',
  },
  'M.hash2': {
    signature: 'M.hash2(x: number, y: number): number',
    summary: 'Deterministic 2D hash to [0, 1).',
    example: 'M.hash2(u, v)',
  },
  'M.hash3': {
    signature: 'M.hash3(x: number, y: number, z: number): number',
    summary: 'Deterministic 3D hash to [0, 1).',
    example: 'M.hash3(x, y, z)',
  },
  'M.hypot': {
    signature: 'M.hypot(...values: number[]): number',
    summary: 'Hypotenuse of any number of legs.',
    example: 'M.hypot(3, 4)',
  },
  'M.identity': {
    signature: 'M.identity(): Mat4',
    summary: 'The 4×4 identity matrix.',
    example: 'var m = M.identity()',
  },
  'M.len2': {
    signature: 'M.len2(x: number, y: number): number',
    summary: 'Length of a 2D vector, without allocating one.',
    example: 'M.len2(3, 4)',
  },
  'M.len3': {
    signature: 'M.len3(x: number, y: number, z: number): number',
    summary: 'Length of a 3D vector, without allocating one.',
    example: 'M.len3(1, 2, 2)',
  },
  'M.length': {
    signature: 'M.length(a: [x,y,z]): number',
    summary: 'Vector magnitude.',
    example: 'M.length(velocity)',
  },
  'M.lerp': {
    signature: 'M.lerp(a: number, b: number, t: number): number',
    summary: 'Linear interpolation; t outside [0, 1] extrapolates.',
    example: 'M.lerp(0.2, 0.8, t)',
  },
  'M.lerpVec': {
    signature: 'M.lerpVec(a: [x,y,z], b: [x,y,z], t: number): [x,y,z]',
    summary: 'Component-wise linear interpolation of two vectors.',
    example: 'M.lerpVec(start, end, t)',
  },
  'M.log': {
    signature: 'M.log(x: number): number',
    summary: 'Natural logarithm.',
    example: 'M.log(x)',
  },
  'M.log10': {
    signature: 'M.log10(x: number): number',
    summary: 'Base-10 logarithm — decades for log-scale readings.',
    example: 'M.log10(intensity)',
  },
  'M.log2': {
    signature: 'M.log2(x: number): number',
    summary: 'Base-2 logarithm — octaves and halvings.',
    example: 'M.log2(n)',
  },
  'M.max': {
    signature: 'M.max(...values: number[]): number',
    summary: 'Largest argument.',
    example: 'M.max(1, 2, 3)',
  },
  'M.min': {
    signature: 'M.min(...values: number[]): number',
    summary: 'Smallest argument.',
    example: 'M.min(1, 2, 3)',
  },
  'M.mul': {
    signature: 'M.mul(a: [x,y,z], s: number): [x,y,z]',
    summary: 'Vector × scalar.',
    example: 'M.mul(direction, 2)',
  },
  'M.multiply': {
    signature: 'M.multiply(a: Mat4, b: Mat4): Mat4',
    summary:
      'Matrix product in column-major order: applying `a` then `b` to a point is multiply(b, a).',
    example: 'M.multiply(orient, offset)',
  },
  'M.noise3': {
    signature: 'M.noise3(x: number, y: number, z: number): number',
    summary: 'Continuous value noise in [0, 1] — gentle surface variation.',
    example: 'var n = M.noise3(x * 4, y * 4, z * 4)',
  },
  'M.normalize': {
    signature: 'M.normalize(a: [x,y,z]): [x,y,z]',
    summary: 'Unit-length direction; the zero vector stays zero rather than becoming NaN.',
    example: 'M.normalize([3, 4, 0])',
  },
  'M.orient': {
    signature: 'M.orient(direction: [x,y,z], up?: [x,y,z]): Mat4',
    summary:
      'A rotation that points +Z along `direction` — aiming parts, sweep frames, look-at behaviour.',
    example: 'M.orient(M.normalize(target))',
  },
  'M.phyllotaxis': {
    signature: 'M.phyllotaxis(count: number, spacing?: number): [x, y][]',
    summary: 'Golden-angle disc arrangement in 2D — sunflower packing of rivets or seeds.',
    example: 'var seeds = M.phyllotaxis(40, 0.02)',
  },
  'M.pow': {
    signature: 'M.pow(base: number, exponent: number): number',
    summary: 'Exponentiation.',
    example: 'M.pow(ratio, 2)',
  },
  'M.rad': {
    signature: 'M.rad(degrees: number): number',
    summary: 'Convert degrees to radians.',
    example: 'M.rad(90)',
  },
  'M.remap': {
    signature:
      'M.remap(value: number, inMin: number, inMax: number, outMin: number, outMax: number): number',
    summary:
      'Map a value from one range to another, clamped — the workhorse of parameter-to-behaviour binding.',
    example: 'M.remap(ctx.params.heat, 0, 1, 0.2, 8)',
  },
  'M.rotateAxis': {
    signature: 'M.rotateAxis(v: [x,y,z], axis: [x,y,z], angle: number): [x,y,z]',
    summary: "Rotate a vector about an arbitrary axis by `angle` radians (Rodrigues' formula).",
    example: 'M.rotateAxis(v, [0, 1, 0], M.HALF_PI)',
  },
  'M.round': {
    signature: 'M.round(x: number): number',
    summary: 'Round to the nearest integer.',
    example: 'M.round(2.5)',
  },
  'M.saturate': {
    signature: 'M.saturate(value: number): number',
    summary: 'Clamp to [0, 1].',
    example: 'M.saturate(t)',
  },
  'M.sign': {
    signature: 'M.sign(value: number): number',
    summary: '−1, 0 or +1 (zero maps to zero).',
    example: 'M.sign(delta)',
  },
  'M.sin': {
    signature: 'M.sin(x: number): number',
    summary: 'Sine of an angle in radians.',
    example: 'M.sin(phase)',
  },
  'M.sinh': {
    signature: 'M.sinh(x: number): number',
    summary: 'Hyperbolic sine.',
    example: 'M.sinh(1)',
  },
  'M.smootherstep': {
    signature: 'M.smootherstep(t: number): number',
    summary: 'Quintic smoothstep — zero first and second derivative; for moves that must settle.',
    example: 'M.smootherstep(t)',
  },
  'M.smoothstep': {
    signature: 'M.smoothstep(t: number): number',
    summary: 'Hermite smoothstep in [0, 1] — smooth ends, no snap.',
    example: 'M.smoothstep(t)',
  },
  'M.spherical': {
    signature: 'M.spherical(radius: number, theta: number, phi: number): [x,y,z]',
    summary: 'Spherical to cartesian: theta is azimuth about +Y, phi is polar from +Y (radians).',
    example: 'M.spherical(2, M.rad(45), M.HALF_PI / 2)',
  },
  'M.sqr': {
    signature: 'M.sqr(value: number): number',
    summary: 'Square — squared distances avoid a sqrt you would only undo.',
    example: 'M.sqr(distance)',
  },
  'M.sqrt': {
    signature: 'M.sqrt(x: number): number',
    summary: 'Square root.',
    example: 'M.sqrt(4)',
  },
  'M.sub': {
    signature: 'M.sub(a: [x,y,z], b: [x,y,z]): [x,y,z]',
    summary: 'Component-wise vector subtraction — the vector from b to a.',
    example: 'M.sub(target, origin)',
  },
  'M.tan': {
    signature: 'M.tan(x: number): number',
    summary: 'Tangent of an angle in radians.',
    example: 'M.tan(angle)',
  },
  'M.tanh': {
    signature: 'M.tanh(x: number): number',
    summary: 'Hyperbolic tangent — natural saturation, good for smooth limiting.',
    example: 'M.tanh(drive)',
  },
  'M.trunc': {
    signature: 'M.trunc(x: number): number',
    summary: 'Integer part, toward zero.',
    example: 'M.trunc(-2.7)',
  },
  'M.unlerp': {
    signature: 'M.unlerp(a: number, b: number, value: number): number',
    summary: 'Inverse lerp: where value sits in [a, b] as 0..1; 0 for a degenerate range.',
    example: 'M.unlerp(0, 100, 25)',
  },
  'M.vec2': {
    signature: 'M.vec2(x?: number, y?: number): [x, y]',
    summary: 'A 2D vector, defaulting to origin.',
    example: 'M.vec2(1, 0)',
  },
  'M.vec3': {
    signature: 'M.vec3(x?: number, y?: number, z?: number): [x, y, z]',
    summary: 'A 3D vector, defaulting to origin.',
    example: 'M.vec3(0, 1, 0)',
  },
  'M.wrap': {
    signature: 'M.wrap(value: number, range: number): number',
    summary: 'Wrap into [0, range), correct for negatives — unlike the % operator.',
    example: 'M.wrap(angle, M.TAU)',
  },

  // ── geom: geometry builders, profiles, paths, solid operators, modifiers ────
  'geom.airfoilProfile': {
    signature:
      'geom.airfoilProfile({ chord: number, thickness?: number, camber?: number, camberPosition?: number, segments?: number }): ProfileHandle',
    summary:
      'NACA 4-digit airfoil section — blades and wings need the real section for their motion to be correct.',
    example: 'geom.airfoilProfile({ chord: 0.3, thickness: 0.12 })',
  },
  'geom.arcProfile': {
    signature:
      'geom.arcProfile({ radius: number, start: number, end: number, segments?: number }): ProfileHandle',
    summary: 'Circular arc from `start` to `end` radians.',
    example: 'geom.arcProfile({ radius: 1, start: 0, end: M.PI })',
  },
  'geom.bevel': {
    signature: 'geom.bevel(handle: GeometryHandle, amount?: number): GeometryHandle',
    summary: 'Soften hard edges by `amount` (fraction of edge length, default 0.5).',
    example: 'geom.bevel(handle, 0.4)',
  },
  'geom.bezierProfile': {
    signature:
      'geom.bezierProfile(controls: [x, y][], segmentsPerCurve?: number, closed?: boolean): ProfileHandle',
    summary:
      'Cubic Bézier chain through control points (positional arguments, ≥4 points) — drawn curves.',
    example: 'geom.bezierProfile([[0, 0], [0.2, 0.4], [0.6, 0.4], [0.8, 0]], 24)',
  },
  'geom.beam': {
    signature: 'geom.beam({ width: number, height: number, length: number }): GeometryHandle',
    summary: 'A structural beam — the spelling construction models reach for.',
    example: 'geom.beam({ width: 0.06, height: 0.12, length: 1.2 })',
  },
  'geom.bend': {
    signature:
      "geom.bend(handle: GeometryHandle, radians: number, axis?: 'x'|'y'|'z', around?: 'x'|'y'|'z'): GeometryHandle",
    summary: 'Bend the mesh `radians` about `axis` (default y) around `around` (default z).',
    example: 'geom.bend(handle, 0.6)',
  },
  'geom.boolean': {
    signature:
      "geom.boolean({ op: 'union'|'subtract'|'intersect', a: GeometryHandle, b: GeometryHandle, resolution?: number, blend?: number }): GeometryHandle",
    summary:
      'CSG by re-meshing — always yields something closed; `blend` > 0 fillets the seam. Subtract drills holes and cavities.',
    example:
      "geom.boolean({ op: 'subtract', a: block, b: geom.sphere({ radius: 0.05 }), resolution: 64 })",
  },
  'geom.box': {
    signature:
      'geom.box(spec: { size: [w, h, d] } | [w, h, d] | { width, height, length }): GeometryHandle',
    summary:
      'A box in metres. All three spellings accepted; { size: [w, h, d] } is the canonical one.',
    example: 'geom.box({ size: [0.2, 0.1, 0.4] })',
  },
  'geom.capsule': {
    signature:
      'geom.capsule({ radius: number, height: number, segments?: number }): GeometryHandle',
    summary: 'Rounded cylinder: radius ≥ 1e-6, height is the straight mid-section.',
    example: 'geom.capsule({ radius: 0.03, height: 0.12 })',
  },
  'geom.circleProfile': {
    signature: 'geom.circleProfile({ radius: number, segments?: number }): ProfileHandle',
    summary: 'A circle as a profile — the section for pipes, tubes and revolved shafts.',
    example: 'geom.circleProfile({ radius: 0.02, segments: 24 })',
  },
  'geom.clip': {
    signature:
      'geom.clip(handle: GeometryHandle, normal: [x, y, z], offset?: number): GeometryHandle',
    summary:
      'Cut everything above the plane (normal·p + offset > 0) — the real cutaway for lessons that live inside something.',
    example: 'geom.clip(housing, [0, 0, 1], 0.05)',
  },
  'geom.colorByField': {
    signature:
      'geom.colorByField(handle: GeometryHandle, field: (x, y, z) => number, ramp: (t) => [r, g, b]): GeometryHandle',
    summary:
      'Per-vertex colour from a scalar field — heat maps, stress plots. Pair with mat.gradient.',
    example:
      'geom.colorByField(plate, function (x, y, z) { return x / 0.4; }, function (t) { return [t, 1 - t, 0]; })',
  },
  'geom.cone': {
    signature: 'geom.cone({ radius: number, height: number, segments?: number }): GeometryHandle',
    summary: 'Cone pointing up along +Y.',
    example: 'geom.cone({ radius: 0.1, height: 0.2 })',
  },
  'geom.cylinder': {
    signature:
      'geom.cylinder({ height: number, radius?: number, radiusTop?: number, radiusBottom?: number, segments?: number, open?: boolean }): GeometryHandle',
    summary:
      'Cylinder along +Y; give `radius` for straight sides or `radiusTop`+`radiusBottom` for a taper.',
    example: 'geom.cylinder({ radius: 0.02, height: 0.3 })',
  },
  'geom.disc': {
    signature:
      'geom.disc({ radius: number, innerRadius?: number, segments?: number }): GeometryHandle',
    summary: 'Flat disc in the XZ plane; `innerRadius` makes it a washer/ring.',
    example: 'geom.disc({ radius: 0.3, innerRadius: 0.05 })',
  },
  'geom.displace': {
    signature:
      'geom.displace(handle: GeometryHandle, amplitude: number, frequency?: number, octaves?: number): GeometryHandle',
    summary: 'Noise displacement along normals — roughness, erosion, organic surface.',
    example: 'geom.displace(terrain, 0.02, 3)',
  },
  'geom.ellipseProfile': {
    signature:
      'geom.ellipseProfile({ radiusX: number, radiusY: number, segments?: number }): ProfileHandle',
    summary: 'Ellipse as a profile.',
    example: 'geom.ellipseProfile({ radiusX: 0.2, radiusY: 0.05 })',
  },
  'geom.extrude': {
    signature:
      'geom.extrude({ profile: ProfileHandle, depth: number, direction?: [x,y,z], steps?: number, endScale?: number, twist?: number, caps?: boolean }): GeometryHandle',
    summary:
      'Pull a profile into a solid; `twist` (radians over the depth) and `endScale` make turbine blades and flares.',
    example:
      'geom.extrude({ profile: geom.rect({ width: 0.2, height: 0.02 }), depth: 0.1, twist: M.HALF_PI })',
  },
  'geom.facet': {
    signature: 'geom.facet(handle: GeometryHandle): GeometryHandle',
    summary: 'Flat-shade: every triangle gets its own normal — crystalline, low-poly looks.',
    example: 'geom.facet(handle)',
  },
  'geom.field': {
    signature: 'geom.field.<shape>(…) and geom.field.<combine>(…): Sdf',
    summary:
      'Signed-distance-field constructors (see the geom.field members below); fields compose by arithmetic for implicit shapes.',
    example: 'geom.field.smoothUnion(geom.field.sphere(0.2), geom.field.box(0.1, 0.1, 0.3), 0.05)',
  },
  'geom.field.sphere': {
    signature: 'geom.field.sphere(radius: number): Sdf',
    summary: 'SDF of a sphere at the origin.',
    example: 'var f = geom.field.sphere(0.2)',
  },
  'geom.field.box': {
    signature: 'geom.field.box(hx: number, hy: number, hz: number): Sdf',
    summary: 'SDF of an axis-aligned box given half-extents.',
    example: 'var f = geom.field.box(0.1, 0.2, 0.1)',
  },
  'geom.field.cylinder': {
    signature: "geom.field.cylinder(radius: number, halfHeight: number, axis?: 'x'|'y'|'z'): Sdf",
    summary: 'SDF of a cylinder along `axis` (default y).',
    example: "var f = geom.field.cylinder(0.05, 0.2, 'y')",
  },
  'geom.field.torus': {
    signature: 'geom.field.torus(major: number, minor: number): Sdf',
    summary: 'SDF of a torus in the XZ plane.',
    example: 'var f = geom.field.torus(0.3, 0.05)',
  },
  'geom.field.capsule': {
    signature: 'geom.field.capsule(radius: number, halfHeight: number): Sdf',
    summary: 'SDF of a capsule along Y.',
    example: 'var f = geom.field.capsule(0.05, 0.15)',
  },
  'geom.field.plane': {
    signature: 'geom.field.plane(nx: number, ny: number, nz: number, offset?: number): Sdf',
    summary: 'Half-space SDF: inside where the normal·p < offset.',
    example: 'var ground = geom.field.plane(0, 1, 0, 0)',
  },
  'geom.field.union': {
    signature: 'geom.field.union(...fields: Sdf[]): Sdf',
    summary: 'Hard union of any number of fields.',
    example: 'var both = geom.field.union(a, b, c)',
  },
  'geom.field.intersect': {
    signature: 'geom.field.intersect(...fields: Sdf[]): Sdf',
    summary: 'Hard intersection — only where every field is inside.',
    example: 'var core = geom.field.intersect(a, b)',
  },
  'geom.field.subtract': {
    signature: 'geom.field.subtract(a: Sdf, b: Sdf): Sdf',
    summary: 'Hard difference a − b.',
    example: 'var hollowed = geom.field.subtract(shell, core)',
  },
  'geom.field.smoothUnion': {
    signature: 'geom.field.smoothUnion(a: Sdf, b: Sdf, radius: number): Sdf',
    summary: 'Filleted union — moulded-looking joins rather than glued ones.',
    example: 'var blended = geom.field.smoothUnion(a, b, 0.05)',
  },
  'geom.field.smoothSubtract': {
    signature: 'geom.field.smoothSubtract(a: Sdf, b: Sdf, radius: number): Sdf',
    summary: 'Filleted difference — rounded grooves and pockets.',
    example: 'var groove = geom.field.smoothSubtract(a, b, 0.02)',
  },
  'geom.field.offset': {
    signature: 'geom.field.offset(field: Sdf, distance: number): Sdf',
    summary: 'Grow (positive) or shrink (negative) a field by a fixed distance.',
    example: 'var inflated = geom.field.offset(f, 0.01)',
  },
  'geom.field.shell': {
    signature: 'geom.field.shell(field: Sdf, thickness: number): Sdf',
    summary: 'A thin wall centred on the field’s surface — membranes and vessels.',
    example: 'var wall = geom.field.shell(sphereField, 0.004)',
  },
  'geom.field.translate': {
    signature: 'geom.field.translate(field: Sdf, dx: number, dy: number, dz: number): Sdf',
    summary: 'Move a field in space.',
    example: 'var moved = geom.field.translate(f, 0.1, 0, 0)',
  },
  'geom.field.repeat': {
    signature: 'geom.field.repeat(field: Sdf, px: number, py: number, pz: number): Sdf',
    summary: 'Tile a field infinitely with period (px, py, pz) — lattices and grids.',
    example: 'var lattice = geom.field.repeat(cell, 0.1, 0.1, 0.1)',
  },
  'geom.field.metaballs': {
    signature: 'geom.field.metaballs(centres: [x, y, z, radius][], blend?: number): Sdf',
    summary: 'Metaball cloud — organic blobs that merge as they approach.',
    example: 'geom.field.metaballs([[0, 0, 0, 0.1], [0.15, 0, 0, 0.08]], 0.5)',
  },
  'geom.field.gyroid': {
    signature: 'geom.field.gyroid(scale?: number, thickness?: number): Sdf',
    summary: 'Gyroid — triply periodic minimal surface; printed-lattice interiors.',
    example: 'var g = geom.field.gyroid(1, 0.1)',
  },
  'geom.gear': {
    signature:
      'geom.gear({ teeth: number, module: number, thickness: number, bore?: number, pressureAngle?: number }): GeometryHandle',
    summary:
      'Involute-spur gear — the only correct gear (teeth 6–200; module = pitch diameter / teeth, metres; pressureAngle in radians, default 20°).',
    example: 'geom.gear({ teeth: 24, module: 0.004, thickness: 0.02, bore: 0.006 })',
  },
  'geom.gearProfile': {
    signature:
      'geom.gearProfile({ teeth: number, module: number, pressureAngle?: number }): ProfileHandle',
    summary: 'The involute gear section alone — extrude or sweep it for non-standard gear bodies.',
    example: 'geom.gearProfile({ teeth: 12, module: 0.004 })',
  },
  'geom.heightField': {
    signature:
      'geom.heightField({ width: number, depth: number, heightAt: (x, z) => number, segments?: number }): GeometryHandle',
    summary: 'A surface over a rectangle — terrain, potential surfaces, 2D function plots.',
    example:
      'geom.heightField({ width: 1, depth: 1, heightAt: function (x, z) { return 0.1 * M.sin(6 * x); } })',
  },
  'geom.helix': {
    signature:
      'geom.helix({ radius: number, wireRadius: number, turns: number, pitch?: number, height?: number, segmentsPerTurn?: number, wireSegments?: number }): GeometryHandle',
    summary:
      'True helical sweep — the only spring that can compress (wireRadius also accepts thickness/tube; give pitch, or height and turns).',
    example: 'geom.helix({ radius: 0.05, wireRadius: 0.008, turns: 6, pitch: 0.02 })',
  },
  'geom.hemisphere': {
    signature: 'geom.hemisphere({ radius: number, segments?: number }): GeometryHandle',
    summary: 'Upper half of a sphere — domes and bowls.',
    example: 'geom.hemisphere({ radius: 0.2 })',
  },
  'geom.loft': {
    signature:
      'geom.loft({ sections: [{ profile: ProfileHandle, position: [x,y,z], rotation?: number, scale?: number }], smoothSteps?: number, caps?: boolean }): GeometryHandle',
    summary: 'Skin through ≥2 cross-sections — hulls, fuselages, anatomical transitions.',
    example:
      'geom.loft({ sections: [{ profile: geom.circleProfile({ radius: 0.1 }), position: [0, 0, 0] }, { profile: geom.circleProfile({ radius: 0.02 }), position: [0, 0.3, 0] }] })',
  },
  'geom.merge': {
    signature: 'geom.merge(parts: [{ name: string, geometry: GeometryHandle }]): GeometryHandle',
    summary:
      'Several geometries into one buffer, each a named region — one draw call, one selection.',
    example: "geom.merge([{ name: 'head', geometry: head }, { name: 'shank', geometry: shank }])",
  },
  'geom.mesh': {
    signature:
      'geom.mesh({ positions: number[], indices?: number[], normals?: number[], uvs?: number[], colors?: number[] }): GeometryHandle',
    summary:
      'Raw triangles — the mathematical ceiling. positions is a flat xyz array (≥3 vertices), indices triplets.',
    example: 'geom.mesh({ positions: [0, 0, 0, 0.1, 0, 0, 0, 0.1, 0], indices: [0, 1, 2] })',
  },
  'geom.mirror': {
    signature:
      "geom.mirror(handle: GeometryHandle, axis: 'x'|'y'|'z', keepOriginal?: boolean): GeometryHandle",
    summary:
      'Mirror across a plane through the origin; keepOriginal (default true) keeps both sides.',
    example: "geom.mirror(halfBridge, 'x')",
  },
  'geom.morph': {
    signature: 'geom.morph(a: GeometryHandle, b: GeometryHandle, t: number): GeometryHandle',
    summary: 'Blend two meshes at t in [0, 1] — state transitions, before/after.',
    example: 'geom.morph(sphereA, blobB, 0.5)',
  },
  'geom.parametric': {
    signature:
      'geom.parametric({ surface: (u, v) => [x, y, z], segments?: number, closed?: { u?: boolean, v?: boolean } }): GeometryHandle',
    summary: 'Parametric surface over u, v in [0, 1] — waves, Möbius strips, function plots.',
    example:
      'geom.parametric({ surface: function (u, v) { return [u, 0.1 * M.sin(u * 10), v]; } })',
  },
  'geom.patch': {
    signature:
      "geom.patch({ profile: ProfileHandle, heightAt?: (x, y) => number, plane?: 'xy'|'xz'|'yz' }): GeometryHandle",
    summary: 'Fill a profile outline as a surface, optionally displaced — maps, terrain sections.',
    example: "geom.patch({ profile: geom.circleProfile({ radius: 0.5 }), plane: 'xz' })",
  },
  'geom.path': {
    signature: 'geom.path(points: [x, y, z][], closed?: boolean): PathHandle',
    summary: 'A polyline through ≥2 points — sweep and pipe routes; also readable by scene.path.',
    example: 'geom.path([[0, 0, 0], [0.2, 0, 0], [0.2, 0.1, 0.1]])',
  },
  'geom.pattern': {
    signature: 'geom.pattern.<helper>(count, geometryArgs, options?): Placement[]',
    summary:
      'Placement-list constructors (see members below) — feed the result to scene.instances: N × geometry cost, 1 × draw call.',
    example: "geom.pattern.radial(24, 0.3, { axis: 'y' })",
  },
  'geom.pattern.linear': {
    signature:
      'geom.pattern.linear(count: number, step: [x,y,z], { start?: [x,y,z], rotationStep?: [x,y,z], scaleStep?: number }): Placement[]',
    summary: 'A straight run — bolts along an edge, rungs on a ladder, sleepers on track.',
    example: 'geom.pattern.linear(10, [0.05, 0, 0], { start: [-0.25, 0, 0] })',
  },
  'geom.pattern.radial': {
    signature:
      "geom.pattern.radial(count: number, radius: number, { axis?: 'x'|'y'|'z', startAngle?: number, sweep?: number, faceOutward?: boolean, height?: number }): Placement[]",
    summary:
      'An array around a circle — blades, spokes, bolt circles. faceOutward (default true) turns each to point away from the centre.',
    example: "geom.pattern.radial(38, 0.3, { axis: 'y' })",
  },
  'geom.pattern.grid': {
    signature:
      'geom.pattern.grid(counts: [nx, ny, nz], spacing: [dx, dy, dz], { centered?: boolean }): Placement[]',
    summary: 'A 2D/3D lattice — rivet fields, crystal cells, solar arrays, seating.',
    example: 'geom.pattern.grid([6, 1, 6], [0.08, 0, 0.08])',
  },
  'geom.pattern.alongPath': {
    signature:
      'geom.pattern.alongPath(path: PathHandle, count: number, { offset?: number }): Placement[]',
    summary:
      'Placements along a path, oriented to its tangent — carriages, vertebrae, chain teeth.',
    example: 'geom.pattern.alongPath(trackPath, 12)',
  },
  'geom.pattern.spiral': {
    signature:
      "geom.pattern.spiral(count: number, spacing: number, { axis?: 'y'|'z' }): Placement[]",
    summary: 'Golden-angle disc packing — sunflower seeds, scales, evenly packed rivets.',
    example: 'geom.pattern.spiral(60, 0.03)',
  },
  'geom.pattern.onSphere': {
    signature: 'geom.pattern.onSphere(count: number, radius: number): Placement[]',
    summary:
      'Fibonacci-sphere placement, oriented outward — electron shells, dimples, constellations.',
    example: 'geom.pattern.onSphere(32, 0.4)',
  },
  'geom.pattern.helical': {
    signature:
      'geom.pattern.helical(count: number, radius: number, pitch: number, turns: number, { faceOutward?: boolean }): Placement[]',
    summary: 'A helical array — stair treads, screw flights, DNA base pairs.',
    example: 'geom.pattern.helical(30, 0.3, 0.12, 2)',
  },
  'geom.pattern.scatter': {
    signature:
      'geom.pattern.scatter(count: number, extents: [x,y,z], random: () => number, { minSeparation?: number, randomRotation?: boolean, scaleRange?: [min, max] }): Placement[]',
    summary:
      'Random scatter inside a box with a minimum separation — trees, debris, cells (pass `random.float`).',
    example: 'geom.pattern.scatter(40, [1, 0.2, 1], random.float, { minSeparation: 0.08 })',
  },
  'geom.pattern.mirror': {
    signature: "geom.pattern.mirror(placements: Placement[], axis: 'x'|'y'|'z'): Placement[]",
    summary:
      'A placement list plus its mirror — a symmetric 38-blade assembly from one 19-blade definition.',
    example: "geom.pattern.mirror(geom.pattern.radial(19, 0.3), 'x')",
  },
  'geom.pattern.offset': {
    signature: 'geom.pattern.offset(placements: Placement[], offset: [x,y,z]): Placement[]',
    summary: 'Move a whole pattern without regenerating it.',
    example: 'geom.pattern.offset(bolts, [0, 0.05, 0])',
  },
  'geom.pipe': {
    signature:
      'geom.pipe({ path: PathHandle | [x,y,z][], radius: number, innerRadius?: number, segments?: number, caps?: boolean }): GeometryHandle',
    summary:
      'A tube along a path, hollow when `innerRadius` is set so a cutaway shows a real wall. innerRadius must be smaller than radius.',
    example:
      'geom.pipe({ path: geom.path([[0, 0, 0], [0.1, 0, 0], [0.1, 0.1, 0.1]]), radius: 0.015, innerRadius: 0.012 })',
  },
  'geom.plane': {
    signature:
      'geom.plane({ width: number, depth: number, widthSegments?: number, depthSegments?: number }): GeometryHandle',
    summary: 'A ground/reference plane in XZ, subdividable.',
    example: 'geom.plane({ width: 1, depth: 0.6 })',
  },
  'geom.points': {
    signature: 'geom.points({ positions: number[] }): GeometryHandle',
    summary: 'A point cloud (flat xyz array) — render with scene.points, not scene.mesh.',
    example: 'var cloud = geom.points({ positions: [0, 0, 0, 0.1, 0.1, 0.1, 0.2, 0, 0.1] })',
  },
  'geom.polygonProfile': {
    signature:
      'geom.polygonProfile({ sides: number, radius: number, flatBottom?: boolean }): ProfileHandle',
    summary: 'Regular polygon as a profile — hex bar, octagon flanges.',
    example: 'geom.polygonProfile({ sides: 6, radius: 0.05, flatBottom: true })',
  },
  'geom.polyhedron': {
    signature:
      "geom.polyhedron({ kind?: 'tetrahedron'|'octahedron'|'icosahedron'|'cube', radius?: number }): GeometryHandle",
    summary: 'Platonic solid (default icosahedron) — crystals and molecular skeletons.',
    example: "geom.polyhedron({ kind: 'icosahedron', radius: 0.1 })",
  },
  'geom.prism': {
    signature: 'geom.prism({ sides?: number, radius: number, height: number }): GeometryHandle',
    summary: 'Extruded regular polygon (default 6 sides) — nuts, columns, beams.',
    example: 'geom.prism({ sides: 8, radius: 0.05, height: 0.2 })',
  },
  'geom.profile': {
    signature: 'geom.profile(points: [x, y][], closed?: boolean): ProfileHandle',
    summary: 'A 2D outline from ≥2 points (default closed) — the general profile constructor.',
    example: 'geom.profile([[0, 0], [0.1, 0], [0.05, 0.08]])',
  },
  'geom.rect': {
    signature: 'geom.rect({ width: number, height: number, centered?: boolean }): ProfileHandle',
    summary: 'Rectangle profile, centred by default.',
    example: 'geom.rect({ width: 0.2, height: 0.02 })',
  },
  'geom.revolve': {
    signature:
      "geom.revolve({ profile: ProfileHandle, angle?: number, segments?: number, axis?: 'x'|'y'|'z', caps?: boolean }): GeometryHandle",
    summary:
      'Lathe a profile about an axis (default y) — vases, shafts, nozzles. angle in radians, default full turn.',
    example:
      'geom.revolve({ profile: geom.arcProfile({ radius: 0.2, start: -M.HALF_PI, end: M.HALF_PI }) })',
  },
  'geom.ripple': {
    signature:
      "geom.ripple(handle: GeometryHandle, amplitude: number, wavelength: number, phase?: number, axis?: 'x'|'y'|'z'): GeometryHandle",
    summary: 'Sinusoidal ripples along normals — wave fronts on a surface.',
    example: 'geom.ripple(surface, 0.01, 0.2)',
  },
  'geom.sdf': {
    signature:
      'geom.sdf({ field: (x, y, z) => number, bounds: { min: [x,y,z], max: [x,y,z] }, resolution?: number, isoLevel?: number }): GeometryHandle',
    summary:
      'Polygonise a signed distance field (marching cubes) — blended junctions, lattices, organic forms. Cost is O(resolution³); default 48.',
    example:
      'geom.sdf({ field: geom.field.smoothUnion(geom.field.sphere(0.2), geom.field.box(0.05, 0.2, 0.05), 0.05), bounds: { min: [-0.4, -0.4, -0.4], max: [0.4, 0.4, 0.4] } })',
  },
  'geom.shell': {
    signature: 'geom.shell(handle: GeometryHandle, thickness: number): GeometryHandle',
    summary: 'Inflate a mesh into a thin shell — hollow vessels for cutaway lessons.',
    example: 'geom.shell(handle, 0.004)',
  },
  'geom.simplify': {
    signature: 'geom.simplify(handle: GeometryHandle, gridSize: number): GeometryHandle',
    summary: 'Collapse vertices within `gridSize` — meet a triangle budget without redesigning.',
    example: 'geom.simplify(handle, 0.005)',
  },
  'geom.smooth': {
    signature:
      'geom.smooth(handle: GeometryHandle, iterations?: number, strength?: number): GeometryHandle',
    summary: 'Laplacian smoothing (iterations ≤ 8, strength 0–1) — melt hard edges.',
    example: 'geom.smooth(handle, 3, 0.5)',
  },
  'geom.sphere': {
    signature: 'geom.sphere({ radius: number, segments?: number, rings?: number }): GeometryHandle',
    summary: 'Sphere; segments/rings are clamped (default 32) so a coarse shape still builds.',
    example: 'geom.sphere({ radius: 0.14, segments: 32 })',
  },
  'geom.splinePath': {
    signature:
      'geom.splinePath(points: [x, y, z][], segmentsPerSpan?: number, closed?: boolean): PathHandle',
    summary: 'Smooth Catmull–Rom path through ≥3 points — routed pipes, flow lines.',
    example: 'geom.splinePath([[0, 0, 0], [0.2, 0.05, 0], [0.3, 0.15, 0.1]])',
  },
  'geom.splineProfile': {
    signature:
      'geom.splineProfile(points: [x, y][], segmentsPerSpan?: number, closed?: boolean): ProfileHandle',
    summary:
      'Catmull–Rom profile through ≥3 points — interpolating, so it passes through each one.',
    example: 'geom.splineProfile([[0, 0], [0.1, 0.1], [0.2, 0.02]])',
  },
  'geom.subdivide': {
    signature: 'geom.subdivide(handle: GeometryHandle, levels?: number): GeometryHandle',
    summary: 'Split every triangle (0–3 levels) — detail before displacement or a boolean.',
    example: 'geom.subdivide(handle, 1)',
  },
  'geom.sweep': {
    signature:
      'geom.sweep({ profile: ProfileHandle, path: PathHandle | [x,y,z][], twist?: number, endScale?: number, caps?: boolean }): GeometryHandle',
    summary:
      'Sweep a profile along a path — manifolds, cable runs, airfoils with spanwise twist, DNA backbones.',
    example:
      'geom.sweep({ profile: geom.circleProfile({ radius: 0.01 }), path: geom.splinePath([[0, 0, 0], [0.1, 0.02, 0], [0.2, 0.1, 0.05]]), twist: M.PI })',
  },
  'geom.taper': {
    signature:
      "geom.taper(handle: GeometryHandle, endScale: number, axis?: 'x'|'y'|'z'): GeometryHandle",
    summary: 'Scale toward `endScale` (≥0) along an axis (default y).',
    example: 'geom.taper(handle, 0.3)',
  },
  'geom.torus': {
    signature:
      'geom.torus({ radius: number, tube: number, segments?: number, tubeSegments?: number }): GeometryHandle',
    summary: 'Torus in the XZ plane — rings, tires, collars, orbit guides.',
    example: 'geom.torus({ radius: 0.3, tube: 0.03 })',
  },
  'geom.transform': {
    signature:
      'geom.transform(handle: GeometryHandle, { translate?: [x,y,z], scale?: [x,y,z] | number, rotate?: [rx,ry,rz] }): GeometryHandle',
    summary: 'Bake a transform into the vertices (radians for rotate).',
    example: 'geom.transform(handle, { translate: [0, 0.1, 0], rotate: [0, M.HALF_PI, 0] })',
  },
  'geom.twist': {
    signature:
      "geom.twist(handle: GeometryHandle, radians: number, axis?: 'x'|'y'|'z'): GeometryHandle",
    summary: 'Twist `radians` along an axis (default y) — drill flutes, turbine blades.',
    example: 'geom.twist(handle, M.PI)',
  },
  'geom.waveSurface': {
    signature:
      'geom.waveSurface({ width: number, depth: number, amplitude: number, wavelength: number, phase?: number, segments?: number }): GeometryHandle',
    summary:
      'Travelling sinusoid surface — bind `phase` to a parameter so the crest actually travels.',
    example: 'geom.waveSurface({ width: 1, depth: 0.6, amplitude: 0.05, wavelength: 0.4 })',
  },
  'geom.weld': {
    signature: 'geom.weld(handle: GeometryHandle, tolerance?: number): GeometryHandle',
    summary: 'Merge coincident vertices (default 1e-5) — closes seams before smoothing.',
    example: 'geom.weld(handle)',
  },
  'geom.withHoles': {
    signature: 'geom.withHoles(profile: ProfileHandle, holes: ProfileHandle[]): ProfileHandle',
    summary: 'Punch inner loops into a profile so they triangulate once — flange bolt holes.',
    example:
      'geom.withHoles(flange, [geom.circleProfile({ radius: 0.008 }), geom.circleProfile({ radius: 0.008 })])',
  },
  'geom.offsetProfile': {
    signature: 'geom.offsetProfile(profile: ProfileHandle, distance: number): ProfileHandle',
    summary: 'Grow/shrink a profile outward/inward — sheet-metal offsets, clearance.',
    example: 'geom.offsetProfile(base, 0.004)',
  },
  'geom.filletProfile': {
    signature:
      'geom.filletProfile(profile: ProfileHandle, radius: number, segments?: number): ProfileHandle',
    summary: 'Round a profile’s corners — real part outlines are rarely sharp.',
    example: 'geom.filletProfile(geom.rect({ width: 0.2, height: 0.1 }), 0.01)',
  },
  'geom.translateProfile': {
    signature:
      'geom.translateProfile(profile: ProfileHandle, dx: number, dy: number): ProfileHandle',
    summary: 'Move a profile in its plane.',
    example: 'geom.translateProfile(base, 0.05, 0)',
  },
  'geom.rotateProfile': {
    signature: 'geom.rotateProfile(profile: ProfileHandle, angle: number): ProfileHandle',
    summary: 'Rotate a profile in its plane by `angle` radians.',
    example: 'geom.rotateProfile(base, M.HALF_PI)',
  },
  'geom.scaleProfile': {
    signature: 'geom.scaleProfile(profile: ProfileHandle, sx: number, sy?: number): ProfileHandle',
    summary: 'Scale a profile (sy defaults to sx).',
    example: 'geom.scaleProfile(base, 1.5)',
  },

  // ── mat: semantic materials (a deliberately small vocabulary) ──────────────
  'mat.metal': {
    signature:
      'mat.metal({ color? | role?, metalness?, roughness?, opacity?, emissive?, emissiveIntensity?, boundTo?, doubleSided?, flat?, procedural? }?): MaterialHandle',
    summary:
      'Machined parts, conductors, structural steel — fully metallic, low roughness by default. Use `role` to join the colour-role system.',
    example: "mat.metal({ role: 'structure', roughness: 0.35 })",
  },
  'mat.matte': {
    signature: 'mat.matte({ …same options as mat.metal }?): MaterialHandle',
    summary: 'Organic matter, insulators, cast surfaces — no metalness, high roughness.',
    example: "mat.matte({ color: '#c98a72' })",
  },
  'mat.plastic': {
    signature: 'mat.plastic({ …same options as mat.metal }?): MaterialHandle',
    summary: 'Everyday housings, fixtures, knobs.',
    example: "mat.plastic({ role: 'measure' })",
  },
  'mat.glass': {
    signature: 'mat.glass({ …same options as mat.metal }?): MaterialHandle',
    summary:
      'Containers, lenses, membranes — genuinely transmissive and double-sided, so internals stay visible.',
    example: 'mat.glass({ opacity: 0.35 })',
  },
  'mat.translucent': {
    signature: 'mat.translucent({ …same options as mat.metal }?): MaterialHandle',
    summary: 'Explanatory shells over the lesson — cell membranes, containment, skin.',
    example: "mat.translucent({ color: '#dfe8ee', opacity: 0.4 })",
  },
  'mat.emissive': {
    signature: 'mat.emissive({ …same options as mat.metal, boundTo?: string }?): MaterialHandle',
    summary:
      'Energy, charge, heat, signal. Bind `boundTo` to the quantity it represents so brightness IS the measurement.',
    example: "mat.emissive({ color: '#ffb457', boundTo: 'current' })",
  },
  'mat.toon': {
    signature: 'mat.toon({ …same options as mat.metal }?): MaterialHandle',
    summary: 'Flat diagram style — maths and abstractions read better non-photoreal.',
    example: "mat.toon({ color: '#e8a33d' })",
  },
  'mat.wire': {
    signature: 'mat.wire({ …same options as mat.metal }?): MaterialHandle',
    summary: 'Structure lines only — topology, construction, and debugging a wrong model.',
    example: 'mat.wire({})',
  },
  'mat.fluid': {
    signature: 'mat.fluid({ …same options as mat.metal }?): MaterialHandle',
    summary: 'Water, coolant, blood, magma — transmissive and smooth so flow reads through it.',
    example: "mat.fluid({ color: '#4f9fd8' })",
  },
  'mat.organic': {
    signature: 'mat.organic({ …same options as mat.metal }?): MaterialHandle',
    summary: 'Tissue, wood, bone, leaf — slight subsurface so flesh never reads as plastic.',
    example: "mat.organic({ color: '#c98a72' })",
  },
  'mat.gradient': {
    signature: 'mat.gradient({ …same options as mat.metal }?): MaterialHandle',
    summary:
      'Vertex-colour surface — pairs with geom.colorByField for stress and heat read-outs worn by the part itself.',
    example: 'mat.gradient({})',
  },
  'mat.roleColor': {
    signature: 'mat.roleColor(id: string): string',
    summary:
      'The hex a declared colour role resolves to — keep lines and labels on the same system.',
    example: "var line = mat.roleColor('energy')",
  },

  // ── scene: the authoring surface. Declaration order: describe first. ───────
  'scene.describe': {
    signature:
      "scene.describe({ name: string, description: string, concept: string, objectives: string[], domain?: string, subdomain?: string, level?: 'primary'|'secondary'|'undergraduate'|'expert', principles?: string[], simplifications?: string[], relationships?: [{ from, to, kind, note? }] }): void",
    summary:
      'REQUIRED FIRST CALL. Declares what the model is and teaches; the audit checks story and parts against these objectives.',
    example: `scene.describe({
  name: 'Pendulum',
  description: 'Swing a pendulum and discover what changes its tempo — and what surprisingly does not.',
  domain: 'physics',
  concept: 'A pendulum is a clock: its period is set by length and gravity alone — mass never matters.',
  objectives: ['Predict how doubling the length changes the period'],
  level: 'secondary',
  principles: ['T = 2π·sqrt(L/g) — mass cancels out of the equation'],
  simplifications: ['No pivot friction; the damping slider stands in for air drag'],
});`,
  },
  'scene.colorRole': {
    signature:
      'scene.colorRole({ id: string, label: string, color: string, meaning: string }): void',
    summary:
      'Declare a colour ONCE as a category the learner learns to read; reference it from materials with { role: id }.',
    example:
      "scene.colorRole({ id: 'energy', label: 'The moving part', color: '#c2885c', meaning: 'Anything storing or carrying energy' })",
  },
  'scene.param': {
    signature:
      "scene.param({ id: string, label: string, kind?: 'number'|'boolean'|'choice'|'color', min?: number, max?: number, default?: number, unit?: string, description?: string, step?: number, scale?: 'log'|'linear', options?: [{ value: string, label: string }], affects?: [{ partId: string, channel: string }] }): string",
    summary:
      'Declare a learner control (max 24). Every parameter must visibly change behaviour — the audit sweeps and checks. For numbers max must exceed min.',
    example:
      "scene.param({ id: 'ratio', label: 'Gear ratio', kind: 'number', min: 0.5, max: 4, default: 2, unit: ':1', affects: [{ partId: 'demo', channel: 'transform' }] })",
  },
  'scene.metric': {
    signature:
      "scene.metric({ id: string, label: string, unit?: string, formula?: string, precision?: number, source?: 'model'|'physics' }): string",
    summary:
      'A live read-out; publish its value every frame with ctx.metric(id, value) so number and motion never disagree.',
    example:
      "scene.metric({ id: 'rpm', label: 'Rotor speed', unit: 'rpm', formula: '60·rate/TAU' })",
  },
  'scene.group': {
    signature:
      'scene.group({ id: string, name?: string, parentId?: string | null, position?: [x,y,z], rotation?: [x,y,z], scale?: number | [x,y,z], group?: string }): string',
    summary:
      'A non-renderable container; groups follow function so selecting a group selects a concept.',
    example: "scene.group({ id: 'rig', name: 'Pendulum rig' })",
  },
  'scene.mesh': {
    signature:
      'scene.mesh({ id: string, geometry: GeometryHandle, material: MaterialHandle, parentId?: string | null, name?: string, position?: [x,y,z], rotation?: [x,y,z], scale?: number | [x,y,z], group?: string, info?: { title, summary, bullets?, facts? }, selectable?: boolean, visible?: boolean, hero?: boolean, static?: boolean, explodeOffset?: [x,y,z] }): string',
    summary:
      'The core declaration: geometry from geom.*, material from mat.*, meaning via info. Returns the part id (a string, not an object).',
    example: `scene.mesh({
  id: 'axle', parentId: 'rig', name: 'Axle',
  geometry: geom.cylinder({ radius: 0.02, height: 0.3 }),
  material: steel, position: [0, 0.1, 0],
  info: { title: 'Axle', summary: 'The shaft the demo part rides on.' },
});`,
  },
  'scene.instances': {
    signature:
      'scene.instances({ id: string, geometry: GeometryHandle, material: MaterialHandle, placements: Placement[], parentId?: string | null, name?: string, group?: string, info?: { title, summary }, selectable?: boolean, hero?: boolean }): string',
    summary:
      'One geometry placed many times for ONE draw call — the affordable way to repeat (placements from geom.pattern.*, ≤40000 per set).',
    example: `scene.instances({
  id: 'boltRing', parentId: 'rig',
  geometry: geom.cylinder({ radius: 0.008, height: 0.03 }),
  material: steel,
  placements: geom.pattern.radial(8, 0.2, { axis: 'y' }),
});`,
  },
  'scene.points': {
    signature:
      'scene.points({ id: string, geometry: GeometryHandle, material: MaterialHandle, parentId?: string | null, name?: string, info?: { title, summary } }): string',
    summary: 'Render a geom.points cloud — particle fields, electron clouds, star catalogues.',
    example:
      "scene.points({ id: 'stars', geometry: cloud, material: mat.emissive({ color: '#ffffff' }) })",
  },
  'scene.defineComponent': {
    signature: 'scene.defineComponent(name: string, body: (ctx: ComponentContext) => void): void',
    summary:
      'Define a subassembly once; ctx.mesh/ctx.group auto-parent and id-prefix so it can be placed any number of times.',
    example: `scene.defineComponent('bolt', function (ctx) {
  ctx.mesh({ id: 'head', geometry: geom.cylinder({ radius: 0.012, height: 0.008 }), material: steel });
  ctx.mesh({ id: 'shank', geometry: geom.cylinder({ radius: 0.006, height: ctx.params.length ?? 0.05 }), material: steel, position: [0, -0.02, 0] });
});`,
  },
  'scene.place': {
    signature:
      'scene.place(component: string, { id: string, parentId?: string | null, position?: [x,y,z], rotation?: [x,y,z], scale?: number | [x,y,z], params?: Record<string, any> }): string',
    summary:
      'Place a defined component; `params` reaches the body as ctx.params, so each instance differs without new code.',
    example: `scene.defineComponent('cap', function (ctx) {
  ctx.mesh({ id: 'dome', geometry: geom.hemisphere({ radius: 0.02 }), material: steel });
});
scene.place('cap', { id: 'cap1', parentId: 'rig', position: [0.3, 0, 0], params: { size: 0.02 } });`,
  },
  'scene.motion': {
    signature:
      "scene.motion({ id: string, partId: string, kind: 'spin'|'oscillate'|'orbit'|'translate'|'pulse'|'flowAlongPath', axis?: [x,y,z], rate?: number | { const: number } | { param: string }, amplitude?: number | { param: string }, phase?: number, center?: [x,y,z], pathId?: string, runsWhilePaused?: boolean, reason?: string }): void",
    summary:
      'Auditable declared motion. Bind rate/amplitude to a parameter with { param: id } — the audit then proves the slider drives it. flowAlongPath needs pathId.',
    example:
      "scene.motion({ id: 'spin', partId: 'demo', kind: 'spin', axis: [0, 1, 0], rate: { param: 'speed' }, reason: 'Shows the mechanism turning.' })",
  },
  'scene.path': {
    signature: 'scene.path({ id: string, path: PathHandle, visible?: boolean }): string',
    summary:
      'Register a named 3D path (from geom.path/geom.splinePath) — orbits, flow routes, camera rails, flowAlongPath targets.',
    example:
      "scene.path({ id: 'flow', path: geom.splinePath([[0, 0, 0], [0.3, 0.1, 0]]), visible: true })",
  },
  'scene.light': {
    signature: `scene.light({ id: string, kind?: ${LIGHT_KIND_UNION}, color?: string, intensity?: number, position?: [x,y,z], target?: [x,y,z], angle?: number, penumbra?: number, distance?: number, castShadow?: boolean, boundTo?: string }): void`,
    summary:
      'Add a light to the default rig (never replaces it); castShadow sparingly — it is the most expensive option.',
    example:
      "scene.light({ id: 'spark', kind: 'point', color: '#ffb457', intensity: 2, position: [0, 0.2, 0] })",
  },
  'scene.camera': {
    signature:
      'scene.camera({ position: [x,y,z], target?: [x,y,z], fov?: number, limits?: { minDistance?, maxDistance?, minPolarAngle?, maxPolarAngle?, damping?, autoRotate?, autoRotateSpeed? } }): void',
    summary:
      'Set the opening framing yourself — auto-framing is a fallback, never the default answer.',
    example: 'scene.camera({ position: [1.2, 0.8, 1.2], target: [0, 0, 0], fov: 45 })',
  },
  'scene.shot': {
    signature: `scene.shot(name: string, { kind?: ${SHOT_KIND_UNION}, duration?: number, easing?: ${SHOT_EASING_UNION}, targetPartId?: string, pose?: { position?: [x,y,z], target?: [x,y,z], fov?: number }, distance?: number, sweep?: number, fov?: number, margin?: number }): void`,
    summary:
      'A named cinematic move a story beat or interaction can replay. flyTo/follow frame a targetPartId; moveTo/cut take a pose; dolly (toward: negative) and crane (up: positive) take signed distance in metres; orbit and pan sweep radians; fovPull takes the destination fov. Orbit composes with dolly/crane in one shot — see scene.story.',
    example: "scene.shot('inside', { kind: 'flyTo', targetPartId: 'demo', duration: 2 })",
  },
  'scene.environment': {
    signature:
      'scene.environment({ preset?: string, backgroundDark?: string, backgroundLight?: string, grid?: boolean, exposure?: number, fog?: any }): void',
    summary: 'Backdrop and tone; the engine keeps model contrast in both light and dark themes.',
    example: "scene.environment({ preset: 'studio', grid: true })",
  },
  'scene.story': {
    signature: `scene.story(beats: [{ id: string, title: string, narration: string, targetPartId?: string, shots?: [{ kind?: ${SHOT_KIND_UNION}, duration?: number, targetPartId?: string }], setParameters?: { parameterId: number | boolean | string }, holdSeconds?: number, viewMode?: ${VIEW_MODE_UNION} }]): void`,
    summary:
      '3–6 beats along the causal arc; each narration is one plain-language idea. Beat shots move the camera for that beat; default is an eased fly-to of targetPartId.',
    example:
      "scene.story([{ id: 'b1', title: 'The swing', narration: 'Gravity pulls the bob back; the rod turns pull into a curve.', targetPartId: 'demo' }])",
  },
  'scene.quiz': {
    signature:
      'scene.quiz(questions: [{ id: string, question: string, options: string[], correctIndex: number, explanation: string, difficulty?: string, evidencePartId?: string }]): void',
    summary:
      'Authored quiz; at least one distractor must be the real misconception. Bad items are dropped with a warning, not shown.',
    example: `scene.quiz([{
  id: 'q1', question: 'You double the length. The period…',
  options: ['Doubles', 'Grows by sqrt(2)', 'Is unchanged', 'Halves'],
  correctIndex: 1,
  explanation: 'T = 2π·sqrt(L/g): doubling L multiplies T by sqrt(2), about 1.41.',
}]);`,
  },
  'scene.interaction': {
    signature: `scene.interaction({ partId: string, on?: 'click'|'doubleClick'|'hover'|'longPress', kind?: ${INTERACTION_KIND_UNION}, targetId?: string, value?: number | boolean | string, shot?: { kind?: ${SHOT_KIND_UNION}, duration?: number, targetPartId?: string }, impulse?: [x,y,z], handlerId?: string, hint?: string }): void`,
    summary:
      "Behaviour beyond selection on an existing part (declare the part first). 'playShot' replays its inline shot; 'startStoryBeat' takes the beat id as targetId; 'applyImpulse' takes impulse; 'custom' takes a handlerId registered with scene.onInteraction.",
    example:
      "scene.interaction({ partId: 'demo', on: 'click', kind: 'toggleVisibility', targetId: 'demo', hint: 'Click to see inside' })",
  },
  'scene.onFrame': {
    signature:
      'scene.onFrame(callback: (ctx: { time: number, dt: number, paused: boolean, params: Record<string, any>, probes: Record<string, number>, part(id): PartRef, metric(id, value), motor(jointId, targetVelocity) }) => void): void',
    summary:
      'Per-frame logic (≤16 callbacks). PartRef: setPosition/setRotation/setScale/setVisible/setEmissive/setOpacity/setColor/position()/rotation(). time is authored seconds.',
    example:
      "scene.onFrame(function (ctx) { ctx.part('demo').setRotation(0, M.wrap(ctx.time * ctx.params.speed, M.TAU), 0); })",
  },
  'scene.onParameterChange': {
    signature:
      'scene.onParameterChange(callback: (id: string, value: number | boolean | string) => void): void',
    summary:
      'React to a slider outside the frame loop — for work too expensive to redo every frame.',
    example:
      "scene.onParameterChange(function (id, value) { console.log(id, 'changed to', value); })",
  },
  'scene.onSelect': {
    signature: 'scene.onSelect(callback: (partId: string) => void): void',
    summary: 'React to a part being selected.',
    example: "scene.onSelect(function (partId) { console.log('selected', partId); })",
  },
  'scene.onInteraction': {
    signature: 'scene.onInteraction(id: string, callback: (partId: string) => void): void',
    summary: "Register a named handler a scene.interaction { kind: 'custom' } invokes.",
    example: "scene.onInteraction('pulse', function (partId) { console.log('pulse', partId); })",
  },
  'scene.physics': {
    signature: `scene.physics({ world?: { gravity?: [x,y,z], stepHz?, substeps?, timeScale?, grabbable? }, bodies: [{ id, partId, kind?: ${BODY_KIND_UNION}, mass?, centerOfMass?, gravityScale? }], joints: [{ id, kind: ${JOINT_KIND_UNION}, bodyA, bodyB?: string | null, anchorA?, anchorB?, axis?, limits?, motor?: { targetVelocity?, maxForce?, boundToParameter? } }], probes?: [{ id, bodyId, quantity: 'speed'|'height'|'kineticEnergy'|'potentialEnergy'|'totalEnergy'|'momentum'|'angularSpeed'|'contactForce', label }] }): void`,
    summary:
      'Declare real simulation (absent = the model animates, not simulates). Motor targets are retargetable live via ctx.motor; probes surface on ctx.probes.',
    example:
      "scene.physics({ world: { gravity: [0, -9.81, 0] }, bodies: [{ id: 'bobBody', partId: 'demo', mass: 1 }] })",
  },
  'scene.warn': {
    signature: 'scene.warn(message: string): void',
    summary: 'Record a non-fatal note for the diagnostics panel.',
    example: "scene.warn('Scale exaggerated 10× for visibility')",
  },
});
