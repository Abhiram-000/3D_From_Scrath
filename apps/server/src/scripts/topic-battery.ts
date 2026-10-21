/**
 * The P8 topic battery harness — `PLAN.md`'s gate: "the battery runs and records
 * build-rate/part-count/binding-count per topic."
 *
 * `00` demands prompt changes be treated "like a code change with evidence — never vibes-based
 * tuning", and names the method: run a fixed battery of topics (mechanism, circuit, biology, math,
 * astronomy…), measure results (did it build? part count? parameter bindings?), and compare
 * versions against those numbers. This script is that instrument.
 *
 * Usage:
 *   node --experimental-strip-types src/scripts/topic-battery.ts [--count 3] [--out battery.json]
 *   node --experimental-strip-types src/scripts/topic-battery.ts --dry-run
 *
 * `--dry-run` resolves the configuration and prints the exact history row a zero-topic run would
 * write — the row shape is testable in CI without spending the API budget. A real run is an
 * explicit human decision, never an automated step.
 *
 * The script sends `x-edu3d-battery: battery` on every generate call: paired with the server's
 * loopback-socket check, that is the narrow exemption from the generate rate limiter, so an
 * eight-topic run cannot record its own 429s as build failures.
 *
 * Metrics per topic, exactly the gate's three:
 *   - buildRate:   did the pipeline return a validated bundle (ready) or fail (error)?
 *   - partCount:   manifest.cost.parts — the "six-box disappointment" detector
 *   - bindingCount: parameters NOT accused by a parameterLeverage deficiency — derived from the
 *                  audit's structured subjectId list, never from deficiency prose (a parameter
 *                  named `mass` must not match the word "massive").
 * Records audit score, repair/refine passes and durations alongside, because those numbers explain
 * the three above when a regression lands.
 */
import { writeFileSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { PROMPT_VERSION } from '../services/prompts.ts';
import { resolveConfig, type ServerConfig } from '../config/config.ts';
import { BATTERY_REQUEST_HEADER, BATTERY_REQUEST_VALUE } from '../services/rate-limits.ts';

// Where the battery points. Overridable because the target is a deployment choice: pinning it to
// 8787 meant the battery could only ever run against whatever happened to hold that port, which is
// no use when a second instance is up for a measurement.
const API = process.env.EDU3D_BATTERY_API ?? 'http://127.0.0.1:8787';

/** The fixed battery: one topic per domain row in `00`'s spectrum, per the doc's own test. */
const BATTERY: ReadonlyArray<{ topic: string; domain: string }> = [
  { topic: 'how does a pendulum work', domain: 'physics/mechanism' },
  { topic: 'how does a four-stroke engine cycle work', domain: 'mechanical/machines' },
  {
    topic: 'how does a photovoltaic solar cell convert light into electricity',
    domain: 'electronics/circuits',
  },
  { topic: 'how does DNA replication work', domain: 'biology' },
  { topic: 'why do the planets orbit the sun', domain: 'astronomy/space' },
  { topic: 'what does the sine function look like in 3D', domain: 'mathematics' },
  { topic: 'how does supply and demand reach equilibrium', domain: 'economics/systems' },
  { topic: 'how does a bridge carry a load', domain: 'architecture/civil' },
];

/** The summary half of a history row — the five comparable numbers `00` names. */
export interface BatterySummary {
  buildRate: number;
  averagePartCount: number;
  averageBindingCount: number;
  averageAuditScore: number | null;
  totalDurationSeconds: number;
}

/** One `battery-history.jsonl` line: attributable to a prompt version and a model, plus summary. */
export interface BatteryHistoryRow extends BatterySummary {
  at: string;
  promptVersion: string;
  model: string;
}

/** The zero-topic summary a dry run reports — the row shape without the spend. */
const EMPTY_SUMMARY: BatterySummary = {
  buildRate: 0,
  averagePartCount: 0,
  averageBindingCount: 0,
  averageAuditScore: null,
  totalDurationSeconds: 0,
};

/**
 * Build one history row.
 *
 * Attribution is the point: `promptVersion` and `model` arrive as real values from the caller
 * (the imported `PROMPT_VERSION` and the resolved config's model), never the placeholders
 * ('see bundle provenance', 'per server config') that made rows impossible to compare.
 */
export function historyRow(
  promptVersion: string,
  model: string,
  summary: BatterySummary,
  at: string = new Date().toISOString(),
): BatteryHistoryRow {
  return { at, promptVersion, model, ...summary };
}

/** The row a dry run would write: real version, real model, zero measurements. */
export function dryRunRow(config: ServerConfig): BatteryHistoryRow {
  return historyRow(PROMPT_VERSION, config.ai.model, EMPTY_SUMMARY);
}

/**
 * bindingCount from structured data: parameters whose ids are NOT accused by a
 * parameterLeverage deficiency.
 *
 * SubjectId equality only. The previous derivation joined the deficiency prose and substring-
 * matched parameter ids against it, which counted `mass` as unbound because "massive".includes(
 * "mass") — a wrong number that no amount of battery rows could expose. An empty accusation
 * list (an older server, or a fully bound model) binds every parameter.
 */
export function deriveBindingCount(
  parameterIds: readonly string[],
  unboundParameterIds: readonly string[],
): number {
  const accused = new Set(unboundParameterIds);
  return parameterIds.filter((id) => !accused.has(id)).length;
}

interface TopicResult {
  topic: string;
  domain: string;
  built: boolean;
  partCount: number;
  triangleCount: number;
  parameterCount: number;
  bindingCount: number;
  storyBeats: number;
  quizQuestions: number;
  auditScore: number | null;
  repairPasses: number | null;
  refinementPasses: number | null;
  durationSeconds: number;
  failureCode: string | null;
  failureMessage: string | null;
}

interface BatteryReport {
  promptVersion: string;
  startedAt: string;
  model: string;
  topics: TopicResult[];
  summary: BatterySummary;
}

const args = process.argv.slice(2);
const countIndex = args.indexOf('--count');
const limit = countIndex >= 0 ? Number(args[countIndex + 1] ?? BATTERY.length) : BATTERY.length;
const dryRun = args.includes('--dry-run');
const outIndex = args.indexOf('--out');
const outFile =
  outIndex >= 0 ? (args[outIndex + 1] as string) : path.resolve('battery-results.json');

/** Run one topic through the streaming pipeline and reduce the events to metrics. */
async function runTopic(topic: string, domain: string): Promise<TopicResult> {
  const started = Date.now();
  const base: TopicResult = {
    topic,
    domain,
    built: false,
    partCount: 0,
    triangleCount: 0,
    parameterCount: 0,
    bindingCount: 0,
    storyBeats: 0,
    quizQuestions: 0,
    auditScore: null,
    repairPasses: null,
    refinementPasses: null,
    durationSeconds: 0,
    failureCode: null,
    failureMessage: null,
  };

  try {
    const response = await fetch(`${API}/api/generate`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        // The battery's marker, paired server-side with a loopback-socket check: together they
        // are the narrow generate-limiter exemption that keeps this script's own traffic from
        // being counted as build failures. An internet client cannot satisfy the pair.
        [BATTERY_REQUEST_HEADER]: BATTERY_REQUEST_VALUE,
      },
      body: JSON.stringify({ topic, complexity: 'detailed', tier: 'mid', stream: true }),
    });
    if (!response.ok || !response.body) {
      base.failureCode = `http_${response.status}`;
      base.failureMessage = await response.text().catch(() => '');
      base.durationSeconds = (Date.now() - started) / 1000;
      return base;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.length === 0) continue;
        let event: Record<string, unknown>;
        try {
          event = JSON.parse(trimmed) as Record<string, unknown>;
        } catch {
          continue;
        }

        if (event.type === 'ready') {
          const bundle = event.bundle as {
            manifest: {
              cost: { parts: number; triangles: number };
              parameters: Array<{ id: string }>;
              story: unknown[];
              quiz: unknown[];
            };
            provenance: { repairPasses: number; refinementPasses: number };
          };
          const audit = ('audit' in event ? event.audit : undefined) as
            { score: number; unboundParameterIds?: string[] } | undefined;
          const manifest = bundle.manifest;
          base.built = true;
          base.partCount = manifest.cost.parts;
          base.triangleCount = manifest.cost.triangles;
          base.parameterCount = manifest.parameters.length;
          base.storyBeats = manifest.story.length;
          base.quizQuestions = manifest.quiz.length;
          base.auditScore = audit?.score ?? null;
          base.repairPasses = bundle.provenance?.repairPasses ?? null;
          base.refinementPasses = bundle.provenance?.refinementPasses ?? null;
          // Structured: the audit's parameterLeverage subjectIds, compared by equality against
          // the parameter ids. Prose matching here once counted a `mass` parameter because a
          // deficiency said "massive".
          base.bindingCount = deriveBindingCount(
            manifest.parameters.map((parameter) => parameter.id),
            audit?.unboundParameterIds ?? [],
          );
        } else if (event.type === 'error') {
          base.failureCode = String(event.code);
          base.failureMessage = String(event.message);
        }
      }
    }
  } catch (error) {
    base.failureCode = 'network';
    base.failureMessage = (error as Error).message;
  }

  base.durationSeconds = Math.round((Date.now() - started) / 1000);
  return base;
}

async function main(): Promise<void> {
  // dotenv for local runs; real environment variables always win — the same discipline as the
  // server's own main.ts. The battery resolves the config itself so its rows can name the model
  // that actually generated them.
  try {
    await import('dotenv/config');
  } catch {
    /* dotenv is optional; env comes from the platform */
  }
  const config = resolveConfig(process.env);

  if (dryRun) {
    const row = dryRunRow(config);
    console.log('dry-run: the history row a zero-topic battery would write (nothing was');
    console.log('generated, nothing appended, no request sent):\n');
    console.log(JSON.stringify(row));
    return;
  }

  const selected = BATTERY.slice(0, limit);
  console.log(`\nEDU-3D topic battery — ${selected.length} topic(s), streaming pipeline`);
  console.log(`prompt ${PROMPT_VERSION} · model ${config.ai.model}\n`);
  console.log(
    'topic'.padEnd(52) +
      'built'.padEnd(7) +
      'parts'.padEnd(7) +
      'binds'.padEnd(7) +
      'score'.padEnd(7) +
      'reps'.padEnd(5) +
      'secs',
  );
  console.log('-'.repeat(91));

  const results: TopicResult[] = [];
  for (const entry of selected) {
    const result = await runTopic(entry.topic, entry.domain);
    results.push(result);
    console.log(
      entry.topic.slice(0, 50).padEnd(52) +
        (result.built ? '✓' : '✗').padEnd(7) +
        String(result.partCount).padEnd(7) +
        String(result.bindingCount).padEnd(7) +
        String(result.auditScore ?? '—').padEnd(7) +
        String(result.repairPasses ?? '—').padEnd(5) +
        String(result.durationSeconds),
    );
    if (result.failureMessage) {
      console.log(`    ↳ ${result.failureCode}: ${result.failureMessage.slice(0, 120)}`);
    }
  }

  const built = results.filter((r) => r.built);
  const summary: BatterySummary = {
    buildRate: built.length / Math.max(1, results.length),
    averagePartCount: built.length
      ? Math.round(built.reduce((s, r) => s + r.partCount, 0) / built.length)
      : 0,
    averageBindingCount: built.length
      ? Math.round(built.reduce((s, r) => s + r.bindingCount, 0) / built.length)
      : 0,
    averageAuditScore: built.length
      ? Math.round(built.reduce((s, r) => s + (r.auditScore ?? 0), 0) / built.length)
      : null,
    totalDurationSeconds: results.reduce((s, r) => s + r.durationSeconds, 0),
  };
  const startedAt = new Date().toISOString();
  const report: BatteryReport = {
    promptVersion: PROMPT_VERSION,
    startedAt,
    model: config.ai.model,
    topics: results,
    summary,
  };

  writeFileSync(outFile, JSON.stringify(report, null, 2));

  // Append to a cumulative history so prompt versions can be compared (`00`: evidence, not vibes).
  const historyPath = path.resolve('battery-history.jsonl');
  const historyLine = JSON.stringify(
    historyRow(PROMPT_VERSION, config.ai.model, summary, startedAt),
  );
  if (existsSync(historyPath)) {
    const prior = readFileSync(historyPath, 'utf8').trim();
    if (prior.length > 0) writeFileSync(historyPath, prior + '\n');
    else writeFileSync(historyPath, '');
  }
  const { appendFileSync } = await import('node:fs');
  appendFileSync(historyPath, historyLine + '\n');

  console.log('\n' + '='.repeat(91));
  console.log(
    `build-rate ${(report.summary.buildRate * 100).toFixed(0)}% · avg parts ${report.summary.averagePartCount} · avg bindings ${report.summary.averageBindingCount} · avg audit ${report.summary.averageAuditScore ?? '—'} · total ${Math.round(report.summary.totalDurationSeconds / 60)}min`,
  );
  console.log(`results: ${outFile}\nhistory: ${historyPath}\n`);
}

// Run only when invoked as a script, so the test suite can import the pure row builders above
// without triggering a battery — a run spends the human's API budget (8 multi-minute generations)
// and is an explicit handoff, never a side effect of importing.
const invokedAsScript =
  process.argv[1] !== undefined && import.meta.filename === path.resolve(process.argv[1]);
if (invokedAsScript) void main();
