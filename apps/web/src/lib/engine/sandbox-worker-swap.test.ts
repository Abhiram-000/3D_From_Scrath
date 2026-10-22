/**
 * The model-swap contract, driven through the real `loadProgram` pipeline.
 *
 * The audit scenario this file pins: model A has a `speed` parameter; the learner drags it to 5;
 * a second model is generated that also declares `speed` with default 1 — and the second model
 * animated at 5 while its own slider showed 1, because the numeric record the motion applicator
 * resolves against (`state.paramsRecord`, null-able, rebuilt lazily from the *current* builder)
 * survived the swap with model A's values still in it. Ids that do not exist in the new model
 * survived the same way.
 *
 * The sandbox-worker module is imported in Node with its worker-globals stubbed, so
 * `loadProgram` runs the real gate → compile → author → price → realize path against a state
 * object the test owns. `hardenRealm` is neutralized — hardening the *vitest* realm would destroy
 * the test runner itself; the security sequence around it is unchanged.
 */
import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import type * as SandboxModule from '@edu3d/sandbox';
import { ViewEffects } from './view-effects.ts';

const posted: Array<Record<string, unknown>> = [];
// The worker module captures these worker-globals at import time, before anything else runs.
vi.stubGlobal('postMessage', (message: unknown) => {
  posted.push(message as Record<string, unknown>);
});
vi.stubGlobal('requestAnimationFrame', (_cb: (t: number) => void) => 0);
// The worker also captures the heartbeat scheduler at import; a no-op keeps no timer alive in the
// test process (the heartbeat itself is never exercised here).
vi.stubGlobal('setInterval', () => 0);
// The module registers its message handler on the worker's global at import time; a no-op keeps
// that registration harmless in the test realm (the handler itself is never driven here).
vi.stubGlobal('addEventListener', () => undefined);

vi.mock('@edu3d/sandbox', async (importOriginal) => {
  const actual = await importOriginal<typeof SandboxModule>();
  return {
    ...actual,
    // A no-op: hardening the vitest realm would poison Function, freeze intrinsics and delete
    // the globals the runner needs. It is orthogonal to the swap behaviour under test.
    hardenRealm: () => ({ deleted: [], poisoned: [], frozen: [], resisted: [] }),
  };
});

/** The smallest guest that prices, realizes and declares a `speed` parameter. */
const GUEST = String.raw`
scene.describe({
  name: 'Swap Probe',
  description: 'The smallest model the swap test can realize: one wheel with one rate.',
  domain: 'mechanical-engineering',
  subdomain: 'kinematics',
  concept: 'A wheel spins at the rate its parameter names.',
  objectives: ['See the wheel spin'],
  level: 'secondary',
  principles: ['A spinning wheel turns at its declared rate'],
  simplifications: ['No physics'],
  relationships: [],
});
scene.colorRole({ id: 'steel', label: 'Steel', color: '#b9bec4', meaning: 'The wheel' });
var material = mat.metal({ role: 'steel', roughness: 0.3 });
var wheel = geom.revolve({
  profile: geom.profile([[0.05, -0.1], [0.4, -0.1], [0.4, 0.1], [0.05, 0.1]], true),
  segments: 16,
});
scene.mesh({ id: 'wheel', name: 'Wheel', geometry: wheel, material: material });
scene.param({
  id: 'speed',
  kind: 'number',
  label: 'Speed',
  unit: 'rpm',
  min: 0,
  max: 10,
  default: 1,
  precision: 1,
  description: 'How fast the wheel spins.',
  affects: [{ channel: 'motionRate' }],
});
scene.motion({
  id: 'wheelSpin',
  partId: 'wheel',
  kind: 'spin',
  axis: [0, 0, 1],
  rate: { param: 'speed', scale: 0.05 },
  reason: 'The wheel turns.',
});
scene.camera({ position: [2, 1.5, 2.4], target: [0, 0, 0], fov: 42 });
`;

/** A WorkerState the test owns, as far from "loaded" as the interface allows. */
function makeFakeState() {
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
    // The planted stale record: model A's values, including an id the new model will not have.
    paramsRecord: { speed: 5, ghost: 42 },
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
    frameDisabled: false,
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
}

describe("the atomic swap must not hand the previous model's state to the next one", () => {
  it("drops the previous model's parameter record on swap", async () => {
    const worker = await import('./sandbox-worker.ts');
    const target = makeFakeState();

    worker.loadProgram(target as never, { type: 'load', code: GUEST, seed: 1 });

    // The load itself must have genuinely succeeded — a test of the swap that never swapped
    // would pass vacuously.
    const loaded = posted.filter((message) => message.type === 'loaded');
    expect(loaded).toHaveLength(1);

    // The record must be `null`, so the next frame rebuilds it from the *current* model's
    // builder: stale values (speed: 5) and ids absent from the new model (ghost) have nowhere to live.
    expect(target.paramsRecord).toBeNull();
  });
});
