/**
 * The `geom` namespace: the geometry surface AI-written code calls.
 *
 * Three responsibilities that only exist at this boundary:
 *
 *  1. **Measurement.** Every call returns a handle carrying vertex/triangle counts and a structural cache key.
 *     `08` requires admission pricing "before allocation" — "a budget breach is never discovered as a stutter;
 *     it is prevented as a number" — and that is only possible if the number arrives with the shape.
 *  2. **Structural caching.** Identical calls return the same handle, so `08`'s dedup rule holds for shapes the
 *     engine has never seen: "the 200-bolt assembly is 1 bolt's worth of GPU memory."
 *  3. **Containment.** Guest code receives a frozen facade of bound functions and never a mutable object, and
 *     every numeric argument is validated before it can reach a loop bound or an allocation.
 *
 * What this file deliberately does *not* do is restrict what can be built. `geom.mesh` accepts raw typed
 * arrays, `geom.sdf` and `geom.parametric` accept sandboxed closures, and the modifier pipeline composes
 * without limit — `PLAN.md` §A3. The registry below is the single source of truth the static gate validates
 * against and the generation prompt is built from, so adding a builder widens the platform with no schema
 * change and no prompt drift.
 */
import { SANDBOX_LIMITS } from '@edu3d/contracts';
import {
  type MeshData,
  type Path3,
  type Profile,
  boundingRadius,
  computeNormals,
  meshBounds,
  mergeMeshes,
  triangleCount,
  vertexCount,
} from './mesh-data.ts';
import * as primitives from './primitives.ts';
import * as solids from './solids.ts';
import * as implicit from './implicit.ts';
import * as modifiers from './modifiers.ts';
import * as profiles from './profiles.ts';
import * as patterns from './patterns.ts';
import type { Vec3 } from '../math/index.ts';

/**
 * A geometry handle: what guest code holds instead of the buffers.
 *
 * Opaque on purpose. If guest code could reach `mesh.positions` it could mutate a cached buffer that other
 * parts share, and the resulting corruption would appear in an unrelated part of the model — the hardest class
 * of bug to attribute. Handles are inert identifiers; the builder owns the data.
 */
export interface GeometryHandle {
  readonly __brand: 'geometry';
  /** Which builder produced it, recorded in the manifest for diagnostics and the audit. */
  readonly builder: string;
  /** Structural hash. Identical specs share a handle and, later, one GPU object. */
  readonly cacheKey: string;
  readonly vertices: number;
  readonly triangles: number;
  readonly boundingRadius: number;
  /** Modifiers applied after the base build, in order. */
  readonly modifiers: readonly string[];
}

/** Internal record pairing a handle with its data. Never handed to guest code. */
interface GeometryRecord {
  handle: GeometryHandle;
  mesh: MeshData;
}

/** Profile and path handles follow the same discipline: opaque to the guest, owned by the factory. */
export interface ProfileHandle {
  readonly __brand: 'profile';
  readonly points: number;
  readonly closed: boolean;
  readonly cacheKey: string;
}

export interface PathHandle {
  readonly __brand: 'path';
  readonly points: number;
  readonly closed: boolean;
  readonly cacheKey: string;
}

/** Thrown when guest code asks for something the engine refuses. Message is written for the model to read. */
export class GeometryError extends Error {
  /** Class field ([[Define]] semantics): survives the frozen Error.prototype after realm hardening, where a constructor assignment ([[Set]]) throws. */
  override name = 'GeometryError';
  constructor(message: string) {
    super(message);
  }
}

/**
 * Validate a number before it reaches a loop bound or an allocation.
 *
 * `02` R1's rule applied to geometry: non-finite values are rejected at the boundary rather than propagated. A
 * `NaN` radius silently produces a mesh of `NaN` vertices, which then poisons the bounding sphere and breaks
 * culling and raycasting for the whole subtree (`08`) — so it fails here, with a sentence the repair pass can
 * act on.
 */
function requireFinite(
  value: unknown,
  name: string,
  options: { min?: number; max?: number } = {},
): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new GeometryError(
      `${name} must be a finite number, received ${typeof value === 'number' ? String(value) : typeof value}. Check for a division by zero or an undefined variable.`,
    );
  }
  if (options.min !== undefined && value < options.min) {
    throw new GeometryError(`${name} must be at least ${options.min}, received ${value}.`);
  }
  if (options.max !== undefined && value > options.max) {
    throw new GeometryError(`${name} must be at most ${options.max}, received ${value}.`);
  }
  return value;
}

/** Segment counts are clamped rather than rejected: a coarse shape still teaches, a refused build does not. */
const clampSegments = (value: unknown, fallback: number, max = 512): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(3, Math.min(max, Math.floor(value)));
};

function requireVec3(value: unknown, name: string): Vec3 {
  if (!Array.isArray(value) || value.length < 3) {
    throw new GeometryError(`${name} must be an array of three numbers, e.g. [0, 1, 0].`);
  }
  return [
    requireFinite(value[0], `${name}[0]`),
    requireFinite(value[1], `${name}[1]`),
    requireFinite(value[2], `${name}[2]`),
  ];
}

/**
 * Stable structural key for a builder call.
 *
 * `JSON.stringify` on a sorted key list rather than a hash: collisions in a cache key mean two different shapes
 * silently share one GPU object, which is a visually baffling failure. A slightly longer string is a cheap
 * price for exactness. Typed arrays are keyed by length plus a sampled digest, because hashing a 200k-vertex
 * buffer on every call would cost more than the cache saves.
 */
function structuralKey(builder: string, spec: unknown): string {
  const seen = new WeakSet<object>();

  const normalise = (value: unknown): unknown => {
    if (typeof value === 'number') {
      // Rounded to a fixed precision so floating-point noise in a computed argument does not defeat the cache.
      return Number.isFinite(value) ? Math.round(value * 1e6) / 1e6 : String(value);
    }
    if (typeof value === 'function') return '<fn>';
    if (value === null || typeof value !== 'object') return value;

    if (ArrayBuffer.isView(value)) {
      const view = value as unknown as ArrayLike<number> & { length: number };
      let digest = view.length;
      // Sample up to 32 evenly spaced elements: enough to distinguish real shapes, bounded regardless of size.
      const stride = Math.max(1, Math.floor(view.length / 32));
      for (let i = 0; i < view.length; i += stride) {
        digest = (digest * 31 + Math.round((view[i] as number) * 1e4)) | 0;
      }
      return `typed:${view.length}:${digest}`;
    }

    if (seen.has(value as object)) return '<cycle>';
    seen.add(value as object);

    if (Array.isArray(value)) return value.map(normalise);

    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    const out: Record<string, unknown> = {};
    for (const key of keys) out[key] = normalise(record[key]);
    return out;
  };

  return `${builder}:${JSON.stringify(normalise(spec))}`;
}

/**
 * The geometry factory.
 *
 * One instance per build, holding the cache and the running vertex total. Per-build rather than global so a
 * model swap releases everything — `02` R7 and `08`'s flat-memory requirement both depend on the cache dying
 * with the model that filled it.
 */
export class GeometryFactory {
  private readonly cache = new Map<string, GeometryRecord>();
  private readonly byHandle = new WeakMap<GeometryHandle, GeometryRecord>();
  private readonly profileData = new WeakMap<ProfileHandle, Profile>();
  private readonly pathData = new WeakMap<PathHandle, Path3>();

  /** Running total across every distinct geometry, checked against the sandbox ceiling. */
  private totalVertices = 0;
  /** Cache hits, surfaced as a stat because `08` requires the technique to show up in the numbers. */
  private hits = 0;
  private misses = 0;

  /** Warnings the build should report — clamped values, dropped triangles, repaired meshes. */
  readonly warnings: string[] = [];

  get stats(): { vertices: number; hits: number; misses: number; unique: number } {
    return {
      vertices: this.totalVertices,
      hits: this.hits,
      misses: this.misses,
      unique: this.cache.size,
    };
  }

  /** Resolve a handle back to its data. Host-side only. */
  resolve(handle: GeometryHandle): MeshData | undefined {
    return this.byHandle.get(handle)?.mesh;
  }

  resolveProfile(handle: ProfileHandle): Profile | undefined {
    return this.profileData.get(handle);
  }

  resolvePath(handle: PathHandle): Path3 | undefined {
    return this.pathData.get(handle);
  }

  /** Every distinct geometry produced, for the realizer to upload once each. */
  entries(): Iterable<GeometryRecord> {
    return this.cache.values();
  }

  dispose(): void {
    this.cache.clear();
    this.totalVertices = 0;
    this.hits = 0;
    this.misses = 0;
    this.warnings.length = 0;
  }

  /**
   * Register a built mesh, deduplicating by structural key.
   *
   * The one place a geometry enters the system, so measurement, validation and the vertex ceiling are enforced
   * exactly once rather than in thirty builders.
   */
  private register(
    builder: string,
    spec: unknown,
    build: () => MeshData,
    appliedModifiers: readonly string[] = [],
  ): GeometryHandle {
    const cacheKey = structuralKey(builder, spec);
    const cached = this.cache.get(cacheKey);
    if (cached) {
      this.hits += 1;
      return cached.handle;
    }

    this.misses += 1;
    const mesh = build();

    const vertices = vertexCount(mesh);
    const triangles = triangleCount(mesh);

    if (vertices === 0) {
      throw new GeometryError(
        `${builder} produced no vertices. Check that the profile has at least three points and the dimensions are non-zero.`,
      );
    }

    // The ceiling is per *build*, not per shape: a model reaching it has usually looped without bound, and the
    // instruction says so rather than merely refusing.
    if (this.totalVertices + vertices > SANDBOX_LIMITS.maxTotalVertices) {
      throw new GeometryError(
        `This model would generate more than ${SANDBOX_LIMITS.maxTotalVertices.toLocaleString()} vertices. Reduce segment counts, or use instancing for repeated parts instead of building each one.`,
      );
    }
    this.totalVertices += vertices;

    if (!mesh.normals) mesh.normals = computeNormals(mesh);

    const handle: GeometryHandle = Object.freeze({
      __brand: 'geometry' as const,
      builder,
      cacheKey,
      vertices,
      triangles,
      boundingRadius: boundingRadius(meshBounds(mesh)),
      modifiers: Object.freeze([...appliedModifiers]),
    });

    const record: GeometryRecord = { handle, mesh };
    this.cache.set(cacheKey, record);
    this.byHandle.set(handle, record);
    return handle;
  }

  /** Take the mesh behind a handle, or fail with a message naming the argument. */
  private meshOf(handle: unknown, argument: string): MeshData {
    const record = this.byHandle.get(handle as GeometryHandle);
    if (!record) {
      throw new GeometryError(
        `${argument} must be a geometry created by a geom.* function. Received ${typeof handle}.`,
      );
    }
    return record.mesh;
  }

  private profileOf(handle: unknown, argument: string): Profile {
    const data = this.profileData.get(handle as ProfileHandle);
    if (!data) {
      throw new GeometryError(
        `${argument} must be a profile created by a geom.* profile function.`,
      );
    }
    return data;
  }

  private pathOf(handle: unknown, argument: string): Path3 {
    const data = this.pathData.get(handle as PathHandle);
    if (!data) {
      throw new GeometryError(`${argument} must be a path created by geom.path().`);
    }
    return data;
  }

  private makeProfile(builder: string, spec: unknown, profile: Profile): ProfileHandle {
    const handle: ProfileHandle = Object.freeze({
      __brand: 'profile' as const,
      points: profile.points.length / 2,
      closed: profile.closed,
      cacheKey: structuralKey(builder, spec),
    });
    this.profileData.set(handle, profile);
    return handle;
  }

  private makePath(builder: string, spec: unknown, path: Path3): PathHandle {
    const handle: PathHandle = Object.freeze({
      __brand: 'path' as const,
      points: path.points.length / 3,
      closed: path.closed,
      cacheKey: structuralKey(builder, spec),
    });
    this.pathData.set(handle, path);
    return handle;
  }

  /**
   * Build the frozen facade guest code receives.
   *
   * Every method is an arrow function closing over `this`, so the guest cannot detach one and call it with a
   * different receiver. The object is frozen so it cannot be extended or have a method replaced — a guest that
   * monkey-patched `geom.box` would affect nothing else, but the confusion it could cause in its own model is
   * not worth allowing.
   */
  createFacade(): Readonly<Record<string, unknown>> {
    // Arrow functions throughout, so `this` is the factory lexically and no alias is needed. That also means a
    // guest cannot detach a method and call it with a different receiver.
    const facade = {
      // ── Raw mesh: the expressive escape hatch ─────────────────────────────
      /**
       * Build geometry from raw arrays.
       *
       * The mathematical ceiling: anything expressible as triangles is expressible here, and every other
       * builder is sugar over this one. `00-GOAL.md`'s "the ceiling is the API, not the schema" is this
       * function.
       */
      mesh: (spec: {
        positions: ArrayLike<number>;
        indices?: ArrayLike<number>;
        normals?: ArrayLike<number>;
        uvs?: ArrayLike<number>;
        colors?: ArrayLike<number>;
      }): GeometryHandle => {
        if (!spec || typeof spec !== 'object' || !spec.positions) {
          throw new GeometryError('geom.mesh needs { positions } as a flat array of xyz triples.');
        }
        const positionCount = spec.positions.length;
        if (positionCount < 9 || positionCount % 3 !== 0) {
          throw new GeometryError(
            `geom.mesh positions must be a multiple of 3 with at least one triangle; received ${positionCount} values.`,
          );
        }
        return this.register('mesh', spec, () => {
          const built: MeshData = {
            positions: Float32Array.from(spec.positions),
            ...(spec.indices ? { indices: Uint32Array.from(spec.indices) } : {}),
            ...(spec.normals ? { normals: Float32Array.from(spec.normals) } : {}),
            ...(spec.uvs ? { uvs: Float32Array.from(spec.uvs) } : {}),
            ...(spec.colors ? { colors: Float32Array.from(spec.colors) } : {}),
          };
          return built;
        });
      },

      // ── Primitives ────────────────────────────────────────────────────────
      box: (
        spec: { size: readonly [number, number, number] } | readonly [number, number, number],
      ) => {
        // Both spellings are accepted because both are natural to write, and a generator that guesses wrong
        // should not lose a whole build to it. `Array.isArray` does not narrow a readonly tuple, so the
        // discriminant is the presence of `size`.
        const size = Array.isArray(spec)
          ? (spec as readonly [number, number, number])
          : (spec as { size: readonly [number, number, number] }).size;
        const [w, h, d] = requireVec3(size, 'box size');
        return this.register('box', { w, h, d }, () => primitives.box(w, h, d));
      },

      sphere: (spec: { radius: number; segments?: number; rings?: number }) => {
        const radius = requireFinite(spec?.radius, 'sphere radius', { min: 1e-6 });
        const segments = clampSegments(spec?.segments, 32);
        const rings = clampSegments(spec?.rings, Math.max(3, Math.floor(segments / 2)));
        return this.register('sphere', { radius, segments, rings }, () =>
          primitives.sphere(radius, segments, rings),
        );
      },

      hemisphere: (spec: { radius: number; segments?: number }) => {
        const radius = requireFinite(spec?.radius, 'hemisphere radius', { min: 1e-6 });
        const segments = clampSegments(spec?.segments, 32);
        return this.register('hemisphere', { radius, segments }, () =>
          primitives.sphere(
            radius,
            segments,
            Math.max(3, Math.floor(segments / 4)),
            Math.PI * 2,
            Math.PI / 2,
          ),
        );
      },

      cylinder: (spec: {
        radius?: number;
        radiusTop?: number;
        radiusBottom?: number;
        height: number;
        segments?: number;
        open?: boolean;
      }) => {
        const height = requireFinite(spec?.height, 'cylinder height', { min: 1e-6 });
        const top = requireFinite(spec?.radiusTop ?? spec?.radius, 'cylinder radius', { min: 0 });
        const bottom = requireFinite(spec?.radiusBottom ?? spec?.radius, 'cylinder radius', {
          min: 0,
        });
        const segments = clampSegments(spec?.segments, 32);
        return this.register(
          'cylinder',
          { top, bottom, height, segments, open: !!spec?.open },
          () => primitives.cylinder(top, bottom, height, segments, !!spec?.open),
        );
      },

      cone: (spec: { radius: number; height: number; segments?: number }) => {
        const radius = requireFinite(spec?.radius, 'cone radius', { min: 1e-6 });
        const height = requireFinite(spec?.height, 'cone height', { min: 1e-6 });
        const segments = clampSegments(spec?.segments, 32);
        return this.register('cone', { radius, height, segments }, () =>
          primitives.cone(radius, height, segments),
        );
      },

      torus: (spec: { radius: number; tube: number; segments?: number; tubeSegments?: number }) => {
        const radius = requireFinite(spec?.radius, 'torus radius', { min: 1e-6 });
        const tube = requireFinite(spec?.tube, 'torus tube', { min: 1e-6 });
        const segments = clampSegments(spec?.segments, 32);
        const tubeSegments = clampSegments(spec?.tubeSegments, 16);
        return this.register('torus', { radius, tube, segments, tubeSegments }, () =>
          primitives.torus(radius, tube, segments, tubeSegments),
        );
      },

      capsule: (spec: { radius: number; height: number; segments?: number }) => {
        const radius = requireFinite(spec?.radius, 'capsule radius', { min: 1e-6 });
        const height = requireFinite(spec?.height, 'capsule height', { min: 0 });
        const segments = clampSegments(spec?.segments, 24);
        return this.register('capsule', { radius, height, segments }, () =>
          primitives.capsule(radius, height, segments),
        );
      },

      disc: (spec: { radius: number; innerRadius?: number; segments?: number }) => {
        const radius = requireFinite(spec?.radius, 'disc radius', { min: 1e-6 });
        const inner = requireFinite(spec?.innerRadius ?? 0, 'disc innerRadius', { min: 0 });
        const segments = clampSegments(spec?.segments, 32);
        return this.register('disc', { radius, inner, segments }, () =>
          primitives.disc(radius, inner, segments),
        );
      },

      plane: (spec: {
        width: number;
        depth: number;
        widthSegments?: number;
        depthSegments?: number;
      }) => {
        const width = requireFinite(spec?.width, 'plane width', { min: 1e-6 });
        const depth = requireFinite(spec?.depth, 'plane depth', { min: 1e-6 });
        const widthSegments = Math.max(1, Math.min(400, Math.floor(spec?.widthSegments ?? 1)));
        const depthSegments = Math.max(1, Math.min(400, Math.floor(spec?.depthSegments ?? 1)));
        return this.register('plane', { width, depth, widthSegments, depthSegments }, () =>
          primitives.plane(width, depth, widthSegments, depthSegments),
        );
      },

      prism: (spec: { sides: number; radius: number; height: number }) => {
        const sides = clampSegments(spec?.sides, 6, 64);
        const radius = requireFinite(spec?.radius, 'prism radius', { min: 1e-6 });
        const height = requireFinite(spec?.height, 'prism height', { min: 1e-6 });
        return this.register('prism', { sides, radius, height }, () =>
          primitives.prism(sides, radius, height),
        );
      },

      beam: (spec: { width: number; height: number; length: number }) => {
        const width = requireFinite(spec?.width, 'beam width', { min: 1e-6 });
        const height = requireFinite(spec?.height, 'beam height', { min: 1e-6 });
        const length = requireFinite(spec?.length, 'beam length', { min: 1e-6 });
        return this.register('beam', { width, height, length }, () =>
          primitives.beam(width, height, length),
        );
      },

      polyhedron: (spec: {
        kind: 'tetrahedron' | 'octahedron' | 'icosahedron' | 'cube';
        radius?: number;
      }) => {
        const kind = spec?.kind ?? 'icosahedron';
        const radius = requireFinite(spec?.radius ?? 1, 'polyhedron radius', { min: 1e-6 });
        return this.register('polyhedron', { kind, radius }, () =>
          primitives.polyhedron(kind, radius),
        );
      },

      /**
       * A gear with a true involute tooth profile.
       *
       * `01-MODELS.md` requires this precisely: trapezoid teeth "visibly slip and jerk the moment the gear
       * train turns, which is exactly when a learner is watching".
       */
      gear: (spec: {
        teeth: number;
        module: number;
        thickness: number;
        bore?: number;
        pressureAngle?: number;
      }) => {
        const teeth = Math.max(
          6,
          Math.min(200, Math.floor(requireFinite(spec?.teeth, 'gear teeth'))),
        );
        const module_ = requireFinite(spec?.module, 'gear module', { min: 1e-4 });
        const thickness = requireFinite(spec?.thickness, 'gear thickness', { min: 1e-4 });
        const bore = requireFinite(spec?.bore ?? 0, 'gear bore', { min: 0 });
        const pressureAngle = requireFinite(
          spec?.pressureAngle ?? 20 * (Math.PI / 180),
          'gear pressureAngle',
          { min: 0.1, max: 0.7 },
        );
        return this.register('gear', { teeth, module_, thickness, bore, pressureAngle }, () =>
          primitives.gear(teeth, module_, thickness, bore, pressureAngle),
        );
      },

      /**
       * A helical coil swept along its true path.
       *
       * `01`: "A spring must be a true helical sweep, not stacked cylinders — stacked cylinders cannot
       * compress; a spring the learner cannot compress is a picture of a spring."
       */
      helix: (spec: {
        radius: number;
        wireRadius: number;
        turns: number;
        pitch: number;
        segmentsPerTurn?: number;
        wireSegments?: number;
      }) => {
        const radius = requireFinite(spec?.radius, 'helix radius', { min: 1e-6 });
        const wireRadius = requireFinite(spec?.wireRadius, 'helix wireRadius', { min: 1e-6 });
        const turns = requireFinite(spec?.turns, 'helix turns', { min: 0.1, max: 200 });
        const pitch = requireFinite(spec?.pitch, 'helix pitch');
        const segmentsPerTurn = clampSegments(spec?.segmentsPerTurn, 24, 128);
        const wireSegments = clampSegments(spec?.wireSegments, 10, 64);
        return this.register(
          'helix',
          { radius, wireRadius, turns, pitch, segmentsPerTurn, wireSegments },
          () => primitives.helix(radius, wireRadius, turns, pitch, segmentsPerTurn, wireSegments),
        );
      },

      points: (spec: { positions: ArrayLike<number> }) => {
        if (!spec?.positions || spec.positions.length < 3) {
          throw new GeometryError('geom.points needs { positions } with at least one xyz triple.');
        }
        return this.register('points', spec, () =>
          primitives.points(Float32Array.from(spec.positions)),
        );
      },

      // ── Profiles ──────────────────────────────────────────────────────────
      profile: (points: ReadonlyArray<readonly [number, number]>, closed = true): ProfileHandle => {
        if (!Array.isArray(points) || points.length < 2) {
          throw new GeometryError('geom.profile needs at least two [x, y] points.');
        }
        return this.makeProfile('profile', { points, closed }, profiles.profile(points, closed));
      },

      rect: (spec: { width: number; height: number; centered?: boolean }) => {
        const width = requireFinite(spec?.width, 'rect width', { min: 1e-9 });
        const height = requireFinite(spec?.height, 'rect height', { min: 1e-9 });
        return this.makeProfile(
          'rect',
          { width, height, centered: spec?.centered ?? true },
          profiles.rect(width, height, spec?.centered ?? true),
        );
      },

      circleProfile: (spec: { radius: number; segments?: number }) => {
        const radius = requireFinite(spec?.radius, 'circle radius', { min: 1e-9 });
        const segments = clampSegments(spec?.segments, 32);
        return this.makeProfile(
          'circleProfile',
          { radius, segments },
          profiles.circle(radius, segments),
        );
      },

      ellipseProfile: (spec: { radiusX: number; radiusY: number; segments?: number }) => {
        const rx = requireFinite(spec?.radiusX, 'ellipse radiusX', { min: 1e-9 });
        const ry = requireFinite(spec?.radiusY, 'ellipse radiusY', { min: 1e-9 });
        const segments = clampSegments(spec?.segments, 32);
        return this.makeProfile(
          'ellipseProfile',
          { rx, ry, segments },
          profiles.ellipse(rx, ry, segments),
        );
      },

      polygonProfile: (spec: { sides: number; radius: number; flatBottom?: boolean }) => {
        const sides = clampSegments(spec?.sides, 6, 128);
        const radius = requireFinite(spec?.radius, 'polygon radius', { min: 1e-9 });
        return this.makeProfile(
          'polygonProfile',
          { sides, radius, flatBottom: !!spec?.flatBottom },
          profiles.polygon(sides, radius, !!spec?.flatBottom),
        );
      },

      arcProfile: (spec: { radius: number; start: number; end: number; segments?: number }) => {
        const radius = requireFinite(spec?.radius, 'arc radius', { min: 1e-9 });
        const start = requireFinite(spec?.start, 'arc start');
        const end = requireFinite(spec?.end, 'arc end');
        const segments = clampSegments(spec?.segments, 24, 256);
        return this.makeProfile(
          'arcProfile',
          { radius, start, end, segments },
          profiles.arc(radius, start, end, segments),
        );
      },

      /**
       * A cubic Bézier chain through control points.
       *
       * Positional, matching `profile`, `path` and `splinePath`: every curve constructor in this namespace takes
       * its points first. An API where half the curve builders take an object and half take an argument list is
       * a spelling a generator gets wrong, and each wrong guess costs a whole generation.
       */
      bezierProfile: (
        controls: ReadonlyArray<readonly [number, number]>,
        segmentsPerCurve = 16,
        closed = false,
      ) => {
        if (!Array.isArray(controls) || controls.length < 4) {
          throw new GeometryError(
            'geom.bezierProfile needs at least four control points, as geom.bezierProfile(points, segmentsPerCurve?, closed?).',
          );
        }
        const steps = clampSegments(segmentsPerCurve, 16, 128);
        return this.makeProfile(
          'bezierProfile',
          { controls, steps, closed },
          profiles.bezier(controls, steps, closed),
        );
      },

      /** A Catmull–Rom spline through the given points: interpolating, so it passes through each one. */
      splineProfile: (
        points: ReadonlyArray<readonly [number, number]>,
        segmentsPerSpan = 12,
        closed = false,
      ) => {
        if (!Array.isArray(points) || points.length < 3) {
          throw new GeometryError(
            'geom.splineProfile needs at least three points, as geom.splineProfile(points, segmentsPerSpan?, closed?).',
          );
        }
        const steps = clampSegments(segmentsPerSpan, 12, 64);
        return this.makeProfile(
          'splineProfile',
          { points, steps, closed },
          profiles.spline(points, steps, closed),
        );
      },

      /** A NACA 4-digit airfoil, so blades and wings have the section that makes their motion correct. */
      airfoilProfile: (spec: {
        chord: number;
        thickness?: number;
        camber?: number;
        camberPosition?: number;
        segments?: number;
      }) => {
        const chord = requireFinite(spec?.chord, 'airfoil chord', { min: 1e-6 });
        const thickness = requireFinite(spec?.thickness ?? 0.12, 'airfoil thickness', {
          min: 0.01,
          max: 0.5,
        });
        const camber = requireFinite(spec?.camber ?? 0.02, 'airfoil camber', { min: 0, max: 0.3 });
        const camberPosition = requireFinite(
          spec?.camberPosition ?? 0.4,
          'airfoil camberPosition',
          { min: 0.05, max: 0.95 },
        );
        const segments = clampSegments(spec?.segments, 40, 200);
        return this.makeProfile(
          'airfoilProfile',
          { chord, thickness, camber, camberPosition, segments },
          profiles.airfoil(chord, thickness, camber, camberPosition, segments),
        );
      },

      gearProfile: (spec: { teeth: number; module: number; pressureAngle?: number }) => {
        const teeth = Math.max(
          6,
          Math.min(200, Math.floor(requireFinite(spec?.teeth, 'gear teeth'))),
        );
        const module_ = requireFinite(spec?.module, 'gear module', { min: 1e-4 });
        const pressureAngle = requireFinite(
          spec?.pressureAngle ?? 20 * (Math.PI / 180),
          'gear pressureAngle',
          { min: 0.1, max: 0.7 },
        );
        return this.makeProfile(
          'gearProfile',
          { teeth, module_, pressureAngle },
          profiles.gearProfile(teeth, module_, pressureAngle),
        );
      },

      offsetProfile: (handle: ProfileHandle, distance: number) => {
        const source = this.profileOf(handle, 'offsetProfile source');
        const value = requireFinite(distance, 'offset distance');
        return this.makeProfile(
          'offsetProfile',
          { key: handle.cacheKey, value },
          profiles.offsetProfile(source, value),
        );
      },

      filletProfile: (handle: ProfileHandle, radius: number, segments?: number) => {
        const source = this.profileOf(handle, 'filletProfile source');
        const value = requireFinite(radius, 'fillet radius', { min: 0 });
        const steps = clampSegments(segments, 4, 32);
        return this.makeProfile(
          'filletProfile',
          { key: handle.cacheKey, value, steps },
          profiles.filletProfile(source, value, steps),
        );
      },

      /** Add inner loops so a flange's bolt holes triangulate once instead of becoming N booleans. */
      withHoles: (handle: ProfileHandle, holes: readonly ProfileHandle[]) => {
        const source = this.profileOf(handle, 'withHoles source');
        const resolved = holes.map((hole, index) =>
          this.profileOf(hole, `withHoles hole[${index}]`),
        );
        return this.makeProfile(
          'withHoles',
          { key: handle.cacheKey, holes: holes.map((h) => h.cacheKey) },
          profiles.withHoles(source, resolved),
        );
      },

      translateProfile: (handle: ProfileHandle, dx: number, dy: number) => {
        const source = this.profileOf(handle, 'translateProfile source');
        return this.makeProfile(
          'translateProfile',
          { key: handle.cacheKey, dx: requireFinite(dx, 'dx'), dy: requireFinite(dy, 'dy') },
          profiles.translateProfile(source, dx, dy),
        );
      },

      rotateProfile: (handle: ProfileHandle, angle: number) => {
        const source = this.profileOf(handle, 'rotateProfile source');
        return this.makeProfile(
          'rotateProfile',
          { key: handle.cacheKey, angle: requireFinite(angle, 'angle') },
          profiles.rotateProfile(source, angle),
        );
      },

      scaleProfile: (handle: ProfileHandle, sx: number, sy?: number) => {
        const source = this.profileOf(handle, 'scaleProfile source');
        const x = requireFinite(sx, 'sx');
        const y = requireFinite(sy ?? sx, 'sy');
        return this.makeProfile(
          'scaleProfile',
          { key: handle.cacheKey, x, y },
          profiles.scaleProfile(source, x, y),
        );
      },

      // ── Paths ─────────────────────────────────────────────────────────────
      path: (
        points: ReadonlyArray<readonly [number, number, number]>,
        closed = false,
      ): PathHandle => {
        if (!Array.isArray(points) || points.length < 2) {
          throw new GeometryError('geom.path needs at least two [x, y, z] points.');
        }
        const flat = new Float32Array(points.length * 3);
        points.forEach((point, index) => {
          flat[index * 3] = requireFinite(point[0], `path[${index}].x`);
          flat[index * 3 + 1] = requireFinite(point[1], `path[${index}].y`);
          flat[index * 3 + 2] = requireFinite(point[2], `path[${index}].z`);
        });
        return this.makePath('path', { points, closed }, { points: flat, closed });
      },

      /** A smooth path through control points — the common case for a routed pipe or a flow line. */
      splinePath: (
        points: ReadonlyArray<readonly [number, number, number]>,
        segmentsPerSpan = 12,
        closed = false,
      ): PathHandle => {
        if (!Array.isArray(points) || points.length < 3) {
          throw new GeometryError('geom.splinePath needs at least three points.');
        }
        const steps = clampSegments(segmentsPerSpan, 12, 64);
        const count = points.length;
        const at = (index: number): readonly [number, number, number] => {
          if (closed)
            return points[((index % count) + count) % count] as readonly [number, number, number];
          return points[Math.max(0, Math.min(count - 1, index))] as readonly [
            number,
            number,
            number,
          ];
        };

        const out: number[] = [];
        const spans = closed ? count : count - 1;
        for (let i = 0; i < spans; i += 1) {
          const p0 = at(i - 1);
          const p1 = at(i);
          const p2 = at(i + 1);
          const p3 = at(i + 2);
          for (let s = 0; s < steps; s += 1) {
            const t = s / steps;
            const t2 = t * t;
            const t3 = t2 * t;
            for (let axis = 0; axis < 3; axis += 1) {
              out.push(
                0.5 *
                  (2 * (p1[axis] as number) +
                    (-(p0[axis] as number) + (p2[axis] as number)) * t +
                    (2 * (p0[axis] as number) -
                      5 * (p1[axis] as number) +
                      4 * (p2[axis] as number) -
                      (p3[axis] as number)) *
                      t2 +
                    (-(p0[axis] as number) +
                      3 * (p1[axis] as number) -
                      3 * (p2[axis] as number) +
                      (p3[axis] as number)) *
                      t3),
              );
            }
          }
        }
        if (!closed) {
          const last = at(count - 1);
          out.push(last[0], last[1], last[2]);
        }

        return this.makePath(
          'splinePath',
          { points, steps, closed },
          { points: new Float32Array(out), closed },
        );
      },

      // ── Solid operators ───────────────────────────────────────────────────
      revolve: (spec: {
        profile: ProfileHandle;
        angle?: number;
        segments?: number;
        axis?: 'x' | 'y' | 'z';
        caps?: boolean;
      }) => {
        const source = this.profileOf(spec?.profile, 'revolve profile');
        const angle = requireFinite(spec?.angle ?? Math.PI * 2, 'revolve angle', { min: 1e-3 });
        const segments = clampSegments(spec?.segments, 48, 256);
        const axis = spec?.axis ?? 'y';
        return this.register(
          'revolve',
          { key: spec.profile.cacheKey, angle, segments, axis, caps: spec?.caps ?? true },
          () =>
            solids.revolve({ profile: source, angle, segments, axis, caps: spec?.caps ?? true }),
        );
      },

      extrude: (spec: {
        profile: ProfileHandle;
        depth: number;
        direction?: readonly [number, number, number];
        steps?: number;
        endScale?: number;
        twist?: number;
        caps?: boolean;
      }) => {
        const source = this.profileOf(spec?.profile, 'extrude profile');
        const depth = requireFinite(spec?.depth, 'extrude depth');
        const direction = spec?.direction
          ? requireVec3(spec.direction, 'extrude direction')
          : ([0, 0, 1] as Vec3);
        const steps = Math.max(1, Math.min(256, Math.floor(spec?.steps ?? 1)));
        const endScale = requireFinite(spec?.endScale ?? 1, 'extrude endScale', { min: 0 });
        const twist = requireFinite(spec?.twist ?? 0, 'extrude twist');
        return this.register(
          'extrude',
          {
            key: spec.profile.cacheKey,
            depth,
            direction,
            steps,
            endScale,
            twist,
            caps: spec?.caps ?? true,
          },
          () =>
            solids.extrude({
              profile: source,
              depth,
              direction,
              steps,
              endScale,
              twist,
              caps: spec?.caps ?? true,
            }),
        );
      },

      /**
       * Sweep a profile along a path — the operator that makes real machinery reachable.
       *
       * Exhaust manifolds, cable runs, turbine airfoils with spanwise twist, DNA backbones, track.
       */
      sweep: (spec: {
        profile: ProfileHandle;
        path: PathHandle;
        twist?: number;
        endScale?: number;
        caps?: boolean;
      }) => {
        const source = this.profileOf(spec?.profile, 'sweep profile');
        const path = this.pathOf(spec?.path, 'sweep path');
        const twist = requireFinite(spec?.twist ?? 0, 'sweep twist');
        const endScale = requireFinite(spec?.endScale ?? 1, 'sweep endScale', { min: 0 });
        return this.register(
          'sweep',
          {
            profileKey: spec.profile.cacheKey,
            pathKey: spec.path.cacheKey,
            twist,
            endScale,
            caps: spec?.caps ?? true,
          },
          () => solids.sweep({ profile: source, path, twist, endScale, caps: spec?.caps ?? true }),
        );
      },

      /** Loft through cross-sections — hulls, fuselages, transitions, anatomical forms. */
      loft: (spec: {
        sections: Array<{
          profile: ProfileHandle;
          position: readonly [number, number, number];
          rotation?: number;
          scale?: number;
        }>;
        smoothSteps?: number;
        caps?: boolean;
      }) => {
        if (!Array.isArray(spec?.sections) || spec.sections.length < 2) {
          throw new GeometryError('geom.loft needs at least two sections.');
        }
        const sections = spec.sections.map((section, index) => ({
          profile: this.profileOf(section.profile, `loft section[${index}].profile`),
          position: requireVec3(section.position, `loft section[${index}].position`),
          ...(section.rotation !== undefined
            ? { rotation: requireFinite(section.rotation, `loft section[${index}].rotation`) }
            : {}),
          ...(section.scale !== undefined
            ? { scale: requireFinite(section.scale, `loft section[${index}].scale`, { min: 0 }) }
            : {}),
        }));
        const smoothSteps = Math.max(1, Math.min(64, Math.floor(spec?.smoothSteps ?? 1)));
        return this.register(
          'loft',
          {
            sections: spec.sections.map((s) => ({
              key: s.profile.cacheKey,
              position: s.position,
              rotation: s.rotation,
              scale: s.scale,
            })),
            smoothSteps,
            caps: spec?.caps ?? true,
          },
          () => solids.loft({ sections, smoothSteps, caps: spec?.caps ?? true }),
        );
      },

      /** A tube along a path, hollow when `innerRadius` is set so a cutaway shows a real wall. */
      pipe: (spec: {
        path: PathHandle;
        radius: number;
        innerRadius?: number;
        segments?: number;
        caps?: boolean;
      }) => {
        const path = this.pathOf(spec?.path, 'pipe path');
        const radius = requireFinite(spec?.radius, 'pipe radius', { min: 1e-6 });
        const innerRadius = requireFinite(spec?.innerRadius ?? 0, 'pipe innerRadius', { min: 0 });
        if (innerRadius >= radius) {
          throw new GeometryError(
            `pipe innerRadius (${innerRadius}) must be smaller than radius (${radius}), or the wall has no thickness.`,
          );
        }
        const segments = clampSegments(spec?.segments, 24, 128);
        return this.register(
          'pipe',
          { pathKey: spec.path.cacheKey, radius, innerRadius, segments, caps: spec?.caps ?? true },
          () => solids.pipe({ path, radius, innerRadius, segments, caps: spec?.caps ?? true }),
        );
      },

      /** Fill an outline, optionally displaced by a height function — maps, graphs, terrain sections. */
      patch: (spec: {
        profile: ProfileHandle;
        heightAt?: (x: number, y: number) => number;
        plane?: 'xy' | 'xz' | 'yz';
      }) => {
        const source = this.profileOf(spec?.profile, 'patch profile');
        const plane = spec?.plane ?? 'xz';
        return this.register(
          'patch',
          { key: spec.profile.cacheKey, plane, hasHeight: typeof spec?.heightAt === 'function' },
          () =>
            solids.patch({
              profile: source,
              plane,
              ...(typeof spec?.heightAt === 'function' ? { heightAt: spec.heightAt } : {}),
            }),
        );
      },

      // ── Implicit and parametric surfaces ──────────────────────────────────
      /**
       * Polygonise a signed distance field.
       *
       * The path to shapes no operator reaches: blended junctions, metaball clouds, lattices, organic forms.
       * Guest code supplies the mathematics; the engine supplies marching cubes.
       */
      sdf: (spec: {
        field: (x: number, y: number, z: number) => number;
        bounds: { min: readonly [number, number, number]; max: readonly [number, number, number] };
        resolution?: number | readonly [number, number, number];
        isoLevel?: number;
      }) => {
        if (typeof spec?.field !== 'function') {
          throw new GeometryError('geom.sdf needs { field } as a function (x, y, z) => distance.');
        }
        if (!spec?.bounds?.min || !spec?.bounds?.max) {
          throw new GeometryError('geom.sdf needs { bounds: { min: [x,y,z], max: [x,y,z] } }.');
        }
        const min = requireVec3(spec.bounds.min, 'sdf bounds.min');
        const max = requireVec3(spec.bounds.max, 'sdf bounds.max');
        // Resolution is capped because cost is O(n³): 160³ is four million samples, each one a call into guest
        // code, and beyond that a build stops being interactive.
        const resolution = spec?.resolution ?? 48;
        // Closures make the result uncacheable by inspection, so the key includes an identity counter.
        return this.register(
          'sdf',
          { min, max, resolution, isoLevel: spec?.isoLevel ?? 0, fn: nextClosureId(spec.field) },
          () =>
            implicit.sdf({
              field: spec.field,
              bounds: { min, max },
              resolution,
              ...(spec?.isoLevel !== undefined ? { isoLevel: spec.isoLevel } : {}),
            }),
        );
      },

      /** Evaluate a parametric surface — waves, Möbius strips, harmonics, function plots. */
      parametric: (spec: {
        surface: (u: number, v: number) => readonly [number, number, number];
        segments?: number | readonly [number, number];
        closed?: { u?: boolean; v?: boolean };
      }) => {
        if (typeof spec?.surface !== 'function') {
          throw new GeometryError(
            'geom.parametric needs { surface } as a function (u, v) => [x, y, z], with u and v in 0..1.',
          );
        }
        return this.register(
          'parametric',
          {
            segments: spec?.segments ?? 32,
            closed: spec?.closed ?? {},
            fn: nextClosureId(spec.surface),
          },
          () =>
            implicit.parametric({
              surface: spec.surface,
              ...(spec?.segments !== undefined ? { segments: spec.segments } : {}),
              ...(spec?.closed ? { closed: spec.closed } : {}),
            }),
        );
      },

      /** A height field over a rectangle — terrain, potential surfaces, 2D function plots. */
      heightField: (spec: {
        width: number;
        depth: number;
        heightAt: (x: number, z: number) => number;
        segments?: number | readonly [number, number];
      }) => {
        if (typeof spec?.heightAt !== 'function') {
          throw new GeometryError('geom.heightField needs { heightAt } as a function (x, z) => y.');
        }
        const width = requireFinite(spec?.width, 'heightField width', { min: 1e-6 });
        const depth = requireFinite(spec?.depth, 'heightField depth', { min: 1e-6 });
        return this.register(
          'heightField',
          { width, depth, segments: spec?.segments ?? 64, fn: nextClosureId(spec.heightAt) },
          () => implicit.heightField(width, depth, spec.heightAt, spec?.segments ?? 64),
        );
      },

      /**
       * A travelling wave surface.
       *
       * `01` singles this out: a sinusoid that vibrates without its crest *travelling* teaches nothing about
       * propagation, so phase is a parameter the model binds to its clock.
       */
      waveSurface: (spec: {
        width: number;
        depth: number;
        amplitude: number;
        wavelength: number;
        phase?: number;
        segments?: number | readonly [number, number];
      }) => {
        const width = requireFinite(spec?.width, 'waveSurface width', { min: 1e-6 });
        const depth = requireFinite(spec?.depth, 'waveSurface depth', { min: 1e-6 });
        const amplitude = requireFinite(spec?.amplitude, 'waveSurface amplitude');
        const wavelength = requireFinite(spec?.wavelength, 'waveSurface wavelength', { min: 1e-6 });
        const phase = requireFinite(spec?.phase ?? 0, 'waveSurface phase');
        return this.register(
          'waveSurface',
          { width, depth, amplitude, wavelength, phase, segments: spec?.segments ?? 64 },
          () =>
            implicit.waveSurface(width, depth, amplitude, wavelength, phase, spec?.segments ?? 64),
        );
      },

      // ── SDF field constructors, for composing implicit shapes ──────────────
      // Exposed as plain functions returning closures: composing fields is arithmetic, so booleans and smooth
      // blends come free, and a smooth blend is what makes parts look moulded rather than glued.
      field: Object.freeze({
        sphere: (radius: number) =>
          implicit.sdSphere(requireFinite(radius, 'field.sphere radius', { min: 1e-9 })),
        box: (hx: number, hy: number, hz: number) =>
          implicit.sdBox(
            requireFinite(hx, 'field.box hx', { min: 0 }),
            requireFinite(hy, 'field.box hy', { min: 0 }),
            requireFinite(hz, 'field.box hz', { min: 0 }),
          ),
        cylinder: (radius: number, halfHeight: number, axis?: 'x' | 'y' | 'z') =>
          implicit.sdCylinder(
            requireFinite(radius, 'field.cylinder radius', { min: 1e-9 }),
            requireFinite(halfHeight, 'field.cylinder halfHeight', { min: 0 }),
            axis ?? 'y',
          ),
        torus: (major: number, minor: number) =>
          implicit.sdTorus(
            requireFinite(major, 'field.torus major', { min: 1e-9 }),
            requireFinite(minor, 'field.torus minor', { min: 1e-9 }),
          ),
        capsule: (radius: number, halfHeight: number) =>
          implicit.sdCapsule(
            requireFinite(radius, 'field.capsule radius', { min: 1e-9 }),
            requireFinite(halfHeight, 'field.capsule halfHeight', { min: 0 }),
          ),
        plane: (nx: number, ny: number, nz: number, offset?: number) =>
          implicit.sdPlane(nx, ny, nz, offset ?? 0),
        union: (...fields: implicit.Sdf[]) => implicit.sdUnion(...fields),
        intersect: (...fields: implicit.Sdf[]) => implicit.sdIntersect(...fields),
        subtract: (a: implicit.Sdf, b: implicit.Sdf) => implicit.sdSubtract(a, b),
        smoothUnion: (a: implicit.Sdf, b: implicit.Sdf, radius: number) =>
          implicit.sdSmoothUnion(a, b, requireFinite(radius, 'smoothUnion radius', { min: 1e-6 })),
        smoothSubtract: (a: implicit.Sdf, b: implicit.Sdf, radius: number) =>
          implicit.sdSmoothSubtract(
            a,
            b,
            requireFinite(radius, 'smoothSubtract radius', { min: 1e-6 }),
          ),
        offset: (field: implicit.Sdf, distance: number) =>
          implicit.sdOffset(field, requireFinite(distance, 'offset distance')),
        shell: (field: implicit.Sdf, thickness: number) =>
          implicit.sdShell(field, requireFinite(thickness, 'shell thickness', { min: 1e-6 })),
        translate: (field: implicit.Sdf, dx: number, dy: number, dz: number) =>
          implicit.sdTranslate(
            field,
            requireFinite(dx, 'dx'),
            requireFinite(dy, 'dy'),
            requireFinite(dz, 'dz'),
          ),
        repeat: (field: implicit.Sdf, px: number, py: number, pz: number) =>
          implicit.sdRepeat(field, px, py, pz),
        metaballs: (
          centres: ReadonlyArray<readonly [number, number, number, number]>,
          blend?: number,
        ) => implicit.sdMetaballs(centres, blend ?? 0.5),
        gyroid: (scale?: number, thickness?: number) =>
          implicit.sdGyroid(scale ?? 1, thickness ?? 0.1),
      }),

      // ── Modifiers ─────────────────────────────────────────────────────────
      twist: (handle: GeometryHandle, radians: number, axis?: 'x' | 'y' | 'z') =>
        this.applyModifier(
          'twist',
          handle,
          { radians: requireFinite(radians, 'twist radians'), axis },
          (mesh) => modifiers.twist(mesh, radians, axis ?? 'y'),
        ),

      bend: (
        handle: GeometryHandle,
        radians: number,
        axis?: 'x' | 'y' | 'z',
        around?: 'x' | 'y' | 'z',
      ) =>
        this.applyModifier(
          'bend',
          handle,
          { radians: requireFinite(radians, 'bend radians'), axis, around },
          (mesh) => modifiers.bend(mesh, radians, axis ?? 'y', around ?? 'z'),
        ),

      taper: (handle: GeometryHandle, endScale: number, axis?: 'x' | 'y' | 'z') =>
        this.applyModifier(
          'taper',
          handle,
          { endScale: requireFinite(endScale, 'taper endScale', { min: 0 }), axis },
          (mesh) => modifiers.taper(mesh, endScale, axis ?? 'y'),
        ),

      displace: (handle: GeometryHandle, amplitude: number, frequency?: number, octaves?: number) =>
        this.applyModifier(
          'displace',
          handle,
          {
            amplitude: requireFinite(amplitude, 'displace amplitude'),
            frequency: requireFinite(frequency ?? 1, 'displace frequency', { min: 1e-6 }),
            octaves: Math.max(1, Math.min(8, Math.floor(octaves ?? 4))),
          },
          (mesh) => modifiers.displace(mesh, amplitude, frequency ?? 1, octaves ?? 4),
        ),

      weld: (handle: GeometryHandle, tolerance?: number) =>
        this.applyModifier('weld', handle, { tolerance: tolerance ?? 1e-5 }, (mesh) =>
          modifiers.weld(mesh, tolerance ?? 1e-5),
        ),

      subdivide: (handle: GeometryHandle, levels?: number) =>
        this.applyModifier(
          'subdivide',
          handle,
          { levels: Math.max(0, Math.min(3, Math.floor(levels ?? 1))) },
          (mesh) => modifiers.subdivide(mesh, levels ?? 1),
        ),

      smooth: (handle: GeometryHandle, iterations?: number, strength?: number) =>
        this.applyModifier(
          'smooth',
          handle,
          {
            iterations: Math.max(0, Math.min(8, Math.floor(iterations ?? 1))),
            strength: requireFinite(strength ?? 0.5, 'smooth strength', { min: 0, max: 1 }),
          },
          (mesh) => modifiers.smooth(mesh, iterations ?? 1, strength ?? 0.5),
        ),

      simplify: (handle: GeometryHandle, gridSize: number) =>
        this.applyModifier(
          'simplify',
          handle,
          { gridSize: requireFinite(gridSize, 'simplify gridSize', { min: 1e-6 }) },
          (mesh) => modifiers.simplify(mesh, gridSize),
        ),

      mirror: (handle: GeometryHandle, axis: 'x' | 'y' | 'z', keepOriginal?: boolean) =>
        this.applyModifier('mirror', handle, { axis, keepOriginal: keepOriginal ?? true }, (mesh) =>
          modifiers.mirror(mesh, axis, keepOriginal ?? true),
        ),

      shell: (handle: GeometryHandle, thickness: number) =>
        this.applyModifier(
          'shell',
          handle,
          { thickness: requireFinite(thickness, 'shell thickness', { min: 1e-6 }) },
          (mesh) => modifiers.shell(mesh, thickness),
        ),

      bevel: (handle: GeometryHandle, amount?: number) =>
        this.applyModifier('bevel', handle, { amount: amount ?? 0.5 }, (mesh) =>
          modifiers.bevel(mesh, amount ?? 0.5),
        ),

      facet: (handle: GeometryHandle) =>
        this.applyModifier('facet', handle, {}, (mesh) => modifiers.facet(mesh)),

      /** Cut with a plane — the cutaway `01` requires when the lesson is inside something. */
      clip: (handle: GeometryHandle, normal: readonly [number, number, number], offset?: number) =>
        this.applyModifier(
          'clip',
          handle,
          {
            normal: requireVec3(normal, 'clip normal'),
            offset: requireFinite(offset ?? 0, 'clip offset'),
          },
          (mesh) => modifiers.clip(mesh, normal, offset ?? 0),
        ),

      ripple: (
        handle: GeometryHandle,
        amplitude: number,
        wavelength: number,
        phase?: number,
        axis?: 'x' | 'y' | 'z',
      ) =>
        this.applyModifier(
          'ripple',
          handle,
          {
            amplitude: requireFinite(amplitude, 'ripple amplitude'),
            wavelength: requireFinite(wavelength, 'ripple wavelength', { min: 1e-6 }),
            phase: requireFinite(phase ?? 0, 'ripple phase'),
            axis,
          },
          (mesh) => modifiers.ripple(mesh, amplitude, wavelength, phase ?? 0, axis ?? 'y'),
        ),

      transform: (
        handle: GeometryHandle,
        options: {
          translate?: readonly [number, number, number];
          scale?: readonly [number, number, number] | number;
          rotate?: readonly [number, number, number];
        },
      ) =>
        this.applyModifier('transform', handle, options ?? {}, (mesh) =>
          modifiers.transform(mesh, options ?? {}),
        ),

      /** Per-vertex colour from a scalar field — a heat map, a stress plot, a potential. */
      colorByField: (
        handle: GeometryHandle,
        field: (x: number, y: number, z: number) => number,
        ramp: (t: number) => readonly [number, number, number],
      ) => {
        if (typeof field !== 'function' || typeof ramp !== 'function') {
          throw new GeometryError('geom.colorByField needs a field function and a ramp function.');
        }
        return this.applyModifier(
          'colorByField',
          handle,
          { fn: nextClosureId(field), ramp: nextClosureId(ramp) },
          (mesh) => modifiers.colorByField(mesh, field, ramp),
        );
      },

      morph: (a: GeometryHandle, b: GeometryHandle, t: number) => {
        const meshA = this.meshOf(a, 'morph a');
        const meshB = this.meshOf(b, 'morph b');
        const factor = requireFinite(t, 'morph t', { min: 0, max: 1 });
        return this.register('morph', { a: a.cacheKey, b: b.cacheKey, factor }, () =>
          modifiers.morph(meshA, meshB, factor),
        );
      },

      /** Merge several geometries into one buffer, each preserved as a named region. */
      merge: (parts: ReadonlyArray<{ name: string; geometry: GeometryHandle }>) => {
        if (!Array.isArray(parts) || parts.length === 0) {
          throw new GeometryError('geom.merge needs at least one { name, geometry } entry.');
        }
        const resolved = parts.map((part, index) => ({
          name: String(part?.name ?? `part${index}`),
          mesh: this.meshOf(part?.geometry, `merge[${index}].geometry`),
        }));
        return this.register(
          'merge',
          { keys: parts.map((p) => p.geometry.cacheKey), names: parts.map((p) => p.name) },
          () => mergeMeshes(resolved),
        );
      },

      // ── Boolean operations via implicit re-meshing ────────────────────────
      /**
       * Boolean CSG.
       *
       * Implemented by re-meshing rather than by BSP surgery: the inputs are arbitrary AI-generated meshes, and
       * a BSP boolean on a non-manifold input fails in ways that are impossible to explain to a generator.
       * Re-meshing always produces *something* closed, which is the honest trade for a teaching model. `blend`
       * turns a hard boolean into a filleted one, which is usually what a real part looks like.
       */
      boolean: (spec: {
        op: 'union' | 'subtract' | 'intersect';
        a: GeometryHandle;
        b: GeometryHandle;
        resolution?: number;
        blend?: number;
      }) => {
        const meshA = this.meshOf(spec?.a, 'boolean a');
        const meshB = this.meshOf(spec?.b, 'boolean b');
        const op = spec?.op ?? 'union';
        const resolution = Math.max(16, Math.min(128, Math.floor(spec?.resolution ?? 56)));
        const blend = requireFinite(spec?.blend ?? 0, 'boolean blend', { min: 0 });

        return this.register(
          'boolean',
          { op, a: spec.a.cacheKey, b: spec.b.cacheKey, resolution, blend },
          () => {
            const fieldA = meshToField(meshA);
            const fieldB = meshToField(meshB);
            const combined =
              op === 'union'
                ? blend > 0
                  ? implicit.sdSmoothUnion(fieldA, fieldB, blend)
                  : implicit.sdUnion(fieldA, fieldB)
                : op === 'subtract'
                  ? blend > 0
                    ? implicit.sdSmoothSubtract(fieldA, fieldB, blend)
                    : implicit.sdSubtract(fieldA, fieldB)
                  : implicit.sdIntersect(fieldA, fieldB);

            const boundsA = meshBounds(meshA);
            const boundsB = meshBounds(meshB);
            // The sampling volume must contain the result. Union and intersect are bounded by both inputs;
            // subtract is bounded by `a` alone, which keeps resolution where it matters.
            const min: Vec3 =
              op === 'subtract'
                ? [boundsA.minX, boundsA.minY, boundsA.minZ]
                : [
                    Math.min(boundsA.minX, boundsB.minX),
                    Math.min(boundsA.minY, boundsB.minY),
                    Math.min(boundsA.minZ, boundsB.minZ),
                  ];
            const max: Vec3 =
              op === 'subtract'
                ? [boundsA.maxX, boundsA.maxY, boundsA.maxZ]
                : [
                    Math.max(boundsA.maxX, boundsB.maxX),
                    Math.max(boundsA.maxY, boundsB.maxY),
                    Math.max(boundsA.maxZ, boundsB.maxZ),
                  ];

            // Pad so the surface is never clipped by the sampling boundary.
            const pad = 0.05 * Math.max(max[0] - min[0], max[1] - min[1], max[2] - min[2], 1e-3);
            return implicit.sdf({
              field: combined,
              bounds: {
                min: [min[0] - pad, min[1] - pad, min[2] - pad],
                max: [max[0] + pad, max[1] + pad, max[2] + pad],
              },
              resolution,
            });
          },
        );
      },

      // ── Pattern helpers ───────────────────────────────────────────────────
      // Return placement lists, not meshes: a placement list feeds an instanced set, which `08` prices as one
      // draw call regardless of count. This is the mechanism that makes 300-part ambition affordable.
      pattern: Object.freeze({
        linear: patterns.linear,
        radial: patterns.radial,
        grid: patterns.grid,
        alongPath: (
          pathHandle: PathHandle,
          count: number,
          options?: Parameters<typeof patterns.alongPath>[2],
        ) =>
          patterns.alongPath(
            this.pathOf(pathHandle, 'pattern.alongPath path'),
            count,
            options ?? {},
          ),
        spiral: patterns.spiral,
        onSphere: patterns.onSphere,
        helical: patterns.helical,
        scatter: patterns.scatter,
        mirror: patterns.mirrorPlacements,
        offset: patterns.offsetPlacements,
      }),
    };

    return Object.freeze(facade);
  }

  /** Apply a modifier, recording it in the handle's chain so the manifest shows the derivation. */
  private applyModifier(
    name: string,
    handle: GeometryHandle,
    spec: unknown,
    apply: (mesh: MeshData) => MeshData,
  ): GeometryHandle {
    const mesh = this.meshOf(handle, `${name} source`);
    return this.register(
      name,
      { source: handle.cacheKey, ...(spec as object) },
      () => apply(mesh),
      [...handle.modifiers, name],
    );
  }
}

/**
 * Identity counter for closures.
 *
 * A closure's behaviour cannot be inspected, so two calls passing different functions must not share a cache
 * entry. A `WeakMap`-backed counter gives each function a stable identity: the same function reused across
 * calls still hits the cache, while a different one always misses. `08` notes this exact case —
 * "expression-driven variants are uncacheable *by design*".
 */
const closureIds = new WeakMap<object, number>();
let nextClosureCounter = 0;
function nextClosureId(fn: object): number {
  const existing = closureIds.get(fn);
  if (existing !== undefined) return existing;
  nextClosureCounter += 1;
  closureIds.set(fn, nextClosureCounter);
  return nextClosureCounter;
}

/**
 * Convert a mesh into an approximate signed distance field for boolean operations.
 *
 * Approximate by construction: it measures distance to the nearest *vertex* and infers inside/outside from the
 * nearest vertex normal. That is far cheaper than exact triangle-distance with ray-crossing parity, and on the
 * reasonably dense meshes this engine produces it is visually correct. The limitation is stated rather than
 * hidden — a very coarse input booleans imprecisely, and the fix is to subdivide before the boolean.
 */
function meshToField(mesh: MeshData): implicit.Sdf {
  const positions = mesh.positions;
  const normals = mesh.normals ?? computeNormals(mesh);
  const count = positions.length / 3;

  return (x: number, y: number, z: number): number => {
    let bestDistanceSquared = Number.POSITIVE_INFINITY;
    let bestIndex = 0;

    for (let i = 0; i < count; i += 1) {
      const dx = x - (positions[i * 3] as number);
      const dy = y - (positions[i * 3 + 1] as number);
      const dz = z - (positions[i * 3 + 2] as number);
      const distanceSquared = dx * dx + dy * dy + dz * dz;
      if (distanceSquared < bestDistanceSquared) {
        bestDistanceSquared = distanceSquared;
        bestIndex = i;
      }
    }

    const dx = x - (positions[bestIndex * 3] as number);
    const dy = y - (positions[bestIndex * 3 + 1] as number);
    const dz = z - (positions[bestIndex * 3 + 2] as number);
    const distance = Math.sqrt(bestDistanceSquared);
    // Sign from the dot product with the nearest vertex normal: positive means the sample is on the outward
    // side of the surface there.
    const side =
      dx * (normals[bestIndex * 3] as number) +
      dy * (normals[bestIndex * 3 + 1] as number) +
      dz * (normals[bestIndex * 3 + 2] as number);
    return side >= 0 ? distance : -distance;
  };
}
