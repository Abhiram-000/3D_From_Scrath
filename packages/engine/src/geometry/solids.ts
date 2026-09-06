/**
 * The solid operators: `revolve`, `extrude`, `sweep`, `loft`, `pipe`, `patch`.
 *
 * These six functions plus the profile algebra are how the platform reaches arbitrary engineered shapes
 * without a shape catalog. `PLAN.md` §A3: "This is how real CAD shapes are made, and it composes without
 * limit." A bolt is a profile revolved; a turbine blade is an airfoil swept with a twist law; a manifold is
 * a circle piped along a path; a hull is a loft through sections. None of those needed to be anticipated.
 *
 * Every function returns `MeshData` — plain triangles with measured counts — so the results compose with
 * the modifier pipeline and price correctly against a device budget (`08`).
 */
import {
  type MeshData,
  type Path3,
  type Profile,
  computeNormals,
  profilePointCount,
} from './mesh-data.ts';
import { triangulateProfile } from './triangulate.ts';
import { ensureCcw } from './profiles.ts';
import { TAU, clamp, cross, dot, lerp, normalize, type Vec3 } from '../math/index.ts';

/**
 * Weld a side wall to its caps.
 *
 * Caps are appended as separate vertices rather than reusing the wall's, because a cap and a wall meet at a
 * hard edge: sharing vertices would average their normals and produce a rounded-looking seam on what should
 * be a crisp machined lip.
 */
interface Accumulator {
  positions: number[];
  indices: number[];
  uvs: number[];
  groups: Array<{ name: string; start: number; count: number }>;
}

const accumulator = (): Accumulator => ({ positions: [], indices: [], uvs: [], groups: [] });

const beginGroup = (acc: Accumulator, name: string): number => {
  acc.groups.push({ name, start: acc.indices.length, count: 0 });
  return acc.groups.length - 1;
};

const endGroup = (acc: Accumulator, handle: number): void => {
  const group = acc.groups[handle];
  if (group) group.count = acc.indices.length - group.start;
};

const finish = (acc: Accumulator): MeshData => {
  const mesh: MeshData = {
    positions: new Float32Array(acc.positions),
    indices: new Uint32Array(acc.indices),
    uvs: new Float32Array(acc.uvs),
    groups: acc.groups.filter((group) => group.count > 0),
  };
  mesh.normals = computeNormals(mesh);
  return mesh;
};

/**
 * Add a triangulated cap from a profile, transformed into place.
 *
 * `flip` reverses winding for the far cap: both caps come from the same triangulation, but they face
 * opposite directions, and a cap facing inward is invisible from outside.
 */
function addCap(
  acc: Accumulator,
  source: Profile,
  place: (x: number, y: number) => Vec3,
  flip: boolean,
): void {
  const { points, indices } = triangulateProfile(source);
  const base = acc.positions.length / 3;

  for (let i = 0; i < points.length; i += 2) {
    const [px, py, pz] = place(points[i] as number, points[i + 1] as number);
    acc.positions.push(px, py, pz);
    acc.uvs.push((points[i] as number) * 0.5 + 0.5, (points[i + 1] as number) * 0.5 + 0.5);
  }

  for (let i = 0; i + 2 < indices.length; i += 3) {
    const a = base + (indices[i] as number);
    const b = base + (indices[i + 1] as number);
    const c = base + (indices[i + 2] as number);
    if (flip) acc.indices.push(a, c, b);
    else acc.indices.push(a, b, c);
  }
}

/**
 * Stitch two consecutive rings of equal length into a quad strip.
 *
 * The single most reused primitive in this file: revolve, extrude, sweep, loft and pipe all reduce to
 * "generate rings, then stitch". Keeping it in one function means a winding bug is fixed once.
 */
function stitchRings(
  acc: Accumulator,
  ringA: number,
  ringB: number,
  countPerRing: number,
  closed: boolean,
): void {
  const spans = closed ? countPerRing : countPerRing - 1;
  for (let i = 0; i < spans; i += 1) {
    const next = (i + 1) % countPerRing;
    const a = ringA + i;
    const b = ringA + next;
    const c = ringB + next;
    const d = ringB + i;
    acc.indices.push(a, b, c, a, c, d);
  }
}

export interface RevolveOptions {
  profile: Profile;
  /** Radians swept. `TAU` is a full solid of revolution; less leaves an open sector with caps. */
  angle?: number;
  segments?: number;
  /** Rotation axis. Y is the lathe convention: profile x becomes radius, profile y becomes height. */
  axis?: 'x' | 'y' | 'z';
  /** Cap the open ends when the sweep is partial. */
  caps?: boolean;
}

/**
 * Revolve a profile around an axis — the lathe operation.
 *
 * Bottles, bolts, nozzles, wine glasses, bearing races, planetary shells, a rocket's nose cone. Partial
 * angles produce cutaways, which `01` requires as a teaching device: "Where the lesson is *inside*
 * something, plan the view path at design time: transparent shell, cutaway, section, or explode."
 */
export function revolve(options: RevolveOptions): MeshData {
  const source = options.profile;
  const angle = options.angle ?? TAU;
  const segments = Math.max(3, Math.floor(options.segments ?? 48));
  const axis = options.axis ?? 'y';
  const full = Math.abs(angle - TAU) < 1e-6;
  const pointCount = profilePointCount(source);

  const acc = accumulator();
  const wall = beginGroup(acc, 'surface');

  const rings = full ? segments : segments + 1;
  const place = (px: number, py: number, theta: number): Vec3 => {
    const cos = Math.cos(theta);
    const sin = Math.sin(theta);
    if (axis === 'y') return [px * cos, py, px * sin];
    if (axis === 'x') return [py, px * cos, px * sin];
    return [px * cos, px * sin, py];
  };

  for (let r = 0; r < rings; r += 1) {
    const theta = (r / segments) * angle;
    for (let p = 0; p < pointCount; p += 1) {
      const px = source.points[p * 2] as number;
      const py = source.points[p * 2 + 1] as number;
      const [x, y, z] = place(px, py, theta);
      acc.positions.push(x, y, z);
      acc.uvs.push(r / Math.max(1, rings - 1), p / Math.max(1, pointCount - 1));
    }
  }

  for (let r = 0; r < (full ? rings : rings - 1); r += 1) {
    const ringA = r * pointCount;
    const ringB = ((r + 1) % rings) * pointCount;
    stitchRings(acc, ringA, ringB, pointCount, source.closed);
  }
  endGroup(acc, wall);

  // Caps only for a partial revolution: a full solid of revolution has no open end to close.
  if (!full && (options.caps ?? true)) {
    const startCap = beginGroup(acc, 'startCap');
    addCap(acc, ensureCcw(source), (x, y) => place(x, y, 0), false);
    endGroup(acc, startCap);

    const endCap = beginGroup(acc, 'endCap');
    addCap(acc, ensureCcw(source), (x, y) => place(x, y, angle), true);
    endGroup(acc, endCap);
  }

  return finish(acc);
}

export interface ExtrudeOptions {
  profile: Profile;
  /** Extrusion depth along the direction, metres. */
  depth: number;
  /** Direction to extrude along. Defaults to +Z, so a profile in XY becomes a prism facing the viewer. */
  direction?: Vec3;
  /** Intermediate rings; more than one lets a taper or twist vary smoothly along the length. */
  steps?: number;
  /** Scale applied at the far end, producing a taper (draft angle). */
  endScale?: number;
  /** Radians of twist applied across the length. */
  twist?: number;
  caps?: boolean;
}

/**
 * Extrude a profile along a direction, with optional taper and twist.
 *
 * The taper and twist parameters are the reason this is one operator rather than three: a draft-angled cast
 * part, a twisted structural column and a plain prism differ only by two numbers, and forcing a model
 * author to compose separate calls would make the common case verbose.
 */
export function extrude(options: ExtrudeOptions): MeshData {
  const source = options.profile;
  const steps = Math.max(1, Math.floor(options.steps ?? 1));
  const direction = normalize(options.direction ?? [0, 0, 1]);
  const endScale = options.endScale ?? 1;
  const twist = options.twist ?? 0;
  const pointCount = profilePointCount(source);

  const acc = accumulator();
  const wall = beginGroup(acc, 'surface');

  // A local frame so the profile's XY plane is perpendicular to the extrusion direction. Without it a
  // non-axis direction would shear the profile instead of translating it.
  let reference: Vec3 = [0, 1, 0];
  if (Math.abs(dot(direction, reference)) > 0.999) reference = [1, 0, 0];
  const right = normalize(cross(reference, direction));
  const up = cross(direction, right);

  const place = (px: number, py: number, t: number): Vec3 => {
    const scale = lerp(1, endScale, t);
    const angle = twist * t;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const rx = (px * cos - py * sin) * scale;
    const ry = (px * sin + py * cos) * scale;
    const offset = options.depth * t;
    return [
      right[0] * rx + up[0] * ry + direction[0] * offset,
      right[1] * rx + up[1] * ry + direction[1] * offset,
      right[2] * rx + up[2] * ry + direction[2] * offset,
    ];
  };

  for (let s = 0; s <= steps; s += 1) {
    const t = s / steps;
    for (let p = 0; p < pointCount; p += 1) {
      const [x, y, z] = place(
        source.points[p * 2] as number,
        source.points[p * 2 + 1] as number,
        t,
      );
      acc.positions.push(x, y, z);
      acc.uvs.push(t, p / Math.max(1, pointCount - 1));
    }
  }

  for (let s = 0; s < steps; s += 1) {
    stitchRings(acc, s * pointCount, (s + 1) * pointCount, pointCount, source.closed);
  }
  endGroup(acc, wall);

  if (source.closed && (options.caps ?? true)) {
    const startCap = beginGroup(acc, 'startCap');
    addCap(acc, ensureCcw(source), (x, y) => place(x, y, 0), true);
    endGroup(acc, startCap);

    const endCap = beginGroup(acc, 'endCap');
    addCap(acc, ensureCcw(source), (x, y) => place(x, y, 1), false);
    endGroup(acc, endCap);
  }

  return finish(acc);
}

/**
 * Compute parallel-transport frames along a path.
 *
 * The reason this is its own function: the naive approach — deriving each frame independently from the
 * tangent and a fixed up vector — produces a visible twist flip wherever the curve passes through vertical,
 * which is exactly what a pipe bending over the top of a machine does. Parallel transport carries the
 * previous frame forward and rotates it minimally, so the sweep stays untwisted.
 */
function pathFrames(path: Path3): Array<{ position: Vec3; tangent: Vec3; right: Vec3; up: Vec3 }> {
  const count = path.points.length / 3;
  const frames: Array<{ position: Vec3; tangent: Vec3; right: Vec3; up: Vec3 }> = [];

  const pointAt = (index: number): Vec3 => {
    const i = path.closed ? ((index % count) + count) % count : clamp(index, 0, count - 1);
    return [
      path.points[i * 3] as number,
      path.points[i * 3 + 1] as number,
      path.points[i * 3 + 2] as number,
    ];
  };

  let previousUp: Vec3 = [0, 1, 0];

  for (let i = 0; i < count; i += 1) {
    const position = pointAt(i);
    const ahead = pointAt(i + 1);
    const behind = pointAt(i - 1);

    // Central difference for interior points: a one-sided tangent produces a visible kink at each joint.
    let tangent = normalize([ahead[0] - behind[0], ahead[1] - behind[1], ahead[2] - behind[2]]);
    if (tangent[0] === 0 && tangent[1] === 0 && tangent[2] === 0) tangent = [0, 0, 1];

    // Authored ups win: a model that knows its pipe should keep a flange horizontal says so.
    if (path.ups) {
      previousUp = [
        path.ups[i * 3] as number,
        path.ups[i * 3 + 1] as number,
        path.ups[i * 3 + 2] as number,
      ];
    }

    let right = cross(previousUp, tangent);
    if (Math.hypot(right[0], right[1], right[2]) < 1e-6) {
      // Up became parallel to the tangent. Pick any perpendicular rather than emit NaN vertices.
      const alternate: Vec3 = Math.abs(tangent[1]) > 0.9 ? [1, 0, 0] : [0, 1, 0];
      right = cross(alternate, tangent);
    }
    right = normalize(right);
    const up = cross(tangent, right);

    frames.push({ position, tangent, right, up });
    previousUp = up;
  }

  return frames;
}

export interface SweepOptions {
  profile: Profile;
  path: Path3;
  /** Twist in radians applied linearly along the path — a turbine blade's spanwise twist. */
  twist?: number;
  /** Profile scale at the far end, for a tapering sweep. */
  endScale?: number;
  /** Per-station scale law, evaluated with t in [0, 1]. Overrides `endScale` when present. */
  scaleAt?: (t: number) => number;
  caps?: boolean;
}

/**
 * Sweep a profile along a 3D path.
 *
 * The most expressive operator in the file, and the one that makes real machinery reachable: exhaust
 * manifolds, cable runs, turbine airfoils, DNA backbones, roller-coaster track, intestines. A scale law
 * makes it a general lofted sweep rather than a constant-section tube.
 */
export function sweep(options: SweepOptions): MeshData {
  const source = options.profile;
  const frames = pathFrames(options.path);
  if (frames.length < 2) return { positions: new Float32Array(0) };

  const pointCount = profilePointCount(source);
  const twist = options.twist ?? 0;
  const scaleAt = options.scaleAt ?? ((t: number) => lerp(1, options.endScale ?? 1, t));

  const acc = accumulator();
  const wall = beginGroup(acc, 'surface');

  const place = (px: number, py: number, index: number): Vec3 => {
    const frame = frames[index] as (typeof frames)[number];
    const t = index / Math.max(1, frames.length - 1);
    const scale = scaleAt(t);
    const angle = twist * t;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const rx = (px * cos - py * sin) * scale;
    const ry = (px * sin + py * cos) * scale;
    return [
      frame.position[0] + frame.right[0] * rx + frame.up[0] * ry,
      frame.position[1] + frame.right[1] * rx + frame.up[1] * ry,
      frame.position[2] + frame.right[2] * rx + frame.up[2] * ry,
    ];
  };

  for (let f = 0; f < frames.length; f += 1) {
    for (let p = 0; p < pointCount; p += 1) {
      const [x, y, z] = place(
        source.points[p * 2] as number,
        source.points[p * 2 + 1] as number,
        f,
      );
      acc.positions.push(x, y, z);
      acc.uvs.push(f / Math.max(1, frames.length - 1), p / Math.max(1, pointCount - 1));
    }
  }

  const spans = options.path.closed ? frames.length : frames.length - 1;
  for (let f = 0; f < spans; f += 1) {
    const next = (f + 1) % frames.length;
    stitchRings(acc, f * pointCount, next * pointCount, pointCount, source.closed);
  }
  endGroup(acc, wall);

  if (source.closed && !options.path.closed && (options.caps ?? true)) {
    const startCap = beginGroup(acc, 'startCap');
    addCap(acc, ensureCcw(source), (x, y) => place(x, y, 0), true);
    endGroup(acc, startCap);

    const endCap = beginGroup(acc, 'endCap');
    addCap(acc, ensureCcw(source), (x, y) => place(x, y, frames.length - 1), false);
    endGroup(acc, endCap);
  }

  return finish(acc);
}

export interface LoftOptions {
  /** Cross-sections in order. Each may have a different shape; point counts are resampled to match. */
  sections: Array<{ profile: Profile; position: Vec3; rotation?: number; scale?: number }>;
  /** Smooth the transition between sections with extra interpolated rings. */
  smoothSteps?: number;
  caps?: boolean;
}

/**
 * Resample a profile to an exact point count.
 *
 * Loft's precondition is that consecutive sections have matching point counts, which real authored sections
 * never do — an airfoil root has more points than a rounded tip. Resampling by arc length preserves the
 * shape's proportions, where naive index resampling would bunch points at whichever end was denser.
 */
function resampleProfile(source: Profile, targetCount: number): Float32Array {
  const count = profilePointCount(source);
  if (count === targetCount) return source.points;

  // Cumulative arc length along the outline.
  const lengths: number[] = [0];
  let total = 0;
  const spans = source.closed ? count : count - 1;
  for (let i = 0; i < spans; i += 1) {
    const j = (i + 1) % count;
    const dx = (source.points[j * 2] as number) - (source.points[i * 2] as number);
    const dy = (source.points[j * 2 + 1] as number) - (source.points[i * 2 + 1] as number);
    total += Math.hypot(dx, dy);
    lengths.push(total);
  }
  if (total < 1e-9) return source.points;

  const out = new Float32Array(targetCount * 2);
  for (let k = 0; k < targetCount; k += 1) {
    const target = (k / targetCount) * total;
    let span = 0;
    while (span < lengths.length - 2 && (lengths[span + 1] as number) < target) span += 1;
    const segmentStart = lengths[span] as number;
    const segmentEnd = lengths[span + 1] as number;
    const t = segmentEnd > segmentStart ? (target - segmentStart) / (segmentEnd - segmentStart) : 0;
    const i = span % count;
    const j = (span + 1) % count;
    out[k * 2] = lerp(source.points[i * 2] as number, source.points[j * 2] as number, t);
    out[k * 2 + 1] = lerp(
      source.points[i * 2 + 1] as number,
      source.points[j * 2 + 1] as number,
      t,
    );
  }
  return out;
}

/**
 * Loft a surface through a series of cross-sections.
 *
 * Hulls, fuselages, ducts that change shape, anatomical structures, a transition from a square inlet to a
 * round outlet. `01-MODELS.md` names lofting explicitly as the fix for box-shaped turbine blades.
 */
export function loft(options: LoftOptions): MeshData {
  const sections = options.sections;
  if (sections.length < 2) return { positions: new Float32Array(0) };

  // One ring resolution for the whole loft: the densest section wins, so no section loses detail.
  let ringSize = 0;
  for (const section of sections) ringSize = Math.max(ringSize, profilePointCount(section.profile));

  const smoothSteps = Math.max(1, Math.floor(options.smoothSteps ?? 1));
  const acc = accumulator();
  const wall = beginGroup(acc, 'surface');

  const resampled = sections.map((section) => resampleProfile(section.profile, ringSize));

  const emitRing = (sectionIndex: number, t: number): void => {
    const a = sections[sectionIndex] as (typeof sections)[number];
    const b = sections[
      Math.min(sectionIndex + 1, sections.length - 1)
    ] as (typeof sections)[number];
    const pa = resampled[sectionIndex] as Float32Array;
    const pb = resampled[Math.min(sectionIndex + 1, sections.length - 1)] as Float32Array;

    const rotation = lerp(a.rotation ?? 0, b.rotation ?? 0, t);
    const scale = lerp(a.scale ?? 1, b.scale ?? 1, t);
    const cos = Math.cos(rotation);
    const sin = Math.sin(rotation);

    for (let p = 0; p < ringSize; p += 1) {
      const px = lerp(pa[p * 2] as number, pb[p * 2] as number, t) * scale;
      const py = lerp(pa[p * 2 + 1] as number, pb[p * 2 + 1] as number, t) * scale;
      const rx = px * cos - py * sin;
      const ry = px * sin + py * cos;
      acc.positions.push(
        lerp(a.position[0], b.position[0], t) + rx,
        lerp(a.position[1], b.position[1], t) + ry,
        lerp(a.position[2], b.position[2], t),
      );
      acc.uvs.push(t, p / ringSize);
    }
  };

  let ringCount = 0;
  for (let s = 0; s < sections.length - 1; s += 1) {
    for (let step = 0; step < smoothSteps; step += 1) {
      emitRing(s, step / smoothSteps);
      ringCount += 1;
    }
  }
  emitRing(sections.length - 1, 0);
  ringCount += 1;

  for (let r = 0; r < ringCount - 1; r += 1) {
    stitchRings(acc, r * ringSize, (r + 1) * ringSize, ringSize, true);
  }
  endGroup(acc, wall);

  if (options.caps ?? true) {
    const first = sections[0] as (typeof sections)[number];
    const last = sections[sections.length - 1] as (typeof sections)[number];

    const startCap = beginGroup(acc, 'startCap');
    addCap(
      acc,
      ensureCcw(first.profile),
      (x, y) => [first.position[0] + x, first.position[1] + y, first.position[2]],
      true,
    );
    endGroup(acc, startCap);

    const endCap = beginGroup(acc, 'endCap');
    addCap(
      acc,
      ensureCcw(last.profile),
      (x, y) => [last.position[0] + x, last.position[1] + y, last.position[2]],
      false,
    );
    endGroup(acc, endCap);
  }

  return finish(acc);
}

export interface PipeOptions {
  path: Path3;
  radius: number;
  /** Inner radius for a hollow pipe. Zero produces a solid rod. */
  innerRadius?: number;
  segments?: number;
  caps?: boolean;
}

/**
 * A tube along a path.
 *
 * Sugar over `sweep` with a circular profile, provided as its own function because pipes, wires, vessels and
 * flow tubes are so common that making an author construct a circle each time would be friction with no
 * expressive gain. A non-zero `innerRadius` produces a real hollow wall rather than a single surface, which
 * matters the moment the model is cut away.
 */
export function pipe(options: PipeOptions): MeshData {
  const segments = Math.max(3, Math.floor(options.segments ?? 24));
  const inner = options.innerRadius ?? 0;

  const ring = (radius: number): Profile => {
    const points = new Float32Array(segments * 2);
    for (let i = 0; i < segments; i += 1) {
      const angle = (i / segments) * TAU;
      points[i * 2] = Math.cos(angle) * radius;
      points[i * 2 + 1] = Math.sin(angle) * radius;
    }
    return { points, closed: true };
  };

  if (inner <= 0) {
    return sweep({ profile: ring(options.radius), path: options.path, caps: options.caps ?? true });
  }

  // Annular cross-section: outer ring with the inner ring as a hole, so the wall has real thickness.
  const outer = ring(options.radius);
  const bore = ring(inner);
  return sweep({
    profile: { points: outer.points, closed: true, holes: [bore.points] },
    path: options.path,
    caps: options.caps ?? true,
  });
}

export interface PatchOptions {
  /** The outline to fill. Holes are respected. */
  profile: Profile;
  /** Optional height function, evaluated per triangulated vertex — turns a flat patch into a relief. */
  heightAt?: (x: number, y: number) => number;
  /** Plane to lay the patch in. `xz` is the ground plane; `xy` faces the camera. */
  plane?: 'xy' | 'xz' | 'yz';
}

/**
 * A filled outline, optionally displaced by a height function.
 *
 * The bridge between 2D and 3D for the domains that need it: a map region, a graph's shaded area, a terrain
 * cross-section, a field's potential surface. `00`'s mathematics and history/geography domains both live
 * here, and both would otherwise have no natural operator.
 */
export function patch(options: PatchOptions): MeshData {
  const { points, indices } = triangulateProfile(options.profile);
  const plane = options.plane ?? 'xz';
  const heightAt = options.heightAt;

  const positions = new Float32Array((points.length / 2) * 3);
  const uvs = new Float32Array(points.length);

  for (let i = 0; i < points.length; i += 2) {
    const x = points[i] as number;
    const y = points[i + 1] as number;
    const h = heightAt ? heightAt(x, y) : 0;
    const vertex = (i / 2) * 3;
    if (plane === 'xz') {
      positions[vertex] = x;
      positions[vertex + 1] = h;
      positions[vertex + 2] = y;
    } else if (plane === 'xy') {
      positions[vertex] = x;
      positions[vertex + 1] = y;
      positions[vertex + 2] = h;
    } else {
      positions[vertex] = h;
      positions[vertex + 1] = x;
      positions[vertex + 2] = y;
    }
    uvs[i] = x;
    uvs[i + 1] = y;
  }

  const mesh: MeshData = { positions, indices, uvs };
  mesh.normals = computeNormals(mesh);
  return mesh;
}
