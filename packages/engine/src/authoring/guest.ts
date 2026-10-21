/**
 * The guest runtime: the code that runs *inside* the sandbox, on the untrusted side of the boundary.
 *
 * This is the join between `@edu3d/sandbox` (which owns containment) and `@edu3d/engine` (which owns the scene
 * API). It exists as its own module because both hosts — the browser worker and the `node:vm` audit — need the
 * identical sequence, and a difference between them would mean the server approves models the viewer cannot run.
 *
 * The ordering below is the security design, not an implementation detail:
 *
 *   1. build the API facades and the guard **while the host still has `new Function`**;
 *   2. compile the guest program;
 *   3. **harden the realm** — delete capabilities, poison the constructor, freeze intrinsics;
 *   4. only then run the program.
 *
 * Step 3 after step 2 is the trick: the guest executes in a realm where the very facility used to create it no
 * longer exists (`PLAN.md` §A1).
 *
 * **Why this single-realm setup needs no capability membrane.** The guest and the engine live in ONE realm:
 * `scene`, `geom`, `mat`, `M`, `ctx` and part references are intrinsics of the *same* realm the guest code
 * compiles against, so every member-walk from a handed object bottoms out at the very intrinsics hardening
 * poisoned — `(facade).constructor` is this realm's `Function.prototype.constructor`, i.e. the poison, in both
 * its static and computed spellings (`p['cons'+'tru'+'ctor']` is folded and rejected by the static gate too).
 * There is no *host* capability set to leak, because there is no separate host: the objects handed in ARE the
 * guest realm's own frozen structures.
 *
 * The `node:vm` audit host cannot share that trick: its fresh intrinsics realm is a genuinely TWO-realm setup
 * where a handed object's prototype chain still leads to the HOST realm's un-poisoned `Function`. There the
 * boundary is enforced by the guest-facing *realm membrane* instead — `@edu3d/sandbox`'s `membraneScript()`,
 * consumed by `hosts/node-host.ts:createGuestContext` — which wraps everything the host hands over inside
 * the guest realm, deletes the raw payload channel, and throws on forbidden-name reads. The two hosts provide
 * the same *guarantee* through different mechanisms, which is exactly why `guest.ts` must never grow a second
 * untested path: the browser path is a single-realm property, and the binding table below
 * (`__edu3d_tick`, `scene`, `geom`, `mat`, `M`, `console`, `random`) is the same vocabulary the node host's
 * payload carries, so neither side can gain a capability the other never had.
 */
import { SANDBOX_LIMITS, type DeviceTier, type ModelManifest } from '@edu3d/contracts';
import {
  compileGuest,
  createGuard,
  GuestBudgetError,
  GuestTimeoutError,
  hardenRealm,
  type GuardHandle,
} from '@edu3d/sandbox';
import { SceneBuilder, SceneError } from './scene.ts';
import { GeometryError } from '../geometry/factory.ts';
import { MaterialError } from '../materials/factory.ts';
import * as M from '../math/index.ts';
import { createRandom } from '../math/index.ts';

/** A message the guest logged, routed to the diagnostics panel rather than to the real console. */
export interface GuestLogEntry {
  level: 'log' | 'warn' | 'error';
  message: string;
}

export interface AuthorOptions {
  /** Instrumented source. Never raw provider output — the gate and instrumentation run first. */
  code: string;
  /** Device tier, so the model can adapt its own detail if it chooses to. */
  tier: DeviceTier;
  /** Seed for the guest PRNG, so a build is reproducible (`02` R4, `08` memory tests). */
  seed: number;
  /** Wall-clock budget for the authoring pass. */
  deadlineMs?: number;
  /** Whether to harden the realm. False only in Node tests that must keep their own capabilities. */
  harden?: boolean;
  /** The global object to harden. Defaults to `globalThis`. */
  scope?: Record<string, unknown>;
}

export interface AuthorSuccess {
  ok: true;
  manifest: ModelManifest;
  /** Live builder, retained so the host can drive frames and parameter changes. */
  builder: SceneBuilder;
  logs: GuestLogEntry[];
  /** Milliseconds the pass took. */
  durationMs: number;
}

export interface AuthorFailure {
  ok: false;
  /** A sentence written for the model that will fix it, not for a stack-trace reader. */
  message: string;
  /** Guest-side stack, trimmed. Diagnostics only; never shown to a learner. */
  stack?: string;
  /** True when the deadline or the iteration budget stopped it, so the host can say "ran too long". */
  timedOut: boolean;
  logs: GuestLogEntry[];
  durationMs: number;
}

export type AuthorResult = AuthorSuccess | AuthorFailure;

/** Bounded console. A model that cannot log is a model nobody can debug, so it gets one — capped. */
function createConsole(logs: GuestLogEntry[]): Readonly<Record<string, unknown>> {
  const MAX_ENTRIES = 200;
  const MAX_LENGTH = 500;

  const record =
    (level: GuestLogEntry['level']) =>
    (...args: unknown[]): void => {
      if (logs.length >= MAX_ENTRIES) return;
      const message = args
        .map((arg) => {
          if (typeof arg === 'string') return arg;
          if (typeof arg === 'number' || typeof arg === 'boolean' || arg === null)
            return String(arg);
          if (arg === undefined) return 'undefined';
          try {
            // Depth-limited by JSON's own behaviour; a circular structure falls through to the catch.
            return JSON.stringify(arg)?.slice(0, MAX_LENGTH) ?? '[unserialisable]';
          } catch {
            return '[circular]';
          }
        })
        .join(' ')
        .slice(0, MAX_LENGTH);
      logs.push({ level, message });
    };

  return Object.freeze({ log: record('log'), warn: record('warn'), error: record('error') });
}

/**
 * Translate a guest exception into a message the repair pass can act on.
 *
 * `04` requires errors to be actionable, and the engine's own error classes already carry sentences written for a
 * generator. A raw `TypeError` does not, so it gets context added rather than being passed through — "cannot read
 * properties of undefined" tells a model nothing about which call it got wrong.
 */
function describeFailure(error: unknown): { message: string; stack?: string; timedOut: boolean } {
  if (error instanceof GuestTimeoutError || error instanceof GuestBudgetError) {
    return {
      message: error.message,
      timedOut: true,
      ...(error.stack ? { stack: error.stack.slice(0, 4000) } : {}),
    };
  }
  if (
    error instanceof SceneError ||
    error instanceof GeometryError ||
    error instanceof MaterialError
  ) {
    return {
      message: error.message,
      timedOut: false,
      ...(error.stack ? { stack: error.stack.slice(0, 4000) } : {}),
    };
  }
  if (error instanceof RangeError && /call stack/i.test(error.message)) {
    return {
      message:
        'The program recursed too deeply and overflowed the stack. Check for a function that calls itself without a base case.',
      timedOut: true,
      ...(error.stack ? { stack: error.stack.slice(0, 4000) } : {}),
    };
  }
  if (error instanceof Error) {
    return {
      message: `The model threw ${error.name}: ${error.message}. Check that every value used in the geometry is defined and finite.`,
      timedOut: false,
      ...(error.stack ? { stack: error.stack.slice(0, 4000) } : {}),
    };
  }
  return {
    message: `The model threw a non-error value: ${String(error).slice(0, 200)}.`,
    timedOut: false,
  };
}

/**
 * Run the authoring pass.
 *
 * Never throws. A hostile or broken program is a normal input, and `00` requires that "a model that fails to
 * build, crashes, or hangs must not take the viewer down. Show the error, keep the page alive, offer a retry." A
 * failure is therefore a returned value.
 */
export function authorModel(options: AuthorOptions): AuthorResult {
  const started = Date.now();
  const logs: GuestLogEntry[] = [];
  const builder = new SceneBuilder();
  builder.beginTiming();

  let guard: GuardHandle;
  let compiled: ReturnType<typeof compileGuest>;

  try {
    // Step 1 and 2: facades and compilation, while the host still holds `new Function`.
    guard = createGuard();
    compiled = compileGuest(options.code);
  } catch (error) {
    const described = describeFailure(error);
    builder.dispose();
    return {
      ok: false,
      message: described.message,
      ...(described.stack ? { stack: described.stack } : {}),
      timedOut: false,
      logs,
      durationMs: Date.now() - started,
    };
  }

  const random = createRandom(options.seed >>> 0);

  const bindings: Record<string, unknown> = {
    __edu3d_tick: guard.tick,
    scene: builder.createFacade(),
    geom: builder.geometry.createFacade(),
    mat: builder.materials.createFacade(),
    // The math namespace is frozen so a guest cannot replace `M.sin` and silently change every model that
    // shares this realm in the Node audit host.
    M: Object.freeze({ ...M }),
    console: createConsole(logs),
    random: Object.freeze({
      float: random.float,
      range: random.range,
      int: random.int,
      pick: random.pick,
      unitVector: random.unitVector,
    }),
  };

  // Step 3: harden. After compilation, before execution.
  if (options.harden !== false) {
    hardenRealm(options.scope ?? (globalThis as unknown as Record<string, unknown>));
  }

  guard.reset(options.deadlineMs ?? SANDBOX_LIMITS.buildDeadlineMs);

  try {
    // Step 4: run.
    compiled.run(bindings);
    const manifest = builder.toManifest();
    return { ok: true, manifest, builder, logs, durationMs: Date.now() - started };
  } catch (error) {
    const described = describeFailure(error);
    builder.dispose();
    return {
      ok: false,
      message: described.message,
      ...(described.stack ? { stack: described.stack } : {}),
      timedOut: described.timedOut,
      logs,
      durationMs: Date.now() - started,
    };
  }
}

/**
 * Drive one frame of a built model.
 *
 * Separate from `authorModel` because the frame budget is separate: `08` allows a long build and demands a short
 * frame, and a callback that overruns repeatedly gets the model paused with an explanation rather than killed
 * (`SANDBOX_LIMITS.frameOverrunLimit`).
 */
export function runFrame(
  builder: SceneBuilder,
  guard: GuardHandle,
  time: number,
  dt: number,
  paused: boolean,
): { ok: true } | { ok: false; message: string; timedOut: boolean } {
  guard.reset(SANDBOX_LIMITS.frameDeadlineMs, 2_000_000);
  try {
    builder.runFrame(time, dt, paused);
    return { ok: true };
  } catch (error) {
    const described = describeFailure(error);
    return { ok: false, message: described.message, timedOut: described.timedOut };
  }
}
