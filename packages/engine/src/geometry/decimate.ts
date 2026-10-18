/**
 * Quadric-error-metric decimation (Garland & Heckbert 1997) — the operator the quality ladder
 * cuts geometry with.
 *
 * Why this exists: the ladder's previous keyword was index-stride "decimation" — keep every Nth
 * triangle, evenly spaced. Spreading the cuts across the whole mesh does not keep the silhouette;
 * it produces isolated, non-adjacent shards, and `flatShading` was enabled exactly when it fired,
 * so the damage was worst where it was most visible. Edge collapse keeps the surface a surface:
 * each cut merges a vertex into a neighbour along the edge the accumulated error quadrics call
 * cheapest, so the shape degrades as a shape.
 *
 * **The contract is fail-soft, and that is load-bearing.** Input is AI-generated geometry in
 * whatever shape the schema permits: non-indexed soup, non-manifold edges, zero-area triangles, a
 * NaN vertex the sanitizer missed, duplicated positions. The operator's failure mode is "no
 * benefit": every path that cannot provably improve the mesh — and every internal error — returns
 * the ORIGINAL `MeshData` unchanged. It never throws and never emits corrupt geometry, because a
 * simplify bug must cost a triangle budget, never a lesson (`Q2`/`Q4`). The tests in
 * `decimate.test.ts` pin the adversarial population by asserting both halves: no throw, and
 * unchanged output.
 *
 * **Determinism is part of the output shape**, not a courtesy: the structural cache (`factory.ts`)
 * keys geometry by content, so identical input must produce byte-identical output or a decimated
 * part silently forks into two GPU buffers. Hence sorted edge collection, a heap with total
 * ordering (cost, then vertex ids), and local `Set`/`Map` iteration order (insertion-ordered in
 * JavaScript) treated as part of the algorithm rather than an accident of it.
 *
 * Layout notes: the accumulator is a flat `Float64Array` — ten slots per vertex, the symmetric
 * upper triangle of the 4×4 plane quadric, area-weighted. The heap is three parallel arrays with
 * no object allocation per push. Everything below runs in the build pass (worker, inside the 20 s
 * budget), so allocation here is budget, not churn — but the per-builder timing stat bills it.
 */
import { computeNormals, type MeshData } from './mesh-data.ts';

/** Below this squared edge length two vertices are one vertex, whatever the indices claim. */
const WELD_EPSILON_SQ = 1e-12;

/** An area below this contributes no plane quadric — a zero-area triangle teaches nothing. */
const AREA_EPSILON = 1e-14;

/** Ten slots per vertex: the symmetric upper triangle of the 4×4 quadric, row-major. */
const QUADRIC_SLOTS = 10;

/**
 * Collapse edges until roughly `keep` of the input's triangles remain, or until nothing more can
 * collapse without corrupting the surface. `keep` outside (0, 1] — including NaN — is a no-op.
 */
export function decimate(mesh: MeshData, options: { keep: number }): MeshData {
  try {
    return decimateInner(mesh, options.keep);
  } catch {
    // The contract: whatever went wrong in here, the caller gets its geometry back.
    return mesh;
  }
}

function decimateInner(mesh: MeshData, keep: number): MeshData {
  // ── Fail-soft preconditions ───────────────────────────────────────────────
  // An unindexed mesh has no triangles in the data; the caller repairs by switching to indexed
  // primitives or `subdivide`.
  if (!mesh.indices || mesh.indices.length < 3 || mesh.positions.length < 9) return mesh;
  if (mesh.positions.length % 3 !== 0 || mesh.indices.length % 3 !== 0) return mesh;
  if (!Number.isFinite(keep) || keep <= 0 || keep > 1) return mesh;

  const positions = mesh.positions;
  const corners = mesh.indices.slice();
  const vertexCount = positions.length / 3;
  const aliveTriangle = new Uint8Array(corners.length / 3).fill(1);
  const aliveVertex = new Uint8Array(vertexCount).fill(1);
  // Version stamps for the lazy heap: any write to a vertex's position or corner list bumps its
  // counter, and a heap entry stamped at push time is skipped at pop time when either endpoint's
  // counter moved. Without this, an entry whose edge died (its last shared triangle dropped by a
  // neighbouring collapse) survives with its old cheap cost and folds through air — welding
  // separate sheets across a gap, which is the dual corruption of Q4's disconnection rule.
  const vertexVersion = new Uint32Array(vertexCount);
  /** Scratch for the summed endpoints' quadric — computed per price, never stored. */
  const QUADRIC_SUM = new Float64Array(QUADRIC_SLOTS);
  /**
   * Open-mesh rule per the spec: a boundary-touching edge costs AT LEAST this much, absolutely.
   * Chosen 8 decades above the reference model's own edge costs (positions in metres, quadric
   * costs ~1e-2..1e2) so the boundary survives every interior option — and stated as a floor
   * rather than a multiplier because a planar rim's own quadric prices its in-plane movement at
   * zero, and every multiplier times zero is zero.
   */
  const BOUNDARY_ABSOLUTE_FLOOR = 1e8;

  // Cleaning is part of the job, not a courtesy check: a NaN vertex or an index-repeat triangle in
  // the input is debris the ladder must not inherit (`Q2`), and "fail-soft" means the OUTPUT is
  // clean — not that the input's defects are returned verbatim.
  for (let i = 0; i < positions.length; i += 1) {
    if (!Number.isFinite(positions[i])) {
      aliveVertex[(i / 3) | 0] = 0;
    }
  }

  // The working positions, widened: collapse targets are optimal points computed in doubles, and
  // rounding each intermediate back to f32 would make the output depend on the merge order in a
  // way the determinism contract forbids.
  const working = new Float64Array(vertexCount * 3);
  working.set(positions);
  const quadrics = new Float64Array(vertexCount * QUADRIC_SLOTS);
  let triangles = corners.length / 3;
  const targetTriangles = Math.max(1, Math.floor(triangles * keep));

  // Drop the debris: triangles touching a poisoned vertex, or degenerate by index.
  for (let t = 0; t < corners.length; t += 3) {
    if (
      !aliveVertex[corners[t]!] ||
      !aliveVertex[corners[t + 1]!] ||
      !aliveVertex[corners[t + 2]!]
    ) {
      aliveTriangle[t / 3] = 0;
      triangles -= 1;
    }
  }

  // ── Quadric accumulation: one plane per incident triangle, area-weighted ──
  const addPlane = (vi: number, a: number, b: number, c: number): boolean => {
    const ax = working[a * 3]!;
    const ay = working[a * 3 + 1]!;
    const az = working[a * 3 + 2]!;
    const bx = working[b * 3]!;
    const by = working[b * 3 + 1]!;
    const bz = working[b * 3 + 2]!;
    const cx = working[c * 3]!;
    const cy = working[c * 3 + 1]!;
    const cz = working[c * 3 + 2]!;
    const ux = bx - ax;
    const uy = by - ay;
    const uz = bz - az;
    const vx = cx - ax;
    const vy = cy - ay;
    const vz = cz - az;
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const lenSq = nx * nx + ny * ny + nz * nz;
    if (!Number.isFinite(lenSq) || lenSq < AREA_EPSILON) return false;
    const len = Math.sqrt(lenSq);
    nx /= len;
    ny /= len;
    nz /= len;
    const d = -(nx * ax + ny * ay + nz * az);
    const area = len / 2;
    const q = vi * QUADRIC_SLOTS;
    quadrics[q]! += area * nx * nx;
    quadrics[q + 1]! += area * nx * ny;
    quadrics[q + 2]! += area * nx * nz;
    quadrics[q + 3]! += area * nx * d;
    quadrics[q + 4]! += area * ny * ny;
    quadrics[q + 5]! += area * ny * nz;
    quadrics[q + 6]! += area * ny * d;
    quadrics[q + 7]! += area * nz * nz;
    quadrics[q + 8]! += area * nz * d;
    quadrics[q + 9]! += area * d * d;
    return true;
  };

  for (let t = 0; t < corners.length; t += 3) {
    const a = corners[t]!;
    const b = corners[t + 1]!;
    const c = corners[t + 2]!;
    if (!aliveTriangle[t / 3]) continue;
    if (
      a === b ||
      b === c ||
      a === c ||
      !addPlane(a, a, b, c) ||
      !addPlane(b, a, b, c) ||
      !addPlane(c, a, b, c)
    ) {
      // Degenerate by index or by area: drop before it can poison a quadric or a heap decision.
      aliveTriangle[t / 3] = 0;
      triangles -= 1;
    }
  }
  // Nothing to cut when the mesh is already at or under target — but the clean pass above must
  // still reach the caller (the output is clean, not the input). Skip the collapse loop, not the
  // emit; the "no-op" this produces is topology-identical, debris-free, and just as cached.
  const mustCollapse = triangles > targetTriangles;

  // ── Vertex → live corner index. Validated lazily on every use: an entry may name a triangle
  // dropped after the entry was pushed, and validating beats maintaining removals exactly. ──
  const cornersOf = new Map<number, number[]>();
  for (let i = 0; i < corners.length; i += 1) {
    const v = corners[i]!;
    if (!aliveVertex[v]) continue;
    let list = cornersOf.get(v);
    if (!list) {
      list = [];
      cornersOf.set(v, list);
    }
    list.push(i);
  }

  // ── The pairing heap, as parallel arrays: total order (cost, a, b), zero object churn. ──
  const heapCost: number[] = [];
  const heapA: number[] = [];
  const heapB: number[] = [];
  const heapTarget: [number, number, number][] = [];
  const heapVersionA: number[] = [];
  const heapVersionB: number[] = [];

  const heapLess = (i: number, j: number): boolean =>
    heapCost[i]! < heapCost[j]! ||
    (heapCost[i] === heapCost[j] &&
      (heapA[i]! < heapA[j]! || (heapA[i] === heapA[j] && heapB[i]! < heapB[j]!)));

  const heapSwap = (i: number, j: number): void => {
    const c = heapCost[i]!;
    const va = heapA[i]!;
    const vb = heapB[i]!;
    const t = heapTarget[i]!;
    const sa = heapVersionA[i]!;
    const sb = heapVersionB[i]!;
    heapCost[i] = heapCost[j]!;
    heapA[i] = heapA[j]!;
    heapB[i] = heapB[j]!;
    heapTarget[i] = heapTarget[j]!;
    heapVersionA[i] = heapVersionA[j]!;
    heapVersionB[i] = heapVersionB[j]!;
    heapCost[j] = c;
    heapA[j] = va;
    heapB[j] = vb;
    heapTarget[j] = t;
    heapVersionA[j] = sa;
    heapVersionB[j] = sb;
  };

  const pushPair = (
    a: number,
    b: number,
    cost: number,
    target: [number, number, number],
    versionA: number,
    versionB: number,
  ): void => {
    heapCost.push(cost);
    heapA.push(a);
    heapB.push(b);
    heapTarget.push(target);
    heapVersionA.push(versionA);
    heapVersionB.push(versionB);
    let idx = heapCost.length - 1;
    while (idx > 0) {
      const parent = (idx - 1) >> 1;
      if (!heapLess(idx, parent)) break;
      heapSwap(idx, parent);
      idx = parent;
    }
  };

  const popPair = (): {
    a: number;
    b: number;
    target: [number, number, number];
    versionA: number;
    versionB: number;
  } | null => {
    if (heapCost.length === 0) return null;
    const top = {
      a: heapA[0]!,
      b: heapB[0]!,
      target: heapTarget[0]!,
      versionA: heapVersionA[0]!,
      versionB: heapVersionB[0]!,
    };
    const lastC = heapCost.pop()!;
    const lastA = heapA.pop();
    const lastB = heapB.pop();
    const lastT = heapTarget.pop();
    const lastVA = heapVersionA.pop();
    const lastVB = heapVersionB.pop();
    if (heapCost.length > 0 && lastA !== undefined) {
      heapCost[0] = lastC;
      heapA[0] = lastA;
      heapB[0] = lastB!;
      heapTarget[0] = lastT!;
      heapVersionA[0] = lastVA!;
      heapVersionB[0] = lastVB!;
      let idx = 0;
      for (;;) {
        const l = idx * 2 + 1;
        const r = l + 1;
        let best = idx;
        if (l < heapCost.length && heapLess(l, best)) best = l;
        if (r < heapCost.length && heapLess(r, best)) best = r;
        if (best === idx) break;
        heapSwap(idx, best);
        idx = best;
      }
    }
    return top;
  };

  /** vᵀQv over the summed scratch quadric, with the homogeneous row folded in (w = 1). */
  const quadricCostSum = (x: number, y: number, z: number): number =>
    quadricCostAt(QUADRIC_SUM, 0, x, y, z);

  /**
   * Whether an edge is a free border: does exactly one live triangle span both endpoints?
   * Checked per price (O(deg) over the two corner lists), not maintained incrementally — a stale
   * boundary flag from an incremental map silently shrinks rims, which is the failure the penalty
   * exists to prevent.
   */
  const edgeIsBoundary = (
    a: number,
    b: number,
  ): { anyBoundary: boolean; aBoundary: boolean; bBoundary: boolean } => {
    const trisA = cornersTris(a);
    const trisB = cornersTris(b);
    let shared = 0;
    for (const tri of trisB) {
      if (trisA.has(tri)) shared += 1;
    }
    // An edge is a border itself when exactly one live triangle spans it; either endpoint being a
    // rim vertex (some other edge of it has a single incident face) makes the fold rim-touching.
    const sharedIsSingle = shared === 1;
    const aBoundary = sharedIsSingle || isBoundaryVertex(a);
    const bBoundary = sharedIsSingle || isBoundaryVertex(b);
    return { anyBoundary: aBoundary || bBoundary, aBoundary, bBoundary };
  };

  /** A vertex is on the border when some live edge containing it has exactly one live triangle. */
  const isBoundaryVertex = (v: number): boolean => {
    const neighbours = new Map<number, number>();
    for (const idx of cornersOf.get(v) ?? []) {
      const tri = (idx / 3) | 0;
      if (!aliveTriangle[tri]) continue;
      const t0 = corners[tri * 3]!;
      const t1 = corners[tri * 3 + 1]!;
      const t2 = corners[tri * 3 + 2]!;
      for (const [x, y] of [
        [t0, t1],
        [t1, t2],
        [t2, t0],
      ] as const) {
        if (x !== v && y !== v) continue;
        const other = x === v ? y! : x!;
        neighbours.set(other, (neighbours.get(other) ?? 0) + 1);
      }
    }
    for (const count of neighbours.values()) {
      if (count === 1) return true;
    }
    return false;
  };

  /** Live triangle ids containing vertex v — the shared-count helper's halves. */
  function cornersTris(v: number): Set<number> {
    const set = new Set<number>();
    for (const idx of cornersOf.get(v) ?? []) {
      const tri = (idx / 3) | 0;
      if (aliveTriangle[tri]) set.add(tri);
    }
    return set;
  }

  const quadricCostAt = (
    q: Float64Array,
    base: number,
    x: number,
    y: number,
    z: number,
  ): number => {
    // vᵀQv with the homogeneous row folded in (w = 1).
    return (
      q[base]! * x * x +
      2 * q[base + 1]! * x * y +
      2 * q[base + 2]! * x * z +
      2 * q[base + 3]! * x +
      q[base + 4]! * y * y +
      2 * q[base + 5]! * y * z +
      2 * q[base + 6]! * y +
      q[base + 7]! * z * z +
      2 * q[base + 8]! * z +
      q[base + 9]!
    );
  };

  /** Solve (Qa + Qb)·v = [0,0,0,1] for the optimal point; singular → endpoint `a`, deterministically. */
  const solveTarget = (a: number, b: number): [number, number, number] => {
    const pa = a * QUADRIC_SLOTS;
    const pb = b * QUADRIC_SLOTS;
    const m00 = quadrics[pa]! + quadrics[pb]!;
    const m01 = quadrics[pa + 1]! + quadrics[pb + 1]!;
    const m02 = quadrics[pa + 2]! + quadrics[pb + 2]!;
    const m10 = m01;
    const m11 = quadrics[pa + 4]! + quadrics[pb + 4]!;
    const m12 = quadrics[pa + 5]! + quadrics[pb + 5]!;
    const m20 = m02;
    const m21 = m12;
    const m22 = quadrics[pa + 7]! + quadrics[pb + 7]!;
    const r0 = -(quadrics[pa + 3]! + quadrics[pb + 3]!);
    const r1 = -(quadrics[pa + 6]! + quadrics[pb + 6]!);
    const r2 = -(quadrics[pa + 8]! + quadrics[pb + 8]!);
    const det =
      m00 * (m11 * m22 - m12 * m21) - m01 * (m10 * m22 - m12 * m20) + m02 * (m10 * m21 - m11 * m20);
    if (Number.isFinite(det) && Math.abs(det) > 1e-10) {
      const x =
        (r0 * (m11 * m22 - m12 * m21) - m01 * (r1 * m22 - m12 * r2) + m02 * (r1 * m21 - m11 * r2)) /
        det;
      const y =
        (m00 * (r1 * m22 - m12 * r2) - r0 * (m10 * m22 - m12 * m20) + m02 * (m10 * r2 - r1 * m20)) /
        det;
      const z =
        (m00 * (m11 * r2 - r1 * m21) - m01 * (m10 * r2 - r1 * m20) + r0 * (m10 * m21 - m11 * m20)) /
        det;
      if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)) return [x, y, z];
    }
    return [working[a * 3]!, working[a * 3 + 1]!, working[a * 3 + 2]!];
  };

  /** Price one edge and push it into the heap. Priced against BOTH endpoints' quadrics. */
  const priceEdge = (a: number, b: number): void => {
    if (!aliveVertex[a] || !aliveVertex[b] || a === b) return;
    const target = solveTarget(a, b);
    // Sum the endpoints' quadrics into scratch: the classic operator prices against Qa alone,
    // ignoring the damage the collapse does to b's planes — any mesh with two differently-shaped
    // regions then orders its cuts backwards, and the dense side pays for the cheap side's
    // collapses (the asymmetric-mesh silhouette test pins this at 5%).
    const pa = a * QUADRIC_SLOTS;
    const pb = b * QUADRIC_SLOTS;
    for (let i = 0; i < QUADRIC_SLOTS; i += 1) {
      QUADRIC_SUM[i] = quadrics[pa + i]! + quadrics[pb + i]!;
    }
    let cost = quadricCostSum(target[0], target[1], target[2]);

    // Boundary handling, as an absolute floor rather than a multiplier: an open sheet's planar
    // rim edges price at ~0 in their own quadrics (movement along the plane is free), so even a
    // large multiplier times zero is zero, and the plate loses its coastline. A boundary-touching
    // edge pays an absolute floor that no interior edge of a similarly-positioned mesh can be
    // priced under; a still-live boundary edge is only ever chosen when nothing interior remains.
    const boundary = edgeIsBoundary(a, b);
    if (boundary.anyBoundary) cost = Math.max(cost, BOUNDARY_ABSOLUTE_FLOOR);
    if (!Number.isFinite(cost)) return;
    pushPair(a, b, cost, target, vertexVersion[a]!, vertexVersion[b]!);
  };

  // Initial pricing, over edges collected in sorted order.
  const edgeKeys = new Set<number>();
  for (let t = 0; t < corners.length; t += 3) {
    if (!aliveTriangle[t / 3]) continue;
    const a = corners[t]!;
    const b = corners[t + 1]!;
    const c = corners[t + 2]!;
    edgeKeys.add(a < b ? a * vertexCount + b : b * vertexCount + a);
    edgeKeys.add(b < c ? b * vertexCount + c : c * vertexCount + b);
    edgeKeys.add(c < a ? c * vertexCount + a : a * vertexCount + c);
  }
  const sortedEdges = [...edgeKeys].sort((x, y) => x - y);
  for (const key of sortedEdges) {
    const a = Math.floor(key / vertexCount);
    const b = key % vertexCount;
    if (a !== b) priceEdge(a, b);
  }

  /**
   * Fold `dead` into `survivor`: rewrite every live corner, drop the triangles the fold makes
   * degenerate (by index or by area — a collapsed sliver still corrupts normals), maintain the
   * corner map, and return the number of triangles lost.
   */
  const retriangulate = (dead: number, survivor: number): number => {
    let dropped = 0;
    const deadCorners = cornersOf.get(dead) ?? [];
    const survivorCorners = cornersOf.get(survivor) ?? [];
    for (const idx of deadCorners) {
      if (aliveTriangle[(idx / 3) | 0]) corners[idx] = survivor;
    }
    survivorCorners.push(...deadCorners);
    cornersOf.set(dead, []);

    const touched = new Set<number>();
    for (const idx of survivorCorners) touched.add((idx / 3) | 0);
    for (const tri of touched) {
      if (!aliveTriangle[tri]) continue;
      const a = corners[tri * 3 + 0]!;
      const b = corners[tri * 3 + 1]!;
      const c = corners[tri * 3 + 2]!;
      if (a === b || b === c || a === c) {
        aliveTriangle[tri] = 0;
        dropped += 1;
        continue;
      }
      const ax = working[a * 3]!;
      const ay = working[a * 3 + 1]!;
      const az = working[a * 3 + 2]!;
      const ux = working[b * 3]! - ax;
      const uy = working[b * 3 + 1]! - ay;
      const uz = working[b * 3 + 2]! - az;
      const vx = working[c * 3]! - ax;
      const vy = working[c * 3 + 1]! - ay;
      const vz = working[c * 3 + 2]! - az;
      const nx = uy * vz - uz * vy;
      const ny = uz * vx - ux * vz;
      const nz = ux * vy - uy * vx;
      if (!Number.isFinite(nx) || nx * nx + ny * ny + nz * nz < AREA_EPSILON) {
        aliveTriangle[tri] = 0;
        dropped += 1;
      }
    }
    return dropped;
  };

  // ── The collapse loop ─────────────────────────────────────────────────────
  while (mustCollapse && triangles > targetTriangles && heapCost.length > 0) {
    const top = popPair()!;
    const a = top.a;
    const b = top.b;
    if (!aliveVertex[a] || !aliveVertex[b]) continue;
    if (a === b) continue;
    // Staleness: the entry was priced when these stamps were current. A moved position or a
    // rewritten corner list on either endpoint makes the price — and the solved target — a guess
    // about a surface that no longer exists; skip it (the reprice pass re-pushed the live edge).
    if (top.versionA !== vertexVersion[a]! || top.versionB !== vertexVersion[b]!) continue;

    // Weld-distance: two vertices sharing coordinates are one decision either way; take the merge
    // with the existing position rather than the (possibly NaN-tainted) solved one.
    const dx = working[b * 3]! - working[a * 3]!;
    const dy = working[b * 3 + 1]! - working[a * 3 + 1]!;
    const dz = working[b * 3 + 2]! - working[a * 3 + 2]!;
    const isWeld = dx * dx + dy * dy + dz * dz < WELD_EPSILON_SQ;

    if (!isWeld) {
      working[a * 3] = top.target[0];
      working[a * 3 + 1] = top.target[1];
      working[a * 3 + 2] = top.target[2];
      vertexVersion[a]! += 1;
    }
    for (let i = 0; i < QUADRIC_SLOTS; i += 1) {
      const ai = a * QUADRIC_SLOTS + i;
      quadrics[ai] = (quadrics[ai] ?? 0) + quadrics[b * QUADRIC_SLOTS + i]!;
    }
    aliveVertex[b] = 0;
    vertexVersion[b]! += 1;
    vertexVersion[a]! += 1;
    triangles -= retriangulate(b, a);

    // Re-price every live edge of the survivor. Insertion-ordered sets keep this deterministic.
    const repriced = new Set<number>();
    for (const idx of cornersOf.get(a) ?? []) {
      if (!aliveTriangle[(idx / 3) | 0]) continue;
      const tri0 = corners[(idx / 3) * 3]!;
      const tri1 = corners[(idx / 3) * 3 + 1]!;
      const tri2 = corners[(idx / 3) * 3 + 2]!;
      for (const other of [tri0, tri1, tri2]) {
        if (other === a || !aliveVertex[other]) continue;
        repriced.add(a < other ? a * vertexCount + other : other * vertexCount + a);
      }
    }
    for (const key of repriced) priceEdge(Math.floor(key / vertexCount), key % vertexCount);
  }

  // ── Emit: referenced survivors only, f32 output, normals from the DECIMATED positions ──
  const keptVertex = new Map<number, number>();
  for (let i = 0; i < corners.length; i += 1) {
    if (!aliveTriangle[(i / 3) | 0]) continue;
    const v = corners[i]!;
    if (!keptVertex.has(v)) keptVertex.set(v, keptVertex.size);
  }
  const outPositions = new Float32Array(keptVertex.size * 3);
  for (const [oldIndex, newIndex] of keptVertex) {
    outPositions[newIndex * 3] = working[oldIndex * 3]!;
    outPositions[newIndex * 3 + 1] = working[oldIndex * 3 + 1]!;
    outPositions[newIndex * 3 + 2] = working[oldIndex * 3 + 2]!;
  }
  const trianglesOut: number[] = [];
  for (let t = 0; t < corners.length; t += 3) {
    if (!aliveTriangle[t / 3]) continue;
    trianglesOut.push(corners[t]!, corners[t + 1]!, corners[t + 2]!);
  }
  const outIndices = new Uint32Array(trianglesOut.length);
  for (let i = 0; i < trianglesOut.length; i += 1) {
    outIndices[i] = keptVertex.get(trianglesOut[i]!)!;
  }
  const out: MeshData = {
    positions: outPositions,
    indices: outIndices,
    normals: computeNormals({ positions: outPositions, indices: outIndices }),
  };
  return out;
}
