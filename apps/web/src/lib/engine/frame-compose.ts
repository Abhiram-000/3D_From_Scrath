/**
 * The per-frame pose plumbing the sandbox worker delegates to, extracted so it can be tested.
 *
 * The worker's hot path had two allocation fountains hiding in plain sight: the pre-frame reset
 * replaced three arrays per motion-driven part per frame, and the transform sync rebuilt its
 * arguments with spreads (`set(...triple)`). Both now write by components into objects that
 * already exist. The functions here are pure with respect to their inputs and hold no state, so
 * the stubs in the test exercise the same contract the realized `THREE.Object3D`s happen to
 * satisfy structurally — no three import, no DOM, Node-runnable.
 */
import type { ModelManifest } from '@edu3d/contracts';
import type { PartTransformLike } from '@edu3d/engine';

/** The transform surface the applicator reads and the reset writes; the worker's parts use it. */
export interface TransformHolder {
  transform: PartTransformLike;
}

/** What the renderer object must expose for the sync — a structural slice of `THREE.Object3D`. */
export interface SyncableObject {
  position: { x: number; y: number; z: number };
  rotation: { x: number; y: number; z: number } | undefined;
  scale: { x: number; y: number; z: number };
  visible: boolean;
  /**
   * Deliberately `unknown`: a realized object's material is `Material | Material[]`, and the
   * channels this sync touches exist only on the standard/physical archetypes. The `'in'` guard
   * below is what the original `instanceof Mesh || instanceof InstancedMesh` check was doing by
   * class — a basic material simply has no emissive to set.
   */
  material?: unknown;
}

/**
 * Whether this frame is allowed to be empty.
 *
 * The on-demand rule (`08`, "a paused model renders a static image 60 times a second at full cost"
 * is the disease): a frame does work only when something can have changed — the model runs, the
 * idle orbit spins, a gesture landed, an inspection invalidation fired. Everything else is a
 * presented frame that costs nothing. The flags are cold facts about the state at the top of the
 * tick; the caller still publishes stats so the watchdog sees the liveness it keys on.
 */
export interface RenderGateInput {
  paused: boolean;
  autoRotate: boolean;
  cameraDirty: boolean;
  needsRender: boolean;
}

export function renderGate(s: RenderGateInput): boolean {
  return !s.paused || s.autoRotate || s.cameraDirty || s.needsRender;
}

/**
 * Copy each motion-driven part's authored base into the live transform it already holds — in place.
 *
 * The array-identity contract is deliberate: assigning `live.position = [...base.position]` read
 * the base and allocated three fresh triples per part per frame, which is churn the GC bills every
 * second the model runs. Callers that need their own copy make one; the reset itself never does.
 * Parts without `runsWhilePaused` keep their frame pose while the model is paused — that is what
 * "paused but still inspectable" means at this layer, and the set makes it one lookup instead of
 * a per-motion scan.
 */
export function resetMotionDriven(
  bases: ReadonlyMap<string, PartTransformLike>,
  live: ReadonlyMap<string, TransformHolder | undefined>,
  runsWhilePausedParts: ReadonlySet<string>,
  paused: boolean,
): void {
  for (const [partId, base] of bases) {
    if (paused && !runsWhilePausedParts.has(partId)) continue;
    const holder = live.get(partId);
    const transform = holder?.transform;
    if (!transform) continue;

    copyInto(transform.position, base.position);
    if (transform.rotation !== undefined) {
      if (base.rotation) copyInto(transform.rotation, base.rotation);
      else transform.rotation = undefined;
    } else if (base.rotation) {
      transform.rotation = [...base.rotation];
    }
    copyInto(transform.scale, base.scale);
  }
}

/** A rotation that is authored-absent resets to absent: an empty Euler is not the authored base. */

function copyInto(target: PartTransformLike['position'], source: readonly number[]): void {
  const x = source[0];
  const y = source[1];
  const z = source[2];
  if (x !== undefined) target[0] = x;
  if (y !== undefined) target[1] = y;
  if (z !== undefined) target[2] = z;
}

/**
 * Copy every realized part's manifest transform onto its renderer object, component-wise.
 *
 * Only the channels the scene API exposes per frame are pushed — position, the three Euler
 * components, scale, visibility, and the two material channels (emissive intensity, opacity).
 * Physics-driven parts are skipped here by the caller: their solver pose arrives through the
 * simulated map, whose values the caller passes in to keep this function free of worker state.
 */
export function syncTransforms(
  model: ReadonlyMap<string, SyncableObject>,
  parts: ModelManifest['parts'],
): void {
  for (const node of parts) {
    const object = model.get(node.id);
    if (!object) continue;

    const { position, rotation, scale } = node.transform;
    const target = object.position;
    target.x = position[0];
    target.y = position[1];
    target.z = position[2];

    if (object.rotation !== undefined && rotation !== undefined) {
      // By components, not `set(...rotation)`: same setters Euler's own `.set` calls, minus the
      // arguments array. (A realized Object3D's rotation is never assigned away — only its
      // components change; an authored-absent rotation resets in `resetMotionDriven`, on the
      // manifest side where the array semantics belong.)
      object.rotation.x = rotation[0];
      object.rotation.y = rotation[1];
      object.rotation.z = rotation[2];
    }

    object.scale.x = scale[0];
    object.scale.y = scale[1];
    object.scale.z = scale[2];
    object.visible = node.visible;

    const nodeMaterial = node.material;
    const material = object.material as
      { emissiveIntensity?: number; opacity?: number } | undefined;
    if (nodeMaterial && material && 'emissiveIntensity' in material && 'opacity' in material) {
      if (nodeMaterial.emissiveIntensity !== undefined) {
        material.emissiveIntensity = nodeMaterial.emissiveIntensity;
      }
      if (nodeMaterial.opacity !== undefined) {
        material.opacity = nodeMaterial.opacity;
      }
    }
  }
}
