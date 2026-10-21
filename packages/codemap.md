# packages/

## Responsibility

Shared, runtime-agnostic libraries. Three pnpm workspace members, all DOM-free and Node-runnable, ordered by dependency: `contracts` (no deps) → `sandbox` and `engine` (which depend on `contracts`) → consumed by both `apps/*`.

## Design

Pure container — no source of its own. The layering is deliberate and lint-enforced: `packages/contracts` imports nothing of ours and is the single source of truth for wire formats, the manifest schema, budgets and the error taxonomy; `packages/sandbox` is the untrusted-code execution boundary; `packages/engine` is the scene API, geometry and runtime.

Because `engine` and `sandbox` run in Node with no DOM, the server can execute the AI's program headlessly (the `node:vm` authoring pass and the static gate) without a browser or GPU.

## Flow

`contracts` types flow outward into both libraries and both apps. `sandbox` prepares/compiles/hardens a program that `engine` then runs against the scene API — in the browser worker at view time, and in `node:vm` at generation time for audit.

## Integration

- `packages/contracts/` — [map](./contracts/codemap.md)
- `packages/sandbox/` — [map](./sandbox/codemap.md)
- `packages/engine/` — [map](./engine/codemap.md)

Consumed by `apps/web` and `apps/server`. `sandbox` and `engine` never import app or server code.
