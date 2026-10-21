# packages/engine/

## Responsibility

`@edu3d/engine` (v0.1.0, `"type": "module"`, private) is the scene API handed to AI-written guest code, the runtime that realizes and prices a `ModelManifest`, the Node sandbox host, and the reference models. Per its `package.json` description it is framework-agnostic and DOM-free: it runs in a browser worker and in plain Node.

## Design

- Three package exports, three audiences: `.` → `src/index.ts` (the barrel everything but the server host imports), `./authoring` → `src/authoring/index.ts`, `./node-host` → `src/hosts/node-host.ts`.
- The `authoring/` boundary validates the guest's declarations **structurally, never through zod at runtime**: the same `scene.ts` executes inside the poisoned guest realm (`@edu3d/sandbox` replaces `Function` with a thrower), and zod's `parse`/`safeParse` touches `Function`, so a schema call there throws `Function is not available inside the model sandbox` — a browser-only failure that `node:vm` (unpoisoned) never sees. Closed vocabularies are still the contract's: enums are read off a schema's `.options` (a property read, safe) at module scope, and `api-reference.ts` renders its prompt unions from those same enums so the documentation cannot teach an illegal value.
- `scripts.typecheck` is `tsc --noEmit`; devDeps are `@types/node` 26.4.1, `@types/three` 0.185.4, `typescript` 6.0.3.

## Flow

No data flows here — this layer only declares the boundary. Runtime data flows source → sandbox gate/instrumentation → engine guest join → `ModelManifest` (authoring pass, server) → admission pricing → realized Three.js scene graph (browser only).

## Integration

- Dependencies ("dependencies" in `package.json`): `@edu3d/contracts` `workspace:*` (all wire types, budgets, limits), `three` 0.185.1 (the only GPU-touching dep, reachable only via `src/runtime/realize.ts`), `@edu3d/sandbox` `workspace:*` (containment: compile, guard, hardening).
- Dependency direction is one-way and lint-enforced: engine never imports apps or other packages' internals; `apps/web/src/lib/engine/*`, `apps/server/src/services/*` and `packages/engine/tests` import engine. The `./node-host` subpath exists so the server can import the Node-only host directly without a browser-facing barrel entry (see `src/index.ts:86-95`).
