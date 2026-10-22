/**
 * The worker-side wiring for the two view modes, driven through the real `loadProgram` pipeline.
 *
 * The module's own suite pins the maths; this file pins the wiring that only the worker can get
 * wrong: that loading a model binds the effects controller to the realized root (so explode has
 * something to capture), that `applyViewMode` delegates x-ray and explode to it, and that the
 * explode displacement composes additively with a pose the frame loop has already written — the
 * difference between "a moving part also explodes" and "a moving part loses its offset every
 * frame".
 *
 * The sandbox-worker module is imported in Node with its worker-globals stubbed, exactly as the
 * swap suite does; `hardenRealm` is neutralized because hardening the vitest realm would destroy
 * the runner.
 */
import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import type * as SandboxModule from '@edu3d/sandbox';
import type * as WorkerModule from './sandbox-worker.ts';
import { EXPLODE_DURATION, ViewEffects } from './view-effects.ts';

const posted: Array<Record<string, unknown>> = [];
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

/** The smallest guest that prices, realizes and gives the modes a real mesh to act on. */
const GUEST = String.raw`
scene.describe({
  name: 'Effects Probe',
  description: 'One wheel, so the view modes have a real part to swap and explode.',
  domain: 'mechanical-engineering',
  subdomain: 'kinematics',
  concept: 'A wheel is a part the viewer can inspect.',
  objectives: ['See the wheel'],
  level: 'secondary',
  principles: ['A wheel is a body'],
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
scene.camera({ position: [2, 1.5, 2.4], target: [0, 0, 0], fov: 42 });
`;

/** A WorkerState the test owns, as far from "loaded" as the interface allows. */
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

async function loadedState() {
  const worker = await import('./sandbox-worker.ts');
  const target = makeFakeState();
  worker.loadProgram(target as never, { type: 'load', code: GUEST, seed: 1 });

  const wheel = target.model?.parts.get('wheel') as THREE.Mesh;
  expect(wheel).toBeDefined();
  return { worker, target, wheel };
}

describe('applyViewMode — x-ray wiring', () => {
  it('swaps the shared shell in and restores the authored material exactly', async () => {
    const { worker, target, wheel } = await loadedState();
    const authored = wheel.material;

    target.viewMode = 'xray';
    worker.applyViewMode(target);
    expect(wheel.material).toBe(target.effects.sharedMaterial);
    expect(wheel.material).not.toBe(authored);

    target.viewMode = 'normal';
    worker.applyViewMode(target);
    expect(wheel.material).toBe(authored);
  });
});

describe('applyViewMode — explode wiring', () => {
  it('captures the model on load and animates the parts apart on toggle', async () => {
    const { worker, target, wheel } = await loadedState();
    const restY = wheel.position.y;

    target.viewMode = 'explode';
    worker.applyViewMode(target);
    expect(target.effects.exploded).toBe(true);
    expect(target.effects.explodeProgress).toBe(0);

    target.effects.advance(EXPLODE_DURATION);

    // The frame loop writes the authored pose, then the explode pass adds its delta on top.
    wheel.position.set(0, restY, 0);
    target.effects.apply();
    expect(wheel.position.y).toBeGreaterThan(restY);
  });

  it('adds to a pose the frame already wrote rather than replacing it', async () => {
    const { worker, target, wheel } = await loadedState();

    target.viewMode = 'explode';
    worker.applyViewMode(target);
    target.effects.advance(EXPLODE_DURATION); // progress 1

    // Measure the explode displacement from rest.
    wheel.position.set(0, 0, 0);
    target.effects.apply();
    const delta = wheel.position.y;

    // A motion writes a different pose on this frame; the result is motionPose + delta.
    wheel.position.set(0, 4, 0);
    target.effects.apply();
    expect(wheel.position.y).toBeCloseTo(4 + delta, 6);
  });

  it('collapses back to the written pose with no residual offset', async () => {
    const { worker, target, wheel } = await loadedState();

    target.viewMode = 'explode';
    worker.applyViewMode(target);
    target.effects.advance(EXPLODE_DURATION);

    target.viewMode = 'normal';
    worker.applyViewMode(target);
    target.effects.advance(EXPLODE_DURATION);
    expect(target.effects.explodeProgress).toBe(0);

    wheel.position.set(0, 0, 0);
    target.effects.apply();
    expect(wheel.position.y).toBe(0);
  });
});
