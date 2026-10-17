/**
 * Dev-only generation console.
 *
 * Why this exists: when a generated model died, it died with one learner-facing sentence —
 * "This model stopped responding" — and the developer had no record of which stage ate the time,
 * what the guest's own console.log had printed, or whether anything was ever realized. The WebGL
 * errors a dead worker leaves in the console (zero-size framebuffer spam) are symptoms, not causes.
 * Every stage of a build now emits a line here while it happens, so the next dead model is
 * diagnosed in one glance instead of reconstructed after the fact.
 *
 * Compile-time gating is the whole point: `import.meta.env.DEV` is statically replaced by Vite, so
 * in a production bundle every logger collapses to a no-op and every string literal in this
 * module's callers is unreachable — verified by grepping the prod *executable* chunks for
 * `[edu3d:dev]` and finding none. The one honest caveat: the literal still appears inside shipped
 * source maps (they embed original source text), where it is inert metadata, never executed. The
 * pure formatters are the deliberate exception to stripping — plain functions, unit-tested, only
 * invoked from guarded call sites.
 */

/** Compile-time switch. Never check `process.env` or localStorage here — build output must be clean. */
export const devEnabled = import.meta.env.DEV === true;

/** Unique marker so the prod bundle can be grepped: zero occurrences is the pass condition. */
export const DEV_PREFIX = '[edu3d:dev]';

/**
 * The sink is injectable so tests can record output without spying on the global console — whose
 * type resolves differently under the DOM lib and whose methods are patched by the runner. Test
 * code may call `setDevSink`; production never does, and a null sink silences everything.
 */
export interface DevSink {
  debug: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  groupCollapsed: (label: string, ...rest: unknown[]) => void;
  groupEnd: () => void;
}

let sink: DevSink | null = {
  debug: (...args) => console.debug(...args),
  warn: (...args) => console.warn(...args),
  error: (...args) => console.error(...args),
  groupCollapsed: (label) => console.groupCollapsed(label),
  groupEnd: () => console.groupEnd(),
};

export function setDevSink(next: DevSink | null): void {
  sink = next;
}

const STYLE = 'color:#c2885c;font-weight:600';

type Logf = (message: string, ...details: unknown[]) => void;

// Each logger is a static ternary on the compile-time flag: in a production build `devEnabled`
// folds to `false`, the logging branch — strings included — is dead code the minifier removes, and
// the export collapses to a no-op. That is what makes the prod-bundle grep a pass condition rather
// than an aspiration; a runtime `if (!enabled)` inside a shared emit function would leave every
// string in the bundle, merely silenced.
export const devGroup: (label: string) => void = devEnabled
  ? (label) => {
      sink?.groupCollapsed(`%c${DEV_PREFIX} ${label}`, STYLE);
    }
  : () => {};

export const devGroupEnd: () => void = devEnabled
  ? () => {
      sink?.groupEnd();
    }
  : () => {};

export const devLog: Logf = devEnabled
  ? (message, ...details) => {
      sink?.debug(`%c${DEV_PREFIX} ${message}`, STYLE, ...details);
    }
  : () => {};

export const devWarn: Logf = devEnabled
  ? (message, ...details) => {
      sink?.warn(`%c${DEV_PREFIX} ${message}`, STYLE, ...details);
    }
  : () => {};

export const devError: Logf = devEnabled
  ? (message, ...details) => {
      sink?.error(`%c${DEV_PREFIX} ${message}`, STYLE, ...details);
    }
  : () => {};

/**
 * Times a stage. Returns its own end function rather than requiring the caller to track marks, so
 * instrumentation is one line at the top of a stage and one at the bottom.
 */
export function devTimer(label: string): () => string {
  const start = performance.now();
  return () => {
    const ms = performance.now() - start;
    const line = `${label} — ${ms < 100 ? ms.toFixed(1) : Math.round(ms)}ms`;
    devLog(line);
    return line;
  };
}

/**
 * Thousands-separated integer with no locale dependency, so a test and a console agree byte for
 * byte on every platform.
 */
function count(value: number): string {
  return String(Math.round(value)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function seconds(ms: number): string {
  return `${ms < 100 ? ms.toFixed(1) : Math.round(ms / 100) / 10}s`;
}

export interface ModelSummaryInput {
  name: string;
  ms: number;
  parts: number;
  parameters: number;
  motions: number;
  triangles: number;
  drawCalls: number;
}

export function formatModelSummary(input: ModelSummaryInput): string {
  return (
    `${input.name} — ${input.parts} parts · ${input.parameters} params · ${input.motions} motions` +
    ` · ${count(input.triangles)} tris / ${input.drawCalls} draws — ${seconds(input.ms)}`
  );
}

export function formatFailure(input: {
  message: string;
  timedOut: boolean;
  logCount: number;
}): string {
  const klass = input.timedOut ? 'TIMEOUT' : 'FAILED';
  const logs = input.logCount > 0 ? ` · ${input.logCount} guest log line(s)` : '';
  return `${klass} — ${input.message}${logs}`;
}

export interface StatsInput {
  fps: number;
  draws: number;
  triangles: number;
  seconds: number;
}

export function formatStats(input: StatsInput): string {
  return `FPS ${round1(input.fps)} · draws ${input.draws} · tris ${count(input.triangles)} · t ${input.seconds}s`;
}

function round1(value: number): string {
  return Number.isFinite(value) ? `${Math.round(value * 10) / 10}` : '?';
}
