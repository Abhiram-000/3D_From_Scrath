# apps/server/src/

## Responsibility

Composition root of the server: `main.ts` runs the process lifecycle (resolve → validate → serve → drain) and `app.ts` assembles the Hono app — all routes, middleware, the error taxonomy and the write-token guard — around one injected `AppState`.

## Design

- **Dependency injection**: `AppState` (`app.ts`) carries `config: ServerConfig`, `ai: AiClient`, `store: GalleryStore`, `limiters: LimiterSet`, `draining`, `openStreams`, `startedAt`, and `remoteAddress` — a fallback `'127.0.0.1'` used only when the runtime exposes no socket (`clientKey` reads the real socket per request; the constant must never be primary). `main()` builds it once.
- **Error taxonomy**: `apiError(code, message, requestId, retryAfterSeconds?)` in `app.ts` is the one shape (`ApiError` from contracts); `app.notFound` keeps JSON for `/api/*`, `app.onError` logs and returns `internal` 500 with the id the client saw.
- **Opt-in write token**: `requireWriteToken(state, authorization)` compares SHA-256 digests with `timingSafeEqual` (hashing both sides defeats length/prefix leak); unset `EDU3D_WRITE_TOKEN` fails open locally, and the production refusal happens in config instead.
- **Startup/health split**: `/api/health` (liveness + capabilities: `config.ai.configured`, store backend, warnings from config and store announcement, `openGenerationStreams`) vs `/api/ready` (503 `draining`). `main.ts` feeds `STATIC_SITE_PRESENT` (from `static-pages.ts`) into `resolveConfig` so the boot probe and the serving middleware agree.
- **Shutdown sequence** (`main.ts:shutdown`): drain flag → `server.close()` + sweep-timer clear → store `flush()`/`close()` → 500 ms exit with a 15 s `SHUTDOWN_HARD_EXIT_MS` hard-exit guarantee. `unhandledRejection` logs; `uncaughtException` triggers drain. Limiter buckets are swept every 30 s by an unref'd interval.

## Flow

Request lifecycle through `buildApp`:

1. Middleware `*` (request-id): `newRequestId()`, sets `x-request-id`; under `forceHttps` a `x-forwarded-proto: http` request 308-redirects to https before any handler runs.
2. Middleware `*` (headers, post-handler): `x-content-type-options`, `referrer-policy`, `x-frame-options`, optional HSTS, and the fixed CSP policy — `report-only` header always, `content-security-policy` added when `csp === 'enforce'`.
3. CORS: `hono/cors` with origin echo only if it is in `config.allowedOrigins`; methods GET/POST/DELETE/OPTIONS.
4. `/api/*`: general limiter via `limitWith(state.limiters.api, config.trustProxy, state.remoteAddress)`.
5. `GET /api/health` / `GET /api/ready` — no limiter (monitoring must not lock itself out).
6. `POST /api/generate`: battery exemption check (`isBatteryExemption(header, connectionAddress(context))`, both required) else generate limiter; drain → 503 `draining`; `GenerateRequest.safeParse` → 400 `bad_request` before the capability gate; unconfigured AI → 503 `capability_absent`; non-streaming runs `runPipeline` with a buffering sink and answers `{ bundle, audit, requestId }`; streaming wraps `runPipeline` in an NDJSON `ReadableStream` (queued `phase` event first, guarded `write()` that flips `clientGone` instead of throwing into a closed controller, terminal `ready` or `error`, `state.openStreams` counted via `tracked()`), headers `application/x-ndjson`, `x-accel-buffering: no`.
7. `POST /api/chat`: chat limiter → drain → `ChatRequest` parse → capability gate → `buildChatPrompt(persona, context JSON)` → `state.ai.complete` (last 12 history turns, 2000 tokens, 60 s) → non-stream `{ text }` or NDJSON `delta` chunks (~60 chars, 15 ms apart) ending with `done`.
8. `POST /api/quiz`: quiz limiter → `QuizRequest` parse → capability gate → `buildQuizPrompt` → `state.ai.complete` → `validateQuizQuestions(text)` → `{ questions, dropped, requestId }`.
9. `GET /api/gallery` (`GalleryListQuery`), `GET /api/gallery/:id` (UUID regex before any query), `POST /api/gallery` (write limiter + `requireWriteToken`, `PublishRequest`, snapshot size ceil `SNAPSHOT_MAX_BYTES` → 413, `sniffSnapshot` → 400 on unknown magic bytes, `store.putSnapshot` + `store.put`, 201 `{ id, shareUrl }`), `DELETE /api/gallery/:id` (same guard), `GET /api/snapshots/:id` (path-traversal sanitised, immutable cache, `store.getSnapshot`).
10. Mounted last: `staticSiteMiddleware` (`*`) — `/api` is always API, everything else is pages; then `notFound`/`onError` above.

## Integration

- Imports contracts: `GenerateRequest`, `ChatRequest`, `QuizRequest`, `PublishRequest`, `GalleryListQuery`, `ERROR_STATUS`, `DEFAULT_ERROR_MESSAGE`, `ApiError`, `ErrorCode`.
- Imports every service: `ai-client.ts` (type), `pipeline.ts` (`runPipeline`), `prompts.ts` (`buildChatPrompt`, `buildQuizPrompt`), `gallery-store.ts` (`GalleryStore`, `sniffSnapshot`, `SNAPSHOT_MAX_BYTES`), `rate-limits.ts` (`limitWith`, `connectionAddress`, `isBatteryExemption`, `BATTERY_REQUEST_HEADER`, `LimiterSet`), `static-pages.ts` (`staticSiteMiddleware`), `quiz.ts` (`validateQuizQuestions`), `config/config.ts` (`ServerConfig`).
- Consumed by: nothing (this is the wire surface). Boundary = the routes above; `apps/web/src/lib/core/api.ts` is the reference client (`API_BASE '/api'`, `GenerateOptions.stream`, `STALL_HEARTBEATS × HEARTBEAT_INTERVAL_MS` stall detection); `topic-battery.ts` calls `/api/generate` directly.
