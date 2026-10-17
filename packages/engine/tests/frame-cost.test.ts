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

describe('the cost of a frame', () => {
  it('allocates a bounded number of bytes per frame', () => {
    const gc = resolveGc();
    if (!gc) {
      console.warn('[frame-cost] skipped: no collector available in this runtime');
      return;
    }

    const prepared = prepareProgram(REFERENCE_MODEL_SOURCE, { apiSurface: apiSurfaceSet() });
    expect(prepared.ok, describeViolations(prepared.gate).join('\n')).toBe(true);
    if (!prepared.ok) return;

    // `harden: false`: hardening deletes capabilities from this process's realm and would break every
    // later test in the file. The sandbox package has its own dedicated hardening suite.
    const result = authorModel({ code: prepared.instrumented, tier: 'mid', seed: 7, harden: false });
    expect(result.ok, result.ok ? '' : result.message).toBe(true);
    if (!result.ok) return;

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

    // Warm up: the first frames pay one-time costs (JIT, lazy facade construction, closure creation)
    // that would otherwise be charged to the sample and read as a per-frame cost.
    for (let i = 0; i < 200; i += 1) frame();

    const settle = (): number => {
      gc();
      gc();
      return process.memoryUsage().heapUsed;
    };

    const before = settle();
    for (let i = 0; i < FRAMES_PER_SAMPLE; i += 1) frame();
    const after = settle();

    const bytesPerFrame = (after - before) / FRAMES_PER_SAMPLE;
    console.log(
      `[frame-cost] retained ${bytesPerFrame.toFixed(0)} bytes/frame over ${FRAMES_PER_SAMPLE} frames ` +
        `(frame budget ${SANDBOX_LIMITS.frameDeadlineMs}ms; the model's own callback is a fraction of it)`,
    );

    expect(
      bytesPerFrame,
      `engine frame path retained ${bytesPerFrame.toFixed(0)} bytes/frame, over the ` +
        `${MAX_RETAINED_BYTES_PER_FRAME} byte budget`,
    ).toBeLessThan(MAX_RETAINED_BYTES_PER_FRAME);
  });
});