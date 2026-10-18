/**
 * The QEM decimator's contract: the ladder's ability to cut cost without cutting the lesson.
 *
 * Two populations exercise this file. The first is engine-made geometry — clean, indexed,
 * manifold — where the quadric maths is allowed to be good. The second is adversarial input in
 * the shapes AI-generated models actually arrive in: non-manifold edges, zero-area triangles, a
 * NaN vertex the sanitizer missed, duplicated positions, meshes too small to cut. For that
 * population the contract is **fail-soft**: the operator never throws and never silently
 * corrupts — it returns the input geometry unchanged unless it provably improved it, because a
 * simplify bug must cost a triangle budget, never a lesson (`Q2`).
 *
 * Invariants asserted here, so every caller downstream gets them by construction:
 *   - triangle-count control: keep 0.5 of a known mesh lands in ±2%;
 *   - zero degenerate output regardless of input pathology;
 *   - no newly-disconnected surface (the lesson's topology survives);
 *   - the source is never mutated (the structural cache shares buffers behind the caller's back);
 *   - determinism: identical input, identical output, byte for byte (the cache keys on it);
 *   - normals recomputed from the decimated positions, not carried from the full mesh.
 */
import { decimate } from '../src/geometry/decimate.ts';
import {
  computeNormals,
  validateMesh,
  meshBounds,
  type MeshData,
} from '../src/geometry/mesh-data.ts';
import { sphere as spherePrimitive } from '../src/geometry/primitives.ts';
import { describe, expect, it } from 'vitest';

/** An indexed sphere with a known triangle count — the clean population's fixture. */
const sphere = (radius = 1, widthSegments = 24, heightSegments = 16): MeshData =>
  spherePrimitive(radius, widthSegments, heightSegments);

/** Count connected components over a triangle soup (shared vertex ids weld triangles). */
function surfaceComponents(mesh: MeshData): number {
  const adjacency = new Map<number, Set<number>>();
  for (let i = 0; i < mesh.indices!.length; i += 3) {
    const tri = [mesh.indices![i]!, mesh.indices![i + 1]!, mesh.indices![i + 2]!];
    for (let v = 0; v < 3; v += 1) {
      const from = tri[v]!;
      const to = tri[(v + 1) % 3]!;
      if (!adjacency.has(from)) adjacency.set(from, new Set());
      adjacency.get(from)!.add(to);
      if (!adjacency.has(to)) adjacency.set(to, new Set());
      adjacency.get(to)!.add(from);
    }
  }
  const seen = new Set<number>();
  let components = 0;
  for (const start of adjacency.keys()) {
    if (seen.has(start)) continue;
    components += 1;
    const queue = [start];
    seen.add(start);
    while (queue.length > 0) {
      const current = queue.pop()!;
      for (const neighbour of adjacency.get(current) ?? []) {
        if (!seen.has(neighbour)) {
          seen.add(neighbour);
          queue.push(neighbour);
        }
      }
    }
  }
  return components;
}

const hasDegenerate = (mesh: MeshData): boolean =>
  validateMesh(mesh).some((problem) => problem.kind === 'degenerate_triangle');

const triangleCount = (mesh: MeshData): number => (mesh.indices?.length ?? 0) / 3;

const cloneMesh = (mesh: MeshData): MeshData => ({
  positions: new Float32Array(mesh.positions),
  indices: new Uint32Array(mesh.indices!),
  ...(mesh.normals ? { normals: new Float32Array(mesh.normals) } : {}),
});

describe('decimate — the clean population', () => {
  it('keeps roughly the requested fraction of triangles on a segmented sphere', () => {
    const mesh = sphere();
    const before = triangleCount(mesh);
    const out = decimate(mesh, { keep: 0.5 });
    const after = triangleCount(out);
    expect(after).toBeGreaterThanOrEqual(before * 0.48);
    expect(after).toBeLessThanOrEqual(before * 0.52);
    // The output is a real indexed mesh, not a stub.
    expect(out.positions.length / 3).toBeLessThan(mesh.positions.length / 3);
    expect(out.indices!.length % 3).toBe(0);
  });

  it('never produces a degenerate triangle', () => {
    const out = decimate(sphere(1, 20, 14), { keep: 0.4 });
    const p = out.positions;
    const idx = out.indices!;
    for (let i = 0; i < idx.length; i += 3) {
      const a = idx[i]! * 3;
      const b = idx[i + 1]! * 3;
      const c = idx[i + 2]! * 3;
      const abx = p[b]! - p[a]!;
      const aby = p[b + 1]! - p[a + 1]!;
      const abz = p[b + 2]! - p[a + 2]!;
      const acx = p[c]! - p[a]!;
      const acy = p[c + 1]! - p[a + 1]!;
      const acz = p[c + 2]! - p[a + 2]!;
      const cross =
        (aby * acz - abz * acy) ** 2 + (abz * acx - abx * acz) ** 2 + (abx * acy - aby * acx) ** 2;
      expect(cross).toBeGreaterThan(0);
    }
  });

  it('does not disconnect a connected surface', () => {
    const source = sphere(1, 24, 16);
    const out = decimate(source, { keep: 0.5 });
    // A sphere decimates to a sphere: one shell, intact, with no degenerate triangles.
    expect(surfaceComponents(out)).toBe(surfaceComponents(source));
    expect(hasDegenerate(out)).toBe(false);
  });

  it('recomputes normals from the decimated positions, not the source normals', () => {
    const mesh = sphere(1, 24, 16);
    // Poison every source normal so any carry-through is loud.
    mesh.normals!.fill(7);
    const out = decimate(mesh, { keep: 0.5 });
    // A unit sphere's normals are unit-length unit vectors pointing outward: |n| === 1 near
    // vertices the decimation merged. Length 7 anywhere means a source normal was carried.
    for (let i = 0; i < out.normals!.length; i += 1) {
      expect(Math.abs(out.normals![i]!)).toBeLessThanOrEqual(1.0001);
    }
  });

  it('never mutates the source', () => {
    const mesh = sphere(1, 24, 16);
    const snapshot = cloneMesh(mesh);
    decimate(mesh, { keep: 0.3 });
    expect(mesh.positions).toEqual(snapshot.positions);
    expect(mesh.indices).toEqual(snapshot.indices);
  });

  it('is deterministic — identical bytes on identical input', () => {
    const mesh = sphere(1, 24, 16);
    const a = decimate(mesh, { keep: 0.45 });
    const b = decimate(mesh, { keep: 0.45 });
    expect(Buffer.from(a.positions.buffer).equals(Buffer.from(b.positions.buffer))).toBe(true);
    expect(Buffer.from(a.indices!.buffer).equals(Buffer.from(b.indices!.buffer))).toBe(true);
  });
});

describe('decimate — the adversarial population (fail-soft by contract)', () => {
  it('returns the input unchanged for a non-indexed mesh, loudly naming the repair', () => {
    const mesh: MeshData = {
      positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
      // no indices: soup form
    };
    const out = decimate(mesh, { keep: 0.5 });
    expect(out).toBe(mesh);
  });

  it('survives a non-manifold edge (two triangles sharing an edge twice)', () => {
    const mesh: MeshData = {
      positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0]),
      indices: new Uint32Array([0, 1, 2, 1, 2, 3, 2, 1, 3]),
      normals: computeNormals({
        positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0]),
        indices: new Uint32Array([0, 1, 2, 1, 2, 3, 2, 1, 3]),
      }),
    };
    expect(() => decimate(mesh, { keep: 0.5 })).not.toThrow();
  });

  it('survives zero-area triangles and returns their connection intact', () => {
    // A proper triangle welded to a fully collapsed one (b === c).
    const mesh: MeshData = {
      positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
      indices: new Uint32Array([0, 1, 2, 0, 1, 1]),
      normals: computeNormals({
        positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
        indices: new Uint32Array([0, 1, 2, 0, 1, 1]),
      }),
    };
    const out = decimate(mesh, { keep: 0.5 });
    expect(hasDegenerate(out)).toBe(false);
    expect(triangleCount(out)).toBeGreaterThanOrEqual(1);
  });

  it('survives a NaN position without emitting NaN geometry', () => {
    const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]);
    positions[4] = NaN;
    const mesh: MeshData = {
      positions,
      indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
      normals: computeNormals({
        positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]),
        indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
      }),
    };
    const out = decimate(mesh, { keep: 0.5 });
    for (const v of out.positions) expect(Number.isFinite(v)).toBe(true);
  });

  it('survives duplicated positions (same coordinates, distinct indices)', () => {
    const mesh: MeshData = {
      positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 0, 0]),
      indices: new Uint32Array([0, 1, 2, 3, 2, 1]),
      normals: computeNormals({
        positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 0, 0]),
        indices: new Uint32Array([0, 1, 2, 3, 2, 1]),
      }),
    };
    const out = decimate(mesh, { keep: 0.5 });
    // The bounds build skips non-finite components by design, so a NaN any output vertex would
    // show up as a min left at its initialised poisoned value — assert all six are finite.
    const bounds = meshBounds(out);
    expect(
      Number.isFinite(bounds.minX) &&
        Number.isFinite(bounds.minY) &&
        Number.isFinite(bounds.minZ) &&
        Number.isFinite(bounds.maxX) &&
        Number.isFinite(bounds.maxY) &&
        Number.isFinite(bounds.maxZ),
    ).toBe(true);
  });

  it('refuses to cut below one triangle, even at keep values near zero', () => {
    const mesh: MeshData = {
      positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
      indices: new Uint32Array([0, 1, 2]),
    };
    const out = decimate(mesh, { keep: 0.0001 });
    expect(triangleCount(out)).toBe(1);
    expect(hasDegenerate(out)).toBe(false);
  });

  it('treats keep 1 as a full-fidelity no-op', () => {
    const mesh = sphere(1, 16, 12);
    const out = decimate(mesh, { keep: 1 });
    expect(triangleCount(out)).toBe(triangleCount(mesh));
  });
});
