/**
 * The shot player — the four declared shot kinds the viewer can actually play.
 *
 * `00-GOAL.md` makes the shot vocabulary "a core capability, not a nice-to-have", and until now a
 * model could legally declare `kind: 'crane'`, validate, audit clean — and the camera never moved.
 * These tests pin the player that closes the honest half of that gap: `flyTo` (the existing glide,
 * resolved from a declared part), `cut` (the pose applied in one frame), `dolly` (a view-axis
 * distance change that never changes the angle) and `fovPull` (the projection pulled while the
 * position holds still). The five kinds with no player must be *refused* here, because the audit
 * flags them — a silent fake would break the audit's honesty contract.
 *
 * The worker module is imported in Node with its worker-globals stubbed, exactly as
 * `sandbox-worker-swap.test.ts` does; the state object is the test's own.
 */
import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import type * as SandboxModule from '@edu3d/sandbox';
import type { ShotDeclInput } from '@edu3d/contracts';
import type * as WorkerModule from './sandbox-worker.ts';
import { ViewEffects } from './view-effects.ts';

const posted: Array<Record<string, unknown>> = [];
// The worker module captures these worker-globals at import time, before anything else runs.
vi.stubGlobal('postMessage', (message: unknown) => {
  posted.push(message as Record<string, unknown>);
});
vi.stubGlobal('requestAnimationFrame', (_cb: (t: number) => void) => 0);
vi.stubGlobal('setInterval', () => 0);
vi.stubGlobal('addEventListener', () => undefined);

vi.mock('@edu3d/sandbox', async (importOriginal) => {
  const actual = await importOriginal<typeof SandboxModule>();
  return {
    ...actual,
    hardenRealm: () => ({ deleted: [], poisoned: [], frozen: [], resisted: [] }),
  };
});

/** The smallest guest that prices, realizes and gives the shot player a real part to frame. */
const GUEST = String.raw`
scene.describe({
  name: 'Shot Probe',
  description: 'The smallest model the shot-player test can realize: one wheel.',
  domain: 'mechanical-engineering',
  subdomain: 'kinematics',
  concept: 'A wheel exists so the camera has something to fly to.',
  objectives: ['See the wheel'],
  level: 'secondary',
  principles: ['A wheel is round'],
  simplifications: ['No physics'],
  relationships: [],
});
var material = mat.metal({ roughness: 0.3 });
var wheel = geom.revolve({
  profile: geom.profile([[0.05, -0.1], [0.4, -0.1], [0.4, 0.1], [0.05, 0.1]], true),
  segments: 16,
});
scene.mesh({ id: 'wheel', name: 'Wheel', geometry: wheel, material: material });
scene.camera({ position: [2, 1.5, 2.4], target: [0, 0, 0], fov: 42 });
`;

/** The same model, with an interaction whose click replays an fov pull. */
const INTERACTION_GUEST = `${GUEST}
scene.interaction({ partId: 'wheel', on: 'click', kind: 'playShot',
  shot: { kind: 'fovPull', fov: 30, duration: 0.5 } });
`;

/** A WorkerState the test owns, as far from "loaded" as the interface allows. */
/**
 * A partial worker state — only the fields a shot player touches. Cast once, here, rather than at
 * each of the twenty call sites: this is a test double, not a full worker, and pretending otherwise
 * would mean maintaining sixty fields that the player never reads.
 */
function makeFakeState(): WorkerModule.WorkerState {
  return {
    renderer: {
      setPixelRatio: () => undefined,
      render: () => undefined,
      shadowMap: { enabled: false },
    } as unknown as THREE.WebGLRenderer,
    scene: new THREE.Scene(),
    camera: new THREE.PerspectiveCamera(45, 4 / 3, 0.01, 2000),
    canvas: {} as OffscreenCanvas,
    tier: 'high',
    pixelRatio: 1,
    width: 800,
    height: 600,

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
    physicsMillis: 0,

    ladder: {
      applied: new Set(),
      pressureFrames: 0,
      headroomFrames: 0,
      basePixelRatio: 1,
      warnedAboutPin: false,
    },
    pinnedQuality: null,

    orbit: { theta: 1, phi: 1, distance: 5, target: new THREE.Vector3() },
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
  } as unknown as WorkerModule.WorkerState;
}

async function loadedState(code: string) {
  const worker = await import('./sandbox-worker.ts');
  const target = makeFakeState();
  worker.loadProgram(target as never, { type: 'load', code, seed: 1 });
  const loaded = posted.some((message) => message.type === 'loaded');
  expect(loaded, 'the test model must load before a shot can play').toBe(true);
  // The load itself must have set a real camera pose (42° fov from the guest's scene.camera).
  expect(target.camera.fov).toBeCloseTo(42, 6);
  return { worker, target: target as never as ReturnType<typeof makeFakeState> };
}

/** Step the player to completion on 60 Hz frames, like the render loop would. */
function settle(
  worker: typeof WorkerModule,
  target: ReturnType<typeof makeFakeState>,
  maxFrames = 400,
): void {
  for (let i = 0; i < maxFrames; i += 1) {
    if (!target.glide && !target.fovMove) return;
    worker.advanceShot(target, 1 / 60);
  }
}

/** The same model, with an authored opening pose that sits *outside* its own declared distance limits. */
const OUT_OF_LIMITS_GUEST = `${GUEST}
scene.camera({ position: [3, 2, 4], target: [0, 0, 0], fov: 42,
  limits: { minDistance: 1, maxDistance: 5 } });
`;

describe('returning the camera to the authored opening frame', () => {
  it('lands exactly on the authored pose after a shot move, and the rig stays there', async () => {
    const { worker, target } = await loadedState(GUEST);

    // Move the camera away from the opening frame the ordinary way.
    expect(worker.playShot(target, { kind: 'flyTo', targetPartId: 'wheel', duration: 0.4 })).toBe(
      true,
    );
    worker.advanceShot(target, 0.2);
    expect(target.glide).not.toBeNull();
    expect(target.orbit.distance).not.toBeCloseTo(Math.hypot(2, 1.5, 2.4), 6);

    // `03` R5 Reset: the camera half is the authored initial pose, and nothing else.
    expect(worker.resetCameraToInitial(target)).toBe(true);

    expect(target.orbit.target.x).toBeCloseTo(0, 9);
    expect(target.orbit.target.y).toBeCloseTo(0, 9);
    expect(target.orbit.target.z).toBeCloseTo(0, 9);
    expect(target.orbit.distance).toBeCloseTo(Math.hypot(2, 1.5, 2.4), 9);
    expect(target.camera.fov).toBeCloseTo(42, 9);
    expect(target.camera.position.x).toBeCloseTo(2, 6);
    expect(target.camera.position.y).toBeCloseTo(1.5, 6);
    expect(target.camera.position.z).toBeCloseTo(2.4, 6);

    // The cancelled move leaves nothing behind that could carry the camera back off the pose.
    expect(target.glide).toBeNull();
    expect(target.fovMove).toBeNull();
    expect(target.glideFocus).toBeNull();

    // And it genuinely stops: further shot ticks move nothing.
    for (let index = 0; index < 60; index += 1) worker.advanceShot(target, 1 / 60);
    expect(target.orbit.distance).toBeCloseTo(Math.hypot(2, 1.5, 2.4), 9);
    expect(target.camera.position.x).toBeCloseTo(2, 6);
    expect(target.camera.position.y).toBeCloseTo(1.5, 6);
    expect(target.camera.position.z).toBeCloseTo(2.4, 6);
  });

  it('cancels a fov pull as well, restoring the authored zoom', async () => {
    const { worker, target } = await loadedState(GUEST);
    expect(worker.playShot(target, { kind: 'fovPull', fov: 30, duration: 1 })).toBe(true);
    worker.advanceShot(target, 0.5);
    expect(target.camera.fov).toBeLessThan(42);

    worker.resetCameraToInitial(target);

    expect(target.camera.fov).toBeCloseTo(42, 9);
    expect(target.fovMove).toBeNull();
    for (let index = 0; index < 60; index += 1) worker.advanceShot(target, 1 / 60);
    expect(target.camera.fov).toBeCloseTo(42, 9);
  });

  it('brings an authored pose that violates its own limits inside them, direction preserved', async () => {
    const { worker, target } = await loadedState(OUT_OF_LIMITS_GUEST);

    // |(3, 2, 4)| = √29 ≈ 5.39, past the declared maxDistance of 5.
    worker.resetCameraToInitial(target);

    expect(target.orbit.distance).toBeCloseTo(5, 9);
    // Clamped along the same sight line, not snapped somewhere else.
    expect(target.camera.position.x / target.camera.position.z).toBeCloseTo(3 / 4, 6);
    expect(target.camera.position.y).toBeGreaterThan(0);
  });
});

describe('the shot player', () => {
  it('plays flyTo as a real glide that settles on the declared part', async () => {
    const { worker, target } = await loadedState(GUEST);
    const startDistance = target.orbit.distance;
    const startTheta = target.orbit.theta;
    const startPhi = target.orbit.phi;

    // RED today: nothing reads a ShotDecl, so there is no player at all.
    const started = worker.playShot(target, {
      kind: 'flyTo',
      targetPartId: 'wheel',
      duration: 0.5,
    } satisfies ShotDeclInput);
    expect(started, 'a flyTo shot at a real part must start').toBe(true);
    expect(target.glide).not.toBeNull();

    // Mid-flight the camera is genuinely between poses.
    worker.advanceShot(target, 0.25);
    const midDistance = target.orbit.distance;
    expect(midDistance).not.toBeCloseTo(startDistance, 6);

    settle(worker, target);
    expect(target.glide).toBeNull();
    // Arrived: closer than it started (a fitted framing of a ~0.4-unit wheel from 5 units back),
    // and it approached along the view it already had — angles untouched by the resolution.
    expect(target.orbit.distance).not.toBeCloseTo(startDistance, 3);
    expect(target.orbit.theta).toBeCloseTo(startTheta, 6);
    expect(target.orbit.phi).toBeCloseTo(startPhi, 6);
  });

  it('applies a cut in one frame, with none of the interpolation', async () => {
    const { worker, target } = await loadedState(GUEST);
    const ok = worker.playShot(target, {
      kind: 'cut',
      pose: { position: [1, 2, 3], target: [0, 0, 0] },
    } satisfies ShotDeclInput);
    expect(ok).toBe(true);
    expect(target.glide).toBeNull();
    // Zero seconds of travel, full arrival: the distance is |pos − target| ≈ 3.742.
    worker.advanceShot(target, 0);
    expect(target.orbit.distance).toBeCloseTo(Math.sqrt(14), 3);
    // The pose's fov, when authored, applies in the same frame.
    const withFov = worker.playShot(target, {
      kind: 'cut',
      pose: { position: [1, 2, 3], target: [0, 0, 0], fov: 55 },
    } satisfies ShotDeclInput);
    expect(withFov).toBe(true);
    expect(target.camera.fov).toBeCloseTo(55, 6);
  });

  it('dollys along the view axis and honours the shot easing', async () => {
    const { worker, target } = await loadedState(GUEST);
    const startDistance = target.orbit.distance;
    const startTheta = target.orbit.theta;

    const ok = worker.playShot(target, {
      kind: 'dolly',
      distance: -1,
      duration: 1,
      easing: 'linear',
    } satisfies ShotDeclInput);
    expect(ok).toBe(true);

    // Linear over 1 s: halfway through, exactly halfway along the axis. Stepped in frame-sized
    // ticks, as the loop delivers them (advanceShot clamps a single tick to the frame delta cap).
    for (let i = 0; i < 5; i += 1) worker.advanceShot(target, 0.1);
    expect(target.orbit.distance).toBeCloseTo(startDistance - 0.5, 6);
    expect(target.orbit.theta).toBeCloseTo(startTheta, 6);

    settle(worker, target);
    expect(target.orbit.distance).toBeCloseTo(startDistance - 1, 6);
  });

  it('pulls fov with the position untouched', async () => {
    const { worker, target } = await loadedState(GUEST);
    const before = {
      theta: target.orbit.theta,
      phi: target.orbit.phi,
      distance: target.orbit.distance,
    };

    const ok = worker.playShot(target, {
      kind: 'fovPull',
      fov: 30,
      duration: 1,
    } satisfies ShotDeclInput);
    expect(ok).toBe(true);

    worker.advanceShot(target, 0.5);
    const midFov = target.camera.fov;
    expect(midFov).toBeLessThan(42);
    expect(midFov).toBeGreaterThan(30);

    settle(worker, target);
    expect(target.camera.fov).toBeCloseTo(30, 6);
    // The point of a focus pull: only the projection changes, the framing never moves.
    expect(target.orbit.theta).toBeCloseTo(before.theta, 9);
    expect(target.orbit.phi).toBeCloseTo(before.phi, 9);
    expect(target.orbit.distance).toBeCloseTo(before.distance, 9);
  });

  it('refuses a kind with no player instead of faking it', async () => {
    const { worker, target } = await loadedState(GUEST);
    expect(worker.playShot(target, { kind: 'crane', distance: 2 } satisfies ShotDeclInput)).toBe(
      false,
    );
    expect(worker.playShot(target, { kind: 'orbit', sweep: 1 } satisfies ShotDeclInput)).toBe(
      false,
    );
    expect(target.glide).toBeNull();
    expect(target.fovMove).toBeNull();
  });

  it('skips honestly when the shot names a part that does not exist', async () => {
    const { worker, target } = await loadedState(GUEST);
    const ok = worker.playShot(target, {
      kind: 'flyTo',
      targetPartId: 'ghost',
      duration: 0.5,
    } satisfies ShotDeclInput);
    expect(ok, '05: a missing target skips the move, it does not fake one').toBe(false);
    expect(target.glide).toBeNull();
  });

  it('yields the move the moment the learner steers', async () => {
    const { worker, target } = await loadedState(GUEST);
    worker.playShot(target, { kind: 'flyTo', targetPartId: 'wheel' } satisfies ShotDeclInput);
    expect(target.glide).not.toBeNull();
    worker.cancelCameraMove(target);
    expect(target.glide).toBeNull();
    expect(target.fovMove).toBeNull();
  });

  it('never fights the rig: a flyTo past the limits clamps into it', async () => {
    const { worker, target } = await loadedState(GUEST);
    const ok = worker.playShot(target, { kind: 'dolly', distance: 900 } satisfies ShotDeclInput);
    expect(ok).toBe(true);
    // The manifest declares no limits here, so the rig's floor/ceiling (0.1 … 500) applies at
    // step time; landing outside them would leave the camera somewhere the rig refuses to be.
    settle(worker, target);
    expect(target.orbit.distance).toBeLessThanOrEqual(500);
  });

  it('plays an interaction declared as playShot on click', async () => {
    const { worker, target } = await loadedState(INTERACTION_GUEST);
    const ok = worker.playPartShots(target, 'wheel');
    expect(ok, 'a click playShot interaction must start from the declared shot').toBe(true);
    settle(worker, target);
    expect(target.camera.fov).toBeCloseTo(30, 6);
  });

  it('does not play an interaction for a part without one', async () => {
    const { worker, target } = await loadedState(INTERACTION_GUEST);
    expect(worker.playPartShots(target, 'no-such-part')).toBe(false);
    expect(worker.playPartShots(target, 'unrelated')).toBe(false);
  });
});
