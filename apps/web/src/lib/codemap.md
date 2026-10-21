# apps/web/src/lib/

## Responsibility

Browser-side helpers shared by the three routes: the ambient cursor/theme system, two decorative three.js page backgrounds (landing wireframe polyhedra, loading neural points), the compile-time-gated dev console, and the landing input gate. `core/` and `engine/` have their own codemaps; this file covers the root modules.

## Design

- `ambient.ts` — one `requestAnimationFrame` loop for five cursor effects (dot-grid mask via `--gx/--gy`, eased spotlight, `data-parallax` drift, `data-magnetic` pull, sheen sweep via `--sx/--sy`); only transforms and custom properties, never layout. `ambientLayerRequested()` and `Ambient.mount()` refuse to append anything or start the loop when every effect is off — the viewer's case, because an inert layer still occupies the frame queue and its `blur(60px)` blobs re-rasterise over an opaque canvas every presented frame. Tracking auto-disables without `(hover: hover) and (pointer: fine)` or under reduced motion. Theme helpers `getTheme/setTheme/toggleTheme` write `THEME_STORAGE_KEY` (from `@edu3d/contracts`) under `theme-switching` transition suppression and dispatch `edu3d:themechange`.
- `landing-background.ts:LandingBackground` — corner-biased translucent wireframes; float is base-relative oscillation (`basePosition` in `userData`), not integrators, so shapes never walk into the headline; `pushClearOfCopy` projects and walks shapes clear of the 640px copy column _after_ scale is applied; any WebGL failure hides the canvas instead of taking the page.
- `loading-background.ts` — `LoadingBackground` (points + O(n²) neighbour lines rebuilt every other frame, all disposers collected for `destroy()`) and `initParticles` DOM accents, suppressed under reduced motion.
- `dev-console.ts` — loggers are static ternaries on `import.meta.env.DEV` (`devEnabled`), so production minifiers remove every call and string (grep `DEV_PREFIX = '[edu3d:dev]'` in prod chunks: zero). Injected sink (`DevSink`/`setDevSink`) for tests; pure formatters (`formatModelSummary`, `formatFailure`, `formatStats`, `devTimer`) are the deliberate exception to stripping.
- `validate-topic.ts:suspiciousContent` — needle list (`<script`, `javascript:`, `data:text/html`, `<iframe`, `eval(`) plus `/on\w+\s*=/i`; in its own module so Svelte's template parser never scans the needles.

## Flow

`routes/+page.svelte` mounts `Ambient` + `LandingBackground` and gates the topic; `routes/loading/+page.svelte` mounts `Ambient` + `LoadingBackground`/`initParticles`; `routes/viewer/+page.svelte` uses a fully-off `Ambient` plus the theme helpers. Both backgrounds re-tint on the `edu3d:themechange` CustomEvent that `ambient.ts:setTheme` dispatches — that event is the internal boundary between the theme system and the decorations.

## Integration

Depends on `@edu3d/contracts` (`THEME_STORAGE_KEY` only, in `ambient.ts`) and `three` (the two backgrounds). Consumed by all three route pages; `dev-console.ts` is consumed by `lib/engine/sandbox-host.ts`, `lib/engine/sandbox-worker.ts` and `components/generate-dialog.svelte`. `components/panel-branch.ts` and `styles/` live here but belong to the components lane.
