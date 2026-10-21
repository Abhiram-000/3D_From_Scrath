/**
 * The static gate: the first of the sandbox's five layers, and the only one that runs before the code
 * reaches a browser at all.
 *
 * `04-BACKEND.md` places it in the pipeline explicitly — "a static gate runs before the browser ever
 * sees it: syntax check, forbidden-token scan, API surface check, size and shape limits" — and requires
 * its failures to be *enumerated* so they can drive a self-repair pass rather than a re-roll.
 *
 * The gate is AST-based, not regex-based, for one decisive reason: a token scan cannot tell
 * `fetchGeometryCount` from `fetch`, cannot see `globalThis['fe' + 'tch']`, and cannot know that
 * `const document = ...` makes a later `document` reference harmless. Every violation below is
 * therefore a statement about a resolved binding or a syntactic form, not about a substring.
 */
import { parse } from 'acorn';
import { full, simple } from 'acorn-walk';
import type { Node } from 'acorn';
import { type GateResult, type GateViolation, SANDBOX_LIMITS } from '@edu3d/contracts';
import {
  FORBIDDEN_GLOBALS,
  FORBIDDEN_MEMBERS,
  DYNAMIC_CODE_GLOBALS,
  GUEST_BINDINGS,
} from './forbidden.ts';
import { RESERVED_PREFIX } from './instrument.ts';
import { analyzeScopes } from './scope.ts';

type AnyNode = Node & { type: string; [key: string]: unknown };

/** Maximum AST nesting. Deep nesting is a parser-stack risk, and no legible program needs this much. */
const MAX_AST_DEPTH = 400;

/** Character budget for a single string literal, so a program cannot smuggle a payload as data. */
const MAX_STRING_LITERAL_LENGTH = 20_000;

/**
 * UTF-8 byte length, via the one API both hosts actually have.
 *
 * This was `Buffer.byteLength(source, 'utf8')`, which is a Node global — and this module is the
 * browser-side defence layer. Loading any model in a browser threw `ReferenceError: Buffer is not
 * defined`, so the gate never ran at all: the one layer that is supposed to reject `eval` before
 * execution was throwing before it could look at the program. The monorepo's suite missed it because
 * every test there runs in Node, where `Buffer` exists.
 *
 * `TextEncoder` is a global in Node 11+ and in every browser, and encoding a string to UTF-8 bytes and
 * counting them is the same measurement `Buffer.byteLength(s, 'utf8')` performs — so the byte budget
 * keeps its meaning rather than silently degrading to UTF-16 code units.
 */
const UTF8 = new TextEncoder();

const utf8ByteLength = (source: string): number => UTF8.encode(source).length;

const violation = (
  kind: GateViolation['kind'],
  message: string,
  node?: AnyNode,
  snippet?: string,
): GateViolation => ({
  kind,
  message,
  ...(node?.loc ? { line: node.loc.start.line, column: node.loc.start.column } : {}),
  ...(snippet ? { snippet: snippet.slice(0, 200) } : {}),
});

export interface GateOptions {
  /**
   * Scene-API function names the engine actually exports, in `namespace.method` form.
   *
   * Passed in rather than imported so the gate cannot drift from the engine: the engine generates this
   * descriptor from its own registry, and the same descriptor is injected into the generation prompt.
   * That single source is what lets new geometry builders widen the platform's range without a gate
   * change — `PLAN.md` §A3.
   */
  apiSurface: ReadonlySet<string>;
  /** Namespaces whose members are checked against `apiSurface`. Defaults to the guest bindings. */
  checkedNamespaces?: ReadonlySet<string>;
  maxBytes?: number;
}

/**
 * Run the gate.
 *
 * Never throws: a hostile or broken program is a normal input here, and the caller needs the full
 * violation list to build a repair instruction. A parse failure returns a single `syntax` violation
 * with the position acorn reported, because that position is what makes the repair prompt specific.
 */
export function runStaticGate(source: string, options: GateOptions): GateResult {
  const byteLength = utf8ByteLength(source);
  const maxBytes = options.maxBytes ?? SANDBOX_LIMITS.maxCodeBytes;
  const violations: GateViolation[] = [];

  if (byteLength === 0) {
    return {
      ok: false,
      violations: [violation('syntax', 'The program is empty.')],
      byteLength,
      guardedLoops: 0,
      apiCalls: [],
    };
  }

  if (byteLength > maxBytes) {
    return {
      ok: false,
      violations: [
        violation(
          'shape_limit',
          `The program is ${byteLength} bytes, over the ${maxBytes}-byte ceiling. Use component reuse and instancing instead of repeating blocks.`,
        ),
      ],
      byteLength,
      guardedLoops: 0,
      apiCalls: [],
    };
  }

  let program: Node;
  try {
    program = parse(source, {
      // `sourceType: 'script'` is itself a check: `import`/`export` become syntax errors rather than
      // silently-accepted module syntax the guest realm could never satisfy.
      ecmaVersion: 2023,
      sourceType: 'script',
      locations: true,
      allowReturnOutsideFunction: false,
      allowAwaitOutsideFunction: false,
      allowHashBang: false,
    });
  } catch (error) {
    const parseError = error as Error & { loc?: { line: number; column: number } };
    const isModuleSyntax = /'import'|'export'|import\.meta|dynamic import/i.test(
      parseError.message,
    );
    return {
      ok: false,
      violations: [
        {
          kind: isModuleSyntax ? 'module_syntax' : 'syntax',
          message: isModuleSyntax
            ? `Module syntax is not available in the sandbox: ${parseError.message}. Write one self-contained script with no imports or exports.`
            : parseError.message,
          ...(parseError.loc ? { line: parseError.loc.line, column: parseError.loc.column } : {}),
        },
      ],
      byteLength,
      guardedLoops: 0,
      apiCalls: [],
    };
  }

  const checkedNamespaces = options.checkedNamespaces ?? new Set(GUEST_BINDINGS);
  const forbidden = new Set(FORBIDDEN_GLOBALS);
  const forbiddenMembers = new Set(FORBIDDEN_MEMBERS);
  const dynamicCodeNames = new Set(DYNAMIC_CODE_GLOBALS);
  const apiCalls = new Set<string>();
  let guardedLoops = 0;

  // ── Scope and constant analysis ────────────────────────────────────────────
  // Hoisted above the member walk because two checks below need resolved bindings: the API-surface
  // walk needs free references, and the computed-member check needs to know whether an identifier is
  // a live capability name (`scene`, `globalThis`, …) or merely the program's own word for something
  // harmless (`const parent = group`).
  const { freeReferences, maxDepth } = analyzeScopes(program);
  const freeByName = new Map<string, { node: AnyNode; chain: AnyNode[] }>();
  for (const reference of freeReferences) {
    if (!freeByName.has(reference.name)) freeByName.set(reference.name, reference);
  }

  /**
   * Every name a destructuring pattern binds (same traversal as `scope.ts:patternNames`, duplicated
   * here rather than exported because the sandbox package keeps each module's helpers private).
   */
  const patternTargets = (node: unknown, out: string[]): void => {
    if (!node || typeof node !== 'object') return;
    const candidate = node as AnyNode;
    switch (candidate.type) {
      case 'Identifier':
        out.push(candidate.name as string);
        return;
      case 'ObjectPattern':
        for (const property of candidate.properties as AnyNode[]) {
          if (property.type === 'RestElement') patternTargets(property.argument, out);
          else patternTargets(property.value, out);
        }
        return;
      case 'ArrayPattern':
        for (const element of candidate.elements as (AnyNode | null)[])
          patternTargets(element, out);
        return;
      case 'AssignmentPattern':
        patternTargets(candidate.left, out);
        return;
      case 'RestElement':
        patternTargets(candidate.argument, out);
        return;
      default:
        return;
    }
  };

  /**
   * Constant strings a program derives from literals, acquired in one pass *before* the member walk.
   *
   * The escape that motivated this: `scene.describe['cons' + 'tru' + 'ctor']` walks past a gate that
   * only inspects literal keys, and the same trick hides a key in a variable (`const k = 'cons' +
   * 'tru' + 'ctor'; scene.describe[k]`). Folding concatenations, template literals with no
   * interpolations and — through this map — variables that were exactly that, turns all three spellings
   * into the same checked string. A name is folded only while its single declaration initialises it
   * from a foldable expression *and* nothing ever assigns it: the moment a variable is written anywhere
   * it is dropped, so folding can never claim to know a value the program could have changed.
   */
  const reassigned = new Set<string>();
  const recordAssignmentTargets = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;
    const candidate = node as AnyNode;
    if (candidate.type === 'Identifier') {
      reassigned.add(candidate.name as string);
      return;
    }
    for (const key of ['elements', 'properties', 'left', 'argument'] as const) {
      const part = candidate[key];
      if (Array.isArray(part)) {
        for (const item of part) recordAssignmentTargets(item);
      } else if (part) {
        recordAssignmentTargets(part);
      }
    }
  };

  /** Names initialised from an expression that involves the capability surface (see below). */
  const apiFlowed = new Set<string>();

  /**
   * `const`-bound strings a program derives from literals.
   *
   * Declared before the walks that fill and read it: the declarator pass writes entries here, and the
   * member walk below reads the *complete* map, so a key hidden a few lines away from its definition
   * still folds. Function-declaration hoisting makes `foldConstantString` callable before this point.
   */
  const constStrings = new Map<string, string>();

  /**
   * Names the guest *does* receive. A computed key whose object chain mentions one of these — or a
   * forbidden or dynamic-code global — is where an un-resolvable key could hide a capability reach,
   * so the gate refuses the form there while leaving plain program-local indexing (`positions[i]`)
   * alone: local data cannot carry the host into the picture, and refusing it would reject the
   * typed-array loops the API's escape hatch exists for.
   */
  const capabilityNames = new Set<string>([...GUEST_BINDINGS, ...forbidden, ...dynamicCodeNames]);

  /** True when the subtree reads a capability: a free capability name, or a local fed from one. */
  const referencesCapability = (root: AnyNode): boolean => {
    let found = false;
    full(root, (node) => {
      if (found) return;
      const candidate = node as unknown as AnyNode;
      if (candidate.type !== 'Identifier') return;
      const name = candidate.name as string;
      if (capabilityNames.has(name) && freeByName.has(name)) found = true;
      else if (apiFlowed.has(name)) found = true;
    });
    return found;
  };

  /**
   * Bindings the program declares — every declarator target, destructuring pattern, parameter,
   * caught error and class/function name — counted by name.
   *
   * The fold below is scope-blind: it keeps one map of "this word means this string", with no notion
   * of nested scopes. That is sound only if a folded name cannot be rebound by a shadowing
   * declaration — `const k = 'constructor'` above a `for (const k of …)` that shadows it, with
   * `scene.describe[k]` inside the loop, would otherwise fold with the *outer* spelling while the
   * runtime reads the *shadow*, and a wrong fold is worse than no fold: it would short-circuit the
   * strict computed-key rejection the gate leans on for capability objects. Counting every binding
   * and dropping names bound more than once makes the fold fail closed — a dropped entry is an
   * un-foldable key, which takes the strict policy below.
   */
  const declaredCount = new Map<string, number>();
  const countBindTargets = (target: AnyNode | null | undefined): void => {
    if (!target) return;
    const names: string[] = [];
    patternTargets(target, names);
    for (const name of names) declaredCount.set(name, (declaredCount.get(name) ?? 0) + 1);
  };
  const countFunctionBindings = (node: unknown): void => {
    const candidate = node as AnyNode & { id?: AnyNode; params?: AnyNode[] };
    countBindTargets(candidate.id);
    for (const parameter of candidate.params ?? []) countBindTargets(parameter);
  };

  /** `foldConstantString` reads `constStrings`; hoisted so the declarator pass may call it. */
  function foldConstantString(node: AnyNode): string | undefined {
    switch (node.type) {
      case 'Literal':
        return typeof node.value === 'string' ? (node.value as string) : undefined;
      case 'TemplateLiteral': {
        const quasis = node.quasis as AnyNode[];
        const expressions = node.expressions as AnyNode[];
        if (quasis.length === 0) return undefined;
        // A template folds when *every* part folds: no-interpolation templates fold by definition,
        // and `` `cons${``}tru${``}ctor` `` — the spelling the exploit actually used — is interpolations
        // of empty templates, so each expression folds recursively and the chunks join to the same
        // string. `cooked` is null for templates with invalid escape sequences; those stay un-foldable.
        const firstValue = (quasis[0] as AnyNode | undefined)?.value as
          { cooked?: string | null } | undefined;
        let folded = firstValue?.cooked;
        if (typeof folded !== 'string') return undefined;
        for (let i = 0; i < expressions.length; i += 1) {
          const part = foldConstantString(expressions[i] as AnyNode);
          if (part === undefined) return undefined;
          const nextValue = (quasis[i + 1] as AnyNode | undefined)?.value as
            { cooked?: string | null } | undefined;
          const next = nextValue?.cooked;
          if (typeof next !== 'string') return undefined;
          folded += part + next;
        }
        return folded;
      }
      case 'Identifier': {
        if (reassigned.has(node.name as string)) return undefined;
        const known = constStrings.get(node.name as string);
        return known === undefined ? undefined : known;
      }
      case 'BinaryExpression':
        if (node.operator === '+') {
          const left = foldConstantString(node.left as AnyNode);
          const right = foldConstantString(node.right as AnyNode);
          if (left !== undefined && right !== undefined) return left + right;
        }
        return undefined;
      default:
        return undefined;
    }
  }

  /**
   * `objectRootName` — for violation snippets: the leftmost identifier of a member/call chain,
   * so `scene[names[0]]` reports as `scene[<non-constant key>]` rather than dumping an AST type name.
   */
  const objectRootName = (node: AnyNode): string => {
    let current: AnyNode | undefined = node;
    while (current) {
      if (current.type === 'Identifier') return current.name as string;
      if (current.type === 'MemberExpression') {
        current = current.object as AnyNode;
        continue;
      }
      if (current.type === 'CallExpression' || current.type === 'NewExpression') {
        current = current.callee as AnyNode;
        continue;
      }
      break;
    }
    return '<expression>';
  };

  /**
   * One analysis pass: what the program binds, what it writes, and what its locals are fed from.
   *
   * The visitors run in source order, so `const g = geom.box(...)` taints `g` before a later
   * `const alias = g` checks that same set — aliasing propagates by construction.
   */
  simple(program, {
    VariableDeclarator(node) {
      const declarator = node as unknown as AnyNode;
      const { id, init } = declarator as unknown as { id?: AnyNode; init?: AnyNode };
      countBindTargets(id);
      if (!id || id.type !== 'Identifier' || !init) return;
      const name = id.name as string;
      const folded = foldConstantString(init);
      if (folded !== undefined && !reassigned.has(name)) constStrings.set(name, folded);
      // A local whose initialiser touches the capability surface is one a later computed key could
      // use to reach it — `const g = geom.box(...); g[mysteryKey]` — so the object-side check below
      // counts the name as capability-tainted, in the direction of rejecting rather than allowing.
      if (referencesCapability(init)) apiFlowed.add(name);
    },
    // `let p; p = ctx.part('a'); p[k]` reaches the surface without any initialiser, so the assignment
    // has to mark its targets tainted by the same reject-not-allow logic as the declarator above.
    AssignmentExpression(node) {
      const expression = node as unknown as AnyNode;
      const left = expression.left as AnyNode;
      recordAssignmentTargets(left);
      if (referencesCapability(expression.right as AnyNode)) {
        const names: string[] = [];
        patternTargets(left, names);
        for (const name of names) apiFlowed.add(name);
      }
    },
    UpdateExpression(node) {
      recordAssignmentTargets((node as unknown as AnyNode).argument as AnyNode);
    },
    FunctionDeclaration(node) {
      countFunctionBindings(node);
    },
    FunctionExpression(node) {
      countFunctionBindings(node);
    },
    ArrowFunctionExpression(node) {
      countFunctionBindings(node);
    },
    ClassDeclaration(node) {
      countBindTargets((node as unknown as AnyNode).id as AnyNode | undefined);
    },
    CatchClause(node) {
      countBindTargets((node as unknown as AnyNode).param as AnyNode | undefined);
    },
  });

  // The shadow hedge, applied once after the walk so a `const k` seen before its shadow (in source
  // order) is still purged: any name bound in more than one place keeps no folded string.
  for (const [name, count] of declaredCount) {
    if (count > 1) constStrings.delete(name);
  }

  // ── Reserved identifier namespace ───────────────────────────────────────────
  // A `full` walk rather than a `simple` one with an `Identifier` visitor: acorn-walk dispatches
  // declaration names and destructuring targets as `Pattern`/`VariablePattern`, so a simple walk would
  // miss `function __edu3d_tick() {}` — precisely the shadowing this check exists to prevent.
  full(program, (node) => {
    const candidate = node as unknown as AnyNode;
    if (candidate.type !== 'Identifier') return;
    if (!(candidate.name as string).startsWith(RESERVED_PREFIX)) return;
    violations.push(
      violation(
        'forbidden_global',
        `Identifiers beginning with \`${RESERVED_PREFIX}\` are reserved by the runtime. Rename \`${candidate.name as string}\`.`,
        candidate,
        String(candidate.name),
      ),
    );
  });

  // ── Syntactic forms that must not appear at all ─────────────────────────────
  simple(program, {
    ImportDeclaration(node) {
      violations.push(
        violation(
          'module_syntax',
          'The sandbox has no module loader. Remove the import and use the provided scene API.',
          node as unknown as AnyNode,
        ),
      );
    },
    ImportExpression(node) {
      violations.push(
        violation(
          'module_syntax',
          'Dynamic import is not available. Remove it.',
          node as unknown as AnyNode,
        ),
      );
    },
    ExportNamedDeclaration(node) {
      violations.push(
        violation(
          'module_syntax',
          'Export syntax is not available. The program runs as a script, not a module.',
          node as unknown as AnyNode,
        ),
      );
    },
    ExportDefaultDeclaration(node) {
      violations.push(
        violation(
          'module_syntax',
          'Export syntax is not available. The program runs as a script, not a module.',
          node as unknown as AnyNode,
        ),
      );
    },
    WithStatement(node) {
      // `with` makes every identifier's binding undecidable at parse time, which would defeat the
      // scope analysis every other check in this file depends on.
      violations.push(
        violation(
          'dynamic_code',
          '`with` is not allowed because it makes variable resolution ambiguous.',
          node as unknown as AnyNode,
        ),
      );
    },
    Literal(node) {
      const literal = node as unknown as AnyNode;
      if (
        typeof literal.value === 'string' &&
        (literal.value as string).length > MAX_STRING_LITERAL_LENGTH
      ) {
        violations.push(
          violation(
            'shape_limit',
            `A string literal of ${(literal.value as string).length} characters exceeds the ${MAX_STRING_LITERAL_LENGTH}-character limit. Generate data procedurally instead of embedding it.`,
            literal,
          ),
        );
      }
    },
    TemplateElement(node) {
      const element = node as unknown as AnyNode;
      const cooked = (element.value as { cooked?: string } | undefined)?.cooked;
      if (typeof cooked === 'string' && cooked.length > MAX_STRING_LITERAL_LENGTH) {
        violations.push(
          violation(
            'shape_limit',
            `A template literal chunk of ${cooked.length} characters exceeds the ${MAX_STRING_LITERAL_LENGTH}-character limit.`,
            element,
          ),
        );
      }
    },
    ForStatement() {
      guardedLoops += 1;
    },
    ForInStatement() {
      guardedLoops += 1;
    },
    ForOfStatement() {
      guardedLoops += 1;
    },
    WhileStatement() {
      guardedLoops += 1;
    },
    DoWhileStatement() {
      guardedLoops += 1;
    },
    MemberExpression(node) {
      const member = node as unknown as AnyNode;
      const property = member.property as AnyNode;
      // Static member access to an intrinsic reacher: `x.constructor.constructor`, `obj.__proto__`.
      if (
        !member.computed &&
        property.type === 'Identifier' &&
        forbiddenMembers.has(property.name as string)
      ) {
        violations.push(
          violation(
            'prototype_access',
            `Accessing \`${property.name as string}\` is not allowed: it reaches the runtime's intrinsics.`,
            member,
            String(property.name),
          ),
        );
      }
      // Computed access with a *foldable* key hides the same reach behind brackets — and, since the
      // key may be spelled as a concatenation of literals, a template literal with no interpolations,
      // or a constant string variable, every spelling must be folded to the string it evaluates to
      // before this check can answer. The individual cases that motivated the fold:
      //   `scene.describe['cons' + 'tru' + 'ctor']` — the escaped exploit that motivated this file's change;
      //   `scene.describe[`cons${``}tru${``}ctor`]`;
      //   `const k = 'constructor'; scene.describe[k]` — no reassignments, so k *is* its initialiser.
      if (member.computed) {
        const folded = foldConstantString(property);
        if (folded !== undefined) {
          if (forbiddenMembers.has(folded)) {
            violations.push(
              violation(
                'prototype_access',
                `Accessing \`${folded}\` is not allowed, however the property name is spelled: the sandbox folds computed keys before checking them.`,
                member,
                folded,
              ),
            );
          }
          if (forbidden.has(folded)) {
            violations.push(
              violation(
                'forbidden_global',
                `\`${folded}\` is not available in the sandbox, including through a computed key that folds to it.`,
                member,
                folded,
              ),
            );
          }
        } else if (referencesCapability(member.object as AnyNode)) {
          // A key the gate cannot resolve, on a chain rooted in the capability surface: the very
          // shape a runtime escape takes (`scene[names[i]]`, `ctx.part('a')[k]`). The platform's own
          // API is addressed by dotted names, so a dynamic key here has no legitimate use — rejecting
          // the form outright is the deliberate choice, and the message tells the repair pass what
          // replaces it. Residual risk accepted and documented: a locally-held value *obtained from*
          // the surface (`const p = ctx.part('a'); p[k]`) still has an un-resolvable key on a pure
          // local `p`, which the gate cannot see — that hole is what the node:vm realm's guest-facing
          // membrane closes at runtime (`compile.ts` / `hosts/node-host.ts`).
          violations.push(
            violation(
              'dynamic_code',
              `A computed property key that is not a constant is not allowed on the scene API or globals: the sandbox cannot tell what it would read. Address the documented API by name (for example geom.box(...)), or index only plain program-local arrays with numbers (positions[i]).`,
              member,
              `${objectRootName(member.object as AnyNode)}[<non-constant key>]`,
            ),
          );
        }
        // Un-foldable key on a chain with no capability reference: program-local data indexing.
      }
    },
  });

  // ── Free references: the capability check ───────────────────────────────────
  if (maxDepth > MAX_AST_DEPTH) {
    violations.push(
      violation(
        'shape_limit',
        `The program nests ${maxDepth} levels deep, over the ${MAX_AST_DEPTH}-level limit. Extract helper functions.`,
      ),
    );
  }

  const allowedFree = new Set(GUEST_BINDINGS);

  /**
   * Names whose violation is specifically about *constructing code*, checked before the general
   * forbidden-global list.
   *
   * Ordering matters because the violation kind drives the repair instruction: telling the model
   * "`eval` is not available in the sandbox" invites it to look for another way to evaluate a string,
   * whereas "the sandbox forbids constructing code at runtime" tells it the whole approach is wrong.
   * The set itself is declared once near the top of the gate (alongside `forbidden` and
   * `forbiddenMembers`) so the computed-member capability check and this loop share one definition —
   * declaring it twice is exactly how two overlapping lists drift apart.
   */
  /**
   * Language intrinsics a guest legitimately names.
   *
   * Present here and *frozen* in the realm: a model doing real geometry needs `Math`, `Array`,
   * `Float32Array` and friends, and denying them would make the mesh escape hatch unusable, which is
   * the opposite of the expressive-ceiling goal. `Function` and `eval` are deliberately absent.
   */
  const allowedIntrinsics = new Set([
    'Object',
    'Array',
    'String',
    'Number',
    'Boolean',
    'Symbol',
    'BigInt',
    'Math',
    'JSON',
    'Map',
    'Set',
    'WeakMap',
    'WeakSet',
    'Promise',
    'RegExp',
    'Date',
    'Error',
    'TypeError',
    'RangeError',
    'ArrayBuffer',
    'DataView',
    'Int8Array',
    'Uint8Array',
    'Uint8ClampedArray',
    'Int16Array',
    'Uint16Array',
    'Int32Array',
    'Uint32Array',
    'Float32Array',
    'Float64Array',
    'BigInt64Array',
    'BigUint64Array',
    'Infinity',
    'NaN',
    'undefined',
    'isNaN',
    'isFinite',
    'parseInt',
    'parseFloat',
    'encodeURIComponent',
    'decodeURIComponent',
    'structuredClone',
    'Intl',
    'this',
  ]);

  // ── API surface check ──────────────────────────────────────────────────────
  // Namespaces the engine owns are checked member-by-member; a method the engine does not export
  // is almost always a hallucinated helper, and naming it precisely is what makes the repair pass
  // one-shot. This walk runs *before* the free-reference loop so a namespace whose qualified call
  // is already reported (`phys.body`) does not get a second, less actionable bare-name violation.
  const qualifiedUnknownNamespaces = new Set<string>();
  simple(program, {
    MemberExpression(node) {
      const member = node as unknown as AnyNode;
      const object = member.object as AnyNode;
      const property = member.property as AnyNode;
      if (member.computed) return;
      if (object.type !== 'Identifier' || property.type !== 'Identifier') return;

      const namespace = object.name as string;
      // A free reference is one no program binding declares; only those can be API namespaces.
      const isFreeNamespace = freeReferences.some((reference) => reference.name === namespace);

      if (!checkedNamespaces.has(namespace)) {
        // A member call on a free identifier nothing binds — `phys.body` after Phase 1b removed
        // `phys` — must be rejected with the *qualified* name: that is the line the repair pass
        // deletes. Program-local objects that shadow nothing are skipped (not API calls), and
        // language intrinsics, forbidden globals and dynamic-code names carry their own messages.
        if (
          options.apiSurface.size > 0 &&
          isFreeNamespace &&
          !GUEST_BINDINGS.includes(namespace) &&
          !allowedIntrinsics.has(namespace) &&
          !forbidden.has(namespace) &&
          !dynamicCodeNames.has(namespace)
        ) {
          const qualified = `${namespace}.${property.name as string}`;
          apiCalls.add(qualified);
          violations.push(
            violation(
              'unknown_api',
              `\`${qualified}\` is not part of the scene API — no \`${namespace}\` namespace is bound in the sandbox. Use only the documented functions.`,
              member,
              qualified,
            ),
          );
          qualifiedUnknownNamespaces.add(namespace);
        }
        return;
      }
      // A program-local variable that shadows a namespace name is not an API call.
      if (!isFreeNamespace && !GUEST_BINDINGS.includes(namespace)) return;

      const qualified = `${namespace}.${property.name as string}`;
      apiCalls.add(qualified);
      if (options.apiSurface.size > 0 && !options.apiSurface.has(qualified)) {
        violations.push(
          violation(
            'unknown_api',
            `\`${qualified}\` is not part of the scene API. Use only the documented functions.`,
            member,
            qualified,
          ),
        );
      }
    },
  });

  for (const reference of freeReferences) {
    const { name, node } = reference;
    // Already reported with its qualified call above — one actionable line per mistake.
    if (qualifiedUnknownNamespaces.has(name)) continue;
    if (dynamicCodeNames.has(name)) {
      violations.push(
        violation(
          name === 'require' || name === 'module' || name === 'exports' || name === 'process'
            ? 'forbidden_global'
            : 'dynamic_code',
          name === 'require' || name === 'module' || name === 'exports' || name === 'process'
            ? `\`${name}\` is not available in the sandbox. The program runs as an isolated script with no host access.`
            : `\`${name}\` is not available: the sandbox forbids constructing or loading code at runtime.`,
          node,
          name,
        ),
      );
      continue;
    }
    if (forbidden.has(name)) {
      violations.push(
        violation(
          'forbidden_global',
          `\`${name}\` is not available in the sandbox. The program may only use the scene API (${[...GUEST_BINDINGS].join(', ')}).`,
          node,
          name,
        ),
      );
      continue;
    }
    if (allowedFree.has(name) || allowedIntrinsics.has(name)) continue;

    violations.push(
      violation(
        'unknown_api',
        `\`${name}\` is not defined. It is neither a variable in the program nor part of the scene API.`,
        node,
        name,
      ),
    );
  }

  return {
    ok: violations.length === 0,
    violations: violations.slice(0, 64),
    byteLength,
    guardedLoops,
    apiCalls: [...apiCalls].slice(0, 256),
  };
}

/**
 * Turn gate violations into the enumerated instruction list the repair prompt sends back.
 *
 * `04`: the model receives "its own code plus the specific, enumerated errors". Grouping by kind keeps
 * the instruction short when one mistake was made forty times — forty identical lines teach the model
 * nothing the first line did not.
 */
export function describeViolations(result: GateResult): string[] {
  const grouped = new Map<string, { count: number; sample: GateViolation }>();
  for (const item of result.violations) {
    const key = `${item.kind}:${item.snippet ?? item.message}`;
    const existing = grouped.get(key);
    if (existing) existing.count += 1;
    else grouped.set(key, { count: 1, sample: item });
  }

  return [...grouped.values()].map(({ count, sample }) => {
    const where = sample.line ? ` (line ${sample.line})` : '';
    const repetition = count > 1 ? ` — ${count} occurrences` : '';
    return `${sample.message}${where}${repetition}`;
  });
}
