/**
 * What one frame of the authoring path costs, in bytes.
 *
 * No perf test existed in this repo, so every claim about the frame path was an estimate read off
 * source. This measures it instead, by GC-regressing the heap across a run of frames: sample the
 * heap, run N frames, sample again, divide. That needs no counter in production code and nothing to
 * remove later, and it measures the thing that actually matters — allocation rate — rather than a
 * proxy like call counts.
 *
 * The reference turbofan is the fixture because it is the one model the suite already trusts: it
 * goes through the real static gate, the real instrumentation and the real authoring builder, and it
 * declares real motions with real parameter bindings, so every per-frame code path in the engine is
 * exercised. A toy fixture would report a cost nobody ships.
 *
 * Measured in Node, so it covers the engine's own per-frame cost and not the browser's. That is the
 * right boundary for this suite: the browser half (worker protocol, postMessage, WebGL) is measured
 * by the e2e suite, and the engine must stay DOM-free for this to run at all.
 */
import { describe, expect, it } from 'vitest';
import v8 from 'node:v8';
import vm from 'node:vm';
import { PerformanceObserver, constants } from 'node:perf_hooks';
import { prepareProgram, describeViolations, createGuard } from '@edu3d/sandbox';
import { apiSurfaceSet } from '../src/authoring/api-surface.ts';
import { authorModel, runFrame } from '../src/authoring/guest.ts';
import { applyMotions, type PartTransformLike } from '../src/runtime/motions.ts';
import { REFERENCE_MODEL_SOURCE } from '../src/reference/turbofan.ts';
import { SANDBOX_LIMITS } from '@edu3d/contracts';

/**
 * Obtain a collector without requiring `--expose-gc` on the command line.
 *
 * Vitest 5's pool options did not expose a way to add the flag, and `pnpm verify` invokes vitest
 * directly rather than through the package script, so a CLI flag would have made this benchmark run
 * only for whoever happened to remember it. Flipping the flag inside the process and reading `gc`
 * out of a fresh context works everywhere the suite runs.
 */
const resolveGc = (): (() => void) | null => {
  if (typeof (globalThis as { gc?: unknown }).gc === 'function') {
    return () => (globalThis as unknown as { gc: () => void }).gc();
  }
  try {
    v8.setFlagsFromString('--expose_gc');
    const gc = vm.runInNewContext('gc') as () => void;
    return typeof gc === 'function' ? gc : null;
  } catch {
    return null;
  } finally {
    try {
      v8.setFlagsFromString('--no-expose_gc');
    } catch {
      /* the flag round-trip is best-effort; a failure here does not affect the measurement */
    }
  }
};

/**
 * Frames per sample. Large enough that one-time costs inside the loop amortise to noise, small
 * enough that the test stays well inside the 20s timeout.
 */
const FRAMES_PER_SAMPLE = 2000;

/**
 * Ceiling on RETAINED heap growth per frame, in bytes.
 *
 * Read this constant's name carefully: it is not an allocation-rate budget. The measurement settles
 * the heap before sampling, so what it observes is what the frame path *keeps*, not what it churns.
 * Three consecutive runs measured 14, 47 and 48 bytes/frame, which is the noise floor of this
 * technique rather than a signal about the engine.
 *
 * So what it is good for, and the reason it is here: catching a per-frame LEAK. A frame that
 * retains anything — a growing array, an unbounded map, a closure capturing per-frame state —
 * shows up as hundreds or thousands of bytes per frame and never comes back down. That is a class of
 * bug worth a gate, and this catches it.
 *
 * What it deliberately does NOT catch is transient per-frame allocation churn, which is invisible
 * here because short-lived objects are collected before the second sample. The performance plan's
 * finding of roughly 4,800 short-lived objects per second of idle running is a real cost that this
 * benchmark is blind to by construction. Do not read a green run here as "the frame path is cheap".
 */
const MAX_RETAINED_BYTES_PER_FRAME = 512;

/**
 * Ceiling on p99 frame time for the engine's per-frame path, in milliseconds.
 *
 * A leak is caught by the retained-bytes assertion above; this catches the other kind of regression,
 * where a frame allocates so much short-lived garbage that the scavenger runs constantly. Measured
 * p99 here is a small fraction of a millisecond, so this is set with wide headroom and exists to fail
 * on a step change rather than to police microseconds.
 */
const MAX_P99_FRAME_MILLIS = 5;

describe('the cost of a frame', () => {
  /**
   * The shared fixture: reference model through the real gate and authoring pass, plus a `frame()`
   * in the worker's exact order. Both cost tests drive it — the retained-bytes one and the churn
   * gate — so a disagreement between them is about what they measure, never what they run.
   */
  const prepareHarness = () => {
    const prepared = prepareProgram(REFERENCE_MODEL_SOURCE, { apiSurface: apiSurfaceSet() });
    expect(prepared.ok, describeViolations(prepared.gate).join('\n')).toBe(true);
    if (!prepared.ok) return null;

    // `harden: false`: hardening deletes capabilities from this process's realm and would break every
    // later test in the file. The sandbox package has its own dedicated hardening suite.
    const result = authorModel({
      code: prepared.instrumented,
      tier: 'mid',
      seed: 7,
      harden: false,
    });
    expect(result.ok, result.ok ? '' : result.message).toBe(true);
    if (!result.ok) return null;

    const nodes = new Map(result.manifest.parts.map((part) => [part.id, part]));
    const snapshot = (transform: PartTransformLike): PartTransformLike => ({
      position: [...transform.position],
      ...(transform.rotation ? { rotation: [...transform.rotation] } : {}),
      scale: [...transform.scale],
    });
    // The authored base per motion-driven part, captured at load exactly as the worker does.
    const bases = new Map<string, PartTransformLike>();
    for (const motion of result.manifest.motions) {
      const transform = nodes.get(motion.partId)?.transform;
      if (transform && !bases.has(motion.partId)) bases.set(motion.partId, snapshot(transform));
    }

    const guard = createGuard();
    let elapsed = 0;

    /** One frame in the worker's exact order: host reset → model code → apply declared motions. */
    const frame = (): void => {
      for (const [id, base] of bases) {
        const live = nodes.get(id)?.transform;
        if (!live) continue;
        live.position = [...base.position] as [number, number, number];
        live.rotation = base.rotation
          ? ([...base.rotation] as [number, number, number])
          : undefined;
        live.scale = [...base.scale] as [number, number, number];
      }
      elapsed += 1 / 60;
      runFrame(result.builder, guard, elapsed, 1 / 60, false);
      const params = Object.fromEntries(
        Object.entries(result.builder.currentParameters()).filter(
          (entry): entry is [string, number] => typeof entry[1] === 'number',
        ),
      );
      applyMotions(
        {
          motions: result.manifest.motions,
          baseTransform: (id) => bases.get(id),
          liveTransform: (id) => nodes.get(id)?.transform,
        },
        { params, elapsed },
        false,
      );
    };
    return { frame };
  };

  it('allocates a bounded number of bytes per frame', () => {
    const gc = resolveGc();
    if (!gc) {
      console.warn('[frame-cost] skipped: no collector available in this runtime');
      return;
    }

    const harness = prepareHarness();
    if (!harness) return;
    const { frame } = harness;

    // Warm up: the first frames pay one-time costs (JIT, lazy facade construction, closure creation)
    // that would otherwise be charged to the sample and read as a per-frame cost.
    for (let i = 0; i < 200; i += 1) frame();

    const settle = (): number => {
      gc();
      gc();
      return process.memoryUsage().heapUsed;
    };

    const before = settle();
    // Wall time per frame, recorded alongside the retained-bytes figure. The two answer different
    // questions and neither substitutes for the other: bytes-retained catches a leak, and frame time
    // is what the phase-timeout budget actually cares about. A frame-path change that removes
    // thousands of short-lived objects moves the wall clock and barely moves the retained figure.
    const durations = new Float64Array(FRAMES_PER_SAMPLE);
    for (let i = 0; i < FRAMES_PER_SAMPLE; i += 1) {
      const started = performance.now();
      frame();
      durations[i] = performance.now() - started;
    }
    const after = settle();

    const sorted = Array.from(durations).sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length * 0.5)] ?? 0;
    const p99 = sorted[Math.floor(sorted.length * 0.99)] ?? 0;
    const bytesPerFrame = (after - before) / FRAMES_PER_SAMPLE;
    console.log(
      `[frame-cost] retained ${bytesPerFrame.toFixed(0)} B/frame | frame time median ` +
        `${median.toFixed(4)}ms p99 ${p99.toFixed(4)}ms over ${FRAMES_PER_SAMPLE} frames ` +
        `(budget ${SANDBOX_LIMITS.frameDeadlineMs}ms)`,
    );

    // The frame budget is 50ms for the *model's own callback*; the whole engine frame must sit far
    // under it, so 5ms p99 is a generous ceiling that still fails loudly on a regression that costs
    // real time.
    expect(
      p99,
      `frame path p99 was ${p99.toFixed(4)}ms, over the ${MAX_P99_FRAME_MILLIS}ms ceiling ` +
        `(median ${median.toFixed(4)}ms)`,
    ).toBeLessThan(MAX_P99_FRAME_MILLIS);

    expect(
      bytesPerFrame,
      `engine frame path retained ${bytesPerFrame.toFixed(0)} bytes/frame, over the ` +
        `${MAX_RETAINED_BYTES_PER_FRAME} byte budget`,
    ).toBeLessThan(MAX_RETAINED_BYTES_PER_FRAME);
  });

  /**
   * Ceiling on scavenges attributable to the frame path, over FRAMES_CHURN frames.
   *
   * Pinned from the first measured run: the frame path scavenged 3 times over 20 000 frames against
   * an idle baseline of 0 — roughly 1.2–2.4 KB of short-lived objects per frame, which is the
   * read-off-source estimate of the render-perf spec now converted into a number. The plan's frame
   * tasks cut that churn; this constant is re-pinned downward at this phase's end to the measured
   * remainder plus headroom, and a phase that cannot lower the number has not done what it claimed.
   *
   * The frame-run number is read against an idle baseline over the same iteration count, so
   * scavenges the runtime takes for its own reasons cancel out of the comparison.
   */
  const FRAMES_CHURN = 20_000;
  const MAX_CHURN_SCAVENGES = 5;

  /**
   * Minor-GC events observed while the given body executes.
   *
   * PerformanceObserver callbacks are queued, not synchronous, so the records are drained after the
   * body via macrotask boundaries rather than read inline — reading inline counts almost nothing
   * and makes the gate pass by deafness. GC kinds other than the scavenger (`kMinor`) are excluded:
   * full and incremental marks belong to the runtime's own bookkeeping, not to this file's subject.
   *
   * The `control` run exists because a gate that cannot see degradation is worse than no gate: it
   * allocates millions of small objects, asserts it saw at least one scavenge, and thereby proves
   * the observer works before the frame-run number is allowed to mean anything.
   */
  const countScavenges = async (frames: number, body: (i: number) => void): Promise<number> => {
    let count = 0;
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        // The scavenger discriminant moved: current Node exposes it as `detail.kind` (1 = minor gc),
        // where `entry.kind` used to sit flat on the entry. Read both, prefer detail, and compare
        // against the constant so a version that reshapes this again fails the control below rather
        // than silently passing — the control run is what keeps this reader honest.
        const detail = (entry as unknown as { detail?: { kind?: number } }).detail;
        const flat = (entry as unknown as { kind?: number }).kind;
        const kind = detail?.kind ?? flat;
        if (kind === constants.NODE_PERFORMANCE_GC_MINOR) count += 1;
      }
    });
    observer.observe({ entryTypes: ['gc'] });
    try {
      for (let i = 0; i < frames; i += 1) body(i);
      // Two macrotask turns: observer callbacks queue behind the current synchronous block, and a
      // scavenge triggered by the last few frames can land in either.
      await new Promise<void>((resolve) => setImmediate(resolve));
      await new Promise<void>((resolve) => setImmediate(resolve));
    } finally {
      observer.disconnect();
    }
    return count;
  };

  it('does not churn: frame-run scavenges stay near an idle-run baseline', async () => {
    const harness = prepareHarness();
    if (!harness) return;
    const { frame } = harness;

    // Instrument self-check: four million escaping small objects must read as scavenges. They are
    // pushed into an array deliberately — an object that never escapes is scalar-replaced by V8 and
    // allocates nothing, so a control written the obvious way proves V8's optimiser, not the
    // observer. If this ever reads zero the instrument is broken and the frame number below is
    // meaningless — fail loudly rather than vacuously.
    let sink: object[] = [];
    const control = await countScavenges(4_000_000, (i) => {
      sink.push({ i, pad: i * 2 });
      if (sink.length >= 100_000) sink = [];
    });
    expect(
      control,
      'the churn observer saw no scavenge while allocating four million objects — ' +
        'the instrument is broken, so the frame-run figure is meaningless',
    ).toBeGreaterThanOrEqual(1);

    // The idle baseline executes the same iteration count doing no allocation, so scavenges the
    // runtime takes for its own reasons land on both sides and cancel.
    const idle = await countScavenges(FRAMES_CHURN, (i) => {
      if (Math.sin(i) > 2) throw new Error('unreachable');
    });
    const running = await countScavenges(FRAMES_CHURN, () => frame());
    console.log(
      `[frame-cost] churn: control ${control} | idle ${idle} vs frame-run ${running} ` +
        `over ${FRAMES_CHURN} frames`,
    );
    expect(
      running,
      `frame path scavenged ${running} times vs idle baseline ${idle} over ` +
        `${FRAMES_CHURN} frames — the frame path is allocating`,
    ).toBeLessThanOrEqual(idle + MAX_CHURN_SCAVENGES);
  });
});
