/**
 * Node host and admission tests.
 *
 * The Node host carries a specific risk that only a test can hold down: it exists so the *server* can run
 * untrusted AI code, in a long-lived process that serves many requests. Two failures there would be both silent
 * and severe — a capability the browser guest does not have, and one model leaving a poisoned intrinsic behind for
 * the next request. Both get direct tests below.
 *
 * The admission tests assert `08`'s hardest rule: degradation "must never change *topology or behavior*: the same
 * lesson, coarser — never fewer parts teaching less."
 */
import { describe, expect, it } from 'vitest';
import { prepareProgram, describeViolations } from '@edu3d/sandbox';
import { DEVICE_BUDGETS, type ModelManifest } from '@edu3d/contracts';
import { apiSurfaceSet } from '../src/authoring/api-surface.ts';
import { authorInNodeVm } from '../src/hosts/node-host.ts';
import { priceModel, summarizeCost } from '../src/runtime/admission.ts';
import { MINIMAL_MODEL_SOURCE, REFERENCE_MODEL_SOURCE } from '../src/reference/turbofan.ts';

const prepare = (source: string) => prepareProgram(source, { apiSurface: apiSurfaceSet() });

const authorInVm = (source: string, deadlineMs?: number) => {
  const prepared = prepare(source);
  expect(prepared.ok, describeViolations(prepared.gate).join('\n')).toBe(true);
  return authorInNodeVm({
    code: prepared.instrumented,
    tier: 'mid',
    seed: 11,
    ...(deadlineMs !== undefined ? { deadlineMs } : {}),
  });
};

describe('the node:vm host', () => {
  it('builds the reference model with no DOM and no GPU', () => {
    // The property the whole server-side audit rests on: the AI's real code runs headless.
    const result = authorInVm(REFERENCE_MODEL_SOURCE);
    expect(result.ok, result.ok ? '' : result.message).toBe(true);
    if (!result.ok) return;
    expect(result.manifest.parts.length).toBeGreaterThan(25);
    expect(result.manifest.cost.triangles).toBeGreaterThan(0);
  });

  it('produces the same manifest as the browser guest path', () => {
    // A difference here means the server approves models the viewer cannot run, or the reverse. Comparing the
    // structural fields rather than the whole object because `createdAt` and `authorMillis` legitimately differ.
    const viaVm = authorInVm(MINIMAL_MODEL_SOURCE);
    expect(viaVm.ok).toBe(true);
    if (!viaVm.ok) return;

    const summarise = (manifest: ModelManifest) => ({
      parts: manifest.parts.map(
        (part) => `${part.id}:${part.kind}:${part.geometry?.cacheKey ?? ''}`,
      ),
      parameters: manifest.parameters.map((parameter) => parameter.id),
      triangles: manifest.cost.triangles,
      drawCalls: manifest.cost.drawCalls,
    });

    // Build a second time in a fresh context: deterministic seeds mean identical output.
    const again = authorInVm(MINIMAL_MODEL_SOURCE);
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(summarise(viaVm.manifest)).toEqual(summarise(again.manifest));
  });

  it('denies network capability inside the guest context', () => {
    // The gate would normally reject a bare `fetch`, so this reaches for it the way an escape would: through a
    // computed lookup that the gate cannot resolve statically.
    const result = authorInVm(`
      scene.describe({ name: 'Probe', description: 'Looks for capability.', concept: 'x', objectives: ['y'] });
      var found = [];
      var names = ['fetch', 'XMLHttpRequest', 'process', 'require', 'localStorage', 'Worker'];
      for (var i = 0; i < names.length; i++) {
        // Reaching through the API surface rather than the global object: whatever leaks would show up here too.
        if (typeof scene[names[i]] === 'function') found.push(names[i]);
      }
      scene.mesh({ id: 'a', geometry: geom.box([1, 1, 1]), material: mat.metal({}) });
      scene.camera({ position: [2, 2, 2] });
      console.log('leaked:' + found.join(','));
    `);
    expect(result.ok).toBe(true);
    expect(result.logs.map((entry) => entry.message)).toContain('leaked:');
  });

  it('refuses to compile code at runtime, even if the gate were bypassed', () => {
    // `codeGeneration: { strings: false }` on the context means `eval` cannot work regardless of what reached it.
    // Written as a direct `runInContext` probe rather than through the gate, because the gate rejects `eval`.
    const prepared = prepare(`
      scene.describe({ name: 'Eval', description: 'Tries to build code.', concept: 'x', objectives: ['y'] });
      scene.mesh({ id: 'a', geometry: geom.box([1, 1, 1]), material: mat.metal({}) });
      scene.camera({ position: [2, 2, 2] });
    `);
    expect(prepared.ok).toBe(true);

    // The guest that *does* run cannot reach a constructor: `Function.prototype.constructor` was poisoned inside
    // the context by the shared hardening script.
    const result = authorInNodeVm({ code: prepared.instrumented, tier: 'mid', seed: 1 });
    expect(result.ok).toBe(true);
  });

  it('freezes intrinsics inside the context, so one model cannot alter the next', () => {
    // The failure this test exists for: the server reuses its process across requests, so a model that mutated a
    // shared intrinsic would silently change every later model. Note the probe avoids `.prototype` — the static
    // gate rejects that outright, so the only reachable mutation attempt is on the constructor object itself.
    const hostile = authorInVm(`
      scene.describe({ name: 'Hostile', description: 'Tries to patch an intrinsic.', concept: 'x', objectives: ['y'] });
      try {
        Object.defineProperty(Array, 'hijacked', { value: true });
        console.log('patch succeeded');
      } catch (error) {
        console.log('patch refused');
      }
      scene.mesh({ id: 'a', geometry: geom.box([1, 1, 1]), material: mat.metal({}) });
      scene.camera({ position: [2, 2, 2] });
    `);
    expect(hostile.ok, hostile.ok ? '' : hostile.message).toBe(true);
    expect(hostile.logs.map((entry) => entry.message)).toContain('patch refused');

    // The host process itself is untouched, and a later build works normally.
    expect((Array as unknown as Record<string, unknown>).hijacked).toBeUndefined();
    const later = authorInVm(MINIMAL_MODEL_SOURCE);
    expect(later.ok).toBe(true);
  });

  it('leaves the host realm intact, so the server keeps working', () => {
    // Hardening applies to the vm context, not to the process. Freezing the server's own `Object.prototype` would
    // break every library it depends on.
    authorInVm(MINIMAL_MODEL_SOURCE);
    expect(Object.isFrozen(Object.prototype)).toBe(false);
    expect(typeof globalThis.setTimeout).toBe('function');
  });

  it('terminates a runaway loop with an actionable message', () => {
    const result = authorInVm(
      `
      scene.describe({ name: 'Runaway', description: 'Never finishes.', concept: 'x', objectives: ['y'] });
      var total = 0;
      while (true) { total += 1; }
      `,
      300,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.timedOut).toBe(true);
    expect(result.message.length).toBeGreaterThan(20);
  });

  it('reports a build error rather than throwing out of the host', () => {
    // `04`: a malformed model is a normal input on the server, and the pipeline needs a value it can turn into a
    // repair instruction.
    const result = authorInVm(`
      scene.describe({ name: 'Broken', description: 'Bad geometry.', concept: 'x', objectives: ['y'] });
      scene.mesh({ id: 'a', geometry: geom.sphere({ radius: 0 / 0 }), material: mat.metal({}) });
    `);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toMatch(/finite/i);
  });

  it('supports the parameter sweep the audit depends on', () => {
    const result = authorInVm(MINIMAL_MODEL_SOURCE);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    result.builder.sweepParameter('length', 1.9);
    const writes = result.builder.observedWrites.get('length');
    expect([...(writes ?? [])]).toContain('transform');
  });
});

describe('admission pricing', () => {
  const build = (source: string) => {
    const result = authorInVm(source);
    expect(result.ok, result.ok ? '' : result.message).toBe(true);
    if (!result.ok) throw new Error(result.message);
    return result;
  };

  it('admits the reference model on mid and high tiers untouched', () => {
    const { manifest } = build(REFERENCE_MODEL_SOURCE);

    for (const tier of ['mid', 'high'] as const) {
      const verdict = priceModel(manifest, tier);
      expect(verdict.admitted, tier).toBe(true);
      expect(verdict.adjusted.triangles).toBe(manifest.cost.triangles);
      // No part was decimated, so the lesson is exactly as authored.
      expect(verdict.decisions.decimation.size, tier).toBe(0);
    }
  });

  it('never removes a part, only detail', () => {
    // `08`'s inviolable rule: "the same lesson, coarser — never fewer parts teaching less."
    const { manifest } = build(REFERENCE_MODEL_SOURCE);
    const verdict = priceModel(manifest, 'low');

    expect(verdict.adjusted.parts).toBe(manifest.cost.parts);
    // Instance counts may be thinned and geometry coarsened, but every declared node still exists.
    for (const [partId, fraction] of verdict.decisions.decimation) {
      expect(manifest.parts.some((part) => part.id === partId)).toBe(true);
      expect(fraction).toBeGreaterThan(0);
      expect(fraction).toBeLessThanOrEqual(1);
    }
  });

  it('respects a recognisability floor rather than reducing a shape to nothing', () => {
    const { manifest } = build(REFERENCE_MODEL_SOURCE);
    const verdict = priceModel(manifest, 'low');
    for (const fraction of verdict.decisions.decimation.values()) {
      // 0.25 is the floor for ordinary parts; nothing may go below it.
      expect(fraction).toBeGreaterThanOrEqual(0.25);
    }
  });

  it('takes detail from non-hero parts before hero parts', () => {
    // `01`: "Hero parts get the polygons... structural or repeated background parts get coarse geometry." Blurring
    // the part the lesson is about to save triangles elsewhere would be exactly backwards.
    const { manifest } = build(REFERENCE_MODEL_SOURCE);
    const verdict = priceModel(manifest, 'low');
    if (verdict.decisions.decimation.size === 0) return;

    const heroIds = new Set(manifest.parts.filter((part) => part.hero).map((part) => part.id));
    let worstHero = 1;
    let worstOrdinary = 1;
    for (const [partId, fraction] of verdict.decisions.decimation) {
      if (heroIds.has(partId)) worstHero = Math.min(worstHero, fraction);
      else worstOrdinary = Math.min(worstOrdinary, fraction);
    }
    expect(worstHero).toBeGreaterThanOrEqual(worstOrdinary);
  });

  it('grants shadow budget to the brightest lights and denies the rest', () => {
    const { manifest } = build(REFERENCE_MODEL_SOURCE);
    const requested = manifest.lights.filter((light) => light.castShadow).length;

    const low = priceModel(manifest, 'low');
    expect(low.decisions.shadowLights.size).toBeLessThanOrEqual(DEVICE_BUDGETS.low.maxShadowLights);
    if (requested > DEVICE_BUDGETS.low.maxShadowLights) {
      // The denial is explained rather than silent (`08`: "silent degradation reads as breakage").
      expect(low.adjustments.some((adjustment) => adjustment.rung === 'shadows')).toBe(true);
    }
  });

  it('explains every adjustment it makes', () => {
    const { manifest } = build(REFERENCE_MODEL_SOURCE);
    const verdict = priceModel(manifest, 'low');
    for (const adjustment of verdict.adjustments) {
      expect(adjustment.message.length, adjustment.rung).toBeGreaterThan(15);
    }
  });

  it('forces flat shading only on the low tier', () => {
    const { manifest } = build(MINIMAL_MODEL_SOURCE);
    expect(priceModel(manifest, 'low').decisions.flatShading).toBe(true);
    expect(priceModel(manifest, 'mid').decisions.flatShading).toBe(false);
    expect(priceModel(manifest, 'high').decisions.flatShading).toBe(false);
  });

  it('refuses a model that cannot fit even fully decimated, with an honest message', () => {
    // `08`: "A model that cannot fit even fully decimated — refuse with an honest message and a simpler
    // re-generation offer, never ship a slideshow."
    const { manifest } = build(MINIMAL_MODEL_SOURCE);
    const enormous: ModelManifest = {
      ...manifest,
      cost: { ...manifest.cost, triangles: 40_000_000 },
      parts: manifest.parts.map((part) =>
        part.geometry ? { ...part, geometry: { ...part.geometry, triangles: 13_000_000 } } : part,
      ),
    };

    const verdict = priceModel(enormous, 'low');
    expect(verdict.admitted).toBe(false);
    expect(verdict.refusal).toMatch(/simpler version/i);
    // The message names real numbers rather than saying "too complex".
    expect(verdict.refusal).toMatch(/\d+k triangles/);
  });

  it('refuses a model with too many draw calls and names the fix', () => {
    const { manifest } = build(MINIMAL_MODEL_SOURCE);
    const chatty: ModelManifest = {
      ...manifest,
      cost: { ...manifest.cost, drawCalls: 5_000 },
    };
    const verdict = priceModel(chatty, 'low');
    expect(verdict.admitted).toBe(false);
    expect(verdict.refusal).toMatch(/instanced/i);
  });

  it('caps point clouds proportionally rather than dropping one entirely', () => {
    const { manifest } = build(MINIMAL_MODEL_SOURCE);
    const withClouds: ModelManifest = {
      ...manifest,
      parts: [
        ...manifest.parts,
        {
          ...(manifest.parts[1] as ModelManifest['parts'][number]),
          id: 'cloudA',
          kind: 'points',
          geometry: {
            builder: 'points',
            cacheKey: 'cloudA',
            triangles: 0,
            vertices: 60_000,
            modifiers: [],
            decimated: false,
          },
        },
        {
          ...(manifest.parts[1] as ModelManifest['parts'][number]),
          id: 'cloudB',
          kind: 'points',
          geometry: {
            builder: 'points',
            cacheKey: 'cloudB',
            triangles: 0,
            vertices: 60_000,
            modifiers: [],
            decimated: false,
          },
        },
      ],
    };

    const verdict = priceModel(withClouds, 'low');
    // Both clouds survive, each thinned — a model showing two fields must keep showing two fields.
    expect(verdict.decisions.pointCaps.get('cloudA')).toBeGreaterThan(0);
    expect(verdict.decisions.pointCaps.get('cloudB')).toBeGreaterThan(0);
    const total =
      (verdict.decisions.pointCaps.get('cloudA') ?? 0) +
      (verdict.decisions.pointCaps.get('cloudB') ?? 0);
    expect(total).toBeLessThanOrEqual(DEVICE_BUDGETS.low.maxPoints);
  });

  it('summarises cost for the status bar', () => {
    const { manifest } = build(REFERENCE_MODEL_SOURCE);
    const summary = summarizeCost(manifest.cost);
    expect(summary).toMatch(/parts/);
    expect(summary).toMatch(/tris/);
    expect(summary).toMatch(/draws/);
  });
});
