# apps/

## Responsibility

Deployable applications. Two pnpm workspace members, one deploy root each: `apps/web` (SvelteKit frontend, built to static assets) and `apps/server` (Hono API, which also serves those assets in production so the app is same-origin).

## Design

Pure container — no source of its own. The split exists because the two halves have different runtimes (browser bundle vs Node process) and different deploy targets, while sharing `packages/*` through the workspace.

## Flow

`pnpm dev` runs both in parallel. At deploy time the server serves the web build, so a request enters through `apps/server` and either hits an API route or falls through to the static handler.

## Integration

- `apps/web/` — [map](./web/codemap.md)
- `apps/server/` — [map](./server/codemap.md)

Both import `packages/contracts` for wire types; `web` also imports `packages/engine` and `packages/sandbox`. Neither is imported by `packages/*` — dependency direction is one-way and lint-enforced.
