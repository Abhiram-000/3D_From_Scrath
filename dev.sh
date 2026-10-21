#!/usr/bin/env bash
#
# dev.sh — bring the whole platform up with one command, then open the landing page.
#
#   ./dev.sh                  production-like: one origin, built site, CSP enforced  (default)
#   ./dev.sh --dev            hot reload: API + vite dev server, no CSP
#   ./dev.sh --db postgres    throwaway Postgres in Docker, torn down on exit
#   ./dev.sh --open-writes    accept unauthenticated publish locally (no token to paste)
#   ./dev.sh --reset-data     wipe .data/ (the file-backed gallery) before starting
#   ./dev.sh --fresh          reinstall deps and rebuild from scratch
#   ./dev.sh --port 9000      API port (reclaimed if a stale instance of ours holds it)
#   ./dev.sh --force-port     reclaim the port even from a process that is NOT ours (careful)
#   ./dev.sh --alt-port       take the next free port instead of reclaiming
#   ./dev.sh --no-open        do not launch a browser
#
# Port policy: a busy port is diagnosed, not silently avoided. If the holder is one of our own
# leftovers — a previous run, `pnpm dev`, an orphaned watcher — it is stopped and the port is
# reused. If the holder is a stranger (a container, another project), the script refuses and tells
# you exactly what is holding it rather than killing something it did not start. --force-port
# overrides that; --alt-port goes around it.
#
# Why the default is production-like rather than `pnpm dev`: the two are NOT equivalent, and the
# difference is the one that shipped a fatal bug. `vite dev` sets no Content-Security-Policy, so
# the viewer looks perfectly healthy there while the deployed configuration refuses to compile any
# model (`new Function` vs `script-src`). The default below is the configuration that is actually
# served in production, so "it works here" means something.
#
# Nothing here is imported by the application, so it cannot affect a running measurement. It starts
# only what it starts and kills only that.

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$REPO"

MODE="prod"          # prod | dev
DB="auto"            # auto | postgres | file
PORT="${PORT:-8899}"
WEB_PORT="${WEB_PORT:-5173}"
OPEN_BROWSER=1
FRESH=0
OPEN_WRITES=0
FORCE_PORT=0
ALT_PORT=0
RESET_DATA=0
PG_PORT=55432
PG_NAME="edu3d-dev-pg"

while [ $# -gt 0 ]; do
  case "$1" in
    --dev)          MODE="dev" ;;
    --db)           DB="${2:?--db needs auto|postgres|file}"; shift ;;
    --port)         PORT="${2:?--port needs a number}"; shift ;;
    --fresh)        FRESH=1 ;;
    --open-writes)  OPEN_WRITES=1 ;;
    --force-port)   FORCE_PORT=1 ;;
    --alt-port)     ALT_PORT=1 ;;
    --reset-data)   RESET_DATA=1 ;;
    --no-open)      OPEN_BROWSER=0 ;;
    -h|--help)      sed -n '2,25p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *)              echo "unknown option: $1 (try --help)" >&2; exit 2 ;;
  esac
  shift
done

# ── presentation ─────────────────────────────────────────────────────────────
if [ -t 1 ]; then
  B=$'\033[1m'; DIM=$'\033[2m'; G=$'\033[32m'; Y=$'\033[33m'; R=$'\033[31m'; C=$'\033[36m'; N=$'\033[0m'
else
  B=""; DIM=""; G=""; Y=""; R=""; C=""; N=""
fi
say()  { printf '%s\n' "$*"; }
step() { printf '\n%s▸ %s%s\n' "$B" "$*" "$N"; }
ok()   { printf '  %s✔%s %s\n' "$G" "$N" "$*"; }
warn() { printf '  %s!%s %s\n' "$Y" "$N" "$*"; }
note() { printf '  %s%s%s\n' "$DIM" "$*" "$N"; }
fail() { printf '\n%s✘ %s%s\n' "$R" "$*" "$N" >&2; exit 1; }

# ── teardown: only what this script started ──────────────────────────────────
STARTED_PIDS=()
PG_STARTED=0
cleanup() {
  local code=$?
  trap - EXIT INT TERM
  printf '\n'
  if [ "${#STARTED_PIDS[@]}" -gt 0 ]; then
    note "stopping ${#STARTED_PIDS[@]} process(es)"
    # Children first: `node --watch` and vite each fork a worker, and killing only the parent
    # would leave the real server holding the port — which is the stale holder this script then
    # has to reclaim next time.
    for pid in "${STARTED_PIDS[@]}"; do
      pkill -TERM -P "$pid" 2>/dev/null || true
      kill -TERM "$pid" 2>/dev/null || true
    done
    sleep 1
    for pid in "${STARTED_PIDS[@]}"; do
      pkill -KILL -P "$pid" 2>/dev/null || true
      kill -KILL "$pid" 2>/dev/null || true
    done
  fi
  if [ "$PG_STARTED" = "1" ]; then
    note "removing the throwaway Postgres container"
    docker rm -f "$PG_NAME" >/dev/null 2>&1 || true
  fi
  exit "$code"
}
trap cleanup EXIT INT TERM

# ── helpers ──────────────────────────────────────────────────────────────────
port_free() { node -e '
  const s = require("node:net").createServer();
  s.once("error", () => process.exit(1));
  s.once("listening", () => s.close(() => process.exit(0)));
  s.listen(Number(process.argv[1]), "127.0.0.1");
' "$1" 2>/dev/null; }

# pid(s) listening on a port, one per line. ss first, lsof second, nothing if neither exists.
port_holders() {
  local port="$1" pids=""
  if command -v ss >/dev/null; then
    pids="$(ss -lptn "sport = :$port" 2>/dev/null | grep -o 'pid=[0-9]*' | cut -d= -f2 | sort -u || true)"
  fi
  if [ -z "$pids" ] && command -v lsof >/dev/null; then
    pids="$(lsof -ti "tcp:$port" -sTCP:LISTEN 2>/dev/null | sort -u || true)"
  fi
  printf '%s' "$pids"
}

pid_cmd()  { tr '\0' ' ' < "/proc/$1/cmdline" 2>/dev/null | sed 's/ *$//'; }
pid_cwd()  { readlink -f "/proc/$1/cwd" 2>/dev/null || true; }

# Is this process one of ours? Two independent signals, both required, so a foreign process that
# merely mentions "vite" or "main.ts" cannot be mistaken for ours.
is_ours() {
  local pid="$1" cmd cwd
  cmd="$(pid_cmd "$pid")"; cwd="$(pid_cwd "$pid")"
  [ -n "$cmd" ] || return 1
  case "$cwd" in
    "$REPO"|"$REPO"/*) ;;
    *) return 1 ;;
  esac
  case "$cmd" in
    *"--experimental-strip-types"*"main.ts"*) return 0 ;;   # our API server
    *vite*)                                   return 0 ;;   # our dev server
    *)                                        return 1 ;;
  esac
}

describe_holder() {
  local pid="$1"
  printf 'pid %s — %s' "$pid" "$(pid_cmd "$pid" | cut -c1-110)"
  local cwd; cwd="$(pid_cwd "$pid")"
  [ -n "$cwd" ] && printf ' (cwd %s)' "$cwd"
  printf '\n'
}

stop_pid() {
  local pid="$1" i=0
  pkill -TERM -P "$pid" 2>/dev/null || true
  kill -TERM "$pid" 2>/dev/null || true
  while [ "$i" -lt 20 ]; do
    kill -0 "$pid" 2>/dev/null || return 0
    sleep 0.25; i=$(( i + 1 ))
  done
  pkill -KILL -P "$pid" 2>/dev/null || true
  kill -KILL "$pid" 2>/dev/null || true
  sleep 0.5
  kill -0 "$pid" 2>/dev/null && return 1 || return 0
}

# Make `want` usable: free → done; ours → stop it; stranger → refuse, unless forced or asked to
# step aside. Echoes the port to use.
settle_port() {
  local want="$1" label="$2" holder
  if port_free "$want"; then echo "$want"; return 0; fi

  local holders; holders="$(port_holders "$want")"
  printf '\n  %s!%s %s on %s is busy\n' "$Y" "$N" "$label" "$want" >&2
  if [ -z "$holders" ]; then
    note "  the holder cannot be identified from here — it may be a container, a process in another" >&2
    note "  network namespace, or a socket owned by another user. Use --alt-port, or free it yourself." >&2
  else
    while read -r pid; do
      [ -n "$pid" ] || continue
      printf '      ' >&2; describe_holder "$pid" >&2
    done <<< "$holders"
  fi

  # ── our own leftovers: stop them and reuse the port ──
  if [ -n "$holders" ]; then
    local all_ours=1
    while read -r pid; do
      [ -n "$pid" ] || continue
      is_ours "$pid" || all_ours=0
    done <<< "$holders"
    if [ "$all_ours" = "1" ] && [ "$ALT_PORT" = "0" ]; then
      note "  it is a leftover of ours — stopping it and reusing the port" >&2
      while read -r pid; do
        [ -n "$pid" ] || continue
        stop_pid "$pid" || fail "could not stop pid $pid"
      done <<< "$holders"
      if port_free "$want"; then echo "$want"; return 0; fi
      fail "port $want is still busy after stopping our own processes"
    fi
  fi

  # ── a stranger: never killed silently ──
  if [ "$ALT_PORT" = "1" ]; then
    local p=$(( want + 1 ))
    while [ "$p" -lt $(( want + 40 )) ]; do
      if port_free "$p"; then note "  --alt-port: using $p instead" >&2; echo "$p"; return 0; fi
      p=$(( p + 1 ))
    done
    fail "no free port in the next 40 after $want"
  fi

  if [ "$FORCE_PORT" = "1" ]; then
    [ -n "$holders" ] || fail "--force-port cannot act: the holder of $want cannot be identified
     (a container or another namespace). Free it yourself, or use --alt-port."
    warn "  --force-port: killing it anyway (this is not one of ours)"
    while read -r pid; do
      [ -n "$pid" ] || continue
      stop_pid "$pid" || fail "could not stop pid $pid"
    done <<< "$holders"
    if port_free "$want"; then echo "$want"; return 0; fi
    fail "port $want is still busy after --force-port"
  fi

  fail "$label port $want is held by a process that is not ours.
     Free it yourself, or choose: --alt-port (use the next free port) / --force-port (kill it)."
}

wait_for_http() { # url, seconds
  local url="$1" timeout="${2:-90}" i=0
  while [ "$i" -lt $(( timeout * 2 )) ]; do
    curl -sf -o /dev/null --max-time 3 "$url" && return 0
    i=$(( i + 1 )); sleep 0.5
  done
  return 1
}

wait_for_tcp() { # host, port, seconds
  node -e '
    const net = require("node:net");
    const [host, port, secs] = process.argv.slice(1);
    const deadline = Date.now() + Number(secs) * 1000;
    (function attempt() {
      const s = net.connect(Number(port), host);
      s.once("connect", () => { s.destroy(); process.exit(0); });
      s.once("error", () => {
        s.destroy();
        if (Date.now() > deadline) process.exit(1);
        setTimeout(attempt, 500);
      });
    })();
  ' "$1" "$2" "$3"
}

rand_token() { node -e 'console.log(require("node:crypto").randomBytes(32).toString("hex"))'; }

env_value() { # file, key → value (never printed by callers)
  node -e '
    const fs = require("node:fs");
    let text = "";
    try { text = fs.readFileSync(process.argv[1], "utf8"); } catch { process.exit(0); }
    const line = text.split("\n").find((l) => l.trim().startsWith(process.argv[2] + "="));
    if (!line) process.exit(0);
    let v = line.slice(line.indexOf("=") + 1).trim();
    if ((v.startsWith("\"") && v.endsWith("\"")) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    console.log(v);
  ' "$1" "$2"
}

# ── preflight ────────────────────────────────────────────────────────────────
step "Preflight"
[ -f "$REPO/package.json" ] || fail "no package.json at $REPO"
command -v node >/dev/null || fail "node is not installed (need 22+; developed on 25)"
command -v pnpm >/dev/null || fail "pnpm is missing — corepack enable && corepack prepare pnpm@10 --activate"
command -v curl >/dev/null || fail "curl is missing (used for readiness checks)"
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 22 ] || fail "node $NODE_MAJOR is too old; the server needs >= 22"
ok "node $(node -v) · pnpm $(pnpm -v)"

if [ "$FRESH" = "1" ] || [ ! -d "$REPO/node_modules" ]; then
  note "pnpm install (only when node_modules is missing, or with --fresh)"
  pnpm install
else
  ok "dependencies present ${DIM}(--fresh to reinstall)${N}"
fi

# ── environment ─────────────────────────────────────────────────────────────
step "Environment"
ENV_FILE="$REPO/apps/server/.env"
if [ ! -f "$ENV_FILE" ]; then
  [ -f "$REPO/apps/server/.env.example" ] || fail "no apps/server/.env.example to copy from"
  cp "$REPO/apps/server/.env.example" "$ENV_FILE"
  warn "created apps/server/.env from the example"
fi
AI_KEY="$(env_value "$ENV_FILE" AI_API_KEY)"
AI_MODEL="$(env_value "$ENV_FILE" AI_MODEL)"
if [ -n "$AI_KEY" ]; then
  ok "AI_API_KEY is set ${DIM}(${AI_MODEL:-provider default}) — generation unlocked${N}"
else
  warn "AI_API_KEY is empty — the viewer, gallery and reference model work; generation answers 503"
  note "   put a key in apps/server/.env to unlock generation"
fi

# ── database ────────────────────────────────────────────────────────────────
step "Database"
DB_ENV_URL="$(env_value "$ENV_FILE" DATABASE_URL)"
USE_STORE="file"
DATABASE_URL_EXPORT=""

if [ "$DB" = "postgres" ]; then
  command -v docker >/dev/null || fail "--db postgres needs docker, and docker is not on PATH"
  docker info >/dev/null 2>&1 || fail "docker is installed but the daemon is not responding (is it running?)"
  if docker ps -a --format '{{.Names}}' | grep -qx "$PG_NAME"; then
    note "removing a leftover $PG_NAME from an earlier run"
    docker rm -f "$PG_NAME" >/dev/null 2>&1 || true
  fi
  if ! port_free "$PG_PORT"; then
    note "postgres port $PG_PORT is busy — asking docker for a free one"
    PG_PORT="$(settle_port "$PG_PORT" "local postgres")"
  fi
  note "starting postgres:16-alpine on 127.0.0.1:$PG_PORT (removed on exit)"
  if ! docker run -d --rm --name "$PG_NAME" \
      -e POSTGRES_USER=edu3d -e POSTGRES_PASSWORD=edu3d -e POSTGRES_DB=edu3d \
      -p "127.0.0.1:$PG_PORT:5432" postgres:16-alpine >/dev/null; then
    fail "docker could not start postgres (is the image pullable? try: docker pull postgres:16-alpine)"
  fi
  PG_STARTED=1
  printf '  %s' "waiting for the database to be ready"
  # `pg_isready` INSIDE the container is the authoritative probe, and a bare TCP connect is not:
  # the image's entrypoint accepts connections briefly while it initialises, then restarts the
  # postmaster. A TCP-only check therefore passes against a server that is about to vanish, and the
  # API's pool is dropped with "Connection terminated unexpectedly" — which in production is a
  # refusal to start. Waited in half-seconds so a slow first initdb still succeeds.
  PG_WAIT=0
  PG_OK=0
  while [ "$PG_WAIT" -lt 180 ]; do
    if docker exec "$PG_NAME" pg_isready -U edu3d -d edu3d >/dev/null 2>&1; then PG_OK=1; break; fi
    PG_WAIT=$(( PG_WAIT + 1 )); sleep 0.5
  done
  if [ "$PG_OK" != "1" ]; then
    printf '\r%*s\r' 52 ""
    docker logs --tail 20 "$PG_NAME" 2>&1 | sed 's/^/      /' || true
    fail "postgres did not report ready on $PG_PORT within 90s"
  fi
  printf '\r%*s\r' 52 ""
  USE_STORE="postgres"
  # `?sslmode=disable` is required, not cosmetic. The store turns SSL ON whenever the URL carries no
  # `sslmode` (`gallery-store.ts:505`) — the right default for a managed cloud database, and wrong
  # for a local one, where it fails with "The server does not support SSL connections".
  DATABASE_URL_EXPORT="postgres://edu3d:edu3d@127.0.0.1:$PG_PORT/edu3d?sslmode=disable"
elif [ -n "$DB_ENV_URL" ] && [ "$DB" != "file" ]; then
  REST="${DB_ENV_URL#*@}"; HOSTPORT="${REST%%/*}"
  DBHOST="${HOSTPORT%%:*}"; DBPORT="${HOSTPORT##*:}"
  [ "$DBPORT" = "$DBHOST" ] && DBPORT=5432
  printf '  %s' "waiting for the configured database at $DBHOST:$DBPORT"
  if wait_for_tcp "$DBHOST" "$DBPORT" 30; then
    printf '\r%*s\r' 60 ""
    USE_STORE="postgres"; DATABASE_URL_EXPORT="$DB_ENV_URL"
  else
    printf '\r%*s\r' 60 ""
    warn "unreachable — falling back to the file store (the gallery will say so)"
  fi
fi

if [ "$USE_STORE" = "file" ]; then
  DATA_DIR="$REPO/.data"
  if [ "$RESET_DATA" = "1" ] && [ -d "$DATA_DIR" ]; then
    note "--reset-data: removing .data/"
    rm -rf "$DATA_DIR"
  fi
  mkdir -p "$DATA_DIR"
  ok "file store at .data/ ${DIM}(no DATABASE_URL — published models persist on this disk only)${N}"
else
  ok "Postgres ${DIM}— the server creates its schema on first boot, idempotently${N}"
fi

# ── ports ───────────────────────────────────────────────────────────────────
step "Ports"
PORT="$(settle_port "$PORT" "API")"
if [ "$MODE" = "prod" ]; then
  ok "single origin: API + built site on 127.0.0.1:$PORT ${DIM}(CSP enforced)${N}"
else
  WEB_PORT="$(settle_port "$WEB_PORT" "vite dev server")"
  ok "dev: API on 127.0.0.1:$PORT, vite on 127.0.0.1:$WEB_PORT"
  warn "dev mode sets NO Content-Security-Policy — it cannot prove the CSP wiring works"
fi

# ── write posture ───────────────────────────────────────────────────────────
WRITE_ENV=()
WRITE_TOKEN=""
if [ "$OPEN_WRITES" = "1" ]; then
  WRITE_ENV=(EDU3D_ALLOW_OPEN_WRITES=true)
  warn "open writes: anyone who can reach this port may publish and delete"
else
  WRITE_TOKEN="$(rand_token)"
  WRITE_ENV=("EDU3D_WRITE_TOKEN=$WRITE_TOKEN")
fi

# ── build ───────────────────────────────────────────────────────────────────
if [ "$MODE" = "prod" ]; then
  step "Building the site"
  BUILD_INDEX="$REPO/apps/web/build/index.html"
  NEED_BUILD=0
  [ "$FRESH" = "1" ] && NEED_BUILD=1
  [ -f "$BUILD_INDEX" ] || NEED_BUILD=1
  if [ "$NEED_BUILD" = "0" ]; then
    # A build older than the sources it came from is a stale build, and serving it is how you end
    # up debugging a fix that is not in the bundle.
    if [ -n "$(find "$REPO/apps/web/src" "$REPO/packages" -type f \
                \( -name '*.ts' -o -name '*.svelte' -o -name '*.css' \) \
                -newer "$BUILD_INDEX" -print -quit 2>/dev/null)" ]; then
      note "sources are newer than the build — rebuilding"
      NEED_BUILD=1
    fi
  fi
  if [ "$NEED_BUILD" = "1" ]; then
    pnpm build
  else
    ok "existing build is current ${DIM}(--fresh to force)${N}"
  fi
  [ -f "$BUILD_INDEX" ] || fail "the build produced no index.html"
  ok "site ready"
fi

# ── launch ──────────────────────────────────────────────────────────────────
step "Starting"
SERVER_ENV=("PORT=$PORT" "HOST=127.0.0.1" "TRUST_PROXY=0" "${WRITE_ENV[@]}")
if [ "$DATABASE_URL_EXPORT" != "" ]; then
  SERVER_ENV+=("DATABASE_URL=$DATABASE_URL_EXPORT")
else
  SERVER_ENV+=("EDU3D_ALLOW_EPHEMERAL_STORE=true" "EDU3D_DATA_DIR=$REPO/.data")
fi
[ "$MODE" = "prod" ] && SERVER_ENV+=("NODE_ENV=production")

# Each child is `exec`'d so the recorded PID is the real process; the subshell exists only so the
# `cd` cannot leak into this script. Do not background these with `| tee` — the pipe would break
# the PID and the teardown would miss it.
if [ "$MODE" = "prod" ]; then
  ( cd "$REPO/apps/server" && exec env "${SERVER_ENV[@]}" \
      node --experimental-strip-types src/main.ts ) &
else
  ( cd "$REPO/apps/server" && exec env "${SERVER_ENV[@]}" \
      node --watch --experimental-strip-types src/main.ts ) &
fi
API_PID=$!
STARTED_PIDS+=("$API_PID")

if ! wait_for_http "http://127.0.0.1:$PORT/api/health" 90; then
  if ! kill -0 "$API_PID" 2>/dev/null; then
    fail "the API exited during startup — its error is above"
  fi
  fail "the API never became healthy on $PORT within 90s"
fi
ok "API healthy"
HEALTH="$(curl -s "http://127.0.0.1:$PORT/api/health")"
note "   $(printf '%s' "$HEALTH" | node -e '
  let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
    try {
      const h = JSON.parse(s);
      const caps = h.capabilities ?? {};
      console.log(`storage ${h.storage} · ai ${caps.ai ? "ready" : "absent"} · snapshots ${caps.snapshots ? "ready" : "off"}`);
    } catch { console.log("(health not parseable)"); }
  });')"

if [ "$MODE" = "dev" ]; then
  ( cd "$REPO/apps/web" && exec env "API_ORIGIN=http://127.0.0.1:$PORT" \
      pnpm exec vite dev --port "$WEB_PORT" ) &
  WEB_PID=$!
  STARTED_PIDS+=("$WEB_PID")
  if ! wait_for_http "http://127.0.0.1:$WEB_PORT/" 60; then
    kill -0 "$WEB_PID" 2>/dev/null || fail "the dev server exited during startup — its error is above"
    fail "the dev server never came up on $WEB_PORT"
  fi
  ok "vite dev server up"
  URL="http://127.0.0.1:$WEB_PORT/"
else
  URL="http://127.0.0.1:$PORT/"
fi

# ── open ────────────────────────────────────────────────────────────────────
say ""
say "${B}${G}ready${N}  ${C}${URL}${N}"
if [ "$WRITE_TOKEN" != "" ]; then
  say "${DIM}publishing asks for a token once — paste this:${N}"
  say "  ${B}${WRITE_TOKEN}${N}"
  say "${DIM}kept in this browser only (localStorage: edu3d.publish.token), never shown again.${N}"
fi
note "Ctrl-C stops $( [ "$MODE" = "dev" ] && printf 'the dev server and ' )the API$( [ "$PG_STARTED" = "1" ] && printf ' and removes the throwaway database' )."

if [ "$OPEN_BROWSER" = "1" ]; then
  if command -v xdg-open >/dev/null; then (xdg-open "$URL" >/dev/null 2>&1 &)
  elif command -v open >/dev/null;  then (open "$URL" >/dev/null 2>&1 &)
  else warn "no browser opener found — open $URL yourself"; fi
fi

# Foreground on the API so its log stays visible and Ctrl-C tears everything down.
wait "$API_PID"
