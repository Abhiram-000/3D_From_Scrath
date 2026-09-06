/**
 * Implicit surfaces: signed distance fields, marching cubes, and parametric surfaces.
 *
 * This file is the answer to the shapes the profile operators cannot reach. A heart, a blended manifold
 * junction, a metaball electron cloud, a gyroid lattice, a cave, a bone — none of these are a swept profile,
 * and none of them would ever appear in a shape catalog. `00-GOAL.md` requires the platform to build them
 * anyway ("if a concept exists, it can be modeled"), so the API exposes the two general-purpose surface
 * definitions mathematics offers:
 *
 *   - **implicit**: `f(x, y, z) = 0`, polygonised by marching cubes. Blends, unions and subtractions are
 *     arithmetic on the field, so booleans come free and *smooth* booleans come nearly free.
 *   - **parametric**: `f(u, v) → point`, evaluated on a grid. Exact for anything with a formula — a wave
 *     surface, a Möbius strip, a Klein bottle, a torus knot, a mathematical function plot.
 *
 * Both take *sandboxed closures*, so the shape is defined by the model's own program. That is the deepest
 * expression of "the ceiling is the API, not the schema": the engine supplies the polygoniser, the AI
 * supplies the mathematics.
 */
import { type MeshData, computeNormals } from './mesh-data.ts';
import { TAU, clamp, smootherstep } from '../math/index.ts';

/** A signed distance function: negative inside, positive outside, zero on the surface. */
export type Sdf = (x: number, y: number, z: number) => number;

/** A parametric surface: maps `(u, v)` in `[0,1]²` to a point in space. */
export type SurfaceFn = (u: number, v: number) => readonly [number, number, number];

// ── SDF primitives and combinators ──────────────────────────────────────────
//
// Provided because hand-writing distance functions is where models get subtly wrong: a "sphere" written as
// `x*x + y*y + z*z - r*r` is a *field* whose zero-set is a sphere but whose gradient is wrong, which makes
// smooth blends and shell offsets behave unpredictably. These return true distances.

export const sdSphere =
  (radius: number): Sdf =>
  (x, y, z) =>
    Math.sqrt(x * x + y * y + z * z) - radius;

export const sdBox =
  (hx: number, hy: number, hz: number): Sdf =>
  (x, y, z) => {
    const qx = Math.abs(x) - hx;
    const qy = Math.abs(y) - hy;
    const qz = Math.abs(z) - hz;
    // The outside term plus the inside term: exact distance both in and out, unlike a naive max().
    const outside = Math.sqrt(Math.max(qx, 0) ** 2 + Math.max(qy, 0) ** 2 + Math.max(qz, 0) ** 2);
    return outside + Math.min(Math.max(qx, Math.max(qy, qz)), 0);
  };

export const sdCylinder =
  (radius: number, halfHeight: number, axis: 'x' | 'y' | 'z' = 'y'): Sdf =>
  (x, y, z) => {
    const [radial, along] =
      axis === 'y'
        ? [Math.sqrt(x * x + z * z), Math.abs(y)]
        : axis === 'x'
          ? [Math.sqrt(y * y + z * z), Math.abs(x)]
          : [Math.sqrt(x * x + y * y), Math.abs(z)];
    const dx = radial - radius;
    const dy = along - halfHeight;
    return Math.min(Math.max(dx, dy), 0) + Math.sqrt(Math.max(dx, 0) ** 2 + Math.max(dy, 0) ** 2);
  };

export const sdTorus =
  (major: number, minor: number): Sdf =>
  (x, y, z) => {
    const q = Math.sqrt(x * x + z * z) - major;
    return Math.sqrt(q * q + y * y) - minor;
  };

export const sdCapsule =
  (radius: number, halfHeight: number): Sdf =>
  (x, y, z) => {
    const cy = clamp(y, -halfHeight, halfHeight);
    return Math.sqrt(x * x + (y - cy) ** 2 + z * z) - radius;
  };

export const sdPlane =
  (nx: number, ny: number, nz: number, offset = 0): Sdf =>
  (x, y, z) =>
    x * nx + y * ny + z * nz - offset;

/** Hard union — the sharp boolean OR. */
export const sdUnion =
  (...fields: Sdf[]): Sdf =>
  (x, y, z) => {
    let best = Number.POSITIVE_INFINITY;
    for (const field of fields) {
      const value = field(x, y, z);
      if (value < best) best = value;
    }
    return best;
  };

/** Hard intersection — boolean AND. */
export const sdIntersect =
  (...fields: Sdf[]): Sdf =>
  (x, y, z) => {
    let best = Number.NEGATIVE_INFINITY;
    for (const field of fields) {
      const value = field(x, y, z);
      if (value > best) best = value;
    }
    return best;
  };

/** Subtraction — `a` minus `b`. The bore in a block, the chamber in a casing. */
export const sdSubtract =
  (a: Sdf, b: Sdf): Sdf =>
  (x, y, z) =>
    Math.max(a(x, y, z), -b(x, y, z));

/**
 * Smooth union with a blend radius.
 *
 * The single most valuable function in this file for model quality. Real objects have fillets where parts
 * meet — a manifold junction, a bone's condyle, a muscle's insertion, a moulded plastic housing — and a hard
 * union produces a crease that reads as "two shapes stuck together". `01`'s attractiveness dimension is
 * largely this: crafted transitions rather than accidental ones.
 */
export const sdSmoothUnion =
  (a: Sdf, b: Sdf, radius: number): Sdf =>
  (x, y, z) => {
    const da = a(x, y, z);
    const db = b(x, y, z);
    const h = clamp(0.5 + (0.5 * (db - da)) / radius, 0, 1);
    // Polynomial smooth-min: linear interpolation minus the correction term that creates the fillet.
    return db * (1 - h) + da * h - radius * h * (1 - h);
  };

/** Smooth subtraction, for a filleted pocket rather than a knife-edged one. */
export const sdSmoothSubtract =
  (a: Sdf, b: Sdf, radius: number): Sdf =>
  (x, y, z) => {
    const da = a(x, y, z);
    const db = -b(x, y, z);
    const h = clamp(0.5 - (0.5 * (da + db)) / radius, 0, 1);
    return db * (1 - h) + da * h + radius * h * (1 - h);
  };

/** Offset a field: positive grows the surface, negative shrinks it. A shell is the difference of two offsets. */
export const sdOffset =
  (field: Sdf, distance: number): Sdf =>
  (x, y, z) =>
    field(x, y, z) - distance;

/** Hollow a solid into a shell of the given wall thickness. */
export const sdShell =
  (field: Sdf, thickness: number): Sdf =>
  (x, y, z) =>
    Math.abs(field(x, y, z)) - thickness / 2;

/** Translate a field by moving the sample point the other way. */
export const sdTranslate =
  (field: Sdf, dx: number, dy: number, dz: number): Sdf =>
  (x, y, z) =>
    field(x - dx, y - dy, z - dz);

/** Repeat a field infinitely on a lattice — foams, trusses, crystal cells, honeycomb. */
export const sdRepeat =
  (field: Sdf, px: number, py: number, pz: number): Sdf =>
  (x, y, z) => {
    const wrap = (value: number, period: number): number =>
      period > 0 ? value - period * Math.round(value / period) : value;
    return field(wrap(x, px), wrap(y, py), wrap(z, pz));
  };

/**
 * A metaball field from weighted centres.
 *
 * Electron density, molecular surfaces, cell clusters, fluid droplets merging. Metaballs are the canonical
 * "shape that has no primitive", and their whole teaching value is that they *merge* — which the smooth
 * field produces automatically.
 */
export const sdMetaballs =
  (centres: ReadonlyArray<readonly [number, number, number, number]>, blend = 0.5): Sdf =>
  (x, y, z) => {
    // Exponential smooth-min over all centres: the standard soft-minimum that produces true merging rather
    // than intersecting spheres.
    let accumulator = 0;
    for (const [cx, cy, cz, radius] of centres) {
      const distance = Math.sqrt((x - cx) ** 2 + (y - cy) ** 2 + (z - cz) ** 2) - radius;
      accumulator += Math.exp(-distance / blend);
    }
    return accumulator > 0 ? -blend * Math.log(accumulator) : Number.POSITIVE_INFINITY;
  };

/**
 * A gyroid — the minimal surface used for lattices, scaffolds and heat exchangers.
 *
 * Included as a named field because it is a real engineering surface with a non-obvious formula, and because
 * it demonstrates the point of the implicit path: no catalog would have it, and any model that needs a
 * lattice needs exactly this.
 */
export const sdGyroid =
  (scale = 1, thickness = 0.1): Sdf =>
  (x, y, z) => {
    const sx = x * scale;
    const sy = y * scale;
    const sz = z * scale;
    const value =
      Math.sin(sx) * Math.cos(sy) + Math.sin(sy) * Math.cos(sz) + Math.sin(sz) * Math.cos(sx);
    return Math.abs(value) / scale - thickness;
  };

// ── Marching cubes ──────────────────────────────────────────────────────────

/**
 * Edge table: for each of the 256 corner-sign combinations, which of the 12 cube edges the surface crosses.
 *
 * These two tables are the marching-cubes algorithm. They are data, not logic, and they are reproduced here
 * rather than pulled from a dependency so the geometry layer keeps its "runs in Node with no dependencies
 * beyond three's math" property, which is what makes the headless audit possible.
 */
const EDGE_TABLE = new Int32Array([
  0x0, 0x109, 0x203, 0x30a, 0x406, 0x50f, 0x605, 0x70c, 0x80c, 0x905, 0xa0f, 0xb06, 0xc0a, 0xd03,
  0xe09, 0xf00, 0x190, 0x99, 0x393, 0x29a, 0x596, 0x49f, 0x795, 0x69c, 0x99c, 0x895, 0xb9f, 0xa96,
  0xd9a, 0xc93, 0xf99, 0xe90, 0x230, 0x339, 0x33, 0x13a, 0x636, 0x73f, 0x435, 0x53c, 0xa3c, 0xb35,
  0x83f, 0x936, 0xe3a, 0xf33, 0xc39, 0xd30, 0x3a0, 0x2a9, 0x1a3, 0xaa, 0x7a6, 0x6af, 0x5a5, 0x4ac,
  0xbac, 0xaa5, 0x9af, 0x8a6, 0xfaa, 0xea3, 0xda9, 0xca0, 0x460, 0x569, 0x663, 0x76a, 0x66, 0x16f,
  0x265, 0x36c, 0xc6c, 0xd65, 0xe6f, 0xf66, 0x86a, 0x963, 0xa69, 0xb60, 0x5f0, 0x4f9, 0x7f3, 0x6fa,
  0x1f6, 0xff, 0x3f5, 0x2fc, 0xdfc, 0xcf5, 0xfff, 0xef6, 0x9fa, 0x8f3, 0xbf9, 0xaf0, 0x650, 0x759,
  0x453, 0x55a, 0x256, 0x35f, 0x55, 0x15c, 0xe5c, 0xf55, 0xc5f, 0xd56, 0xa5a, 0xb53, 0x859, 0x950,
  0x7c0, 0x6c9, 0x5c3, 0x4ca, 0x3c6, 0x2cf, 0x1c5, 0xcc, 0xfcc, 0xec5, 0xdcf, 0xcc6, 0xbca, 0xac3,
  0x9c9, 0x8c0, 0x8c0, 0x9c9, 0xac3, 0xbca, 0xcc6, 0xdcf, 0xec5, 0xfcc, 0xcc, 0x1c5, 0x2cf, 0x3c6,
  0x4ca, 0x5c3, 0x6c9, 0x7c0, 0x950, 0x859, 0xb53, 0xa5a, 0xd56, 0xc5f, 0xf55, 0xe5c, 0x15c, 0x55,
  0x35f, 0x256, 0x55a, 0x453, 0x759, 0x650, 0xaf0, 0xbf9, 0x8f3, 0x9fa, 0xef6, 0xfff, 0xcf5, 0xdfc,
  0x2fc, 0x3f5, 0xff, 0x1f6, 0x6fa, 0x7f3, 0x4f9, 0x5f0, 0xb60, 0xa69, 0x963, 0x86a, 0xf66, 0xe6f,
  0xd65, 0xc6c, 0x36c, 0x265, 0x16f, 0x66, 0x76a, 0x663, 0x569, 0x460, 0xca0, 0xda9, 0xea3, 0xfaa,
  0x8a6, 0x9af, 0xaa5, 0xbac, 0x4ac, 0x5a5, 0x6af, 0x7a6, 0xaa, 0x1a3, 0x2a9, 0x3a0, 0xd30, 0xc39,
  0xf33, 0xe3a, 0x936, 0x83f, 0xb35, 0xa3c, 0x53c, 0x435, 0x73f, 0x636, 0x13a, 0x33, 0x339, 0x230,
  0xe90, 0xf99, 0xc93, 0xd9a, 0xa96, 0xb9f, 0x895, 0x99c, 0x69c, 0x795, 0x49f, 0x596, 0x29a, 0x393,
  0x99, 0x190, 0xf00, 0xe09, 0xd03, 0xc0a, 0xb06, 0xa0f, 0x905, 0x80c, 0x70c, 0x605, 0x50f, 0x406,
  0x30a, 0x203, 0x109, 0x0,
]);

/** Triangle table: up to five triangles per cube, terminated by -1. Flattened to 256 × 16. */
const TRI_TABLE = new Int8Array([
  -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 0, 8, 3, -1, -1, -1, -1, -1, -1,
  -1, -1, -1, -1, -1, -1, -1, 0, 1, 9, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 1, 8, 3,
  9, 8, 1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 1, 2, 10, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
  -1, -1, -1, 0, 8, 3, 1, 2, 10, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 9, 2, 10, 0, 2, 9, -1, -1,
  -1, -1, -1, -1, -1, -1, -1, -1, 2, 8, 3, 2, 10, 8, 10, 9, 8, -1, -1, -1, -1, -1, -1, -1, 3, 11, 2,
  -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 0, 11, 2, 8, 11, 0, -1, -1, -1, -1, -1, -1,
  -1, -1, -1, -1, 1, 9, 0, 2, 3, 11, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 1, 11, 2, 1, 9, 11, 9,
  8, 11, -1, -1, -1, -1, -1, -1, -1, 3, 10, 1, 11, 10, 3, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 0,
  10, 1, 0, 8, 10, 8, 11, 10, -1, -1, -1, -1, -1, -1, -1, 3, 9, 0, 3, 11, 9, 11, 10, 9, -1, -1, -1,
  -1, -1, -1, -1, 9, 8, 10, 10, 8, 11, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 4, 7, 8, -1, -1, -1,
  -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 4, 3, 0, 7, 3, 4, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
  0, 1, 9, 8, 4, 7, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 4, 1, 9, 4, 7, 1, 7, 3, 1, -1, -1, -1,
  -1, -1, -1, -1, 1, 2, 10, 8, 4, 7, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 3, 4, 7, 3, 0, 4, 1, 2,
  10, -1, -1, -1, -1, -1, -1, -1, 9, 2, 10, 9, 0, 2, 8, 4, 7, -1, -1, -1, -1, -1, -1, -1, 2, 10, 9,
  2, 9, 7, 2, 7, 3, 7, 9, 4, -1, -1, -1, -1, 8, 4, 7, 3, 11, 2, -1, -1, -1, -1, -1, -1, -1, -1, -1,
  -1, 11, 4, 7, 11, 2, 4, 2, 0, 4, -1, -1, -1, -1, -1, -1, -1, 9, 0, 1, 8, 4, 7, 2, 3, 11, -1, -1,
  -1, -1, -1, -1, -1, 4, 7, 11, 9, 4, 11, 9, 11, 2, 9, 2, 1, -1, -1, -1, -1, 3, 10, 1, 3, 11, 10, 7,
  8, 4, -1, -1, -1, -1, -1, -1, -1, 1, 11, 10, 1, 4, 11, 1, 0, 4, 7, 11, 4, -1, -1, -1, -1, 4, 7, 8,
  9, 0, 11, 9, 11, 10, 11, 0, 3, -1, -1, -1, -1, 4, 7, 11, 4, 11, 9, 9, 11, 10, -1, -1, -1, -1, -1,
  -1, -1, 9, 5, 4, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 9, 5, 4, 0, 8, 3, -1, -1, -1,
  -1, -1, -1, -1, -1, -1, -1, 0, 5, 4, 1, 5, 0, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 8, 5, 4, 8,
  3, 5, 3, 1, 5, -1, -1, -1, -1, -1, -1, -1, 1, 2, 10, 9, 5, 4, -1, -1, -1, -1, -1, -1, -1, -1, -1,
  -1, 3, 0, 8, 1, 2, 10, 4, 9, 5, -1, -1, -1, -1, -1, -1, -1, 5, 2, 10, 5, 4, 2, 4, 0, 2, -1, -1,
  -1, -1, -1, -1, -1, 2, 10, 5, 3, 2, 5, 3, 5, 4, 3, 4, 8, -1, -1, -1, -1, 9, 5, 4, 2, 3, 11, -1,
  -1, -1, -1, -1, -1, -1, -1, -1, -1, 0, 11, 2, 0, 8, 11, 4, 9, 5, -1, -1, -1, -1, -1, -1, -1, 0, 5,
  4, 0, 1, 5, 2, 3, 11, -1, -1, -1, -1, -1, -1, -1, 2, 1, 5, 2, 5, 8, 2, 8, 11, 4, 8, 5, -1, -1, -1,
  -1, 10, 3, 11, 10, 1, 3, 9, 5, 4, -1, -1, -1, -1, -1, -1, -1, 4, 9, 5, 0, 8, 1, 8, 10, 1, 8, 11,
  10, -1, -1, -1, -1, 5, 4, 0, 5, 0, 11, 5, 11, 10, 11, 0, 3, -1, -1, -1, -1, 5, 4, 8, 5, 8, 10, 10,
  8, 11, -1, -1, -1, -1, -1, -1, -1, 9, 7, 8, 5, 7, 9, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 9, 3,
  0, 9, 5, 3, 5, 7, 3, -1, -1, -1, -1, -1, -1, -1, 0, 7, 8, 0, 1, 7, 1, 5, 7, -1, -1, -1, -1, -1,
  -1, -1, 1, 5, 3, 3, 5, 7, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 9, 7, 8, 9, 5, 7, 10, 1, 2, -1,
  -1, -1, -1, -1, -1, -1, 10, 1, 2, 9, 5, 0, 5, 3, 0, 5, 7, 3, -1, -1, -1, -1, 8, 0, 2, 8, 2, 5, 8,
  5, 7, 10, 5, 2, -1, -1, -1, -1, 2, 10, 5, 2, 5, 3, 3, 5, 7, -1, -1, -1, -1, -1, -1, -1, 7, 9, 5,
  7, 8, 9, 3, 11, 2, -1, -1, -1, -1, -1, -1, -1, 9, 5, 7, 9, 7, 2, 9, 2, 0, 2, 7, 11, -1, -1, -1,
  -1, 2, 3, 11, 0, 1, 8, 1, 7, 8, 1, 5, 7, -1, -1, -1, -1, 11, 2, 1, 11, 1, 7, 7, 1, 5, -1, -1, -1,
  -1, -1, -1, -1, 9, 5, 8, 8, 5, 7, 10, 1, 3, 10, 3, 11, -1, -1, -1, -1, 5, 7, 0, 5, 0, 9, 7, 11, 0,
  1, 0, 10, 11, 10, 0, -1, 11, 10, 0, 11, 0, 3, 10, 5, 0, 8, 0, 7, 5, 7, 0, -1, 11, 10, 5, 7, 11, 5,
  -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 10, 6, 5, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
  -1, 0, 8, 3, 5, 10, 6, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 9, 0, 1, 5, 10, 6, -1, -1, -1, -1,
  -1, -1, -1, -1, -1, -1, 1, 8, 3, 1, 9, 8, 5, 10, 6, -1, -1, -1, -1, -1, -1, -1, 1, 6, 5, 2, 6, 1,
  -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 1, 6, 5, 1, 2, 6, 3, 0, 8, -1, -1, -1, -1, -1, -1, -1, 9,
  6, 5, 9, 0, 6, 0, 2, 6, -1, -1, -1, -1, -1, -1, -1, 5, 9, 8, 5, 8, 2, 5, 2, 6, 3, 2, 8, -1, -1,
  -1, -1, 2, 3, 11, 10, 6, 5, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 11, 0, 8, 11, 2, 0, 10, 6, 5,
  -1, -1, -1, -1, -1, -1, -1, 0, 1, 9, 2, 3, 11, 5, 10, 6, -1, -1, -1, -1, -1, -1, -1, 5, 10, 6, 1,
  9, 2, 9, 11, 2, 9, 8, 11, -1, -1, -1, -1, 6, 3, 11, 6, 5, 3, 5, 1, 3, -1, -1, -1, -1, -1, -1, -1,
  0, 8, 11, 0, 11, 5, 0, 5, 1, 5, 11, 6, -1, -1, -1, -1, 3, 11, 6, 0, 3, 6, 0, 6, 5, 0, 5, 9, -1,
  -1, -1, -1, 6, 5, 9, 6, 9, 11, 11, 9, 8, -1, -1, -1, -1, -1, -1, -1, 5, 10, 6, 4, 7, 8, -1, -1,
  -1, -1, -1, -1, -1, -1, -1, -1, 4, 3, 0, 4, 7, 3, 6, 5, 10, -1, -1, -1, -1, -1, -1, -1, 1, 9, 0,
  5, 10, 6, 8, 4, 7, -1, -1, -1, -1, -1, -1, -1, 10, 6, 5, 1, 9, 7, 1, 7, 3, 7, 9, 4, -1, -1, -1,
  -1, 6, 1, 2, 6, 5, 1, 4, 7, 8, -1, -1, -1, -1, -1, -1, -1, 1, 2, 5, 5, 2, 6, 3, 0, 4, 3, 4, 7, -1,
  -1, -1, -1, 8, 4, 7, 9, 0, 5, 0, 6, 5, 0, 2, 6, -1, -1, -1, -1, 7, 3, 9, 7, 9, 4, 3, 2, 9, 5, 9,
  6, 2, 6, 9, -1, 3, 11, 2, 7, 8, 4, 10, 6, 5, -1, -1, -1, -1, -1, -1, -1, 5, 10, 6, 4, 7, 2, 4, 2,
  0, 2, 7, 11, -1, -1, -1, -1, 0, 1, 9, 4, 7, 8, 2, 3, 11, 5, 10, 6, -1, -1, -1, -1, 9, 2, 1, 9, 11,
  2, 9, 4, 11, 7, 11, 4, 5, 10, 6, -1, 8, 4, 7, 3, 11, 5, 3, 5, 1, 5, 11, 6, -1, -1, -1, -1, 5, 1,
  11, 5, 11, 6, 1, 0, 11, 7, 11, 4, 0, 4, 11, -1, 0, 5, 9, 0, 6, 5, 0, 3, 6, 11, 6, 3, 8, 4, 7, -1,
  6, 5, 9, 6, 9, 11, 4, 7, 9, 7, 11, 9, -1, -1, -1, -1, 10, 4, 9, 6, 4, 10, -1, -1, -1, -1, -1, -1,
  -1, -1, -1, -1, 4, 10, 6, 4, 9, 10, 0, 8, 3, -1, -1, -1, -1, -1, -1, -1, 10, 0, 1, 10, 6, 0, 6, 4,
  0, -1, -1, -1, -1, -1, -1, -1, 8, 3, 1, 8, 1, 6, 8, 6, 4, 6, 1, 10, -1, -1, -1, -1, 1, 4, 9, 1, 2,
  4, 2, 6, 4, -1, -1, -1, -1, -1, -1, -1, 3, 0, 8, 1, 2, 9, 2, 4, 9, 2, 6, 4, -1, -1, -1, -1, 0, 2,
  4, 4, 2, 6, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 8, 3, 2, 8, 2, 4, 4, 2, 6, -1, -1, -1, -1, -1,
  -1, -1, 10, 4, 9, 10, 6, 4, 11, 2, 3, -1, -1, -1, -1, -1, -1, -1, 0, 8, 2, 2, 8, 11, 4, 9, 10, 4,
  10, 6, -1, -1, -1, -1, 3, 11, 2, 0, 1, 6, 0, 6, 4, 6, 1, 10, -1, -1, -1, -1, 6, 4, 1, 6, 1, 10, 4,
  8, 1, 2, 1, 11, 8, 11, 1, -1, 9, 6, 4, 9, 3, 6, 9, 1, 3, 11, 6, 3, -1, -1, -1, -1, 8, 11, 1, 8, 1,
  0, 11, 6, 1, 9, 1, 4, 6, 4, 1, -1, 3, 11, 6, 3, 6, 0, 0, 6, 4, -1, -1, -1, -1, -1, -1, -1, 6, 4,
  8, 11, 6, 8, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 7, 10, 6, 7, 8, 10, 8, 9, 10, -1, -1, -1, -1,
  -1, -1, -1, 0, 7, 3, 0, 10, 7, 0, 9, 10, 6, 7, 10, -1, -1, -1, -1, 10, 6, 7, 1, 10, 7, 1, 7, 8, 1,
  8, 0, -1, -1, -1, -1, 10, 6, 7, 10, 7, 1, 1, 7, 3, -1, -1, -1, -1, -1, -1, -1, 1, 2, 6, 1, 6, 8,
  1, 8, 9, 8, 6, 7, -1, -1, -1, -1, 2, 6, 9, 2, 9, 1, 6, 7, 9, 0, 9, 3, 7, 3, 9, -1, 7, 8, 0, 7, 0,
  6, 6, 0, 2, -1, -1, -1, -1, -1, -1, -1, 7, 3, 2, 6, 7, 2, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
  2, 3, 11, 10, 6, 8, 10, 8, 9, 8, 6, 7, -1, -1, -1, -1, 2, 0, 7, 2, 7, 11, 0, 9, 7, 6, 7, 10, 9,
  10, 7, -1, 1, 8, 0, 1, 7, 8, 1, 10, 7, 6, 7, 10, 2, 3, 11, -1, 11, 2, 1, 11, 1, 7, 10, 6, 1, 6, 7,
  1, -1, -1, -1, -1, 8, 9, 6, 8, 6, 7, 9, 1, 6, 11, 6, 3, 1, 3, 6, -1, 0, 9, 1, 11, 6, 7, -1, -1,
  -1, -1, -1, -1, -1, -1, -1, -1, 7, 8, 0, 7, 0, 6, 3, 11, 0, 11, 6, 0, -1, -1, -1, -1, 7, 11, 6,
  -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 7, 6, 11, -1, -1, -1, -1, -1, -1, -1, -1, -1,
  -1, -1, -1, -1, 3, 0, 8, 11, 7, 6, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 0, 1, 9, 11, 7, 6, -1,
  -1, -1, -1, -1, -1, -1, -1, -1, -1, 8, 1, 9, 8, 3, 1, 11, 7, 6, -1, -1, -1, -1, -1, -1, -1, 10, 1,
  2, 6, 11, 7, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 1, 2, 10, 3, 0, 8, 6, 11, 7, -1, -1, -1, -1,
  -1, -1, -1, 2, 9, 0, 2, 10, 9, 6, 11, 7, -1, -1, -1, -1, -1, -1, -1, 6, 11, 7, 2, 10, 3, 10, 8, 3,
  10, 9, 8, -1, -1, -1, -1, 7, 2, 3, 6, 2, 7, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 7, 0, 8, 7, 6,
  0, 6, 2, 0, -1, -1, -1, -1, -1, -1, -1, 2, 7, 6, 2, 3, 7, 0, 1, 9, -1, -1, -1, -1, -1, -1, -1, 1,
  6, 2, 1, 8, 6, 1, 9, 8, 8, 7, 6, -1, -1, -1, -1, 10, 7, 6, 10, 1, 7, 1, 3, 7, -1, -1, -1, -1, -1,
  -1, -1, 10, 7, 6, 1, 7, 10, 1, 8, 7, 1, 0, 8, -1, -1, -1, -1, 0, 3, 7, 0, 7, 10, 0, 10, 9, 6, 10,
  7, -1, -1, -1, -1, 7, 6, 10, 7, 10, 8, 8, 10, 9, -1, -1, -1, -1, -1, -1, -1, 6, 8, 4, 11, 8, 6,
  -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 3, 6, 11, 3, 0, 6, 0, 4, 6, -1, -1, -1, -1, -1, -1, -1, 8,
  6, 11, 8, 4, 6, 9, 0, 1, -1, -1, -1, -1, -1, -1, -1, 9, 4, 6, 9, 6, 3, 9, 3, 1, 11, 3, 6, -1, -1,
  -1, -1, 6, 8, 4, 6, 11, 8, 2, 10, 1, -1, -1, -1, -1, -1, -1, -1, 1, 2, 10, 3, 0, 11, 0, 6, 11, 0,
  4, 6, -1, -1, -1, -1, 4, 11, 8, 4, 6, 11, 0, 2, 9, 2, 10, 9, -1, -1, -1, -1, 10, 9, 3, 10, 3, 2,
  9, 4, 3, 11, 3, 6, 4, 6, 3, -1, 8, 2, 3, 8, 4, 2, 4, 6, 2, -1, -1, -1, -1, -1, -1, -1, 0, 4, 2, 4,
  6, 2, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 1, 9, 0, 2, 3, 4, 2, 4, 6, 4, 3, 8, -1, -1, -1, -1,
  1, 9, 4, 1, 4, 2, 2, 4, 6, -1, -1, -1, -1, -1, -1, -1, 8, 1, 3, 8, 6, 1, 8, 4, 6, 6, 10, 1, -1,
  -1, -1, -1, 10, 1, 0, 10, 0, 6, 6, 0, 4, -1, -1, -1, -1, -1, -1, -1, 4, 6, 3, 4, 3, 8, 6, 10, 3,
  0, 3, 9, 10, 9, 3, -1, 10, 9, 4, 6, 10, 4, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 4, 9, 5, 7, 6,
  11, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 0, 8, 3, 4, 9, 5, 11, 7, 6, -1, -1, -1, -1, -1, -1,
  -1, 5, 0, 1, 5, 4, 0, 7, 6, 11, -1, -1, -1, -1, -1, -1, -1, 11, 7, 6, 8, 3, 4, 3, 5, 4, 3, 1, 5,
  -1, -1, -1, -1, 9, 5, 4, 10, 1, 2, 7, 6, 11, -1, -1, -1, -1, -1, -1, -1, 6, 11, 7, 1, 2, 10, 0, 8,
  3, 4, 9, 5, -1, -1, -1, -1, 7, 6, 11, 5, 4, 10, 4, 2, 10, 4, 0, 2, -1, -1, -1, -1, 3, 4, 8, 3, 5,
  4, 3, 2, 5, 10, 5, 2, 11, 7, 6, -1, 7, 2, 3, 7, 6, 2, 5, 4, 9, -1, -1, -1, -1, -1, -1, -1, 9, 5,
  4, 0, 8, 6, 0, 6, 2, 6, 8, 7, -1, -1, -1, -1, 3, 6, 2, 3, 7, 6, 1, 5, 0, 5, 4, 0, -1, -1, -1, -1,
  6, 2, 8, 6, 8, 7, 2, 1, 8, 4, 8, 5, 1, 5, 8, -1, 9, 5, 4, 10, 1, 6, 1, 7, 6, 1, 3, 7, -1, -1, -1,
  -1, 1, 6, 10, 1, 7, 6, 1, 0, 7, 8, 7, 0, 9, 5, 4, -1, 4, 0, 10, 4, 10, 5, 0, 3, 10, 6, 10, 7, 3,
  7, 10, -1, 7, 6, 10, 7, 10, 8, 5, 4, 10, 4, 8, 10, -1, -1, -1, -1, 6, 9, 5, 6, 11, 9, 11, 8, 9,
  -1, -1, -1, -1, -1, -1, -1, 3, 6, 11, 0, 6, 3, 0, 5, 6, 0, 9, 5, -1, -1, -1, -1, 0, 11, 8, 0, 5,
  11, 0, 1, 5, 5, 6, 11, -1, -1, -1, -1, 6, 11, 3, 6, 3, 5, 5, 3, 1, -1, -1, -1, -1, -1, -1, -1, 1,
  2, 10, 9, 5, 11, 9, 11, 8, 11, 5, 6, -1, -1, -1, -1, 0, 11, 3, 0, 6, 11, 0, 9, 6, 5, 6, 9, 1, 2,
  10, -1, 11, 8, 5, 11, 5, 6, 8, 0, 5, 10, 5, 2, 0, 2, 5, -1, 6, 11, 3, 6, 3, 5, 2, 10, 3, 10, 5, 3,
  -1, -1, -1, -1, 5, 8, 9, 5, 2, 8, 5, 6, 2, 3, 8, 2, -1, -1, -1, -1, 9, 5, 6, 9, 6, 0, 0, 6, 2, -1,
  -1, -1, -1, -1, -1, -1, 1, 5, 8, 1, 8, 0, 5, 6, 8, 3, 8, 2, 6, 2, 8, -1, 1, 5, 6, 2, 1, 6, -1, -1,
  -1, -1, -1, -1, -1, -1, -1, -1, 1, 3, 6, 1, 6, 10, 3, 8, 6, 5, 6, 9, 8, 9, 6, -1, 10, 1, 0, 10, 0,
  6, 9, 5, 0, 5, 6, 0, -1, -1, -1, -1, 0, 3, 8, 5, 6, 10, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
  10, 5, 6, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 11, 5, 10, 7, 5, 11, -1, -1, -1, -1,
  -1, -1, -1, -1, -1, -1, 11, 5, 10, 11, 7, 5, 8, 3, 0, -1, -1, -1, -1, -1, -1, -1, 5, 11, 7, 5, 10,
  11, 1, 9, 0, -1, -1, -1, -1, -1, -1, -1, 10, 7, 5, 10, 11, 7, 9, 8, 1, 8, 3, 1, -1, -1, -1, -1,
  11, 1, 2, 11, 7, 1, 7, 5, 1, -1, -1, -1, -1, -1, -1, -1, 0, 8, 3, 1, 2, 7, 1, 7, 5, 7, 2, 11, -1,
  -1, -1, -1, 9, 7, 5, 9, 2, 7, 9, 0, 2, 2, 11, 7, -1, -1, -1, -1, 7, 5, 2, 7, 2, 11, 5, 9, 2, 3, 2,
  8, 9, 8, 2, -1, 2, 5, 10, 2, 3, 5, 3, 7, 5, -1, -1, -1, -1, -1, -1, -1, 8, 2, 0, 8, 5, 2, 8, 7, 5,
  10, 2, 5, -1, -1, -1, -1, 9, 0, 1, 5, 10, 3, 5, 3, 7, 3, 10, 2, -1, -1, -1, -1, 9, 8, 2, 9, 2, 1,
  8, 7, 2, 10, 2, 5, 7, 5, 2, -1, 1, 3, 5, 3, 7, 5, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 0, 8, 7,
  0, 7, 1, 1, 7, 5, -1, -1, -1, -1, -1, -1, -1, 9, 0, 3, 9, 3, 5, 5, 3, 7, -1, -1, -1, -1, -1, -1,
  -1, 9, 8, 7, 5, 9, 7, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 5, 8, 4, 5, 10, 8, 10, 11, 8, -1,
  -1, -1, -1, -1, -1, -1, 5, 0, 4, 5, 11, 0, 5, 10, 11, 11, 3, 0, -1, -1, -1, -1, 0, 1, 9, 8, 4, 10,
  8, 10, 11, 10, 4, 5, -1, -1, -1, -1, 10, 11, 4, 10, 4, 5, 11, 3, 4, 9, 4, 1, 3, 1, 4, -1, 2, 5, 1,
  2, 8, 5, 2, 11, 8, 4, 5, 8, -1, -1, -1, -1, 0, 4, 11, 0, 11, 3, 4, 5, 11, 2, 11, 1, 5, 1, 11, -1,
  0, 2, 5, 0, 5, 9, 2, 11, 5, 4, 5, 8, 11, 8, 5, -1, 9, 4, 5, 2, 11, 3, -1, -1, -1, -1, -1, -1, -1,
  -1, -1, -1, 2, 5, 10, 3, 5, 2, 3, 4, 5, 3, 8, 4, -1, -1, -1, -1, 5, 10, 2, 5, 2, 4, 4, 2, 0, -1,
  -1, -1, -1, -1, -1, -1, 3, 10, 2, 3, 5, 10, 3, 8, 5, 4, 5, 8, 0, 1, 9, -1, 5, 10, 2, 5, 2, 4, 1,
  9, 2, 9, 4, 2, -1, -1, -1, -1, 8, 4, 5, 8, 5, 3, 3, 5, 1, -1, -1, -1, -1, -1, -1, -1, 0, 4, 5, 1,
  0, 5, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 8, 4, 5, 8, 5, 3, 9, 0, 5, 0, 3, 5, -1, -1, -1, -1,
  9, 4, 5, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 4, 11, 7, 4, 9, 11, 9, 10, 11, -1,
  -1, -1, -1, -1, -1, -1, 0, 8, 3, 4, 9, 7, 9, 11, 7, 9, 10, 11, -1, -1, -1, -1, 1, 10, 11, 1, 11,
  4, 1, 4, 0, 7, 4, 11, -1, -1, -1, -1, 3, 1, 4, 3, 4, 8, 1, 10, 4, 7, 4, 11, 10, 11, 4, -1, 4, 11,
  7, 9, 11, 4, 9, 2, 11, 9, 1, 2, -1, -1, -1, -1, 9, 7, 4, 9, 11, 7, 9, 1, 11, 2, 11, 1, 0, 8, 3,
  -1, 11, 7, 4, 11, 4, 2, 2, 4, 0, -1, -1, -1, -1, -1, -1, -1, 11, 7, 4, 11, 4, 2, 8, 3, 4, 3, 2, 4,
  -1, -1, -1, -1, 2, 9, 10, 2, 7, 9, 2, 3, 7, 7, 4, 9, -1, -1, -1, -1, 9, 10, 7, 9, 7, 4, 10, 2, 7,
  8, 7, 0, 2, 0, 7, -1, 3, 7, 10, 3, 10, 2, 7, 4, 10, 1, 10, 0, 4, 0, 10, -1, 1, 10, 2, 8, 7, 4, -1,
  -1, -1, -1, -1, -1, -1, -1, -1, -1, 4, 9, 1, 4, 1, 7, 7, 1, 3, -1, -1, -1, -1, -1, -1, -1, 4, 9,
  1, 4, 1, 7, 0, 8, 1, 8, 7, 1, -1, -1, -1, -1, 4, 0, 3, 7, 4, 3, -1, -1, -1, -1, -1, -1, -1, -1,
  -1, -1, 4, 8, 7, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 9, 10, 8, 10, 11, 8, -1, -1,
  -1, -1, -1, -1, -1, -1, -1, -1, 3, 0, 9, 3, 9, 11, 11, 9, 10, -1, -1, -1, -1, -1, -1, -1, 0, 1,
  10, 0, 10, 8, 8, 10, 11, -1, -1, -1, -1, -1, -1, -1, 3, 1, 10, 11, 3, 10, -1, -1, -1, -1, -1, -1,
  -1, -1, -1, -1, 1, 2, 11, 1, 11, 9, 9, 11, 8, -1, -1, -1, -1, -1, -1, -1, 3, 0, 9, 3, 9, 11, 1, 2,
  9, 2, 11, 9, -1, -1, -1, -1, 0, 2, 11, 8, 0, 11, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 3, 2, 11,
  -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 2, 3, 8, 2, 8, 10, 10, 8, 9, -1, -1, -1, -1,
  -1, -1, -1, 9, 10, 2, 0, 9, 2, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 2, 3, 8, 2, 8, 10, 0, 1, 8,
  1, 10, 8, -1, -1, -1, -1, 1, 10, 2, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 1, 3, 8,
  9, 1, 8, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 0, 9, 1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
  -1, -1, -1, 0, 3, 8, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
  -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
]);

/** Which two corners each of the 12 cube edges connects. */
const EDGE_CORNERS: ReadonlyArray<readonly [number, number]> = [
  [0, 1],
  [1, 2],
  [2, 3],
  [3, 0],
  [4, 5],
  [5, 6],
  [6, 7],
  [7, 4],
  [0, 4],
  [1, 5],
  [2, 6],
  [3, 7],
];

/** Corner offsets in cube-local units. */
const CORNER_OFFSETS: ReadonlyArray<readonly [number, number, number]> = [
  [0, 0, 0],
  [1, 0, 0],
  [1, 1, 0],
  [0, 1, 0],
  [0, 0, 1],
  [1, 0, 1],
  [1, 1, 1],
  [0, 1, 1],
];

export interface SdfOptions {
  field: Sdf;
  /** Sampling volume, metres. Must contain the whole surface or it will be clipped at the boundary. */
  bounds: { min: readonly [number, number, number]; max: readonly [number, number, number] };
  /** Grid divisions per axis. Cost is O(n³), so this is the knob the budget system turns. */
  resolution?: number | readonly [number, number, number];
  /** Iso-level to extract. Zero is the surface of a true distance field. */
  isoLevel?: number;
}

/**
 * Polygonise a signed distance field with marching cubes.
 *
 * Resolution is deliberately explicit rather than adaptive: a model author choosing 48³ over 96³ is making a
 * cost decision worth 8× the triangles, and `08` requires that cost to be visible and priced before
 * allocation. An adaptive octree would hide it.
 */
export function sdf(options: SdfOptions): MeshData {
  const { field, bounds } = options;
  const isoLevel = options.isoLevel ?? 0;

  // `Array.isArray` does not narrow a `readonly` tuple, so the discriminant is the primitive check.
  const resolution = options.resolution ?? 40;
  const [nx, ny, nz] =
    typeof resolution === 'number' ? ([resolution, resolution, resolution] as const) : resolution;

  const gx = Math.max(2, Math.min(160, Math.floor(nx)));
  const gy = Math.max(2, Math.min(160, Math.floor(ny)));
  const gz = Math.max(2, Math.min(160, Math.floor(nz)));

  const [minX, minY, minZ] = bounds.min;
  const [maxX, maxY, maxZ] = bounds.max;
  const stepX = (maxX - minX) / gx;
  const stepY = (maxY - minY) / gy;
  const stepZ = (maxZ - minZ) / gz;

  // The field is sampled once per grid point rather than once per cube corner: a cube shares corners with
  // its six neighbours, so caching turns 8 evaluations per cube into ~1. On a 64³ grid that is the
  // difference between 2 million and 260 thousand calls into guest code.
  const sampleCount = (gx + 1) * (gy + 1) * (gz + 1);
  const samples = new Float32Array(sampleCount);
  const sampleIndex = (x: number, y: number, z: number): number =>
    x + y * (gx + 1) + z * (gx + 1) * (gy + 1);

  for (let z = 0; z <= gz; z += 1) {
    for (let y = 0; y <= gy; y += 1) {
      for (let x = 0; x <= gx; x += 1) {
        const value = field(minX + x * stepX, minY + y * stepY, minZ + z * stepZ);
        // A field that returns NaN would produce NaN vertices and poison the bounding sphere for the whole
        // subtree, so a bad sample is treated as "far outside" instead.
        samples[sampleIndex(x, y, z)] = Number.isFinite(value) ? value - isoLevel : 1e9;
      }
    }
  }

  const positions: number[] = [];
  const indices: number[] = [];
  const cornerValues = new Float32Array(8);
  const edgeVertex = new Int32Array(12);

  /**
   * Vertices shared along cube edges are deduplicated by a positional key.
   *
   * Marching cubes naturally emits a triangle soup, and leaving it that way costs three ways: 3× the
   * vertices, faceted shading where the surface should be smooth, and a broken `weld` downstream. Keying on
   * the quantised edge midpoint is cheap and exact, because two cubes sharing an edge compute the identical
   * crossing.
   */
  const edgeCache = new Map<number, number>();

  for (let z = 0; z < gz; z += 1) {
    for (let y = 0; y < gy; y += 1) {
      for (let x = 0; x < gx; x += 1) {
        let cubeIndex = 0;
        for (let corner = 0; corner < 8; corner += 1) {
          const offset = CORNER_OFFSETS[corner] as readonly [number, number, number];
          const value = samples[sampleIndex(x + offset[0], y + offset[1], z + offset[2])] as number;
          cornerValues[corner] = value;
          if (value < 0) cubeIndex |= 1 << corner;
        }

        const edges = EDGE_TABLE[cubeIndex] as number;
        // Fully inside or fully outside: no surface passes through this cube.
        if (edges === 0) continue;

        edgeVertex.fill(-1);

        for (let edge = 0; edge < 12; edge += 1) {
          if ((edges & (1 << edge)) === 0) continue;

          const [ca, cb] = EDGE_CORNERS[edge] as readonly [number, number];
          const oa = CORNER_OFFSETS[ca] as readonly [number, number, number];
          const ob = CORNER_OFFSETS[cb] as readonly [number, number, number];

          // Grid coordinates of the two corners this edge spans.
          const ax = x + oa[0];
          const ay = y + oa[1];
          const az = z + oa[2];
          const bx = x + ob[0];
          const by = y + ob[1];
          const bz = z + ob[2];

          // Cache key from the corner pair, ordered so both owning cubes produce the same key.
          const keyA = sampleIndex(ax, ay, az);
          const keyB = sampleIndex(bx, by, bz);
          const key = keyA < keyB ? keyA * sampleCount + keyB : keyB * sampleCount + keyA;

          const cached = edgeCache.get(key);
          if (cached !== undefined) {
            edgeVertex[edge] = cached;
            continue;
          }

          const va = cornerValues[ca] as number;
          const vb = cornerValues[cb] as number;
          // Linear interpolation to the zero crossing is what makes marching cubes smooth rather than
          // blocky: snapping to corners would produce visible voxels.
          const denominator = vb - va;
          const t = Math.abs(denominator) > 1e-12 ? -va / denominator : 0.5;

          const vertex = positions.length / 3;
          positions.push(
            minX + (ax + (bx - ax) * t) * stepX,
            minY + (ay + (by - ay) * t) * stepY,
            minZ + (az + (bz - az) * t) * stepZ,
          );
          edgeCache.set(key, vertex);
          edgeVertex[edge] = vertex;
        }

        const triBase = cubeIndex * 16;
        for (let i = 0; i < 15; i += 3) {
          const a = TRI_TABLE[triBase + i] as number;
          if (a < 0) break;
          const ia = edgeVertex[a] as number;
          const ib = edgeVertex[TRI_TABLE[triBase + i + 1] as number] as number;
          const ic = edgeVertex[TRI_TABLE[triBase + i + 2] as number] as number;
          if (ia < 0 || ib < 0 || ic < 0) continue;
          indices.push(ia, ib, ic);
        }
      }
    }
  }

  const mesh: MeshData = {
    positions: new Float32Array(positions),
    indices: new Uint32Array(indices),
  };
  mesh.normals = computeNormals(mesh);
  return mesh;
}

export interface ParametricOptions {
  surface: SurfaceFn;
  /** Grid divisions in u and v. */
  segments?: number | readonly [number, number];
  /** Close the surface in u and/or v, so a tube or torus has no seam. */
  closed?: { u?: boolean; v?: boolean };
}

/**
 * Evaluate a parametric surface on a grid.
 *
 * The exact counterpart to the implicit path: anything with a formula gets its true shape rather than an
 * approximation. `01-MODELS.md` requires this for wave propagation specifically — "A wave must be a surface
 * whose vertices follow the wave function, not a curved still shape wiggling" — and it is equally the right
 * answer for a Möbius strip, a hyperboloid, a spherical harmonic, or a function plot in the mathematics
 * domain, where `00` insists on "the textbook graph — axes, origin, units, a clean curve".
 */
export function parametric(options: ParametricOptions): MeshData {
  const segments = options.segments ?? 32;
  const [su, sv] = typeof segments === 'number' ? ([segments, segments] as const) : segments;

  const nu = Math.max(2, Math.min(400, Math.floor(su)));
  const nv = Math.max(2, Math.min(400, Math.floor(sv)));
  const closedU = options.closed?.u ?? false;
  const closedV = options.closed?.v ?? false;

  const rows = closedV ? nv : nv + 1;
  const cols = closedU ? nu : nu + 1;

  const positions = new Float32Array(rows * cols * 3);
  const uvs = new Float32Array(rows * cols * 2);

  for (let v = 0; v < rows; v += 1) {
    for (let u = 0; u < cols; u += 1) {
      const fu = u / nu;
      const fv = v / nv;
      const point = options.surface(fu, fv);
      const index = (v * cols + u) * 3;
      // A formula that divides by zero at a pole is common — a spherical parameterisation does it at both —
      // so non-finite output collapses to the origin rather than poisoning the mesh.
      positions[index] = Number.isFinite(point[0]) ? point[0] : 0;
      positions[index + 1] = Number.isFinite(point[1]) ? point[1] : 0;
      positions[index + 2] = Number.isFinite(point[2]) ? point[2] : 0;
      uvs[(v * cols + u) * 2] = fu;
      uvs[(v * cols + u) * 2 + 1] = fv;
    }
  }

  const indices: number[] = [];
  for (let v = 0; v < (closedV ? rows : rows - 1); v += 1) {
    for (let u = 0; u < (closedU ? cols : cols - 1); u += 1) {
      const nextU = (u + 1) % cols;
      const nextV = (v + 1) % rows;
      const a = v * cols + u;
      const b = v * cols + nextU;
      const c = nextV * cols + nextU;
      const d = nextV * cols + u;
      indices.push(a, c, b, a, d, c);
    }
  }

  const mesh: MeshData = { positions, indices: new Uint32Array(indices), uvs };
  mesh.normals = computeNormals(mesh);
  return mesh;
}

/**
 * A height field over a rectangle — terrain, a potential surface, a 2D function plot.
 *
 * Sugar over `parametric`, provided separately because `z = f(x, y)` is how most non-mathematicians think,
 * and requiring them to write the parameterisation themselves invites off-by-one errors in the mapping.
 */
export function heightField(
  width: number,
  depth: number,
  heightAt: (x: number, z: number) => number,
  segments: number | readonly [number, number] = 64,
): MeshData {
  return parametric({
    surface: (u, v) => {
      const x = (u - 0.5) * width;
      const z = (v - 0.5) * depth;
      return [x, heightAt(x, z), z];
    },
    segments,
  });
}

/**
 * A travelling wave surface.
 *
 * Present as a named builder because `01` singles it out: a sinusoid that "vibrates" without its crest
 * *travelling* teaches nothing about propagation. Phase is a parameter, so binding it to the model's clock
 * produces genuine propagation rather than a standing wiggle.
 */
export function waveSurface(
  width: number,
  depth: number,
  amplitude: number,
  wavelength: number,
  phase: number,
  segments: number | readonly [number, number] = 64,
): MeshData {
  const k = TAU / Math.max(1e-6, wavelength);
  return heightField(
    width,
    depth,
    (x, z) => {
      const radial = Math.sqrt(x * x + z * z);
      // Radial rather than planar by default: a point disturbance spreading outward is the wave a learner
      // recognises, and an envelope keeps the far field from looking like an infinite grid.
      const envelope = 1 - smootherstep(radial / (Math.max(width, depth) / 2));
      return Math.sin(k * radial - phase) * amplitude * envelope;
    },
    segments,
  );
}
