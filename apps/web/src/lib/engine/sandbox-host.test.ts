/**
 * The main-thread host's contract, tested with a fake worker.
 *
 * Two failure classes live here, both found by the adversarial audit:
 *
 *  1. **The demo-killer**: a healthy model executed for the crime of being in a background tab.
 *     While the tab is hidden the browser throttles timers — the *host's own watchdog tick* runs
 *     about once a minute on modern Chrome — so `lastHeartbeatAt` at the moment the learner returns
 *     can hold the timestamp of the last hidden tick, sixty seconds stale. The next visible tick
 *     measured that staleness against a 4–30 s threshold and terminated a perfectly healthy model.
 *     The host must feed the tick judgement honest page evidence (hidden *or* a stalled rAF clock)
 *     and honour the re-arm the arithmetic in `watchdog.test.ts` pins.
 *
 *  2. **Stale-worker events**: a worker that was terminated can still have a `MessageEvent` already
 *     posted to the main thread, delivered *after* the replacement spawns. The old handlers called
 *     `handleMessage`/`kill` on the shared host unconditionally, so the stale `loaded` of the
 *     previous model overwrote the panel and — worst — a stale `error` killed the *new* worker
 *     mid-build.
 *
 * Runs in the plain Node environment: the DOM the host touches is hand-stubbed (canvas, container,
 * timers, `document.hidden`, `performance.now`), so the suite owns the wall clock and drives the
 * audit's exact stale-heartbeat sequence in microseconds rather than minutes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelManifest, RuntimeStats } from '@edu3d/contracts';

const { TrackedFakeWorker, workers } = vi.hoisted(() => {
  interface Listener {
    (event: unknown): void;
  }
  class FakeWorker {
    private readonly listeners = new Map<string, Listener[]>();
    sent: unknown[] = [];
    terminated = false;
    addEventListener(type: string, handler: Listener): void {
      const list = this.listeners.get(type) ?? [];
      list.push(handler);
      this.listeners.set(type, list);
    }
    postMessage(message: unknown, _transfer?: Transferable[]): void {
      this.sent.push(message);
    }
    terminate(): void {
      this.terminated = true;
    }
    /** Deliver a message already in flight from this worker (post-terminate delivery, the audit's trigger). */
    emit(data: unknown): void {
      for (const handler of this.listeners.get('message') ?? []) handler({ data });
    }
    /** Deliver an uncaught error event the same way. */
    emitError(message: string): void {
      for (const handler of this.listeners.get('error') ?? []) handler({ message });
    }
  }
  const workers: FakeWorker[] = [];
  class TrackedFakeWorker extends FakeWorker {
    constructor() {
      super();
      workers.push(this);
    }
  }
  return { TrackedFakeWorker, workers };
});

vi.mock('./sandbox-worker.ts?worker', () => ({ default: TrackedFakeWorker }));

import { SandboxHost } from './sandbox-host';
import type { SerializableVerdict } from './sandbox-worker.ts';

/** A manifest with just the fields the host's dev-instrumentation touches. Cast keeps focus. */
function fakeManifest(name: string): ModelManifest {
  return {
    name,
    parts: [],
    parameters: [],
    motions: [],
    metrics: [],
    colorRoles: [],
    story: [],
    quiz: [],
    cost: { triangles: 0, drawCalls: 0 },
  } as unknown as ModelManifest;
}

const fakeVerdict = {
  admitted: true,
  tier: 'high',
  adjustments: [],
  triangles: 0,
  drawCalls: 0,
} as unknown as SerializableVerdict;

const fakeStats = {
  fps: 60,
  frameMillis: 16,
  drawCalls: 1,
  triangles: 8,
  physicsMillis: 0,
  cacheHitRate: 1,
  quality: 'high',
  effectiveTier: 'high',
  simSeconds: 1,
  cameraDistance: 5,
  degradedRungs: [],
} as unknown as RuntimeStats;

/** Workers are pushed on construction; a missing slot is a test-ordering bug worth failing for. */
function workerAt(index: number): InstanceType<typeof TrackedFakeWorker> {
  const worker = workers[index];
  if (!worker) throw new Error(`no fake worker at index ${index}`);
  return worker;
}

/** The DOM surface the host touches, stubbed so the suite owns it. */
let container: HTMLElement;
let hidden = false;
const makeCanvas = (): unknown => ({
  style: {},
  setAttribute: () => undefined,
  remove: () => undefined,
  getContext: () => null,
  transferControlToOffscreen: () => ({}),
});

beforeEach(() => {
  hidden = false;
  workers.length = 0;
  const canvas = makeCanvas();
  const fakeDocument = {
    createElement: () => canvas,
  };
  const fakeWindow = {
    devicePixelRatio: 1,
    setInterval: () => 0,
    clearInterval: () => undefined,
  };
  vi.stubGlobal('document', fakeDocument as unknown as Document);
  vi.stubGlobal('window', fakeWindow as unknown as Window & typeof globalThis);
  vi.stubGlobal('navigator', { hardwareConcurrency: 8, deviceMemory: 8, maxTouchPoints: 0 });
  container = {
    appendChild: () => undefined,
    getBoundingClientRect: () => ({ width: 800, height: 600, left: 0, top: 0 }),
  } as unknown as HTMLElement;
  // The item-1 tests flip the document stub's hidden flag; make the property readable dynamically.
  Object.defineProperty(fakeDocument, 'hidden', { configurable: true, get: () => hidden });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('events from a terminated worker are not applied to the live host', () => {
  const loaded: ModelManifest[] = [];
  const killed: string[] = [];
  let host: SandboxHost | null = null;

  beforeEach(() => {
    loaded.length = 0;
    killed.length = 0;
  });

  afterEach(() => {
    host?.dispose();
    host = null;
  });

  it('ignores a stale `loaded` after the worker was replaced mid-flight', () => {
    host = new SandboxHost(container, {
      onLoaded: (manifest) => loaded.push(manifest),
      onKilled: (reason) => killed.push(reason),
    });
    host.start();
    const first = workerAt(0);
    first.emit({ type: 'loaded', manifest: fakeManifest('model A'), verdict: fakeVerdict });
    expect(loaded).toHaveLength(1);

    // Generate again: the old worker is terminated, a new one spawns — and the old worker's
    // already-posted `loaded` event lands afterwards.
    host.load('model b code', 5);
    const second = workerAt(1);
    expect(first.terminated).toBe(true);

    first.emit({
      type: 'loaded',
      manifest: fakeManifest('model A, stale'),
      verdict: fakeVerdict,
    });
    expect(loaded).toHaveLength(1);
    expect(loaded[0]?.name).toBe('model A'); // the live worker has not loaded anything yet

    // The *current* worker's messages still get through, either way.
    second.emit({ type: 'loaded', manifest: fakeManifest('model B'), verdict: fakeVerdict });
    expect(loaded).toHaveLength(2);
    expect(loaded[1]?.name).toBe('model B');
    expect(killed).toEqual([]);

    // A stale worker keeps sending stats; they must not touch the live host either.
    first.emit({ type: 'stats', stats: fakeStats });
    expect(killed).toEqual([]);
    host.dispose();
  });

  it('a stale worker `error` must not kill the new worker', () => {
    host = new SandboxHost(container, {
      onLoadFailed: () => undefined,
      onKilled: (reason) => killed.push(reason),
    });
    host.start();
    const first = workerAt(0);
    host.load('model b code', 5);
    const second = workerAt(1);

    // The doomed worker's uncaught error was already in flight when terminate() ran.
    first.emitError('stale realm error');

    expect(second.terminated).toBe(false);
    expect(killed).toEqual([]);
    host.dispose();
  });
});

describe('returning to a hidden tab is never a hang', () => {
  const killed: string[] = [];
  let host: SandboxHost | null = null;
  let fakeNow = 0;
  let ticks: Array<() => void>;

  beforeEach(() => {
    fakeNow = 0;
    killed.length = 0;
    ticks = [];
    vi.stubGlobal('performance', { now: () => fakeNow });
    const fakeWindow = {
      devicePixelRatio: 1,
      setInterval: (cb: () => void) => {
        ticks.push(cb);
        return ticks.length;
      },
      clearInterval: () => undefined,
    };
    vi.stubGlobal('window', fakeWindow as unknown as Window & typeof globalThis);
  });

  afterEach(() => {
    host?.dispose();
    host = null;
  });

  /** One watchdog interval pass. */
  const tick = (): void => {
    for (const t of ticks) t();
  };

  it('re-arms when the tab becomes visible again instead of executing the model', () => {
    host = new SandboxHost(container, { onKilled: (reason) => killed.push(reason) });
    host.start();
    const worker = workerAt(0);

    fakeNow = 1_000;
    worker.emit({ type: 'ready' });
    worker.emit({ type: 'loaded', manifest: fakeManifest('probe'), verdict: fakeVerdict });

    // The tab goes hidden. In a real browser the *host's own timer* is what throttles; here the
    // test simply stops ticking while hidden — the same wall-clock gap, without waiting a minute.
    fakeNow = 2_000;
    hidden = true;
    tick(); // one hidden tick happens (as it does before throttling kicks in)

    // ~61 seconds later the learner returns. The next tick is the first visible one, and the last
    // heartbeat refresh is 61 s old — the audit's exact scenario.
    hidden = false;
    fakeNow = 63_000;
    tick();

    expect(killed).toEqual([]);
    expect(worker.terminated).toBe(false);

    // The re-arm must not pardon forever: a live worker keeps posting, and a silent-while-visible
    // worker is still executed on the fresh window (the judgement tests pin that half).
    fakeNow = 70_000;
    worker.emit({ type: 'stats', stats: fakeStats });
    tick();
    fakeNow = 71_500;
    tick();
    expect(killed).toEqual([]);
    host.dispose();
  });

  it('a worker that keeps beating through the hidden period and after the return is never executed', () => {
    // The probe's scenario, at the unit level: the synthetic `hidden` flag does not stop a real
    // browser's rAF, so the worker's messages keep flowing for the entire hidden period and
    // past the return. Every one of them must refresh the liveness the tick judges — a hidden
    // stretch with a live worker is not silence at all, and the return must look exactly like
    // what it is: nothing happened to the worker.
    host = new SandboxHost(container, { onKilled: (reason) => killed.push(reason) });
    host.start();
    const worker = workerAt(0);

    fakeNow = 0;
    worker.emit({
      type: 'loaded',
      manifest: fakeManifest('probe'),
      verdict: fakeVerdict,
    });

    // One beat (a stats publish) per second, through the hide, the hidden stretch, the return,
    // and well past any silence window — the wall-clock rhythm the worker's heartbeat provides
    // once it is wired (see `sandbox-worker.ts:startHeartbeat`).
    hidden = true;
    for (let t = 1_000; t <= 8_000; t += 1_000) {
      fakeNow = t;
      worker.emit({ type: 'stats', stats: fakeStats });
      tick();
      expect(killed).toEqual([]);
    }
    hidden = false;
    for (let t = 9_000; t <= 20_000; t += 1_000) {
      fakeNow = t;
      worker.emit({ type: 'stats', stats: fakeStats });
      tick();
      expect(killed).toEqual([]);
    }
    expect(worker.terminated).toBe(false);
    host.dispose();
  });

  it('still kills a worker that stays silent the whole time while visible', () => {
    host = new SandboxHost(container, { onKilled: (reason) => killed.push(reason) });
    host.start();
    const worker = workerAt(0);

    fakeNow = 1_000;
    worker.emit({
      type: 'loaded',
      manifest: fakeManifest('probe'),
      verdict: fakeVerdict,
    });

    // No further messages: no frame measured yet, so the pre-frame cap (30 s) applies.
    for (let t = 5_000; t <= 30_000; t += 5_000) {
      fakeNow = t;
      tick();
      expect(killed).toEqual([]);
    }
    fakeNow = 32_000;
    tick();
    expect(killed).toHaveLength(1);
    host.dispose();
  });
});
