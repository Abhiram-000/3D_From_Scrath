# BUILD DOC 05 — THE CONVERSATION LAYER

> Read `00-GOAL.md` first. This document specifies the platform's _teaching voice_: chat tutoring, quiz, story mode, and narration — the modes through which the platform talks _with_ the learner rather than at them. The requirements are drawn from a working implementation, including the bugs that taught each rule. Every mode below must feel like one continuous conversation with a tutor who can see the same model you can.

## Mission

A model shows; the conversation layer _explains, questions, guides and remembers_. It is the difference between a beautiful object and a lesson. These modes share one context — the currently loaded model — and one trust rule: **everything the model authored or the AI replies is untrusted text, rendered as text, never as markup.**

## Context: what every mode knows about the model

Every conversational call carries an extracted summary of the _loaded_ model — never the raw spec:

- Name, description, and the model's own teaching declaration (concept, objectives)
- The component tree, flattened to named parts with their info titles (depth-limited, count-capped — "…and 23 more" beats a wall of 60 names that dilutes the answer)
- The parameters with labels, ranges and defaults — so the tutor can say _"try increasing the pressure to 5×10⁵ Pa"_ and be right
- Selection state where available: _which part the learner is looking at_ is the single most valuable piece of context a tutor can have

**Context discipline**: bounded, structured, topic-focused. Sending the entire model JSON burns tokens, dilutes the model's attention, and leaks implementation detail into prose. Extract what a teacher would glance at, not everything that exists.

## Chat — the tutor

### Personas, not one voice

The tutor speaks in selectable personas, each a _teaching stance_, not a gimmick:

| Persona         | Stance                                              | For the learner who…           |
| --------------- | --------------------------------------------------- | ------------------------------ |
| **Teacher**     | Warm, wise, analogy-driven, encouraging             | wants the classic explanation  |
| **Study buddy** | Casual peer, slang, supportive                      | is intimidated by formality    |
| **Engineer**    | Technical, precise, cites values, materials, forces | wants the real numbers         |
| **ELI5**        | Toys/animals/food metaphors, tiny words             | is completely new to the topic |
| **Socratic**    | Never answers directly; guiding questions           | wants to be led to the answer  |

The persona is chosen in the UI and sent per-message; switching mid-conversation is instant (the stance changes, the knowledge doesn't). Persona selection is remembered per user. **Persona design rule**: each must be _genuinely different in what it teaches_ — the engineer cites the model's actual parameter values, the Socratic turns questions back with the model's own parts as evidence. A persona that only changes vocabulary is decoration.

### Chat behavior requirements

- **Model-aware answers**: the system prompt binds the tutor to _this_ model — reference parts by name, suggest parameter changes the model actually supports, correct misconceptions using what's on screen. Generic encyclopedia answers that ignore the model are a failure mode to design against
- **Conversation memory within a session**: the recent exchange is part of the context, so "why does it do that?" works after the previous answer
- **Typing indicator, then the answer** — a tutor that answers instantly with no sign of thinking feels canned; one that hangs silently feels broken. Show work-in-progress honestly
- **Suggestion chips** seeded from the model's own content (part names, parameter names, story beats) — the learner's first question is the hardest; give them good ones to start from
- **Scroll discipline**: the list auto-scrolls only when the learner is already near the bottom — _reading older messages must never be interrupted_ by an incoming reply; a scroll-to-bottom affordance appears when they've scrolled up
- Enter sends, Shift+Enter newlines (same rule as the landing prompt)
- Errors replace the typing indicator with an honest message; the input is never lost
- All reply text rendered as **text nodes with safe formatting** — bold/emphasis via a constrained renderer on escaped text, never `innerHTML` of raw model output (a published model's chat context runs in every viewer that opens it)

### Streaming (the upgrade)

Answers should **stream token-by-token into the bubble** — the tutor is _writing_, visibly. A chat that hangs for 10 seconds and dumps a paragraph feels like a database, not a teacher. Streaming shares the generation pipeline's transport discipline (heartbeat, backpressure, cancel-on-navigate).

## Quiz — the examination

### The authored-first rule (the most important one)

**A model's own questions are used before any are generated.** They were written for this exact model, they're already in memory, and using them costs nothing. Generation is the _fallback_ for models that shipped without a quiz — never the default path that makes every learner wait tens of seconds (and fails entirely when the backend is down) for content that was already sitting in the page. This ordering also means the backend being down can only ever affect _one_ quiz path, not all of them.

### Question quality requirements

- Multiple choice, 4 options, exactly one correct, an explanation for _both_ outcomes
- **Distractors built from real misconceptions** — answers a learner who half-understands would pick, not obviously-wrong filler; the explanation says _why the tempting wrong answer is wrong_
- Questions test what the model can _show_: "what happens to X when you increase Y?" — answerable by touching the model — plus concept questions rooted in what the model displays; never generic trivia the model gives no evidence for
- Difficulty selectable (recall → application → synthesis); count bounded (5–20)
- **Validation before use**: questions with no options, fewer than two options, or an out-of-range correct index are _dropped_, not rendered — an unanswerable question teaches nothing and destroys trust ("every answer was wrong, including the right one" is the canonical failure this rule exists to prevent)

### Quiz UX requirements

- Options labeled A/B/C/D so a question can be discussed out loud (classroom, study partner)
- On answer: all options lock, the correct one marks, the learner's wrong pick marks differently, the explanation shows — _the answer stays visible while the explanation is read_
- **Score counted once per question** — re-clicking a locked question can't inflate it
- Results in-modal with a percentage, an honest grade line ("Excellent" / "Good work" / "Worth another look") and _guidance back into the model_ ("try changing the parameters to see the same principles in motion") — the quiz's ending is a doorway back to exploration, not a dead end
- Feedback text rendered as text nodes (same trust rule — generated explanations are untrusted)
- No blocking dialogs anywhere in the flow (`alert()` freezes the render loop and covers the result it's reporting)

## Story mode — the guided tour

Story mode is a **cinematic lesson authored into the model**: a sequence of beats that walk the concept from setup through mechanism to result.

### Beat requirements

Each beat carries: a **title**, **narration text**, a **camera target** (which part this beat is about), and optional **parameter sets** (change the model to demonstrate this step). 3–6 beats for most concepts — enough to build the narrative arc, few enough that each step is a real step.

### Playback requirements

- **The camera follows the story**: each beat focuses its target part (eased fly-to, per the cinematic camera vocabulary in 00-GOAL) and highlights it — the learner's eye is _taken_ to the mechanism, not left to find it
- **The model can change per beat**: a beat may set parameters so the phenomenon _demonstrates itself_ at that step (forward bias at the diode beat, full throttle at the combustion beat)
- **Subtitle overlay** shows the beat's title and narration; a scene counter (3/6) and prev/next controls give the learner pace control — _the story never traps_: cancel is always one click, manual control of the model resumes on exit
- **Voice narration** (text-to-speech) of each beat when enabled: speech synthesis where available, and **the story advances without it** — a synthesis error or missing API must never strand the story on the current beat (advance on error, not stall)
- **Auto-advance with reading time** when narration is off (~6s), a shorter beat after narration ends; the final beat closes the story and restores the learner's camera
- Disabled honestly when the model has no story: the button's tooltip says why, the shortcut says so — no mode that opens empty
- **Model swap unloads the story** — beats answering the previous model are as wrong as a stale quiz

### Story authoring (generation side)

The generation prompt requires 3–6 beats that follow the causal arc (setup → mechanism → intermediate state → result → why it matters), each beat targeting a real named part and each narration beat teaching one idea. Beats are audited like everything else: targets must resolve to real parts, narrations must be non-empty, the arc must cover the model's declared objectives.

## Narration — the voice

Voice is a _setting_, always optional, always honest:

- **Part narration on selection** — selecting a part reads its info aloud (the "read it to me" path) — and selecting anything else stops it; narration never overlaps itself
- **Story narration** as above; **stop on exit** always
- Speech availability detected, absence is silent (the modes work fine without it); errors cancel gracefully rather than stacking utterances
- Rate/pitch configurable; a voice preference persisted per user

## Cross-mode rules

- **One mode at a time**: entering quiz closes story overlays and vice versa; `Escape` exits any mode back to free exploration
- **Modes compose with everything else**: pause + story works (narration over a paused model is a legitimate teaching state), annotations persist under modes, parameters changed by a beat flow through the same undo history as manual changes
- **Every mode is analytics-instrumented at its funnel points** — story start/complete, quiz start/complete with source (authored vs. generated) and score band, chat by persona — because "which teaching mode actually gets finished" is a product question only data answers
- **All mode text is untrusted**: model-authored, AI-generated, or user-typed — text nodes everywhere, constrained formatting only

## Edge cases

- A published model whose quiz section is malformed → unusable questions silently dropped, usable ones kept; the learner never sees a broken question
- Quiz generation with the backend down → honest error state in-modal, auto-close, authored-path unaffected
- Story beat targeting a part that was renamed or removed by refinement → the beat skips its camera move and still narrates; one dangling target never kills the tour
- Chat while no model is loaded → the tutor says so and answers generally, or the panel explains; never a context-shaped hole
- Rapid mode switching → each exit path idempotent (timers cleared, utterances cancelled, highlights cleared); no stacked handlers across repeated runs
- Persona switching mid-answer → the in-flight answer completes; the next message uses the new stance

## Testing

- **Quiz**: authored-first ordering; unusable-question filtering; single-scoring; lock-and-mark states; result thresholds; generated-fallback failure path
- **Story**: beat sequencing, camera targeting on real parts, auto-advance with and without narration, narration-error advancement, exit cleanliness (timers/speech/highlights), model-swap unloading
- **Chat**: persona selection reaches the request; context extraction is bounded and structured; typing indicator lifecycle; scroll-near-bottom discipline; rendering safety (markup in replies displays, never executes)
- **E2E**: full story run on a model with authored beats; authored quiz answered end-to-end; a chat exchange in two personas

## What you decide

Persona roster beyond the required five stances, TTS engine (platform speech vs. a neural voice service), quiz scoring nuance, beat transition choreography — yours. The contracts: model-aware bounded context, authored-first content, personas that teach differently, stories that drive the camera, narration that never strands, and text safety everywhere.

## The final image

A learner finishes the story mode — the camera has walked them from the battery through the circuit to the glowing bulb, narrated in a warm voice, each beat showing exactly the mechanism it described. They switch the tutor to Engineer and ask why the filament glows; the answer cites _this_ model's voltage parameter and tells them to raise it and watch. They take the quiz, miss the misconception question, read why the wrong answer was tempting, drag the voltage slider themselves — and get it right the second time. That conversation — model, story, quiz, chat, one voice — is what this document builds.
