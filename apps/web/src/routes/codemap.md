# apps/web/src/routes/

## Responsibility

The SvelteKit route tree root: the layout that installs the global CSS pipeline and the app-wide render configuration, and the landing page (`/`) that converts a typed topic into a navigation to `/loading`.

## Design

- `+layout.svelte` imports `$lib/styles/base.css` and renders `{@render children()}` from `$props()`; it carries zero chrome — every page owns its own markup. Its comment records the layering contract: tokens.css first, theme.css loaded last so it wins every shared custom-property name.
- `+layout.ts` exports `prerender = true`, `ssr = false`, `trailingSlash = 'never'`: static HTML shells with client-only islands. Deliberate because pages fetch no server-side data (the API is another origin), the viewer is browser-only, and skipping hydration mismatch keeps the landing first paint cheap (`08`).
- `+page.svelte` is the full landing page (V1 port: `.landing-container` → header + hero + footer, plus a fixed wireframe `<canvas>` behind it), with exactly one scoped `<style>` block: `.landing-container`, `.is-leaving` — the fade-out navigation transition, which is new-app behavior.
- Invariants the page encodes: the `<h1>` keeps the full headline in a `.sr-only` span while the typed span is `aria-hidden` (a stable accessible name during the typewriter); the Detail control is a native `<select>` populated from `COMPLEXITY_LEVELS` so its promise (parts ranges) and the generation prompt's ask cannot drift; `Enter` submits / `Shift+Enter` newlines in the textarea; the caret is a drawn bar (`.cursor-blink`), suppressed by CSS under reduced motion where the mount hook renders the headline in full instead.
- The early-beta framing lives here too: a `.beta-badge` span (real text, not a control — nothing to press, no keyboard path needed) in the brand lockup, and the honest `.beta-note` sentence under the prompt card that sets coverage expectations before the wait. Both are styled from existing tokens, ship no engine code, and hold AA contrast in both themes.

## Flow

- `onMount`: `getTheme()` → `takeComplexity()` (both restoring prior choices); `Ambient` mounts the layered cursor system (`.parallaxize('[data-parallax]').magnetize('[data-magnetic]').sheen(...)`); `LandingBackground.init(bgCanvas)` starts the wireframe field; the typewriter reveals `HEADLINE_TEXT` at a derived rate (`HEADLINE_TYPING_MS / length`, clamped 35–80ms, 350ms start delay) — skipped entirely under `prefers-reduced-motion`; `#topicInput` is focused after 900ms only on fine pointers; cleanup destroys ambient/background.
- `handleGenerate()` is the entry gate: empty / `<5 chars` / `>500 chars` checks, a 3s client rate limit (`RATE_LIMIT_MS`) with a countdown in the toast, `suspiciousContent()` rejection (`showError` + `shakeElement`, V1-style). Passing: `storeTopic(value)` + `storeComplexity(complexity)` → adds `.is-leaving` to `.landing-container` → `window.location.href = '/loading'` after 500ms.
- Exits: the quick-start chips (`QUICK_STARTS`) fill the input and focus it (ripple on fine pointers); the demo link (`resolve('/viewer')`) runs the reference model with no state carried; `toggleTheme()` flips via `setTheme` with the V1 lean-back flourish.
- Across routes: `/loading` resumes the topic and complexity from `sessionStorage` (keys written by `storeTopic`/`storeComplexity`); `/viewer` resumes either via `?model=` (shared link) or the stored session bundle from `/loading`.

## Integration

- Contracts: `COMPLEXITY_LEVELS`, `ComplexityPreference` (`@edu3d/contracts`) — the depth control and its blurb render from the same table the generation prompt reads.
- `$lib/ambient.ts` (`Ambient`, `getTheme`, `setTheme`), `$lib/landing-background.ts:LandingBackground`, `$lib/validate-topic.ts:suspiciousContent`, and `$lib/core/api.ts` (`storeTopic`, `storeComplexity`, `takeComplexity`, `DEFAULT_COMPLEXITY`). The theme key pairing with `app.html`'s pre-paint script is pinned by `theme-key.test.ts` (`THEME_STORAGE_KEY`).
- Styles: `$lib/styles/landing.css` (verbatim V1) via the `base.css` chain; navigation partners are `routes/loading/` (generation) and `routes/viewer/` (demo).
