/**
 * Extraction and preparation: everything that must happen to a provider's reply before a realm sees it.
 *
 * `04-BACKEND.md` requires extraction to be forgiving and the gate to be strict: "Model code is extracted
 * from any surrounding prose/fences; then a static gate runs before the browser ever sees it." The
 * asymmetry is the point — a provider that wraps its answer in a fence or a sentence of preamble has not
 * made a semantic mistake, and re-rolling a whole generation over a markdown fence would be an expensive
 * way to be pedantic. Repair over reject, but bounded.
 */
import type { GateResult } from '@edu3d/contracts';
import { runStaticGate, type GateOptions } from './static-gate.ts';
import { instrumentLoops } from './instrument.ts';

/** A fenced block, with or without a language tag. Non-greedy so several fences are found separately. */
const FENCE_PATTERN = /```(?:javascript|js|jsx|typescript|ts)?\s*\n([\s\S]*?)```/g;

/**
 * Pull program text out of a provider reply.
 *
 * Strategy, in order of confidence:
 *   1. the largest fenced block — a model that fenced its code told us exactly where the code is;
 *   2. the whole reply, trimmed, when there is no fence at all;
 *   3. the reply with a leading prose paragraph removed, when it starts with a sentence.
 *
 * "Largest" rather than "first" because models routinely emit a short illustrative fence before the real
 * program, and picking the first would ship the example.
 */
export function extractProgram(raw: string): string {
  const fences = [...raw.matchAll(FENCE_PATTERN)]
    .map((match) => match[1] ?? '')
    .filter((block) => block.trim().length > 0);

  if (fences.length > 0) {
    return fences
      .reduce((longest, block) => (block.length > longest.length ? block : longest))
      .trim();
  }

  const trimmed = raw.trim();

  // An unterminated fence: the reply was cut off mid-block. Keep what came after the opening fence so
  // truncation detection downstream sees real code and can report "truncated" rather than "no code".
  const openFence = trimmed.match(/```(?:javascript|js|jsx|typescript|ts)?\s*\n/);
  if (openFence?.index !== undefined) {
    return trimmed.slice(openFence.index + openFence[0].length).trim();
  }

  return trimmed;
}

/**
 * Heuristics for a reply that was cut off.
 *
 * `04`: "Truncation is detected, never shipped... a MAX_TOKENS finish on an empty or cut-off response is a
 * specific, named failure." The provider's finish reason is the primary signal, but it is not always
 * truthful, so the shape of the code is checked too: unbalanced braces after a successful-looking reply is
 * the reliable tell, and a syntax error at the very last line is the second.
 */
export function looksTruncated(code: string): boolean {
  if (code.length === 0) return true;

  let depth = 0;
  let inString: string | null = null;
  let inLineComment = false;
  let inBlockComment = false;

  for (let i = 0; i < code.length; i += 1) {
    const char = code[i];
    const next = code[i + 1];

    if (inLineComment) {
      if (char === '\n') inLineComment = false;
      continue;
    }
    if (inBlockComment) {
      if (char === '*' && next === '/') {
        inBlockComment = false;
        i += 1;
      }
      continue;
    }
    if (inString) {
      if (char === '\\') {
        i += 1;
        continue;
      }
      if (char === inString) inString = null;
      continue;
    }

    if (char === '/' && next === '/') {
      inLineComment = true;
      i += 1;
      continue;
    }
    if (char === '/' && next === '*') {
      inBlockComment = true;
      i += 1;
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      inString = char;
      continue;
    }
    if (char === '{' || char === '(' || char === '[') depth += 1;
    if (char === '}' || char === ')' || char === ']') depth -= 1;
  }

  // An unclosed string or a positive depth both mean the text stopped mid-structure.
  return depth > 0 || inString !== null || inBlockComment;
}

export interface PrepareOptions extends GateOptions {
  /** The provider's reported finish reason, when it gave one. `length` means the cap was hit. */
  finishReason?: string;
}

export interface PreparedProgram {
  /** The extracted program exactly as the model wrote it — what the diagnostics panel shows. */
  code: string;
  /** The program with loop guards injected. This is what a realm actually compiles. */
  instrumented: string;
  gate: GateResult;
  truncated: boolean;
  /** True when the program is safe to run. False means the caller repairs or fails; it never runs it. */
  ok: boolean;
}

/**
 * The full pre-execution path: extract → detect truncation → gate → instrument.
 *
 * Instrumentation runs last and only on gated code, because injecting guards into a program that failed
 * the gate would be work spent on something that must not run — and because instrumenting unparseable
 * source throws, which would turn a reportable gate failure into an opaque crash.
 */
export function prepareProgram(raw: string, options: PrepareOptions): PreparedProgram {
  const code = extractProgram(raw);
  const truncated = options.finishReason === 'length' || looksTruncated(code);

  const gate = runStaticGate(code, options);

  if (!gate.ok || truncated) {
    return { code, instrumented: '', gate, truncated, ok: false };
  }

  const { code: instrumented } = instrumentLoops(code);
  return { code, instrumented, gate, truncated, ok: true };
}
