# materials/

## Responsibility

The `mat` namespace guest code calls: a deliberately small, semantic material vocabulary (11 capped archetypes) that turns a builder choice into physical defaults, an sRGB colour or declared colour role, and (optionally) a live parameter binding — then hands opaque frozen handles to the AI and typed `MaterialRef`s to the manifest/realizer.

## Design

- **Factory + opaque handle (mirrors geometry)** — `factory.ts:MaterialHandle` is frozen and branded (`__brand: 'material'`, archetype, cacheKey, optional role); data lives in a private `Map<string, MaterialRef>` cache plus a `WeakMap` byHandle; `resolve()` is host-only. Errors are `MaterialError`, a class-field `name` so it survives frozen `Error.prototype` after realm hardening (same trick as `GeometryError`).
- **Table-driven defaults** — `ARCHETYPE_DEFAULTS` gives every archetype its physically plausible PBR set (metal `metalness 1/roughness 0.28`, matte `0/0.9`, glass `transmission 0.92` rather than fake transparency, translucent opacity 0.45, emissive `intensity 2.5`); `ARCHETYPE_COLORS` prevents a colourless material rendering black ("a black part reads as a hole").
- **Validation at the boundary** — `factory.ts:requireColor` accepts only sRGB hex `#rgb`/`#rrggbb` (authored stays textual; conversion to linear happens in exactly one place downstream per `01`); `optionalNumber` clamps into range (metalness/roughness/opacity/transmission 0–1, emissiveIntensity 0–64).
- **Structural dedup** — private `MaterialFactory.make` builds the pipe-joined `cacheKey` from _every_ rendering-relevant field (archetype, color, role, metalness, roughness, opacity, transmission, emissiveIntensity, procedural, boundToParameter, doubleSided, flat, emissive) so two materials that differ only in a bound parameter stay distinct; identical calls share one handle and, later, one GPU material (300-part assemblies average ~6 materials — dedup avoids per-frame shader state thrash).
- **Colour roles** — `declareRole({id, label, color, meaning})` fills a role table that `make` resolves in place of a literal colour (undeclared role → `MaterialError` telling the model to call `scene.colorRole(...)` first); `declaredRoles()` returns declaration order for the legend; re-declaration replaces and warns.
- **Behavioural option defaults baked in the facade** — `glass`/`translucent`/`fluid` force `doubleSided: true` by option order (`{ doubleSided: true, ...options }`, so an explicit false still wins), `toon` forces `flat: true`. Named per archetype, not `mat.create({archetype})`, because the name is the semantic cue the audit reads.
- `contrastRatio(a, b)` computes WCAG relative luminance (proper sRGB→linear transfer) for the audit's adjacency check — machinery, not rendering.

## Flow

1. Guest build code calls e.g. `mat.metal({ color: '#806b56' })` on the facade from `factory.ts:createFacade()`.
2. `make(archetype, options)` resolves colour (role declaration > literal > archetype fallback), clamps/defaults the five physical fields, assembles a `MaterialRef` (`boundToParameter` set from `boundTo`), keys, dedups, and returns a frozen `MaterialHandle` — cache stats at `get stats()` (`{unique, roles}`), `entries()` for one creation each in the realizer.
3. A role comes in first via `declareRole` (called from the scene facade); `mat.roleColor(id)` lets non-material consumers share the same colour.
4. Output: the `MaterialRef` record travels in the manifest part (`PartNode.material`); `boundToParameter` marks brightness-is-the-measurement bindings for audit.

## Integration

- Depends on: `@edu3d/contracts` (`MaterialArchetype` enum, `HexColor`, `MaterialRef` — the manifest type this factory produces verbatim) and `../math/index.ts` (`clamp`).
- Consumed by: `authoring/api-surface.ts` (`collect('mat', materials.createFacade())` — also evidence for the static gate/prompt); `authoring/scene.ts` (owns the `MaterialFactory` instance, imports `MaterialHandle`); `runtime/realize.ts:resolveMaterial` keys three materials by `ref.cacheKey` (suffixed `#flat` when quality decisions force flat shading); `hosts/node-host.ts` and `authoring/guest.ts` catch `MaterialError`; `index.ts` re-exports `factory.ts` symbols.
- Note: the `MaterialOptions.emissive` colour is validated and folded into the cache key but is not carried in `MaterialRef` (contracts field does not exist for it).
