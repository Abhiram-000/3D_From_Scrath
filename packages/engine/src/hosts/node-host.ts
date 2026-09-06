/**
 * The Node host: runs a guest program in a fresh `node:vm` context, with no DOM and no GPU.
 *
 * This is what makes the audit in `04-BACKEND.md` stage 4 possible — "a dry-run build in a sandboxed context
 * (headless, no GPU): does it produce parts? do parameters change anything?" — and it is the reason the whole
 * engine is DOM-free. The server prices and scores a model by *running the AI's actual code*, which is a
 * categorically better signal than inspecting a schema: a parameter that writes nothing is observed, not guessed.
 *
 * Two properties are non-negotiable and both are asserted by tests:
 *
 *  - **The capability set matches the browser guest exactly.** A difference would mean the server approves models
 *    the viewer cannot run, or rejects models that would have worked.
 *  - **A fresh context per build.** `vm.createContext()` gives each program its own realm, so one model cannot
 *    leave a poisoned `Array.prototype` behind for the next request. The Node host serves many models per
 *    process, which is precisely where cross-contamination would be invisible and disastrous.
 *
 * The server still renders nothing. This host builds a manifest and measurements; pixels only ever happen in the
 * browser worker on the learner's device.
 */
import { createContext, runInContext, type Context } from 'node:vm';
import { SANDBOX_LIMITS, type DeviceTier, type ModelManifest } from '@edu3d/contracts';
import { FORBIDDEN_GLOBALS, GUARD_IDENTIFIER, createGuard, hardeningScript } from '@edu3d/sandbox';
import { SceneBuilder } from '../authoring/scene.ts';
import { GeometryError } from '../geometry/factory.ts';
import { MaterialError } from '../materials/factory.ts';
import { SceneError } from '../authoring/scene.ts';
import * as M from '../math/index.ts';
import { createRandom } from '../math/index.ts';
import type { GuestLogEntry } from '../authoring/guest.ts';

export interface NodeHostOptions {
  /** Instrumented source. The gate and loop instrumentation run before this. */
  code: string;
  tier: DeviceTier;
  seed: number;
  deadlineMs?: number;
}

export interface NodeHostSuccess {
  ok: true;
  manifest: ModelManifest;
  /** Live builder, so the caller can sweep parameters and run frames for the audit. */
  builder: SceneBuilder;
  logs: GuestLogEntry[];
  durationMs: number;
}

export interface NodeHostFailure {
  ok: false;
  message: string;
  stack?: string;
  timedOut: boolean;
  logs: GuestLogEntry[];
  durationMs: number;
}

export type NodeHostResult = NodeHostSuccess | NodeHostFailure;

/** Bounded console, identical in behaviour to the browser guest's. */
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
          if (arg === undefined) return 'undefined';
          if (typeof arg === 'object' && arg !== null) {
            try {
              return JSON.stringify(arg)?.slice(0, MAX_LENGTH) ?? '[unserialisable]';
            } catch {
              return '[circular]';
            }
          }
          return String(arg);
        })
        .join(' ')
        .slice(0, MAX_LENGTH);
      logs.push({ level, message });
    };

  return Object.freeze({ log: record('log'), warn: record('warn'), error: record('error') });
}

/**
 * Translate a guest exception into an instruction the repair pass can act on.
 *
 * Classification is by `name` and shape rather than by `instanceof`, and that is not a stylistic choice: an error
 * thrown inside a `vm` context is constructed from *that realm's* `Error`, so `instanceof Error` is false for it
 * in this realm. Relying on `instanceof` here reported every guest fault — timeouts included — as "threw a
 * non-error value", which is exactly the kind of misleading diagnostic that sends a repair pass in the wrong
 * direction.
 */
function describeFailure(error: unknown): { message: string; stack?: string; timedOut: boolean } {
  // Duck-typed across the realm boundary.
  const asError =
    error &&
    typeof error === 'object' &&
    typeof (error as { message?: unknown }).message === 'string'
      ? (error as { name?: string; message: string; stack?: string })
      : null;

  if (asError) {
    const name = asError.name ?? 'Error';
    const timedOut =
      name === 'GuestTimeoutError' ||
      name === 'GuestBudgetError' ||
      /script execution timed out|exceeded .* loop iterations|took too long/i.test(asError.message);

    // The engine's own error classes carry sentences already written for a generator, so they pass through intact.
    // Matched by name as well as by identity, since a guest-realm copy fails the identity check.
    const isEngineError =
      error instanceof SceneError ||
      error instanceof GeometryError ||
      error instanceof MaterialError ||
      name === 'SceneError' ||
      name === 'GeometryError' ||
      name === 'MaterialError';

    if (isEngineError) {
      return {
        message: asError.message,
        timedOut: false,
        ...(asError.stack ? { stack: asError.stack.slice(0, 4000) } : {}),
      };
    }
    const error_ = asError;
    if (timedOut) {
      return {
        message:
          error_.message ||
          'The model took too long to build. Reduce procedural detail, or lower a resolution or segment count.',
        timedOut: true,
        ...(error_.stack ? { stack: error_.stack.slice(0, 4000) } : {}),
      };
    }
    if (name === 'RangeError' && /call stack/i.test(error_.message)) {
      return {
        message:
          'The program recursed too deeply and overflowed the stack. Check for a function that calls itself without a base case.',
        timedOut: true,
      };
    }
    return {
      message: `The model threw ${name}: ${error_.message}. Check that every value used in the geometry is defined and finite.`,
      timedOut: false,
      ...(error_.stack ? { stack: error_.stack.slice(0, 4000) } : {}),
    };
  }

  // Genuinely not an error object: a program that did `throw 'oops'` or `throw 42`.
  return {
    message: `The model threw a non-error value: ${String(error).slice(0, 200)}.`,
    timedOut: false,
  };
}

/**
 * Build the guest context.
 *
 * `vm.createContext` starts from a *fresh set of intrinsics* rather than the host's, which is the property that
 * makes this safe to reuse across requests: hardening freezes that context's `Object.prototype`, not the server's.
 * Freezing the server's own intrinsics would break every library in the process.
 */
function createGuestContext(bindings: Record<string, unknown>): Context {
  const sandbox: Record<string, unknown> = { ...bindings };

  // Explicitly undefined rather than merely absent: `typeof fetch` returning `'undefined'` is what the compiled
  // guest's lexical shadowing also produces, so probing behaves identically in both hosts.
  for (const name of FORBIDDEN_GLOBALS) {
    if (name in sandbox) continue;
    sandbox[name] = undefined;
  }

  const context = createContext(sandbox, {
    name: 'edu3d-guest',
    codeGeneration: {
      // Belt over the braces: even if the gate missed an `eval`, the context cannot compile a string. The guest is
      // already compiled by the time it runs here.
      strings: false,
      wasm: false,
    },
  });

  // Harden the *guest* realm's intrinsics, not the host's. The script is generated from the same capability lists
  // the browser guest uses, so the two hosts cannot drift apart.
  runInContext(hardeningScript(), context, { timeout: 2000 });

  return context;
}

/**
 * Run the authoring pass in an isolated context.
 *
 * Never throws: a hostile or broken program is a normal input on the server, and the pipeline needs a value it can
 * turn into an enumerated repair instruction.
 */
export function authorInNodeVm(options: NodeHostOptions): NodeHostResult {
  const started = Date.now();
  const logs: GuestLogEntry[] = [];
  const builder = new SceneBuilder();
  builder.beginTiming();

  const guard = createGuard();
  const random = createRandom(options.seed >>> 0);
  const deadline = options.deadlineMs ?? SANDBOX_LIMITS.buildDeadlineMs;

  const bindings: Record<string, unknown> = {
    [GUARD_IDENTIFIER]: guard.tick,
    scene: builder.createFacade(),
    geom: builder.geometry.createFacade(),
    mat: builder.materials.createFacade(),
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

  try {
    const context = createGuestContext(bindings);
    guard.reset(deadline);

    // Wrapped in a strict-mode IIFE for the same reason the browser compiler prepends `'use strict'`: sloppy mode
    // would bind `this` to the context's global on any plain call, handing back the reference hardening removed.
    const program = `'use strict';\n(function(){\n${options.code}\n})();`;

    // `vm`'s own timeout is a second line of defence behind the injected loop guards. The guards catch the common
    // case with an actionable message; this catches a pathological program that somehow avoided instrumentation,
    // and it is the only mechanism that can interrupt synchronous code from outside.
    runInContext(program, context, { timeout: deadline, breakOnSigint: true });

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
