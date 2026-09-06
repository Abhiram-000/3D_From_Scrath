# BUILD DOC 04 — THE BACKEND

> Read `00-GOAL.md` first. This document specifies the backend: the generation pipeline, the API surface, and the robustness qualities that make it _powerful_. The stack is deliberately yours to choose — what is fixed is the behavior. A reference implementation used Node + Express successfully; that is evidence the requirements are satisfiable, not a prescription.

## Mission

The backend is the platform's engine room. It holds the AI key and the money, runs generations that take one to three minutes, stores every published model forever, and serves everything the frontend loads. Two words define the standard:

- **Powerful**: it streams progress while the model thinks, runs audit and refinement without stalling other requests, serves the gallery in milliseconds, and scales to a classroom of simultaneous learners
- **Robust**: it survives provider outages, bad payloads, redeployes mid-generation, database failovers, and its own bugs — and tells the truth about all of them

A backend that works on a laptop and falls over on the internet is not done. Neither is one that is reliable but slow, or fast but opaque. All three adjectives, always.

## The generation pipeline — the backend's primary job

Generation is a _pipeline_, not a call. The stages, each of which reports progress as it begins:

```
topic → prompt assembly → AI call(s) → extract code → static gate
      → audit → [self-repair / refinement loop] → validated model → response
```

### Stage requirements

**1. Prompt assembly**

- The system prompt (the scene API contract + pedagogy — see 00's prompting section) is loaded once and cached; the user's topic is wrapped and labeled **untrusted topic data, never an instruction** — prompt injection through the topic is the attack this stage exists to make impossible
- Complexity/style preferences bound what the prompt asks for; the domain spectrum (00) feeds domain-adaptive guidance

**2. The AI call**

- **Retries for the transient, never for the semantic**: a 429/503/timeout retries with backoff (a minutes-long generation must not die to a blip); a safety refusal or a bad request does _not_ retry — it fails fast with the provider's reason translated into user-actionable words ("out of quota — wait a minute", "the model declined this topic — try describing it differently")
- **Truncation is detected, never shipped**: a MAX_TOKENS finish on an empty or cut-off response is a specific, named failure — retry or fail with "the response was truncated," never deliver half a model
- The exact raw output is retained for diagnostics (the viewer's code panel shows what the model actually wrote vs. what runs)
- An unparseable, unrepairable output is _saved to disk_ (timestamped, gitignored) — it is the only evidence of what the repair chain could not fix, and the artifact the next repair gets written against

**3. Extraction and the static gate (AI-writes-code specific)**

- Model code is extracted from any surrounding prose/fences; then a **static gate runs before the browser ever sees it**: syntax check, forbidden-token scan (no `fetch`, `import`, `document`, `postMessage`, `Worker`, `eval`...), API surface check (only the scene API's known functions), size and shape limits
- A failure at the gate is fed back into a **self-repair loop**: the model receives _its own code plus the specific, enumerated errors_ and revises — bounded (e.g. 2 repair passes), because each pass costs money; after the bound, fail honestly
- Targeted revision beats re-rolling: a fresh attempt produces a different first draft, not a fixed one

**4. Audit and refinement**

- The generated model is audited server-side (structure, completeness, parameter leverage, the model-quality dimensions in 01-MODELS) — the audit runs headless, in-process, with no browser and no AI key
- When the audit falls short, **one refinement pass** sends the model its own output plus enumerated deficiencies; the revision is accepted only if it is _genuinely better_ (fewer errors, score not worse) — a degenerate second attempt must never replace a decent first one
- Audit results, scores and deficiency lists ride along with the response so the client and analytics can see generation quality

**5. Response**

- Streaming clients get phased progress events (prompt → model → parse → audit → refine → ready) plus a **heartbeat every ~10 s** during silent phases — a minutes-long model call that reports nothing is indistinguishable from a dead socket, and the heartbeat is what makes silence diagnostic
- Non-streaming clients get the same payload as one JSON object — content negotiation, not a separate endpoint
- Failures after the stream starts become terminal `error` events; a stream that ends without a terminal event is itself treated as a failure by the client

### Cost management (the money rules)

- Every stage that calls the AI is **budget-capped**: retries capped, self-repair passes capped, refinement to one pass — quality wins over token cost (00), but _loops_ are where costs run away, so loops are always bounded
- Per-IP/per-user rate limits on every AI endpoint, tighter than the general API (a classroom behind one NAT is one IP — make ceilings configurable)
- Generation, chat and quiz have **separate budgets** — a chatty tutor session must never eat the generation budget
- The pipeline logs duration, token counts and pass counts per generation: cost visibility is a requirement, not a nice-to-have

## The API surface

- **Design for the client you actually have**: the frontend needs generation (streamed), chat, quiz, gallery CRUD, subjects, snapshots, health — keep the surface small, versioned, and documented
- **Validation at the boundary**: every request body validated and bounded (topic length caps, question count clamps, pagination limits) — malformed input dies at the door with a 400, never reaches the pipeline
- **Error taxonomy that maps to client behavior**: 400 (your fault, fix the request), 401 (token), 429 (wait, said when), 503 (capability absent or draining — _not_ 500: the server is fine, the capability isn't), 502 (upstream AI failed, with the actionable translation). Errors carry a request id, never a stack trace
- **Never block the event loop**: the pipeline is async throughout; any CPU-heavy work (auditing a huge model, hashing snapshots) is chunked or moved to worker threads — one request's audit must never add latency to another's chat
- **Idempotency where it matters**: reads may be retried by the client; writes never automatically re-sent (a retried publish must not create duplicate gallery rows)
- Static serving is an **explicit allow-list** of frontend directories — never the repository root (see 06-STORAGE-AND-SECURITY)

## Robustness — the qualities, explicitly

- **Per-operation timeouts, never global**: health in seconds, gallery reads in seconds, generation gets an _idle_ watchdog (streaming with heartbeats) rather than a fixed ceiling — because a run that keeps reporting progress is healthy however long it takes
- **Draining, not dying**: SIGTERM → stop routing (readiness fails), let in-flight requests finish, tell every open generation stream what happened, flush, exit under a hard timer (the full sequence and its reasoning is in 06-STORAGE-AND-SECURITY)
- **Upstream failures are translated, not propagated**: the provider's message is the answer when it's actionable ("quota exceeded"), paraphrased when it's noise — never a raw upstream 500 dumped on a learner
- **Degraded modes are real modes**: no AI key → generation/chat/quiz answer 503 with a hint while the gallery and viewer keep working entirely; no database → the documented fallback with its announcements (08)
- **Structured logging with request ids**: every request one correlatable line; errors carry the same id the client saw; nothing is logged that shouldn't be (no keys, no user topic text in full — length, not content)
- **Observability**: request rates, generation durations and outcomes, open stream count, storage backend, and configuration warnings all exposed on the detailed health endpoint — a deployment can be diagnosed without SSH
- **The startup contract** (from 08, restated because it is backend behavior): resolve everything once, list every problem, refuse to start when production is unsafe

## Performance targets

- Gallery list and model reads: **single-digit milliseconds** server-side (indexed queries, light projections — snapshot URLs, not bytes)
- Stream flush latency: events reach the client within ~100 ms of occurring — buffering anywhere in the chain (proxy included, `X-Accel-Buffering: no`) defeats the entire stream
- Concurrent generations: at least a dozen simultaneous streams on one small instance without latency collapse — the pipeline is I/O-bound by design; prove it with a load test
- Snapshot serving: content-addressed immutable caching; a gallery page's burst of thumbnails never touches the API budget (separate mount, separate cache rules)

## Edge cases

- Client disconnects mid-stream → stop charging for work nobody is waiting for where safely possible; never write to a dead socket
- Two refinement passes racing on the same topic from one user → rate limiter prevents; pipeline itself is stateless per request
- The AI returns valid JSON/code with zero parts (an empty model) → the audit catches "does it have a root?"-class emptiness — never ship a blank scene
- Provider returns a different model's output shape after a silent upgrade → the extraction and gate stages absorb variance (fences, prose, both spellings of fields) — repair over reject, but _bounded_
- A request whose topic is hostile (injection payloads) → the wrapper holds, the static gate rejects, the log records length only
- Clock skew, duplicate ids, oversized snapshots, unicode topics, 10,000-character topics — all bounded at validation, all answered with a specific 400

## Testing

- **The pipeline tests without a live AI key**: the AI client is mocked with recorded fixtures — the happy path, truncation, refusal, quota, timeout, and malformed-output cases — so the pipeline's logic is CI-testable on every commit
- **The repair chain gets adversarial suites**: every class of malformed output the chain has ever seen becomes a regression test (this is the reference implementation's single most-tested module, for good reason)
- **The static gate gets escape attempts**: forbidden tokens in every hiding place (strings, template literals, comments, property access) must be caught
- **Streaming tests**: heartbeat timing, phase ordering, terminal-event guarantees, drain notification
- **Load test**: N concurrent streams; latency per phase stays flat

## What you decide

Framework (Express, Fastify, Hono, anything that streams), runtime (Node, Bun, Deno), AI provider and client library, mock/fixture tooling, worker-thread strategy — yours. The contracts: a phased, heartbeated, cost-capped pipeline with a static gate and bounded self-repair; per-operation timeouts; translated failures; an allow-listed, validated, idempotent API; and a backend whose idea of a bad day is a clear log line and an honest 503.

## The final image

Forty students press Generate in the same minute. Every one of them watches real phases stream — a model call, a parse, an audit, a refinement — with heartbeats in the silences. One student's provider call dies to a 429 and is retried invisibly inside the same stream. One topic comes back broken and is repaired by the model itself, with the repair visible in the diagnostics panel. The teacher publishes three models to the gallery between periods; the redeploys at 2 a.m. interrupt nobody. That is a powerful backend: it makes a slow, failure-prone world look smooth — and tells the truth when it can't.
