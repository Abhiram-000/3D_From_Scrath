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
 *   2. **Shader-drawn, uniform-driven.** A `THREE.Mesh` of one plane with a `ShaderMaterial`: two
 *      tokens (fine + major) travel as uniforms, so a theme change recolours the grid in place and
 *      nothing is rebuilt. It replaced the old `GridHelper`, whose baked-into-geometry colours forced
 *      a rebuild and whose 1-px 6%-opacity lines were invisible.
 *   3. **Unpickable.** A no-op `raycast` means the grid can never appear in any intersection list, so
 *      a pick aimed at the model can never land on the chrome. The chrome-writing settings
 *      (`transparent`, `depthWrite = false`, a render order below the model) keep the plane from
 *      occluding geometry.
 *   4. **Disposed.** Geometry and material are GPU resources; both are released on teardown, and
 *      teardown is idempotent.
 *
 * The worker module is imported in Node with its worker-globals stubbed, exactly as the swap and
 * shot suites do. The state object is the test's own, cast because these helpers read a handful of
 * fields, not sixty.
 */
import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import type * as WorkerModule from './sandbox-worker.ts';
import { ViewEffects } from './view-effects.ts';

// The worker captures these worker-globals at import time, before anything else runs.
vi.stubGlobal('postMessage', () => undefined);
vi.stubGlobal('requestAnimationFrame', (_cb: (t: number) => void) => 0);
vi.stubGlobal('setInterval', () => 0);
vi.stubGlobal('addEventListener', () => undefined);

const WIDTH = 800;
const HEIGHT = 600;

/** The four shipped tokens, verbatim from `tokens.css`. */
const DARK = {
  top: '#17130f',
  bottom: '#08070a',
  grid: 'rgb(255 255 255 / 14%)',
  gridMajor: 'rgb(255 255 255 / 40%)',
};
const LIGHT = {
  top: '#f4ecd8',
  bottom: '#ddd0b6',
  grid: 'rgb(26 22 18 / 16%)',
  gridMajor: 'rgb(26 22 18 / 42%)',
};

/** The six uniform identifiers the fragment shader declares, in the order it declares them. */
const REQUIRED_UNIFORMS = [
  'uMinorColor',
  'uMajorColor',
  'uMinorAlpha',
  'uMajorAlpha',
  'uFadeStart',
  'uFadeEnd',
] as const;

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
    // `applyTheme` tells the effects controller the new backdrop so a live x-ray shell re-tints.
    effects: new ViewEffects(),
  } as unknown as WorkerModule.WorkerState;
}

/** Put the camera above the origin looking down, so the view ray crosses the grid's plane. */
function poseAbove(camera: THREE.PerspectiveCamera): void {
  camera.position.set(0, 5, 0.0001);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();
}

/** Every grid mesh on a scene, identified by the worker's own chrome name. */
function sceneGrids(scene: THREE.Scene, name: string): THREE.Mesh[] {
  return scene.children.filter(
    (child): child is THREE.Mesh => child instanceof THREE.Mesh && child.name === name,
  );
}

/** A mesh's live uniforms, read through the worker's own contract (Three types them as an index bag). */
function gridUniforms(material: THREE.Material): WorkerModule.GridUniforms {
  return (material as THREE.ShaderMaterial).uniforms as unknown as WorkerModule.GridUniforms;
}

describe('the ground grid tokens', () => {
  it('parses the modern space-and-slash form for both weights, alpha included', async () => {
    const worker = await import('./sandbox-worker.ts');

    const darkFine = worker.parseGridColor(DARK.grid);
    expect(darkFine.color.getHexString(THREE.SRGBColorSpace)).toBe('ffffff');
    expect(darkFine.opacity).toBeCloseTo(0.14, 6);

    const darkMajor = worker.parseGridColor(DARK.gridMajor);
    expect(darkMajor.color.getHexString(THREE.SRGBColorSpace)).toBe('ffffff');
    expect(darkMajor.opacity).toBeCloseTo(0.4, 6);

    const lightFine = worker.parseGridColor(LIGHT.grid);
    expect(lightFine.color.getHexString(THREE.SRGBColorSpace)).toBe('1a1612');
    expect(lightFine.opacity).toBeCloseTo(0.16, 6);

    const lightMajor = worker.parseGridColor(LIGHT.gridMajor);
    expect(lightMajor.color.getHexString(THREE.SRGBColorSpace)).toBe('1a1612');
    expect(lightMajor.opacity).toBeCloseTo(0.42, 6);
  });

  it('accepts hex and the legacy comma form', async () => {
    const worker = await import('./sandbox-worker.ts');

    expect(worker.parseGridColor('#fff').color.getHexString(THREE.SRGBColorSpace)).toBe('ffffff');
    expect(worker.parseGridColor('rgba(10, 20, 30, 0.5)').opacity).toBeCloseTo(0.5, 6);
  });

  it('falls back to a visible neutral instead of throwing on a bad or absent token', async () => {
    const worker = await import('./sandbox-worker.ts');

    const fallback = worker.parseGridColor('not a colour at all');
    expect(fallback.opacity).toBeGreaterThan(0.1);
    expect(fallback.color.getHexString(THREE.SRGBColorSpace)).toBe('808080');

    // An empty token (a missing custom property read as '') is the same honest fallback.
    expect(() => worker.parseGridColor('')).not.toThrow();
    // So is a token that never arrived at all — a theme payload from a page that does not send it.
    expect(() => worker.parseGridColor(undefined as unknown as string)).not.toThrow();
  });
});

describe('the grid shader assembly', () => {
  it('builds exactly the uniforms the fragment shader declares', async () => {
    const worker = await import('./sandbox-worker.ts');
    const uniforms = worker.buildGridUniforms(DARK);

    expect(Object.keys(uniforms).sort()).toEqual([...REQUIRED_UNIFORMS].sort());
    // A GLSL identifier typo compiles fine in Node and fails only at render: pin the names here.
    for (const name of REQUIRED_UNIFORMS) {
      expect(new RegExp(`\\b${name}\\b`).test(worker.GRID_FRAGMENT_SHADER)).toBe(true);
    }
  });

  it("carries both tokens' colours and alphas, plus an ordered fade range", async () => {
    const worker = await import('./sandbox-worker.ts');

    const dark = worker.buildGridUniforms(DARK);
    expect(dark.uMinorColor.value.getHexString(THREE.SRGBColorSpace)).toBe('ffffff');
    expect(dark.uMinorAlpha.value).toBeCloseTo(0.14, 6);
    expect(dark.uMajorColor.value.getHexString(THREE.SRGBColorSpace)).toBe('ffffff');
    expect(dark.uMajorAlpha.value).toBeCloseTo(0.4, 6);

    const light = worker.buildGridUniforms(LIGHT);
    expect(light.uMinorColor.value.getHexString(THREE.SRGBColorSpace)).toBe('1a1612');
    expect(light.uMinorAlpha.value).toBeCloseTo(0.16, 6);
    expect(light.uMajorAlpha.value).toBeCloseTo(0.42, 6);

    expect(dark.uFadeStart.value).toBeGreaterThan(0);
    expect(dark.uFadeEnd.value).toBeGreaterThan(dark.uFadeStart.value);
  });
});

describe('the ground grid is viewer chrome', () => {
  it('is a shader mesh on the scene — never the model root — after a theme is applied', async () => {
    const worker = await import('./sandbox-worker.ts');
    const target = makeState();
    // A root a swap would dispose: the grid must be a sibling, not a descendant.
    const modelRoot = new THREE.Group();
    target.scene.add(modelRoot);

    worker.applyTheme(target, DARK);

    expect(target.grid).toBeInstanceOf(THREE.Mesh);
    expect(target.grid?.parent).toBe(target.scene);
    let underRoot = false;
    modelRoot.traverse((object) => {
      if (object === target.grid) underRoot = true;
    });
    expect(underRoot).toBe(false);
    // No `GridHelper` is left anywhere: the plane replaced it.
    expect(target.scene.children.some((child) => child instanceof THREE.GridHelper)).toBe(false);
    expect(sceneGrids(target.scene, worker.GRID_MESH_NAME)).toHaveLength(1);
  });

  it('draws translucent, writes no depth, and sits below the model', async () => {
    const worker = await import('./sandbox-worker.ts');
    const target = makeState();

    worker.applyTheme(target, DARK);
    const grid = target.grid!;
    const material = grid.material;

    expect(material).toBeInstanceOf(THREE.ShaderMaterial);
    expect(material.transparent).toBe(true);
    expect(material.depthWrite).toBe(false);
    expect(material.side).toBe(THREE.FrontSide);
    expect(grid.renderOrder).toBeLessThan(0);
    expect(gridUniforms(material).uMinorAlpha.value).toBeCloseTo(0.14, 6);
  });
});

describe('theme changes and swaps', () => {
  it('updates the uniforms in place and leaves exactly one grid', async () => {
    const worker = await import('./sandbox-worker.ts');
    const target = makeState();

    worker.applyTheme(target, DARK);
    const grid = target.grid!;
    const material = grid.material;
    const geometryDisposed = vi.spyOn(grid.geometry, 'dispose');
    const materialDisposed = vi.spyOn(material, 'dispose');

    worker.applyTheme(target, LIGHT);

    // Recoloured, not rebuilt: same mesh and material, new uniform values.
    expect(target.grid).toBe(grid);
    expect(target.grid!.material).toBe(material);
    const uniforms = gridUniforms(material);
    expect(uniforms.uMinorAlpha.value).toBeCloseTo(0.16, 6);
    expect(uniforms.uMajorAlpha.value).toBeCloseTo(0.42, 6);
    expect(uniforms.uMinorColor.value.getHexString(THREE.SRGBColorSpace)).toBe('1a1612');
    expect(geometryDisposed).not.toHaveBeenCalled();
    expect(materialDisposed).not.toHaveBeenCalled();
    expect(sceneGrids(target.scene, worker.GRID_MESH_NAME)).toHaveLength(1);
  });

  it('survives several model swaps and theme changes with exactly one grid', async () => {
    const worker = await import('./sandbox-worker.ts');
    const target = makeState();
    worker.applyTheme(target, DARK);

    for (let swap = 0; swap < 4; swap += 1) {
      // A swap: the previous root is detached and disposed, a new one is realized onto the scene.
      const root = new THREE.Group();
      target.scene.add(root);
      expect(sceneGrids(target.scene, worker.GRID_MESH_NAME)).toHaveLength(1);
      worker.applyTheme(target, swap % 2 === 0 ? LIGHT : DARK);
      target.scene.remove(root);
      expect(sceneGrids(target.scene, worker.GRID_MESH_NAME)).toHaveLength(1);
    }

    expect(target.grid?.parent).toBe(target.scene);
  });

  it('does not leak its material into the model root', async () => {
    const worker = await import('./sandbox-worker.ts');
    const target = makeState();
    const root = new THREE.Group();
    const part = new THREE.Mesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshStandardMaterial({ color: 0xffffff }),
    );
    root.add(part);
    target.scene.add(root);

    worker.applyTheme(target, DARK);

    // The root still owns exactly its own material, and none of the grid's.
    const materials = new Set<THREE.Material>();
    root.traverse((object) => {
      const material = (object as THREE.Mesh).material;
      if (material instanceof THREE.Material) materials.add(material);
    });
    expect(materials.size).toBe(1);
    expect(materials.has(target.grid!.material)).toBe(false);
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
    expect(sceneGrids(target.scene, worker.GRID_MESH_NAME)).toHaveLength(1);
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
