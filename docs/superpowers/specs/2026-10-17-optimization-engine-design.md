# Optimization Engine — Design Spec

**Date:** 2026-10-17
**Status:** approved in conversation, awaiting spec review
**Reported requirement:** "It should not lag when zoomed in, and it must run really well on potato
devices — same lesson, same quality. Use advanced, efficient techniques — not just working code."

---

## 0. What this spec is

The platform already has an optimization engine: `DEVICE_BUDGETS`, `QUALITY_LADDER`,
`priceModel`, the adaptive ladder in `sandbox-worker.ts`. Its _architecture_ is right — admission
prices before allocation, degradation is tier-governed and announced, no part is ever removed. Its
_implementation_ is shallow: three of its rungs do nothing, the one that would help most is a
no-op, its decimation shatters geometry, its raycast walks every triangle, and its frame path
allocates ~7,450 objects per second at idle.

So this is not a rebuild. It is making the existing engine do what it already claims to do — and
making every claim verifiable.

Distinguishing feature of the work: **techniques are adopted only where they show up in the
numbers.** `Build_Docs/08` states the meta-rule plainly — _"a technique that isn't showing up in
the numbers is complexity without benefit and gets removed."_ Every phase below names the number
it moves. A phase that cannot name its number is not in this spec.

### 0.1 Evidence basis — measured vs. read

Findings marked **M** (measured) come from the existing harness: `frame-cost.test.ts`,
`check-compositor.mjs`, the topic battery, or a hand-run recorded in a commit message. Findings
marked **R** (read) are derived from source and are treated as hypotheses until a phase's test
confirms them. No commit claims a speedup it has not measured.

| Finding                                                                                          | Basis                                                                |
| ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------- |
| Frame path allocates a frame-context Proxy + guaranteed-miss `Map` per frame                     | R + `frame-cost.test.ts` baseline                                    |
| Raycast is O(total triangles), per pointer event                                                 | R (no `firstHitOnly`, no BVH, intersect all)                         |
| `three-mesh-bvh` and `three-bvh-csg` are declared in `PLAN.md` §B and absent from every lockfile | M (grep)                                                             |
| `geometryDetail` rung is a no-op; ladder can never reach `flatShading`                           | R                                                                    |
| Decimation is index-stride; shatters when `flatShading` engages                                  | R                                                                    |
| `admission` credits a static merge `realize` never performs                                      | R                                                                    |
| Hero instance cap breaches `HERO_FLOOR`                                                          | R (`admission.ts:203`, `Math.max(3,…)`)                              |
| QEM decimation reduces cost without silhouette loss                                              | industry (Garland & Heckbert 1997) — to be confirmed perPart by test |

---

## 1. Invariants — the contract

These are assertions, not prose. Q-numbers continue the series from
`2026-10-17-render-performance-design.md` so the two specs read as one programme.

| ID      | Invariant                                                                                                                           | Enforced by                 |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| Q1      | Every declared parameter that renders a value still renders the same value after any rung                                           | audit sweep                 |
| Q2      | Geometry a learner sees is never _less_ correct than before any rung                                                                | Phase 4 floors + mesh tests |
| Q3      | No decimation path may reduce a part below `RECOGNIZABILITY_FLOOR`/`HERO_FLOOR`                                                     | Phase 4/5 admission tests   |
| Q4      | Decimated output contains zero degenerate triangles and zero newly-disconnected surface                                             | Phase 4 unit tests          |
| Q5      | `stats.triangles` reports what is actually drawn, not what was authored                                                             | Phase 5 realize test        |
| Q6      | No user-visible notice describes an effect that does not occur                                                                      | Phase 6 rung tests          |
| Q7      | A part's info text never disagrees with what is drawn                                                                               | Phase 5 hero-cap test       |
| **Q8**  | **The part list a learner can select is identical on every tier** — the lesson is the same, only its triangle budget differs        | Phase 4 potato e2e          |
| **Q9**  | **First frame on a low-tier device is already correct** — the tier's realization plan is derived at load, not discovered by lagging | Phase 5 predict test        |
| **Q10** | **Every optimization technique adopted in this programme has a number that moved**                                                  | per-phase commit message    |

Non-negotiable architecture, unchanged from the prior spec:

| ID  | Invariant                                                                           | Source                      |
| --- | ----------------------------------------------------------------------------------- | --------------------------- |
| A1  | The server never renders a pixel                                                    | `PLAN.md:32-47`             |
| A2  | Untrusted code's capability set is unchanged by this work                           | `PLAN.md:18-24`             |
| A3  | `engine` and `sandbox` stay DOM-free                                                | `eslint.config.js:16-20`    |
| A4  | The API surface stays a single reflected source of truth                            | `api-surface.ts:79-122`     |
| I1  | The 20 s build / 50 ms frame sandbox deadlines are never relaxed to buy performance | `contracts/wire/sandbox.ts` |

---

## 2. The optimization engine as it stands

A reader needs this map before the phases make sense.

```
authored manifest ──priceModel(manifest, tier)──▶ AdmissionVerdict + RealizationDecisions
                                                        │
live frame loop ──monitorLadder(frameMillis)──▶ ladderStep() ──▶ rung applied
                                                        │
            priceModel  =  static plan   (what COULD be cut, by data)
            monitorLadder =  dynamic plan (what IS cut, by behaviour)
```

`admission.ts` walks `QUALITY_LADDER` in order — postProcessing, shadows, particles, instances,
geometryDetail, draw calls, flatShading, physicsSubsteps — producing a _plan_. `realize.ts`
consumes it. A second, live ladder in `sandbox-worker.ts` re-walks `remainingRungs()` when
sustained frame pressure is measured, with 90-frame hysteresis.

Three facts break this today:

1. **The two ladders disagree about order.** The live ladder inherits `remainingRungs()` but the
   static plan's least-damage-first ordering is fixed, not cost-derived — so a device whose
   bottleneck is _draw calls_ still sees _pixel ratio_ cut first.
2. **Rungs lie.** `geometryDetail` marks itself applied and returns (blocking every rung after
   it); the draw-call rung credits a merge `realize.ts` never performs; the substeps rung emits a
   notice `PhysicsWorld` ignores.
3. **Nothing measures where build time goes.** `GeometryFactory` counts hits and misses but
   neither records nor exposes per-builder cost, so "the SDF is slow" is folklore.

---

## 3. Techniques — what "advanced" means here, and where it is _not_ wanted

Each technique names the number it moves and the phase that installs it. This section is the
spec's answer to "use advanced techniques — not dumb working code": an advanced technique that
cannot name its number is rejected on sight.

| Technique                                                                                                                                                 | Moves         | Phase       | Why not the simpler thing                                                                                                                                                                                                                   |
| --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **QEM edge collapse** (Garland-Heckbert quadric matrices, lazy heap)                                                                                      | Q2, Q3        | 4           | Index-stride produces isolated non-adjacent triangles and fails Q4 by construction. Vertex clustering (`simplify`, already present) is documented fast-but-low-quality; it cannot hold a hero blade's silhouette at 0.55 keep.              |
| **Screen-space LOD** — swaps by projected screen coverage, not camera distance                                                                            | Q8, L2        | 5           | Distance-scaled LOD is wrong for any FOV the learner can set; `Build_Docs/08` mandates screen-space. Cost per frame: one `project()` per part per frame → amortized to every 4th frame per part (staggered, per `08`'s "amortize by cost"). |
| **Lazy per-geometry BVH** — `three-mesh-bvh`, `acceleratedRaycast`, `firstHitOnly`, built on first raycast, only for meshes ≥ `BVH_MIN_TRIANGLES` (2 000) | L2 (hover), 3 | 3           | A BVH built per geometry at realize time costs build budget on parts never picked; the threshold keeps the build cost off models that don't need it and keeps the worker chunk honest (measured before/after, per Q10).                     |
| **Zero-allocation frame path** — hoisted context, module scratch, dirty flags                                                                             | L3            | 2           | GC scavenges fast, but steady-state churn is what turns a battery warm, and `08` mandates zero allocation in the hot path.                                                                                                                  |
| **Predicted tier plan** — realization decisions derived at load from measured manifest cost                                                               | Q9            | 5           | Starting at full quality and stepping down after 90 frames is precisely the reported first-second lag.                                                                                                                                      |
| **Cost-ordered ladder** — rung _order_ re-ranked by measured per-part cost attribution, order still least-damage-first within a tied cost                 | Q10           | 5           | A full PID controller (rejected) buys its gain only after cost attribution exists and has no number today; re-ranking an existing ladder gets most of it and keeps `08`'s ordering contract.                                                |
| **Packed-integer mesh keys, CSR adjacency** in `weld`/`simplify`/`smooth`                                                                                 | build L6      | 4           | Template-literal string keys allocate a string per vertex pair; `number[][]` of length V allocates V arrays. Already planned in the prior spec §Phase 5 and still undone.                                                                   |
| **Structural cache with `nextClosureId`** — closure identity via `WeakMap` counter                                                                        | correctness   | 7 (`patch`) | Already the engine's own pattern (`factory.ts:1611`); `patch` alone skips it. The fix is to use the existing mechanism, not invent one.                                                                                                     |

**Deliberately rejected**, with the reason recorded so nobody re-proposes them:

- **WebGPU / WebGPURenderer** — Three.js's own guidance keeps WebGL2 as the recommended renderer;
  migrating a 188-member scene API, Rapier and determinism requirements onto TSL is unproven-gain
  risk. (Carried from the prior spec §6.)
- **A PID/ML frame controller** — needs field telemetry this platform does not collect yet; the
  hysteresis ladder plus cost ordering reaches comparable smoothness with no new failure mode.
- **`n`. `sharedArrayBuffer`-parallel decimation** — violates A2's capability floor and buys
  nothing at 150k triangles.
- **Worker-pool geometry building** — the build already happens off the main thread in the
  sandbox worker; a pool adds scheduling complexity for a phase-4 build cost that per-builder
  timing may prove does not matter.

---

## 4. Phases

Each phase is one commit. Each names the number it moved. `pnpm verify` green before each.

### Phase 1 — Baseline and in-flight work

Commit the author's uncommitted work (prompts v7, `dev-console.ts` and its wiring in
`sandbox-host`/`sandbox-worker`, landing CSS, `generate-dialog`) after completing anything
half-done; delete the four scratch `*.tmp.mjs` scripts at the repo root. Run `pnpm verify`; record:

- `frame-cost.test.ts` bytes/frame **(L3 baseline)**
- reference-model build wall-clock ms **per-builder ms cannot be recorded yet — the stat arrives
  in Phase 2; Phase 1 records whole-build time only**

Recorded in the commit message. Every later phase cites these numbers.

### Phase 2 — Frame path: zero allocation

Targets L3. Host-side only; A2 untouched.

- `createFrameContext`'s proxy handler and `partRefCache` hoist to `SceneBuilder` scope;
  invalidated on part mutation only
- `applyMotions` gets module-level scratch tuples/quaternions; the `?? {const:0}` literals become
  frozen module constants
- one `params` record on `WorkerState`, rebuilt only in `setParameter`
- `resetMotionDrivenParts` aliases `base.position` (safe: `applyMotions` assigns fresh arrays)
- `syncTransforms` becomes dirty-checked via the builder's `noteWrite` channel set
- `setParameter`'s synchronous extra frame becomes a dirty flag consumed by the next `renderFrame`
- `orbit`/`pan`/`zoom` coalesce to one update per `renderFrame`; `pan` reads `matrixWorld` not
  `matrix`; the two `Vector3` hoist
- physics probe path: one `linvel()` call, cached `mass()`, precomputed key strings, in-place
  `lastGood*` mutation, `probes: undefined` when empty
- **`GeometryFactory.register()` gains per-builder timing** (`Map<builder, ms>`), exposed via
  `buildTimings()`; surfaced in the frame benchmark and the code-view diagnostics modal

Boundary: `frame-cost.test.ts` assertion updated with the new measured number and 25 % headroom.
Phase gate: allocation near-zero per frame; no functional test regresses.

### Phase 3 — Picking and camera responsiveness

Targets the reported zoom lag. The number: hover raycast cost on the reference turbofan
(334k triangles), measured in the new `raycast-cost` Node benchmark, before/after.

- install `three-mesh-bvh`; adopt `acceleratedRaycast` + `firstHitOnly`
- **lazy BVH build**: on first raycast against a mesh whose `geometry.index.count/3 ≥
BVH_MIN_TRIANGLES = 2000`; `dispose()` on model unload, tracked per geometry in a `WeakMap`
- the module-level `computeBoundsTree`/`disposeBoundsTree`/`acceleratedRaycast` setup lives in
  `sandbox-worker.ts` behind one helper so the fallback below is a two-line swap
- fallback (documented, not implemented unless measurement demands): per-mesh bounding-sphere
  pre-rejection using the manifest's already-measured `boundingRadius`
- bundle gate: worker chunk size before/after recorded; if the growth exceeds 5 % compressed, the
  fallback is taken instead and `Q10`'s number names the rejection

### Phase 4 — Real decimation: QEM edge collapse

New `packages/engine/src/geometry/decimate.ts`. Targets Q2–Q4 and the geometryDetail rung.

- quadric error metrics per vertex; lazy pairing heap keyed on error; boundary preservation via
  an edge-weighted penalty; positions only — normals are recomputed once at the end (see §5, the
  `carry()` note)
- API mirrors the existing modifiers exactly: `decimate(mesh, { keep: 0.55 }) → MeshData`, so it
  slots into `modifiers` and the `structuralKey`/cache path with no new surface (`A4`)
- unit tests: zero degenerate triangles; zero newly-disconnected components; floors respected;
  reference turbofan's fan-blade silhouette survives `keep: 0.55` (asserted on projected bounds,
  not eyeballed); deterministic given the same input
- `admission.ts`'s instance-cap path and `decimationOrder` fixed to price from post-cap counts
  and honour `decimationOrder`'s non-hero-first policy (the instance path currently ignores it)

### Phase 5 — Admission: the tier plan is predicted, then measured

Targets Q9, Q10 and the L2/ladder gap. `admission.ts`/`sandbox-worker.ts`.

- `priceModel` derives the tier's initial `RealizationDecisions` from the manifest's measured
  cost — a potato's first frame is already inside budget, rather than arriving at full quality
  and stepping down after 90 frames
- the live ladder's rung _order_ is re-ranked by measured per-builder/per-part cost attribution
  (from Phase 2's `buildTimings` + manifest `boundingRadius`), order still least-damage-first
  within a tie; hysteresis and both-direction movement unchanged
- screen-space LOD for hero and repeated parts: 2–3 `decimate()` variants per part, `THREE.LOD`
  children, swapped by projected screen coverage measured every 4th frame per part (staggered);
  picking unaffected (`firstHitOnly` on the LOD's raycast)
- the `geometryDetail` rung drives QEM decimation and stops returning early, so the ladder can
  finally reach `flatShading`; the "flatShading exactly when decimation engages" coupling is
  deleted
- Q9 test: a Node benchmark that prices the reference model at tier `low`, realizes, and asserts
  the first rendered frame's triangle count is within the low-tier budget — before any ladder
  step has run

### Phase 6 — Honest rungs, honest numbers

Targets Q5, Q6. One rule: **a rung that does not change a field of `RealizationDecisions` may
not emit a notice, and a field that nothing reads is deleted.**

- static-merge: _implement_ merging for `staticGeometry` parts in `realize.ts` (Build_Docs 08
  mandates the technique class; per-part selection is unnecessary by construction) — or, if the
  measured merge saves fewer than 10 % of draw calls on the reference model, stop crediting it
  and record that number in the commit
- `physicsSubsteps`: `PhysicsWorld` honours `DEVICE_BUDGETS[tier].maxSubsteps` and
  `manifest.physics.world.substeps`, or the rung is deleted and `admission` stops pricing it
- `postProcessing`/`maxPixelRatio`: honoured by the renderer setup or dropped from the decisions
- `stats.triangles`, `stats.drawCalls` report realized values; `PartNode.decimated` stops being
  hardcoded `false` at its three authoring sites
- the status bar renders what is already computed and shown nowhere: `degradedRungs`,
  `physicsMillis`, `cacheHitRate`, `effectiveTier`, `quality` — Build_Docs 08: "the engine
  surfaces its own cost"

### Phase 7 — Defect repairs: correctness a learner can see

Each item is independently testable; each is small enough to be one commit, batched into one
phase for review economy. The number is trivial (a failing test flips to passing) — for these,
Q10's "number" is the regression test itself.

**Geometry**

- `geom.patch`: key its cache entry with `nextClosureId(spec.heightAt)` — two `patch` calls with
  the same profile+plane and _different_ relief functions currently return the first one's mesh
  (`factory.ts:1118`)
- `primitives.polyhedron`: add the `dodecahedron` branch the docstring promises (or shrink the
  docstring and refuse the name with a `GeometryError` pointing at the real set)
- `extrude.depth`: require `> 0` (`requireFinite` without a `min` accepts 0 and negatives today)

**Physics** — the 2026-10-12 plan's unimplemented load-bearing fix

- collider inference from `geometry.builder` + measured `geometry.boundingRadius` (the word
  "geometry" currently appears in `physics-world.ts` only in comments, and a collider defaults
  to a hardcoded 0.5 m sphere)
- the degrees-for-radians quaternion write at `physics-world.ts:393` reuses the correct
  conversion at `motions.ts:204-221`

**Sandbox**

- `maxCallDepth: 512` becomes real: a depth counter on the injected guard, tripping a
  `GuestBudgetError` variant; the limit is currently referenced by nothing in the repo
- `instrument.ts` guards `ArrowFunctionExpression` bodies as it guards function declarations
- `arguments` leaves `allowedIntrinsics` (a false accept that costs a generation at runtime)
- `unguardable_loop` is emitted or deleted from `GateViolationKind`

**Server**

- `config.security.csp` and `forceHttps` are applied in `app.ts` (resolved and printed in the
  startup banner, implemented nowhere)
- `snapshotUrl` is persisted on the row; `PostgresStore.delete` returns the delete's truth; the
  `pg` pool is ended on shutdown; drain notify reaches open generation streams
- viewer-facing sincerity is Phase 6's business; the server's honesty items above are deployment
  correctness, not optimization

**Viewer**

- bind the advertised shortcuts (`S` → story mode) or stop advertising them; same for the
  `Ctrl+G`/`Ctrl+P` tooltips
- fix the broken `./authoring` export map target (`src/authoring/index.ts` does not exist)
- delete the dead `chat-panel.svelte`/`quiz-modal.svelte` trees; export or delete the orphaned
  862-line `WATCH_MODEL_SOURCE`

### Phase 8 — Motion honesty

`flowAlongPath` is schema-accepted, audited, priced — and never flows, because
`pointOnPath` is deliberately unset (`sandbox-worker.ts:925`).

- implement `pointOnPath` in the worker as arc-length parameterisation over the declared
  `PathDecl` (uniform tangent frames are unnecessary — the motion only needs position), or
- reject `flowAlongPath` at declaration with a naming-the-gap `SceneError`, and drop it from the
  API reference and audit vocabulary

Pick one here, now: **implement `pointOnPath`**, position-only, as an arc-length parameterisation
over the declared `PathDecl` (~60 lines, reusing the path representations `solids.ts` already
builds for `sweep`). The schema, audit and generation prompt already promise this capability, so
rejecting it would shrink a surface the prompt advertises; the honest gap to close is the
sampler, not the declaration. Uniform tangent frames are explicitly out of scope — the motion
consumer needs position only.

`SceneBuilder.dispose()` clears every registry it claims to own (it currently leaves `metrics`,
`motions`, `paths`, `lights`, `shots`, `story`, `quiz`, `components`, `warnings`,
`sweepStates`, `observedWrites` alive); verified as hygiene rather than leak (a fresh builder
per build), fixed anyway because the file's own header promises it.

### Phase 9 — Memory flat over cycles

Targets `Build_Docs/08`: "generate → load → generate again, dozens of times, must not grow."

- the capped point-cloud geometry and fallback-material caches are tracked and disposed
  (`realize.ts:327-342, 311-313, 459-470` — a `WebGLBuffer` leaks per load cycle today)
- N-cycle heap test in the frame benchmark harness (Node) asserting flat heap over 10 cycles

### Phase 10 — The potato gate

Acceptance, not new code. A Playwright project on a throttled CPU profile (CDP
`Emulation.setCPUThrottlingRate` at 6×) loads the reference model and asserts:

- the fps floor holds at low tier;
- I8: the part list is identical to the unthrottled run — same parts, same selectability;
- no notice appeared that describes an effect the tree does not perform (Q6, e2e-level);
- memory (via `performance.memory` smoke, non-asserted) does not grow across two model reloads.

Full `pnpm verify` (desktop + phone + potato profiles) green.

---

## 5. Performance techniques inside the engine build path

Adopted alongside Phase 4 because they are the same commit's subject matter, from the prior
spec's Phase 5 and still undone:

- `carry()`'s dead `recomputeNormals` flag becomes chain-aware: one recompute per modifier chain,
  not N
- modifier intermediates stop being counted against `totalVertices` (`factory.ts:1592, 295`)
- `geom.mesh`/`geom.points` inputs coerce to typed arrays _before_ keying, so the 32-sample
  digest branch applies
- `makeProfile`/`makePath`/`pattern.*` memoize behind the structural keys they already compute
- `triangulateProfile`/`ensureCcw` hoist out of the two `addCap` call sites (`solids.ts:72`)
- per-vertex `cos`/`sin` hoist out of `revolve`/`extrude`/`sweep`'s `place()` (`solids.ts:144-150`)
- `resampleProfile`'s `span` cursor becomes monotonic (O(n²) → O(n), `solids.ts:441`)
- `sdCylinder` uses `len2`/`len3` rather than an array literal per SDF sample (`implicit.ts:52-58`)
- `register()` pre-flights `sdf`/`boolean` cost so the vertex ceiling is enforced _before_
  allocation, as the file's own header promises (`factory.ts:277` vs `:290`)

---

## 6. Explicit non-goals

| Not doing                                            | Why                                                                                                                                                                              |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| WebGPU                                               | Unproven gain against a 188-member API + Rapier + determinism (§3).                                                                                                              |
| Sandbox capability additions                         | A2. Every change here is host-side or builder-side.                                                                                                                              |
| PID/ML frame controller                              | No field telemetry to learn from; hysteresis ladder + cost ordering is the measured ceiling available today.                                                                     |
| Tier-aware _generation_ (different prompts per tier) | The lesson must not differ by device; `Build_Docs/08` says degrade, never re-author. Revisit with field data.                                                                    |
| Annotations, settings, export/video, QR              | Orphaned viewer features, ~600 lines of CSS with no markup. A different project.                                                                                                 |
| The live server-side pipeline rewrite                | Out of scope by choice; the honest-rungs items in Phase 7 that touch the server do so because they are deployment correctness, not because the pipeline is being re-architected. |
| `three-bvh-csg` install                              | No model in the battery uses booleans today; tracking per Phase 4's timing stat and adding when a number demands it.                                                             |

---

## 7. Ordering and dependencies

```
1 baseline ─▶ 2 frame path ─▶ 3 picking/BVH ─▶ 4 QEM ─▶ 5 admission+LOD ─▶ 6 honest rungs
                                                                        │
7 defect repairs ═══════════════════════════════════════════════════════╧▶ 8 motion, 9 memory, 10 gate
```

- **1 before everything** — the numbers every claim cites.
- **2 before 3** — a zero-allocation path makes the BVH's raycast cost visible instead of lost in
  noise, and the `buildTimings` stat from 2 is what ranks the ladder in 5.
- **4 before 5** — LOD variants are made by QEM; admission's floors are meaningless without a
  decimator that respects them.
- **5 before 6** — honest rungs must exist as _working_ rungs before they can be honest ones.
- **7 is parallel-safe** across 2–6 (its items touch different files), but lands after 5 so the
  collider and physics fixes are not invalidated by decisions still changing.
- **10 last** — the gate asserts contracts 1–9 built.

---

## 8. Workflow

- Phases 1–6, 8, 9 and 10 land as one commit each. Phase 7 is the deliberate exception: its items
  are unrelated to each other, so it lands as review-sized commits — one per defect or defect
  group — inside the phase. The commit message names the invariant (Q-number) it protects and the
  number it moved.
- `pnpm verify` green before every commit — secrets, config, compositor, format, lint,
  typecheck, unit, build, e2e.
- TDD on the engine work: the failing test (degenerate triangles, floor breach, wrong `patch`
  collision, unguarded arrow loop) precedes the fix, per the repo's own standing rule that a
  regression test must demonstrably fail against the old code.

No commit bundles a refactor with a behavioural change. No commit relaxes a deadline in
`contracts/wire/sandbox.ts`.

This spec covers the whole programme, but the implementation plan may follow the repo's own
convention of one plan file per phase (as `2026-10-17-phase-0-1-render-performance.md` did) if a
single plan grows past reviewable size. Phases 2+3 and 4+5 are the likely split points.
