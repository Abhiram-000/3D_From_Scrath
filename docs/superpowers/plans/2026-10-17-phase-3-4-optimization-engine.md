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

1. **Pause-flake** — a paused model that re-renders forever because an invalidation fires every frame (e.g. hover set without a change check). The gate must go truly still: e2e asserts FPS 0 sustained, then recovers on interaction. _(Task 1)_
2. **Degenerate input to decimate** — a 1-triangle mesh, and `keep` ≥ 1 (no-op) and `keep` ≤ 0 (floor). _(Task 2)_
3. **Decimation on indexed AND non-indexed meshes** — a non-indexed mesh must be rejected loudly, not silently skirted. _(Task 2)_
4. **Reuse of vertex normals across a collapse** — normals for a cached `cacheKey@keep` entry must come from the DECIMATED geometry, carried through `toBufferGeometry`'s "skip recompute when normals exist" path. _(Task 3)_
5. **Silhouette** — hero-part projected bounds at `HERO_FLOOR` must stay within a tolerance of the original's. _(Task 2)_

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
  const quiet = {
    paused: true,
    autoRotate: false,
    cameraDirty: false,
    needsRender: false,
    hoverPending: false,
  };
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
if (renderGate(gate)) {
  /* physics step, guest run, declared motions, sync, cast, render */
}
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

**Population requirement — the operator is built for AI-generated geometry, not engine-made geometry.** Everything the topic battery's models actually produce (and everything the schema permits them to produce) is fair input: non-manifold edges, unindexed-but-degenerate vertex soup, zero-area triangles, NaN vertices that survived sanitization, duplicated positions, `keep` values at both clamp bounds. Two hard rules hold across all of it:

- **Fail-soft, per part.** Decimation that cannot handle a mesh returns the ORIGINAL mesh unchanged — the caller (realizer, admission ladder) logs a notice naming the part and keeps the part at full cost rather than dropping it. `decimate` throwing is a contract violation: units pin the adversarial fixtures to `not.toThrow()` AND `toBe(original)`-equivalent output. A simplify bug must cost a triangle budget, never a lesson.
- **Proven over a corpus, not a fixture.** The operator's own suite carries adversarial meshes (below); Task 6's generated-model corpus carries the end-to-end proof over the domain grammar.

- [ ] **Step 1: RED — the contract suite**

- on a procedurally built indexed sphere (segmented, known triangle count), `keep: 0.5` produces triangle counts in `[0.49, 0.51]` of original
- **zero degenerate triangles** (each kept triangle has positive area)
- **zero newly-disconnected surface**: union of kept triangles' vertex set is connected when the source was (existing `validateMesh` reports components — reuse its counting)
- normals come from `computeNormals` of the decimated positions when the source had normals (else omitted, per MeshData's optional contract)
- source `MeshData` is byte-identical after the call (no in-place mutation)
- deterministic: two runs, identical bytes
- reject non-indexed `MeshData` with a `GeometryError` naming the repair (`subdivide`/`mesh` with indices)
- **adversarial fixtures, each pinned to fail-soft output** (no throw, plus the stated result):
  - a non-manifold mesh (two triangles sharing one edge twice)
  - a soup of zero-area triangles (collapsed vertices)
  - a mesh with a NaN position the sanitizer missed (one poisoned vertex)
  - duplicated positions (two vertices, same coordinates, distinct indices)
  - a single-triangle mesh, and a two-triangle mesh where `keep: 0.5` must keep ≥1 triangle
  - `keep: 1` (no-op, identical topology), `keep: 0.0001` (clamps to the floor, still returns a valid connected-if-source-connected result)
- Review Focus 2/5: `keep: 1` returns an equivalent mesh; a hero sphere at `keep: 0.55` keeps its projected silhouette within 5%

- [ ] **Step 2: Implement** — quadric per vertex from its incident triangle planes (area-weighted), lazy pairing heap over unique edges, optimal-target solve per pair (6×6 null-space with fallback to midpoints), boundary preservation via edge flags from boundary-angle detection, position writes into a fresh `Float32Array`, index rebuild once at the end. Where the quadric system is singular or the mesh violates an assumption the fixtures name, return the input unchanged — the operator's failure mode is "no benefit", never "corruption".

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

### Task 6: The generated-model corpus gate — proving the space, not the fixture

The reference turbofan is the trusted fixture; it is not the population. This task makes every
guarantee in the programme hold over the model space AI generation actually produces, in three
enforcement layers whose population is the domain grammar, not one hand-built model.

**Files:**

- Create: `packages/engine/tests/corpus/*.ts` — one program per domain-grammar row (mechanism,
  circuit, field, molecule, biology, orbital, math, architecture, data/systems, economics,
  history/geography, everyday), each exercising a different engine path: SDF blends, booleans,
  4-modifier chains, ≥1000-instance sets, ≥50k-point clouds, raw computed `mesh`, a
  zero-parameter model, a `runsWhilePaused`-only model, and a guest-`onFrame`-only model with no
  declared motions (the render gate's hardest case — a still gate that freezes a self-animating
  model is invisible to the turbofan, which declares motions).
- Create: `packages/engine/tests/corpus-gate.test.ts` — the harness: for each program, the real
  static gate → `prepareProgram` → `authorModel` → `priceModel` at every tier → component-wise
  realization → the applicator at 10 000 frames.
- Modify: `tests/e2e/viewer.spec.ts` — a corpus pass that loads each program through
  `window.__edu3dHost.load(...)` on the phone project and asserts the lesson-level invariants.

**Interfaces:**

- Consumes: everything the programme built — `buildTimings`, the churn gate, `decimate`,
  `priceModel`, `renderGate`'s stillness contract.
- Produces: per-program, per-tier figures (build ms, triangles, draws, decimation decisions,
  churn scavenges, per-builder timings) written to the ledger and re-generated on watch.

**Corpus asserts, per program, per tier:**

1. builds inside `SANDBOX_LIMITS.buildDeadlineMs` with the plan's own budget to spare;
2. admission applies decisions exactly as priced — hero floors hold per part (`Q3`), no part
   removed, every parameter still bound (`Q1`);
3. decimated output per part has zero degenerate triangles and no disconnect (or fail-soft
   original with a notice, per Task 2);
4. 10 000 applicator frames churn under the gate's ceiling, and the poses stay finite (`Q2`'s
   NaN rule at distance);
5. the zero-motion and `onFrame`-only programs freeze _correctly_ under the render gate when
   paused (frames presented = 0 with `paused` true and nothing dirty; self-animated parts hold —
   and RUN when playing, proving the gate did not over-still them);
6. `buildTimings` names where each build's time went — the corpus is also where the next
   phase's tier-plan prediction gets its data.

**e2e asserts, per loaded program, phone project:**

- the full part list renders and every part is selectable by its list button;
- pause stills the presentation (fps drains to 0), interaction revives it;
- the watchdog never fires inside the budget window (no "stopped responding" for a passing
  model);
- reported triangles match the loaded program's realization height, not a cached previous model.

**Deliberately out of scope and named as such:** runtime behavioral diversity cannot be fully
enumerated by any corpus. The sandbox's existing nets — 20 s build deadline, 50 ms frame deadline
with overruns → pause-with-explanation, NaN quarantine, watchdog terminate with the page alive —
are the layer that makes an unseen model degrade gracefully instead of hanging a tab. The corpus
proves the common; the nets forgive the tail.

- [ ] **Step 1: Author the corpus**, each program passing the real gate as committed source (the
      battery topic list is the vocabulary; `Build_Docs/00`'s grammar table is the shape).
- [ ] **Step 2: RED** — run the harness; expect at least one program to move a floor (that is the
      point). Each failure is either a program bug (fix the fixture) or an engine finding (fix the
      engine, RED→GREEN). Record both kinds in the ledger.
- [ ] **Step 3: GREEN + e2e pass** — `pnpm test corpus-gate` then the phone e2e pass.
- [ ] **Step 4: Commit** — `test: the corpus gate — every guarantee, proven over the grammar, not one turbofan`

---

## Phase gate

`pnpm verify` green. Then: ledger Task 1–5 closed with figures; the Phase 5/6 batch (predicted tier plan + LOD + honest rungs) is the next plan.
