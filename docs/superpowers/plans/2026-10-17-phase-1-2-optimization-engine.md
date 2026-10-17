# Optimization Engine — Phase 1 + 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the in-flight work on a green `pnpm verify`, put a per-builder cost stat and a transient-churn gate in place, then drive the frame path's allocation churn to near zero.

**Architecture:** The spec's Phase 1 (baseline + in-flight) and Phase 2 (zero-allocation frame path). `createFrameContext` was already hoisted by commit c296983, and `frame-cost.test.ts` measures *retained* bytes only — so this plan adds the missing instrument (a GCPerformanceObserver churn gate) before touching code. Everything is host-side; no sandbox capability changes (spec A2).

**Tech Stack:** TypeScript, Vitest 5 (node env), GCPerformanceObserver from `perf_hooks`, pnpm 10.

**Spec:** `docs/superpowers/specs/2026-10-17-optimization-engine-design.md` — §4 Phases 1–2, §1 invariants Q10.

## Global Constraints

- `pnpm verify` green before every commit (secrets → config → compositor → format → lint → typecheck → unit → build → e2e).
- No change to `contracts/wire/sandbox.ts` deadlines or to any sandbox capability (spec A2/I1).
- `packages/engine` and `packages/sandbox` stay DOM-free (spec A3); `apps/web/src/lib/engine/frame-compose.ts` may import `three` but must be Node-testable without a WebGL context.
- Measured numbers cited in commit messages; never claim a speedup not measured (spec Q10).
- Uncommitted work already in the tree is landing in Task 1 by the user's decision — commit it in logical pieces, never `git add -A`.

## Review Focus

1. **Motion-driven parts under `runsWhilePaused` while paused** — the pose must stay correct when the unpaused clock advances but the pausable clock is frozen; the per-part persistent pose arrays must not alias across parts. *(Task 5)*
2. **Two motions driving one part's position channel** — `resetMotionDrivenParts` in-place writes must not reorder visible outcomes versus the copying behaviour. *(Task 5 — pinned by characterization before the change)*
3. **Slider drag on a paused model** — the parameter must still visibly re-pose the model within one frame without the synchronous extra frame. *(Task 7 — pinned by existing e2e)*
4. **A guest `onFrame` that throws** — the dirty-flag frame must not swallow the throwable the old in-handler code reported. *(Task 7)*
5. **Churn gate stability** — V8 may scavenge for reasons unrelated to the frame path; the gate compares a frame run against an idle run over equal iteration counts, not an absolute zero. *(Task 3)*

---

### Task 1: Land the in-flight work in logical commits

The tree holds prompts v7, a new dev console with its test, telemetry in host/worker, and landing polish. Four commits, each green in isolation. Do not bundle with anything later in this plan.

**Files:**
- Commit A: `apps/server/src/services/prompts.ts`, `apps/server/tests/prompts.test.ts`
- Commit B: `apps/web/src/lib/dev-console.ts`, `apps/web/src/lib/dev-console.test.ts`, `apps/web/src/lib/engine/sandbox-host.ts`, `apps/web/src/lib/engine/sandbox-worker.ts`
- Commit C: `apps/web/src/lib/styles/landing.css`, `apps/web/src/routes/+page.svelte`, `apps/web/src/lib/components/generate-dialog.svelte`
- Delete: `ab.tmp.mjs`, `cc.tmp.mjs`, `ho.tmp.mjs`, `place.tmp.mjs`

- [ ] **Step 1: Run the two unit suites that cover the new files**

Run: `pnpm test prompts && pnpm test dev-console`
Expected: PASS. If a suite fails, fix the test or the code until green — that is the "complete, not just commit" requirement from the user.

- [ ] **Step 2: Typecheck and lint the touched files, then build; record the Phase 1 baseline**

Run: `pnpm typecheck && pnpm lint && pnpm build && pnpm test frame-cost`
Expected: all green. Record in this commit series' final message (Task 3 cites them): the build's
wall-clock seconds and the frame-cost benchmark's retained-bytes figure. Per-builder timing does
not exist yet — Task 2 adds the stat; whole-build time is what Phase 1 records.

- [ ] **Step 3: Commit A (prompts v7), then B (dev console), then C (landing polish)**

```bash
git add apps/server/src/services/prompts.ts apps/server/tests/prompts.test.ts
git commit -m "feat(prompts): v7 — build-and-frame discipline, reference turbofan as exemplar"
git add apps/web/src/lib/dev-console.ts apps/web/src/lib/dev-console.test.ts \
  apps/web/src/lib/engine/sandbox-host.ts apps/web/src/lib/engine/sandbox-worker.ts
git commit -m "feat(web): dev-only stage telemetry for dead-model diagnosis"
git add apps/web/src/lib/styles/landing.css apps/web/src/routes/+page.svelte \
  apps/web/src/lib/components/generate-dialog.svelte
git commit -m "style(landing): polish pass on the topic card"
```

- [ ] **Step 4: Delete the scratch scripts**

```bash
rm ab.tmp.mjs cc.tmp.mjs ho.tmp.mjs place.tmp.mjs
```
(All four are untracked; nothing to commit.)

---

### Task 2: Per-builder timing stat in GeometryFactory

The number every later phase cites. No UI yet — surfacing is Phase 6 of the spec.

**Files:**
- Modify: `packages/engine/src/geometry/factory.ts` (`register()`, new `buildTimings()`)
- Test: `packages/engine/tests/geometry.test.ts` (append)

**Interfaces:**
- Produces: `GeometryFactory.buildTimings(): ReadonlyMap<string, number>` — cumulative ms per builder name, accumulated across `register()` calls; cache hits add nothing.

- [ ] **Step 1: Write the failing test**

```ts
it('records cumulative per-builder build time and ignores cache hits', () => {
  const f = new GeometryFactory(6_000_000);
  f.sphere({ radius: 1 });
  f.box({ width: 1, height: 1, depth: 1 });
  const once = f.buildTimings();
  expect(once.get('sphere')).toBeGreaterThanOrEqual(0);
  f.sphere({ radius: 1 }); // identical shape — cache hit, must not bill
  expect(f.buildTimings().get('sphere')).toBe(once.get('sphere'));
  expect(f.buildTimings().get('box')).toBeGreaterThanOrEqual(0);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm test geometry`
Expected: FAIL — `buildTimings` is not a function.

- [ ] **Step 3: Implement**

In `register()`, time only the miss side (`builder` callback); on hit, return early exactly as now. Use `performance.now()`. Accumulate `timings: Map<string, number>`. Export the method; add the field beside `hits`/`misses`.

- [ ] **Step 4: Run the suite; commit**

Run: `pnpm test geometry`
Expected: PASS, plus the whole existing geometry suite (761 lines) still green.

```bash
git add packages/engine/src/geometry/factory.ts packages/engine/tests/geometry.test.ts
git commit -m "perf(engine): time every builder, so cost claims are citable"
```

---

### Task 3: The churn gate — measure transient allocation, not just retention

`frame-cost.test.ts` is blind to short-lived objects by its own header. This adds the missing instrument: a `GCPerformanceObserver` counting scavenges during a frame run versus an idle run over the same iteration count. The difference is attributable churn.

**Files:**
- Modify: `packages/engine/tests/frame-cost.test.ts`

**Interfaces:**
- Produces: exported helper `countScavenges(run: () => void): number` — observer-wrapped invocation returning minor-GC event count; used by the gate and reusable by later phases.

- [ ] **Step 1: Add the helper and the comparative gate**

```ts
it('the frame path does not churn: frame-run scavenges ≈ idle-run scavenges', () => {
  const idle = countScavenges(() => { for (let i = 0; i < FRAMES_PER_SAMPLE; i++) { Math.sin(i); } });
  const frame = countScavenges(() => runFrames(FRAMES_PER_SAMPLE));
  expect(frame, `idle=${idle} frame=${frame}`).toBeLessThanOrEqual(idle + MAX_CHURN_SCAVENGES);
});
```
`runFrames` is the existing harness loop. `MAX_CHURN_SCAVENGES` starts pinned to the *measured* value with 50 % headroom (Step 2 tells you the number); the plan tightens it at Task 8.

- [ ] **Step 2: Run it, read the numbers, pin the constant**

Run: `pnpm test frame-cost`
Expected: PASS on the first run *only because* the constant was pinned from measurement. Record `idle` and `frame` in the commit message — those two numbers are the before picture for Q10.

- [ ] **Step 3: Commit**

```bash
git add packages/engine/tests/frame-cost.test.ts
git commit -m "test: a churn gate that can see what the retained-bytes gate cannot"
```

---

### Task 4: `applyMotions` — zero-allocation math

`motions.ts` allocates per motion per frame: `normaliseAxis`, five `readVec3` literals, `frameDelta`, the `scoped` context spread, quaternion intermediates, and `eulerFromQuatXyz` output.

**Files:**
- Modify: `packages/engine/src/runtime/motions.ts`
- Test: `packages/engine/tests/motions.test.ts` (append a characterization pin BEFORE changing: run each existing case's expected poses — the suite is the characterization; add one that pins `frameDelta` composition correctness)

**Interfaces:**
- Consumes: existing `resolveScalar`, `MotionHost`, `ScalarContext` — signatures unchanged.
- Produces (new, module-private): `readVec3Into(out: Vec3Tuple, src, fallback)`, `quatFromAxisAngleTo(out: QuaternionTuple, axis, angle)`, `quatMultiplyTo(out, a, b)`, `eulerFromQuatXyzTo(out, q)`, and one module-level scratch `MOTION_CTX` reused per call.

- [ ] **Step 1: Pin behaviour before touching it**

The existing 534-line `motions.test.ts` asserts exact absolute poses. Record: `pnpm test motions` PASS. Add one test pinning that two motions on one part's position channel compose exactly as today (the Review Focus #2 characterization):

```ts
it('two position-channel motions compose the frame delta exactly as before', () => {
  // spin-less orbit + translate on the same part — assert the composed position equals
  // base + (motionOffsetA) then (motionOffsetB applied on top), matching current values.
});
```

- [ ] **Step 2: Convert the helpers to out-parameter form; hoist scratch**

Every allocation inside the per-motion `switch` becomes a write into module-level scratch. The `scoped` context spread becomes `MOTION_CTX` field mutation, re-entrant because `resolveScalar` is pure arithmetic and `applyMotions` never re-enters itself within a call.

- [ ] **Step 3: Verify behaviour unchanged (the suite is the proof)**

Run: `pnpm test motions && pnpm test frame-cost`
Expected: motions PASS unchanged; the churn gate's `frame` number drops materially (record before/after).

- [ ] **Step 4: Commit**

```bash
git add packages/engine/src/runtime/motions.ts packages/engine/tests/motions.test.ts
git commit -m "perf(engine): applyMotions writes into scratch, not fresh tuples"
```

---

### Task 5: reset/sync — persistent pose arrays and spread-free sync

**Files:**
- Create: `apps/web/src/lib/engine/frame-compose.ts` (pure, Node-testable, imports `three`)
- Create: `apps/web/src/lib/engine/frame-compose.test.ts`
- Modify: `apps/web/src/lib/engine/sandbox-worker.ts:901-1105` (delegate to the new module)

**Interfaces:**
- Consumes: `manifest.parts`, `model.parts` (the realized `Map<string, THREE.Object3D>`), `motionBases`, `runsWhilePausedParts`.
- Produces: `resetMotionDriven(parts, bases, pausedOnly, scratch)` and `syncTransforms(model, manifest)` — the sync writes position/rotation/scale as scalar assignments (`.x =`), never `set(...spread)`, and caches per-part material channels; the reset keeps one persistent `[number,number,number]` per part keyed by part id in a `Map`, copying base→live in place so nothing is allocated per part per frame.

- [ ] **Step 1: Characterize the old behaviour in the new test file**

Stub object3Ds (`{ position: {x,y,z}, rotation: {x,y,z}, visible }`) do not need real three; write the characterization tests against fake transforms first: paused-with-flag resets, dangling part id skipped, material channel writes once and unchanged when identical.

- [ ] **Step 2: Implement; delete the spread calls; keep the outer worker signatures**

`resetMotionDriven` writes `live.x = base.x` style through persistent per-part arrays held in `target.motionPoses` (a `Map<partId, [number,number,number]>` created once at load). Alias risk (Review Focus #1) is avoided because each part owns its array; the array is never shared with `base`.

- [ ] **Step 3: Verify: unit suite + the e2e orbit and parameter tests**

Run: `pnpm test frame-compose && pnpm build && pnpm test:e2e -- --grep "orbits|parameters"`
Expected: PASS. The e2e drag-order test proves Review Focus #2 in the real renderer.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/lib/engine/frame-compose.ts apps/web/src/lib/engine/frame-compose.test.ts \
  apps/web/src/lib/engine/sandbox-worker.ts
git commit -m "perf(worker): the pose reset and transform sync allocate nothing per frame"
```

---

### Task 6: One frame at a time — params record and setParameter dirty flag

**Files:**
- Modify: `apps/web/src/lib/engine/sandbox-worker.ts:919-980, 1345-1365`

**Interfaces:**
- Consumes: `currentParameters()` (exists on `SceneBuilder`).
- Produces: `target.paramsRecord: Record<string, number|boolean|string> | null` — rebuilt lazily on the next frame after `setParameter` invalidates it; `applyDeclaredMotions` reads it and never calls `Object.entries`.

- [ ] **Step 1: Delete the synchronous extra frame**

`setParameter` sets `state.paramsRecord = null`, calls `wakeAll()`, sets `state.needsFrame = true`. `renderFrame` consumes: if `needsFrame`, run the guest frame once this tick (guard reset exactly as the old block did), then clear the flag.

- [ ] **Step 2: Prove the paused-slider case (Review Focus #3) and the throwable case (#4)**

The paused case: the rAF loop runs even when paused today (Phase 3 changes that), so the next tick carries the flag — assert via the existing e2e (`--grep "parameters"`) which drags while the model runs, plus one new e2e: pause, set parameter, expect the read-out change. The throwable case: runFrame inside `renderFrame` is wrapped by the existing per-frame try/catch — confirm by grepping that the old in-handler `catch {}` is gone and nothing else swallowed it.

- [ ] **Step 3: Verify and commit**

Run: `pnpm test frame-cost && pnpm test:e2e -- --grep "parameters"`
Expected: PASS; churn gate unchanged or better.

```bash
git add apps/web/src/lib/engine/sandbox-worker.ts
git commit -m "perf(worker): one frame per tick — setParameter invalidates, renderFrame consumes"
```

---

### Task 7: Camera — coalesce gestures to once per frame

**Files:**
- Modify: `apps/web/src/lib/engine/sandbox-worker.ts:1406-1448`

- [ ] **Step 1: Handlers stop calling `updateCamera`**

`orbit`/`zoom`/`pan` mutate `state.orbit` and set `state.cameraDirty = true`; `renderFrame` calls `updateCamera` once when the flag is set and clears it. `pan` reads `matrixWorld` and reuses two module-level `THREE.Vector3` scrubs.

- [ ] **Step 2: Verify with the existing orbit e2e**

Run: `pnpm test:e2e -- --grep "orbits"`
Expected: PASS (drag still rotates, triangles still drawn).

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/lib/engine/sandbox-worker.ts
git commit -m "perf(worker): camera gestures coalesce to one update per frame"
```

---

### Task 8: Ratchet the gate, record the numbers

**Files:**
- Modify: `packages/engine/tests/frame-cost.test.ts`

- [ ] **Step 1: Re-pin `MAX_CHURN_SCAVENGES` from the post-fix measurement with 25 % headroom; record idle/frame before-and-after in the commit message**
- [ ] **Step 2: Full gate**

Run: `pnpm verify`
Expected: green end-to-end.

```bash
git add packages/engine/tests/frame-cost.test.ts
git commit -m "perf(phase-2): the frame path churns N scavenges then M — gate ratchets to the number"
```
