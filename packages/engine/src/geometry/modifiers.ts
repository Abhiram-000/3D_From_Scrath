/**
 * The modifier pipeline: mesh in, mesh out.
 *
 * Every function here takes `MeshData` and returns `MeshData`, which makes shapes *derivations* rather than
 * lookups — `twist(subdivide(revolve(profile)))` is ordinary composition, and the manifest records the chain
 * as `modifiers: ['revolve', 'subdivide', 'twist']` for the audit to read as evidence of authored detail.
 * `PLAN.md` §A3 names this as the fourth of the five mechanisms that keep the expressive ceiling open.
 *
 * Two disciplines run through the file. Nothing mutates its input, because a mesh may be the cached source
 * for several parts and an in-place twist would corrupt all of them. And every modifier is safe on degenerate
 * input, because these run on AI-authored geometry whose vertex counts and bounds are not known in advance.
 */
import {
  type Bounds,
  type MeshData,
  boundsAreEmpty,
  computeNormals,
  meshBounds,
} from './mesh-data.ts';
import { TAU, clamp, fbm, lerp, smootherstep } from '../math/index.ts';

/** Copy the attribute arrays a positional modifier does not change. */
const carry = (mesh: MeshData, positions: Float32Array, recomputeNormals = true): MeshData => {
  const result: MeshData = {
    positions,
    ...(mesh.indices ? { indices: mesh.indices } : {}),
    ...(mesh.uvs ? { uvs: mesh.uvs } : {}),
    ...(mesh.colors ? { colors: mesh.colors } : {}),
    ...(mesh.groups ? { groups: mesh.groups } : {}),
  };
  // Normals must be rebuilt after any deformation: reusing the originals is the classic cause of a twisted
  // part that still shades as though it were straight, which reads as a lighting bug rather than a shape.
  if (recomputeNormals) result.normals = computeNormals(result);
  return result;
};

/** Extent along one axis, used to normalise a deformation's parameter into `[0, 1]`. */
const axisExtent = (bounds: Bounds, axis: 'x' | 'y' | 'z'): { min: number; span: number } => {
  if (axis === 'x') return { min: bounds.minX, span: bounds.maxX - bounds.minX };
  if (axis === 'y') return { min: bounds.minY, span: bounds.maxY - bounds.minY };
  return { min: bounds.minZ, span: bounds.maxZ - bounds.minZ };
};

/**
 * Twist a mesh around an axis, proportional to position along it.
 *
 * Drill bits, augers, turbine blades, twisted columns, DNA. The rotation is a function of position rather
 * than a constant, which is what distinguishes a twist from a rotation.
 */
export function twist(mesh: MeshData, radians: number, axis: 'x' | 'y' | 'z' = 'y'): MeshData {
  const bounds = meshBounds(mesh);
  if (boundsAreEmpty(bounds)) return mesh;
  const { min, span } = axisExtent(bounds, axis);
  if (span < 1e-9) return mesh;

  const source = mesh.positions;
  const positions = new Float32Array(source.length);

  for (let i = 0; i < source.length; i += 3) {
    const x = source[i] as number;
    const y = source[i + 1] as number;
    const z = source[i + 2] as number;
    const along = axis === 'x' ? x : axis === 'y' ? y : z;
    const angle = ((along - min) / span) * radians;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);

    if (axis === 'y') {
      positions[i] = x * cos - z * sin;
      positions[i + 1] = y;
      positions[i + 2] = x * sin + z * cos;
    } else if (axis === 'x') {
      positions[i] = x;
      positions[i + 1] = y * cos - z * sin;
      positions[i + 2] = y * sin + z * cos;
    } else {
      positions[i] = x * cos - y * sin;
      positions[i + 1] = x * sin + y * cos;
      positions[i + 2] = z;
    }
  }

  return carry(mesh, positions);
}

/**
 * Bend a mesh around a circular arc.
 *
 * Pipes without a swept path, curved beams, a spine, a bent sheet. Bending after the fact is often the
 * cheaper authoring route than constructing a curved path first, and both should be available.
 */
export function bend(
  mesh: MeshData,
  radians: number,
  axis: 'x' | 'y' | 'z' = 'y',
  around: 'x' | 'y' | 'z' = 'z',
): MeshData {
  const bounds = meshBounds(mesh);
  if (boundsAreEmpty(bounds)) return mesh;
  const { min, span } = axisExtent(bounds, axis);
  if (span < 1e-9 || Math.abs(radians) < 1e-9) return mesh;

  // Arc radius that maps the mesh's length onto the requested sweep. A shorter mesh bends tighter for the
  // same angle, which is what "bend by 90°" should mean.
  const radius = span / radians;

  const source = mesh.positions;
  const positions = new Float32Array(source.length);

  for (let i = 0; i < source.length; i += 3) {
    const x = source[i] as number;
    const y = source[i + 1] as number;
    const z = source[i + 2] as number;

    const along = axis === 'x' ? x : axis === 'y' ? y : z;
    const offset = around === 'x' ? x : around === 'y' ? y : z;
    const angle = (along - min) / radius;

    const bentAlong = Math.sin(angle) * (radius - offset);
    const bentOffset = radius - Math.cos(angle) * (radius - offset);

    let nx = x;
    let ny = y;
    let nz = z;
    if (axis === 'y') ny = bentAlong + min;
    else if (axis === 'x') nx = bentAlong + min;
    else nz = bentAlong + min;

    if (around === 'x') nx = bentOffset;
    else if (around === 'y') ny = bentOffset;
    else nz = bentOffset;

    positions[i] = nx;
    positions[i + 1] = ny;
    positions[i + 2] = nz;
  }

  return carry(mesh, positions);
}

/**
 * Taper a mesh: scale cross-sections along an axis.
 *
 * Draft angles on cast parts, tapered columns, nozzles, a tree trunk. `easing` shapes the taper so it can be
 * conical, trumpet-like or ogive rather than only linear.
 */
export function taper(
  mesh: MeshData,
  endScale: number,
  axis: 'x' | 'y' | 'z' = 'y',
  easing: (t: number) => number = (t) => t,
): MeshData {
  const bounds = meshBounds(mesh);
  if (boundsAreEmpty(bounds)) return mesh;
  const { min, span } = axisExtent(bounds, axis);
  if (span < 1e-9) return mesh;

  const source = mesh.positions;
  const positions = new Float32Array(source.length);

  for (let i = 0; i < source.length; i += 3) {
    const x = source[i] as number;
    const y = source[i + 1] as number;
    const z = source[i + 2] as number;
    const along = axis === 'x' ? x : axis === 'y' ? y : z;
    const t = clamp((along - min) / span, 0, 1);
    const scale = lerp(1, endScale, easing(t));

    positions[i] = axis === 'x' ? x : x * scale;
    positions[i + 1] = axis === 'y' ? y : y * scale;
    positions[i + 2] = axis === 'z' ? z : z * scale;
  }

  return carry(mesh, positions);
}

/**
 * Displace vertices along their normals by fractal noise.
 *
 * Rock, bark, corrosion, tissue, terrain, an asteroid. This is the difference between "a sphere labelled
 * asteroid" and something a learner accepts as an asteroid, and `01`'s attractiveness dimension asks for
 * exactly that kind of authored surface — while its texture rules ask that it be *procedural*, not a photo.
 */
export function displace(mesh: MeshData, amplitude: number, frequency = 1, octaves = 4): MeshData {
  const source = mesh.positions;
  const normals = mesh.normals ?? computeNormals(mesh);
  const positions = new Float32Array(source.length);

  for (let i = 0; i < source.length; i += 3) {
    const x = source[i] as number;
    const y = source[i + 1] as number;
    const z = source[i + 2] as number;
    // Sampled at the *original* position so the displacement is stable: sampling the moving position would
    // make the result depend on iteration order.
    const offset =
      (fbm(x * frequency, y * frequency, z * frequency, octaves) - 0.5) * 2 * amplitude;
    positions[i] = x + (normals[i] as number) * offset;
    positions[i + 1] = y + (normals[i + 1] as number) * offset;
    positions[i + 2] = z + (normals[i + 2] as number) * offset;
  }

  return carry(mesh, positions);
}

/**
 * Weld coincident vertices within a tolerance.
 *
 * The prerequisite for smooth shading on procedural output: marching cubes, merged meshes and stitched
 * strips all leave duplicate vertices at seams, and duplicates cannot share a normal — so the seam renders as
 * a visible crease on what should be a continuous surface. Welding is also what makes `subdivide` and
 * `simplify` behave, since both need real topology.
 */
export function weld(mesh: MeshData, tolerance = 1e-5): MeshData {
  const source = mesh.positions;
  const count = source.length / 3;
  if (count === 0) return mesh;

  // Quantising to a grid turns "within tolerance" into an exact hash lookup, which is O(n) instead of the
  // O(n²) a pairwise distance test would cost. At 200k vertices that is the difference between instant and
  // unusable.
  const scale = 1 / Math.max(1e-9, tolerance);
  const map = new Map<string, number>();
  const remap = new Uint32Array(count);
  const kept: number[] = [];

  for (let i = 0; i < count; i += 1) {
    const x = source[i * 3] as number;
    const y = source[i * 3 + 1] as number;
    const z = source[i * 3 + 2] as number;
    const key = `${Math.round(x * scale)},${Math.round(y * scale)},${Math.round(z * scale)}`;
    const existing = map.get(key);
    if (existing !== undefined) {
      remap[i] = existing;
      continue;
    }
    const index = kept.length / 3;
    map.set(key, index);
    remap[i] = index;
    kept.push(x, y, z);
  }

  if (kept.length / 3 === count) return mesh;

  const indices = mesh.indices ?? Uint32Array.from({ length: count }, (_unused, i) => i);
  const welded = new Uint32Array(indices.length);
  for (let i = 0; i < indices.length; i += 1) {
    welded[i] = remap[indices[i] as number] as number;
  }

  const result: MeshData = {
    positions: new Float32Array(kept),
    indices: welded,
    ...(mesh.groups ? { groups: mesh.groups } : {}),
  };
  result.normals = computeNormals(result);
  return result;
}

/**
 * Loop-style subdivision: split every triangle into four.
 *
 * Used to give a deformation something to deform. A displaced or bent low-poly mesh moves its few vertices and
 * looks faceted; subdividing first is what makes the result read as a curved surface. Vertex count grows 4×
 * per level, so the caller's level choice is a real cost decision the budget system prices.
 */
export function subdivide(mesh: MeshData, levels = 1): MeshData {
  let current = mesh;
  const passes = clamp(Math.floor(levels), 0, 3);

  for (let pass = 0; pass < passes; pass += 1) {
    const source = current.positions;
    const indices = current.indices;
    if (!indices) break;

    const positions: number[] = Array.from(source);
    const newIndices: number[] = [];
    // Edge midpoints are cached so adjacent triangles share them; without the cache the mesh would split
    // into disconnected triangles and every seam would open.
    const midpoints = new Map<number, number>();

    const midpoint = (a: number, b: number): number => {
      const key = a < b ? a * source.length + b : b * source.length + a;
      const cached = midpoints.get(key);
      if (cached !== undefined) return cached;
      const index = positions.length / 3;
      positions.push(
        ((source[a * 3] as number) + (source[b * 3] as number)) / 2,
        ((source[a * 3 + 1] as number) + (source[b * 3 + 1] as number)) / 2,
        ((source[a * 3 + 2] as number) + (source[b * 3 + 2] as number)) / 2,
      );
      midpoints.set(key, index);
      return index;
    };

    for (let i = 0; i + 2 < indices.length; i += 3) {
      const a = indices[i] as number;
      const b = indices[i + 1] as number;
      const c = indices[i + 2] as number;
      const ab = midpoint(a, b);
      const bc = midpoint(b, c);
      const ca = midpoint(c, a);
      newIndices.push(a, ab, ca, ab, b, bc, ca, bc, c, ab, bc, ca);
    }

    current = {
      positions: new Float32Array(positions),
      indices: new Uint32Array(newIndices),
      ...(current.groups ? { groups: current.groups } : {}),
    };
    current.normals = computeNormals(current);
  }

  return current;
}

/**
 * Laplacian smoothing: move each vertex toward the average of its neighbours.
 *
 * The finishing pass for noisy procedural output — a displaced mesh, a marching-cubes surface, a scanned
 * profile. `strength` below 1 keeps the shape recognisable while removing the high-frequency jitter that
 * reads as noise rather than detail, which is `01`'s cleanliness dimension in one operation.
 */
export function smooth(mesh: MeshData, iterations = 1, strength = 0.5): MeshData {
  const indices = mesh.indices;
  if (!indices) return mesh;

  const count = mesh.positions.length / 3;
  let positions = new Float32Array(mesh.positions);

  // Adjacency built once and reused across iterations: rebuilding per pass would dominate the cost.
  const neighbours: number[][] = Array.from({ length: count }, () => []);
  for (let i = 0; i + 2 < indices.length; i += 3) {
    const a = indices[i] as number;
    const b = indices[i + 1] as number;
    const c = indices[i + 2] as number;
    (neighbours[a] as number[]).push(b, c);
    (neighbours[b] as number[]).push(a, c);
    (neighbours[c] as number[]).push(a, b);
  }

  const passes = clamp(Math.floor(iterations), 0, 8);
  const factor = clamp(strength, 0, 1);

  for (let pass = 0; pass < passes; pass += 1) {
    const next = new Float32Array(positions.length);
    for (let v = 0; v < count; v += 1) {
      const adjacent = neighbours[v] as number[];
      if (adjacent.length === 0) {
        next[v * 3] = positions[v * 3] as number;
        next[v * 3 + 1] = positions[v * 3 + 1] as number;
        next[v * 3 + 2] = positions[v * 3 + 2] as number;
        continue;
      }
      let sx = 0;
      let sy = 0;
      let sz = 0;
      for (const other of adjacent) {
        sx += positions[other * 3] as number;
        sy += positions[other * 3 + 1] as number;
        sz += positions[other * 3 + 2] as number;
      }
      const inverse = 1 / adjacent.length;
      next[v * 3] = lerp(positions[v * 3] as number, sx * inverse, factor);
      next[v * 3 + 1] = lerp(positions[v * 3 + 1] as number, sy * inverse, factor);
      next[v * 3 + 2] = lerp(positions[v * 3 + 2] as number, sz * inverse, factor);
    }
    positions = next;
  }

  return carry(mesh, positions);
}

/**
 * Reduce triangle count by collapsing vertices onto a grid.
 *
 * Vertex clustering rather than edge-collapse: it is O(n), it never fails, and it preserves overall silhouette
 * — which is exactly the trade `08`'s decimation rung wants, where "segment counts shrink with
 * recognizability floors — a coarser sphere, never a triangle". A quadric-error simplifier would look better
 * and could fail unpredictably on the arbitrary output a model produces.
 */
export function simplify(mesh: MeshData, gridSize: number): MeshData {
  const bounds = meshBounds(mesh);
  if (boundsAreEmpty(bounds)) return mesh;

  const cell = Math.max(1e-6, gridSize);
  const source = mesh.positions;
  const count = source.length / 3;

  const clusters = new Map<string, { index: number; x: number; y: number; z: number; n: number }>();
  const remap = new Uint32Array(count);

  for (let i = 0; i < count; i += 1) {
    const x = source[i * 3] as number;
    const y = source[i * 3 + 1] as number;
    const z = source[i * 3 + 2] as number;
    const key = `${Math.floor(x / cell)},${Math.floor(y / cell)},${Math.floor(z / cell)}`;
    const existing = clusters.get(key);
    if (existing) {
      // Averaging within the cell keeps the surface centred where the original vertices were, rather than
      // snapping it to grid corners and visibly shrinking the shape.
      existing.x += x;
      existing.y += y;
      existing.z += z;
      existing.n += 1;
      remap[i] = existing.index;
      continue;
    }
    const index = clusters.size;
    clusters.set(key, { index, x, y, z, n: 1 });
    remap[i] = index;
  }

  const positions = new Float32Array(clusters.size * 3);
  for (const cluster of clusters.values()) {
    positions[cluster.index * 3] = cluster.x / cluster.n;
    positions[cluster.index * 3 + 1] = cluster.y / cluster.n;
    positions[cluster.index * 3 + 2] = cluster.z / cluster.n;
  }

  const indices = mesh.indices ?? Uint32Array.from({ length: count }, (_unused, i) => i);
  const kept: number[] = [];
  for (let i = 0; i + 2 < indices.length; i += 3) {
    const a = remap[indices[i] as number] as number;
    const b = remap[indices[i + 1] as number] as number;
    const c = remap[indices[i + 2] as number] as number;
    // Triangles whose corners collapsed into one cell have zero area and are dropped.
    if (a === b || b === c || a === c) continue;
    kept.push(a, b, c);
  }

  const result: MeshData = { positions, indices: new Uint32Array(kept) };
  result.normals = computeNormals(result);
  return result;
}

/**
 * Mirror across a plane, optionally keeping both halves.
 *
 * Bilateral symmetry is everywhere in the domains this platform serves — anatomy, vehicles, molecules,
 * architecture — and modelling one half then mirroring is both half the tokens and guaranteed symmetric.
 */
export function mirror(mesh: MeshData, axis: 'x' | 'y' | 'z', keepOriginal = true): MeshData {
  const source = mesh.positions;
  const count = source.length / 3;
  const indices = mesh.indices ?? Uint32Array.from({ length: count }, (_unused, i) => i);

  const flipped = new Float32Array(source.length);
  for (let i = 0; i < source.length; i += 3) {
    flipped[i] = axis === 'x' ? -(source[i] as number) : (source[i] as number);
    flipped[i + 1] = axis === 'y' ? -(source[i + 1] as number) : (source[i + 1] as number);
    flipped[i + 2] = axis === 'z' ? -(source[i + 2] as number) : (source[i + 2] as number);
  }

  // Mirroring inverts handedness, so winding must be reversed or the reflected half renders inside-out.
  const flippedIndices = new Uint32Array(indices.length);
  for (let i = 0; i + 2 < indices.length; i += 3) {
    flippedIndices[i] = indices[i] as number;
    flippedIndices[i + 1] = indices[i + 2] as number;
    flippedIndices[i + 2] = indices[i + 1] as number;
  }

  if (!keepOriginal) {
    const result: MeshData = { positions: flipped, indices: flippedIndices };
    result.normals = computeNormals(result);
    return result;
  }

  const positions = new Float32Array(source.length * 2);
  positions.set(source, 0);
  positions.set(flipped, source.length);

  const combined = new Uint32Array(indices.length * 2);
  combined.set(indices, 0);
  for (let i = 0; i < flippedIndices.length; i += 1) {
    combined[indices.length + i] = (flippedIndices[i] as number) + count;
  }

  const result: MeshData = {
    positions,
    indices: combined,
    groups: [
      { name: 'original', start: 0, count: indices.length },
      { name: 'mirrored', start: indices.length, count: flippedIndices.length },
    ],
  };
  result.normals = computeNormals(result);
  return result;
}

/**
 * Scale, translate and rotate in one pass.
 *
 * A modifier rather than only a node transform because baking a transform into vertices is what lets several
 * shapes merge into one buffer — the draw-call reduction `08` asks for on static scaffolding.
 */
export function transform(
  mesh: MeshData,
  options: {
    translate?: readonly [number, number, number];
    scale?: readonly [number, number, number] | number;
    rotate?: readonly [number, number, number];
  },
): MeshData {
  const source = mesh.positions;
  const positions = new Float32Array(source.length);

  const [tx, ty, tz] = options.translate ?? [0, 0, 0];
  const scale = options.scale ?? 1;
  const [sx, sy, sz] = typeof scale === 'number' ? [scale, scale, scale] : scale;
  const [rx, ry, rz] = options.rotate ?? [0, 0, 0];

  const cx = Math.cos(rx);
  const sinx = Math.sin(rx);
  const cy = Math.cos(ry);
  const siny = Math.sin(ry);
  const cz = Math.cos(rz);
  const sinz = Math.sin(rz);

  for (let i = 0; i < source.length; i += 3) {
    let x = (source[i] as number) * sx;
    let y = (source[i + 1] as number) * sy;
    let z = (source[i + 2] as number) * sz;

    // XYZ order, matching the Euler convention in `math/compose` and Three.js's default.
    let ny = y * cx - z * sinx;
    let nz = y * sinx + z * cx;
    y = ny;
    z = nz;

    let nx = x * cy + z * siny;
    nz = -x * siny + z * cy;
    x = nx;
    z = nz;

    nx = x * cz - y * sinz;
    ny = x * sinz + y * cz;
    x = nx;
    y = ny;

    positions[i] = x + tx;
    positions[i + 1] = y + ty;
    positions[i + 2] = z + tz;
  }

  return carry(mesh, positions);
}

/**
 * Colour vertices from a scalar field.
 *
 * The mechanism behind `01`'s "heat map that shifts with the temperature parameter is a read-out wearing a
 * surface": stress on a beam, temperature across a plate, potential in a field, concentration in a volume.
 * Per-vertex colour is far cheaper than a texture and rebinds instantly when a parameter changes.
 */
export function colorByField(
  mesh: MeshData,
  field: (x: number, y: number, z: number) => number,
  ramp: (t: number) => readonly [number, number, number],
): MeshData {
  const source = mesh.positions;
  const count = source.length / 3;
  const colors = new Float32Array(count * 3);

  // Two passes so the ramp can be normalised across the actual value range: a fixed 0–1 assumption would
  // wash out any field whose values happen to sit in a narrow band.
  const values = new Float32Array(count);
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;

  for (let i = 0; i < count; i += 1) {
    const value = field(
      source[i * 3] as number,
      source[i * 3 + 1] as number,
      source[i * 3 + 2] as number,
    );
    const safe = Number.isFinite(value) ? value : 0;
    values[i] = safe;
    if (safe < min) min = safe;
    if (safe > max) max = safe;
  }

  const span = max - min;
  for (let i = 0; i < count; i += 1) {
    const t = span > 1e-12 ? ((values[i] as number) - min) / span : 0.5;
    const [r, g, b] = ramp(clamp(t, 0, 1));
    colors[i * 3] = r;
    colors[i * 3 + 1] = g;
    colors[i * 3 + 2] = b;
  }

  return { ...mesh, colors };
}

/**
 * Shell a surface into a solid wall of the given thickness.
 *
 * The cheap answer to "this needs to look real when cut away": a revolved bottle, a duct, a casing. Offsetting
 * along normals is not exact at sharp corners — the honest limitation — but for the smooth surfaces this is
 * used on it is correct, and it is orders of magnitude cheaper than an implicit re-mesh.
 */
export function shell(mesh: MeshData, thickness: number): MeshData {
  const source = mesh.positions;
  const normals = mesh.normals ?? computeNormals(mesh);
  const count = source.length / 3;
  const indices = mesh.indices ?? Uint32Array.from({ length: count }, (_unused, i) => i);

  const positions = new Float32Array(source.length * 2);
  positions.set(source, 0);
  for (let i = 0; i < source.length; i += 3) {
    positions[source.length + i] = (source[i] as number) - (normals[i] as number) * thickness;
    positions[source.length + i + 1] =
      (source[i + 1] as number) - (normals[i + 1] as number) * thickness;
    positions[source.length + i + 2] =
      (source[i + 2] as number) - (normals[i + 2] as number) * thickness;
  }

  const combined: number[] = Array.from(indices);
  // Inner surface with reversed winding so it faces inward.
  for (let i = 0; i + 2 < indices.length; i += 3) {
    combined.push(
      (indices[i] as number) + count,
      (indices[i + 2] as number) + count,
      (indices[i + 1] as number) + count,
    );
  }

  const result: MeshData = {
    positions,
    indices: new Uint32Array(combined),
    groups: [
      { name: 'outer', start: 0, count: indices.length },
      { name: 'inner', start: indices.length, count: indices.length },
    ],
  };
  result.normals = computeNormals(result);
  return result;
}

/**
 * Round a mesh's silhouette by smoothing then re-projecting.
 *
 * A pragmatic bevel: real edge bevelling needs half-edge topology and produces new faces, which is a large
 * amount of machinery for a visual effect that a constrained smooth achieves acceptably on the procedural
 * meshes this engine produces. Named `bevel` because that is what a model author is asking for.
 */
export function bevel(mesh: MeshData, amount = 0.5): MeshData {
  const welded = weld(mesh);
  return smooth(welded, 1, clamp(amount, 0, 1) * 0.6);
}

/**
 * Flatten shading by splitting shared vertices.
 *
 * `08`'s cheapest rung ("flat shading on LOW — skips normal interpolation") and also a deliberate style
 * choice: `01` notes that diagram-style models often read *better* non-photoreal, and faceted shading is part
 * of that language.
 */
export function facet(mesh: MeshData): MeshData {
  const source = mesh.positions;
  const indices = mesh.indices;
  if (!indices) return mesh;

  const positions = new Float32Array(indices.length * 3);
  for (let i = 0; i < indices.length; i += 1) {
    const v = indices[i] as number;
    positions[i * 3] = source[v * 3] as number;
    positions[i * 3 + 1] = source[v * 3 + 1] as number;
    positions[i * 3 + 2] = source[v * 3 + 2] as number;
  }

  const result: MeshData = { positions };
  result.normals = computeNormals(result);
  return result;
}

/**
 * Cut a mesh with a plane, discarding everything on the positive side.
 *
 * The cutaway `01` requires when "the lesson is *inside* something". Triangles straddling the plane are
 * clipped exactly rather than dropped, because dropping them leaves a ragged edge that reads as a broken
 * model rather than a section.
 */
export function clip(
  mesh: MeshData,
  normal: readonly [number, number, number],
  offset = 0,
): MeshData {
  const source = mesh.positions;
  const indices = mesh.indices ?? Uint32Array.from({ length: source.length / 3 }, (_u, i) => i);
  const [nx, ny, nz] = normal;

  const positions: number[] = [];
  const kept: number[] = [];

  const distance = (v: number): number =>
    (source[v * 3] as number) * nx +
    (source[v * 3 + 1] as number) * ny +
    (source[v * 3 + 2] as number) * nz -
    offset;

  const push = (x: number, y: number, z: number): number => {
    const index = positions.length / 3;
    positions.push(x, y, z);
    return index;
  };

  const pushVertex = (v: number): number =>
    push(source[v * 3] as number, source[v * 3 + 1] as number, source[v * 3 + 2] as number);

  const pushCrossing = (a: number, b: number): number => {
    const da = distance(a);
    const db = distance(b);
    const t = Math.abs(db - da) > 1e-12 ? da / (da - db) : 0.5;
    return push(
      lerp(source[a * 3] as number, source[b * 3] as number, t),
      lerp(source[a * 3 + 1] as number, source[b * 3 + 1] as number, t),
      lerp(source[a * 3 + 2] as number, source[b * 3 + 2] as number, t),
    );
  };

  for (let i = 0; i + 2 < indices.length; i += 3) {
    const tri = [indices[i] as number, indices[i + 1] as number, indices[i + 2] as number];
    const inside = tri.filter((v) => distance(v) <= 0);

    if (inside.length === 3) {
      kept.push(
        pushVertex(tri[0] as number),
        pushVertex(tri[1] as number),
        pushVertex(tri[2] as number),
      );
      continue;
    }
    if (inside.length === 0) continue;

    if (inside.length === 1) {
      // One corner survives: the triangle becomes a smaller triangle.
      const keepVertex = inside[0] as number;
      const others = tri.filter((v) => v !== keepVertex);
      kept.push(
        pushVertex(keepVertex),
        pushCrossing(keepVertex, others[0] as number),
        pushCrossing(keepVertex, others[1] as number),
      );
      continue;
    }

    // Two corners survive: the triangle becomes a quad, emitted as two triangles.
    const cut = tri.find((v) => distance(v) > 0) as number;
    const a = inside[0] as number;
    const b = inside[1] as number;
    const ca = pushCrossing(a, cut);
    const cb = pushCrossing(b, cut);
    const va = pushVertex(a);
    const vb = pushVertex(b);
    kept.push(va, vb, cb, va, cb, ca);
  }

  const result: MeshData = {
    positions: new Float32Array(positions),
    indices: new Uint32Array(kept),
  };
  result.normals = computeNormals(result);
  return result;
}

/**
 * Ripple a surface radially — a standing or travelling wave applied to existing geometry.
 *
 * Distinct from `waveSurface`, which *creates* a surface: this deforms one that already exists, so a membrane,
 * a drum head or a water surface built by any other means can be made to oscillate.
 */
export function ripple(
  mesh: MeshData,
  amplitude: number,
  wavelength: number,
  phase = 0,
  axis: 'x' | 'y' | 'z' = 'y',
): MeshData {
  const source = mesh.positions;
  const positions = new Float32Array(source.length);
  const k = TAU / Math.max(1e-6, wavelength);

  for (let i = 0; i < source.length; i += 3) {
    const x = source[i] as number;
    const y = source[i + 1] as number;
    const z = source[i + 2] as number;
    const radial =
      axis === 'y'
        ? Math.sqrt(x * x + z * z)
        : axis === 'x'
          ? Math.sqrt(y * y + z * z)
          : Math.sqrt(x * x + y * y);
    const offset = Math.sin(k * radial - phase) * amplitude;

    positions[i] = axis === 'x' ? x + offset : x;
    positions[i + 1] = axis === 'y' ? y + offset : y;
    positions[i + 2] = axis === 'z' ? z + offset : z;
  }

  return carry(mesh, positions);
}

/** Blend two meshes with matching vertex counts — morph targets, growth stages, before/after states. */
export function morph(a: MeshData, b: MeshData, t: number): MeshData {
  if (a.positions.length !== b.positions.length) return a;
  const positions = new Float32Array(a.positions.length);
  const factor = smootherstep(clamp(t, 0, 1));
  for (let i = 0; i < positions.length; i += 1) {
    positions[i] = lerp(a.positions[i] as number, b.positions[i] as number, factor);
  }
  return carry(a, positions);
}
