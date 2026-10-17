# Render & Build Performance — Design Spec

**Date:** 2026-10-17
**Status:** awaiting review
**Branch:** `fix/production-gap-closure`
**Reported symptom:** janky orbit/camera interaction; general viewer lag; long freezes on model build.

---

## 1. Problem statement

The viewer's camera interaction feels janky, models allocate ~4,800 objects/second at idle,
some models freeze the build for minutes with no diagnosable cause, and four code paths emit
output that is *factually wrong* about the model on screen.

This spec covers six phases, each landing as its own commit, ordered by cost-to-risk ratio.

### 1.1 Evidence basis — read this before trusting any number

Every finding below was derived from reading source, not from profiling a running app.
Magnitudes are **estimates**, not measurements. That is precisely why Phase 0 exists:
it builds the measurement net that every later phase must report against. No commit in
phases 1–6 should claim a speedup it has not measured.

Two findings were verified by hand against source before this spec was written
(§3.1, §3.2); the rest are single-sourced from a code audit and are treated as hypotheses
until Phase 0's harness can confirm or refute them.

---

## 2. Invariants — the contract this work must not violate

These are the definition of "done". They are written as assertions because a contract
expressed as prose drifts.

### 2.1 Model quality may improve, never degrade

| ID | Invariant | Enforced by |
|----|-----------|-------------|
| Q1 | Every declared parameter that renders a value still renders the same value | Parameter-leverage sweep in `audit.ts`; existing |
| Q2 | Geometry a learner sees is never *less* correct than before | Phase 6 decimation + hero-floor tests |
| Q3 | No decimation path may reduce a part below `RECOGNIZABILITY_FLOOR` / `HERO_FLOOR` | Phase 6 admission tests |
| Q4 | Decimated output contains no degenerate triangles and no newly-disconnected surface | Phase 6 mesh tests |
| Q5 | `stats.triangles` reports what is actually drawn, not what was authored | Phase 6 realize test |
| Q6 | No user-visible notice may describe an effect that does not occur | Phase 6 rung tests |
| Q7 | A part's own info text may never disagree with what is drawn | Phase 6 hero-cap test |

**Q7 currently fails.** A `hero: true` radial array can be capped to 3 of 22 placements
(`admission.ts:203`, `Math.max(3, ...)`) while its info panel still reads `Blades: '22'`.
This is a live correctness bug on low-tier devices, and the user has approved fixing it.

### 2.2 "No lag" is a number, not a feeling

| ID | Metric | Current | Target |
|----|--------|---------|--------|
| L1 | Camera-gesture → visible-pixel latency | 1–2 frames + N redundant `updateCamera` calls between frames | ≤1 frame, no redundant camera recomputation |
| L2 | Dropped frames during a continuous 5s orbit, mid tier | unmeasured, suspected significant | 0 — **manual/real-device criterion, see §2.2.1** |
| L3 | Steady-state allocations, model running, no input | ~7,450 objects/s | <200/s |
| L4 | `renderer.render` calls/sec while paused + static + not orbiting | 60 | 0 |
| L5 | Worker bundle, first load, physics not declared | ~4 MB uncompressed IIFE | Rapier absent from the initial chunk; total <2.5 MB compressed |
| L6 | `geom.sdf` @ res 160, and `geom.boolean` on 100k-vertex inputs | unbounded; ~14 min; only `worker.terminate()` can stop it | terminates inside the 20 s build deadline with an actionable message |
| L7 | Main-thread `getBoundingClientRect()` per `pointermove` | 1 (up to 120/s) | 0 |

#### 2.2.1 Which targets CI can actually verify

Playwright runs headless Chromium with `--use-gl=angle --use-angle=swiftshader`
(`playwright.config.ts`), i.e. **software rasterization**. Frame timings and dropped-frame
counts measured there are meaningless, and would be actively misleading if asserted.

So the targets split:

| Verifiable in CI | Not verifiable in CI |
|---|---|
| **L3, L4, L6** — via the §4.2 Node benchmark (real V8, real `Date.now()`, real GC) | **L1, L2, L5** — require a real GPU and real network |
| **L7** and the *causes* behind L1/L2 — via the §4.3 static compositor lint | |
| **Q1–Q7** — via the §4.4 quality-invariant tests | |

**L1, L2 and L5 are therefore verified by (a) eliminating their static causes and (b) a
one-time manual measurement on real hardware recorded in the phase's commit message.**
The cause-elimination is fully automated and is what CI enforces; the residual measurement is
documented, not asserted. This is stated up front so no CI failure is later misread as a
regression when it is in fact the harness doing its job.

### 2.3 Non-negotiable architecture

| ID | Invariant | Source |
|----|-----------|--------|
| A1 | The server never renders a pixel | `PLAN.md:32-47` |
| A2 | Untrusted code's capability set is unchanged by this work | `PLAN.md:18-24` |
| A3 | `engine` and `sandbox` stay DOM-free | `eslint.config.js:16-20` |
| A4 | The scene API surface stays a single reflected source of truth | `api-surface.ts:79-122` |

**A2 constrains Phases 2–6 heavily.** Performance work that adds a capability to the sandbox
is out of scope. Scratch-object hoisting, dirty flags and cached snapshots are all *host-side*
or *builder-side* and therefore safe. Adding a `guard` tick into `GeometryFactory` (Phase 5) is
safe because it threads an existing handle into existing engine code, not a new capability.

---

## 3. Root causes, ranked

### 3.1 `.ambient-layer` re-blurs two large surfaces over the canvas, every frame — VERIFIED

`viewer/+page.svelte:163-164`:
```js
ambient = new Ambient({ grid: false, spotlight: false }); // The viewer is chrome-heavy; V1 ran no cursor system here.
ambient.mount();
```

`ambient.ts:164-183` creates both `.ambient-blob` elements **unconditionally, before** the
`useSpot` and `useGrid` checks. Those flags only gate the spotlight and the grid.

`base.css:199-254`:
```css
.ambient-layer { position: fixed; inset: 0; z-index: 2; ... }
.ambient-blob   { position: absolute; border-radius: 50%; filter: blur(60px); will-change: transform; }
.ambient-blob-a { width: min(70vmin, 780px); height: min(70vmin, 780px); animation: ambient-blob-a 32s ... infinite alternate; }
@keyframes ambient-blob-a { 0% { transform: translate3d(0,0,0) scale(1); }
                            100% { transform: translate3d(-12vw,16vh,0) scale(1.18); } }
```

The layer is a `document.body` child at `z-index: 2`. `.viewport-container` is
`position: relative` with no `z-index`, so it creates no stacking context — the blobs paint
directly over the WebGL canvas.

The canvas is created with `alpha: false` (`sandbox-worker.ts:423`) and never sets
`preserveDrawingBuffer`, so every rendered frame is a full-canvas damage rect.

The animation drives a **non-integer** scale factor. That defeats Chrome's cached filtered
texture, forcing a re-rasterization of the 60px Gaussian over ~780×780 CSS px (≈3.4M device
px at DPR 2), twice per frame, for the entire viewer session — producing no visible output,
because the viewer explicitly requested no cursor system.

External corroboration: Chromium bug 495538197 reproduces 60fps → 10-20fps (composite
2-3ms → 30-80ms) from a 4px `backdrop-filter` over an animating canvas. Chrome's own
"Animating a blur" article confirms convolution filters blow the 16ms budget per frame.

**Verdict: dominant cause of the reported orbit jank.** Fixes in Phase 1.

### 3.2 `Ambient`'s per-frame rAF keeps the main thread's frame queue non-empty — VERIFIED

`ambient.ts:196-203`:
```js
requestAnimationFrame(() => layer.classList.add('is-visible'));
if (this.tracking) {
  window.addEventListener('pointermove', this.onPointerMove, { passive: true });
  ...
  this.start();
}
```

`tracking` is `finePointer && !reducedMotion` (`ambient.ts:148-158`) — true on any desktop
with a mouse. So the viewer runs a second rAF loop forever.

Per frame, `ambient.ts:84-105` does: two `innerWidth`/`innerHeight` reads (whose only
consumer is `nx`/`ny`, consumed exclusively by the `parallax` and `magnets` loops — both
empty in the viewer), four `lerp`s, and three `for…of` loops over empty arrays.

Note on cost: the three `setProperty` calls are guarded by optional chaining
(`this.spot?.style.setProperty(...)`), which short-circuits **argument evaluation**, so the
template literals and their `toFixed(1)` calls are *not* evaluated. The per-frame JS is
~200-400ns. **The cost is not the JS — it is that a second rAF callback keeps the main
thread's frame queue permanently occupied, competing with `postMessage` dispatch and input
coalescing.**

**Verdict: second cause. Fix in Phase 1.**

### 3.3 Hovering rebuilds a 200-button DOM subtree, per hover-target change

`viewer/+page.svelte:447-449` resolves `activePart` against `selectedPart ?? hoveredPart`,
so `activePart` is non-null merely by hovering. That makes `selectedPartInfo` truthy, which
flips the right panel's top-level branch:

```svelte
1332:  {#if selectedPartInfo}                    ← truthy WHILE HOVERING
1362:  {:else if overviewHtmlSafe}
1397:    {#each listedParts as part (part.id)}   ← up to 200 <button class="part-button">
```

Consequence per pointer enter/exit cycle: the `{:else if}` branch is destroyed and rebuilt —
200 `template_effect`s, 200 `onclick` closures, 200 DOM nodes. This lands *while the pointer
is moving across the canvas*. It is also an accessibility regression: the keyboard-reachable
part list (the documented `aria` path) vanishes the instant the pointer touches the model.

Additionally, four independent `.find()` scans over `manifest.parts` run per hover change
(`:448`, `:1251`, `:1253`, `:1255` — separate `template_effect`s because each is a distinct
dynamic expression), each walking a Svelte 5 deep proxy.

**Verdict: the "general viewer lag" while moving the mouse. Fix in Phase 1.**

### 3.4 `$state` deep proxies over large replaced-wholesale objects

`viewer/+page.svelte:44-49` — `manifest`, `verdict`, `stats`, `metrics`, `parameterValues`
are all plain `$state`, i.e. deep proxies. All are replaced wholesale on write
(`:109`, `:116`, `:126`, `:129`, `:338`) and never mutated in place.

Every property access becomes a proxy `get` trap that reads a source version and registers a
dependency. Hover alone produces ~2,400 traps per change, up to 60×/sec.

Svelte's own docs: *"Deep proxies are not free. Every property access goes through a trap"*,
with `$state.raw` recommended for data that is *"large, effectively immutable, and replaced
wholesale — parsed JSON responses, configuration blobs, lookup tables."* Svelte issue #14721
quantifies ~20% proxy overhead and reports the symptom directly: *"animations start stuttering
and losing frames."*

**Must NOT be applied to `progress` in `loading/+page.svelte:22` or
`generate-dialog.svelte:26`** — `ProgressModel` is a class whose `index` is mutated in place
and read through getters; `.raw` would silently freeze the stage chips.

### 3.5 Pointer path: a layout read per event, and no coalescing

`viewer/+page.svelte:568-579` calls `canvasHolder.getBoundingClientRect()` on every
`pointermove`, *before* the `!dragging` check — so it fires on hover moves too, at up to
120 Hz. The document is frequently dirty (stats at 1 Hz, metrics at 1 Hz, hover per change),
so each read can force a synchronous style+layout flush.

Every `pointermove` also becomes its own `postMessage`. The worker coalesces the *raycast*
(`sandbox-worker.ts:1011-1014`) but not the message volume.

### 3.6 Frame path: ~4,800 objects/second, from a cache that is rebuilt every frame

`scene.ts:548-636` — `createFrameContext` constructs, **per frame**: a `Proxy` over the
parameter map plus its handler object, a `new Map()` named `partRefCache`, a `makePartRef`
closure, the context literal, three method closures, and — for each distinct part `onFrame`
touches — one part-ref object plus nine method closures.

Because `partRefCache` is created *inside* `createFrameContext`, **every part ref is a
guaranteed cache miss every frame.** Estimated ~80 allocations/frame.

Contributing: `applyMotions` allocates 15–20 objects per motion per frame (`motions.ts:265-414`);
`applyDeclaredMotions` rebuilds a full parameter snapshot via `Object.fromEntries` +
`Object.entries` every frame (`sandbox-worker.ts:924-929`) for data that changes only on slider
input; `resetMotionDrivenParts` copies three arrays per motion-driven part per frame
(`sandbox-worker.ts:896-905`), unnecessarily, because `applyMotions` never mutates in place;
`syncTransforms` writes all N parts every frame with no dirty check (`sandbox-worker.ts:1054-1089`).

**Calibration:** V8's generational collector scavenges under 1ms when most objects die young,
which is what these are. This is a contributor, not the dominant term — see §3.1. It matters
for pause/resume, low-end devices, and thermal behaviour.

### 3.7 Pausing costs exactly as much as running

`sandbox-worker.ts:969` has no `!target.paused` in the frame guard. A paused, un-orbited model
still runs the guest `onFrame`, still walks all N parts in `syncTransforms`, and still calls
`renderer.render()` at 60 Hz — rendering a static image 60 times a second at full cost.

### 3.8 Slider drag doubles the frame work

`sandbox-worker.ts:1330-1342` — the `setParameter` handler synchronously runs a **complete
extra frame** (reset → `runFrame` → `applyDeclaredMotions` → `syncTransforms`), on top of the
rAF frame. Slider input at 60–120 Hz means the worker does 2× its normal per-frame work while
the user drags.

### 3.9 Camera input is un-coalesced and redundant

`orbit` / `zoom` / `pan` are handled immediately on message receipt
(`sandbox-worker.ts:1385-1427`), each calling `updateCamera`. During a drag that is ~60
redundant camera updates per second *between* frames, each competing with the rAF render for
the worker's event loop.

`updateCamera` itself is cheap (~sub-microsecond), so the redundant calls are not the cost —
the **message-queue pressure against rAF** is. Separately, `pan` allocates two
`THREE.Vector3` per message and reads `state.camera.matrix` rather than `matrixWorld`
(`sandbox-worker.ts:1420-1421`).

### 3.10 Redundant heartbeat

The `heartbeat` message fires on the same 1,000 ms interval, from the same start instant, and
against the same `clockMs` as `stats` — so it posts in the same frame, every second.
`sandbox-host.ts:284` already treats **any** message as proof the worker's event loop is
turning. The heartbeat contributes nothing.

### 3.11 Raycasting the whole scene, per frame

`sandbox-worker.ts:861` — `raycaster.intersectObject(model.root, true)`, no BVH, no spatial
index, and the full intersection list is sorted. Cost is O(total triangles) per cast.
`firstHitOnly` is not set. Hidden parts are still raycast (Three does not skip
`visible === false`).

### 3.12 Worker bundle: one 4 MB uncompressed IIFE

`vite.config.ts:30-49` declares `build.rollupOptions.manualChunks` but has **no
`worker.rollupOptions` key**, so `worker.format` defaults to `iife`. Rollup forces
`inlineDynamicImports` in that mode: `manualChunks` cannot apply, code splitting is impossible,
and dynamic `import()` is unavailable. The `three` / `physics` / `geometry-ops` rules do
nothing for the worker.

Consequences: `physics-world.ts:23` statically imports `@dimforge/rapier3d-compat` (~2.86 MB
module with base64-inlined WASM), so it is parsed and evaluated on **every** worker spawn —
and the worker is terminated and respawned on **every** model load (`sandbox-host.ts:484-488`).

`static-pages.ts:60-65` sets only `content-type` — no `content-encoding`, no compression.

### 3.13 Nothing in the build path is abortable

`instrument.ts:103-140` injects `__edu3d_tick()` into *guest* loops only. Nothing in
`packages/engine/src/geometry/*` is instrumented and nothing calls `guard.tick()`.

Therefore `geom.sdf` at resolution 160 (4.17M samples, `implicit.ts:460-469`) executes with
**zero** guard calls when composed from `geom.field.*` (engine closures, not instrumented).
And `geom.boolean` is O(R³·V): `meshToField` (`factory.ts:1627-1659`) is an unaccelerated
linear scan over every vertex, per sample. Two 100k-vertex inputs at max resolution is
~14 minutes. The only backstop is `worker.terminate()`, which produces "it hung" rather than an
actionable repair message.

Compounding: `register()` runs `build()` *before* the vertex-ceiling check
(`factory.ts:277` vs `:290`), contradicting the file's own header promise of pricing
"before allocation".

### 3.14 The four quality lies

| # | Lie | Location |
|---|-----|----------|
| 1 | Instance capping ignores `hero`; `Math.max(3, …)` can cut a hero part to 13.6% when `HERO_FLOOR` is 0.55 — and the recognizability floors are consulted only in the decimation branch | `admission.ts:197-214` vs `:119-120` |
| 2 | Index-stride decimation produces isolated, non-adjacent triangles. The comment claiming "the silhouette survives" is false. `flatShading` is enabled exactly when decimation engages, so it is worst where it triggers | `realize.ts:64-78`, `admission.ts:303-304` |
| 3 | Admission credits a static-merge that the realizer never performs — `RealizationDecisions` has no merge field and `realize.ts` contains no merge path | `admission.ts:265-277` |
| 4 | The `physicsSubsteps` rung is priced with a user-facing notice, but `PhysicsWorld` hardcodes `MAX_SUBSTEPS = 3` and never reads `DEVICE_BUDGETS[tier].maxSubsteps` (low = 2). On a low-tier device the solver runs 50% over budget under a notice saying otherwise | `admission.ts:312-317` vs `physics-world.ts:52,57` |

Plus, adjacent to them: the `geometryDetail` ladder rung is marked applied but returns without
doing anything (`sandbox-worker.ts:1160-1166`), which blocks `ladderStep` from ever reaching
`flatShading` — the only rung left that would help (`sandbox-worker.ts:1105`).

---

## 4. Verification strategy — Phase 0

The repo currently has **no working regression net for the viewer**: 12 of 14 Playwright
tests fail because `tests/e2e/viewer.spec.ts` targets selectors that no longer exist in
`apps/web` (`.canvas-holder`, `#param-spoolRpm`, `getByTitle('Device tier')`, a
`diagnostics` button, a `Solid` button). `waitForModel()` depends on `title` attributes that
are not rendered, so every viewer test fails at setup. `vitest.config.ts:26` excludes e2e, so
nothing catches this.

Phase 0 exists so that phases 1–6 cannot silently regress. It is not optional.

### 4.1 Repair the existing E2E suite

Re-point every selector at the current markup. This is required regardless — the suite is
currently a false signal that says "green" only because nobody runs it.

### 4.2 Engine frame benchmark (Node, vitest — no browser)

Author `REFERENCE_MODEL_SOURCE` through the real static gate and `prepareProgram`, drive
10,000 frames in the exact order `renderFrame` uses, and assert:

- p99 frame wall time below a recorded baseline
- post-`global.gc()` heap growth below a recorded threshold (Node exposes `--expose-gc`)
- allocations per frame, counted via a `SceneBuilder`-level counter the benchmark enables

This is deterministic and CI-able. It is the primary proof for L3, L4 and Phase 2.

### 4.3 Compositor lint (vitest, jsdom)

Parse `viewer.css`, `base.css`, `theme.css`, `viewer-extended.css`; resolve each
`filter` / `backdrop-filter` declaration; fail if any applies to an element that geometrically
overlays `.main-canvas-holder`.

This test is static and deterministic. **It would have caught §3.1 the day it was written, and
it prevents the class from returning.** This is the highest-leverage test in Phase 0.

### 4.4 Quality-invariant tests

- `keepFraction >= HERO_FLOOR` for every part on every tier, including the instance-cap path
- decimated output: zero degenerate triangles, zero newly-disconnected surface components
- `stats.triangles === realized triangle count`
- no rung emits a notice without changing a `RealizationDecisions` field

### 4.5 Stress fixtures

`authoring.test.ts:432-439` asserts build < 15,000 ms against a model that realistically takes
~50 ms — ~200× loose. Add fixtures that exercise the worst paths the reference model never
touches: two `geom.sdf` calls, one `geom.boolean`, and a 4-modifier chain.

---

## 5. Phases

Each phase is one commit. Each carries before/after figures from §4.2 where applicable.

### Phase 1 — Orbit jank, browser layer

Targets L1, L2, L7. Touches no engine logic. Lowest risk, highest user-visible value.

| Change | Location |
|--------|----------|
| Add a `blobs?: boolean` option to `Ambient`; gate blob creation alongside `useGrid`/`useSpot`. Viewer passes `blobs: false`, so `mount()` creates nothing and `start()` never runs | `ambient.ts:164-183`; `+page.svelte:163-164` |
| Gate the right panel on `selectedPart`, not `activePart`; let the tooltip (already gated `hoveredPart && !selectedPart`) be the only hover consumer | `+page.svelte:1332` |
| Build an id→part `Map` once per manifest; collapse the four `.find()` scans to one lookup | `+page.svelte:447-449, 1251, 1253, 1255` |
| `$state.raw` on `manifest`, `verdict`, `stats`, `metrics`, `parameterValues` | `+page.svelte:44-49` |
| Cache the canvas rect in the existing `ResizeObserver`; stop calling `getBoundingClientRect()` per `pointermove` | `+page.svelte:176, 568-579` |
| Coalesce `pointer` messages to one per frame on the main thread | `+page.svelte:568-579` |
| Give `.tooltip-3d` real `position: absolute` geometry; drop `glass-panel` for a solid background (`backdrop-filter: none`) | `+page.svelte:1248-1261` + style block |
| Pause rendering while any modal is open — `viewer.css:1520-1527` already claims this happens | `+page.svelte:244, 1034` |
| Delete the redundant `heartbeat` message and its special-case handler | `sandbox-worker.ts:1032-1038`; `sandbox-host.ts:373-375` |
| Delete `window.__edu3dHost` on destroy (leaks a closure over a disposed host) | `+page.svelte:171-174, 295` |

**Risk:** low. Removing decoration is visually a *loss* on the viewer — but the viewer
already asked for `grid:false, spotlight:false`, so this restores intent, not removes design.
The `.tooltip-3d` change is the one visible-behaviour fix: it is currently an unpositioned
full-width block with a 16px backdrop-filter sitting over the canvas.

### Phase 2 — Frame-path allocation

Targets L3. All host-side or builder-side; A2 preserved.

- Hoist `createFrameContext`'s proxy handler and `partRefCache` to `SceneBuilder` scope; invalidate on part mutation only (`scene.ts:548-636`)
- Module-level scratch tuples/quaternions in `applyMotions`; hoist the `?? {const:0}` / `?? {const:1}` literals to frozen module constants (`motions.ts:265-414`)
- Hold one `params` record on `WorkerState`; rebuild only in the `setParameter` handler (`sandbox-worker.ts:924-929`)
- `resetMotionDrivenParts`: alias `base.position` instead of copying — safe because `applyMotions` always assigns a fresh array (`sandbox-worker.ts:896-905`)
- Dirty-check `syncTransforms` using the builder's existing `noteWrite` channel set (`sandbox-worker.ts:1054-1089`)
- Replace `setParameter`'s synchronous extra frame with a dirty flag consumed by the next `renderFrame` (`sandbox-worker.ts:1330-1342`)
- Coalesce `orbit`/`pan`/`zoom` to once per frame in `renderFrame`; hoist the two `Vector3`; read `matrixWorld` not `matrix` (`sandbox-worker.ts:1385-1427`)
- Physics: single `linvel()` call, cache `mass()` on the body link, precompute probe key strings, mutate `lastGood*` in place, return `probes: undefined` when empty (`physics-world.ts:363-402`)
- `Object.keys(stepped.probes)` computed once, not twice per frame (`sandbox-worker.ts:956-964`)

### Phase 3 — On-demand rendering

Targets L4. Follows the official Three.js "Rendering on Demand" pattern.

- Add `needsRender` to `WorkerState`, set by: parameter change, selection, hover change, view-mode change, theme, resize, frame switch, camera interaction, physics motor target, and any notice that changes the scene
- When `paused && !autoRotate && !needsRender`: skip physics step, `runFrame`, motions, `syncTransforms` **and** `renderer.render`
- Preserve the existing contract that a paused model is still inspectable: parameter changes,
  selection, hover and view modes must all invalidate

**Risk:** medium — this is the phase most likely to introduce a "the model stopped updating"
bug. The §4.2 benchmark must prove that sweeping every parameter still mutates observable
state while paused (the existing test `"sweeps cutaway into a genuine visibility change"`
at `authoring.test.ts:347-371` is the model for this).

### Phase 4 — Bundle and raycast

Targets L5.

**Order is mandatory.** `worker.format: 'es'` + `worker.rollupOptions` must land first;
`iife` forbids dynamic `import()` entirely, so the Rapier change is impossible before it.

- `vite.config.ts`: `worker: { format: 'es' }` and worker `rollupOptions` mirroring the client rules
- `physics-world.ts`: dynamic `await import('@dimforge/rapier3d-compat')` inside `create()`, gated on `manifest.physics`
- `static-pages.ts`: negotiate gzip/brotli for `text/*`
- `updateHover`: adopt `three-mesh-bvh` + `acceleratedRaycast` + `firstHitOnly` — **measure the bundle cost first**; if the added weight in the worker chunk exceeds the raycast saving, use per-mesh bounding-sphere pre-rejection instead
- `svelte.config.js`: drop `fallback: 'index.html'` so the landing page gets its own node + CSS preloaded (currently guaranteed FOUC)
- Predictive prefetch of viewer chunks during generation, per `Build_Docs/08:135` — the minutes-long wait is currently downloading nothing

**Risk:** medium. Bundle reconfiguration can surface latent build issues. The dev server is
unaffected in shape but the production output changes materially.

### Phase 5 — Build path

Targets L6.

**Highest-leverage item first:** plumb `guard.tick` into `GeometryFactory` and call it once per
z-slice in `implicit.ts:460` and once per cube row at `:486`. ~20 lines turns "the worker hung"
into an actionable repair message, and makes `sdf`/`boolean` abortable at ~2ms granularity.

- Spatial acceleration for `meshToField` — a uniform voxel hash or BVH, taking boolean from
  O(R³·V) to ~O(R³·log V); memoize per-mesh so N booleans against one operand don't rescan it N times
- Pre-flight estimate in `register()` for `sdf`/`boolean` so the vertex ceiling is enforced
  *before* allocation, as the file header already promises
- Make `carry()`'s dead `recomputeNormals` flag chain-aware: recompute normals once at the end
  of a modifier chain, not N times (`modifiers.ts:23-35`)
- Stop registering and billing modifier intermediates to `totalVertices` (`factory.ts:1592, 295`)
- Coerce `geom.mesh` / `geom.points` inputs to typed arrays *before* keying, so the 32-sample
  digest branch applies (`factory.ts:188`)
- Memoize `makeProfile` / `makePath` / `pattern.*` behind the structural keys they already compute
- Hoist `triangulateProfile` + `ensureCcw` out of the two `addCap` calls (`solids.ts:72`)
- Hoist per-vertex `cos`/`sin` out of `revolve`/`extrude`/`sweep`'s `place()` (`solids.ts:144-150`)
- Make `resampleProfile`'s `span` cursor monotonic — it is O(n²) where O(n) is available (`solids.ts:441`)
- Packed-integer keys instead of template-literal string keys in `weld`/`simplify` (`modifiers.ts:230, 396`)
- CSR adjacency in `smooth` instead of `number[][]` of length V (`modifiers.ts:331`)
- `sdCylinder`: use `len2`/`len3` rather than an array literal per SDF sample (`implicit.ts:52-58`)
- **Add a per-builder timing stat** (`Map<builder, ms>`) surfaced next to `hits`/`misses`

That last item is not an optimization — it is the reason the rest can be verified. Today
**nobody can answer "where does build time go"**, because the reference model uses zero booleans
and zero modifiers and therefore exercises none of the worst paths.

### Phase 6 — The quality lies

Targets Q2–Q7. Quality can only improve.

| Change | Location |
|--------|----------|
| **Replace index-stride decimation with quadric-error-metric edge collapse.** QEM is the industry standard (Garland & Heckbert 1997; `vtkQuadricDecimation`); index-stride is not in the standard taxonomy (vertex remove / edge collapse / vertex clustering) and is why geometry shatters. New module in `packages/engine/src/runtime/`, unit-tested in isolation | `realize.ts:64-78` |
| Hero-aware, floor-respecting instance capping using `decimationOrder`'s existing "non-hero before hero, largest first" policy, which the instance path omits entirely | `admission.ts:197-214` |
| Fix `decimationOrder` to price from the post-cap instance count (currently over-claims by up to `n/cap`×) | `admission.ts:98-101` |
| Implement static merging in the realizer, **or** stop crediting it — pick one and make `RealizationDecisions` honest | `admission.ts:265-277`, `realize.ts` |
| Track the capped point-cloud geometry in `geometryCache` (currently leaks a `WebGLBuffer` per load cycle) and the fallback material in `materialCache` | `realize.ts:327-342, 311-313, 459-470` |
| Honour `DEVICE_BUDGETS[tier].maxSubsteps` / `manifest.physics.world.substeps`, **or** stop emitting the rung | `physics-world.ts:52,57` |
| `stats.triangles` reports realized; set `GeometryRef.decimated` honestly (hardcoded `false` at all three authoring sites) | `realize.ts:350`; `scene.ts:802,867,919` |
| Fix the `geometryDetail` rung so it does not block the ladder from reaching `flatShading` | `sandbox-worker.ts:1105, 1160-1166` |
| Fix the wrong quaternion→Euler conversion — degrees, X-axis only, and `y/w` is not even the correct X formula. A correct implementation exists at `motions.ts:204-221` and should be reused | `physics-world.ts:393` |
| Make `MeshData.groups` survive realization, or delete the feature (currently built, threaded, documented, tested, and discarded) | `realize.ts:55-95` |

**QEM edge collapse is the largest single piece of work in this spec** — roughly 300 lines
plus tests. It is worth doing properly rather than substituting the existing voxel-clustering
`simplify`, because clustering is documented as fast-but-low-quality and the constraint here is
that quality must not degrade.

---

## 6. Explicit non-goals

| Not doing | Why |
|-----------|-----|
| WebGPU / `WebGPURenderer` | Three.js's own guidance: *"WebGLRenderer is still maintained and the recommended choice for pure WebGL 2 applications."* Migrating a 188-member custom scene API with a strict sandbox boundary, Rapier and determinism requirements onto node materials/TSL is a large risk for an unproven gain here. |
| Adding capabilities to the sandbox | Violates A2. |
| Implementing the orphaned viewer features | Annotations, settings, export/video and QR are ~600 lines of CSS with no markup. Removing that CSS is a Phase 1-adjacent cleanup; *implementing* the features is a different project. |
| Fixing the dead-code CSS wholesale | ~1,100 of `viewer.css`'s 3,462 lines match no markup. Worth deleting, but it is parse cost, not frame cost, so it is not a Phase 1 priority. |
| Fixing the server-side generation pipeline | Real findings exist (`openStreams` leak, `AI_CHAT_MODEL` never read, phase-vocabulary drift). Out of scope for a render-performance sweep. |
| Changing the API surface | A4: the surface is a single reflected source of truth. Adding a builder widens the gate, the prompt and diagnostics together, by design. |

---

## 7. Ordering rationale and dependencies

```
Phase 0  safety net  ──┬──▶ Phase 1  orbit jank      (dominant cost, lowest risk)
                       ├──▶ Phase 2  frame allocation (needs Phase 0 benchmark to prove)
                       │      └──▶ Phase 3  on-demand rendering
                       ├──▶ Phase 4  bundle/raycast
                       └──▶ Phase 5  build path
                              └──▶ Phase 6  quality lies
```

- **0 before everything.** A silent regression in geometry generation is invisible until
  someone looks at a model.
- **1 before 2–3.** If Phase 1 lands the fix, the remaining frame-path work may not be worth
  its risk — measurable either way, and Phase 0's benchmark answers it.
- **2 before 3.** On-demand rendering is only safe once per-frame cost is low and understood.
- **4's two parts are ordered internally**: `worker.format: 'es'` strictly before the Rapier
  dynamic import.
- **5 before 6.** Phase 6's QEM decimation is easier to verify when per-builder timing exists.

---

## 8. Commit strategy

One commit per phase. Each commit message states the invariant protected, not just the change.
Each references its §4 test. Phases 1 and 2 carry before/after benchmark figures; later phases
carry them where measurable.

No commit bundles a refactor with a behavioural change. `pnpm verify` runs the full gate
(secrets → config → format → lint → typecheck → unit → build → e2e) before each.

This spec covers the whole programme, but the **implementation plan is per-phase**, with a
verification gate between phases. Six phases authored as one plan would be a plan nobody
finishes; six phases each with its own plan-and-verify cycle is the same work delivered.
Phase 1 alone is expected to resolve the reported complaint, and Phase 0's benchmark will
tell us whether Phase 2 is worth its risk at that point — which is the point of measuring
before continuing rather than after.

### 8.1 Expected outcome per phase

| Phase | Solves | Expected to be worth it on its own |
|---|---|---|
| 0 | Makes every other phase safe | Yes — the broken suite is currently a false green |
| 1 | The reported orbit jank | **Yes** — this is the complaint |
| 2 | Steady-state allocation churn | Measure after Phase 1; may be unnecessary |
| 3 | Wasted frames while paused | Yes on battery/thermal, invisible while moving |
| 4 | First-load weight, raycast cost | Yes — Rapier on every spawn is indefensible |
| 5 | Unbounded/frozen builds | Yes — turns hangs into diagnosable failures |
| 6 | Four user-visible lies | Yes — quality goes up |

---

## 9. Open questions for the reviewer

1. **QEM edge collapse is the long pole.** Accept ~300 lines in Phase 6, or substitute the
   existing voxel-clustering `simplify` (fast, documented as lower quality) and revisit?
2. **`three-mesh-bvh` adds weight to an already-4 MB worker chunk.** Adopt it, or use
   per-mesh bounding-sphere pre-rejection (cheaper, no dependency, less effective on dense scenes)?
3. **Should Phase 4's compression and prefetch work be split out?** They touch
   `apps/server` and `svelte.config.js` respectively, and are arguably deploy-config rather
   than render performance.