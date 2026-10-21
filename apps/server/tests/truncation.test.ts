/**
 * Truncation must be detected, refused and retried — never shipped (`00:145`, stated twice in
 * the build docs). The old signals (`finishReason === 'length'` + a brace-depth scanner) passed
 * two classes of half-program to the learner:
 *
 *   1. a reply cut mid-fence where the cut happens to land balanced (a statement boundary) —
 *      parses, gates, audits ~86, ships as `ready`;
 *   2. a token-budget reply whose usage hit the cap while the provider reported `stop`.
 *
 * Both directions pinned here: cut programs refused (or retried into refusal), complete
 * programs — dead ends included — still shipping.
 */
import { describe, expect, it } from 'vitest';
import { REFERENCE_MODEL_SOURCE, apiSurfaceSet } from '@edu3d/engine';
import { runPipeline } from '../src/services/pipeline.ts';
import type { AiClient } from '../src/services/ai-client.ts';
import { prepareProgram } from '@edu3d/sandbox';

/** A reply whose fenced block was never closed: the stream was cut mid-program. */
const openFence = (body: string) => '```javascript\n' + body;

/** Cut the reference at a statement boundary ~90% in (parses, balanced braces, truncation invisible to looksTruncated). */
function cutAtStatementBoundary(fraction: number): string {
  const code = REFERENCE_MODEL_SOURCE;
  let depth = 0;
  let inString: string | null = null;
  let inLine = false;
  let inBlock = false;
  let best = 0;
  for (let i = 0; i < code.length; i++) {
    const c = code[i];
    const n = code[i + 1];
    if (inLine) {
      if (c === '\n') inLine = false;
      continue;
    }
    if (inBlock) {
      if (c === '*' && n === '/') {
        inBlock = false;
        i++;
      }
      continue;
    }
    if (inString) {
      if (c === '\\') {
        i++;
        continue;
      }
      if (c === inString) inString = null;
      continue;
    }
    if (c === '/' && n === '/') {
      inLine = true;
      i++;
      continue;
    }
    if (c === '/' && n === '*') {
      inBlock = true;
      i++;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      inString = c;
      continue;
    }
    if (c === '{' || c === '(' || c === '[') depth += 1;
    if (c === '}' || c === ')' || c === ']') depth -= 1;
    if (depth === 0 && c === '\n') {
      const line = code.slice(0, i).trimEnd();
      const last = line.slice(-1);
      if (last === ';' || last === '}') best = i + 1;
      if (best >= code.length * fraction) break;
    }
  }
  return code.slice(0, best);
}

const completeReply = '```javascript\n' + REFERENCE_MODEL_SOURCE + '\n```';

describe('a cut-at-statement-boundary reply', () => {
  it(
    'is refused — never shipped as ready with finishReason omitted',
    { timeout: 60_000 },
    async () => {
      // The provider truncated mid-fence and (lying gateway class) reported nothing or `stop`.
      const cut = cutAtStatementBoundary(0.9);
      const prepared = prepareProgram(cut, { apiSurface: apiSurfaceSet(), finishReason: 'stop' });
      // The cut must be the interesting kind: parses fine, balances fine, invisible to the scanner.
      expect(prepared.ok, 'test setup: the cut must pass the gate').toBe(true);
      expect(prepared.truncated, 'test setup: the cut must NOT be caught by looksTruncated').toBe(
        false,
      );

      const result = await runPipeline('a turbofan engine', 'balanced', {
        ai: {
          complete: async () => ({
            ok: true as const,
            text: openFence(cut),
            finishReason: 'stop',
            usage: { promptTokens: 10, completionTokens: 900_000 },
          }),
        } as unknown as AiClient,
        sink: () => {},
        tier: 'mid',
        maxOutputTokens: 8192,
      });
      expect(result.ok).toBe(false);
      if (result.ok) {
        throw new Error(
          `shipped a statement-boundary-cut program as ready (score ${result.audit.score})`,
        );
      }
      expect(
        ['upstream_truncated', 'generation_unrepairable', 'upstream_failed'].includes(
          result.failure.code,
        ),
        `expected a truncation-class refusal, got ${result.failure.code}`,
      ).toBe(true);
    },
  );

  it(
    'recovers when the re-ask returns the complete program (retry, not refuse)',
    { timeout: 60_000 },
    async () => {
      const cut = cutAtStatementBoundary(0.9);
      let calls = 0;
      const result = await runPipeline('a turbofan engine', 'balanced', {
        ai: {
          complete: async () => {
            calls += 1;
            return calls === 1
              ? {
                  ok: true as const,
                  text: openFence(cut),
                  finishReason: 'stop',
                  usage: { promptTokens: 10, completionTokens: 900 },
                }
              : {
                  ok: true as const,
                  text: completeReply,
                  finishReason: 'stop',
                  usage: { promptTokens: 10, completionTokens: 900 },
                };
          },
        } as unknown as AiClient,
        sink: () => {},
        tier: 'mid',
        maxOutputTokens: 8192,
      });
      expect(result.ok, result.ok ? '' : result.failure.message).toBe(true);
      if (!result.ok) return;
      expect(result.bundle.rawOutput).toBe(completeReply);
    },
  );
});

describe('a token-budget reply the provider stops truthfully', () => {
  it(
    'completion tokens at the output cap are treated as truncation even with finishReason stop',
    { timeout: 60_000 },
    async () => {
      const cut = cutAtStatementBoundary(0.9);
      const result = await runPipeline('a turbofan engine', 'balanced', {
        ai: {
          complete: async () => ({
            ok: true as const,
            text: '```javascript\n' + cut + '\n```',
            finishReason: 'stop',
            usage: { promptTokens: 10, completionTokens: 16384 },
          }),
        } as unknown as AiClient,
        sink: () => {},
        tier: 'mid',
        maxOutputTokens: 16384,
      });
      expect(result.ok).toBe(false);
      if (result.ok) {
        throw new Error(`shipped a cap-hit half program as ready (score ${result.audit.score})`);
      }
    },
  );

  it(
    'a reply under the cap with a real stop still ships (no false positive)',
    { timeout: 60_000 },
    async () => {
      const result = await runPipeline('a turbofan engine', 'balanced', {
        ai: {
          complete: async () => ({
            ok: true as const,
            text: completeReply,
            finishReason: 'stop',
            usage: { promptTokens: 10, completionTokens: 6400 },
          }),
        } as unknown as AiClient,
        sink: () => {},
        tier: 'mid',
        maxOutputTokens: 16384,
      });
      expect(result.ok, result.ok ? '' : result.failure.message).toBe(true);
    },
  );
});

describe('a mid-expression cut (unparseable tail)', () => {
  it(
    'never ships either — gate/parse refusal lands the run in the repair or truncation path',
    { timeout: 90_000 },
    async () => {
      // Cut mid-token: the gate's parse reports a syntax error at the last line — a truncation tell
      // lying exactly where the program stopped.
      const cut = REFERENCE_MODEL_SOURCE.slice(0, REFERENCE_MODEL_SOURCE.length * 0.97);
      const result = await runPipeline('a turbofan engine', 'balanced', {
        ai: {
          complete: async () => ({
            ok: true as const,
            text: '```javascript\n' + cut,
            finishReason: 'stop',
            usage: { promptTokens: 10, completionTokens: 900 },
          }),
        } as unknown as AiClient,
        sink: () => {},
        tier: 'mid',
        maxOutputTokens: 8192,
      });
      expect(result.ok).toBe(false);
      if (result.ok) {
        throw new Error(`shipped a mid-expression cut as ready (score ${result.audit.score})`);
      }
      expect(
        ['upstream_truncated', 'generation_unrepairable', 'upstream_failed'].includes(
          result.failure.code,
        ),
      ).toBe(true);
    },
  );
});
