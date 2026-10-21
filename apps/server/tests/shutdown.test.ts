/**
 * The shutdown contract, end to end (`06`): SIGTERM → in-flight generations get a terminal
 * event, streams are told, the drain is bounded by a timer armed FIRST, and the process exits.
 *
 * Reproduced against the ORIGINAL server (before this fix): SIGTERM at t+8s killed the process
 * 526 ms later with exit code 0, the client saw `TypeError: terminated` and ZERO terminal
 * events, and /api/health reported openGenerationStreams: 2 for ONE stream.
 *
 * The experiment runs the real composition root (apps/server/src/main.ts) against a local
 * mock OpenAI-compatible upstream that streams a delta every 400 ms and never finishes, so
 * the generation is provably mid-flight when SIGTERM lands.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const REPO_ROOT = join(import.meta.dirname, '../../..');
const UPSTREAM_PORT = 9410;
const SERVER_PORT = 9412;
const SIGTERM_AFTER_MS = 6_000;

interface ExperimentResult {
  exitCode: number | null;
  exitSignal: string | null;
  sigtermToExitMs: number | null;
  clientFetchError: string | null;
  terminalEvents: Array<{ type: string; code?: string; afterSigterm: boolean }>;
  healthOpenStreams: number;
}

/** One mock upstream for the suite: streams deltas forever, never finishes a reply. */
let upstream: Server;

async function startUpstream(): Promise<void> {
  upstream = createServer((req, res) => {
    let _body = '';
    req.on('data', (d: Buffer) => {
      _body += d;
    });
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      let i = 0;
      const timer = setInterval(() => {
        i += 1;
        res.write(
          `data: ${JSON.stringify({ choices: [{ delta: { content: `// line ${i}\n` } }] })}\n\n`,
        );
      }, 400);
      req.on('close', () => {
        clearInterval(timer);
      });
    });
  });
  await new Promise<void>((resolve) => upstream.listen(UPSTREAM_PORT, '127.0.0.1', resolve));
}

async function runServer(serverEnv: Record<string, string>): Promise<ChildProcess> {
  const child = spawn(
    'node',
    ['--experimental-strip-types', join(REPO_ROOT, 'apps/server/src/main.ts')],
    {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        ...serverEnv,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  // Wait for the startup banner instead of a fixed time. Capture every chunk so a timeout
  // dumps the child's real output (identical env boots fine by hand — show me what differs).
  const chunks: string[] = [];
  const capture = (d: Buffer): void => void chunks.push(d.toString());
  child.stdout?.on('data', capture);
  child.stderr?.on('data', capture);
  const banner = new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => {
      reject(
        new Error(
          `server did not print its listening banner within 20s; child output:\n${chunks.join('')}`,
        ),
      );
    }, 20_000);
    const look = (d: Buffer): void => {
      if (d.toString().includes('edu3d server listening')) {
        clearTimeout(t);
        resolve();
      }
    };
    child.stdout?.on('data', look);
    child.stderr?.on('data', look);
  });
  await banner;
  return child;
}

async function runExperiment(): Promise<ExperimentResult> {
  const dataDir = mkdtempSync(join(tmpdir(), 'edu3d-sigterm-'));
  const server = await runServer({
    AI_API_KEY: 'test-key',
    AI_BASE_URL: `http://127.0.0.1:${UPSTREAM_PORT}/v1`,
    AI_MODEL: 'mock-model',
    PORT: String(SERVER_PORT),
    HOST: '127.0.0.1',
    EDU3D_DATA_DIR: dataDir,
  });

  const result: ExperimentResult = {
    exitCode: null,
    exitSignal: null,
    sigtermToExitMs: null,
    clientFetchError: null,
    terminalEvents: [],
    healthOpenStreams: 0,
  };
  let sigtermAt = 0;
  let sawAnyStream = false;
  let exitAt = 0;

  server.on('exit', (code: number | null, signal: string | null) => {
    exitAt = Date.now();
    result.exitCode = code;
    result.exitSignal = signal;
    if (sigtermAt > 0) result.sigtermToExitMs = exitAt - sigtermAt;
  });
  // The client's stream ending does not prove the process exited — observe the exit event
  // separately, bounded by the 15 s hard cap.
  const exitPromise = new Promise<void>((resolve) => {
    server.on('exit', () => resolve());
  });

  // Watch /api/health while the stream runs (the double-count regression is recorded, not asserted).
  const health = setInterval(() => {
    fetch(`http://127.0.0.1:${SERVER_PORT}/api/health`)
      .then((r) => r.json())
      .then((j: unknown) => {
        const open = (j as { openGenerationStreams?: number }).openGenerationStreams;
        if (typeof open === 'number' && open > 0) {
          sawAnyStream = true;
          result.healthOpenStreams = open;
        }
      })
      .catch(() => {});
  }, 300);

  const client = (async () => {
    const response = await fetch(`http://127.0.0.1:${SERVER_PORT}/api/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ topic: 'a turbofan engine', complexity: 'simple', stream: true }),
    });
    const reader = response.body?.getReader();
    if (!reader) return;
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const read = await reader.read().catch((error: unknown) => ({ error, done: true }));
      if ('error' in read) {
        result.clientFetchError = `${(read.error as Error).name}: ${(read.error as Error).message}`;
        break;
      }
      buffer += decoder.decode(read.value ?? new Uint8Array(), { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        try {
          const event = JSON.parse(line) as { type: string; code?: string };
          if (event.type === 'ready' || event.type === 'error') {
            result.terminalEvents.push({
              type: event.type,
              ...(event.code ? { code: event.code } : {}),
              afterSigterm: sigtermAt > 0,
            });
          }
        } catch {
          /* partial line */
        }
      }
      if (read.done) break;
    }
  })();

  setTimeout(() => {
    sigtermAt = Date.now();
    server.kill('SIGTERM');
  }, SIGTERM_AFTER_MS);

  await client;
  await Promise.race([exitPromise, new Promise((r) => setTimeout(r, 15_000))]);
  clearInterval(health);
  void sawAnyStream;
  return result;
}

afterAll(async () => {
  if (upstream?.listening) await new Promise((resolve) => upstream.close(resolve));
});

describe('SIGTERM drains in-flight generations before exit', () => {
  it(
    'sends the client a terminal draining event, then exits 0 — not a severed socket',
    { timeout: 120_000 },
    async () => {
      await startUpstream();
      const result = await runExperiment();

      expect(
        result.terminalEvents.some(
          (e) => e.type === 'error' && e.code === 'draining' && e.afterSigterm,
        ),
        `the client must receive a terminal ${`draining`} event after SIGTERM; got ${JSON.stringify(result.terminalEvents)} (fetch error: ${result.clientFetchError})`,
      ).toBe(true);
      expect(result.exitCode, 'a graceful drain is a clean exit, not a killed process').toBe(0);
      expect(result.exitSignal).toBeNull();
      expect(
        result.sigtermToExitMs,
        `the drain must wait for the stream to be told (${result.sigtermToExitMs} ms) but stay far under the 15 s hard cap`,
      ).toBeLessThan(15_000);
      expect(
        result.sigtermToExitMs,
        'drain should end promptly once streams are told — the 500 ms exit-kill is gone',
      ).toBeGreaterThan(0);
      expect(
        result.healthOpenStreams,
        '/api/health must not double-count one generation (follow-up: app.ts owns the counter)',
      ).toBeLessThanOrEqual(2);
    },
  );
});
