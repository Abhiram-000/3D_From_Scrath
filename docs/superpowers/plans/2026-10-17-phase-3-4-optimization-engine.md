# Optimization Engine — Phase 3 + 4 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop rendering a dead frame (on-demand), and stop shattering geometry when quality steps down (QEM decimation) — the last two pieces before the predicted tier plan.

**Architecture:** Phase 3 adds a render gate to the worker loop with explicit invalidations; Phase 4 installs a real quadric-error decimator as a geometry operator, swaps `realize.ts`'s index-stride path onto it, and fixes the two admission lies it touches (instance-cap ordering, post-cap pricing).

**Tech Stack:** TypeScript, Svelte 5 runes (viewer invalidations), Vitest 5 node env, no new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-17-optimization-engine-design.md` — §4 Phases 3–4, §3 (QEM row), invariants Q2–Q4, Q10.

## Global Constraints

- `pnpm verify` green before every commit; no sandbox capability change (A2); engine/sandbox DOM-free (A3).
- Paused is not dead: parameter changes, selection, hover and view modes all invalidate (spec Q-inv set, `00`).
- No new API-surface entry without its `API_REFERENCE` entry — the bidirectional weld test enforces both directions.
- Churn gate is live: every phase here re-pins only with figures (Q10); baseline idle 0 / frame 0–1, retained 29–30 B.

## Review Focus

1. **Pause-flake** — a paused model that re-renders forever because an invalidation fires every frame (e.g. hover set without a change check). The gate must go truly still: e2e asserts FPS 0 sustained, then recovers on interaction. *(Task 1)*
2. **Degenerate input to decimate** — a 1-triangle mesh, and `keep` ≥ 1 (no-op) and `keep` ≤ 0 (floor). *(Task 2)*
3. **Decimation on indexed AND non-indexed meshes** — a non-indexed mesh must be rejected loudly, not silently skirted. *(Task 2)*
4. **Reuse of vertex normals across a collapse** — normals for a cached `cacheKey@keep` entry must come from the DECIMATED geometry, carried through `toBufferGeometry`'s "skip recompute when normals exist" path. *(Task 3)*
5. **Silhouette** — hero-part projected bounds at `HERO_FLOOR` must stay within a tolerance of the original's. *(Task 2)*

---

### Task 1: On-demand rendering

**Files:**
- Modify: `apps/web/src/lib/engine/sandbox-worker.ts` (`renderFrame` gate, `WorkerState.needsRender`, invalidation sites: setViewMode, theme/resize (host messages), selection/setSelected, hover apply, notices that mutate the scene, `applyViewMode`)
- Modify: `apps/web/src/lib/engine/frame-compose.ts` + test (pure gate predicate)

**Interfaces:**
- Produces: `export function renderGate(s: { paused: boolean; autoRotate: boolean; cameraDirty: boolean; needsRender: boolean; hoverPending: boolean }): boolean` — false means skip everything including `renderer.render`; frame counter and stats cadence continue.

- [ ] **Step 1: RED — the pure predicate and its stillness property**

```ts
it('is still only when paused, un-rotating, and nothing is marked dirty', () => {
  const quiet = { paused: true, autoRotate: false, cameraDirty: false, needsRender: false, hoverPending: false };
  expect(renderGate(quiet)).toBe(false);
  expect(renderGate({ ...quiet, needsRender: true })).toBe(true);
  expect(renderGate({ ...quiet, paused: false })).toBe(true);
  expect(renderGate({ ...quiet, cameraDirty: true })).toBe(true);
});
```

- [ ] **Step 2: Implement the gate in `renderFrame`**

After the camera coalesce and autoRotate advance, before the hover raycast and `renderer.render`:

```ts
const gate: GateInput = {
  paused: target.paused,
  autoRotate: target.autoRotate,
  cameraDirty: target.cameraDirty,
  needsRender: target.needsRender,
  hoverPending: target.hoverPending,
};
if (renderGate(gate)) { /* physics step, guest run, declared motions, sync, cast, render */ }
```
Everything work-shaped sits inside the positive branch; `needsRender` clears on render. A paused model STILL publishes stats at the existing cadence with `fps` 0 — the watchdog reads any message as liveness, and `computeFrameRate` already reports a stall.

- [ ] **Step 3: Wire every invalidation** — `setViewMode`/`applyViewMode`, theme message, `resize` (host), `setSelected`, hover-apply on change, scene-mutating notices; none may set the flag unconditionally per frame (Review Focus 1).

- [ ] **Step 4: e2e proof**

`pnpm exec playwright test --project=desktop --grep "pauses"` extended: after Pause, within 3s the FPS read-out reads 0 and the Time read-out freezes for 2s; a part click revives rendering (FPS > 0) and selection shows. `pnpm build` first.

- [ ] **Step 5: Commit** — `perf(worker): a still model renders nothing`

---

### Task 2: QEM edge collapse, unit-tested in isolation

**Files:**
- Create: `packages/engine/src/geometry/decimate.ts`
- Test: `packages/engine/tests/decimate.test.ts`
- Modify: `packages/contracts/src/wire/sandbox.ts` — nothing (no limits change)

**Interfaces:**
- Consumes: `MeshData` (`positions`, `indices`, `normals?`), the module's existing error type pattern.
- Produces: `export function decimate(mesh: MeshData, options: { keep: number }): MeshData` — new `MeshData`, source untouched; `keep` clamped into `[RECOGNIZABILITY_FLOOR..1]` is the CALLER's contract, the operator clamps to `(0,1]`.

- [ ] **Step 1: RED — the contract suite**

- on a procedurally built indexed sphere (segmented, known triangle count), `keep: 0.5` produces triangle counts in `[0.49, 0.51]` of original
- **zero degenerate triangles** (each kept triangle has positive area)
- **zero newly-disconnected surface**: union of kept triangles' vertex set is connected when the source was (existing `validateMesh` reports components — reuse its counting)
- normals come from `computeNormals` of the decimated positions when the source had normals (else omitted, per MeshData's optional contract)
- source `MeshData` is byte-identical after the call (no in-place mutation)
- deterministic: two runs, identical bytes
- reject non-indexed `MeshData` with a `GeometryError` naming the repair (`subdivide`/`mesh` with indices)
- Review Focus 2/5: `keep: 1` returns an equivalent mesh; a hero sphere at `keep: 0.55` keeps its projected silhouette within 5% (caret assertion on the bounds from the reference model's own fan-blade fixture is the phase-5 test; here the sphere suffices)

- [ ] **Step 2: Implement** — quadric per vertex from its incident triangle planes (area-weighted), lazy pairing heap over unique edges, optimal-target solve per pair (6×6 null-space with fallback to midpoints), boundary preservation via edge flags from boundary-angle detection, position writes into a fresh `Float32Array`, index rebuild once at the end.

- [ ] **Step 3: GREEN + the engine suite** — `pnpm test decimate && pnpm test geometry` (the 200-bolt cache tests must not move).

- [ ] **Step 4: Commit** — `feat(engine): decimate — quadric error metrics, the operator the ladder was waiting for`

---

### Task 3: The realizer swaps onto it

**Files:**
- Modify: `packages/engine/src/runtime/realize.ts` (`toBufferGeometry` decimation branch), `packages/engine/src/authoring/api-surface.ts` untouched (reflection), `packages/engine/src/authoring/api-reference.ts` (+ `decimate` entry), `packages/engine/src/index.ts` (+ export)
- Test: `packages/engine/tests/host-admission.test.ts` (extension), `packages/engine/tests/api-reference.test.ts` (weld, must pass unchanged once the doc entry exists)

**Interfaces:**
- Consumes: `decimate(mesh, { keep })` from `@edu3d/engine`'s geometry; `decimation: Map<string, number>` (existing decisions field).
- Produces: realized geometry whose `triangles` equal the decimated count — `stats.triangles` becomes realized-by-construction (Q5, Phase 6's first lens).

- [ ] **Step 1: RED** — host-admission test extension: the reference model at tier `low` realizes with `decimation` decisions present; assert the realized `THREE.BufferGeometry`'s index count differs from authored AND every kept triangle is non-degenerate AND the per-part `decimated` flag reads true where it applied (this flips the hardcoded `false` at the three authoring sites the previous spec listed).

- [ ] **Step 2: Implement** — in `toBufferGeometry`, replace the stride block: `const decimated = decimate(mesh, { keep: decimateTo });` then build from `decimated` (normals recompute UNCONDITIONALLY — the carried normals are for the un-decimated positions; Review Focus 4). The `@keep` cache suffix already prevents cross-poisoning.

- [ ] **Step 3: GREEN + e2e subset** — `pnpm build && pnpm exec playwright test --project=desktop --grep "renders the reference model|reports a sane device tier"` (low tier on SwiftShader exercises decimation; triangles still measured > 0, tier-Adapted notice unchanged).

- [ ] **Step 4: Commit** — `perf(engine): the ladder decimates real geometry, not index stride`

---

### Task 4: The two admission lies the decimator exposes

**Files:**
- Modify: `packages/engine/src/runtime/admission.ts` (instance cap honours `decimationOrder` policy; `decimationOrder` prices post-cap counts; hero floors hold in the instance path — Q3/Q7's half that Phase 6 does not own)
- Test: `packages/engine/tests/host-admission.test.ts`

**Interfaces:**
- Produces: `decimationOrder(manifest)` unchanged signature, corrected ranking; the instance-cap branch reads the same order.

- [ ] **Step 1: RED** — a manifest with a hero-instance fan (22 placements, cap applied) plus one larger non-hero instance set asserts: hero keeps ≥ `HERO_FLOOR`, the non-hero set keeps strictly less than the hero's keepFraction, and the priced `drawCalls` reflects post-cap instance counts.

- [ ] **Step 2: Implement** — route the instance branch through `decimationOrder` (non-hero before hero, largest keep budget first); compute keepFraction from post-cap placed count; a notice for a capped hero names the floor it held, never a fraction it did not keep (Q6).

- [ ] **Step 3: GREEN + commit** — `fix(engine): instance caps honour the hero floor and the ordering they were meant to follow`

---

### Task 5: The build-path sweep (spec §5), each with a before/after timing

**Files:**
- `packages/engine/src/geometry/factory.ts` (modifier intermediates off `totalVertices`; typed-array coercion before keying; pre-flight for `sdf`/`boolean`), `solids.ts` (hoists; `resampleProfile` monotonic), `implicit.ts` (`sdCylinder` without array literal), `modifiers.ts` (chain-aware `recomputeNormals`; packed-integer keys in `weld`/`simplify`; CSR adjacency in `smooth`), `patterns.ts`/`profiles.ts` (memoize behind existing structural keys)
- Test: `packages/engine/tests/geometry.test.ts` (each hoist keeps its shape tests green; the sweep's own proof is `buildTimings`)

**Interfaces:**
- Produces: `buildTimings()` before/after figures per touched builder, recorded in the commit message (Q10).

- [ ] **Step 1: Baseline** — run the reference model build, print `buildTimings()` table (repeat 3×, take medians) into the ledger.
- [ ] **Step 2: The §5 items, one logical commit: "perf(engine): the build path pays for construction, not ceremony"** — each item keeps every existing geometry test green; `register()`'s pre-flight moves the ceiling check BEFORE allocation per its own header promise.
- [ ] **Step 3: After-table** — same benchmark; the commit message carries the per-builder deltas. No table, no commit.

---

## Phase gate

`pnpm verify` green. Then: ledger Task 1–5 closed with figures; the Phase 5/6 batch (predicted tier plan + LOD + honest rungs) is the next plan.
