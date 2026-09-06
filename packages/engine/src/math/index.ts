/**
 * The pure math namespace handed to guest code as `M`.
 *
 * Every function here is deterministic, allocation-light and free of host capability. That combination is
 * what lets it be the *only* utility surface the AI needs: a model doing real geometry needs vector math,
 * interpolation, easing and noise, and if the API does not provide them the model will either reinvent
 * them badly or reach for something the sandbox denies.
 *
 * Vectors are plain 3-tuples rather than a class. `08` bans per-frame allocation in the hot path, and a
 * class with methods invites chaining that allocates an intermediate per operation — so the API is
 * function-first, and every function that can write into a caller-supplied output does.
 */

export type Vec3 = [number, number, number];
export type Vec2 = [number, number];
/** Column-major 4×4, matching Three.js so nothing is converted at the boundary. */
export type Mat4 = number[];

export const PI = Math.PI;
export const TAU = Math.PI * 2;
export const HALF_PI = Math.PI / 2;
/** Golden angle in radians. The correct spiral for phyllotaxis, sunflower packing and even scatter. */
export const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
/** Standard gravity, m/s². The same constant the physics layer defaults to (`02` R2). */
export const GRAVITY = 9.80665;

export const DEG = Math.PI / 180;
export const RAD = 180 / Math.PI;

export const deg = (radians: number): number => radians * RAD;
export const rad = (degrees: number): number => degrees * DEG;

export const clamp = (value: number, min: number, max: number): number =>
  value < min ? min : value > max ? max : value;

export const saturate = (value: number): number => clamp(value, 0, 1);

export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/** Inverse lerp; returns 0 when the range is degenerate rather than dividing by zero. */
export const unlerp = (a: number, b: number, value: number): number =>
  Math.abs(b - a) < 1e-12 ? 0 : (value - a) / (b - a);

/** Map a value from one range to another, clamped. The workhorse of parameter-to-behaviour binding. */
export const remap = (
  value: number,
  inMin: number,
  inMax: number,
  outMin: number,
  outMax: number,
): number => lerp(outMin, outMax, saturate(unlerp(inMin, inMax, value)));

/** Hermite smoothstep. Smooth first derivative at both ends, so motion built on it never snaps. */
export const smoothstep = (t: number): number => {
  const x = saturate(t);
  return x * x * (3 - 2 * x);
};

/** Quintic smootherstep: zero first *and* second derivative at the ends. For camera moves that must settle. */
export const smootherstep = (t: number): number => {
  const x = saturate(t);
  return x * x * x * (x * (x * 6 - 15) + 10);
};

export const easeIn = (t: number): number => t * t * t;
export const easeOut = (t: number): number => 1 - (1 - t) ** 3;
export const easeInOut = (t: number): number =>
  t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;

/** Elastic overshoot, for a mechanism that snaps into place. */
export const easeBack = (t: number): number => {
  const c = 1.70158;
  return 1 + (c + 1) * (t - 1) ** 3 + c * (t - 1) ** 2;
};

/** Wrap a value into `[0, range)`. Correct for negatives, unlike `%`. */
export const wrap = (value: number, range: number): number => ((value % range) + range) % range;

/** Shortest signed angular difference, in radians. Prevents the long way round on a rotation. */
export const angleDelta = (from: number, to: number): number => {
  const delta = wrap(to - from + PI, TAU) - PI;
  return delta;
};

/** Sign that returns 0 for 0, matching mathematical convention rather than `Math.sign`'s -0. */
export const sign = (value: number): number => (value > 0 ? 1 : value < 0 ? -1 : 0);

export const sqr = (value: number): number => value * value;

/** Hypotenuse without the intermediate array `Math.hypot` allocates for varargs. */
export const len2 = (x: number, y: number): number => Math.sqrt(x * x + y * y);
export const len3 = (x: number, y: number, z: number): number => Math.sqrt(x * x + y * y + z * z);

// ── Vectors ─────────────────────────────────────────────────────────────────

export const vec3 = (x = 0, y = 0, z = 0): Vec3 => [x, y, z];
export const vec2 = (x = 0, y = 0): Vec2 => [x, y];

export const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const mul = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
export const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

export const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];

export const length = (a: Vec3): number => Math.sqrt(dot(a, a));

export const distance = (a: Vec3, b: Vec3): number => length(sub(a, b));

/** Normalise, returning the zero vector unchanged rather than producing NaN. */
export const normalize = (a: Vec3): Vec3 => {
  const l = length(a);
  return l > 1e-12 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 0];
};

export const lerpVec = (a: Vec3, b: Vec3, t: number): Vec3 => [
  lerp(a[0], b[0], t),
  lerp(a[1], b[1], t),
  lerp(a[2], b[2], t),
];

/** Rotate a vector about an arbitrary axis by `angle` radians (Rodrigues' formula). */
export function rotateAxis(v: Vec3, axis: Vec3, angle: number): Vec3 {
  const k = normalize(axis);
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const kv = cross(k, v);
  const kkv = dot(k, v) * (1 - cos);
  return [
    v[0] * cos + kv[0] * sin + k[0] * kkv,
    v[1] * cos + kv[1] * sin + k[1] * kkv,
    v[2] * cos + kv[2] * sin + k[2] * kkv,
  ];
}

/** Spherical coordinates to cartesian. `theta` is azimuth about +Y, `phi` is polar from +Y. */
export const spherical = (radius: number, theta: number, phi: number): Vec3 => [
  radius * Math.sin(phi) * Math.cos(theta),
  radius * Math.cos(phi),
  radius * Math.sin(phi) * Math.sin(theta),
];

/**
 * Evenly distributed points on a sphere via the Fibonacci spiral.
 *
 * Present because the naive alternative — nesting latitude and longitude loops — clusters points at the
 * poles, and a model that scatters electrons, stars or receptors that way looks visibly wrong at the top
 * and bottom. One correct helper prevents a whole class of bad-looking models.
 */
export function fibonacciSphere(count: number, radius = 1): Vec3[] {
  const points: Vec3[] = [];
  for (let i = 0; i < count; i += 1) {
    const y = 1 - (i / Math.max(1, count - 1)) * 2;
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    const theta = GOLDEN_ANGLE * i;
    points.push([Math.cos(theta) * r * radius, y * radius, Math.sin(theta) * r * radius]);
  }
  return points;
}

/** Phyllotactic disc arrangement — sunflower seeds, packed rivets, receptor arrays. */
export function phyllotaxis(count: number, spacing = 1): Vec2[] {
  const points: Vec2[] = [];
  for (let i = 0; i < count; i += 1) {
    const r = spacing * Math.sqrt(i);
    const theta = GOLDEN_ANGLE * i;
    points.push([r * Math.cos(theta), r * Math.sin(theta)]);
  }
  return points;
}

// ── Matrices ────────────────────────────────────────────────────────────────

export const identity = (): Mat4 => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

/**
 * Compose a transform from translation, XYZ Euler rotation and scale.
 *
 * Euler order is XYZ applied as Rz·Ry·Rx, matching Three.js's default so an authored rotation means the
 * same thing here and after realization. A mismatch would show up as parts rotated correctly in the
 * manifest and wrongly on screen, which is a miserable bug to find.
 */
export function compose(translation: Vec3, rotation: Vec3, scale: Vec3): Mat4 {
  const [rx, ry, rz] = rotation;
  const cx = Math.cos(rx);
  const sx = Math.sin(rx);
  const cy = Math.cos(ry);
  const sy = Math.sin(ry);
  const cz = Math.cos(rz);
  const sz = Math.sin(rz);

  const m00 = cy * cz;
  const m01 = -cy * sz;
  const m02 = sy;
  const m10 = sx * sy * cz + cx * sz;
  const m11 = -sx * sy * sz + cx * cz;
  const m12 = -sx * cy;
  const m20 = -cx * sy * cz + sx * sz;
  const m21 = cx * sy * sz + sx * cz;
  const m22 = cx * cy;

  const [sxs, sys, szs] = scale;
  return [
    m00 * sxs,
    m10 * sxs,
    m20 * sxs,
    0,
    m01 * sys,
    m11 * sys,
    m21 * sys,
    0,
    m02 * szs,
    m12 * szs,
    m22 * szs,
    0,
    translation[0],
    translation[1],
    translation[2],
    1,
  ];
}

/** Multiply two column-major matrices: `a` then `b` applied to a point means `multiply(b, a)`. */
export function multiply(a: Mat4, b: Mat4): Mat4 {
  const out = new Array<number>(16);
  for (let column = 0; column < 4; column += 1) {
    for (let row = 0; row < 4; row += 1) {
      let sum = 0;
      for (let k = 0; k < 4; k += 1) {
        sum += (a[k * 4 + row] as number) * (b[column * 4 + k] as number);
      }
      out[column * 4 + row] = sum;
    }
  }
  return out;
}

/**
 * A transform that maps +Z onto `direction`, with `up` resolving the remaining roll.
 *
 * The workhorse behind `sweep` frames, `follow` camera shots and any part that must point at something.
 * When `direction` is parallel to `up` the cross product degenerates, so an alternate reference axis is
 * substituted — without that branch a pipe sweeping straight up produces NaN vertices.
 */
export function orient(direction: Vec3, up: Vec3 = [0, 1, 0]): Mat4 {
  const z = normalize(direction);
  if (length(z) < 1e-12) return identity();

  let reference = up;
  if (Math.abs(dot(z, normalize(up))) > 0.999)
    reference = Math.abs(z[1]) > 0.9 ? [1, 0, 0] : [0, 1, 0];

  const x = normalize(cross(reference, z));
  const y = cross(z, x);
  return [x[0], x[1], x[2], 0, y[0], y[1], y[2], 0, z[0], z[1], z[2], 0, 0, 0, 0, 1];
}

// ── Noise ───────────────────────────────────────────────────────────────────

/**
 * Deterministic hash → `[0, 1)`.
 *
 * Deterministic on purpose: `02` R4 and `00` both require reproducible teaching demos, and a model whose
 * surface roughness changes on every reload cannot be one. Guest code gets no access to `Math.random`'s
 * unseeded behaviour — it gets `random`, seeded by the host.
 */
export function hash1(x: number): number {
  const s = Math.sin(x * 127.1) * 43758.5453123;
  return s - Math.floor(s);
}

export function hash2(x: number, y: number): number {
  const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453123;
  return s - Math.floor(s);
}

export function hash3(x: number, y: number, z: number): number {
  const s = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453123;
  return s - Math.floor(s);
}

/** Value noise in 3D with smootherstep interpolation. Continuous, cheap, and good enough for surfaces. */
export function noise3(x: number, y: number, z: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const iz = Math.floor(z);
  const fx = smootherstep(x - ix);
  const fy = smootherstep(y - iy);
  const fz = smootherstep(z - iz);

  const c000 = hash3(ix, iy, iz);
  const c100 = hash3(ix + 1, iy, iz);
  const c010 = hash3(ix, iy + 1, iz);
  const c110 = hash3(ix + 1, iy + 1, iz);
  const c001 = hash3(ix, iy, iz + 1);
  const c101 = hash3(ix + 1, iy, iz + 1);
  const c011 = hash3(ix, iy + 1, iz + 1);
  const c111 = hash3(ix + 1, iy + 1, iz + 1);

  const x00 = lerp(c000, c100, fx);
  const x10 = lerp(c010, c110, fx);
  const x01 = lerp(c001, c101, fx);
  const x11 = lerp(c011, c111, fx);
  return lerp(lerp(x00, x10, fy), lerp(x01, x11, fy), fz);
}

/**
 * Fractal (sum-of-octaves) noise.
 *
 * The shape of natural detail: terrain, bark, corrosion, cloud. Exposed because a model needing "a rocky
 * surface" should reach for one call rather than hand-rolling an octave loop that gets the persistence
 * wrong and produces mush.
 */
export function fbm(x: number, y: number, z: number, octaves = 4, persistence = 0.5): number {
  let total = 0;
  let amplitude = 1;
  let frequency = 1;
  let normalisation = 0;
  for (let i = 0; i < octaves; i += 1) {
    total += noise3(x * frequency, y * frequency, z * frequency) * amplitude;
    normalisation += amplitude;
    amplitude *= persistence;
    frequency *= 2;
  }
  return normalisation > 0 ? total / normalisation : 0;
}

/**
 * A seeded pseudo-random generator (mulberry32).
 *
 * Chosen for being tiny, fast and well-distributed enough for scatter and variation. The seed is supplied
 * by the host, so a model built twice from the same manifest is identical — the property `02` calls
 * determinism and `08`'s memory tests depend on.
 */
export function createRandom(seed: number): {
  float: () => number;
  range: (min: number, max: number) => number;
  int: (min: number, max: number) => number;
  pick: <T>(items: readonly T[]) => T | undefined;
  unitVector: () => Vec3;
} {
  let state = seed >>> 0;

  const float = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const range = (min: number, max: number): number => min + float() * (max - min);

  return {
    float,
    range,
    int: (min: number, max: number) => Math.floor(range(min, max + 1)),
    pick: <T>(items: readonly T[]): T | undefined =>
      items.length === 0 ? undefined : items[Math.floor(float() * items.length)],
    unitVector: (): Vec3 => {
      // Rejection-free: sample z uniformly and the azimuth uniformly. Sampling all three components
      // independently and normalising would bias toward the cube's corners.
      const z = range(-1, 1);
      const theta = range(0, TAU);
      const r = Math.sqrt(Math.max(0, 1 - z * z));
      return [r * Math.cos(theta), z, r * Math.sin(theta)];
    },
  };
}
