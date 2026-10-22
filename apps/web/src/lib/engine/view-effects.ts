/**
 * X-ray and Explode — the two scene-inspection modes the viewer's toolbar drives.
 *
 * WHY THIS EXISTS AS ITS OWN MODULE
 * Both modes are scene-graph operations with real resource-lifetime and frame-order
 * consequences, and both were previously inline in `sandbox-worker.ts` where they were hard to
 * test and, in the case of x-ray, wrong in three separate ways. This module owns one correct
 * implementation of each; the maths is pure and runs in Node, the material/object plumbing uses
 * Three and runs where the GPU does.
 *
 * THE TWO RULES THE OLD INLINE CODE BROKE (and this module exists to keep broken):
 *
 *  1. **X-ray is a material swap, not a material mutation.** The old pass wrote
 *     `transparent/opacity/depthWrite` onto each mesh's *authored* material in place — so it kept
 *     every part's own colour (a dark metal part stayed dark and the result was a muddle rather
 *     than a blueprint), it never set `side` (interior structure was z-culled instead of reading
 *     through the shell), and its exit path wrote `depthWrite = true` onto *every* material,
 *     silently rewriting the authored material of a part that legitimately had depth writes off
 *     (glass, fluid). Here one shared `MeshPhysicalMaterial` — double-sided, depth-write off, one
 *     blueprint colour — is swapped over the meshes by traversal and the originals are restored by
 *     reference on exit. The authored material is never touched, so a part that keeps
 *     `transparent`/`depthWrite` off comes back byte-for-byte.
 *
 *  2. **Explode is an animated world-space displacement composed after the motions.** The old
 *     pass was `position = base + direction * 0.35`, applied once on toggle: it snapped, it was
 *     overwritten on the next frame by the motion applicator and guest `onFrame` (which write part
 *     poses every frame), it ignored model size (a 0.2 m board and a 40 m engine both moved 0.35
 *     units), and it mixed parent space (`object.position`) with world space (the centre), so any
 *     nested subassembly flew off in the wrong direction. Here the per-part `{rest, target}` is
 *     captured once per model in *parent* space (the world target transformed back through the
 *     parent's inverse world matrix), the travel is derived from the world bounding box, and the
 *     per-frame work is a single `delta * progress` added *after* the motions have written their
 *     poses — so a part that is animated can both move and explode.
 *
 * Idempotence is part of the contract: applying x-ray twice is a no-op, and a root swap releases
 * everything the old root referred to before re-binding to the new one.
 */
import * as THREE from 'three';

/** Seconds the explode transition takes; `easeInOutCubic` over this reads as deliberate motion. */
export const EXPLODE_DURATION = 1.1;

/** How translucently the shell reads. Low enough to see through, high enough to read as a surface. */
const XRAY_OPACITY = 0.28;

/** A low roughness keeps the shell from blooming into a highlight that hides the structure behind it. */
const XRAY_ROUGHNESS = 0.35;

/** Fraction of the model's largest dimension a part travels from the base term alone. */
const BASE_TRAVEL_FRACTION = 0.35;

/** Extra travel per unit of radial distance, so outer parts separate further than inner ones. */
const RADIAL_TRAVEL_FRACTION = 0.85;

/**
 * An authored `explodeOffset` at least this fraction of the model's scale is a deliberate metric
 * spread and keeps its own length; anything shorter is only trusted for its *direction*.
 */
const AUTHORED_LENGTH_FRACTION = 0.1;

/** Below this length a radial vector is "at the centre" and gets the deterministic fallback. */
const RADIAL_EPSILON = 1e-4;

/** Below this length an authored direction is meaningless and is ignored. */
const DIRECTION_EPSILON = 1e-8;

/** The direction a part exactly at the centre is pushed, so it separates deterministically. */
const CENTRE_DIRECTION: Vec3Like = { x: 0, y: 1, z: 0 };

/** Column-major identity, used when a part has no parent (root-level parts). */
const IDENTITY_MATRIX: readonly number[] = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

/** A three-component vector. Read-only inputs, plain-object outputs — never a Three dependency. */
export interface Vec3Like {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/** A mutable three-component vector: a Three `Vector3` satisfies this structurally. */
export interface MutableVec3 {
  x: number;
  y: number;
  z: number;
}

/** Column-major 4×4 elements, the layout of `THREE.Matrix4.elements`. */
export type Mat4Like = ArrayLike<number>;

/** One part's explode input, gathered from the realized scene and its manifest node. */
export interface ExplodeSource {
  /** Stable key within one capture pass (the caller's part id or any unique string). */
  id: string;
  /** The part's world-space position in the assembled model. */
  worldPosition: Vec3Like;
  /** The parent's world matrix; identity when the part sits directly under the root. */
  parentWorldMatrix: Mat4Like;
  /** The part's parent-space position at capture — the pose a zero-progress frame keeps. */
  rest: Vec3Like;
  /** The authored direction, when the part declared one; null otherwise. */
  explodeOffset?: readonly number[] | null;
}

/** The assembled model's world-space bounds. */
export interface BoundsLike {
  center: Vec3Like;
  size: Vec3Like;
}

/** A part's captured explode pose. `delta = target - rest` is the displacement added per frame. */
export interface ExplodePose {
  rest: Vec3Like;
  target: Vec3Like;
  delta: Vec3Like;
}

/** The explode transition's clock: where it came from, where it is going, and how far it is. */
export interface ExplodeClock {
  active: boolean;
  elapsed: number;
  from: number;
  to: number;
  progress: number;
}

/** A settled, assembled clock. Shared because it is never mutated. */
export const IDLE_EXPLODE: ExplodeClock = {
  active: false,
  elapsed: 0,
  from: 0,
  to: 0,
  progress: 0,
};

/* ------------------------------------------------------------------ */
/* Pure maths — no Three, no DOM, Node-testable                       */
/* ------------------------------------------------------------------ */

/** Cubic ease-in-out: slow out of the endpoints, quick through the middle. */
export function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

/**
 * Relative luminance of a linear-space colour.
 *
 * The backdrop arrives from `THREE.Color`, whose channels are already linear (the theme's sRGB hex
 * was converted by `setStyle(..., SRGBColorSpace)`), so the physical coefficients apply directly.
 */
export function relativeLuminance(r: number, g: number, b: number): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * Derive the x-ray shell colour from the backdrop's luminance.
 *
 * The rule, stated once so both themes are readable by the same material: **a light shell over a
 * dark backdrop, a deeper one over a light backdrop.** On the dark theme's near-black backdrop a
 * pale cyan glows against the void; on the light theme's near-white backdrop that same pale cyan
 * would vanish, so the shell deepens toward blue to hold its edge. The threshold sits at 0.5
 * because the two theme tops are near-black and near-white, nowhere near the midpoint.
 */
export function xrayShellStyle(backdropLuminance: number): { color: number; emissive: number } {
  return backdropLuminance < 0.5
    ? { color: 0x7fd4ff, emissive: 0x0a2b3a }
    : { color: 0x1f618d, emissive: 0x08202e };
}

/**
 * How far a part travels at full separation.
 *
 * `scale * 0.35` gives every part a baseline separation proportional to the model, and the
 * `radial * 0.85` term makes outer parts travel further than inner ones — a uniform puff hides the
 * structure, whereas growing separation reads as an exploded assembly.
 */
export function computeTravel(scale: number, radial: number, spread: number): number {
  return (scale * BASE_TRAVEL_FRACTION + radial * RADIAL_TRAVEL_FRACTION) * spread;
}

/** Read one element of a possibly-undefined-indexed matrix without leaking `undefined` arithmetic. */
function at(elements: Mat4Like, index: number): number {
  return elements[index] as number;
}

/** Transform a point (w = 1) by a column-major 4×4 matrix, dividing through by w when it is not 1. */
export function applyMatrix4(m: Mat4Like, point: Vec3Like): Vec3Like {
  const x = point.x;
  const y = point.y;
  const z = point.z;

  const w = at(m, 3) * x + at(m, 7) * y + at(m, 11) * z + at(m, 15);
  const scale = w === 0 || w === 1 ? 1 : 1 / w;

  return {
    x: (at(m, 0) * x + at(m, 4) * y + at(m, 8) * z + at(m, 12)) * scale,
    y: (at(m, 1) * x + at(m, 5) * y + at(m, 9) * z + at(m, 13)) * scale,
    z: (at(m, 2) * x + at(m, 6) * y + at(m, 10) * z + at(m, 14)) * scale,
  };
}

/** Invert a column-major 4×4 matrix; a singular matrix falls back to identity rather than NaN. */
export function invertMatrix4(m: Mat4Like): number[] {
  const a00 = at(m, 0);
  const a01 = at(m, 1);
  const a02 = at(m, 2);
  const a03 = at(m, 3);
  const a10 = at(m, 4);
  const a11 = at(m, 5);
  const a12 = at(m, 6);
  const a13 = at(m, 7);
  const a20 = at(m, 8);
  const a21 = at(m, 9);
  const a22 = at(m, 10);
  const a23 = at(m, 11);
  const a30 = at(m, 12);
  const a31 = at(m, 13);
  const a32 = at(m, 14);
  const a33 = at(m, 15);

  const b00 = a00 * a11 - a01 * a10;
  const b01 = a00 * a12 - a02 * a10;
  const b02 = a00 * a13 - a03 * a10;
  const b03 = a01 * a12 - a02 * a11;
  const b04 = a01 * a13 - a03 * a11;
  const b05 = a02 * a13 - a03 * a12;
  const b06 = a20 * a31 - a21 * a30;
  const b07 = a20 * a32 - a22 * a30;
  const b08 = a20 * a33 - a23 * a30;
  const b09 = a21 * a32 - a22 * a31;
  const b10 = a21 * a33 - a23 * a31;
  const b11 = a22 * a33 - a23 * a32;

  const determinant = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
  if (determinant === 0) return [...IDENTITY_MATRIX];
  const inv = 1 / determinant;

  return [
    (a11 * b11 - a12 * b10 + a13 * b09) * inv,
    (a02 * b10 - a01 * b11 - a03 * b09) * inv,
    (a31 * b05 - a32 * b04 + a33 * b03) * inv,
    (a22 * b04 - a21 * b05 - a23 * b03) * inv,
    (a12 * b08 - a10 * b11 - a13 * b07) * inv,
    (a00 * b11 - a02 * b08 + a03 * b07) * inv,
    (a32 * b02 - a30 * b05 - a33 * b01) * inv,
    (a20 * b05 - a22 * b02 + a23 * b01) * inv,
    (a10 * b10 - a11 * b08 + a13 * b06) * inv,
    (a01 * b08 - a00 * b10 - a03 * b06) * inv,
    (a30 * b04 - a31 * b02 + a33 * b00) * inv,
    (a21 * b02 - a20 * b04 - a23 * b00) * inv,
    (a11 * b07 - a10 * b09 - a12 * b06) * inv,
    (a00 * b09 - a01 * b07 + a02 * b06) * inv,
    (a31 * b01 - a30 * b03 - a32 * b00) * inv,
    (a20 * b03 - a21 * b01 + a22 * b00) * inv,
  ];
}

/**
 * Capture the explode pose for every part.
 *
 * `rest` is the part's parent-space position at capture; `target` is the world-space separation
 * transformed back through the parent's inverse world matrix, so a mesh nested inside a rotated
 * subassembly explodes radially in world terms rather than in whatever direction its parent happens
 * to be facing. `delta` is the difference the frame loop adds — the frame loop adds it *after* the
 * motions instead of overwriting `position`, which is what lets a moving part also explode.
 */
export function captureExplodePoses(
  sources: readonly ExplodeSource[],
  bounds: BoundsLike,
  spread = 1,
): Map<string, ExplodePose> {
  const poses = new Map<string, ExplodePose>();
  const scale = Math.max(bounds.size.x, bounds.size.y, bounds.size.z) || 1;
  const authoredThreshold = scale * AUTHORED_LENGTH_FRACTION;
  const { center } = bounds;

  for (const source of sources) {
    const rx = source.worldPosition.x - center.x;
    const ry = source.worldPosition.y - center.y;
    const rz = source.worldPosition.z - center.z;
    const radial = Math.hypot(rx, ry, rz);

    const authored = source.explodeOffset;
    const authoredLength = authored
      ? Math.hypot(authored[0] ?? 0, authored[1] ?? 0, authored[2] ?? 0)
      : 0;

    let dx: number;
    let dy: number;
    let dz: number;
    let travel: number;

    if (authored && authoredLength > DIRECTION_EPSILON) {
      const inv = 1 / authoredLength;
      dx = (authored[0] ?? 0) * inv;
      dy = (authored[1] ?? 0) * inv;
      dz = (authored[2] ?? 0) * inv;
      // An authored offset long enough to be a metric distance keeps its length; a short one is
      // only a direction and borrows the computed travel.
      travel =
        authoredLength >= authoredThreshold ? authoredLength : computeTravel(scale, radial, spread);
    } else if (radial > RADIAL_EPSILON) {
      const inv = 1 / radial;
      dx = rx * inv;
      dy = ry * inv;
      dz = rz * inv;
      travel = computeTravel(scale, radial, spread);
    } else {
      dx = CENTRE_DIRECTION.x;
      dy = CENTRE_DIRECTION.y;
      dz = CENTRE_DIRECTION.z;
      travel = computeTravel(scale, radial, spread);
    }

    const parentInverse = invertMatrix4(source.parentWorldMatrix);
    const target = applyMatrix4(parentInverse, {
      x: source.worldPosition.x + dx * travel,
      y: source.worldPosition.y + dy * travel,
      z: source.worldPosition.z + dz * travel,
    });
    const rest: Vec3Like = { x: source.rest.x, y: source.rest.y, z: source.rest.z };

    poses.set(source.id, {
      rest,
      target,
      delta: { x: target.x - rest.x, y: target.y - rest.y, z: target.z - rest.z },
    });
  }

  return poses;
}

/**
 * Add the explode displacement to a live position.
 *
 * This is the composition rule in one function: the motions (and guest `onFrame`) have already
 * written the pose, and the explode pass *adds* `delta * progress` so the two compose instead of
 * competing. At `progress === 0` the addition is exactly zero, which is what makes a settled
 * collapse return to the authored rest with no drift across repeated cycles.
 */
export function applyExplodeDelta(position: MutableVec3, delta: Vec3Like, progress: number): void {
  if (progress === 0) return;
  position.x += delta.x * progress;
  position.y += delta.y * progress;
  position.z += delta.z * progress;
}

/**
 * Aim the explode clock at `to` (1 = apart, 0 = together), starting from wherever it is now.
 *
 * `from` is the live progress, not the last endpoint, which is what makes a mid-flight reversal
 * smooth: the clock carries on from the pose on screen rather than jumping.
 */
export function startExplode(clock: ExplodeClock, to: number): ExplodeClock {
  const target = to >= 1 ? 1 : 0;
  if (!clock.active && clock.progress === target) return clock;
  return { active: true, elapsed: 0, from: clock.progress, to: target, progress: clock.progress };
}

/**
 * Advance the explode clock by `dt` seconds.
 *
 * Progress is `from + (to - from) * eased`, so the ease applies to the *remaining* distance on a
 * reversal. On completion it snaps to `to` exactly — the exact endpoint is what stops accumulated
 * float error from drifting a cycle.
 */
export function advanceExplode(clock: ExplodeClock, dt: number, duration: number): ExplodeClock {
  if (!clock.active) return clock;

  const elapsed = clock.elapsed + Math.max(0, dt);
  const t = duration > 0 ? Math.min(1, elapsed / duration) : 1;
  const eased = easeInOutCubic(t);

  if (t >= 1) {
    return { active: false, elapsed, from: clock.from, to: clock.to, progress: clock.to };
  }
  return {
    active: true,
    elapsed,
    from: clock.from,
    to: clock.to,
    progress: clock.from + (clock.to - clock.from) * eased,
  };
}

/* ------------------------------------------------------------------ */
/* The controller — the Three-side plumbing                           */
/* ------------------------------------------------------------------ */

/** Is this object a mesh whose material the x-ray pass may swap? InstancedMesh is a Mesh. */
function isSwappableMesh(object: THREE.Object3D): object is THREE.Mesh {
  return (object as THREE.Mesh).isMesh === true;
}

/**
 * Owns the live state of both modes for one model.
 *
 * One instance lives on the worker; `setRoot` re-binds it to each new model and releases everything
 * the previous one referred to. Sticky flags (`xray`, `exploded`) survive a swap so an inspection
 * mode stays on across a generate, and re-apply to the new root.
 */
export class ViewEffects {
  private readonly explodeDuration: number;
  private root: THREE.Object3D | null = null;

  private xray = false;
  private xrayMaterial: THREE.MeshPhysicalMaterial | null = null;
  /** Authored materials held by object, so exit restores each reference exactly — never a value. */
  private originalMaterials = new Map<THREE.Object3D, THREE.Material | THREE.Material[]>();
  private backdropLuminance = 0;

  private explodeTargets: Array<{ object: THREE.Object3D; delta: Vec3Like }> = [];
  private clock: ExplodeClock = IDLE_EXPLODE;
  private isExploded = false;

  constructor(options: { explodeDuration?: number } = {}) {
    this.explodeDuration = options.explodeDuration ?? EXPLODE_DURATION;
  }

  /* ---- lifecycle ---- */

  /**
   * Bind to a model (or null on teardown) and re-apply any sticky mode.
   *
   * Everything the previous root referred to is dropped first: the shared material is disposed and
   * the captured poses cleared. `offsetOf` resolves a part's authored `explodeOffset` from the
   * realized object; the worker supplies it because only the worker holds the manifest.
   */
  setRoot(
    root: THREE.Object3D | null,
    offsetOf?: (object: THREE.Object3D) => readonly number[] | null,
  ): void {
    this.release();
    this.root = root;
    if (!root) return;

    this.captureExplode(root, offsetOf);
    if (this.xray) this.applyXray();
    // A logically-exploded model opens on arrival rather than snapping: a fresh capture always
    // starts at rest, so animating 0 → 1 is both correct and the better read.
    if (this.isExploded) this.clock = startExplode(this.clock, 1);
  }

  /** Tell the controller the current backdrop, so a live x-ray shell re-tints for the theme. */
  setBackdrop(color: THREE.Color): void {
    this.backdropLuminance = relativeLuminance(color.r, color.g, color.b);
    if (!this.xrayMaterial) return;
    const style = xrayShellStyle(this.backdropLuminance);
    this.xrayMaterial.color.setHex(style.color);
    this.xrayMaterial.emissive.setHex(style.emissive);
  }

  /* ---- x-ray ---- */

  get xrayEnabled(): boolean {
    return this.xray;
  }

  /** The shared shell material, exposed for tests and diagnostics. Null before first entry. */
  get sharedMaterial(): THREE.MeshPhysicalMaterial | null {
    return this.xrayMaterial;
  }

  /** Enter or leave x-ray. Idempotent: a repeated call in the same direction does nothing. */
  setXray(enabled: boolean): void {
    const next = Boolean(enabled);
    if (next === this.xray) return;
    this.xray = next;
    if (next) this.applyXray();
    else this.restoreMaterials();
  }

  /* ---- explode ---- */

  get exploded(): boolean {
    return this.isExploded;
  }

  get explodeProgress(): number {
    return this.clock.progress;
  }

  /** Begin an explode transition (apart or together). A repeat in the same settled direction is a no-op. */
  setExplode(enabled: boolean): void {
    const next = Boolean(enabled);
    if (next === this.isExploded && !this.clock.active) return;
    this.isExploded = next;
    this.clock =
      this.explodeTargets.length > 0 ? startExplode(this.clock, next ? 1 : 0) : IDLE_EXPLODE;
  }

  /**
   * Advance the transition. Returns true when it moved this frame — including the frame that
   * completes it, so the caller marks that frame dirty and the final pose is presented.
   */
  advance(deltaSeconds: number): boolean {
    if (!this.clock.active) return false;
    this.clock = advanceExplode(this.clock, deltaSeconds, this.explodeDuration);
    return true;
  }

  /**
   * Compose the current explode displacement onto every captured part. Called *after* the motions
   * and the transform sync have written their poses, so it adds to them rather than fighting them.
   */
  apply(): void {
    const { progress } = this.clock;
    if (progress === 0) return;
    for (const { object, delta } of this.explodeTargets) {
      applyExplodeDelta(object.position, delta, progress);
    }
  }

  /** Full teardown: release the current model and clear the sticky flags. */
  dispose(): void {
    this.release();
    this.xray = false;
    this.isExploded = false;
    this.clock = IDLE_EXPLODE;
    this.root = null;
  }

  /* ---- internals ---- */

  /**
   * Drop per-root state without touching the caller's mode flags.
   *
   * The old root has already been disposed by the worker when this runs, so the authored materials
   * are *not* written back — writing to a disposed object is exactly the stale-reference bug this
   * design avoids. The references are simply dropped, and the shared material is released.
   */
  private release(): void {
    this.originalMaterials.clear();
    if (this.xrayMaterial) {
      this.xrayMaterial.dispose();
      this.xrayMaterial = null;
    }
    this.explodeTargets = [];
    this.clock = IDLE_EXPLODE;
  }

  /** Swap the shared shell over every mesh, remembering each authored material by reference. */
  private applyXray(): void {
    if (!this.root) return;
    const material = this.ensureXrayMaterial();
    this.root.traverse((object) => {
      if (!isSwappableMesh(object)) return;
      if (!this.originalMaterials.has(object)) this.originalMaterials.set(object, object.material);
      object.material = material;
    });
  }

  /** Put every authored material back by reference — the model's own material, untouched. */
  private restoreMaterials(): void {
    for (const [object, material] of this.originalMaterials) {
      (object as THREE.Mesh).material = material;
    }
    this.originalMaterials.clear();
  }

  /** One shared physical material for the whole scene, coloured for the current backdrop. */
  private ensureXrayMaterial(): THREE.MeshPhysicalMaterial {
    if (this.xrayMaterial) return this.xrayMaterial;
    const style = xrayShellStyle(this.backdropLuminance);
    this.xrayMaterial = new THREE.MeshPhysicalMaterial({
      color: style.color,
      transparent: true,
      opacity: XRAY_OPACITY,
      // Double-sided with depth writing off is what lets interior structure read through the shell
      // instead of being z-culled by the outer surface.
      side: THREE.DoubleSide,
      depthWrite: false,
      roughness: XRAY_ROUGHNESS,
      metalness: 0,
      emissive: style.emissive,
      emissiveIntensity: 0.4,
    });
    return this.xrayMaterial;
  }

  /**
   * Capture the assembled model's world bounds and each mesh's explode pose.
   *
   * Only renderable meshes are captured: a group that contains other captured meshes would move its
   * children twice (once for itself, once for each child), so the leaf geometry is what explodes
   * and the groups it hangs from stay put.
   */
  private captureExplode(
    root: THREE.Object3D,
    offsetOf?: (object: THREE.Object3D) => readonly number[] | null,
  ): void {
    root.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(root);
    if (box.isEmpty()) return;

    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());

    const sources: ExplodeSource[] = [];
    const byId = new Map<string, THREE.Object3D>();
    let index = 0;

    root.traverse((object) => {
      if (!isSwappableMesh(object)) return;
      const id = `part-${index}`;
      index += 1;
      byId.set(id, object);
      sources.push({
        id,
        worldPosition: object.getWorldPosition(new THREE.Vector3()),
        parentWorldMatrix: object.parent ? object.parent.matrixWorld.elements : IDENTITY_MATRIX,
        rest: object.position,
        explodeOffset: offsetOf?.(object) ?? null,
      });
    });

    const poses = captureExplodePoses(sources, { center, size });
    this.explodeTargets = sources.flatMap((source) => {
      const pose = poses.get(source.id);
      const object = byId.get(source.id);
      return pose && object ? [{ object, delta: pose.delta }] : [];
    });
  }
}
