/**
 * The WebGL context-recovery contract.
 *
 * The audit found the recovery theatre: a `RESOURCE_TEXTURES` set declared in the worker, iterated
 * on `webglcontextrestored`, and populated by *nothing* — so the loop marked zero textures while
 * the UI claimed "Graphics memory restored — the model is back", and `renderer.render` kept
 * running against the dead context the whole time. A false recovery message is worse than an honest
 * failure; the only fix that keeps the message is making the recovery real.
 *
 * This module holds the parts that can be tested without a GPU: what counts as a resource the
 * context loss destroyed (a texture reachable from any material channel on any part), and what
 * re-establishing it means (`needsUpdate`, which forces the renderer to re-upload from the CPU
 * copy that survives). The worker populates its set at the model swap and drains it on restore.
 */
import * as THREE from 'three';

/**
 * Every material channel that may hold a texture.
 *
 * A closed list rather than reflection over the material: the channels are part of the scene API's
 * contract with the renderer, and a list here is greppable, testable, and cannot silently acquire
 * a private Three.js internal that happens to be named like a map.
 */
const MATERIAL_MAP_CHANNELS: readonly string[] = [
  'map',
  'normalMap',
  'roughnessMap',
  'metalnessMap',
  'aoMap',
  'emissiveMap',
  'alphaMap',
  'bumpMap',
  'displacementMap',
  'specularMap',
  'envMap',
];

/** True when a value is an actual texture, not an unset (or exotic) channel value. */
const isTexture = (value: unknown): value is THREE.Texture =>
  value instanceof THREE.Texture || (value as { isTexture?: boolean })?.isTexture === true;

/**
 * Collect every texture reachable from the model's materials into `into`.
 *
 * Walks the realized graph once per model load — swap time, not frame time — and fills the banked
 * set the restore handler drains. Holes (meshes without materials, array slots that are null) are
 * expected and skipped; a model with thirty parts and no textures banks nothing.
 */
export function collectModelTextures(
  root: THREE.Object3D,
  into: Set<THREE.Texture> = new Set(),
): Set<THREE.Texture> {
  root.traverse((object: THREE.Object3D) => {
    const material = (object as THREE.Mesh).material;
    if (!material) return;
    const materials = Array.isArray(material) ? material : [material];
    for (const single of materials) {
      if (!single) continue;
      const source = single as unknown as Record<string, unknown>;
      for (const channel of MATERIAL_MAP_CHANNELS) {
        const texture = source[channel];
        if (isTexture(texture)) into.add(texture);
      }
    }
  });
  return into;
}

/**
 * Force every banked texture to re-upload on the next render.
 *
 * The context's GPU-side copies died with it; the CPU-side image data did not. `needsUpdate` is
 * the renderer's own contract for "this GPU resource is stale — upload it again", which is all a
 * restoration cost the scene API actually controls.
 */
export function reuploadTextures(textures: Iterable<THREE.Texture | null | undefined>): void {
  for (const texture of textures) {
    if (!texture) continue;
    texture.needsUpdate = true;
  }
}
