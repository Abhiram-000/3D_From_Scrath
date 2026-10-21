# apps/server/

## Responsibility

The single Node process that hosts the whole backend: the streamed generation pipeline, gallery, chat, quiz, health and the static frontend — one container serving the built site and `/api` same-origin. It "holds the AI key and the money" (package.json description), so it owns every expensive capability and every budget.

## Design

- Hono 4 (`hono` 4.13.7) on `@hono/node-server`, run type-less via `node --experimental-strip-types src/main.ts` (`dev` adds `--watch`; `typecheck` is `tsc --noEmit`).
- Dependency injection by object: `buildApp(state: AppState)` in `src/app.ts` receives one `AppState` (`config`, `ai: AiClient`, `store: GalleryStore`, `limiters: LimiterSet`, `draining`, `openStreams`, `startedAt`, `remoteAddress`) assembled once in `src/main.ts:main`.
- Strategy pattern at two seams: storage (`openGalleryStore` → `PostgresStore` | `FileStore` behind the `GalleryStore` interface) and AI (base URL/model/key fully config-driven, plus an independent cross-provider fallback provider).
- One error envelope for every endpoint: `apiError(code, message, requestId, retryAfterSeconds?)` mapped onto contracts `ERROR_STATUS`/`DEFAULT_ERROR_MESSAGE`/`ErrorCode`; requestId always echoed via `x-request-id`.
- Degradation as designed behaviour: no `AI_API_KEY` → generate/chat/quiz answer 503 `capability_absent` while viewer/gallery/static stay fully functional; no `DATABASE_URL` → file-backed store under `.data/` that announces itself; no built frontend → API-only mode (and `PUBLIC_ORIGIN` becomes a production refusal).
- Startup/lifecycle contract in `src/main.ts:main`: `resolveConfig` → `formatStartupReport` → `shouldRefuseToStart` refuses exhaustively (exits 1) → `openGalleryStore` → `buildApp` → `serve`; SIGTERM/SIGINT/uncaughtException run the ordered shutdown (drain flag → `server.close()` → `store.flush()`+`close()` → 15 s hard-exit timer); a 30 s unref'd interval sweeps limiter buckets.

## Flow

Boot once, then serve: every request enters `buildApp`'s middleware chain (request-id + forceHttps 308 → security headers/CSP → CORS allow-list → `/api/*` general limiter → route/served service) and leaves with either the JSON error envelope or route payload. AI-capable routes (`/api/generate`, `/api/chat`, `/api/quiz`) each layer their own limiter, capability gate and Zod schema validation before touching `AiClient`; `/api/gallery*`/`/api/snapshots/:id` go to the store; anything not `/api` falls through to `staticSiteMiddleware`. See `src/codemap.md` for the per-route lifecycle and `src/services/codemap.md` for the pipeline order.

## Integration

- Depends on `@edu3d/contracts` (all wire schemas, budgets, error taxonomy) and workspace `@edu3d/engine` + `@edu3d/sandbox` (used only inside services for the audit host, prompt reference surface and sandbox gate); runtime deps `pg`, `pino`, `zod`, `dotenv`, `hono`.
- Consumed by: `apps/web` via `src/lib/core/api.ts` (`API_BASE = '/api'`, NDJSON `GenerationEvent` from `/api/generate`, `GenerateRequest`/`ChatRequest`/`QuizRequest`/`PublishRequest`/`GalleryListQuery` in, `ModelBundle`/`ApiError` out); the topic battery in `src/scripts/topic-battery.ts`, which is an HTTP client of `/api/generate`; the built `apps/web` site served from `apps/web/build/` by `static-pages.ts`.
