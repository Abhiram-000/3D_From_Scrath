# EDU-3D production image — one container, one port.
#
# Stage 1 builds the static frontend; stage 2 builds/hosts the API server and serves the built
# site from the same origin (apps/server/src/services/static-pages.ts). The result deploys with
# `docker run -p 8787:8787 -e AI_API_KEY=… -e EDU3D_WRITE_TOKEN=… edu3d` and works: no CORS, no
# DATABASE_URL required (the file store persists to a mounted volume). EDU3D_WRITE_TOKEN guards
# publish/delete — required in production unless a deploy explicitly sets
# EDU3D_ALLOW_OPEN_WRITES=true; without either the server refuses to start, and its request guard
# fails closed to 401s even if some later configuration change slips past the boot check.
#
# Node slim (not alpine: native deps like pg's build path are happier on glibc) with corepack
# providing the pinned pnpm.

FROM node:25-slim AS web-build
WORKDIR /build
# Node 25's slim image ships no corepack; install the pinned pnpm directly.
RUN npm install -g pnpm@10.28.2
# Workspace manifests (and the shared tsconfig the web build extends) first for layer-cached
# dependency install.
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY apps/web/package.json apps/web/
COPY packages/contracts/package.json packages/contracts/
COPY packages/engine/package.json packages/engine/
COPY packages/sandbox/package.json packages/sandbox/
RUN pnpm install --frozen-lockfile --filter @edu3d/web... --filter @edu3d/contracts...
# Source, then build. `NODE_ENV=production` keeps dev-only vite plugins out.
COPY packages packages
COPY apps/web apps/web
# The build's last step writes a precompressed copy of every asset, so the server never spends CPU
# compressing on the fly. It lives in `scripts/`, so that is part of the build context.
COPY scripts scripts
RUN pnpm --filter @edu3d/web build

FROM node:25-slim AS server
WORKDIR /app
ENV NODE_ENV=production
RUN npm install -g pnpm@10.28.2
# Server-side dependency install (engine + sandbox + contracts are consumed as workspace source).
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY apps/server/package.json apps/server/
COPY packages/contracts/package.json packages/contracts/
COPY packages/engine/package.json packages/engine/
COPY packages/sandbox/package.json packages/sandbox/
RUN pnpm install --frozen-lockfile --filter @edu3d/server... --prod

# Server source AND the workspace package sources it imports via symlinks (contracts, engine,
# sandbox are consumed as source — the whole point of the no-build server). Node's native type
# stripping runs them directly; nothing to compile out of date.
COPY apps/server/src apps/server/src
COPY packages/contracts/src packages/contracts/src
COPY packages/engine/src packages/engine/src
COPY packages/sandbox/src packages/sandbox/src
# The built frontend from stage 1, where static-pages.ts serves it.
COPY --from=web-build /build/apps/web/build apps/web/build

# Unprivileged runtime user; the volume below is chowned to match.
RUN useradd --system --uid 10001 edu3d && mkdir -p /data && chown edu3d:edu3d /data
USER edu3d
VOLUME /data

# Single-container defaults, overridable at `docker run` with -e. They encode the deliberate
# deployment decisions for this shape: file-store persistence to /data (explicitly accepted —
# the volume makes it durable across redeploys on the same host) and one proxy hop (the norm on
# every hosting platform).
#
# What is deliberately NOT defaulted: EDU3D_ALLOW_OPEN_WRITES is gone. Publishing and deleting are
# capability-gated — in production the server refuses to boot without EDU3D_WRITE_TOKEN (set it at
# `docker run -e EDU3D_WRITE_TOKEN=…`), and its write guard fails closed to 401s even when the
# boot refusal is somehow bypassed. The previously baked-in open-writes default answered every
# anonymous POST /api/gallery with a 201 and let the same anonymous caller delete the gallery.
# Writing "open while the platform is young" as a default flag meant the operator never made that
# choice; setting it explicitly is one line in this file when a sandbox deployment wants it.
#
# After these, a deploy with a key and a token starts and works with zero other configuration.
ENV EDU3D_DATA_DIR=/data \
    EDU3D_ALLOW_EPHEMERAL_STORE=true \
    TRUST_PROXY=1 \
    HOST=0.0.0.0

EXPOSE 8787
# tini-style reaping: node:25-slim includes no init by default, and PID 1 must forward signals
# for the graceful drain (`06`) to ever run. `--init` on docker run does the same; this makes it
# explicit for orchestrators that pass the entrypoint straight through.
ENTRYPOINT ["node", "--experimental-strip-types", "apps/server/src/main.ts"]
