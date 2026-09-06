# BUILD DOC 06 — STORAGE & SECURITY

> Read `00-GOAL.md` first. This document specifies _what must persist, what must be protected, and how the server behaves as a citizen of a hosting platform_. The reference implementation's scars are quoted as reasoning — each rule exists because its absence caused silent data loss, an unauthenticated write, or a deployment that was wrong in four ways at once with nothing announcing it.

## Mission

Published models are promises. A share link handed to thirty students is a promise that the model still exists tomorrow. Storage exists to keep promises; security exists so that keeping them costs nobody their gallery, their API budget, or their users' trust. And lifecycle exists so a redeploy — the most routine thing a platform does — never destroys either.

## Storage

### The persistence rule

**Durable by default: Postgres.** The gallery's primary store is PostgreSQL (`DATABASE_URL`). Postgres is chosen deliberately: relational integrity for the gallery, `TEXT[]` for tags, UUID keys, `TIMESTAMPTZ`, serverless-friendly managed providers (Neon, Supabase, Railway, Render), and no file-system dependency on platforms whose disks vanish.

**The fallback is a file, not memory — and it knows it's second best.** For local development with no database, a file-backed local store answers the same queries. The critical requirements, learned from real loss:

- A pure in-memory fallback means _every restart empties the gallery_ and every shared link silently dies — no error anywhere, because losing state that was never written down is not a failure any code path can observe. The fallback must therefore write through to disk (debounced, so a publish burst becomes one write) and flush on shutdown
- **Atomic writes**: temp file + rename. A crash during a direct overwrite leaves a truncated store — recreating the data loss the fallback exists to prevent
- **A corrupt store is quarantined, never deleted** — it is the only copy of whatever was in it
- **Bounded rows** (oldest-first eviction) so an unattended instance cannot fill a disk
- The fallback _announces itself_, once, plainly: "the gallery is stored in a local file; published models are lost if this filesystem is replaced" — and it distinguishes _no DATABASE_URL configured_ from _DATABASE_URL set but unreachable_, because those send the operator to completely different fixes
- **Production refuses to start on the fallback** unless an operator sets an explicit "I accept ephemeral storage" flag — the refusal is the feature; silently running production on a vanishing disk is the bug

### Schema requirements

```
blueprints (id UUID PK, name, subject, tags TEXT[], code TEXT,
            snapshot_url, created_at, updated_at)
snapshots   (id UUID PK, mime, bytes BYTEA, byte_length, created_at)
```

The rules encoded there:

- **Snapshots live in their own table, not on disk, and not in the blueprints row.** Two reasons, both from real deployments: (a) an ephemeral filesystem erases the upload directory on redeploy while rows keep pointing at it — every gallery thumbnail renders empty _forever_, silently; (b) inlining image bytes into the row would drag hundreds of kilobytes per model across every `SELECT *` for the viewer. Separate table: list queries stay light, bytes survive redeploys
- **Indexes on subject and created_at DESC** — the gallery's two real query patterns
- Parameterized queries _only_ — the list route's `subject`/`search` filters build `$n` placeholders, never string interpolation; bounded `LIMIT`/`OFFSET` pagination (an unvalidated limit is one request asking for the entire table)
- Ids are UUIDs; anything not shaped like one is rejected at the route with a 400 before the query layer ever sees it
- **Schema creation is idempotent** (`CREATE TABLE IF NOT EXISTS`) at startup, with a committed `setup.sql` for planned provisioning; disk-snapshot migration to the database runs automatically on first boot with a database, so switching a long-running instance to Postgres doesn't orphan every old gallery card

### Snapshot ingestion (user-uploaded bytes)

- **Buffer in memory, validate, then commit** — never stream to disk first (a rejected upload that already created a file must be unlinked on every error path, and a missed unlink is a file that lives forever)
- **Magic-byte sniffing, not the client's MIME type**: the multipart `Content-Type` is client-supplied and means nothing; these images are served from your own origin, so accepting an attacker-chosen body under `image/png` is how same-origin HTML or SVG gets hosted. Verify PNG/JPEG/WebP/AVIF container signatures before storing
- Bounded: size ceiling, one file, bounded fields/parts — a malformed multipart body cannot allocate freely
- Served with `X-Content-Type-Options: nosniff` and immutable caching (content-addressed ids)

## Security

### The threat model, stated plainly

This server: holds an API key that costs money per call, runs on a public URL, accepts user text, stores user-published content, and serves generated (untrusted) models to browsers. Every control below maps to one of those facts.

### Write protection

- **Writes are token-guarded**: publishing, deleting, overwriting the fallback model — all mutating endpoints require a bearer token (`EDU3D_WRITE_TOKEN`) when one is configured
- **Opt-in by default for local use** (no token → writes open, and startup _says so_), but production refuses to start with unauthenticated writes unless explicitly accepted
- **Constant-time comparison** — hash both sides then `timingSafeEqual`, because naive `===` on a secret leaks length and prefix to a patient attacker
- **Tokens travel in headers, never query parameters** — URLs are copied into browser history, proxy logs, monitoring and referrers
- Refusals are logged with the request id and answered with the request id; a 401 that cannot be correlated to a log line is a support request nobody can resolve

### Rate limiting

- **Layered budgets**: a general API limiter (generous — one model load makes several calls), a tighter write limiter (writes are rarer and more consequential), and per-endpoint limiters for the expensive AI paths (generate/chat/quiz), because a classroom behind one NAT address is one IP
- **Health checks are exempt from every limiter** — monitoring must never lock the service out of its own buckets
- **`trust proxy` must be resolved from configuration** — with Express's default (off), every visitor behind a platform router shares the router's IP and therefore one bucket; the fourth concurrent visitor starts receiving 429s while nowhere near the limit. This is the single most consequential deployed-server setting, and the rate limiter's own validation warning about the mismatch is a signal to keep, not silence
- Limiter validation stays _on_: it detects the trust-proxy mismatch, and that complaint is how the misconfiguration stays visible

### CORS, headers, transport

- **Origin allow-list** (never `*` in production): the deployed platform's own advertised URL is derived and included automatically so a first deploy works; extra origins from config; `localhost` trusted only outside production — a deployment trusting `http://localhost:*` is trusting any developer machine on earth, because `Origin` is whatever the requesting page's address happens to be
- **CSP from configuration** (enforced or report-only, stated at startup), HSTS opt-in, frameguard `sameorigin` (stops quota-harvesting hidden iframes), `X-Content-Type-Options`, strict referrer policy
- HTTPS redirect opt-in (most platforms terminate TLS at the edge; doing it twice is waste), correct only once `trust proxy` is set
- `x-powered-by` disabled; errors carry **request ids, never internal detail or stack traces**
- **Static serving is an explicit allow-list of frontend directories — never the repository root**, which would expose server source, environment files and the system prompt

### Secrets and configuration

- **API keys live only in env files server-side**; the frontend has zero knowledge of them
- `.env` files gitignored with committed annotated examples; **an automated secret scan runs on every test run** — "no secrets in the repo" is enforced by tooling, not memory
- **Configuration resolves once into one validated object** — never `process.env.X` scattered across a dozen call sites with private defaults; boolean parsing that treats `"false"` as false (the string is truthy — the most common "I turned it off and it stayed on" bug)
- **Production misconfiguration is fatal and _exhaustive_**: every problem (no write token, no database, no origins) is listed at startup, not just the first — finding them one restart at a time is a bad use of anybody's afternoon
- A real environment variable always beats a file, so CI secrets and container config work unchanged

## Lifecycle — the deployed citizen

A redeploy sends SIGTERM and waits. The shutdown sequence, in order, each step for a reason:

1. **Flip the drain flag** — readiness starts failing 503 so the load balancer stops routing; new expensive requests are refused with an explanation and `Connection: close` (not accepted onto a socket about to vanish)
2. **Stop accepting connections** — in-flight requests run to completion
3. **Notify every open generation stream** — a learner one to three minutes into a generation gets a terminal "server is restarting, try again" event instead of a severed socket with a generic network error at the worst possible moment
4. **Flush and close** — debounced local writes flushed, analytics persisted, database pool closed, in registration order
5. **Exit, guaranteed by a hard timer** — a process that refuses to die gets SIGKILLed by the platform and loses everything step 4 was for

Liveness and readiness are **separate**: liveness says only "the process exists" (a liveness probe that fails on a dead _database_ causes the platform to restart a healthy process, which fixes nothing and loses in-flight work); readiness reports draining so rolling deploys are graceful. `unhandledRejection` and `uncaughtException` are handled — one stray rejected promise must not take the server down outside any request cycle. Socket timeouts are sized for the workload (a generation stream legitimately runs minutes; Node's defaults assume request/response traffic).

## Edge cases

- DATABASE_URL points at an unreachable database in production → refuse to start (silently demoting to the local store would make successful writes vanish on redeploy); in development → warn, demote, announce
- TLS mismatch against Postgres (local Docker = no SSL; managed providers = required) → detect from the error direction, retry with the other setting, and never override an `sslmode=` the operator stated in the URL
- An idle pool client dying → logged as a warning and replaced by the pool; an unhandled `pool.on('error')` is a crash risk
- Snapshot upload with a lying MIME type → magic-byte rejection, 400, nothing stored
- Delete of a model whose snapshot is already gone → both succeed independently, no orphan errors
- Two publishes racing → distinct UUIDs, both fine; debounced persist coalesces
- Restart mid-persist → atomic rename means the old file is intact or the new one is complete, never a truncated hybrid

## Testing

- **Storage**: insert/list/get/delete round-trips on both backends; pagination bounds; subject/search filters; corrupt-file quarantine; atomic-write crash simulation; disk→database snapshot migration
- **Auth**: token required when configured, open when not; constant-time comparison; header-only token sources; production refusal states
- **Rate limits**: buckets keyed per client behind a proxy; health exempt; write budget separate from read budget
- **Lifecycle**: SIGTERM drains (open streams notified, in-flight requests complete, store flushed); readiness fails while draining; liveness stays up; hard-exit timer fires on a hung step
- **Secrets**: the scan catches a planted key and fails the run

## What you decide

ORM vs. raw SQL, migration tooling, exact limiter values, the fallback store's format — yours. The contracts: Postgres-first durability, snapshots with the bytes they promise, token-guarded writes, layered limits with proxy-awareness, exhaustive startup validation, and a shutdown sequence that treats every in-flight human as a promise to keep.

## The final image

The platform redeploys at 2 a.m. A student twenty minutes into the night's third generation sees "the server is restarting — your generation was interrupted, try again in a moment" and does, and it works. The gallery is identical after the redeploy, every shared link resolves, every thumbnail renders, and the only log lines are the drain doing its job. Nothing was lost, nobody was lied to, and nobody had to be awake for it. That is what this document builds.
