/**
 * The public surface of `@edu3d/sandbox`.
 *
 * The package deliberately exports the *pieces* rather than one `runUntrustedCode()` helper. Hosts differ
 * in ways that matter — the browser host owns a Worker and a canvas, the audit host owns a `node:vm`
 * context and no GPU — and hiding that difference behind one function would mean one of them silently got
 * capabilities suited to the other. `09`'s facade rule applies per layer boundary, and the boundary here
 * is the realm, not the package.
 */

export {
  FORBIDDEN_GLOBALS,
  FORBIDDEN_MEMBERS,
  FROZEN_INTRINSICS,
  GUEST_BINDINGS,
  NETWORK_GLOBALS,
  STORAGE_GLOBALS,
  REALM_GLOBALS,
  DYNAMIC_CODE_GLOBALS,
  SCHEDULING_GLOBALS,
  DEVICE_GLOBALS,
} from './forbidden.ts';

export { analyzeScopes, type ScopeAnalysis } from './scope.ts';
export { runStaticGate, describeViolations, type GateOptions } from './static-gate.ts';
export {
  instrumentLoops,
  isLoopNode,
  GUARD_IDENTIFIER,
  RESERVED_PREFIX,
  type InstrumentResult,
} from './instrument.ts';
export { hardenRealm, hardeningScript, auditRealm, type HardeningReport } from './harden.ts';
export {
  compileGuest,
  createGuard,
  GuestBudgetError,
  GuestTimeoutError,
  type CompiledGuest,
  type GuardHandle,
} from './compile.ts';
export { prepareProgram, type PreparedProgram, type PrepareOptions } from './prepare.ts';
