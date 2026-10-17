# EDU-3D — Production Gap Closure Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development` (recommended) or `executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring the implementation to the contract written in `Build_Docs/00`–`09`, so the product works, survives the internet, and can be shown to strangers.

**Architecture:** Ten phases ordered by blast radius. Phase 0 makes the repo safe to commit into. Phase 1 makes declared behaviour actually execute. Phase 2 makes generation succeed more often. Phase 3 makes sharing work. Phase 4 hardens the server. Phase 5 fixes viewer correctness and honesty. Phase 6 makes the product findable. Phase 7 completes the physics contract. Phase 8 completes the conversation layer. Phase 9 completes the performance contract. Phase 10 pays the code-quality debt.

**Tech Stack:** TypeScript, SvelteKit 2 / Svelte 5 runes, Hono 4, Three.js 0.185, Rapier (WASM), Zod, Vitest, Playwright, pnpm 10, Postgres.

**Spec:** `Build_Docs/00-GOAL.md` … `09-CODEBASE-QUALITY.md`, read in order. This plan argues from the spec; executors read both. Where this plan and a build doc disagree, **the build doc wins** and this plan is the thing that is wrong.

## Global Constraints

- Dependency direction is one-way and lint-enforced: `contracts` ← `sandbox` ← `engine` ← apps. The engine imports no DOM and no Three.js outside `runtime/realize.ts`, which must never enter the server bundle.
- New runtime logic lives in `packages/engine/src/runtime/` as pure, Node-testable functions — no DOM, no WebGL. The browser worker is a caller, never the home of the logic.
- Motion is **absolute** (authored base transform + `elapsed`), never accumulated, so reset and time-scrub are exact.
- Frame budgets are contracts from `08`: ≥30 fps LOW / ≥50 MID / ≥58 HIGH; <2 s time-to-first-frame on MID; <1 frame input-to-response; landing page kilobytes, never megabytes.
- Every new public function ships with a test in the same commit. No task ends with a skipped or commented-out test.
- **A change that fixes an unexpected behaviour ships with a regression test that demonstrably fails against the old code.** The RED run is not ceremony: it is the proof the test would have caught the bug. A test that passes both before and after the fix protects nothing and is a finding at review.
- `pnpm verify` (secret scan → config → format → lint → typecheck → unit+integration → build → e2e) is the single definition of done, per `09`.
- Never commit a credential. `deploy.env` is gitignored from Phase 0 onward.
- No hex literal in a component file; every colour, radius, shadow and easing is a CSS custom property in one theme sheet (`07`).
- Generated text renders as **text nodes** everywhere — chat replies, quiz explanations, part info, model descriptions (`05`).
- Comments carry _why_, cite the failure they prevent, and are never restatements of the code (`09`).

## Review Focus

Five input/failure classes the spec implies but individual task tests miss. Each gets its owning test in the task that owns the code.

1. **A visitor with no AI key** — the only person who can try the product before it is configured. Must reach a working model in one click and be told honestly what is unavailable. (2.5, 6.3)
2. **A generated model that shares cleanly** — publish → thumbnail → link → a stranger opens the link → sees _that_ model. The turbofan-fallback shipped because no test crossed the publish/load boundary. (3.1, 3.2)
3. **A parameter that changes nothing** — `00:210` says such a control is rejected, not shipped. The audit currently cannot detect it. (1.3)
4. **A learner on a budget phone on school wifi** — mobile panels, a four-minute generation, a failed publish, a weak GPU. Degrade honestly, never silently. (5.2, 9.4)
5. **Someone with curl** — no auth on the expensive AI endpoint, a spoofable rate-limit header, an ungated publish path, and a key on disk. (4.1, 4.2, 0.1)

---

# Phase 0 — Safety Net

### Task 0.1: Stop the credential leak

**Files:** Modify `.gitignore`, `scripts/check-secrets.mjs`. Rotate the key.

- [ ] **Step 1: Add `deploy.env` to `.gitignore`**, above `.env`.
- [ ] **Step 2: Prove it.** Run `git check-ignore -v deploy.env` → must print the rule.
- [ ] **Step 3: Extend the scan.** `check-secrets.mjs` derives candidates from `git ls-files`; `deploy.env` is untracked, so scan it explicitly for `AI_API_KEY=<value>`.
- [ ] **Step 4: Verify it fails.** Run `pnpm check:secrets` → must FAIL naming `deploy.env`.
- [ ] **Step 5: Rotate the key.** It is compromised by having sat unignored. Write the replacement only into `deploy.env`.
- [ ] **Step 6: Re-run and commit.** `pnpm check:secrets` → PASS. Commit `fix(secrets): gitignore deploy.env and scan it for credentials`.

### Task 0.2: Repair the failing config test

**Files:** `apps/server/tests/config.test.ts:151`, `apps/server/src/config/config.ts:244-248`.

- [ ] **Step 1: Watch it fail.** `pnpm vitest run apps/server/tests/config.test.ts` → FAIL at line 151; `PUBLIC_ORIGIN` appears only in a warning, never in `problems`.
- [ ] **Step 2: Decide.** Make it a production refusal **only when the static root is absent** (frontend deployed separately); otherwise a warning. Update the test and the adjacent comment to match reality.
- [ ] **Step 3: Pass and commit.** `fix(config): resolve the PUBLIC_ORIGIN refusal so the config suite is green`.

---

# Phase 1 — Make Declared Behaviour Execute

`00:192` — "The default state of a model is **motion**." `01:121` — "Every part that _should_ move, moves." Today nothing applies it.

### Task 1.1: Ship the loop guard to the browser

**Interfaces:** `ModelBundle` gains `runtime?: string` — instrumented source for execution; `code` stays clean for the diagnostics panel and download. The worker's `load` message accepts `{ type:'load', code, runtime?, seed }` and prefers `runtime ?? code`.

**Files:** `packages/contracts/src/wire/`, `apps/server/src/services/pipeline.ts:286`, `apps/web/src/lib/engine/sandbox-worker.ts`, `sandbox-host.ts:389`.

- [ ] **Step 1: Failing test.** `expect(bundle.code).not.toContain('__edu3d_tick'); expect(bundle.runtime).toContain('__edu3d_tick');`
- [ ] **Step 2: Verify it fails** — `runtime` undefined.
- [ ] **Step 3: Implement.** Set `runtime: prepared.instrumented`; add `runtime: z.string().optional()`; the worker compiles it.
- [ ] **Step 4: Pass.** `pnpm vitest run apps/server/tests/pipeline.test.ts` → PASS. Commit.

### Task 1.2: Build the motion applicator

**Files:** Create `packages/engine/src/runtime/motions.ts`; export from `packages/engine/src/index.ts`; call from the worker frame loop after `runFrame`, before `syncTransforms`. Test `packages/engine/tests/motions.test.ts`.

**Interfaces (Produces):**

```ts
export function resolveScalar(
  source: ScalarSource,
  params: Readonly<Record<string, number>>,
): number;
export interface MotionHost {
  motions: readonly MotionDecl[];
  baseTransform(partId: string): PartTransformLike | undefined; // authored, never mutated
  liveTransform(partId: string): PartTransformLike | undefined; // mutated in place
  params: Readonly<Record<string, number>>;
  pointOnPath?(pathId: string, t: number): Vec3 | undefined;
}
export function applyMotions(host: MotionHost, elapsed: number, paused: boolean): void;
```

- [ ] **Step 1: Failing tests.** Pin each `MotionKind` against the unit comment at `behavior.ts:48-49` (spin rad/s, translate m/s, oscillate/pulse Hz):
  - `spin` about `axis` at `rate × elapsed`, read from base
  - rate bound to a parameter: `{ rpm: 2 }` at `t=1` yields 2 rad
  - `phase` distributes orbiting bodies rather than synchronising them
  - paused holds motion still unless `runsWhilePaused`
  - **time going backwards yields the earlier pose** (reset/scrub exactness)
  - one case each for `orbit`, `oscillate`, `pulse`, `translate`, `flowAlongPath`
- [ ] **Step 2: Verify they fail** — module not found.
- [ ] **Step 3: Implement.** Always read `baseTransform`, write `liveTransform`. `oscillate` = `amplitude × sin(2π·rate·elapsed + phase)`. `pulse` scales by `1 + amplitude × (0.5 + 0.5·sin(…))`. `orbit` rotates position about `center`. `flowAlongPath` samples the path at `frac(elapsed·rate + phase)`.
- [ ] **Step 4: Wire into the worker.** Call after `builder.runFrame`, before `syncTransforms`; skip when paused unless a motion opts in.
- [ ] **Step 5: Pass and commit.** `feat(engine): apply declared motion — the reference model finally spins`.

### Task 1.3: Make the audit prove causal parameter linkage

`00:210` — "a control that changes nothing is rejected, not shipped." `01:137` names _parameter leverage_ as an audit dimension. Today the sweep credits any parameter whose sweep coincided with any part being written.

**Files:** `packages/engine/src/authoring/scene.ts:334-345`, `apps/server/src/services/audit.ts:79-108`, `packages/engine/src/reference/turbofan.ts:648-654`, `packages/engine/tests/authoring.test.ts`.

- [ ] **Step 1: Failing test.** A model declaring `cutaway` (affects visibility) whose handler only calls `scene.warn` must be rejected; a parameter driving a part through `onParameterChange` must be credited.
- [ ] **Step 2: Verify it fails** — the broken model is accepted.
- [ ] **Step 3: Implement.** Stop running `onFrame` inside the sweep. Sweep = set param → dispatch that param's `onParameterChange` → attribute those writes to it. Frame-liveness becomes a separate dimension (has `onFrame` or ≥1 motion), never conflated with per-parameter causality.
- [ ] **Step 4: Make `cutaway` real.** Swap `nacelle` ↔ `nacelleFull` visibility on toggle. Add it to the existing parameter test (`authoring.test.ts:267-271`), which currently checks only three of four.
- [ ] **Step 5: Add the runtime assertion.** Test that `spoolRpm` visibly rotates the spool — tying Task 1.2 to the model that ships it.
- [ ] **Step 6: Pass and commit.** `fix(audit): attribute parameter writes to their cause; make cutaway real`.

### Task 1.4: Remove the unbound `phys` namespace

**Files:** `packages/sandbox/src/forbidden.ts:263`, `packages/engine/src/authoring/api-surface.ts`, gate fixtures, prompt text.

- [ ] **Step 1: Confirm with grep** that `phys.body`/`phys.joint` are advertised in `GUEST_BINDINGS` but bound by no host (`guest.ts`, `node-host.ts`, `sandbox-worker.ts` all bind `scene, geom, mat, M, console, random`).
- [ ] **Step 2: Remove it everywhere** — bindings, gate fixture, API surface, prompt.
- [ ] **Step 3: Test.** A model calling `phys.body` must be rejected by the gate as `unknown_api`, not throw at runtime.
- [ ] **Step 4: Commit.** `fix(engine): remove the advertised-but-unbound phys namespace`.

### Task 1.5: Add representation fidelity to the audit

`01:45-50` — "a model whose moving parts are static-shape lookalikes is deficient and should be flagged for refinement." Trapezoid gear teeth, stacked-cylinder springs, scattered dots standing in for flow.

**Files:** `apps/server/src/services/audit.ts`, `packages/engine/src/reference/turbofan.ts`.

- [ ] **Step 1: Failing test.** A model whose only `spin` motion targets a box flagged `deficient`.
- [ ] **Step 2: Implement.** A moving part must use a motion-correct builder for its kind — spin ⇒ `gear`/`revolve`/`helix`/`sweep`, flow ⇒ `path`/`pipe` with `flowAlongPath`. Emit a named deficiency the refinement prompt can act on (`01:140`).
- [ ] **Step 3: Pass and commit.** `feat(audit): detect moving parts that are static-shape lookalikes`.

---

# Phase 2 — Generation Quality and Cost

### Task 2.1: Put real signatures in the prompt

`00:134` — "The contract is in the prompt … **because the model cannot follow rules it was never told**." `describeApiSurface()` currently emits ~108 bare names. This is the most likely driver of the 62.5% build rate: the model invents argument names, the gate rejects them, and the repair prompt re-sends the same signature-less list.

**Files:** `packages/engine/src/authoring/api-surface.ts:140-149`, `scene.ts`, `geometry/factory.ts`, `apps/server/src/services/prompts.ts`.

- [ ] **Step 1: Failing test.** Every member in `apiSurfaceSet()` must appear with a `(` and a signature — no bare-name-only entries.
- [ ] **Step 2: Verify it fails.**
- [ ] **Step 3: Implement.** Extend registration so each member carries `{ signature, summary, example }`; **reject registration missing any of the three** so this can never regress. Emit a grouped reference.
- [ ] **Step 4: Exemplify what is mandated but unshown** — `scene.instances`, `defineComponent` + `place`, `geom.pattern.*`, `geom.gear`, `scene.motion`.
- [ ] **Step 5: Pass and commit.** `feat(prompt): ship full API signatures, summaries and examples to the model`.

### Task 2.2: Separate budgets, and make cost visible

`04:58-60` — "Generation, chat and quiz have **separate budgets**"; "logs duration, token counts and pass counts per generation: cost visibility is a requirement, not a nice-to-have." Today `AI_CHAT_MODEL` is resolved, documented, tested — and never used. `usage` is parsed and discarded.

- [ ] **Step 1: Failing test.** A chat request must use `chatModel`, not the generation model; a generation log line must carry tokens and passes.
- [ ] **Step 2: Implement.** Wire `chatModel` for chat and quiz; log `{ requestId, model, attempts, passes, tokensIn, tokensOut, durationMs, outcome, promptVersion }`.
- [ ] **Step 3: Send `stream_options: { include_usage: true }`** so streaming reports usage at all.
- [ ] **Step 4: Commit.** `feat(server): separate AI budgets and log the cost of every generation`.

### Task 2.3: Make prompt changes measurable

`00:135` — "treat a prompt change like a code change with evidence — never vibes-based tuning." `battery-history.jsonl` rows carry no `promptVersion`, so rows are incomparable.

**Files:** `apps/server/src/scripts/topic-battery.ts:200, 221-226`, `audit.ts` bindingCount heuristic.

- [ ] **Step 1: Failing test.** Every row carries `promptVersion` and `model`; `bindingCount` is computed from structured deficiencies, not `String.includes` over joined prose.
- [ ] **Step 2: Implement.**
- [ ] **Step 3: Run the battery** (`--count 8`) and record `buildRate` and `averagePartCount` in the commit body. This is the number 2.1 must beat.
- [ ] **Step 4: Exempt the battery from the generate rate limiter**, or it records its own 429s as build failures.
- [ ] **Step 5: Commit.** `feat(battery): version prompt rows and measure bindings structurally`.

### Task 2.4: Never ship a partial program

`04:33` — "Truncation is detected, never shipped." `00:145` — "a half-generated model must be detected, refused and retried, never delivered."

**Files:** `apps/server/src/services/pipeline.ts:157, 165`, `ai-client.ts:418-423`.

- [ ] **Step 1: Failing tests.** `rawOutput` must be the retry text, not the truncated original; a stream aborted mid-response with partial text must return a failure, not `{ ok: true }`.
- [ ] **Step 2: Implement both.**
- [ ] **Step 3: Persist unrepairable output to `artifacts/`** (`04:35`) — the evidence the next repair is written against.
- [ ] **Step 4: Commit.** `fix(pipeline): correct rawOutput after retry; never ship a partial stream`.

### Task 2.5: Cancel when the client leaves

`04:90` — "Client disconnects mid-stream → stop charging for work nobody is waiting for." Client aborts at 6 min; server averages 6.5 min.

- [ ] **Step 1: Failing test.** Abort after the first phase → no second AI call.
- [ ] **Step 2: Implement.** Thread `context.req.raw.signal` → `runPipeline(request, onEvent, signal?)` → `AiClient.complete(..., signal?)` → `fetch`. Check before each AI call.
- [ ] **Step 3: Commit.** `fix(server): cancel the pipeline when the client disconnects`.

---

# Phase 3 — Make Sharing Work

### Task 3.1: Give the browser a publish path

`06:53-59` requires token-guarded writes. The server refuses to start in production without one and 401s without it — and the client sends no auth header anywhere, so **every publish fails in any compliant deployment**.

- [ ] **Step 1: Failing tests.** An anonymous visitor publishes with a signed single-use token → 201; a replayed token → 401.
- [ ] **Step 2: Implement.** `GET /api/publish-token` mints an HMAC token bound to a random nonce with short TTL, single-use enforced per store. `EDU3D_WRITE_TOKEN` stays for privileged callers. Tokens in headers only (`06:58`).
- [ ] **Step 3: Add idempotency to writes** (`04:68`) — a retried publish must not create a duplicate row.
- [ ] **Step 4: Commit.** `feat(server): signed anonymous publish tokens so sharing works without a login`.

### Task 3.2: Thumbnails, tags, cleanup, and a non-empty gallery

`00:273` — "Publish the model to a public gallery (with snapshot thumbnail, subject, auto-tags)." Today `snapshotUrl` is hardcoded `null` on write in both stores; tags are hardcoded `[]`; the snapshot delete matches nothing because `putSnapshot` mints its own id.

- [ ] **Step 1: Failing tests.** `GET /api/gallery` returns a `snapshotUrl` that resolves to an image; tags are non-empty; deleting a blueprint also removes its snapshot row.
- [ ] **Step 2: Implement.** Add `snapshotUrl` to the Postgres INSERT/RETURNING and the FileStore row; derive tags from `manifest.domain` + part-name tokens; parse the stored `snapshotUrl` in `delete()` the way `FileStore` already does.
- [ ] **Step 3: Upload the screenshot the client already took** — `share-modal.svelte` posts a bundle with no `snapshot`.
- [ ] **Step 4: Seed the gallery on boot** when the store is empty, so a fresh deploy demonstrates the feature.
- [ ] **Step 5: Commit.** `feat(gallery): real thumbnails, derived tags, snapshot cleanup and a seeded gallery`.

### Task 3.3: Idempotent schema and disk→database migration

`06:38` — "Schema creation is idempotent (`CREATE TABLE IF NOT EXISTS`) at startup, with a committed `setup.sql`"; "disk-snapshot migration to the database runs automatically on first boot with a database."

- [ ] **Step 1: Failing test.** Booting with a database migrates existing local-file snapshots into it.
- [ ] **Step 2: Implement.** Commit `apps/server/src/db/setup.sql`; run it idempotently at startup; migrate the fallback store's snapshots on first boot with a database.
- [ ] **Step 3: Commit.** `feat(storage): idempotent schema and automatic disk to database migration`.

---

# Phase 4 — Server Hardening

### Task 4.1: Stop trusting a client-supplied rate-limit header

`06:65` calls trust-proxy "the single most consequential deployed-server setting." The current index math takes the **leftmost** hop, which an attacker controls by sending their own `X-Forwarded-For`.

- [ ] **Step 1: Failing test.** Three requests with different spoofed headers land in one bucket.
- [ ] **Step 2: Implement.** Take the rightmost untrusted hop; document that the edge must _replace_ rather than append. Wire the real socket address instead of the literal `'127.0.0.1'`.
- [ ] **Step 3: Commit.** `fix(server): derive the client address from the rightmost trusted hop`.

### Task 4.2: Gate the publish path and cap bodies

- [ ] **Step 1: Failing tests.** Publishing a bundle whose code calls `fetch` → 400; a 10 MB body → 413.
- [ ] **Step 2: Implement.** Run `prepareProgram` + `auditModel` on the publish path before persisting, and store the instrumented `runtime`. Add a content-length check **before** parsing — the current 4 MB check runs after the body is fully in memory.
- [ ] **Step 3: Commit.** `fix(server): gate published code and cap request bodies`.

### Task 4.3: Apply the security config that already exists

`06:71` — CSP from configuration, HSTS, frameguard, nosniff. `config.security.csp` and `forceHttps` are resolved, defaulted to enforce in production, tested — and never applied.

- [ ] **Step 1: Failing tests.** CSP present in production; HTTPS redirect when configured.
- [ ] **Step 2: Implement.** Emit the computed CSP and add the redirect middleware. **The CSP must permit `'wasm-unsafe-eval'`** or the physics path silently dies in production — test that specifically.
- [ ] **Step 3: Disable `x-powered-by`** (`06:73`).
- [ ] **Step 4: Commit.** `feat(server): apply the CSP and HTTPS redirect the config already resolves`.

### Task 4.4: Drain, health and the limiter sweep

`06:88-93` — the five-step shutdown, each with a stated reason. Step 3 ("notify every open generation stream") is claimed in comments and not implemented. `06:64` — health checks exempt from every limiter; the code rate-limits them.

- [ ] **Step 1: Failing tests.** Health never rate-limited; open-stream count is true (currently doubled); stale buckets are swept; SIGTERM notifies open streams before exiting.
- [ ] **Step 2: Implement.** Mount the limiter after health/ready; remove the duplicate `openStreams += 1`; call `sweep()` on an interval; make shutdown wait for streams and emit a terminal `error` event to each.
- [ ] **Step 3: Commit.** `fix(server): exempt health from limits, drain streams honestly, sweep buckets`.

### Task 4.5: Postgres correctness

- [ ] **Step 1: Failing tests.** Deleting a missing blueprint → 404 (`|| true` makes every delete succeed); a TLS mismatch against a managed provider retries with the other `sslmode` and never overrides one the operator stated (`06:99`).
- [ ] **Step 2: Implement both.** Commit `fix(storage): real delete results and TLS-mismatch recovery`.

### Task 4.6: Honest logging, and no prompt disclosure

`06:77` — "no keys, no user topic text in full — length, not content." Today `bundle.rawOutput` ships the model's **entire reply** to the client and into Postgres; it may have restated the system prompt.

- [ ] **Step 1: Failing test.** A response containing the system prompt's text must not carry it verbatim to the client.
- [ ] **Step 2: Implement.** Redact the system-prompt fingerprint from `rawOutput`; log topic length, never content.
- [ ] **Step 3: Commit.** `fix(server): redact prompt disclosure from stored raw output`.

---

# Phase 5 — Viewer Correctness and Honesty

### Task 5.1: Theme persistence and the advertised shortcuts

`03:68` — theme "applied **before first paint** … persisted per user." Two keys are in play (`edu3d.theme` read, `edu3d-theme` written) so the preference is discarded on every navigation. `03:34` — "every toolbar control has a keyboard shortcut"; `S`, `Ctrl+G` and `Ctrl+P` are advertised and absent.

- [ ] **Step 1: Failing tests.** Theme survives a full navigation; the three shortcuts work.
- [ ] **Step 2: Implement.** One key everywhere via a single exported `toggleTheme`; add the three cases; never fire while a field has focus.
- [ ] **Step 3: Commit.** `fix(web): persist theme across navigation; wire the advertised shortcuts`.

### Task 5.2: Make mobile work

`03:33` — "Collapses gracefully to a single column on phones — panels become sheets/drawers over the canvas." Both panels are translated off-screen unconditionally and the toggles toggle a class the CSS never reads, so parameters, metrics, legend, chat and information are all unreachable on a phone.

- [ ] **Step 1: Failing test.** Phone profile: parameters visible after opening the left panel.
- [ ] **Step 2: Implement.** Bind the class the CSS actually expects; make collapsed panels `display:none` on narrow viewports so no focusable-but-invisible subtree remains. Verify Tab order.
- [ ] **Step 3: Commit.** `fix(web): make the panels reachable on phones`.

### Task 5.3: Dialogs that render, trap focus, and tell the truth

Share and AI Output render below a clipped container — two toolbar buttons and the `G` shortcut open something invisible. No modal traps focus or marks the background inert. The copy button claims success when `navigator.clipboard` is undefined (any non-HTTPS origin). Publish can throw into an unhandled rejection.

- [ ] **Step 1: Failing tests.** Share is in the viewport when opened; Tab stays inside a dialog and returns focus on close; copy reports honestly without the clipboard API; a null response body shows an error.
- [ ] **Step 2: Implement.** Wrap both modals in `.modal-overlay` like `quiz-modal-v1.svelte`; extract **one** `focusTrap` action shared by all six modals rather than six ad-hoc copies; feature-detect the clipboard; add the missing `catch`.
- [ ] **Step 3: Stop the render loop while a modal is open** (`07:75`) — a blurred overlay over a live WebGL canvas forces the compositor to re-filter every frame.
- [ ] **Step 4: Commit.** `fix(web): dialogs render in the viewport, trap focus, and stop lying about copying`.

### Task 5.4: Hover must not hijack the information panel

`03:51` — "Hover → tooltip"; hover and selection are different acts. Today moving the mouse swaps the whole right panel and unmounts the parts list — which `03` and the canvas's `aria-hidden` make the **only** keyboard path into the model.

- [ ] **Step 1: Failing test.** The parts list stays keyboard-reachable while a part is hovered.
- [ ] **Step 2: Implement.** Separate _selected_ (drives the panel) from _hovered_ (drives highlight and tooltip only); keep the list mounted; disambiguate duplicate display names — six buttons reading "Stator vanes" is unusable.
- [ ] **Step 3: Commit.** `fix(web): hover no longer hijacks the info panel; duplicate part names disambiguated`.

### Task 5.5: Failure states that are honest

`00:336` — "Never lose work … show the error, keep the page alive, offer a retry." `07:65` — two exits on every failure. `00:338` — "Degrade, never die."

- [ ] **Step 1: Failing tests.** A killed model shows an error, not an endless spinner; a slow-but-fine generation is not labelled "stopped responding" and still offers retry; a `sessionStorage` quota failure keeps the user on the loading page with an explanation instead of navigating into a turbofan; the stream ends as soon as the server says `ready`.
- [ ] **Step 2: Implement.** `onKilled` must clear `modelLoading`; use a distinct abort reason for the absolute deadline vs. a heartbeat stall; check `storeBundle`'s return value; `break` and `reader.cancel()` on a terminal event.
- [ ] **Step 3: Commit.** `fix(web): honest failure states — no silent turbofan, no endless spinner`.

### Task 5.6: One source of truth for every visible mode

`03:67` — "toolbar buttons reflect the engine's true state (a mode changed by shortcut, story beat, or interaction still shows correctly — one source of truth, buttons are followers)." `03:62` — programmatic changes reflect back onto the widgets. `03:61` — derived read-outs refresh from **every** source — panel, story beat, interaction, undo/redo — "because a metrics panel that only updates on slider drags is lying the rest of the time."

Today story-beat parameter writes bypass the undo stack and the metrics refresh, so a learner can reach a state they cannot undo or whose numbers do not update.

- [ ] **Step 1: Failing tests.** A story beat's parameter change is undoable; metrics update after an undo; a mode changed by shortcut shows the correct button state.
- [ ] **Step 2: Implement.** Route every parameter write — panel, story beat, undo, redo, interaction — through **one** owner that records history, updates widgets, and invalidates metrics. Make view-mode buttons derive from engine state, not local toggles.
- [ ] **Step 3: Commit.** `fix(viewer): one owner for parameter writes; mode buttons follow the engine`.

### Task 5.7: Accessibility a screen reader can finish

`07:81-86` treats accessibility as a requirement. The landing toast is invisible to assistive tech, the `h1` mutates a character at a time so its accessible name is unstable, `role="application"` on the canvas disables browse mode, `aria-live` covers the whole chat history, and the generate button violates WCAG 2.5.3 once its label changes.

- [ ] **Step 1: Failing tests** for each of the above.
- [ ] **Step 2: Implement.** Render the full `h1` and animate a visual overlay; `role="alert"` on the toast; drop `role="application"`; narrow `aria-live` to the newest message; keep the visible label inside the accessible name; give colour-only status dots a text alternative.
- [ ] **Step 3: Commit.** `fix(web): announcements a screen reader can finish reading`.

---

# Phase 6 — Make It Findable

### Task 6.1: Real HTML for the landing page

The page ships **no title and not one word of copy** — `ssr = false` prerenders an empty document — and no Open Graph tags, so a shared link renders blank. For a product whose entire loop is sharing, that is the loop broken at the first hop.

- [ ] **Step 1: Failing test.** The built `index.html` contains a title, a description, the hero copy and `og:title`.
- [ ] **Step 2: Implement.** Keep the viewer client-only; prerender the landing with real content; add full OG/Twitter tags with a committed 1200×630 OG image (a turbofan render), canonical, robots, and JSON-LD `SoftwareApplication`.
- [ ] **Step 3: Commit.** `feat(seo): ship real HTML, Open Graph and JSON-LD`.

### Task 6.2: A demo entry point

`00:158` forbids "we don't support that"; the visitor needs to _see_ the product before committing to a four-minute wait. The turbofan — ~40 parts, no key, no database, no login — is the proof and has no link.

- [ ] **Step 1: Failing test.** One click from `/` reaches a working model.
- [ ] **Step 2: Implement.** A prominent **See a live demo** CTA beside Generate, a footer linking the demo/gallery/repo, and a gallery entry point. **Per `07:24`, quick-start chips fill the input and focus it — they do not auto-submit**; the demo CTA is the one-click path.
- [ ] **Step 3: Let the landing page scroll.** `overflow: hidden` plus a hero hidden below `max-height: 720px` clips the one line explaining the product on short laptops.
- [ ] **Step 4: Commit.** `feat(web): a live-demo entry point and a gallery link on the landing page`.

### Task 6.3: Say what is unavailable before the user waits

`00:338` — every missing dependency is "a first-class, explained state." `04:76` — no AI key → 503 with a hint while the gallery and viewer keep working.

- [ ] **Step 1: Failing test.** With no key, the landing page explains before the user commits, and offers the demo.
- [ ] **Step 2: Implement.** Surface `capabilities` from `GET /api/health` on the landing page.
- [ ] **Step 3: Commit.** `feat(web): tell the truth about capabilities before the user commits to a wait`.

### Task 6.4: Repo hygiene

- [ ] **Step 1: License and CI.** `LICENSE` (MIT) and `.github/workflows/ci.yml` running `pnpm verify`. Without a license nobody may legally use it (`09:88`).
- [ ] **Step 2: README.** Keep the strong existing lines and add badges, a demo GIF at the top, a 60-second quick start, the no-key demo story, and measured battery numbers.
- [ ] **Step 3: Metadata.** Description plus 20 topics. **Rename** `3D_From_Scrath` → `edu3d` (a typo containing nothing anyone would search).
- [ ] **Step 4: Make it public — only after 6.1–6.2 land.**

### Task 6.5: Rewrite the e2e suite

`tests/e2e/viewer.spec.ts` targets markup that no longer exists and currently fails. Rebuild it from the current accessible names, not from classes, so the next rewrite is cheap. Cover the full flow on desktop and phone profiles (`03:126`).

---

# Phase 7 — Complete the Physics Contract

`02` is the most under-built doc. Rapier is integrated well (SI units, fixed timestep, NaN quarantine) but **no model uses it and no test runs a step**, so a degrees-vs-radians bug shipped unnoticed.

### Task 7.1: Fix the rotation units and prove physics runs

- [ ] **Step 1: Failing tests.** A 90° Rapier rotation syncs as ≈π/2 radians in the right axis; a falling body matches `s = ½gt²` within tolerance.
- [ ] **Step 2: Implement.** Convert quaternion → euler in radians, XYZ order.
- [ ] **Step 3: Write the honesty suite** `02:104-110`: conservation of momentum, density-derived mass scaling with volume, a pendulum's period plausible for its length and gravity, colliders matching authored geometry not bounding boxes, degenerate input rejected before the solver.
- [ ] **Step 4: Ship one model that uses physics** — the pendulum in `reference/` never declares `scene.physics`. Without it the status bar can never say "Physics: On".
- [ ] **Step 5: Commit.** `fix(physics): sync rotation in radians and prove the solver with real tests`.

### Task 7.2: The kinematic bridge

`02:87` — "Animated (kinematic) bodies vs. dynamic ones — moving machinery must actually push things, not leave its collider behind." `01:79` — "a conveyor belt that passes **through** the crates it should carry is a broken lesson."

- [ ] **Step 1: Failing test.** A kinematic body moving into a dynamic one imparts momentum.
- [ ] **Step 2: Implement.** Map `scene.motion` + `onFrame` transforms onto kinematic colliders each step.
- [ ] **Step 3: Commit.** `feat(physics): moving machinery pushes simulated bodies`.

### Task 7.3: Learner interaction with the simulation

`02:114-124` — "Watching correct physics is half the product; touching it is the other half." None of this exists.

- [ ] **Step 1: Failing tests.** Grab and throw hands off velocity; a tap applies an impulse; a time-scale slider changes the step rate; all of it feeds the undo history (`02:122`).
- [ ] **Step 2: Implement.** Body picking (BVH, `08:121`), kinematic override while dragging, release velocity, impulse API, `setTimeScale` surfaced in the UI.
- [ ] **Step 3: Commit.** `feat(physics): drag, throw, nudge and slow-motion`.

### Task 7.4: Observable physics

`02:51-59` — publish measured values; per-part measurement on selection (mass, speed, kinetic energy, momentum); toggleable force/velocity vectors.

- [ ] **Step 1: Failing test.** Selecting a simulated part shows its measured mass and speed, matching the solver.
- [ ] **Step 2: Implement.** Extend probes; render measurement on selection; add a vector toggle.
- [ ] **Step 3: Commit.** `feat(physics): per-part measurement and vector overlays`.

### Task 7.5: Physics edge cases

`02:65-94` — each is a stated test requirement: tunneling/CCD, contact-flood bounding, sleeping-body wake on parameter change, mid-step scene swap without double-free, repeated generate/load cycles with flat memory.

- [ ] **Step 1: Write one test per edge case** in the survival suite.
- [ ] **Step 2: Implement whatever fails.**
- [ ] **Step 3: Commit.** `test(physics): survival suite for every stated edge case`.

---

# Phase 8 — Complete the Conversation Layer

### Task 8.1: Real chat streaming

`05:49` — "Answers should **stream token-by-token** into the bubble … Streaming shares the generation pipeline's transport discipline (heartbeat, backpressure, cancel-on-navigate)." Today the server completes the whole answer and replays it in 60-char chunks at 15 ms, and the client requests non-streaming anyway.

- [ ] **Step 1: Failing test.** Deltas arrive incrementally and cancel cleanly on navigate.
- [ ] **Step 2: Implement.** Stream `/api/chat` for real; the client consumes it.
- [ ] **Step 3: Commit.** `feat(chat): true token streaming with cancel`.

### Task 8.2: Narration as a first-class setting

`05:96-104` — part narration on selection ("read it to me"), rate/pitch configurable, a persisted voice preference, absence silent. Today only story mode speaks, automatically, with no opt-in and no visible control.

- [ ] **Step 1: Failing tests.** Selecting a part speaks its info when enabled; changing selection cancels; a synthesis error never stacks or strands.
- [ ] **Step 2: Implement.** A narration setting with a toggle, rate and pitch; part selection speaks; errors cancel.
- [ ] **Step 3: Commit.** `feat(viewer): narration settings and read-it-to-me on selection`.

### Task 8.3: Mode discipline

`05:106-119` — one mode at a time, `Escape` exits, model swap unloads story and quiz ("a quiz that answers the _previous_ model is a betrayal"), each exit path idempotent.

- [ ] **Step 1: Failing tests.** Loading a new model clears the previous story, quiz and narration; entering quiz closes story; repeated entry/exit stacks no handlers.
- [ ] **Step 2: Implement.**
- [ ] **Step 3: Commit.** `fix(viewer): modes are exclusive and unload on model swap`.

### Task 8.4: Quiz depth

`05:62` — difficulty selectable, count bounded 5–20. `05:70` — results end with "guidance back into the model."

- [ ] **Step 1: Failing tests.** Difficulty reaches the request; the result panel offers a way back into the model.
- [ ] **Step 2: Implement.**
- [ ] **Step 3: Commit.** `feat(quiz): difficulty control and a result that points back at the model`.

### Task 8.5: Mode analytics

`05:109` — "Every mode is analytics-instrumented at its funnel points … because 'which teaching mode actually gets finished' is a product question only data answers." There is no analytics anywhere.

- [ ] **Step 1: Failing test.** Story start/complete, quiz start/complete with source and score band, chat by persona all emit exactly one event.
- [ ] **Step 2: Implement.** A first-party, no-cookie event sink (`08:97` — private field telemetry), disabled by default and never blocking.
- [ ] **Step 3: Commit.** `feat(analytics): first-party mode funnel events`.

---

# Phase 9 — Complete the Performance Contract

### Task 9.1: Enforce the budget table at admission

`08:33-42` — triangles (LOW ~150k / MID ~600k / HIGH ~2M), draw calls (100 / 400 / 1500), shadow-casting lights (0–1 / 2 / 4+), enforced **before allocation** — "a budget breach is never discovered as a stutter; it is prevented as a number." Manifest `cost` fields are currently trusted from the client, so a crafted bundle can claim a small model and allocate a huge one.

- [ ] **Step 1: Failing test.** A bundle claiming `triangles: 1000` that actually builds 6M vertices is refused at admission.
- [ ] **Step 2: Implement.** Price from the server-side build, not the declaration.
- [ ] **Step 3: Commit.** `fix(perf): enforce the budget table at admission from measured cost`.

### Task 9.2: Landing page carries no engine

`08:31` — "JS bundle, landing page: No engine, no physics — kilobytes, not megabytes." `landing-background.ts` statically imports Three.js to draw twenty wireframe shapes.

- [ ] **Step 1: Failing test.** No `three` chunk is requested on `/`.
- [ ] **Step 2: Implement.** Canvas 2D for the landing background; fix the `Date.now() & 1` "every other frame" bug (a millisecond clock's low bit is ~random at 60 fps); cache `getBoundingClientRect()`; replace the background's `+=` accumulation with base-relative placement so the composition stops drifting apart.
- [ ] **Step 3: Correct the stale claim** at `vite.config.ts:7-9` once it is true.
- [ ] **Step 4: Commit.** `perf(web): landing page no longer downloads Three.js`.

### Task 9.3: Download the engine during the wait

`08:89,131,135` — "the engine chunks so physics/WASM arrive **in parallel with** generation"; "the generation wait is free download time"; "a learner who just generated will open the viewer — prefetch its engine chunks during generation." Full page navigation makes this impossible.

- [ ] **Step 1: Failing test.** The engine chunk is requested while the loading page is still counting.
- [ ] **Step 2: Implement.** SvelteKit client navigation between landing/loading/viewer, plus an explicit prefetch of the viewer chunk once generation starts.
- [ ] **Step 3: Commit.** `perf(web): prefetch the engine during generation`.

### Task 9.4: Survive context loss and thermal pressure

`08:142-148` — WebGL context loss must rebuild the scene and keep the model; low-memory pressure events release caches and step down; a backgrounded tab clamps its delta. Also `08:117` zero allocation in the hot path and `08:120` dirty-flag propagation.

- [ ] **Step 1: Failing tests.** `webglcontextlost` rebuilds rather than dead-canvasing; a multi-second background delta is clamped.
- [ ] **Step 2: Implement.**
- [ ] **Step 3: Commit.** `fix(perf): survive context loss, memory pressure and backgrounding`.

### Task 9.5: Performance gates and memory tests in CI

`08:97,150-156` — budget tests, adaptive-ladder tests (no oscillation), phone-profile E2E, memory flat across N cycles, battery sanity.

- [ ] **Step 1: Write the gates.**
- [ ] **Step 2: Wire them into CI** so "a regression that doubles load time fails the build like a failing test."
- [ ] **Step 3: Commit.** `ci(perf): budget, adaptive and memory gates`.

---

# Phase 10 — Pay the Code-Quality Debt

`09` states these as gates, not suggestions.

### Task 10.1: Delete the dead code

`09:41` — "No orphans: every file is imported from somewhere or is a deliberate entry point. Dead files are deleted, not parked."

- [ ] **Step 1: Confirm each with grep**, then delete: `chat-panel.svelte` (~394 lines, superseded by `chat-panel-v1`, contains an `export function` illegal in runes mode), `quiz-modal.svelte` (~308 lines), `apps/server/src/services/model-context.ts` (zero importers; the web app has a divergent copy), and the ~1,400 lines of `viewer.css` for a settings panel, export modal, annotation overlay and QR code that do not exist.
- [ ] **Step 2: Unify `model-context`** so 05's context discipline has one implementation.
- [ ] **Step 3: Fix the stale comments** that document features which do not exist — the share modal's "QR canvas", the toolbar's "settings, export", `api.ts`'s false URL fallback.
- [ ] **Step 4: Commit.** `refactor: delete orphaned components and dead CSS`.

### Task 10.2: Split the oversized modules

`09:40` — "If a file passes ~800 lines and still has more to say, it is probably two files." `viewer/+page.svelte` is ~1,143 lines.

- [ ] **Step 1: Identify seams** — the toolbar, the parameters panel, the information panel, and the six modals are natural modules.
- [ ] **Step 2: Extract them** with unchanged behaviour; the e2e suite from 6.5 is the safety net.
- [ ] **Step 3: Commit.** `refactor(web): split the viewer shell into focused modules`.

### Task 10.3: Consolidate the design tokens

`09`/`07:9` — one theme sheet, no hex in components. Today `tokens.css` and `theme.css` each define half the system, with two conflicting implementations of the ambient cursor block, `.sr-only` and `:focus-visible`, and a documented circular-reference footgun already hit once.

- [ ] **Step 1: Failing test.** No duplicate token definitions; no hex literal outside the theme sheet (lint rule).
- [ ] **Step 2: Consolidate**, keeping the legacy family as aliases rather than removing them in one risky sweep.
- [ ] **Step 3: Commit.** `refactor(css): one token source, no duplicate definitions`.

### Task 10.4: CHANGELOG and commit discipline

`09:97` — "A `CHANGELOG` or release note habit for user-visible changes; commit messages that say _why_ in the subject line."

- [ ] **Step 1: Start `CHANGELOG.md`** with the Phases 1–6 user-visible changes, then maintain it per release.
- [ ] **Step 2: Commit.** `docs: changelog for the production gap closure`.

---

# Final Verification

```sh
pnpm verify         # secrets → config → format → lint → typecheck → unit+integration → build → e2e
pnpm test:e2e       # desktop and phone profiles
git status          # clean
```

Then, by hand:

1. Fresh clone, `docker compose up`, open the landing page, click **See a live demo**, drag **Spool speed** — the fan turns.
2. Generate "how does a pendulum work" — you get _that_ model, and physics reads On.
3. Toggle **Cutaway** — the nacelle changes.
4. Share → publish → open the link in a private window — same model, with a thumbnail.
5. Rotate a phone — both panels reachable; touch-orbit works.
6. Paste the URL into a message — the preview card renders.
7. Drag a slider in story mode, then `Ctrl+Z` — it undoes, and the read-outs follow.
8. `curl -X POST /api/generate` 20 times with a spoofed `X-Forwarded-For` — the limiter holds.
