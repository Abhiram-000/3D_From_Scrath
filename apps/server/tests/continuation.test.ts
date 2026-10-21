/**
 * The continuation protocol: a cut-off reply is CONTINUED, not re-rolled and not refused.
 *
 * The measured evidence that motivated this: every failed battery topic died `upstream_truncated`,
 * all on long programs, and the old remedy — "send the partial back, ask for the COMPLETE program
 * again" — failed the same way a second time at full price. The pipeline must instead send the
 * partial as an assistant turn, ask for ONLY the remainder, stitch, and re-gate.
 *
 * Proof shape, per the brief:
 *   1. END-TO-END against a stub provider speaking the real OpenAI SSE wire format, told to cut
 *      the stream mid-program: the old behavior was a terminal `upstream_truncated`; now the run
 *      stitches and reaches `ready` with the whole reference program audited.
 *   2. The seam: stitched programs must parse and pass `prepareProgram` — including a cut landing
 *      MID-TOKEN (`const radius = 0.` + `5;`) and a continuation that echoes the tail it was
 *      handed (the overlap must be dropped, not duplicated).
 *
 * The stub is a local HTTP server; no real provider is contacted and no API key is spent.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { REFERENCE_MODEL_SOURCE, apiSurfaceSet } from '@edu3d/engine';
import { prepareProgram } from '@edu3d/sandbox';
import type { GenerationEvent } from '@edu3d/contracts';
import { AiClient } from '../src/services/ai-client.ts';
import {
  classifyTruncationWall,
  MAX_CONTINUATION_PASSES,
  runPipeline,
  stitchContinuation,
} from '../src/services/pipeline.ts';
import type { ServerConfig } from '../src/config/config.ts';
import { resolveConfig } from '../src/config/config.ts';

/** Split the (trimmed) reference program at a statement boundary near `fraction` of its length. */
function cutAtStatementBoundary(fraction: number): { head: string; tail: string } {
  const code = REFERENCE_MODEL_SOURCE.trim();
  let depth = 0;
  let best = 0;
  for (let i = 0; i < code.length; i += 1) {
    const c = code[i];
    if (c === '{' || c === '(' || c === '[') depth += 1;
    if (c === '}' || c === ')' || c === ']') depth -= 1;
    if (depth === 0 && c === '\n') {
      // A statement boundary only where the line actually closed a statement (or block).
      const line = code.slice(0, i).trimEnd();
      if (/[;}]$/.test(line) && i >= code.length * fraction) {
        best = i + 1;
        break;
      }
    }
  }
  if (best === 0) throw new Error('test setup: no statement boundary found near that fraction');
  // Both halves keep every byte: head includes the separating newline so the stitch must
  // reconstruct the program EXACTLY for the equality assertions to be honest.
  return { head: code.slice(0, best), tail: code.slice(best) };
}

// ── The stub provider: same OpenAI SSE wire, scripted behavior, no network egress ──────────

interface StubReply {
  /** Content fragments streamed as `delta.content` chunks. */
  chunks: string[];
  /** `stop` sends finish_reason + usage + [DONE]; `cut` destroys the socket with no terminal event. */
  end: 'stop' | 'cut';
  /**
   * Override the reported completion tokens (default: ~chars/4). A value AT the configured cap
   * simulates "the provider stopped because its room ran out" — the output-cap wall.
   */
  usageCompletionTokens?: number;
}
interface StubCall {
  messages: Array<{ role: string; content: string }>;
}
interface StubProvider {
  url: string;
  close: () => Promise<void>;
  calls: StubCall[];
}

/** An OpenAI-compatible SSE server that serves the scripted reply for each call, in order. */
async function startStubProvider(
  script: (call: StubCall, index: number) => StubReply,
): Promise<StubProvider> {
  const calls: StubCall[] = [];
  const server: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => {
      body += chunk;
    });
    req.on('end', () => {
      // Scripted behavior is computed defensively: a throwing script must fail the TEST, never
      // take the stub server (or the process) down.
      let reply: StubReply;
      try {
        reply = script(
          { messages: (JSON.parse(body).messages ?? []) as StubCall['messages'] },
          calls.length,
        );
        calls.push({ messages: reply === null ? [] : (JSON.parse(body).messages ?? []) });
      } catch (error) {
        res.writeHead(500);
        res.end(String(error));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const chunk of reply.chunks) {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: chunk } }] })}\n\n`);
      }
      if (reply.end === 'stop') {
        res.write(
          `data: ${JSON.stringify({
            choices: [{ delta: {}, finish_reason: 'stop' }],
            // Tokens, not chars — like a real provider (~4 chars/token). Reporting the raw char
            // count would exceed the configured cap and mask as a truncation through the usage
            // check on `replyLooksCut` (which is exactly the honest misfire it is designed for).
            usage: {
              prompt_tokens: 100,
              completion_tokens:
                reply.usageCompletionTokens ?? Math.ceil(reply.chunks.join('').length / 4),
            },
          })}\n\n`,
        );
        res.write('data: [DONE]\n\n');
        res.end();
      } else {
        // Cut mid-stream, exactly like the measured provider: no finish_reason, no [DONE].
        setTimeout(() => res.destroy(), 20);
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    calls,
  };
}

const configForStub = (url: string): ServerConfig =>
  resolveConfig({ AI_API_KEY: 'stub-key', AI_BASE_URL: url, AI_MODEL: 'stub-model' });

describe('a stream cut mid-program', () => {
  const { head, tail } = cutAtStatementBoundary(0.55);
  let stub: StubProvider;

  beforeAll(async () => {
    stub = await startStubProvider((_call, index) =>
      index === 0
        ? { chunks: ['```javascript\n', head], end: 'cut' }
        : // The continuation ask: partial arrives as an ASSISTANT turn; the stub obeys the
          // protocol literally — tail only, in one closed fence.
          { chunks: ['```javascript\n', tail, '\n```'], end: 'stop' },
    );
  });

  afterAll(() => stub.close());

  it(
    'is continued from the exact cut, stitched, and reaches ready with the full program audited',
    { timeout: 120_000 },
    async () => {
      const events: GenerationEvent[] = [];
      const result = await runPipeline('a turbofan engine', 'balanced', {
        ai: new AiClient(configForStub(stub.url)) as unknown as AiClient,
        sink: (event) => events.push(event),
        tier: 'mid',
        maxOutputTokens: 8192,
      });
      expect(result.ok, result.ok ? '' : result.failure.message).toBe(true);
      if (!result.ok) return;

      // The continuation ask had the partial as an assistant turn (protocol, not re-roll).
      if (stub.calls.length < 2) throw new Error('stub: the continuation call never happened');
      const continuationCall = stub.calls.at(1);
      if (!continuationCall) throw new Error('stub: the continuation call never happened');
      expect(continuationCall.messages.at(-2)?.role).toBe('assistant');
      expect(continuationCall.messages.at(-2)?.content).toContain(head.slice(0, 40));

      // The stitched raw reply is one closed fence holding the WHOLE program, byte-exact.
      expect(result.bundle.rawOutput).toBe(
        '```javascript\n' + REFERENCE_MODEL_SOURCE.trim() + '\n```',
      );
      expect(result.bundle.code).toBe(REFERENCE_MODEL_SOURCE.trim());
      expect(result.bundle.runtime).toContain('__edu3d_tick');
      expect(result.audit.score).toBeGreaterThan(0);
      // The continuation spend is visible in provenance, not swallowed (2 provider calls).
      const provenance = result.bundle.provenance as unknown as { providerCalls: number };
      expect(provenance.providerCalls).toBe(2);
      // The truncation was made VISIBLE to the learner, not swallowed.
      const notices = events.filter((event) => event.type === 'notice');
      expect(
        notices.some((event) => event.type === 'notice' && /ran out of room/.test(event.message)),
      ).toBe(true);
      // And the model must pass the static gate on the STITCHED program, end to end.
      if (typeof result.bundle.rawOutput !== 'string') {
        throw new Error('bundle rawOutput missing');
      }
      expect(prepareProgram(result.bundle.rawOutput, { apiSurface: apiSurfaceSet() }).ok).toBe(
        true,
      );
    },
  );
});

describe('a stream cut twice (the continuation itself is cut)', () => {
  const { head, tail } = cutAtStatementBoundary(0.55);
  const midTail = Math.floor(tail.length * 0.5);
  let stub: StubProvider;

  beforeAll(async () => {
    stub = await startStubProvider((_call, index) => {
      if (index === 0) return { chunks: ['```javascript\n', head], end: 'cut' };
      if (index === 1) return { chunks: ['```javascript\n', tail.slice(0, midTail)], end: 'cut' };
      return { chunks: ['```javascript\n', tail.slice(midTail), '\n```'], end: 'stop' };
    });
  });

  afterAll(() => stub.close());

  it(
    'continues again from the new cut and still lands on ready',
    { timeout: 120_000 },
    async () => {
      const result = await runPipeline('a turbofan engine', 'balanced', {
        ai: new AiClient(configForStub(stub.url)) as unknown as AiClient,
        sink: () => {},
        tier: 'mid',
        maxOutputTokens: 8192,
      });
      expect(result.ok, result.ok ? '' : result.failure.message).toBe(true);
      if (!result.ok) return;
      expect(result.bundle.code).toBe(REFERENCE_MODEL_SOURCE.trim());
      expect(stub.calls).toHaveLength(3);
    },
  );
});

describe('a stream that keeps getting cut', () => {
  let stub: StubProvider;

  beforeAll(async () => {
    // Every reply: a program cut MID-TOKEN inside an unclosed call — never a complete statement,
    // so only the continuation bound (not a lucky stitch) can end this run.
    stub = await startStubProvider(() => ({
      chunks: [
        '```javascript\n',
        'const unfinishedEngine = buildEngine(\n' + '// pad\n'.repeat(200),
      ],
      end: 'cut',
    }));
  });

  afterAll(() => stub.close());

  it(
    `fails as upstream_truncated after the bounded ${MAX_CONTINUATION_PASSES} continuations`,
    { timeout: 60_000 },
    async () => {
      const result = await runPipeline('a turbofan engine', 'balanced', {
        ai: new AiClient(configForStub(stub.url)) as unknown as AiClient,
        sink: () => {},
        tier: 'mid',
        maxOutputTokens: 8192,
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.failure.code).toBe('upstream_truncated');
      expect(result.failure.message).toContain('ran out of writing room');
    },
  );
});

// ── The seam itself: pure-function proof on stitched source ─────────────────────────────────

describe('stitchContinuation', () => {
  it('joins a mid-token cut with no separator, and the stitched program parses and passes prepareProgram', () => {
    const head = 'const radius = 0.';
    const continuation = '```javascript\n5 + 1.5;\nscene.describe({ name: "x" });\n```';
    const stitched = stitchContinuation(head, continuation);
    expect(stitched).toContain('const radius = 0.5 + 1.5;');
    const prepared = prepareProgram(stitched, { apiSurface: apiSurfaceSet() });
    expect(prepared.gate.ok, JSON.stringify(prepared.gate.violations)).toBe(true);
  });

  it('drops a repeated tail line instead of duplicating it, and the result parses', () => {
    const head = 'const a = 1;\nconst rotationSpeed = 0.42;\nscene.param({ id: "p" });';
    // Model echoes the last line before continuing.
    const continuation =
      '```javascript\nscene.param({ id: "p" });\nscene.describe({ name: "y" });\n```';
    const stitched = stitchContinuation(head, continuation);
    expect(stitched.match(/scene\.param\(\{ id: "p" \}\);/g)).toHaveLength(1);
    expect(stitched).toContain('scene.describe({ name: "y" });');
  });

  it('treats a continuation that restates the program as a rewrite, not append noise', () => {
    const head = 'const speed = 2;\nscene.describe({ name: "x" });';
    const continuation =
      '```javascript\nconst speed = 2;\nscene.describe({ name: "x" });\nscene.colorRole({ id: "c" });\n```';
    const stitched = stitchContinuation(head, continuation);
    // The rewrite supersedes the partial: exactly one of each line survives.
    expect(stitched.match(/scene\.describe/g)).toHaveLength(1);
    expect(stitched).toContain('scene.colorRole');
  });

  it('leaves a trivial `});` echo alone rather than risking a silently wrong dedupe', () => {
    const head = 'scene.param({ id: "p",\n});';
    const continuation = '```javascript\n});\nscene.describe({ name: "x" });\n```';
    const stitched = stitchContinuation(head, continuation);
    // Not deduped: both closers survive back to back → broken code that the gate/repair loop
    // catches instead of a dedupe rule guessing wrong.
    expect(stitched).toContain('});\n});');
  });
});

// ── The wall diagnosis: WHICH truncation shape fired (provider /models data made this a question
// of classifying, not diagnosing — the three remedies differ completely) ───────────────────────

describe('classifyTruncationWall', () => {
  const CAP = 8192;
  it('says output_cap when reported usage reached OUR ceiling (the wall is ours)', () => {
    expect(classifyTruncationWall({ completionTokens: CAP }, CAP)).toBe('output_cap');
    expect(classifyTruncationWall({ completionTokens: CAP + 1 }, CAP)).toBe('output_cap');
  });
  it('says early_stream when usage is reported but below the cap (gateway cut, or reasoning tokens invisible to the count)', () => {
    expect(classifyTruncationWall({ completionTokens: 400 }, CAP)).toBe('early_stream');
  });
  it('says unreported when no usage arrived (the stream died before accounting for anything)', () => {
    expect(classifyTruncationWall({ completionTokens: 0 }, CAP)).toBe('unreported');
    expect(classifyTruncationWall(undefined, CAP)).toBe('unreported');
  });
});

describe('a stream the provider stops AT the output cap (usage reports the cap exactly)', () => {
  const { head, tail } = cutAtStatementBoundary(0.55);
  let stub: StubProvider;

  beforeAll(async () => {
    stub = await startStubProvider((_call, index) =>
      index === 0
        ? // Cap wall: content is mid-program but usage reports the cap exactly, finish `stop` —
          // the provider "finished" because ITS OWN room ran out, which is our cap to raise.
          {
            chunks: ['```javascript\n', head],
            end: 'stop',
            usageCompletionTokens: 8192,
          }
        : { chunks: ['```javascript\n', tail, '\n```'], end: 'stop' },
    );
  });

  afterAll(() => stub.close());

  it(
    'is recognised as output_cap, continued once, and lands on ready',
    { timeout: 120_000 },
    async () => {
      const result = await runPipeline('a turbofan engine', 'balanced', {
        ai: new AiClient(configForStub(stub.url)) as unknown as AiClient,
        sink: () => {},
        tier: 'mid',
        maxOutputTokens: 8192,
      });
      expect(result.ok, result.ok ? '' : result.failure.message).toBe(true);
      if (!result.ok) return;
      expect(result.bundle.code).toBe(REFERENCE_MODEL_SOURCE.trim());
      expect(stub.calls).toHaveLength(2);
    },
  );
});

describe('a stream cut early with usage reported BELOW the cap (gateway cut, cap blameless)', () => {
  const { head, tail } = cutAtStatementBoundary(0.55);
  let stub: StubProvider;

  beforeAll(async () => {
    stub = await startStubProvider((_call, index) =>
      index === 0
        ? // Early cut: truncated content, a clean finish, but usage WELL below the cap —
          // the provider "finished" while holding back most of its room. Raising the cap's
          // blameless here; the continuation protocol is the remedy either way.
          { chunks: ['```javascript\n', head], end: 'stop', usageCompletionTokens: 400 }
        : { chunks: ['```javascript\n', tail, '\n```'], end: 'stop' },
    );
  });

  afterAll(() => stub.close());

  it(
    'is recognised as early_stream, continued once, and lands on ready',
    { timeout: 120_000 },
    async () => {
      const result = await runPipeline('a turbofan engine', 'balanced', {
        ai: new AiClient(configForStub(stub.url)) as unknown as AiClient,
        sink: () => {},
        tier: 'mid',
        maxOutputTokens: 8192,
      });
      expect(result.ok, result.ok ? '' : result.failure.message).toBe(true);
      if (!result.ok) return;
      expect(result.bundle.code).toBe(REFERENCE_MODEL_SOURCE.trim());
      expect(stub.calls).toHaveLength(2);
    },
  );
});
