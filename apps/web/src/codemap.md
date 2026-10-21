# apps/web/src/

## Responsibility

The SvelteKit app root: the HTML document, the ambient type declarations, and the `lib/` helper tree the three routes render from. This is the whole frontend source; there is no server-side rendering code.

## Design

- `app.d.ts`: all five `App` interfaces (`Error`, `Locals`, `PageData`, `PageState`, `Platform`) are declared present but empty — a documented decision (static build; the browser `fetch`es `apps/server`), not an omission.
- `app.html` owns the theme-before-first-paint contract: an inline, synchronous `<head>` script reads `localStorage['edu3d.theme']` and sets `data-theme` + `style.colorScheme` on `<html>` before any stylesheet applies (`07`'s no-flash rule). Reads are try/caught because private browsing throws; `'edu3d.theme'` is a hand-maintained mirror of `THEME_STORAGE_KEY` from `@edu3d/contracts` (the script cannot import), asserted to match by `src/theme-key.test.ts`. `data-theme="dark"` is the markup default that stands when storage is unavailable.
- Different module scopes by design: landing/loading/viewer pages live in `routes/` (separate lane); helpers, `core/`, `engine/`, `components/` and `styles/` live under `lib/`. Sensitive validation strings (e.g. `<script` needles) are kept out of `routes` so Svelte's template parser never scans them.

## Flow

Document load → inline theme script → SvelteKit mounts the route (`data-sveltekit-preload-data="hover"` on `<body>`): `routes/+page.svelte` (landing) constructs `new Ambient({grid:true, magnetStrength:0.12, magnetRadius:130})` and the topic form; `routes/loading/+page.svelte` runs the generation stream against a quiet neural-points background; `routes/viewer/+page.svelte` constructs `new Ambient({grid:false, spotlight:false, blobs:false})` — so `lib/ambient.ts:Ambient.mount()` appends nothing and starts no loop, and only the three.js engine canvas remains.

## Integration

Any submodule imported after `%sveltekit.head%`/`%sveltekit.body%` are filled at build. Contains `lib/` (see `lib/codemap.md`, plus separately documented `lib/core/` and `lib/engine/`), `routes/`, and `static/` (favicon). Only external boundary is `@edu3d/contracts` via `THEME_STORAGE_KEY`.
