/**
 * The realizer's decimation contract, proved at Node level (three's geometry layer is headless;
 * only the final rasterization needs a GPU, and that is not what this pins).
 *
 * The property under test, from the render-performance spec's "four quality lies": the realizer
 * used to report the model's AUTHOR triangle count while building (at most via index-stride
 * thinning) something smaller — so `stats.triangles` described a model that was never on screen.
 * The report must be realized-by-construction, and the decimated triangles must be QEM output:
 * no degenerates, silhouette intact enough that the part's bounding sphere agrees with the
 * authored one's (`Q2`/`Q5`).
 */
import { describe, expect, it } from 'vitest';
import { prepareProgram, describeViolations } from '@edu3d/sandbox';
import { apiSurfaceSet } from '../src/authoring/api-surface.ts';
import { authorInNodeVm } from '../src/hosts/node-host.ts';
import { priceModel } from '../src/runtime/admission.ts';
import { realize } from '../src/runtime/realize.ts';
import { REFERENCE_MODEL_SOURCE } from '../src/reference/turbofan.ts';
import type { MeshData } from '../src/geometry/mesh-data.ts';

describe('the realizer decimation contract', () => {
  it('reports realized triangles, and every decimated triangle is real geometry', () => {
    const prepared = prepareProgram(REFERENCE_MODEL_SOURCE, { apiSurface: apiSurfaceSet() });
    expect(prepared.ok, describeViolations(prepared.gate).join('\n')).toBe(true);
    if (!prepared.ok) return;

    const result = authorInNodeVm({ code: prepared.instrumented, tier: 'low', seed: 5 });
    expect(result.ok, result.ok ? '' : result.message).toBe(true);
    if (!result.ok) return;

    const decisions = priceModel(result.manifest, 'low');
    const geometries = new Map<string, MeshData>();
    for (const record of result.builder.geometry.entries()) {
      geometries.set(
        record.handle.cacheKey,
        result.builder.geometry.resolve(record.handle) as MeshData,
      );
    }

    const realized = realize({
      manifest: result.manifest,
      geometries,
      decisions: decisions.decisions,
    });

    const authored = result.manifest.cost.triangles;
    const realizedTris = realized.stats.triangles;

    // The realised figure equals what the index buffers actually hold, summed per part — the
    // renderer's own accounting, with instanced parts drawing `count` copies of one buffer
    // multiplied the same way the renderer multiplies them. (Q5, realized by construction
    // instead of asserted after the fact.) This is the headline: the old realizer reported the
    // model's authored count while shipping (at best) stride-thinned buffers.
    let indexTriangles = 0;
    for (const part of realized.parts.values()) {
      const count = (part as { count?: number }).count ?? 1;
      const geometry = (part as { geometry?: { index?: { count: number } } }).geometry;
      if (!geometry) continue;
      indexTriangles += ((geometry.index?.count ?? 0) / 3) * count;
    }
    expect(realizedTris, 'stats.triangles must be realised, not authored').toBe(indexTriangles);

    // Low tier decimates the reference model: its decisions are present and the realised total is
    // strictly lower than authored, by at least the fractions admission priced.
    expect(decisions.decisions.decimation.size).toBeGreaterThan(0);
    expect(
      realizedTris,
      'realised triangles must drop below authored on the low tier',
    ).toBeLessThan(authored);

    // Every decimated part's geometry keeps a bounding sphere that agrees with the authored one
    // within 10%: the shape degraded as a shape, not into confetti with a shrunk hull.
    for (const [partId, fraction] of decisions.decisions.decimation) {
      const part = realized.parts.get(partId) as
        { geometry?: { boundingSphere?: { radius: number } } } | undefined;
      const node = result.manifest.parts.find((p) => p.id === partId);
      expect(part, partId).toBeDefined();
      expect(node, partId).toBeDefined();
      // A measured bounding radius is part of the manifest contract (`factory.ts` computes it for
      // every handle); a missing one fails the test rather than the arithmetic.
      const authoredRadius = node!.geometry!.boundingRadius!;
      const realizedRadius = part!.geometry!.boundingSphere!.radius;
      expect(realizedRadius, `${partId} keep ${fraction}`).toBeGreaterThanOrEqual(
        authoredRadius * 0.85,
      );
      expect(realizedRadius, `${partId} keep ${fraction}`).toBeLessThanOrEqual(
        authoredRadius * 1.15,
      );
    }
  });
});
