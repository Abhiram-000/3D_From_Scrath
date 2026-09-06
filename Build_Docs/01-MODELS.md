# BUILD DOC 01 — MODELS: GEOMETRY, MATERIALS, COLOR

> Read `00-GOAL.md` first. This document defines _what makes a model good_ — the qualities of geometry, physics usage, material and color choices — as requirements with reasoning, so you design your own vocabulary and selection logic. It deliberately does not hand you a shape catalog; a catalog gets copied, requirements get _thought about_. Where a concrete rule is stated, it is stated because violating it visibly breaks the lesson.

## Mission

A model is a **teaching argument expressed in 3D**. Every shape, every material, every color, every motion either carries the argument or dilutes it. The measure of a model is not how it looks in a screenshot — it is what a learner understands after playing with it for five minutes that they did not understand before.

That standard drives everything below.

## The three qualities — all three, or it isn't done

Every generated model must be simultaneously:

**1. Clean.** Visual silence around the signal. A clean model has a clear focal hierarchy (one hero, supporting structure that recedes), no visual noise (no floating clutter, no decorative blobs, no competing colors), no overlap where parts hide the lesson, consistent materials and spacing. Cleanliness is what makes a model _legible at first glance_ — the learner's eye lands on the concept within one second of the model appearing, because nothing else is shouting.

**2. Visually attractive.** The model must earn attention it didn't have. Beautiful lighting and materials, deliberate composition, satisfying motion, moments of delight (a cutaway revealing glowing internals, particles streaming along a lit path, a mechanism that visibly works). Attractive is not "photorealistic" — it is _crafted_: every element placed with intent, nothing accidental. A model that is correct but ugly loses the learner before it can teach; a model that is pretty but wrong is worse. **Attract with the truth.**

**3. Information-dense in the right way.** Every part teaches: names, info text and tooltips on everything selectable; parameters with visible consequences; formulas that agree with motion; a story that walks the concept; color roles that encode meaning. But density is _organized_, not piled — information layered by depth (glance → hover → select → story) so the learner chooses how deep to go. The test: a learner can spend ten minutes with the model and keep discovering things worth knowing, and none of those things is noise.

**The tension is deliberate and resolvable**: cleanliness argues for fewer elements, information argues for more. The resolution is _hierarchy_ — few things prominent, many things discoverable, everything meaningful. When in doubt, remove the thing that is neither the hero nor a hidden discoverable.

The first-frame test: a stranger sees the model for three seconds. They should think _"ooh"_ (attractive), immediately see _what_ it is (clean), and want to touch it (inviting). Five minutes later they should still be learning (information). Design for all three seconds and all five minutes.

## The model as a designed whole

A model is not a pile of parts. It is designed top-down, and the order matters:

1. **Concept** — the one idea the model exists to teach
2. **Entities** — every physical or conceptual thing the idea requires: source, mechanism, boundary, carrier, output, return path. _Omit none the phenomenon requires; add none that does not teach_
3. **Relationships** — what connects to what, which way causality flows, what exchanges what
4. **Representation** — for each entity: what shape, what material, what color, what motion
5. **Composition** — spatial arrangement, hierarchy, camera framing, lighting, controls

When a model feels wrong, diagnose it against this order. A beautiful part floating unconnected (step 4 done before step 3) is the classic failure: a battery sitting far from the circuit it powers teaches disconnection instead of circuitry.

## Shape and geometry selection

### The representation principle

**Choose the shape whose _behavior_ matches the concept's behavior, not the shape whose static outline looks similar.**

The test is motion: if the concept involves rotation, transmission, flow, oscillation or growth, the shape must be one whose geometry makes that motion _correct_ — because the moment the model moves, approximation is exposed:

- A gear must be an involute profile, not trapezoid teeth — trapezoids mesh visually in a still frame and visibly _slip and jerk_ the moment the gear train turns, which is exactly when a learner is watching
- A spring must be a true helical sweep, not stacked cylinders — stacked cylinders cannot compress; a spring the learner cannot compress is a picture of a spring
- A flow must be particles traveling an authored path or a tube with animated contents, not static dots scattered in a volume — scattered dots teach noise, not flow
- A wave must be a surface whose vertices follow the wave function, not a curved still shape wiggling — a sinusoid that "vibrates" without its crest _traveling_ teaches nothing about propagation

State this rule in your generation prompts. Enforce it in your audit: a model whose moving parts are static-shape lookalikes is deficient and should be flagged for refinement.

### Proportion, scale and exaggeration

- **Real proportions when reality is the lesson**: anatomy, planetary scale, a gear train's ratio — the _relationships between sizes_ carry the science
- **Deliberate exaggeration when reality is unreadable**: an atom enlarged to classroom scale, a greenhouse effect with visible infrared arrows, a 10:1-slowed molecular collision. Exaggeration is fine — but declare it in the model's own info text, so the learner knows they are looking at an analogy, not a scale model
- **Never accidental scale**: a model where the heart is bigger than the body because nobody checked relative sizes teaches falsehood. Cross-entity proportion is part of correctness

### Detail economics

Detail is a budget, spent where teaching happens:

- **Hero parts** (the two or three components the lesson is about) get real geometry: correct segments, smooth curves, believable proportions
- **Supporting structure** (the housing, the frame, the background) gets simple shapes at low counts — it exists to _locate_ the hero, not to compete with it
- **Repetition must be cheap**: define a part once, place it many times. A turbine with 38 identical blades authored 38 times is a token-budget failure; authored once and instanced 38 times, it is an engineering success. Your vocabulary must make this the _easy_ path
- **Never spend triangles where motion, spacing, color or material would teach more.** A gear's teachable content is in its motion; 100k vertices on its rim teach nothing that 2k vertices plus correct involute motion don't

### Structure and hierarchy

- Group by _function_ (intake stage, combustor, exhaust), not by geometry type — the hierarchy should read as the machine's block diagram, so selecting a group selects a concept
- Every part carries its meaning: name, info text, tooltip. A part the learner can select but that says nothing is a wasted click
- Where the lesson is _inside_ something, plan the view path at design time: transparent shell, cutaway, section, or explode — never leave the only teaching part permanently invisible

## Physics usage selection

**Physics is a tool the model chooses, not a mode every model gets.** The selection rule:

- **Use real simulation when the _consequence_ is the lesson**: a collision's momentum transfer, a pendulum's period, a stack's collapse, an orbit's stability. When the learner should _feel_ inertia, weight or energy, simulation is the only honest way
- **Use authored animation when the _mechanism_ is the lesson**: electrons orbiting, current flowing, a four-stroke cycle — these are demonstrations of structure and sequence, and declarative motion shows them more clearly than a solver would
- **Mixed models are fine and common**: a kinematic crank driven by animation while the piston it pushes is dynamic — animation drives, physics responds. The bridge between them (animated colliders that genuinely push simulated bodies) is a requirement, not an option; a conveyor belt that passes _through_ the crates it should carry is a broken lesson

When physics is used, the model must declare real units — a pendulum's length in meters, gravity 9.81, densities in kg/m³ — so the demonstrated period, force or trajectory is the _true_ one. And every physics quantity the lesson cares about should be surfaced: a measured read-out next to a damped oscillator turns a pretty demo into a lab.

## Material selection

Materials are **semantic** — they tell the learner what a thing _is_:

- **Glass / transmission** for containers, lenses, fluids, membranes — anything the lesson needs to see through. Transmission with thickness and IOR is the physically honest version; high transparency is the cheap version. Either way, see-through is how internals stop being hidden
- **Emissive** for energy, charge, heat, signal, anything that _emits or carries_ the phenomenon: a glowing filament, ionized gas, a hot exhaust. Bind the emissive intensity to the quantity it represents so brightness _is_ the measurement — the model becomes its own instrument
- **Metal** (high metalness, low roughness) for machined parts, conductors, structural steel; **matte** (low metalness, high roughness) for organic matter, insulators, cast surfaces. Material _categories_ that map to physical categories let a learner identify substance on sight
- **Translucent / layered opacity** for explanatory shells: a cell membrane, a reactor containment, a skin over organs — opacity itself teaches that there are layers
- **Toon / flat shading** for diagram-style models where clean visual separation beats realism — mathematics and abstract concepts often read _better_ non-photoreal
- One color space discipline covers all of it: authored colors are sRGB, rendering is linear — convert explicitly, every time, or every material choice above renders washed out and muddy

**Restraint rule**: a model with five material archetypes used meaningfully reads as designed; a model with fifty ad-hoc materials reads as noise. Materials, like parts, must earn their place.

## Color selection

Color is a **semantic system the learner learns to read**:

- **Declare color roles, use them consistently**: one color for carriers (electrons, water, current), one for fields, one for boundaries, one for energy sources, one for outputs. Declared once in the model, applied by every part that has that meaning. After a minute, the learner stops reading labels and starts reading _color as category_ — that is the win
- **Adjacent contrast**: touching or interacting parts must be distinguishable at a glance — by lightness as much as hue (a dark blue next to a black fails even for fully-sighted learners)
- **Luminance hierarchy**: the important part is the _brightest_ or most saturated thing on screen; supporting structure recedes into muted, darker tones. Where the eye lands first is a design decision — make it deliberately
- **Emissive colors for states**: hot → cool reads through the emissive ramp; a part that shifts from amber to white as its temperature parameter rises is teaching thermodynamics through color alone
- **Color is never the only signal**: pair every color distinction with a shape, material, motion or label distinction — for the colorblind learner, and because redundant encoding is simply better design
- **Theme discipline**: colors are chosen against both dark and light backdrops and must hold contrast in both; the palette adapts, but the _roles_ never change meaning between themes

## Texture selection

Textures are the most commonly _misused_ element in generated models, so the rules are strict:

- **Prefer bare materials when the lesson is structure**: for teaching a mechanism, a clean PBR surface with correct metalness/roughness beats any texture — noise competes with the geometry that carries the meaning
- **Use procedural texture when the surface _is_ the content**: brushed metal direction, a heat gradient across a plate, wood grain as an anatomy section's cue, field-line contours. Generate procedurally from parameters so the texture tracks the physics — a heat map that shifts with the temperature parameter is a read-out wearing a surface
- **Never use photo-real textures as decoration**: slapping a generic "metal texture" on every part makes a model look aged, not detailed, and destroys the clean semantic palette above
- **Consistency over realism**: if one part is textured, its whole class is textured, with the same family; a single textured part among smooth ones reads as an error
- **Performance discipline**: every texture is GPU memory; procedural or flat-colored by default, textures only where the vocabulary entry genuinely needs them

## Motion and life (the thread that binds shape, material, color)

A model must be _alive_ by default, and motion is where all the selections above pay off or collapse:

- Every part that _should_ move, moves — because its shape was chosen for that motion (see the representation principle)
- Motion rate, direction and amplitude come from the model's parameters wherever possible, so a slider visibly changes the behavior
- Emissive, opacity and color follow their quantities live — glow rises with power, membranes fade on x-ray, the heat map shifts with temperature
- Stillness is deliberate: parts that don't move are _reference structure_, and their visual quietness against moving parts is itself information

## The audit — how model quality is measured

Because "good" must be machine-checkable to drive refinement, your audit scores models against these dimensions:

- **Cleanliness**: focal hierarchy present (one clear hero with receding support); no orphan/decorative parts; adjacency readable without overlap; material and spacing consistency
- **Attractiveness**: lighting and composition deliberately authored (not default); motion present and satisfying; at least one moment of delight (cutaway, glow, flow, reveal) — scored by _proxy signals_ the audit can measure, and by presentation choices the model declares
- **Information**: every part named + explained; parameters all visibly consequential; formulas agree with motion; story and quiz present and specific to this concept
- **Completeness**: every entity the concept requires is present; nothing floats unconnected; source → mechanism → output → return path is traceable
- **Representation fidelity**: moving parts use motion-correct shapes (gears are gears, flows are flows, waves propagate)
- **Material semantics**: archetypes used meaningfully; emissive bound to quantities where it teaches; transparency where internals need it
- **Color semantics**: roles declared and consistently used; adjacency contrast; luminance hierarchy points at the hero
- **Parameter leverage**: every parameter drives at least one visible behavior; formulas agree with motion
- **Detail economics**: hero parts detailed, repetition instanced, total cost inside the device budget

Deficiencies from the audit feed back into a refinement pass as _specific, enumerated_ instructions — "the turbine blades are boxes, loft them", "the battery has no connection to the circuit", "the temperature parameter changes nothing visible" — because targeted revision beats re-rolling.

## Edge cases

- A concept with no natural 3D form (supply curves, an algorithm, a historical trade network) → a _declared spatial metaphor_ with axes, flows, or step machinery — never a refusal and never a forced fake realism
- A model with no moving parts at all → it must still feel alive: camera auto-rotation, hover highlights, parameter-driven material changes; total stillness is a defect
- Contradictory requests ("photoreal DNA at true atomic scale") → resolve toward _teachability_ and declare the resolution in the info text
- A model whose physics request can't run on the device → animation fallback for the same phenomenon, stated honestly in the status bar

## What you decide

The vocabulary entries, the audit's scoring weights, the refinement loop's mechanics, the exact material and color role systems — all yours. The contract is above: motion-correct shapes, semantic materials, readable color roles, disciplined texture, deliberate physics-vs-animation choices, and an audit that can tell a good model from a decorated bad one.

## The final image

The learner opens a jet engine: the cowling is glass so the spool is visible, each compressor stage is a distinct color role they now recognize, the blades are lofted airfoils instanced 38 times from one definition, and dragging the thrust slider spins the spool through physics, raises the combustor's emissive glow, and accelerates the intake particles along their paths — shape, material, color, motion and control all arguing the _same_ lesson at once. That is a model. Everything in this document exists to make that the ordinary outcome, not the lucky one.
