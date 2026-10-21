# apps/server/src/scripts/

## Responsibility

The topic battery harness — `PLAN.md`'s P8 gate: run a fixed set of topics through the live generation endpoint, record build rate / part count / binding count per topic, and append an attributable history row per prompt version so prompt changes are judged by evidence, not vibes.

## Design

- **Two-layer structure**: pure, importable row builders (`historyRow(promptVersion, model, summary, at?)`, `dryRunRow(config: ServerConfig)`, `deriveBindingCount(parameterIds, unboundParameterIds)`) and side-effecting `runTopic`/`main`. `BatterySummary` holds the five comparable numbers (buildRate, averagePartCount, averageBindingCount, averageAuditScore, totalDurationSeconds); `BatteryHistoryRow` adds `at`, `promptVersion`, `model` — real values, never placeholder prose.
- **Run guard**: `main()` only executes when `import.meta.filename === path.resolve(process.argv[1])`, so importing the module in tests never spends API budget (a real run is eight multi-minute generations).
- **Measurement is structured, never prose**: `deriveBindingCount` counts parameters whose ids are not accused by a `parameterLeverage` deficiency's `subjectId` (set equality). The earlier prose-substring derivation counted a `mass` parameter as unbound because `"massive".includes("mass")` — tests (`tests/topic-battery.test.ts`) lock the structured derivation in.
- **Rate-limit exemption as a client**: every generate call carries `BATTERY_REQUEST_HEADER: BATTERY_REQUEST_VALUE` (`x-edu3d-battery: battery`), paired server-side with a loopback-socket check so the battery's own traffic cannot be recorded as 429 build failures.

## Flow

`main()`: resolve `config` via `resolveConfig(process.env)` (dotenv optional, real env wins) → `--dry-run` prints `dryRunRow(config)` (the history row a zero-topic run would write; no request, no spend) and exits → otherwise iterate the 8-topic `BATTERY` list (physics/mechanism, mechanical, electronics, biology, astronomy, mathematics, economics, architecture), `--count N` truncates: for each topic `runTopic` POSTs `{ topic, complexity: 'detailed', tier: 'mid', stream: true }` to `API = 'http://127.0.0.1:8787'` + `/api/generate`, reads the NDJSON stream line-by-line, and on the `ready` event extracts `manifest.cost.parts/triangles`, parameter count, story/quiz lengths, `audit.score`, `provenance.repairPasses/refinementPasses`, and `deriveBindingCount(manifest.parameters[].id, audit.unboundParameterIds)`; an `error` event yields `failureCode/failureMessage`; network failures yield code `network`. Results print as a console table, and are written twice: a full `BatteryReport` to `--out` (default `battery-results.json`) and one `historyRow(PROMPT_VERSION, config.ai.model, summary)` appended to `battery-history.jsonl` for cross-version comparison.

## Integration

- Imports: `PROMPT_VERSION` and the prompt-versioning discipline from `src/services/prompts.ts`; `resolveConfig`/`ServerConfig` from `src/config/config.ts`; `BATTERY_REQUEST_HEADER`/`BATTERY_REQUEST_VALUE` from `src/services/rate-limits.ts`.
- A network client of the running server's `POST /api/generate`, consuming the `GenerationEvent` NDJSON wire format and `ModelBundle`/audit summary fields (`bundle.manifest`, `bundle.provenance`, `audit.unboundParameterIds`); not imported by the server at runtime — its exports exist only for `tests/topic-battery.test.ts` and CI-type evidence.
