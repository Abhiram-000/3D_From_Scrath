/**
 * Device tiers and the resource budgets that go with them.
 *
 * `08-PERFORMANCE-AND-DEVICES.md` states these as contracts, not aspirations, and requires them to be
 * enforced *at admission, before allocation*: "a budget breach is never discovered as a stutter; it is
 * prevented as a number." That is only possible if one table is visible to the authoring pass (which
 * prices a build), the server (which audits it), and the runtime (which adapts it) — so the table
 * lives here, in the contracts package, rather than in any one of them.
 */
import { z } from 'zod';

/**
 * `MID` is the design centre, not the middle option: `08` names it "the *majority* of real users".
 * Tier is fluid — re-evaluated from measured frame time, because a thermally throttled high-end
 * laptop is a mid device and the platform must notice.
 */
export const DeviceTier = z.enum(['low', 'mid', 'high']);
export type DeviceTier = z.infer<typeof DeviceTier>;

/** Quality presets the adaptive ladder moves between, and the settings panel can pin. */
export const QualityPreset = z.enum(['minimum', 'low', 'medium', 'high', 'ultra']);
export type QualityPreset = z.infer<typeof QualityPreset>;

export const DeviceBudget = z.object({
  tier: DeviceTier,
  /** Triangles on screen. Hero parts get the detail; repetition is instanced, never duplicated. */
  maxTriangles: z.number().int().positive(),
  /** Draw calls — "the real killer on weak GPUs", so batching and instancing are budget lines. */
  maxDrawCalls: z.number().int().positive(),
  /** Shadow-casting lights: the most expensive thing a naive model asks for. */
  maxShadowLights: z.number().int().nonnegative(),
  maxPhysicsBodies: z.number().int().nonnegative(),
  maxInstances: z.number().int().nonnegative(),
  maxPoints: z.number().int().nonnegative(),
  /** Upper bound on device pixel ratio; the first and biggest lever on high-DPR phones. */
  maxPixelRatio: z.number().positive(),
  /** Minimum acceptable steady frame rate before the ladder steps down. */
  targetFps: z.number().int().positive(),
  /** Post-processing allowance: bloom+AA on high, AA on mid, neither on low. */
  postProcessing: z.enum(['none', 'antialias', 'full']),
  /** Physics solver substeps allowed at this tier. */
  maxSubsteps: z.number().int().positive(),
});
export type DeviceBudget = z.infer<typeof DeviceBudget>;

/**
 * The budget table.
 *
 * Numbers come straight from `08`'s resource-budget section (triangles ~150k/600k/2M, draw calls
 * <100/<400/<1500, shadow lights 0–1/2/4+, target fps 30/50/58). Instance and point ceilings are set
 * by transform-buffer memory rather than render cost, since an instanced set is one draw call — which
 * is why they are generous even on LOW.
 */
export const DEVICE_BUDGETS: Readonly<Record<DeviceTier, DeviceBudget>> = Object.freeze({
  low: Object.freeze({
    tier: 'low' as const,
    maxTriangles: 150_000,
    maxDrawCalls: 100,
    maxShadowLights: 1,
    maxPhysicsBodies: 48,
    maxInstances: 6_000,
    maxPoints: 20_000,
    maxPixelRatio: 1,
    targetFps: 30,
    postProcessing: 'none' as const,
    maxSubsteps: 2,
  }),
  mid: Object.freeze({
    tier: 'mid' as const,
    maxTriangles: 600_000,
    maxDrawCalls: 400,
    maxShadowLights: 2,
    maxPhysicsBodies: 160,
    maxInstances: 20_000,
    maxPoints: 80_000,
    maxPixelRatio: 1.5,
    targetFps: 50,
    postProcessing: 'antialias' as const,
    maxSubsteps: 4,
  }),
  high: Object.freeze({
    tier: 'high' as const,
    maxTriangles: 2_000_000,
    maxDrawCalls: 1_500,
    maxShadowLights: 4,
    maxPhysicsBodies: 512,
    maxInstances: 40_000,
    maxPoints: 200_000,
    maxPixelRatio: 2,
    targetFps: 58,
    postProcessing: 'full' as const,
    maxSubsteps: 8,
  }),
});

/**
 * The order the adaptive ladder steps down in: least damage first.
 *
 * `08` fixes this sequence and the reasoning behind its first rung — reducing pixel ratio is "often
 * the single biggest win on high-DPR phones; sharpness loss beats judder". Geometry decimation comes
 * late because it touches the lesson's legibility, and topology/behaviour are never touched at all:
 * "the same lesson, coarser — never fewer parts teaching less."
 */
export const QUALITY_LADDER = Object.freeze([
  'pixelRatio',
  'postProcessing',
  'shadows',
  'geometryDetail',
  'particles',
  'physicsSubsteps',
  'flatShading',
] as const);
export type QualityRung = (typeof QUALITY_LADDER)[number];

/**
 * Detected device facts, measured once at startup and re-evaluated from behaviour.
 *
 * `08` edge case: "a device that lies about its capabilities (reports high, performs low) — the live
 * frame-time monitor is the truth; trust behavior over strings." So `tier` here is an opening guess,
 * and `effectiveTier` in the runtime status is the number that governs.
 */
export const DeviceProfile = z.object({
  tier: DeviceTier,
  gpuRenderer: z.string().max(200).optional(),
  cores: z.number().int().positive().optional(),
  deviceMemoryGb: z.number().positive().optional(),
  pixelRatio: z.number().positive(),
  touch: z.boolean(),
  /** False when WebGL is unavailable: a first-class, explained state, never a blank page (`00`). */
  webgl2: z.boolean(),
  /** False when the physics WASM cannot load; the model animates and the UI says so (`02` R1). */
  wasm: z.boolean(),
  reducedMotion: z.boolean().default(false),
});
export type DeviceProfile = z.infer<typeof DeviceProfile>;

/** Live runtime cost, surfaced in the status bar and diagnostics — every number measured (`03` R9). */
export const RuntimeStats = z.object({
  fps: z.number().min(0),
  frameMillis: z.number().min(0),
  drawCalls: z.number().int().min(0),
  triangles: z.number().int().min(0),
  physicsMillis: z.number().min(0),
  /** Geometry/material cache hit rate; a visible stat because `08` requires the technique be measured. */
  cacheHitRate: z.number().min(0).max(1),
  quality: QualityPreset,
  effectiveTier: DeviceTier,
  simSeconds: z.number().min(0),
  /** Present when the ladder has stepped down, so the notice can explain what changed and why. */
  degradedRungs: z.array(z.enum(QUALITY_LADDER)).default([]),
});
export type RuntimeStats = z.infer<typeof RuntimeStats>;
