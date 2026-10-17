/**
 * The weld between the reflective surface and the authored reference table.
 *
 * `buildApiSurface()` reflects over live facades, so it is the source of truth for *what exists* —
 * but runtime reflection cannot recover TypeScript parameter types, so *how to call it* lives in a
 * hand-authored table (`api-reference.ts`). Two sources of truth drift silently unless something
 * fails when they disagree, and this file is that something, in both directions:
 *
 *  - a facade member with no reference entry fails here (the prompt would ship a bare name —
 *    the exact failure mode that drove `unknown_api` rejections at 62.5% build rate);
 *  - a reference entry naming nothing in the surface fails here (documentation for a removed
 *    function is worse than none: the model calls it and the gate rejects it).
 *
 * The third group executes the ten most load-bearing examples through the real authoring builder,
 * so an example that drifts from the API fails CI instead of a learner's generation.
 */
import { describe, expect, it } from 'vitest';
import { prepareProgram, describeViolations } from '@edu3d/sandbox';
import { apiSurfaceSet, describeApiSurface } from '../src/authoring/api-surface.ts';
import { API_REFERENCE } from '../src/authoring/api-reference.ts';
import { authorModel } from '../src/authoring/guest.ts';

describe('the authored API reference table', () => {
  it('documents every member the reflective surface exposes', () => {
    const missing = [...apiSurfaceSet()].filter((member) => !(member in API_REFERENCE));
    expect(missing, 'surface members with no reference entry').toEqual([]);
  });

  it('names only real members — documentation for a removed function fails the build', () => {
    const invented = Object.keys(API_REFERENCE).filter((key) => !apiSurfaceSet().has(key));
    expect(invented, 'reference entries that name nothing in the surface').toEqual([]);
  });

  it('carries a non-empty signature, summary and example for every entry', () => {
    for (const [key, entry] of Object.entries(API_REFERENCE)) {
      expect(entry.signature, `${key}.signature`).toMatch(/\S/);
      expect(entry.summary, `${key}.summary`).toMatch(/\S/);
      expect(entry.example, `${key}.example`).toMatch(/\S/);
    }
  });
});

describe('the rendered reference', () => {
  it('gives every member a signature — no bare names survive — and is deterministic', () => {
    const first = describeApiSurface();
    // Byte-identical across calls: response caching keys on this text, and an A/B comparison of
    // prompt versions is meaningless if the surface renders differently between runs.
    expect(describeApiSurface()).toBe(first);

    for (const member of apiSurfaceSet()) {
      // The member line is exactly two spaces of indent, the qualified name, then the call's
      // argument list (`(`), its type (`:`), or — for the nested-namespace markers geom.field /
      // geom.pattern — the nested-member pointer (`.`). Anything else is the old bare-name
      // listing this rewrite exists to replace.
      const line = first
        .split('\n')
        .find(
          (candidate) =>
            candidate.startsWith(`  ${member}(`) ||
            candidate.startsWith(`  ${member}:`) ||
            candidate.startsWith(`  ${member}.`),
        );
      expect(line, `a rendered line for ${member}`).toBeDefined();
      expect(line, `${member} must be documented, not merely named`).toContain('(');
    }
  });
});

/**
 * The scaffold every load-bearing example runs inside: a minimal legal program declaring the ids
 * the examples reference (`speed`, `steel`, `rig`, `demo`), so each example can be a copy-pasteable
 * fragment rather than a whole second program. Examples declare their own distinct ids.
 */
const SCAFFOLD_BEFORE = `scene.describe({ name: 'Reference scaffold', description: 'A harness that exists so the reference examples can execute.', concept: 'Examples must run against the real builder.', objectives: ['Execute the example call'] });
scene.param({ id: 'speed', label: 'Speed', kind: 'number', min: 0, max: 5, default: 1, unit: 'm/s', affects: [{ partId: 'demo', channel: 'transform' }] });
var steel = mat.metal({});
scene.group({ id: 'rig', name: 'Scaffold rig' });
scene.mesh({ id: 'demo', parentId: 'rig', name: 'Demo part', geometry: geom.box({ size: [0.2, 0.1, 0.1] }), material: steel, position: [0, 0, 0], info: { title: 'Demo part', summary: 'The part the scaffold examples act on.' } });
`;

const SCAFFOLD_AFTER = `scene.camera({ position: [1.2, 0.8, 1.2], target: [0, 0, 0], fov: 45 });
`;

/**
 * The members a generated program cannot get wrong without losing the build: the declaration
 * sequence, the parameter/motion/onFrame binding machinery, the mandated repetition mechanisms,
 * and the three builders the prompt singles out by name (`gear`, `helix`, `sweep`).
 */
const LOAD_BEARING_MEMBERS = [
  'scene.describe',
  'scene.param',
  'scene.mesh',
  'scene.instances',
  'scene.defineComponent',
  'scene.place',
  'scene.motion',
  'scene.onFrame',
  'geom.gear',
  'geom.helix',
  'geom.sweep',
] as const;

describe('the load-bearing examples', () => {
  for (const member of LOAD_BEARING_MEMBERS) {
    it(`executes ${member}'s example through the real gate and authoring builder`, () => {
      const entry = API_REFERENCE[member];
      expect(entry, `${member} must have a reference entry`).toBeDefined();
      if (!entry) return;

      const program = `${SCAFFOLD_BEFORE}${entry.example}\n${SCAFFOLD_AFTER}`;
      const prepared = prepareProgram(program, { apiSurface: apiSurfaceSet() });
      expect(prepared.ok, describeViolations(prepared.gate).join('\n')).toBe(true);
      if (!prepared.ok) return;

      // `harden: false` because realm hardening deletes capabilities from the test process —
      // the same discipline as authoring.test.ts; the hardening path has its own suite.
      const result = authorModel({
        code: prepared.instrumented,
        tier: 'mid',
        seed: 11,
        harden: false,
      });
      expect(result.ok, result.ok ? '' : result.message).toBe(true);
    });
  }
});
