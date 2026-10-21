# 3D_From_Scrath/ — EDU-3D

## Responsibility

EDU-3D is a pnpm-workspace monorepo for a web platform where a learner types any topic and an AI
**writes real JavaScript** that builds an interactive, physically honest 3D lesson. The AI is a
programmer, not a form-filler: it receives a scene API and writes a program against it, so the
ceiling is the API rather than a schema. Headless requirements live in `Build_Docs/` (read
`00-GOAL.md` first); decisions, phases and gates in `PLAN.md`; setup and deploy in `README.md`.

Two decisions everything else follows from (`PLAN.md` Part A):

1. **The sandbox** — the AI's program is untrusted and runs in a dedicated module Worker with an
   `OffscreenCanvas` transferred from the page. Five defence layers, capability drop that cannot be
   recovered (a worker has no `iframe`/`Realm` to escape into).
2. **The scene API** — a two-stage build: the guest program runs **once** against a pure-data
   authoring API producing a `ModelBuild` + serialisable `ModelManifest`, and only then is it
   _realized_ into Three.js. That split is what lets the server audit, price and diagnose a model
   with no browser, no GPU and no renderer.

## Design

- **Dependency direction is one-way and lint-enforced.** `packages/contracts` imports nothing of
  ours; `packages/sandbox` and `packages/engine` are DOM-free, Node-runnable, and never import an
  app or the server; the server never imports frontend code; everything imports `contracts`.
- **All rendering happens on the learner's device.** The server never renders a pixel — its only
  engine contact is the headless `node:vm` authoring pass (`@edu3d/engine/node-host`) used to harvest,
  audit and price a manifest. A published model replays anywhere without the server.
- **The framework owns the DOM; the engine owns the canvas.** Svelte 5 runes wrap an imperative,
  frame-driven Three.js core behind one explicit worker boundary — no framework re-render can touch
  the scene graph.
- **Policy is data, not prose.** Budgets, the quality ladder, audit weights, error status/retry
  tables, phase order and sandbox ceilings are frozen tables in `contracts`, so the frontend, the
  server and the sandbox cannot drift apart.
- **Degrade, never die.** No AI key, no database, no WebGL, weak device — each is a first-class,
  explained state (`503 capability_absent`, a file-backed gallery that announces itself, a quality
  ladder that steps down visibly, a kill switch that recreates the canvas).
- **`pnpm verify` is the single definition of "done."** A step whose tooling is absent reports
  `SKIP`, never `PASS`.

## Flow

End to end, one generation:

1. **Landing** (`apps/web/src/routes/+page.svelte`) validates the topic and stores it in
   `sessionStorage` → `/loading`.
2. **Loading** calls `POST /api/generate` and consumes an NDJSON `GenerationEvent` stream, mapping
   real server phases onto an honest, monotonic progress bar.
3. **Server pipeline** (`apps/server/src/services/pipeline.ts`): prompt → model → extract → up to 2
   repair passes → audit/build → at most 1 refinement → `ready`. The provider's prose is extracted
   and **statically gated** (`packages/sandbox`) before it ever reaches a browser.
4. **Audit** (`apps/server/src/services/audit.ts`) runs the instrumented program in `node:vm`
   against the real scene API, sweeps every parameter to prove it changes the model, scores 12
   weighted dimensions and writes deficiencies back as a refinement prompt.
5. **Viewer** (`apps/web/src/routes/viewer/+page.svelte`) loads the bundle into a fresh sandbox
   Worker: compile-then-harden (`packages/sandbox`) → guest runs the authoring pass → `priceModel`
   admits against the device tier → `realize` builds the Three.js graph → atomic swap. Every frame,
   declared motions compose over the guest's `onFrame` callbacks and present to the transferred
   `OffscreenCanvas`.

## Integration

Contracts at the boundaries: `/api/generate` (streaming NDJSON), `/api/chat`, `/api/quiz`,
`/api/gallery*`, `/api/snapshots/:id`, `/api/health`. One container serves the built frontend and the
API same-origin.

### Repository Directory Map

| Directory                          | Responsibility                                                                                                                  | Map                                                |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| `packages/contracts/`              | Single source of truth for every cross-boundary shape: manifest schema, wire formats, budgets, audit vocabulary, error taxonomy | [View](packages/contracts/codemap.md)              |
| `packages/contracts/src/`          | Bounded value primitives, audit quality vocabulary, device-budget table, learner settings                                       | [View](packages/contracts/src/codemap.md)          |
| `packages/contracts/src/manifest/` | The six modules defining `ModelManifest` — what a generated model _is_, serialisable for audit/pricing without a browser        | [View](packages/contracts/src/manifest/codemap.md) |
| `packages/contracts/src/wire/`     | Transport protocols: endpoint doors, NDJSON generation stream, error taxonomy, host↔guest sandbox messages                      | [View](packages/contracts/src/wire/codemap.md)     |
| `packages/sandbox/`                | The execution boundary: static gate, loop instrumentation, lexical shadowing, realm hardening, seal audit                       | [View](packages/sandbox/codemap.md)                |
| `packages/sandbox/src/`            | One module per defence layer plus the forgiving extraction front door                                                           | [View](packages/sandbox/src/codemap.md)            |
| `packages/engine/`                 | The scene API handed to guest code, the manifest runtime, the Node sandbox host and the reference models                        | [View](packages/engine/codemap.md)                 |
| `packages/engine/src/`             | The package barrel: what consumers may import, and the frozen DOM-free invariant                                                | [View](packages/engine/src/codemap.md)             |
| `packages/engine/src/authoring/`   | Runs the guest program once against the scene facades → manifest + live builder; owns the gate/prompt-shared API surface        | [View](packages/engine/src/authoring/codemap.md)   |
| `packages/engine/src/geometry/`    | Every expressible shape → cached, measured triangle data, plus the MeshData→MeshData operators                                  | [View](packages/engine/src/geometry/codemap.md)    |
| `packages/engine/src/materials/`   | The `mat` facade: 11 semantic PBR archetypes + colour roles → frozen handles and manifest-ready refs                            | [View](packages/engine/src/materials/codemap.md)   |
| `packages/engine/src/math/`        | The pure deterministic numeric language exported to guest code as `M`                                                           | [View](packages/engine/src/math/codemap.md)        |
| `packages/engine/src/runtime/`     | Prices a manifest per device tier, applies declared motions per tick, realizes the Three.js graph on-device                     | [View](packages/engine/src/runtime/codemap.md)     |
| `packages/engine/src/hosts/`       | The `node:vm` host that runs untrusted code headlessly for the server-side audit                                                | [View](packages/engine/src/hosts/codemap.md)       |
| `packages/engine/src/reference/`   | Hand-authored source-string models: fallback content, prompt exemplars, test fixtures                                           | [View](packages/engine/src/reference/codemap.md)   |
| `apps/`                            | The two deployable apps (container)                                                                                             | [View](apps/codemap.md)                            |
| `apps/web/`                        | Frontend deploy root: SvelteKit static shell whose routes own the DOM and proxy the API                                         | [View](apps/web/codemap.md)                        |
| `apps/web/src/`                    | App root: HTML document, ambient types, the no-SSR decision made explicit                                                       | [View](apps/web/src/codemap.md)                    |
| `apps/web/src/lib/`                | Route-shared decoration, dev-console and input-gate helpers (framework-free)                                                    | [View](apps/web/src/lib/codemap.md)                |
| `apps/web/src/lib/core/`           | The model layer: API client, sessionStorage handoffs, honest progress, settings                                                 | [View](apps/web/src/lib/core/codemap.md)           |
| `apps/web/src/lib/engine/`         | The sandbox boundary: main-thread host/watchdog + the worker doing all on-device rendering                                      | [View](apps/web/src/lib/engine/codemap.md)         |
| `apps/web/src/lib/components/`     | Leaf viewer UI: chat, the five modals, story mode, and the pure panel-branch predicate                                          | [View](apps/web/src/lib/components/codemap.md)     |
| `apps/web/src/lib/styles/`         | The CSS system: token layering, two themes, per-page sheets, the compositor no-blur rule                                        | [View](apps/web/src/lib/styles/codemap.md)         |
| `apps/web/src/routes/`             | SvelteKit route tree root: global CSS pipeline, render config, the landing page                                                 | [View](apps/web/src/routes/codemap.md)             |
| `apps/web/src/routes/loading/`     | Generation screen: drives the stream with honest progress → storeBundle → viewer, or the failure card                           | [View](apps/web/src/routes/loading/codemap.md)     |
| `apps/web/src/routes/viewer/`      | The app shell hosting the worker engine, all modal/pause/undo state, and the atomic model-load chain                            | [View](apps/web/src/routes/viewer/codemap.md)      |
| `apps/server/`                     | The single API container: generation pipeline, gallery, chat, quiz, health and same-origin static serving                       | [View](apps/server/codemap.md)                     |
| `apps/server/src/`                 | Composition root: lifecycle in `main.ts`, routes/middleware/error taxonomy in `app.ts`                                          | [View](apps/server/src/codemap.md)                 |
| `apps/server/src/config/`          | Sole environment parser: one validated `ServerConfig`, exhaustive production refusals                                           | [View](apps/server/src/config/codemap.md)          |
| `apps/server/src/services/`        | Service layer: AI client, headless audit, pipeline, prompts, gallery store, quiz, rate limits, static serving                   | [View](apps/server/src/services/codemap.md)        |
| `apps/server/src/scripts/`         | The topic-battery CLI measuring generation quality against a running server                                                     | [View](apps/server/src/scripts/codemap.md)         |
| `packages/`                        | The shared libraries (container)                                                                                                | [View](packages/codemap.md)                        |
| `scripts/`                         | The enforcement layer: `pnpm verify` plus its checkers and the build-time precompressor                                         | [View](scripts/codemap.md)                         |

### Root assets

| Path                                                     | Role                                                                                     |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `package.json`                                           | Workspace root: `dev`/`build`/`test`/`test:e2e`/`lint`/`typecheck`/`format` and `verify` |
| `pnpm-workspace.yaml`                                    | Workspace members: `packages/*`, `apps/*`                                                |
| `tsconfig.base.json`                                     | Shared TypeScript base config                                                            |
| `eslint.config.js`                                       | Flat config; enforces the one-way dependency direction                                   |
| `vitest.config.ts`                                       | Unit/integration test projects                                                           |
| `playwright.config.ts`                                   | E2E, desktop + phone profiles                                                            |
| `Dockerfile`, `docker-compose.yml`, `deploy.env.example` | One-container production deploy (no required configuration)                              |
| `Build_Docs/00..09-*.md`                                 | The requirements this implementation answers to                                          |
| `PLAN.md`                                                | Architecture decisions, phase plan and gates                                             |
| `README.md`                                              | Prerequisites, configure, run, deploy, verify                                            |
| `tests/e2e/`                                             | Playwright specs (`loading.spec.ts`, `viewer.spec.ts`)                                   |
| `.slim/codemap.json`                                     | Codemap change-detection state (`codemap.mjs changes` / `update`)                        |
| `docs/superpowers/`                                      | Historical plans, specs and phase reports                                                |
| `AGENTS.md`                                              | Agent entry point; points here                                                           |

> Maintenance: this map and the per-folder `codemap.md` files are tracked by
> `.slim/codemap.json`. After source changes run `node <codemap-skill>/scripts/codemap.mjs changes
--root .` to find affected folders, refresh only those maps, then `... update --root .`.
