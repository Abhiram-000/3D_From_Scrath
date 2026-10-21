# Live verification and v1 parity

**Started:** 2026-10-22
**Driver:** orchestrator session, autonomous run against a live browser (Playwright MCP, real
Chromium) plus the v1 reference implementation at `/home/abhiram/Project/3D_Platform/EDU_3d_V1`.

## What this run is for

Two questions the test suites cannot answer on their own:

1. Does the platform work when a real person uses it — browser, console, network, a real paid
   generation, every viewer control?
2. v1 was a working product. What did it do better that v2 should carry forward?

Method: exercise the deployed and dev builds in a real Chromium, read the console and the network,
compare against `Build_Docs`, and fix what is found — committing each fix so a mistake is one
`git revert` away.

## Environment facts established

- **8787 is the Docker container** `3d_from_scrath-edu3d-1`, image built **2026-10-13**. It serves a
  build eight days old (`entry/start.UTWoTGlF.js`). It is _not_ the current source.
- **8788 is the current source** (`node --env-file=apps/server/.env src/main.ts`, no `--watch`),
  serving `apps/web/build` from `main` (`entry/start.DWbaCoDw.js`). All current-code verification
  runs against 8788.
- The container's stale build is why two "bugs" found in the first pass (theme key `edu3d-theme`,
  Reset leaving parameters) had to be re-checked against current source before being believed.
- `pnpm verify` failed on **formatting** for 61 files: `.playwright-mcp/*.yml` (60, browser session
  artifacts) + `opencode.json`. Fixed in `7f772f4` by ignoring the artifacts for formatting and git.

## Live findings (real browser, current source unless noted)

Confirmed working (no console errors or warnings anywhere):

- Landing → streamed `/api/generate` → audit → viewer, one generation, ~2 min, NDJSON progress
  honest and monotonic (49% → 53% → ready during the model phase).
- Sandbox worker spawns, model realises, 30–35 parts, 58–88 draw calls, 20k–389k triangles,
  105–240 FPS on the desktop profile, tier `mid`, quality `Adapted`.
- Play/pause freezes every live metric and the clock; slider change updates derived metrics live
  (spool 4800→12000 rpm moved thrust 19.5→19.9 kN, fan tip speed 754→1885 m/s); undo/redo restore
  both the slider value and the metrics.
- Part selection (fan blades) shows info text + properties; x-ray, wireframe and explode each change
  the render and are mutually exclusive; view presets dropdown offers front/back/left/right/top/
  bottom/iso.
- Reloading `/viewer` falls back to the reference turbofan — the generated bundle lives in a module
  singleton, so F5 loses it. Intended (the bundle is big) but undocumented for the learner.

### Live-confirmed, with measurements

**Phone panels (B1).** At 390×844 the panels measure `left: -390` and `left: 390` with
`transform: translateX(∓100%)`; pressing "Left Panel" adds only `.collapsed`, which sets `width: 0`
on top of the same transform — the panel is squeezed to nothing off-screen. A phone learner has no
parameters, no chat and no information panel, and the existing phone E2E only measures the canvas
width, so it passes while the surface is unreachable. Evidence: `live/12-phone-initial.png`,
`live/13-phone-left-panel-open.png`.

**Reset (M1).** On the reference turbofan, dragging spool speed to 12 000 rpm and pressing Reset left
it at 12 000 rpm while the clock did return to 00:00. `03` R5 and `00-GOAL.md:298` both define Reset
as time zero + parameter defaults + the authored camera pose.

**Console is clean, with one benign exception.** The only console output across landing, loading,
viewer and a phone viewport is a CSP _report-only_ violation from `zod`'s feature probe
(`Function('')` inside `zod/v4/core/util.js`, bundled into `BuQFvmqT.js`). Zod catches the EvalError,
the platform is unaffected, and `WORKER_POLICY` already grants `'unsafe-eval'` to the worker chunks
that genuinely need it (`packages/sandbox/src/compile.ts`). Recorded rather than "fixed": silencing it
would mean loosening the document policy for a probe that is designed to fail closed.

**E2E honesty.** Two viewer tests (`draws frames rather than a single static image`,
`selects a part from the keyboard-reachable list and describes it`) skip themselves via
`requireRealFrameRate()` because the suite's headless software rasterizer cannot hit 10 fps. The skip
is documented and honest, but it means **motion over time and part selection are not covered by the
suite** — the live browser run (real GPU, 105–240 fps) is what verifies them here.

### E2E honesty (found live)

Two viewer tests skip themselves via `requireRealFrameRate()` because the suite's headless software
rasterizer cannot hit 10 fps (`tests/e2e/viewer.spec.ts:47-55`). The skip is documented and honest,
but it means **motion over time, part selection, view-mode toggling and pause/resume are not
covered by the suite at all** — the live browser run (real GPU, 105–240 fps) is what verifies them
here. Queued improvement: make those assertions renderer-independent (dispatch events directly
instead of relying on Playwright's frame-stability actionability checks; widen time windows
proportionally to the measured frame rate) so the suite keeps its teeth on a GPU-less CI box.

## Findings to fix

Graded from the live run, from the code audit against `Build_Docs`, and from the v1 comparison.

### Blockers

| #   | Finding                                                                                                                                | Evidence                                                     |
| --- | -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| B1  | Phone: both side panels are unreachable — CSS slides them off-screen expecting `.active`, the page only ever toggles `.collapsed`      | `viewer.css:2168-2196` vs `viewer/+page.svelte:1253,1506`    |
| B2  | No Settings surface at all, while `settings.ts` and the routes codemap claim one; the quality pin can never be set, so the ladder wins | `viewer/+page.svelte:816-1246`, `settings.ts:15`, codemap:11 |
| B3  | `pnpm verify` red on formatting (fixed in `7f772f4`)                                                                                   | verify log                                                   |

### Major

| #   | Finding                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Evidence                                                         |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| M1  | Reset resets time only, not parameter defaults or the authored camera (`00` :298, `03` R5) — confirmed live: Reset left spool at 12000 rpm                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | `viewer/+page.svelte:842`, worker `resetTime`                    |
| M2  | Annotations missing entirely (contract + CSS exist unused); v1 had world-pinned notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | `contracts/settings.ts:78-95`, `viewer.css:3320`                 |
| M3  | Share has no QR code (`00` :274) although the CSS exists; v1 shipped a real ISO-18004 encoder                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | `share-modal.svelte:162-274`                                     |
| M4  | No video clip recording, no multi-resolution screenshot — one 1200×675 snapshot only (`00` :279-280)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | `sandbox-host.ts:646`, `viewer:865`                              |
| M5  | Physics is implemented (Rapier, SI, tested) but no model ever declares it: the prompt contract never mentions `scene.physics`; status bar says Off                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | `prompts.ts:352-370`, `audit.ts:434`                             |
| M6  | Status bar omits `quality`, `effectiveTier`, `physicsMillis`, `cacheHitRate` even though the worker reports them                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | `budgets.ts:138-161`, `viewer:1606-1652`                         |
| M7  | Chat never streams (`stream:false` hardcoded) and the server's "stream" re-chunks a finished completion                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | `chat-panel-v1.svelte:145`, `app.ts:585-608`                     |
| M8  | Story narration speaks regardless of the narration setting; no "read it to me" on part selection                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | `story-mode.svelte:47-116`, `settings.ts:44`                     |
| M9  | Gallery entries publish with no thumbnail (`00` :273)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | `share-modal.svelte:115-117`                                     |
| M10 | No touch parity: no pinch-zoom, two-finger pan, double-tap focus (`00` :72)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | `viewer:741-778`                                                 |
| M11 | Several toolbar controls have no shortcut and Generate's tooltip claims `G` (which opens AI Output)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | `viewer:922` vs `viewer:322-324`                                 |
| M12 | Selecting a part replaced the whole information panel, so the parts list — the only mouse-free selection path (`panel-branch.ts:11`) — disappeared; a learner was stuck on the first part they touched, and the E2E test that selects two parts in a row fails for this reason (`travels the camera to the part the learner selects`)                                                                                                                                                                                                                                                                                                             | `viewer:1665` / `1725-1744`                                      |
| M13 | **Story mode froze the whole viewer.** Opening it on the reference model throws `effect_update_depth_exceeded` within seconds: the story component's beat effect tracked its callback props, and the page passed them as inline arrows — so a beat's parameter write re-rendered the page, which handed down fresh callbacks, which re-ran the effect, forever. Svelte then stops applying state: clicks are ignored and the model clock stops. The suite never saw it because its only story assertion sits behind `requireRealFrameRate`                                                                                                        | `story-mode.svelte:58-62`, `viewer:1753-1759`                    |
| M14 | **The engine validated nothing at the authoring boundary where zod parsing runs inside the guest realm.** Two halves: (a) `scene.motion` copied `rate`/`amplitude` verbatim, so `rate: 2` survived the gate, both repair passes and the audit, then died as `motions.rate: Invalid input` after a **55-minute** run; (b) the obvious remedy — parse the contract schema at the boundary — throws `Function is not available inside the model sandbox`, because the sandbox poisons `Function` and zod's fast path touches it. `PhysicsDeclSchema.safeParse` was already there from before, latent only because no model had ever declared physics | `scene.ts` (17 `as never` casts), `scene.ts:1526` (pre-existing) |
| M15 | `api-reference.ts` documented `scene.light kind?: 'area'` — a kind `LightKind` has never had — while omitting `ambient`, `hemisphere` and `rect`. The table travels verbatim in the generation prompt, so the documentation taught an illegal call                                                                                                                                                                                                                                                                                                                                                                                                | `api-reference.ts:1257`                                          |

### Live-verified fixes (same day)

- **B1** — at 390×844 both panels now measure `left: 0, width: 390` with the `active` class, and the toolbar toggle collapses and restores them (`live/18-phone-panel-open.png`).
- **B2** — the Settings dialog opens from the toolbar and from `,`; quality presets render `Auto*/Low/Mid/High` with the detected tier shown; picking **High** toasts "Quality pinned to high. The ladder will not step down on its own.", persists `quality: "high"` in `edu3d.settings.v1`, and the status bar immediately reports the live preset `high`. Controls the engine cannot honour (shadows, post-processing, physics preference, reduced motion, camera sensitivity) render disabled with the reason.
- **M6** — the status bar now reports `Cache 100%` and the live `Quality medium` instead of the admission verdict's "Adapted".
- **M12** — the parts list is hoisted out of the info panel's branch, so it survives a selection.
- **M13** — the beat effect tracks only `index` (`untrack`) and the page passes stable named callbacks; a new E2E asserts no `effect_update_depth_exceeded`, that Next advances the beat, and that Cancel closes the overlay.
- **M14** — boundary validation is being rewritten structurally (no zod at guest-realm runtime) with a hardened-realm regression test.
- **M15** — the light-kind union is rendered from `LightKind.options` and welded by a new test.

### Baseline suite state (before this run's fixes)

`pnpm verify` on the committed tree: secret scan, config, compositor, formatting, lint, typecheck, unit (714 tests) and build all **pass**; **E2E fails** with 3 failures and 14 skips of 50. The failures are `travels the camera to the part the learner selects` (desktop + phone — M12, where the fix removes the need for a frame-rate skip) and `a paused model still answers parameters` (phone — B1). The 14 skips are all `requireRealFrameRate`, which is why the story freeze shipped.

### Found late, and the biggest one

**Physics had never run in a browser, on any device (M16).** With a live model that
declares `scene.physics`, the status bar read "Unavailable" — and, before this run's status-bar
work, it would have read "On" while only a toast admitted otherwise. The reason string blamed the
device; the real cause was ordering. `hardenRealm` deletes `WebAssembly` (PLAN §A1 layer 4), and
`PhysicsWorld.create` called `RAPIER.init()` during a load — after hardening. The compile therefore
never happened, and `02` R1's degraded path disguised a dead feature as a weak device.

Verified by making the failure say what it was (`Physics could not start: WebAssembly is not
defined.`), then fixed by warming the runtime at worker boot and **awaiting it before
`initRenderer` hardens the realm**. Because `ready` now arrives one compile later, messages that
arrive mid-boot are deferred: the host sends `init` and `load` back to back, and a `load` that
overtook boot hit `if (!state) return` and vanished — a viewer that loaded nothing, silently.

Verified live afterwards: a model declaring a world, a body and a speed probe reports
`Physics 0.1–0.2 ms` in the status bar and the solver steps (`live/21-physics-running.png`).

### Verified live after the final rebuild

Panels reachable at 390×844 · story opens, advances to `2 / 5`, closes, console empty · Reset returns
4800 rpm _and_ the authored camera (9.9 m → 4.8 m) · the parts list survives a selection (35 buttons)
· `x` toggles X-ray · a note pins to a world point, renders, and persists under
`edu3d.annotations.Two-spool turbofan` with its `partId` · the quality pin reaches the ladder and the
status bar · Physics reports solver time for a declared world · no console errors anywhere (the only
noise is zod's `Function('')` probe tripping report-only CSP).

**Share, publish and gallery, end to end:** opening the share dialog published the model, produced
`/viewer?model=b03e0c16-…`, rendered a **QR canvas 270×270 with a 37% dark-module ratio** (real barcode
content, not a decorative pattern), and labelled the reference model honestly ("the link shares it
as-is, not an AI-generated model"). The gallery holds one entry with a **snapshot thumbnail** that
serves as a 178 KB PNG at the HD preset and loads in the gallery card, and the shared link opened cold
in a new tab loads the same model — 35 parts, 3 parameters, no console errors.

**Chat streaming, end to end (and one bug it exposed):** the tutor's answer streamed in progressively
(749 characters rendered while the composer was still disabled, so text arrives _before_ the completion
ends) — but the composer never re-enabled: at 30 s and 55 s the send button was still disabled, with no
typing indicator and no error. Reading the code confirmed the cause: `consumeStream` tracks the
provider's terminal event but only exits its read loop when the provider _closes the socket_, and this
provider sends its terminal chunk then holds the connection open — so no terminal event was ever
written, `chatStream` never settled, and the panel's `finally` never ran. A learner could ask exactly
one question per page load. Fixed at the transport (exit on the provider's terminal event, release the
reader), which is the same hang class the generation path could hit. Not re-verified live: the fix
landed after this run's last browser session.

### Commits

`7f772f4` verification artifacts out of the gates · `9947bf5` physics compiled before hardening ·
`3440064` structural authoring validation + API-table enums · `c30f781` physics reachable + v1 prompt
rules · `8b1a91a` real streaming chat · `7746549` settings, narration, quality pin · `dcee3ba` QR,
thumbnails, gallery honesty · `7b2ba6d` notes, export, honest physics read-out, Reset · `c39d9e3`
viewer pass (panels, reset, story, status, shortcuts) · `592a42f` docs and codemaps.

### Still open

- **E2E coverage.** 14 of 50 tests skip themselves below 10 fps (`requireRealFrameRate`), which is
  how the story freeze shipped. Making those assertions renderer-independent (dispatch events
  directly; widen windows in proportion to measured frame rate) is the next test-quality job.
- **Two sources of truth for the drain.** `app.ts` still carries `AppState.draining`/`openStreams`
  while `services/lifecycle.ts` owns the real drain signal and open-generation count; routes read one,
  the pipeline and AI client read the other. They agree today, and that is the whole risk — one fact
  with two homes is the defect class this codebase has already paid for twice (the theme key, the chat
  persona).
- **The deployed container** is an image from 2026-10-13 and serves a build eight days old; it must
  be rebuilt for the deployment to match `main`.
- Streaming chat, notes and export are verified in unit/integration tests and by hand at the DOM
  level, but they have no E2E assertion yet.
- The `live/` screenshots and `.playwright-mcp/` snapshots are evidence, git-ignored on purpose.

## Order of work

### v1 parity worth porting (format-free)

- Real QR encoder; annotations; multi-resolution export; audio SFX; honest client watchdog wording.
- Prompt rules: **mathematics/graphing** (explicit axes, graph dominant, helix forbidden for a sine),
  domain-archetype selection and **causal completeness** (a source with no edge to its mechanism is
  rejected — the "floating battery" failure).
- Auto subject + auto tags on publish; non-repeating topic-aware facts on the loading screen.
- "No link is better than a link that cannot work": publish before showing a share link.

## Order of work

1. B1 + M1 + M6 + M11 in one pass over `viewer/+page.svelte` (the integration file; one writer only).
2. B2 Settings modal + quality pin wiring.
3. M2 annotations, M3 QR, M4 export, M9 thumbnail (v1 parity surface).
4. M5 physics contract + audit + status truth; M7 real streaming chat; M8 narration gating.
5. M10 touch parity.
6. Prompt rules from v1.
7. `pnpm verify` green, then rebuild the Docker image so the deployed artifact matches `main`.
