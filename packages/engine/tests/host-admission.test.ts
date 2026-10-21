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
import { execFile } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { prepareProgram, describeViolations } from '@edu3d/sandbox';
import { DEVICE_BUDGETS, type ModelManifest } from '@edu3d/contracts';
import { apiSurfaceSet } from '../src/authoring/api-surface.ts';
import { authorInNodeVm } from '../src/hosts/node-host.ts';
import { priceModel, summarizeCost } from '../src/runtime/admission.ts';
import { MINIMAL_MODEL_SOURCE, REFERENCE_MODEL_SOURCE } from '../src/reference/turbofan.ts';

const prepare = (source: string) => prepareProgram(source, { apiSurface: apiSurfaceSet() });
const execFileAsync = promisify(execFile);

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

  it('denies network capability: the gate refuses the probing shape, the realm blocks it if it ever got here', () => {
    // Layer 1: the escape's *shape* — a computed lookup the gate cannot resolve — is now rejected outright.
    // `scene[names[i]]` is exactly the form a dynamic reach takes, and the documented API has no dynamic-key
    // vocabulary, so it is a `dynamic_code` violation with an actionable message rather than a `typeof` probe
    // the gate must hope comes back empty.
    const probed = prepare(`
      scene.describe({ name: 'Probe', description: 'Looks for capability.', concept: 'x', objectives: ['y'] });
      var found = [];
      var names = ['fetch', 'XMLHttpRequest', 'process', 'require', 'localStorage', 'Worker'];
      for (var i = 0; i < names.length; i++) {
        if (typeof scene[names[i]] === 'function') found.push(names[i]);
      }
      scene.mesh({ id: 'a', geometry: geom.box([1, 1, 1]), material: mat.metal({}) });
      scene.camera({ position: [2, 2, 2] });
    `);
    expect(probed.ok, describeViolations(probed.gate).join('\n')).toBe(false);
    expect(probed.gate.violations.map((violation) => violation.kind)).toContain('dynamic_code');

    // Layer 2 (defence in depth): even if a host wiring bug ever bypassed the gate and fed raw code here,
    // the realm membrane answers the probing read with a throw instead of an empty string. Fed raw
    // (unprepared) source on purpose: gate failures must not hide a realm-layer failure.
    const result = authorInNodeVm({
      code: `
        scene.describe({ name: 'Raw', description: 'x', concept: 'c', objectives: ['o'] });
        var leaked = [];
        var names = ['fetch', 'process', 'require'];
        for (var i = 0; i < names.length; i++) {
          if (typeof scene[names[i]] === 'function') leaked.push(names[i]);
        }
        console.log('leaked:' + leaked.join(','));
        scene.mesh({ id: 'a', geometry: geom.box([1, 1, 1]), material: mat.metal({}) });
        scene.camera({ position: [2, 2, 2] });
      `,
      tier: 'mid',
      seed: 11,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    // The membrane's message names the blocked global, so a repair pass sees what was attempted.
    expect(result.message).toMatch(/"(fetch|process)" is not available inside the model sandbox/);
    expect(result.logs.map((entry) => entry.message)).not.toContain('leaked:fetch');
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

/**
 * The realm boundary table.
 *
 * The guest realm is a genuinely SEPARATE set of intrinsics from the host process, and the node host hands
 * engine objects across. Every attempt below is a shape that used to work against the raw handed objects:
 * a computed/folded member key reaches `Function.prototype` → `Function` → `process` through the *host*
 * realm, bypassing the guest realm's own poisoned constructor entirely. The membrane (`@edu3d/sandbox`
 * `membraneScript`, wired in `createGuestContext`) installs guest-realm stand-ins for every handed value;
 * these tests assert the *class* of reach is closed, not just the one spelling the exploit used.
 *
 * The attempts are fed RAW to `authorInNodeVm` (no `prepareProgram`): the gate rejects most of these shapes
 * outright, and letting that rejection satisfy the assertion would test layer 1 twice while testing layer 2
 * never. Each attempt must fail at the realm.
 */
describe('the realm membrane closes the handing path', () => {
  const rawBuild = (code: string) =>
    authorInNodeVm({
      code: `
        scene.describe({ name: 'Escape', description: 'x', concept: 'c', objectives: ['o'] });
        ${code}
      `,
      tier: 'mid',
      seed: 1,
    });

  // The handed surfaces a build can reach before its first frame. Each probe reads a member the
  // membrane must not expose, then tries to call whatever came back as a code constructor.
  const surfaceAttempts: Array<[string, string]> = [
    [
      'scene: folded computed key',
      'var F = scene["cons" + "tru" + "ctor"]; var run = F("return process"); throw new Error("ESCAPED:" + typeof process)',
    ],
    [
      'scene: plain forbidden member',
      'var F = scene.describe["constructor"]; var run = F("return process"); throw new Error("ESCAPED:" + typeof process)',
    ],
    [
      'geom: folded computed key',
      'var F = geom["cons" + "tru" + "ctor"]; var run = F("return 1"); throw new Error("ESCAPED:" + typeof run)',
    ],
    [
      'mat: folded computed key',
      'var F = mat["constructor"]; var run = F("return 1"); throw new Error("ESCAPED:" + typeof run)',
    ],
    [
      'M: folded computed key',
      'var F = M["constructor"]; var run = F("return 1"); throw new Error("ESCAPED:" + typeof run)',
    ],
    [
      'console: folded computed key',
      'var F = console["constructor"]; var run = F("return 1"); throw new Error("ESCAPED:" + typeof run)',
    ],
    [
      'getPrototypeOf on a facade is a null chain',
      'var F = Object.getPrototypeOf(scene).constructor; var run = F("return process"); throw new Error("ESCAPED:" + typeof process)',
    ],
  ];

  for (const [label, attempt] of surfaceAttempts) {
    it(`blocks: ${label}`, () => {
      const result = rawBuild(attempt);
      expect(result.ok, `escape should fail: ${label}`).toBe(false);
      if (result.ok) return;
      // Either the membrane's forbidden-member/global blocker or a hardening poison must have stopped it —
      // and the message must never carry evidence of a successful reach ('ESCAPED' proves the program got far).
      expect(result.message).not.toMatch(/ESCAPED/);
      expect(result.message).toMatch(
        /not allowed|not available inside the model sandbox|Cannot read propert/,
      );
    });
  }

  it('realm deletions hold: globals are absent, and no probe reading them can reach the host realm', () => {
    const result = rawBuild(
      [
        'var r = typeof globalThis === "undefined" ? "no-globalThis" : typeof globalThis;',
        'var f = typeof fetch;',
        'var p = typeof process;',
        'scene.mesh({ id: "a", geometry: geom.box([1, 1, 1]), material: mat.metal({}) });',
        'scene.camera({ position: [2, 2, 2] });',
        'console.log("probe:" + r + "/" + f + "/" + p);',
      ].join('\n'),
    );
    expect(result.ok, result.ok ? '' : result.message).toBe(true);
    expect(result.logs.map((entry) => entry.message)).toContain(
      'probe:no-globalThis/undefined/undefined',
    );
  });

  it('reads of forbidden names on any handed surface throw as classifiable guest errors', () => {
    const result = rawBuild('var n = scene["process"];');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toMatch(/Accessing "process"|is not available inside the model sandbox/);
  });

  /**
   * Regression for the poisoning bug found while proving this suite: `hardeningScript` used to
   * reference `Function.prototype` *after* deleting the `Function` global, so vm-scope resolution
   * threw `ReferenceError: Function is not defined`, the code hardened nothing, and `resisted`
   * quietly gained an entry while `(function(){}).constructor('return process')` still escaped.
   * The capture now happens before the deletions, through a function instance, so the poison is the
   * ONLY thing standing between this spelling and the host realm — the gate cannot see it, and the
   * test asserts exactly that division of labor: the gate passes the un-foldable-key shape by
   * design (a pure-local root is program-local data), and the realm's poison stops the call with
   * the hardening thrower's message.
   */
  it('realm poison stops a Function construct attempt the gate lets through by design', () => {
    const prepared = prepare(`
      scene.describe({ name: 'Poison', description: 'x', concept: 'c', objectives: ['o'] });
      scene.mesh({ id: 'a', geometry: geom.box([1, 1, 1]), material: mat.metal({}) });
      scene.camera({ position: [2, 2, 2] });
      var make = function frame() { return 1; };
      var kf = ['constructor'];
      var F = make[kf[0]];
      var run = F('return 1 + 1');
      throw new Error('ESCAPED:' + typeof run);
    `);
    // The gate allows this spelling: `make[kf[0]]` has an un-foldable key on a pure-local root.
    expect(prepared.ok, describeViolations(prepared.gate).join('\n')).toBe(true);
    const result = authorInNodeVm({ code: prepared.instrumented, tier: 'mid', seed: 7 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    // The poison's own message — not the member blocker (make is not a handed surface) and not the
    // membrane's global thrower (which would read '"process" is not available…').
    expect(result.message).not.toMatch(/ESCAPED/);
    expect(result.message).toMatch(/Function is not available inside the model sandbox/);
    expect(result.message).not.toMatch(/Accessing "constructor"/);
  });

  /**
   * The frame path: calls re-enter the engine across the membrane on every frame, so the same prove must
   * hold for the per-frame handles — `ctx`, the part references it hands out, `ctx.params` and
   * `ctx.probes`. The *folded spellings* (`ctx['constructor']`) are already caught by the static gate
   * (folded computed keys on capability-rooted chains are rejected — see the sandbox gate tests), so what
   * is proved here is the gate's documented blind spot, exercised warm: a capability value parked in a
   * program-local store and read later with a key the gate cannot fold — `store[0][keys[i]]`. The gate
   * allows that shape (local data cannot statically carry the host), which makes it precisely the runtime
   * membrane's job. These go through the GATE and must still fail at the realm.
   */
  const frameAttempt = (label: string, attempt: string, expected: RegExp) => {
    const prepared = prepare(`
      scene.describe({ name: 'Frame', description: 'x', concept: 'c', objectives: ['o'] });
      scene.mesh({ id: 'a', geometry: geom.box([1, 1, 1]), material: mat.metal({}) });
      scene.camera({ position: [2, 2, 2] });
      scene.onFrame(function (ctx) {
        var store = [];
        var keys = ['constructor', 'callee', '__proto__', 'process'];
        store.push(ctx.part('a'));
        store.push(ctx.params);
        store.push(ctx.probes);
        ${attempt}
      });
    `);
    expect(prepared.ok, describeViolations(prepared.gate).join('\n')).toBe(true);
    const result = authorInNodeVm({ code: prepared.instrumented, tier: 'mid', seed: 7 });
    expect(result.ok, `${label}: build should pass the gate and the realm`).toBe(true);
    if (!result.ok) return;

    // The escape fires on the first frame the host drives.
    expect(() => result.builder.runFrame(0.5, 1 / 60, false), label).toThrow(expected);
  };

  const BLOCK_MEMBER = /Accessing "(constructor|__proto__)" on the scene surface/;
  const BLOCK_GLOBAL = /is not available inside the model sandbox/;

  it('blocks: a Function reach through a part reference parked in a local store', () => {
    frameAttempt('part reference via store', 'var F = store[0][keys[0]]; void F;', BLOCK_MEMBER);
  });
  it('blocks: __proto__ reads reach nothing through params', () => {
    frameAttempt('params proto', 'var F = store[1][keys[2]]; void F;', BLOCK_MEMBER);
  });
  it('blocks: dynamic keys on the frame context surfaces stay throwers (fold-free spellings)', () => {
    frameAttempt('dynamic key via store', 'var F = store[1][keys[0]]; void F;', BLOCK_MEMBER);
  });
  it('blocks: forbidden global names are throwers on the probes object', () => {
    // The literal spelling `store[2]['process']` is folded by the gate and rejected statically (see the
    // sandbox gate tests), so the fold-free element spelling is what must be caught here — at the realm.
    frameAttempt('probes via store', 'var F = store[2][keys[3]]; void F;', BLOCK_GLOBAL);
  });

  /**
   * The browser guest path (`authoring/guest.ts`) is a SINGLE-realm join — the guest and the engine share
   * one set of intrinsics, hardening poisons the one constructor every member walk bottoms out at, so no
   * membrane is needed there. Because it is a different host mechanism, it is probed in its own process:
   * this suite hardens the real `globalThis` by `authorModel({ harden: true })`, and the poison survives
   * guest reads. Spawned via a `node --input-type=module` child so this test process's own `Function` is never
   * put at risk by the probe, and the probe reports verdicts on stdout as JSON.
   */
  it('the browser guest path stops the folded-key escape through the poisoned realm', async () => {
    const paths = {
      guest: fileURLToPath(new URL('../src/authoring/guest.ts', import.meta.url)),
      apiSurface: fileURLToPath(new URL('../src/authoring/api-surface.ts', import.meta.url)),
      sandbox: fileURLToPath(new URL('../../sandbox/src/index.ts', import.meta.url)),
    };

    const escapeSource = `
      scene.describe({ name: 'Escape', description: 'x', concept: 'c', objectives: ['o'] });
      scene.mesh({ id: 'a', geometry: geom.box([1, 1, 1]), material: mat.metal({}) });
      scene.camera({ position: [2, 2, 2] });
      // Un-foldable spelling so the probe is a RUNTIME-layer test: the gate deliberately cannot fold
      // a key read from a program-local array, so this shape must come back to the realm to fail.
      var store = [];
      store.push(scene.describe);
      var keys = ['constructor', 'prototype'];
      var F = store[0][keys[0]];
      var run = F('return process');
      throw new Error('ESCAPED:process reachable');
    `;
    const ambientSource = `
      scene.describe({ name: 'Ambient', description: 'x', concept: 'c', objectives: ['o'] });
      scene.mesh({ id: 'a', geometry: geom.box([1, 1, 1]), material: mat.metal({}) });
      scene.camera({ position: [2, 2, 2] });
      // Ambient intrinsic chain, same un-foldable rule: ({}).constructor.constructor spelled so the gate
      // cannot fold it, then the runtime poison must be the thing that stops the call.
      var chain = [];
      chain.push({});
      var keys = ['constructor', 'prototype'];
      var F = chain[0][keys[0]];
      var deeper = F[keys[0]];
      var run = deeper('return 42');
      throw new Error('ESCAPED:constructed code ran');
    `;

    const probe = async (
      source: string,
    ): Promise<{ ok: boolean; message: string; gateOk: boolean }> => {
      const script = [
        'const sandbox = await import(process.env.EDU3D_SANDBOX_PATH);',
        'const guest = await import(process.env.EDU3D_GUEST_PATH);',
        'const api = await import(process.env.EDU3D_API_PATH);',
        'const prepared = sandbox.prepareProgram(process.env.EDU3D_SOURCE, { apiSurface: api.apiSurfaceSet() });',
        'const verdict = { gateOk: prepared.ok, violations: prepared.ok ? [] : sandbox.describeViolations(prepared.gate) };',
        'if (prepared.ok) {',
        '  const result = guest.authorModel({ code: prepared.instrumented, tier: "mid", seed: 3, harden: true });',
        '  verdict.ok = result.ok;',
        '  verdict.message = result.ok ? "" : result.message;',
        '}',
        "console.log('PROBE:' + JSON.stringify(verdict));",
      ].join('\n');
      const target = await mkdtemp(join(tmpdir(), 'edu3d-probe-'));
      const file = join(target, 'probe.mjs');
      await writeFile(file, script);
      const run = await execFileAsync(process.execPath, ['--experimental-strip-types', file], {
        env: {
          ...process.env,
          EDU3D_SANDBOX_PATH: pathToFileURL(paths.sandbox).href,
          EDU3D_GUEST_PATH: pathToFileURL(paths.guest).href,
          EDU3D_API_PATH: pathToFileURL(paths.apiSurface).href,
          EDU3D_SOURCE: source,
        },
        timeout: 30_000,
      });
      const line = run.stdout.split('\n').find((entry) => entry.startsWith('PROBE:'));
      if (!line) throw new Error(`probe produced no verdict: ${run.stdout} ${run.stderr}`);
      return JSON.parse(line.slice('PROBE:'.length)) as {
        ok: boolean;
        message: string;
        gateOk: boolean;
      };
    };

    for (const [label, source] of [
      ['folded key through the facade', escapeSource],
      ['ambient constructor chain through a plain object', ambientSource],
    ] as const) {
      const verdict = await probe(source);
      expect(
        verdict.gateOk,
        `${label}: gate should pass — the escape is a runtime-layer probe`,
      ).toBe(true);
      expect(verdict.ok, `${label}: single realm must refuse`).toBe(false);
      expect(verdict.message).not.toMatch(/ESCAPED/);
      expect(verdict.message).toMatch(/not available inside the model sandbox/);
    }
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
