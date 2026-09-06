# BUILD PLAN — EDU-3D (rebuild from scratch)

Derived from `Build_Docs/00..09`. This file is the execution contract: decisions made, phases
ordered, gates that define "done". Update it when a decision changes, never silently diverge.

---

## Part A — The two decisions everything else follows from

`00-GOAL.md` closes with: _"Start by designing two things, together: the scene API and the sandbox
that runs it."_ Those are settled first, here.

### A1. The sandbox: a Web Worker realm with irrecoverable capability drop

The AI writes real JavaScript. It executes in a **dedicated module Worker** that owns an
`OffscreenCanvas` transferred from the page. Five layers, defence in depth:

| Layer                                   | Where                                         | What it stops                                                                                                                                                                                                                                                                                                                                               |
| --------------------------------------- | --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Static gate (acorn parse + AST walk) | server, before the browser ever sees the code | syntax errors, `import`/`import()`, `eval`, `with`, forbidden identifiers, unknown API calls, size/shape limits                                                                                                                                                                                                                                             |
| 2. AST instrumentation (loop guards)    | server + host, same module                    | infinite `while`/`for`/`do`/recursion — a deadline check is injected into every loop body                                                                                                                                                                                                                                                                   |
| 3. Lexical shadowing                    | worker, compile time                          | every dangerous global name is a `undefined` **parameter** of the compiled function, so it is shadowed regardless of what exists on `self`                                                                                                                                                                                                                  |
| 4. Realm hardening                      | worker, before AI code runs                   | `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource`, `importScripts`, `Worker`, `SharedWorker`, `BroadcastChannel`, `indexedDB`, `caches`, `Atomics`, `SharedArrayBuffer`, `WebAssembly`, `crypto`, `navigator`, `location`, `postMessage`, `self`, `globalThis` deleted/poisoned; `Function.prototype.constructor` poisoned; intrinsic prototypes frozen |
| 5. Kill switch                          | main thread                                   | heartbeat watchdog → `worker.terminate()`; the canvas is re-created and the viewer survives                                                                                                                                                                                                                                                                 |

**Why a worker and not an iframe:** a worker _cannot create a fresh realm_ — there is no `iframe`,
no `Realm`, and `Worker` itself is deleted. Deleting a global inside a worker is therefore an
irrecoverable capability drop, which is not true in a document. The worker also holds zero secrets,
and moving untrusted code off the main thread is simultaneously the performance requirement
(`08`, "untrusted code and expensive compilation both belong where they cannot jank the UI").

**All rendering happens on the learner's device. The server never renders a pixel.** A hard
architectural rule, not an optimisation:

- The WebGL context, the Three.js scene, every draw call, the physics step and the AI's per-frame code
  all live in the **browser worker on the user's machine**, drawing to an `OffscreenCanvas` transferred
  from the page. No server-side GPU, no remote frame buffer, no video stream.
- The server's only contact with the engine is the **authoring pass** in `node:vm`: it runs the AI's
  program against the same pure-data scene API to harvest the manifest, then prices and audits it. That
  pass touches no canvas, no WebGL and no renderer — it is arithmetic over typed arrays, which is
  exactly why `packages/engine` is DOM-free and why the audit can run headless (`04` stage 4).
- Consequences, all of them wanted: a published model replays on any device without the server being
  involved; generation cost never scales with viewing; a loaded model keeps working when the network
  drops (`08`, "offline-ish resilience"); and the tier that governs quality is the _actual_ device
  (`08`, "the device decides, the platform adapts, the user is never asked and never lied to").
- The single server-side pixel operation is storing a **snapshot thumbnail the client rendered** and
  uploaded for the gallery: bytes in, bytes out, no rendering.

**Node host for the same code**: the identical guest runtime runs in `node:vm` with a fresh
context and no DOM — that is what makes the server-side audit (`04`, stage 4) possible without a
browser or a GPU.

### A2. The scene API: a two-stage build (authoring → realization)

The AI's program runs **once** against a pure-data _authoring_ API. It produces a `ModelBuild`
(declarations + registered callbacks) plus a `ModelManifest` (serialisable description). Only then
is the build _realized_ into Three.js objects.

```
AI code ──run once──▶ ModelBuild + ModelManifest ──realize──▶ Three.js scene
                            │
                            └── audit / chat context / diagnostics / cost pricing
                                (needs no GPU → runs server-side in node:vm)
```

This split buys four things the docs demand and a single-stage design cannot give:

1. **Server-side audit without a browser** (`04` stage 4, `01` "the audit").
2. **Admission pricing before allocation** (`08`: "a budget breach is never discovered as a
   stutter; it is prevented as a number") — the manifest carries triangle/draw-call cost before a
   single GPU object exists.
3. **Machine-checkable parameter leverage** (`00`, `01`): the dry run sweeps each parameter
   min→max, invokes `onFrame`, and records which targets were mutated. A parameter that writes
   nothing is a _provable_ deficiency, enumerable back into the refinement pass.
4. **Atomic swap** (`03` R2): realization can fail without touching the live scene.

Per-frame power is preserved: `scene.onFrame(fn)` callbacks live in the sandbox realm and receive
capability-scoped handles (`ctx.part(id).setRotation(...)`, `ctx.params.speed`), so the AI keeps
arbitrary per-frame logic while every write is attributable to a declared target.

### A3. Expressive ceiling: no shape catalog, ever

**The rule:** the AI is never limited to a fixed set of shapes. `00-GOAL.md` states it directly —
_"the ceiling is the API, not the schema"_ and _"data can only describe what the engine already
anticipates"_. A closed geometry enum would reintroduce the LEGO limit that the code-writing design
exists to escape, so the manifest identifies geometry by _which builder produced it plus its
measured cost_, never by a member of a closed list (`packages/contracts/src/manifest/parts.ts`).

Five mechanisms deliver arbitrary complexity, in order of how often a model will reach for them:

1. **Mesh-level escape hatch.** `geom.mesh({ positions, indices, normals?, uv? })` accepts raw typed
   arrays the AI computed itself. Anything expressible as triangles is expressible — that is a
   mathematical ceiling, not an engine one. Every higher-level builder is sugar over this.
2. **Parametric and implicit surfaces.** `geom.parametric(f(u,v))` for any surface with a formula;
   `geom.sdf(f(x,y,z))` marching-cubes an isosurface for organic and blended forms that no primitive
   describes. Both take _sandboxed closures_, so the shape is program-defined.
3. **A profile/curve algebra, not shape presets.** 2D profile builders (polygon, bezier, arc, offset,
   fillet, boolean-on-profiles, text outline) feed the operators that turn a curve into a solid:
   `revolve`, `extrude`, `sweep` along any 3D curve with a twist/scale law, `loft` through N sections,
   `pipe`, `shell`, `patch`. This is how real CAD shapes are made, and it composes without limit.
4. **Mesh modifiers as a pipeline.** `twist`, `bend`, `taper`, `noise/displace`, `subdivide`,
   `smooth`, `weld`, `simplify`, `bevel`, `shell`, `mirror`, `array(linear|radial|grid|path)`,
   `boolean(union|subtract|intersect)`. Applied in sequence, recorded in the manifest as
   `modifiers: [...]`, so a shape is a _derivation_ rather than a lookup.
5. **Composition primitives that make 300 parts cheap.** `scene.defineComponent(name, fn)` +
   `place(component, transformList)`, `instances()` for one-draw-call repetition (cap 40 000),
   `pattern()` helpers (linear/radial/grid/path/phyllotaxis), and a deterministic seeded PRNG so
   procedural variation is reproducible. `00`'s affordability rule — "an engine with 300 parts is
   built from a few parameterized definitions" — is an API guarantee here, not advice in a prompt.

Two supporting guarantees, because power without them is a crash:

- **Everything is measured, not trusted.** Every builder returns vertex/triangle counts and a
  structural cache key at authoring time, so admission pricing and deduplication work on shapes the
  engine has never seen (`08`).
- **Everything is bounded, not capped low.** Limits exist where runaway loops would exhaust memory
  (40 000 instances per set, 200 000 points per cloud, 20 000 nodes per model, a per-build vertex
  ceiling by device tier) — chosen far above the stated ambition so they never shape the model, only
  stop a pathological one.

The static gate validates builder names against the engine's exported API-surface descriptor, which
is generated from the code and injected into the generation prompt. Adding a builder therefore widens
what the AI can build with no schema change and no prompt drift.

---

## Part B — Stack decisions (with the justification `00` demands)

### Frontend: **SvelteKit 2 + Svelte 5 (runes)**, static adapter

`00` §Stack rule 2 asks for a deliberate choice against five specific needs. Scored against them:

- _Reactive UI around a non-reactive core_: Svelte 5 runes are signals. There is no VDOM, so no
  re-render can ever walk into the scene graph — the failure mode React makes easy (a re-render
  touching an imperative `THREE.Object3D`) is structurally impossible here. Engine → UI events land
  in `$state` and update exactly the DOM nodes that changed.
- _First paint / routing_: SvelteKit splits per route; the landing route ships no engine, no
  physics, no viewer CSS. Svelte's compiled output has no framework runtime tax on that page.
- _Streaming-friendly_: a progress event mutating one `$state` field costs one DOM write, not a
  component tree diff. Minutes of NDJSON and token-by-token chat are the cheap case.
- _Batteries without baggage_: `<dialog>`, transitions, actions and scoped styles are in the
  compiler; no component library is needed for the glass-panel design language in `07`.
- _Type safety_: `svelte-check` + generated `./$types` typecheck route data end to end.

Trade-offs accepted: smaller ecosystem than React (no `react-three-fiber`-class helper — irrelevant,
`00` forbids a declarative wrapper over Three anyway and the engine is deliberately framework-free);
fewer prebuilt accessible widgets (so the handful we need are written and tested here).

### Backend: **Hono 4 on Node 25** (`@hono/node-server`)

`04`'s disqualifier is a runtime that buffers a response body. Hono's handlers return web
`Response` objects backed by `ReadableStream`, so NDJSON flushes at the write, not at the end.
Per-request overhead is a fraction of Express's; the same app object runs unchanged on Bun/Deno/edge
if this ever moves; and typed routes share `packages/contracts` with the frontend, which is the
"one source of truth for the wire format" requirement. CPU work (audit dry-run, snapshot hashing)
goes to `worker_threads`, never the event loop.

Rejected: Express (proven by the reference implementation, but middleware-first streaming and higher
per-request cost), Fastify (excellent, but its value is schema-driven routing we already get from
zod contracts, and Web-standard `Response` streaming is more direct in Hono).

### Fixed and chosen

| Concern         | Choice                                                                              | Note                                                                                |
| --------------- | ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Rendering       | **three 0.185**                                                                     | mandated, exclusively                                                               |
| Physics         | **@dimforge/rapier3d-compat 0.20**                                                  | WASM, in the render worker; progressive enhancement                                 |
| CSG             | **three-bvh-csg**                                                                   | real engineering shapes (`00`: booleans)                                            |
| Picking         | **three-mesh-bvh**                                                                  | sub-ms raycast on 300-part assemblies (`08`)                                        |
| Language        | **TypeScript 6.0**                                                                  | pinned below 7 for `typescript-eslint`/SvelteKit peer ranges                        |
| Bundler         | **Vite 8**                                                                          | via SvelteKit                                                                       |
| Package manager | **pnpm 10 workspaces**                                                              | two deploy roots (web, server) with shared packages                                 |
| DB              | **Postgres via `pg`**                                                               | durable-by-default, file fallback that announces itself (`06`)                      |
| AI              | **`openai` 7 SDK against a configurable base URL**                                  | `AI_BASE_URL`/`AI_MODEL` env-driven, so provider is swappable; key server-side only |
| Tests           | **Vitest 5** (unit/integration) + **Playwright 1.63** (E2E, desktop+phone profiles) |                                                                                     |
| Parser          | **acorn 8**                                                                         | static gate + loop instrumentation                                                  |
| Validation      | **zod 4**                                                                           | one schema set, shared                                                              |
| Logging         | **pino 10**                                                                         | structured, request-id correlated                                                   |

### Layout

```
packages/contracts   wire formats, manifest schema, budgets, error taxonomy   (no deps)
packages/sandbox     static gate, AST instrumentation, worker host, node host (contracts)
packages/engine      scene API, geometry, materials, lights, camera, runtime,
                     physics, guest entry — DOM-free, Node-runnable            (contracts, three)
apps/web             SvelteKit: landing, loading, viewer                       (engine, sandbox, contracts)
apps/server          Hono: pipeline, gallery, chat, quiz, health               (sandbox, engine, contracts)
scripts              check-secrets, check-config, verify
```

Dependency direction is one-way and lint-enforced: `engine` never imports `app`/`server`;
`server` never imports frontend code; both import `contracts`.

---

## Part C — Phases and gates

Each phase ends with a green gate. No phase starts before its predecessor's gate passes.

### P0 — Foundation

Workspace, tooling (prettier/eslint/tsconfig), `packages/contracts` (wire + manifest + budget
schemas), `scripts/check-secrets`, `scripts/check-config`, `.env.example`s, README.
**Gate:** `pnpm verify` runs and passes on an empty test suite; secret scan catches a planted key.

### P1 — The sandbox and the scene API (critical path)

1. Scene API authoring surface + manifest harvest (pure, Node-testable)
2. Geometry: the open builder system of §A3 — `mesh` escape hatch, profile/curve algebra,
   `revolve`/`extrude`/`sweep`/`loft`/`pipe`/`shell`/`patch`, `parametric`, `sdf`, the modifier
   pipeline, CSG, instancing and pattern helpers — each returning measured cost + cache key, and each
   registered in the generated API-surface descriptor
3. Materials (semantic archetypes), lighting rig, camera + cinematic shot vocabulary
4. Static gate + loop instrumentation, validated against the API-surface descriptor
5. Guest runtime: hardening, compile, run, realize, frame loop, RPC protocol
6. Worker host (browser) + vm host (Node), watchdog, terminate/rebuild
7. Adversarial suite: escape attempts, infinite loops, prototype paths, NaN, budget breach
8. A hand-authored reference model that exercises the whole surface, including a raw `mesh`, an
   `sdf` blend, a swept profile and a 500-instance set
   **Gate:** reference model builds in Node (manifest + cost) and renders in a browser worker; every
   adversarial test fails closed; `worker.terminate()` recovers the viewer.

### P2 — The viewer

Shell that boots with a dead engine, atomic model swap, parameters panel (one owner, gesture-
coalesced undo), part select/hover/info, play/pause/reset, x-ray/wireframe/explode, theme before
first paint, status bar, keyboard map, diagnostics panel.
**Gate:** E2E — load reference model, click a part, drag a slider and observe motion change, toggle
every mode, kill the model and see the viewer survive.

### P3 — The backend and the pipeline

Config resolved once and validated exhaustively, health/liveness/readiness, NDJSON generation
pipeline (prompt assembly → AI call with typed retries → extraction → static gate → bounded
self-repair), heartbeats, drain, rate limits, storage (Postgres + announcing file fallback),
snapshots with magic-byte sniffing, write token.
**Gate:** pipeline tests pass with a mocked provider (happy, truncated, refusal, quota, malformed);
SIGTERM drains and notifies open streams; production misconfiguration refuses to start.

### P4 — Audit and refinement

Headless dry run in `node:vm`, scoring across `01`'s dimensions, parameter-leverage sweep,
enumerated deficiencies, one refinement pass accepted only if genuinely better.
**Gate:** a deliberately deficient model produces the exact expected deficiency list.

### P5 — Physics

Rapier world in SI units, density-derived mass, faithful colliders, joints/motors, kinematic bridge,
measured value publication, grab/impulse/time-scale interaction, disposal.
**Gate:** conservation, free-fall, pendulum-period, joint-limit and NaN-quarantine tests pass in Node.

### P6 — Conversation layer

Streaming chat with five personas and bounded model context, authored-first quiz with validation,
story beats driving the cinematic camera, narration that never strands.
**Gate:** authored-first ordering, unusable-question filtering, narration-error advance, mode-swap
unload — all tested.

### P7 — Performance and devices

Tier detection, admission pricing, adaptive ladder with hysteresis and notices, instancing/LOD/
merge/BVH, phone layout and gestures, flat memory across generate cycles.
**Gate:** budget tests per tier, ladder ordering test, memory-flat test over N cycles, phone E2E.

### P8 — Prompt architecture

Phased planning prompt (classify → entities → causality → representation → hierarchy → code),
role separation, domain grammar table, few-shot fragments, versioned prompts, topic battery harness
with measured outcomes.
**Gate:** the battery runs and records build-rate/part-count/binding-count per topic.

### P9 — Polish

Landing and loading delight (typed headline, wireframe backdrop, cursor system, honest staged
progress), share + QR + gallery, screenshot/video export, a11y pass, docs and changelog.
**Gate:** full `pnpm verify` green including E2E on desktop and phone profiles.

---

## Part D — Standing rules (from `09`, enforced not remembered)

- One concern per file; a file past ~800 lines is two files.
- **No shape catalogs.** Never add a closed list of geometries, and never let a schema become the
  limit on what a model can be. New expressive power arrives as a _builder_ registered in the API
  surface descriptor; the manifest records what ran and what it cost, never what was allowed.
- Every file opens with a short header block saying what it owns and why it exists.
- Comments carry _reasoning_ only; magic numbers become named constants with a justified line.
- No secrets in the repo — enforced by `scripts/check-secrets.mjs` on every `verify`.
- All model-authored and AI-authored text renders as text nodes. No `innerHTML` of untrusted data.
- Errors: user-facing text says what to do next; client errors carry a request id, never internals.
- `pnpm verify` is the single definition of done.
