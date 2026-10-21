/**
 * Prompt-composition contract.
 *
 * v5 removed the hand-written example model from every prompt while keeping the generated API
 * reference verbatim. v6 re-adds a complete example — the platform's own reference turbofan — now
 * as a craftsmanship bar: what a model of real ambition looks like, subject excluded. Three claims
 * have to hold at once, and only a test can hold them there. The model must still see every legal
 * call signature (no guessing argument shapes). It must see the full reference model, framed so it
 * cannot mistake a jet engine for a template. And the repair/refinement prompts must not duplicate
 * that reference, because they already carry the model's own working code as the anchor.
 *
 * Each assertion names the failure it prevents. Dropping the reference table would strand the model
 * guessing argument shapes. Shipping the reference without copy-prevention would pull every topic
 * toward jet engines. Dropping the errors or deficiencies from their prompts would gut the layers
 * that actually catch malformed models.
 */
import { describe, expect, it } from 'vitest';
import { describeApiSurface, REFERENCE_MODEL_SOURCE } from '@edu3d/engine';
import {
  buildGenerationPrompt,
  buildRefinementPrompt,
  buildRepairPrompt,
} from '../src/services/prompts.ts';

// `describeApiSurface()` is deterministic (code-unit sorted), so the table generated here is
// byte-identical to the one the prompt builder embeds. Asserting the whole table verbatim pins
// "in detail" against paraphrase — no signature can silently drop out of the prompt.
const surface = describeApiSurface();

// Exemplar-only markers: strings that exist in the removed pendulum exemplar and nowhere else — not
// in the API table, not in the mechanism patterns, not in the turbofan reference (verified). These
// pin that the small anchor stays gone even though a large reference has arrived.
const EXEMPLAR_MARKERS = [
  '// A pendulum, taught honestly.',
  'theta0',
  '=== COMPLETE WORKING EXAMPLE',
] as const;

// Unique to the retained mechanism patterns (kept deliberately: patterns, not a model).
const MECHANISM_MARKER = '// Repetition as instances: one geometry, N placements, ONE draw call.';

// The load-bearing framing phrases. If one of these erodes, the reference degrades from a
// craftsmanship bar into a template the model fills in — the failure mode a size-anchoring
// exemplar causes, now at scale. Asserting the exact prose makes erosion a test failure.
const REFERENCE_FRAMING = [
  'never imitate its subject',
  'the topic decides the subject',
  'disciplines are domain-independent',
  'the teaching bar never scales down',
  'Scale the ambition to the requested complexity',
  'be as ambitious as the topic deserves',
  // The AMBITIOUS rubric line, with the audit-mapping tag the v7+ prompt carries: the rubric states
  // plainly which audit dimensions back each line, per the honesty boundary in contracts/audit.ts.
  'AMBITIOUS: [audit: representationFidelity + detailEconomics + attractiveness]',
] as const;

describe('the generation prompt', () => {
  const prompt = buildGenerationPrompt({ complexity: 'detailed', tier: 'mid' });

  it('ships the full generated API reference, verbatim', () => {
    expect(prompt).toContain(surface);
  });

  it('ships the full reference model, verbatim — the bar the model can see in full', () => {
    expect(prompt).toContain(REFERENCE_MODEL_SOURCE);
  });

  it('frames the reference so it cannot become a template: subject excluded, disciplines translated', () => {
    for (const phrase of REFERENCE_FRAMING) expect(prompt).toContain(phrase);
  });

  it('orders builders by construction cost, so the cheapest honest shape is reached for first', () => {
    expect(prompt).toContain('cheapest honest shape first');
    expect(prompt).toContain('the most expensive builder you may call');
    expect(prompt).toContain('build it once, at top level');
  });

  it('teaches the build and frame budgets the host actually enforces', () => {
    expect(prompt).toContain('20 second build budget');
    expect(prompt).toContain('50 millisecond');
    expect(prompt).toContain('NEVER construct geometry');
  });

  it('keeps the worked mechanism patterns', () => {
    expect(prompt).toContain(MECHANISM_MARKER);
  });

  it('ships no pendulum exemplar', () => {
    for (const marker of EXEMPLAR_MARKERS) expect(prompt).not.toContain(marker);
  });

  it('carries no instruction that points at an example that is no longer there', () => {
    expect(prompt).not.toContain('your program must reach this standard');
    expect(prompt).not.toContain("see the example's period");
  });

  it('offers physics as a progressive enhancement — simulate to feel or predict, else declare the depiction', () => {
    // v8, narrowed to what the lesson turns on, per `02`: "When a model uses physics, it must
    // demonstrate mechanics, not depict them", and "Physics is a progressive enhancement." The
    // clause must carry BOTH halves — reach for the solver when the learner is meant to perturb or
    // predict, and declare an honest depiction rather than silently animating forces — plus the
    // worked form showing the real call shape (a solver declaration is easy to invent wrong).
    expect(prompt).toContain('Physics is a progressive enhancement, not a requirement');
    expect(prompt).toContain('FEEL or PREDICT');
    expect(prompt).toContain('Animation is legitimate');
    expect(prompt).toContain('animated on a driven schedule, not simulated');
    expect(prompt).toContain('must NOT declare physics');
    expect(prompt).toContain("ctx.motor('arm'");
  });

  it('forbids a helix as the primary representation of a plain sine wave — the mathematics rule', () => {
    // v1's single highest-value rule. An ambitious generator draws a sine as a wrapping helix, and
    // a sine wrapped around a cylinder teaches nothing; the textbook graph is mandatory and the
    // forbidden representation is named so it cannot be reached for by mistake.
    expect(prompt).toContain('textbook graph');
    expect(prompt).toContain('FORBIDDEN as the primary representation');
    expect(prompt).toContain('helix, tube, spiral or spatial wave');
  });

  it('requires archetype classification and a causal map before coding, rejecting the floating battery', () => {
    expect(prompt).toContain('ARCHETYPE:');
    expect(prompt).toContain('CAUSAL MAP:');
    expect(prompt).toContain('floating-battery failure');
  });
});

describe('the repair prompt', () => {
  // A realistic gate violation: the model invented an argument shape the gate does not know.
  const errors = [
    'Line 12: geom.gear was called positionally; the gate accepts an options object.',
  ];
  const prompt = buildRepairPrompt('var gear = geom.gear(80, 0.16, 0.1, 0.55);', errors);

  it('ships the full generated API reference, verbatim', () => {
    expect(prompt).toContain(surface);
  });

  it('does not duplicate the reference model — the program being repaired is already the anchor', () => {
    expect(prompt).not.toContain(REFERENCE_MODEL_SOURCE);
  });

  it('still receives the numbered errors — repair is the layer that fixes malformed models', () => {
    expect(prompt).toContain('1. ' + errors[0]);
  });

  it('ships no complete example model', () => {
    for (const marker of EXEMPLAR_MARKERS) expect(prompt).not.toContain(marker);
  });

  it('carries no instruction that points at an example that is no longer there', () => {
    expect(prompt).not.toContain('=== THE CORRECT CALL SHAPES');
  });
});

describe('the refinement prompt', () => {
  const deficiencies = ['The exhaust plume is declared but nothing drives it: dead parameter.'];
  const prompt = buildRefinementPrompt('scene.describe({ name: "Turbine" });', deficiencies);

  it('ships the full generated API reference, verbatim', () => {
    expect(prompt).toContain(surface);
  });

  it('does not duplicate the reference model — the program being refined is already the anchor', () => {
    expect(prompt).not.toContain(REFERENCE_MODEL_SOURCE);
  });

  it('still receives the deficiencies — refinement is the layer that raises the teaching bar', () => {
    expect(prompt).toContain('1. ' + deficiencies[0]);
  });

  it('ships no complete example model', () => {
    for (const marker of EXEMPLAR_MARKERS) expect(prompt).not.toContain(marker);
  });

  it('carries no instruction that points at an example that is no longer there', () => {
    expect(prompt).not.toContain('STRUCTURE AND STANDARD TO MATCH');
  });
});
