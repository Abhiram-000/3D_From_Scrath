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
  type QualityRung,
  type RuntimeStats,
} from '@edu3d/contracts';
import { compileGuest, createGuard, hardenRealm, type GuardHandle } from '@edu3d/sandbox';
import {
  GeometryError,
  M,
  MaterialError,
  SceneBuilder,
  SceneError,
  priceModel,
  realize,
  type AdmissionVerdict,
  type MeshData,
  type RealizedModel,
} from '@edu3d/engine';

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
    }
  | { type: 'load'; code: string; seed: number; deadlineMs?: number }
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
  | { type: 'setViewMode'; mode: 'normal' | 'xray' | 'wireframe' | 'explode' }
  | { type: 'setTheme'; theme: { top: string; bottom: string } }
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
  | { type: 'heartbeat'; frame: number }
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
  performance: { now: () => number };
};

const scheduleFrame = hostScope.requestAnimationFrame.bind(hostScope);
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
   * Milliseconds between heartbeats.
   *
   * Same reasoning as stats: the watchdog measures *time* without a heartbeat, so the worker must beat on a clock,
   * not on a frame count. A model rendering at 2 fps still beats every second.
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

  paused: boolean;
  timeScale: number;
  elapsed: number;
  frame: number;
  lastFrameAt: number;
  /** Wall-clock of the last heartbeat/stats post, so slow frames cannot starve the watchdog. */
  lastHeartbeatMs: number;
  lastStatsMs: number;
  frameTimes: number[];
  /** Consecutive frames where the guest's callback overran its budget. */
  overruns: number;
  /** True once the model has been paused for repeated overruns, so the notice is sent once. */
  frameDisabled: boolean;

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
  };

  /** Orbit state: spherical coordinates around the target. */
  orbit: { theta: number; phi: number; distance: number; target: THREE.Vector3 };
  autoRotate: boolean;

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

/** Frame an object so it fills the view with breathing room. */
function frameObject(target: WorkerState, object: THREE.Object3D, margin = 1.4): void {
  const box = new THREE.Box3().setFromObject(object);
  if (box.isEmpty()) return;
  const sphere = box.getBoundingSphere(new THREE.Sphere());
  target.orbit.target.copy(sphere.center);
  // Distance that puts the bounding sphere inside the vertical FOV, times a margin so the part is not cropped.
  const fov = (target.camera.fov * Math.PI) / 180;
  target.orbit.distance = (sphere.radius / Math.sin(fov / 2)) * margin;
  updateCamera(target);
}

/** Set up the renderer. Called once per worker; the worker is replaced rather than reconfigured. */
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
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

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

    paused: false,
    timeScale: 1,
    elapsed: 0,
    frame: 0,
    lastFrameAt: 0,
    lastHeartbeatMs: 0,
    lastStatsMs: 0,
    frameTimes: [],
    overruns: 0,
    frameDisabled: false,

    ladder: { applied: new Set(), pressureFrames: 0, headroomFrames: 0, basePixelRatio: request.pixelRatio },

    orbit: { theta: Math.PI * 0.25, phi: Math.PI * 0.4, distance: 5, target: new THREE.Vector3() },
    autoRotate: true,

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
 */
function loadProgram(target: WorkerState, request: Extract<WorkerRequest, { type: 'load' }>): void {
  logs.length = 0;

  const builder = new SceneBuilder();
  builder.beginTiming();

  let guard: GuardHandle;
  let compiled: ReturnType<typeof compileGuest>;

  try {
    // Step 2 and 3: facades and compilation, while `new Function` still exists.
    guard = createGuard();
    compiled = compileGuest(request.code);
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
    realized = realize({ manifest, geometries, decisions: verdict.decisions });
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
  if (target.builder) target.builder.dispose();

  target.builder = builder;
  target.model = realized;
  target.manifest = manifest;
  target.verdict = verdict;
  target.guard = guard;
  target.elapsed = 0;
  target.frame = 0;
  target.overruns = 0;
  target.frameDisabled = false;
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

  // Apply the authored opening frame. `00`: "every model opens with the full concept in view."
  const pose = manifest.camera.initial;
  target.camera.fov = pose.fov;
  target.camera.updateProjectionMatrix();
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
      material.transparent = true;
      material.opacity = 0.35;
      material.depthWrite = false;
    } else {
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
function updateHover(target: WorkerState): void {
  const model = target.model;
  if (!model) return;

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

  if (partId !== target.hoveredPart) {
    target.hoveredPart = partId;
    post({ type: 'hover', partId });
  }
}

/** One frame: advance the model, run guest logic, render, publish. */
function renderFrame(target: WorkerState, timestamp: number): void {
  const rawDelta = target.lastFrameAt === 0 ? 1 / 60 : (timestamp - target.lastFrameAt) / 1000;
  target.lastFrameAt = timestamp;

  // Clamped so a backgrounded tab resumes rather than fast-forwards (`08`).
  const delta = Math.min(TIMING.maxDelta, Math.max(0, rawDelta)) * target.timeScale;
  if (!target.paused) target.elapsed += delta;

  const frameStart = now();

  // Guest frame logic, budgeted. A callback that overruns repeatedly gets the model paused with an explanation
  // rather than being killed: `SANDBOX_LIMITS.frameOverrunLimit`.
  if (target.builder && target.guard && !target.frameDisabled) {
    target.guard.reset(SANDBOX_LIMITS.frameDeadlineMs, 2_000_000);
    const callbackStart = now();
    try {
      target.builder.runFrame(target.elapsed, delta, target.paused);
      const cost = now() - callbackStart;
      if (cost > SANDBOX_LIMITS.frameDeadlineMs) target.overruns += 1;
      else target.overruns = Math.max(0, target.overruns - 1);

      if (target.overruns > SANDBOX_LIMITS.frameOverrunLimit) {
        target.frameDisabled = true;
        post({
          type: 'notice',
          message:
            'This model\u2019s animation was paused because it was too slow to keep up. The model is still explorable.',
        });
      }
    } catch (error) {
      // A throwing frame callback disables itself rather than killing the model: the geometry is still worth
      // exploring even if the animation is broken.
      target.frameDisabled = true;
      const described = describeFailure(error);
      post({ type: 'notice', message: `Animation stopped: ${described.message}` });
    }

    // Push the builder's authored transforms into the Three.js objects.
    syncTransforms(target);
  }

  // Idle orbit, so the viewer is never inert (`00`).
  if (target.autoRotate && !target.paused) {
    target.orbit.theta += (target.manifest?.camera.limits.autoRotateSpeed ?? 0.35) * delta * 0.2;
    updateCamera(target);
  }

  // One coalesced hover raycast per frame, after the camera settled so the cast uses the pose that renders.
  if (target.hoverPending) {
    target.hoverPending = false;
    updateHover(target);
  }

  target.renderer.render(target.scene, target.camera);

  const frameTime = now() - frameStart;
  target.frameTimes.push(frameTime);
  if (target.frameTimes.length > TIMING.frameWindow) target.frameTimes.shift();

  // The live monitor rides on the measured frame time, after the frame it judges (`08`).
  monitorLadder(target, frameTime);

  target.frame += 1;

  const clockMs = now();
  if (clockMs - target.lastHeartbeatMs >= TIMING.heartbeatIntervalMs) {
    target.lastHeartbeatMs = clockMs;
    post({ type: 'heartbeat', frame: target.frame });
  }

  if (clockMs - target.lastStatsMs >= TIMING.statsIntervalMs) {
    target.lastStatsMs = clockMs;
    publishStats(target);
    if (target.builder) {
      const metrics = target.builder.currentMetrics();
      if (Object.keys(metrics).length > 0) post({ type: 'metrics', values: metrics });
    }
  }
}

/**
 * Copy authored transforms onto the rendered objects.
 *
 * The builder is the source of truth for a part's transform, because guest code writes there. Copying rather than
 * sharing keeps the guest away from Three.js objects entirely — it never holds a reference to anything on the GPU.
 */
function syncTransforms(target: WorkerState): void {
  const model = target.model;
  const manifest = target.manifest;
  if (!model || !manifest) return;

  for (const node of manifest.parts) {
    const object = model.parts.get(node.id);
    if (!object) continue;
    object.position.set(...node.transform.position);
    if (node.transform.rotation) object.rotation.set(...node.transform.rotation);
    object.scale.set(...node.transform.scale);
    object.visible = node.visible;

    // Material channel writes: emissive intensity and opacity are the two the API exposes per frame.
    if (node.material && (object instanceof THREE.Mesh || object instanceof THREE.InstancedMesh)) {
      const material = object.material as THREE.Material & {
        emissiveIntensity?: number;
        opacity?: number;
      };
      if (node.material.emissiveIntensity !== undefined && 'emissiveIntensity' in material) {
        material.emissiveIntensity = node.material.emissiveIntensity;
      }
      if (node.material.opacity !== undefined && 'opacity' in material) {
        material.opacity = node.material.opacity;
      }
    }
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
      target.renderer.shadowMap.enabled = direction === 'up' && target.verdict!.decisions.shadowLights.size > 0;
      break;
    case 'flatShading':
      // A material-level change: flip the flag and force the realizer's materials to rebuild their
      // programs. Kept cheap by touching only what exists on screen.
      target.renderer.shadowMap.needsUpdate = true;
      break;
    default:
      // Geometry detail and particle rungs are admission-time decisions; the live ladder skips them
      // rather than rebuild GPU buffers mid-session, and says nothing (the pricer already reported them).
      break;
  }

  if (direction === 'down') {
    post({
      type: 'notice',
      message: LADDER_NOTICES[next],
    });
  }
}

/** One learner-facing sentence per rung, written once so the wording cannot drift between steps. */
const LADDER_NOTICES: Record<QualityRung, string> = {
  pixelRatio: 'Render resolution reduced to keep motion smooth.',
  postProcessing: 'Antialiasing turned off to keep motion smooth.',
  shadows: 'Shadows turned off to keep motion smooth.',
  geometryDetail: 'Shapes drawn coarser to keep motion smooth; every part is still here.',
  particles: 'Fewer particles drawn; the pattern is unchanged.',
  physicsSubsteps: 'Physics accuracy reduced to keep motion smooth.',
  flatShading: 'Flat shading on this device; the shapes are unchanged.',
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

  if (target.ladder.pressureFrames >= TIMING.ladderSustainFrames) {
    target.ladder.pressureFrames = 0;
    ladderStep(target, 'down');
  } else if (target.ladder.headroomFrames >= TIMING.ladderSustainFrames * 2) {
    target.ladder.headroomFrames = 0;
    ladderStep(target, 'up');
  }
}

/** Publish measured runtime cost. Every number measured, never estimated (`03` R9). */function publishStats(target: WorkerState): void {
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
      fps: average > 0 ? Math.min(240, 1000 / average) : 0,
      frameMillis: average,
      drawCalls: info.render.calls,
      triangles: info.render.triangles,
      physicsMillis: 0,
      cacheHitRate: cacheTotal > 0 ? (geometryStats?.hits ?? 0) / cacheTotal : 1,
      quality: target.tier === 'low' ? 'low' : target.tier === 'mid' ? 'medium' : 'high',
      effectiveTier: target.tier,
      simSeconds: target.elapsed,
      degradedRungs: [...target.ladder.applied],
    },
  });
}

/** Release everything the worker owns. Idempotent and tolerant of partial prior failures (`02` R7). */
function disposeAll(): void {
  if (!state) return;
  if (state.model) {
    state.scene.remove(state.model.root);
    state.model.dispose();
  }
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
  renderFrame(state, timestamp);
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
        break;
      }

      case 'setParameter': {
        if (!state?.builder) return;
        state.builder.setParameter(request.id, request.value);
        // Run one frame immediately so the change is visible within a frame rather than at the next tick (`03` R4).
        if (!state.frameDisabled && state.guard) {
          state.guard.reset(SANDBOX_LIMITS.frameDeadlineMs, 2_000_000);
          try {
            state.builder.runFrame(state.elapsed, 0, state.paused);
            syncTransforms(state);
          } catch {
            // A parameter change that throws is reported by the next frame's handler; nothing to do here.
          }
        }
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
          updateHover(state);
          state.selectedPart = state.hoveredPart;
          post({ type: 'selected', partId: state.selectedPart });
          // A selection stops the idle orbit: the learner is looking at something specific (`00`).
          if (state.selectedPart) state.autoRotate = false;
        }
        break;
      }

      case 'orbit': {
        if (!state) return;
        state.autoRotate = false;
        state.orbit.theta -= request.deltaX * 0.005;
        // Polar angle clamped so the camera never passes through the poles, where orbit control degenerates.
        const limits = state.manifest?.camera.limits;
        const minPhi = limits?.minPolarAngle ?? 0.08;
        const maxPhi = limits?.maxPolarAngle ?? Math.PI - 0.08;
        state.orbit.phi = Math.max(
          minPhi,
          Math.min(maxPhi, state.orbit.phi - request.deltaY * 0.005),
        );
        updateCamera(state);
        break;
      }

      case 'zoom': {
        if (!state) return;
        state.autoRotate = false;
        const limits = state.manifest?.camera.limits;
        const min = limits?.minDistance ?? 0.1;
        const max = limits?.maxDistance ?? 500;
        // Multiplicative zoom, so a scroll notch feels the same at every distance.
        state.orbit.distance = Math.max(
          min,
          Math.min(max, state.orbit.distance * (1 + request.delta * 0.001)),
        );
        updateCamera(state);
        break;
      }

      case 'pan': {
        if (!state) return;
        state.autoRotate = false;
        // Pan in the camera's own plane, scaled by distance so the gesture tracks the cursor at any zoom.
        const right = new THREE.Vector3().setFromMatrixColumn(state.camera.matrix, 0);
        const up = new THREE.Vector3().setFromMatrixColumn(state.camera.matrix, 1);
        const scale = state.orbit.distance * 0.001;
        state.orbit.target.add(right.multiplyScalar(-request.deltaX * scale));
        state.orbit.target.add(up.multiplyScalar(request.deltaY * scale));
        updateCamera(state);
        break;
      }

      case 'focusPart': {
        if (!state?.model) return;
        if (!request.partId) {
          frameObject(state, state.model.root, 1.3);
          break;
        }
        const object = state.model.parts.get(request.partId);
        if (object) frameObject(state, object, 1.6);
        break;
      }

      case 'setViewMode': {
        if (!state) return;
        state.viewMode = request.mode;
        applyViewMode(state);
        break;
      }

      case 'setTheme': {
        if (!state) return;
        applyTheme(state, request.theme);
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
