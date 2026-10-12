/**
 * Battery attribution and measurement tests.
 *
 * `00:135`: "treat a prompt change like a code change with evidence — never vibes-based tuning."
 * Two things made that impossible: history rows carried the literal string 'see bundle
 * provenance' where the prompt version belongs, and bindingCount was a substring match over
 * joined deficiency prose — a parameter named `mass` matched the word "massive". The tests here
 * pin the fixes: rows carry real values, and bindings are read from structured deficiency ids.
 *
 * The rate-limit exemption is tested here too because it exists for the battery's sake: the
 * battery is an HTTP client of the server, so the generate limiter would otherwise count its own
 * topics against it and record its 429s as build failures. The exemption must be two things at
 * once (marker header AND loopback socket) so an internet client can never claim it.
 */
import { describe, expect, it } from 'vitest';
import { PROMPT_VERSION } from '../src/services/prompts.ts';
import {
  BATTERY_REQUEST_HEADER,
  connectionAddress,
  isBatteryExemption,
  isLoopbackAddress,
} from '../src/services/rate-limits.ts';
import { resolveConfig } from '../src/config/config.ts';
import { dryRunRow, deriveBindingCount, historyRow } from '../src/scripts/topic-battery.ts';

describe('bindingCount from structured deficiencies', () => {
  it('counts a parameter unbound only when a parameterLeverage deficiency names its id', () => {
    // The canonical false positive: deficiency PROSE contains the word "massive" (about a gear
    // ratio), there is no deficiency about the `mass` parameter at all. Structurally, only
    // `rate` is accused.
    const parameterIds = ['mass', 'rate'];
    const unboundParameterIds = ['rate'];

    // The old heuristic, replicated: substring match over joined prose. It counts `mass` because
    // "massive".includes("mass") — the wrong answer this replacement exists to remove.
    const prose = "Parameter 'rate' changes nothing visible. The gear ratio looks massive.";
    const oldHeuristicCount = parameterIds.filter((id) =>
      prose.toLowerCase().includes(id.toLowerCase()),
    ).length;
    expect(oldHeuristicCount).toBe(2); // both wrongly counted as unbound → bindingCount 0

    // The new derivation: subjectId equality. Only `rate` is unbound, so `mass` still counts.
    expect(deriveBindingCount(parameterIds, unboundParameterIds)).toBe(1);
  });

  it('treats an absent structured list as no accusations rather than all parameters bound', () => {
    // An older server that never sent the field: bindingCount falls back to every parameter
    // counting as bound (0 accused), never to a prose guess.
    expect(deriveBindingCount(['a', 'b', 'c'], [])).toBe(3);
  });
});

describe('history row attribution', () => {
  const summary = {
    buildRate: 0.625,
    averagePartCount: 39,
    averageBindingCount: 2,
    averageAuditScore: 84,
    totalDurationSeconds: 3109,
  };

  it('carries the real prompt version and model, not placeholders', () => {
    const row = historyRow(PROMPT_VERSION, 'test-model', summary);
    expect(row.promptVersion).toBe(PROMPT_VERSION);
    expect(row.promptVersion).not.toBe('see bundle provenance');
    expect(row.model).toBe('test-model');
    expect(row.model).not.toBe('per server config');
    expect(row.buildRate).toBe(0.625);
    expect(typeof row.at).toBe('string');
  });

  it('dry-run row resolves the model from config and names the prompt version, spending nothing', () => {
    const config = resolveConfig({ AI_MODEL: 'battery-dry-run-model' });
    const row = dryRunRow(config);
    expect(row.promptVersion).toBe(PROMPT_VERSION);
    expect(row.model).toBe('battery-dry-run-model');
    // Zero topics ran: the row is the shape, not a measurement.
    expect(row.buildRate).toBe(0);
    expect(row.averageBindingCount).toBe(0);
  });
});

describe('the battery rate-limit exemption', () => {
  it('requires the marker header AND a loopback socket', () => {
    expect(isBatteryExemption('battery', '127.0.0.1')).toBe(true);
    expect(isBatteryExemption('battery', '::1')).toBe(true);
    expect(isBatteryExemption('battery', '::ffff:127.0.0.1')).toBe(true);
    // An internet client can set the header; it can never be the loopback socket.
    expect(isBatteryExemption('battery', '203.0.113.9')).toBe(false);
    // A local client without the explicit marker gets no exemption either.
    expect(isBatteryExemption(undefined, '127.0.0.1')).toBe(false);
    expect(isBatteryExemption('1', '127.0.0.1')).toBe(false);
    // No socket information at all (a test harness): fail closed.
    expect(isBatteryExemption('battery', undefined)).toBe(false);
  });

  it('recognises only loopback spellings', () => {
    expect(isLoopbackAddress('127.0.0.1')).toBe(true);
    expect(isLoopbackAddress('::1')).toBe(true);
    expect(isLoopbackAddress('::ffff:127.0.0.1')).toBe(true);
    expect(isLoopbackAddress('localhost')).toBe(false);
    expect(isLoopbackAddress(undefined)).toBe(false);
  });

  it('reads the address from the request socket, failing soft when there is none', () => {
    // The socket is the one thing a remote client cannot forge; forwarded headers are not read.
    const withSocket = {
      env: { incoming: { socket: { remoteAddress: '127.0.0.1' } } },
    } as never;
    expect(connectionAddress(withSocket)).toBe('127.0.0.1');

    const withoutSocket = { env: {} } as never;
    expect(connectionAddress(withoutSocket)).toBeUndefined();
  });

  it('uses a header name the battery actually sends', () => {
    // The weld between server and battery: if either side renames it, the exemption silently
    // stops applying (safe direction — the battery just gets limited again).
    expect(BATTERY_REQUEST_HEADER).toBe('x-edu3d-battery');
  });
});
