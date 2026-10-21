# AGENTS.md

Project-specific guidance for agents working in this repository.

## Repository Map

A full codemap is available at [`codemap.md`](./codemap.md) in the project root.

Before working on any task, read `codemap.md` to understand:

- Project architecture and entry points
- Directory responsibilities and design patterns
- Data flow and integration points between modules

For deep work on a specific folder, also read that folder's `codemap.md`.

## Orientation

- Requirements: `Build_Docs/` (read `00-GOAL.md` first).
- Architecture decisions, phases and gates: `PLAN.md`.
- Setup, deploy and the `verify` gate: `README.md`.

## Non-negotiables

- The AI's generated program is **untrusted**; it runs in a sandbox with access to the scene API
  and nothing else. Never widen that boundary casually.
- Dependency direction is one-way and lint-enforced: `packages/contracts` imports nothing of ours;
  `packages/sandbox` and `packages/engine` are DOM-free and never import an app or the server;
  the server never imports frontend code.
- All rendering happens on the learner's device. The server never renders a pixel — its only engine
  contact is the headless `node:vm` authoring pass.
- `pnpm verify` is the single definition of "done". A step whose tooling is absent reports `SKIP`,
  never `PASS`.
