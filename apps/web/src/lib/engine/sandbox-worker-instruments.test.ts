/**
 * The worker's instruments and its honest readouts (`03` R9, `02` interaction).
 *
 * Three small promises, each of which is a *policy* rather than a mechanism, and therefore each of
 * which belongs in a test rather than in a comment:
 *
 *   1. **Time control.** `setTimeScale` is wired end to end; the part the worker owns is the clamp and
 *      the refusal of a non-finite value, because either one reaching `elapsed` poisons every declared
 *      motion from that frame on.
 *   2. **Zoom clamped through the model's own limits.** `00` requires that a learner can never lose the
 *      model off-screen or zoom through the floor, so every command that moves the camera along its
 *      view axis — a scroll notch, a pinch ratio expressed as a delta — passes through one clamp. A
 *      malformed manifest that inverts its limits must still leave a usable range.
 *   3. **Physics reported as measured.** The status bar used to read `manifest.physics`, so a device
 *      whose WASM failed to load still showed "Physics: On". `physicsStatus` answers from the live
 *      world instead, and names the reason when there is one.
 *
 * The worker module is imported with its worker globals stubbed, as the other worker suites do.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import type * as WorkerModule from './sandbox-worker.ts';

const posted: Array<Record<string, unknown>> = [];
vi.stubGlobal('postMessage', (message: unknown) => {
  posted.push(message as Record<string, unknown>);
});
vi.stubGlobal('requestAnimationFrame', (_cb: (t: number) => void) => 0);
vi.stubGlobal('setInterval', () => 0);
vi.stubGlobal('addEventListener', () => undefined);

/** A partial state: the instrument helpers read very little. */
function makeState(): WorkerModule.WorkerState {
  return {
    camera: new THREE.PerspectiveCamera(45, 800 / 600, 0.01, 2000),
    orbit: { theta: 1, phi: 1, distance: 5, target: new THREE.Vector3() },
    manifest: null,
    physics: null,
    physicsUnavailableReason: null,
    timeScale: 1,
    autoRotate: false,
    glide: null,
    fovMove: null,
    glideFocus: null,
    cameraDirty: false,
    needsRender: false,
  } as unknown as WorkerModule.WorkerState;
}

/** A manifest carrying only the camera declaration the helpers read. */
function withLimits(
  state: WorkerModule.WorkerState,
  limits: Record<string, number>,
): WorkerModule.WorkerState {
  state.manifest = {
    camera: {
      initial: { position: [3, 2, 4], target: [0, 0, 0], fov: 42 },
      limits: { autoRotate: false, ...limits },
    },
  } as unknown as WorkerModule.WorkerState['manifest'];
  return state;
}

beforeEach(() => {
  posted.length = 0;
});

describe('time scale', () => {
  it('applies a value inside the useful range', async () => {
    const worker = await import('./sandbox-worker.ts');
    const target = makeState();

    worker.applyTimeScale(target, 0.25);
    expect(target.timeScale).toBe(0.25);

    worker.applyTimeScale(target, 2);
    expect(target.timeScale).toBe(2);
  });

  it('clamps to the range where the control still means something', async () => {
    const worker = await import('./sandbox-worker.ts');
    const target = makeState();

    worker.applyTimeScale(target, 100);
    expect(target.timeScale).toBe(4);

    worker.applyTimeScale(target, 0);
    expect(target.timeScale).toBe(0.05);
  });

  it('ignores a non-finite value instead of poisoning the clock', async () => {
    const worker = await import('./sandbox-worker.ts');
    const target = makeState();

    worker.applyTimeScale(target, Number.NaN);
    worker.applyTimeScale(target, Number.POSITIVE_INFINITY);

    expect(target.timeScale).toBe(1);
  });
});

describe('zoom clamped through the model’s camera limits', () => {
  it('reads the authored limits', async () => {
    const worker = await import('./sandbox-worker.ts');
    const target = withLimits(makeState(), { minDistance: 2, maxDistance: 8 });

    expect(worker.distanceLimits(target)).toEqual({ min: 2, max: 8 });
  });

  it('falls back to the rig defaults when the model declares none', async () => {
    const worker = await import('./sandbox-worker.ts');
    const target = makeState();
    target.manifest = {
      camera: { initial: { position: [1, 1, 1], target: [0, 0, 0], fov: 45 }, limits: {} },
    } as unknown as WorkerModule.WorkerState['manifest'];

    expect(worker.distanceLimits(target)).toEqual({ min: 0.1, max: 500 });
  });

  it('sorts an inverted pair rather than leaving an empty range', async () => {
    const worker = await import('./sandbox-worker.ts');
    // A malformed manifest: min above max. `Math.max(min, Math.min(max, d))` would pin the camera at
    // the smaller number forever; sorting keeps the declared range usable.
    const target = withLimits(makeState(), { minDistance: 8, maxDistance: 2 });

    expect(worker.distanceLimits(target)).toEqual({ min: 2, max: 8 });
  });

  it('clamps a pinch that would go through the floor or off the model', async () => {
    const worker = await import('./sandbox-worker.ts');
    const limits = { min: 2, max: 8 };

    expect(worker.clampDistance(5, limits)).toBe(5);
    expect(worker.clampDistance(0.01, limits)).toBe(2);
    expect(worker.clampDistance(1000, limits)).toBe(8);
  });

  it('returns null for a pinch that computed garbage', async () => {
    const worker = await import('./sandbox-worker.ts');

    // `Math.min`/`Math.max` propagate `NaN`; a `NaN` distance reaches the camera position and takes
    // the renderer down. "This command changed nothing" is the honest answer.
    expect(worker.clampDistance(Number.NaN, { min: 2, max: 8 })).toBeNull();
  });
});

describe('sending the camera home', () => {
  it('reproduces the authored opening frame', async () => {
    const worker = await import('./sandbox-worker.ts');
    const target = withLimits(makeState(), { minDistance: 1, maxDistance: 20 });
    target.orbit.distance = 12;
    target.orbit.theta = 2.5;
    target.orbit.phi = 0.3;

    expect(worker.resetCameraToInitial(target)).toBe(true);

    // |position − target| = |(3,2,4)| = √29.
    expect(target.orbit.distance).toBeCloseTo(Math.sqrt(29), 6);
    expect(target.camera.fov).toBe(42);
    expect(target.cameraDirty).toBe(true);
    // The camera is where the authored pose says it is, looking at the authored target.
    expect(target.camera.position.x).toBeCloseTo(3, 6);
    expect(target.camera.position.y).toBeCloseTo(2, 6);
    expect(target.camera.position.z).toBeCloseTo(4, 6);
  });

  it('does nothing honest when there is no model loaded', async () => {
    const worker = await import('./sandbox-worker.ts');
    const target = makeState();

    expect(worker.resetCameraToInitial(target)).toBe(false);
  });
});

describe('physics reported as measured', () => {
  it('reports off, with no reason, when the model never asked for a simulation', async () => {
    const worker = await import('./sandbox-worker.ts');
    const target = makeState();

    expect(worker.physicsStatus(target)).toEqual({ physicsActive: false });
  });

  it('reports active only while a world actually exists', async () => {
    const worker = await import('./sandbox-worker.ts');
    const target = makeState();
    target.physics = { dispose: () => undefined } as unknown as WorkerModule.WorkerState['physics'];

    expect(worker.physicsStatus(target)).toEqual({ physicsActive: true });
  });

  it('names the reason when the model asked for physics and the device refused', async () => {
    const worker = await import('./sandbox-worker.ts');
    const target = makeState();
    target.physicsUnavailableReason = 'The physics engine could not load on this device.';

    expect(worker.physicsStatus(target)).toEqual({
      physicsActive: false,
      physicsUnavailableReason: 'The physics engine could not load on this device.',
    });
  });
});
