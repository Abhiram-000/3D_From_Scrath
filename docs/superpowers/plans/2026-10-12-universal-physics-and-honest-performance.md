# Plan — Universal Physics + Honest Performance

Derived from a full gap audit of `Build_Docs/02-PHYSICS.md` and `08-PERFORMANCE-AND-DEVICES.md`
against the implementation. Spec is binding; this is the argument from it.

## The thesis

**Physics must work for any geometry an AI generates, without the AI having to know physics.**
A model that has never seen a collider declaration must still fall, stack, roll and collide
correctly. That makes collider _inference_ from measured geometry a first-class concern rather
than an optimisation — and it is the only way `02-PHYSICS.md`'s promise is keepable at scale.

## The decisive finding

`apps/web/src/lib/engine/physics-world.ts:214-246` derives every collider from authored literals
times `part.transform.scale[0]`, defaulting to a **hardcoded 0.5 m sphere**. The word "geometry"
appears in that file only in comments. Two facts already exist and are unused by physics:

- `PartNode.geometry.builder` — the name of the constructor that made the shape
  (`packages/contracts/src/manifest/parts.ts:66,88`). **The audit already reads it**
  (`apps/server/src/services/audit.ts:263-271`).
- `PartNode.geometry.boundingRadius` — measured at authoring time
  (`packages/engine/src/geometry/factory.ts:305`), already consumed by the camera auto-framer
  (`packages/engine/src/authoring/scene.ts:1588`).

So the mapping is a table over data already shipped.

---

## Phase P1 — Make physics real for any model

### P1.1 Faithful colliders by construction, not declaration ← the load-bearing fix

- Build `builderColliders`: `cylinder → cylinder(r,h)`, `sphere/ball → ball`,
  `box/cube → cuboid`, `cone → cone`, `capsule → capsule`, `pipe/tube → cylinder` (its annulus is a
  tube), `gear/wheel/cog → cylinder` (the hub is what collides), `helix/torus → ball(r)`,
  `revolve/lathe/extrude/sweep/loft/patch → convex hull of the mesh`.
- Every fallback derives from the **actual vertex data**, never a constant: read
  `geometry.boundingRadius` for the default radius, and compute a convex hull from positions where
  the builder is unknown (`mesh`, `boolean`, `sdf`, `parametric`, `heightField`, `waveSurface`).
- Non-uniform scale: use each axis, not `scale[0]` (`physics-world.ts:160`).
- Authored rotation reaches the body (`physics-world.ts:134-139` currently drops it).
- **Test:** for every builder the engine can emit, a part built that way collides as a shape of the
  right proportions — measured, not asserted by construction.

### P1.2 Correctness fixes that make any simulation a lie today

| Fix                                                                                         | Location                                            |
| ------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| Rotation in **radians**, all three axes, correct euler order                                | `physics-world.ts:391` — reuse `motions.ts:204-221` |
| Quarantine checks **all** quaternion components and restores rotation, not just translation | `physics-world.ts:369-385`                          |
| Authored rotation/quaternion applied to the body                                            | `physics-world.ts:134-139`                          |
| Dangling `bodyB` must **fail loudly**, not re-anchor to the world                           | `physics-world.ts:252,291`                          |

### P1.3 Validate the declaration at the boundary

`scene.ts:1397-1399` stores `scene.physics(spec)` verbatim. Run `PhysicsDecl.parse` there so NaN
gravity, negative density, zero extent and absurd body counts never reach the solver. One line
closes the entire input-validation half of `02-PHYSICS.md`.

### P1.4 The kinematic bridge — "moving machinery must actually push things"

Three breaks: no velocity is ever set on a kinematic body; the sync loop `continue`s past every
non-dynamic body; nothing routes `scene.motion` / `onFrame` transforms into the solver. Fix by
driving `setNextKinematicTranslation`/`Rotation` from the live part transform each step, so an
animated conveyor genuinely carries the crates.

### P1.5 Make it reachable at all

- Add `scene.physics(...)` to a reference model so the status bar can say `On` and CI exercises the
  path. The pendulum (`MINIMAL_MODEL_SOURCE`) is the honest fixture: `02-PHYSICS.md:108` asks for
  "a pendulum's period plausible for its length and gravity."
- **Enable `apps/*/src/**/*.test.ts` in `vitest.config.ts`** and add a `test` script to
  `apps/web/package.json` — without this, `physics-world.ts` cannot be tested by CI at all. This is
  the single change that makes every other physics fix permanent.
- Write the honesty suite `02-PHYSICS.md:104-110` asserts: `s = ½gt²` and `v = gt` within tolerance,
  momentum conserved across impulses, density-derived mass scaling with volume, pendulum period
  plausible, degenerate input rejected before the solver.

### P1.6 Disposal that is actually idempotent

`dispose()` claims idempotent and failure-tolerant; it is neither (no guard, no `try`). And
`disposeAll` never nulls `target.builder`, so a teardown during load **leaks a WASM world**
(`sandbox-worker.ts:644, 1119-1133`).

### P1.7 Interaction (`02-PHYSICS.md:114-124`)

Pick (BVH), grab with kinematic override, release with velocity handoff, impulse, time-scale, and
live mass/friction/restitution/damping retargeting — all feeding the undo history. `wakeAll()`
currently wakes every body about a change that cannot arrive, because no parameter binding exists.

---

## Phase P2 — Performance that is honest, then fast

Order matters: **fix what lies to the user before adding capability.**

### P2.1 Stop lying ← first, because `08-PERFORMANCE.md:61`

- **X-ray leak**: restore `transparent`/`opacity` on exit (`sandbox-worker.ts:716-728`). One click
  currently costs every device a permanent 2–4× fragment cost and a permanently translucent model.
- **`flatShading` rung** flips no flag (`sandbox-worker.ts:1029-1033`). Either implement it or delete
  the rung and its notice.
- **`postProcessing` rung** is a disguised second pixel-ratio step, and its notice claims MSAA is off
  while it is on (`sandbox-worker.ts:1015-1024, 1051`). Fix the notice to match reality.
- Remove notices for the three rungs that do nothing rather than claiming they did.

### P2.2 WebGL context loss

Listen for `webglcontextlost` / `webglcontextrestored`, rebuild the scene, keep the model
(`08:144`). Today: permanent black canvas on a memory-pressured phone, silently.

### P2.3 Admission before allocation

Pricing runs at `sandbox-worker.ts:554`, **after** `compiled.run()` at `:540` built every buffer.
`08:42`: "a budget breach is never discovered as a stutter; it is prevented as a number." Price from
the declaration and refuse before building.

### P2.4 Hot-path discipline

- Hoist the frame context and `PartRef` objects — `createFrameContext` allocates ~9 objects plus 9
  closures **per part per frame** (`scene.ts:547-635`); the reference model alone allocates ~55
  closures per frame.
- `three-mesh-bvh` for picking (`vite.config.ts:39` already has the chunk rule; the dependency is
  missing).
- Dirty-flag propagation so a parameter at rest costs nothing.
- Reuse probe buffers; `PhysicsWorld.step` allocates ~`3 + 6N` objects per step.

### P2.5 Device tiers must be fluid

`effectiveTier` is `readonly` — a throttled laptop stays `high` forever, holding 2M/1500/4-shadow
budgets while running at LOW speed (`08:19`). Re-tier from live frame time and **re-price**.

### P2.6 Disposition of dead capabilities

Merged static geometry is priced at admission (`admission.ts:266-285`) but `realize.ts` never
merges — a model is admitted on a merge that does not happen. Either merge or stop pretending.
Same for `physicsSubsteps` (announces a reduction that `PhysicsWorld` ignores) and LOD (absent).

---

## Execution order

P1.5's test wiring first — it is one config line and it is what makes the rest stick.
Then P1.1 → P1.2 → P1.3 → P1.5 (reference model + honesty suite) → P1.6 → P1.4 → P1.7.
Then P2.1 (the lies) → P2.2 → P2.4 → P2.3 → P2.5.

Every item ships with a test that demonstrably fails against the current code.
