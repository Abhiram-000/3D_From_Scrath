# BUILD DOC 03 — THE VIEWER

> Read `00-GOAL.md` first. This document states _what the viewer must achieve and how it must feel_. Layout details, framework, module structure — your decisions. The requirements below are the contract; the bar at the end is the ambition.

## Mission

The viewer is where every promise of the platform is kept or broken. The user has waited one to three minutes; now the model is on screen. Within seconds they must understand what they are looking at. Within a minute they must be _playing_ with it. Every capability the engine and the AI's model offer — parts, physics, camera, parameters, stories — becomes real here, or it does not exist.

The viewer is the product. The rest is plumbing for it.

## Structure requirements

### R1 — The three-column layout

```
+--------------------------------------------------------------+
|  Toolbar: model name | playback, view, x-ray, wireframe,     |
|            explode, fullscreen, theme, generate, share,      |
|            settings, help, undo/redo                          |
+------------+---------------------------------+---------------+
|  LEFT      |                                 |  RIGHT        |
|  PANEL     |                                 |  PANEL        |
|  Parameters|         3D CANVAS               |  Info tab     |
|  (live-    |    (orbit / pan / zoom,          |  Chat tab     |
|  bound to  |     click / hover parts,         |  (AI tutor)   |
|  the model)|     annotate)                   |               |
+------------+---------------------------------+---------------+
|  Status bar: fps, device tier, quality preset, sim time      |
+--------------------------------------------------------------+
```

- Panels are **collapsible** so the canvas can go full-bleed; the canvas resizes correctly after a collapse (observe size changes, don't listen to window resize only)
- **Collapses gracefully to a single column on phones** — panels become sheets/drawers over the canvas, touch parity for every mouse capability
- Every toolbar control has a **keyboard shortcut**, and no shortcut fires while the user is typing in a field
- Tooltips are screen-reader-friendly, `aria` labelled, focusable in order

### R2 — Startup that never strands the user

- The shell (toolbar, panels, buttons) wires up **even when the engine fails to start** — no WebGL, a crashed model, a dead backend must all leave a page that can _explain itself_, not a frozen loading overlay and dead buttons
- Boot order: engine → annotations → layout → modes → extended UI; a failure at any step is caught, reported, and the remaining steps still run
- Loading a model resolves, in priority order: **shared link → session spec → gallery pick → on-disk fallback → honest error** with a path forward (back to landing, retry, generate)
- A model load either fully succeeds or **leaves the previous model on screen** — atomic swap, never a half-built scene
- The first frame after load is the authored camera framing the whole concept — never an auto-fit that crops the lesson

### R3 — Part interaction and the info loop

Clicking a part is the platform's core gesture — the moment the model explains itself:

- **Click → select**: highlight the part, focus the camera on it, and fill the right panel with its info — title, explanation, and _live measured facts_ (type, tags, mass, speed, kinetic energy when simulated, which instance of a repeated placement was hit)
- **Hover → tooltip**: name plus authored bullet points, following the pointer, vanishing on exit
- **Click empty space → deselect**: return to the model overview, clear the highlight
- All model-authored text renders as **text nodes, never interpolated HTML** — generated content is untrusted input; a description containing markup must be displayed, not executed
- Narration on selection (text-to-speech of the part's info) when voice is enabled — the "read it to me" path

### R4 — Parameters panel that never lies

- Widgets are generated from the model's declared parameters: sliders, toggles, color pickers, each with label, unit, and formatted value
- **Widget updates go through one owner** that knows each parameter's type and formatting — writing `input.value` directly breaks checkboxes, colors, and decimal precision
- Changes apply to the engine **on the next frame** while running, and still visibly update state while paused
- **Undo coalesces per gesture**: a slider fires on every pointer move; one drag is one undo step, snapshotted _before_ the first change, or fifty history slots fill with fragments of a single gesture and undo becomes useless
- Derived formula read-outs refresh on _every_ parameter change, wherever it came from — panel, story beat, interaction, undo/redo — because a metrics panel that only updates on slider drags is lying the rest of the time
- Programmatic changes (a story beat sets a parameter) reflect back onto the widgets — the panel shows the model's true state

### R5 — Display modes

- **Play / Pause / Reset**: motion freezes and resumes _exactly_ mid-state; reset restores authored time = 0, parameter defaults, and the initial camera
- **X-ray, wireframe, explode** toggle as engine view effects; toolbar buttons reflect the engine's true state (a mode changed by shortcut, story beat, or interaction still shows correctly — one source of truth, buttons are followers)
- **Dark / light theme**, persisted per user, applied **before first paint** (inline in the document head — never a white flash), with the 3D backdrop following the theme
- Fullscreen hides browser chrome; state survives entering/exiting

### R6 — Learning modes

- **Story mode**: beats move the camera (cinematic focus), set parameters, and narrate; subtitle overlay; optional voice narration; auto-advance with reading time; prev/next; disabled with an honest tooltip when a model has no authored story
- **Quiz mode**: authored questions are used when the model ships them — **generation from the API is the fallback, not the default**; options are rendered and answerable; scoring against the authored correct index; distractors that teach
- **Chat**: an AI tutor panel with context about the current model (name, description, parts, parameters), multiple personas (teacher, study buddy, engineer, ELI5, socratic)
- Mode entries are guarded: entering story mode with no story says so; a model swap unloads the previous model's story and quiz — a quiz that answers the _previous_ model is a betrayal

### R7 — Annotations

- Learner pins labelled notes to points on the model; pins **stay glued to geometry** as the camera orbits (world point re-projected each frame), hide behind the camera, never overlap the panel chrome
- Persisted per model in local storage; storage failures are non-fatal (session-only annotations still work); hard cap so a stuck click can't fill storage
- Mode is toggleable from the toolbar and by shortcut, with a clear "click the model to add a note" affordance

### R8 — Share, gallery, export

- **Share** publishes the model (if not already) and produces a link + QR code that opens _that exact model_; a dead-end (backend down) is reported honestly — a link that can't resolve is worse than no link
- **Gallery** browsable from the viewer (thumbnails, subjects, search); loading a gallery model is an atomic swap like any other
- **Export**: screenshots at viewport resolution and at authored resolutions (HD/4K — resize, render, capture, restore); video clip recording of the canvas with codec fallbacks and a duration cap
- A **diagnostics panel** shows what the AI actually produced for this model — raw output vs. what runs — the first tool anyone reaches for when a model looks wrong

### R9 — The status bar and trust

- FPS, device tier, quality preset, simulation time, vertex count — **always visible, always honest**
- Adaptive quality step-downs surface a notice ("Quality reduced to keep the frame rate smooth") — a user who sees the picture soften without explanation assumes the app is broken
- Physics unavailable on this device? Say so. Never fake it

## The bar: a viewer that feels like an instrument

Correct wiring is the floor. The target:

- **Alive at rest**: with no input, the model breathes — auto-rotate, subtle motion, hover glows. A viewer that is inert until clicked wastes the 3D medium
- **Instant everywhere**: hover, select, drag a slider — all respond within a frame. Anything slower reads as broken, whatever the cause
- **Discoverable without docs**: tooltips, the help modal, disabled-button explanations, empty-state text — the UI teaches itself
- **Error states are guidance, not dead ends**: "Backend not running — start it with `npm run server`" beats "Network error" the way a teacher beats a shrug
- **Never loses the user's work or place**: a failed generation, a crashed model, a dead backend — the previous model stays on screen and every panel keeps working
- **Every number on screen is true**: FPS is measured, metrics are computed, physics read-outs are simulated values — nothing is decorative
- **Quiet when idle, loud when it matters**: notifications are short-lived and rare; the canvas is the hero

## Edge cases — survive all of these

- Engine fails to boot (no WebGL) → the shell still works, the error explains itself
- A module fails to load → the rest of the viewer still initializes; one broken script must not kill the page
- Model swap while a mode is active → story/quiz unload cleanly; no stale callbacks fire against the new model
- Render loop stopped for a modal (fullscreen overlays over a live canvas cost the compositor) → restarted on close
- Panel collapse mid-model → canvas resizes; annotations re-project
- Rapid generate → load → generate → the app stays responsive; nothing leaks (GPU memory, event listeners, rAF handles)
- Clipboard/QR/fullscreen APIs missing → feature reports unavailable, viewer unaffected
- Theme switched mid-session → 3D backdrop follows without a flash or a re-render stall
- Storage unavailable (private browsing) → theme defaults, annotations session-only, everything else unaffected
- Deep link to a dead gallery id → honest message + fallback model, never a blank viewer

## Testing

- **Unit**: parameter widget generation and formatting per type; undo coalescing per gesture; panel-info assembly from authored data (structure, not markup); annotation projection math
- **Integration**: boot with a dead engine; load fallback; atomic swap (load failure leaves the previous scene); parameter change → engine + metrics + widget round-trip
- **E2E (real browser, desktop and phone profiles)**: landing → generate → viewer flow; part click shows info; slider changes the model; theme persists; share link resolves; screenshots and recording produce real files; every toolbar button does its one job

## What you decide

Framework (vanilla or otherwise), module split, state management, exact widget set, how the render loop and the UI loop divide work — yours. The contract: every capability above is present, honest, fast, and survives its edge cases.

## The final image

A learner opens a shared link. The model is already framed, already moving. They hover — the part names itself. They click — the camera glides in, the panel explains, the voice reads. They drag a slider — the machine obeys, the numbers follow. Ten minutes later they are still there, x-ray on, quiz running, annotating the rotor for their lab report. That is the viewer you are building.
