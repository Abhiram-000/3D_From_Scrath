/**
 * The main-thread host: the page's side of the sandbox boundary.
 *
 * It owns the `<canvas>` element, spawns the worker, forwards input, and — most importantly — holds the kill
 * switch. `00-GOAL.md` requires that "a model that crashes or runs forever must be killable without taking down
 * the viewer", and `worker.terminate()` is the only mechanism that can interrupt synchronous guest code from
 * outside. Everything else in the sandbox is defence in depth; this is the guarantee.
 *
 * Two consequences shape the design:
 *
 *  - **`transferControlToOffscreen()` is once per element.** After a terminate the canvas is spent, so recovery
 *    means replacing the element and re-transferring. That is why this class owns the canvas rather than receiving
 *    one, and why `recreateCanvas` exists.
 *  - **One worker per model load.** Terminating on swap is the leak fix as much as the safety fix: the GPU
 *    context, the WASM heap and every listener die with the worker, which is what keeps memory flat across the
 *    dozens of generate/load cycles `08` requires.
 *
 * All rendering happens here, on the learner's device. The server is never involved in a frame.
 */
import type { DeviceTier, ModelManifest, RuntimeStats } from '@edu3d/contracts';
import type { SerializableVerdict, WorkerRequest, WorkerResponse } from './sandbox-worker.ts';
import SandboxWorker from './sandbox-worker.ts?worker';

/** What the viewer subscribes to. Each callback is optional so a caller takes only what it needs. */
export interface HostCallbacks {
  onReady?: () => void;
  onLoaded?: (manifest: ModelManifest, verdict: SerializableVerdict) => void;
  onLoadFailed?: (message: string, timedOut: boolean, logs: string[]) => void;
  onStats?: (stats: RuntimeStats) => void;
  onMetrics?: (values: Record<string, number>) => void;
  onHover?: (partId: string | null) => void;
  onSelected?: (partId: string | null) => void;
  onLog?: (level: 'log' | 'warn' | 'error', message: string) => void;
  onNotice?: (message: string) => void;
  onSnapshot?: (blob: Blob) => void;
  /** Fired when the watchdog killed the worker. The viewer stays alive; the model is gone. */
  onKilled?: (reason: string) => void;
}

/** Watchdog thresholds. Each is a number with a reason, not a guess. */
const WATCHDOG = {
  /**
   * Minimum milliseconds without proof of life before the worker is considered hung.
   *
   * The worker beats every second, and *any* message from it proves the event loop is turning. Four seconds is
   * four missed beats — comfortably beyond a slow frame or a GC pause on an ordinary device, and short enough that
   * a learner has not yet decided the page is broken. On a slow device the effective timeout rises with the
   * measured frame time (see `frameSlackMultiplier`), because the alternative was observed in CI: a healthy model
   * rendering long frames under a software rasterizer was killed for "not responding".
   */
  heartbeatTimeoutMs: 4_000,
  /**
   * How many average frames of slack the adaptive timeout grants.
   *
   * A device whose frames genuinely take a second needs a longer silence than one whose frames take 16 ms, or
   * every slow-but-alive model is executed. Six frames past the average is far enough that only a truly wedged
   * loop (which sends nothing, ever) can cross it, and near enough that a real hang is still caught in seconds.
   */
  frameSlackMultiplier: 6,
  /** The adaptive timeout is capped so a pathological stats value cannot disable the watchdog entirely. */
  maxHeartbeatTimeoutMs: 30_000,
  /**
   * Grace period after a load request before heartbeat monitoring resumes, per device tier.
   *
   * A build legitimately blocks the worker's event loop for seconds — marching cubes on a complex SDF is the usual
   * case — and killing a model for successfully building would be absurd. The build deadline inside the worker is
   * the mechanism that bounds this phase.
   *
   * It is tier-scaled for the same reason `heartbeatTimeoutMs` scales with measured frame time: the worker cannot
   * beat while it is compiling shaders, so the grace has to cover realization AND first-frame shader compilation,
   * and that cost is several times higher on a weak device. A single flat number made a software rasterizer flaky
   * — the same build finished in 16 s or was killed at 25 s depending on the run — so the suite that is supposed to
   * catch regressions could not be trusted to. The kill still happens; it just stops firing on work that was going
   * to finish.
   */
  buildGraceMsByTier: {
    low: 60_000,
    mid: 40_000,
    high: 25_000,
  },
} as const;

/** Device detection, run once. `08`: detect cheaply at startup, then trust *measured behaviour* over strings. */
export function detectTier(): { tier: DeviceTier; pixelRatio: number; reasons: string[] } {
  const reasons: string[] = [];
  const cores = navigator.hardwareConcurrency ?? 4;
  const memory = (navigator as unknown as { deviceMemory?: number }).deviceMemory ?? 4;
  const pixelRatio = window.devicePixelRatio || 1;
  const touch = navigator.maxTouchPoints > 0;

  let renderer = '';
  try {
    // A throwaway context purely to read the GPU string. Lost immediately so it does not hold a GPU allocation.
    const probe = document.createElement('canvas').getContext('webgl2');
    const info = probe?.getExtension('WEBGL_debug_renderer_info');
    if (probe && info) renderer = String(probe.getParameter(info.UNMASKED_RENDERER_WEBGL) ?? '');
    probe?.getExtension('WEBGL_lose_context')?.loseContext();
  } catch {
    // Blocked by a privacy setting. Core count and memory are enough for an opening guess.
  }

  let tier: DeviceTier = 'mid';

  // Known-weak GPU families. String matching is a heuristic, and `08` is explicit that the live frame-time monitor
  // is the truth — this only decides where to *start*. Software rasterizers are weak by definition: a model that
  // runs at full detail under SwiftShader/llvmpipe renders at a few frames per second.
  if (
    /mali-[46]|adreno [345]|powervr|intel.*hd graphics [23]|swiftshader|llvmpipe|softpipe|software/i.test(
      renderer,
    )
  ) {
    tier = 'low';
    reasons.push(`GPU "${renderer}" is a low-tier family`);
  } else if (/rtx|radeon rx|apple m[1-9]|adreno 7|arc a/i.test(renderer)) {
    tier = 'high';
    reasons.push(`GPU "${renderer}" is a high-tier family`);
  }

  if (cores <= 4) {
    if (tier === 'high') tier = 'mid';
    else tier = 'low';
    reasons.push(`${cores} logical cores`);
  } else if (cores >= 12 && tier !== 'low') {
    tier = 'high';
    reasons.push(`${cores} logical cores`);
  }

  if (memory <= 4 && tier !== 'low') {
    tier = 'mid';
    reasons.push(`${memory} GB device memory`);
  }

  // A high-DPR phone is the case `08` singles out: pixel ratio is the first and biggest lever, because a 3× screen
  // means nine times the fragments for the same layout.
  if (touch && pixelRatio >= 2.5 && tier === 'high') {
    tier = 'mid';
    reasons.push(`touch device at ${pixelRatio}× pixel ratio`);
  }

  return { tier, pixelRatio, reasons };
}

/** True when the browser can run the sandbox at all. */
export function sandboxSupported(): { supported: boolean; reason?: string } {
  if (typeof Worker === 'undefined') {
    return { supported: false, reason: 'This browser does not support Web Workers.' };
  }
  if (typeof OffscreenCanvas === 'undefined') {
    return {
      supported: false,
      reason:
        'This browser cannot render off the main thread. Try Chrome, Edge, Firefox 105+, or Safari 16.4+.',
    };
  }
  const probe = document.createElement('canvas');
  if (!probe.getContext('webgl2')) {
    return { supported: false, reason: 'This browser or device does not support WebGL 2.' };
  }
  if (typeof probe.transferControlToOffscreen !== 'function') {
    return { supported: false, reason: 'This browser cannot transfer a canvas to a worker.' };
  }
  return { supported: true };
}

export class SandboxHost {
  private worker: Worker | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private readonly container: HTMLElement;
  private readonly callbacks: HostCallbacks;
  private readonly tier: DeviceTier;
  private readonly pixelRatio: number;

  private lastHeartbeatAt = 0;
  /** Rolling average frame cost the worker last reported, so the timeout can follow measured reality. */
  private lastFrameMillis = 0;
  private watchdogTimer: number | null = null;
  private buildingUntil = 0;
  private disposed = false;

  /** Retained so a kill can be recovered from by reloading the same program into a fresh worker. */
  private lastProgram: { code: string; seed: number; runtime?: string } | null = null;
  private theme = { top: '#17130f', bottom: '#08070a' };

  constructor(container: HTMLElement, callbacks: HostCallbacks = {}) {
    this.container = container;
    this.callbacks = callbacks;
    const detected = detectTier();
    this.tier = detected.tier;
    // Capped here rather than in the worker so the cap is visible to the page's own layout maths.
    this.pixelRatio = Math.min(detected.pixelRatio, 2);
  }

  get deviceTier(): DeviceTier {
    return this.tier;
  }

  /**
   * Create the canvas and hand it to a fresh worker.
   *
   * Called on construction and again after every terminate, because `transferControlToOffscreen` cannot be
   * repeated on an element whose control was already transferred.
   */
  start(): void {
    if (this.disposed) return;
    this.recreateCanvas();
    this.spawnWorker();
  }

  private recreateCanvas(): void {
    if (this.canvas) this.canvas.remove();

    const canvas = document.createElement('canvas');
    canvas.style.display = 'block';
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    // The canvas is decorative to assistive technology: the model's content is exposed through the info panel and
    // the part list, which are real text. A canvas cannot be read by a screen reader either way, so claiming
    // otherwise with an ARIA role would be a lie.
    canvas.setAttribute('aria-hidden', 'true');
    this.container.appendChild(canvas);
    this.canvas = canvas;
  }

  private spawnWorker(): void {
    if (!this.canvas) return;

    const worker = new SandboxWorker();
    this.worker = worker;

    worker.addEventListener('message', (event: MessageEvent<WorkerResponse>) => {
      this.handleMessage(event.data);
    });

    worker.addEventListener('error', (event: ErrorEvent) => {
      // A worker-level error is not recoverable in place: the realm may be half-hardened. Kill and report.
      const where = [event.filename, event.lineno, event.colno].filter(Boolean).join(':');
      const detail =
        event.error instanceof Error && event.error.stack
          ? ` ${event.error.stack.split('\n')[1]?.trim() ?? ''}`
          : '';
      this.kill(
        `The 3D engine stopped unexpectedly: ${event.message}${where ? ` (${where})` : ''}${detail}`,
      );
    });

    const rect = this.container.getBoundingClientRect();
    const width = Math.max(1, Math.floor(rect.width));
    const height = Math.max(1, Math.floor(rect.height));

    const offscreen = this.canvas.transferControlToOffscreen();
    this.send(
      {
        type: 'init',
        canvas: offscreen,
        width,
        height,
        pixelRatio: this.pixelRatio,
        tier: this.tier,
        theme: this.theme,
      },
      [offscreen],
    );

    this.lastHeartbeatAt = performance.now();
    this.startWatchdog();
  }

  private send(message: WorkerRequest, transfer?: Transferable[]): void {
    if (!this.worker) return;
    if (transfer && transfer.length > 0) this.worker.postMessage(message, transfer);
    else this.worker.postMessage(message);
  }

  private handleMessage(message: WorkerResponse): void {
    // Any message is proof the worker's event loop is turning, so it cannot be hung. Treating only the
    // explicit heartbeat this way meant a busy-but-alive worker sending stats and hover events could still be
    // executed once its *frames* outgrew the fixed timeout — which is exactly what the CI failure showed.
    this.lastHeartbeatAt = performance.now();

    switch (message.type) {
      case 'ready':
        this.callbacks.onReady?.();
        break;
      case 'loaded':
        // The build phase is over, so heartbeat monitoring resumes at normal sensitivity.
        this.buildingUntil = 0;
        this.lastHeartbeatAt = performance.now();
        this.callbacks.onLoaded?.(message.manifest, message.verdict);
        break;
      case 'loadFailed':
        this.buildingUntil = 0;
        this.callbacks.onLoadFailed?.(message.message, message.timedOut, message.logs);
        break;
      case 'stats':
        // The timeout follows measured frame cost: a device whose frames take a second needs more slack than
        // the fixed floor, per `08`'s "the live frame-time monitor is the truth; trust behavior over strings".
        this.lastFrameMillis = message.stats.frameMillis;
        this.callbacks.onStats?.(message.stats);
        break;
      case 'metrics':
        this.callbacks.onMetrics?.(message.values);
        break;
      case 'hover':
        this.callbacks.onHover?.(message.partId);
        break;
      case 'selected':
        this.callbacks.onSelected?.(message.partId);
        break;
      case 'log':
        this.callbacks.onLog?.(message.level, message.message);
        break;
      case 'notice':
        this.callbacks.onNotice?.(message.message);
        break;
      case 'snapshot':
        this.callbacks.onSnapshot?.(message.blob);
        break;
      case 'disposed':
        break;
      default:
        break;
    }
  }

  /**
   * The watchdog.
   *
   * Checks liveness on a timer rather than reacting to a missed beat, because a hung worker sends nothing at all —
   * there is no event to react to. This is the outer guarantee behind the injected loop guards: the guards catch
   * the common case with an actionable message, and this catches everything else.
   */
  private startWatchdog(): void {
    this.stopWatchdog();
    this.watchdogTimer = window.setInterval(() => {
      if (!this.worker) return;

      // A build legitimately blocks the worker's loop, so monitoring pauses until the grace period expires.
      const now = performance.now();
      if (this.buildingUntil > now) return;

      // A hidden tab stops `requestAnimationFrame`, so heartbeats stop legitimately. Killing a model because the
      // learner switched tabs would be a spectacular own goal.
      if (document.hidden) {
        this.lastHeartbeatAt = now;
        return;
      }

      if (now - this.lastHeartbeatAt > this.currentHeartbeatTimeoutMs()) {
        this.kill(
          'This model stopped responding and was stopped to keep the page usable. You can try generating it again.',
        );
      }
    }, 1_000);
  }

  private stopWatchdog(): void {
    if (this.watchdogTimer !== null) {
      window.clearInterval(this.watchdogTimer);
      this.watchdogTimer = null;
    }
  }

  /**
   * The silence threshold, adapted to what the device actually achieves.
   *
   * A fixed timeout judged slow devices by fast-device rules; the adaptive form keeps the same guarantee
   * (a wedged loop sends *nothing*, so it crosses any threshold) while granting a genuinely slow GPU the
   * seconds its own frames prove it needs.
   */
  private currentHeartbeatTimeoutMs(): number {
    const adaptive =
      WATCHDOG.heartbeatTimeoutMs + this.lastFrameMillis * WATCHDOG.frameSlackMultiplier;
    return Math.min(
      WATCHDOG.maxHeartbeatTimeoutMs,
      Math.max(WATCHDOG.heartbeatTimeoutMs, adaptive),
    );
  }

  /**
   * Terminate the worker and rebuild the host.
   *
   * The viewer survives: `00` requires that a failed model "must not take the viewer down. Show the error, keep the
   * page alive, offer a retry." The canvas is replaced because its control is spent.
   */
  kill(reason: string): void {
    this.stopWatchdog();
    this.worker?.terminate();
    this.worker = null;
    this.callbacks.onKilled?.(reason);
    if (!this.disposed) this.start();
  }

  /**
   * Load a program.
   *
   * A fresh worker per load, deliberately. Reusing one would leave the previous model's GPU objects, WASM heap and
   * closures alive in a realm that is already hardened — and hardened means the new load could not re-acquire what
   * it needs. Terminating is both the leak fix and the correctness fix.
   *
   * `runtime` is the instrumented twin of `code` and the string the worker actually compiles; `code`
   * travels with it for the diagnostics panel. Omitted for the reference source and pre-guard
   * bundles, which load the clean string exactly as they always have.
   */
  load(code: string, seed = Math.floor(Math.random() * 0xffffffff), runtime?: string): void {
    this.lastProgram = { code, seed, ...(runtime ? { runtime } : {}) };
    // Restart so each model gets a clean realm.
    this.stopWatchdog();
    this.worker?.terminate();
    this.worker = null;
    this.recreateCanvas();
    this.spawnWorker();

    this.buildingUntil = performance.now() + WATCHDOG.buildGraceMsByTier[this.tier];
    this.send({ type: 'load', code, seed, ...(runtime ? { runtime } : {}) });
  }

  /** Retry the last program in a fresh worker. */
  reload(): void {
    if (!this.lastProgram) return;
    this.load(this.lastProgram.code, this.lastProgram.seed, this.lastProgram.runtime);
  }

  resize(): void {
    const rect = this.container.getBoundingClientRect();
    this.send({
      type: 'resize',
      width: Math.max(1, Math.floor(rect.width)),
      height: Math.max(1, Math.floor(rect.height)),
      pixelRatio: this.pixelRatio,
    });
  }

  setParameter(id: string, value: number | boolean | string): void {
    this.send({ type: 'setParameter', id, value });
  }

  setPaused(paused: boolean): void {
    this.send({ type: 'setPaused', paused });
  }

  setTimeScale(scale: number): void {
    this.send({ type: 'setTimeScale', scale });
  }

  resetTime(): void {
    this.send({ type: 'resetTime' });
  }

  pointer(x: number, y: number, kind: 'move' | 'down' | 'up'): void {
    this.send({ type: 'pointer', x, y, kind });
  }

  orbit(deltaX: number, deltaY: number): void {
    this.send({ type: 'orbit', deltaX, deltaY });
  }

  zoom(delta: number): void {
    this.send({ type: 'zoom', delta });
  }

  pan(deltaX: number, deltaY: number): void {
    this.send({ type: 'pan', deltaX, deltaY });
  }

  focusPart(partId: string | null): void {
    this.send({ type: 'focusPart', partId });
  }

  /** Standard camera angles (`03`): "show me it from the side" without fumbling an orbit. */
  viewPreset(preset: 'front' | 'back' | 'left' | 'right' | 'top' | 'bottom' | 'iso'): void {
    this.send({ type: 'viewPreset', preset });
  }

  setViewMode(mode: 'normal' | 'xray' | 'wireframe' | 'explode'): void {
    this.send({ type: 'setViewMode', mode });
  }

  setTheme(theme: { top: string; bottom: string }): void {
    this.theme = theme;
    this.send({ type: 'setTheme', theme });
  }

  /** Ask for a PNG. Rendered on this device; the server only ever stores the bytes. */
  requestSnapshot(width = 1200, height = 675): void {
    this.send({ type: 'snapshot', width, height });
  }

  dispose(): void {
    this.disposed = true;
    this.stopWatchdog();
    this.send({ type: 'dispose' });
    // Terminating immediately rather than awaiting the `disposed` reply: a worker that is already wedged would
    // never send it, and the page must not leak a thread waiting for a message that is not coming.
    this.worker?.terminate();
    this.worker = null;
    this.canvas?.remove();
    this.canvas = null;
  }
}
