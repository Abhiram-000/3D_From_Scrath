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
import type { DeviceTier, ModelManifest, QualityPreset, RuntimeStats } from '@edu3d/contracts';
import type { SerializableVerdict, WorkerRequest, WorkerResponse } from './sandbox-worker.ts';
import SandboxWorker from './sandbox-worker.ts?worker';
import {
  devEnabled,
  devError,
  devLog,
  devWarn,
  formatFailure,
  formatModelSummary,
  formatStats,
} from '../dev-console.ts';
import {
  WATCHDOG_KILL_REASON,
  buildGraceMs,
  heartbeatTimeoutMs,
  judgeWatchdogTick,
  renderSuppressed,
  type WatchdogState,
} from './watchdog.ts';

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

/**
 * The watchdog's thresholds live in `watchdog.ts`, as tested arithmetic: the patience this host
 * shows a slow-but-alive worker is a policy decision, and a policy decision that cannot be tested
 * is a policy decision that drifts.
 */

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

  /**
   * The watchdog's judgement state: the last heartbeat (or re-arm), whether the page had its
   * frame production suppressed since the last visible tick, and the dev-warn latch. The
   * arithmetic that consumes it lives in `watchdog.ts`, tested without a DOM.
   */
  private watchdogState: WatchdogState = {
    lastHeartbeatAt: 0,
    wasSuppressed: false,
    warned: false,
  };
  /**
   * When a main-thread `requestAnimationFrame` last fired.
   *
   * `Infinity` until the probe starts: an unmeasurable clock must never read as "stalled", or a
   * renderer-less environment would enjoy an unlimited silence pass. The probe exists for the
   * occluded-window case — `document.hidden` stays false there while rAF (ours and the worker's)
   * stalls — and one do-nothing callback at page refresh rate costs nothing.
   */
  private rafLastFiredAt = Number.POSITIVE_INFINITY;
  private rafProbeRunning = false;
  /** Rolling average frame cost the worker last reported, so the timeout can follow measured reality. */
  private lastFrameMillis = 0;
  /**
   * Whether the worker has presented a frame and reported what it cost.
   *
   * Until it has, there is no measurement to scale the silence by, and the frame in question is
   * the most expensive one the worker will ever present — the one that compiles every shader.
   */
  private hasMeasuredFrame = false;
  private watchdogTimer: number | null = null;
  private buildingUntil = 0;
  private disposed = false;

  /** The learner's pinned quality, if any. Read at spawn, so a respawn keeps their choice. */
  private pinnedQuality: QualityPreset | null;

  /** Retained so a kill can be recovered from by reloading the same program into a fresh worker. */
  private lastProgram: { code: string; seed: number; runtime?: string } | null = null;
  private theme = { top: '#17130f', bottom: '#08070a' };
  /** Dev-only instrumentation state: load-start clock and stats cadence. */
  private loadStartedAt = 0;
  private statsPublished = 0;

  constructor(
    container: HTMLElement,
    callbacks: HostCallbacks = {},
    options: { quality?: QualityPreset | null } = {},
  ) {
    this.container = container;
    this.callbacks = callbacks;
    const detected = detectTier();
    this.tier = detected.tier;
    // Capped here rather than in the worker so the cap is visible to the page's own layout maths.
    this.pixelRatio = Math.min(detected.pixelRatio, 2);
    this.pinnedQuality = options.quality ?? null;
  }

  get deviceTier(): DeviceTier {
    return this.tier;
  }

  /**
   * Set the learner's pinned quality, or null to hand the decision back to the adaptive ladder.
   *
   * Sent to the live worker rather than waiting for a reload: a control that only takes effect the
   * next time the model loads is a control that appears broken.
   */
  setQuality(quality: QualityPreset | null): void {
    this.pinnedQuality = quality;
    this.send({ type: 'setQuality', quality });
  }

  /**
   * Create the canvas and hand it to a fresh worker.
   *
   * Called on construction and again after every terminate, because `transferControlToOffscreen` cannot be
   * repeated on an element whose control was already transferred.
   */
  start(): void {
    if (this.disposed) return;
    this.startRenderProbe();
    this.recreateCanvas();
    this.spawnWorker();
  }

  /**
   * The occlusion probe: one recurring, do-nothing main-thread `requestAnimationFrame`.
   *
   * Fires whenever the compositor produces a frame. In an occluded or minimized window — the case
   * `document.hidden` cannot see — it stalls, and the watchdog reads that stall as "the page could
   * not have presented anyway". Guarded on availability: an environment without rAF keeps
   * `rafLastFiredAt` at infinity, which can never read as stalled.
   */
  private startRenderProbe(): void {
    if (this.rafProbeRunning || typeof window.requestAnimationFrame !== 'function') return;
    this.rafProbeRunning = true;
    const beat = (): void => {
      if (!this.rafProbeRunning) return;
      this.rafLastFiredAt = performance.now();
      window.requestAnimationFrame(beat);
    };
    window.requestAnimationFrame(beat);
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

    // Every event is scoped to the worker it came from — captured here, compared on delivery.
    // `terminate()` discards messages still queued *inside* a worker, but a `MessageEvent` already
    // posted to the main thread is still delivered afterwards: a stale `loaded` would set the
    // panel to the previous model, a stale `stats` would refresh the heartbeat of a worker that
    // is not running, and a stale `error` would call `kill()` on the *new* worker and destroy the
    // model in flight. Anything not from the current worker is not this session's news.
    worker.addEventListener('message', (event: MessageEvent<WorkerResponse>) => {
      if (this.worker !== worker) return;
      this.handleMessage(event.data);
    });

    worker.addEventListener('error', (event: ErrorEvent) => {
      if (this.worker !== worker) return;
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
        // The learner's pinned quality travels with the init rather than after it: the ladder can
        // step inside the first second, and a pin that arrives late is one the optimizer already
        // overrode.
        quality: this.pinnedQuality,
      },
      [offscreen],
    );

    if (devEnabled)
      devLog(
        `canvas ${width}×${height} @${this.pixelRatio} DPR · tier ${this.tier} · theme ${this.theme.top}`,
      );
    // A fresh worker starts its watchdog clock now: nothing may be judged across the spawn.
    this.watchdogState = {
      lastHeartbeatAt: performance.now(),
      wasSuppressed: false,
      warned: false,
    };
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
    this.watchdogState.lastHeartbeatAt = performance.now();

    // Dev-only console instrumentation (compiled out of production). `08`'s honesty rule applies to
    // developers too: a stalled build must be attributable to a stage, not reconstructed afterwards.
    if (devEnabled) {
      if (message.type === 'log') {
        // Guest console output and engine stage telemetry share this channel; both print live.
        devLog(message.message);
      } else if (message.type === 'notice') {
        devWarn(message.message);
      }
    }

    switch (message.type) {
      case 'ready':
        this.callbacks.onReady?.();
        break;
      case 'loaded':
        // The build phase is over, so heartbeat monitoring resumes at normal sensitivity.
        this.buildingUntil = 0;
        this.watchdogState.lastHeartbeatAt = performance.now();
        // A new model has presented no frame yet, so the first frame — the one that compiles every
        // shader — gets the patience the policy gives an unmeasured worker.
        this.hasMeasuredFrame = false;
        if (devEnabled) {
          const { manifest, verdict } = message;
          devLog(
            formatModelSummary({
              name: manifest.name,
              ms: performance.now() - this.loadStartedAt,
              parts: manifest.parts.length,
              parameters: manifest.parameters.length,
              motions: manifest.motions.length,
              triangles: manifest.cost.triangles,
              drawCalls: manifest.cost.drawCalls,
            }),
            `${verdict.adjustments.length} admission adjustment(s) — see notices`,
          );
        }
        this.callbacks.onLoaded?.(message.manifest, message.verdict);
        break;
      case 'loadFailed':
        this.buildingUntil = 0;
        if (devEnabled) {
          devError(
            formatFailure({
              message: message.message,
              timedOut: message.timedOut,
              logCount: message.logs.length,
            }),
          );
          for (const line of message.logs.slice(-25)) devLog(`guest log: ${line}`);
        }
        this.callbacks.onLoadFailed?.(message.message, message.timedOut, message.logs);
        break;
      case 'stats':
        // The timeout follows measured frame cost: a device whose frames take a second needs more slack than
        // the fixed floor, per `08`'s "the live frame-time monitor is the truth; trust behavior over strings".
        this.lastFrameMillis = message.stats.frameMillis;
        this.hasMeasuredFrame = true;
        if (devEnabled) {
          this.statsPublished += 1;
          if (this.statsPublished % 5 === 1) {
            devLog(
              formatStats({
                fps: message.stats.fps,
                draws: message.stats.drawCalls,
                triangles: message.stats.triangles,
                seconds: Math.round(message.stats.simSeconds),
              }),
            );
          }
        }
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

      // The whole tick is one judgement, made by tested arithmetic (`watchdog.ts`): grace first,
      // then "could the page have produced a frame at all" — a hidden tab *or* an occluded window
      // (rAF stalled, `document.hidden` still false), then the silence itself, measured only
      // against a clock that was last re-armed while the page could render.
      const nowMs = performance.now();
      const verdict = judgeWatchdogTick({
        state: this.watchdogState,
        nowMs,
        suppressed: renderSuppressed({
          hidden: document.hidden,
          msSinceRaf: nowMs - this.rafLastFiredAt,
        }),
        graceUntil: this.buildingUntil,
        timeoutMs: this.currentHeartbeatTimeoutMs(),
      });
      this.watchdogState = verdict.state;

      if (verdict.warn) devWarn(verdict.warn);
      if (verdict.kill) this.kill(WATCHDOG_KILL_REASON);
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
   * seconds its own frames prove it needs. Before the first frame there is nothing to adapt to, and the
   * policy in `watchdog.ts` says so explicitly.
   */
  private currentHeartbeatTimeoutMs(): number {
    return heartbeatTimeoutMs({
      hasMeasuredFrame: this.hasMeasuredFrame,
      frameMillis: this.lastFrameMillis,
    });
  }

  /**
   * Terminate the worker and rebuild the host.
   *
   * The viewer survives: `00` requires that a failed model "must not take the viewer down. Show the error, keep the
   * page alive, offer a retry." The canvas is replaced because its control is spent.
   */
  kill(reason: string): void {
    if (devEnabled) devError(`worker terminated — ${reason}`);
    this.stopWatchdog();
    this.worker?.terminate();
    this.worker = null;
    // The grace belonged to the model that just died. A worker that wedges immediately after this
    // kill must be monitored like any other worker, not sheltered by a grace period it inherited.
    this.buildingUntil = 0;
    this.callbacks.onKilled?.(reason);
    if (!this.disposed) this.start();
    // The replacement worker holds no model: nothing can be presented and its idle-orbit loop
    // would burn frames (60 fps on an empty scene) until the learner retries. Pause it — a tap of
    // Play or a fresh `load()` hands the decision back to the page, since each load spawns a
    // worker whose pause state is clean.
    this.setPaused(true);
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
    if (devEnabled) {
      this.loadStartedAt = performance.now();
      devLog(
        `load — ${code.length} bytes · seed ${seed} · ${runtime ? 'instrumented runtime' : 'clean source'}`,
      );
    }
    // Restart so each model gets a clean realm.
    this.stopWatchdog();
    this.worker?.terminate();
    this.worker = null;
    this.recreateCanvas();
    this.spawnWorker();

    this.buildingUntil = performance.now() + buildGraceMs(this.tier);
    // A new model has measured nothing yet.
    this.hasMeasuredFrame = false;
    this.send({ type: 'load', code, seed, ...(runtime ? { runtime } : {}) });
  }

  /** Retry the last program in a fresh worker. */
  reload(): void {
    if (!this.lastProgram) return;
    this.load(this.lastProgram.code, this.lastProgram.seed, this.lastProgram.runtime);
  }

  resize(): void {
    const rect = this.container.getBoundingClientRect();
    const width = Math.max(1, Math.floor(rect.width));
    const height = Math.max(1, Math.floor(rect.height));
    if (devEnabled) devLog(`resize → ${width}×${height}`);
    this.send({
      type: 'resize',
      width,
      height,
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
    this.rafProbeRunning = false;
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
