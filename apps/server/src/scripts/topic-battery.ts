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
 *
 * Metrics per topic, exactly the gate's three:
 *   - buildRate:   did the pipeline return a validated bundle (ready) or fail (error)?
 *   - partCount:   manifest.cost.parts — the "six-box disappointment" detector
 *   - bindingCount: parameters observed to write something during the audit sweep, i.e. total
 *                  parameters minus parameterLeverage deficiencies ("changes nothing visible")
 * Records audit score, repair/refine passes and durations alongside, because those numbers explain
 * the three above when a regression lands.
 */
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const API = 'http://127.0.0.1:8787';

/** The fixed battery: one topic per domain row in `00`'s spectrum, per the doc's own test. */
const BATTERY: ReadonlyArray<{ topic: string; domain: string }> = [
  { topic: 'how does a pendulum work', domain: 'physics/mechanism' },
  { topic: 'how does a four-stroke engine cycle work', domain: 'mechanical/machines' },
  { topic: 'how does a photovoltaic solar cell convert light into electricity', domain: 'electronics/circuits' },
  { topic: 'how does DNA replication work', domain: 'biology' },
  { topic: 'why do the planets orbit the sun', domain: 'astronomy/space' },
  { topic: 'what does the sine function look like in 3D', domain: 'mathematics' },
  { topic: 'how does supply and demand reach equilibrium', domain: 'economics/systems' },
  { topic: 'how does a bridge carry a load', domain: 'architecture/civil' },
];

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
  summary: {
    buildRate: number;
    averagePartCount: number;
    averageBindingCount: number;
    averageAuditScore: number | null;
    totalDurationSeconds: number;
  };
}

const args = process.argv.slice(2);
const countIndex = args.indexOf('--count');
const limit = countIndex >= 0 ? Number(args[countIndex + 1] ?? BATTERY.length) : BATTERY.length;
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
      headers: { 'content-type': 'application/json' },
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
          const audit = event.audit as { score: number; deficiencies: string[] } | undefined;
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
          // bindingCount: parameters that are NOT named in a parameterLeverage deficiency. The
          // audit's deficiency strings carry the parameter id; count parameters not accused.
          const deficiencyText = (audit?.deficiencies ?? []).join('\n').toLowerCase();
          const unbound = manifest.parameters.filter((p) => deficiencyText.includes(p.id.toLowerCase()));
          base.bindingCount = Math.max(0, manifest.parameters.length - unbound.length);
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
  const selected = BATTERY.slice(0, limit);
  console.log(`\nEDU-3D topic battery — ${selected.length} topic(s), streaming pipeline\n`);
  console.log(
    'topic'.padEnd(52) + 'built'.padEnd(7) + 'parts'.padEnd(7) + 'binds'.padEnd(7) + 'score'.padEnd(7) + 'reps'.padEnd(5) + 'secs',
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
  const report: BatteryReport = {
    promptVersion: 'see bundle provenance',
    startedAt: new Date().toISOString(),
    model: 'per server config',
    topics: results,
    summary: {
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
    },
  };

  writeFileSync(outFile, JSON.stringify(report, null, 2));

  // Append to a cumulative history so prompt versions can be compared (`00`: evidence, not vibes).
  const historyPath = path.resolve('battery-history.jsonl');
  const historyLine = JSON.stringify({
    at: report.startedAt,
    ...report.summary,
  });
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

void main();
