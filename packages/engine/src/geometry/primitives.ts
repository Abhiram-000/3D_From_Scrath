/**
 * Primitive shapes.
 *
 * These are conveniences, not the vocabulary. Every one of them could be written with `revolve`, `extrude`
 * or a raw `mesh`, and the reason they exist anyway is token economy: a model that needs a bolt head should
 * not spend twenty lines constructing a hexagonal prism from first principles when the interesting part of
 * the model is elsewhere. `00-GOAL.md` requires ambition to be affordable, and cheap primitives are part of
 * that — the expressive ceiling lives in `solids.ts`, `implicit.ts` and the raw mesh escape hatch.
 *
 * Every primitive is parameterised by segment counts so the decimation ladder in `08` can coarsen it without
 * changing what it is: "the same lesson, coarser — never fewer parts teaching less."
 */
import { type MeshData, computeNormals, mergeMeshes } from './mesh-data.ts';
import { extrude, pipe, revolve } from './solids.ts';
import { circle, gearProfile, polygon, profile, rect, withHoles } from './profiles.ts';
import { PI, TAU, lerp } from '../math/index.ts';

/** A box centred on the origin. */
export function box(width: number, height: number, depth: number): MeshData {
  const hx = width / 2;
  const hy = height / 2;
  const hz = depth / 2;

  // Written out rather than generated: a box is six quads with hard edges, and the vertices cannot be shared
  // between faces or the corners would shade round instead of crisp.
  const faces: Array<Array<[number, number, number]>> = [
    [
      [-hx, -hy, hz],
      [hx, -hy, hz],
      [hx, hy, hz],
      [-hx, hy, hz],
    ], // +Z
    [
      [hx, -hy, -hz],
      [-hx, -hy, -hz],
      [-hx, hy, -hz],
      [hx, hy, -hz],
    ], // -Z
    [
      [hx, -hy, hz],
      [hx, -hy, -hz],
      [hx, hy, -hz],
      [hx, hy, hz],
    ], // +X
    [
      [-hx, -hy, -hz],
      [-hx, -hy, hz],
      [-hx, hy, hz],
      [-hx, hy, -hz],
    ], // -X
    [
      [-hx, hy, hz],
      [hx, hy, hz],
      [hx, hy, -hz],
      [-hx, hy, -hz],
    ], // +Y
    [
      [-hx, -hy, -hz],
      [hx, -hy, -hz],
      [hx, -hy, hz],
      [-hx, -hy, hz],
    ], // -Y
  ];
  const names = ['front', 'back', 'right', 'left', 'top', 'bottom'];

  const positions = new Float32Array(faces.length * 4 * 3);
  const uvs = new Float32Array(faces.length * 4 * 2);
  const indices = new Uint32Array(faces.length * 6);
  const groups: Array<{ name: string; start: number; count: number }> = [];

  faces.forEach((face, f) => {
    face.forEach((vertex, v) => {
      const base = (f * 4 + v) * 3;
      positions[base] = vertex[0];
      positions[base + 1] = vertex[1];
      positions[base + 2] = vertex[2];
      const uvBase = (f * 4 + v) * 2;
      uvs[uvBase] = v === 1 || v === 2 ? 1 : 0;
      uvs[uvBase + 1] = v === 2 || v === 3 ? 1 : 0;
    });
    const start = f * 6;
    const v0 = f * 4;
    indices[start] = v0;
    indices[start + 1] = v0 + 1;
    indices[start + 2] = v0 + 2;
    indices[start + 3] = v0;
    indices[start + 4] = v0 + 2;
    indices[start + 5] = v0 + 3;
    groups.push({ name: names[f] as string, start, count: 6 });
  });

  const mesh: MeshData = { positions, indices, uvs, groups };
  mesh.normals = computeNormals(mesh);
  return mesh;
}

/**
 * A UV sphere.
 *
 * Latitude/longitude rather than an icosphere because the poles are where a model puts its meaningful
 * features — a spin axis, a magnetic pole — and a UV sphere puts vertices exactly there. Partial ranges
 * produce hemispheres and orange-slice cutaways, which `01` wants for showing internals.
 */
export function sphere(
  radius: number,
  widthSegments = 32,
  heightSegments = 16,
  phiLength = TAU,
  thetaLength = PI,
): MeshData {
  const w = Math.max(3, Math.floor(widthSegments));
  const h = Math.max(2, Math.floor(heightSegments));

  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];

  for (let y = 0; y <= h; y += 1) {
    const v = y / h;
    const theta = v * thetaLength;
    for (let x = 0; x <= w; x += 1) {
      const u = x / w;
      const phi = u * phiLength;
      positions.push(
        -radius * Math.sin(theta) * Math.cos(phi),
        radius * Math.cos(theta),
        radius * Math.sin(theta) * Math.sin(phi),
      );
      uvs.push(u, 1 - v);
    }
  }

  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const a = y * (w + 1) + x;
      const b = a + 1;
      const c = a + (w + 1);
      const d = c + 1;
      // Skip the degenerate triangle at each pole: a quad there has two coincident corners.
      if (y !== 0) indices.push(a, c, b);
      if (y !== h - 1) indices.push(b, c, d);
    }
  }

  const mesh: MeshData = {
    positions: new Float32Array(positions),
    indices: new Uint32Array(indices),
    uvs: new Float32Array(uvs),
  };
  mesh.normals = computeNormals(mesh);
  return mesh;
}

/**
 * A cylinder, optionally tapered into a truncated cone.
 *
 * Expressed as a revolve of the side profile plus revolved cap discs, so capping and winding have one
 * implementation rather than two. A truncated cone therefore gets its two different cap radii for free.
 */
export function cylinder(
  radiusTop: number,
  radiusBottom: number,
  height: number,
  segments = 32,
  openEnded = false,
): MeshData {
  const half = height / 2;
  // Radii are floored just above zero: an exactly-zero radius collapses the revolve ring into a line of
  // coincident vertices, which produces degenerate triangles and a black tip.
  const top = Math.max(1e-5, radiusTop);
  const bottom = Math.max(1e-5, radiusBottom);

  const side = revolve({
    profile: profile(
      [
        [bottom, -half],
        [top, half],
      ],
      false,
    ),
    segments,
    axis: 'y',
    caps: false,
  });

  if (openEnded) return side;

  const topCap = revolve({
    profile: profile(
      [
        [0, half],
        [top, half],
      ],
      false,
    ),
    segments,
    axis: 'y',
    caps: false,
  });
  const bottomCap = revolve({
    profile: profile(
      [
        [bottom, -half],
        [0, -half],
      ],
      false,
    ),
    segments,
    axis: 'y',
    caps: false,
  });

  return mergeMeshes([
    { name: 'side', mesh: side },
    { name: 'top', mesh: topCap },
    { name: 'bottom', mesh: bottomCap },
  ]);
}

/** A cone: a cylinder whose top radius collapses to a point. */
export const cone = (radius: number, height: number, segments = 32): MeshData =>
  cylinder(1e-5, radius, height, segments, false);

/** A torus — rings, gaskets, orbital paths. */
export function torus(
  radius: number,
  tubeRadius: number,
  radialSegments = 32,
  tubularSegments = 16,
): MeshData {
  const ring = circle(tubeRadius, tubularSegments);
  const count = ring.points.length / 2;
  const shifted: Array<[number, number]> = [];
  for (let i = 0; i < count; i += 1) {
    shifted.push([(ring.points[i * 2] as number) + radius, ring.points[i * 2 + 1] as number]);
  }
  // Offsetting the tube profile by the major radius and revolving it *is* the definition of a torus.
  return revolve({ profile: profile(shifted, true), segments: radialSegments, axis: 'y' });
}

/** A capsule: a cylinder with hemispherical ends. Bones, pills, bounding volumes. */
export function capsule(radius: number, height: number, segments = 24): MeshData {
  const half = height / 2;
  const arcSteps = Math.max(4, Math.floor(segments / 2));
  const points: Array<[number, number]> = [[1e-5, -half - radius]];

  for (let i = 0; i <= arcSteps; i += 1) {
    const angle = lerp(-PI / 2, 0, i / arcSteps);
    points.push([Math.max(1e-5, Math.cos(angle) * radius), -half + Math.sin(angle) * radius]);
  }
  for (let i = 0; i <= arcSteps; i += 1) {
    const angle = lerp(0, PI / 2, i / arcSteps);
    points.push([Math.max(1e-5, Math.cos(angle) * radius), half + Math.sin(angle) * radius]);
  }
  points.push([1e-5, half + radius]);

  return revolve({ profile: profile(points, true), segments, axis: 'y' });
}

/** A flat disc or annulus in the XZ plane. */
export function disc(outerRadius: number, innerRadius = 0, segments = 32): MeshData {
  return revolve({
    profile: profile(
      [
        [Math.max(1e-5, innerRadius), 0],
        [outerRadius, 0],
      ],
      false,
    ),
    segments,
    axis: 'y',
    caps: false,
  });
}

/** A rectangular plane, subdivided so a height function or displacement modifier has vertices to move. */
export function plane(
  width: number,
  depth: number,
  widthSegments = 1,
  depthSegments = 1,
): MeshData {
  const w = Math.max(1, Math.floor(widthSegments));
  const d = Math.max(1, Math.floor(depthSegments));

  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];

  for (let z = 0; z <= d; z += 1) {
    for (let x = 0; x <= w; x += 1) {
      positions.push((x / w - 0.5) * width, 0, (z / d - 0.5) * depth);
      uvs.push(x / w, z / d);
    }
  }

  for (let z = 0; z < d; z += 1) {
    for (let x = 0; x < w; x += 1) {
      const a = z * (w + 1) + x;
      const b = a + 1;
      const c = a + (w + 1);
      const dd = c + 1;
      indices.push(a, c, b, b, c, dd);
    }
  }

  const mesh: MeshData = {
    positions: new Float32Array(positions),
    indices: new Uint32Array(indices),
    uvs: new Float32Array(uvs),
  };
  mesh.normals = computeNormals(mesh);
  return mesh;
}

/** A prism from a regular polygon: hex bolt heads, octagonal columns, crystal forms. */
export const prism = (sides: number, radius: number, height: number): MeshData =>
  extrude({ profile: polygon(sides, radius), depth: height, direction: [0, 1, 0] });

/** A rectangular beam — the most-used shape in structural models. */
export const beam = (width: number, height: number, length: number): MeshData =>
  extrude({ profile: rect(width, height), depth: length, direction: [0, 0, 1] });

/**
 * A helix — springs, threads, DNA backbones, coils.
 *
 * `01-MODELS.md` requires this shape specifically: "A spring must be a true helical sweep, not stacked
 * cylinders — stacked cylinders cannot compress; a spring the learner cannot compress is a picture of a
 * spring." Sweeping a circle along the true helical path is what makes pitch a live parameter.
 */
export function helix(
  coilRadius: number,
  wireRadius: number,
  turns: number,
  pitch: number,
  segmentsPerTurn = 24,
  wireSegments = 10,
): MeshData {
  const steps = Math.max(8, Math.floor(turns * segmentsPerTurn));
  const points = new Float32Array((steps + 1) * 3);
  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps;
    const angle = t * turns * TAU;
    points[i * 3] = Math.cos(angle) * coilRadius;
    points[i * 3 + 1] = t * turns * pitch;
    points[i * 3 + 2] = Math.sin(angle) * coilRadius;
  }

  return pipe({ path: { points, closed: false }, radius: wireRadius, segments: wireSegments });
}

/**
 * A gear.
 *
 * The involute profile lives in `profiles.ts` for the reason `01` gives — trapezoid teeth visibly slip when
 * a train turns. This extrudes that profile into a real solid with an optional bore so it can sit on a shaft.
 */
export function gear(
  teeth: number,
  module_: number,
  thickness: number,
  boreRadius = 0,
  pressureAngle = 20 * (PI / 180),
): MeshData {
  const tooth = gearProfile(teeth, module_, pressureAngle);
  const shaped = boreRadius > 0 ? withHoles(tooth, [circle(boreRadius, 24)]) : tooth;
  return extrude({ profile: shaped, depth: thickness, direction: [0, 0, 1] });
}

/**
 * A tetrahedron, octahedron, icosahedron or dodecahedron, optionally spherified.
 *
 * Present because crystal structures, molecular geometries and coordination shells all need exact platonic
 * forms, and approximating them with a low-segment sphere gets the vertex *count* right and the vertex
 * *positions* wrong — which is the difference between a correct diagram and a decorative one.
 */
export function polyhedron(
  kind: 'tetrahedron' | 'octahedron' | 'icosahedron' | 'cube',
  radius = 1,
): MeshData {
  let vertices: number[];
  let faces: number[];

  if (kind === 'tetrahedron') {
    vertices = [1, 1, 1, -1, -1, 1, -1, 1, -1, 1, -1, -1];
    faces = [2, 1, 0, 0, 3, 2, 1, 3, 0, 2, 3, 1];
  } else if (kind === 'octahedron') {
    vertices = [1, 0, 0, -1, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 1, 0, 0, -1];
    faces = [0, 2, 4, 0, 4, 3, 0, 3, 5, 0, 5, 2, 1, 2, 5, 1, 5, 3, 1, 3, 4, 1, 4, 2];
  } else if (kind === 'cube') {
    vertices = [-1, -1, -1, 1, -1, -1, 1, 1, -1, -1, 1, -1, -1, -1, 1, 1, -1, 1, 1, 1, 1, -1, 1, 1];
    faces = [
      0, 3, 2, 0, 2, 1, 4, 5, 6, 4, 6, 7, 0, 4, 7, 0, 7, 3, 1, 2, 6, 1, 6, 5, 3, 7, 6, 3, 6, 2, 0,
      1, 5, 0, 5, 4,
    ];
  } else {
    // Icosahedron from the golden-ratio rectangles.
    const t = (1 + Math.sqrt(5)) / 2;
    vertices = [
      -1,
      t,
      0,
      1,
      t,
      0,
      -1,
      -t,
      0,
      1,
      -t,
      0,
      0,
      -1,
      t,
      0,
      1,
      t,
      0,
      -1,
      -t,
      0,
      1,
      -t,
      t,
      0,
      -1,
      t,
      0,
      1,
      -t,
      0,
      -1,
      -t,
      0,
      1,
    ];
    faces = [
      0, 11, 5, 0, 5, 1, 0, 1, 7, 0, 7, 10, 0, 10, 11, 1, 5, 9, 5, 11, 4, 11, 10, 2, 10, 7, 6, 7, 1,
      8, 3, 9, 4, 3, 4, 2, 3, 2, 6, 3, 6, 8, 3, 8, 9, 4, 9, 5, 2, 4, 11, 6, 2, 10, 8, 6, 7, 9, 8, 1,
    ];
  }

  const positions = new Float32Array(vertices.length);
  for (let i = 0; i < vertices.length; i += 3) {
    const x = vertices[i] as number;
    const y = vertices[i + 1] as number;
    const z = vertices[i + 2] as number;
    const length = Math.sqrt(x * x + y * y + z * z) || 1;
    positions[i] = (x / length) * radius;
    positions[i + 1] = (y / length) * radius;
    positions[i + 2] = (z / length) * radius;
  }

  const mesh: MeshData = { positions, indices: new Uint32Array(faces) };
  mesh.normals = computeNormals(mesh);
  return mesh;
}

/**
 * A point cloud.
 *
 * Electron clouds, particle fields, star catalogues, scatter plots. One draw call regardless of count, which
 * is why `08`'s point ceiling is generous: the cost is transform memory, not render time.
 */
export function points(positions: Float32Array): MeshData {
  return { positions };
}

/**
 * A polyline as a thin swept tube.
 *
 * Real geometry rather than a `LineSegments` primitive, because line width is unimplemented in WebGL on most
 * drivers — a "3px line" renders as 1px everywhere it matters. A swept tube is the only way an arrow, a flow
 * path or a field line reads at a consistent thickness.
 */
export const polyline = (path: Float32Array, thickness = 0.01, segments = 6): MeshData =>
  pipe({ path: { points: path, closed: false }, radius: thickness, segments });
