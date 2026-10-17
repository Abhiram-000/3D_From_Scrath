/**
 * Dev-console contract.
 *
 * The console exists because generation failures were undiagnosable: the watchdog kills a stalled
 * build with one learner-facing sentence, and the developer had no record of which stage ate the
 * time, what the guest printed, or whether anything was ever realized. Every logger here must be
 * compiled out of the production bundle (`import.meta.env.DEV`), and every summary string a human
 * reads must be produced by a pure formatter that stays deterministic in tests.
 */
import { describe, expect, it } from 'vitest';
import {
  devEnabled,
  devError,
  devGroup,
  devGroupEnd,
  devLog,
  devTimer,
  devWarn,
  formatFailure,
  formatModelSummary,
  formatStats,
  setDevSink,
  type DevSink,
} from './dev-console.ts';

describe('the pure formatters', () => {
  it('summarizes a finished build in one readable line', () => {
    expect(
      formatModelSummary({
        name: 'How a water molecule forms',
        ms: 11_245,
        parts: 61,
        parameters: 5,
        motions: 2,
        triangles: 118_004,
        drawCalls: 64,
      }),
    ).toBe(
      'How a water molecule forms — 61 parts · 5 params · 2 motions · 118,004 tris / 64 draws — 11.2s',
    );
  });

  it('summarizes a failure with its timeout class and guest log count', () => {
    expect(formatFailure({ message: 'Build budget exhausted', timedOut: true, logCount: 12 })).toBe(
      'TIMEOUT — Build budget exhausted · 12 guest log line(s)',
    );
    expect(formatFailure({ message: 'boom at line 7', timedOut: false, logCount: 0 })).toBe(
      'FAILED — boom at line 7',
    );
  });

  it('renders live frame stats without locale drift', () => {
    expect(formatStats({ fps: 240, draws: 0, triangles: 0, seconds: 75 })).toBe(
      'FPS 240 · draws 0 · tris 0 · t 75s',
    );
  });
});

describe('the loggers', () => {
  // vitest runs with import.meta.env.DEV true, so the loggers are live here — pinned explicitly
  // rather than silently assumed. The production build strips the guarded calls at compile time;
  // that is verified by grepping the prod bundle for the prefix, not here.
  it('assumes a dev-mode test environment, explicitly', () => {
    expect(devEnabled).toBe(true);
  });

  // A recording sink, never a console spy: the global console's type resolves differently under the
  // DOM lib, and the runner patches its methods, so spying on it is flaky by construction.
  function record(): { lines: string[]; sink: DevSink } {
    const lines: string[] = [];
    const push = (...args: unknown[]) => lines.push(args.map(String).join(' '));
    return {
      lines,
      sink: { debug: push, warn: push, error: push, groupCollapsed: push, groupEnd: () => {} },
    };
  }

  it('routes through the sink with the dev prefix and the message', () => {
    const { lines, sink } = record();
    setDevSink(sink);
    try {
      devLog('stage message');
      devWarn('watchdog close');
      devError('build failed', 'code guest');
      expect(lines[0]).toContain('[edu3d:dev] stage message');
      expect(lines[1]).toContain('[edu3d:dev] watchdog close');
      expect(lines[2]).toContain('[edu3d:dev] build failed');
      expect(lines[2]).toContain('code guest');
    } finally {
      setDevSink(null);
    }
  });

  it('groups collapse under one labelled header', () => {
    const { lines, sink } = record();
    setDevSink(sink);
    try {
      devGroup('water molecule — build');
      devLog('inside the group');
      devGroupEnd();
      expect(lines[0]).toContain('[edu3d:dev] water molecule — build');
      expect(lines[1]).toContain('inside the group');
    } finally {
      setDevSink(null);
    }
  });

  it('returns a timer that reports elapsed milliseconds', () => {
    const { lines, sink } = record();
    setDevSink(sink);
    try {
      const end = devTimer('authoring');
      const line = end();
      expect(line).toMatch(/^authoring — [\d.]+ms$/);
      expect(lines[lines.length - 1]).toContain('authoring —');
    } finally {
      setDevSink(null);
    }
  });
});
