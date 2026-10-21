# apps/server/src/config/

## Responsibility

The single owner of environment parsing: `process.env` is read nowhere else in the server. It resolves every variable once into one validated `ServerConfig`, collecting all production misconfiguration as an exhaustive refusal list instead of greeting each problem one restart at a time.

## Design

- **Purity by argument**: `resolveConfig(env: Record<string, string|undefined>, deps: ResolveConfigDeps)` takes the environment map rather than reading globals — this is what lets the whole production-refusal matrix be unit-tested (`tests/config.test.ts`). Deps carry `staticSitePresent?: boolean` (default `false`, fail-safe: a missing probe refuses in production rather than fail-open).
- **Parsers**: `parseBoolean` treats the string `"false"` as false (operators' spellings `true/1/yes/on/enabled` vs `false/0/no/off/disabled`); `parseInteger` falls back instead of producing `NaN`; `parseList` splits/trim/filters comma lists.
- **ConfigProblem / ConfigWarning**: `problems` are fatal in production (each with an operator-actionable `fix`), `warnings` are informational and surface on `/api/health` via `config.warnings`. Famous collected refusals: no `DATABASE_URL` (unless `EDU3D_ALLOW_EPHEMERAL_STORE=true`), no `EDU3D_WRITE_TOKEN` (unless `EDU3D_ALLOW_OPEN_WRITES`), `TRUST_PROXY` unset, wildcard `ALLOWED_ORIGINS`, `PUBLIC_ORIGIN` absent when no static site is presented. No AI key is never a problem — it is the designed degraded mode (warning; generate/chat/quiz then 503).
- **`ServerConfig`** (all readonly): `env`/`isProduction`, `port`/`host`, `trustProxy`, `publicOrigin`, `allowedOrigins` (PUBLIC_ORIGIN auto-derived in; localhost:5173/4173 added outside production only), `ai{ configured, apiKey, baseUrl, model, chatModel, maxOutputTokens, fallback|null }`, `storage{ backend: 'postgres'|'file' (`StorageBackend`), databaseUrl, sslRejectUnauthorized, dataDir, allowEphemeral }`, `security{ writeToken, allowOpenWrites, csp: CspMode, hsts, forceHttps }`, `limits{ api, write, generate, chat, quiz }`, `logging{ level, pretty }`.
- **Env vars & defaults** (corroborated by `.env.example`): `PORT=8787`, `HOST=127.0.0.1`, `NODE_ENV` (development|test|production), `AI_API_KEY`, `AI_BASE_URL` default `https://api.openai.com/v1`, `AI_MODEL` default `gpt-5`, `AI_CHAT_MODEL` defaults to `AI_MODEL` (a wrong id is a provider 404, reuse always works), `AI_MAX_OUTPUT_TOKENS` default 64000, `AI_MAX_CONCURRENCY` default 1 (the provider plan's concurrency — the generation queue's slot count), `AI_QUEUE_MAX_WAIT_MS` default 900000 (bounded queue wait; past it `rate_limited` with a retry-after), `FALLBACK_AI_API_KEY`/`_BASE_URL` (freeinference.org/v1)/`_MODEL` (deepseek-v4-flash), `DATABASE_URL`, `EDU3D_DATA_DIR=.data`, `EDU3D_DB_SSL_REJECT_UNAUTHORIZED` defaults to `isProduction`, `EDU3D_CSP` (`enforce` prod / `report-only` dev), `EDU3D_HSTS`, `EDU3D_FORCE_HTTPS`, `EDU3D_API/WRITE/GENERATE/CHAT/QUIZ_RATE_LIMIT` defaults 600/30/12/60/30, `LOG_LEVEL=info`, `LOG_FORMAT` (pretty dev, json prod).
- **Report & refusal**: `formatStartupReport(config)` prints one identical text from server, CI check or test (never a secret value); `shouldRefuseToStart(config)` is simply `isProduction && problems.length > 0`.

## Flow

`main.ts:main` calls `resolveConfig(process.env, { staticSitePresent: STATIC_SITE_PRESENT })`, `console.log(formatStartupReport(config))`, then exits before opening the store if `shouldRefuseToStart`. `topic-battery.ts` resolves the same way so history rows name the model that actually generated them. After resolution, everything downstream reads the frozen object: `app.ts` uses `security.*`, `trustProxy`, `allowedOrigins`, `ai.configured`, `ai.maxOutputTokens`; `ai-client.ts` uses the `ai` block; `gallery-store.ts` the `storage` block; `rate-limits.ts` the `limits` block (via `buildLimiters`) and `trustProxy` (via `clientKey`); warnings flow to `/api/health`.

## Integration

- Depends on: nothing but `zod` (for `CspMode` and `StorageBackend` enums). Zero imports from services or contracts — it is the first dependency, not a middle.
- Consumed by: `main.ts` (also `app.ts` at runtime), `ai-client.ts`, `gallery-store.ts`, `rate-limits.ts`, `app.ts` (via `AppState`), `scripts/topic-battery.ts`. `STATIC_SITE_PRESENT` arrives from `services/static-pages.ts` as the caller-supplied probe. Behavioural evidence lives in `tests/config.test.ts` (defaults, refusals, derived settings, report wording).
