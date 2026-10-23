/**
 * Model-label projection at the sandbox boundary (`01`: parts self-describing; spatial contiguity).
 *
 * The worker's half of the label capability: turn a label's anchored world point — the part's world
 * position plus its authored offset — into a screen position the page can draw a caption over. It is
 * the twin of the annotation projection in `sandbox-worker-annotations.test.ts`, and it is hard for
 * the same reason: `Vector3.project` divides by `w`, so a point behind the camera mirrors through the
 * origin and comes back as a plausible coordinate on the wrong side of the screen. That coordinate
 * must never be handed to the page — the label is flagged hidden and given no coordinates at all.
 *
 * The two behaviours unique to labels are pinned here as well:
 *
 *   - **One-shot.** A label on a static part is projected once and not again; a moved part re-projects.
 *   - **De-collision.** Two labels landing on the same screen point cannot stack — the later one is
 *     dropped, so a word is never printed over another.
 *
 * The worker module is imported with its worker globals stubbed, exactly as the annotation, shot and
 * swap suites do; the state object is the test's own, cast to the interface because projection reads
 * a handful of fields, not sixty.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import type { ModelManifest } from '@edu3d/contracts';
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

type Label = ModelManifest['labels'][number];

/** A partial worker state: only what `projectLabels` actually reads. */
function makeState(labels: Label[]): WorkerModule.WorkerState {
  return {
    camera: new THREE.PerspectiveCamera(45, WIDTH / HEIGHT, 0.01, 2000),
    width: WIDTH,
    height: HEIGHT,
    labels,
    labelAnchors: new Map(),
    model: null,
  } as unknown as WorkerModule.WorkerState;
}

/** A realized-model stand-in: part id → object, with the objects positioned in world space. */
function makeModel(parts: Record<string, THREE.Object3D>): WorkerModule.WorkerState['model'] {
  const root = new THREE.Group();
  for (const object of Object.values(parts)) root.add(object);
  root.updateMatrixWorld(true);
  return {
    root,
    parts: new Map(Object.entries(parts)),
  } as unknown as WorkerModule.WorkerState['model'];
}

function box(x: number, y: number, z: number): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial());
  mesh.position.set(x, y, z);
  return mesh;
}

/** Put the camera at `position`, looking at the origin — the pose every assertion is stated against. */
function poseCamera(camera: THREE.PerspectiveCamera, position: [number, number, number]): void {
  camera.position.set(position[0], position[1], position[2]);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();
}

const label = (id: string, partId: string, extra: Partial<Label> = {}): Label =>
  ({ id, partId, text: id, ...extra }) as Label;

beforeEach(() => {
  posted.length = 0;
});

describe('projecting model labels', () => {
  it('sends nothing when the model declares no labels', async () => {
    const worker = await import('./sandbox-worker.ts');
    const target = makeState([]);
    target.model = makeModel({ axle: box(0, 0, 0) });

    worker.projectLabels(target);

    expect(posted).toHaveLength(0);
  });

  it('places a label at its part, at the centre of the canvas when the part is on the view axis', async () => {
    const worker = await import('./sandbox-worker.ts');
    const target = makeState([label('lblAxle', 'axle')]);
    poseCamera(target.camera, [0, 0, 10]);
    target.model = makeModel({ axle: box(0, 0, 0) });

    worker.projectLabels(target);

    expect(posted).toHaveLength(1);
    const message = posted[0] as {
      type: string;
      labels: Array<{ id: string; visible: boolean; x?: number; y?: number }>;
    };
    expect(message.type).toBe('labelPositions');
    expect(message.labels).toHaveLength(1);
    expect(message.labels[0]?.id).toBe('lblAxle');
    expect(message.labels[0]?.visible).toBe(true);
    expect(message.labels[0]?.x).toBeCloseTo(WIDTH / 2, 6);
    expect(message.labels[0]?.y).toBeCloseTo(HEIGHT / 2, 6);
  });

  it('applies the authored offset in the part’s frame', async () => {
    const worker = await import('./sandbox-worker.ts');
    // A part up and to the right of the origin; the label lifts a further metre up.
    const target = makeState([label('lblAxle', 'axle', { offset: [0, 1, 0] })]);
    poseCamera(target.camera, [0, 0, 10]);
    target.model = makeModel({ axle: box(0.2, -0.3, 0) });

    worker.projectLabels(target);

    const message = posted[0] as {
      labels: Array<{ visible: boolean; x?: number; y?: number }>;
    };
    const placed = message.labels[0];
    expect(placed?.visible).toBe(true);
    if (!placed?.visible) throw new Error('unreachable');

    // The offset moves the label up in world space, so its screen y is above the part's own centre.
    const partScreen = worker.projectPointToCanvas(target.camera, WIDTH, HEIGHT, [0.2, -0.3, 0]);
    expect(partScreen.visible).toBe(true);
    if (!partScreen.visible) throw new Error('unreachable');
    expect(placed.y).toBeLessThan(partScreen.y);
  });

  it('flags a labelled part behind the camera hidden, with no mirrored coordinate', async () => {
    const worker = await import('./sandbox-worker.ts');
    const target = makeState([label('lblAxle', 'axle')]);
    poseCamera(target.camera, [0, 0, 10]);
    // Behind the camera on the same axis: projected naively this is the canvas centre.
    target.model = makeModel({ axle: box(0, 0, 30) });

    worker.projectLabels(target);

    const message = posted[0] as {
      labels: Array<{ id: string; visible: boolean; x?: number; y?: number }>;
    };
    expect(message.labels[0]?.id).toBe('lblAxle');
    expect(message.labels[0]?.visible).toBe(false);
    expect(message.labels[0]?.x).toBeUndefined();
    expect(message.labels[0]?.y).toBeUndefined();
  });

  it('reports a label whose part has no realized object as hidden rather than guessing', async () => {
    const worker = await import('./sandbox-worker.ts');
    const target = makeState([label('lblGhost', 'missing')]);
    poseCamera(target.camera, [0, 0, 10]);
    target.model = makeModel({ axle: box(0, 0, 0) });

    worker.projectLabels(target);

    const message = posted[0] as { labels: Array<{ visible: boolean; x?: number }> };
    expect(message.labels[0]?.visible).toBe(false);
    expect(message.labels[0]?.x).toBeUndefined();
  });

  it('does not re-project when nothing moved — the label is a one-shot cost', async () => {
    const worker = await import('./sandbox-worker.ts');
    const target = makeState([label('lblAxle', 'axle')]);
    poseCamera(target.camera, [0, 0, 10]);
    target.model = makeModel({ axle: box(0, 0, 0) });

    worker.projectLabels(target);
    expect(posted).toHaveLength(1);
    posted.length = 0;

    // A second call with the same pose publishes nothing: the anchors match.
    worker.projectLabels(target);
    expect(posted).toHaveLength(0);
  });

  it('re-projects when a labelled part moved', async () => {
    const worker = await import('./sandbox-worker.ts');
    const target = makeState([label('lblAxle', 'axle')]);
    poseCamera(target.camera, [0, 0, 10]);
    const parts = { axle: box(0, 0, 0) };
    target.model = makeModel(parts);

    worker.projectLabels(target);
    expect(posted).toHaveLength(1);
    posted.length = 0;

    // The part moved: the anchor no longer matches, so the label is recomputed.
    parts.axle.position.set(1, 0, 0);
    parts.axle.updateMatrixWorld(true);
    worker.projectLabels(target);
    expect(posted).toHaveLength(1);
  });

  it('drops a label that collides with one already drawn', async () => {
    const worker = await import('./sandbox-worker.ts');
    // Two labels on the same part, so the same screen position — one word, not two stacked.
    const target = makeState([label('lblA', 'axle'), label('lblB', 'axle')]);
    poseCamera(target.camera, [0, 0, 10]);
    target.model = makeModel({ axle: box(0, 0, 0) });

    worker.projectLabels(target);

    const message = posted[0] as {
      labels: Array<{ id: string; visible: boolean }>;
    };
    expect(message.labels).toHaveLength(2);
    expect(message.labels[0]?.visible).toBe(true);
    expect(message.labels[1]?.visible).toBe(false);
  });
});
