/**
 * `MeshData` — the one currency every geometry builder deals in.
 *
 * This is the deliberate answer to the requirement that the AI never be limited to a fixed set of
 * shapes. `00-GOAL.md` states the principle ("the ceiling is the API, not the schema"; "data can only
 * describe what the engine already anticipates"), and the mechanism is this type: every builder —
 * primitive, revolve, sweep, marching-cubes isosurface, or a raw typed array the model computed itself —
 * returns plain triangle data. The set of expressible shapes is therefore the set of shapes expressible
 * as triangles, which is a mathematical ceiling rather than an engine one.
 *
 * Three consequences that shape everything downstream:
 *
 *   1. **Builders compose.** A modifier takes `MeshData` and returns `MeshData`, so `twist(subdivide(
 *      revolve(profile)))` is ordinary function composition rather than a special case someone had to
 *      anticipate.
 *   2. **Cost is measured, not trusted.** Vertex and triangle counts come from the arrays themselves, so
 *      admission pricing (`08`) works on shapes the engine has never seen.
 *   3. **Nothing here touches a GPU.** The type is plain arrays, which is what lets the whole geometry
 *      layer run in Node for the headless audit.
 */

/**
 * Interleaved triangle geometry.
 *
 * Typed arrays rather than arrays of objects, for two reasons that both matter at 300-part scale: they
 * transfer to the host as `ArrayBuffer`s with zero copying, and they avoid the per-vertex object
 * allocation that `08` bans from the hot path.
 */
export interface MeshData {
  /** xyz per vertex, metres. Length is always a multiple of 3. */
  positions: Float32Array;
  /** Triangle indices. Absent means the positions are already a triangle soup. */
  indices?: Uint32Array;
  /** Unit normals, xyz per vertex. Absent means the realizer computes them. */
  normals?: Float32Array;
  /** uv per vertex, for procedural texturing. */
  uvs?: Float32Array;
  /** Per-vertex rgb in linear space, for gradient and field-value shading. */
  colors?: Float32Array;
  /**
   * Named vertex ranges within this mesh.
   *
   * The mechanism behind selectable sub-features on a single buffer: a swept pipe can name its inlet,
   * bend and outlet without becoming three draw calls. `03` R3 needs a click to resolve to something the
   * learner can be told about; this is how one mesh answers for several teachable regions.
   */
  groups?: Array<{ name: string; start: number; count: number }>;
}

/** Vertex count derived from the buffer, never carried separately — two sources of truth would drift. */
export const vertexCount = (mesh: MeshData): number => mesh.positions.length / 3;

/** Triangle count, respecting whether the mesh is indexed. */
export const triangleCount = (mesh: MeshData): number =>
  mesh.indices ? mesh.indices.length / 3 : mesh.positions.length / 9;

/**
 * A 2D profile: the input to every solid-producing operator.
 *
 * `revolve`, `extrude`, `sweep` and `loft` all take profiles, and profiles are produced by their own
 * small algebra (polygon, bezier, arc, offset, fillet, boolean). That split is what makes real
 * engineering shapes reachable: a turbine blade is an airfoil profile swept with a twist law, not a
 * bespoke `turbineBlade()` function someone had to write in advance.
 */
export interface Profile {
  /** xy pairs in profile space. */
  points: Float32Array;
  /** True when the last point connects back to the first. */
  closed: boolean;
  /**
   * Inner loops to subtract — bolt holes, cooling passages, a pipe's bore.
   *
   * Holes live on the profile rather than requiring a CSG pass because that is dramatically cheaper: a
   * flange with 24 bolt holes triangulates once here, versus 24 boolean operations on a solid.
   */
  holes?: Float32Array[];
}

/** Point count in a profile. */
export const profilePointCount = (profile: Profile): number => profile.points.length / 2;

/** A 3D path: the spine for `sweep`, the route for particle flow, the rail for a camera move. */
export interface Path3 {
  /** xyz per point, metres. */
  points: Float32Array;
  closed: boolean;
  /**
   * Optional per-point up vector, xyz.
   *
   * Without it a sweep derives its frame from the curve, and a curve with an inflection produces a
   * visible twist flip — the classic artifact in a swept pipe that bends through vertical. Authored ups
   * are how a model avoids it.
   */
  ups?: Float32Array;
}

/** Point count in a path. */
export const pathPointCount = (path: Path3): number => path.points.length / 3;

/**
 * An axis-aligned bounding box, accumulated as geometry is built.
 *
 * Kept as six numbers rather than a class because it is computed for every part in a 300-part model, and
 * because `08` warns that "a NaN-poisoned or stale bounding sphere silently breaks culling (and
 * raycasting) for a whole subtree".
 */
export interface Bounds {
  minX: number;
  minY: number;
  minZ: number;
  maxX: number;
  maxY: number;
  maxZ: number;
}

/** An empty bounds, ready to be expanded. Infinities so the first point always wins both comparisons. */
export const emptyBounds = (): Bounds => ({
  minX: Number.POSITIVE_INFINITY,
  minY: Number.POSITIVE_INFINITY,
  minZ: Number.POSITIVE_INFINITY,
  maxX: Number.NEGATIVE_INFINITY,
  maxY: Number.NEGATIVE_INFINITY,
  maxZ: Number.NEGATIVE_INFINITY,
});

/** Compute the bounds of a mesh in one pass, skipping non-finite vertices. */
export function meshBounds(mesh: MeshData): Bounds {
  const bounds = emptyBounds();
  const { positions } = mesh;
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i] as number;
    const y = positions[i + 1] as number;
    const z = positions[i + 2] as number;
    // A single NaN vertex would poison min/max for the whole subtree, so it is skipped rather than
    // propagated. Validation reports it separately; culling must not be collateral damage.
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
    if (x < bounds.minX) bounds.minX = x;
    if (y < bounds.minY) bounds.minY = y;
    if (z < bounds.minZ) bounds.minZ = z;
    if (x > bounds.maxX) bounds.maxX = x;
    if (y > bounds.maxY) bounds.maxY = y;
    if (z > bounds.maxZ) bounds.maxZ = z;
  }
  return bounds;
}

/** True when no finite vertex was seen — an empty or fully-poisoned mesh. */
export const boundsAreEmpty = (bounds: Bounds): boolean => bounds.minX > bounds.maxX;

/** Radius of the sphere centred on the bounds' centre that contains the box. */
export function boundingRadius(bounds: Bounds): number {
  if (boundsAreEmpty(bounds)) return 0;
  const dx = (bounds.maxX - bounds.minX) / 2;
  const dy = (bounds.maxY - bounds.minY) / 2;
  const dz = (bounds.maxZ - bounds.minZ) / 2;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/** Centre of a bounds; the default pivot for rotation and the origin for explode offsets. */
export function boundsCenter(bounds: Bounds): [number, number, number] {
  if (boundsAreEmpty(bounds)) return [0, 0, 0];
  return [
    (bounds.minX + bounds.maxX) / 2,
    (bounds.minY + bounds.maxY) / 2,
    (bounds.minZ + bounds.maxZ) / 2,
  ];
}

/**
 * Every problem found in a mesh, with enough detail to enumerate as a repair instruction.
 *
 * Validation is separate from construction because a builder should be free to produce whatever the
 * model's math produced; catching `NaN` is the *gate's* job, not the extruder's. `02` R1 requires
 * non-finite values to be rejected before they reach the solver, and this is where that happens for
 * geometry.
 */
export interface MeshProblem {
  kind:
    | 'non_finite'
    | 'empty'
    | 'index_out_of_range'
    | 'index_count'
    | 'position_count'
    | 'degenerate_triangle'
    | 'attribute_length';
  message: string;
  /** How many vertices or triangles were affected, when the problem is countable. */
  count?: number;
}

/**
 * Check a mesh for the faults that break rendering, picking or physics downstream.
 *
 * Deliberately reports rather than throws: a model with 12 degenerate triangles out of 40 000 should be
 * cleaned and shipped, while one with zero finite vertices should be refused. The caller decides, and it
 * needs the counts to decide well.
 */
export function validateMesh(mesh: MeshData): MeshProblem[] {
  const problems: MeshProblem[] = [];
  const { positions, indices, normals, uvs, colors } = mesh;

  if (positions.length === 0) {
    problems.push({ kind: 'empty', message: 'The mesh has no vertices.' });
    return problems;
  }

  if (positions.length % 3 !== 0) {
    problems.push({
      kind: 'position_count',
      message: `Position array length ${positions.length} is not a multiple of 3.`,
    });
  }

  let nonFinite = 0;
  for (let i = 0; i < positions.length; i += 1) {
    if (!Number.isFinite(positions[i] as number)) nonFinite += 1;
  }
  if (nonFinite > 0) {
    problems.push({
      kind: 'non_finite',
      message: `${nonFinite} position components are NaN or Infinity. Check for division by zero or a square root of a negative value in the geometry math.`,
      count: nonFinite,
    });
  }

  const vertices = positions.length / 3;

  if (indices) {
    if (indices.length % 3 !== 0) {
      problems.push({
        kind: 'index_count',
        message: `Index array length ${indices.length} is not a multiple of 3, so the last triangle is incomplete.`,
      });
    }
    let outOfRange = 0;
    let degenerate = 0;
    for (let i = 0; i + 2 < indices.length; i += 3) {
      const a = indices[i] as number;
      const b = indices[i + 1] as number;
      const c = indices[i + 2] as number;
      if (a >= vertices || b >= vertices || c >= vertices) outOfRange += 1;
      // A triangle with a repeated index has zero area: invisible, but it still costs a draw and it
      // breaks normal computation for its neighbours.
      else if (a === b || b === c || a === c) degenerate += 1;
    }
    if (outOfRange > 0) {
      problems.push({
        kind: 'index_out_of_range',
        message: `${outOfRange} triangles reference vertices outside the position array (${vertices} vertices).`,
        count: outOfRange,
      });
    }
    if (degenerate > 0) {
      problems.push({
        kind: 'degenerate_triangle',
        message: `${degenerate} triangles have a repeated vertex and zero area.`,
        count: degenerate,
      });
    }
  }

  if (normals && normals.length !== positions.length) {
    problems.push({
      kind: 'attribute_length',
      message: `Normal array has ${normals.length / 3} entries for ${vertices} vertices.`,
    });
  }
  if (uvs && uvs.length / 2 !== vertices) {
    problems.push({
      kind: 'attribute_length',
      message: `UV array has ${uvs.length / 2} entries for ${vertices} vertices.`,
    });
  }
  if (colors && colors.length / 3 !== vertices) {
    problems.push({
      kind: 'attribute_length',
      message: `Color array has ${colors.length / 3} entries for ${vertices} vertices.`,
    });
  }

  return problems;
}

/**
 * Remove degenerate triangles and clamp non-finite vertices to the origin.
 *
 * The rationale is `01`'s honesty rule applied to geometry: a mesh with a handful of bad triangles still
 * teaches its lesson, and silently rendering garbage or refusing the whole model are both worse than
 * repairing and reporting. The repair is conservative — it never moves a good vertex.
 */
export function sanitizeMesh(mesh: MeshData): { mesh: MeshData; repaired: number } {
  const positions = mesh.positions;
  let repaired = 0;

  for (let i = 0; i < positions.length; i += 1) {
    if (!Number.isFinite(positions[i] as number)) {
      positions[i] = 0;
      repaired += 1;
    }
  }

  if (!mesh.indices) return { mesh, repaired };

  const vertices = positions.length / 3;
  const kept: number[] = [];
  const indices = mesh.indices;
  for (let i = 0; i + 2 < indices.length; i += 3) {
    const a = indices[i] as number;
    const b = indices[i + 1] as number;
    const c = indices[i + 2] as number;
    if (a >= vertices || b >= vertices || c >= vertices) {
      repaired += 1;
      continue;
    }
    if (a === b || b === c || a === c) {
      repaired += 1;
      continue;
    }
    kept.push(a, b, c);
  }

  if (kept.length === indices.length) return { mesh, repaired };
  return { mesh: { ...mesh, indices: new Uint32Array(kept) }, repaired };
}

/**
 * Compute smooth vertex normals by area-weighted face averaging.
 *
 * Area weighting rather than plain averaging because it is what makes a mesh with uneven tessellation —
 * every procedural mesh — shade correctly: a large face should influence a shared vertex more than a
 * sliver does. The difference is visible on any lofted or swept surface, which is most of what this
 * engine builds.
 */
export function computeNormals(mesh: MeshData): Float32Array {
  const { positions } = mesh;
  const normals = new Float32Array(positions.length);
  const indices = mesh.indices;
  const triangles = indices ? indices.length / 3 : positions.length / 9;

  for (let t = 0; t < triangles; t += 1) {
    const ia = indices ? (indices[t * 3] as number) : t * 3;
    const ib = indices ? (indices[t * 3 + 1] as number) : t * 3 + 1;
    const ic = indices ? (indices[t * 3 + 2] as number) : t * 3 + 2;

    const ax = positions[ia * 3] as number;
    const ay = positions[ia * 3 + 1] as number;
    const az = positions[ia * 3 + 2] as number;
    const bx = positions[ib * 3] as number;
    const by = positions[ib * 3 + 1] as number;
    const bz = positions[ib * 3 + 2] as number;
    const cx = positions[ic * 3] as number;
    const cy = positions[ic * 3 + 1] as number;
    const cz = positions[ic * 3 + 2] as number;

    // The un-normalised cross product's magnitude is twice the triangle's area, which is exactly the
    // weight we want — so no extra area computation is needed.
    const e1x = bx - ax;
    const e1y = by - ay;
    const e1z = bz - az;
    const e2x = cx - ax;
    const e2y = cy - ay;
    const e2z = cz - az;
    const nx = e1y * e2z - e1z * e2y;
    const ny = e1z * e2x - e1x * e2z;
    const nz = e1x * e2y - e1y * e2x;

    normals[ia * 3] = (normals[ia * 3] as number) + nx;
    normals[ia * 3 + 1] = (normals[ia * 3 + 1] as number) + ny;
    normals[ia * 3 + 2] = (normals[ia * 3 + 2] as number) + nz;
    normals[ib * 3] = (normals[ib * 3] as number) + nx;
    normals[ib * 3 + 1] = (normals[ib * 3 + 1] as number) + ny;
    normals[ib * 3 + 2] = (normals[ib * 3 + 2] as number) + nz;
    normals[ic * 3] = (normals[ic * 3] as number) + nx;
    normals[ic * 3 + 1] = (normals[ic * 3 + 1] as number) + ny;
    normals[ic * 3 + 2] = (normals[ic * 3 + 2] as number) + nz;
  }

  for (let i = 0; i < normals.length; i += 3) {
    const x = normals[i] as number;
    const y = normals[i + 1] as number;
    const z = normals[i + 2] as number;
    const length = Math.sqrt(x * x + y * y + z * z);
    if (length > 1e-12) {
      normals[i] = x / length;
      normals[i + 1] = y / length;
      normals[i + 2] = z / length;
    } else {
      // An isolated vertex or a fully-degenerate neighbourhood: point up rather than leave a zero
      // normal, which would render as a black facet and read as a hole in the model.
      normals[i] = 0;
      normals[i + 1] = 1;
      normals[i + 2] = 0;
    }
  }

  return normals;
}

/**
 * Concatenate meshes into one buffer, preserving each source as a named group.
 *
 * This is the merge path `08` asks for ("never-moving decoration merges into few buffers") and also how
 * a builder that produces several shells — a revolve with caps, a shelled solid — returns a single mesh
 * whose regions stay individually addressable.
 */
export function mergeMeshes(parts: Array<{ name: string; mesh: MeshData }>): MeshData {
  let totalVertices = 0;
  let totalIndices = 0;
  let hasUvs = false;
  let hasColors = false;

  for (const { mesh } of parts) {
    totalVertices += mesh.positions.length / 3;
    totalIndices += mesh.indices ? mesh.indices.length : mesh.positions.length / 3;
    if (mesh.uvs) hasUvs = true;
    if (mesh.colors) hasColors = true;
  }

  const positions = new Float32Array(totalVertices * 3);
  const indices = new Uint32Array(totalIndices);
  const uvs = hasUvs ? new Float32Array(totalVertices * 2) : undefined;
  const colors = hasColors ? new Float32Array(totalVertices * 3) : undefined;
  const groups: Array<{ name: string; start: number; count: number }> = [];

  let vertexOffset = 0;
  let indexOffset = 0;

  for (const { name, mesh } of parts) {
    const count = mesh.positions.length / 3;
    positions.set(mesh.positions, vertexOffset * 3);
    if (uvs && mesh.uvs) uvs.set(mesh.uvs, vertexOffset * 2);
    if (colors && mesh.colors) colors.set(mesh.colors, vertexOffset * 3);

    const startIndex = indexOffset;
    if (mesh.indices) {
      for (let i = 0; i < mesh.indices.length; i += 1) {
        indices[indexOffset + i] = (mesh.indices[i] as number) + vertexOffset;
      }
      indexOffset += mesh.indices.length;
    } else {
      // Un-indexed source: synthesise a sequential index run so the merged mesh is uniformly indexed.
      for (let i = 0; i < count; i += 1) indices[indexOffset + i] = vertexOffset + i;
      indexOffset += count;
    }

    groups.push({ name, start: startIndex, count: indexOffset - startIndex });
    vertexOffset += count;
  }

  return {
    positions,
    indices,
    ...(uvs ? { uvs } : {}),
    ...(colors ? { colors } : {}),
    groups,
  };
}

/**
 * Apply a 4×4 transform to a copy of a mesh.
 *
 * Used by pattern helpers and by the merge path: baking a placement into vertices is what turns 24 bolts
 * into one buffer. The matrix is a flat 16-number array in column-major order, matching Three.js, so no
 * conversion happens at the boundary.
 */
export function transformMesh(mesh: MeshData, m: ArrayLike<number>): MeshData {
  const source = mesh.positions;
  const positions = new Float32Array(source.length);

  const m0 = m[0] as number;
  const m1 = m[1] as number;
  const m2 = m[2] as number;
  const m4 = m[4] as number;
  const m5 = m[5] as number;
  const m6 = m[6] as number;
  const m8 = m[8] as number;
  const m9 = m[9] as number;
  const m10 = m[10] as number;
  const m12 = m[12] as number;
  const m13 = m[13] as number;
  const m14 = m[14] as number;

  for (let i = 0; i < source.length; i += 3) {
    const x = source[i] as number;
    const y = source[i + 1] as number;
    const z = source[i + 2] as number;
    positions[i] = m0 * x + m4 * y + m8 * z + m12;
    positions[i + 1] = m1 * x + m5 * y + m9 * z + m13;
    positions[i + 2] = m2 * x + m6 * y + m10 * z + m14;
  }

  // Normals are dropped rather than transformed: doing it correctly needs the inverse-transpose, and
  // recomputing from the transformed positions is both cheaper and immune to a non-uniform scale.
  return {
    positions,
    ...(mesh.indices ? { indices: mesh.indices } : {}),
    ...(mesh.uvs ? { uvs: mesh.uvs } : {}),
    ...(mesh.colors ? { colors: mesh.colors } : {}),
    ...(mesh.groups ? { groups: mesh.groups } : {}),
  };
}
