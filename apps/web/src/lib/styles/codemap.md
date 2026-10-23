# apps/web/src/lib/styles/

## Responsibility

The app's whole CSS system: the design-token sheets, the two-theme token definitions, and the per-page stylesheets each route imports so a page ships only its own CSS (no viewer CSS on landing, per `07`).

## Design

- Layering is an explicit import chain: `base.css` imports `tokens.css` first, then `theme.css` — so `theme.css` wins every shared custom-property name, and a self-referential re-declaration (noted in `viewer.css`) would blank every surface. `+layout.svelte` imports `base.css` alone as the global base.
- `tokens.css` — the "Sunset Graphite" app tokens: cream/bronze/amber/graphite primitives, semantic status hues, geometry/spacing/type/motion tokens, layout constants (`--panel-width`, `--toolbar-height`, `--touch-target`, the `--z-canvas…--z-modal` ladder), dark default + `[data-theme='light']` as _token redefinitions_ (including the engine-facing backdrop set — `--scene-bg-top/bottom` plus the two grid-weight tokens `--scene-grid` (fine 1-unit lattice, 14%/16%) and `--scene-grid-major` (10-unit structure, 40%/42%), each carrying its own alpha so the floor reads at distance), and a `prefers-reduced-motion` block collapsing `--duration-*` to 1ms.
- `theme.css` — the landing/loading token sheet: primitives + `color-scheme`, semantic dark/light sets (`--bg-canvas`, `--text-*`, `--accent-ink` with the WCAG AA fix documented inline), spacing/type scale, `.sr-only`/`:focus-visible`/`.theme-switching` one-frame transition suppression, the ambient cursor system (`.ambient-grid`, `.ambient-layer/.ambient-blob/.ambient-spot`, `.has-sheen`, `.has-glow-border`, `[data-magnetic]`) and its reduced-motion kill switch.
- `base.css` — reset, element baseline, focus ring (`.glass` material with a `@supports (backdrop-filter)` enhancement and a high-alpha fallback so cards read without blur), `.gradient-text` (hero only), `.decorative`, plus the ambient classes landing/loading mount against.
- `landing.css` — landing layout verbatim: header/theme-toggle icon cross-fade, hero (typed headline, in-flow `.cursor-blink`, sr-only accessible name pattern), `.prompt-card` + `.input-footer` (Detail select, counter, 44px Generate button), quick-start chips, `.demo-link`, and short-viewport/mobile/≤640px rules (background pulled to `opacity:0.35` on phones).
- `loading.css` — loading layout verbatim: `.scene-loader` orbital construction (halo + three tilted spinning rings), `.progress-stages` tracker with success/fail states, linear-transition `.progress-bar` (disabled under reduced motion via `.no-transition`/media query), `.fact-container` leave/enter swap classes, `.error-container` with `.retry-btn`/`.back-btn`, particles, success flourish.
- `viewer.css` — the app shell: toolbar/`control-group`s, left/right panels + tabs, parameter widgets (44px transparent slider strip with re-centred thumb), chat block, `.info-*` card system, bottom bar, modals (`.modal-overlay` with explicit `backdrop-filter:none`; solid `.code-view-modal` over the canvas), quiz options/feedback, schema-generated settings panel (grid columns, sticky preset toolbar, device-tier badge), responsive tiers (≤768 full-screen sliding panels, ≤480, 769–1600 / ≥1601 panel widths, max-height 800).
- `viewer-extended.css` — generate/publish/gallery modal extras: `.form-group`, `.primary-btn`, `.status-message` variants, `.gallery-grid/.gallery-card` (comments note the Svelte gallery uses its own scoped styles for some parts).
- Compositor rule enforced throughout every stylesheet: anything stacked over the opaque WebGL canvas drops its blur (`code-view-modal`, `.modal-overlay`, `.subtitle`, `.tooltip-3d`, `.toast`, mobile `.panel`) and `.code-view-pre` opts into `content-visibility:auto` for kilolines of untrusted text.

## Flow

- Mount-time: `+layout.svelte` → `base.css` (tokens → theme); `+page.svelte` (landing) imports `landing.css`, `loading/+page.svelte` imports `loading.css`, `viewer/+page.svelte` imports `viewer.css` + `viewer-extended.css`.
- Runtime theming: flipping happens only via `document.documentElement[data-theme]` — `lib/ambient.ts:setTheme` writes the attribute + `color-scheme`, persists `THEME_STORAGE_KEY` (the contract key the pre-paint script in `app.html` also reads; that pairing is what `theme-key.test.ts` pins), and toggles `.theme-switching` for one frame so tokens swap without a half-transition.
- Engine follows the CSS: `viewer/+page.svelte:readThemeColors()` reads all four backdrop tokens (`--scene-bg-top/--scene-bg-bottom`, `--scene-grid/--scene-grid-major` — the latter two already carrying their intended alpha) and calls `SandboxHost.setTheme(...)`, so the 3D backdrop and ground grid track the same source the components use.

## Integration

- `lib/ambient.ts` (`Ambient`, `getTheme`, `setTheme`) owns the attribute/class contract these sheets implement; `lib/core/settings.ts:SettingsStore` handles persisted user settings (quality pin), which is a JavaScript concern separate from theme.
- Consumers: all three route folders (`routes/`, `routes/loading/`, `routes/viewer/`) and, transitively, every component in `lib/components`, which restyles shared classes from `viewer.css`/`viewer-extended.css` instead of duplicating them.
