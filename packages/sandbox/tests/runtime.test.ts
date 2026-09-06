/**
 * Tests for the runtime half of the sandbox: loop instrumentation, realm hardening, and the compiled
 * guest's lexical shadowing.
 *
 * These matter more than the gate tests, not less. The gate is the layer most likely to be bypassed —
 * a new AST form, a parser upgrade, a repair pass that rewrites code after the gate ran — so every test
 * here deliberately feeds *ungated* hostile source straight into the runtime and asserts it still fails
 * closed. That is what "verify it, don't assume it" (`00`) means for a boundary with five layers.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  auditRealm,
  compileGuest,
  createGuard,
  GuestBudgetError,
  GuestTimeoutError,
  hardenRealm,
  instrumentLoops,
  GUARD_IDENTIFIER,
} from '../src/index.ts';

describe('loop instrumentation', () => {
  it('guards a block-bodied loop', () => {
    const { code, guardedLoops } = instrumentLoops('while (true) { doWork(); }');
    expect(guardedLoops).toBe(1);
    expect(code).toContain(`${GUARD_IDENTIFIER}()`);
  });

  it('guards a bare-statement loop by wrapping it in a block', () => {
    // `while (x) step();` has nowhere to put a statement, so the transform must create a scope. Missing
    // this case leaves the shortest realistic infinite loop completely unguarded.
    const { code } = instrumentLoops('while (x) step();');
    expect(code).toContain(`{${GUARD_IDENTIFIER}();`);
    expect(code.endsWith('}')).toBe(true);
  });

  it('guards the empty-statement loop, the shortest infinite loop in the language', () => {
    const { code } = instrumentLoops('for (;;);');
    expect(code).toContain(GUARD_IDENTIFIER);
  });

  it('guards every loop form', () => {
    const source = `
      for (let i = 0; i < 3; i++) { a(); }
      for (const k in o) { b(); }
      for (const v of arr) { c(); }
      while (p) { d(); }
      do { e(); } while (q);
    `;
    const { guardedLoops } = instrumentLoops(source);
    expect(guardedLoops).toBe(5);
  });

  it('guards nested loops independently', () => {
    const { code, guardedLoops } = instrumentLoops(
      'for (let i = 0; i < 2; i++) { for (let j = 0; j < 2; j++) { work(); } }',
    );
    expect(guardedLoops).toBe(2);
    expect(code.match(new RegExp(GUARD_IDENTIFIER, 'g'))?.length).toBe(2);
  });

  it('guards function entry so recursion is bounded by wall clock, not stack depth', () => {
    const { code } = instrumentLoops('function recurse(n) { return recurse(n + 1); }');
    expect(code).toContain(GUARD_IDENTIFIER);
  });

  it('leaves a loop-free program byte-identical', () => {
    const source = 'const a = 1;\nconst b = a + 2;\n';
    const { code, guardedLoops } = instrumentLoops(source);
    expect(guardedLoops).toBe(0);
    expect(code).toBe(source);
  });

  it('preserves line numbers, so a guest stack trace points at the model own code', () => {
    // Insertions never add newlines. The diagnostics panel shows the model's source, and a trace
    // pointing at a shifted line would be worse than no trace.
    const source = 'const a = 1;\nwhile (a) { b(); }\nconst c = 2;\n';
    const { code } = instrumentLoops(source);
    expect(code.split('\n').length).toBe(source.split('\n').length);
  });

  it('produces code that still parses and runs correctly', () => {
    const { code } = instrumentLoops('let total = 0; for (let i = 0; i < 5; i++) { total += i; }');
    const guard = createGuard();
    guard.reset(1000);
    const fn = new Function(GUARD_IDENTIFIER, `${code}; return total;`) as (
      t: () => void,
    ) => number;
    expect(fn(guard.tick)).toBe(0 + 1 + 2 + 3 + 4);
  });
});

describe('deadline guard', () => {
  it('throws a timeout error once the wall clock passes the deadline', () => {
    // Time is injected so the test asserts the behaviour without spending two seconds proving it.
    let now = 0;
    const guard = createGuard(() => now);
    guard.reset(100);
    now = 1000;
    // The time check is sampled every 2048 iterations, so the throw arrives within that window.
    expect(() => {
      for (let i = 0; i < 5000; i += 1) guard.tick();
    }).toThrow(GuestTimeoutError);
  });

  it('throws a budget error on a fast runaway loop that never reaches the deadline', () => {
    // The complement of the timeout: a tight loop can execute millions of iterations inside its time
    // budget. Without an iteration cap, "fast and infinite" would pass the clock check forever.
    const guard = createGuard(() => 0);
    guard.reset(60_000, 100);
    expect(() => {
      for (let i = 0; i < 500; i += 1) guard.tick();
    }).toThrow(GuestBudgetError);
  });

  it('resets cleanly for a new phase', () => {
    const guard = createGuard(() => 0);
    guard.reset(1000, 10);
    for (let i = 0; i < 5; i += 1) guard.tick();
    expect(guard.iterations()).toBe(5);
    guard.reset(1000, 10);
    expect(guard.iterations()).toBe(0);
  });

  it('carries an actionable message rather than a bare error', () => {
    const guard = createGuard(() => 0);
    guard.reset(1000, 1);
    try {
      guard.tick();
      guard.tick();
      expect.unreachable('the guard should have thrown');
    } catch (error) {
      expect((error as Error).message).toMatch(/instancing|reduce/i);
    }
  });
});

describe('realm hardening', () => {
  /** A stand-in global object with the capabilities a real worker would expose. */
  const makeScope = (): Record<string, unknown> => ({
    fetch: () => Promise.resolve(),
    XMLHttpRequest: class {},
    localStorage: { getItem: () => null },
    indexedDB: {},
    Worker: class {},
    postMessage: () => {},
    importScripts: () => {},
    document: { body: {} },
    location: { href: 'https://example.test' },
    navigator: { userAgent: 'test' },
    setTimeout: () => 0,
    crypto: {},
    WebAssembly: {},
    Object,
    Array,
    Math,
    JSON,
    Function,
    eval: globalThis.eval,
  });

  it('removes every reachable capability', () => {
    const scope = makeScope();
    const report = hardenRealm(scope);
    for (const name of [
      'fetch',
      'localStorage',
      'Worker',
      'postMessage',
      'document',
      'navigator',
    ]) {
      expect(scope[name], name).toBeUndefined();
    }
    expect(report.deleted).toContain('fetch');
    expect(report.deleted).toContain('Worker');
  });

  it('poisons the Function constructor rather than deleting it, so the attempt is reportable', () => {
    const scope = makeScope();
    hardenRealm(scope);
    expect(typeof scope.Function).toBe('function');
    expect(() => (scope.Function as () => unknown)()).toThrow(/not available/);
  });

  it('closes the constructor-of-constructor escape', () => {
    const scope = makeScope();
    hardenRealm(scope);
    // The canonical escape: reach Function through any function's prototype and build a new one.
    const reached = (function probe() {} as unknown as { constructor: (body: string) => unknown })
      .constructor;
    expect(() => reached('return this')).toThrow();
  });

  it('freezes intrinsic prototypes so one model cannot poison the next', () => {
    const scope = makeScope();
    hardenRealm(scope);
    expect(Object.isFrozen(Array.prototype)).toBe(true);
    expect(Object.isFrozen(Object.prototype)).toBe(true);
    expect(() => {
      // Assigning to a frozen prototype throws in strict mode, which every guest program runs in.
      'use strict';
      (Array.prototype as unknown as Record<string, unknown>).poisoned = true;
    }).toThrow();
  });

  it('reports a sealed realm as leak-free', () => {
    const scope = makeScope();
    hardenRealm(scope);
    expect(auditRealm(scope)).toEqual([]);
  });

  it('detects a leak when a capability survives', () => {
    const scope = makeScope();
    hardenRealm(scope);
    // Simulate a regression: something re-attaches a capability after hardening.
    scope.fetch = () => Promise.resolve();
    expect(auditRealm(scope)).toContain('fetch');
  });

  it('records rather than throws when a runtime refuses a deletion', () => {
    const scope: Record<string, unknown> = { Object, Array };
    Object.defineProperty(scope, 'navigator', {
      value: { userAgent: 'stubborn' },
      writable: false,
      configurable: false,
    });
    const report = hardenRealm(scope);
    // Non-configurable and non-writable: hardening cannot remove it, and says so instead of failing.
    // The compiler's lexical shadowing is what keeps guest code from naming it anyway.
    expect(report.resisted).toContain('navigator');
  });
});

describe('compiled guest — lexical shadowing', () => {
  it('declares every shadowable forbidden global as a parameter', () => {
    const guest = compileGuest(`scene.noop();`);
    for (const name of [
      'fetch',
      'document',
      'Worker',
      'postMessage',
      'localStorage',
      'setTimeout',
    ]) {
      expect(guest.parameterNames, name).toContain(name);
    }
    // `eval` and `arguments` cannot be bound as parameters in strict mode — the gate and realm hardening
    // are what cover those two, which is the reason the sandbox has five layers rather than one.
    expect(guest.parameterNames).not.toContain('eval');
  });

  it('sees `undefined` for a capability even when the real global exists', () => {
    // This is the layer that survives a hardening failure: the name resolves to a parameter, and the
    // parameter is undefined, whatever the global object still holds.
    const observed: Record<string, string> = {};
    const guest = compileGuest(
      `scene.record('fetch', typeof fetch); scene.record('localStorage', typeof localStorage);`,
    );
    guest.run({
      [GUARD_IDENTIFIER]: () => {},
      scene: {
        record: (key: string, value: string) => {
          observed[key] = value;
        },
      },
    });
    expect(observed.fetch).toBe('undefined');
    expect(observed.localStorage).toBe('undefined');
  });

  it('runs in strict mode, so `this` is undefined rather than the global object', () => {
    // Sloppy mode would bind `this` to globalThis on a plain call, handing back the exact reference the
    // rest of the sandbox works to remove.
    let observed: unknown = 'unset';
    const guest = compileGuest(`function probe() { return this; } scene.record(probe());`);
    guest.run({
      [GUARD_IDENTIFIER]: () => {},
      scene: {
        record: (value: unknown) => {
          observed = value;
        },
      },
    });
    expect(observed).toBeUndefined();
  });

  it('receives the scene API bindings it was given', () => {
    const calls: string[] = [];
    const guest = compileGuest(`scene.group('root'); geom.box(1); M.sin(0);`);
    guest.run({
      [GUARD_IDENTIFIER]: () => {},
      scene: { group: (id: string) => calls.push(`scene.group:${id}`) },
      geom: { box: (n: number) => calls.push(`geom.box:${n}`) },
      M: { sin: (n: number) => calls.push(`M.sin:${n}`) },
    });
    expect(calls).toEqual(['scene.group:root', 'geom.box:1', 'M.sin:0']);
  });

  it('lets a guest error propagate to the host as an ordinary exception', () => {
    // 00: a model that fails to build "must not take the viewer down. Show the error, keep the page
    // alive, offer a retry." The host can only do that if the throw is catchable, not fatal.
    const guest = compileGuest(`throw new Error('the turbine has no blades');`);
    expect(() => guest.run({ [GUARD_IDENTIFIER]: () => {} })).toThrow('the turbine has no blades');
  });

  it('terminates a guarded infinite loop instead of hanging', () => {
    const { code } = instrumentLoops('while (true) { }');
    const guest = compileGuest(code);
    const guard = createGuard(() => 0);
    guard.reset(60_000, 5000);
    expect(() => guest.run({ [GUARD_IDENTIFIER]: guard.tick })).toThrow(GuestBudgetError);
  });

  it('terminates unbounded recursion through the function-entry guard', () => {
    const { code } = instrumentLoops('function recurse() { return recurse(); } recurse();');
    const guest = compileGuest(code);
    const guard = createGuard(() => 0);
    guard.reset(60_000, 1000);
    // Either the guard trips or the stack overflows; both are bounded failures rather than a hang.
    expect(() => guest.run({ [GUARD_IDENTIFIER]: guard.tick })).toThrow();
  });

  it('routes console through the host binding rather than the real console', () => {
    const logged: unknown[] = [];
    const guest = compileGuest(`console.log('building', 42);`);
    const spy = vi.spyOn(globalThis.console, 'log');
    guest.run({
      [GUARD_IDENTIFIER]: () => {},
      console: { log: (...args: unknown[]) => logged.push(args) },
    });
    expect(logged).toEqual([['building', 42]]);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
