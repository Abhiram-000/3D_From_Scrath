/**
 * Polygon triangulation (ear clipping with hole support).
 *
 * Needed by every operator that caps a solid: `extrude` needs end faces, `revolve` needs caps when the
 * sweep is partial, `patch` needs a filled outline. Written here rather than pulled from a library because
 * the whole geometry layer must run in Node with no DOM for the headless audit, and because holes are a
 * first-class requirement — a flange with 24 bolt holes should triangulate once, not become 24 boolean
 * operations (see `profiles.ts`, `withHoles`).
 *
 * Ear clipping is O(n²) in the worst case, which is the right trade here: profiles are tens to hundreds of
 * points, and the algorithm is simple enough to be obviously correct — a subtly wrong triangulation
 * produces inside-out caps, which is one of the hardest model faults to diagnose visually.
 */
import type { Profile } from './mesh-data.ts';
import { signedArea } from './profiles.ts';

/** A flat list of `[x, y]` pairs, indexed by vertex number. */
type Points = Float32Array;

const cross2 = (ax: number, ay: number, bx: number, by: number): number => ax * by - ay * bx;

/** True when point p lies inside triangle abc, inclusive of the edges. */
function pointInTriangle(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number,
  px: number,
  py: number,
): boolean {
  const d1 = cross2(bx - ax, by - ay, px - ax, py - ay);
  const d2 = cross2(cx - bx, cy - by, px - bx, py - by);
  const d3 = cross2(ax - cx, ay - cy, px - cx, py - cy);
  const hasNegative = d1 < 0 || d2 < 0 || d3 < 0;
  const hasPositive = d1 > 0 || d2 > 0 || d3 > 0;
  return !(hasNegative && hasPositive);
}

/**
 * Distance below which two ring vertices are treated as the same point.
 *
 * Needed because hole bridging deliberately duplicates its two seam endpoints (see `bridgeHole`). Without
 * an epsilon the containment test below sees a duplicate sitting exactly on a candidate ear's corner,
 * reports it as "inside", and no ear is ever found — the polygon silently triangulates to nothing.
 */
const COINCIDENT_EPSILON = 1e-9;

/**
 * Triangulate a simple polygon given as an index ring into `points`.
 *
 * Returns triangle indices referring to the same `points` array, so the caller can weld caps onto a side
 * wall without re-indexing. Counter-clockwise input is required; the caller normalises winding.
 */
function earClip(points: Points, ring: number[]): number[] {
  const indices: number[] = [];
  const remaining = [...ring];

  /** True when two vertices occupy the same location, whatever their indices. */
  const coincident = (a: number, b: number): boolean =>
    Math.abs((points[a * 2] as number) - (points[b * 2] as number)) < COINCIDENT_EPSILON &&
    Math.abs((points[a * 2 + 1] as number) - (points[b * 2 + 1] as number)) < COINCIDENT_EPSILON;

  // Guard the loop explicitly: a self-intersecting profile can otherwise fail to find any ear and spin.
  // Bailing out with a partial triangulation is better than hanging — the model still renders, and the
  // audit reports the deficient cap.
  let guard = remaining.length * remaining.length + 16;

  while (remaining.length > 3 && guard-- > 0) {
    let clipped = false;

    for (let i = 0; i < remaining.length; i += 1) {
      const prev = remaining[(i - 1 + remaining.length) % remaining.length] as number;
      const current = remaining[i] as number;
      const next = remaining[(i + 1) % remaining.length] as number;

      const ax = points[prev * 2] as number;
      const ay = points[prev * 2 + 1] as number;
      const bx = points[current * 2] as number;
      const by = points[current * 2 + 1] as number;
      const cx = points[next * 2] as number;
      const cy = points[next * 2 + 1] as number;

      // Convex test. A reflex vertex can never be an ear.
      if (cross2(bx - ax, by - ay, cx - bx, cy - by) <= 0) continue;

      // No other vertex may lie inside the candidate ear. Vertices that *coincide* with one of the ear's
      // corners are skipped rather than counted: hole bridging duplicates its seam endpoints on purpose, and
      // treating a duplicate as an interior point makes every ear look blocked, which triangulates to nothing.
      let contains = false;
      for (const other of remaining) {
        if (other === prev || other === current || other === next) continue;
        if (coincident(other, prev) || coincident(other, current) || coincident(other, next))
          continue;
        if (
          pointInTriangle(
            ax,
            ay,
            bx,
            by,
            cx,
            cy,
            points[other * 2] as number,
            points[other * 2 + 1] as number,
          )
        ) {
          contains = true;
          break;
        }
      }
      if (contains) continue;

      indices.push(prev, current, next);
      remaining.splice(i, 1);
      clipped = true;
      break;
    }

    // No ear found in a full pass: the polygon is degenerate or self-intersecting. Stop rather than loop.
    if (!clipped) break;
  }

  if (remaining.length === 3) {
    indices.push(remaining[0] as number, remaining[1] as number, remaining[2] as number);
  }

  return indices;
}

/**
 * Bridge a hole into the outer ring so ear clipping sees one simple polygon.
 *
 * The standard technique: find the hole's rightmost vertex, cast a ray right to find the nearest outer
 * edge, and cut a two-way seam between them. Duplicating the two bridge vertices is what keeps the ring
 * simple — without duplicates the seam would be traversed once and the ring would self-touch.
 */
function bridgeHole(points: number[], outer: number[], hole: number[]): { outer: number[] } {
  // Rightmost hole vertex: the seam must exit the hole toward the outer boundary.
  let holeIndex = 0;
  let bestX = -Infinity;
  for (let i = 0; i < hole.length; i += 1) {
    const x = points[(hole[i] as number) * 2] as number;
    if (x > bestX) {
      bestX = x;
      holeIndex = i;
    }
  }
  const holeVertex = hole[holeIndex] as number;
  const hy = points[holeVertex * 2 + 1] as number;

  // Nearest outer vertex to the right of the hole, at a similar height. Using the closest visible vertex
  // rather than a true ray-edge intersection keeps this simple and works for the convex-ish outlines real
  // profiles have; a pathological outline yields a slightly worse triangulation, never a wrong one.
  let outerIndex = 0;
  let bestDistance = Infinity;
  for (let i = 0; i < outer.length; i += 1) {
    const vertex = outer[i] as number;
    const vx = points[vertex * 2] as number;
    const vy = points[vertex * 2 + 1] as number;
    if (vx < bestX) continue;
    const distance = (vx - bestX) * (vx - bestX) + (vy - hy) * (vy - hy);
    if (distance < bestDistance) {
      bestDistance = distance;
      outerIndex = i;
    }
  }

  const bridgeOuter = outer[outerIndex] as number;

  // Duplicate both bridge endpoints so the seam is traversed out and back.
  const duplicateHole = points.length / 2;
  points.push(points[holeVertex * 2] as number, points[holeVertex * 2 + 1] as number);
  const duplicateOuter = points.length / 2;
  points.push(points[bridgeOuter * 2] as number, points[bridgeOuter * 2 + 1] as number);

  const rotatedHole = [...hole.slice(holeIndex), ...hole.slice(0, holeIndex)];

  const merged = [
    ...outer.slice(0, outerIndex + 1),
    ...rotatedHole,
    duplicateHole,
    duplicateOuter,
    ...outer.slice(outerIndex + 1),
  ];

  return { outer: merged };
}

export interface TriangulationResult {
  /** xy pairs — may be longer than the input when holes added bridge vertices. */
  points: Float32Array;
  /** Triangle indices into `points`. */
  indices: Uint32Array;
}

/**
 * Triangulate a profile, including its holes.
 *
 * Winding is normalised first: a clockwise outline triangulated as counter-clockwise produces inward-facing
 * triangles, and the resulting cap is invisible from outside — geometry that is correct and simply facing
 * away, which is among the most confusing faults a model can have.
 */
export function triangulateProfile(source: Profile): TriangulationResult {
  const outerCcw = signedArea(source) < 0;
  const count = source.points.length / 2;
  if (count < 3) return { points: source.points, indices: new Uint32Array(0) };

  const points: number[] = [];
  for (let i = 0; i < source.points.length; i += 1) points.push(source.points[i] as number);

  let outerRing: number[] = [];
  for (let i = 0; i < count; i += 1) outerRing.push(i);
  if (outerCcw) outerRing.reverse();

  for (const hole of source.holes ?? []) {
    const holeCount = hole.length / 2;
    if (holeCount < 3) continue;

    const start = points.length / 2;
    for (let i = 0; i < hole.length; i += 1) points.push(hole[i] as number);

    const holeRing: number[] = [];
    for (let i = 0; i < holeCount; i += 1) holeRing.push(start + i);

    // Holes must wind opposite to the outer ring, or the bridge seam folds the wrong way and the hole
    // fills in instead of being cut out.
    let holeArea = 0;
    for (let i = 0; i < holeCount; i += 1) {
      const j = (i + 1) % holeCount;
      holeArea +=
        (hole[i * 2] as number) * (hole[j * 2 + 1] as number) -
        (hole[j * 2] as number) * (hole[i * 2 + 1] as number);
    }
    if (holeArea > 0) holeRing.reverse();

    outerRing = bridgeHole(points, outerRing, holeRing).outer;
  }

  const flat = new Float32Array(points);
  const indices = earClip(flat, outerRing);

  return { points: flat, indices: new Uint32Array(indices) };
}
