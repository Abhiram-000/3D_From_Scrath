# apps/web/src/lib/components/

## Responsibility

Every interactive UI part the viewer hosts as a leaf component: the left-panel tutor chat, the in-viewer modals/dialogs (code view, gallery, generate, quiz, share), story mode, plus `panel-branch.ts` — the pure predicate that decides which branch the right panel takes. Visibility is _not_ owned here: `routes/viewer/+page.svelte` mounts each one behind an `{#if}` flag and passes callbacks in.

## Design

- Props in via `$props()`, effects out as callbacks: every modal takes `onclose` plus a completion callback (`ontab`, `onload`, `ongenerated`) instead of touching page state; the page closes it by flipping its own flag.
- State ownership is per-component workspace only — `chat-panel-v1.svelte` owns `messages`/`input`/`persona`/`thinking` (persona persisted under `edu3d.persona` via localStorage, restored in an `$effect`); `gallery-modal.svelte` owns `entries`/`search`/`offset`/`loadingModel` pagination state; `generate-dialog.svelte` owns `topic`/`progress`/`AbortController`; `quiz-modal-v1.svelte` owns `answered`/`score`/`finished`; `story-mode.svelte` owns beat `index` + `advanceTimer`. Model data (`manifest`, `story`, `questions`) always arrives as props, never fetched inside.
- Deriveds: `chat-panel-v1.svelte:suggestions` (`$derived.by`, seeded from `toContext(manifest, selectedPart)`), `quiz-modal-v1.svelte:question`, `story-mode.svelte:beat`.
- Effects: `story-mode.svelte` re-runs its play/stop cleanup per beat index (drives camera focus, parameter writes, narration, auto-advance); advance never latches — SpeechSynthesis `onend`/`onerror` fall back to the reading-time timer (`holdSeconds ?? 6`).
- `panel-branch.ts:panelShowsSelectedPart(selectedPart, selectedPartInfo)` returns true only for a non-empty `selectedPart` AND truthy info. The comment is the spec: `activePart` resolves `selectedPart ?? hoveredPart`, so embedding that resolution inline flipped the panel's top-level branch on every hover — destroying/rebuilding the overview's up-to-200 part buttons synchronously while the pointer crossed the canvas, and removing the keyboard-reachable part list. "Hover belongs to the tooltip. Selection belongs to the panel."
- Modal chrome is not re-implemented: components reuse `viewer.css`'s `.modal-overlay.active` / `.modal-container.glass-panel` shell; `code-view-modal.svelte` is deliberately _solid_ (`backdrop-filter:none`) because it stacks potentially thousands of lines of text over the live WebGL canvas (the compositor-freeze fix documented in `viewer.css`).

## Flow

- Chat: `send()` guards `thinking`, appends the user message, POSTs `/chat` via `apiFetch` with `{message, persona, history (last 12, sans welcome id 0), context: toContext(manifest, selectedPart), stream:false}`; on failure the text returns to `input` with an honest assistant note. `render()` serves only text nodes with a constrained `**bold**` renderer; `onScroll`/`scrollToBottom` implement near-bottom auto-scroll (60px) and the jump button (>160px).
- Code view: `rawCode = $derived(peekBundleCode() ?? '(the model came from the reference set…)')`; tabs are lifted state (`ontab`); `copy()`/`download()` (Blob) work on the raw text or `JSON.stringify(manifest)`; meta chips report `manifest.cost.*` and `warnings`.
- Gallery: `onMount → refresh(true)` hits `GET /gallery?limit=24&offset=…&search=…`; a card calls `load(entry)` → `GET /gallery/{entry.id}` → `onload(code, name, runtime)`; broken loads surface `error` rather than navigating.
- Generate: `start()` runs `generateStream` with `detectTier()` and a 150ms `ProgressModel` tick; events feed `progress.apply` + dev-console logging; success stores via `storeBundle(...)` and hands over with `ongenerated(code, name, runtime)`; `cancel()` aborts; failure offers "Try Again" / "Keep current model".
- Quiz: caller supplies `questions` and `source` (`authored` = written for this exact model, `generated` = fetched); `answer()` locks options once per question id (score counts once), `next()`/`restart()` walk and reset; correct/wrong marks stay visible beside the explanation.
- Story: `play()` calls `onfocus(beat.targetPartId ?? null)` (engine's `focusPart`; dangling target skips the move, not the narration), pushes `beat.setParameters` through `onsetParameter` — the page's single owner of parameter writes so beats join the same undo history — and `go(±1)`/Escape/close never trap the learner.
- Share: `onMount → publish()` POSTs `/gallery` with `{bundle: {manifest, code: peekBundleCode() || REFERENCE_MODEL_SOURCE, …(runtime)}}`; without a backend the link still resolves to bare `/viewer` (session storage serves it in this browser); `social()` opens prebuilt intent URLs.

## Integration

- Sole consumer: `routes/viewer/+page.svelte`; the right panel's branch test there is `{#if selectedPartInfo && panelShowsSelectedPart(selectedPart, selectedPartInfo)}` — behaviour pinned by `panel-branch.test.ts` (hover-only info must stay on the overview; a selection with no info must not open an empty panel).
- Calls `$lib/core/api.ts` (`apiFetch`, `generateStream`, `storeBundle`, `peekBundleCode`, `peekBundleRuntime`), `$lib/core/model-context.ts:toContext`, `$lib/core/loading-progress.ts` (`ProgressModel`, `STAGES`), `$lib/dev-console.ts`, `$lib/engine/sandbox-host.ts:detectTier`. Theme and settings are page-level: the viewer page consults `lib/core/settings.ts:SettingsStore` (quality pin) and `setTheme`, not these components.
- Contracts: `ModelManifest`, `ChatPersona`, `QuizQuestion`, `StoryBeat` from `@edu3d/contracts`; server endpoints `POST /chat`, `GET /gallery`, `GET /gallery/:id`, `POST /gallery`, `POST /generate` (through `generateStream`).
