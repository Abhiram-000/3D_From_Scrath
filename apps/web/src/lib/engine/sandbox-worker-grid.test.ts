/**
 * The ground grid, as viewer chrome (`00`: models need a scale reference; v1 shipped one).
 *
 * The contract already carries the model's ask — `environment.grid`, default `false`, "useful for
 * scale, noise otherwise" — and the viewer already captures it. The engine never read it, so the one
 * capability the model could declare about the floor was silently ignored and the viewer had no grid
 * at all. This file pins the viewer-side grid that closes that gap:
 *
 *   1. **Chrome, not model.** The grid lives on the scene, never under `realized.root`, precisely
 *      because a model swap disposes the root — chrome a swap can dispose is chrome that vanishes
 *      after the first generate.
 *   2. **Theme-driven, rebuilt.** A `GridHelper` bakes its two colours into a geometry attribute at
 *      construction, so a theme change (which v1 handled by rebuilding) disposes the old helper and
 *      builds a new one, honouring the `--scene-grid` token's alpha.
 *   3. **Unpickable.** A no-op `raycast` means the grid can never appear in any intersection list, so
 *      a pick aimed at the model can never land on the chrome. The chrome-writing settings
 *      (`transparent`, `depthWrite = false`, a render order below the model) keep the lines from
 *      punching through geometry.
 *   4. **Disposed.** Geometry and material are GPU resources; both are released on a rebuild and on
 *      teardown, and teardown is idempotent.
 *
 * The worker module is imported in Node with its worker-globals stubbed, exactly as the swap and
 * shot suites do. The state object is the test's own, cast because these helpers read a handful of
 * fields, not sixty.
 */
import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import type * as WorkerModule from './sandbox-worker.ts';

// The worker captures these worker-globals at import time, before anything else runs.
vi.stubGlobal('postMessage', () => undefined);
vi.stubGlobal('requestAnimationFrame', (_cb: (t: number) => void) => 0);
vi.stubGlobal('setInterval', () => 0);
vi.stubGlobal('addEventListener', () => undefined);

const WIDTH = 800;
const HEIGHT = 600;

/** The two shipped tokens, verbatim from `tokens.css`. */
const DARK = { top: '#17130f', bottom: '#08070a', grid: 'rgb(255 255 255 / 6%)' };
const LIGHT = { top: '#f4ecd8', bottom: '#ddd0b6', grid: 'rgb(26 22 18 / 8%)' };

/** A partial worker state: only what the grid helpers and picking read. */
function makeState(): WorkerModule.WorkerState {
  return {
    scene: new THREE.Scene(),
    grid: null,
    camera: new THREE.PerspectiveCamera(45, WIDTH / HEIGHT, 0.01, 2000),
    width: WIDTH,
    height: HEIGHT,
    raycaster: new THREE.Raycaster(),
    pointer: new THREE.Vector2(),
    model: null,
  } as unknown as WorkerModule.WorkerState;
}

/** Put the camera above the origin looking down, so the view ray crosses the grid's plane. */
function poseAbove(camera: THREE.PerspectiveCamera): void {
  camera.position.set(0, 5, 0.0001);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();
}

function sceneGrids(scene: THREE.Scene): THREE.GridHelper[] {
  return scene.children.filter(
    (child): child is THREE.GridHelper => child instanceof THREE.GridHelper,
  );
}

/** The baked vertex colours, which is where a `GridHelper` keeps its centre/grid colours. */
function gridColours(grid: THREE.GridHelper): number[] {
  const attribute = grid.geometry.getAttribute('color');
  return Array.from(attribute.array as ArrayLike<number>);
}

describe('the ground grid token', () => {
  it('parses the modern space-and-slash form, alpha included', async () => {
    const worker = await import('./sandbox-worker.ts');

    const dark = worker.parseGridColor(DARK.grid);
    expect(dark.color.getHexString(THREE.SRGBColorSpace)).toBe('ffffff');
    expect(dark.opacity).toBeCloseTo(0.06, 6);

    const light = worker.parseGridColor(LIGHT.grid);
    expect(light.color.getHexString(THREE.SRGBColorSpace)).toBe('1a1612');
    expect(light.opacity).toBeCloseTo(0.08, 6);
  });

  it('accepts hex and the legacy comma form', async () => {
    const worker = await import('./sandbox-worker.ts');

    expect(worker.parseGridColor('#fff').color.getHexString(THREE.SRGBColorSpace)).toBe('ffffff');
    expect(worker.parseGridColor('rgba(10, 20, 30, 0.5)').opacity).toBeCloseTo(0.5, 6);
  });

  it('falls back to a neutral instead of throwing on an unparseable token', async () => {
    const worker = await import('./sandbox-worker.ts');

    const fallback = worker.parseGridColor('not a colour at all');
    expect(fallback.opacity).toBeGreaterThan(0);
    expect(fallback.color.getHexString(THREE.SRGBColorSpace)).toBe('808080');

    // An empty token (a missing custom property read as '') is the same honest fallback.
    expect(() => worker.parseGridColor('')).not.toThrow();
  });
});

describe('the ground grid is viewer chrome', () => {
  it('is built onto the scene — never the model root — when the theme is applied', async () => {
    const worker = await import('./sandbox-worker.ts');
    const target = makeState();
    // A root a swap would dispose: the grid must be a sibling, not a descendant.
    const modelRoot = new THREE.Group();
    target.scene.add(modelRoot);

    worker.applyTheme(target, DARK);

    expect(target.grid).toBeInstanceOf(THREE.GridHelper);
    expect(target.grid?.parent).toBe(target.scene);
    let underRoot = false;
    modelRoot.traverse((object) => {
      if (object === target.grid) underRoot = true;
    });
    expect(underRoot).toBe(false);
    expect(sceneGrids(target.scene)).toHaveLength(1);
  });

  it('honours the token alpha, writes no depth, and draws below the model', async () => {
    const worker = await import('./sandbox-worker.ts');
    const target = makeState();

    worker.applyTheme(target, DARK);
    const grid = target.grid!;

    expect(grid.material.transparent).toBe(true);
    expect(grid.material.opacity).toBeCloseTo(0.06, 6);
    expect(grid.material.depthWrite).toBe(false);
    expect(grid.renderOrder).toBeLessThan(0);
    // The centre line is emphasised from the same colour — a distinct baked colour, not a second token.
    expect(new Set(gridColours(grid)).size).toBeGreaterThan(1);
  });

  it('rebuilds on a theme change, disposing the old resources and leaving exactly one', async () => {
    const worker = await import('./sandbox-worker.ts');
    const target = makeState();

    worker.applyTheme(target, DARK);
    const first = target.grid!;
    const firstColours = gridColours(first);
    const geometryDisposed = vi.spyOn(first.geometry, 'dispose');
    const materialDisposed = vi.spyOn(first.material, 'dispose');

    worker.applyTheme(target, LIGHT);

    // Rebuilt, not recoloured: the old helper is gone and its GPU resources released.
    expect(target.grid).not.toBe(first);
    expect(geometryDisposed).toHaveBeenCalledTimes(1);
    expect(materialDisposed).toHaveBeenCalledTimes(1);
    expect(sceneGrids(target.scene)).toHaveLength(1);
    expect(gridColours(target.grid!)).not.toEqual(firstColours);
  });

  it('survives several model swaps and theme changes with exactly one grid', async () => {
    const worker = await import('./sandbox-worker.ts');
    const target = makeState();
    worker.applyTheme(target, DARK);

    for (let swap = 0; swap < 4; swap += 1) {
      // A swap: the previous root is detached and disposed, a new one is realized onto the scene.
      const root = new THREE.Group();
      target.scene.add(root);
      expect(sceneGrids(target.scene)).toHaveLength(1);
      worker.applyTheme(target, swap % 2 === 0 ? LIGHT : DARK);
      target.scene.remove(root);
      expect(sceneGrids(target.scene)).toHaveLength(1);
    }

    expect(target.grid?.parent).toBe(target.scene);
  });
});

describe('the grid can never be picked', () => {
  it('is a no-op under a raycast through its plane, where a default helper is not', async () => {
    const worker = await import('./sandbox-worker.ts');
    const target = makeState();
    poseAbove(target.camera);
    worker.applyTheme(target, DARK);
    target.scene.updateMatrixWorld(true);

    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(new THREE.Vector2(0, 0), target.camera);

    // A control: a default `GridHelper` in the same scene *is* hit by the ray...
    const control = new THREE.GridHelper(40, 40);
    target.scene.add(control);
    const hits = raycaster.intersectObject(target.scene, true);
    expect(hits.map((hit) => hit.object)).toContain(control);

    // ...while the viewer's grid, though it is in that scene, is in none of them: its raycast is a no-op.
    expect(hits.map((hit) => hit.object)).not.toContain(target.grid);
  });

  it('is never what pickPoint returns, even through its plane', async () => {
    const worker = await import('./sandbox-worker.ts');
    const target = makeState();
    poseAbove(target.camera);
    worker.applyTheme(target, DARK);
    // An empty model root: the ray crosses the grid plane but strikes nothing pickable.
    const root = new THREE.Group();
    target.model = { root } as unknown as WorkerModule.WorkerState['model'];
    target.scene.add(root);

    const hit = worker.pickPoint(target, WIDTH / 2, HEIGHT / 2);

    expect(hit).toEqual({ point: null, partId: null });
    expect(sceneGrids(target.scene)).toHaveLength(1);
  });
});

describe('grid disposal', () => {
  it('disposes geometry and material on teardown, detaches, and is idempotent', async () => {
    const worker = await import('./sandbox-worker.ts');
    const target = makeState();
    worker.applyTheme(target, DARK);
    const grid = target.grid!;
    const geometryDisposed = vi.spyOn(grid.geometry, 'dispose');
    const materialDisposed = vi.spyOn(grid.material, 'dispose');

    worker.disposeGrid(target);

    expect(geometryDisposed).toHaveBeenCalledTimes(1);
    expect(materialDisposed).toHaveBeenCalledTimes(1);
    expect(target.grid).toBeNull();
    expect(target.scene.children).not.toContain(grid);

    // A second teardown has nothing to release and must not throw.
    expect(() => worker.disposeGrid(target)).not.toThrow();
  });
});
