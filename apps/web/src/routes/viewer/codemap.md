# apps/web/src/routes/viewer/

## Responsibility

The viewer: the full app shell hosting the sandboxed engine (`SandboxHost` + Web Worker), toolbar/left/right panels/bottom bar, all modal state, the model-load priority chain, and the atomic swap every model entry point funnels through.

## Design

- Single `+page.svelte` owning all shell state as `$state` (`leftOpen`/`rightOpen`/`activeTab`/`activeMode`/`viewMode`, the seven modal flags, `theme`, `topicName`, `deviceTier`, toast list). Engine events arrive through `callbacks: HostCallbacks` and write into it (`onLoaded` adopts the manifest, resets parameter defaults and calls `unloadModes()` so a model swap unloads the previous model's story/quiz; `onKilled` nulls `manifest`/`stats` and toasts).
- `manifest`, `verdict`, `stats`, `metrics`, `parameterValues` are deliberate `$state.raw`: every write reassigns a fresh value (parameter writes spread), never mutates — so deep proxies would only charge a `get` trap per property read across hundreds of parts on every hover and inside `code-view-modal`'s `JSON.stringify`. Classes like `ProgressModel` must stay deep-`$state` (their instances mutate in place; `.raw` would silently freeze them).
- `lib/core/settings.ts:SettingsStore` (plain class, not rendered) holds the persisted quality pin; `pinnedQuality` mirrors it into `$state` at mount and `setPinnedQuality()` rewrites it via `settings.update({ quality })` + `host.setQuality(...)`, toasting honestly ("Auto" unpins; a pin warns instead of silently adapting).
- Deriveds build lookup Maps once per manifest — `partsById`/`metricsById` (replacing per-hover linear `.find()` over the proxy) — plus `activePart` (`selectedPart ?? hoveredPart`), `listedParts` (first 200 selectable non-group parts), `selectedPartInfo` and `overviewHtmlSafe` (only text-safe manifest fields: name, description, pedagogy). The right panel's top-level branch is gated by `$lib/components/panel-branch.ts`: `{#if selectedPartInfo && panelShowsSelectedPart(selectedPart, selectedPartInfo)}` — selection drives the panel, hover only the tooltip.
- One `$effect` owns render pausing: it reads every modal flag + `paused` through `anyOverlayOpen()` / `shouldPauseRender()` before calling `host.setPaused()` — reading both before acting is what makes it impossible to latch (a pause for one modal must not leak into the next model; a user-paused model stays paused).
- Pointer path: `canvasRect` cached via `ResizeObserver`; `dispatchPointer` sends `down`/`up` immediately and coalesces `move` to one requestAnimationFrame sample (`shouldSendPointerNow`, `toCanvasPoint`, `flushHover`); `onpointercancel` is bound alongside `pointerup` so a lost capture cannot strand the `dragging` flag.

## Flow

- Mount: `sandboxSupported()` gate → `Ambient` with grid/spotlight/blobs all disabled (over an opaque WebGL canvas) → `new SandboxHost(canvasHolder, callbacks, { quality: pinnedQuality })` → `start()` → `host.setTheme(readThemeColors())` → load by priority (`03` R2): `?model=<id>` → `loadFromGallery` (GET `/gallery/:id`; failure toasts and falls back to `REFERENCE_MODEL_SOURCE`), else the stored session bundle (`takeBundle()` → `host.load(code, 7, storedRuntime(bundle))` — the instrumented `runtime` twin gives the model its browser-side loop guard), else `host.load(REFERENCE_MODEL_SOURCE, 7)`. A frozen `window.__edu3dHost` diagnostic handle is installed and deleted in `onDestroy` (before `host.dispose()`).
- Keyboard handler (inert while typing in `input/textarea/select`): space/r toggles, `1–6/v` → `host.viewPreset`, `x/w/e` → `setViewMode`, `f` fullscreen, `g` → AI Output, `s` → story, `t` theme, `?` → shortcuts, `ctrl+z/y` → undo/redo, Escape closes all modals, then exits `activeMode`, then clears selection + normal view.
- Mode entry: `enterStory` requires `manifest.story.length`; `enterQuiz` prefers authored `manifest.quiz` (`quizSource: 'authored'`) else POSTs `/quiz` with `toContext(manifest, selectedPart)`, count 5, mixed difficulty (`quizSource: 'generated'`) and toasts when unavailable.
- Atomic model swap: `swapInModel(code, name, runtime)` (gallery's `onload` / generate-dialog's `ongenerated`) sets `modelLoading`, closes both dialogs and calls `host.load(...)` with a random seed — a failed load leaves the previous model on screen (`03` R2).
- Parameter gestures: `onParameterInput` → `noteParameterGesture()` (600ms batch window) → snapshot into `undoStack`/`redoStack` → `host.setParameter`; undo/redo reapply snapshots through the host.
- Teardown: `cancelPendingHover()`, delete `__edu3dHost`, `host.dispose()`.

## Integration

- `$lib/engine/sandbox-host.ts` (`SandboxHost`, `sandboxSupported`), `$lib/engine/sandbox-worker.ts` (`SerializableVerdict`); `$lib/core/api.ts` (`apiFetch`, `takeBundle`, `storedRuntime`), `$lib/core/settings.ts:SettingsStore`, `$lib/core/render-pause.ts` (`anyOverlayOpen`, `shouldPauseRender`), `$lib/core/pointer.ts`, `$lib/core/model-context.ts:toContext`; `$lib/ambient.ts` (`getTheme`, `setTheme`); all seven `$lib/components/*`; `@edu3d/engine:REFERENCE_MODEL_SOURCE`; contracts `ModelManifest`, `QualityPreset`, `QuizQuestion`, `RuntimeStats`.
- Endpoints: `GET /gallery/:id` (shared-link entry), `POST /quiz` (generated questions). Styles: `viewer.css` + `viewer-extended.css`; scene colors come from the token sheets via `readThemeColors()` (`--scene-bg-top/bottom`).
