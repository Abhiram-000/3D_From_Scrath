/**
 * Admission pricing: decide whether a model fits the device *before* anything is allocated.
 *
 * `08-PERFORMANCE-AND-DEVICES.md` states the rule this file implements, and its reasoning is the whole design:
 * "These budgets are enforced at admission, before allocation — a model is priced from its declaration,
 * downgraded (coarser segments, fewer particles, simpler materials) until it fits, and only then built. A budget
 * breach is never discovered as a stutter; it is prevented as a number."
 *
 * That is possible here only because the authoring pass already measured everything: the manifest carries real
 * triangle, draw-call and instance counts from the builders themselves, not estimates. So this module is
 * arithmetic over a manifest — no GPU, no canvas, and runnable on the server for the audit's budget dimension.
 *
 * The one inviolable constraint, from the same document: "Degradation must never change *topology or behavior*:
 * the same lesson, coarser — never fewer parts teaching less." Nothing here removes a part.
 */
import {
  DEVICE_BUDGETS,
  QUALITY_LADDER,
  type BuildCost,
  type DeviceBudget,
  type DeviceTier,
  type ModelManifest,
  type QualityRung,
} from '@edu3d/contracts';

/** One decision the pricer made, so the status bar can explain itself rather than silently degrade. */
export interface AdmissionAdjustment {
  rung: QualityRung;
  /** Learner-facing sentence. `08`: "every step-down is *visible and explained*". */
  message: string;
  /** What it saved, for diagnostics: triangles removed, draw calls merged, shadows dropped. */
  saved?: string;
}

export interface AdmissionVerdict {
  /** False only when the model cannot fit even fully degraded — then it is refused, honestly (`08`). */
  admitted: boolean;
  /** The tier the model was priced against. */
  tier: DeviceTier;
  /** Cost as authored. */
  original: BuildCost;
  /** Cost after the adjustments below. */
  adjusted: BuildCost;
  adjustments: AdmissionAdjustment[];
  /** Per-part instructions the realizer applies: decimation targets and shadow denials. */
  decisions: RealizationDecisions;
  /** Set when `admitted` is false: what to tell the learner, in words they can act on. */
  refusal?: string;
}

/** What the realizer must do differently, keyed by part id where it is per-part. */
export interface RealizationDecisions {
  /** Fraction of original detail to keep per part, 1 meaning untouched. */
  decimation: Map<string, number>;
  /** Light ids allowed to cast shadows; every other light's request is denied. */
  shadowLights: Set<string>;
  /** Point clouds capped to this many points, keyed by part id. */
  pointCaps: Map<string, number>;
  /** Instanced sets capped to this many placements, keyed by part id. */
  instanceCaps: Map<string, number>;
  /** Post-processing allowance for this tier. */
  postProcessing: DeviceBudget['postProcessing'];
  /** Device pixel ratio ceiling. */
  maxPixelRatio: number;
  /** Physics substeps allowed. */
  maxSubsteps: number;
  /** True when flat shading is forced — the cheapest rung, LOW only. */
  flatShading: boolean;
}

/** A blank decision set: everything as authored. */
const permissiveDecisions = (budget: DeviceBudget): RealizationDecisions => ({
  decimation: new Map(),
  shadowLights: new Set(),
  pointCaps: new Map(),
  instanceCaps: new Map(),
  postProcessing: budget.postProcessing,
  maxPixelRatio: budget.maxPixelRatio,
  maxSubsteps: budget.maxSubsteps,
  flatShading: false,
});

/**
 * Rank parts by how much detail they can afford to lose.
 *
 * `01-MODELS.md` sets the priority: "Hero parts get the polygons... structural or repeated background parts get
 * coarse geometry, instancing, or merged buffers." So decimation takes from the biggest non-hero parts first,
 * and only reaches hero parts when nothing else is left — the opposite of a uniform reduction, which would blur
 * exactly the parts the lesson is about.
 */
function decimationOrder(
  manifest: ModelManifest,
): Array<{ id: string; triangles: number; hero: boolean }> {
  const candidates = manifest.parts
    .filter((part) => part.geometry && part.kind !== 'points')
    .map((part) => ({
      id: part.id,
      triangles:
        part.kind === 'instances'
          ? (part.geometry?.triangles ?? 0) * (part.instances?.length ?? 0)
          : (part.geometry?.triangles ?? 0),
      hero: part.hero,
    }));

  return candidates.sort((a, b) => {
    // Non-hero before hero, then largest first: take the cheapest-to-lose detail first.
    if (a.hero !== b.hero) return a.hero ? 1 : -1;
    return b.triangles - a.triangles;
  });
}

/**
 * The floor below which a shape stops being recognisable.
 *
 * `08` requires "recognizability floors — a coarser sphere, never a triangle", so no part is ever reduced below
 * this fraction of its authored detail. Hero parts get a higher floor because they are what the learner is
 * looking at.
 */
const RECOGNIZABILITY_FLOOR = 0.25;
const HERO_FLOOR = 0.55;

/**
 * Price a manifest against a device budget and decide what to change.
 *
 * Order of concessions follows `QUALITY_LADDER` — least damage first — because `08` fixes that order and its
 * reasoning: pixel ratio is the cheapest visible loss, geometry and physics detail are the most expensive to the
 * lesson.
 */
export function priceModel(manifest: ModelManifest, tier: DeviceTier): AdmissionVerdict {
  const budget = DEVICE_BUDGETS[tier];
  const decisions = permissiveDecisions(budget);
  const adjustments: AdmissionAdjustment[] = [];

  const original = manifest.cost;
  let triangles = original.triangles;
  let drawCalls = original.drawCalls;
  let instances = original.instances;

  // ── Rung: post-processing ─────────────────────────────────────────────────
  // Nothing to decide per model; the tier's allowance simply applies. Recorded when it differs from the best
  // available so the diagnostics panel can show why bloom is missing.
  if (budget.postProcessing !== 'full') {
    adjustments.push({
      rung: 'postProcessing',
      message:
        budget.postProcessing === 'none'
          ? 'Post-processing is off on this device to keep motion smooth.'
          : 'Bloom is off on this device; antialiasing is on.',
    });
  }

  // ── Rung: shadows ─────────────────────────────────────────────────────────
  // Shadow-casting lights are the most expensive thing a naive model asks for (`08`), so the allowance is spent
  // on the lights most likely to matter: the brightest ones, which carry the scene's primary form.
  const shadowRequests = manifest.lights
    .filter((light) => light.castShadow)
    .sort((a, b) => b.intensity - a.intensity);

  for (const light of shadowRequests.slice(0, budget.maxShadowLights)) {
    decisions.shadowLights.add(light.id);
  }
  const deniedShadows = Math.max(0, shadowRequests.length - budget.maxShadowLights);
  if (deniedShadows > 0) {
    adjustments.push({
      rung: 'shadows',
      message:
        budget.maxShadowLights === 0
          ? 'Shadows are off on this device.'
          : `Shadows limited to ${budget.maxShadowLights} light${budget.maxShadowLights === 1 ? '' : 's'} on this device.`,
      saved: `${deniedShadows} shadow map${deniedShadows === 1 ? '' : 's'}`,
    });
  }

  // ── Rung: particles (point clouds and instance counts) ────────────────────
  let pointTotal = 0;
  for (const part of manifest.parts) {
    if (part.kind !== 'points' || !part.geometry) continue;
    pointTotal += part.geometry.vertices;
  }

  if (pointTotal > budget.maxPoints) {
    // Scaled proportionally rather than truncating one cloud, so a model with several fields keeps all of them
    // visible — `08` wants "visible partial-simulation notices rather than silent removal".
    const scale = budget.maxPoints / pointTotal;
    for (const part of manifest.parts) {
      if (part.kind !== 'points' || !part.geometry) continue;
      decisions.pointCaps.set(part.id, Math.max(64, Math.floor(part.geometry.vertices * scale)));
    }
    adjustments.push({
      rung: 'particles',
      message:
        'Particle counts reduced on this device; the pattern is the same, drawn with fewer points.',
      saved: `${(pointTotal - budget.maxPoints).toLocaleString()} points`,
    });
  }

  if (instances > budget.maxInstances) {
    const scale = budget.maxInstances / instances;
    let capped = 0;
    for (const part of manifest.parts) {
      if (part.kind !== 'instances' || !part.instances) continue;
      // A minimum of 3 keeps a radial array reading as an array rather than a lone object.
      const cap = Math.max(3, Math.floor(part.instances.length * scale));
      decisions.instanceCaps.set(part.id, cap);
      capped += part.instances.length - cap;
      triangles -= (part.geometry?.triangles ?? 0) * (part.instances.length - cap);
    }
    instances = budget.maxInstances;
    adjustments.push({
      rung: 'particles',
      message: 'Repeated parts thinned on this device to keep the frame rate up.',
      saved: `${capped.toLocaleString()} instances`,
    });
  }

  // ── Rung: geometry detail ─────────────────────────────────────────────────
  if (triangles > budget.maxTriangles) {
    const order = decimationOrder(manifest);
    let remaining = triangles - budget.maxTriangles;
    let reducedParts = 0;

    for (const candidate of order) {
      if (remaining <= 0) break;
      if (candidate.triangles < 64) continue;

      const floor = candidate.hero ? HERO_FLOOR : RECOGNIZABILITY_FLOOR;
      const removable = Math.floor(candidate.triangles * (1 - floor));
      if (removable <= 0) continue;

      const take = Math.min(removable, remaining);
      const keepFraction = (candidate.triangles - take) / candidate.triangles;
      decisions.decimation.set(candidate.id, keepFraction);
      remaining -= take;
      triangles -= take;
      reducedParts += 1;
    }

    if (reducedParts > 0) {
      adjustments.push({
        rung: 'geometryDetail',
        message:
          'Quality reduced to keep motion smooth: shapes are coarser, and every part is still here.',
        saved: `${(original.triangles - triangles).toLocaleString()} triangles across ${reducedParts} parts`,
      });
    }

    if (remaining > 0) {
      // Even at the recognisability floor it does not fit. `08`: "A model that cannot fit even fully decimated —
      // refuse with an honest message and a simpler re-generation offer, never ship a slideshow."
      return {
        admitted: false,
        tier,
        original,
        adjusted: { ...original, triangles, drawCalls, instances },
        adjustments,
        decisions,
        refusal:
          `This model needs about ${Math.round(triangles / 1000)}k triangles, and this device can draw about ` +
          `${Math.round(budget.maxTriangles / 1000)}k smoothly. Try generating a simpler version of the same topic.`,
      };
    }
  }

  // ── Draw calls ────────────────────────────────────────────────────────────
  // Not a ladder rung, because the fix is structural rather than a quality setting: static parts merge into
  // shared buffers. The realizer does the merging; here it is only priced and reported.
  if (drawCalls > budget.maxDrawCalls) {
    const mergeable = manifest.parts.filter((part) => part.staticGeometry).length;
    if (mergeable > 1) {
      // Merged static geometry collapses to roughly one draw call per material.
      const materialsAmongStatic = new Set(
        manifest.parts
          .filter((part) => part.staticGeometry)
          .map((part) => part.material?.cacheKey ?? ''),
      ).size;
      const saved = Math.max(0, mergeable - materialsAmongStatic);
      drawCalls -= saved;
      if (saved > 0) {
        adjustments.push({
          rung: 'geometryDetail',
          message: 'Static parts merged into shared buffers to reduce draw calls.',
          saved: `${saved} draw calls`,
        });
      }
    }

    if (drawCalls > budget.maxDrawCalls) {
      return {
        admitted: false,
        tier,
        original,
        adjusted: { ...original, triangles, drawCalls, instances },
        adjustments,
        decisions,
        refusal:
          `This model issues ${drawCalls} draw calls and this device can handle about ${budget.maxDrawCalls}. ` +
          'Repeated parts should be instanced rather than built individually. Try generating it again.',
      };
    }
  }

  // ── Rung: flat shading ────────────────────────────────────────────────────
  if (tier === 'low') {
    decisions.flatShading = true;
    adjustments.push({
      rung: 'flatShading',
      message: 'Flat shading on this device; the shapes are unchanged.',
    });
  }

  // ── Rung: physics substeps ────────────────────────────────────────────────
  if (manifest.physics && manifest.physics.world.substeps > budget.maxSubsteps) {
    adjustments.push({
      rung: 'physicsSubsteps',
      message: 'Physics accuracy reduced slightly on this device.',
      saved: `${manifest.physics.world.substeps - budget.maxSubsteps} substeps`,
    });
  }

  if (manifest.physics && manifest.physics.bodies.length > budget.maxPhysicsBodies) {
    adjustments.push({
      rung: 'physicsSubsteps',
      message: `Simulating ${budget.maxPhysicsBodies} of ${manifest.physics.bodies.length} bodies on this device; the rest are animated.`,
    });
  }

  return {
    admitted: true,
    tier,
    original,
    adjusted: {
      ...original,
      triangles,
      drawCalls,
      instances,
    },
    adjustments,
    decisions,
  };
}

/**
 * Which rungs the ladder would step down next, in order, from a given quality level.
 *
 * Used by the live adaptive ladder rather than by admission: `08` requires the runtime to step down under
 * sustained pressure and back up when it clears, in this fixed order, with hysteresis so it cannot oscillate.
 * Sharing the order with admission means a device that started degraded and a device that degraded later end up
 * in the same state, which is what keeps the two systems from fighting.
 */
export function remainingRungs(applied: readonly QualityRung[]): QualityRung[] {
  const used = new Set(applied);
  return QUALITY_LADDER.filter((rung) => !used.has(rung));
}

/** A one-line summary for the status bar. Every number measured, never estimated (`03` R9). */
export function summarizeCost(cost: BuildCost): string {
  const triangles =
    cost.triangles >= 1_000_000
      ? `${(cost.triangles / 1_000_000).toFixed(1)}M`
      : `${Math.round(cost.triangles / 1000)}k`;
  return `${cost.parts} parts · ${triangles} tris · ${cost.drawCalls} draws`;
}
