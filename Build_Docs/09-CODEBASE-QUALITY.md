# BUILD DOC 09 — CODEBASE QUALITY

> Read `00-GOAL.md` first. This document defines the **non-negotiable production-grade standards** for the codebase itself: structure, comments, testing, tooling, documentation. A platform that generates marvellous models from a tangled codebase is a demo. A platform that does it from a clean one is a product. These requirements are mandatory — treat every item as a gate, not a suggestion.

## Mission

The codebase is read hundreds of times more than it is written. Its readers are: future you, contributors, and — critically — **the AI agents that will maintain and extend it**. Every requirement below exists to make the code explain itself, survive change, and never let one edit silently break another module.

## Folder structure — modular by ownership

**Separate by responsibility, not by file type.** A reader asking "where does X live" must be answerable in one guess, and the answer must be a _folder whose name says what it owns_:

```
src/
  engine/          — the 3D engine: framework-agnostic, no DOM, no app imports
    scene/         — spec, validation, building, materials
    geometry/      — shape compilation
    physics/       — simulation
    behavior/      — declarative animation
    expr/          — sandboxed expression language
    runtime/       — frame loop, camera, interaction, settings, budgets
  app/             — page controllers, panels, modes (owns the DOM)
  core/            — API client, streaming, analytics (no DOM beyond fetch)
pages/             — one entry HTML per page, minimal
server/            — API, services, routes, config — one concern per file
  routes/
  services/
  middleware/
  config/
tests/             — mirroring the source tree
docs/ or build-docs/
scripts/           — check/verify tooling
```

Rules that make this structure _mean_ something:

- **Dependency direction is one-way and enforced**: `engine` never imports from `app`; `app` imports from `engine`; `server` never imports frontend. The engine must run in Node without a browser — that is what makes it testable and reusable
- **A module that needs a facade gets exactly one**: the app talks to the engine through a single facade, never by reaching into engine internals. One choke point per layer boundary
- **Flat over deep**: a file three folders from its module root is a smell. If a folder needs a README to explain its layout, the layout is wrong
- **One concern per file**: a file named `engine.js` doing rendering, controls, and loading is a god object — split it. If a file passes ~800 lines and still has more to say, it is probably two files
- **No orphans**: every file is imported from somewhere or is a deliberate entry point. Dead files are deleted, not parked

## Naming

- Modules and classes are nouns describing what they own (`PhysicsWorld`, `MaterialFactory`, `GenerationStream`); functions are verbs saying what they do
- No abbreviations that require tribal knowledge; no `utils.js` dumping ground — a function goes in the module whose concern it serves, or a _named_ shared module (`format.js`, not `helpers.js`)
- Test files sit beside (or mirror) their source, named after it
- The name is the first comment: if you need a comment to explain what a thing _is_, rename it

## Comments — clean, purposeful, rare-but-loaded

Comments are not decoration and not noise. The standard:

- **Every file opens with a file-level block**: one short paragraph — what this module is, and (only if non-obvious) why it exists. A reader should never open a file and wonder what it's for
- **Explain _why_, never _what_**: the code already says what. The comment that earns its place is the one carrying reasoning the code cannot: a constraint, a non-obvious consequence, a bug being defended against, an ordering that must not change
- **The best comments record hard-won knowledge**: "Runs before routing so a request that arrives between close() and exit gets an explanation, not a dead socket." A year later, that sentence prevents the bug from being reintroduced. _This is the entire value of comments — write these_
- **No redundant comments**: `// increment i` and restated signatures are deleted on sight. Comment-verbosity is treated as code smell in review
- **Magic numbers get named constants with a justification**: `const MAX_FRAME_DELTA = 0.1;` plus one line of _why_ 0.1. A bare literal in logic is a question every future reader has to answer again
- **TODOs carry an owner and a reason**, or they are deleted. A TODO with neither is graffiti

## Code style — the surface discipline

- **One language style, enforced by tooling, not by review**: formatter (e.g. Prettier/Biome) and linter (e.g. ESLint/ruff-class) configured in the repo, run on commit and CI. Style debates are settled once, by config, forever
- **Strict mode everywhere**; no silent failures: a caught error is either handled, rethrown with context, or logged with intent — never swallowed because the path was annoying
- **No copy-paste twins**: two functions with the same body and different literals become one parameterized function. Review rejects duplication on sight
- **Early returns over nested pyramids**; guard clauses first; the happy path reads left-to-right
- **Pure where possible**: logic is extracted into pure functions so it can be tested without a DOM, a canvas, or a server. Side effects (DOM, network, GPU) live at the edges — thin, visible, mockable
- **Constants over literals** in logic; enums as frozen objects; no stringly-typed states where an enum exists
- **Error messages written for their reader**: user-facing errors say what to do next; log lines carry context (ids, counts, durations); internal detail never leaks to clients

## The engine/app boundary (worth its own rule)

The engine is **framework-agnostic and DOM-free** — it runs in a worker or Node, is unit-testable without a browser, and communicates upward only through events and return values. The app layer owns the DOM, panels, and navigation, and drives the engine through its facade. This separation is what allows the sandbox to exist: the sandbox hosts engine + AI code without ever touching the page.

## Testing — the quality gate

- **Unit tests for every logic module**: the expression language, the JSON/code repair chain, validation, the progress model, physics accuracy — all testable without a network, a GPU, or an AI key
- **The security-critical paths have dedicated adversarial suites**: sandbox escape attempts, malformed model output, injection payloads — a regression here is a vulnerability, and the suite is the only thing that catches it cheaply
- **Integration tests for seams**: engine boot → model load → parameter change → render; server config → route → response
- **E2E for the flows a user actually takes** (real browser, desktop _and_ phone profiles): landing → generate → viewer, part selection, sharing, gallery
- **A single `verify` command runs everything** — secret scan, config check, unit, build, E2E — so "done" is one command with a green exit, not a ritual of remembered steps
- **Flaky tests are fixed or quarantined the day they flake** — a suite that is 95% green is 0% trusted
- **Tests are code**: same style standards, no magic literals without a word, and each test's _arrange-act-assert_ is readable without opening the source

## Tooling and reproducibility

- **Dependencies pinned and minimal**; two install roots (frontend, server) if the halves deploy separately — each `package.json` declares only what it runs
- **`README` gets a stranger productive in minutes**: prerequisites, install, configure, run, test — with the one canonical command sequence
- **Configuration is explicit and validated at startup** — a misconfigured deployment refuses to start with every problem listed, not just the first; production configs have an annotated example file
- **No secrets in the repo, ever** — enforced by an automated scan on every test run, not by memory
- **Env files are gitignored with committed examples**; a real environment variable always wins over file values so CI and containers work unchanged

## Documentation discipline

- **The build docs are the architecture's source of truth** — read in order, they explain the whole system
- **Every module's file-header + the folder structure are the map**; a separate internal wiki is not maintained (it rots). Where behavior is subtle, the comment in the code wins
- **A `CHANGELOG` or release note habit** for user-visible changes; commit messages that say _why_ in the subject line

## Review bar

A change is not done when it works. It is done when:

- [ ] Structure: it lives in the module that owns its concern; dependencies point the allowed direction
- [ ] Naming: nothing requires tribal knowledge to decode
- [ ] Comments: any non-obvious _why_ is written down where the next reader meets it
- [ ] Style: formatter and linter pass with zero exceptions, no suppressions without a reason
- [ ] No duplication, no dead code, no orphan files
- [ ] Errors handled at the right layer with the right message for its reader
- [ ] Tests cover the logic changed; the `verify` gate is green end-to-end
- [ ] Docs/comments updated where behavior changed

## What you decide

Language-specific idioms, exact tool choices, test framework, formatter — yours. The gate list above is the contract: modular ownership, one-way dependencies, comments that carry reasoning, style enforced by tools, adversarial tests for the dangerous paths, one green command that means "done."

## The final image

A new engineer (or a fresh AI agent) opens the repository. The folder names tell them where everything lives. Every file begins with three sentences that say what it is. The dangerous parts — sandbox, validation, repair — are visibly armored in tests. One command proves the whole system. Six months later, the person who wrote it is gone, the code is still obvious, and the bug someone reintroduces is caught by a test that was written the day the rule was learned.

That is a production codebase. Build nothing less.
