/**
 * The sandbox worker: the untrusted side of the boundary, running on the learner's device.
 *
 * **Everything in this file executes in a Web Worker on the user's machine.** It owns the `OffscreenCanvas`
 * transferred from the page, the WebGL context, the Three.js scene, and the AI's program. The server never runs
 * any of it and never renders a pixel — it only ever authored and priced the manifest.
 *
 * `PLAN.md` §A1 explains why the sandbox is a worker rather than an iframe, and the reason bears repeating here
 * because this file depends on it: a worker cannot create a fresh realm — there is no `iframe`, no `Realm`, and
 * `Worker` itself is deleted — so the capability drop performed before the guest runs is *irrecoverable*. In a
 * document it would not be.
 *
 * The sequence below is the security design:
 *
 *   1. receive the canvas and the program from the page;
 *   2. build the renderer and the API facades **while `new Function` still exists**;
 *   3. compile the guest;
 *   4. **harden the realm** — delete capabilities, poison the constructor, freeze intrinsics;
 *   5. run the guest, realize its manifest, and start the frame loop.
 *
 * Nothing after step 4 can reach the network, storage, the DOM, or another model.
 */
import * as THREE from 'three';
import {
  SANDBOX_LIMITS,
  DEVICE_BUDGETS,
  QUALITY_LADDER,
  type DeviceTier,
  type ModelManifest,
  type QualityPreset,
  type QualityRung,
  type RuntimeStats,
  type ShotDecl,
  type ShotDeclInput,
  type ShotEasing,
  type AnnotationPin,
  type ProjectedAnnotation,
  type VideoRecordingCapability,
  type PointPickRequest,
  type SetAnnotationsRequest,
  type PointPickResponse,
  type AnnotationProjectionResponse,
  VIDEO_CLIP_LIMITS,
} from '@edu3d/contracts';
import {
  compileGuest,
  createGuard,
  hardenRealm,
  prepareProgram,
  describeViolations,
  type GuardHandle,
} from '@edu3d/sandbox';
import {
  applyMotions,
  apiSurfaceSet,
  GeometryError,
  M,
  MaterialError,
  SceneBuilder,
  SceneError,
  priceModel,
  realize,
  type AdmissionVerdict,
  type MeshData,
  type MotionHost,
  type PartTransformLike,
  type RealizedModel,
  type ScalarContext,
} from '@edu3d/engine';
import { PhysicsWorld } from './physics-world.ts';
import { computeFrameRate } from './frame-rate.ts';
import { devEnabled } from '../dev-console.ts';
import { collectModelTextures, reuploadTextures } from './context-restore.ts';
import {
  createFrameDisableState,
  frameCallbackDecision,
  frameCallbackFailed,
  frameCallbackRecovered,
  type FrameDisableState,
} from './frame-disable.ts';
import {
  renderGate,
  resetMotionDriven as resetMotionDrivenInto,
  syncTransforms as syncManifestTransforms,
} from './frame-compose.ts';
import { ViewEffects } from './view-effects.ts';
import {
  createGlide,
  dollyPose,
  easeFor,
  fitDistance,
  GLIDE_DURATION,
  isTapRelease,
  isUsablePose,
  retargetGlide,
  stepGlide,
  type Glide,
  type GlideLimits,
  type OrbitPose,
} from './camera-glide.ts';
import { ladderDecision } from './quality-pin.ts';

/**
 * The theme values the page reads from CSS and hands to the engine (`07`).
 *
 * Both grid tokens travel whole, alpha included, and the shader keeps them as uniforms: a theme
 * change only rewrites uniform values, so the grid is never rebuilt for a theme (the old
 * `THREE.GridHelper` baked its colours into a geometry attribute, which is why it had to be).
 */
export interface ThemeTokens {
  top: string;
  bottom: string;
  /** `--scene-grid`: the colour and alpha of the fine (1-unit) lattice. */
  grid: string;
  /** `--scene-grid-major`: the colour and alpha of the 10-unit structure. */
  gridMajor: string;
}

/** Messages the page sends into the worker. */
export type WorkerRequest =
  | {
      type: 'init';
      canvas: OffscreenCanvas;
      width: number;
      height: number;
      pixelRatio: number;
      tier: DeviceTier;
      theme: ThemeTokens;
      /**
       * The learner's pinned quality, or null to let the adaptive ladder decide.
       *
       * Carried at init rather than sent afterwards, because the ladder can step within the first
       * second of a model's life and a pin that arrives late would be a pin the optimizer already
       * overrode.
       */
      quality: QualityPreset | null;
    }
  | { type: 'load'; code: string; seed: number; deadlineMs?: number; runtime?: string }
  | { type: 'resize'; width: number; height: number; pixelRatio: number }
  | { type: 'setParameter'; id: string; value: number | boolean | string }
  | { type: 'setPaused'; paused: boolean }
  | { type: 'setTimeScale'; scale: number }
  | { type: 'resetTime' }
  | { type: 'pointer'; x: number; y: number; kind: 'move' | 'down' | 'up' }
  | { type: 'orbit'; deltaX: number; deltaY: number }
  | { type: 'zoom'; delta: number }
  | { type: 'pan'; deltaX: number; deltaY: number }
  /** Return the camera to the authored opening frame (`03` R5: Reset restores authored time = 0 and
   * parameter defaults *and* the initial camera). */
  | { type: 'resetCamera' }
  /** Raycast a screen point against the realized model (`03` R7: a note must glue to real geometry). */
  | PointPickRequest
  /** Replace the projected pin set; an empty list switches the whole projection path off. */
  | SetAnnotationsRequest
  /** Begin an honest WebM clip if this device can encode one; bounded by `VIDEO_CLIP_LIMITS`. */
  | { type: 'startRecording'; maxSeconds?: number }
  | { type: 'stopRecording' }
  | { type: 'focusPart'; partId: string | null }
  | { type: 'playShot'; shot: ShotDecl }
  | { type: 'viewPreset'; preset: 'front' | 'back' | 'left' | 'right' | 'top' | 'bottom' | 'iso' }
  | { type: 'setViewMode'; mode: 'normal' | 'xray' | 'wireframe' | 'explode' }
  | { type: 'setTheme'; theme: ThemeTokens }
  | { type: 'setQuality'; quality: QualityPreset | null }
  | { type: 'snapshot'; width: number; height: number }
  | { type: 'dispose' };

/** Messages the worker sends back to the page. */
export type WorkerResponse =
  | { type: 'ready' }
  | { type: 'loaded'; manifest: ModelManifest; verdict: SerializableVerdict }
  | { type: 'loadFailed'; message: string; timedOut: boolean; logs: string[] }
  | { type: 'stats'; stats: RuntimeStats }
  | { type: 'metrics'; values: Record<string, number> }
  | { type: 'hover'; partId: string | null }
  | { type: 'selected'; partId: string | null }
  | { type: 'log'; level: 'log' | 'warn' | 'error'; message: string }
  | { type: 'notice'; message: string }
  /** The PNG plus the exact pixels it was rendered at, so the page can name the file honestly. */
  | { type: 'snapshot'; blob: Blob; width: number; height: number }
  | { type: 'capabilities'; video: VideoRecordingCapability }
  | { type: 'recording'; blob: Blob; seconds: number; bytes: number }
  | { type: 'recordingFailed'; message: string }
  | PointPickResponse
  | AnnotationProjectionResponse
  | { type: 'disposed' };

/** The admission verdict, minus the `Map`/`Set` fields that do not survive structured cloning cleanly. */
export interface SerializableVerdict {
  admitted: boolean;
  tier: DeviceTier;
  adjustments: Array<{ rung: string; message: string; saved?: string }>;
  refusal?: string;
  triangles: number;
  drawCalls: number;
}

const toSerializable = (verdict: AdmissionVerdict): SerializableVerdict => ({
  admitted: verdict.admitted,
  tier: verdict.tier,
  adjustments: verdict.adjustments.map((adjustment: AdmissionVerdict['adjustments'][number]) => ({
    rung: adjustment.rung,
    message: adjustment.message,
    ...(adjustment.saved ? { saved: adjustment.saved } : {}),
  })),
  ...(verdict.refusal ? { refusal: verdict.refusal } : {}),
  triangles: verdict.adjusted.triangles,
  drawCalls: verdict.adjusted.drawCalls,
});

/**
 * Host capabilities, captured into module scope before any hardening runs.
 *
 * This block exists because of a bug worth remembering: hardening once deleted `requestAnimationFrame` and
 * `performance` from this realm, and the render loop died one frame after the first model loaded. The worker is
 * simultaneously the sandbox *and* the host of the render loop, so it needs a scheduler and a clock that the guest
 * must not have.
 *
 * The resolution is in two parts. `HOST_RETAINED_GLOBALS` keeps those specific names out of the realm-deletion set
 * (they are still denied to the guest by the gate and by lexical shadowing), and these captured references mean the
 * host never depends on a global lookup that a future hardening change could remove. Capturing costs nothing and
 * removes a whole class of ordering bug.
 */
const hostScope = globalThis as unknown as {
  postMessage: (message: unknown, transfer?: Transferable[]) => void;
  addEventListener: (type: string, handler: (event: MessageEvent<WorkerRequest>) => void) => void;
  requestAnimationFrame: (callback: (time: number) => void) => number;
  setInterval: (callback: () => void, ms: number) => number;
  performance: { now: () => number };
};

const scheduleFrame = hostScope.requestAnimationFrame.bind(hostScope);
/**
 * The heartbeat scheduler, captured at module scope like the frame scheduler above: hardening must
 * never be able to reach a state where the host-side watchdog can no longer hear this worker, and
 * the heartbeat is what a *presenting*-stalled worker says with.
 */
const scheduleHeartbeat = hostScope.setInterval.bind(hostScope);
const hostPerformance = hostScope.performance;
const now = (): number => hostPerformance.now();

/**
 * The physics runtime starts compiling here, at worker boot — a *head start*, not the guarantee.
 *
 * It is the guarantee in `beginBoot`, which awaits this same promise before `initRenderer` hardens
 * the realm (hardening deletes `WebAssembly`, so a Rapier world built afterwards can never start).
 * Starting it at module scope just means the compile overlaps the host's spawn handshake instead of
 * beginning after it. Do not remove the await in `beginBoot` on the strength of this line: the
 * ordering here is a race, and a race was exactly how physics came to be unreachable everywhere.
 */
void PhysicsWorld.warmUp();

/**
 * The worker's private channel to the page.
 *
 * Captured before hardening deletes `postMessage` from the global. That is the whole trick: after hardening, guest
 * code cannot find any way to message the host, while the host keeps its own reference in a closure the guest
 * cannot reach.
 */
const post = ((): ((message: WorkerResponse, transfer?: Transferable[]) => void) => {
  const captured = hostScope.postMessage.bind(hostScope);
  return (message, transfer) => {
    if (transfer && transfer.length > 0) captured(message, transfer);
    else captured(message);
  };
})();

/**
 * The WebCodecs constructors, captured at module scope like the scheduler and the clock above.
 *
 * `hardenRealm` deletes the device surfaces the guest must not reach, and it runs inside a load —
 * after this module has already evaluated. Looking `VideoEncoder` up from the global at recording
 * time would therefore depend on a hardening list that is allowed to grow, which is the exact
 * ordering bug the retained-globals block was written to end. Capturing removes the dependency.
 * Absent on any runtime without WebCodecs, which is what the capability probe reports.
 */
const HostVideoEncoder = (globalThis as { VideoEncoder?: typeof VideoEncoder }).VideoEncoder;
const HostVideoFrame = (globalThis as { VideoFrame?: typeof VideoFrame }).VideoFrame;

/**
 * Dev-only build-stage telemetry over the existing `log` channel — protocol unchanged, messages
 * prefixed `stage ·` so the host can distinguish engine milestones from guest `console.log`, and
 * compiled out of production (the string never exists in a prod bundle, verified by grep).
 */
function stageLog(message: string): void {
  if (devEnabled) post({ type: 'log', level: 'log', message: `stage · ${message}` });
}

/** Pan scratch, module-level: two vectors reused per gesture message instead of two fresh ones. */
const CAMERA_PAN_RIGHT = new THREE.Vector3();
const CAMERA_PAN_UP = new THREE.Vector3();

/** Frame timing constants, each with a reason rather than a guessed number. */
const TIMING = {
  /**
   * Largest delta the simulation will accept, seconds.
   *
   * `08` edge case: "Backgrounded tab returns — clamp the delta, never simulate the whole gap; the model resumes,
   * not fast-forwards." A tab hidden for a minute would otherwise advance the model by a minute in one step, which
   * both looks wrong and can explode a physics solver.
   */
  maxDelta: 0.1,
  /**
   * Milliseconds between stat publications.
   *
   * Time-based rather than frame-count-based: on a weak device a frame can take a second, and a counter that only
   * publishes every 30 frames would leave the status bar — and the page's watchdog — starved. The watchdog's
   * 4 s timeout is the number this stays comfortably inside of.
   */
  statsIntervalMs: 1000,
  /**
   * Milliseconds between heartbeat ticks — the worker's wall-clock liveness proof.
   *
   * The render loop's stats publish inherits the *presenter's* cadence (rAF), which on a
   * software-raster device is 0.2–2 fps: a gap of many seconds between messages that a host
   * cannot distinguish from a hang. This interval beats on the event loop's own clock, so every
   * window closes with at least one message as long as the event loop turns; only a loop wedged
   * hard enough to miss its own timers — the actual hang the watchdog exists for — goes silent.
   * Gated through `statsIntervalMs` with the render loop, so a healthy 60 fps model still
   * publishes exactly once per window.
   */
  heartbeatIntervalMs: 1000,
  /** Rolling window for frame-time averaging: long enough to ignore a single spike (`08`). */
  frameWindow: 60,
  /**
   * Frames of sustained pressure before a ladder step, and frames of sustained headroom before stepping back up.
   *
   * `08` demands "rolling window, not single-frame spikes" and hysteresis so the ladder "cannot oscillate
   * between two quality levels". 90 frames ≈ 1.5–3 s of sustained behaviour at interactive rates — long
   * enough that a GC pause or a shader compile cannot trigger a step, short enough that judder is fixed
   * before a learner gives up.
   */
  ladderSustainFrames: 90,
  /** Fraction over the frame budget that counts as pressure; fraction under that counts as headroom. */
  ladderPressureFactor: 1.35,
  ladderHeadroomFactor: 0.85,
} as const;

/**
 * An fov pull in flight: the projection animates from `fromFov` to `toFov` over `duration`, on the
 * same easing vocabulary the pose glides use. Position is untouched — that is the whole move.
 */
interface FovMove {
  fromFov: number;
  toFov: number;
  elapsed: number;
  duration: number;
  easing: ShotEasing;
}

/** One encoded frame on its way into the container. */
export interface EncodedVideoFrame {
  data: Uint8Array;
  /** Microseconds from the start of the clip, as `VideoEncoder` reports it. */
  timestampUs: number;
  key: boolean;
}

/**
 * A clip in flight.
 *
 * Everything the recorder needs and nothing else: the encoded chunks accumulate here (bounded by
 * `maxBytes`), and `finishing` is the latch that keeps a frame arriving mid-flush from re-entering.
 * The encoder itself holds GPU state, so it is closed on exactly one path — `finishRecording` or
 * `abortRecording` — never both.
 */
export interface RecordingSession {
  encoder: VideoEncoder;
  width: number;
  height: number;
  fps: number;
  startedAtMs: number;
  /** Microseconds of the last submitted frame; `-1` until the first, which is also the keyframe test. */
  lastFrameUs: number;
  chunks: EncodedVideoFrame[];
  bytes: number;
  maxSeconds: number;
  maxBytes: number;
  finishing: boolean;
}

/** Everything the worker owns between loads. */
export interface WorkerState {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  canvas: OffscreenCanvas;
  tier: DeviceTier;
  pixelRatio: number;
  width: number;
  height: number;

  /**
   * Viewer chrome: the shader-drawn ground grid, or null before the first theme application.
   *
   * It is scene furniture, not model geometry — it is never a child of `model.root`, so a model swap
   * (which disposes the root) cannot take it down. The material is created once and a theme change
   * only rewrites its uniforms, so the mesh is built once and lives until `disposeGrid`/`disposeAll`.
   */
  grid: SceneGrid | null;

  builder: SceneBuilder | null;
  model: RealizedModel | null;
  manifest: ModelManifest | null;
  verdict: AdmissionVerdict | null;
  guard: GuardHandle | null;
  /** The simulation, when the model declares one. Null until loaded; `simFailed` says why not. */
  physics: PhysicsWorld | null;
  simFailed: boolean;

  /**
   * Declared-motion state, captured at load (`applyMotions` is stateless by design):
   *   - `partNodes` — the manifest's live part nodes, which `onFrame` writes through `ctx.part()`
   *     and `syncTransforms` reads. The motion applicator writes them too, in the same frame.
   *   - `motionBases` — each motion-driven part's authored transform, deep-copied at load and
   *     never mutated: the anchor every animated pose is computed from, so reset and scrub are exact.
   *   - `runsWhilePausedParts` — parts with at least one `runsWhilePaused` motion; those are the
   *     only ones reset to base while paused, so a paused fan freezes mid-angle instead of
   *     snapping to its authored pose while a paused glow keeps pulsing.
   */
  partNodes: Map<string, ModelManifest['parts'][number]>;
  motionBases: Map<string, PartTransformLike>;
  runsWhilePausedParts: Set<string>;
  /**
   * Whether any declared motion carries `runsWhilePaused`. The render gate composes this with
   * `paused`: a paused model whose glow keeps pulsing is never still, one whose every motion
   * respects pause is still after the last invalidation.
   */
  hasRunsWhilePaused: boolean;
  /** Latest physics probe read-outs, so `{ probe: … }` scalar sources resolve per frame. */
  lastProbes: Readonly<Record<string, number>>;
  /** Per-frame flag bank: camera gestures coalesce to one `updateCamera` per tick. */
  cameraDirty: boolean;
  /**
   * An inspection invalidation: selection change, hover change, view mode, theme, resize, any
   * notice that touched the scene. Cleared when the frame renders. Distinct from `cameraDirty`
   * only in who sets it — the gate reads both the same way.
   */
  needsRender: boolean;
  /**
   * The numeric parameter record the applicator resolves against, `null` when invalidated.
   *
   * `setParameter` nulls it; the next `applyDeclaredMotions` rebuilds it lazily. The record is
   * read-only for its consumers — a parameter that arrives mid-frame is honoured next frame, which
   * is within the same wall-clock window the slider's own event happened in.
   */
  paramsRecord: Record<string, number> | null;
  /**
   * A deferred-frame request. Phase 2 honours it trivially (the loop runs continuously); Phase 3's
   * on-demand rendering is what reads it as a gate. Kept as a declared field so the setParameter
   * contract does not change shape between the phases.
   */
  needsFrame: boolean;

  paused: boolean;
  timeScale: number;
  elapsed: number;
  /** Previous frame-rate sample: the frame count and clock reading `computeFrameRate` measures against. */
  lastRateFrame: number;
  lastRateAt: number;
  /**
   * Wall-clock seconds — advances every frame regardless of pause, and is consumed only by
   * `runsWhilePaused` motions. The pausable `elapsed` freezes with the model, so without this
   * second clock a paused pulse recomputed the same scale forever ("glow pulses may differ",
   * behavior.ts's own example, was unreachable).
   */
  wallElapsed: number;
  frame: number;
  lastFrameAt: number;
  /** Wall-clock of the last stats post, so slow frames cannot starve the watchdog. */
  lastHeartbeatMs: number;
  lastStatsMs: number;
  frameTimes: number[];
  /** Consecutive frames where the guest's callback overran its budget. */
  overruns: number;
  /** `performance.now()` of the current load's start, so the first frame reports end-to-end latency. */
  loadStartedAt: number;
  /** Milliseconds the last physics step cost, for the status bar's budget line (`02`). */
  physicsMillis: number;
  /**
   * Why physics is not running, when the model declared it and this device could not provide it.
   *
   * Set from the async creation's failure path, cleared on every model swap. `physicsStatus` reads it
   * together with `physics` so the status bar reports the measured truth rather than the model's hope
   * (`03` R9).
   */
  physicsUnavailableReason: string | null;
  /**
   * The learner's pinned world points, exactly as the page sent them.
   *
   * Empty is the common case, and the frame loop checks it *before* doing any projection work: the
   * worker must not pay for a feature nobody used (`03` R7).
   */
  annotations: readonly AnnotationPin[];
  /**
   * What the device can do about video export, probed once at init.
   *
   * `null` until the async probe answers. The host shows "checking" until it does, rather than
   * guessing — a capability that is assumed is a capability that is eventually faked.
   */
  videoCapability: VideoRecordingCapability | null;
  /** The clip being recorded, or null. */
  recording: RecordingSession | null;
  /**
   * The guest frame callback's circuit breaker (`frame-disable.ts`).
   *
   * Scopes to the callback *alone*: declared motion and the transform sync keep running while the
   * model's own frame code is dark — a broken animation must not freeze the model or detach
   * physics from its pose. Also recoverable: one probation frame per retry window, cleared the
   * first time the callback holds its budget again.
   */
  frameDisable: FrameDisableState;

  /**
   * The live adaptive ladder (`08`). `applied` is the set of rungs already stepped down; the order is
   * fixed by `QUALITY_LADDER` (least damage first). Hysteresis lives in the two counters: sustained
   * pressure steps down, sustained headroom steps back up, and the sustain window is long enough that
   * the ladder cannot oscillate between two levels.
   */
  ladder: {
    applied: Set<QualityRung>;
    pressureFrames: number;
    headroomFrames: number;
    /** The base pixel ratio before the first step-down, so stepping back up restores it. */
    basePixelRatio: number;
    /**
     * True once the ladder has warned that a pinned quality is not being held.
     *
     * Sent once per model: a learner who has already been told does not need telling sixty times,
     * and a notice that repeats itself is a notice that gets ignored.
     */
    warnedAboutPin: boolean;
  };

  /**
   * The learner's pinned quality, or null to let the ladder decide (`08`: the explicit choice beats
   * the optimizer, which then only warns).
   */
  pinnedQuality: QualityPreset | null;

  /** Orbit state: spherical coordinates around the target. */
  orbit: { theta: number; phi: number; distance: number; target: THREE.Vector3 };
  autoRotate: boolean;

  /**
   * A camera move in flight, or null.
   *
   * The camera travels to whatever the learner selects instead of snapping to it: a snap reads as
   * a teleport, and a teleport teaches nothing about where the part is. The move lives here
   * because the camera's state lives here.
   */
  glide: Glide | null;

  /**
   * An fov pull in flight, or null.
   *
   * `fovPull` is the one shot that animates the projection rather than the rig: the camera holds
   * its position and the field of view narrows or widens, which is what a focus pull between two
   * related parts reads as. Advanced by `advanceShot` on wall-clock time like the glide; cleared
   * by every learner gesture and by any new pose move.
   */
  fovMove: FovMove | null;

  /**
   * The press in progress: where it began, and how many fingers were part of it.
   *
   * A press that stayed put is a choice, and the camera travels to it. A press that travelled is
   * the learner steering, and the camera stays exactly where they put it.
   */
  pointerPress: { x: number; y: number; pointers: number } | null;
  /** How many pointers are down right now. */
  pointersDown: number;

  /**
   * What a camera move is travelling to, re-measured every frame.
   *
   * A part that is itself moving — a spinning blade, a reciprocating piston — is somewhere else
   * by the time the camera arrives, so the destination is measured again while the camera
   * travels. A window resized mid-move changes what fits on screen for the same reason.
   */
  glideFocus: { object: THREE.Object3D; margin: number } | null;

  hoveredPart: string | null;
  selectedPart: string | null;
  viewMode: 'normal' | 'xray' | 'wireframe' | 'explode';
  /**
   * X-ray and explode, owned by the effects module and re-bound to each model.
   *
   * The shared shell material and the per-part explode poses belong to a model, not to the page:
   * `loadProgram` calls `setRoot` on every swap, which disposes the old shell and re-captures, so
   * nothing from a disposed model is ever written again. Wireframe stays inline — it flips a flag
   * on the authored materials directly.
   */
  effects: ViewEffects;
  /**
   * Set by pointer-move messages, consumed by the next frame. Hovering is the highest-rate input the worker
   * receives, and a raycast per message means a fast pointer delivers dozens of full-scene casts between two
   * frames — all but the last are wasted. Coalescing to once per frame is `08`'s frame-loop scheduling rule;
   * clicks stay immediate because selection is rare and must land on the exact pose the learner saw.
   */
  hoverPending: boolean;

  raycaster: THREE.Raycaster;
  pointer: THREE.Vector2;
}

let state: WorkerState | null = null;
/** Guest logs, forwarded to the diagnostics panel rather than to the real console. */
const logs: string[] = [];

/** Bounded console for guest code. */
function createConsole(): Readonly<Record<string, unknown>> {
  const record =
    (level: 'log' | 'warn' | 'error') =>
    (...args: unknown[]): void => {
      if (logs.length >= 200) return;
      const message = args
        .map((arg) => {
          if (typeof arg === 'string') return arg;
          if (arg === undefined) return 'undefined';
          if (typeof arg === 'object' && arg !== null) {
            try {
              return JSON.stringify(arg)?.slice(0, 500) ?? '[unserialisable]';
            } catch {
              return '[circular]';
            }
          }
          return String(arg);
        })
        .join(' ')
        .slice(0, 500);
      logs.push(message);
      post({ type: 'log', level, message });
    };
  return Object.freeze({ log: record('log'), warn: record('warn'), error: record('error') });
}

/** Translate a guest fault into a sentence the page can show and the repair pass can use. */
function describeFailure(error: unknown): { message: string; timedOut: boolean } {
  const asError =
    error &&
    typeof error === 'object' &&
    typeof (error as { message?: unknown }).message === 'string'
      ? (error as { name?: string; message: string })
      : null;

  if (!asError)
    return {
      message: `The model threw a non-error value: ${String(error).slice(0, 200)}.`,
      timedOut: false,
    };

  const name = asError.name ?? 'Error';
  if (name === 'GuestTimeoutError' || name === 'GuestBudgetError') {
    return { message: asError.message, timedOut: true };
  }
  if (
    error instanceof SceneError ||
    error instanceof GeometryError ||
    error instanceof MaterialError ||
    name === 'SceneError' ||
    name === 'GeometryError' ||
    name === 'MaterialError'
  ) {
    return { message: asError.message, timedOut: false };
  }
  if (name === 'RangeError' && /call stack/i.test(asError.message)) {
    return {
      message:
        'The program recursed too deeply. Check for a function that calls itself without a base case.',
      timedOut: true,
    };
  }
  return {
    message: `The model threw ${name}: ${asError.message}.`,
    timedOut: false,
  };
}

/**
 * The ground grid: a shader-drawn plane, not a `GridHelper`.
 *
 * v1 shipped a `THREE.GridHelper` and it was invisible. A helper draws 1-px, non-antialiased lines at
 * one opacity, and at the old 6% over `#17130f` a line sat ~7/255 from the backdrop — present in the
 * framebuffer, absent to a person. It also shimmered at grazing angles, because lines whose spacing
 * projects below a pixel alias into a moiré. One plane and one fragment shader fix both halves: lines
 * are measured in pixels (so they stay a crisp pixel wide at any distance and any window size), the
 * fine lattice fades where it can no longer be resolved, and the whole plane dissolves radially so it
 * has no visible edge.
 *
 * The mesh is viewer chrome: added to `state.scene`, never to `realized.root`, on a render order
 * below the model's, with a no-op raycast. It is created once and survives model swaps and theme
 * changes; only `disposeGrid`/`disposeAll` release its geometry and material.
 */

/** The mesh type the grid is, so the material is known without a cast at every use. */
type SceneGrid = THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>;

/** The plane's extent in world units. Larger than the fade radius, so an edge never ends the grid. */
const GRID_PLANE_SIZE = 240;

/** The mesh name, so tests and diagnostics can identify chrome without inspecting materials. */
export const GRID_MESH_NAME = 'scene-grid';

/**
 * Where the grid draws relative to the model.
 *
 * Below the model's default render order of 0, so the transparent grid is drawn first and can never
 * punch through geometry in front of it.
 */
const GRID_RENDER_ORDER = -10;

/**
 * The radial fade, in world units from the plane's centre.
 *
 * A model is a few metres across and the camera orbits at a similar radius, so the grid is solid
 * under the whole model by 26 units and fully gone by 110 — well before the plane's 120-unit edge
 * could ever show as a straight line across the floor.
 */
const GRID_FADE_START = 26;
const GRID_FADE_END = 110;

/**
 * The neutral the grid falls back to when a token cannot be parsed: a mid grey at a visible alpha —
 * roughly between the two shipped weights — so a bad or absent token never throws and never leaves
 * the floor invisible.
 */
const GRID_FALLBACK = { r: 0.5, g: 0.5, b: 0.5, a: 0.18 } as const;

/** One `rgb()` channel as a 0–1 number: percent scales by 100, otherwise the 0–255 channel is normalised. */
function channelToUnit(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed === '') return null;
  const numeric = Number.parseFloat(trimmed);
  if (!Number.isFinite(numeric)) return null;
  const unit = trimmed.endsWith('%') ? numeric / 100 : numeric / 255;
  return Math.min(1, Math.max(0, unit));
}

/** One alpha as a 0–1 number: percent scales by 100, otherwise a plain fraction. */
function alphaToUnit(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed === '') return null;
  const numeric = Number.parseFloat(trimmed);
  if (!Number.isFinite(numeric)) return null;
  return Math.min(1, Math.max(0, trimmed.endsWith('%') ? numeric / 100 : numeric));
}

/**
 * The neutral colour a token falls back to, as its own value constructor so both the empty-token and
 * the missing-token paths return the same thing.
 */
function fallbackGridColour(): { color: THREE.Color; opacity: number } {
  return {
    color: new THREE.Color().setRGB(
      GRID_FALLBACK.r,
      GRID_FALLBACK.g,
      GRID_FALLBACK.b,
      THREE.SRGBColorSpace,
    ),
    opacity: GRID_FALLBACK.a,
  };
}

/**
 * Parse a grid token (`--scene-grid` or `--scene-grid-major`) into a colour and an alpha, defensively.
 *
 * The shipped tokens are modern CSS (`rgb(255 255 255 / 14%)` dark, `rgb(26 22 18 / 16%)` light for
 * the fine lattice), but the page also supplies a literal fallback and a future author may write hex
 * or the legacy comma form — so `#rgb`/`#rgba`/`#rrggbb`/`#rrggbbaa` and `rgb()`/`rgba()` in both the
 * space-separated and comma forms, with percent or unit channels, are all accepted. Anything
 * unparseable — including a token that never arrived from a page that does not send it — becomes
 * `GRID_FALLBACK`: a chrome token must never be able to throw the renderer down.
 *
 * The returned colour is converted from sRGB into the renderer's working colour space; the shader
 * converts it back on output, so the token composites at its authored weight.
 */
export function parseGridColor(token: string): { color: THREE.Color; opacity: number } {
  if (typeof token !== 'string') return fallbackGridColour();

  const raw = token.trim();

  const hex = /^#([0-9a-f]{3,8})$/i.exec(raw);
  if (hex) {
    const digits = hex[1] ?? '';
    const wide = digits.length <= 4 ? digits.replace(/./g, (digit) => digit + digit) : digits;
    if (wide.length === 6 || wide.length === 8) {
      const hexChannel = (pair: string): number => Number.parseInt(pair, 16) / 255;
      const color = new THREE.Color().setRGB(
        hexChannel(wide.slice(0, 2)),
        hexChannel(wide.slice(2, 4)),
        hexChannel(wide.slice(4, 6)),
        THREE.SRGBColorSpace,
      );
      return { color, opacity: wide.length === 8 ? hexChannel(wide.slice(6, 8)) : 1 };
    }
  }

  const functional = /^rgba?\(([^)]*)\)$/i.exec(raw);
  if (functional) {
    const [rgbPart = '', alphaPart] = (functional[1] ?? '').split('/');
    const channels = rgbPart.split(/[\s,]+/).filter((part) => part !== '');
    if (channels.length >= 3) {
      const r = channelToUnit(channels[0] ?? '');
      const g = channelToUnit(channels[1] ?? '');
      const b = channelToUnit(channels[2] ?? '');
      // Modern syntax puts alpha after a slash; the legacy form carries it as a fourth channel.
      const alpha =
        alphaPart !== undefined
          ? alphaToUnit(alphaPart)
          : channels[3] !== undefined
            ? alphaToUnit(channels[3])
            : 1;
      if (r !== null && g !== null && b !== null && alpha !== null) {
        return { color: new THREE.Color().setRGB(r, g, b, THREE.SRGBColorSpace), opacity: alpha };
      }
    }
  }

  return fallbackGridColour();
}

/**
 * The vertex stage: carry the world-space ground coordinates to the fragment stage and place the
 * plane. The plane is authored in XY and rotated onto the ground elsewhere, so its world `xz` are the
 * coordinates the grid is measured in — the lattice stays aligned to the world axes however the mesh
 * is posed.
 */
export const GRID_VERTEX_SHADER = /* glsl */ `
varying vec2 vGround;

void main() {
  vec4 world = modelMatrix * vec4(position, 1.0);
  vGround = world.xz;
  gl_Position = projectionMatrix * viewMatrix * world;
}
`;

/**
 * The fragment stage: two screen-space antialiased line sets and two fades, composed so the floor
 * reads at a weight the tokens set and never aliases.
 *
 * Each term is here for a stated reason:
 *   - `gridLines` measures a line's distance in *pixels*, by dividing the fractional coordinate by
 *     `fwidth` (the coordinate's change across the pixel). The `min` takes the nearer axis and the
 *     clamp holds the line at one pixel wide at any distance and any window size, so a distant
 *     lattice stays a lattice instead of dissolving into dots.
 *   - two scales: a fine 1-unit lattice for local texture and a 10-unit structure that reads as a
 *     floor plan — v1's 1-unit cells kept, plus a structure the eye can measure a model against.
 *   - the density fade applies to the fine lines only: when a whole unit falls inside one pixel
 *     (`fwidth` of the ground coordinate against the unit spacing) the fine lines cannot be resolved
 *     and only beat against each other as moiré, so they are faded out there.
 *   - the distance fade is radial from the plane's centre, giving the plane no visible edge.
 *   - the weight is `max(fine, major)` — the stronger line wins — and the colour follows whichever
 *     weight won, so a 10-unit line crossing the fine lattice carries the major token.
 */
export const GRID_FRAGMENT_SHADER = /* glsl */ `
uniform vec3 uMinorColor;
uniform vec3 uMajorColor;
uniform float uMinorAlpha;
uniform float uMajorAlpha;
uniform float uFadeStart;
uniform float uFadeEnd;

varying vec2 vGround;

float gridLines(vec2 coord, float spacing) {
  vec2 c = coord / spacing;
  vec2 toLine = abs(fract(c - 0.5) - 0.5) / fwidth(c);
  return 1.0 - min(min(toLine.x, toLine.y), 1.0);
}

void main() {
  float fine = gridLines(vGround, 1.0);
  float major = gridLines(vGround, 10.0);

  float unitsPerPixel = max(fwidth(vGround.x), fwidth(vGround.y));
  float density = 1.0 - smoothstep(0.5, 1.0, unitsPerPixel);

  float distanceFade = smoothstep(uFadeStart, uFadeEnd, length(vGround));

  float fineAlpha = uMinorAlpha * fine * density;
  float majorAlpha = uMajorAlpha * major;

  vec3 color = mix(uMinorColor, uMajorColor, step(fineAlpha, majorAlpha));
  gl_FragColor = vec4(color, max(fineAlpha, majorAlpha) * (1.0 - distanceFade));

  // A plain ShaderMaterial does not colour-manage its output the way Three's built-in materials do.
  // This injects the renderer's own linear-to-output conversion, so a token parsed in sRGB reaches
  // the sRGB drawing buffer at its authored weight rather than looking darker than the CSS says.
  #include <colorspace_fragment>
}
`;

/**
 * The grid's uniform surface.
 *
 * A named type rather than `Record<string, THREE.IUniform>` so the runtime code and the tests read
 * each uniform without `noUncheckedIndexedAccess` widening every lookup to `IUniform | undefined` —
 * the grid's uniforms are a fixed contract with the fragment shader, not an arbitrary bag.
 */
export type GridUniforms = {
  uMinorColor: THREE.IUniform<THREE.Color>;
  uMajorColor: THREE.IUniform<THREE.Color>;
  uMinorAlpha: THREE.IUniform<number>;
  uMajorAlpha: THREE.IUniform<number>;
  uFadeStart: THREE.IUniform<number>;
  uFadeEnd: THREE.IUniform<number>;
};

/**
 * The grid's uniforms, from both tokens.
 *
 * Pure and exported on purpose: a test can pin the exact names the fragment shader declares and the
 * values they carry, because a typo in a GLSL identifier compiles fine in Node and only fails at
 * render time — nothing else in the suite would notice it.
 */
export function buildGridUniforms(theme: ThemeTokens): GridUniforms {
  const fine = parseGridColor(theme.grid);
  const major = parseGridColor(theme.gridMajor);
  return {
    uMinorColor: { value: fine.color },
    uMajorColor: { value: major.color },
    uMinorAlpha: { value: fine.opacity },
    uMajorAlpha: { value: major.opacity },
    uFadeStart: { value: GRID_FADE_START },
    uFadeEnd: { value: GRID_FADE_END },
  };
}

/** Create the grid mesh for a theme. `applyTheme`/`disposeGrid` own its lifecycle. */
function buildSceneGrid(theme: ThemeTokens): SceneGrid {
  const material = new THREE.ShaderMaterial({
    vertexShader: GRID_VERTEX_SHADER,
    fragmentShader: GRID_FRAGMENT_SHADER,
    uniforms: buildGridUniforms(theme),
    // Chrome composites over the backdrop: translucency is the point, and a transparent plane that
    // wrote depth would occlude the model with an invisible surface.
    transparent: true,
    depthWrite: false,
    // A floor is looked at from above; drawing the underside would only show a grid to a camera that
    // has slipped under the model, where it means nothing.
    side: THREE.FrontSide,
  });

  const grid = new THREE.Mesh(new THREE.PlaneGeometry(GRID_PLANE_SIZE, GRID_PLANE_SIZE), material);
  grid.name = GRID_MESH_NAME;
  // Lay the XY plane onto the ground.
  grid.rotation.x = -Math.PI / 2;
  // Chrome must never intercept a pick meant for the model. A no-op raycast means the grid can never
  // appear in any intersection list — the page's own pick ray, a future scene-wide cast, anything.
  grid.raycast = () => {};
  grid.renderOrder = GRID_RENDER_ORDER;
  return grid;
}

/**
 * Rewrite a live grid's uniforms for a new theme. No rebuild: the colours and alphas are uniforms, so
 * a theme change is six value assignments. Values are copied into the live material's uniforms rather
 * than reassigned wholesale — Three captures the uniform object when it builds the program, so a new
 * object would not be seen.
 */
function updateGridTheme(grid: SceneGrid, theme: ThemeTokens): void {
  // The material's own uniforms object, typed back to the contract the shader declares. This is the
  // same object `buildSceneGrid` handed to the material, so writing through it updates the program.
  const uniforms = grid.material.uniforms as unknown as GridUniforms;
  const next = buildGridUniforms(theme);
  uniforms.uMinorColor.value.copy(next.uMinorColor.value);
  uniforms.uMajorColor.value.copy(next.uMajorColor.value);
  uniforms.uMinorAlpha.value = next.uMinorAlpha.value;
  uniforms.uMajorAlpha.value = next.uMajorAlpha.value;
  uniforms.uFadeStart.value = next.uFadeStart.value;
  uniforms.uFadeEnd.value = next.uFadeEnd.value;
}

/** Release the grid's GPU resources and detach it; the one path a build and a teardown share. */
export function disposeGrid(target: WorkerState): void {
  const grid = target.grid;
  if (!grid) return;
  target.scene.remove(grid);
  grid.geometry.dispose();
  grid.material.dispose();
  target.grid = null;
}

/**
 * Apply the scene backdrop from theme tokens, and give the ground grid its weight.
 *
 * The grid is created once and then only recoloured: its two colours and alphas are shader uniforms,
 * so a theme change rewrites those values and nothing is rebuilt or disposed. (The old `GridHelper`
 * baked its colours into geometry, which is why it used to be torn down and rebuilt here.)
 *
 * The grid is viewer chrome and is on by default (v1 shipped it on, and the user asked for it), which
 * also satisfies an authored `environment.grid === true`. A model cannot switch it off: `grid`
 * defaults to `false` in the contract, so an authored `false` is indistinguishable from a model that
 * said nothing — a contract question, deliberately not guessed at here.
 *
 * It is added to the scene, never to `realized.root`, so a model swap (which disposes the root)
 * cannot take the chrome down with it.
 */
export function applyTheme(target: WorkerState, theme: ThemeTokens): void {
  const top = new THREE.Color().setStyle(theme.top, THREE.SRGBColorSpace);
  target.scene.background = top;

  // The x-ray shell is coloured from the backdrop's luminance, so it has to know the backdrop.
  // A live shell re-tints here when the theme changes mid-session; a dark backdrop gets the pale
  // shell and a light one the deeper shell (see `xrayShellStyle`).
  target.effects.setBackdrop(top);

  if (!target.grid) {
    target.grid = buildSceneGrid(theme);
    target.scene.add(target.grid);
  } else {
    updateGridTheme(target.grid, theme);
  }

  // Fog is not applied by default: it hides distant parts, and a model's own `environment.fog` is the only place
  // that should decide to do that.
}

/** Position the camera from its orbit state. */
function updateCamera(target: WorkerState): void {
  const { theta, phi, distance, target: focus } = target.orbit;
  target.camera.position.set(
    focus.x + distance * Math.sin(phi) * Math.sin(theta),
    focus.y + distance * Math.cos(phi),
    focus.z + distance * Math.sin(phi) * Math.cos(theta),
  );
  target.camera.lookAt(focus);
}

/** The camera's current pose, in the rig's terms. */
function currentPose(target: WorkerState): OrbitPose {
  return {
    theta: target.orbit.theta,
    phi: target.orbit.phi,
    distance: target.orbit.distance,
    target: { x: target.orbit.target.x, y: target.orbit.target.y, z: target.orbit.target.z },
  };
}

/** Write a pose back into the rig. */
function applyPose(target: WorkerState, pose: OrbitPose): void {
  target.orbit.theta = pose.theta;
  target.orbit.phi = pose.phi;
  target.orbit.distance = pose.distance;
  target.orbit.target.set(pose.target.x, pose.target.y, pose.target.z);
}

/**
 * Frame the model the way its author opened it.
 *
 * `00`: "every model opens with the full concept in view — the AI author sets the initial camera".
 * Shared by the load path and by Reset (`03` R5), so "look at it fresh" restores exactly the frame
 * the model was authored to open with rather than an approximation of it, and the two can never
 * drift apart.
 *
 * The authored pose is re-clamped through the model's own `camera.limits`. `00` requires that a
 * learner "can never lose the model off-screen or zoom through the floor", and a pose that sits
 * outside those limits is a pose the very next gesture would snap away from — so the opening frame is
 * brought inside the declared box, direction preserved. For a manifest whose limits admit its own
 * opening pose (the normal case, and the reference model's) the clamp is exactly a no-op.
 *
 * Returns false when there is no manifest to read that frame from.
 */
export function resetCameraToInitial(target: WorkerState): boolean {
  const manifest = target.manifest;
  if (!manifest) return false;

  // Any move in flight belonged to where the camera used to be; leaving one running would carry the
  // camera straight back off the authored pose it was just put on.
  cancelCameraMove(target);

  const pose = manifest.camera.initial;
  applyFov(target, pose.fov);
  target.orbit.target.set(pose.target[0], pose.target[1], pose.target[2]);

  const dx = pose.position[0] - pose.target[0];
  const dy = pose.position[1] - pose.target[1];
  const dz = pose.position[2] - pose.target[2];
  // `null` here would mean a non-finite pose, which a parsed manifest cannot produce; falling back to
  // the floor keeps the spherical conversion below non-degenerate either way (the limits are positive).
  const distance = clampDistance(Math.hypot(dx, dy, dz), distanceLimits(target)) ?? 1;
  const phi = Math.acos(Math.max(-1, Math.min(1, dy / distance)));
  const polar = polarLimits(target);
  target.orbit.distance = distance;
  target.orbit.theta = Math.atan2(dx, dz);
  target.orbit.phi = Math.min(polar.max, Math.max(polar.min, phi));
  target.autoRotate = manifest.camera.limits.autoRotate;
  updateCamera(target);
  target.cameraDirty = true;
  return true;
}

/**
 * The rig's distance limits, lowest-first, from the model's own declaration.
 *
 * `00` requires that a learner "can never lose the model off-screen or zoom through the floor", so
 * every command that moves the camera along its view axis — a scroll notch, an absolute pinch
 * distance, a declared dolly — passes through here rather than trusting its caller. A malformed
 * manifest can invert the pair (`minDistance` above `maxDistance`); sorting keeps the range
 * non-empty instead of making `clampDistance` return the minimum forever.
 */
export function distanceLimits(target: WorkerState): { min: number; max: number } {
  const limits = target.manifest?.camera.limits;
  const min = limits?.minDistance ?? 0.1;
  const max = limits?.maxDistance ?? 500;
  return { min: Math.min(min, max), max: Math.max(min, max) };
}

/**
 * Clamp a prospective camera distance into the rig's limits.
 *
 * Returns `null` for a non-finite distance rather than a number: `Math.min`/`Math.max` propagate
 * `NaN`, and a `NaN` orbit distance writes `NaN` into the camera position, which takes the renderer
 * down with it. "This command changed nothing" is the honest answer to a pinch that computed garbage.
 */
export function clampDistance(
  distance: number,
  limits: { min: number; max: number },
): number | null {
  if (!Number.isFinite(distance)) return null;
  return Math.min(limits.max, Math.max(limits.min, distance));
}

/**
 * The rig's polar-angle limits, lowest-first, from the model's own declaration.
 *
 * Sorted for the same reason `distanceLimits` is: a manifest that inverted the pair must still leave
 * the rig a non-empty range rather than pinning the camera to one angle.
 */
export function polarLimits(target: WorkerState): { min: number; max: number } {
  const limits = target.manifest?.camera.limits;
  const min = limits?.minPolarAngle ?? 0.08;
  const max = limits?.maxPolarAngle ?? Math.PI - 0.08;
  return { min: Math.min(min, max), max: Math.max(min, max) };
}

/** The rig's own limits, so a camera move can never end somewhere the rig refuses to be. */
function glideLimits(target: WorkerState): GlideLimits {
  const { min: minDistance, max: maxDistance } = distanceLimits(target);
  const { min: minPhi, max: maxPhi } = polarLimits(target);
  return { minPhi, maxPhi, minDistance, maxDistance };
}

/**
 * The pose that frames an object: its centre as the pivot, at a distance that fits it.
 *
 * The distance considers both axes of the view. Fitting the vertical field of view alone — which
 * is what the earlier version of this platform did — crops a wide object on a portrait phone,
 * because a phone's narrow axis is the horizontal one.
 */
function framingPose(
  target: WorkerState,
  object: THREE.Object3D,
  margin: number,
): OrbitPose | null {
  const box = new THREE.Box3().setFromObject(object);
  if (box.isEmpty()) return null;
  const sphere = box.getBoundingSphere(new THREE.Sphere());
  const pose = currentPose(target);
  // The pivot moves to the object, so orbiting afterwards pivots around what the learner chose.
  pose.target = { x: sphere.center.x, y: sphere.center.y, z: sphere.center.z };
  pose.distance = fitDistance(sphere.radius, target.camera.fov, target.camera.aspect, margin);
  // A broken mesh can produce a radius that is not a number, and a camera at a position that is
  // not a number takes the renderer down with it. The move is simply not started.
  return isUsablePose(pose) ? pose : null;
}

/**
 * Start a camera move.
 *
 * The origin is wherever the camera is now, so a move started while another is in flight continues
 * from there rather than snapping back to a stale origin. The direction the camera already had is
 * kept: the camera pushes in towards the object rather than swinging to a new angle, which is what
 * makes the move read as "moving closer to look" rather than "jumping somewhere else".
 *
 * `focus` is what the move is travelling to, and it is measured again every frame — see
 * `glideFocus`. A preset has no focus: it moves the camera without arriving anywhere in
 * particular. Declared shots pass their own duration and easing; the focus glide keeps its
 * defaults.
 */
function startGlide(
  target: WorkerState,
  to: OrbitPose,
  focus?: { object: THREE.Object3D; margin: number },
  duration: number = GLIDE_DURATION,
  easing: ShotEasing = 'easeInOut',
): void {
  cancelCameraMove(target);
  target.autoRotate = false;
  target.glide = createGlide(currentPose(target), to, duration, easing);
  target.glideFocus = focus ?? null;
  // A move is motion; the idle orbit would fight it, and the frame must present.
  target.cameraDirty = true;
}

/**
 * The declared shot vocabulary the viewer plays, with the kinds that say honest about the rest.
 *
 * `00-GOAL.md` specifies nine kinds; the player covers the four whose implementation this camera
 * rig already genuinely performs — `cut` (apply the destination), `flyTo` (the eased glide along
 * the current approach), `dolly` (a view-axis change of distance) and `fovPull` (the projection
 * pulled while the position holds). The other five stay legal in the schema because the spec
 * names them, but nothing plays them, so the audit flags a model that declares one rather than
 * letting the manifest promise a camera move that will not happen.
 */
const PLAYABLE_SHOT_KINDS = new Set(['cut', 'flyTo', 'dolly', 'fovPull']);

/**
 * The contract defaults a captured `ShotDecl` may not carry.
 *
 * Story-beat and interaction shots are captured verbatim by the authoring pass — like
 * `MotionDeclInput`, they can arrive at playback without zod's defaults applied. The player
 * defaults them itself, against `ShotDecl`'s own numbers, instead of multiplying by `undefined`.
 */
const SHOT_DEFAULT_DURATION = 1.2;

const SHOT_DEFAULT_MARGIN = 1.35;

/** The easing the contract defaults a captured shot to when none was authored. */
const SHOT_DEFAULT_EASING: ShotEasing = 'easeInOut';

/** Write the projection's field of view. One place, so every caller updates the matrix too. */
function applyFov(target: WorkerState, fov: number): void {
  target.camera.fov = fov;
  target.camera.updateProjectionMatrix();
}

/**
 * The pose a shot travels to, or null when there is nothing honest to travel to.
 *
 * `targetPartId` resolves against the live model's framing (the same fit the focus glide uses);
 * an explicit `pose` overrides the current rig field by field, deriving spherical coordinates when
 * a full position–target pair is authored. A shot with neither — or one whose part does not exist,
 * or whose framing is a NaN — returns null and the shot simply does not start.
 */
function shotDestination(
  target: WorkerState,
  shot: ShotDeclInput,
): { pose: OrbitPose; focus: { object: THREE.Object3D; margin: number } | null } | null {
  const margin = shot.margin ?? SHOT_DEFAULT_MARGIN;
  if (shot.targetPartId !== undefined && target.model) {
    const object = target.model.parts.get(shot.targetPartId);
    // `05`: a missing target skips the move, it does not fake one.
    if (!object) return null;
    const pose = framingPose(target, object, margin);
    if (!pose) return null;
    return { pose, focus: { object, margin } };
  }
  if (shot.pose) {
    const pose = currentPose(target);
    const { position, target: lookAt } = shot.pose;
    if (position && lookAt) {
      const dx = position[0] - lookAt[0];
      const dy = position[1] - lookAt[1];
      const dz = position[2] - lookAt[2];
      const distance = Math.max(0.1, Math.sqrt(dx * dx + dy * dy + dz * dz));
      pose.theta = Math.atan2(dx, dz);
      pose.phi = Math.acos(Math.max(-1, Math.min(1, dy / distance)));
      pose.distance = distance;
      pose.target = { x: lookAt[0], y: lookAt[1], z: lookAt[2] };
    } else if (lookAt) {
      pose.target = { x: lookAt[0], y: lookAt[1], z: lookAt[2] };
    } else if (position) {
      // A position without a target orbits to the same angles measured from the current pivot.
      const dx = position[0] - pose.target.x;
      const dy = position[1] - pose.target.y;
      const dz = position[2] - pose.target.z;
      const distance = Math.max(0.1, Math.sqrt(dx * dx + dy * dy + dz * dz));
      pose.theta = Math.atan2(dx, dz);
      pose.phi = Math.acos(Math.max(-1, Math.min(1, dy / distance)));
      pose.distance = distance;
    }
    if (!isUsablePose(pose)) return null;
    return { pose, focus: null };
  }
  return null;
}

/**
 * Play a declared camera shot. Returns whether it actually started.
 *
 * A `false` is an honest skip, never a fake: an unplayable kind (`crane`, `orbit`, `follow`,
 * `pan`, `moveTo` — see `PLAYABLE_SHOT_KINDS`) and a missing target part both leave the camera
 * exactly where it was, which is why the audit flags the kind and dangling ids separately — the
 * learner must never watch a move the manifest promised and did not make.
 */
export function playShot(target: WorkerState, shot: ShotDeclInput): boolean {
  if (!target.manifest) return false;
  if (!PLAYABLE_SHOT_KINDS.has(shot.kind)) return false;
  const duration = shot.duration ?? SHOT_DEFAULT_DURATION;
  const easing = shot.easing ?? SHOT_DEFAULT_EASING;

  switch (shot.kind) {
    case 'cut': {
      const destination = shotDestination(target, shot);
      if (!destination) return false;
      target.autoRotate = false;
      cancelCameraMove(target);
      applyPose(target, destination.pose);
      // A cut's authored fov applies in the same frame as its framing — an instant transition
      // means the *whole* frame the learner sees next is the destination.
      if (shot.pose?.fov !== undefined) applyFov(target, shot.pose.fov);
      target.cameraDirty = true;
      return true;
    }
    case 'flyTo': {
      const destination = shotDestination(target, shot);
      if (!destination) return false;
      target.autoRotate = false;
      // The focus rides along so a moving part is re-framed every frame while the approach runs.
      startGlide(target, destination.pose, destination.focus ?? undefined, duration, easing);
      return true;
    }
    case 'dolly': {
      // The contract's sign: negative moves toward the target. No distance means nothing to move.
      if (shot.distance === undefined || !Number.isFinite(shot.distance)) return false;
      target.autoRotate = false;
      startGlide(
        target,
        dollyPose(currentPose(target), shot.distance),
        undefined,
        duration,
        easing,
      );
      return true;
    }
    case 'fovPull': {
      if (shot.fov === undefined || !Number.isFinite(shot.fov)) return false;
      if (!Number.isFinite(target.camera.fov)) return false;
      target.autoRotate = false;
      // A pull is a still-camera move: an in-flight glide would move the framing under it.
      cancelCameraMove(target);
      target.fovMove = {
        fromFov: target.camera.fov,
        toFov: shot.fov,
        elapsed: 0,
        duration: Math.max(0.01, duration),
        easing,
      };
      target.cameraDirty = true;
      return true;
    }
    default:
      return false;
  }
}

/**
 * Play the shots an interaction declares for a part's `click` (`on: 'click'`, kind `playShot`).
 *
 * Returns whether one actually played, so the tap handler can fall back to the default
 * select-and-frame move when the interaction carries nothing that plays. Every other
 * interaction trigger (`hover` per-move spam, the double-tap timers the rig does not model)
 * is deliberately out of the player's reach today: a shot that fires on a hover would fire
 * dozens of times a second, and half a camera vocabulary beats one that misfires.
 */
export function playPartShots(target: WorkerState, partId: string): boolean {
  if (!target.manifest) return false;
  for (const interaction of target.manifest.interactions) {
    if (interaction.partId !== partId || interaction.on !== 'click') continue;
    if (!interaction.shot) continue;
    if (playShot(target, interaction.shot)) return true;
  }
  return false;
}

/**
 * Every way the camera is told to move, ended at once.
 *
 * `00`: "never fight the user." Any learner gesture, any pose move replacing another, and any
 * new shot all end what was in flight — pose moves and fov pulls alike, because a pull under a
 * fresh glide would move the framing the pull promised to hold.
 */
export function cancelCameraMove(target: WorkerState): void {
  target.glide = null;
  target.fovMove = null;
  target.glideFocus = null;
}

/**
 * Advance the shot player by one tick: fov pull first, then any pose glide.
 *
 * Extracted from the frame loop so tests can drive it, and so the loop keeps one camera
 * choreography call. Runs on wall-clock seconds above the render gate — the camera is an
 * instrument, not simulation: a slow-motion model does not slow the shot, and a paused one can
 * still be looked at properly. Both branches write only into state that already exists; there
 * is no per-frame allocation here.
 */
export function advanceShot(target: WorkerState, deltaSeconds: number): void {
  const cameraDelta = Math.min(TIMING.maxDelta, Math.max(0, deltaSeconds));

  if (target.fovMove) {
    const move = target.fovMove;
    move.elapsed += cameraDelta;
    const t = Math.min(1, move.elapsed / move.duration);
    applyFov(target, move.fromFov + (move.toFov - move.fromFov) * easeFor(move.easing)(t));
    // The projection changed; the frame must present even on a paused, still model.
    target.cameraDirty = true;
    if (t >= 1) target.fovMove = null;
  }

  if (target.glide) {
    // The destination is measured again while the camera travels: a spinning blade is somewhere
    // else by the time the camera arrives, and a window resized mid-move changes what fits on
    // screen for the same reason.
    if (target.glideFocus) {
      const live = framingPose(target, target.glideFocus.object, target.glideFocus.margin);
      if (live) target.glide = retargetGlide(target.glide, live.target, live.distance);
    }
    const stepped = stepGlide(target.glide, cameraDelta, glideLimits(target));
    applyPose(target, stepped.pose);
    target.glide = stepped.done ? null : stepped.glide;
    // The rig moved, so the camera must be recomputed — and the frame presented, because
    // `cameraDirty` is what keeps the on-demand gate open for the length of the move.
    target.cameraDirty = true;
  }
}

/** Set up the renderer. Called once per worker; the worker is replaced rather than reconfigured. */
/**
 * True between `webglcontextlost` and `webglcontextrestored`.
 *
 * The render loop checks it so a lost context stops costing frames — the browser is trying to
 * reclaim memory and we should not be fighting it — and so the watchdog's silence means
 * "context lost", which the notice explains, rather than a mysteriously blank canvas.
 */
let CONTEXT_LOST = false;

/** Textures that must be re-uploaded after a context loss; every GPU-side buffer died with it. */
const RESOURCE_TEXTURES = new Set<THREE.Texture>();

function initRenderer(request: Extract<WorkerRequest, { type: 'init' }>): WorkerState {
  const renderer = new THREE.WebGLRenderer({
    canvas: request.canvas,
    antialias: request.tier !== 'low',
    alpha: false,
    // `low-power` on weak devices is a real battery and thermal win, and `08` requires the GPU hint to follow the
    // detected tier rather than always asking for maximum performance.
    powerPreference: request.tier === 'low' ? 'low-power' : 'high-performance',
  });

  renderer.setPixelRatio(request.pixelRatio);
  renderer.setSize(request.width, request.height, false);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  // ACES filmic keeps emissive parts from clipping to white, which matters because emissive intensity is a
  // *read-out* in this platform (`01`) and a clipped read-out cannot be read.
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1;
  renderer.shadowMap.enabled = request.tier !== 'low';
  renderer.shadowMap.type = THREE.PCFShadowMap;

  // WebGL context loss (`08` edge cases). A memory-pressured phone reclaims the GPU and fires
  // `webglcontextlost`; with nothing listening, Three stops silently and the canvas stays black
  // for the rest of the session while the worker keeps heartbeating — so the watchdog never fires
  // and nothing tells the learner. `preventDefault` is what makes restoration possible at all.
  request.canvas.addEventListener(
    'webglcontextlost',
    (event) => {
      event.preventDefault();
      // Drawing into a lost context is pure waste and keeps the reclaim from succeeding — and it
      // is what the old recovery did, while its message claimed the model was fine. The loop keeps
      // ticking (stats still publish, so the watchdog knows the worker is alive) but presents
      // nothing until the browser hands the context back.
      CONTEXT_LOST = true;
      post({
        type: 'notice',
        message: 'The browser reclaimed the graphics memory. Restoring the model…',
      });
    },
    false,
  );
  request.canvas.addEventListener(
    'webglcontextrestored',
    () => {
      CONTEXT_LOST = false;
      // Every GPU-side object died with the context; re-upload from the CPU copies we still hold.
      // This is the half the old code faked: `RESOURCE_TEXTURES` was declared and iterated but
      // never populated by anything, so the loop marked nothing, the geometry reappeared (the
      // renderer re-uploads lazily) and the textures did not. Now they show up honest.
      renderer.resetState();
      reuploadTextures(RESOURCE_TEXTURES);
      // A restored context must present: without an invalidation the on-demand gate would keep
      // serving the last-still frame indefinitely.
      if (state) state.needsRender = true;
      post({
        type: 'notice',
        message: 'Graphics memory restored — the model is back.',
      });
    },
    false,
  );

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(
    45,
    request.width / Math.max(1, request.height),
    0.01,
    2000,
  );

  const next: WorkerState = {
    renderer,
    scene,
    camera,
    canvas: request.canvas,
    tier: request.tier,
    pixelRatio: request.pixelRatio,
    width: request.width,
    height: request.height,
    // Built by `applyTheme` below, which owns the grid's whole lifecycle.
    grid: null,

    builder: null,
    model: null,
    manifest: null,
    verdict: null,
    guard: null,
    physics: null,
    simFailed: false,

    partNodes: new Map(),
    motionBases: new Map(),
    runsWhilePausedParts: new Set(),
    hasRunsWhilePaused: false,
    lastProbes: {},
    paramsRecord: null,
    needsFrame: false,
    cameraDirty: false,
    needsRender: false,

    paused: false,
    timeScale: 1,
    elapsed: 0,
    lastRateFrame: 0,
    lastRateAt: 0,
    wallElapsed: 0,
    frame: 0,
    lastFrameAt: 0,
    lastHeartbeatMs: 0,
    lastStatsMs: 0,
    frameTimes: [],
    overruns: 0,
    loadStartedAt: 0,
    frameDisable: createFrameDisableState(),
    physicsMillis: 0,
    physicsUnavailableReason: null,
    annotations: [],
    videoCapability: null,
    recording: null,

    ladder: {
      applied: new Set(),
      pressureFrames: 0,
      headroomFrames: 0,
      basePixelRatio: request.pixelRatio,
      warnedAboutPin: false,
    },

    pinnedQuality: request.quality,

    orbit: { theta: Math.PI * 0.25, phi: Math.PI * 0.4, distance: 5, target: new THREE.Vector3() },
    autoRotate: true,

    glide: null,
    fovMove: null,
    pointerPress: null,
    pointersDown: 0,
    glideFocus: null,

    hoveredPart: null,
    selectedPart: null,
    viewMode: 'normal',
    effects: new ViewEffects(),
    hoverPending: false,

    raycaster: new THREE.Raycaster(),
    pointer: new THREE.Vector2(),
  };

  applyTheme(next, request.theme);
  updateCamera(next);
  return next;
}

/**
 * Load a program: author, price, realize, swap.
 *
 * The swap is atomic in the sense `03` R2 requires — the previous model is disposed only after the new one is
 * fully realized, so a failure anywhere above leaves the learner looking at what they already had.
 *
 * Exported for the swap-contract test, which runs this pipeline in Node against a state the test
 * owns (the worker message handler itself needs worker globals no test realm has).
 *
 * `runtime` is the instrumented twin of `code` and the string that actually executes: `compileGuest`'s
 * guard closes over `__edu3d_tick` calls the instrumentation spliced in, so compiling the clean `code`
 * instead meant no model reaching a browser ever had a loop guard — the cheap layer of the sandbox's
 * five never ran. Old bundles (and the on-disk reference source) carry no `runtime`; they compile the
 * clean string and fall back to the expensive outer layers, exactly as before.
 */
export function loadProgram(
  target: WorkerState,
  request: Extract<WorkerRequest, { type: 'load' }>,
): void {
  logs.length = 0;
  const buildStart = performance.now();
  target.loadStartedAt = buildStart;

  const builder = new SceneBuilder();
  builder.beginTiming();

  let guard: GuardHandle;
  let compiled: ReturnType<typeof compileGuest>;

  try {
    // Step 2 and 3: facades and compilation, while `new Function` still exists.
    const compileStart = performance.now();
    guard = createGuard();
    // A load without an instrumented twin is a RAW load — the e2e replay path, a gallery bundle
    // whose `runtime` predates its `code`, any manual probe. Run the pipeline's own build contract
    // here: gate the source and instrument its loops, so `while(true)` in a raw load trips the
    // injected guard at the 20 s build deadline instead of relying on a watchdog that is honouring
    // this machine's 60 s build grace. The generated path (server → `runtime`) skips this: it was
    // gated and instrumented server-side, where the violations name the repair pass.
    let source = request.runtime;
    if (source === undefined) {
      const prepared = prepareProgram(request.code, { apiSurface: apiSurfaceSet() });
      if (!prepared.ok) {
        post({
          type: 'loadFailed',
          message: describeViolations(prepared.gate).join('\n'),
          timedOut: false,
          logs: [...logs],
        });
        return;
      }
      if (prepared.truncated) {
        post({
          type: 'loadFailed',
          message: 'This program appears to be cut off mid-statement.',
          timedOut: false,
          logs: [...logs],
        });
        return;
      }
      source = prepared.instrumented;
    }
    compiled = compileGuest(source);
    stageLog(
      `compile ok — ${request.code.length} bytes · ${Math.round(performance.now() - compileStart)}ms`,
    );
  } catch (error) {
    const described = describeFailure(error);
    builder.dispose();
    post({ type: 'loadFailed', message: described.message, timedOut: false, logs: [...logs] });
    return;
  }

  const random = M.createRandom(request.seed >>> 0);
  const bindings: Record<string, unknown> = {
    __edu3d_tick: guard.tick,
    scene: builder.createFacade(),
    geom: builder.geometry.createFacade(),
    mat: builder.materials.createFacade(),
    M: Object.freeze({ ...M }),
    console: createConsole(),
    random: Object.freeze({
      float: random.float,
      range: random.range,
      int: random.int,
      pick: random.pick,
      unitVector: random.unitVector,
    }),
  };

  // Step 4: harden. After compilation, before execution. Idempotent, so a second load is safe.
  hardenRealm(globalThis as unknown as Record<string, unknown>);

  guard.reset(request.deadlineMs ?? SANDBOX_LIMITS.buildDeadlineMs);

  let manifest: ModelManifest;
  try {
    // Step 5: run the guest.
    compiled.run(bindings);
    manifest = builder.toManifest();
    stageLog(
      `authored — ${manifest.parts.length} parts · ${manifest.parameters.length} params · ` +
        `${manifest.motions.length} motions · ${Math.round(performance.now() - buildStart)}ms`,
    );
  } catch (error) {
    const described = describeFailure(error);
    builder.dispose();
    post({
      type: 'loadFailed',
      message: described.message,
      timedOut: described.timedOut,
      logs: [...logs],
    });
    return;
  }

  const verdict = priceModel(manifest, target.tier);
  stageLog(
    verdict.admitted
      ? `admission — admitted · ${verdict.adjustments.length} adjustment(s), detailed in notices`
      : 'admission — REFUSED this device',
  );
  if (!verdict.admitted) {
    builder.dispose();
    post({
      type: 'loadFailed',
      message: verdict.refusal ?? 'This model is too complex for this device.',
      timedOut: false,
      logs: [...logs],
    });
    return;
  }

  // Collect geometry data for the realizer. The factory holds it; the manifest holds only keys and costs.
  const geometries = new Map<string, MeshData>();
  for (const record of builder.geometry.entries()) {
    geometries.set(record.handle.cacheKey, builder.geometry.resolve(record.handle) as MeshData);
  }

  let realized: RealizedModel;
  try {
    const realizeStart = performance.now();
    realized = realize({ manifest, geometries, decisions: verdict.decisions });
    stageLog(
      `realized — ${realized.stats.triangles} tris · ${realized.stats.drawCalls} draws · ` +
        `${realized.stats.geometries} geometries · ${Math.round(performance.now() - realizeStart)}ms`,
    );
  } catch (error) {
    const described = describeFailure(error);
    builder.dispose();
    post({ type: 'loadFailed', message: described.message, timedOut: false, logs: [...logs] });
    return;
  }

  // The swap. Everything above could fail without the learner losing their current model.
  if (target.model) {
    target.scene.remove(target.model.root);
    target.model.dispose();
  }
  target.physics?.dispose();
  target.physics = null;
  // The reason belonged to the previous model's failure. Cleared unconditionally, not only when the
  // new model declares physics — otherwise a model with no simulation would inherit the last one's
  // "physics unavailable" and the status bar would explain a problem that is not there.
  target.simFailed = false;
  target.physicsUnavailableReason = null;
  if (target.builder) target.builder.dispose();

  target.builder = builder;
  target.model = realized;
  target.manifest = manifest;
  target.verdict = verdict;
  target.guard = guard;
  // Nothing of the previous model's session may drive this one. `paramsRecord` is the numeric
  // record the motion applicator resolves against, built lazily from the *current* builder — a
  // record left standing here would let model A's `speed: 5` animate model B (whose slider reads
  // its own default, 1), and ids that exist in neither model would tag along. `setParameter`
  // nulls it; the swap must too.
  target.paramsRecord = null;
  // Bank every texture the new model's materials hold, so a context loss can actually re-upload
  // them on restore instead of claiming it did. (The old set was iterated on restore and populated
  // by nothing — the audit's false-recovery bug; see `context-restore.ts`.)
  RESOURCE_TEXTURES.clear();
  collectModelTextures(realized.root, RESOURCE_TEXTURES);

  // Declared-motion anchors, captured the moment the manifest exists and before any frame runs:
  // the authored transform per motion-driven part (never mutated again — it is what every animated
  // pose is computed from, so reset and time-scrub stay exact), the live node lookup, and the
  // subset that keeps moving while paused.
  target.partNodes = new Map(manifest.parts.map((node) => [node.id, node]));
  target.motionBases = new Map();
  target.runsWhilePausedParts = new Set();
  target.hasRunsWhilePaused = false;
  for (const motion of manifest.motions) {
    const node = target.partNodes.get(motion.partId);
    if (node && !target.motionBases.has(motion.partId)) {
      target.motionBases.set(motion.partId, {
        position: [...node.transform.position] as [number, number, number],
        ...(node.transform.rotation
          ? { rotation: [...node.transform.rotation] as [number, number, number] }
          : {}),
        scale: [...node.transform.scale] as [number, number, number],
      });
    }
    if (motion.runsWhilePaused) {
      target.runsWhilePausedParts.add(motion.partId);
      target.hasRunsWhilePaused = true;
    }
  }
  target.lastProbes = {};

  // X-ray and explode re-bind to the new model here: the shared shell material is disposed with the
  // old root and a fresh one is captured against these parts, and every explode pose is measured
  // from the assembled model's world bounds. The authored `explodeOffset` (when a part has one) is
  // resolved through the realized object's part id, because only this side holds the manifest. The
  // sticky mode flags survive, so a model generated while inspecting arrives in the same mode.
  const explodeOffsets = new Map<string, readonly number[]>();
  for (const node of manifest.parts) {
    if (node.explodeOffset) explodeOffsets.set(node.id, node.explodeOffset);
  }
  target.effects.setRoot(realized.root, (object) => {
    const partId = realized.partOf.get(object);
    return partId ? (explodeOffsets.get(partId) ?? null) : null;
  });

  // A new model starts with a clean camera: a move in flight belonged to the old one — pose
  // moves and fov pulls alike.
  cancelCameraMove(target);
  target.pointerPress = null;
  target.pointersDown = 0;

  target.elapsed = 0;
  target.frame = 0;
  target.overruns = 0;
  target.frameDisable = createFrameDisableState();
  target.selectedPart = null;
  target.hoveredPart = null;
  // Admission decisions ride the new verdict; the live ladder starts clean.
  target.ladder.applied = new Set(
    (verdict.adjustments.map((adjustment) => adjustment.rung) as QualityRung[]).filter((rung) =>
      (QUALITY_LADDER as readonly string[]).includes(rung),
    ),
  );
  target.ladder.pressureFrames = 0;
  target.ladder.headroomFrames = 0;
  target.ladder.basePixelRatio = target.pixelRatio;

  target.scene.add(realized.root);

  // Physics is progressive enhancement (`02` R1): the WASM loads async; on failure the model animates
  // and the status bar says simulation is off — never a crash, never a fake.
  if (manifest.physics) {
    target.simFailed = false;
    target.physicsUnavailableReason = null;
    PhysicsWorld.create(manifest, target.tier)
      .then((world) => {
        // A newer load may have replaced the model while the WASM was loading.
        if (target.builder === builder && world) target.physics = world;
        else if (world) world.dispose();
        if (!world && target.builder === builder) {
          target.simFailed = true;
          // The status bar reads this reason from the next `stats`; the notice says it once, out loud.
          // The runtime's own failure (when it has one) is carried through: "the device could not
          // load it" is a claim this code cannot actually make on the device's behalf.
          target.physicsUnavailableReason = PhysicsWorld.runtimeFailure
            ? `Physics could not start: ${PhysicsWorld.runtimeFailure}`
            : 'The physics engine could not load on this device.';
          post({
            type: 'notice',
            message:
              'Physics simulation is unavailable on this device; the model animates instead.',
          });
        }
      })
      .catch(() => {
        if (target.builder === builder) {
          target.simFailed = true;
          target.physicsUnavailableReason = 'The physics engine could not load on this device.';
        }
      });
  }

  // Apply the authored opening frame. `00`: "every model opens with the full concept in view."
  resetCameraToInitial(target);

  // Post-processing and pixel ratio follow the admission decisions rather than the model's wishes.
  target.renderer.setPixelRatio(Math.min(target.pixelRatio, verdict.decisions.maxPixelRatio));
  target.renderer.shadowMap.enabled = verdict.decisions.shadowLights.size > 0;

  // Warmup render while the host's build grace is still active. Shader compilation happens on first
  // render and can take seconds on weak devices; doing it here rather than in the frame loop keeps the
  // watchdog from mistaking compile time for a hang.
  try {
    target.renderer.render(target.scene, target.camera);
  } catch (error) {
    target.scene.remove(realized.root);
    realized.dispose();
    builder.dispose();
    const described = describeFailure(error);
    post({ type: 'loadFailed', message: described.message, timedOut: false, logs: [...logs] });
    return;
  }

  target.lastHeartbeatMs = now();
  target.lastStatsMs = now();
  post({ type: 'loaded', manifest, verdict: toSerializable(verdict) });
  for (const adjustment of verdict.adjustments)
    post({ type: 'notice', message: adjustment.message });
}

/**
 * Apply the viewer's view mode across the model.
 *
 * Wireframe stays inline — it flips `wireframe` on the authored materials themselves, and that is
 * its own pre-existing contract. X-ray and explode are delegated to the effects module: x-ray
 * because a shared shell swap plus an exact restore belongs with the material's lifetime (and the
 * old inline pass mutated the authored materials, kept every part's own colour, never set `side`,
 * and forced `depthWrite` back on for glass and fluid on exit), and explode because a toggle must
 * start an animation rather than write one snapped pose.
 */
export function applyViewMode(target: WorkerState): void {
  const model = target.model;

  target.effects.setXray(target.viewMode === 'xray');
  target.effects.setExplode(target.viewMode === 'explode');

  if (!model) return;

  // Wireframe last: entering x-ray swaps the shared shell in, and leaving it has just restored the
  // authored materials, so this writes the wireframe flag onto the real material either way.
  model.root.traverse((object: THREE.Object3D) => {
    if (!(object instanceof THREE.Mesh)) return;
    const material = object.material as THREE.Material & { wireframe?: boolean };
    if (!('wireframe' in material)) return;
    material.wireframe = target.viewMode === 'wireframe';
  });
}

/**
 * Walk up to the nearest ancestor that declares itself selectable.
 *
 * A click on a sub-mesh must resolve to the part the learner thinks they clicked, which is why this
 * ascends rather than reading `userData` off the hit alone. Shared by hover and by the annotation
 * pick, so the two can never disagree about what "that part" means.
 */
function selectablePartId(object: THREE.Object3D): string | null {
  let current: THREE.Object3D | null = object;
  while (current) {
    if (current.userData.selectable && typeof current.userData.partId === 'string') {
      return current.userData.partId as string;
    }
    current = current.parent;
  }
  return null;
}

/** Raycast against the model and report what the pointer is over. */
function updateHover(target: WorkerState): boolean {
  const model = target.model;
  if (!model) return false;

  target.raycaster.setFromCamera(target.pointer, target.camera);
  const hits = target.raycaster.intersectObject(model.root, true);

  let partId: string | null = null;
  for (const hit of hits) {
    partId = selectablePartId(hit.object);
    if (partId) break;
  }

  const changed = partId !== target.hoveredPart;
  if (changed) {
    target.hoveredPart = partId;
    post({ type: 'hover', partId });
  }
  // The caller renders only on change: a cast is cheap, a presented frame is not.
  return changed;
}

/**
 * The pick ray's normalised device coordinate, kept apart from the hover pointer.
 *
 * `target.pointer` belongs to hover, whose cast is coalesced to one per frame; a click writing into it
 * would leave a later coalesced hover casting from the click's position instead of the mouse's, and
 * highlight the wrong part. One extra `Vector2` avoids that entirely.
 */
const PICK_NDC = new THREE.Vector2();

/**
 * Turn a screen point into a world-space point on the realized model (`03` R7).
 *
 * Returns the first surface the ray strikes, with the nearest selectable part it belongs to — a note
 * pinned to unselectable geometry (a ground plane, a backdrop) is still a note glued to geometry, so
 * the point is reported even when no part owns it. A miss returns `null`, never the model's centre.
 */
export function pickPoint(
  target: WorkerState,
  x: number,
  y: number,
): { point: [number, number, number] | null; partId: string | null } {
  const model = target.model;
  if (!model) return { point: null, partId: null };

  PICK_NDC.set((x / target.width) * 2 - 1, -(y / target.height) * 2 + 1);
  target.raycaster.setFromCamera(PICK_NDC, target.camera);
  const hit = target.raycaster.intersectObject(model.root, true)[0];
  if (!hit) return { point: null, partId: null };

  return {
    point: [hit.point.x, hit.point.y, hit.point.z],
    partId: selectablePartId(hit.object),
  };
}

/** A projected point: a canvas position when it can be seen, or an explicit "nothing honest to report". */
export type ProjectedPoint = { visible: true; x: number; y: number } | { visible: false };

/** Projection scratch, module-level: one reused vector instead of one per pin per frame. */
const PROJECT_SCRATCH = new THREE.Vector3();

/**
 * Project a world point onto the canvas, in the same pixel space pointer messages use.
 *
 * The view matrix is applied first, on purpose. `Vector3.project` divides by `w`, and a point behind
 * the camera has a negative `w` — the division mirrors it back through the origin, so a pin whose
 * geometry is behind the learner comes out as a plausible-looking coordinate on the *opposite* side
 * of the screen. Testing view-space `z` against the near plane catches that case before any division,
 * and the frustum test catches the rest. Both report `visible: false`, and neither invents a number.
 *
 * `updateMatrixWorld` is called here rather than trusted to the caller: it composes the world matrix
 * from position/quaternion (and inverts it), so a projection can never read a stale pose — including
 * in tests that set the camera without ever rendering.
 */
export function projectPointToCanvas(
  camera: THREE.PerspectiveCamera,
  width: number,
  height: number,
  point: readonly [number, number, number],
): ProjectedPoint {
  camera.updateMatrixWorld();
  PROJECT_SCRATCH.set(point[0], point[1], point[2]).applyMatrix4(camera.matrixWorldInverse);
  // View space looks down −Z, so a point in front of the camera has z strictly beyond the near plane.
  if (!(PROJECT_SCRATCH.z < -camera.near)) return { visible: false };

  PROJECT_SCRATCH.applyMatrix4(camera.projectionMatrix);
  if (Math.abs(PROJECT_SCRATCH.x) > 1 || Math.abs(PROJECT_SCRATCH.y) > 1) return { visible: false };

  return {
    visible: true,
    x: (PROJECT_SCRATCH.x * 0.5 + 0.5) * width,
    y: (-PROJECT_SCRATCH.y * 0.5 + 0.5) * height,
  };
}

/**
 * Publish every pin's screen position for this frame.
 *
 * One message per call, and the frame loop calls it once per presented frame — that is the throttle.
 * With no pins it returns before touching a matrix: the common case must cost nothing, because the
 * feature nobody used should not be paid for by everyone (`03` R7).
 */
export function projectAnnotations(target: WorkerState): void {
  if (target.annotations.length === 0) return;

  const pins: ProjectedAnnotation[] = [];
  for (const pin of target.annotations) {
    const projected = projectPointToCanvas(target.camera, target.width, target.height, pin.point);
    pins.push(
      projected.visible
        ? { id: pin.id, visible: true, x: projected.x, y: projected.y }
        : { id: pin.id, visible: false },
    );
  }
  post({ type: 'annotationPositions', pins });
}

/**
 * Reset motion-driven parts to their authored base, before the model's own frame code runs.
 *
 * This is the host half of the applicator's contract (`applyMotions` is stateless): after the
 * reset, the live transform holds `base ⊕ this tick's onFrame writes`, so a declared motion can
 * compose on top without accumulating and without clobbering what the model just wrote.
 *
 * While paused, only `runsWhilePaused` parts reset: everyone else freezes at the last animated
 * pose — a paused fan stops mid-angle rather than snapping to its authored orientation — while
 * the parts that keep moving are reset so their paused-time application stays absolute rather
 * than multiplying on itself every frame.
 */
function resetMotionDrivenParts(target: WorkerState, paused: boolean): void {
  // Delegated, in place: the worker's parts are the copy buffers, so the reset copies components
  // and allocates nothing per part per frame (see frame-compose.ts for the identity contract).
  resetMotionDrivenInto(target.motionBases, target.partNodes, target.runsWhilePausedParts, paused);
}

/**
 * Apply declared motion for this tick — the consumer of `manifest.motions`.
 *
 * Runs after `runFrame` (model code reacts to parameters first; declared motion composes on top)
 * and before `syncTransforms` (the renderer copies the composed pose). Nothing to apply when the
 * model declares no motion; the map is empty and this is a no-op.
 */
function applyDeclaredMotions(target: WorkerState): void {
  if (target.motionBases.size === 0 || !target.manifest) return;
  const host: MotionHost = {
    motions: target.manifest.motions,
    baseTransform: (partId) => target.motionBases.get(partId),
    liveTransform: (partId) => target.partNodes.get(partId)?.transform,
    // `pointOnPath` stays unset: the engine has no runtime path sampler yet, so `flowAlongPath`
    // skips in the browser (declared, audited, not yet flowing). Adding the sampler is a matter
    // of resolving manifest.paths here — deliberately not guessed at today.
  };
  // The parameter record is rebuilt only when a parameter changes (the `setParameter` handler
  // invalidates it), not per frame: `Object.entries` over the model's parameters was an allocation
  // every frame for data that changes on slider input alone.
  let params = target.paramsRecord;
  if (!params) {
    params = {};
    if (target.builder) {
      for (const [id, value] of Object.entries(target.builder.currentParameters())) {
        if (typeof value === 'number') params[id] = value;
      }
    }
    target.paramsRecord = params;
  }
  const context: ScalarContext = {
    params,
    elapsed: target.elapsed,
    // The never-pausing clock, consumed only by runsWhilePaused motions inside the applicator.
    unpausedElapsed: target.wallElapsed,
    frame: target.frame,
    probes: target.lastProbes,
  };
  applyMotions(host, context, target.paused);
}

/**
 * Apply the learner's time scale.
 *
 * Clamped to a range that stays meaningful: below 0.05× the model reads as frozen, and above 4× every
 * declared motion becomes a blur that teaches nothing (`02` calls the control "slow-motion for
 * collision study"). A non-finite scale is ignored — a `NaN` here would multiply through into
 * `elapsed` and poison every declared motion from that frame on.
 *
 * Extracted from the message handler so the policy can be tested without a worker realm, and so the
 * host's `setTimeScale` has exactly one place where its value is interpreted.
 */
export function applyTimeScale(target: WorkerState, scale: number): void {
  if (!Number.isFinite(scale)) return;
  target.timeScale = Math.max(0.05, Math.min(4, scale));
}

/** One frame: advance the model, run guest logic, render, publish. */
function renderFrame(target: WorkerState, timestamp: number): void {
  const rawDelta = target.lastFrameAt === 0 ? 1 / 60 : (timestamp - target.lastFrameAt) / 1000;
  target.lastFrameAt = timestamp;

  // The shot player advances here, above the gate, because the gate would otherwise close on a
  // paused or idle model and the move would never start. The camera is an instrument, not
  // simulation: it travels on wall-clock time, so a slow-motion model does not slow the camera
  // down, and a model paused for inspection can still be looked at properly. Pose glides and
  // fov pulls both live in `advanceShot` — see there for the allocation discipline.
  advanceShot(target, rawDelta);

  // The explode transition advances here for the same reason the camera move does: a paused model
  // can still be exploded, and a transition waiting on a gate that only a *change* opens would
  // never start on an otherwise-still model. `advance` reports the frame it completes as moved
  // too, so the final pose is presented rather than left unwritten.
  if (target.effects.advance(Math.min(TIMING.maxDelta, Math.max(0, rawDelta)))) {
    target.needsRender = true;
  }

  // The on-demand gate (`08`): a paused model with nothing marked dirty presents nothing — no
  // physics step, no guest callback, no declared motion, no sync, no cast, no render. `paused`
  // composes with `hasRunsWhilePaused`: a paused glow that pulses is never still, a paused fan
  // is still after the last invalidation. The stats cadence below runs on both paths, and its
  // `fps` reads 0 of itself while still (`computeFrameRate` reports a stall from the drained
  // window) — which is the honest figure, because zero frames were presented.
  const motionFrozen = target.paused && !target.hasRunsWhilePaused;
  const still = !renderGate({
    // autoRotate admits a frame only while the model runs: the orbit advance below is gated on
    // `!paused` anyway, so a paused + auto-rotate model presents a frozen frame at full rate —
    // the reviewer's default-state hole (the manifest defaults autoRotate on, so this was the
    // common case, not the edge).
    paused: motionFrozen,
    autoRotate: target.autoRotate && !target.paused,
    cameraDirty: target.cameraDirty,
    needsRender: target.needsRender,
  });

  // Clamped so a backgrounded tab resumes rather than fast-forwards (`08`). Computed before the
  // gate so a resume's first frame measures the real gap, then clamps it.
  const delta = Math.min(TIMING.maxDelta, Math.max(0, rawDelta)) * target.timeScale;
  if (!target.paused) target.elapsed += delta;

  if (!still) {
    // A still path freezes both clocks: advancing a wall clock nobody reads is bookkeeping for
    // nothing, and a resume re-measures the gap through lastFrameAt above.
    target.wallElapsed += delta;
    const frameStart = now();

    // The simulation steps on its own fixed clock, before guest logic so the last step's probes are
    // already published to `ctx.probes` when the model's own code reads them (`02` R4, R6).
    if (target.physics && !target.paused) {
      const stepped = target.physics.step(delta, target.builder?.motorTargets ?? new Map());
      target.physicsMillis = stepped.millis;
      if (Object.keys(stepped.probes).length > 0 && target.builder) {
        target.builder.publishProbes(stepped.probes);
      }
      // Kept for the motion applicator too: `{ probe: … }` scalar sources resolve from these,
      // the same measurements the model's own frame code just saw.
      if (Object.keys(stepped.probes).length > 0) target.lastProbes = stepped.probes;
    }

    // Guest frame logic, budgeted. A callback that overruns repeatedly gets the model paused with an explanation
    // rather than being killed: `SANDBOX_LIMITS.frameOverrunLimit`.
    // `needsFrame` is a bare clear at this phase (see its field comment); the on-demand gate above
    // is what spares the callback when nothing can have changed.
    target.needsFrame = false;
    if (target.builder && target.guard && !CONTEXT_LOST) {
      // The declared-motion base reset composes with the guest's writes, so it precedes the
      // callback — and it is NOT hostage to the callback's health (see the disable below).
      resetMotionDrivenParts(target, target.paused);

      // The guest callback, and only the guest callback, is disposable. The old code gated the
      // whole block — declared motion, transform sync, the physics pose — on this callback's
      // health, so one throwing frame froze the model, detached the physics solver from any pose
      // that was applied, and offered no way back. Now the model keeps breathing while its
      // animation script is dark, and the dark state is a circuit breaker, not a life sentence.
      const decision = frameCallbackDecision(target.frameDisable, now());
      let disable = target.frameDisable;
      if (decision.run) {
        target.guard.reset(SANDBOX_LIMITS.frameDeadlineMs, 2_000_000);
        const callbackStart = now();
        try {
          target.builder.runFrame(target.elapsed, delta, target.paused);
          const cost = now() - callbackStart;
          if (cost > SANDBOX_LIMITS.frameDeadlineMs) target.overruns += 1;
          else if (decision.probation) target.overruns = 0;
          else target.overruns = Math.max(0, target.overruns - 1);

          if (target.overruns > SANDBOX_LIMITS.frameOverrunLimit) {
            disable = frameCallbackFailed(disable, now());
            target.overruns = 0;
            // The notice stays honest about scope: only the model's own frame code is paused.
            post({
              type: 'notice',
              message:
                'This model’s animation was paused because it was too slow to keep up. The model’s declared motion and physics still run, and it stays explorable. It will retry automatically.',
            });
          } else {
            // A budget-holding run — probation or ordinary — restores full service, quietly.
            disable = frameCallbackRecovered();
          }
        } catch (error) {
          const wasDisabled = disable.disabled;
          disable = frameCallbackFailed(disable, now());
          target.overruns = 0;
          if (!wasDisabled) {
            // A throwing frame callback disables itself rather than killing the model: the geometry is still worth
            // exploring even if the animation is broken. The retry promise is said out loud.
            const described = describeFailure(error);
            post({
              type: 'notice',
              message: `Animation stopped: ${described.message} The model’s declared motion and physics still run, and it stays explorable; this script retries automatically.`,
            });
          }
        }
      }
      target.frameDisable = disable;

      // Declared motion, after the model's own writes and before the renderer copies the pose.
      // Unconditional: the applicator consumes the manifest, not the guest's code.
      applyDeclaredMotions(target);

      // Push the builder's authored transforms into the Three.js objects — including the physics
      // solver's pose, which must never be stepped into a void because a guest callback threw.
      syncTransforms(target);

      // The explode delta composes on top of the pose the motions and the guest just wrote: it is
      // *added*, never assigned, so a part that is animated can both move and explode instead of
      // losing its offset to the next `syncTransforms`. A no-op at progress 0.
      target.effects.apply();
    }

    // Gestured camera state (orbit/zoom/pan messages) applies once per frame — the messages carry
    // deltas, so applying at message rate bought nothing but event-loop contention against the
    // render tick. The consumer clears the flag so a quiet gesture costs nothing either.
    if (target.cameraDirty) {
      target.cameraDirty = false;
      updateCamera(target);
    }

    // Idle orbit, so the viewer is never inert (`00`).
    if (target.autoRotate && !target.paused) {
      target.orbit.theta += (target.manifest?.camera.limits.autoRotateSpeed ?? 0.35) * delta * 0.2;
      updateCamera(target);
    }

    // One coalesced hover raycast per frame, after the camera settled so the cast uses the pose that renders.
    // The CHANGE it finds is what marks the frame dirty — a cast is one raycast, a render is a
    // presented frame, and conflating them would put the pointer back in charge of the frame rate.
    if (target.hoverPending) {
      target.hoverPending = false;
      if (updateHover(target)) target.needsRender = true;
    }

    // A lost context is a reclaim in progress: presenting against it wastes the frame and fights
    // the browser for the memory. The loop keeps its cadence and its stats (so the watchdog sees a
    // live worker, not a hang), and restoration re-presents via `needsRender`.
    if (!CONTEXT_LOST) {
      target.renderer.render(target.scene, target.camera);
      // The clip is the viewport, so it is taken from the frame that was just presented — no second
      // render target, nothing to dispose. `captureRecordingFrame` itself closes the `VideoFrame`.
      if (target.recording) captureRecordingFrame(target);
    }

    // Pin projection, once per presented frame (`03` R7). A still frame does not reach here, which is
    // correct: nothing moved, so the positions the page already holds are still the positions.
    projectAnnotations(target);

    const frameTime = now() - frameStart;
    target.frameTimes.push(frameTime);
    if (target.frameTimes.length > TIMING.frameWindow) target.frameTimes.shift();

    // The live monitor rides on the measured frame time, after the frame it judges (`08`).
    monitorLadder(target, frameTime);

    target.frame += 1;
    if (target.frame === 1 && target.loadStartedAt > 0) {
      stageLog(
        `first frame — ${((performance.now() - target.loadStartedAt) / 1000).toFixed(1)}s end-to-end`,
      );
    }
  } else if (target.hoverPending) {
    // Still: the hover cast keeps its appointment (against the last presented pose — correct,
    // because nothing has rendered since). The change it finds wakes the presenter next tick.
    target.hoverPending = false;
    if (updateHover(target)) target.needsRender = true;
  }

  // The stats publish stays cadence-gated here so a frame never carries a duplicate of what the
  // heartbeat is about to say — but it is NOT the liveness proof anymore. The proof moved to the
  // wall-clock heartbeat below 'init': the stats cadence inherited the rAF cadence, and on a
  // software-raster device the presenter delivers at 0.2–2 fps, so the between-stats gap ran to
  // multiple seconds against a ~4 s silence window — an invisible hang written in healthy
  // arithmetic. The render loop publishes when it happens to be first in the window; it must never
  // be the only one who can.
  stepCadence(target);
}

function syncTransforms(target: WorkerState): void {
  const model = target.model;
  const manifest = target.manifest;
  if (!model || !manifest) return;

  // Delegated, by components: position/Euler/scale/visibility/material channels, no spreads.
  syncManifestTransforms(model.parts, manifest.parts);

  // Physics-driven parts take their pose from the solver, not the manifest — the override after
  // the manifest sync, exactly as before. Solver outputs are plain triples read off the Rapier
  // body, written component-wise into the realized object.
  const simulated = target.physics?.simulatedParts;
  if (!simulated || simulated.size === 0) return;
  for (const [partId, pose] of simulated) {
    const object = model.parts.get(partId);
    if (!object) continue;
    object.position.x = pose.position[0];
    object.position.y = pose.position[1];
    object.position.z = pose.position[2];
    if (object.rotation !== undefined && pose.rotation) {
      object.rotation.x = pose.rotation[0];
      object.rotation.y = pose.rotation[1];
      object.rotation.z = pose.rotation[2];
    }
    object.visible = true;
  }
}

/**
 * The adaptive ladder, live.
 *
 * Order is `QUALITY_LADDER`'s — least damage first — and every rung the admission pricing already
 * applied is pre-marked so the runtime never repeats a decision the pricer made (the two systems share
 * the vocabulary precisely so a device that started degraded and one that degraded later end in the
 * same state). Each step posts a notice, because `08` requires every step-down to be visible:
 * "silent degradation reads as breakage". Stepping back up is quiet, for the same reason a gift needs
 * no apology.
 */
function ladderStep(target: WorkerState, direction: 'down' | 'up'): void {
  const order = QUALITY_LADDER as readonly QualityRung[];
  const next =
    direction === 'down'
      ? order.find((rung) => !target.ladder.applied.has(rung))
      : [...order].reverse().find((rung) => target.ladder.applied.has(rung));

  if (!next) return;
  if (direction === 'down') target.ladder.applied.add(next);
  else target.ladder.applied.delete(next);

  const budget = DEVICE_BUDGETS[target.tier];
  switch (next) {
    case 'pixelRatio': {
      // The first and biggest lever on high-DPR phones. 0.75× render, upscaled.
      const capped =
        direction === 'down'
          ? Math.max(0.5, target.renderer.getPixelRatio() * 0.75)
          : Math.min(target.ladder.basePixelRatio, budget.maxPixelRatio);
      target.renderer.setPixelRatio(capped);
      break;
    }
    case 'postProcessing':
      // MSAA is fixed at context creation, so the runtime lever is the pixel ratio again — an
      // additional small step below the dedicated rung's floor, which reads as softening without
      // aliasing back. A real effects chain (bloom) lands with P9 polish and toggles here.
      if (direction === 'down') {
        target.renderer.setPixelRatio(Math.max(0.4, target.renderer.getPixelRatio() * 0.85));
      } else {
        target.renderer.setPixelRatio(Math.min(target.ladder.basePixelRatio, budget.maxPixelRatio));
      }
      break;
    case 'shadows':
      target.renderer.shadowMap.enabled =
        direction === 'up' && target.verdict!.decisions.shadowLights.size > 0;
      break;
    case 'flatShading': {
      // A material-level change, so it has to touch materials — not the shadow map, which is what
      // this used to do, announcing flat shading while shading stayed smooth. Three needs
      // `needsUpdate` because flatShading changes the shader program, not just a uniform.
      const flat = direction === 'down';
      target.model?.root.traverse((object: THREE.Object3D) => {
        if (!(object instanceof THREE.Mesh) && !(object instanceof THREE.InstancedMesh)) return;
        const materials = Array.isArray(object.material) ? object.material : [object.material];
        for (const material of materials) {
          if (!material || !('flatShading' in material)) continue;
          const typed = material as THREE.MeshStandardMaterial;
          if (flat) {
            if (!FLAT_ORIGINALS.has(typed)) FLAT_ORIGINALS.set(typed, typed.flatShading);
            typed.flatShading = true;
          } else {
            typed.flatShading = FLAT_ORIGINALS.get(typed) ?? false;
            FLAT_ORIGINALS.delete(typed);
          }
          typed.needsUpdate = true;
        }
      });
      break;
    }
    default:
      // Geometry detail, particles and physics substeps are admission-time decisions. The live
      // ladder skips them rather than rebuild GPU buffers mid-session — and, critically, says
      // nothing, because a notice for a rung that changed nothing is a lie the learner has to
      // reconcile against what they can see (`08`: silent degradation reads as breakage; a false
      // notice is worse, because the user checks).
      return;
  }

  if (direction === 'down') {
    post({
      type: 'notice',
      message: LADDER_NOTICES[next],
    });
  }
}

/** Authored flatness per material, so stepping back up restores the model's own choice. */
const FLAT_ORIGINALS = new WeakMap<THREE.MeshStandardMaterial, boolean>();

/**
 * One learner-facing sentence per rung, written once so the wording cannot drift between steps.
 *
 * Every sentence must describe what actually changed. The post-processing rung used to claim
 * "Antialiasing turned off" while MSAA — fixed at context creation — was still on.
 */
const LADDER_NOTICES: Record<QualityRung, string> = {
  pixelRatio: 'Render resolution reduced to keep motion smooth.',
  postProcessing: 'Render resolution softened further to keep motion smooth.',
  shadows: 'Shadows turned off to keep motion smooth.',
  geometryDetail: 'Shapes drawn coarser to keep motion smooth; every part is still here.',
  particles: 'Fewer particles drawn; the pattern is unchanged.',
  physicsSubsteps: 'Physics accuracy reduced to keep motion smooth.',
  flatShading: 'Smooth shading turned off to keep motion smooth; the shapes are unchanged.',
};

/**
 * The frame-time monitor: rolling average against the tier's target frame time.
 *
 * Averages over the rolling window (never a single spike), sustained for `ladderSustainFrames`, with
 * separate pressure/headroom counters so a mixed period does nothing — which is the hysteresis.
 */
function monitorLadder(target: WorkerState, frameTimeMs: number): void {
  const targetFrameMs = 1000 / DEVICE_BUDGETS[target.tier].targetFps;

  if (frameTimeMs > targetFrameMs * TIMING.ladderPressureFactor) {
    target.ladder.pressureFrames += 1;
    target.ladder.headroomFrames = 0;
  } else if (frameTimeMs < targetFrameMs * TIMING.ladderHeadroomFactor) {
    target.ladder.headroomFrames += 1;
    target.ladder.pressureFrames = 0;
  } else {
    // Between the bands: neither pressure nor headroom — hold, by design.
    target.ladder.pressureFrames = 0;
    target.ladder.headroomFrames = 0;
  }

  const decision = ladderDecision({
    pressureFrames: target.ladder.pressureFrames,
    headroomFrames: target.ladder.headroomFrames,
    sustainFrames: TIMING.ladderSustainFrames,
    pinned: target.pinnedQuality !== null,
  });

  if (decision.warn && !target.ladder.warnedAboutPin) {
    // The pin is honoured and the learner is told what it costs. `08`: the optimizer becomes a
    // warner — a quality they chose that the device cannot hold must not be silently exchanged for
    // stutter they cannot explain.
    target.ladder.warnedAboutPin = true;
    post({
      type: 'notice',
      message:
        'Your device is working hard to hold the quality you chose. Set quality back to Auto to let the platform adapt.',
    });
  }

  if (decision.step === 'down') {
    target.ladder.pressureFrames = 0;
    ladderStep(target, 'down');
  } else if (decision.step === 'up') {
    target.ladder.headroomFrames = 0;
    ladderStep(target, 'up');
  }
  // Otherwise: hold, by design. The counters keep their evidence for the next frame — including
  // when a pin means the pressure will never be acted on, which is the point of a pin.
}

/**
 * The cadence step: publish stats (and any metrics) once per window.
 *
 * Shared by the render loop and the wall-clock heartbeat, gated on the same `lastStatsMs` stamp so
 * exactly one of them fires per window — a healthy loop and the heartbeat race for it, and either
 * winner satisfies the host.
 */
function stepCadence(target: WorkerState): void {
  const clockMs = now();
  if (clockMs - target.lastStatsMs < TIMING.statsIntervalMs) return;
  target.lastStatsMs = clockMs;
  publishStats(target);
  if (target.builder) {
    const metrics = target.builder.currentMetrics();
    if (Object.keys(metrics).length > 0) post({ type: 'metrics', values: metrics });
  }
}

/**
 * The wall-clock heartbeat.
 *
 * This is the fix for the second head of the demo-killer. The worker's liveness proof used to ride
 * entirely on `renderFrame` — whose cadence is the *presenter's* cadence, and on a
 * software-raster device that is 0.2–2 fps: a healthy worker went silent for 3–10 s between
 * presented frames while its per-pass JS cost measured ~16 ms, so the host's adaptive silence
 * window (4 s base + 6× a tiny frameMillis) judged healthy-slow delivery a hang and executed the
 * model — often right after a tab returned, because that is when the watchdog's clock was
 * re-armed. `TIMING.heartbeatIntervalMs` was declared with exactly this purpose ("a model
 * rendering at 2 fps still beats every second") and never wired to anything.
 *
 * The interval fires on the event loop's own clock, so it proves what the watchdog actually needs
 * proving: that the event loop turns. A loop wedged in synchronous guest code cannot service
 * timers either — that hang still crosses the silence window and still dies. A paused model, a
 * lost context, a 0-fps presenter — all keep beating. Skips its own turn when the render loop
 * published inside the window (exactly-once stats, either winner).
 */
function startHeartbeat(): void {
  scheduleHeartbeat(() => {
    const target = state;
    if (!target) return;
    stepCadence(target);
  }, TIMING.heartbeatIntervalMs);
}

/**
 * The measured physics state, for the status bar.
 *
 * Derived from the live world, not from `manifest.physics`: the manifest says the model *asked* for a
 * simulation, and the honest answer to "is it running" is whether a world exists and no creation has
 * failed. `03` R9 forbids faking a trust indicator, and "Physics: On" on a device where the WASM never
 * loaded is precisely that fake.
 */
export function physicsStatus(target: WorkerState): {
  physicsActive: boolean;
  physicsUnavailableReason?: string;
} {
  if (target.physics) return { physicsActive: true };
  return target.physicsUnavailableReason
    ? { physicsActive: false, physicsUnavailableReason: target.physicsUnavailableReason }
    : { physicsActive: false };
}

/** Publish measured runtime cost. Every number measured, never estimated (`03` R9). */
function publishStats(target: WorkerState): void {
  const publishedAt = now();

  const average =
    target.frameTimes.length > 0
      ? target.frameTimes.reduce((sum, value) => sum + value, 0) / target.frameTimes.length
      : 0;

  const info = target.renderer.info;
  const geometryStats = target.builder?.geometry.stats;
  const cacheTotal = (geometryStats?.hits ?? 0) + (geometryStats?.misses ?? 0);

  post({
    type: 'stats',
    stats: {
      // Frames actually presented per second, measured across the window since the last publish.
      // This used to be `1000 / average`, which reports how fast a frame COULD complete rather than
      // how often one ran: a stalled loop whose last frames were fast claimed 68fps while presenting
      // nothing for 29 seconds. `frameMillis` stays as the mean per-frame work duration.
      fps: computeFrameRate(target.frame, target.lastRateFrame, publishedAt, target.lastRateAt),
      frameMillis: average,
      drawCalls: info.render.calls,
      triangles: info.render.triangles,
      physicsMillis: target.physicsMillis,
      ...physicsStatus(target),
      cacheHitRate: cacheTotal > 0 ? (geometryStats?.hits ?? 0) / cacheTotal : 1,
      // Reported as the pin when the learner set one: the status bar must show the quality in
      // force, not the quality the tier would have chosen.
      quality:
        target.pinnedQuality ??
        (target.tier === 'low' ? 'low' : target.tier === 'mid' ? 'medium' : 'high'),
      effectiveTier: target.tier,
      simSeconds: target.elapsed,
      // The camera's distance from its pivot: the number that changes while a camera move is in
      // flight, so the move is observable rather than something only the picture knows about.
      cameraDistance: target.orbit.distance,
      degradedRungs: [...target.ladder.applied],
    },
  });

  target.lastRateFrame = target.frame;
  target.lastRateAt = publishedAt;
}

/**
 * The three numbers an export temporarily changes, captured so the restore is exact.
 *
 * A 4K snapshot that left the drawing buffer at 4K would render every frame afterwards at four times
 * the fragments — a permanent cost paid for one file — so the restore is verified, not assumed.
 */
export interface ViewSize {
  width: number;
  height: number;
  pixelRatio: number;
}

/** The largest export edge, so a 4K request cannot allocate a buffer the GPU refuses and take the tab with it. */
export const MAX_SNAPSHOT_EDGE = 4_096;

/** What the page should know about the file it just received. */
export interface SnapshotSize {
  restore: ViewSize;
  width: number;
  height: number;
}

/** The renderer's real drawing-buffer geometry — read back, never assumed from `state.width`. */
function viewSize(target: WorkerState): ViewSize {
  const size = target.renderer.getSize(new THREE.Vector2());
  return { width: size.x, height: size.y, pixelRatio: target.renderer.getPixelRatio() };
}

function clampEdge(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.max(1, Math.min(MAX_SNAPSHOT_EDGE, Math.round(value)));
}

/**
 * Resize the drawing buffer for an export render and hand back the numbers that restore it.
 *
 * Pixel ratio 1 is the point of an authored resolution: an "HD" file must be 1280×720, not
 * 1280·DPR, or the same button produces a different file on every device.
 */
export function beginSnapshot(target: WorkerState, width: number, height: number): SnapshotSize {
  const restore = viewSize(target);
  const exportWidth = clampEdge(width);
  const exportHeight = clampEdge(height);
  target.renderer.setPixelRatio(1);
  target.renderer.setSize(exportWidth, exportHeight, false);
  target.camera.aspect = exportWidth / Math.max(1, exportHeight);
  target.camera.updateProjectionMatrix();
  return { restore, width: exportWidth, height: exportHeight };
}

/**
 * Restore the view exactly, and report whether it is exact.
 *
 * The return value exists so the worker can *say* when a restore failed rather than leave the learner
 * with a canvas that renders at export size forever. `false` posts a notice; it is never swallowed.
 */
export function endSnapshot(target: WorkerState, restore: ViewSize): boolean {
  target.renderer.setPixelRatio(restore.pixelRatio);
  target.renderer.setSize(restore.width, restore.height, false);
  target.camera.aspect = restore.width / Math.max(1, restore.height);
  target.camera.updateProjectionMatrix();
  // The buffer was resized twice, which clears it; the frame that proves the restore must present.
  target.needsRender = true;

  const restored = viewSize(target);
  return (
    restored.width === restore.width &&
    restored.height === restore.height &&
    restored.pixelRatio === restore.pixelRatio
  );
}

/** Frames per second a clip is sampled at. The render loop runs faster; closer frames are skipped. */
const RECORDING_FPS = 30;

/** Bits per pixel per second for the encoder. High enough for a screen recording, low enough for a phone. */
const RECORDING_BITS_PER_PIXEL = 0.12;

function recordingBitrate(width: number, height: number): number {
  const raw = width * height * RECORDING_FPS * RECORDING_BITS_PER_PIXEL;
  return Math.round(Math.max(500_000, Math.min(12_000_000, raw)));
}

/**
 * Probe what this device can actually encode, once, and tell the page.
 *
 * The answer is a promise from the runtime (`isConfigSupported`), not a feature-detect guess: a
 * `VideoEncoder` that refuses every configuration is not a device that can record, and reporting it as
 * one would put a button on screen that does nothing — the exact dishonest UI `03` R8 asks us to avoid.
 */
export async function probeVideoCapability(target: WorkerState): Promise<void> {
  const limits = {
    maxSeconds: VIDEO_CLIP_LIMITS.maxSeconds,
    maxBytes: VIDEO_CLIP_LIMITS.maxBytes,
  };

  if (!HostVideoEncoder) {
    target.videoCapability = {
      supported: false,
      reason: 'This browser cannot encode video clips in the background.',
      ...limits,
    };
    post({ type: 'capabilities', video: target.videoCapability });
    return;
  }

  const codec = 'vp8';
  try {
    const support = await HostVideoEncoder.isConfigSupported({
      codec,
      width: target.canvas.width,
      height: target.canvas.height,
      bitrate: recordingBitrate(target.canvas.width, target.canvas.height),
      framerate: RECORDING_FPS,
    });
    target.videoCapability = support.supported
      ? { supported: true, codec, ...limits }
      : { supported: false, reason: `This device cannot encode ${codec} video.`, ...limits };
  } catch {
    target.videoCapability = {
      supported: false,
      reason: 'This device refused a video encoder configuration.',
      ...limits,
    };
  }
  post({ type: 'capabilities', video: target.videoCapability });
}

/**
 * Start a clip, or refuse honestly.
 *
 * Every refusal is a `recordingFailed` carrying the reason, never a silent no-op: the page either
 * never offered the button (because the capability said so) or gets told why not.
 */
export function startRecording(target: WorkerState, requestedSeconds: number): void {
  if (target.recording) return;

  const capability = target.videoCapability;
  if (!HostVideoEncoder || !HostVideoFrame || !capability?.supported || !capability.codec) {
    post({
      type: 'recordingFailed',
      message: capability?.reason ?? 'Recording is not available on this device.',
    });
    return;
  }

  const width = target.canvas.width;
  const height = target.canvas.height;
  if (width < 2 || height < 2) {
    post({
      type: 'recordingFailed',
      message: 'The viewer is not on screen, so there is nothing to record.',
    });
    return;
  }

  // Bounded here as well as at the message boundary: the cap is a property of the recorder, not a
  // courtesy the caller is trusted to respect.
  const maxSeconds = Math.max(1, Math.min(VIDEO_CLIP_LIMITS.maxSeconds, requestedSeconds));

  // `session` is assigned before `configure`/`encode`, which are the only calls that can fire the
  // callbacks below; the null check keeps the closures total without a non-null assertion.
  let session: RecordingSession | null = null;
  const encoder = new HostVideoEncoder({
    output: (chunk) => {
      if (!session) return;
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      session.chunks.push({ data, timestampUs: chunk.timestamp, key: chunk.type === 'key' });
      session.bytes += data.byteLength;
    },
    error: (error) => {
      if (session) abortRecording(target, session, `Recording stopped: ${error.message}`);
    },
  });

  session = {
    encoder,
    width,
    height,
    fps: RECORDING_FPS,
    startedAtMs: now(),
    lastFrameUs: -1,
    chunks: [],
    bytes: 0,
    maxSeconds,
    maxBytes: VIDEO_CLIP_LIMITS.maxBytes,
    finishing: false,
  };

  try {
    encoder.configure({
      codec: capability.codec,
      width,
      height,
      bitrate: recordingBitrate(width, height),
      framerate: RECORDING_FPS,
      latencyMode: 'realtime',
    });
  } catch (error) {
    releaseEncoder(encoder);
    post({ type: 'recordingFailed', message: describeFailure(error).message });
    return;
  }

  target.recording = session;
  // The first frame of the clip is the frame the learner is already looking at.
  target.needsRender = true;
}

/**
 * Hand the presented canvas to the encoder, once per interval.
 *
 * The canvas *is* the clip: recording the frame that was just presented is what "video clip recording
 * of the viewport" means, and it avoids a second render target entirely. Frames closer together than
 * the sample interval are dropped, so a 120 fps presenter does not quadruple the bitrate of a 30 fps
 * clip. `VideoFrame` is GPU-backed, so it is closed immediately after encoding — an open frame is a
 * real allocation held for the life of the worker.
 */
function captureRecordingFrame(target: WorkerState): void {
  const session = target.recording;
  if (!session || session.finishing || !HostVideoFrame) return;

  const elapsedMs = now() - session.startedAtMs;
  if (elapsedMs >= session.maxSeconds * 1000) {
    void finishRecording(target);
    return;
  }

  const timestampUs = Math.round(elapsedMs * 1000);
  const intervalUs = Math.round(1_000_000 / session.fps);
  if (session.lastFrameUs >= 0 && timestampUs - session.lastFrameUs < intervalUs) return;
  const isFirstFrame = session.lastFrameUs < 0;
  session.lastFrameUs = timestampUs;

  const frame = new HostVideoFrame(target.canvas, { timestamp: timestampUs, duration: intervalUs });
  try {
    session.encoder.encode(frame, { keyFrame: isFirstFrame });
  } finally {
    frame.close();
  }

  // The byte cap is the second hard stop: a still scene costs almost nothing to encode, but a busy one
  // must not be able to grow the clip past what the page can hold.
  if (session.bytes >= session.maxBytes) void finishRecording(target);
}

/** Flush, mux and deliver the clip. Idempotent per session via the `finishing` latch. */
async function finishRecording(target: WorkerState): Promise<void> {
  const session = target.recording;
  if (!session || session.finishing) return;
  session.finishing = true;
  target.recording = null;

  try {
    await session.encoder.flush();
  } catch {
    // The encoder may already have errored and closed; the chunks collected so far are still usable.
  }
  releaseEncoder(session.encoder);

  if (session.chunks.length === 0) {
    post({ type: 'recordingFailed', message: 'The recording produced no frames.' });
    return;
  }

  const bytes = muxWebmVp8(session.chunks, session.width, session.height, 1000 / session.fps);
  post({
    type: 'recording',
    blob: new Blob([bytes], { type: 'video/webm' }),
    seconds: Math.max(0, session.lastFrameUs) / 1_000_000,
    bytes: bytes.byteLength,
  });
  target.needsRender = true;
}

/** Drop a clip that failed, releasing the encoder and everything it held. Never posts a fake success. */
function abortRecording(target: WorkerState, session: RecordingSession, message: string): void {
  if (session.finishing) return;
  session.finishing = true;
  if (target.recording === session) target.recording = null;
  releaseEncoder(session.encoder);
  session.chunks.length = 0;
  post({ type: 'recordingFailed', message });
}

/** Close an encoder at most once. `close()` on an already-closed encoder throws, and must not escape. */
function releaseEncoder(encoder: VideoEncoder): void {
  try {
    encoder.close();
  } catch {
    // Already closed (or errored). Closing is bookkeeping here, not the operation being reported.
  }
}

/** Release a clip during teardown, without messaging a realm that is going away. */
function releaseRecording(target: WorkerState): void {
  const session = target.recording;
  if (!session) return;
  session.finishing = true;
  target.recording = null;
  releaseEncoder(session.encoder);
  session.chunks.length = 0;
}

// ── WebM muxing ──────────────────────────────────────────────────────────────

/**
 * A minimal WebM (Matroska) writer for VP8 chunks.
 *
 * WebCodecs hands back encoded chunks, not a container, and this platform ships no muxing dependency.
 * Building the handful of EBML elements a single VP8 track needs keeps `00-GOAL.md`'s "video clip
 * recording of the viewport" real without adding a package. The clip is bounded long before it gets
 * here (`VIDEO_CLIP_LIMITS`), so the whole file fits in memory and the element sizes are known — no
 * streaming, no unknown-size segments.
 */
function ebmlUint(value: number): Uint8Array<ArrayBuffer> {
  const bytes: number[] = [];
  let remaining = Math.max(0, Math.floor(value));
  do {
    bytes.unshift(remaining & 0xff);
    remaining = Math.floor(remaining / 256);
  } while (remaining > 0);
  return new Uint8Array(bytes);
}

function ebmlFloat(value: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setFloat64(0, value, false);
  return bytes;
}

/** Variable-length EBML size, in the shortest form the value allows (all-ones is reserved as "unknown"). */
function ebmlSize(value: number): Uint8Array<ArrayBuffer> {
  let length = 1;
  while (length < 8 && value >= 2 ** (7 * length) - 1) length += 1;
  const bytes = new Uint8Array(length);
  let remaining = value;
  for (let index = length - 1; index >= 0; index -= 1) {
    bytes[index] = remaining & 0xff;
    remaining = Math.floor(remaining / 256);
  }
  bytes[0] = (bytes[0] ?? 0) | (1 << (8 - length));
  return bytes;
}

function ebmlElement(id: readonly number[], payload: Uint8Array): Uint8Array<ArrayBuffer> {
  const size = ebmlSize(payload.byteLength);
  const out = new Uint8Array(id.length + size.byteLength + payload.byteLength);
  out.set(id, 0);
  out.set(size, id.length);
  out.set(payload, id.length + size.byteLength);
  return out;
}

function ebmlConcat(parts: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
  let length = 0;
  for (const part of parts) length += part.byteLength;
  const out = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

function asciiBytes(text: string): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(text.length);
  for (let index = 0; index < text.length; index += 1) {
    bytes[index] = text.charCodeAt(index) & 0x7f;
  }
  return bytes;
}

/**
 * Mux VP8 chunks into a playable WebM.
 *
 * One video track, one timecode scale (milliseconds), clusters split only when a `SimpleBlock`'s
 * signed 16-bit relative timestamp would overflow — which the duration cap makes rare, but the
 * encoder is not trusted to stay inside it.
 */
export function muxWebmVp8(
  frames: readonly EncodedVideoFrame[],
  width: number,
  height: number,
  frameDurationMs: number,
): Uint8Array<ArrayBuffer> {
  const first = frames[0];
  if (!first) return new Uint8Array(0);

  const header = ebmlElement(
    [0x1a, 0x45, 0xdf, 0xa3],
    ebmlConcat([
      ebmlElement([0x42, 0x86], ebmlUint(1)), // EBMLVersion
      ebmlElement([0x42, 0xf7], ebmlUint(1)), // EBMLReadVersion
      ebmlElement([0x42, 0xf2], ebmlUint(4)), // EBMLMaxIDLength
      ebmlElement([0x42, 0xf3], ebmlUint(8)), // EBMLMaxSizeLength
      ebmlElement([0x42, 0x82], asciiBytes('webm')), // DocType
      ebmlElement([0x42, 0x87], ebmlUint(2)), // DocTypeVersion
      ebmlElement([0x42, 0x85], ebmlUint(2)), // DocTypeReadVersion
    ]),
  );

  const firstMs = Math.round(first.timestampUs / 1000);
  const last = frames[frames.length - 1] ?? first;
  const lastMs = Math.round(last.timestampUs / 1000);
  const durationMs = Math.max(frameDurationMs, lastMs - firstMs + frameDurationMs);

  const info = ebmlElement(
    [0x15, 0x49, 0xa9, 0x66],
    ebmlConcat([
      // TimecodeScale is nanoseconds per tick, so 1 ms ticks.
      ebmlElement([0x2a, 0xd7, 0xb1], ebmlUint(1_000_000)),
      ebmlElement([0x4d, 0x80], asciiBytes('edu3d')),
      ebmlElement([0x57, 0x41], asciiBytes('edu3d')),
      ebmlElement([0x44, 0x89], ebmlFloat(durationMs)),
    ]),
  );

  const trackEntry = ebmlElement(
    [0xae],
    ebmlConcat([
      ebmlElement([0xd7], ebmlUint(1)), // TrackNumber
      ebmlElement([0x73, 0xc5], ebmlUint(1)), // TrackUID
      ebmlElement([0x83], ebmlUint(1)), // TrackType: video
      ebmlElement([0x86], asciiBytes('V_VP8')), // CodecID
      ebmlElement(
        [0xe0],
        ebmlConcat([
          ebmlElement([0xb0], ebmlUint(width)), // PixelWidth
          ebmlElement([0xba], ebmlUint(height)), // PixelHeight
        ]),
      ),
    ]),
  );
  const tracks = ebmlElement([0x16, 0x54, 0xae, 0x6b], trackEntry);

  const clusters: Uint8Array[] = [];
  let clusterStartMs = firstMs;
  let blocks: Uint8Array[] = [];
  const flushCluster = (): void => {
    if (blocks.length === 0) return;
    clusters.push(
      ebmlElement(
        [0x1f, 0x43, 0xb6, 0x75],
        ebmlConcat([ebmlElement([0xe7], ebmlUint(clusterStartMs)), ...blocks]),
      ),
    );
    blocks = [];
  };

  for (const frame of frames) {
    const timeMs = Math.round(frame.timestampUs / 1000);
    if (blocks.length > 0 && timeMs - clusterStartMs > 30_000) {
      flushCluster();
      clusterStartMs = timeMs;
    }
    const relative = Math.max(0, Math.min(32_767, timeMs - clusterStartMs));
    const block = new Uint8Array(4 + frame.data.byteLength);
    block[0] = 0x81; // track number 1, written as a one-byte vint
    block[1] = (relative >> 8) & 0xff;
    block[2] = relative & 0xff;
    block[3] = frame.key ? 0x80 : 0x00; // flags: keyframe bit
    block.set(frame.data, 4);
    blocks.push(ebmlElement([0xa3], block));
  }
  flushCluster();

  const segment = ebmlElement([0x18, 0x53, 0x80, 0x67], ebmlConcat([info, tracks, ...clusters]));
  return ebmlConcat([header, segment]);
}

/** Release everything the worker owns. Idempotent and tolerant of partial prior failures (`02` R7). */
function disposeAll(): void {
  if (!state) return;
  if (state.model) {
    state.scene.remove(state.model.root);
    state.model.dispose();
  }
  // The clip's encoder holds a codec instance and the chunks hold the encoded bytes; both die here
  // rather than waiting for the realm to be collected.
  releaseRecording(state);
  // The grid lives on the scene, not the model root, so only teardown disposes it: geometry and
  // material are GPU resources and would otherwise wait on the realm's collection.
  disposeGrid(state);
  // The x-ray shell is a GPU material the model's disposal does not own; release it here.
  state.effects.dispose();
  state.physics?.dispose();
  state.builder?.dispose();
  state.renderer.dispose();
  // Forcing context loss releases the GPU allocation immediately rather than at the browser's discretion, which is
  // what keeps memory flat across repeated generate/load cycles (`08`).
  state.renderer.forceContextLoss();
  state = null;
  post({ type: 'disposed' });
}

/** The frame loop. `requestAnimationFrame` in a worker pauses when the page is hidden, which is wanted (`08`). */
function loop(timestamp: number): void {
  if (!state) return;
  // The reschedule must not be conditional on this frame succeeding. An exception thrown anywhere
  // in worker-internal code — the adaptive ladder, statistics, the hover cast — used to escape past
  // `scheduleFrame`, so the loop simply stopped being rescheduled: the page kept showing the last
  // frame forever, with no notice, no console error and no watcher trip, because a dead render loop
  // sends nothing. `00`: "a model's runtime failure is a normal event, not an exception."
  try {
    renderFrame(state, timestamp);
  } catch (error) {
    post({ type: 'notice', message: `Rendering stopped: ${describeFailure(error).message}` });
  }
  scheduleFrame(loop);
}

/**
 * Boot, and the one message that starts it.
 *
 * `initRenderer` hardens the realm, and hardening deletes `WebAssembly` — so Rapier's runtime has to
 * be compiled *before* it, which makes boot genuinely asynchronous. That is why the physics runtime
 * used to be unreachable: `PhysicsWorld.create` called `RAPIER.init()` during a load, long after the
 * capability was gone, and every physics model degraded to "the engine could not load on this
 * device" — a claim about the device made by code that could not tell the device from the sandbox.
 *
 * Because `ready` now arrives one compile later, every other message waits in `deferredRequests`.
 * The host sends `init` and `load` back to back; a `load` that overtook a still-booting worker hit
 * `if (!state) return` and vanished, and the symptom was a viewer that never loaded anything with
 * nothing on screen to read.
 */
let bootComplete = false;
const deferredRequests: WorkerRequest[] = [];

async function beginBoot(request: Extract<WorkerRequest, { type: 'init' }>): Promise<void> {
  // Failure is not fatal: `PhysicsWorld.create` degrades honestly, which is `02` R1's contract.
  await PhysicsWorld.warmUp();
  state = initRenderer(request);
  post({ type: 'ready' });
  scheduleFrame(loop);
  startHeartbeat();
  // The video-capability probe is asynchronous (`isConfigSupported`), so the page hears "checking"
  // from `ready` and the real answer a moment later. Nothing blocks on it.
  void probeVideoCapability(state);
  bootComplete = true;
  for (const pending of deferredRequests.splice(0)) dispatch(pending);
}

/**
 * Message handler.
 *
 * Registered before hardening deletes `addEventListener` from the global. The listener survives the deletion,
 * which is what lets the host keep receiving messages in a realm where the guest cannot send any.
 */
(
  globalThis as unknown as {
    addEventListener: (type: string, handler: (event: MessageEvent<WorkerRequest>) => void) => void;
  }
).addEventListener('message', (event: MessageEvent<WorkerRequest>) => {
  const request = event.data;
  if (request.type === 'init') {
    void beginBoot(request);
    return;
  }
  if (!bootComplete) {
    deferredRequests.push(request);
    return;
  }
  dispatch(request);
});

/** The protocol, in one place: everything except `init`, which boot owns. */
function dispatch(request: WorkerRequest): void {
  try {
    switch (request.type) {
      case 'load': {
        if (!state) return;
        loadProgram(state, request);
        break;
      }

      case 'resize': {
        if (!state) return;
        state.width = request.width;
        state.height = request.height;
        state.pixelRatio = request.pixelRatio;
        state.renderer.setPixelRatio(
          Math.min(
            request.pixelRatio,
            state.verdict?.decisions.maxPixelRatio ?? request.pixelRatio,
          ),
        );
        state.renderer.setSize(request.width, request.height, false);
        state.camera.aspect = request.width / Math.max(1, request.height);
        state.camera.updateProjectionMatrix();
        // A resize changes what every pixel shows; the frame that proves it must present.
        state.needsRender = true;
        break;
      }

      case 'setParameter': {
        if (!state?.builder) return;
        state.builder.setParameter(request.id, request.value);
        // A sleeping body must hear a parameter change (`02` R5).
        state.physics?.wakeAll();
        // The change is honoured by the next frame — which this request lands within, since the
        // rAF loop is already scheduled and a parameter's visible effect is measured against the
        // presented frame, not the message tick. The old synchronous extra frame here doubled the
        // worker's per-frame work for the whole drag; the invalidations below carry the same
        // promise (visible within a frame, `03` R4) at one frame's cost: the parameter record is
        // what the applicator reads, the render flag is what marks the frame worth presenting —
        // including while paused, where the guest still computes metrics and re-poses declared
        // parts from the new value (`00`: paused is not dead).
        state.paramsRecord = null;
        state.needsFrame = true;
        state.needsRender = true;
        break;
      }

      case 'setPaused': {
        if (!state) return;
        state.paused = request.paused;
        break;
      }

      case 'setTimeScale': {
        if (!state) return;
        applyTimeScale(state, request.scale);
        break;
      }

      case 'resetTime': {
        if (!state) return;
        state.elapsed = 0;
        // The wall clock restarts with the model: a scrub-to-start must not leave a paused glow
        // mid-breath.
        state.wallElapsed = 0;
        if (state.manifest) state.physics?.reset(state.manifest);
        state.needsRender = true;
        break;
      }

      case 'resetCamera': {
        if (!state) return;
        // `resetCameraToInitial` already invalidates the frame; keeping the learner at their current
        // pause state and parameter values is the point of Reset being a view command, not a reload.
        resetCameraToInitial(state);
        break;
      }

      case 'pointer': {
        if (!state) return;
        // Normalised device coordinates, which is what the raycaster expects.
        state.pointer.set((request.x / state.width) * 2 - 1, -(request.y / state.height) * 2 + 1);
        if (request.kind === 'move') {
          // Coalesced: the frame loop runs the cast once for however many moves arrived this frame.
          state.hoverPending = true;
        } else if (request.kind === 'down') {
          // A gesture cancels a camera move in flight: the camera never fights the learner.
          cancelCameraMove(state);
          state.pointersDown += 1;
          if (state.pointerPress) {
            // A second finger joined the press: this is a pinch, not a choice.
            state.pointerPress.pointers = state.pointersDown;
          } else {
            state.pointerPress = { x: request.x, y: request.y, pointers: 1 };
          }
          updateHover(state);
          state.selectedPart = state.hoveredPart;
          post({ type: 'selected', partId: state.selectedPart });
          // A selection stops the idle orbit: the learner is looking at something specific (`00`).
          if (state.selectedPart) state.autoRotate = false;
          // Selection feedback (the highlight, the info panel) is a presented-frame concern.
          state.needsRender = true;
        } else if (request.kind === 'up') {
          // A press that did not travel is a choice, and the camera travels to it. A press that
          // travelled is the learner steering, and the camera stays exactly where they put it.
          state.pointersDown = Math.max(0, state.pointersDown - 1);
          if (state.pointersDown > 0) break;
          const press = state.pointerPress;
          state.pointerPress = null;
          if (!press || !isTapRelease(press, request.x, request.y)) break;
          updateHover(state);
          const partId = state.hoveredPart;
          if (!partId || !state.model) break;
          // A part whose declared interaction replays a shot defines its own camera move; the
          // default select-and-frame glide yields to it and only covers the parts without one.
          if (playPartShots(state, partId)) {
            state.needsRender = true;
            break;
          }
          const object = state.model.parts.get(partId);
          if (!object) break;
          const pose = framingPose(state, object, 1.6);
          if (!pose) break;
          startGlide(state, pose, { object, margin: 1.6 });
        }
        break;
      }

      case 'orbit': {
        if (!state) return;
        state.autoRotate = false;
        // The learner is steering: a camera move in flight yields to them.
        cancelCameraMove(state);
        state.orbit.theta -= request.deltaX * 0.005;
        // Polar angle clamped so the camera never passes through the poles, where orbit control degenerates.
        const limits = state.manifest?.camera.limits;
        const minPhi = limits?.minPolarAngle ?? 0.08;
        const maxPhi = limits?.maxPolarAngle ?? Math.PI - 0.08;
        state.orbit.phi = Math.max(
          minPhi,
          Math.min(maxPhi, state.orbit.phi - request.deltaY * 0.005),
        );
        // Applied once per frame, in renderFrame — the gesture message rate (up to 120Hz) does not
        // need to fight the render tick for the worker's event loop.
        state.cameraDirty = true;
        break;
      }

      case 'zoom': {
        if (!state) return;
        state.autoRotate = false;
        // The learner is steering: a camera move in flight yields to them.
        cancelCameraMove(state);
        // Multiplicative zoom, so a scroll notch feels the same at every distance.
        const distance = clampDistance(
          state.orbit.distance * (1 + request.delta * 0.001),
          distanceLimits(state),
        );
        if (distance !== null) state.orbit.distance = distance;
        state.cameraDirty = true;
        break;
      }

      case 'pan': {
        if (!state) return;
        state.autoRotate = false;
        // The learner is steering: a camera move in flight yields to them.
        cancelCameraMove(state);
        // Pan in the camera's own plane, scaled by distance so the gesture tracks the cursor at any zoom.
        // `matrixWorld` (the composed world matrix), not `matrix` (its local one) — the camera is a
        // root object so they coincide today, and reading the wrong one is the kind of bug that
        // waits for a scene-graph parent to matter. The two vectors are module scratch.
        CAMERA_PAN_RIGHT.setFromMatrixColumn(state.camera.matrixWorld, 0);
        CAMERA_PAN_UP.setFromMatrixColumn(state.camera.matrixWorld, 1);
        const scale = state.orbit.distance * 0.001;
        state.orbit.target.addScaledVector(CAMERA_PAN_RIGHT, -request.deltaX * scale);
        state.orbit.target.addScaledVector(CAMERA_PAN_UP, request.deltaY * scale);
        state.cameraDirty = true;
        break;
      }

      case 'focusPart': {
        if (!state?.model) return;
        // A part id focuses that part; no id frames the whole model again.
        const object = request.partId ? state.model.parts.get(request.partId) : state.model.root;
        if (!object) return;
        const margin = request.partId ? 1.6 : 1.3;
        const pose = framingPose(state, object, margin);
        if (!pose) return;
        // The focus is passed along so the camera keeps aiming at the part while it travels: a
        // part that is moving is somewhere else by the time the camera gets there.
        startGlide(state, pose, { object, margin });
        break;
      }

      case 'playShot': {
        if (!state) return;
        // A declared shot from a story beat or an interaction, sent by the page (the single
        // owner of the beats' clocks). An honest skip — an unplayable kind, a missing part —
        // leaves the camera where it is; the audit flags those declarations upstream.
        playShot(state, request.shot);
        break;
      }

      case 'viewPreset': {
        if (!state) return;
        // Presets keep the current distance and target, so the framing holds while the angle moves.
        state.autoRotate = false;
        const presets = {
          front: [Math.PI / 2, Math.PI / 2],
          back: [-Math.PI / 2, Math.PI / 2],
          left: [Math.PI, Math.PI / 2],
          right: [0, Math.PI / 2],
          top: [0, 0.001],
          bottom: [Math.PI, 0.001],
          iso: [Math.PI / 4, Math.PI / 3],
        } as const;
        const pair = presets[request.preset] ?? presets.iso;
        const theta = pair[0];
        const phi = pair[1];
        const pose = currentPose(state);
        pose.theta = theta;
        pose.phi = phi;
        startGlide(state, pose);
        break;
      }

      case 'setViewMode': {
        if (!state) return;
        state.viewMode = request.mode;
        applyViewMode(state);
        // A mode change rewrites materials across the scene: a frame must present it.
        state.needsRender = true;
        break;
      }

      case 'setQuality': {
        if (!state) return;
        // The learner changed their mind: the pin applies from the next frame, and the warning is
        // re-armed so a *new* pin gets its own chance to be explained.
        state.pinnedQuality = request.quality;
        state.ladder.warnedAboutPin = false;
        state.needsRender = true;
        break;
      }

      case 'setTheme': {
        if (!state) return;
        applyTheme(state, request.theme);
        // The 3D backdrop follows the theme (`07`); the frame that shows it must be presented.
        state.needsRender = true;
        break;
      }

      case 'pickPoint': {
        // Answered even with no model loaded: the page is waiting on a promise, and silence would
        // leave it waiting forever. "Nothing there" is the truthful answer in that state.
        const hit = state ? pickPoint(state, request.x, request.y) : { point: null, partId: null };
        post({
          type: 'pickedPoint',
          requestId: request.requestId,
          point: hit.point,
          partId: hit.partId,
        });
        break;
      }

      case 'setAnnotations': {
        if (!state) return;
        state.annotations = request.pins;
        // One frame presents and republishes the positions. An empty list needs no frame at all, and
        // the projection path costs nothing from here on (`projectAnnotations` checks first).
        if (request.pins.length > 0) state.needsRender = true;
        break;
      }

      case 'startRecording': {
        if (!state) return;
        startRecording(state, request.maxSeconds ?? VIDEO_CLIP_LIMITS.maxSeconds);
        break;
      }

      case 'stopRecording': {
        if (!state) return;
        void finishRecording(state);
        break;
      }

      case 'snapshot': {
        if (!state) return;
        // Rendered on the learner's device and sent to the page as bytes; the server stores it without
        // rendering anything itself. This is the platform's only file operation on pixels.
        //
        // The drawing buffer is resized to the authored resolution, rendered, captured, and restored —
        // and the restore is checked, because a snapshot that left the canvas at 4K would cost every
        // later frame four times the fragments for the sake of one file.
        const { restore, width, height } = beginSnapshot(state, request.width, request.height);
        state.renderer.render(state.scene, state.camera);
        state.canvas
          .convertToBlob({ type: 'image/png' })
          .then((blob: Blob) => post({ type: 'snapshot', blob, width, height }))
          .catch(() =>
            post({ type: 'notice', message: 'Could not capture a snapshot on this device.' }),
          )
          .finally(() => {
            // `state` may have been torn down while the blob was being encoded; the renderer is gone
            // with it and must not be resized.
            if (!state) return;
            if (!endSnapshot(state, restore)) {
              post({
                type: 'notice',
                message: 'The view could not be restored after the export; reload the page.',
              });
            }
          });
        break;
      }

      case 'dispose': {
        disposeAll();
        break;
      }

      default: {
        // Exhaustiveness: an unhandled message type is a protocol drift, and silence would hide it.
        post({ type: 'notice', message: 'The viewer received an unrecognised instruction.' });
      }
    }
  } catch (error) {
    // A fault in the host half of the worker must not leave the page waiting forever.
    const described = describeFailure(error);
    post({ type: 'notice', message: described.message });
  }
}
