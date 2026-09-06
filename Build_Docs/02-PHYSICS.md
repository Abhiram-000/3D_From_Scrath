# BUILD DOC 02 — PHYSICS

> Read `00-GOAL.md` first. This document states _what the physics system must achieve_ — and how good it must feel. How — engine integration, solver configuration, architecture — is your decision. Every requirement exists because its absence made a model lie, crash, or die. Edge cases are not an afterthought here; they are the spec.

## Mission

When a model uses physics, it must **demonstrate mechanics, not depict them**. A pendulum swings with the right period. A gear train transmits real torque. A struck object tumbles. Energy visibly transfers and is visibly conserved.

The test, stated once: a physics teacher should never say "that's not what happens" — and a learner should be able to _feel_ the physics, push it, drop it, spin it, and trust the result.

## The bar: beyond correct, into _convincing_

Correct physics is the floor. The target is physics that a learner _belieieves_ — the difference between "a demo" and "a machine I'm looking inside of". Aim here:

- **Inertia you can predict**: a learner who has played with the model for two minutes should be able to guess what happens _before_ they act — where a spun turbine slows, which way a toppling stack falls, how far the pendulum swings back. Correct moments and friction make motion predictable, and predictable motion is what turns interaction into intuition
- **Consequences that chain**: push one gear and the train turns; drop a ball on one end of a seesaw and the other rises. Real multi-body response — not each part animating its own script — is what makes a model feel like a _system_
- **Materials you can identify blind**: steel rings and slides to a stop, rubber grips and squeaks to one, ice glides, glass shatters (if modeled). Distinct mass, friction, restitution and damping per material, applied consistently, teach material science without a word of text
- **Energy as a visible ledger**: a ball trading height for speed on a ramp; a spring storing and releasing; a damped pendulum's swing visibly decaying while a read-out counts it down. Energy flow is the deepest story physics tells; make it watchable
- **Impact you flinch at**: contact that lands — a satisfying tumble from an off-center hit, a collision whose sound and force scale with severity, a stack that settles rather than freezes. Weight is a feeling; deliver it
- **Failure modes that teach**: a bridge that genuinely collapses under excess load, a projectile that genuinely tunnels at high speed (and the model explains why CCD matters), an unstable equilibrium that genuinely tips. When the real physics _disagrees_ with the naive expectation, that disagreement is the lesson

These are not optional polish. "Boring but correct" loses the learner's attention, and attention is the entire product.

## Requirements

### R1 — A real physics engine

Use a production-grade rigid-body solver (Rapier, Jolt, Ammo, or an engine of equal seriousness), integrated in whatever runtime form you judge best. Never hand-roll dynamics, never approximate with tweens and springs dressed up as physics. The solver's vocabulary — bodies, colliders, joints, motors, contact events — is the vocabulary your scene API exposes to the AI.

**Physics is a progressive enhancement.** If the physics runtime cannot load on a device, the model renders and animates without it, the UI says so honestly, and nothing crashes. Never fake simulation; never let its absence kill the page.

### R2 — Real units, real properties

- SI throughout: meters, kilograms, seconds, newtons. A dropped ball accelerates at 9.8 m/s²; a 2 kg mass hit by a 1 N·s impulse gains 0.5 m/s
- **Mass and inertia derive from the collider's true volume and the material's real density** by default — so a steel part and a foam part of the same shape behave differently. Authored overrides (explicit mass, center of mass, inertia tensor) exist for non-uniform internals
- Friction, restitution, damping, gravity, forces, impulses, torques, joints, motors: all obey real mechanics
- Simplification for teaching (slow-motion, exaggerated scale) adjusts _presentation_; the underlying math never lies

### R3 — Faithful colliders

Collision shape must match what is drawn, not a bounding box of it. A cylinder collides as a cylinder with its authored radius; a partial sphere is not a ball; a stack of parts is a compound body whose center of mass reflects its actual geometry. The fidelity rule: **what the learner sees touching is what the solver resolves.**

### R4 — Stable, frame-rate-independent simulation

The same scene must evolve identically on a 30 Hz phone and a 144 Hz desktop, and across reloads (determinism where the model asks for it). Simulation advances on its own clock; rendering follows without stutter. A slow frame degrades gracefully — slow motion, dropped steps, anything except a locked tab or an exploding accumulator.

### R5 — Live control

Every physics quantity is retargetable at runtime, because **parameter sliders must drive the simulation**: gravity changes, motor speeds retarget, forces apply, bodies wake. A sleeping body must hear a parameter change. Changes apply within a frame — the learner watches cause become effect.

### R6 — Observable physics

The system must publish _measured_ values — speeds, heights, kinetic energy, angular rates, contact forces — where the UI and the model's formulas can read them, so a read-out next to a pendulum tracks what the solver actually did, damping included. Numbers on screen and motion on screen must never disagree.

Go further than read-outs where it pays:

- **Live graphs**: energy over time, velocity over time — a strip chart next to a damped oscillator is a lab instrument, and labs are what this platform replaces
- **Per-part measurement on selection**: select any body and see its mass, speed, kinetic energy, momentum — turning every model into a measurable experiment
- **Vectors the learner can toggle**: force arrows, velocity arrows, contact points drawn on the model — the free-body diagram, live

### R7 — Clean lifecycle

Physics resources are allocated on scene load and **fully released on scene swap**. The core loop of this platform is generate → load → generate again; any leak in that cycle compounds into a dead browser tab within a session. Disposal must be total, idempotent, and tolerant of partial failures.

## Edge cases — handle all of these, explicitly

Each of these is a real failure mode of a naive implementation. Your design must survive every one, and your test suite must prove it:

**Input and validation**

- Non-finite values (NaN, Infinity) in any authored transform, velocity, or force — reject before they reach the solver
- Zero or negative mass, density, extent; degenerate collider shapes (flat, collinear, single-point)
- Bodies spawned at identical positions; bodies spawned inside each other
- Joint anchored to a missing or already-removed body
- Collider requests that are invalid for the body type (e.g. concave shapes on dynamic bodies)
- Author asks for more bodies than the device budget allows

**Runtime**

- A solver step produces NaN (numerical explosion): the body must be frozen and quarantined at its last good pose — one poisoned body must not write garbage into the whole scene graph
- A mechanism that locks up (constraint fighting contact) — must not jitter infinitely or consume the frame budget
- Backgrounded tab returns a multi-second delta — never attempt to simulate it all
- Frame rate drops below the simulation rate — debt must be shed, not accumulated into a spiral
- Sleeping bodies vs. parameter changes — sleeping is correct for settled scenes, but any change must wake what it affects
- Fast body vs. thin body (tunneling) — a projectile must not pass through a wall unnoticed
- Contact event flood (hundreds of simultaneous contacts) — event handling must be bounded
- Animated (kinematic) bodies vs. dynamic ones — moving machinery must actually push things, not leave its collider behind

**Lifecycle**

- Physics runtime fails to load mid-session — the running scene survives
- Scene swapped while the solver is mid-step — no dangling references, no double-free, no use-after-free
- Reset requested mid-simulation — every body returns to its _authored_ pose (not last frame's), interpolation state re-seeded, contacts cleared
- Repeated generate/load cycles — memory profile flat across dozens of cycles

## Performance

- Hard caps on bodies, joints, and colliders tied to the device tier; when a cap is hit, degrade visibly (partial simulation with a notice) rather than fail
- The physics step gets a time budget in the frame; it reports its cost so the adaptive quality system can see it
- No per-frame allocation in the hot path

## Testing — physics honesty is asserted, not assumed

Your suite runs in Node, with no browser and no AI key, and asserts the laws the system claims to model:

- **Conservation**: momentum conserved across impulses; a closed elastic system gains no energy; free fall matches s = ½gt² and v = gt within tolerance
- **Mass properties**: density-derived mass scales with volume; same shape, different material, different behavior; authored overrides honored
- **Mechanisms**: a pendulum's period is plausible for its length and gravity; joint limits are actually enforced; a motor actually drives; retargeting a live motor actually changes the rate
- **Fidelity**: colliders match authored geometry, not bounding boxes; degenerate input is rejected before reaching the solver
- **Survival**: every edge case above has a test that fails if the naive version of the bug returns

When one of these tests fails, the platform is teaching something false. That is the severity level you should assign physics bugs.

## Interaction — physics under the learner's hands

Watching correct physics is half the product; touching it is the other half. The learner should be able to act on the simulation directly:

- **Drag/push bodies**: grab a dynamic body and throw it — with proper velocity handoff on release, so a throw is a throw
- **Nudge and impulse controls**: tap a part to apply a small impulse; hold for a bigger one — enough to disturb an equilibrium and watch it recover (or not)
- **Direct parameter manipulation of live bodies**: change a body's mass, friction or bounciness while the scene runs and watch the response ripple through the system
- **Slow-motion and time control**: a time-scale slider on physics scenes — watch a collision resolve at 10% speed, every contact visible — plus pause-with-inspection, which already exists at the viewer level
- Every interaction feeds the undo history like any other parameter change

These capabilities must be part of the physics contract, not bolted on later, because they dictate API surface: grabbing needs body pick + kinematic override + release velocity; slow-motion needs a time-scale the stepper respects.

## What you decide

Engine and integration form, solver configuration, the shape of the body/joint/motor API, interpolation strategy, how measured values are published, how the kinematic bridge works — yours. The requirements above are the contract; meet all of them, then make the physics feel _deliberate_: stiff where machinery is stiff, soft where materials are soft, and always, always honest.

## The final image

Done right, this is what a learner remembers: they dragged a slider, the flywheel's angular momentum fought them for a beat, the read-out climbed exactly as the textbook said it would, the stack toppled the way it had to — and for one second they understood rotation not as a formula but as a _thing that has weight_. Build that.
