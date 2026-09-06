/**
 * Pattern helpers: the fifth mechanism that makes 300-part ambition affordable.
 *
 * `00-GOAL.md` states the affordability rule as a hard constraint, not advice: "an engine with 300 parts is
 * built from a few parameterized definitions, not 300 hand-written blocks. The scene API must make repetition
 * cheap (instancing, component reuse) so ambition is not limited by token counts."
 *
 * These functions return *placement lists* rather than meshes. That distinction is the whole point: a
 * placement list feeds an instanced set, which `08` prices as "N × geometry cost, 1 × draw call". A 38-blade
 * fan authored as 38 meshes costs 38 draw calls; the same fan from `radial(38)` costs one.
 */
import { GOLDEN_ANGLE, TAU, lerp, normalize, type Vec3 } from '../math/index.ts';
import type { Path3 } from './mesh-data.ts';

/** One placement in an instanced set. Matches the manifest's `InstancePlacement` shape. */
export interface Placement {
  position: Vec3;
  rotation?: Vec3;
  scale?: Vec3;
  /** Optional label so a click can report *which* instance was hit (`03` R3). */
  label?: string;
}

/** A linear run — bolts along a flange edge, sleepers on a track, rungs on a ladder. */
export function linear(
  count: number,
  step: Vec3,
  options: {
    start?: Vec3;
    rotationStep?: Vec3;
    scaleStep?: number;
    label?: (index: number) => string;
  } = {},
): Placement[] {
  const start = options.start ?? [0, 0, 0];
  const placements: Placement[] = [];

  for (let i = 0; i < Math.max(0, Math.floor(count)); i += 1) {
    const scale = options.scaleStep !== undefined ? 1 + options.scaleStep * i : 1;
    placements.push({
      position: [start[0] + step[0] * i, start[1] + step[1] * i, start[2] + step[2] * i],
      ...(options.rotationStep
        ? {
            rotation: [
              options.rotationStep[0] * i,
              options.rotationStep[1] * i,
              options.rotationStep[2] * i,
            ] as Vec3,
          }
        : {}),
      ...(options.scaleStep !== undefined ? { scale: [scale, scale, scale] as Vec3 } : {}),
      ...(options.label ? { label: options.label(i) } : {}),
    });
  }

  return placements;
}

/**
 * A radial array — turbine blades, spokes, bolt circles, planetary gears, petals.
 *
 * `faceOutward` rotates each instance to point away from the centre, which is almost always what is wanted and
 * is the step a model author most often forgets: without it a blade array looks like a ring of parallel blades
 * rather than a fan.
 */
export function radial(
  count: number,
  radius: number,
  options: {
    axis?: 'x' | 'y' | 'z';
    startAngle?: number;
    sweep?: number;
    faceOutward?: boolean;
    height?: number;
    label?: (index: number) => string;
  } = {},
): Placement[] {
  const total = Math.max(0, Math.floor(count));
  const axis = options.axis ?? 'y';
  const startAngle = options.startAngle ?? 0;
  const sweep = options.sweep ?? TAU;
  const faceOutward = options.faceOutward ?? true;
  const height = options.height ?? 0;

  const placements: Placement[] = [];
  // A full circle divides by `count` so first and last do not coincide; a partial arc divides by `count - 1`
  // so both ends land on the requested limits.
  const divisor = Math.abs(sweep - TAU) < 1e-6 ? total : Math.max(1, total - 1);

  for (let i = 0; i < total; i += 1) {
    const angle = startAngle + (i / divisor) * sweep;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);

    let position: Vec3;
    let rotation: Vec3 | undefined;

    if (axis === 'y') {
      position = [cos * radius, height, sin * radius];
      if (faceOutward) rotation = [0, -angle, 0];
    } else if (axis === 'x') {
      position = [height, cos * radius, sin * radius];
      if (faceOutward) rotation = [angle, 0, 0];
    } else {
      position = [cos * radius, sin * radius, height];
      if (faceOutward) rotation = [0, 0, angle];
    }

    placements.push({
      position,
      ...(rotation ? { rotation } : {}),
      ...(options.label ? { label: options.label(i) } : {}),
    });
  }

  return placements;
}

/** A 2D or 3D lattice — rivet fields, crystal cells, solar arrays, seating, tiles. */
export function grid(
  counts: readonly [number, number, number],
  spacing: readonly [number, number, number],
  options: { centered?: boolean; label?: (x: number, y: number, z: number) => string } = {},
): Placement[] {
  const [cx, cy, cz] = counts.map((value) => Math.max(0, Math.floor(value))) as [
    number,
    number,
    number,
  ];
  const centered = options.centered ?? true;

  const originX = centered ? (-(cx - 1) * spacing[0]) / 2 : 0;
  const originY = centered ? (-(cy - 1) * spacing[1]) / 2 : 0;
  const originZ = centered ? (-(cz - 1) * spacing[2]) / 2 : 0;

  const placements: Placement[] = [];
  for (let z = 0; z < cz; z += 1) {
    for (let y = 0; y < cy; y += 1) {
      for (let x = 0; x < cx; x += 1) {
        placements.push({
          position: [originX + x * spacing[0], originY + y * spacing[1], originZ + z * spacing[2]],
          ...(options.label ? { label: options.label(x, y, z) } : {}),
        });
      }
    }
  }
  return placements;
}

/**
 * Placements distributed along a path, oriented to its tangent.
 *
 * Carriages on a track, teeth on a chain, vertebrae on a spine, cars in a pipeline, atoms along a polymer.
 * Orienting to the tangent is what makes the array follow the curve rather than merely sit on it.
 */
export function alongPath(
  path: Path3,
  count: number,
  options: { offset?: number; label?: (index: number) => string } = {},
): Placement[] {
  const points = path.points;
  const pointCount = points.length / 3;
  if (pointCount < 2) return [];

  const total = Math.max(0, Math.floor(count));
  const placements: Placement[] = [];

  // Arc-length parameterisation so instances are evenly spaced in *space*, not in index. A path with dense
  // points near a bend would otherwise bunch every instance into the bend.
  const cumulative = new Float32Array(pointCount);
  let length = 0;
  for (let i = 1; i < pointCount; i += 1) {
    const dx = (points[i * 3] as number) - (points[(i - 1) * 3] as number);
    const dy = (points[i * 3 + 1] as number) - (points[(i - 1) * 3 + 1] as number);
    const dz = (points[i * 3 + 2] as number) - (points[(i - 1) * 3 + 2] as number);
    length += Math.sqrt(dx * dx + dy * dy + dz * dz);
    cumulative[i] = length;
  }
  if (length < 1e-9) return [];

  for (let i = 0; i < total; i += 1) {
    const target = (total === 1 ? 0.5 : i / (total - 1)) * length;
    let segment = 0;
    while (segment < pointCount - 2 && (cumulative[segment + 1] as number) < target) segment += 1;

    const spanStart = cumulative[segment] as number;
    const spanEnd = cumulative[segment + 1] as number;
    const t = spanEnd > spanStart ? (target - spanStart) / (spanEnd - spanStart) : 0;

    const ax = points[segment * 3] as number;
    const ay = points[segment * 3 + 1] as number;
    const az = points[segment * 3 + 2] as number;
    const bx = points[(segment + 1) * 3] as number;
    const by = points[(segment + 1) * 3 + 1] as number;
    const bz = points[(segment + 1) * 3 + 2] as number;

    const tangent = normalize([bx - ax, by - ay, bz - az]);
    // Euler angles that point +Z along the tangent. Yaw from the horizontal projection, pitch from the
    // vertical component — the standard "look along" decomposition.
    const yaw = Math.atan2(tangent[0], tangent[2]);
    const pitch = -Math.asin(Math.max(-1, Math.min(1, tangent[1])));

    const offset = options.offset ?? 0;
    placements.push({
      position: [
        lerp(ax, bx, t) + tangent[0] * offset,
        lerp(ay, by, t) + tangent[1] * offset,
        lerp(az, bz, t) + tangent[2] * offset,
      ],
      rotation: [pitch, yaw, 0],
      ...(options.label ? { label: options.label(i) } : {}),
    });
  }

  return placements;
}

/**
 * Phyllotactic (golden-angle) placements on a disc.
 *
 * Sunflower seeds, pinecone scales, densely packed rivets, receptor arrays. The golden angle is the correct
 * answer for even packing, and the alternative — nested radial rings — produces visible spokes that read as
 * an artifact rather than a pattern.
 */
export function spiral(
  count: number,
  spacing: number,
  options: { axis?: 'y' | 'z'; label?: (index: number) => string } = {},
): Placement[] {
  const total = Math.max(0, Math.floor(count));
  const axis = options.axis ?? 'y';
  const placements: Placement[] = [];

  for (let i = 0; i < total; i += 1) {
    const radius = spacing * Math.sqrt(i);
    const angle = GOLDEN_ANGLE * i;
    const x = Math.cos(angle) * radius;
    const y = Math.sin(angle) * radius;
    placements.push({
      position: axis === 'y' ? [x, 0, y] : [x, y, 0],
      rotation: axis === 'y' ? [0, -angle, 0] : [0, 0, angle],
      ...(options.label ? { label: options.label(i) } : {}),
    });
  }

  return placements;
}

/**
 * Placements on a sphere via the Fibonacci spiral, oriented outward.
 *
 * Electron shells, coordination geometry, receptor distributions, satellite constellations, dimples on a golf
 * ball. Latitude/longitude nesting clusters at the poles, which looks visibly wrong on exactly the models that
 * need this.
 */
export function onSphere(
  count: number,
  radius: number,
  options: { label?: (index: number) => string } = {},
): Placement[] {
  const total = Math.max(0, Math.floor(count));
  const placements: Placement[] = [];

  for (let i = 0; i < total; i += 1) {
    const y = total === 1 ? 0 : 1 - (i / (total - 1)) * 2;
    const ringRadius = Math.sqrt(Math.max(0, 1 - y * y));
    const angle = GOLDEN_ANGLE * i;
    const position: Vec3 = [
      Math.cos(angle) * ringRadius * radius,
      y * radius,
      Math.sin(angle) * ringRadius * radius,
    ];

    const outward = normalize(position);
    const yaw = Math.atan2(outward[0], outward[2]);
    const pitch = -Math.asin(Math.max(-1, Math.min(1, outward[1])));

    placements.push({
      position,
      rotation: [pitch, yaw, 0],
      ...(options.label ? { label: options.label(i) } : {}),
    });
  }

  return placements;
}

/**
 * A helical array — stair treads, screw flights, DNA base pairs, spiral ramps.
 */
export function helical(
  count: number,
  radius: number,
  pitch: number,
  turns: number,
  options: { faceOutward?: boolean; label?: (index: number) => string } = {},
): Placement[] {
  const total = Math.max(0, Math.floor(count));
  const faceOutward = options.faceOutward ?? true;
  const placements: Placement[] = [];

  for (let i = 0; i < total; i += 1) {
    const t = total === 1 ? 0 : i / (total - 1);
    const angle = t * turns * TAU;
    placements.push({
      position: [Math.cos(angle) * radius, t * turns * pitch, Math.sin(angle) * radius],
      ...(faceOutward ? { rotation: [0, -angle, 0] as Vec3 } : {}),
      ...(options.label ? { label: options.label(i) } : {}),
    });
  }

  return placements;
}

/**
 * Pseudo-random scatter inside a box, with a minimum separation.
 *
 * Trees, debris, cells, molecules, crowd. The separation constraint matters: unconstrained random placement
 * produces visible clumps and gaps that read as a bug, and `01`'s cleanliness dimension penalises exactly that
 * kind of visual noise. Rejection sampling is bounded so a request that cannot be satisfied returns fewer
 * placements rather than looping.
 */
export function scatter(
  count: number,
  extents: readonly [number, number, number],
  random: () => number,
  options: {
    minSeparation?: number;
    randomRotation?: boolean;
    scaleRange?: readonly [number, number];
    label?: (index: number) => string;
  } = {},
): Placement[] {
  const total = Math.max(0, Math.floor(count));
  const separation = options.minSeparation ?? 0;
  const separationSquared = separation * separation;
  const placements: Placement[] = [];

  // 30 attempts per placement is the standard rejection-sampling budget: enough to fill a reasonable density,
  // bounded enough that an impossible request fails fast instead of hanging the build.
  const maxAttempts = 30;

  for (let i = 0; i < total; i += 1) {
    let placed = false;
    for (let attempt = 0; attempt < maxAttempts && !placed; attempt += 1) {
      const position: Vec3 = [
        (random() - 0.5) * extents[0],
        (random() - 0.5) * extents[1],
        (random() - 0.5) * extents[2],
      ];

      if (separationSquared > 0) {
        let tooClose = false;
        for (const existing of placements) {
          const dx = existing.position[0] - position[0];
          const dy = existing.position[1] - position[1];
          const dz = existing.position[2] - position[2];
          if (dx * dx + dy * dy + dz * dz < separationSquared) {
            tooClose = true;
            break;
          }
        }
        if (tooClose) continue;
      }

      const scaleRange = options.scaleRange;
      const scale = scaleRange ? lerp(scaleRange[0], scaleRange[1], random()) : 1;

      placements.push({
        position,
        ...(options.randomRotation ? { rotation: [0, random() * TAU, 0] as Vec3 } : {}),
        ...(scaleRange ? { scale: [scale, scale, scale] as Vec3 } : {}),
        ...(options.label ? { label: options.label(i) } : {}),
      });
      placed = true;
    }
  }

  return placements;
}

/**
 * Mirror a placement list across a plane.
 *
 * Composes with every other helper, which is the point: `mirror(radial(19, r), 'x')` produces a symmetric
 * 38-blade arrangement from one 19-blade definition.
 */
export function mirrorPlacements(
  placements: readonly Placement[],
  axis: 'x' | 'y' | 'z',
): Placement[] {
  const index = axis === 'x' ? 0 : axis === 'y' ? 1 : 2;
  return [
    ...placements,
    ...placements.map((placement) => {
      const position: Vec3 = [...placement.position] as Vec3;
      position[index] = -position[index];
      return {
        ...placement,
        position,
        ...(placement.label ? { label: `${placement.label} (mirrored)` } : {}),
      };
    }),
  ];
}

/** Offset every placement by a fixed vector — reposition a whole pattern without regenerating it. */
export function offsetPlacements(placements: readonly Placement[], offset: Vec3): Placement[] {
  return placements.map((placement) => ({
    ...placement,
    position: [
      placement.position[0] + offset[0],
      placement.position[1] + offset[1],
      placement.position[2] + offset[2],
    ] as Vec3,
  }));
}
