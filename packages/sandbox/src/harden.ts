/**
 * Realm hardening: layer 4 of the sandbox.
 *
 * Runs once, inside the guest realm, before any AI-written code is compiled. Everything the static gate
 * forbade by name is removed or poisoned here by capability, so the two layers fail independently — a
 * gate bug does not become an escape, and a hardening gap is still caught by the gate.
 *
 * The order of operations matters and is not obvious:
 *   1. delete the reachable capabilities, so nothing later can hand one out;
 *   2. poison `Function` and its constructor path, because that single reference is the classic
 *      one-line escape from every lexical protection above it;
 *   3. freeze the intrinsic prototypes *last*, since freezing `Object` first would prevent the deletions.
 *
 * `00-GOAL.md` frames the intent: "Containment, not prohibition. Give the AI full power over its own
 * scene and zero power over everything else."
 */
import { FROZEN_INTRINSICS, HOST_RETAINED_GLOBALS, REALM_DELETIONS } from './forbidden.ts';
// `REALM_DELETIONS` rather than `FORBIDDEN_GLOBALS`: the host half of the sandbox worker runs the render loop in
// this same realm, so it must keep its scheduler and its clock. Those names are still denied to guest code by the
// static gate and by the compiler's lexical shadowing — see `HOST_RETAINED_GLOBALS`.
// `hardeningScript` below embeds these same lists into a standalone script for the `node:vm` host, so the two
// realms are hardened from one definition rather than two that can drift.

/** What hardening actually managed to do, so a host can log a realm it could not fully seal. */
export interface HardeningReport {
  deleted: string[];
  poisoned: string[];
  frozen: string[];
  /** Names that resisted deletion — non-configurable properties on some runtimes. */
  resisted: string[];
}

/**
 * Marker installed on every poisoned stand-in.
 *
 * `auditRealm` needs to tell "this capability leaked" from "this capability was deliberately replaced by
 * a thrower", and calling it to find out is not an option for something like `postMessage`. A brand is
 * the cheapest honest answer.
 */
/** The registry key, shared with the generated script so both hosts brand poisons identically. */
const POISON_BRAND_KEY = 'edu3d.sandbox.poisoned';
const POISON_BRAND = Symbol.for(POISON_BRAND_KEY);

/**
 * A thrower installed in place of a capability.
 *
 * Poisoning rather than deleting is deliberate for the dynamic-code path: `typeof Function` returning
 * `'undefined'` would let a probing program branch quietly, whereas a throw on *use* surfaces the
 * attempt as a reportable guest error the diagnostics panel can show.
 */
const poison = (name: string): (() => never) => {
  const thrower = function forbidden(): never {
    throw new TypeError(`${name} is not available inside the model sandbox.`);
  };
  // A poisoned function must not itself be a route back to the constructor.
  Object.defineProperty(thrower, 'prototype', { value: undefined, writable: false });
  Object.defineProperty(thrower, POISON_BRAND, { value: true, enumerable: false });
  return thrower as unknown as () => never;
};

/** True when a value is one of this module's throwers rather than a live capability. */
const isPoisoned = (value: unknown): boolean =>
  typeof value === 'function' &&
  (value as unknown as Record<symbol, unknown>)[POISON_BRAND] === true;

/**
 * Seal the current realm.
 *
 * Written to run in a Worker or in a `node:vm` context with the same code path, because the headless
 * audit must have exactly the capability set the browser guest has. A difference between the two would
 * mean the server approves models the viewer cannot run, or vice versa.
 */
export function hardenRealm(scope: Record<string, unknown>): HardeningReport {
  const report: HardeningReport = { deleted: [], poisoned: [], frozen: [], resisted: [] };

  // ── 1. Remove reachable capabilities ──────────────────────────────────────
  for (const name of REALM_DELETIONS) {
    if (!(name in scope)) continue;
    try {
      const descriptor = Object.getOwnPropertyDescriptor(scope, name);
      if (descriptor && !descriptor.configurable) {
        // Non-configurable and writable: overwrite rather than delete. `navigator` behaves this way in
        // some worker implementations, and leaving it intact would leak user-agent data at minimum.
        if (descriptor.writable) {
          scope[name] = undefined;
          report.deleted.push(name);
        } else {
          report.resisted.push(name);
        }
        continue;
      }
      delete scope[name];
      report.deleted.push(name);
    } catch {
      // A runtime that refuses the delete is recorded, not fatal: the lexical shadowing in the compiler
      // still prevents guest code from naming it, and the gate rejected the name already.
      report.resisted.push(name);
    }
  }

  // ── 2. Poison the dynamic-code path ───────────────────────────────────────
  // `Function` cannot simply be deleted: it is the prototype's `constructor`, and every function object
  // reaches it. Poisoning the constructor property is what closes `(function(){}).constructor('…')`.
  try {
    const functionPrototype = Function.prototype as unknown as Record<string, unknown>;
    Object.defineProperty(functionPrototype, 'constructor', {
      value: poison('Function'),
      writable: false,
      enumerable: false,
      configurable: false,
    });
    report.poisoned.push('Function.prototype.constructor');
  } catch {
    report.resisted.push('Function.prototype.constructor');
  }

  for (const name of ['Function', 'eval']) {
    try {
      Object.defineProperty(scope, name, {
        value: poison(name),
        writable: false,
        enumerable: false,
        configurable: false,
      });
      report.poisoned.push(name);
    } catch {
      report.resisted.push(name);
    }
  }

  // Async and generator function constructors are reachable through their instances the same way.
  try {
    const asyncCtor = Object.getPrototypeOf(async function noop() {}) as Record<string, unknown>;
    Object.defineProperty(asyncCtor, 'constructor', {
      value: poison('AsyncFunction'),
      writable: false,
      configurable: false,
    });
    report.poisoned.push('AsyncFunction');
  } catch {
    report.resisted.push('AsyncFunction');
  }

  try {
    const generatorCtor = Object.getPrototypeOf(function* noop() {}) as Record<string, unknown>;
    Object.defineProperty(generatorCtor, 'constructor', {
      value: poison('GeneratorFunction'),
      writable: false,
      configurable: false,
    });
    report.poisoned.push('GeneratorFunction');
  } catch {
    report.resisted.push('GeneratorFunction');
  }

  // ── 3. Freeze intrinsics ──────────────────────────────────────────────────
  // Not to protect the guest from itself, but to protect the *next* guest: the Node audit host reuses a
  // realm across builds, and a model that patched `Array.prototype.map` would silently change how every
  // later model behaves. Freezing makes the realm's starting state a constant.
  for (const name of FROZEN_INTRINSICS) {
    const intrinsic = scope[name] as { prototype?: object } | undefined;
    if (!intrinsic) continue;
    try {
      if (intrinsic.prototype) Object.freeze(intrinsic.prototype);
      Object.freeze(intrinsic);
      report.frozen.push(name);
    } catch {
      report.resisted.push(`${name}.prototype`);
    }
  }

  return report;
}

/**
 * The same hardening, emitted as a self-contained script.
 *
 * Needed because the Node audit host hardens a *different realm* — a `node:vm` context with its own intrinsics —
 * and a function shipped across that boundary by `toString()` would arrive without its module-scoped constant
 * lists. Generating a script that embeds the lists keeps one source of truth for *what* is removed, which is the
 * property that matters: if the browser guest and the audit guest had different capability sets, the server would
 * approve models the viewer cannot run.
 *
 * The script is generated rather than hand-written for the same reason. Adding a name to `REALM_DELETIONS`
 * updates both hosts at once.
 */
export function hardeningScript(): string {
  // `this` at the top level of a sloppy-mode script is the realm's global object. Used deliberately instead of
  // `globalThis`, because `globalThis` is itself on the forbidden list — a host that shadows it before hardening
  // would leave this script dereferencing `undefined`, and every capability would survive.
  return `(function(scope){
  'use strict';
  var forbidden = ${JSON.stringify(REALM_DELETIONS)};
  var intrinsics = ${JSON.stringify(FROZEN_INTRINSICS)};
  var brand = Symbol.for(${JSON.stringify(POISON_BRAND_KEY)});

  function poison(name) {
    var thrower = function forbiddenCapability() {
      throw new TypeError(name + ' is not available inside the model sandbox.');
    };
    try {
      Object.defineProperty(thrower, 'prototype', { value: undefined, writable: false });
      Object.defineProperty(thrower, brand, { value: true, enumerable: false });
    } catch (error) { void error; }
    return thrower;
  }

  // 1. Remove reachable capabilities.
  for (var i = 0; i < forbidden.length; i++) {
    var name = forbidden[i];
    if (!(name in scope)) continue;
    try {
      var descriptor = Object.getOwnPropertyDescriptor(scope, name);
      if (descriptor && !descriptor.configurable) {
        if (descriptor.writable) scope[name] = undefined;
      } else {
        delete scope[name];
      }
    } catch (error) { void error; }
  }

  // 2. Poison the dynamic-code path. Function is reachable from every function object's constructor, so the
  //    property is replaced rather than the global alone.
  try {
    Object.defineProperty(Function.prototype, 'constructor', {
      value: poison('Function'),
      writable: false,
      enumerable: false,
      configurable: false,
    });
  } catch (error) { void error; }

  var dynamic = ['Function', 'eval'];
  for (var d = 0; d < dynamic.length; d++) {
    try {
      Object.defineProperty(scope, dynamic[d], {
        value: poison(dynamic[d]),
        writable: false,
        enumerable: false,
        configurable: false,
      });
    } catch (error) { void error; }
  }

  try {
    var asyncCtor = Object.getPrototypeOf(async function noop() {});
    Object.defineProperty(asyncCtor, 'constructor', { value: poison('AsyncFunction'), configurable: false });
  } catch (error) { void error; }
  try {
    var generatorCtor = Object.getPrototypeOf(function* noop() {});
    Object.defineProperty(generatorCtor, 'constructor', { value: poison('GeneratorFunction'), configurable: false });
  } catch (error) { void error; }

  // 3. Freeze intrinsics last: freezing Object first would prevent the deletions above.
  for (var k = 0; k < intrinsics.length; k++) {
    var intrinsic = scope[intrinsics[k]];
    if (!intrinsic) continue;
    try {
      if (intrinsic.prototype) Object.freeze(intrinsic.prototype);
      Object.freeze(intrinsic);
    } catch (error) { void error; }
  }
})(this);`;
}

/**
 * Verify a realm is sealed.
 *
 * Exists so the adversarial suite asserts the *result* rather than the procedure: a refactor that stops
 * deleting something still fails this check. `02`'s standard applied to the sandbox — verify it, do not
 * assume it.
 */
export function auditRealm(scope: Record<string, unknown>): string[] {
  const leaks: string[] = [];

  for (const name of REALM_DELETIONS) {
    const value = scope[name];
    // A poisoned stand-in is the intended end state, not a leak: it throws on use and reports the attempt.
    if (isPoisoned(value)) continue;
    if (value !== undefined && name in scope) leaks.push(name);
  }

  try {
    const escaped = (function escapeAttempt() {} as unknown as { constructor: unknown })
      .constructor;
    if (typeof escaped === 'function') {
      try {
        (escaped as (body: string) => () => unknown)('return 1')();
        leaks.push('Function.prototype.constructor');
      } catch {
        // Throwing is the expected outcome: the poison is in place.
      }
    }
  } catch {
    // Reaching the constructor at all threw, which is stronger than the poison. Nothing to report.
  }

  if (!Object.isFrozen(Object.prototype)) leaks.push('Object.prototype not frozen');
  if (!Object.isFrozen(Array.prototype)) leaks.push('Array.prototype not frozen');

  return leaks;
}
