/**
 * The X-ray and Explode contracts.
 *
 * Explode's maths is pinned both as pure functions (travel proportion, the parent-space write,
 * the at-centre fallback, the authored-direction rules, the clock's ease/reversal/no-drift
 * properties, and the additive composition with a per-frame pose write) and through the
 * controller's capture → animate → apply loop. X-ray is pinned through the controller, where the
 * properties that matter are about identity and lifetime, not arithmetic: one shared material for
 * many meshes, authored materials restored *by reference* (the part that legitimately had
 * `transparent`/`depthWrite` off comes back exactly as authored), idempotence, and a root swap
 * that disposes the old shell and re-applies to the new root.
 *
 * Three is used for the controller half — it is the same package the worker imports, and its
 * object graph is what the controller manipulates. The pure half never touches it.
 */
import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import {
  advanceExplode,
  applyExplodeDelta,
  applyMatrix4,
  captureExplodePoses,
  easeInOutCubic,
  EXPLODE_DURATION,
  IDLE_EXPLODE,
  relativeLuminance,
  startExplode,
  xrayShellStyle,
  ViewEffects,
  type ExplodeSource,
} from './view-effects.ts';

/** Column-major identity, the layout `THREE.Matrix4.elements` uses. */
const IDENTITY: number[] = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

/** Column-major Y-rotation by θ, then translated by (tx, ty, tz) — a rotated, offset parent. */
function yRotationThenTranslate(theta: number, tx: number, ty: number, tz: number): number[] {
  const c = Math.cos(theta);
  const s = Math.sin(theta);
  return [c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, tx, ty, tz, 1];
}

const unitBounds = (scale: number) => ({
  center: { x: 0, y: 0, z: 0 },
  size: { x: scale, y: scale, z: scale },
});

function poseFor(scale: number) {
  const source: ExplodeSource = {
    id: 'part',
    worldPosition: { x: scale / 2, y: 0, z: 0 },
    parentWorldMatrix: IDENTITY,
    rest: { x: scale / 2, y: 0, z: 0 },
  };
  return captureExplodePoses([source], unitBounds(scale)).get('part')!;
}

const length = (v: { x: number; y: number; z: number }) => Math.hypot(v.x, v.y, v.z);

describe('captureExplodePoses — travel is proportionate to the model', () => {
  it('separates the same relative layout by the same fraction of model size at 0.2 and 40 units', () => {
    const small = poseFor(0.2);
    const large = poseFor(40);

    const smallFraction = length(small.delta) / 0.2;
    const largeFraction = length(large.delta) / 40;

    // The constant-offset bug moved both by the same 0.35 units: imploding the board, launching
    // the engine off-screen. Deriving travel from the bounds is what makes both readable.
    expect(largeFraction).toBeCloseTo(smallFraction, 6);
    expect(smallFraction).toBeGreaterThan(0.5);
  });
});

describe('captureExplodePoses — a nested part explodes in world terms', () => {
  it("expresses the target in the rotated parent's space, not as a naive local write", () => {
    const parentWorld = yRotationThenTranslate(Math.PI / 2, 5, 0, 0);
    const localRest = { x: 1, y: 0, z: 0 };
    const worldPosition = applyMatrix4(parentWorld, localRest);
    const source: ExplodeSource = {
      id: 'nested',
      worldPosition,
      parentWorldMatrix: parentWorld,
      rest: localRest,
    };

    const pose = captureExplodePoses([source], unitBounds(10)).get('nested')!;

    // Recompute the world-space intent independently: travel grows with radial distance.
    const radial = length(worldPosition);
    const travel = 10 * 0.35 + radial * 0.85;
    const worldTarget = {
      x: worldPosition.x + (worldPosition.x / radial) * travel,
      y: worldPosition.y + (worldPosition.y / radial) * travel,
      z: worldPosition.z + (worldPosition.z / radial) * travel,
    };

    // Transformed back through the parent, the target must land where the world maths intends.
    const roundTrip = applyMatrix4(parentWorld, pose.target);
    expect(roundTrip.x).toBeCloseTo(worldTarget.x, 6);
    expect(roundTrip.y).toBeCloseTo(worldTarget.y, 6);
    expect(roundTrip.z).toBeCloseTo(worldTarget.z, 6);

    // The old bug wrote the world target straight into `position` (parent space): a rotated parent
    // would then have sent the part somewhere else entirely.
    const naiveWorld = applyMatrix4(parentWorld, worldTarget);
    expect(Math.hypot(naiveWorld.x - worldTarget.x, naiveWorld.z - worldTarget.z)).toBeGreaterThan(
      1,
    );

    expect(pose.rest).toEqual(localRest);
  });
});

describe('captureExplodePoses — the degenerate and authored cases', () => {
  it('gives a part exactly at the centre a deterministic direction and still separates', () => {
    const source: ExplodeSource = {
      id: 'core',
      worldPosition: { x: 0, y: 0, z: 0 },
      parentWorldMatrix: IDENTITY,
      rest: { x: 0, y: 0, z: 0 },
    };
    const pose = captureExplodePoses([source], unitBounds(1)).get('core')!;

    expect(pose.delta.x).toBe(0);
    expect(pose.delta.z).toBe(0);
    expect(pose.delta.y).toBeGreaterThan(0);
  });

  it('keeps an authored offset long enough to be a metric distance', () => {
    const source: ExplodeSource = {
      id: 'authored',
      worldPosition: { x: 0, y: 0, z: 0 },
      parentWorldMatrix: IDENTITY,
      rest: { x: 0, y: 0, z: 0 },
      explodeOffset: [0, 0, 5],
    };
    const pose = captureExplodePoses([source], unitBounds(10)).get('authored')!;

    // 5 is 50% of the model scale, so the length is deliberate and the travel is exactly 5.
    expect(pose.delta.z).toBeCloseTo(5, 6);
    expect(pose.delta.x).toBeCloseTo(0, 6);
  });

  it('uses only the direction of a short authored offset and borrows the computed travel', () => {
    const source: ExplodeSource = {
      id: 'hint',
      worldPosition: { x: 0, y: 0, z: 0 },
      parentWorldMatrix: IDENTITY,
      rest: { x: 0, y: 0, z: 0 },
      explodeOffset: [0, 0, 0.001],
    };
    const pose = captureExplodePoses([source], unitBounds(10)).get('hint')!;

    // 0.001 is 0.01% of scale — a direction hint, not a distance. Travel falls back to the base
    // term (10 * 0.35) and the direction is the authored +z.
    expect(pose.delta.z).toBeCloseTo(3.5, 6);
  });

  it('is authoritative for direction even when short', () => {
    const source: ExplodeSource = {
      id: 'hint',
      worldPosition: { x: 5, y: 0, z: 0 },
      parentWorldMatrix: IDENTITY,
      rest: { x: 5, y: 0, z: 0 },
      explodeOffset: [-0.01, 0, 0],
    };
    const pose = captureExplodePoses([source], unitBounds(10)).get('hint')!;

    // The radial direction would push +x; the authored hint overrides it to -x.
    expect(pose.delta.x).toBeLessThan(0);
  });

  it('falls back to the radial direction for a zero-length authored offset', () => {
    const source: ExplodeSource = {
      id: 'zero',
      worldPosition: { x: 1, y: 0, z: 0 },
      parentWorldMatrix: IDENTITY,
      rest: { x: 1, y: 0, z: 0 },
      explodeOffset: [0, 0, 0],
    };
    const pose = captureExplodePoses([source], unitBounds(2)).get('zero')!;

    expect(pose.delta.x).toBeGreaterThan(0);
    expect(pose.delta.y).toBeCloseTo(0, 6);
  });
});

describe('explode progress — exact endpoints, smooth reversal, no drift', () => {
  it('eases to 0 and 1 at the endpoints', () => {
    expect(easeInOutCubic(0)).toBe(0);
    expect(easeInOutCubic(1)).toBe(1);
    expect(easeInOutCubic(0.5)).toBeCloseTo(0.5, 12);
  });

  it('lands on the far endpoint exactly when driven to completion', () => {
    const apart = advanceExplode(startExplode(IDLE_EXPLODE, 1), 2, EXPLODE_DURATION);
    expect(apart.progress).toBe(1);
    expect(apart.active).toBe(false);

    const together = advanceExplode(startExplode(apart, 0), 2, EXPLODE_DURATION);
    expect(together.progress).toBe(0);
  });

  it('reverses from a mid-flight progress and lands on the far end', () => {
    let clock = advanceExplode(
      startExplode(IDLE_EXPLODE, 1),
      EXPLODE_DURATION / 2,
      EXPLODE_DURATION,
    );
    const mid = clock.progress;
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(1);

    clock = startExplode(clock, 0);
    expect(clock.from).toBe(mid);

    clock = advanceExplode(clock, 2, EXPLODE_DURATION);
    expect(clock.progress).toBe(0);
  });

  it('returns exactly to rest across repeated full cycles — no drift', () => {
    let clock = IDLE_EXPLODE;
    for (let cycle = 0; cycle < 5; cycle += 1) {
      clock = advanceExplode(startExplode(clock, 1), 5, EXPLODE_DURATION);
      clock = advanceExplode(startExplode(clock, 0), 5, EXPLODE_DURATION);
    }
    expect(clock.progress).toBe(0);
    expect(clock.active).toBe(false);
  });
});

describe('applyExplodeDelta — the explode pass composes with the motions', () => {
  it('adds the displacement to whatever pose the frame already wrote', () => {
    const delta = { x: 1, y: -2, z: 0.5 };
    const motionPose = { x: 3, y: 4, z: 5 };

    applyExplodeDelta(motionPose, delta, 1);

    // motionPose + delta, not one or the other.
    expect(motionPose).toEqual({ x: 4, y: 2, z: 5.5 });
  });

  it('is exactly a no-op at progress 0', () => {
    const position = { x: 3, y: 4, z: 5 };
    applyExplodeDelta(position, { x: 1, y: -2, z: 0.5 }, 0);
    expect(position).toEqual({ x: 3, y: 4, z: 5 });
  });
});

/** A root with one mesh per material, so a test can identify each by reference. */
function rootWithMeshes(materials: THREE.Material[]): {
  root: THREE.Group;
  meshes: THREE.Mesh[];
} {
  const root = new THREE.Group();
  const meshes = materials.map((material) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(), material);
    root.add(mesh);
    return mesh;
  });
  return { root, meshes };
}

describe('x-ray material', () => {
  it('derives a light shell over a dark backdrop and a deeper one over a light backdrop', () => {
    expect(relativeLuminance(0, 0, 0)).toBe(0);
    expect(relativeLuminance(1, 1, 1)).toBeCloseTo(1, 12);
    expect(xrayShellStyle(0).color).not.toBe(xrayShellStyle(1).color);
  });

  it('uses a single shared material for many meshes', () => {
    const effects = new ViewEffects();
    const { root, meshes } = rootWithMeshes([
      new THREE.MeshStandardMaterial(),
      new THREE.MeshPhysicalMaterial(),
      new THREE.MeshStandardMaterial(),
    ]);
    effects.setRoot(root);

    effects.setXray(true);

    const shared = effects.sharedMaterial;
    expect(shared).not.toBeNull();
    for (const mesh of meshes) expect(mesh.material).toBe(shared);
    expect(new Set(meshes.map((mesh) => mesh.material)).size).toBe(1);
  });

  it('restores authored materials by reference, including one with transparency/depthWrite off', () => {
    const glass = new THREE.MeshPhysicalMaterial({
      transparent: true,
      opacity: 0.5,
      depthWrite: false,
    });
    const solid = new THREE.MeshStandardMaterial({ transparent: false, depthWrite: true });
    const effects = new ViewEffects();
    const { root, meshes } = rootWithMeshes([glass, solid]);
    effects.setRoot(root);

    effects.setXray(true);
    expect(meshes[0]!.material).toBe(effects.sharedMaterial);
    expect(meshes[1]!.material).toBe(effects.sharedMaterial);

    effects.setXray(false);

    // Identity, not equality: the old pass mutated values in place and forced depthWrite back on.
    expect(meshes[0]!.material).toBe(glass);
    expect(meshes[1]!.material).toBe(solid);
    expect(glass.transparent).toBe(true);
    expect(glass.opacity).toBe(0.5);
    expect(glass.depthWrite).toBe(false);
    expect(solid.depthWrite).toBe(true);
  });

  it('is idempotent — applying twice does not lose the captured original', () => {
    const authored = new THREE.MeshStandardMaterial();
    const effects = new ViewEffects();
    const { root, meshes } = rootWithMeshes([authored]);
    effects.setRoot(root);

    effects.setXray(true);
    effects.setXray(true);

    effects.setXray(false);
    expect(meshes[0]!.material).toBe(authored);
  });

  it('disposes the shell on a root swap and re-applies to the new model', () => {
    const effects = new ViewEffects();
    const first = rootWithMeshes([new THREE.MeshStandardMaterial()]);
    effects.setRoot(first.root);
    effects.setXray(true);
    const firstShell = effects.sharedMaterial!;
    const dispose = vi.spyOn(firstShell, 'dispose');

    const second = rootWithMeshes([
      new THREE.MeshStandardMaterial(),
      new THREE.MeshStandardMaterial(),
    ]);
    effects.setRoot(second.root);

    expect(dispose).toHaveBeenCalledTimes(1);
    expect(effects.xrayEnabled).toBe(true);
    const secondShell = effects.sharedMaterial;
    expect(secondShell).not.toBe(firstShell);
    for (const mesh of second.meshes) expect(mesh.material).toBe(secondShell);
  });

  it('re-tints the live shell when the backdrop changes', () => {
    const effects = new ViewEffects();
    const { root } = rootWithMeshes([new THREE.MeshStandardMaterial()]);
    effects.setRoot(root);
    effects.setXray(true);

    effects.setBackdrop(new THREE.Color(0x000000));
    const dark = effects.sharedMaterial!.color.getHex();
    effects.setBackdrop(new THREE.Color(0xffffff));
    const light = effects.sharedMaterial!.color.getHex();

    expect(dark).not.toBe(light);
  });
});

describe('explode through the controller — capture, animate, compose', () => {
  /** Two meshes so the model has a real radial layout (one alone sits at its own centre). */
  function radialRoot(): { root: THREE.Group; near: THREE.Mesh; far: THREE.Mesh } {
    const root = new THREE.Group();
    const near = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial());
    near.position.set(-5, 0, 0);
    const far = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial());
    far.position.set(5, 0, 0);
    root.add(near, far);
    return { root, near, far };
  }

  it('animates apart when toggled and settles at the captured target', () => {
    const effects = new ViewEffects();
    const { root, far } = radialRoot();
    effects.setRoot(root);

    effects.setExplode(true);
    expect(effects.explodeProgress).toBe(0);

    effects.advance(EXPLODE_DURATION / 2);
    effects.apply();
    const mid = far.position.x;
    expect(mid).toBeGreaterThan(5);

    effects.advance(EXPLODE_DURATION);
    // The frame loop rewrites the authored pose each frame; mirror that before the final apply.
    far.position.set(5, 0, 0);
    effects.apply();
    expect(effects.explodeProgress).toBe(1);
    const settled = far.position.x;
    expect(settled).toBeGreaterThan(mid);
  });

  it('composes with a per-frame pose write: the part ends at motionPose + delta', () => {
    const effects = new ViewEffects();
    const { root, far } = radialRoot();
    effects.setRoot(root);
    effects.setExplode(true);
    effects.advance(EXPLODE_DURATION); // progress 1

    // Measure the displacement the explode pass intends, from the authored rest.
    far.position.set(5, 0, 0);
    effects.apply();
    const delta = far.position.x - 5;

    // Now a motion writes a different pose on this frame; the explode must add to it.
    far.position.set(9, 2, 0);
    effects.apply();
    expect(far.position.x).toBeCloseTo(9 + delta, 6);
    expect(far.position.y).toBeCloseTo(2, 6);
  });

  it('returns exactly to the per-frame pose when collapsed', () => {
    const effects = new ViewEffects();
    const { root, far } = radialRoot();
    effects.setRoot(root);

    effects.setExplode(true);
    effects.advance(EXPLODE_DURATION);
    far.position.set(5, 0, 0);
    effects.apply();
    expect(far.position.x).toBeGreaterThan(5);

    effects.setExplode(false);
    effects.advance(EXPLODE_DURATION);
    expect(effects.explodeProgress).toBe(0);

    // The next frame's write stands alone — no residual displacement.
    far.position.set(5, 0, 0);
    effects.apply();
    expect(far.position.x).toBe(5);
  });
});
