# Prompt v9 — visual legibility, the beta launch, and one correction

**Started:** 2026-10-23 · **Driver:** orchestrator session, autonomous.

## What this run set out to answer

The owner's report: _generated models are structurally compatible but not understandable —
they don't read as realistic, and a learner can't tell what they're looking at._

That matches `00-GOAL.md`'s quality bar, so it was treated as a product defect rather than a
tuning problem.

## The diagnosis, measured

Three real generations (four-stroke engine, nephron, ocean tides), not mocks. The decisive
observation was the first one: **a four-stroke engine scored 94/100 with zero deficiencies on the
platform's own audit, and is still hard to read.** The audit measures structure, completeness,
liveliness and parameter leverage. It has **no dimension that measures whether a learner
understands the result** — so the platform was grading itself blind to exactly the reported defect.

The prompt told a model what it must BE (fidelity, causality, cost, physics, a rubric) and almost
nothing about how it must READ.

## What shipped

**1. An engine capability, because the prompt could not reach the goal.** The highest-effect fix
in the instructional-design literature is spatial contiguity — a word beside the object it names
(median effect 1.10, 22/22 tests). The guest API had **no text, label, callout or sprite member at
all**, verified across `scene.*`; `PartKind` even listed `'sprite'`/`'label'` with nothing able to
emit them. `scene.label({ id, partId, text, offset? })` now lets a model name its own parts,
projected through the same world-point→screen path the learner's notes already proved, one-shot,
de-colliding in the worker, text as a text node. Labels stay pure manifest data so the headless
`node:vm` audit never needs a DOM.

**2. Prompt v9 — the visual layer.** Words on the model; signal the lesson and mute the rest; cut
open what hides the lesson; state scale; proportions before surfaces; material and light chosen for
legibility; nothing decorative (removing decorative material measures g ≈ 1.00 — the largest single
effect in the literature). Plus a `LEGIBLE` rubric line, a NEVER entry, and contract item 14.

**3. The measured effect of v9, same topic, same settings:**

|                            | baseline            | v9                |
| -------------------------- | ------------------- | ----------------- |
| On-model labels            | 0                   | **8**             |
| Real cutaway (`geom.clip`) | 0                   | 2                 |
| Colour roles               | 3                   | 5                 |
| Parts                      | 50                  | 36                |
| Audit score                | 94 / 0 deficiencies | 78 / 1 deficiency |

The labels are the intended set — `Piston`, `Connecting rod`, `Crankshaft`, `Intake valve`,
`Exhaust valve`, `Spark plug`, `Flywheel`, `Cylinder` — the lesson-bearing parts, not all 36. The
audit's one finding is a genuine one the previous version hid: a parameter (`sparkTiming`) that
changes nothing when swept.

**4. A production defect found by reading logs during a real generation.** The per-provider model
cascade had drifted against its own providers: FreeInference's second hop was the retired
`glm-5.1` (the ceilings table thirty lines below had always named `glm-5.3-flash`, and nothing
checked the two agreed), and Gemini's third hop was the absent `gemini-2.0-flash`. With
`qwen3.6-35b` correctly skipped for its 8,192-token ceiling, FreeInference had **no working
fallback at all** — so a 429 became a hard failure rather than a degrade, in a platform whose fourth
stated principle is "degrade, never die".

**5. Deployed.** https://edu3d.onrender.com — Render free plan, Docker, auto-deploy on push. The
GitHub repo was made public for it, after scanning the full history for secrets (none; only
deliberate `secret-scan-ok` fixtures, and a single bot author).

## The correction

An earlier commit (`332d1a3`) states that the generated engine _"declared zero relationships"_ and
cites that as evidence for a prompt gap. **That was wrong, and the error was mine.** Every model
emits relationships — engine 5, nephron 11, v9 6. The `0` came from reading
`manifest.relationships` when the schema nests them under `manifest.pedagogy`, and I did not check
my own query before acting on it.

The prompt edit itself survives on its own merits: item 1 genuinely did not list `relationships`
among the fields `scene.describe` must carry, so making it explicit (and saying why it is the one
part of the causal map the platform can check) is still an improvement. What is withdrawn is the
claim about observed output.

**Durable lesson for the next session:** these fields live under `pedagogy`, not at the manifest
root — `concept`, `objectives`, `principles`, `simplifications`, `relationships`. Reading the root
returns a silent `0`, which is indistinguishable from a real absence.

## Known state after this run

- The generation queue publishes one concurrent generation on the free tier, so a launch would
  serialise its audience. This is the single biggest launch-day risk and a budget decision.
- Render's free tier sleeps after ~15 minutes idle, and that cold start lands on the first visitor.
- Chromebook/low-tier viability — named by the audience research as the blocker for any teaching
  audience — is still **untested**.
- The gallery resets on redeploy (no persistent disk on the free plan).
