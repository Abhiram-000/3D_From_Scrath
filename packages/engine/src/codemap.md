# packages/engine/src/

## Responsibility

The package barrel (`index.ts`): the single public surface of `@edu3d/engine`. Declares what consumers may import and freezes the DOM-free invariant — nothing exported touches `document`, `window`, a canvas, or renders on the server.

## Design

- Public surface by module: geometry (`MeshData`/`Bounds`/`validateMesh`/`mergeMeshes`/`sanitizeMesh` from `geometry/mesh-data.ts`, the `primitives`/`solids`/`implicit`/`modifiers`/`profiles`/`patterns` namespaces, `triangulateProfile`, `decimate`, `GeometryFactory`/`GeometryError`/handles from `geometry/factory.ts`); materials (`MaterialFactory`, `MaterialError`, `contrastRatio`); authoring (`SceneBuilder`, `SceneError`, `ComponentContext`, `FrameContext`, `PartRef`, `SweepPoint`, `apiSurface`/`apiSurfaceSet`/`buildApiSurface`/`describeApiSurface`, `API_REFERENCE`); guest (`authorModel`, `runFrame`, `AuthorOptions`/`AuthorResult`/`GuestLogEntry`); runtime (`priceModel`/`remainingRungs`/`summarizeCost` + `RealizationDecisions`, `realize`/`RealizedModel`, `applyMotions`/`resolveScalar` + `MotionHost`/`ScalarContext`); `WATCH_MODEL_SOURCE`, `REFERENCE_MODEL_SOURCE`, `MINIMAL_MODEL_SOURCE`; and `export * as M` from `math/index.ts`.
- `geometry/`, `materials/` and `math/` are documented by their own codemap lane; `authoring/`, `runtime/`, `hosts/` and `reference/` here.
- The `node:vm` host is deliberately **not** re-exported here (`index.ts:86-95`): a barrel that reaches `src/hosts/node-host.ts` imports `node:vm`, which poisons every browser bundle in dev (Vite externalises it and the worker dies before the first frame). Consumers import the host via the `@edu3d/engine/node-host` subpath.

## Flow

Two entry paths share one barrel: the server imports only data producers (`authorModel`/`authorInNodeVm`, `apiSurface*`, `API_REFERENCE`, reference sources) to harvest and price a `ModelManifest` without rendering a pixel; the browser worker (`apps/web/src/lib/engine/sandbox-worker.ts`) additionally imports the realization/motion side (`priceModel`, `realize`, `applyMotions`, `SceneBuilder`, error classes, `M`).

## Integration

- Depends on `@edu3d/contracts` (manifest/budget wire types), `@edu3d/sandbox` (host containment), `three` (only inside `runtime/realize.ts`).
- Consumed by `apps/web/src/lib/engine/sandbox-worker.ts`, `apps/web/src/lib/engine/frame-compose.ts` (`PartTransformLike`), `apps/web/src/lib/engine/physics-world.test.ts`, `apps/server/src/services/prompts.ts` (`describeApiSurface`, `REFERENCE_MODEL_SOURCE`), `apps/server/src/services/pipeline.ts` (`apiSurface`), and engine/sub-package tests.
