# src/

## Responsibility

The contract modules themselves: bounded value primitives every schema composes, the audit's machine-checkable quality vocabulary, the device-tier budget table, and user settings/annotations. Hardened by design — this layer is where the platform's trust boundaries are drawn as numbers.

## Design

- src/primitives.ts is the trust-root every other file imports: `finite` (rejects NaN/±Infinity, which would poison the physics solver), `finiteIn(min,max)`, `AuthoredId` (letter-initial `[A-Za-z0-9_.-]`, 1–64 — these become object keys and DOM ids), `Uuid`, `RequestId`, tuple schemas `Vec2`/`Vec3`/`Quat`, `HexColor` (sRGB textual form, engine converts to linear), `shortText(max)`, `optionalText(max)` (normalizes blank → undefined instead of storing it), `UnitLabel`, `EpochMillis` (ints only; `Date` never crosses a process).
- src/audit.ts defines "good": `AuditDimension` (12 dimensions), `AUDIT_WEIGHTS` (sum to 1; completeness 0.14 > attractiveness 0.05 — teaching consequence dominates aesthetics), `DeficiencySeverity` (blocker/major/minor), `Deficiency` {dimension, severity, finding, instruction, subjectId} where `instruction` is written for the generator that fixes it, `DimensionScore`, `AuditReport`, `REFINEMENT_THRESHOLD = 72`. Deliberately no rejection threshold: the documented floor is ~36, so a planned 35-threshold rule could never fire.
- src/budgets.ts prices builds at admission: `DeviceTier`, `QualityPreset`, `DeviceBudget`, frozen `DEVICE_BUDGETS` (low/mid/high — 150k/600k/2M triangles, 100/400/1500 draw calls, 30/50/58 targetFps), ordered `QUALITY_LADDER` (7 rungs, least damage first; pixelRatio rung 1), `DeviceProfile` (measured facts; `webgl2`/`wasm` false are first-class states), `RuntimeStats` (live measured cost, `effectiveTier` governs over the hint tier; defaulted `cameraDistance`/`degradedRungs` for wire-version tolerance).
- src/settings.ts: `UserSettings` (theme, nullable `quality` override — user choice beats the optimizer, `timeScale`, `chatPersona`, camera, diagnostics, `writeToken`) with all defaults; storage keys `SETTINGS_STORAGE_KEY`/`THEME_STORAGE_KEY`/`ANNOTATIONS_STORAGE_PREFIX`; `Annotation` (capped world-pinned notes). Documented asymmetry: only `quality` is wired end-to-end so far; other fields are specified, not honored.

## Flow

Leaf modules import `primitives.ts` (and each other minimally: audit.ts takes `shortText`; settings.ts takes `QualityPreset` from budgets.ts and `ChatPersona` from wire/api.ts). src/index.ts re-exports everything; no logic runs here beyond zod construction and frozen tables.

## Integration

- Consumes: only `zod` (and, transitively, nothing of ours).
- Consumed by: `manifest/*` and `wire/*` (see src/manifest/codemap.md, src/wire/codemap.md) plus the barrel src/index.ts.
- `DeviceBudget`/`QUALITY_LADDER` are read by the engine's admission ladder and the worker's RuntimeStats reporting (packages/engine/codemap.md, packages/sandbox/codemap.md); `AuditReport`/`REFINEMENT_THRESHOLD` drive the server pipeline's refine-or-accept decision (apps/server/codemap.md); `UserSettings`/`Annotation` shape the web settings store and viewer (apps/web/codemap.md).
