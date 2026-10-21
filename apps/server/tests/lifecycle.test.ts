/**
 * Lifecycle service: the drain signal and the generation counter shutdown waits on.
 *
 * `06-BACKEND.md` documents the shutdown contract ("in-flight requests finish, streams are
 * told, hard exit in 15s") — previously nothing in the codebase implemented the "streams are
 * told" or "wait" halves. The lifecycle is the piece main.ts owns and the pipeline and the
 * AI client consult: drain flips the flag, in-flight provider calls abort, open generations
 * are counted so shutdown can wait for them instead of killing the process.
 */
import { describe, expect, it } from 'vitest';
import { createLifecycle } from '../src/services/lifecycle.ts';

describe('createLifecycle', () => {
  it('starts clean: not draining, zero open generations, signal not aborted', () => {
    const lifecycle = createLifecycle();
    expect(lifecycle.draining).toBe(false);
    expect(lifecycle.openGenerations).toBe(0);
    expect(lifecycle.drainSignal.aborted).toBe(false);
  });

  it('beginDrain flips the flag and aborts the signal exactly once', () => {
    const lifecycle = createLifecycle();
    lifecycle.beginDrain();
    expect(lifecycle.draining).toBe(true);
    expect(lifecycle.drainSignal.aborted).toBe(true);
    // Draining twice must not un-abort or throw.
    expect(() => lifecycle.beginDrain()).not.toThrow();
    expect(lifecycle.draining).toBe(true);
  });

  it('waitUntilQuiet resolves immediately when nothing is open', async () => {
    const lifecycle = createLifecycle();
    await lifecycle.waitUntilQuiet(10);
  });

  it('waitUntilQuiet resolves when the last generation ends', async () => {
    const lifecycle = createLifecycle();
    lifecycle.beginGeneration();
    lifecycle.beginGeneration();
    let done = false;
    void lifecycle.waitUntilQuiet(5000).then(() => {
      done = true;
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(done, 'must still wait while generations are open').toBe(false);
    lifecycle.endGeneration();
    await new Promise((r) => setTimeout(r, 20));
    expect(done, 'must not resolve while one generation is open').toBe(false);
    lifecycle.endGeneration();
    await new Promise((r) => setTimeout(r, 20));
    expect(done, 'must resolve once the last generation ends').toBe(true);
  });

  it('waitUntilQuiet resolves on its cap even if a generation hangs', async () => {
    const lifecycle = createLifecycle();
    lifecycle.beginGeneration();
    const t0 = Date.now();
    await lifecycle.waitUntilQuiet(50);
    expect(Date.now() - t0).toBeLessThan(5000);
  }, 10_000);

  it('waitUntilQuiet resolves at once when drain fires with zero generations', async () => {
    const lifecycle = createLifecycle();
    void lifecycle.beginDrain();
    const t0 = Date.now();
    await lifecycle.waitUntilQuiet(5000);
    expect(Date.now() - t0).toBeLessThan(500);
  });

  it('beginDrain while generations are open lets waitUntilQuiet fall through after drain events', async () => {
    const lifecycle = createLifecycle();
    lifecycle.beginGeneration();
    let done = false;
    void lifecycle.waitUntilQuiet(5000).then(() => {
      done = true;
    });
    lifecycle.beginDrain();
    lifecycle.endGeneration();
    await new Promise((r) => setTimeout(r, 20));
    expect(done, 'the last open generation ending must release the waiter').toBe(true);
  });
});
