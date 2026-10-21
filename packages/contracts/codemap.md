# packages/contracts/

## Responsibility

The single source of truth for every shape that crosses a process, thread or network boundary in EDU-3D: the model manifest schema, endpoint wire formats, device budgets, audit vocabulary and the error taxonomy. It imports nothing from our own packages, so every other package may depend on it — the lint-enforced one-way dependency root.

## Design

- npm package `@edu3d/contracts` (package.json): ESM, `type: module`, one export `.` → `./src/index.ts`; only runtime dependency is `zod` 4.5.4; `tsc --noEmit` typecheck.
- src/index.ts is a commented barrel organized by concern: primitives → manifest/* (what a model _is_) → wire/* (how it travels) → audit + budgets (how it is judged and priced) → settings (what the learner chose). The export order is the reading order.
- Contract style: zod schema exported alongside its inferred type (`z.infer`), so consumers never re-declare wire shapes. Several frozen constant tables record policy as data, not prose: `DEVICE_BUDGETS`, `QUALITY_LADDER` (budgets.ts), `AUDIT_WEIGHTS`, `REFINEMENT_THRESHOLD` (audit.ts), `ERROR_STATUS`, `RETRYABLE`, `DEFAULT_ERROR_MESSAGE` (wire/errors.ts), `PHASE_WEIGHT`, `GENERATION_PHASES` (wire/generation.ts), `SANDBOX_LIMITS` (wire/sandbox.ts).
- Invariant: no GPU handles, URLs, `Date` objects or unbounded strings anywhere. Rejecting `NaN`/Infinity (`primitives.ts:finite`) happens once, here, making every downstream schema safe by construction.

## Flow

Consumers parse at their boundaries; no behavior lives here beyond schema construction. Entering data: HTTP requests validated against `wire/api.ts` request schemas; guest code against `wire/sandbox.ts` message unions. Leaving data: `ModelBundle` on generation/gallery paths, `ApiError` from every route, `SandboxRequest`/`SandboxResponse` across the sandbox boundary, `RuntimeStats` from the worker.

## Integration

- Depended on by everything — that is the design: `packages/sandbox` (see packages/sandbox/codemap.md) compiles against `wire/sandbox.ts` and `budgets.ts`; `packages/engine` realizes `manifest/*` (packages/engine/codemap.md); the server pipeline validates every endpoint with `wire/api.ts` and streams `wire/generation.ts` events (apps/server/codemap.md); the web client consumes bundle, events and settings (apps/web/codemap.md).
- Internal layout: read src/codemap.md for the root modules, src/manifest/codemap.md for the manifest schema layers, src/wire/codemap.md for transport protocols.
