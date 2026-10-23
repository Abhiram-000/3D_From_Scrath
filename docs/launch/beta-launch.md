# Beta launch — drafts and plan

**Live:** https://edu3d.onrender.com · **Status:** early beta, public, free.

This file holds paste-ready drafts. Nothing here has been posted: Hacker News has **no write
API at all**, and the other channels are accounts the owner controls. Posting is a two-minute
human action per channel.

---

## Positioning decision (and why)

The first instinct — K-12 teachers — is the wrong beachhead for an AI product, on evidence:

| | K-12 teachers | Technical explainer builders |
| --- | --- | --- |
| Attitude to AI | **25% say net harm, 6% net good** (Pew 2024) | Already use AI tooling daily |
| Hardware | ~**59% Chromebooks**, district-filtered | Developer machines |
| Budget | Essentially none | Content / DevRel budgets |
| What they pay for | time saved | **the thing we actually fix — comprehensibility** |
| Channel | hostile to promotion | HN, r/threejs, r/webdev, DevRel — peers who welcome a show-and-tell |

Lead with **"build an interactive explainer of anything"**, aimed at people who already hand-build
these artifacts (the animagraffs / Animated Engines / ciechanow.ski genre — weeks of work each).
Education is expansion, not the opening.

---

## 1. Show HN — the primary channel

**Why here:** the audience is technical, and the genuinely interesting claim is not "AI makes 3D" but
*"the AI writes real code and we execute it safely, on your device, with a headless audit and no GPU
server."* Lead with the engineering.

**Title** (HN has no API — paste by hand):

```
Show HN: An AI writes real Three.js code to build a 3D lesson on any topic
```

**Body:**

```
You type a topic — "how a four-stroke engine works", "how the kidney filters blood" — and
an AI model writes a complete JavaScript program against a scene API. The program runs in
your browser and builds an interactive 3D model you can orbit, click apart, and drive with
sliders.

The decision worth talking about: the AI writes code, not a spec. A declarative JSON
approach can only describe what the engine already anticipates; code means the ceiling is
the API rather than a schema. That's what lets it attempt an arbitrary topic instead of the
ten we happened to design for.

Which raises the obvious problem — I'm executing an LLM's code. So it runs in a dedicated
Web Worker that owns an OffscreenCanvas transferred from the page, and the worker's realm is
hardened before any guest code executes: fetch, WebSocket, WebAssembly, crypto,
importScripts, Function.prototype.constructor and friends are deleted rather than guarded.
There's no iframe or Realm inside a worker, so a deleted global is gone for good — that's
the whole reason it's a worker and not a sandboxed iframe. Loop bodies are instrumented
against a deadline for infinite loops, and a heartbeat watchdog terminates the worker if it
stops answering; the viewer recreates the canvas and survives.

The build is two-stage. The AI's program runs once against a pure-data authoring API and
produces a manifest — parts, parameters, measured cost, declared motion, a serialisable
description. The server runs that same pass headlessly in node:vm, so it can audit and price
a model with no browser and no GPU, before a single GPU object exists. Only then is the
model realized into Three.js on your device. Nothing renders server-side, ever.

It's an early beta and I'd rather say so up front. Some topics land much better than others,
and the hardest problem has not been making models *correct* — it's making them
*understandable*: I had a model score 94/100 on my own audit and still be hard to read,
because the audit can see structure and cannot see comprehension. So the prompt now requires
parts to be labelled on the model, cutaways to actually be cut, and scale to be stated.

Known limits, honestly: the free AI tier allows one generation at a time, so you may wait in
a queue; the gallery resets on redeploy; and the model is small for the size of program it
writes, so complex topics sometimes come back shallow.

I'd genuinely like to know which topics fail, and what you couldn't understand when you
looked at the result.
```

**Rules that matter on HN:** answer every question in the thread, including the hostile ones;
never argue about the downvotes; do not ask for upvotes; if someone finds a bug, thank them and
fix it *in the thread*. Post between roughly 08:00–10:00 US Eastern on a weekday. Expect the
sandbox to be the most questioned part — that's the interesting discussion, not a distraction.

---

## 2. Bluesky / X — the demo post

Short, one idea, link last so it doesn't read as an ad.

```
You type a topic. An AI writes real Three.js code that builds an interactive 3D model of it.

Not a spec — actual code, running sandboxed in a Web Worker on your device, with sliders that
change how it behaves.

Early beta: https://edu3d.onrender.com

Tell me which topics land badly.
```

Add a 10–20 s screen recording (generation → model → drag a slider → a labelled part). Video
carries these posts; text alone does not.

---

## 3. Reddit — read each sub's rules first

Different subs, different framings. **Do not cross-post the same text.** Nothing here is
"marketing" in tone — each is a maker talking to peers.

**r/SideProject** (welcomes launches, low scrutiny):
> I built a thing that turns any topic into an interactive 3D model, and I've finally got it
> online. The AI writes real Three.js code rather than filling in a template, so it can at least
> *attempt* anything. It's a beta and some topics flop badly — happy to hear which ones.

**r/threejs** (technically curious, tolerant of self-promo if there's engineering substance):
> I've been running LLM-written Three.js in a hardened Web Worker with an OffscreenCanvas — no
> DOM, no network, deleted globals, instrumented loops, a watchdog that kills it. Here's what it
> produces and the sandbox design. Interested in where people think the boundary leaks.

**r/webdev / r/InternetIsBeautiful:** lead with the artifact, not the AI. A working, weird,
interactive 3D model on an arbitrary topic *is* the hook.

**Avoid:** r/Teachers, r/edtech, r/homeschool. The evidence says those communities punish exactly
this post — 25% of teachers consider AI net-harmful, and self-promotion is against their rules.

---

## 4. Product Hunt

**Tagline (≤60 chars):**
```
Type any topic, get an interactive 3D model of it
```

**First comment** (the maker's intro — this is what people actually read):
```
I built this because every "learn X visually" tool I liked was a fixed catalogue. You could have
any of their 120 simulations, but never the one your class was stuck on.

So here the AI writes real code against a scene API instead of picking from a set. That's the
whole design: the ceiling is the API, not a list. Untrusted code, so it runs in a hardened
worker on your device — nothing renders on my server.

It's early. Some topics are great, some are shallow, and I'm most interested in the failures.
```

---

## 5. Reply plan — the objections to expect

Rehearse these; the replies are the launch.

| Objection | Answer |
| --- | --- |
| "How do I know it's not wrong?" | "You can read the generated program in the app — there's a code panel. Parameters are real numbers, not hallucinated pixels. And every model declares its own simplifications; if a proportion is exaggerated, it says so and gives the real value." |
| "Isn't running LLM code dangerous?" | Name the five layers: static gate on the server, AST loop instrumentation, lexical shadowing, realm hardening with irrecoverable cap drop, worker terminate. "Containment, not prohibition — it has full power over its own scene and none over anything else." |
| "It's just AI slop." | Agree with the failure mode and be specific: "Most of it is. I spent this week on exactly that — models that were structurally fine and unreadable. Labels, cutaways and scale are now required." |
| "Will it run on a school Chromebook?" | Answer honestly with what's measured, and what isn't yet. This is the one to fix before pitching education. |
| "What does it cost?" | "Free tier now, one generation at a time. Paid tier exists if it's useful." |

---

## Open questions before posting

- **The domain.** `edu3d.onrender.com` is honest but undersells the repositioned audience. A real
  domain would help HN credibility — it costs ~$10/yr and needs a human purchase.
- **The cold start.** Render's free tier sleeps after ~15 min idle, so the first visitor after a
  quiet spell waits ~60 s. On HN, that landing visit *is* the product demo. Worth a paid instance
  (~$7/mo) for launch day, or accept it and say so in the post.
- **AI capacity.** The free provider allows **one** concurrent generation. A front-page HN post
  would queue everyone after the first and many would leave. This is the single biggest launch-day
  risk and it is a budget decision.
