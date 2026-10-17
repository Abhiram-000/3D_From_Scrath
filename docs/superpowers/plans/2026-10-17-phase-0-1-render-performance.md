# Phase 0 + Phase 1 Implementation Plan — Render Performance

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore a working regression net, then eliminate the browser-layer causes of janky orbit interaction without touching engine logic.

**Architecture:** Phase 0 adds three independent verification surfaces — a repaired Playwright suite, a Node frame-cost benchmark, and a CSS compositor linter with a dated offender allow-list. Phase 1 works through those tests TDD-style: each task adds its own lint entry or assertion first (failing), then makes it pass.

**Tech Stack:** SvelteKit 2 / Svelte 5 runes, Three.js in a Web Worker via `transferControlToOffscreen`, Vitest 5 (Node env — **jsdom is not installed**), Playwright 1.63.

**Spec:** `docs/superpowers/specs/2026-10-17-render-performance-design.md` — read §2 (invariants) and §3 (root causes) before starting.

## Global Constraints

- **Spec: A2** — no task may add a capability to the sandbox. All Phase 1 work is host-side or CSS.
- **Spec: A3** — `packages/engine` and `packages/sandbox` stay DOM-free. Only `packages/engine` is touched, in Task 2's benchmark only.
- **Spec: L1–L7, Q1–Q7** — quality may improve, never degrade. The viewport never renders a static image 60×/sec.
- Node 22+, pnpm 10. Run `pnpm verify` before each commit; it must be green.
- `vitest.config.ts` uses `environment: 'node'`. **Do not write DOM-dependent tests** — jsdom is not installed despite the config comment. Extract decisions into pure exported functions and test those.
- Uncommitted work already in the tree (`prompts.ts` v7, `dev-console.ts`, `landing.css`, `+page.svelte`) is the author's in-flight work. Do not stage it, revert it, or reformat it.

### Deliberately out of this plan

Spec §4.4 (quality-invariant tests) and §4.5 (stress fixtures) are **not** authored here.
Every assertion in §4.4 targets a Phase 6 defect, and §4.5's fixtures target Phase 5's
unbounded builders. Writing them now would produce characterization tests of behaviour the
spec already documents as wrong — a test that passes while the hero floor is breached is
worse than no test, because it looks like coverage.

They are written with their owning phase, as the failing test that precedes the fix. The
net is not weaker for the delay: the decimation and admission code is not touched in
Phases 0–1 at all.

## Review Focus

Conditions the spec implies but no test in this plan exercises. Each is pinned in the task that owns the relevant code.

1. **A model with no parameters** — the right panel must still show the part list and the `{#if}` flip must not strand it. *(Task 5)*
2. **Viewer opened with `prefers-reduced-motion`** — `Ambient.tracking` is false, so `mount()` creates the layer but never starts the rAF; the blob must still be absent. *(Task 4)*
3. **`pointercancel` mid-drag** — `setPointerCapture` releases without a `pointerup`, leaving `dragging` set and the camera spinning. *(Task 7)*
4. **Model swap while a modal is open** — pause state must not survive into the next model. *(Task 9)*
5. **Narrow viewport** — `.panel` becomes `position: absolute; inset: 0` over the canvas at ≤768px, so the compositor lint's overlay list must include it even though desktop panels do not overlap. *(Task 3)*

---

## Phase 0 — Safety net

### Task 1: Repair the Playwright suite

12 of 14 tests currently fail against selectors that no longer exist, so the suite is a false green. `waitForModel()` uses `getByTitle('Frames per second, measured over a rolling window')`, but no `.stat-item` carries a `title` attribute — so **every** viewer test fails at setup.

Two mismatches are worth fixing in the app rather than the test, because they are real gaps: stat read-outs have no hover text, and parameter sliders have no stable DOM id.

**Files:**
- Modify: `apps/web/src/routes/viewer/+page.svelte:1421-1439` (add `title` to four `.stat-item`s), `:1141-1152` (add `id` to the range input)
- Modify: `tests/e2e/viewer.spec.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `.stat-item[data-stat]` and `input#param-{parameterId}` as stable test hooks. Task 3's lint and Task 5's panel work both rely on these class names existing.

- [ ] **Step 1: Add the missing `title` attributes and `data-stat` hooks**

In `+page.svelte`, give each of the four left-group `.stat-item` divs a `title` and a `data-stat`. Exact values, in source order:

| label | `data-stat` | `title` |
|---|---|---|
| `FPS` | `fps` | `Frames per second, measured over a rolling window` |
| `Draws` | `draws` | `Draw calls in the last rendered frame` |
| `Triangles` | `triangles` | `Triangles this frame` |
| `Time` | `time` | `Model time` |

Give the `Tier` `.stat-item` `data-stat="tier"` and `title="Device tier"`.

In the number-parameter branch, add `id={'param-' + parameter.id}` to the `<input type="range">`. The turbofan declares `spoolRpm` and `fuelFlow`, so this yields `#param-spoolRpm` and `#param-fuelFlow`.

- [ ] **Step 2: Re-point the selectors in `viewer.spec.ts`**

Replace, exactly:

| Line | Old | New |
|---|---|---|
| 73, 87 | `page.locator('#param-spoolRpm')` / `#param-fuelFlow` | unchanged — Task 1 Step 1 creates them |
| 78 | `page.locator('.control', { has: slider }).locator('output')` | `page.locator('.parameter-item', { has: slider }).locator('.parameter-value')` |
| 91 | `page.locator('dt', { hasText: 'Thrust' }).locator('+ dd')` | `page.locator('.metric-item', { hasText: 'Thrust' }).locator('.metric-value')` |
| 63 | `page.getByText('quality adapted')` | `page.getByText('Adapted')` |
| 117 | `['X-ray', 'Wire', 'Explode', 'Solid']` | `['X-ray', 'Wireframe', 'Explode']` |
| 118 | after each click, also click again | there is no `Solid` button — the three are toggles, so click each twice to return to normal before the next |
| 146, 228 | `page.locator('.canvas-holder')` | `page.locator('.main-canvas-holder')` |
| 166–173 | diagnostics button + `region 'Diagnostics'` | no diagnostics panel exists — delete the block and assert the AI Output toolbar button opens `code-view-modal` with a `<pre>` that is non-empty |

`X-ray`, `Wireframe` and `Explode` already have `title` attributes (`X-ray Mode (X)`, `Wireframe (W)`, `Explode View (E)`); `getByRole('button', { name: 'Wireframe', exact: true })` matches the visible `<span>` text.

- [ ] **Step 3: Run the suite and confirm green**

Run: `pnpm build && pnpm test:e2e`
Expected: 14 passed (2 skipped on the wrong project — the phone-only tests skip on desktop and vice versa).

- [ ] **Step 4: Commit**

```bash
git add tests/e2e/viewer.spec.ts apps/web/src/routes/viewer/+page.svelte
git commit -m "test: make the viewer suite tell the truth again

12 of 14 e2e tests failed against selectors that no longer exist, so the
suite reported nothing. waitForModel() keyed on a title attribute no stat
item carried, which meant every viewer test failed at setup.

Two of the mismatches were app gaps rather than stale selectors, and are
fixed in the app: stat read-outs carry no hover text, and parameter
sliders have no stable DOM id. Both are now emitted, so the test hooks and
the user-facing affordance are the same change."
```

---

### Task 2: Engine frame benchmark

Measures bytes allocated per frame by regression, so it needs no instrumentation in production code and no counter to remove later.

**Files:**
- Modify: `vitest.config.ts` (expose `gc` to the test worker)
- Create: `packages/engine/tests/frame-cost.test.ts`

**Interfaces:**
- Consumes: `REFERENCE_MODEL_SOURCE` from `@edu3d/engine`; `prepareProgram` from `@edu3d/sandbox`; `createGuard` from `@edu3d/sandbox`.
- Produces: a vitest assertion that no frame path may exceed `MAX_BYTES_PER_FRAME`. Every later engine task cites this number.

- [ ] **Step 1: Expose `gc` to the vitest worker**

In `vitest.config.ts`, inside `test`, add:

```ts
pool: 'forks',
poolOptions: { forks: { execArgv: ['--expose-gc'] } },
```

- [ ] **Step 2: Write the failing benchmark**

Create `packages/engine/tests/frame-cost.test.ts`. It must:

1. Gate on `typeof global.gc === 'function'`; `it.skip` if absent, so a missing flag never blocks CI.
2. Build the reference model exactly as `authoring.test.ts` does — `prepareProgram(REFERENCE_MODEL_SOURCE, { apiSurface })`, then `compileGuest`, then run with a `SceneBuilder`.
3. Define `runFrames(n)` that, for each frame, calls `resetMotionDrivenParts`-equivalent base reset, `builder.runFrame(elapsed, delta, false)`, `applyMotions(...)` and the transform sync the worker performs.
4. Measure: `global.gc(); global.gc();` then record `process.memoryUsage().heapUsed`; run `FRAMES_PER_SAMPLE` frames; `global.gc(); global.gc();` then record again. `bytesPerFrame = (after - before) / FRAMES_PER_SAMPLE`.
5. Use `FRAMES_PER_SAMPLE = 2000`.

Assert `bytesPerFrame < MAX_BYTES_PER_FRAME`. Record the measured value in the assertion message so a regression names itself:

```
expect(bytesPerFrame, `engine frame path allocated ${bytesPerFrame} bytes/frame`).toBeLessThan(MAX_BYTES_PER_FRAME)
```

- [ ] **Step 3: Run it and record the current number**

Run: `pnpm test frame-cost`
Expected: PASS, but read the measured value from the output. Write it into a comment above `MAX_BYTES_PER_FRAME` and set the constant to that value plus 25% headroom. This number is the baseline every Phase 2 claim is measured against.

- [ ] **Step 4: Commit**

```bash
git add vitest.config.ts packages/engine/tests/frame-cost.test.ts
git commit -m "test: measure what a frame costs before changing it

No perf test existed, so every claim about the frame path was an estimate
read off source. This measures bytes allocated per frame by GC-regressing
the heap across 2000 frames, which needs no counter in production code and
nothing to remove later.

The reference turbofan is the fixture because it exercises the real gate,
the real authoring builder and real declared motions. Its cost today is
the baseline Phase 2 must beat."
```

---

### Task 3: Compositor linter

The highest-value test in the plan: it detects the dominant cause of the reported jank (§3.1) statically, and it would have caught it the day it was written.

`scripts/` already establishes the pattern (`check-secrets.mjs` + `check-secrets.test.ts`), and `scripts/*.test.ts` is in vitest's `include`.

**Files:**
- Create: `scripts/check-compositor.mjs`
- Create: `scripts/check-compositor.test.ts`
- Modify: `scripts/verify.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces: `findCompositorOffenders(stylesheets) -> Offender[]` and `KNOWN_OFFENDERS: Record<string, string>`. Tasks 4 and 8 delete entries from `KNOWN_OFFENDERS`; a removal without the matching fix must fail.

- [ ] **Step 1: Write the detector as a pure function and test it**

`scripts/check-compositor.mjs` exports:

```js
export function findCompositorOffenders(sheets) -> Array<{ file, selector, property, radius, reason }>
```

Two rules, both scoped to the animation and overlap facts rather than to any one selector:

- **Animated large blur** — a rule whose declarations contain both a `filter: blur(Npx)` with `N >= 20` and an `animation` whose name resolves to an `infinite` keyframe block. Reason: `filter` is not compositor-cached, and a non-integer `scale()` in the keyframe forces a re-rasterization every frame.
- **Backdrop filter over the canvas** — a rule declaring `backdrop-filter: blur(Npx)` with `N >= 5` whose selector matches any class in `CANVAS_OVERLAY_CLASSES = ['modal-overlay', 'tooltip-3d', 'toast', 'subtitle', 'panel']`. Reason: the WebGL canvas is opaque (`alpha: false`), so every rendered frame is a full-canvas damage rect and the browser must re-blur the backdrop.

Parse with a regex over declarations within `selector { … }` blocks — no new dependency. `verify.mjs` is a plain Node script and must stay dependency-free like its siblings.

`scripts/check-compositor.test.ts` asserts two things: a synthetic stylesheet containing both patterns is detected, and `KNOWN_OFFENDERS` currently covers every real offender in `apps/web/src/lib/styles/`.

- [ ] **Step 2: Seed the allow-list with the current offenders**

Export from `check-compositor.mjs`:

```js
export const KNOWN_OFFENDERS = {
  '.ambient-blob': 'Phase 1 Task 4 — viewer passes blobs:false',
  '.modal-overlay': 'Phase 1 Task 8 — solid while a modal is open',
  '.tooltip-3d': 'Phase 1 Task 8 — solid, and given real geometry',
  '.panel': 'Phase 1 Task 8 — ≤768px the panel covers the canvas',
  '.toast': 'Phase 1 Task 8 — solid background',
  '.subtitle': 'Phase 1 Task 8 — solid background',
};
```

Each value names the task that removes it, so the list is a work order, not an excuse. The desktop case must not be over-broad: `.panel` only overlaps the canvas at ≤768px, which is why it is listed rather than banned.

- [ ] **Step 3: Wire it into `verify` and confirm it is green**

Add a `compositor` step to `scripts/verify.mjs` that runs the script. Run `pnpm verify compositor`.
Expected: PASS with each allow-listed offender reported as a known debt line, and zero unlisted offenders. An unlisted offender here is a real finding — fix it or add it deliberately.

- [ ] **Step 4: Commit**

```bash
git add scripts/check-compositor.mjs scripts/check-compositor.test.ts scripts/verify.mjs
git commit -m "test: a linter for the class of bug that made orbit janky

The dominant cost is static and detectable: a filter: blur(60px) on an
animated 780px layer above an opaque canvas re-rasterizes every frame. The
allow-list is a work order, not an excuse - every entry names the task that
removes it, and removing an entry without the fix turns this red.

Scoped to the mechanism (animated large blur, backdrop blur over the canvas)
rather than to any one selector, so it catches the pattern rather than the
instance. .panel is listed rather than banned because it only overlaps the
canvas at <=768px."
```

---

## Phase 1 — Orbit jank, browser layer

### Task 4: Ambient decoration becomes opt-out

Removes §3.1 and §3.2 together: the animated `blur(60px)` layers above the canvas, and the per-frame rAF that keeps the main thread's frame queue occupied.

`ambient.ts:164-183` creates both blobs unconditionally *before* the `useGrid`/`useSpot` checks, and `:196-203` starts the rAF whenever `tracking` is true — which is independent of the options the viewer passes.

**Files:**
- Modify: `apps/web/src/lib/ambient.ts`
- Modify: `apps/web/src/lib/styles/base.css`
- Modify: `scripts/check-compositor.mjs` (remove the `.ambient-blob` entry)
- Modify: `apps/web/src/routes/viewer/+page.svelte:163-164`

**Interfaces:**
- Consumes: nothing.
- Produces: `AmbientOptions` gains `blobs?: boolean` (default `true`, so the landing and loading pages are unchanged) and `export function ambientLayerRequested(options: AmbientOptions): boolean`.

- [ ] **Step 1: Write the failing test**

Add to a new `apps/web/src/lib/ambient.test.ts` (Node env, no DOM — the decision must be a pure function):

```ts
import { describe, expect, it } from 'vitest';
import { ambientLayerRequested } from './ambient';

it('is false when nothing is requested, which is how the viewer uses it', () => {
  expect(ambientLayerRequested({ grid: false, spotlight: false, blobs: false })).toBe(false);
});
it('is true if any one layer is requested', () => {
  expect(ambientLayerRequested({ grid: true, spotlight: false, blobs: false })).toBe(true);
  expect(ambientLayerRequested({ grid: false, spotlight: true, blobs: false })).toBe(true);
  expect(ambientLayerRequested({ grid: false, spotlight: false, blobs: true })).toBe(true);
});
```

The second test is Review Focus #2: `prefers-reduced-motion` must not make the blobs reappear, because `blobs` is a caller decision and never consulted `tracking`.

- [ ] **Step 2: Run it to confirm it fails**

Run: `pnpm test ambient`
Expected: FAIL — `ambientLayerRequested` is not exported.

- [ ] **Step 3: Implement**

Add `blobs?: boolean` to the options type, defaulting to `true`. Export:

```ts
export function ambientLayerRequested(options: AmbientOptions): boolean {
  return options.grid || options.spotlight || options.blobs !== false;
}
```

In `mount()`, replace the unconditional blob block (`:166-175`) so blobs are created only when `this.blobs`, and add an early return at the top of `mount()`:

```ts
if (!ambientLayerRequested(this.options)) return this;
```

so nothing is appended to `document.body` and `start()` is never reached.

- [ ] **Step 4: Pass `blobs: false` from the viewer, and add a DOM assertion**

Change `+page.svelte:163` to:

```js
ambient = new Ambient({ grid: false, spotlight: false, blobs: false });
```

**The `.ambient-blob` allow-list entry stays, and its reason is rewritten** to
`landing and loading pages only — the viewer passes blobs:false`. This is the lint working
correctly, not a gap: the blob CSS is global and must remain for the landing page, so a
static CSS scan can never prove the viewer is safe. Enforcement for this one moves to two
runtime assertions the lint cannot make:

- the pure-function test in Step 1, and
- a Playwright assertion, added to `tests/e2e/viewer.spec.ts`, that `/viewer` contains no
  `.ambient-blob` element.

If the blob markup were ever created on the viewer again, the Playwright assertion fails.
A static rule alone would not.

- [ ] **Step 5: Run both tests and commit**

Run: `pnpm test ambient && pnpm verify compositor`
Expected: both PASS.

```bash
git add apps/web/src/lib/ambient.ts apps/web/src/lib/styles/base.css apps/web/src/lib/ambient.test.ts apps/web/src/routes/viewer/+page.svelte scripts/check-compositor.mjs
git commit -m "perf(viewer): stop decorating over the canvas

The viewer passed grid:false and spotlight:false, saying it wanted no
cursor system. mount() did not honour that: both blur(60px) blobs were
created unconditionally, before the option checks, and tracking is true on
any desktop with a mouse, so the rAF started anyway.

The cost was not the ~300ns of per-frame JS - optional chaining means the
template literals are never evaluated. It was two 780px layers with
filter: blur(60px) sitting above an opaque canvas, animated to a
non-integer scale, which defeats Chrome's cached filtered texture and
forces a re-rasterization of the 60px blur over ~3.4M device pixels, twice
per frame, for the whole session.

Decoration is now opt-out rather than opt-in, so the viewer gets none of it
and the landing page is unchanged."
```

---

### Task 5: Hovering stops rebuilding the right panel

§3.3. `+page.svelte:447-449` resolves `activePart` against `selectedPart ?? hoveredPart`, so hovering alone makes `selectedPartInfo` truthy, which flips the right panel's branch (`:1332`) and destroys the `{:else if}` arm holding up to 200 `.part-button` elements.

**Files:**
- Modify: `apps/web/src/routes/viewer/+page.svelte:447-449, 455-464, 1332, 1251, 1253, 1255`

**Interfaces:**
- Consumes: nothing.
- Produces: `partsById: Map<string, ModelManifest['parts'][number]>`, a `$derived` keyed off `manifest`.

- [ ] **Step 1: Write the failing test**

There is no DOM in vitest, so pin the branch condition as a pure predicate in the page's script:

```ts
export function panelShowsSelectedPart(selectedPart: string | null, selectedPartInfo: unknown): boolean {
  return Boolean(selectedPart) && Boolean(selectedPartInfo);
}
```

Test it in `apps/web/src/lib/components/right-panel-branch.test.ts` by importing from the page module is not possible (Svelte component). Put the predicate in a new `apps/web/src/lib/components/panel-branch.ts` and import it into the page.

Assert:

```ts
expect(panelShowsSelectedPart(null, { title: 'Fan blades' })).toBe(false);  // hovering only
expect(panelShowsSelectedPart('fanBlades', null)).toBe(false);
expect(panelShowsSelectedPart('fanBlades', { title: 'Fan blades' })).toBe(true);
```

The first case is Review Focus #1 and is the regression itself: a non-null selection must be the gate, not mere hoverability.

- [ ] **Step 2: Implement**

Add `partsById` as a `$derived` building a `Map` from `manifest?.parts` once per manifest, and rewrite `activePart` as `partsById.get(selectedPart ?? hoveredPart) ?? null`. Keep `activePart` resolving on hover — the tooltip needs it. Change only the **branch condition** at `:1332` to `{#if panelShowsSelectedPart(selectedPart, selectedPartInfo)}`, so the overview and the part list stay mounted while the pointer moves.

Collapse the three tooltip `.find()` calls at `:1251`, `:1253`, `:1255` and the one in `formatMetric` (`:479`) to `partsById.get(hoveredPart)`.

- [ ] **Step 3: Verify the part list survives a hover sweep**

Run: `pnpm test panel-branch && pnpm build`
Then manually: open `/viewer`, move the pointer across the model, and confirm the Overview heading and the Parts list remain mounted (inspect rather than watch for a flicker). Confirm hovering still shows the tooltip.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/routes/viewer/+page.svelte apps/web/src/lib/components/panel-branch.ts apps/web/src/lib/components/panel-branch.test.ts
git commit -m "perf(viewer): hovering a part no longer tears down the parts list

activePart resolved against selectedPart ?? hoveredPart, so merely hovering
made selectedPartInfo truthy and flipped the right panel's top-level branch
- destroying and rebuilding up to 200 part buttons, with their effects and
onclick closures, on every pointer enter and exit. That is a multi-ms
synchronous block landing exactly while the pointer crosses the canvas, and
it removed the keyboard-reachable part list the moment the pointer touched
the model.

The branch is now gated on selection; the tooltip keeps hover. Four linear
scans over a proxied array per hover change collapse to one Map lookup."
```

---

### Task 6: `$state.raw` on the large replaced-wholesale state

§3.4. Svelte issue #14721 measures ~20% proxy overhead and reports frame stutter as the symptom. **Do not apply this to `progress`** — `ProgressModel` is a class whose `index` is mutated in place and read through getters.

**Files:**
- Modify: `apps/web/src/routes/viewer/+page.svelte:44-49`

- [ ] **Step 1: Change the five declarations**

`manifest`, `verdict`, `stats`, `metrics`, `parameterValues` become `$state.raw`. All are assigned a fresh value on write and never mutated in place — confirm this per declaration before changing it; any in-place mutation must stay `$state`.

- [ ] **Step 2: Verify by build and by hand**

Run: `pnpm build`
Expected: clean. Hand-check the three behaviours that break silently under a wrong `.raw`: toggle a boolean parameter (`cutaway` — its checkbox reads `checked={Boolean(parameterValues[...])}`), watch a metric tick at 1 Hz, and hover a part.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/routes/viewer/+page.svelte
git commit -m "perf(viewer): stop proxying state that is only ever replaced

manifest, stats, metrics and parameterValues are assigned wholesale and
never mutated, so the deep proxy bought nothing and charged a get trap per
property read - roughly 2,400 per hover change on a 300-part manifest.

$state.raw is the documented fit: large, effectively immutable, replaced as
a unit. progress in loading/+page.svelte is deliberately NOT converted -
ProgressModel is a class read through getters, so .raw would silently
freeze the stage chips."
```

---

### Task 7: Pointer path — one layout read per resize, not per event

§3.5. `getBoundingClientRect()` runs on every `pointermove` (up to 120/s) *before* the drag check, and each event becomes its own `postMessage`.

**Files:**
- Modify: `apps/web/src/routes/viewer/+page.svelte:176-177, 556-586`

**Interfaces:**
- Consumes: nothing.
- Produces: `canvasRect: DOMRect | null`, refreshed by the existing `ResizeObserver`.

- [ ] **Step 1: Cache the rect**

Store the rect from the `ResizeObserver` callback into a plain `let` (not `$state` — it is never read in the template), and have `onPointerDown`/`onPointerMove`/`onPointerUp` read it, falling back to `getBoundingClientRect()` when null.

- [ ] **Step 2: Coalesce `pointer` moves to one per frame**

Add a plain `let pendingPointer: { x: number; y: number; kind: 'move' | 'down' | 'up' } | null`. On `pointermove` while not dragging, store into it; send on the next `requestAnimationFrame`. `down` and `up` must send immediately — a click has to land on the exact pose the learner saw. Cancel the rAF in `onDestroy`.

- [ ] **Step 3: Handle `pointercancel`**

Add a `pointercancel` listener that clears `dragging` and cancels the pending rAF. **Review Focus #3** — without this, a cancelled capture leaves `dragging` set and the camera keeps spinning.

- [ ] **Step 4: Verify and commit**

Run: `pnpm build && pnpm test:e2e -- --grep "orbits"`
Expected: PASS. Hand-check that hover highlighting still follows the pointer and that a click still selects.

```bash
git add apps/web/src/routes/viewer/+page.svelte
git commit -m "perf(viewer): one layout read per resize, not per pointer event

getBoundingClientRect ran on every pointermove before the drag check, at up
to 120Hz, on a document that is frequently dirty - stats at 1Hz, metrics at
1Hz, hover per change. Each read can force a synchronous style and layout
flush. The existing ResizeObserver already fires on exactly the events that
change the rect.

pointer moves are now coalesced to one message per frame; down and up stay
immediate because a click must land on the pose the learner saw.
pointercancel now clears the drag state, which setPointerCapture releases
without a pointerup."
```

---

### Task 8: Chrome over the canvas stops blurring the canvas

§3.1's second half. `viewer.css:1520-1527` already documents the diagnosis — *"Stacking the overlay's blur on top of the glass panel's blur forced the compositor to re-filter every frame on integrated GPUs, freezing the page"* — and implements the blur half but not the pause half.

**Files:**
- Modify: `apps/web/src/routes/viewer/+page.svelte` (tooltip markup + style block; modal open/close handlers)
- Modify: `apps/web/src/lib/styles/viewer.css:1461-1475` (`.modal-overlay`), `:2154-2167` (`.panel` at ≤768px)
- Modify: `scripts/check-compositor.mjs` (remove four entries)

- [ ] **Step 1: Give `.tooltip-3d` real geometry**

It currently has **no CSS anywhere**, so it is a `position: static`, full-content-width block laid out over the canvas, carrying `.glass-panel`'s `backdrop-filter: blur(16px)` — a full-viewport-width blurred band that re-blurs on every orbit frame. Give it `position: absolute` plus a `bottom`/`left` offset and a max-width, and replace `class="tooltip-3d glass-panel"` with `class="tooltip-3d"` plus a solid `background: var(--bg-surface-solid); backdrop-filter: none;`.

- [ ] **Step 2: Make overlays solid where they cover the canvas**

- `.modal-overlay` — drop `backdrop-filter: blur(5px)`; it covers the full viewport including the canvas.
- `.panel` in the `@media (max-width: 768px)` block — drop `backdrop-filter`; the 0.95-alpha background already occludes it.
- `.toast` — drop the `glass-panel` class from the toast markup; give `.toast` a solid background.
- `.subtitle` — already `backdrop-filter: none` via `.code-view-modal`-style override? No: it carries `.glass` (`blur(18px) saturate(140%)`) from `base.css:117-129` and lives over the canvas in story mode. Give `.subtitle` a solid background.

- [ ] **Step 3: Remove the four allow-list entries and confirm green**

Remove `.modal-overlay`, `.tooltip-3d`, `.panel` and `.toast` from `KNOWN_OFFENDERS`, and `.subtitle` if Step 2 removed its blur. Run `pnpm verify compositor`.
Expected: PASS with only the entries removed in Tasks 4 and 8 remaining.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/routes/viewer/+page.svelte apps/web/src/lib/styles/viewer.css scripts/check-compositor.mjs
git commit -m "perf(viewer): nothing above the canvas blurs the canvas

viewer.css already diagnosed this failure - stacking the overlay's blur on
the glass panel's blur forced the compositor to re-filter every frame over
a live WebGL canvas, freezing the page - and implemented the blur half
while leaving the pause half as a comment.

The tooltip was worse than unimplemented: .tooltip-3d has no CSS at all, so
it was a static, full-width in-flow block sitting over the canvas and
carrying .glass-panel's 16px backdrop-filter. It now has real geometry and
a solid background. Modals, mobile panels, toasts and story subtitles do
the same. Chromium reproduces this pattern at 60fps down to 10-20."
```

---

### Task 9: Pause rendering behind a modal, and drop the redundant heartbeat

**Files:**
- Modify: `apps/web/src/routes/viewer/+page.svelte` (each `*ModalOpen = true`/`false` site)
- Modify: `apps/web/src/lib/engine/sandbox-worker.ts` (heartbeat post + response type)
- Modify: `apps/web/src/lib/engine/sandbox-host.ts` (heartbeat case)

- [ ] **Step 1: Pause rendering while any overlay is open**

Add one helper in the page:

```ts
function syncRenderPause(): void {
  const anyOpen = quizModalOpen || shortcutsModalOpen || shareModalOpen || galleryOpen
    || generateOpen || codeViewModalOpen || viewPresetsOpen;
  host?.setPaused(anyOpen || paused);
}
```

Call it from every modal flag assignment. **Review Focus #4** — it must read the current `paused` rather than latching, so a model that was already paused stays paused when the modal closes, and a model swapped while a modal is open does not inherit a stuck pause.

- [ ] **Step 2: Remove the heartbeat**

Delete the `post({ type: 'heartbeat', frame })` block in `sandbox-worker.ts`, the `'heartbeat'` member of `WorkerResponse`, and its `case` in `sandbox-host.ts`. The host already sets `lastHeartbeatAt` on **every** message (`sandbox-host.ts:284`), so watchdog coverage is unchanged — and the two timers share a start instant and a 1,000 ms interval, so the heartbeat posted in the same frame as `stats`, every second, forever.

Delete the now-dead second `lastHeartbeatAt` assignment inside the removed case.

- [ ] **Step 3: Release the debug global on destroy**

`+page.svelte:171-174` assigns `window.__edu3dHost`, which is never deleted. On SPA navigation away from `/viewer` it retains a closure over a disposed `SandboxHost`, so `load()` would post to a terminated worker. Delete it in the existing `onDestroy`.

Playwright drives the worker through this handle (`viewer.spec.ts:199`), so it must survive until `onDestroy` — do not remove the handle itself, only the leak.

- [ ] **Step 4: Verify and commit**

Run: `pnpm verify`
Expected: green. Hand-check that the AI Output modal does not keep the model spinning behind it, and that the watchdog still kills a runaway model — `pnpm test:e2e -- --grep "runaway"`.

```bash
git add apps/web/src/routes/viewer/+page.svelte apps/web/src/lib/engine/sandbox-worker.ts apps/web/src/lib/engine/sandbox-host.ts
git commit -m "perf: stop rendering behind a modal, and drop the redundant heartbeat

viewer.css claimed the engine's render loop is stopped while the code-view
modal is open. It is not - no handler paused it. Opening that modal over a
live canvas while the compositor re-blurs it is the exact freeze that
comment was written about.

The heartbeat went with it. Both timers start at the same instant at load
and share a 1,000ms interval, so heartbeat posted in the same frame as stats
every second. The host already treats any message as proof the worker event
loop is turning, so the message contributed nothing but a structured clone
and a performance.now() per second."
```

---

## Phase gate

After Task 9, before proposing Phase 2:

1. `pnpm verify` green.
2. `pnpm test frame-cost` — record the bytes/frame figure.
3. `pnpm test:e2e` — 14 passed.
4. Manual, on real hardware: a 5-second continuous orbit on a mid-tier machine, and a pointer sweep across the model. Record dropped frames for both. This covers spec §2.2.1's L1/L2, which CI cannot measure because Playwright runs software rendering.
5. Report to the user with those four numbers before starting Phase 2, and let the measurement decide whether Phase 2 is worth its risk — spec §8 says it may not be.