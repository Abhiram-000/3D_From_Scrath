# math/

## Responsibility

The pure, deterministic math namespace exported to guest code as `M`: scalars, easing, vector/matrix algebra, deterministic noise/random — everything a model doing real geometry needs, so it never reinvents it badly or reaches for a capability the sandbox denies. Also the shared numeric vocabulary the geometry layer itself is written against.

## Design

- **Function-first, plain tuples** — `math/index.ts:Vec3`/`Vec2` are `[number, n...]` arrays, never a class: `08` bans per-frame allocation, and method chaining would allocate an intermediate per op. Ops are free functions (`add`, `sub`, `mul`, `dot`, `cross`, `length`, `distance`, `normalize`, `lerpVec`); `normalize` returns the zero vector rather than NaN; `rotateAxis` is Rodrigues; `spherical`/`fibonacciSphere` (golden-angle, anti-pole-clustering)/`phyllotaxis` are the distribution helpers.
- **Mat4 is column-major `[number, ×16]` matching Three.js** so nothing converts at the boundary; `compose(translation, rotation, scale)` builds XYZ Euler applied as Rz·Ry·Rx (same convention as Three.js and `modifiers.transform`), `multiply`, `identity`, and `orient(direction, up)` which maps +Z onto a direction with an alternate reference axis when they're near-parallel — the branch that stops a straight-up sweep emitting NaN.
- **Constants & scalar kit** — `TAU`, `HALF_PI`, `GOLDEN_ANGLE`, `GRAVITY` (same constant physics defaults to), `DEG`/`RAD`, `deg`, `rad`, `clamp/saturate`, `lerp`, `unlerp` (0 on degenerate range), `remap`, `smoothstep`/`smootherstep` (quintic, zero 1st and 2nd derivative), ease family (`easeIn/Out/InOut/Back`), `wrap` (correct for negatives), `angleDelta` (shortest signed rotation), `sign` (0 for 0), `len2/len3` (no varargs allocation).
- **Elementary re-exports bound to `Math` itself** (`sin`...`cbrt`, `E`, `SQRT2`): redundant in principle but they make `M.sin` the correct spelling for free with zero call overhead.
- **Deterministic noise/random by contract** — `hash1/2/3` (sin-based fract hash to [0,1)), `noise3` (value noise, smootherstep interpolation), `fbm` (normalised octaves); `createRandom(seed)` is mulberry32 with `float/range/int/pick/unitVector` (bias-free sphere sampling), seeded by the host so the same manifest rebuilds byte-identically (`02` R4; `08` memory tests depend on this). Guest has no unseeded `Math.random`.

## Flow

There is no data flow through this folder — it is a leaf. Functions are called either by guest code (spelled `M.*` in the sandbox) or internally by engine code: the whole geometry folder imports it (`geometry/*.ts:TAU, clamp, lerp, fbm, smootherstep, normalize, cross, GOLDEN_ANGLE`, `factory.ts:Vec3` type), and `patterns.ts:scatter` takes a host-seeded `random: () => number` produced from `math/index.ts:createRandom` in `guest.ts`/`node-host.ts`.

## Integration

- Depends on: nothing — pure JS, Node-safe, no `three`, no contracts import. The only engine folder with zero outbound coupling, which is why it is the shared leaf at the bottom of the one-way dependency graph.
- Consumed by: `authoring/guest.ts` and `hosts/node-host.ts` (mount it into the sandbox as a frozen `M: Object.freeze({ ...M })` plus `createRandom(options.seed)`); `authoring/api-surface.ts` (`collect('M', M)` makes it the one namespace whose surface is the raw exports rather than a facade); `authoring/api-reference.ts` documents it symbol-by-symbol (`M.createRandom`, …); every `geometry/*.ts` file; `materials/factory.ts` and `authoring/scene.ts` (`clamp`). The one cross-package rule: `GRAVITY = 9.80665` is documented as the same constant the physics layer defaults to (`02` R2), so a manifest and its simulation never disagree.
- Skim evidence: `tests/geometry.test.ts` exercises `fbm` (displace), `smootherstep` (wave envelope, morph easing), `TAU` (radial arrays) indirectly via geometry behaviour tests rather than direct unit tests.
