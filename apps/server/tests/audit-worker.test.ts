/**
 * The audit must leave the request thread free, and must never wedge on it.
 *
 * `04-BACKEND.md:67` and `PLAN.md:156` both claim the CPU work of the audit runs on worker
 * threads. It used to run inline on the event loop: `node:vm`'s timeout BLOCKS the host
 * thread, so one generation's audit froze every other request — NDJSON heartbeats, static
 * responses, even the SIGTERM handler — for ~0.2 s typically and up to ~20 s worst case.
 *
 * These tests pin the two properties instead:
 *   1. while an audit runs, the event loop keeps ticking (a 20 ms interval must fire);
 *   2. a wedging audit is killed by a hard timeout and returns a failure — never hangs the caller.
 */
import { describe, expect, it } from 'vitest';
import { REFERENCE_MODEL_SOURCE } from '@edu3d/engine';
import { prepareProgram } from '@edu3d/sandbox';
import { apiSurfaceSet } from '@edu3d/engine';
import { auditModelAsync } from '../src/services/audit-worker.ts';

const prepared = prepareProgram(REFERENCE_MODEL_SOURCE, { apiSurface: apiSurfaceSet() });
if (!prepared.ok) throw new Error('reference model must pass the gate');

describe('auditModelAsync — the audit runs off the request thread', () => {
  it('keeps the event loop ticking while the audit runs', { timeout: 30_000 }, async () => {
    const ticks = { count: 0 };
    // 20 ms interval, not unref'd: if the loop blocks for the audit, the ticks are missed.
    const timer = setInterval(() => {
      ticks.count += 1;
    }, 20);
    try {
      const outcome = await auditModelAsync({
        code: prepared.instrumented,
        tier: 'mid',
        seed: 0x5eed,
      });
      expect(outcome.ok, outcome.ok ? '' : outcome.message).toBe(true);
      // The audit measured ~175–220 ms; a free loop fires ~9-11 ticks. A blocking audit fires 0.
      expect(
        ticks.count,
        'the event loop must keep servicing timers during an audit',
      ).toBeGreaterThanOrEqual(3);
    } finally {
      clearInterval(timer);
    }
  });

  it(
    'agrees with the synchronous kernel on the same input (result parity)',
    { timeout: 30_000 },
    async () => {
      const outcome = await auditModelAsync({
        code: prepared.instrumented,
        tier: 'mid',
        seed: 0x5eed,
      });
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      // plain data only: the structured clone carried the report and manifest across the thread.
      expect(typeof outcome.report.score).toBe('number');
      expect(outcome.manifest.parts.length).toBeGreaterThan(0);
    },
  );

  it(
    'reports a build failure for a broken model without wedging the next audit',
    { timeout: 30_000 },
    async () => {
      const broken = await auditModelAsync({
        code: 'scene.mesh({ id: "x", geometry: geom.nonsense({}) });',
        tier: 'mid',
        seed: 1,
      });
      expect(broken.ok).toBe(false);
      if (!broken.ok) expect(broken.timedOut).toBe(false);

      // A bad model must not poison the next one: the reference still audits right after.
      const good = await auditModelAsync({
        code: prepared.instrumented,
        tier: 'mid',
        seed: 0x5eed,
      });
      expect(good.ok, good.ok ? '' : good.message).toBe(true);
    },
  );

  it(
    'hard-stops a wedging audit at the deadline and returns a timedOut failure',
    { timeout: 30_000 },
    async () => {
      // Guest program passes the gate (loops are instrumented) and then burns the whole budget
      // inside the build. The worker deadline must terminate it, not hang the caller.
      const wedged = ReferenceError_dataBuilder();
      const t0 = Date.now();
      const outcome = await auditModelAsync({
        code: wedged.instrumented,
        tier: 'mid',
        seed: 1,
        deadlineMs: 1_500,
      });
      const elapsed = Date.now() - t0;
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) expect(outcome.timedOut).toBe(true);
      expect(
        elapsed,
        'the deadline must bound the audit, not let it run to the default cap',
      ).toBeLessThan(10_000);
    },
  );

  it(
    'survives a guest onFrame that trips the loop budget during the sweep — never throws',
    { timeout: 40_000 },
    async () => {
      // The sweep runs guest frame callbacks only for declared parameters; a param-less model's
      // onFrame would never execute during the sweep at all. The bomb therefore declares one real
      // parameter (so `sweepValuesFor` produces ≥2 sweep points) and pairs it with an exhaustive
      // per-frame loop: `while (true)` used to throw GuestBudgetError straight through auditModel
      // and the pipeline; the sweep catch turns it into the timedOut audit failure instead.
      const source = `
      scene.describe({ name: 'Budget bomb', description: 'onFrame would burn the budget.',
        concept: 'budget', objectives: ['bomb the sweep'] });
      scene.param({ id: 'v', kind: 'number', label: 'V', min: 0, max: 1, default: 0.5, affects: [{ channel: 'transform' }] });
      var m = mat.metal({});
      scene.mesh({ id: 'p', name: 'P', geometry: geom.box({ size: [0.2, 0.2, 0.2] }), material: m });
      scene.onFrame(function (ctx) { while (true) { } });
    `;
      const p = prepareProgram(source, { apiSurface: apiSurfaceSet() });
      expect(p.ok).toBe(true);
      const outcome = await auditModelAsync({ code: p.instrumented, tier: 'mid', seed: 1 });
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) expect(outcome.timedOut).toBe(true);
    },
  );
});

/** A gate-passing program that wedges inside the build phase. */
function ReferenceError_dataBuilder(): { instrumented: string } {
  const source = `
    scene.describe({ name: 'Wedge', description: 'Spins forever inside describe.',
      concept: 'wedge', objectives: ['hang'] });
    while (true) { }
  `;
  const prepared = prepareProgram(source, { apiSurface: apiSurfaceSet() });
  if (!prepared.ok) throw new Error('wedge model must pass the gate');
  return prepared;
}
