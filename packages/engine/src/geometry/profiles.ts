/**
 * The 2D profile algebra.
 *
 * Real engineering shapes are made by drawing a cross-section and then revolving, extruding or sweeping
 * it. That is why this file exists instead of a longer list of solid primitives: a profile plus four
 * operators covers a bolt, a flange, a turbine airfoil, a wine glass, an I-beam and a gear tooth, and it
 * covers the ten thousand shapes nobody thought to enumerate. `PLAN.md` §A3 calls this the curve algebra;
 * `00-GOAL.md` calls the underlying principle "the ceiling is the API, not the schema".
 *
 * Everything here is pure 2D and pure math — no GPU, no host, no allocation beyond the arrays returned.
 */
import type { Profile } from './mesh-data.ts';
import { TAU, clamp, lerp } from '../math/index.ts';

/** Build a profile from xy pairs. The rawest entry point; every other function here is sugar over it. */
export function profile(points: ReadonlyArray<readonly [number, number]>, closed = true): Profile {
  const flat = new Float32Array(points.length * 2);
  for (let i = 0; i < points.length; i += 1) {
    const point = points[i] as readonly [number, number];
    flat[i * 2] = point[0];
    flat[i * 2 + 1] = point[1];
  }
  return { points: flat, closed };
}

/** A rectangle, optionally centred. The `centered` flag exists because both conventions are natural. */
export function rect(width: number, height: number, centered = true): Profile {
  const x0 = centered ? -width / 2 : 0;
  const y0 = centered ? -height / 2 : 0;
  return profile(
    [
      [x0, y0],
      [x0 + width, y0],
      [x0 + width, y0 + height],
      [x0, y0 + height],
    ],
    true,
  );
}

/** A circle approximated by `segments` points. */
export function circle(radius: number, segments = 32): Profile {
  const count = Math.max(3, Math.floor(segments));
  const points: Array<[number, number]> = [];
  for (let i = 0; i < count; i += 1) {
    const angle = (i / count) * TAU;
    points.push([Math.cos(angle) * radius, Math.sin(angle) * radius]);
  }
  return profile(points, true);
}

/** An ellipse. Separate from `circle` because a squashed circle is a scale, and scales distort thickness. */
export function ellipse(radiusX: number, radiusY: number, segments = 32): Profile {
  const count = Math.max(3, Math.floor(segments));
  const points: Array<[number, number]> = [];
  for (let i = 0; i < count; i += 1) {
    const angle = (i / count) * TAU;
    points.push([Math.cos(angle) * radiusX, Math.sin(angle) * radiusY]);
  }
  return profile(points, true);
}

/** A regular polygon with a flat bottom edge when `flatBottom`, otherwise a vertex at angle 0. */
export function polygon(sides: number, radius: number, flatBottom = false): Profile {
  const count = Math.max(3, Math.floor(sides));
  const offset = flatBottom ? Math.PI / count - Math.PI / 2 : 0;
  const points: Array<[number, number]> = [];
  for (let i = 0; i < count; i += 1) {
    const angle = (i / count) * TAU + offset;
    points.push([Math.cos(angle) * radius, Math.sin(angle) * radius]);
  }
  return profile(points, true);
}

/** An arc from `startAngle` to `endAngle`, open by default so it can be part of a larger outline. */
export function arc(radius: number, startAngle: number, endAngle: number, segments = 24): Profile {
  const count = Math.max(2, Math.floor(segments));
  const points: Array<[number, number]> = [];
  for (let i = 0; i <= count; i += 1) {
    const angle = lerp(startAngle, endAngle, i / count);
    points.push([Math.cos(angle) * radius, Math.sin(angle) * radius]);
  }
  return profile(points, false);
}

/**
 * A cubic Bézier chain through control points.
 *
 * Bézier rather than only polylines because smooth outlines are the difference between a designed part and
 * a faceted approximation — a wine glass, a car fender, an airfoil's leading edge. `01`'s representation
 * principle applies to silhouettes too: the shape must survive being looked at.
 */
export function bezier(
  controls: ReadonlyArray<readonly [number, number]>,
  segmentsPerCurve = 16,
  closed = false,
): Profile {
  if (controls.length < 4)
    return profile(controls as ReadonlyArray<readonly [number, number]>, closed);

  const points: Array<[number, number]> = [];
  const steps = Math.max(2, Math.floor(segmentsPerCurve));

  // Walk in groups of three, reusing the previous end point as the next start: the standard chained form.
  for (let start = 0; start + 3 < controls.length; start += 3) {
    const p0 = controls[start] as readonly [number, number];
    const p1 = controls[start + 1] as readonly [number, number];
    const p2 = controls[start + 2] as readonly [number, number];
    const p3 = controls[start + 3] as readonly [number, number];

    // Skip i = 0 on later curves so the shared knot is not duplicated, which would create a zero-length
    // segment and a visible crease in anything swept along it.
    const from = start === 0 ? 0 : 1;
    for (let i = from; i <= steps; i += 1) {
      const t = i / steps;
      const u = 1 - t;
      const x =
        u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0];
      const y =
        u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1];
      points.push([x, y]);
    }
  }

  return profile(points, closed);
}

/**
 * A Catmull–Rom spline through the given points.
 *
 * Interpolating rather than approximating, which is what a model author almost always wants: "pass through
 * these measurements" rather than "be pulled toward them". Used for anatomical outlines, terrain sections
 * and any profile derived from real data.
 */
export function spline(
  points: ReadonlyArray<readonly [number, number]>,
  segmentsPerSpan = 12,
  closed = false,
): Profile {
  if (points.length < 3) return profile(points, closed);

  const result: Array<[number, number]> = [];
  const count = points.length;
  const steps = Math.max(2, Math.floor(segmentsPerSpan));
  const spans = closed ? count : count - 1;

  const at = (index: number): readonly [number, number] => {
    if (closed) return points[((index % count) + count) % count] as readonly [number, number];
    return points[clamp(index, 0, count - 1)] as readonly [number, number];
  };

  for (let i = 0; i < spans; i += 1) {
    const p0 = at(i - 1);
    const p1 = at(i);
    const p2 = at(i + 1);
    const p3 = at(i + 2);
    for (let s = 0; s < steps; s += 1) {
      const t = s / steps;
      const t2 = t * t;
      const t3 = t2 * t;
      // Uniform Catmull–Rom basis with tension 0.5.
      const x =
        0.5 *
        (2 * p1[0] +
          (-p0[0] + p2[0]) * t +
          (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2 +
          (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3);
      const y =
        0.5 *
        (2 * p1[1] +
          (-p0[1] + p2[1]) * t +
          (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 +
          (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3);
      result.push([x, y]);
    }
  }

  if (!closed) result.push(at(count - 1) as [number, number]);
  return profile(result, closed);
}

/**
 * An airfoil section (NACA 4-digit).
 *
 * Included as a named builder for the same reason `gear` is: `00-GOAL.md` requires turbine blades, wings
 * and propellers, and `01`'s representation principle says the shape must make the *behaviour* correct.
 * A blade drawn as a curved box does not read as a blade the moment it spins, and a model author cannot be
 * expected to remember the NACA thickness polynomial.
 */
export function airfoil(
  chord: number,
  thicknessRatio = 0.12,
  camberRatio = 0.02,
  camberPosition = 0.4,
  segments = 40,
): Profile {
  const count = Math.max(8, Math.floor(segments));
  const upper: Array<[number, number]> = [];
  const lower: Array<[number, number]> = [];

  for (let i = 0; i <= count; i += 1) {
    // Cosine spacing concentrates points at the leading edge, where curvature is highest. Uniform spacing
    // produces a visibly polygonal nose at any reasonable segment count.
    const beta = (i / count) * Math.PI;
    const x = (1 - Math.cos(beta)) / 2;

    const yt =
      (thicknessRatio / 0.2) *
      (0.2969 * Math.sqrt(x) - 0.126 * x - 0.3516 * x * x + 0.2843 * x ** 3 - 0.1015 * x ** 4);

    let yc = 0;
    let dyc = 0;
    if (camberRatio > 0) {
      if (x < camberPosition) {
        yc = (camberRatio / (camberPosition * camberPosition)) * (2 * camberPosition * x - x * x);
        dyc = ((2 * camberRatio) / (camberPosition * camberPosition)) * (camberPosition - x);
      } else {
        const q = 1 - camberPosition;
        yc = (camberRatio / (q * q)) * (1 - 2 * camberPosition + 2 * camberPosition * x - x * x);
        dyc = ((2 * camberRatio) / (q * q)) * (camberPosition - x);
      }
    }

    const theta = Math.atan(dyc);
    upper.push([(x - yt * Math.sin(theta)) * chord, (yc + yt * Math.cos(theta)) * chord]);
    lower.push([(x + yt * Math.sin(theta)) * chord, (yc - yt * Math.cos(theta)) * chord]);
  }

  // Upper surface leading→trailing, then lower surface trailing→leading, minus the duplicated endpoints.
  const points = [...upper, ...lower.slice(1, -1).reverse()];
  return profile(points, true);
}

/**
 * An involute gear tooth profile.
 *
 * `01-MODELS.md` names this specifically: "A gear must be an involute profile, not trapezoid teeth —
 * trapezoids mesh visually in a still frame and visibly *slip and jerk* the moment the gear train turns,
 * which is exactly when a learner is watching." So the correct curve is provided as a builder rather than
 * left to a model author to approximate.
 */
export function gearProfile(
  teeth: number,
  module_: number,
  pressureAngle = 20 * (Math.PI / 180),
  pointsPerFlank = 8,
): Profile {
  const toothCount = Math.max(6, Math.floor(teeth));
  const pitchRadius = (module_ * toothCount) / 2;
  const baseRadius = pitchRadius * Math.cos(pressureAngle);
  const outerRadius = pitchRadius + module_;
  // Standard addendum/dedendum proportions: 1.25 × module for root clearance.
  const rootRadius = Math.max(0.05 * pitchRadius, pitchRadius - 1.25 * module_);

  /** Involute of a circle: the curve traced by a taut string unwinding from the base circle. */
  const involuteAt = (radius: number): { angle: number; r: number } => {
    const r = Math.max(radius, baseRadius);
    const alpha = Math.acos(clamp(baseRadius / r, -1, 1));
    return { angle: Math.tan(alpha) - alpha, r };
  };

  const pitchInvolute = involuteAt(pitchRadius).angle;
  const anglePerTooth = TAU / toothCount;
  // Half the angular width of a tooth at the pitch circle, offset by the involute's own rotation.
  const halfTooth = anglePerTooth / 4 + pitchInvolute;

  const points: Array<[number, number]> = [];
  const flankSteps = Math.max(3, Math.floor(pointsPerFlank));

  for (let tooth = 0; tooth < toothCount; tooth += 1) {
    const center = tooth * anglePerTooth;

    // Rising flank: root → tip, along the involute.
    for (let i = 0; i <= flankSteps; i += 1) {
      const r = lerp(rootRadius, outerRadius, i / flankSteps);
      const { angle } = involuteAt(r);
      const theta = center - halfTooth + angle;
      points.push([Math.cos(theta) * r, Math.sin(theta) * r]);
    }

    // Falling flank: tip → root, mirrored about the tooth centre.
    for (let i = flankSteps; i >= 0; i -= 1) {
      const r = lerp(rootRadius, outerRadius, i / flankSteps);
      const { angle } = involuteAt(r);
      const theta = center + halfTooth - angle;
      points.push([Math.cos(theta) * r, Math.sin(theta) * r]);
    }
  }

  return profile(points, true);
}

/**
 * Offset a closed profile outward (positive) or inward (negative).
 *
 * The basis of wall thickness: a pipe is a circle and its inward offset, an enclosure is an outline and its
 * offset. Uses angle-bisector offsetting, which is exact for convex corners and acceptable for the gentle
 * concavity real profiles have. Self-intersection at sharp inward offsets is not resolved — that needs a
 * full straight-skeleton, and the honest answer is to keep this predictable rather than subtly wrong.
 */
export function offsetProfile(source: Profile, distance: number): Profile {
  const count = source.points.length / 2;
  if (count < 3) return source;

  const result: Array<[number, number]> = [];

  for (let i = 0; i < count; i += 1) {
    const prev = (i - 1 + count) % count;
    const next = (i + 1) % count;

    const px = source.points[prev * 2] as number;
    const py = source.points[prev * 2 + 1] as number;
    const cx = source.points[i * 2] as number;
    const cy = source.points[i * 2 + 1] as number;
    const nx = source.points[next * 2] as number;
    const ny = source.points[next * 2 + 1] as number;

    // Inward normals of the two adjacent edges.
    const e1x = cx - px;
    const e1y = cy - py;
    const e2x = nx - cx;
    const e2y = ny - cy;
    const l1 = Math.hypot(e1x, e1y) || 1;
    const l2 = Math.hypot(e2x, e2y) || 1;
    const n1x = -e1y / l1;
    const n1y = e1x / l1;
    const n2x = -e2y / l2;
    const n2y = e2x / l2;

    let bx = n1x + n2x;
    let by = n1y + n2y;
    const bl = Math.hypot(bx, by);
    if (bl < 1e-9) {
      // A 180° reversal: the bisector is undefined, so fall back to one edge's normal rather than NaN.
      bx = n1x;
      by = n1y;
    } else {
      bx /= bl;
      by /= bl;
    }

    // Scale by the miter factor so the offset distance is measured perpendicular to the edges, not along
    // the bisector — without it, sharp corners come out rounded-in.
    const cosHalf = Math.max(0.2, bx * n1x + by * n1y);
    const scale = distance / cosHalf;
    result.push([cx + bx * scale, cy + by * scale]);
  }

  return {
    points: new Float32Array(result.flat()),
    closed: true,
    ...(source.holes ? { holes: source.holes } : {}),
  };
}

/**
 * Round the corners of a profile.
 *
 * A fillet is what separates a machined part from a paper cutout, and `01`'s attractiveness dimension is
 * partly this: sharp corners everywhere read as "generated", while consistent radii read as "designed".
 */
export function filletProfile(source: Profile, radius: number, segments = 4): Profile {
  const count = source.points.length / 2;
  if (count < 3 || radius <= 0) return source;

  const result: Array<[number, number]> = [];
  const steps = Math.max(1, Math.floor(segments));

  for (let i = 0; i < count; i += 1) {
    const prev = (i - 1 + count) % count;
    const next = (i + 1) % count;

    const px = source.points[prev * 2] as number;
    const py = source.points[prev * 2 + 1] as number;
    const cx = source.points[i * 2] as number;
    const cy = source.points[i * 2 + 1] as number;
    const nx = source.points[next * 2] as number;
    const ny = source.points[next * 2 + 1] as number;

    const d1x = px - cx;
    const d1y = py - cy;
    const d2x = nx - cx;
    const d2y = ny - cy;
    const l1 = Math.hypot(d1x, d1y) || 1;
    const l2 = Math.hypot(d2x, d2y) || 1;

    // Never cut more than half an edge, or adjacent fillets would overlap and invert the outline.
    const cut = Math.min(radius, l1 / 2, l2 / 2);
    const a: [number, number] = [cx + (d1x / l1) * cut, cy + (d1y / l1) * cut];
    const b: [number, number] = [cx + (d2x / l2) * cut, cy + (d2y / l2) * cut];

    // Quadratic Bézier with the original corner as the control point: a smooth, cheap circular-ish arc.
    for (let s = 0; s <= steps; s += 1) {
      const t = s / steps;
      const u = 1 - t;
      result.push([
        u * u * a[0] + 2 * u * t * cx + t * t * b[0],
        u * u * a[1] + 2 * u * t * cy + t * t * b[1],
      ]);
    }
  }

  return {
    points: new Float32Array(result.flat()),
    closed: true,
    ...(source.holes ? { holes: source.holes } : {}),
  };
}

/** Add inner loops to subtract: bolt holes, a pipe's bore, cooling passages. */
export function withHoles(source: Profile, holes: readonly Profile[]): Profile {
  return {
    points: source.points,
    closed: source.closed,
    holes: holes.map((hole) => hole.points),
  };
}

/** Translate a profile. */
export function translateProfile(source: Profile, dx: number, dy: number): Profile {
  const points = new Float32Array(source.points.length);
  for (let i = 0; i < source.points.length; i += 2) {
    points[i] = (source.points[i] as number) + dx;
    points[i + 1] = (source.points[i + 1] as number) + dy;
  }
  return { points, closed: source.closed, ...(source.holes ? { holes: source.holes } : {}) };
}

/** Rotate a profile about its origin. */
export function rotateProfile(source: Profile, angle: number): Profile {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const points = new Float32Array(source.points.length);
  for (let i = 0; i < source.points.length; i += 2) {
    const x = source.points[i] as number;
    const y = source.points[i + 1] as number;
    points[i] = x * cos - y * sin;
    points[i + 1] = x * sin + y * cos;
  }
  return { points, closed: source.closed, ...(source.holes ? { holes: source.holes } : {}) };
}

/** Scale a profile, non-uniformly when both factors differ. */
export function scaleProfile(source: Profile, sx: number, sy = sx): Profile {
  const points = new Float32Array(source.points.length);
  for (let i = 0; i < source.points.length; i += 2) {
    points[i] = (source.points[i] as number) * sx;
    points[i + 1] = (source.points[i + 1] as number) * sy;
  }
  return { points, closed: source.closed, ...(source.holes ? { holes: source.holes } : {}) };
}

/** Reverse winding. Needed when a profile's orientation disagrees with the operator's face convention. */
export function reverseProfile(source: Profile): Profile {
  const count = source.points.length / 2;
  const points = new Float32Array(source.points.length);
  for (let i = 0; i < count; i += 1) {
    const j = count - 1 - i;
    points[i * 2] = source.points[j * 2] as number;
    points[i * 2 + 1] = source.points[j * 2 + 1] as number;
  }
  return { points, closed: source.closed, ...(source.holes ? { holes: source.holes } : {}) };
}

/**
 * Signed area, via the shoelace formula. Positive means counter-clockwise.
 *
 * Used to normalise winding before triangulation: a clockwise outline triangulated as counter-clockwise
 * produces inward-facing triangles, and the resulting shape is invisible from outside — one of the most
 * confusing failures a model can have, because the geometry is *correct* and simply facing away.
 */
export function signedArea(source: Profile): number {
  const count = source.points.length / 2;
  let area = 0;
  for (let i = 0; i < count; i += 1) {
    const j = (i + 1) % count;
    area +=
      (source.points[i * 2] as number) * (source.points[j * 2 + 1] as number) -
      (source.points[j * 2] as number) * (source.points[i * 2 + 1] as number);
  }
  return area / 2;
}

/** Ensure counter-clockwise winding, reversing if needed. */
export const ensureCcw = (source: Profile): Profile =>
  signedArea(source) < 0 ? reverseProfile(source) : source;
