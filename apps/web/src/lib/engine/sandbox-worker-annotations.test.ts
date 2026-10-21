/**
 * Annotation support at the sandbox boundary (`03` R7).
 *
 * R7 requires learner-pinned notes that "stay glued to geometry as the camera orbits (world point
 * re-projected each frame)" and that "hide behind the camera". Two halves of that live on the worker
 * side, and both are hard to get right for the same reason — the worker is the only place that knows
 * the camera and the geometry:
 *
 *   1. **Screen → world.** A click becomes a world point by raycasting the realized scene, so a pin
 *      is anchored to real geometry rather than to a screen coordinate that stops meaning anything
 *      the moment the camera moves.
 *   2. **World → screen, per frame.** Every pinned world point is projected back for the page to
 *      place a DOM pin over. The one trap this file exists to pin down is that `Vector3.project`
 *      divides by `w`: a point *behind* the camera mirrors through the origin and comes back as a
 *      perfectly plausible coordinate on the opposite side of the screen. That coordinate must never
 *      be handed to the page — the point is flagged hidden and given no coordinates at all.
 *
 * The worker module is imported with its worker globals stubbed, exactly as the shot and swap suites
 * do; the state object is the test's own, cast to the interface because projection and picking read a
 * handful of fields, not sixty.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import type { AnnotationPin } from '@edu3d/contracts';
import type * as WorkerModule from './sandbox-worker.ts';

const posted: Array<Record<string, unknown>> = [];
// The worker captures these globals at import time, before any test can stub them later.
vi.stubGlobal('postMessage', (message: unknown) => {
  posted.push(message as Record<string, unknown>);
});
vi.stubGlobal('requestAnimationFrame', (_cb: (t: number) => void) => 0);
vi.stubGlobal('setInterval', () => 0);
vi.stubGlobal('addEventListener', () => undefined);

const WIDTH = 800;
const HEIGHT = 600;

/** A partial worker state: only what projection and picking actually read. */
function makeState(): WorkerModule.WorkerState {
  return {
    camera: new THREE.PerspectiveCamera(45, WIDTH / HEIGHT, 0.01, 2000),
    width: WIDTH,
    height: HEIGHT,
    annotations: [],
    raycaster: new THREE.Raycaster(),
    model: null,
  } as unknown as WorkerModule.WorkerState;
}

/** Put the camera at `position`, looking at the origin — the pose every assertion is stated against. */
function poseCamera(camera: THREE.PerspectiveCamera, position: [number, number, number]): void {
  camera.position.set(position[0], position[1], position[2]);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();
}

/** A one-metre box at the origin, owned by a part named `wheel`. */
function makeModel(selectable: boolean): THREE.Group {
  const root = new THREE.Group();
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial());
  if (selectable) mesh.userData = { selectable: true, partId: 'wheel' };
  root.add(mesh);
  root.updateMatrixWorld(true);
  return root;
}

const pin = (id: string, point: [number, number, number]): AnnotationPin => ({ id, point });

beforeEach(() => {
  posted.length = 0;
});

describe('projecting a world point onto the canvas', () => {
  it('round-trips a known pose: a point on the view axis lands at the centre of the canvas', async () => {
    const worker = await import('./sandbox-worker.ts');
    const camera = new THREE.PerspectiveCamera(45, WIDTH / HEIGHT, 0.01, 2000);
    poseCamera(camera, [0, 0, 10]);

    const projected = worker.projectPointToCanvas(camera, WIDTH, HEIGHT, [0, 0, 0]);

    expect(projected.visible).toBe(true);
    if (!projected.visible) throw new Error('unreachable');
    expect(projected.x).toBeCloseTo(WIDTH / 2, 6);
    expect(projected.y).toBeCloseTo(HEIGHT / 2, 6);
  });

  it('agrees with Three’s own projection for an off-axis point', async () => {
    const worker = await import('./sandbox-worker.ts');
    const camera = new THREE.PerspectiveCamera(45, WIDTH / HEIGHT, 0.01, 2000);
    poseCamera(camera, [2, 1.5, 6]);

    const point: [number, number, number] = [0.4, -0.3, 0.2];
    const projected = worker.projectPointToCanvas(camera, WIDTH, HEIGHT, point);
    expect(projected.visible).toBe(true);
    if (!projected.visible) throw new Error('unreachable');

    // The independent reference: NDC from `Vector3.project`, converted to the same pixel space.
    const ndc = new THREE.Vector3(point[0], point[1], point[2]).project(camera);
    expect(projected.x).toBeCloseTo((ndc.x * 0.5 + 0.5) * WIDTH, 4);
    expect(projected.y).toBeCloseTo((-ndc.y * 0.5 + 0.5) * HEIGHT, 4);
  });

  it('flags a point behind the camera hidden instead of mirroring it through the origin', async () => {
    const worker = await import('./sandbox-worker.ts');
    const camera = new THREE.PerspectiveCamera(45, WIDTH / HEIGHT, 0.01, 2000);
    poseCamera(camera, [0, 0, 10]);

    // Behind the camera, on the same axis. Projected naively this is the canvas centre — a bogus
    // coordinate for a pin whose geometry the learner cannot see at all.
    const behind = worker.projectPointToCanvas(camera, WIDTH, HEIGHT, [0, 0, 20]);
    expect(behind.visible).toBe(false);
    expect(behind).not.toHaveProperty('x');
    expect(behind).not.toHaveProperty('y');

    // At the camera plane itself is also not visible: the division is degenerate there.
    expect(worker.projectPointToCanvas(camera, WIDTH, HEIGHT, [0, 0, 10]).visible).toBe(false);
  });

  it('flags a point outside the frustum hidden', async () => {
    const worker = await import('./sandbox-worker.ts');
    const camera = new THREE.PerspectiveCamera(45, WIDTH / HEIGHT, 0.01, 2000);
    poseCamera(camera, [0, 0, 10]);

    const offside = worker.projectPointToCanvas(camera, WIDTH, HEIGHT, [100, 0, 0]);
    expect(offside.visible).toBe(false);
    expect(offside).not.toHaveProperty('x');
  });
});

describe('publishing pin positions', () => {
  it('sends nothing at all when no pin is set', async () => {
    const worker = await import('./sandbox-worker.ts');
    const target = makeState();

    worker.projectAnnotations(target);

    expect(posted).toHaveLength(0);
  });

  it('sends one message per call, with a visibility flag per pin', async () => {
    const worker = await import('./sandbox-worker.ts');
    const target = makeState();
    poseCamera(target.camera, [0, 0, 10]);
    target.annotations = [pin('front', [0, 0, 0]), pin('behind', [0, 0, 30])];

    worker.projectAnnotations(target);

    expect(posted).toHaveLength(1);
    const message = posted[0] as {
      type: string;
      pins: Array<{ id: string; visible: boolean; x?: number; y?: number }>;
    };
    expect(message.type).toBe('annotationPositions');
    expect(message.pins).toHaveLength(2);

    const front = message.pins[0];
    expect(front?.id).toBe('front');
    expect(front?.visible).toBe(true);
    expect(front?.x).toBeCloseTo(WIDTH / 2, 6);

    const behind = message.pins[1];
    expect(behind?.id).toBe('behind');
    expect(behind?.visible).toBe(false);
    // No coordinate may travel for a hidden pin: the page must not be able to place it by accident.
    expect(behind?.x).toBeUndefined();
    expect(behind?.y).toBeUndefined();
  });
});

describe('picking a screen point into a world point', () => {
  it('returns the surface point and the part that owns it', async () => {
    const worker = await import('./sandbox-worker.ts');
    const target = makeState();
    poseCamera(target.camera, [0, 0, 5]);
    target.model = { root: makeModel(true) } as unknown as WorkerModule.WorkerState['model'];

    // The centre of the canvas is the centre of the box.
    const hit = worker.pickPoint(target, WIDTH / 2, HEIGHT / 2);

    expect(hit.point).not.toBeNull();
    expect(hit.partId).toBe('wheel');
    if (!hit.point) throw new Error('unreachable');
    expect(hit.point[0]).toBeCloseTo(0, 5);
    expect(hit.point[1]).toBeCloseTo(0, 5);
    // The near face of a one-metre box seen from z = 5.
    expect(hit.point[2]).toBeCloseTo(0.5, 5);
  });

  it('still reports the point when the geometry belongs to no selectable part', async () => {
    const worker = await import('./sandbox-worker.ts');
    const target = makeState();
    poseCamera(target.camera, [0, 0, 5]);
    target.model = { root: makeModel(false) } as unknown as WorkerModule.WorkerState['model'];

    const hit = worker.pickPoint(target, WIDTH / 2, HEIGHT / 2);

    // A note pinned to a ground plane is still a note glued to geometry.
    expect(hit.point).not.toBeNull();
    expect(hit.partId).toBeNull();
  });

  it('returns an honest miss rather than a guessed origin', async () => {
    const worker = await import('./sandbox-worker.ts');
    const target = makeState();
    poseCamera(target.camera, [0, 0, 5]);
    target.model = { root: makeModel(true) } as unknown as WorkerModule.WorkerState['model'];

    // Far outside the box's silhouette on screen.
    const hit = worker.pickPoint(target, WIDTH - 5, HEIGHT - 5);

    expect(hit.point).toBeNull();
    expect(hit.partId).toBeNull();
  });

  it('reports a miss when there is no model to hit', async () => {
    const worker = await import('./sandbox-worker.ts');
    const target = makeState();

    expect(worker.pickPoint(target, 10, 10)).toEqual({ point: null, partId: null });
  });
});
