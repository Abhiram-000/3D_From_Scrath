/**
 * The compiler: layer 3 of the sandbox.
 *
 * Takes gated, instrumented source and produces a callable. Two things happen here that no other layer
 * can do:
 *
 * 1. **Lexical shadowing.** Every forbidden name is declared as a parameter of the compiled function and
 *    passed `undefined`. That shadows the name inside the guest's entire lexical scope regardless of what
 *    still exists on the global object — so even a runtime that refused to delete `navigator`, or a
 *    hardening step that ran incompletely, cannot expose it to guest code. This is the layer that makes
 *    the others' failures survivable.
 *
 * 2. **The deadline guard.** The `__edu3d_tick` function the instrumentation calls is created here and
 *    closes over a monotonic deadline, so termination is enforced by wall clock inside the guest rather
 *    than only by the host's kill switch.
 *
 * The compiled function is built with `new Function` *before* the realm is hardened. That ordering is the
 * whole trick: the host compiles while it still has the constructor, then poisons it, so the guest runs in
 * a realm where the very facility used to create it no longer exists.
 */
import { SANDBOX_LIMITS } from '@edu3d/contracts';
import { FORBIDDEN_GLOBALS, FORBIDDEN_MEMBERS, GUEST_BINDINGS } from './forbidden.ts';
import { GUARD_IDENTIFIER } from './instrument.ts';

/** Thrown when guest code exceeds its wall-clock budget. Distinguished so the host can say "ran too long". */
export class GuestTimeoutError extends Error {
  /** Class field: thrown inside the hardened realm, so it must not assign through the frozen prototype. */
  override name = 'GuestTimeoutError';
  constructor(message: string) {
    super(message);
  }
}

/** Thrown when guest code exceeds its iteration budget — a runaway loop that is fast but unbounded. */
export class GuestBudgetError extends Error {
  /** Class field: thrown inside the hardened realm, so it must not assign through the frozen prototype. */
  override name = 'GuestBudgetError';
  constructor(message: string) {
    super(message);
  }
}

/**
 * The channel over which the node host hands raw capabilities into a `node:vm` realm.
 *
 * The host stashes the raw bindings under this key in the context sandbox; the membrane (below)
 * consumes the payload inside the guest realm, installs guest-facing stand-ins, and deletes the channel
 * before any guest statement can execute. A `\u0000` prefix makes name collision with real API
 * vocabulary impossible: no model source can spell this name as an identifier, and after the membrane
 * runs the key is gone from the global object anyway — the membrane *fails closed* (throws, rejecting
 * the build) when deletion did not succeed.
 *
 * A string, not a symbol: `vm.createContext` reliably contextifies string-keyed sandbox properties, and
 * cross-realm symbol identity would be a dependency the next Node runtime may renegotiate.
 */
export const GUEST_SURFACE_KEY = '\u0000edu3d.sandbox.guest-surface';

/**
 * Thrown when the realm's guest-facing surface could not be assembled at all.
 *
 * Deliberately not a `TypeError`, so the node host's failure classifier reports it as an infrastructure
 * fault (the sandbox itself is broken) rather than as an instruction for the repair pass (the *model*
 * did something wrong).
 */
export class MembraneError extends Error {
  /** Class field, for the same realm-boundary reason as the guard errors above. */
  override name = 'MembraneError';
  constructor(message: string) {
    super(message);
  }
}

export interface GuardHandle {
  /** The function the instrumented source calls at every loop iteration and function entry. */
  tick: () => void;
  /** Restart the clock for a new phase (build, then each frame) without rebuilding the guest. */
  reset: (budgetMs: number, maxIterations?: number) => void;
  /** Iterations counted since the last reset; surfaced in diagnostics as a runaway signal. */
  iterations: () => number;
}

/**
 * Create the deadline guard.
 *
 * `now` is injected so tests can drive time deterministically instead of sleeping — a suite that must
 * wait two seconds to prove a timeout is a suite people stop running.
 */
export function createGuard(now: () => number = () => Date.now()): GuardHandle {
  let deadline = Number.POSITIVE_INFINITY;
  // Annotated because `SANDBOX_LIMITS` is frozen, so its properties infer as literal types and the
  // counter would otherwise be typed as the single number it started at.
  let remaining: number = SANDBOX_LIMITS.maxLoopIterations;
  let counted = 0;

  /**
   * Time is checked every N iterations, not every iteration.
   *
   * `Date.now()` at 20 million iterations per build would itself dominate the budget it is protecting.
   * 2048 is small enough that an overrun is caught within microseconds of real work and large enough
   * that the check disappears into the loop's own cost.
   */
  const TIME_CHECK_MASK = 2047;

  const tick = (): void => {
    counted += 1;
    remaining -= 1;
    if (remaining <= 0) {
      throw new GuestBudgetError(
        `The model exceeded ${SANDBOX_LIMITS.maxLoopIterations} loop iterations. Reduce the loop bounds or generate the repetition with instancing.`,
      );
    }
    if ((counted & TIME_CHECK_MASK) === 0 && now() > deadline) {
      throw new GuestTimeoutError(
        'The model took too long to build. Simplify the geometry or reduce procedural detail.',
      );
    }
  };

  return {
    tick,
    reset: (budgetMs: number, maxIterations = SANDBOX_LIMITS.maxLoopIterations) => {
      deadline = now() + budgetMs;
      remaining = maxIterations;
      counted = 0;
    },
    iterations: () => counted,
  };
}

export interface CompiledGuest {
  /** Runs the program with the given API bindings. Throws guest errors; never returns a value. */
  run: (bindings: Record<string, unknown>) => void;
  /** Names the compiled function accepts, in order. Exposed for the adversarial suite to assert against. */
  parameterNames: readonly string[];
}

/**
 * Names that cannot be shadowed by a parameter.
 *
 * Strict mode forbids binding `eval` and `arguments` at all — `new Function('eval', ...)` is itself a
 * SyntaxError. They are therefore the two capabilities the compiler *cannot* protect, which is exactly
 * why the other layers exist: the gate rejects any program that names either, and realm hardening
 * poisons both so a reference that somehow arrives throws instead of evaluating.
 */
const UNSHADOWABLE = new Set(['eval', 'arguments']);

/**
 * Compile instrumented guest source.
 *
 * Uses `new Function` rather than the realm's (poisoned) constructor because the host calls this before
 * hardening. `'use strict'` is prepended for a security reason, not a style one: sloppy mode would give
 * the guest a `this` bound to the global object on any plain function call, handing back the exact
 * reference every other layer works to remove.
 */
export function compileGuest(instrumentedSource: string): CompiledGuest {
  const shadowed = FORBIDDEN_GLOBALS.filter(
    (name) => /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) && !UNSHADOWABLE.has(name),
  );
  const parameterNames = [GUARD_IDENTIFIER, ...GUEST_BINDINGS, ...shadowed];

  const body = `'use strict';\n${instrumentedSource}\n`;

  // The one legitimate `new Function` in the platform. It runs on the *host* side of the boundary, before
  // realm hardening poisons the constructor — that ordering is the trick that lets the guest execute in a
  // realm where the facility used to create it no longer exists.
  const factory = new Function(...parameterNames, body) as (...args: unknown[]) => void;

  return {
    parameterNames,
    run: (bindings: Record<string, unknown>) => {
      const args = parameterNames.map((name) => {
        if (name in bindings) return bindings[name];
        // Everything not explicitly provided arrives as `undefined`: that *is* the shadowing.
        return undefined;
      });
      // `.call` with an explicit `undefined` receiver: in strict mode `this` stays undefined rather than
      // becoming the global object, which would hand back the exact reference the sandbox removes.
      factory.call(undefined, ...args);
    },
  };
}

/**
 * The guest-facing capability membrane for the `node:vm` realm.
 *
 * Why this exists at all. The browser guest runs the engine and the model in ONE realm with one
 * intrinsic set, so hardening's poisoned `Function.prototype.constructor` covers every escape through a
 * handed object. The Node audit host cannot share the process's realm (freezing the server's own
 * `Object.prototype` would break every library in the process), so it creates a *fresh intrinsics realm*
 * with `vm.createContext` — and hands the engine's objects into it. Historically it handed them raw:
 * `scene.describe['cons' + 'tru' + 'ctor']` reached the HOST realm's `Function` through the frozen
 * facade, bypassing the guest realm's poisoning entirely, and `F('return process')()` handed out the
 * auditor's process. `codeGeneration: { strings: false }` does not help — it blocks *string→code*, not
 * calling a host constructor reached through a leaked host object. The realm boundary was a suggestion;
 * this script is where it becomes a boundary.
 *
 * What it does, once per context, before any guest code runs:
 *
 *   1. Reads the raw capability payload the host stashed under `GUEST_SURFACE_KEY`.
 *   2. For every value in it, fabricates a **guest-realm stand-in** and installs it as a read-only,
 *      non-configurable global binding: null-prototype objects whose property reads are accessors into
 *      the twin (so `ctx.time` stays *live*), null-prototype functions that translate arguments and wrap
 *      results, and read-only guest-realm copies of host arrays. Every read on a stand-in goes through a
 *      guest-realm getter, so the membrane can answer "no" — with a *reportable*, classifiable guest
 *      error — exactly where static hardening only covers globals and members of the realm's intrinsics.
 *   3. Maintains the identity map in both directions with WeakMaps: `host twin ↔ guest stand-in`.
 *      Because the engine REUSES the frame context and part references across frames, the wrappers are
 *      created once and the steady-state per-frame path becomes plain WeakMap hits — zero allocations,
 *      which is what the frame-cost budget requires a wrapper layer that touches `ctx` to prove.
 *   4. Deletes the payload channel and *fails closed* if the deletion did not take, throwing before any
 *      guest code can run.
 *
 * Values are classified by the realm that made them, verified *structurally* (prototype identity
 * comparison against this realm's `Object.prototype`/`Array.prototype`), because `instanceof` cannot
 * classify across realms and `Array.isArray` says nothing about realm of origin:
 *
 *   - **Primitives** pass through untouched; the frame path (`M.lerp`, `random.range`, `ctx.time`) is
 *     made of them, and copying them would only burn the scavenge budget.
 *   - **Guest-realm plain objects/arrays** pass through by reference *unless a twin hides inside* —
 *     `scene.mesh({ geometry: <twistedHandle> })` must reach the factory's WeakMap by host identity, so
 *     specs are scanned and, only when a twin is found, copied with twins replaced (copy-on-write:
 *     ordinary specs `{ width: 2, height: 3 }` stay allocation-free, and specs only travel at build
 *     time anyway).
 *   - **Host objects/bindings** (facades, `M`, the frame context, part references, host arrays returned
 *     from `M`) never reach the guest as themselves: objects become wrappers, arrays become read-only
 *     guest copies, functions become wrappers.
 *   - **Host `Error`s** thrown by engine code are re-materialised inside the guest realm (name, message
 *     and stack copied) so a guest `try/catch` sees a *guest* error and the host-side classifier
 *     (`describeFailure`) still sees `SceneError` by name. Host `Error` objects — whose prototype
 *     chains lead to the host's — never bridge as themselves.
 *
 * Every stand-in carries **accessor throwers for every name in `FORBIDDEN_MEMBERS` and
 * `FORBIDDEN_GLOBALS`**, enumerable-false so `Object.keys` looks like the API it is. That is the
 * runtime completion of the static gate: the gate rejects un-resolvable computed keys on the capability
 * surface, but a *pure-local* value obtained from it (`const p = ctx.part('a'); p[kArr[i]]`) is a form
 * the gate cannot see — on the wrapper, it now throws instead of reading indefinitely.
 *
 * The script is GENERATED, not imported: like `hardeningScript`, it must run in a realm whose module
 * scope it never had, and one source of truth means a new forbidden name updates every host at once.
 */
export function membraneScript(): string {
  return [
    '/* Generated by membraneScript() — @edu3d/sandbox.',
    '   Consumes the raw capability payload parked under GUEST_SURFACE_KEY, fabricates',
    '   guest-realm stand-ins for each binding, then deletes the payload channel before',
    '   guest code runs (fail closed). One source of truth with hardeningScript: the',
    '   forbidden-name lists are embedded from the same constants the gate rejects by. */',
    '(function (global) {',
    "  'use strict';",
    `  var SEED = ${JSON.stringify(GUEST_SURFACE_KEY)};`,
    `  var MEMBERS = ${JSON.stringify(FORBIDDEN_MEMBERS)};`,
    `  var GLOBALS = ${JSON.stringify(FORBIDDEN_GLOBALS)};`,
    '  var memberBlock = new Set(MEMBERS);',
    '  var globalBlock = new Set(GLOBALS);',
    '  var gObjectProto = Object.prototype;',
    '  var gArrayProto = Array.prototype;',
    '  var gFunctionProto = Function.prototype;',
    '  var MAX_TWINS = 6; // max cross-realm data nesting depth; past it, fail closed',
    '  // The identity maps. Closure-scoped: unreachable from guest code and collectable per build,',
    '  // because node:vm builds are one-context-per-model.',
    '  var objectTwins = new WeakMap();   // host object → stand-in',
    '  var functionTwins = new WeakMap(); // host function → stand-in (standalone wrappers)',
    '  var methodTwins = new WeakMap();   // owner → WeakMap(fn → stand-in)',
    '  var wrappers = new WeakMap();      // guest stand-in → host twin (the unwrap direction)',
    '  var callbacks = new WeakMap();     // guest function → host-callable bridge',
    '  function memberBlocked(name) {',
    "    return function blockedMember() { throw new TypeError('Accessing \"' + name + '\" on the scene surface is not allowed: the sandbox folds computed keys before checking them, and this name reaches the runtime intrinsics.'); };",
    '  }',
    '  function globalBlocked(name) {',
    "    return function blockedGlobal() { throw new TypeError('\"' + name + '\" is not available inside the model sandbox. Use only the scene API the model received: scene, geom, mat, M, console, random.'); };",
    '  }',
    '  function blockWraps(target, isFunction) {',
    '    for (var m = 0; m < MEMBERS.length; m++) addBlocker(target, MEMBERS[m], memberBlocked(MEMBERS[m]), isFunction);',
    '    for (var g = 0; g < GLOBALS.length; g++) addBlocker(target, GLOBALS[g], globalBlocked(GLOBALS[g]), false);',
    '  }',
    '  function addBlocker(target, name, thrower, isFunctionPrototype) {',
    "    // A function's own `prototype` is { writable: true, configurable: false } per spec — it can never be",
    '    // replaced by an accessor. On function wrappers it therefore stays the data property it was born',
    '    // with: reads give undefined (harmless — `new wrapper()` would fall back to a plain GUEST-realm',
    '    // object), writes fail on the freeze. Object wrappers get the full thrower set.',
    '    if (isFunctionPrototype && name === "prototype") return;',
    '    Object.defineProperty(target, name, { get: thrower, set: thrower, enumerable: false, configurable: false });',
    '  }',
    '  // Host EngineError → guest-realm Error replica: name, message, stack copied. Host errors — whose',
    '  // prototype chain is the host realm — never cross as themselves, and the failure classifier sees',
    '  // SceneError/GeometryError/MaterialError by name either way.',
    '  function replicaOf(error) {',
    '    if (error === null || error === undefined) return new Error(String(error));',
    "    var message = typeof error.message === 'string' && error.message.length > 0 ? error.message : String(error);",
    '    var replica = new Error(message);',
    '    if (error instanceof Error) {} // pointless in this realm — checked structurally below',
    "    if (typeof error.name === 'string' && error.name.length > 0) {",
    "      Object.defineProperty(replica, 'name', { value: error.name, writable: false, enumerable: true, configurable: false });",
    '    }',
    "    if (typeof error.stack === 'string') replica.stack = error.stack;",
    '    return replica;',
    '  }',
    '  function throwAttempt() { throw new TypeError("Cross-realm value rejected: an object that was never wrapped leaked to the guest, or a value is being handed back to the host without an unwrap path."); }',
    '  // ── Host → guest direction ───────────────────────────────────────────────',
    '  function hostToGuest(value, depth) {',
    '    if (value === null || value === undefined) return value;',
    '    var type = typeof value;',
    "    if (type !== 'object' && type !== 'function') return value;",
    '    var cached = objectTwins.get(value) || functionTwins.get(value);',
    '    if (cached !== undefined) return cached;',
    "    if (type === 'function') return makeFunctionWrapper(value, undefined);",
    '    if (depth > MAX_TWINS) throw throwAttempt();',
    '    if (Array.isArray(value)) {',
    '      var copy = [];',
    '      for (var i = 0; i < value.length; i++) copy.push(hostToGuest(value[i], depth + 1));',
    '      return copy;',
    '    }',
    '    return hostWrapper(value);',
    '  }',
    '  function hostWrapper(hostObj) {',
    '    var cached = objectTwins.get(hostObj);',
    '    if (cached !== undefined) return cached;',
    '    var wrapper = Object.create(null);',
    '    var keys = Object.keys(hostObj);',
    '    for (var i = 0; i < keys.length; i++) (function (key) {',
    '      Object.defineProperty(wrapper, key, {',
    '        get: function () { return memberToGuest(hostObj, key); },',
    "        set: function () { throw new TypeError('Scene API state is read-only from the model. Change state through the API: ctx.part(id).setPosition(...), scene.onFrame(...).'); },",
    '        enumerable: true,',
    '        configurable: false',
    '      });',
    '    })(keys[i]);',
    '    blockWraps(wrapper, false);',
    '    blockSetFreeze(wrapper);',
    '    objectTwins.set(hostObj, wrapper);',
    '    wrappers.set(wrapper, hostObj);',
    '    return wrapper;',
    '  }',
    '  function memberToGuest(owner, key) {',
    '    var value = owner[key];',
    '    var type = typeof value;',
    "    if (type === 'function') return methodWrapper(owner, value);",
    "    if (type !== 'object' || value === null) return value; // data props (M.PI, ctx.time — live re-read) pass through",
    '    return hostToGuest(value, 0);',
    '  }',
    '  function methodWrapper(owner, hostFn) {',
    '    var ownerMap = methodTwins.get(owner);',
    '    if (ownerMap === undefined) { ownerMap = new WeakMap(); methodTwins.set(owner, ownerMap); }',
    '    var cached = ownerMap.get(hostFn);',
    '    if (cached !== undefined) return cached;',
    '    var wrapper = makeFunctionWrapper(hostFn, owner);',
    '    ownerMap.set(hostFn, wrapper);',
    '    return wrapper;',
    '  }',
    '  function makeFunctionWrapper(hostFn, owner) {',
    '    if (owner === undefined) {',
    '      var cached = functionTwins.get(hostFn);',
    '      if (cached !== undefined) return cached;',
    '    }',
    '    var wrapper = function wrapped() {',
    '      var n = arguments.length;',
    '      var out;',
    '      try {',
    '        if (n === 0) {',
    '          out = hostFn.call(owner);',
    '        } else if (n === 1) {',
    '          out = hostFn.call(owner, unwrap(arguments[0], 0));',
    '        } else {',
    '          var args = new Array(n);',
    '          for (var i = 0; i < n; i++) args[i] = unwrap(arguments[i], 0);',
    '          out = hostFn.apply(owner, args);',
    '        }',
    '      } catch (error) { throw replicaOf(error); }',
    '      return hostToGuest(out, 0);',
    '    };',
    '    Object.defineProperty(wrapper, "name", { value: String(hostFn.name || ""), writable: false, enumerable: false, configurable: false });',
    '    Object.defineProperty(wrapper, "length", { value: typeof hostFn.length === "number" ? hostFn.length : 0, writable: false, enumerable: false, configurable: false });',
    '    Object.setPrototypeOf(wrapper, null);',
    // 'prototype' is STILL configurable at this point: blockWraps replaces it with a throwing accessor,
    // which both blocks reads and makes `new wrapper()` fail (the accessor throws inside the constructor
    // path). Sealing it as a data property first would make the blocker un-installable.
    '    blockWraps(wrapper, true);',
    '    blockSetFreeze(wrapper);',
    '    wrappers.set(wrapper, hostFn);',
    '    if (owner === undefined) functionTwins.set(hostFn, wrapper);',
    '    return wrapper;',
    '  }',
    '  function blockSetFreeze(target) {',
    '    // Wrappers are sealed twice-checked: freeze guards setPrototypeOf (frozen implies non-extensible)',
    '    // AND prevents guests from defineProperty-ing their own members on the scene surface.',
    '    Object.freeze(target);',
    '  }',
    '  // ── Guest → host direction ───────────────────────────────────────────────',
    '  function unwrap(value, depth) {',
    '    if (value === null || value === undefined) return value;',
    '    var type = typeof value;',
    "    if (type !== 'object' && type !== 'function') return value;",
    '    if (wrappers.has(value)) return wrappers.get(value); // a guest stand-in → its host twin',
    "    if (type === 'function') return bridge(value); // guest callback → host-callable bridge",
    '    if (depth > MAX_TWINS) throw throwAttempt();',
    '    var proto = Object.getPrototypeOf(value);',
    '    var isGuestObject = Array.isArray(value) ? proto === gArrayProto : (proto === gObjectProto || proto === null);',
    '    if (isGuestObject) {',
    '      if (!containsTwin(value, depth)) return value; // plain guest spec: pass-through, zero copies',
    '      if (Array.isArray(value)) {',
    '        var copy = [];',
    '        for (var i = 0; i < value.length; i++) copy.push(unwrap(value[i], depth + 1));',
    '        return copy;',
    '      }',
    '      var result = {};',
    '      var keys = Object.keys(value);',
    '      for (var k = 0; k < keys.length; k++) result[keys[k]] = unwrap(value[keys[k]], depth + 1);',
    '      return result;',
    '    }',
    '    throw throwAttempt();',
    '  }',
    '  function containsTwin(value, depth) {',
    '    if (value === null || value === undefined) return false;',
    '    var type = typeof value;',
    "    if (type === 'function') return wrappers.has(value);",
    "    if (type !== 'object') return false;",
    '    if (wrappers.has(value)) return true;',
    '    var proto = Object.getPrototypeOf(value);',
    '    var guest = Array.isArray(value) ? proto === gArrayProto : (proto === gObjectProto || proto === null);',
    '    if (!guest) return false;',
    '    if (depth > MAX_TWINS) throw throwAttempt();',
    '    var keys = Array.isArray(value) ? value.length : Object.keys(value);',
    '    for (var i = 0; Array.isArray(value) ? i < value.length : i < keys.length; i++) {',
    '      if (containsTwin(Array.isArray(value) ? value[i] : value[keys[i]], depth + 1)) return true;',
    '    }',
    '    return false;',
    '  }',
    '  // Guest callbacks: bridge INTO the guest, host→guest args. Guest faults propagate as-is (the host',
    '  // classifier duck-types errors across realms already).',
    '  function bridge(guestFn) {',
    '    var cached = callbacks.get(guestFn);',
    '    if (cached !== undefined) return cached;',
    '    var bridged = function bridged() {',
    '      var n = arguments.length;',
    '      try {',
    '        if (n === 0) return unwrap(guestFn.call(undefined), 0);',
    '        if (n === 1) return unwrap(guestFn.call(undefined, hostToGuest(arguments[0], 0)), 0);',
    '        var args = new Array(n);',
    '        for (var i = 0; i < n; i++) args[i] = hostToGuest(arguments[i], 0);',
    '        return unwrap(guestFn.apply(undefined, args), 0);',
    '      } catch (error) { throw error; }',
    '    };',
    '    callbacks.set(guestFn, bridged);',
    '    return bridged;',
    '  }',
    '  // ── Install the guest surface, consume the payload, fail closed ──────────',
    '  var seed = global[SEED];',
    '  if (seed === undefined || seed === null || typeof seed !== "object") {',
    '    throw new Error("edu3d membrane: capability payload missing from the realm seed. The sandbox assembly is broken, not the model.");',
    '  }',
    '  var names = Object.keys(seed);',
    '  for (var s = 0; s < names.length; s++) {',
    '    var name = names[s];',
    '    if (SEED === name) continue;',
    '    var raw = seed[name];',
    '    var type = typeof raw;',
    '    var standIn;',
    "    if (type === 'function') standIn = makeFunctionWrapper(raw, undefined);",
    "    else if (type === 'object' && raw !== null) standIn = hostToGuest(raw, 0);",
    '    else standIn = raw;',
    '    Object.defineProperty(global, name, { value: standIn, writable: false, enumerable: true, configurable: false });',
    '  }',
    '  delete global[SEED];',
    '  if (SEED in global) {',
    '    throw new Error("edu3d membrane: the capability payload channel could not be deleted; refusing to run guest code against a leaked capability list.");',
    '  }',
    '})(this);',
  ].join('\n');
}
