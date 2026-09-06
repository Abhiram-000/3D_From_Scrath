# BUILD DOC 00 — THE GOAL

## What you are building

A web platform where a user types **any topic** — science, engineering, history, art, economics, everyday curiosity — and an AI generates an **interactive 3D educational model** of it — viewable, explorable, and manipulable in the browser.

**The promise is total: whatever the user asks, the platform produces something interactive and genuinely interesting to explore — every time, in every domain.** Not "the ten topics we tuned for". Any concept with structure, parts, motion, scale or causality can become a model, and the system is built so that a topic it has never seen is handled just as well as one it has: classify it, find its entities and relationships, choose a representation that suits _it_, and build.

The user picks a part and learns about it. Sliders change parameters and the model reacts live. A chat tutor answers questions about the model. Learners can take quizzes, follow guided story beats, share models via link, and browse a public gallery.

## The core idea (memorize this)

**The AI writes real code.**

Unlike a declarative-spec approach, here the AI is a programmer. It receives a scene API — a set of functions and objects your engine exposes (add mesh, define parameter, animate, bind physics, set camera, respond to clicks) — and it writes the code that builds the model using that API.

Why: data can only describe what the engine already anticipates. Code lets the AI do _anything the API allows_ — custom geometry math, procedural generation, per-frame logic, state machines, interactions nobody predefined. The ceiling is the API, not the schema. This is what makes the platform capable of genuinely novel models instead of elaborate LEGO.

This is the one absolute, non-negotiable rule of the platform:

**AI-written code is powerful but untrusted. It runs sandboxed, with access to the scene API and nothing else.**

- No DOM, no network, no storage, no globals, no host APIs
- One bad model must not be able to touch the page, other models, or the user
- A model that crashes or runs forever must be killable without taking down the viewer
- Time and resource limits are enforced, not assumed

Containment, not prohibition. Give the AI full power over its own scene and zero power over everything else.

## The user flow

```
Landing  →  enter a topic
  ↓
Loading  →  AI generates (takes 1–3 minutes; show real progress)
  ↓
Viewer   →  3D model on screen, interactive
```

Keep the pages lightweight and separate. A user landing on the first page should not download the engine.

## Physics: like real life

When a model uses physics, it must behave the way the real world behaves.

- A real physics engine (Rapier, Ammo, Jolt, or equivalent) — never hand-rolled approximations
- Real units: meters, kilograms, seconds, newtons. A pendulum with correct length and gravity swings at the correct period. A dropped ball accelerates at 9.8 m/s²
- Correct properties: mass, friction, restitution, density, damping, applied forces, joints and constraints that obey real mechanics
- Deterministic when the scene asks for it (reproducible teaching demos), free when it asks for that (sandbox play)
- Scaled or exaggerated only when the _lesson_ needs it (slow-motion, enlarged atoms) — and even then the underlying math stays physically correct; only presentation is adjusted

The test: a physics teacher should never say "that's not what happens". A learner should be able to _feel_ the physics — push it, drop it, spin it, watch energy transfer — and trust the result.

## Lighting

Lighting is not decoration — it is how a model becomes _readable_. A badly lit model hides exactly the parts that carry the lesson.

- **Standard setup:** every generated model gets a sane default rig (ambient/hemisphere fill + key directional light + fill light) so it is never lit flat or pitch black, even if the AI wrote no lighting code
- **Physically correct:** correct color space, tone mapping, and light units; shadows that look grounded, not stamped on. Materials respond believably (metal reflects, glass transmits, matte diffuses)
- **Semantic light:** the AI should be able to use light _as explanation_ — emissive glow for energy/charge/heat, a spotlight drawing the eye to the active part, brightness bound to a parameter (power, temperature, reaction rate)
- **Readable in both themes:** dark and light backdrops both need the model to hold contrast; the rig adapts, not just the CSS
- **Performance-aware:** shadow-casting lights are budgeted; a model that asks for twenty shadowed lights gets downgraded, not a frozen tab
- Exposed through the scene API: the AI can add, position, color, animate and bind lights like any other scene object

## Camera

The camera is the learner's eye, and the first frame decides whether a model makes sense.

- **Framing on load:** every model opens with the full concept in view — the AI author sets the initial camera (position, target, FOV, zoom) as part of the model; "auto-frame the bounding sphere" is the fallback, never the default answer
- **Orbit / pan / zoom** with sensible damping and limits: smooth, not floaty; the learner can never lose the model off-screen or zoom through the floor
- **Story mode drives the camera:** beats move the camera deliberately (cut or eased fly-to) to focus the current step; the learner's manual control is suspended during a beat and restored after
- **Touch parity:** one-finger orbit, two-finger pan and pinch zoom, matching every mouse capability
- **Never fight the user:** programmatic camera moves must be interruptible — a click or drag takes control back immediately

### Cinematic camera movement

The camera must be able to _move like a film camera_, because a model that teaches is a sequence of shots, not a screensaver. This is a core capability, not a nice-to-have, and the scene API must expose it directly to the AI.

**Cuts and transitions**

- **Cut:** jump instantly to a new framing — used when consecutive beats show different regions; instant, no interpolation
- **Eased move:** interpolate position and look-target with cubic ease-in-out so the move accelerates and settles — reads as deliberate, not a linear slide
- **Duration is authored:** every move carries its own duration so a beat can say "get there slowly" or "snap to it"

**The shot vocabulary (all scriptable through the API)**

- **Fly-to / focus:** move to frame a specific part, approaching along the _current_ view direction so it feels like moving closer, not teleporting to a new angle; the part fills the view with margin
- **Reveal orbit:** a slow continuous orbit around the model — the "hero shot" that shows an assembly from all sides
- **Follow shot:** track a moving part (an orbiting planet, a travelling electron, a piston at full speed) — camera position updates every frame, looking at the target
- **Dolly / push-in:** move straight toward or away from the target to build or release tension
- **Crane:** vertical rise or descent over the model — from ground level to overhead, revealing layout
- **Pan:** sweep the view horizontally while the camera stays put
- **Zoom (FOV) pull:** widen or tighten the field of view without moving — a focus pull between two related parts
- **Auto-rotate:** a gentle idle orbit when the user is not interacting, so the model always feels alive without stealing control

**Rules for cinematic moves**

- Easing curves are chosen per shot, and they matter: ease-in-out for travel, ease-out for landings, linear for follow shots
- Moves compose — orbit _while_ dollying = a spiral shot; the API should let the AI combine them
- Any user input cancels the current move and hands control back instantly
- Story beats can chain moves: establishing crane → fly-to the source → follow the carrier → pull back for the result. The sequence is the lesson
- The camera never passes through geometry in authored moves where avoidable; where not, fog or a cut hides the transition
- Respect the frame budget: a cinematic move is just an eased interpolation per frame — cheap — but a follow shot that recomputes bounds every frame is not; cache what the target is

## Model quality: textbook-accurate and genuinely complex

A generated model must be good enough to learn from. This is a quality bar, not a stretch goal.

**Textbook accuracy**

- The model must be _correct before it is pretty_: proportions, topology, states and relationships faithful to the real science — a cell shows the organelles a textbook names, a motor shows the parts that actually exist and in the right arrangement
- Every part carries its meaning: names, info text and tooltips that explain what it is and its role in the concept, shown on selection
- Behavior is truthful: electrons flow the correct direction, a pump's flow matches its rotor speed, a gear train's ratios are mathematically right. If the real thing has a source, a path, an output and a return, the model shows all four
- Simplification is allowed but honest: symbolic or diagrammatic geometry is fine when it clarifies — as long as the _relationships_ stay faithful. What is never allowed is a model that teaches something wrong

**High complexity is the target, not the exception**

- The platform must produce **rockets, spaceships, jet engines, launch systems, power plants** — full multi-system assemblies with hundreds of meaningful parts, not six boxes and a sphere
- The AI is a capable programmer: it can procedurally generate repeated structures (rivets, turbine blades, solar panel arrays), compose subassemblies, use booleans for real engineering shapes, and build hierarchies of functional groups (stage → engines → turbopump → blades)
- Detail means _explanatory_ detail: every extra part exists to show how the real machine works. A cutaway rocket shows fuel tanks, oxidizer, engine bells, turbopumps, avionics — and each is selectable and explained
- Complexity must be affordable: an engine with 300 parts is built from a few parameterized definitions, not 300 hand-written blocks. The scene API must make repetition cheap (instancing, component reuse) so ambition is not limited by token counts

**The bar, stated plainly:** if a learner can't reconstruct a textbook diagram of the concept from memory after playing with the model, the model isn't done.

## Prompting: the craft that produces the models

The prompts are not a footnote — they are **the primary production tool of the platform**. The difference between a six-box disappointment and a 300-part cutaway rocket is mostly the prompting architecture. Engineer them like code, not like a wish.

- **Chain-of-thought before code:** the model must think before it writes. Prompt it to plan in phases — _understand the concept → identify entities and relationships → design the causal system → choose representations → structure the scene hierarchy → then write code_. A model that plans produces coherent assemblies; one that starts typing produces scattered geometry
- **Structured role prompting:** separate the expert personas — domain scientist (what is true), instructional designer (what teaches), 3D engineer (what builds) — either within one structured prompt or across multi-step calls, so each concern gets real attention instead of being a bullet point nobody weighs
- **Domain-adaptive guidance:** the prompt makes the model classify the topic first (mechanism, circuit, field, molecule, ecosystem, orbital system...), then apply the visual grammar of that domain — linked assemblies for mechanisms, directed flow for circuits, sources and vectors for fields, compartments and transport for biology. One generic prompt cannot produce all of these well
- **Few-shot exemplars of excellence:** include short, real fragments of _good_ generated models — a well-structured subassembly, a well-bound parameter, a well-sequenced camera story — because showing beats telling, and the model will imitate structure it has seen
- **Self-critique and refinement loop:** generation does not end at the first output. Audit what came back (structure, parameter bindings, completeness) and, when it falls short, send the model _its own output plus specific, enumerated deficiencies_ — "the turbine has no blades", "this parameter changes nothing" — and have it revise. Targeted revision beats re-rolling; a fresh attempt produces a different first draft, not a fixed one
- **The contract is in the prompt:** the scene API surface, coding rules, physics units, parameter-binding requirement and output format live in the prompt itself, stated as hard constraints — because the model cannot follow rules it was never told
- **Prompt engineering discipline:** version the prompts, test them against a fixed battery of topics (mechanism, circuit, biology, math, astronomy...), measure results (did it build? part count? parameter bindings?), and treat a prompt change like a code change with evidence — never vibes-based tuning
- **Token budget awareness:** thinking costs tokens, code costs tokens, and output is capped — so the prompt must push the model to spend its budget on planning _and_ a complete program, not on restating instructions or verbose comments

## Token cost vs. model quality: quality wins

When a generation has to choose between a cheaper model and a better model, **choose the better model. Every time.**

- **The priority order is explicit:** the model's _looks, correctness and understandability_ come first. Token efficiency, cost per generation and response speed come after. A cheaper prompt that produces a worse model saved nothing — it wasted the whole call
- **Never truncate ambition to save tokens:** if the concept needs 300 parts, the generation writes 300 parts' worth of code (efficiently — through reuse and procedural structure — but _completely_). Cutting the model short to fit a smaller budget produces exactly the shallow six-box failure this platform exists to beat
- **Spend tokens where the learner sees them:** verbose comments, restated instructions, apologetic prose — waste. Planning, explanatory detail, correct parameter bindings, complete subassemblies — investment. The prompt should push every token into what renders, moves and teaches
- **The budget is a constraint, not a target:** hit the quality bar, then be efficient about it. Configure generous output limits; if a model hits the cap, that is a signal to restructure (more reuse, fewer hand-written parts), not to silently ship a truncated result — a half-generated model must be detected, refused and retried, never delivered
- **Cost still matters at the system level:** rate limits, retry caps and per-user budgets protect the platform from runaway spend — but they bound _how often_ we generate, never _how well_ once we do

The test: compare the cheap path and the full path for the same topic. If the cheap path yields a model a learner would close in ten seconds, it was not a saving — it was the most expensive token spend in the system, because it bought nothing.

The test: two prompt architectures against the same topic. If one produces a textbook-grade assembly and the other a sphere with boxes, the prompting — not the model, not the engine — is where the difference was made.

## Every domain, exceptional models

The platform does not have favorite subjects. A user asking about a heart, a market, a bridge, a black hole, a factory line or the water cycle deserves the same level of craft.

**Universal coverage, universal quality**

- **No "unsupported topic" answer:** if a concept exists, it can be modeled. The system classifies the domain, picks that domain's visual grammar, and builds — the failure mode to design against is a graceful, _honest_ fallback (e.g. a diagram-style interactive), never "we don't support that"
- **Exceptional in every domain:** the bar is equally high everywhere — mechanisms that move like machines, circuits with directed flow, fields with vectors and gradients, molecules with bonds and states, anatomy with layers, geology with strata, astronomy with scale, architecture with structure, data/systems with flows and transformations, economics/history with maps, timelines and causal chains
- **Interesting is a requirement, not luck:** every model needs a reason to keep watching — motion, a mystery to unfold in story mode, a parameter to experiment with, an internal world to discover through x-ray and explode. A correct-but-boring model is half a model
- **Abstraction is fine when reality isn't visual:** not every topic has a natural 3D shape (supply and demand, an algorithm, a historical trade route). The AI should invent a _spatial metaphor_ — axes, flows, landscapes of value, step-by-step machinery — rather than forcing fake photorealism or refusing
- **One platform, many visual languages:** the same engine under the flythrough of a rocket, the orbit of electrons, and the abstraction of a graph. The scene API must be general enough that no domain feels like a guest in someone else's house

**The test:** hand the platform a topic from each of five wildly different domains. If any one of them produces a model visibly weaker than the others, that weakness is the next thing to fix.

### The domain spectrum

The AI classifies every topic into a domain _before_ choosing a representation, because each domain has its own visual grammar — its entities, its signature motions, its spatial truths. The classification is guidance, not a cage; topics that straddle domains (biochemistry, astrophysics) blend grammars. The spectrum the platform must be fluent in:

| Domain                      | Entities it models                      | Signature representation                  | What moves                               |
| --------------------------- | --------------------------------------- | ----------------------------------------- | ---------------------------------------- |
| **Mechanics / machines**    | gears, linkages, bearings, engines      | assembled mechanisms, correct proportions | rotation, transmission, timing           |
| **Electronics / circuits**  | sources, components, carriers, traces   | schematic-in-3D, directed flow            | current, signal, state changes           |
| **Physics / fields**        | sources, charges, vectors, potentials   | field lines, gradients, wave surfaces     | propagation, oscillation, interaction    |
| **Chemistry**               | atoms, bonds, molecules, reactions      | ball-and-stick, orbitals, reaction states | vibration, bonding, transformation       |
| **Biology / anatomy**       | organelles, organs, systems, membranes  | layered compartments, cutaways            | transport, growth, cycles                |
| **Earth science / geology** | strata, cycles, weather, plates         | cross-sections, layered spheres           | flow, pressure, time-lapse               |
| **Astronomy / space**       | bodies, orbits, scale, radiation        | orbital systems, scaled distance          | revolution, rotation, trajectories       |
| **Mathematics**             | functions, surfaces, transformations    | axes, graphs, parametric forms            | the variable itself sweeping its range   |
| **Architecture / civil**    | structures, loads, forces, spans        | beams, trusses, stress visibility         | load, deformation, construction sequence |
| **Computing / algorithms**  | data, states, operations                | step machinery, flows, state diagrams     | the algorithm executing                  |
| **Economics / systems**     | actors, flows, stocks, feedback         | spatial metaphors — flowscapes, maps      | exchange, growth, oscillation            |
| **History / geography**     | places, routes, events, empires         | maps, timelines as paths, terrain         | expansion, movement, before/after states |
| **Everyday curiosity**      | appliances, instruments, cooking, sport | the real object, exploded                 | the thing doing its job                  |

Two disciplines need their own note. **Mathematics** demands the textbook graph — axes, origin, units, a clean curve as the dominant object — never a decorative 3D wave when the request is a function. **History/geography** has no natural 3D form, so the AI builds _spatial narratives_: a map with animated routes, a timeline the camera travels, a city that grows. These metaphor-driven domains prove the platform's generality — and they are where "no natural shape" must never become "no model".

Every domain entry above is a _sample_, not a boundary. The classification exists so the AI asks itself "what does this domain's best representation look like?" before building — the answer for an unlisted domain (music theory, law, linguistics, sports tactics) is derived the same way: find the entities, find the relationships, find the motion, choose the metaphor that makes them visible.

## Models must be alive

A generated model should almost never be a static sculpture. The default state of a model is **motion** — a spinning turbine, orbiting electrons, a swinging pendulum, flowing particles, pulsing valves.

- When the user hits **Play**, the model demonstrates its concept: parts rotate, oscillate, orbit, flow, or cycle through states
- When the user hits **Pause**, motion freezes exactly where it is — and everything is still inspectable: select parts, read info, change parameters
- **Reset** returns the model to its authored initial state (time = 0)
- Motion is _meaningful_: every moving part moves because the concept requires it (a rotor spins because rotors spin), not because "some animation" was needed. Rate, direction and amplitude should come from the model's own parameters wherever possible, so sliders visibly change the motion
- Pause does not mean dead: parameter changes, selection, annotations and visual modes all keep working while paused

The test: a screenshot of a paused model should look like a good textbook diagram; a running model should look like the concept _happening_.

## Parameters must change the model's behavior

A parameter that only moves a slider is a broken parameter. **Every user-facing control must visibly and meaningfully change what the model does** — this is the difference between a lesson and a screensaver.

- **Behavior, not just shape:** a speed parameter changes how fast parts actually rotate; a load parameter changes how a mechanism strains or deforms; a temperature parameter changes glow, particle motion and reaction rate. The _motion and physics_ follow the parameter, not only the geometry
- **Real-time:** the change applies live on the next frame, while the model runs — the learner drags a slider and watches cause become effect immediately, seeing the intermediate states as the value sweeps, not just the endpoints
- **Rooted in the science:** parameters are the real quantities of the concept — voltage, mass flow, gear ratio, enzyme concentration — and the model's response obeys the real relationship (double the voltage, see the proportional change a textbook predicts). Quantitative, not cosmetic
- **Cascading where the concept cascades:** a parameter that feeds several parts updates all of them consistently — change input voltage and the current, brightness, magnetic field and heat all respond together, so the learner sees the _system_ react, not five unrelated sliders
- **Every parameter earns its place:** the generation contract is that each declared parameter drives at least one visible behavior; a control that changes nothing is rejected, not shipped
- **Formula read-outs follow:** derived metrics displayed in the UI recompute from the same parameters the model uses, so numbers on screen and motion on screen always agree
- Works while paused too: dragging a slider on a paused model updates state visibly (position, color, glow), so inspection and experimentation are never blocked

The test: hand a learner the model with no explanation. If they can't discover _what a parameter does_ within a few seconds of dragging it, the binding is too weak.

## The viewer

The viewer is a three-column desktop layout that collapses gracefully to a single column on phones:

```
+--------------------------------------------------------------+
|  Toolbar: model name | play/pause, reset, view presets,      |
|            x-ray, wireframe, explode, fullscreen, theme,     |
|            generate, share, settings, help                    |
+------------+---------------------------------+---------------+
|  LEFT      |                                 |  RIGHT        |
|  PANEL     |                                 |  PANEL        |
|            |                                 |               |
|  Parameters|         3D CANVAS               |  Info tab     |
|  (sliders, |    (orbit, pan, zoom,           |  (overview,   |
|  toggles,  |     click & hover parts,        |   properties, |
|  colors —  |     drag annotations)           |   formulas,   |
|  live-bound|                                 |   links)      |
|  to model) |                                 |               |
|            |                                 |  Chat tab     |
|            |                                 |  (AI tutor)   |
+------------+---------------------------------+---------------+
|  Status bar: fps, device tier, mode indicators               |
+--------------------------------------------------------------+
```

Panels are collapsible so the canvas can go full-bleed. Every control has a keyboard shortcut, and none fire while the user is typing in a field.

### Viewer features (the full set)

**Interaction with the model**

- Orbit / pan / zoom camera; view presets (front, back, left, right, top, isometric)
- Click a part → selects it, highlights it, shows its info in the right panel
- Hover a part → highlights it with its name
- Parameter sliders, toggles and color pickers in the left panel, bound live to the model
- Undo / redo of parameter changes
- Live formula read-outs (metrics) that recompute as parameters change

**Visual modes**

- Play / pause / reset animation
- X-ray mode (see internals), wireframe mode, exploded view (parts separate in place)
- Dark and light themes, persisted; the 3D backdrop follows the theme

**Learning modes**

- Story mode: guided beats that move the camera, change parameters, and narrate the concept
- Quiz mode: multiple-choice questions about the model, generated when the model has none
- Chat: an AI tutor that answers questions about the current model, in several personas (teacher, study buddy, engineer, explain-like-I'm-five, socratic)

**Annotation**

- Learner pins their own labelled notes to points on the model; pins stay glued to the geometry as the camera moves; persisted per model

**Sharing & persistence**

- Publish the model to a public gallery (with snapshot thumbnail, subject, auto-tags)
- Share via link + QR code; the link opens the exact model
- Browse the gallery from the viewer and load any model

**Export & diagnostics**

- Screenshots at multiple resolutions (HD, Full HD, 4K)
- Video clip recording of the viewport
- A code/spec panel showing exactly what the AI produced for this model (raw output vs what actually runs) — invaluable when a model looks wrong
- Generate a new model without leaving the viewer

**Runtime trust indicators**

- FPS and device tier in the status bar
- Adaptive quality that steps down visibly when the device struggles, with a notice
- If physics is unavailable on the device, say so — never silently fake it

### Toolbar options — what each one is for

Every toolbar control exists for one job. None are decorative.

**Play / Pause**
Runs or freezes the model's motion. Paused is not dead — parameters, selection, annotations and visual modes all keep working, so a learner can freeze a spinning mechanism mid-motion and poke at it. This is how a model becomes a lab instead of a movie.

**Reset**
Returns the model to its authored initial state: time back to zero, parameters back to defaults, motion back to its starting pose. After a learner has dragged every slider and paused mid-cycle, this is the "clean slate" — the model as the AI intended it to first appear.

**View presets**
One-click standard camera angles (front, back, left, right, top, isometric). Teachers and learners constantly need "show me it from the side" without fumbling an orbit. Presets make the model legible from every angle, which is the whole point of 3D.

**X-ray**
Makes outer parts translucent so internals become visible — see the gears inside a housing, the nucleus inside a cell. The lesson is usually _inside_ something; x-ray is how the learner gets there without exploding anything.

**Wireframe**
Strips materials down to structural lines. Teaches topology and construction: how many segments, how a surface is shaped, what is solid versus hollow. Also a debugging aid when a model looks wrong.

**Explode**
Separates all parts in place along their offsets from the assembly center — an exploded engineering drawing, live. Learners see every component, its position and its relationships without any part hiding another. Toggle back to reassemble.

**Fullscreen**
Expands the viewer to fill the screen, hiding browser chrome and collapsing panels. For projection in a classroom, for focusing a single learner, and for enjoying a good model without distraction.

**Theme**
Toggles dark and light interface; the 3D backdrop follows the theme. Dark for evening reading and vibrant emissive parts; light for bright rooms and printed-feel diagrams. Persisted per user, applied before first paint to avoid a flash.

**Generate**
Opens the AI generation dialog without leaving the viewer. A learner watching the water cycle can immediately ask for the nitrogen cycle. Keeps the loop tight: curiosity → new model, no page reload, no context lost.

**Share**
Publishes the model and produces a link plus QR code that opens the exact model on any device. The core of virality and of classroom use — a teacher shares one link with thirty students, and what each of them sees is the same model.

**Settings**
Device-aware controls: quality preset, shadow and post-effect toggles, physics preferences, narration options. Reflects what the detected hardware can actually do rather than offering options that will stutter. The power-user surface for tuning performance.

**Help**
Lists every keyboard shortcut and basic controls. Discoverability for the people who never read docs — one modal, complete, searchable in future. Reduces the "I didn't know you could do that" gap between casual and expert users.

**Undo / Redo**
Steps parameter changes backward and forward. Encourages experimentation: a learner can push a simulation to extremes, then walk it back step by step and watch each change's effect reverse. Mistakes become cheap, so exploration becomes free.

## Principles to hold, in order of importance

1. **Sandbox first.** Design the execution boundary before designing the API. If the sandbox is weak, nothing else matters.
2. **Never lose work.** A model that fails to build, crashes, or hangs must not take the viewer down. Show the error, keep the page alive, offer a retry.
3. **Honest progress.** Generation is slow. Show real phases from the server, not a fake progress bar.
4. **Degrade, never die.** No API key, no WebGL, weak device, no database — every missing dependency should be a first-class, explained state, not a blank page or a hang.
5. **Cheap before expensive.** Cost what a model asks for against the device's budget. Downgrade instead of crashing the tab.
6. **Recover, don't discard.** AI code will sometimes be broken. Retry, repair or ask the model to fix its own code — a failed generation is expensive for the user (minutes) and for you (API cost).

## Security posture (minimum bar)

- API keys live server-side only. The AI is proxied through your own backend.
- User text sent to the model is wrapped and labeled untrusted — never treated as instructions.
- AI code executes in an isolated context (worker, sealed iframe, or equivalent) with a capability-scoped API.
- Rate-limit expensive endpoints. Protect writes (publish, delete) with a token.
- Errors returned to clients carry request ids, never internal detail.

## What "robustly" means here

This is a rebuild of an existing idea, done better. Be deliberate about:

- **The scene API design** — this is the product. What the API exposes is what the AI can build.
- **The sandbox** — verify it, don't assume it. Escape attempts and infinite loops must be testable without a live AI key.
- **Crash recovery** — a model's runtime failure is a normal event, not an exception. The viewer must survive it and report it usefully.
- **Generation quality** — malformed code, truncated output, empty replies: each needs a specific recovery path (retry, self-repair prompt, or clean failure).
- **Resource lifecycle** — repeated generation must not leak GPU memory or workers.
- **Long requests** — timeouts, streaming, and what the user sees while waiting.
- **Storage** — what persists (gallery, published models), what survives a restart.

## Stack rules

Three constraints are fixed. Everything else must be chosen _excellently_.

### 1. The 3D rendering is Three.js — exclusively

No Babylon.js, no PlayCanvas, no Unity/Unreal WebGL exports. Three.js is the engine layer — scene graph, materials, lights, cameras, post-processing — and the scene API you design for the AI wraps it.

### 2. The frontend framework: pick a _marvelous_ one, and own the choice

Do not default. Do not pick what you know best unless it is also _right_. The frontend framework must be chosen deliberately and justified against what this platform specifically demands of it:

- **A reactive UI around a non-reactive core**: the 3D engine is imperative, frame-driven, mutation-heavy Three.js. The framework must wrap it without fighting it — no framework re-render should ever touch the scene graph, and engine events (parameter changes, part selection, quality shifts) must flow into reactive state cleanly. The pattern is: framework owns the DOM chrome; engine owns the canvas; a thin, explicit boundary joins them
- **First-paint and routing performance**: the three-page flow (landing → loading → viewer) must stay lightweight — the landing page renders in kilobytes. The framework must support per-page code splitting where every page's entry payload stays small, and hydration/first-paint budgets from `08-PERFORMANCE-AND-DEVICES.md` must hold
- **Streaming-friendly**: generation progress arrives as NDJSON events for minutes; chat streams token-by-token. The UI layer must consume streams ergonomically — signals/fine-grained reactivity or equivalent, so a progress bar updating every event costs nothing
- **Batteries but not baggage**: the framework (or its ecosystem) should make the viewer's demands cheap — modals, panels, accessible widgets, theming, i18n-ready strings — without shipping a runtime the landing page pays for
- **Type safety end to end**: the scene API contract, the wire formats, the settings schema — a typed frontend catches cross-layer drift at compile time, and this platform has many layers

Evaluate honestly against those needs (the modern candidates — React/Next-class, Vue/Nuxt-class, Svelte/SvelteKit-class, Solid-class — all _can_ do this; the question is which does it with the least friction and the smallest landing page). State your choice, your reasons, and the trade-offs you accepted. A framework chosen by habit is how projects end up fighting their own UI layer.

### 3. The backend: a _powerful and efficient_ stack

The backend runs minutes-long streamed generations, dozens of concurrent connections, and millisecond gallery reads. Choose a stack whose strengths match that shape:

- **First-class async I/O and streaming**: the framework must stream NDJSON with immediate flushes, hold many long-lived connections cheaply, and never make a generation's wait cost a chat's latency. If the runtime can't stream a response body without buffering, it is disqualified
- **Non-blocking by design**: CPU work (audits, hashing, static gates) has a worker-thread/offload story; the event loop serves requests, never calculations
- **Lean per-request cost**: the API surface is small and the traffic per request is light except where it isn't (streams, snapshots) — the framework's per-request overhead should be negligible, its connection handling excellent
- **Production maturity**: middleware ecosystem for the security posture in `06-STORAGE-AND-SECURITY` (rate limiting, CORS, CSP, body limits), health-check ergonomics, graceful shutdown, structured logging — either built-in or one well-maintained library away
- **Type-safe contracts shared with the frontend** where both sides speak the same types: one source of truth for the wire format, checked at build time

The reference implementation proved Node + Express satisfies every requirement in `04-BACKEND.md`. Newer runtimes and frameworks (Fastify, Hono, Bun, Deno-class) may satisfy them _more efficiently_. Choose the one you can run hardest with the most confidence — and say why.

### Everything else is yours

Bundler, database tooling, AI provider, sandbox mechanism, TTS engine, testing libraries. Whatever you choose exists to serve Three.js + the scene API + the pipeline — never to fight them.

## Your freedom

This document intentionally does not tell you the file layout, the API shape, or the sandbox mechanism. Choose your own.

You are compliant as long as:

- a user gets an interactive, AI-generated 3D lesson from a plain-English topic
- the AI's code runs with real power over its scene and zero power over the host
- the rendering is Three.js, exclusively
- physics, where used, obeys real mechanics with real units
- every failure mode above has a visible, explainable state

Start by designing two things, together: **the scene API** and **the sandbox that runs it**. They are one decision, not two — the API is the capability surface, the sandbox is its boundary, and everything else follows from them.
