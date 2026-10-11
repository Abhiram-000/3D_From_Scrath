/**
 * The API surface descriptor: one generated source of truth for what the AI may call.
 *
 * Three consumers read this, and the fact that they read the *same* thing is the point:
 *
 *  1. the **static gate** (`packages/sandbox`) validates every `namespace.method` call against it, so a
 *     hallucinated helper is caught on the server before a browser ever sees the code;
 *  2. the **generation prompt** (`04`) is built from it, so the documented surface and the real surface cannot
 *     drift — `04` warns that "a prompt that drifts from the code produces code the platform rejects";
 *  3. the **diagnostics panel** shows which functions a model actually used.
 *
 * It is derived by *instantiating the real factories and reading their facades*, not by maintaining a list. That
 * is deliberate: a hand-written list is a second source of truth, and the failure mode is silent — a builder
 * added to the engine that the gate then rejects, or worse, a builder documented in the prompt that does not
 * exist. Adding a geometry builder therefore widens what the AI can build with no schema change and no prompt
 * edit, which is the mechanism `PLAN.md` §A3 depends on.
 */
import { GeometryFactory } from '../geometry/factory.ts';
import { MaterialFactory } from '../materials/factory.ts';
import { SceneBuilder } from './scene.ts';
import * as M from '../math/index.ts';
import { API_REFERENCE } from './api-reference.ts';

/** A callable member of the guest API, in `namespace.method` form. */
export interface ApiMember {
  qualified: string;
  namespace: string;
  member: string;
  /** Nested namespaces (`geom.pattern`, `geom.field`) are recorded so the gate can accept two-level calls. */
  nested: boolean;
}

/**
 * Walk a facade and collect its callable members, one level of nesting deep.
 *
 * One level is enough for the real surface (`geom.pattern.radial`, `geom.field.sphere`) and stops the walk from
 * wandering into whatever a returned handle happens to expose.
 */
function collect(namespace: string, facade: Readonly<Record<string, unknown>>): ApiMember[] {
  const members: ApiMember[] = [];

  for (const [key, value] of Object.entries(facade)) {
    // Constants count as members, not just functions. `M.PI`, `M.TAU` and `M.GRAVITY` are as much part of the
    // surface as `M.sin` — omitting them made the gate reject the reference model's own arithmetic, which is the
    // exact drift this descriptor exists to prevent.
    if (
      typeof value === 'function' ||
      typeof value === 'number' ||
      typeof value === 'string' ||
      typeof value === 'boolean'
    ) {
      members.push({ qualified: `${namespace}.${key}`, namespace, member: key, nested: false });
      continue;
    }
    if (value && typeof value === 'object') {
      // A nested namespace: record the namespace itself (so `geom.pattern` resolves) and its members.
      members.push({ qualified: `${namespace}.${key}`, namespace, member: key, nested: true });
      for (const [nestedKey, nestedValue] of Object.entries(value as Record<string, unknown>)) {
        if (typeof nestedValue !== 'function') continue;
        members.push({
          qualified: `${namespace}.${key}.${nestedKey}`,
          namespace: `${namespace}.${key}`,
          member: nestedKey,
          nested: true,
        });
      }
    }
  }

  return members;
}

/**
 * Build the descriptor.
 *
 * Cheap enough to call per request (three factory instantiations and an `Object.entries` walk), and called once
 * per process in practice via `apiSurface()` below.
 */
export function buildApiSurface(): {
  members: ApiMember[];
  qualified: Set<string>;
  byNamespace: Map<string, string[]>;
} {
  const geometry = new GeometryFactory();
  const materials = new MaterialFactory();
  const scene = new SceneBuilder();

  const members = [
    ...collect('scene', scene.createFacade()),
    ...collect('geom', geometry.createFacade()),
    ...collect('mat', materials.createFacade()),
    // `M` is a plain module namespace rather than a factory facade, so it is collected directly.
    ...collect('M', M as unknown as Record<string, unknown>),
    // Provided to the guest by the host rather than by a factory: a bounded console and a seeded PRNG.
    { qualified: 'console.log', namespace: 'console', member: 'log', nested: false },
    { qualified: 'console.warn', namespace: 'console', member: 'warn', nested: false },
    { qualified: 'console.error', namespace: 'console', member: 'error', nested: false },
    { qualified: 'random.float', namespace: 'random', member: 'float', nested: false },
    { qualified: 'random.range', namespace: 'random', member: 'range', nested: false },
    { qualified: 'random.int', namespace: 'random', member: 'int', nested: false },
    { qualified: 'random.pick', namespace: 'random', member: 'pick', nested: false },
    { qualified: 'random.unitVector', namespace: 'random', member: 'unitVector', nested: false },
  ];

  // The facades hold no GPU objects, but disposing keeps the "one factory per build" discipline honest even here.
  geometry.dispose();
  materials.dispose();
  scene.dispose();

  const byNamespace = new Map<string, string[]>();
  for (const member of members) {
    const existing = byNamespace.get(member.namespace) ?? [];
    existing.push(member.member);
    byNamespace.set(member.namespace, existing);
  }

  return {
    members,
    qualified: new Set(members.map((member) => member.qualified)),
    byNamespace,
  };
}

let cached: ReturnType<typeof buildApiSurface> | null = null;

/** The descriptor, built once per process. */
export function apiSurface(): ReturnType<typeof buildApiSurface> {
  cached ??= buildApiSurface();
  return cached;
}

/** The set the static gate checks calls against. */
export const apiSurfaceSet = (): ReadonlySet<string> => apiSurface().qualified;

/**
 * Render the surface as prompt documentation: the authored reference, grouped by namespace.
 *
 * Grouped by namespace and alphabetised (default code-unit sort — never `localeCompare`, whose
 * order varies by machine) so the same surface always produces the same text — a prompt that
 * reorders between runs would invalidate response caching and make A/B comparisons meaningless.
 *
 * Reflection stays the source of truth for *what exists*; `API_REFERENCE` carries *how to call
 * it*, and the two-way completeness test in tests/api-reference.test.ts welds them. A member that
 * somehow reaches here without an entry (a process that skipped the suite) still renders its bare
 * qualified name: generation must not die to a documentation gap the build already flags — the
 * gate's accepted surface is untouched either way.
 */
export function describeApiSurface(): string {
  const { byNamespace } = apiSurface();
  const lines: string[] = [];

  for (const namespace of [...byNamespace.keys()].sort()) {
    const members = [...new Set(byNamespace.get(namespace) ?? [])].sort();
    lines.push(`${namespace}:`);
    for (const member of members) {
      const entry = API_REFERENCE[`${namespace}.${member}`];
      if (!entry) {
        lines.push(`  ${namespace}.${member}`);
        continue;
      }
      // `signature` begins with the qualified call name, so the line reads as the call itself.
      lines.push(`  ${entry.signature} — ${entry.summary}`);
      for (const exampleLine of entry.example.split('\n')) lines.push(`      ${exampleLine}`);
    }
  }

  return lines.join('\n');
}
