/**
 * The reference heart, through the same pipeline as the turbofan: extract -> static gate -> instrument ->
 * author -> manifest. Authoring this model is the organic-domain gate on the scene API: if heart anatomy
 * cannot be expressed here, no prompt will fix that.
 */
import { describe, expect, it } from 'vitest';
import { prepareProgram, describeViolations } from '@edu3d/sandbox';
import { apiSurfaceSet } from '../src/authoring/api-surface.ts';
import { authorModel } from '../src/authoring/guest.ts';
import { HEART_MODEL_SOURCE } from '../src/reference/heart.ts';

const prepare = (source: string) => prepareProgram(source, { apiSurface: apiSurfaceSet() });

const author = (source: string) => {
  const prepared = prepare(source);
  expect(prepared.ok, describeViolations(prepared.gate).join('\n')).toBe(true);
  return authorModel({ code: prepared.instrumented, tier: 'mid', seed: 7, harden: false });
};

describe('the reference heart model', () => {
  it('passes the static gate', () => {
    const prepared = prepare(HEART_MODEL_SOURCE);
    expect(prepared.ok, describeViolations(prepared.gate).join('\n')).toBe(true);
  });

  it('builds and produces a valid manifest', () => {
    const result = author(HEART_MODEL_SOURCE);
    expect(result.ok, result.ok ? '' : result.message).toBe(true);
    if (!result.ok) return;
    expect(result.manifest.name).toBe('The human heart');
    expect(result.manifest.parameters).toHaveLength(8);
    expect(result.manifest.callbacks.hasFrame).toBe(true);
    expect(result.manifest.parts.length).toBeGreaterThanOrEqual(40);
    expect(result.manifest.cost.triangles).toBeGreaterThan(0);
  });

  it('has every parameter write observable state', () => {
    const result = author(HEART_MODEL_SOURCE);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    result.builder.sweepParameter('strokeVolume', 120);
    expect([...(result.builder.observedWrites.get('strokeVolume') ?? [])]).toContain('transform');

    result.builder.sweepParameter('contractility', 1.5);
    expect((result.builder.observedWrites.get('contractility') ?? new Set()).size).toBeGreaterThan(
      0,
    );
  });

  it('reaches the detailed-complexity band, and reports its scale', () => {
    const result = author(HEART_MODEL_SOURCE);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // 'Detailed' asks for 60-150 meaningful parts; the heart should land in that band without a
    // voxel-heavy build, because wall thickness must stay exact rather than resolution-clamped.
    console.log(
      '[heart] parts:',
      result.manifest.parts.length,
      '| triangles:',
      result.manifest.cost.triangles,
      '| draw calls:',
      result.manifest.cost.drawCalls,
    );
    expect(result.manifest.parts.length).toBeGreaterThanOrEqual(60);
    expect(result.manifest.cost.drawCalls).toBeLessThanOrEqual(80);
  });
});
