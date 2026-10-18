/**
 * Authoring layer barrel: the scene builder, the reflected API surface and its hand-written
 * reference table, and the guest join. Exists because the package.json declares an `./authoring`
 * export — a surface that pointed at nothing until now, so any importer of the subpath got a
 * resolution error the typecheck never saw (no importer existed to fail).
 */
export * from './api-surface.ts';
export * from './api-reference.ts';
export * from './scene.ts';
export * from './guest.ts';
