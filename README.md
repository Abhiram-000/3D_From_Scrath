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

## Deploy (production)

One container serves everything — the built frontend and the API on one port, same-origin — with
**no required configuration for browsing, viewing and generating**: no login, no database, no CORS
setup. Add an AI key and generation unlocks; add nothing and the viewer, reference model and gallery
still work.

**Publishing and deleting need one more thing, on purpose.** Production refuses to boot with open
writes (`04`, `06`): an unauthenticated default let any visitor publish and delete. So give it a
token in the same file —

```sh
cp deploy.env.example deploy.env
printf 'EDU3D_WRITE_TOKEN=%s\n' "$(openssl rand -hex 32)" >> deploy.env   # required to publish
# optional: add AI_API_KEY to the same file to unlock generation
docker compose up                  # → http://localhost:8787
```

The browser asks for that token once, the first time a learner publishes, and remembers it. If you are
running an actual sandbox where open writes _are_ the point, set `EDU3D_ALLOW_OPEN_WRITES: 'true'` in
`docker-compose.yml` and own the choice — the server will still fail closed to 401s on every write.

What the compose file handles so you don't have to: production mode, `0.0.0.0` binding, proxy-aware
rate limits, the gallery persisted to a named volume (survives redeploys), a health check wired to
`/api/health`, and graceful drain on stop (in-flight generations finish; open streams are told).
To upgrade storage to Postgres, uncomment the `postgres` service and set `DATABASE_URL` — nothing
else changes. To deploy the frontend separately (CDN), set `PUBLIC_ORIGIN` to its URL.

The image is multi-stage and reproducible: dependency layers are cached by manifest, the frontend
build is pinned by lockfile, and the server runs its TypeScript directly (nothing to compile out of
date). Any platform that runs a container works — Fly.io, Railway, Render, a VPS with `docker run
-d -p 8787:8787 edu3d`.

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
