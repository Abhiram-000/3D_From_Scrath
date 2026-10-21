# apps/web/

## Responsibility

The frontend deploy root of the workspace: a SvelteKit 2 / Svelte 5 static build whose three routes (landing → loading → viewer) own the DOM while `@edu3d/engine` and `@edu3d/sandbox` own the WebGL canvas inside a dedicated worker. It talks to `apps/server` only over same-origin `/api` fetches; the server never imports this code.

## Design

- Static adapter (`svelte.config.js`): `fallback: 'index.html'`, `strict: false` — no server hooks, deep links like `/viewer?model=<id>` resolve via the fallback, and the app deploys separately from the Hono API.
- `vite.config.ts` carries the two decisions that matter: the dev proxy sends `/api` and `/snapshots` to `127.0.0.1:8787` with `timeout: 0` (generation streams for minutes), and `manualChunks` splits `three`, `@dimforge/rapier3d-compat` (`physics`) and the BVH/CSG packages (`geometry-ops`) so the landing route downloads none of them. `optimizeDeps.exclude` for Rapier avoids WASM pre-bundling breakage.
- `package.json` scripts: `dev` (vite on :5173), `build` (`vite build` + `scripts/precompress.mjs` for precompressed previews), `typecheck` (`svelte-check --threshold warning`). Dependencies pin `three@0.185`, `@dimforge/rapier3d-compat@0.20`, and the workspace packages `@edu3d/contracts` / `@edu3d/engine` / `@edu3d/sandbox` — the dependency direction is one-way; nothing here imports `apps/server`.

## Flow

Landing (`src/routes/+page.svelte`) validates the topic with `lib/validate-topic.ts:suspiciousContent`, stores topic + complexity via `lib/core/api.ts:storeTopic`/`storeComplexity`, and the loading route calls `generateStream` (`POST /api/generate`, NDJSON `GenerationEvent`s) which feeds `lib/core/loading-progress.ts:ProgressModel` into `$state`. On the stream's `ready` event the `ModelBundle` is written to sessionStorage (`storeBundle`) and navigation continues to the viewer, which `takeBundle()`s it into a fresh sandbox worker (`lib/engine/sandbox-host.ts`).

## Integration

Depends on: `@edu3d/contracts` (wire formats — `GenerationEvent`, `ModelBundle`, `SETTINGS_STORAGE_KEY`, `STALL_HEARTBEATS`), `@edu3d/sandbox` (`compileGuest`, `hardenRealm` — worker side), `@edu3d/engine` (`SceneBuilder`, `realize`, `priceModel` — worker side). Consumed by: deployment (one container serves `build/` and the Hono API on one port; health check hits `/api/health`). Endpoints used: `/api/generate`, `/api/gallery`, `/api/chat`, `/api/quiz`; subfolders documented in `src/codemap.md`.
