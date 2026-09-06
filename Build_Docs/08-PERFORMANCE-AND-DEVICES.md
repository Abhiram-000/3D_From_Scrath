# BUILD DOC 08 — PERFORMANCE & DEVICES

> Read `00-GOAL.md` first. This document defines _how fast and how smooth the platform must be, on everything from a weak phone to a strong desktop_. Targets are contracts, not aspirations. Where a technique is named, it is named as the _class_ of solution — the implementation is yours. The standard throughout: **exceptional on low-end, marvelous on mid-range, and effortless on high-end — automatically, with no user tuning.**

## Mission

A learner on a five-year-old budget phone with 40 other tabs open deserves the same lesson as a learner on a gaming desktop. Not the same triangles — the same _clarity, responsiveness and delight_. Performance is not a feature you add at the end; it is the difference between "a marvel" and "a slideshow" for most of the real audience, which is phones, school Chromebooks and office laptops.

The rule that drives everything: **the device decides, the platform adapts, the user is never asked and never lied to.**

## Device tiers

Detect once, at startup, cheaply: GPU renderer string, core count, device memory, pixel ratio, touch capability, WebGL capabilities. From these, classify:

- **LOW** — old/budget phones, weak Chromebooks, integrated graphics from a decade ago
- **MID** — modern phones, typical laptops, entry dedicated GPUs (the _majority_ of real users — this tier is the design center)
- **HIGH** — gaming desktops, recent discrete GPUs

Tier is _fluid_: it is re-evaluated from live behavior (measured frame time), not just hardware strings. A "high" laptop on 10% battery, thermal throttling in a warm room, is a mid device — and the platform must notice and respond.

## Hard performance budgets (the contracts)

### Frame-time budgets

| Budget                                        | Target                                           | Why                                                      |
| --------------------------------------------- | ------------------------------------------------ | -------------------------------------------------------- |
| **Steady frame rate**                         | ≥ 30 fps LOW, ≥ 50 fps MID, ≥ 58 fps HIGH        | Below 30, motion stops teaching — it stutters            |
| **Time-to-first-frame** (viewer)              | < 2 s on MID after model arrives                 | The wait was already minutes; the reveal must be instant |
| **Input-to-response** (hover, select, slider) | < 1 frame — 16 ms                                | Anything slower reads as broken, whatever the cause      |
| **Page load** (landing, cold)                 | < 3 s on a mid-range phone over 4G               | The funnel dies at the door                              |
| **JS bundle, landing page**                   | No engine, no physics — kilobytes, not megabytes | A visitor who may never generate downloads nothing heavy |

### Resource budgets (per tier, enforced before allocation)

- **Triangles on screen**: LOW ~150k, MID ~600k, HIGH ~2M — hero parts get the detail; repetition is instanced, never duplicated
- **Draw calls**: LOW < 100, MID < 400, HIGH < 1500 — the real killer on weak GPUs; batching and instancing are budget lines, not optimizations
- **Shadow-casting lights**: LOW 0–1, MID 2, HIGH 4+ — shadows are the most expensive thing a naive model asks for
- **Physics bodies / particles**: tier-capped, with visible partial-simulation notices rather than silent removal
- **Materials and geometries**: deduplicated by structural caching — a 200-bolt assembly is 1 bolt's worth of GPU objects
- **Texture memory**: procedural or flat by default (see 01-MODELS); any texture use is budgeted

**These budgets are enforced at admission, before allocation** — a model is priced from its declaration, downgraded (coarser segments, fewer particles, simpler materials) until it fits, and only then built. A budget breach is never discovered as a stutter; it is prevented as a number.

## Automatic optimization — the adaptive ladder

The platform tunes itself, continuously, in both directions:

**Downward (survival):** live frame-time monitoring (rolling window, not single-frame spikes) detects sustained pressure and steps quality down in _least-damage-first_ order:

1. Reduce pixel ratio (often the single biggest win on high-DPR phones — render at 0.75×, upscale; sharpness loss beats judder)
2. Reduce/disable post-processing (bloom, antialiasing modes)
3. Disable shadows (or drop to a single low-resolution shadow)
4. Decimate geometry (segment counts shrink with recognizability floors — a coarser sphere, never a triangle)
5. Reduce particle counts, step down physics substeps
6. Flat shading on LOW (skips normal interpolation)

**Upward (excellence):** when headroom persists, step back up quietly. A device that _can_ run the full experience must get it.

**The rules for adapting:**

- Every step-down is _visible and explained_ ("Quality reduced to keep motion smooth") — silent degradation reads as breakage
- Steps are hysteresis-bounded: no oscillation thrashing between two quality levels
- The user's explicit quality choice (settings) beats the optimizer, which then only warns
- Degradation must never change _topology or behavior_: the same lesson, coarser — never fewer parts teaching less

## Phone and tablet excellence

Touch is not a degraded desktop — it is the primary platform, designed for directly:

- **Layout**: the three-panel viewer collapses to a single column — panels become bottom sheets/drawers with large grab handles, the canvas owns the full screen, the toolbar condenses to essentials + overflow menu. _Thumb-reach_ decides control placement: primary actions bottom-center, destructive actions away from the thumb's resting arc
- **Gestures**: one-finger orbit, two-finger pan, pinch zoom — with the same damping and limits as the mouse; double-tap to focus a part; long-press for context (part info without selecting). Every gesture is interruptible and _never fights momentum_
- **Hit targets**: ≥ 44×44 CSS pixels, generously spaced — a slider thumb that is hard to grab is a broken slider
- **Performance realities of phones**: thermal throttling under sustained load (the adaptive ladder must handle a device that is MID for 3 minutes then becomes LOW), high-DPR screens (pixel-ratio management is mandatory, not optional), and mobile GPU driver quirks (prefer well-trodden rendering paths)
- **Page weight**: the landing and loading pages are _light_ — a phone on 4G must land in seconds; every kilobyte of the landing page is paid for in funnel loss
- **Offline-ish resilience**: brief network drops during generation must not kill the wait (reconnect with honest messaging); a loaded model keeps working with the network gone

**Tablets** sit between: the desktop layout at small sizes where it fits, sheet-based panels where it doesn't; Apple Pencil / stylus hover treated as fine-pointer input.

## Responsive and environmental discipline

- Breakpoints for _width_ (phone/tablet/desktop) **and height** (landscape phones, short laptops) — a layout that only tests width fails every phone in landscape
- `visualViewport` respected for on-screen keyboards; the chat input must not be buried behind the IME
- Ambient light: dark theme default in dark environments (via `prefers-color-scheme`), with the 3D backdrop keeping model contrast in both themes
- Reduced motion honored everywhere (`prefers-reduced-motion`): the lesson survives without parallax, sheen and drift
- Keyboard, gamepad and screen-reader paths never regress when layouts collapse

## Loading and streaming discipline

- **Landing loads nothing heavy**; loading page loads nothing heavy; only the viewer loads the engine — and the engine chunks so physics/WASM arrive _in parallel with_ generation, not after it (the generation wait is free download time)
- **First paint beats full load**: every page renders its shell immediately; scripts are `module`/deferred; fonts swap without invisible-text stalls
- **Model load is progressive**: frame the scene as meshes compile; never a blank canvas followed by everything at once
- **Memory is flat over time**: generate → load → generate again, dozens of times, must not grow — disposal is wired into every owner (geometries, materials, textures, workers, WASM worlds) and _verified by test_

## Measurement — you cannot manage what you don't measure

- The engine **surfaces its own cost**: frame time, draw calls, triangles, physics step time, quality level — visible in the status bar and in diagnostics, always honest
- **Automated performance gates in CI**: a headless run of representative scenes asserts frame-time and load-time budgets on throttled-class hardware simulation; a regression that doubles load time fails the build like a failing test
- **Field telemetry** (first-party, private): real-user frame rates and load times per tier, so "works on my machine" is never the answer

## The advanced toolbox — the top techniques, required as _classes_

The budgets above say _what_; this says _how_. Each entry is a technique class your implementation must have an answer for — the top tier of web-3D performance engineering, the difference between "it works" and "it's marvelous on a mid-range phone."

### GPU-side

- **Instancing (the single most important one).** Repeated parts — turbine blades, rivets, atoms, trees, grid cells — render as one draw call with per-instance transforms, not N draws. A 38-blade fan authored as 38 meshes costs 38 draw calls; instanced, 1. Your vocabulary must make instancing the _easy, default path_ for repetition, and the admission system must price an instanced set accordingly (N × geometry cost, 1 × draw-call cost)
- **Structural caching of geometries and materials.** Identical specs map to one GPU object via a cache key — the 200-bolt assembly is 1 bolt's worth of GPU memory. Expression-driven variants are uncacheable _by design_ (their output diverges per frame); everything else deduplicates. Cache hit rate is a visible stat
- **Frustum culling by default, and correct bounding spheres.** Off-screen parts cost nothing — _if_ the bounds are right. A NaN-poisoned or stale bounding sphere silently breaks culling (and raycasting) for a whole subtree; recompute on procedural geometry, verify on adoption from foreign libraries
- **Level of detail (LOD)**: hero parts get distance-based LOD ladders (a turbine blade at 2% screen size is a simplified hull, not 400 vertices); repeated background parts get aggressive ladders. Choose by _screen-space size_, not raw distance, so it adapts to any camera FOV
- **Merged static geometry**: never-moving decoration (a frame, a floor grid) merges into few buffers — the extreme form of draw-call reduction where per-part selection isn't needed
- **Texture discipline**: procedural-by-default (see 01-MODELS), compressed formats where used (KTX2/Basis class — raw PNGs decoded to RGBA cost 4–8× their file size in GPU memory), mipmaps always, anisotropy capped per tier
- **Render-order and state sorting**: transparent objects sorted back-to-front once per frame; opaque front-to-back (early-Z wins); material state grouped so the driver isn't thrashing between shader programs
- **Post-processing that knows its place**: effects chain per tier (HIGH gets bloom + AA; MID gets AA; LOW gets neither), and every effect can be disabled individually by the adaptive ladder

### CPU-side (the frame loop)

- **Zero allocation in the hot path.** Pre-allocated scratch vectors/quaternions/matrices, object pooling for particles and transient handles. GC pauses on a 60 fps budget are frame drops that profiling _will_ find; the discipline is every vector reused, every temp pooled, every closure in the loop hoisted
- **Frame-loop work scheduling**: not every job needs to run every frame — annotations re-project every frame, physics stats publish every N, distant LOD checks every 10th, telemetry every second. Amortize by cost, and stagger jobs across frames so no single frame carries them all
- **Time-sliced scene building**: a 300-part model compiled in one go freezes the main thread and the time-to-first-frame budget dies; build in slices (a few parts per frame), show progressive appearance, keep input responsive throughout
- **Dirty-flag propagation**: expressions and bindings re-evaluate only when their inputs changed — a parameter at rest should cost nothing. A naive "re-evaluate everything every frame" design wastes most of its budget confirming that nothing happened
- **Deferred computation for interactions**: hover raycasts against a _cached_ pick structure (BVH class acceleration), not raw triangle scans; picking must stay sub-millisecond even on complex assemblies

### Concurrency and isolation

- **Move AI model code and heavy compilation off the main thread** (workers) — the sandbox requirement and the performance requirement are the same requirement: untrusted code and expensive compilation both belong where they cannot jank the UI. Transfer results (built geometry buffers, not instructions) back
- **WASM physics in a worker** (or main-thread-isolated) with render interpolation — the physics step's cost never appears as a UI stall
- **Offscreen/hidden-tab discipline**: `requestAnimationFrame` naturally pauses when hidden — never replace it with timers; wake work on visibility change; clamp the return delta

### Asset and network

- **Code-splitting by page and by capability**: landing = kilobytes; the engine, physics WASM, and CSG arrive as separate chunks; **the generation wait is free download time** — the viewer's heavy chunks stream while the loading page counts progress, so the model appearing and the engine being ready coincide
- **Long-term caching of hashed assets**: content-hashed filenames + `immutable` caching (a year), HTML always revalidated — a returning visitor downloads _only_ what changed
- **Precompute and cache server-side**: generated models are deterministic artifacts — cache the audit, the compiled-form stats and any derived artifacts by content hash so a re-publish or a share-link load does no redundant work; snapshot bytes are content-addressed and immutable
- **Compression discipline**: Brotli/gzip for text payloads, NDJSON streams flushed unbuffered, image responses content-negotiated (WebP/AVIF with fallback)
- **Predictive prefetch**: the _one_ reliable prediction is that a learner who just generated will open the viewer — prefetch its engine chunks during generation; beyond that, prefetch nothing speculative (bandwidth is a phone user's budget)

### The meta-rule for all of the above

Every technique here must be **measured, then applied** — the engine surfaces frame time, draw calls, triangles, and cache hit rates; a technique that isn't showing up in the numbers is complexity without benefit and gets removed. Optimization is empirical: profile on the lowest target device, fix what the profile names, re-measure. Never optimize by folklore.

## Edge cases

- A device that lies about its capabilities (reports high, performs low) — the live frame-time monitor is the truth; trust behavior over strings
- WebGL context loss (browser reclaims the GPU under pressure) — detect, rebuild the scene, keep the model; never a dead canvas
- A model that cannot fit even fully decimated — refuse with an honest message and a simpler re-generation offer, never ship a slideshow
- Sustained thermal throttling — the ladder steps down _early_ under the thermal signature, before judder appears
- Backgrounded tab returns — clamp the delta, never simulate the whole gap; the model resumes, not fast-forwards
- Low-memory pressure events — release caches, step quality down, survive; a reload loses the learner's session

## Testing

- **Budget tests**: representative scenes per tier compiled and priced — assert the admission numbers hold and decimation floors keep shapes recognizable
- **Adaptive tests**: simulate sustained slow frames, assert the ladder steps down in order with notices, and back up when pressure clears, without oscillation
- **E2E on phone profiles** (real browser engine, throttled CPU/network): landing loads in budget, viewer boots, gestures work, panels become sheets
- **Memory tests**: N generate/load cycles with heap + GPU memory sampled flat
- **Battery sanity**: a running idle model (auto-rotate only) must not peg the CPU

## What you decide

The exact tier thresholds, the decimation ladder's rungs, the detection heuristics, the chunk strategy — yours. The contracts are above: budget tables, admission-before-allocation, the adaptive ladder with visible honesty, phone-first interaction, flat memory, and measurements that fail builds.

## The final image

A student opens the platform on a hand-me-down Android over school Wi-Fi. The landing page lands instantly and already feels premium. The generated engine model appears in under two seconds and runs at a smooth frame rate — coarser than on a desktop, _visibly the same lesson_, with a quiet notice that quality adapted to the device. They orbit with one thumb, pinch into the rotor, drag the throttle slider, and the machine answers within a frame. Same platform, same lesson, same delight — everywhere it runs. That is performance as a promise kept.
