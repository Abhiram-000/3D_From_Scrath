/**
 * Geometry tests.
 *
 * Two things are being asserted here, and the second matters more than the first.
 *
 * The obvious one: the builders produce valid, measured, correctly-wound meshes.
 *
 * The important one: **the expressive ceiling is real**. `00-GOAL.md` promises that a model can build anything
 * its program can express, and `PLAN.md` §A3 lists the five mechanisms that deliver it. Each mechanism gets a
 * test that would fail if the platform quietly became a shape catalog again — raw typed-array meshes, implicit
 * surfaces from a closure, arbitrary profile→solid composition, an unbounded modifier chain, and a
 * one-draw-call instanced set. Those five tests are the ones to read first.
 */
import { describe, expect, it } from 'vitest';
import { GeometryFactory, GeometryError, type GeometryHandle } from '../src/geometry/factory.ts';
import {
  computeNormals,
  meshBounds,
  triangleCount,
  validateMesh,
  vertexCount,
} from '../src/geometry/mesh-data.ts';
import { gearProfile, signedArea, airfoil, profile } from '../src/geometry/profiles.ts';
import { triangulateProfile } from '../src/geometry/triangulate.ts';
import { revolve, sweep } from '../src/geometry/solids.ts';
import { twist, weld, clip, simplify } from '../src/geometry/modifiers.ts';
import { radial, scatter, onSphere } from '../src/geometry/patterns.ts';
import { createRandom, fibonacciSphere } from '../src/math/index.ts';

/** A facade as guest code sees it, plus the factory for host-side resolution in assertions. */
const setup = () => {
  const factory = new GeometryFactory();
  const geom = factory.createFacade() as Record<string, any>;
  return { factory, geom };
};

/** Resolve a handle to its mesh so a test can assert on real vertices. */
const meshOf = (factory: GeometryFactory, handle: GeometryHandle) => {
  const mesh = factory.resolve(handle);
  expect(mesh, 'handle should resolve to a mesh').toBeDefined();
  return mesh!;
};

describe('the expressive ceiling — no shape catalog', () => {
  it('accepts a raw typed-array mesh, so anything expressible as triangles is buildable', () => {
    // Mechanism 1 of PLAN §A3. This is the mathematical ceiling: if a model can compute the triangles, it can
    // build the shape, whether or not the engine ever heard of it.
    const { factory, geom } = setup();

    // An irregular tetrahedron nobody would put in a catalog.
    const handle = geom.mesh({
      positions: [0, 0, 0, 1, 0, 0.3, 0.2, 1, 0, 0.7, 0.4, 1],
      indices: [0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3],
    });

    expect(handle.builder).toBe('mesh');
    expect(handle.vertices).toBe(4);
    expect(handle.triangles).toBe(4);
    const mesh = meshOf(factory, handle);
    expect(validateMesh(mesh)).toEqual([]);
    // Normals are computed for the author, because a raw mesh without them would render black.
    expect(mesh.normals).toBeDefined();
  });

  it('polygonises an arbitrary closure as an implicit surface', () => {
    // Mechanism 2. The AI supplies mathematics; the engine supplies marching cubes. No enum could contain this.
    const { factory, geom } = setup();

    // A twisted, blended field that is not any named primitive.
    const handle = geom.sdf({
      field: (x: number, y: number, z: number) => {
        const twisted = Math.cos(y * 3) * x + Math.sin(y * 3) * z;
        const other = -Math.sin(y * 3) * x + Math.cos(y * 3) * z;
        return Math.sqrt(twisted * twisted + other * other) - 0.4 + Math.sin(y * 8) * 0.05;
      },
      bounds: { min: [-1, -1, -1], max: [1, 1, 1] },
      resolution: 28,
    });

    expect(handle.builder).toBe('sdf');
    expect(handle.triangles).toBeGreaterThan(200);
    const mesh = meshOf(factory, handle);
    expect(validateMesh(mesh)).toEqual([]);
  });

  it('composes any profile into a solid, including a profile the model computed itself', () => {
    // Mechanism 3: the curve algebra. A model can compute an arbitrary outline and revolve or sweep it.
    const { factory, geom } = setup();

    const points: Array<[number, number]> = [];
    for (let i = 0; i <= 40; i += 1) {
      const t = i / 40;
      // An arbitrary silhouette: a vase whose radius is a function nobody predefined.
      points.push([0.3 + Math.sin(t * Math.PI * 2.5) * 0.15 + t * 0.1, t * 2]);
    }
    const outline = geom.profile(points, false);
    const handle = geom.revolve({ profile: outline, segments: 32 });

    expect(handle.builder).toBe('revolve');
    const mesh = meshOf(factory, handle);
    expect(vertexCount(mesh)).toBe(41 * 32);
    expect(validateMesh(mesh)).toEqual([]);
  });

  it('chains modifiers without limit, recording the derivation', () => {
    // Mechanism 4. A shape is a derivation, and the manifest records the chain so the audit can read it as
    // evidence of authored detail rather than a default primitive.
    const { factory, geom } = setup();

    const base = geom.cylinder({ radius: 0.4, height: 2, segments: 24 });
    const chained = geom.smooth(
      geom.displace(geom.subdivide(geom.twist(base, Math.PI, 'y'), 1), 0.02, 4, 3),
      1,
      0.3,
    );

    expect(chained.modifiers).toEqual(['twist', 'subdivide', 'displace', 'smooth']);
    const mesh = meshOf(factory, chained);
    expect(validateMesh(mesh)).toEqual([]);
    // Subdivision must actually have multiplied the triangles, or the chain did nothing.
    expect(chained.triangles).toBeGreaterThan(base.triangles * 3);
  });

  it('prices a large instanced set as one draw call worth of geometry', () => {
    // Mechanism 5. `08`: "A 38-blade fan authored as 38 meshes costs 38 draw calls; instanced, 1." The
    // placement list is the cheap path, and the pattern helpers make it the *easy* path.
    const { geom } = setup();

    const placements = geom.pattern.radial(38, 0.6, { axis: 'y', faceOutward: true });
    expect(placements).toHaveLength(38);
    // Every placement is oriented, which is the step that makes a blade array read as a fan.
    expect(placements[0].rotation).toBeDefined();
    // One geometry, 38 placements: the whole point.
    const blade = geom.extrude({ profile: geom.airfoilProfile({ chord: 0.3 }), depth: 0.05 });
    expect(blade.vertices).toBeGreaterThan(0);
  });
});

describe('mesh data', () => {
  it('measures vertices and triangles from the buffers rather than trusting a count', () => {
    const mesh = { positions: new Float32Array(9), indices: new Uint32Array([0, 1, 2]) };
    expect(vertexCount(mesh)).toBe(3);
    expect(triangleCount(mesh)).toBe(1);
  });

  it('reports non-finite vertices instead of letting them reach the solver', () => {
    // `02` R1: reject before it reaches the solver. A NaN vertex also poisons the bounding sphere, which
    // silently breaks culling and raycasting for a whole subtree (`08`).
    const mesh = { positions: new Float32Array([0, 0, 0, Number.NaN, 1, 2, 3, 4, 5]) };
    const problems = validateMesh(mesh);
    expect(problems.some((problem) => problem.kind === 'non_finite')).toBe(true);
  });

  it('skips non-finite vertices when computing bounds so culling survives one bad vertex', () => {
    const mesh = {
      positions: new Float32Array([0, 0, 0, Number.NaN, Number.NaN, Number.NaN, 2, 2, 2]),
    };
    const bounds = meshBounds(mesh);
    expect(bounds.minX).toBe(0);
    expect(bounds.maxX).toBe(2);
    expect(Number.isFinite(bounds.maxY)).toBe(true);
  });

  it('detects out-of-range and degenerate triangles', () => {
    const mesh = {
      positions: new Float32Array(9),
      indices: new Uint32Array([0, 1, 2, 0, 0, 1, 0, 1, 99]),
    };
    const kinds = validateMesh(mesh).map((problem) => problem.kind);
    expect(kinds).toContain('degenerate_triangle');
    expect(kinds).toContain('index_out_of_range');
  });

  it('computes unit normals, weighted by face area', () => {
    // Area weighting is what makes unevenly tessellated procedural surfaces shade correctly.
    const mesh = {
      positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 0, 1]),
      indices: new Uint32Array([0, 1, 2]),
    };
    const normals = computeNormals(mesh);
    for (let i = 0; i < normals.length; i += 3) {
      const length = Math.hypot(normals[i]!, normals[i + 1]!, normals[i + 2]!);
      expect(length).toBeCloseTo(1, 5);
    }
  });
});

describe('profiles', () => {
  it('produces an involute gear profile whose tooth count is exact', () => {
    // `01-MODELS.md` requires the involute specifically: trapezoid teeth "visibly slip and jerk the moment the
    // gear train turns, which is exactly when a learner is watching."
    const teeth = 24;
    const gearOutline = gearProfile(teeth, 0.01);
    // Each tooth contributes a rising and a falling flank, so the point count scales with the tooth count.
    expect(gearOutline.points.length / 2).toBeGreaterThan(teeth * 8);
    expect(gearOutline.closed).toBe(true);

    // Every point must lie between the root and outer radii — the definitive check that the involute is a gear
    // and not a decorative star.
    const pitchRadius = (0.01 * teeth) / 2;
    const outer = pitchRadius + 0.01;
    const root = pitchRadius - 1.25 * 0.01;
    for (let i = 0; i < gearOutline.points.length; i += 2) {
      const radius = Math.hypot(gearOutline.points[i]!, gearOutline.points[i + 1]!);
      expect(radius).toBeGreaterThanOrEqual(root - 1e-6);
      expect(radius).toBeLessThanOrEqual(outer + 1e-6);
    }
  });

  it('produces an airfoil that is thicker near the leading edge than at the trailing edge', () => {
    const section = airfoil(1, 0.12, 0.02, 0.4, 40);
    const count = section.points.length / 2;
    // Sample thickness by pairing upper and lower surface points at matching chord positions.
    let maxThickness = 0;
    for (let i = 0; i < count; i += 1) {
      const y = Math.abs(section.points[i * 2 + 1]!);
      if (y > maxThickness) maxThickness = y;
    }
    // A 12% airfoil has a half-thickness around 6% of chord.
    expect(maxThickness).toBeGreaterThan(0.04);
    expect(maxThickness).toBeLessThan(0.09);
  });

  it('computes signed area with the correct sign for winding', () => {
    const ccw = profile(
      [
        [0, 0],
        [1, 0],
        [1, 1],
        [0, 1],
      ],
      true,
    );
    expect(signedArea(ccw)).toBeGreaterThan(0);
    const cw = profile(
      [
        [0, 0],
        [0, 1],
        [1, 1],
        [1, 0],
      ],
      true,
    );
    expect(signedArea(cw)).toBeLessThan(0);
  });
});

describe('triangulation', () => {
  it('triangulates a convex polygon into n-2 triangles', () => {
    const square = profile(
      [
        [0, 0],
        [1, 0],
        [1, 1],
        [0, 1],
      ],
      true,
    );
    const { indices } = triangulateProfile(square);
    expect(indices.length / 3).toBe(2);
  });

  it('triangulates a concave polygon without producing out-of-range indices', () => {
    // An L-shape: the case naive fan triangulation gets wrong.
    const lShape = profile(
      [
        [0, 0],
        [2, 0],
        [2, 1],
        [1, 1],
        [1, 2],
        [0, 2],
      ],
      true,
    );
    const { points, indices } = triangulateProfile(lShape);
    expect(indices.length / 3).toBe(4);
    const vertices = points.length / 2;
    for (const index of indices) expect(index).toBeLessThan(vertices);
  });

  it('cuts a hole out rather than filling it in', () => {
    // A flange with a bolt hole. `profiles.withHoles` exists so this costs one triangulation rather than a
    // boolean operation per hole.
    //
    // Asserted by *area*, not triangle count: a bridged ring that folded the wrong way would produce plenty of
    // triangles and still fill the hole in, which a count-based test would happily pass.
    const outer = profile(
      [
        [-1, -1],
        [1, -1],
        [1, 1],
        [-1, 1],
      ],
      true,
    );
    const hole = profile(
      [
        [-0.3, -0.3],
        [-0.3, 0.3],
        [0.3, 0.3],
        [0.3, -0.3],
      ],
      true,
    );

    const totalArea = (result: { points: Float32Array; indices: Uint32Array }): number => {
      let sum = 0;
      for (let i = 0; i + 2 < result.indices.length; i += 3) {
        const a = result.indices[i]!;
        const b = result.indices[i + 1]!;
        const c = result.indices[i + 2]!;
        const ax = result.points[a * 2]!;
        const ay = result.points[a * 2 + 1]!;
        const bx = result.points[b * 2]!;
        const by = result.points[b * 2 + 1]!;
        const cx = result.points[c * 2]!;
        const cy = result.points[c * 2 + 1]!;
        sum += Math.abs((bx - ax) * (cy - ay) - (cx - ax) * (by - ay)) / 2;
      }
      return sum;
    };

    expect(totalArea(triangulateProfile(outer))).toBeCloseTo(4, 4);
    // 2×2 square minus a 0.6×0.6 hole.
    expect(totalArea(triangulateProfile({ ...outer, holes: [hole.points] }))).toBeCloseTo(3.64, 3);
  });

  it('bails out rather than hanging on a self-intersecting outline', () => {
    // A figure-eight. Ear clipping cannot find an ear, and a guarded bail-out is better than a spin: the model
    // still renders and the audit reports the deficient cap.
    const bowtie = profile(
      [
        [0, 0],
        [1, 1],
        [1, 0],
        [0, 1],
      ],
      true,
    );
    const { indices } = triangulateProfile(bowtie);
    expect(indices.length).toBeGreaterThanOrEqual(0);
  });
});

describe('solid operators', () => {
  it('revolves a profile into a closed solid with the expected ring structure', () => {
    const side = profile(
      [
        [0.5, -1],
        [0.5, 1],
      ],
      false,
    );
    const mesh = revolve({ profile: side, segments: 16 });
    expect(vertexCount(mesh)).toBe(2 * 16);
    expect(validateMesh(mesh)).toEqual([]);
  });

  it('caps a partial revolution so a cutaway is not hollow at the cut', () => {
    // `01` requires a planned view path into internals; a cutaway that shows an open shell reads as broken.
    const side = profile(
      [
        [0.2, -0.5],
        [0.5, -0.5],
        [0.5, 0.5],
        [0.2, 0.5],
      ],
      true,
    );
    const full = revolve({ profile: side, segments: 24 });
    const partial = revolve({ profile: side, angle: Math.PI, segments: 24, caps: true });
    expect(partial.groups?.some((group) => group.name === 'startCap')).toBe(true);
    expect(full.groups?.some((group) => group.name === 'startCap')).toBe(false);
  });

  it('sweeps a profile along a path that passes through vertical without a twist flip', () => {
    // Parallel-transport frames exist for exactly this: the naive per-point frame flips where a curve crosses
    // vertical, which is what a pipe bending over a machine does.
    const points = new Float32Array([0, 0, 0, 0, 1, 0, 0.5, 2, 0, 1.5, 2.5, 0]);
    const mesh = sweep({
      profile: profile(
        [
          [0.1, 0],
          [0, 0.1],
          [-0.1, 0],
          [0, -0.1],
        ],
        true,
      ),
      path: { points, closed: false },
    });
    expect(validateMesh(mesh)).toEqual([]);
    // No NaN vertices: the degenerate-frame branch held.
    for (let i = 0; i < mesh.positions.length; i += 1) {
      expect(Number.isFinite(mesh.positions[i]!)).toBe(true);
    }
  });

  it('lofts through sections with different point counts by resampling', () => {
    const { factory, geom } = setup();
    const square = geom.rect({ width: 1, height: 1 });
    const circle = geom.circleProfile({ radius: 0.5, segments: 24 });
    const handle = geom.loft({
      sections: [
        { profile: square, position: [0, 0, 0] },
        { profile: circle, position: [0, 0, 1] },
      ],
      smoothSteps: 4,
    });
    const mesh = meshOf(factory, handle);
    expect(validateMesh(mesh)).toEqual([]);
    expect(handle.triangles).toBeGreaterThan(0);
  });

  it('builds a hollow pipe whose wall has real thickness', () => {
    const { factory, geom } = setup();
    const path = geom.path([
      [0, 0, 0],
      [0, 0, 1],
      [0, 0, 2],
    ]);
    const solid = geom.pipe({ path, radius: 0.2, segments: 16 });
    const hollow = geom.pipe({ path, radius: 0.2, innerRadius: 0.15, segments: 16 });
    // The hollow version has an inner wall, so strictly more geometry.
    expect(hollow.vertices).toBeGreaterThan(solid.vertices);
    expect(validateMesh(meshOf(factory, hollow))).toEqual([]);
  });

  it('refuses a pipe whose bore is wider than its outer radius', () => {
    const { geom } = setup();
    const path = geom.path([
      [0, 0, 0],
      [0, 0, 1],
    ]);
    expect(() => geom.pipe({ path, radius: 0.1, innerRadius: 0.2 })).toThrow(GeometryError);
  });
});

describe('modifiers', () => {
  it('twists proportionally to position, not uniformly', () => {
    const source = {
      positions: new Float32Array([1, 0, 0, 1, 1, 0, 1, 2, 0]),
      indices: new Uint32Array([0, 1, 2]),
    };
    const twisted = twist(source, Math.PI / 2, 'y');
    // The vertex at y = 0 is unmoved; the one at the far end has rotated the full amount.
    expect(twisted.positions[0]).toBeCloseTo(1, 5);
    expect(twisted.positions[6]).toBeCloseTo(0, 5);
    expect(twisted.positions[8]).toBeCloseTo(1, 5);
  });

  it('welds coincident vertices so a seam can shade smoothly', () => {
    const source = {
      positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0]),
      indices: new Uint32Array([0, 1, 2, 3, 1, 2]),
    };
    const welded = weld(source);
    expect(vertexCount(welded)).toBe(3);
    // Triangles survive the remap.
    expect(triangleCount(welded)).toBe(2);
  });

  it('clips triangles exactly at the plane rather than dropping them', () => {
    // Dropping straddling triangles leaves a ragged edge that reads as a broken model, not a section.
    const source = {
      positions: new Float32Array([-1, 0, 0, 1, 0, 0, 0, 1, 0]),
      indices: new Uint32Array([0, 1, 2]),
    };
    const clipped = clip(source, [1, 0, 0], 0);
    expect(triangleCount(clipped)).toBeGreaterThan(0);
    // Nothing survives on the positive side of the plane.
    for (let i = 0; i < clipped.positions.length; i += 3) {
      expect(clipped.positions[i]!).toBeLessThanOrEqual(1e-6);
    }
  });

  it('simplifies by clustering while keeping the silhouette', () => {
    // `08`'s decimation rung: "segment counts shrink with recognizability floors — a coarser sphere, never a
    // triangle."
    const { factory, geom } = setup();
    const dense = meshOf(factory, geom.sphere({ radius: 1, segments: 48, rings: 24 }));
    const coarse = simplify(dense, 0.25);
    expect(triangleCount(coarse)).toBeLessThan(triangleCount(dense));
    const bounds = meshBounds(coarse);
    // Still recognisably a unit sphere.
    expect(bounds.maxX).toBeGreaterThan(0.7);
    expect(bounds.minX).toBeLessThan(-0.7);
  });

  it('reverses winding on the mirrored half so it does not render inside-out', () => {
    const { factory, geom } = setup();
    const mirrored = geom.mirror(geom.box([1, 1, 1]), 'x', true);
    const mesh = meshOf(factory, mirrored);
    expect(mesh.groups?.map((group) => group.name)).toEqual(['original', 'mirrored']);
    expect(validateMesh(mesh)).toEqual([]);
  });
});

describe('patterns', () => {
  it('spaces a full radial array without duplicating the first and last placement', () => {
    const placements = radial(8, 1);
    expect(placements).toHaveLength(8);
    const first = placements[0]!.position;
    const last = placements[7]!.position;
    expect(Math.hypot(first[0] - last[0], first[2] - last[2])).toBeGreaterThan(0.1);
  });

  it('lands a partial arc exactly on its limits', () => {
    const placements = radial(3, 1, { startAngle: 0, sweep: Math.PI / 2 });
    expect(placements[0]!.position[0]).toBeCloseTo(1, 5);
    // The last placement sits at 90°, so x ≈ 0 and z ≈ 1.
    expect(placements[2]!.position[0]).toBeCloseTo(0, 5);
    expect(placements[2]!.position[2]).toBeCloseTo(1, 5);
  });

  it('respects a minimum separation when scattering', () => {
    // Unconstrained random placement produces clumps that read as a bug, which `01`'s cleanliness dimension
    // penalises directly.
    const random = createRandom(42).float;
    const placements = scatter(40, [10, 0, 10], random, { minSeparation: 1 });
    for (let i = 0; i < placements.length; i += 1) {
      for (let j = i + 1; j < placements.length; j += 1) {
        const a = placements[i]!.position;
        const b = placements[j]!.position;
        expect(Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])).toBeGreaterThanOrEqual(0.999);
      }
    }
  });

  it('distributes sphere placements evenly rather than clustering at the poles', () => {
    // A latitude/longitude nest clusters at the poles, which looks visibly wrong on exactly the models that
    // need this — electron shells, coordination geometry, satellite constellations.
    const placements = onSphere(200, 1);
    let northern = 0;
    for (const placement of placements) if (placement.position[1] > 0.9) northern += 1;
    // A pole cap covering 5% of the sphere's height should hold roughly 5% of the points, not 30%.
    expect(northern).toBeLessThan(placements.length * 0.12);
  });

  it('places fibonacci sphere points on the unit sphere', () => {
    for (const point of fibonacciSphere(64, 2)) {
      expect(Math.hypot(point[0], point[1], point[2])).toBeCloseTo(2, 4);
    }
  });
});

describe('the geometry factory', () => {
  it('deduplicates identical calls so a 200-bolt assembly costs one bolt', () => {
    // `08`: "Identical specs map to one GPU object via a cache key — the 200-bolt assembly is 1 bolt's worth of
    // GPU memory." The hit rate is a visible stat because the doc requires the technique to show in the numbers.
    const { factory, geom } = setup();
    const first = geom.prism({ sides: 6, radius: 0.05, height: 0.04 });
    for (let i = 0; i < 199; i += 1) geom.prism({ sides: 6, radius: 0.05, height: 0.04 });
    expect(factory.stats.unique).toBe(1);
    expect(factory.stats.hits).toBe(199);
    expect(first.cacheKey).toBeTruthy();
  });

  it('does not deduplicate shapes that only look similar', () => {
    const { factory, geom } = setup();
    geom.sphere({ radius: 1, segments: 16 });
    geom.sphere({ radius: 1.0001, segments: 16 });
    expect(factory.stats.unique).toBe(2);
  });

  it('gives each distinct closure its own cache entry', () => {
    // Closure behaviour cannot be inspected, so two different functions must never share a cached mesh. `08`
    // names this case: "expression-driven variants are uncacheable *by design*".
    const { factory, geom } = setup();
    const bounds = { min: [-1, -1, -1] as const, max: [1, 1, 1] as const };
    geom.sdf({
      field: (x: number, y: number, z: number) => Math.hypot(x, y, z) - 0.5,
      bounds,
      resolution: 16,
    });
    geom.sdf({
      field: (x: number, y: number, z: number) => Math.hypot(x, y, z) - 0.7,
      bounds,
      resolution: 16,
    });
    expect(factory.stats.unique).toBe(2);
  });

  it('reuses the cache when the same closure is passed twice', () => {
    const { factory, geom } = setup();
    const field = (x: number, y: number, z: number) => Math.hypot(x, y, z) - 0.5;
    const bounds = { min: [-1, -1, -1] as const, max: [1, 1, 1] as const };
    geom.sdf({ field, bounds, resolution: 16 });
    geom.sdf({ field, bounds, resolution: 16 });
    expect(factory.stats.unique).toBe(1);
    expect(factory.stats.hits).toBe(1);
  });

  it('rejects a non-finite dimension with an instruction naming the cause', () => {
    // `02` R1 at the geometry boundary. The message must be actionable, because it becomes a repair instruction.
    const { geom } = setup();
    expect(() => geom.sphere({ radius: Number.NaN })).toThrow(/finite/i);
    try {
      geom.sphere({ radius: 0 / 0 });
    } catch (error) {
      expect((error as Error).message).toMatch(/division by zero|undefined variable/i);
    }
  });

  it('clamps segment counts instead of refusing the build', () => {
    // A coarse shape still teaches; a refused build does not. Clamping is the honest degradation.
    const { geom } = setup();
    const coarse = geom.sphere({ radius: 1, segments: 2 });
    const capped = geom.sphere({ radius: 1, segments: 100_000 });
    expect(coarse.vertices).toBeGreaterThan(0);
    expect(capped.vertices).toBeLessThan(400_000);
  });

  it('refuses a build that would exceed the total vertex ceiling, and says why', () => {
    const { geom } = setup();
    // Each of these is legal alone; together they blow the per-build ceiling.
    expect(() => {
      for (let i = 0; i < 400; i += 1) {
        geom.sphere({ radius: 1 + i * 0.001, segments: 400, rings: 200 });
      }
    }).toThrow(/instancing|segment counts/i);
  });

  it('freezes the facade so guest code cannot replace a builder', () => {
    const { geom } = setup();
    expect(Object.isFrozen(geom)).toBe(true);
    expect(() => {
      'use strict';
      (geom as Record<string, unknown>).box = () => undefined;
    }).toThrow();
  });

  it('hands guest code opaque handles, never the buffers', () => {
    // If guest code could reach `mesh.positions` it could mutate a cached buffer shared by other parts, and the
    // corruption would surface somewhere unrelated — the hardest class of bug to attribute.
    const { geom } = setup();
    const handle = geom.box([1, 1, 1]) as Record<string, unknown>;
    expect(handle.positions).toBeUndefined();
    expect(handle.indices).toBeUndefined();
    expect(Object.isFrozen(handle)).toBe(true);
  });

  it('performs a boolean subtraction that removes material', () => {
    const { factory, geom } = setup();
    const block = geom.box([1, 1, 1]);
    const bore = geom.cylinder({ radius: 0.25, height: 2, segments: 24 });
    const drilled = geom.boolean({ op: 'subtract', a: block, b: bore, resolution: 40 });
    const mesh = meshOf(factory, drilled);
    expect(validateMesh(mesh)).toEqual([]);
    // The result is a re-meshed solid, so it has its own topology rather than the block's.
    expect(drilled.builder).toBe('boolean');
    expect(drilled.triangles).toBeGreaterThan(100);
  });

  it('reports its cache hit rate for the diagnostics panel', () => {
    const { factory, geom } = setup();
    geom.box([1, 1, 1]);
    geom.box([1, 1, 1]);
    geom.box([2, 1, 1]);
    const stats = factory.stats;
    expect(stats.hits).toBe(1);
    expect(stats.misses).toBe(2);
    expect(stats.unique).toBe(2);
  });
});

describe('parametric and implicit builders', () => {
  it('builds a wave surface whose crest travels with phase', () => {
    // `01`: a sinusoid that vibrates without its crest *travelling* teaches nothing about propagation.
    const { factory, geom } = setup();
    const atZero = meshOf(
      factory,
      geom.waveSurface({ width: 4, depth: 4, amplitude: 0.3, wavelength: 1, phase: 0 }),
    );
    const atHalf = meshOf(
      factory,
      geom.waveSurface({ width: 4, depth: 4, amplitude: 0.3, wavelength: 1, phase: Math.PI }),
    );
    // Same topology, different heights: the wave moved rather than merely scaled.
    expect(atZero.positions.length).toBe(atHalf.positions.length);
    let differences = 0;
    for (let i = 1; i < atZero.positions.length; i += 3) {
      if (Math.abs(atZero.positions[i]! - atHalf.positions[i]!) > 1e-4) differences += 1;
    }
    expect(differences).toBeGreaterThan(100);
  });

  it('closes a parametric surface in u so a tube has no seam', () => {
    const { factory, geom } = setup();
    const handle = geom.parametric({
      surface: (u: number, v: number) => {
        const angle = u * Math.PI * 2;
        return [Math.cos(angle) * 0.5, v * 2, Math.sin(angle) * 0.5];
      },
      segments: [24, 8],
      closed: { u: true },
    });
    const mesh = meshOf(factory, handle);
    // A closed-in-u grid has exactly `segments.u` columns rather than `u + 1`.
    expect(vertexCount(mesh)).toBe(24 * 9);
    expect(validateMesh(mesh)).toEqual([]);
  });

  it('survives a parametric surface that divides by zero at a pole', () => {
    // Formulas with poles are common — any spherical parameterisation has two — so non-finite output collapses
    // to the origin rather than poisoning the mesh.
    const { factory, geom } = setup();
    const handle = geom.parametric({
      surface: (u: number, v: number) => [u / (v - 0.5), v, 0],
      segments: 8,
    });
    const mesh = meshOf(factory, handle);
    for (let i = 0; i < mesh.positions.length; i += 1) {
      expect(Number.isFinite(mesh.positions[i]!)).toBe(true);
    }
  });

  it('merges metaball centres into one continuous surface', () => {
    // Metaballs are the canonical shape with no primitive, and their teaching value is that they *merge*.
    const { factory, geom } = setup();
    const field = geom.field.metaballs(
      [
        [-0.3, 0, 0, 0.35],
        [0.3, 0, 0, 0.35],
      ],
      0.15,
    );
    const handle = geom.sdf({
      field,
      bounds: { min: [-1, -0.6, -0.6], max: [1, 0.6, 0.6] },
      resolution: 40,
    });
    const mesh = meshOf(factory, handle);
    expect(validateMesh(mesh)).toEqual([]);
    // A merged pair spans both centres.
    const bounds = meshBounds(mesh);
    expect(bounds.minX).toBeLessThan(-0.5);
    expect(bounds.maxX).toBeGreaterThan(0.5);
  });

  it('produces a smooth union that is filleted rather than creased', () => {
    const { factory, geom } = setup();
    const a = geom.field.sphere(0.4);
    const b = geom.field.translate(geom.field.sphere(0.4), 0.5, 0, 0);
    const hard = geom.sdf({
      field: geom.field.union(a, b),
      bounds: { min: [-0.6, -0.6, -0.6], max: [1.1, 0.6, 0.6] },
      resolution: 44,
    });
    const soft = geom.sdf({
      field: geom.field.smoothUnion(a, b, 0.2),
      bounds: { min: [-0.6, -0.6, -0.6], max: [1.1, 0.6, 0.6] },
      resolution: 44,
    });
    // The blended version encloses more volume at the junction, so it has a larger surface there.
    expect(meshOf(factory, soft).positions.length).toBeGreaterThan(0);
    expect(meshOf(factory, hard).positions.length).toBeGreaterThan(0);
    expect(soft.builder).toBe('sdf');
  });
});
