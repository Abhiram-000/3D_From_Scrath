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
  type ShotEasing,
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

/** Messages the page sends into the worker. */
export type WorkerRequest =
  | {
      type: 'init';
      canvas: OffscreenCanvas;
      width: number;
      height: number;
      pixelRatio: number;
      tier: DeviceTier;
      theme: { top: string; bottom: string };
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
  | { type: 'focusPart'; partId: string | null }
  | { type: 'playShot'; shot: ShotDecl }
  | { type: 'viewPreset'; preset: 'front' | 'back' | 'left' | 'right' | 'top' | 'bottom' | 'iso' }
  | { type: 'setViewMode'; mode: 'normal' | 'xray' | 'wireframe' | 'explode' }
  | { type: 'setTheme'; theme: { top: string; bottom: string } }
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
  | { type: 'snapshot'; blob: Blob }
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

/** Everything the worker owns between loads. */
interface WorkerState {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  canvas: OffscreenCanvas;
  tier: DeviceTier;
  pixelRatio: number;
  width: number;
  height: number;

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

/** Apply the scene backdrop from theme tokens, so the canvas follows the page rather than fighting it. */
function applyTheme(target: WorkerState, theme: { top: string; bottom: string }): void {
  const top = new THREE.Color().setStyle(theme.top, THREE.SRGBColorSpace);
  target.scene.background = top;
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

/** The rig's own limits, so a camera move can never end somewhere the rig refuses to be. */
function glideLimits(target: WorkerState): GlideLimits {
  const limits = target.manifest?.camera.limits;
  return {
    minPhi: limits?.minPolarAngle ?? 0.08,
    maxPhi: limits?.maxPolarAngle ?? Math.PI - 0.08,
    minDistance: limits?.minDistance ?? 0.1,
    maxDistance: limits?.maxDistance ?? 500,
  };
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
  shot: ShotDecl,
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
export function playShot(target: WorkerState, shot: ShotDecl): boolean {
  if (!target.manifest) return false;
  if (!PLAYABLE_SHOT_KINDS.has(shot.kind)) return false;
  const duration = shot.duration ?? SHOT_DEFAULT_DURATION;

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
      startGlide(target, destination.pose, destination.focus ?? undefined, duration, shot.easing);
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
        shot.easing,
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
        easing: shot.easing,
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
    PhysicsWorld.create(manifest, target.tier)
      .then((world) => {
        // A newer load may have replaced the model while the WASM was loading.
        if (target.builder === builder && world) target.physics = world;
        else if (world) world.dispose();
        if (!world && target.builder === builder) {
          target.simFailed = true;
          post({
            type: 'notice',
            message:
              'Physics simulation is unavailable on this device; the model animates instead.',
          });
        }
      })
      .catch(() => {
        if (target.builder === builder) target.simFailed = true;
      });
  }

  // Apply the authored opening frame. `00`: "every model opens with the full concept in view."
  const pose = manifest.camera.initial;
  applyFov(target, pose.fov);
  target.orbit.target.set(...pose.target);
  const offset = new THREE.Vector3(...pose.position).sub(target.orbit.target);
  target.orbit.distance = Math.max(0.1, offset.length());
  target.orbit.theta = Math.atan2(offset.x, offset.z);
  target.orbit.phi = Math.acos(Math.max(-1, Math.min(1, offset.y / target.orbit.distance)));
  target.autoRotate = manifest.camera.limits.autoRotate;
  updateCamera(target);

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

/** Apply a view mode across the model. */
/** How translucent x-ray makes a part. Named so the ladder, the tests and the viewer share one value. */
const XRAY_OPACITY = 0.35;

/**
 * Each material's authored transparency, captured on x-ray entry so leaving restores the model's
 * own material rather than forcing it opaque. Weak, so a disposed material stays collectable.
 */
const XRAY_ORIGINALS = new WeakMap<THREE.Material, { transparent: boolean; opacity: number }>();

function applyViewMode(target: WorkerState): void {
  const model = target.model;
  if (!model) return;

  const explodeScale = target.viewMode === 'explode' ? 1 : 0;
  const center = new THREE.Vector3();
  new THREE.Box3().setFromObject(model.root).getCenter(center);

  model.root.traverse((object: THREE.Object3D) => {
    if (!(object instanceof THREE.Mesh) && !(object instanceof THREE.InstancedMesh)) return;
    const material = object.material as THREE.Material & {
      wireframe?: boolean;
      opacity?: number;
      transparent?: boolean;
    };

    // Shared materials mean a mode change touches every part using them, which is exactly the intent: x-ray is a
    // scene-wide state, not a per-part one.
    if (target.viewMode === 'wireframe') {
      if ('wireframe' in material) material.wireframe = true;
    } else if ('wireframe' in material) {
      material.wireframe = false;
    }

    if (target.viewMode === 'xray') {
      // Captured on entry, not recomputed on exit: a glass or fluid part is legitimately
      // translucent, and restoring to "opaque" would silently rewrite the model's own material.
      // Without this capture, leaving x-ray left every material permanently transparent — the
      // model stayed ghostly AND lost early-Z, which costs every device a permanent multiple of
      // its fragment work for the rest of the session.
      if (!XRAY_ORIGINALS.has(material)) {
        XRAY_ORIGINALS.set(material, {
          transparent: material.transparent,
          opacity: material.opacity,
        });
      }
      material.transparent = true;
      material.opacity = XRAY_OPACITY;
      material.depthWrite = false;
    } else {
      const original = XRAY_ORIGINALS.get(material);
      if (original) {
        material.transparent = original.transparent;
        material.opacity = original.opacity;
        XRAY_ORIGINALS.delete(material);
      }
      material.depthWrite = true;
    }
  });

  if (explodeScale > 0) {
    // Explode offsets are derived from each part's direction away from the model centre when the model did not
    // author one, so a model that never thought about exploding still explodes sensibly (`00`).
    for (const [partId, object] of model.parts) {
      const node = target.manifest?.parts.find((part) => part.id === partId);
      const direction = node?.explodeOffset
        ? new THREE.Vector3(...node.explodeOffset)
        : object.position.clone().sub(center).normalize();
      object.userData.explodeBase ??= object.position.clone();
      object.position.copy(
        (object.userData.explodeBase as THREE.Vector3).clone().add(direction.multiplyScalar(0.35)),
      );
    }
  } else {
    for (const object of model.parts.values()) {
      const base = object.userData.explodeBase as THREE.Vector3 | undefined;
      if (base) object.position.copy(base);
    }
  }
}

/** Raycast against the model and report what the pointer is over. */
function updateHover(target: WorkerState): boolean {
  const model = target.model;
  if (!model) return false;

  target.raycaster.setFromCamera(target.pointer, target.camera);
  const hits = target.raycaster.intersectObject(model.root, true);

  let partId: string | null = null;
  for (const hit of hits) {
    // Walk up to the nearest ancestor that declares itself selectable, so a click on a sub-mesh still resolves to
    // the part the learner thinks they clicked.
    let current: THREE.Object3D | null = hit.object;
    while (current) {
      if (current.userData.selectable && typeof current.userData.partId === 'string') {
        partId = current.userData.partId as string;
        break;
      }
      current = current.parent;
    }
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
    if (!CONTEXT_LOST) target.renderer.render(target.scene, target.camera);

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

/** Release everything the worker owns. Idempotent and tolerant of partial prior failures (`02` R7). */
function disposeAll(): void {
  if (!state) return;
  if (state.model) {
    state.scene.remove(state.model.root);
    state.model.dispose();
  }
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

  try {
    switch (request.type) {
      case 'init': {
        state = initRenderer(request);
        post({ type: 'ready' });
        scheduleFrame(loop);
        startHeartbeat();
        break;
      }

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
        state.timeScale = Math.max(0.05, Math.min(4, request.scale));
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
        const limits = state.manifest?.camera.limits;
        const min = limits?.minDistance ?? 0.1;
        const max = limits?.maxDistance ?? 500;
        // Multiplicative zoom, so a scroll notch feels the same at every distance.
        state.orbit.distance = Math.max(
          min,
          Math.min(max, state.orbit.distance * (1 + request.delta * 0.001)),
        );
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

      case 'snapshot': {
        if (!state) return;
        // Rendered on the learner's device and sent to the page as bytes; the server stores it without rendering
        // anything itself. This is the platform's only server-side pixel operation, and it is a file write.
        state.renderer.render(state.scene, state.camera);
        state.canvas
          .convertToBlob({ type: 'image/png' })
          .then((blob: Blob) => post({ type: 'snapshot', blob }))
          .catch(() =>
            post({ type: 'notice', message: 'Could not capture a snapshot on this device.' }),
          );
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
});
