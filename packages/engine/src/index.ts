/**
 * The public surface of `@edu3d/engine`.
 *
 * The package is framework-agnostic and DOM-free by construction: nothing exported here touches `document`,
 * `window`, a canvas or a GPU. `09-CODEBASE-QUALITY.md` requires that ("the engine must run in Node without a
 * browser — that is what makes it testable and reusable"), and two things in this platform depend on it: the
 * headless audit runs the same authoring code in `node:vm`, and the browser host runs it inside a hardened
 * worker.
 *
 * Rendering — the WebGL context, the Three.js scene, every draw call — happens **only on the learner's device**,
 * in the realizer that consumes a manifest. The server never renders a pixel; it only runs the authoring pass to
 * harvest and price a manifest. That split is why this entry point exports data producers and no renderer.
 */

// The mesh currency every builder deals in.
export {
  type Bounds,
  type MeshData,
  type MeshProblem,
  type Path3,
  type Profile,
  boundingRadius,
  boundsAreEmpty,
  boundsCenter,
  computeNormals,
  emptyBounds,
  meshBounds,
  mergeMeshes,
  pathPointCount,
  profilePointCount,
  sanitizeMesh,
  transformMesh,
  triangleCount,
  validateMesh,
  vertexCount,
} from './geometry/mesh-data.ts';

// Geometry: an open builder system, not a shape catalog.
export * as primitives from './geometry/primitives.ts';
export * as solids from './geometry/solids.ts';
export * as implicit from './geometry/implicit.ts';
export * as modifiers from './geometry/modifiers.ts';
export * as profiles from './geometry/profiles.ts';
export * as patterns from './geometry/patterns.ts';
export { triangulateProfile, type TriangulationResult } from './geometry/triangulate.ts';
export {
  GeometryFactory,
  GeometryError,
  type GeometryHandle,
  type PathHandle,
  type ProfileHandle,
} from './geometry/factory.ts';

// Materials: deliberately small, deliberately semantic.
export {
  MaterialFactory,
  MaterialError,
  contrastRatio,
  type ColorRoleDecl,
  type MaterialHandle,
  type MaterialOptions,
} from './materials/factory.ts';

// The authoring API the AI writes against, and the descriptor the gate and prompt share.
export {
  SceneBuilder,
  SceneError,
  type ComponentContext,
  type FrameContext,
  type PartRef,
} from './authoring/scene.ts';
export {
  apiSurface,
  apiSurfaceSet,
  buildApiSurface,
  describeApiSurface,
  type ApiMember,
} from './authoring/api-surface.ts';

// Pure math, exported both for the guest namespace and for host-side geometry work.
export * as M from './math/index.ts';
