# src/manifest/

## Responsibility

The six modules that define the `ModelManifest` — the complete, serialisable description the AI's program produces from its authoring pass, and the shape that crosses every boundary in the platform (sandbox → host, server → client, database row → viewer).

## Design

- src/model.ts composes the whole: `ModelManifest` (`formatVersion` literal 1; `Pedagogy` — concept/objectives/principles/declared `simplifications`/`relationships`; `BuildCost` measured before any GPU allocation incl. `instancedSets`; `CallbackRegistry` — ids of `hasFrame`/`hasParameterChange`/`interactionHandlers`/`metricComputers`, since closures stay in the sandbox and are referenced by id), `Domain` (14 values incl. deliberately non-failing `other`), and `ModelBundle` {manifest, code (≤1.5 MB), runtime? (≤2 MB, loop-guard-instrumented), rawOutput?, provenance?} — `runtime`/`code` travel separately so diagnostics can show what ran while learners read clean code.
- zod 4 idiom used repeatedly: `prefault({})` not `default` for nested decls (`environment`, `camera.limits`, `callbacks`, `physics.world`) so nested field defaults apply through the schema at every call site.
- src/parts.ts: open on geometry, closed on semantics. `PartKind` (8 incl. `instances`/`label`), `MaterialArchetype` (11, capped — restraint is the feature), `GeometryBuilderName` is a bounded _identifier_, not an enum (a closed geometry enum would reintroduce the LEGO limit; builder-name truth lives in the engine's API surface checked by the static gate). `GeometryRef` carries `cacheKey` (structural dedup) and authoring-time `triangles`; `MaterialRef` adds semantic fields (`boundToParameter`, `procedural`); `PartNode` uses flat `parentId` + `PartTree` array (parent-first, bounded, stack-safe against hostile nesting) with `selectable`/`hero`/`staticGeometry`/`explodeOffset`/`lod` flags. Ceilings: `MAX_PARTS` 20000, `MAX_INSTANCES_PER_SET` 40000, `MAX_POINTS_PER_CLOUD` 200000.
- src/parameters.ts: `ParameterDecl` discriminated union on `kind` (number/boolean/color/choice); `affects: {partId?, channel}` of `ParameterChannel` (8 channels) is the _claim_ the audit's dry-run sweep verifies; `ParameterValues` is the live record; `MetricDecl` with `source: 'model' | 'physics'`.
- src/presentation.ts: `CameraPose` (framing on load is authored), `CameraLimits`, composable `ShotDecl`/`ShotKind` (nine kinds — orbit _while_ dolly = spiral), `ShotEasing`, `LightDecl`/`LightKind` (augment a base rig; `castShadow` requested-not-granted, tier-downgraded), named-preset `EnvironmentDecl` (no asset URLs — sandbox has no network), `ColorRole` legend.
- src/physics.ts (SI units): mass derives from `PhysicsMaterialDecl` density by default; explicit `BodyDecl.mass` is the override exception. `ColliderShape: 'auto'` derives from render geometry (`02` R3 fidelity); `BodyKind` includes the `kinematic` animated-collider bridge; `JointDecl` (six kinds, `bodyB: null` anchors to world, retargetable `motor`); `PhysicsWorldDecl` fixes deterministic timing (`stepHz` 120, `seed`, `timeScale`); `PhysicsProbeDecl` surfaces solver measurements.
- src/behavior.ts: `ScalarSource` union (const/param/signal/probe) is what makes declared motion auditable (`bind('speed')` vs opaque closures). Key subtlety: `ScalarSourceInput = z.input<typeof ScalarSource>` and `MotionDeclInput` — the builder captures declarations verbatim and the load path never round-trips zod, so consumers must default `scale`/`offset` themselves (`value * undefined` is the NaN they exist to avoid). Also `MotionKind` (8), `PathDecl` (2–4096 points), `InteractionDecl` (7 kinds, `handlerId` → sandbox callback for `custom`), `StoryBeat` (narration/shots/`setParameters`/`viewMode`), authored-first `QuizQuestion` (`correctIndex`, `evidencePartId`).

## Flow

The AI program runs once against the authoring API in the guest realm and accumulates these declarations (e.g. `scene.motion()` captured verbatim); the host receives a `wire/sandbox.ts` `built` response whose `manifest` field validates against `ModelManifest` once at that boundary. Downstream, the server audits/prices the manifest with no browser (audit.ts + `DeviceBudget.vs BuildCost`), and the engine realizes it with atomic swap-on-failure.

## Integration

- Depends only on `../primitives.ts` (see src/codemap.md); consumed by `../wire/*` (`ModelManifest` in sandbox messages; `ModelBundle` in api.ts/generation.ts) and re-exported by src/index.ts.
- Consumers with their own maps: packages/sandbox/codemap.md (guest build + gate feeding manifest), packages/engine/codemap.md (realization), apps/server/codemap.md (generation pipeline, audit, persist), apps/web/src/lib/engine/codemap.md viewing path (apps/web/codemap.md).
