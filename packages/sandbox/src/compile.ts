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
import { FORBIDDEN_GLOBALS, GUEST_BINDINGS } from './forbidden.ts';
import { GUARD_IDENTIFIER } from './instrument.ts';

/** Thrown when guest code exceeds its wall-clock budget. Distinguished so the host can say "ran too long". */
export class GuestTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GuestTimeoutError';
  }
}

/** Thrown when guest code exceeds its iteration budget — a runaway loop that is fast but unbounded. */
export class GuestBudgetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GuestBudgetError';
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
