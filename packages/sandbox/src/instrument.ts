/**
 * Loop instrumentation: layer 2 of the sandbox.
 *
 * The static gate can prove a program does not *name* a capability. It cannot prove the program
 * terminates — that is undecidable — so termination is enforced at runtime by a deadline check injected
 * into every loop body before the code is ever compiled.
 *
 * `00-GOAL.md` requires this as a hard property: "A model that crashes or runs forever must be killable
 * without taking down the viewer... Time and resource limits are enforced, not assumed." The host's
 * `worker.terminate()` is the outer guarantee; this is the inner one, and it matters because a guarded
 * loop throws a *reportable* error the repair pass can act on, whereas a terminated worker only ever
 * yields "it hung".
 *
 * The transform is source-level rather than AST-regeneration: acorn parses but does not print, and
 * splicing text at recorded offsets keeps every line number identical to the code the model wrote. That
 * matters because the diagnostics panel shows the model's own output, and a stack trace pointing at a
 * regenerated file would point at lines nobody can read.
 */
import { parse } from 'acorn';
import { simple } from 'acorn-walk';
import type { Node } from 'acorn';

type AnyNode = Node & { type: string; start: number; end: number; [key: string]: unknown };

/**
 * The guard function's name.
 *
 * The `__edu3d_` prefix is reserved: the static gate rejects any program that declares or references an
 * identifier starting with it. Without that reservation a guest could write `function __edu3d_tick(){}`
 * and shadow the guard inside its own scope, turning every injected check into a no-op — which is
 * exactly the kind of quiet bypass a sandbox cannot afford.
 */
export const GUARD_IDENTIFIER = '__edu3d_tick';

/** Prefix reserved for injected machinery. Guest code that mentions it is rejected by the gate. */
export const RESERVED_PREFIX = '__edu3d_';

const LOOP_TYPES = new Set([
  'ForStatement',
  'ForInStatement',
  'ForOfStatement',
  'WhileStatement',
  'DoWhileStatement',
]);

interface Edit {
  at: number;
  insert: string;
  /** Replaces `length` characters at `at` when set; a pure insertion otherwise. */
  length?: number;
}

export interface InstrumentResult {
  code: string;
  /** Loops that received a guard. Zero in a large model is itself worth noticing. */
  guardedLoops: number;
}

/**
 * Inject a guard call at the top of every loop body.
 *
 * Three body shapes need three treatments, and missing any one of them leaves an unguarded infinite
 * loop: a block gets an inserted statement, a bare statement (`while (x) doThing();`) gets wrapped in a
 * block so the guard has somewhere to live, and an empty statement (`for (;;);` — the shortest infinite
 * loop in the language) gets replaced outright.
 */
export function instrumentLoops(source: string): InstrumentResult {
  const program = parse(source, {
    ecmaVersion: 2023,
    sourceType: 'script',
    locations: false,
    ranges: true,
  });

  const edits: Edit[] = [];
  let guardedLoops = 0;

  const guardBody = (loop: AnyNode): void => {
    const body = loop.body as AnyNode | undefined;
    if (!body) return;
    guardedLoops += 1;

    if (body.type === 'BlockStatement') {
      // Insert immediately after the opening brace so the guard runs before anything else, including
      // an early `continue` that would otherwise skip it forever.
      edits.push({ at: body.start + 1, insert: `${GUARD_IDENTIFIER}();` });
      return;
    }

    if (body.type === 'EmptyStatement') {
      edits.push({
        at: body.start,
        length: body.end - body.start,
        insert: `{${GUARD_IDENTIFIER}();}`,
      });
      return;
    }

    edits.push({ at: body.start, insert: `{${GUARD_IDENTIFIER}();` });
    edits.push({ at: body.end, insert: '}' });
  };

  simple(program, {
    ForStatement(node) {
      guardBody(node as unknown as AnyNode);
    },
    ForInStatement(node) {
      guardBody(node as unknown as AnyNode);
    },
    ForOfStatement(node) {
      guardBody(node as unknown as AnyNode);
    },
    WhileStatement(node) {
      guardBody(node as unknown as AnyNode);
    },
    DoWhileStatement(node) {
      guardBody(node as unknown as AnyNode);
    },
    /**
     * Function entry is guarded too.
     *
     * A guest can hang without a loop: mutual recursion between two functions grows the stack, and while
     * V8 eventually throws `RangeError`, a tail-position-heavy pattern can spin for a long time first.
     * One guard call per function entry bounds it by wall clock instead of by stack depth.
     */
    FunctionDeclaration(node) {
      const fn = node as unknown as AnyNode;
      const body = fn.body as AnyNode;
      if (body?.type === 'BlockStatement') {
        edits.push({ at: body.start + 1, insert: `${GUARD_IDENTIFIER}();` });
      }
    },
    FunctionExpression(node) {
      const fn = node as unknown as AnyNode;
      const body = fn.body as AnyNode;
      if (body?.type === 'BlockStatement') {
        edits.push({ at: body.start + 1, insert: `${GUARD_IDENTIFIER}();` });
      }
    },
  });

  if (edits.length === 0) return { code: source, guardedLoops };

  // Apply from the end so earlier offsets stay valid. Sorting by descending position also keeps the
  // paired open/close edits of a wrapped single-statement body in the right order.
  edits.sort((a, b) => b.at - a.at);

  let output = source;
  for (const edit of edits) {
    const before = output.slice(0, edit.at);
    const after = output.slice(edit.at + (edit.length ?? 0));
    output = `${before}${edit.insert}${after}`;
  }

  return { code: output, guardedLoops };
}

/** True when a node type is one of the loop forms the instrumentation guards. */
export const isLoopNode = (type: string): boolean => LOOP_TYPES.has(type);
