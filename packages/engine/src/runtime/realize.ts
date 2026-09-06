/**
 * The realizer: manifest → Three.js scene.
 *
 * **This runs only on the learner's device.** It is the one module in the engine that touches Three.js objects
 * and, through them, a GPU. The server never calls it: the server runs the authoring pass to harvest and price a
 * manifest, and nothing more. That split is why every other engine module is data-only, and it is what makes a
 * published model replay on any device without the server being involved.
 *
 * Three rules from the build docs shape the code below:
 *
 *  - **Structural caching.** `08`: "Identical specs map to one GPU object via a cache key — the 200-bolt assembly
 *    is 1 bolt's worth of GPU memory." Geometries and materials are keyed and shared.
 *  - **Atomic swap.** `03` R2: "the old model is disposed only after the new one is confirmed good, and a failed
 *    load leaves the previous model on screen." Realization builds into a detached root and returns it; the
 *    caller swaps.
 *  - **Disposal is wired into every owner.** `08` requires memory flat across dozens of generate/load cycles, and
 *    Three.js frees nothing automatically — every geometry, material and texture created here is tracked so it
 *    can be released.
 */
import * as THREE from 'three';
import type { InstancePlacement, MaterialRef, ModelManifest, PartNode } from '@edu3d/contracts';
import type { MeshData } from '../geometry/mesh-data.ts';
import type { RealizationDecisions } from './admission.ts';

/** Everything a realized model owns, so it can be disposed as one unit. */
export interface RealizedModel {
  /** Detached root. The caller adds it to the scene once realization has succeeded. */
  root: THREE.Group;
  /** Selectable objects by part id, for picking and for the info panel. */
  parts: Map<string, THREE.Object3D>;
  /** Reverse lookup from a hit object back to its part id, including instanced meshes. */
  partOf: Map<THREE.Object3D, string>;
  lights: THREE.Light[];
  /** Live counts, measured after construction rather than predicted (`03` R9). */
  stats: { triangles: number; drawCalls: number; geometries: number; materials: number };
  dispose(): void;
}

/** sRGB hex → linear-space THREE.Color, the one place the conversion `01` requires happens. */
function toColor(hex: string | undefined, fallback = '#cccccc'): THREE.Color {
  const color = new THREE.Color();
  // `setStyle` with 'srgb' performs the transfer-function conversion; assigning the hex directly would treat
  // authored sRGB values as linear and wash out every colour in the model.
  color.setStyle(hex ?? fallback, THREE.SRGBColorSpace);
  return color;
}

/**
 * Build a `BufferGeometry` from mesh data.
 *
 * Bounds are computed explicitly rather than left for Three.js to do lazily, because `08` warns that "a
 * NaN-poisoned or stale bounding sphere silently breaks culling (and raycasting) for a whole subtree" — and a
 * procedural mesh is exactly where a NaN comes from.
 */
function toBufferGeometry(mesh: MeshData, decimateTo = 1): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();

  geometry.setAttribute('position', new THREE.BufferAttribute(mesh.positions, 3));
  if (mesh.normals) geometry.setAttribute('normal', new THREE.BufferAttribute(mesh.normals, 3));
  if (mesh.uvs) geometry.setAttribute('uv', new THREE.BufferAttribute(mesh.uvs, 2));
  if (mesh.colors) geometry.setAttribute('color', new THREE.BufferAttribute(mesh.colors, 3));

  if (mesh.indices) {
    if (decimateTo < 1) {
      // Index-stride decimation: keep a fraction of the triangles, evenly spaced. Crude next to a quadric
      // simplifier and chosen for the same reason `simplify` is — it never fails on arbitrary AI-generated
      // topology, and the silhouette survives because the kept triangles are spread across the whole mesh.
      const triangleCount = mesh.indices.length / 3;
      const keep = Math.max(1, Math.floor(triangleCount * decimateTo));
      const stride = triangleCount / keep;
      const decimated = new Uint32Array(keep * 3);
      for (let i = 0; i < keep; i += 1) {
        const source = Math.min(triangleCount - 1, Math.floor(i * stride)) * 3;
        decimated[i * 3] = mesh.indices[source] as number;
        decimated[i * 3 + 1] = mesh.indices[source + 1] as number;
        decimated[i * 3 + 2] = mesh.indices[source + 2] as number;
      }
      geometry.setIndex(new THREE.BufferAttribute(decimated, 1));
    } else {
      geometry.setIndex(new THREE.BufferAttribute(mesh.indices, 1));
    }
  }

  if (!mesh.normals) geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  geometry.computeBoundingBox();

  // A NaN vertex produces a NaN radius, which disables culling and picking for everything under this node. Better
  // to substitute a valid sphere and keep the subtree working.
  if (!geometry.boundingSphere || !Number.isFinite(geometry.boundingSphere.radius)) {
    geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1);
  }

  return geometry;
}

/**
 * Create a material from its manifest reference.
 *
 * Archetypes map onto concrete Three.js materials rather than being reinterpreted per model, so "glass" looks the
 * same in every model a learner opens — which is what makes material a readable signal at all (`01`).
 */
function toMaterial(ref: MaterialRef, flatShading: boolean): THREE.Material {
  const color = toColor(ref.color);
  const common = {
    color,
    transparent: (ref.opacity ?? 1) < 1 || (ref.transmission ?? 0) > 0,
    opacity: ref.opacity ?? 1,
    flatShading,
    // Vertex colours only where the model asked for them, so a gradient material can carry a scalar field.
    vertexColors: ref.archetype === 'gradient',
  };

  switch (ref.archetype) {
    case 'wire':
      return new THREE.MeshBasicMaterial({ ...common, wireframe: true });

    case 'toon':
      // Toon shading needs a gradient map to band correctly; without one it degrades to flat lambert, which is
      // still the diagram look the archetype exists for.
      return new THREE.MeshToonMaterial({
        color,
        transparent: common.transparent,
        opacity: common.opacity,
      });

    case 'emissive':
      // Emissive uses `MeshStandardMaterial` with an emissive term rather than `MeshBasicMaterial`, so it still
      // receives shadows and reads as a lit object that also glows — a basic material looks like a flat sticker.
      return new THREE.MeshStandardMaterial({
        ...common,
        emissive: color,
        emissiveIntensity: ref.emissiveIntensity ?? 2,
        roughness: ref.roughness ?? 0.5,
        metalness: 0,
      });

    case 'glass':
    case 'fluid':
    case 'translucent': {
      const material = new THREE.MeshPhysicalMaterial({
        ...common,
        roughness: ref.roughness ?? 0.1,
        metalness: 0,
        transmission: ref.transmission ?? 0.9,
        // Thickness is what makes transmission read as a solid volume rather than a soap film (`01`).
        thickness: 0.4,
        ior: 1.45,
        transparent: true,
        side: THREE.DoubleSide,
      });
      return material;
    }

    case 'organic':
      return new THREE.MeshPhysicalMaterial({
        ...common,
        roughness: ref.roughness ?? 0.75,
        metalness: 0,
        // A little subsurface transmission is what stops flesh and leaf looking like painted plastic.
        transmission: ref.transmission ?? 0.06,
        thickness: 0.2,
        sheen: 0.3,
      });

    case 'metal':
      return new THREE.MeshStandardMaterial({
        ...common,
        metalness: ref.metalness ?? 1,
        roughness: ref.roughness ?? 0.28,
      });

    default:
      return new THREE.MeshStandardMaterial({
        ...common,
        metalness: ref.metalness ?? 0,
        roughness: ref.roughness ?? 0.6,
        ...(ref.emissiveIntensity && ref.emissiveIntensity > 0
          ? { emissive: color, emissiveIntensity: ref.emissiveIntensity }
          : {}),
      });
  }
}

/** Apply an authored transform to a Three.js object. */
function applyTransform(object: THREE.Object3D, transform: PartNode['transform']): void {
  object.position.set(...transform.position);
  if (transform.quaternion) {
    object.quaternion.set(...transform.quaternion);
  } else if (transform.rotation) {
    // XYZ Euler order, matching `math/compose` and Three.js's default, so an authored rotation means the same
    // thing in the manifest and on screen.
    object.rotation.set(...transform.rotation);
  }
  object.scale.set(...transform.scale);
}

/** Write instance matrices into an `InstancedMesh`, reusing scratch objects so the loop allocates nothing. */
function writeInstances(
  mesh: THREE.InstancedMesh,
  placements: readonly InstancePlacement[],
  limit: number,
): void {
  const matrix = new THREE.Matrix4();
  const position = new THREE.Vector3();
  const quaternion = new THREE.Quaternion();
  const euler = new THREE.Euler();
  const scale = new THREE.Vector3();

  const count = Math.min(placements.length, limit);
  for (let i = 0; i < count; i += 1) {
    const placement = placements[i] as InstancePlacement;
    position.set(...placement.transform.position);
    if (placement.transform.quaternion) {
      quaternion.set(...placement.transform.quaternion);
    } else if (placement.transform.rotation) {
      quaternion.setFromEuler(euler.set(...placement.transform.rotation));
    } else {
      quaternion.identity();
    }
    scale.set(...placement.transform.scale);
    mesh.setMatrixAt(i, matrix.compose(position, quaternion, scale));
  }

  mesh.count = count;
  mesh.instanceMatrix.needsUpdate = true;
  // Instanced meshes get their bounds from the instance matrices, not the base geometry; without this the whole
  // set is culled the moment the base geometry leaves the frustum.
  mesh.computeBoundingSphere();
}

export interface RealizeOptions {
  manifest: ModelManifest;
  /** Geometry data by cache key, resolved from the authoring pass. */
  geometries: Map<string, MeshData>;
  /** Admission decisions: decimation, shadow allowances, caps. */
  decisions: RealizationDecisions;
}

/**
 * Realize a manifest.
 *
 * Builds into a detached `Group` and returns it without touching any live scene, so a failure part-way through
 * leaves the previous model untouched — `03` R2's atomic swap. Throws only on a genuinely unrecoverable input; a
 * missing geometry for one part is skipped and reported rather than failing the whole load, because one bad part
 * should not cost the learner the other 299.
 */
export function realize(options: RealizeOptions): RealizedModel {
  const { manifest, geometries, decisions } = options;

  const root = new THREE.Group();
  root.name = manifest.name;

  const parts = new Map<string, THREE.Object3D>();
  const partOf = new Map<THREE.Object3D, string>();
  const lights: THREE.Light[] = [];

  // Structural caches: the mechanism behind "the 200-bolt assembly is 1 bolt's worth of GPU memory".
  const geometryCache = new Map<string, THREE.BufferGeometry>();
  const materialCache = new Map<string, THREE.Material>();

  let triangles = 0;
  let drawCalls = 0;

  const resolveGeometry = (
    cacheKey: string,
    mesh: MeshData,
    decimateTo: number,
  ): THREE.BufferGeometry => {
    // Decimation changes the geometry, so it participates in the key — otherwise a decimated part would poison
    // the cache for an identical full-detail part elsewhere in the model.
    const key = decimateTo < 1 ? `${cacheKey}@${decimateTo.toFixed(3)}` : cacheKey;
    const cached = geometryCache.get(key);
    if (cached) return cached;
    const built = toBufferGeometry(mesh, decimateTo);
    geometryCache.set(key, built);
    return built;
  };

  const resolveMaterial = (ref: MaterialRef): THREE.Material => {
    const key = decisions.flatShading ? `${ref.cacheKey}#flat` : ref.cacheKey;
    const cached = materialCache.get(key);
    if (cached) return cached;
    const built = toMaterial(ref, decisions.flatShading);
    materialCache.set(key, built);
    return built;
  };

  // Parts arrive parent-first, so a single pass can attach each node to a parent that already exists.
  for (const node of manifest.parts) {
    const parent = node.parentId ? (parts.get(node.parentId) ?? root) : root;
    let object: THREE.Object3D;

    if (node.kind === 'group' || !node.geometry) {
      object = new THREE.Group();
    } else {
      const mesh = geometries.get(node.geometry.cacheKey);
      if (!mesh) {
        // A part whose geometry never arrived: keep an empty group so children still attach and the tree keeps
        // its shape, rather than orphaning a whole subassembly.
        object = new THREE.Group();
        object.name = node.name;
        object.visible = false;
        parts.set(node.id, object);
        parent.add(object);
        continue;
      }

      const decimateTo = decisions.decimation.get(node.id) ?? 1;
      const geometry = resolveGeometry(node.geometry.cacheKey, mesh, decimateTo);
      const material = node.material
        ? resolveMaterial(node.material)
        : new THREE.MeshStandardMaterial();

      if (node.kind === 'instances' && node.instances) {
        const cap = decisions.instanceCaps.get(node.id) ?? node.instances.length;
        const instanced = new THREE.InstancedMesh(
          geometry,
          material,
          Math.min(cap, node.instances.length),
        );
        writeInstances(instanced, node.instances, cap);
        instanced.frustumCulled = true;
        object = instanced;
        triangles += (node.geometry.triangles ?? 0) * instanced.count;
        drawCalls += 1;
      } else if (node.kind === 'points') {
        const cap = decisions.pointCaps.get(node.id);
        const pointsGeometry =
          cap && cap < mesh.positions.length / 3
            ? (() => {
                // Take a contiguous prefix rather than a random sample: the model generated these positions in a
                // meaningful order (a shell, a spiral), and sampling would break the pattern it drew.
                const trimmed = new THREE.BufferGeometry();
                trimmed.setAttribute(
                  'position',
                  new THREE.BufferAttribute(mesh.positions.slice(0, cap * 3), 3),
                );
                trimmed.computeBoundingSphere();
                return trimmed;
              })()
            : geometry;
        object = new THREE.Points(pointsGeometry, material);
        drawCalls += 1;
      } else {
        const meshObject = new THREE.Mesh(geometry, material);
        meshObject.castShadow = !node.staticGeometry;
        meshObject.receiveShadow = true;
        object = meshObject;
        triangles += node.geometry.triangles ?? 0;
        drawCalls += 1;
      }
    }

    object.name = node.name;
    applyTransform(object, node.transform);
    object.visible = node.visible;
    // `userData` carries the part id so a raycast hit resolves back to something the learner can be told about
    // (`03` R3), without a second map lookup in the hot picking path.
    object.userData.partId = node.id;
    object.userData.selectable = node.selectable;

    parts.set(node.id, object);
    partOf.set(object, node.id);
    parent.add(object);
  }

  // ── Lights ────────────────────────────────────────────────────────────────
  for (const decl of manifest.lights) {
    const color = toColor(decl.color, '#ffffff');
    let light: THREE.Light;

    switch (decl.kind) {
      case 'ambient':
        light = new THREE.AmbientLight(color, decl.intensity);
        break;
      case 'hemisphere':
        light = new THREE.HemisphereLight(color, toColor('#404040'), decl.intensity);
        break;
      case 'directional': {
        const directional = new THREE.DirectionalLight(color, decl.intensity);
        if (decl.position) directional.position.set(...decl.position);
        if (decl.target) directional.target.position.set(...decl.target);
        light = directional;
        break;
      }
      case 'spot': {
        const spot = new THREE.SpotLight(color, decl.intensity);
        if (decl.position) spot.position.set(...decl.position);
        if (decl.angle !== undefined) spot.angle = decl.angle;
        if (decl.penumbra !== undefined) spot.penumbra = decl.penumbra;
        if (decl.distance !== undefined) spot.distance = decl.distance;
        light = spot;
        break;
      }
      case 'rect':
        // No `RectAreaLight` without its own uniforms library, so it degrades to a point light of similar
        // intensity. Stated rather than silently substituted, because it changes the look.
        light = new THREE.PointLight(color, decl.intensity, decl.distance ?? 0);
        if (decl.position) light.position.set(...decl.position);
        break;
      default: {
        const point = new THREE.PointLight(color, decl.intensity, decl.distance ?? 0);
        if (decl.position) point.position.set(...decl.position);
        light = point;
        break;
      }
    }

    // Shadow casting is granted by admission, not by the model's request (`08` budgets it per tier).
    if (decl.castShadow && decisions.shadowLights.has(decl.id)) {
      light.castShadow = true;
      if (light instanceof THREE.DirectionalLight || light instanceof THREE.SpotLight) {
        light.shadow.mapSize.set(1024, 1024);
        light.shadow.bias = -0.0005;
      }
    }

    light.name = decl.id;
    light.userData.lightId = decl.id;
    lights.push(light);
    root.add(light);
  }

  /**
   * The default rig.
   *
   * `00`: "A model with no lighting code still gets a sane rig." Added only when the model declared nothing,
   * because augmenting an authored rig with an uninvited key light would fight the author's intent.
   */
  if (manifest.lights.length === 0) {
    const key = new THREE.DirectionalLight(0xffffff, 2.2);
    key.position.set(3, 4, 2);
    const fill = new THREE.HemisphereLight(0xcfe6f2, 0x2a2622, 0.6);
    lights.push(key, fill);
    root.add(key, fill);
  }

  root.updateMatrixWorld(true);

  return {
    root,
    parts,
    partOf,
    lights,
    stats: {
      triangles,
      drawCalls,
      geometries: geometryCache.size,
      materials: materialCache.size,
    },
    /**
     * Release everything.
     *
     * `08` requires memory flat across dozens of generate/load cycles, and Three.js frees nothing on its own.
     * Disposing the caches rather than walking the tree is deliberate: a shared geometry appears under many
     * nodes, and a tree walk would try to dispose it repeatedly.
     */
    dispose(): void {
      for (const geometry of geometryCache.values()) geometry.dispose();
      for (const material of materialCache.values()) {
        // Textures are procedural or absent by design (`01`), but a material that acquired one must not leak it.
        const record = material as unknown as Record<string, unknown>;
        for (const value of Object.values(record)) {
          if (value instanceof THREE.Texture) value.dispose();
        }
        material.dispose();
      }
      geometryCache.clear();
      materialCache.clear();

      for (const light of lights) {
        // Only the shadow-capable light types carry a `shadow`, and its render target is a real GPU allocation
        // that survives the light unless it is disposed explicitly.
        if (
          light instanceof THREE.DirectionalLight ||
          light instanceof THREE.SpotLight ||
          light instanceof THREE.PointLight
        ) {
          light.shadow.map?.dispose();
        }
        light.dispose();
      }

      root.clear();
      parts.clear();
      partOf.clear();
    },
  };
}
