# scripts/

## Responsibility

The repo's enforcement layer: the single `pnpm verify` gate (`verify.mjs`) plus the three exit-code
checkers it runs first — `check-secrets.mjs`, `check-config.mjs`, `check-compositor.mjs` — and the
build-time compression tool `precompress.mjs`.

## Design

- `verify.mjs` models the gate as a linear scan of a `STEPS` array, each step `{id, label, command,
requires?}`; `requires` (used only by the `e2e` step for `playwright.config.ts`) makes a step whose
  tooling is absent record status `skipped` — SKIP, never PASS. Commands run via `run()`
  (`verify.mjs:run`), a `spawn` with `shell: false`, `stdio: 'inherit'`, `cwd: ROOT`; exit code
  `0` = pass, nonzero = fail, spawn `error` resolves `127`. `process.argv[2]` names a single step to
  run in isolation.
- Checkers prove PASS by printing a success line and exiting 0; FAIL by listing every finding to
  stderr and `process.exit(1)`. `check-secrets.mjs` exports `scan(root)` (CLI runs only under
  `isEntryPoint()`, so vitest can import it safely) with signature-based `SIGNATURES` (provider-
  shaped patterns: OpenAI/Anthropic/AWS/GitHub/Slack/Stripe, private-key blocks, Postgres URLs,
  quoted credential assignments), line-scoped `ALLOW_MARKER = 'secret-scan-ok'`, and name-based
  `SECRET_ENV_FILES` (`.env`, `deploy.env`) whose _presence_ is the finding unless
  `isGitProtected()` proves via git (`check-ignore` + `ls-files --error-unmatch`) that the path is
  ignored AND untracked; unconfirmable (no repo) stays a finding. Matched text is echoed redacted.
- `check-config.mjs` is the build-time half of the server's exhaustive startup refusals: a `VARIABLES`
  table (scope `both|production`, `secret` flags) asserts each var is documented in
  `apps/server/.env.example` / `.env.production.example`, unknown assignments yield non-fatal
  `notes`, and a non-empty value for a `secret` var is a problem.
- `check-compositor.mjs` is a CSS linter for per-frame compositor cost; exports
  `readStylesheets()`, `findCompositorOffenders(sheets)`, `CANVAS_OVERLAY_CLASSES`, and
  `KNOWN_OFFENDERS` (accepted-cost allow-list; outsourced to the runtime e2e for `.ambient-blob`).
  Two mechanisms: animated `filter: blur(≥20px)` attributed across class composition, and
  `backdrop-filter: blur(≥5px)` on canvas overlays; lookbehind avoids matching `backdrop-filter`.
- `precompress.mjs` exports `DEFAULT_TARGET` (`apps/web/build`), `COMPRESSIBLE_EXTENSIONS`,
  `shouldCompress`, `compressFile`, `precompressTree`; writes `<file>.br`/`.gz` pairs beside each
  original (brotli q11/gzip 9 at ≤256KB, lower for big files).

## Flow

`node scripts/verify.mjs [step]` iterates `STEPS` in a fixed cheapest–security-critical-first order:
secrets → config → compositor → format → lint → typecheck → unit/integration → build → e2e. Each
step is spawned synchronously in sequence; a `requires` path checked by `exists()` short-circuits to
SKIP. Any nonzero exit breaks the loop (first further steps' shared root cause would be noise),
then a PASS/SKIP/FAIL summary prints and the process exits 1 on failure, else "verify passed".
`precompress.mjs` runs separately in `apps/web`'s build, or standalone with an optional directory.

## Integration

- Root `package.json`: `verify` → `node scripts/verify.mjs`, plus convenience `check:secrets` /
  `check:config`; `typecheck` includes `tsc -p scripts/tsconfig.json` (`allowJs`, noEmit — it
  typechecks the `*.test.ts` importing these `.mjs` modules, not the modules themselves).
- `apps/web/package.json`: `build` = `vite build && node ../../scripts/precompress.mjs`.
- Repo contracts asserted: `.env`/`deploy.env` never tracked (`.gitignore` names `deploy.env`;
  `deploy.env.example` is the committed template, exempt); every platform env var documented in the
  two committed example files with empty secrets; no animated large blur or canvas-covering backdrop
  blur unaccounted in `apps/web/src/lib/styles/*.css`; textual build assets shipped with `.br`/`.gz`
  pairs the Hono server serves. Reads `apps/web/src/lib/styles`, `apps/server` env examples, and
  root git state; the three `*.test.ts` here run under the vitest `unit` step.
