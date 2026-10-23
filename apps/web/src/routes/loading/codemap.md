# apps/web/src/routes/loading/

## Responsibility

The generation-progress page: drives the AI generation stream end-to-end, reports honest progress against real server phases, and hands the validated bundle to `/viewer` — or shows the two-exit failure card.

## Design

- One `+page.svelte`, an exact V1 port (`.scene-loader` with halo + three tilted orbit rings, `.progress-stages` chips with per-stage SVG icons + connectors, `.fact-container`, `.error-container` with `.retry-btn`/`.back-btn`); stylesheet `$lib/styles/loading.css` verbatim.
- The early-beta line (`.beta-note`, a `.status-message` companion) sits under the live status text so the wait reads as attributed rather than broken: a real 3D program is being written, and coverage is uneven. It is a plain paragraph in `--text-dim`, not an alert.
- All state is page-local `$state`: `topic`, `barWidth`, `statusText`, `currentStage`, `completedStageCount`, `fact`, `factLeaving`, `failed`, `failureMessage`, `canRetry`, `success`, `running`.
- The reactivity subtlety that shapes this page: `progress` holds a `ProgressModel` _class instance_ as plain `$state` — it must not be `$state.raw` (the model mutates `index` in place and is read via getters; `.raw` would silently freeze the stage chips), but even deep-`$state` doesn't make the class reactive. So every renderable value is copied out in one place, `renderProgress()`, from `progress.view()` into the page's own `$state` fields — bar, status line and stage chips read the same snapshot and cannot disagree.
- Owned timers/handles, all cleared in `cleanup()` (the `onMount` return): `progressTimer` (120ms `progress.tick()` — V1's exact tick), `factTimer` (6.5s fact rotation), an `AbortController` for the stream, plus the `LoadingBackground` and `Ambient` instances.

## Flow

- `onMount`: `takeTopicFromSession()` reads `edu3d.topic` (what the landing page's `storeTopic` wrote); arriving without one is a lost session, not a generation to bill — `showError(..., {canRetry:false})` immediately. Then ambient mounts (grid/magnetize/sheen), `LoadingBackground.init(bgCanvas)`, `initParticles` unless `prefers-reduced-motion`, `FactQueue` seeded from the topic drives the fact card, and `startGeneration()` runs.
- `startGeneration()`: `generateStream({ topic, complexity: takeComplexity(), tier: detectTier().tier, signal, onEvent })`. Every event — heartbeats included — calls `progress.apply(event)` + `renderProgress()`, because any event proves the run is alive. ProgressModel's milestones come from the server's phase vocabulary; the bar only passes a milestone when its phase actually started and never moves backwards.
- Success path: `success = true` (the flourish — orbits pause, logo greens per `.loading-content.success`), `storeBundle({ code, manifest, raw, galleryId? })` — carrying the id the terminal `ready` event named so the viewer's Publish updates that auto-saved entry rather than adding a duplicate — then `window.location.href = '/viewer'` after 900ms so the completed state is actually seen.
- Failure path: `showError(message)` stops the timers; `network` gets "the backend is not running", `stalled` hides retry (`canRetry:false`), `aborted` is silent (user-initiated). The error card's two exits: `retry()` keeps the topic; the back button navigates to `/` so the learner can change it.

## Integration

- `$lib/core/api.ts`: `generateStream` (POST `/generate`, NDJSON stream with heartbeat/stall/total timeouts), `storeBundle` (session storage bundle consumed by the viewer's `takeBundle`/`storedRuntime`), `takeComplexity`.
- `$lib/core/loading-progress.ts`: `ProgressModel`, `STAGES`, `StageName`, `FactQueue` — phase slices derived from `@edu3d/contracts` `GENERATION_PHASES`.
- `$lib/engine/sandbox-host.ts:detectTier` supplies the device tier at request time; `$lib/ambient.ts`; `$lib/loading-background.ts` (`LoadingBackground`, `initParticles`).
- Styles from the styles lane (`loading.css`); downstream navigation partner `routes/viewer/`.
