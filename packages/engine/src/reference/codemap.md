# packages/engine/src/reference/

## Responsibility

Hand-authored reference model sources: the on-disk fallback model the viewer loads without an AI key, the few-shot exemplars the generation prompt is built from, and the fixtures the engine's own test suites run. Exported as raw _source strings_, so they travel through the identical boundary as generated code — gate, instrumentation, sandbox — which a callable fixture would bypass and thereby prove nothing.

## Design

- `turbofan.ts:REFERENCE_MODEL_SOURCE` (~740 lines) — a two-spool turbofan chosen to force the whole surface at once: swept airfoils, involute `geom.gear` in the accessory drive, a true helical `geom.helix` spring, an instanced blade array (`geom.pattern.radial` + `scene.instances`, one draw call), an SDF-blended nacelle fairing (`geom.field.*` → `geom.sdf`), a raw `geom.mesh`, parameter-bound motions, published metrics, story and quiz. Its header lists the four load-bearing roles (API usability proof, fallback model, few-shot exemplar, realizer/physics/audit fixture). Its `simplifications` declare the blade-count reduction and, crucially, that part motion is animated on a driven schedule rather than simulated — the same words the audit's physics-honesty rule asks a depicting model to use, which is why an honest animation is never flagged and the exemplar stays unflagged.
- `turbofan.ts:MINIMAL_MODEL_SOURCE` — a simple pendulum: the smallest legal manifest for failure-path and cross-host determinism tests.
- `watch.ts:WATCH_MODEL_SOURCE` (~860 lines) — a mechanical watch movement built on a checkable causal chain (timing-screw inertia → balance frequency → rate) with the escapement's stepping as an emergent, not keyframed, signature; its `scene.describe` `simplifications` declare the magnitude exaggeration honestly.
- Both are `String.raw` template literals with no imports — pure data, DOM-free, cheap to ship inside prompts.

## Flow

Source string → `@edu3d/sandbox` `prepareProgram` (static gate + loop instrumentation against `apiSurfaceSet()`) → `authorModel` (browser guest path) or `authorInNodeVm` (server `node:vm` path; the host-admission test asserts both produce the same manifest) → `ModelManifest` for audit pricing, realization or replay.

## Integration

Re-exported through `src/index.ts` (`WATCH_MODEL_SOURCE`, `REFERENCE_MODEL_SOURCE`, `MINIMAL_MODEL_SOURCE`) — no subpath export. Consumers: `apps/server/src/services/prompts.ts` (`REFERENCE_MODEL_SOURCE` as the prompt's few-shot exemplar), `apps/server` tests (`prompts`, `audit`, `pipeline`), and engine tests (`tests/authoring.test.ts`, `tests/host-admission.test.ts`, `tests/api-reference.test.ts` scaffold examples, `tests/frame-cost.test.ts`, `tests/realize-decimate.test.ts`). Depends on nothing but the guest API's own documented surface — which is the point: every call in these files is something a generated model may call.
