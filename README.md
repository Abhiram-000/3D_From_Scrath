# EDU-3D

A web platform where a learner types any topic and an AI **writes real code** that builds an
interactive 3D lesson — explorable, manipulable, and physically honest — rendered with Three.js in a
hardened sandbox.

The AI is a programmer, not a form-filler. It receives a scene API and writes a program against it, so
the ceiling is the API rather than a schema. That program is untrusted: it runs in a locked-down Web
Worker realm with access to the scene API and nothing else.

Architecture decisions, phase plan and gates: **[`PLAN.md`](./PLAN.md)**.
Requirements this implementation answers to: **[`Build_Docs/`](./Build_Docs/)**, read `00-GOAL.md` first.

## Prerequisites

- Node 22 or newer (developed on 25)
- pnpm 10 (`corepack enable` then `corepack prepare pnpm@10 --activate`)
- Postgres 14+ — optional locally; without it the gallery uses a file-backed store that says so

## Install

```sh
pnpm install
```

## Configure

```sh
cp apps/server/.env.example apps/server/.env
```

Then set `AI_API_KEY` (and `AI_BASE_URL` / `AI_MODEL` if you are not using the OpenAI default). Every
variable is documented in the example file next to the reason it exists. Nothing else is required to
run locally: with no `DATABASE_URL` the gallery falls back to `.data/`, and with no `AI_API_KEY`
generation answers 503 while the viewer and gallery keep working.

`.env` is never committed — `pnpm check:secrets` fails the build if it is.

## Run

```sh
pnpm dev            # server + web, in parallel
```

## Verify

```sh
pnpm verify         # the single definition of "done"
```

Runs, in order: secret scan → config check → formatting → lint → typecheck → unit and integration
tests → build → end-to-end tests. Steps whose tooling does not exist yet report `SKIP`, never `PASS`.

Individual steps:

```sh
pnpm verify unit    # or: secrets, config, format, lint, typecheck, build, e2e
pnpm test           # unit + integration, watch with pnpm test:watch
pnpm test:e2e       # Playwright, desktop and phone profiles
```

## Layout

```
packages/contracts   wire formats, manifest schema, budgets, error taxonomy — imports nothing of ours
packages/sandbox     static gate, AST loop instrumentation, worker host, node:vm host
packages/engine      scene API, geometry builders, materials, lights, camera, runtime, physics
apps/web             SvelteKit: landing → loading → viewer
apps/server          Hono: generation pipeline, gallery, chat, quiz, health
scripts              check-secrets, check-config, verify
```

Dependency direction is one-way and lint-enforced: `engine` and `sandbox` run in Node with no DOM and
never import the app or the server; the server never imports frontend code; everything imports
`contracts`.

## Stack

Three.js (mandated, exclusively) · Rapier for physics in SI units · SvelteKit 2 / Svelte 5 runes ·
Hono 4 on Node · Postgres · TypeScript · Vitest + Playwright. The reasoning behind each choice,
including the ones rejected, is in [`PLAN.md`](./PLAN.md) §B.
