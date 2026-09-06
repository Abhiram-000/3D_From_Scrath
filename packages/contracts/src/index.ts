/**
 * The public surface of `@edu3d/contracts`.
 *
 * Everything that crosses a process, thread or network boundary in this platform is defined in this
 * package and re-exported here. Both halves of the codebase import from `@edu3d/contracts` and nowhere
 * else for wire shapes, which is what makes a field rename a compile error instead of a production
 * incident (`00`: "one source of truth for the wire format, checked at build time").
 */

// Value primitives and their bounds.
export * from './primitives.ts';

// What a generated model *is*.
export * from './manifest/parts.ts';
export * from './manifest/parameters.ts';
export * from './manifest/presentation.ts';
export * from './manifest/physics.ts';
export * from './manifest/behavior.ts';
export * from './manifest/model.ts';

// How it travels.
export * from './wire/errors.ts';
export * from './wire/generation.ts';
export * from './wire/api.ts';
export * from './wire/sandbox.ts';

// How it is judged and how much it costs.
export * from './audit.ts';
export * from './budgets.ts';

// What the learner chose.
export * from './settings.ts';
