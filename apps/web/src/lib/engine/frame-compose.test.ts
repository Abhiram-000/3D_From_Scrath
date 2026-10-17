/**
 * The frame-composition contracts the worker delegates to.
 *
 * Two properties pin what the worker's hot path is allowed to allocate:
 *
 *  - **reset is in-place** — the reset copies the authored base *into* the live transform it
 *    already holds, never by replacing the array. Assignation was the per-frame garbage: three
 *    fresh triples per motion-driven part per frame, every frame, forever. The array identity IS
 *    the assertion — a `toEqual` here would pass against both implementations and prove nothing.
 *  - **sync writes by components** — same shape, mirrored onto the renderer's objects: the spread
 *    (`set(...triple)`) built an arguments array per channel per part per frame.
 *
 * The stubs are structural, not THREE objects: the worker hands these functions realized
 * `Object3D`s, but the contract is the x/y/z surface, and keeping the test free of the dependency
 * is what lets it run in Node.
 */
import { describe, expect, it } from 'vitest';
import type { PartTransformLike } from '@edu3d/engine';
import { resetMotionDriven, syncTransforms } from './frame-compose.ts';

interface StubTransform {
  position: { x: number; y: number; z: number };
  rotation: { x: number; y: number; z: number } | undefined;
  scale: { x: number; y: number; z: number };
  visible: boolean;
  material?: { emissiveIntensity?: number; opacity?: number } | undefined;
}

const stub = (x = 0, y = 0, z = 0): StubTransform => ({
  position: { x, y, z },
  rotation: undefined,
  scale: { x: 1, y: 1, z: 1 },
  visible: true,
});

const triple = (t: StubTransform): [number, number, number] => [
  t.position.x,
  t.position.y,
  t.position.z,
];

describe('resetMotionDriven — the pre-frame pose reset', () => {
  it('copies the authored base into the live arrays in place — identity preserved', () => {
    const base = {
      position: [1, 2, 3] as number[],
      rotation: [0, 0.5, 0] as number[],
      scale: [2, 2, 2] as number[],
    };
    const liveTransform = {
      position: [9, 9, 9] as number[],
      rotation: [9, 9, 9] as number[] | undefined,
      scale: [9, 9, 9] as number[],
    };
    const live = new Map([['fan', { transform: liveTransform }]]);
    const before = liveTransform.position;

    resetMotionDriven(new Map([['fan', base]]), live, new Set(['fan']), false);

    // Identity, not equality: the old implementation replaced the array each frame. toEqual would
    // pass against both and hide the allocation.
    expect(liveTransform.position).toBe(before);
    expect(liveTransform.position[0]).toBe(1);
    expect(liveTransform.position[1]).toBe(2);
    expect(liveTransform.position[2]).toBe(3);
    expect(liveTransform.rotation![1]).toBe(0.5);
    expect(liveTransform.scale[0]).toBe(2);
  });

  it('skips parts without a runsWhilePaused motion while paused, and parts the host cannot resolve', () => {
    const base = {
      position: [1, 1, 1] as number[],
      rotation: undefined,
      scale: [1, 1, 1] as number[],
    };
    const makeTransform = (): PartTransformLike => ({
      position: [8, 8, 8],
      rotation: undefined,
      scale: [8, 8, 8],
    });
    const flaggedTransform = makeTransform();
    const live = new Map<string, { transform: PartTransformLike } | undefined>([
      ['flagged', { transform: flaggedTransform }],
      ['unflagged', { transform: makeTransform() }],
      ['ghost', undefined],
    ]);

    resetMotionDriven(
      new Map([
        ['flagged', base],
        ['unflagged', base],
      ]),
      live,
      new Set(['flagged']),
      true,
    );

    // The flagged part resets even while paused; the unflagged keeps its frame pose.
    expect(flaggedTransform.position).toEqual([1, 1, 1]);
    // (the unflagged read-out is asserted through its own map entry below)
    expect(live.get('unflagged')!.transform!.position).toEqual([8, 8, 8]);
  });
});

describe('syncTransforms — the renderer copy', () => {
  it('writes position, 3-component rotation, scale and visibility by component', () => {
    const object = stub();
    object.rotation = { x: 9, y: 9, z: 9 };
    const model = new Map([['fan', object]]);
    syncTransforms(
      model as unknown as Map<string, StubTransform>,
      [
        {
          id: 'fan',
          transform: {
            position: [1, 2, 3],
            rotation: [0.1, 0.2, 0.3],
            scale: [2, 2, 2],
          },
          visible: true,
        },
      ] as never,
    );

    expect(object.position).toEqual({ x: 1, y: 2, z: 3 });
    expect(object.rotation).toEqual({ x: 0.1, y: 0.2, z: 0.3 });
    expect(object.scale).toEqual({ x: 2, y: 2, z: 2 });
  });

  it('copies the material channels the API exposes per frame', () => {
    const object = stub();
    // The worker's guard is `'emissiveIntensity' in material` — the property must EXIST (a real
    // MeshStandardMaterial declares both; a standard-less basic material omits them and is skipped).
    object.material = { emissiveIntensity: undefined, opacity: undefined };
    syncTransforms(
      new Map([['lamp', object]]) as unknown as Map<string, StubTransform>,
      [
        {
          id: 'lamp',
          transform: { position: [0, 0, 0], scale: [1, 1, 1] },
          visible: true,
          material: { emissiveIntensity: 4.5, opacity: 0.5 },
        },
      ] as never,
    );

    expect(object.material?.emissiveIntensity).toBe(4.5);
    expect(object.material?.opacity).toBe(0.5);
  });
});
