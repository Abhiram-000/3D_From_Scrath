/**
 * Scope analysis for guest programs.
 *
 * The static gate must distinguish `fetch('…')` — a free reference to a host capability — from
 * `const parent = group; parent.add(part)`, where `parent` is the program's own variable that merely
 * shares a name with a browser global. Without that distinction the gate either rejects legitimate
 * code (wasting a paid generation on a false positive) or lets a real capability reference through.
 *
 * The analysis is deliberately small: it resolves *bindings*, not types. Two passes over the AST —
 * collect declarations against their owning scope, then resolve every reference up the scope chain —
 * which is all the gate needs and far less machinery than a general-purpose resolver.
 */
import { ancestor } from 'acorn-walk';
import type { Node } from 'acorn';

/** Nodes that introduce a `var`/parameter scope. `let`/`const` also bind here when this is the nearest. */
const FUNCTION_SCOPES = new Set([
  'Program',
  'FunctionDeclaration',
  'FunctionExpression',
  'ArrowFunctionExpression',
]);

/** Nodes that introduce a block scope for `let`, `const` and `class`. */
const BLOCK_SCOPES = new Set([
  'BlockStatement',
  'ForStatement',
  'ForInStatement',
  'ForOfStatement',
  'SwitchStatement',
  'CatchClause',
  'StaticBlock',
  'ClassDeclaration',
  'ClassExpression',
]);

type AnyNode = Node & { type: string; [key: string]: unknown };

/** Bindings introduced by each scope node, keyed by the node itself. */
export type ScopeMap = Map<AnyNode, Set<string>>;

const addBinding = (scopes: ScopeMap, scope: AnyNode | undefined, name: string): void => {
  if (!scope) return;
  const existing = scopes.get(scope);
  if (existing) {
    existing.add(name);
    return;
  }
  scopes.set(scope, new Set([name]));
};

/** Nearest ancestor (inclusive of `self`) that owns `var` and parameter bindings. */
const nearestFunctionScope = (chain: readonly AnyNode[]): AnyNode | undefined => {
  for (let i = chain.length - 1; i >= 0; i -= 1) {
    const node = chain[i];
    if (node && FUNCTION_SCOPES.has(node.type)) return node;
  }
  return undefined;
};

/** Nearest ancestor (inclusive of `self`) that owns `let`, `const` and `class` bindings. */
const nearestBlockScope = (chain: readonly AnyNode[]): AnyNode | undefined => {
  for (let i = chain.length - 1; i >= 0; i -= 1) {
    const node = chain[i];
    if (node && (BLOCK_SCOPES.has(node.type) || FUNCTION_SCOPES.has(node.type))) return node;
  }
  return undefined;
};

/**
 * Every name a destructuring pattern binds.
 *
 * Written recursively because patterns nest arbitrarily — `const [{ a: { b = 1 } }, ...rest] = x` binds
 * `b` and `rest`, and a gate that missed either would treat a later use of them as a free reference.
 */
const patternNames = (node: unknown, out: string[]): void => {
  if (!node || typeof node !== 'object') return;
  const candidate = node as AnyNode;
  switch (candidate.type) {
    case 'Identifier':
      out.push(candidate.name as string);
      return;
    case 'ObjectPattern':
      for (const property of candidate.properties as AnyNode[]) {
        if (property.type === 'RestElement') patternNames(property.argument, out);
        else patternNames(property.value, out);
      }
      return;
    case 'ArrayPattern':
      for (const element of candidate.elements as (AnyNode | null)[]) patternNames(element, out);
      return;
    case 'AssignmentPattern':
      patternNames(candidate.left, out);
      return;
    case 'RestElement':
      patternNames(candidate.argument, out);
      return;
    default:
      return;
  }
};

/**
 * True when this identifier is a *reference* to a binding rather than a name in some other syntactic
 * position — a property key, a member name, a label, or an import specifier.
 *
 * Getting this wrong in the permissive direction is the dangerous one, so the checks below are written
 * as an explicit list of non-reference positions rather than a heuristic.
 */
const isReference = (node: AnyNode, parent: AnyNode | undefined): boolean => {
  if (!parent) return true;
  switch (parent.type) {
    case 'MemberExpression':
      // `a.fetch` is a property; `a[fetch]` is a reference.
      return !(parent.property === node && !parent.computed);
    case 'Property':
      return !(parent.key === node && !parent.computed);
    case 'MethodDefinition':
    case 'PropertyDefinition':
      return !(parent.key === node && !parent.computed);
    case 'LabeledStatement':
    case 'BreakStatement':
    case 'ContinueStatement':
      return parent.label !== node;
    case 'ImportSpecifier':
    case 'ImportDefaultSpecifier':
    case 'ImportNamespaceSpecifier':
    case 'ExportSpecifier':
      return false;
    default:
      return true;
  }
};

export interface ScopeAnalysis {
  /** Bindings per scope node. */
  scopes: ScopeMap;
  /** Every reference that resolves to no binding in its scope chain, with its position. */
  freeReferences: Array<{ name: string; node: AnyNode; chain: AnyNode[] }>;
  /** Deepest AST nesting seen; a shape limit rather than a security check. */
  maxDepth: number;
}

/**
 * Resolve every identifier in a parsed program.
 *
 * Two passes rather than one because JavaScript hoists: `helper(); function helper() {}` is legal, so a
 * single-pass resolver would call the first `helper` free. Collecting all declarations before resolving
 * any reference is the cheapest correct answer.
 */
export function analyzeScopes(program: Node): ScopeAnalysis {
  const scopes: ScopeMap = new Map();
  const references: Array<{ name: string; node: AnyNode; chain: AnyNode[] }> = [];
  let maxDepth = 0;

  // Pass 1 — declarations.
  ancestor(program, {
    VariableDeclaration(node, _state, ancestors) {
      const chain = ancestors as unknown as AnyNode[];
      const declaration = node as unknown as AnyNode;
      const kind = declaration.kind as string;
      const target = kind === 'var' ? nearestFunctionScope(chain) : nearestBlockScope(chain);
      for (const declarator of declaration.declarations as AnyNode[]) {
        const names: string[] = [];
        patternNames(declarator.id, names);
        for (const name of names) addBinding(scopes, target, name);
      }
    },
    FunctionDeclaration(node, _state, ancestors) {
      const chain = ancestors as unknown as AnyNode[];
      const fn = node as unknown as AnyNode;
      // The function's own name binds in the enclosing scope; its parameters bind inside it.
      const enclosing = nearestFunctionScope(chain.slice(0, -1));
      if (fn.id) addBinding(scopes, enclosing, (fn.id as AnyNode).name as string);
      for (const param of fn.params as AnyNode[]) {
        const names: string[] = [];
        patternNames(param, names);
        for (const name of names) addBinding(scopes, fn, name);
      }
    },
    FunctionExpression(node) {
      const fn = node as unknown as AnyNode;
      if (fn.id) addBinding(scopes, fn, (fn.id as AnyNode).name as string);
      for (const param of fn.params as AnyNode[]) {
        const names: string[] = [];
        patternNames(param, names);
        for (const name of names) addBinding(scopes, fn, name);
      }
    },
    ArrowFunctionExpression(node) {
      const fn = node as unknown as AnyNode;
      for (const param of fn.params as AnyNode[]) {
        const names: string[] = [];
        patternNames(param, names);
        for (const name of names) addBinding(scopes, fn, name);
      }
    },
    ClassDeclaration(node, _state, ancestors) {
      const chain = ancestors as unknown as AnyNode[];
      const cls = node as unknown as AnyNode;
      const enclosing = nearestBlockScope(chain.slice(0, -1));
      if (cls.id) addBinding(scopes, enclosing, (cls.id as AnyNode).name as string);
    },
    ClassExpression(node) {
      const cls = node as unknown as AnyNode;
      if (cls.id) addBinding(scopes, cls, (cls.id as AnyNode).name as string);
    },
    CatchClause(node) {
      const clause = node as unknown as AnyNode;
      if (clause.param) {
        const names: string[] = [];
        patternNames(clause.param, names);
        for (const name of names) addBinding(scopes, clause, name);
      }
    },
  });

  // Pass 2 — references.
  ancestor(program, {
    Identifier(node, _state, ancestors) {
      const chain = ancestors as unknown as AnyNode[];
      if (chain.length > maxDepth) maxDepth = chain.length;

      const identifier = node as unknown as AnyNode;
      const parent = chain[chain.length - 2];
      if (!isReference(identifier, parent)) return;

      const name = identifier.name as string;
      for (let i = chain.length - 1; i >= 0; i -= 1) {
        const scope = chain[i];
        if (!scope) continue;
        if (scopes.get(scope)?.has(name)) return;
      }
      references.push({ name, node: identifier, chain: [...chain] });
    },
  });

  return { scopes, freeReferences: references, maxDepth };
}
