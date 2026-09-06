# BUILD DOC 07 — UI & UX

> Read `00-GOAL.md` first. This document catalogs the interface techniques that make the platform _feel_ premium — organized as requirements so you can implement them in your own stack. The three pages (landing, loading, viewer) each have a distinct UX job; the techniques below are what each job needs. "How" is yours; "what the user must feel" is the contract.

## The design language

One visual identity across all pages — **warm, dark, cinematic**: a single hue family (bronze/amber/cream "Sunset Graphite"), glass surfaces, soft glows, generous spacing. Not a default blue SaaS palette. The platform sells _wonder_; the interface must look like it costs something.

- **Design tokens as the only source of color**: every color, radius, shadow, easing and glow lives in one theme sheet as CSS custom properties (`--accent`, `--amber-glow`, `--radius-md`, `--ease-out`...). No hex literal in a component file, ever. Two themes (dark, light) are _token redefinitions_, not separate stylesheets
- **Glassmorphism for cards**: `backdrop-filter: blur()` + translucent background + 1px luminous border + soft shadow — the prompt card, modals and panels all share this material
- **One accent hue family, used sparingly**: glows and borders at 10–30% opacity, full saturation only on primary actions. Restraint is the difference between premium and gaudy
- **Gradient text for headlines only** — the hero statement is the one thing allowed to shimmer; body text never does
- **Typography**: one strong display face for headlines, one readable body face; scale is deliberate (eyebrow → hero → description), never accidental
- **Theme before first paint**: an inline `<script>` in `<head>` reads the saved theme (falling back to `prefers-color-scheme`), sets `data-theme` and `colorScheme` _before any style applies_. A flash of wrong colors on load reads as broken, no matter how good the page is

## Landing page — convert curiosity into a topic

The landing page has one job: get a topic into the box and a click on Generate. Everything else is atmosphere.

### Structure and content

- **Hero hierarchy in four layers**: eyebrow ("AI-powered interactive learning") → typed headline → value description → prompt card. Each layer fades in staggered (`fade-in-delayed`, `fade-in-delayed-2`), so the eye is led down to the input
- **The prompt card is the centerpiece**: a glass card with a sheen sweep and a glow border, containing a textarea, a live character counter, a keyboard hint, and the generate button. It must look like _the_ thing to interact with
- **Quick-start suggestion chips**: three example topics ("Water Molecule", "Cell Division", "Solar System") as one-tap buttons that fill the input and focus it — for the visitor who wants to try but doesn't want to think. Each chip carries the full prompt in `data-topic` so the chip's label is short but the submitted topic is descriptive
- **Minimal chrome**: logo, theme toggle, footer. No nav, no menu, no distraction. The page is a funnel, not a website

### Motion and delight (device-aware)

- **Typing animation on the headline**: the hero text types itself character by character with a blinking cursor block — the page feels alive within 350 ms of arrival
- **3D wireframe background**: floating translucent wireframe polyhedra (icosahedra, octahedra, tori) drifting and rotating slowly in Three.js — a visual promise of what the platform makes. **Corner-biased placement** keeps the center clear for text. Device-aware throughout: fewer shapes, lower opacity, `low-power` GPU hint, capped pixel ratio and no antialiasing on low-end devices; graceful hide if WebGL fails
- **Ambient cursor system** (one rAF loop, all effects): a **reactive dot-grid** that lights up around the pointer, a **trailing spotlight** (soft radial glow that follows the cursor with easing), **parallax depth** (hero layers drift slightly against the pointer, at per-element strengths via `data-parallax`), **magnetic pull** (buttons and cards lean gently toward the cursor within a radius, via `data-magnetic`), and **sheen** (a light sweep across glass surfaces that follows the pointer)
- **Ripple on click** for suggestion chips (suppressed on low-end devices): a scaling radial pulse from the click point
- **All cursor effects are pointer-fine/hover-capable only** — `@media (hover: hover) and (pointer: fine)` gates them, so touch devices get none of the cost. **`prefers-reduced-motion`** disables parallax, sheen, typing, and the 3D background's drift

### Input UX

- **Enter submits, Shift+Enter newlines** — Enter is the first thing anyone tries; requiring Ctrl+Enter is an editor convention that has no place in a single-purpose prompt box
- **Live character counter** (`0 / 500`, `aria-live="polite"`) that warns at 90% and errors at 100%
- **Inline validation with physical feedback**: too short/empty → shake animation on the input + toast explaining why; suspicious content (script tags, `javascript:`, event handlers, `data:text/html`, iframes, `eval(`) → rejected with a clear message
- **Client-side rate limiting** (a few seconds between attempts) with a _countdown_ in the message — not a silent ignore
- **Button loading state**: the generate button disables and re-styles while submitting; the whole page fades out over ~500 ms before navigating, so the transition is a fade, not a jump-cut
- **Auto-focus the input** after the entrance animation (delayed so the animation is seen), and never steal focus on touch devices where a keyboard popping up is hostile

## Loading page — make 1–3 minutes feel worth it

The loading page's job is to hold attention through a long, opaque server process without lying about progress.

### Honest progress (the core UX decision)

- **A staged progress model driven by real server events**: the server streams phase events (model call → parse → audit → refine → ready), and the bar only passes a milestone when the phase behind it has _actually started_. Inside a phase the bar eases toward — but never reaches — the next milestone: slow work looks slow, fast work looks fast, and 100% is only ever shown when the work is done
- **Four named stages** (Thinking → Generating → Compiling → Ready) as a horizontal stepper with icons, labels, connectors and per-stage spinners — the user can see _where_ they are in the journey, not just how far along a bar
- **A status line that narrates real phases** ("The model is designing your 3D scene...", "Improving the model where it fell short..."), `aria-live="polite"`, so screen readers hear progress too
- **Graceful degradation when streaming is unavailable**: one eased phase that stops short of completion until the response arrives — never invented milestones, never a fake sprint to 100%
- **Stall and failure states are distinct**: a heartbeat-quiet connection shows "the model stopped responding"; an unreachable backend says so and names the fix ("start the backend") — pointing the user at the wrong system is worse than the error itself

### Attention management

- **"Did you know?" fact rotation**: topic-aware facts, non-repeating (a queue that refills without repeats), transitioning with a leave/enter text swap every ~6.5 s — the wait becomes content
- **An animated 3D scene-loader**: the brand logo rotating inside three concentric orbital rings with a soft halo — a small kinetic sculpture that says "building in 3D" without any text
- **The topic is displayed prominently** — the user's own words, right there, so the wait feels like _their_ model is being made
- **Particles layer** for atmosphere (suppressed for reduced-motion users)

### Failure UX

- **The error state replaces the progress UI, not the page**: icon, title, the actual message (quota, timeout, safety filter — each in user-actionable words), and **two exits: "Try Again" (same topic) and "Change topic" (back to landing)**. Retrying keeps the topic by design, so changing it must be one click away — a topic the model can't build will fail again, and the user must not be trapped in a retry loop
- Retry returns to the same progress model; no full page reload

## Viewer — the instrument panel

(Covered in `03-VIEWER.md`; the techniques specific to its _feel_:)

- **Three-column layout** with collapsible glass panels; status bar with live FPS/tier/time
- **Hover tooltips that follow the 3D cursor** with part name + authored bullets (text nodes, never HTML)
- **Notifications as brief toasts** (color-coded by severity, auto-dismiss, slide-in/out) — the viewer speaks in short sentences, not dialogs
- **Modals stop the render loop** while open (a blurred overlay over a live WebGL canvas forces the compositor to re-filter every frame — on integrated GPUs that freezes the page)
- **Empty/failed states explain themselves**: a story button with no story says "This model has no story beats"; physics off says so in the status bar
- **Keyboard-first**: every toolbar action has a shortcut; none fire while typing in a field; a help modal lists them all

## Cross-cutting UX rules

**Accessibility is a requirement, not a garnish**

- Screen-reader support: `sr-only` labels, `aria-live` for progress and counters, `role="progressbar"`/`list`/`alert` on the right elements, `aria-hidden` on decorative layers
- Visible `:focus-visible` rings on every interactive element; focus order follows reading order
- `prefers-reduced-motion`: disable parallax, sheen, typing, spinners where possible, background drift; keep the informative animation (the progress bar) but calm it
- Color is never the only signal (error toasts also carry an icon and text; counter states change text weight)

**Responsive discipline**

- Breakpoints at ~640 px width and ~700–860 px _height_ (landscape phones and short laptops are real) — the landing hero, loading stages and viewer panels each have compact variants
- Touch parity: every hover capability has a touch equivalent; every cursor delight is gated to fine pointers; hit targets are comfortably large
- `viewport` meta correct; no horizontal scroll anywhere, ever

**Performance as UX**

- Device detection shapes everything: shape counts, pixel ratio caps, antialiasing, GPU power preference, ripple suppression — a low-end phone gets the same design at a price it can pay
- One rAF loop for all ambient effects; passive event listeners; cleanup on unload (dispose geometries, materials, renderers, cancel frames)
- First paint is fast: theme inline, CSS split per page (landing loads no viewer CSS), the landing page never downloads the physics engine
- Every animation is GPU-friendly (transform/opacity only); nothing animates layout properties

**Honesty rules**

- Progress never lies (no fake milestones, no premature 100%)
- Every number shown is measured (FPS, counts, physics read-outs)
- Error messages name the actual cause and the fix, in words a non-engineer can act on
- Disabled buttons explain themselves in a tooltip

## The bar

A visitor lands and within one second the page is alive: the headline typing itself, wireframes drifting behind glass, the prompt card glowing softly as the cursor passes. They type, the page thanks them by fading out — not cutting. On the loading page they watch their own topic being built through honest stages, learning a fact they didn't ask for. In the viewer, everything responds within a frame and every pixel of chrome knows its one job.

That is the standard. Ship nothing that reads as template, default, or "good enough" — the interface is the first model the user ever sees, and it must look generated _for them_.
