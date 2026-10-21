# packages/engine/src/hosts/

## Responsibility

The Node host (`node-host.ts`): runs a guest program inside a fresh `node:vm` context, DOM-free and GPU-free, so the server can execute the AI's real code for the headless audit — observing parameter effects rather than guessing from a schema.

## Design

- `authorInNodeVm(options): NodeHostResult` mirrors the browser guest join exactly — the capability set must match or the server approves models the viewer cannot run: `GUARD_IDENTIFIER` loop-guard tick from `createGuard()`, `scene`/`geom`/`mat` facades from one `SceneBuilder`, `Object.freeze`d `M`, seeded `random`, bounded `createConsole` (200 entries × 500 chars).
- `createGuestContext(bindings)` — `vm.createContext` with fresh intrinsics so one model cannot leave a poisoned `Array.prototype` for the next request, while the host process realm stays untouched. `FORBIDDEN_GLOBALS` are set to explicit `undefined` (matching what compiled lexical shadowing probes as); `codeGeneration: { strings: false, wasm: false }` is the belt behind the gate's `eval` ban; shared `hardeningScript()` from `@edu3d/sandbox` freezes only the guest realm (same script as the browser guest — the two hosts cannot drift).
- `runInContext`'s own `timeout` is the second line of defence behind the injected loop guards, and the only mechanism that can interrupt synchronous code from outside; the program is wrapped in a strict-mode IIFE so sloppy-mode `this` cannot recover the hardened global.
- `describeFailure` duck-types across the realm boundary — guest errors are constructed from the guest realm's `Error`, so `instanceof` fails — matching `SceneError`/`GeometryError`/`MaterialError` by _name_ and timeouts by message pattern; never throws, returning `{ message, timedOut }` for the repair pipeline.

## Flow

Instrumented source (gate + loop instrumentation run beforehand in `@edu3d/sandbox`) → `createGuestContext` → `guard.reset(deadlineMs ?? SANDBOX_LIMITS.buildDeadlineMs)` → strict IIFE `runInContext(program, context, { timeout, breakOnSigint })` → `builder.toManifest()` → `{ ok: true, manifest, builder, logs, durationMs }` (the retained builder is then swept/runFrame'd by the audit) or `{ ok: false, message, stack, timedOut }`.

## Integration

Depends on `node:vm`, `@edu3d/contracts` (`SANDBOX_LIMITS`), `@edu3d/sandbox` (`FORBIDDEN_GLOBALS`, `GUARD_IDENTIFIER`, `createGuard`, `hardeningScript`), and the engine's own `authoring/`, `geometry/`, `materials/`, `math/`. Reachable only via the `@edu3d/engine/node-host` subpath (`package.json` export) and never re-exported from `src/index.ts`, because `node:vm` poisons browser bundles. Consumer: `apps/server/src/services/audit.ts` (`import { authorInNodeVm } from '@edu3d/engine/node-host'`). Behavioural pins live in `tests/host-admission.test.ts`: identical manifest to the browser path, network capability denied, runtime compile refused, per-build realm freshness, host realm intact, runaway loops terminated with actionable messages, sweep support.
