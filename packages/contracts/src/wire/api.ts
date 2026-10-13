/**
 * Request and response shapes for every endpoint, plus the gallery record.
 *
 * `04-BACKEND.md` requires validation at the boundary — "malformed input dies at the door with a 400,
 * never reaches the pipeline" — and these schemas are that door. They are also the shared source of
 * truth the frontend compiles against, so a field rename breaks the build rather than production.
 */
import { z } from 'zod';
import { EpochMillis, Uuid, shortText } from '../primitives.ts';
import { ModelBundle, Domain } from '../manifest/model.ts';
import { DeviceTier } from '../budgets.ts';
import { QuizQuestion } from '../manifest/behavior.ts';
import { AuditSummary } from './generation.ts';

/**
 * Topic length bounds.
 *
 * 500 characters matches the landing page's visible counter (`07`); the server clamps at the same
 * number rather than a larger private one, because two different limits is how a UI ends up lying.
 * The minimum matches the landing page's "a few words is enough" rule — a one-character topic would
 * sail past schema validation and spend a whole AI call to produce nothing, so it dies at the door
 * with the 400 `04` requires instead.
 */
export const MAX_TOPIC_LENGTH = 500;
export const MIN_TOPIC_LENGTH = 5;

/** How ambitious the model should be. Bounds what the prompt asks for; never lowers the quality bar. */
export const ComplexityPreference = z.enum(['simple', 'balanced', 'detailed', 'maximum']);
export type ComplexityPreference = z.infer<typeof ComplexityPreference>;

/**
 * What each level actually means, in numbers.
 *
 * These numbers used to live in the server's `prompts.ts`, which put them out of reach of the
 * client: the landing page could offer a "detail" control but had no honest way to label it,
 * because the part counts the model would be asked for were written in prose on the other side of
 * the wire. So the numbers live here now, and both sides render from this one table —
 * `COMPLEXITY_GUIDANCE` in the generation prompt is derived from it rather than restated, which
 * removes the drift where the control promises "60–150 parts" and the prompt asks for something
 * else.
 *
 * The levels are ordered by render cost as much as by part count, because that is the tradeoff a
 * learner is actually choosing: `maximum` is a ~2M-triangle scene and wants a real GPU. The
 * triangle ceiling is the device's own HIGH-tier budget from `08` scaled down, so "heavy" here
 * means what the platform's admission table will allow rather than a marketing adjective.
 */
export const COMPLEXITY_LEVELS = [
  {
    id: 'simple' as const,
    label: 'Light',
    parts: [8, 15] as const,
    parameters: [2, 2] as const,
    triangles: 'under ~150k',
    blurb: 'A handful of parts. Builds fastest and runs on any phone.',
  },
  {
    id: 'balanced' as const,
    label: 'Balanced',
    parts: [20, 50] as const,
    parameters: [3, 4] as const,
    triangles: 'under ~600k',
    blurb: 'A real subassembly or two. The everyday choice.',
  },
  {
    id: 'detailed' as const,
    label: 'Detailed',
    parts: [60, 150] as const,
    parameters: [4, 6] as const,
    triangles: 'under ~2M',
    blurb: 'A full machine, built from reusable subassemblies.',
  },
  {
    id: 'maximum' as const,
    label: 'Maximum',
    parts: [150, 300] as const,
    parameters: [5, 8] as const,
    triangles: 'up to the device budget, about 2M',
    blurb: 'Everything the concept has. Heaviest render — wants a good GPU.',
  },
];
export const COMPLEXITY_IDS = COMPLEXITY_LEVELS.map((level) => level.id);

export const GenerateRequest = z.object({
  /**
   * The learner's words. Wrapped and labelled untrusted data before it reaches the model (`04`) — it is
   * never concatenated into the instruction section of a prompt.
   */
  topic: shortText(MAX_TOPIC_LENGTH).refine((topic) => topic.trim().length >= MIN_TOPIC_LENGTH, {
    message: `Describe the topic in at least ${MIN_TOPIC_LENGTH} characters.`,
  }),
  complexity: ComplexityPreference.default('detailed'),
  /** Hint only. The AI classifies the domain itself; this biases nothing more than the opening guess. */
  domain: Domain.optional(),
  /** The client's measured tier, so the pipeline can price the build against the device that asked. */
  tier: DeviceTier.optional(),
  /** Set false by clients that cannot consume NDJSON; the same payload arrives as one JSON object. */
  stream: z.boolean().default(true),
});
export type GenerateRequest = z.infer<typeof GenerateRequest>;

/** The non-streaming generation response: identical content to the terminal `ready` event. */
export const GenerateResponse = z.object({
  bundle: ModelBundle,
  audit: AuditSummary.optional(),
  modelId: Uuid.optional(),
  requestId: z.string().max(64),
});
export type GenerateResponse = z.infer<typeof GenerateResponse>;

/** The five teaching stances from `05`. Each must differ in *what it teaches*, not just its vocabulary. */
export const ChatPersona = z.enum(['teacher', 'buddy', 'engineer', 'eli5', 'socratic']);
export type ChatPersona = z.infer<typeof ChatPersona>;

/**
 * The bounded model context every conversational call carries.
 *
 * `05`'s context discipline: "Sending the entire model JSON burns tokens, dilutes the model's
 * attention, and leaks implementation detail into prose. Extract what a teacher would glance at."
 * Hence the caps below — and `selectedPartId`, which `05` calls "the single most valuable piece of
 * context a tutor can have".
 */
export const ModelContext = z.object({
  name: shortText(120),
  description: shortText(1200),
  domain: Domain,
  concept: shortText(240),
  objectives: z.array(shortText(240)).max(8).default([]),
  /** Named parts with their info titles, depth-limited and count-capped. */
  parts: z
    .array(
      z.object({ id: shortText(64), name: shortText(120), summary: shortText(240).optional() }),
    )
    .max(40)
    .default([]),
  /** How many parts were omitted — "…and 23 more" beats a wall of 60 names (`05`). */
  partsOmitted: z.number().int().min(0).default(0),
  parameters: z
    .array(
      z.object({
        id: shortText(64),
        label: shortText(64),
        unit: shortText(16).optional(),
        min: z.number().finite().optional(),
        max: z.number().finite().optional(),
        current: z.union([z.number().finite(), z.boolean(), z.string().max(64)]).optional(),
      }),
    )
    .max(24)
    .default([]),
  selectedPartId: shortText(64).optional(),
});
export type ModelContext = z.infer<typeof ModelContext>;

export const ChatMessage = z.object({
  role: z.enum(['user', 'assistant']),
  content: shortText(4000),
});
export type ChatMessage = z.infer<typeof ChatMessage>;

export const ChatRequest = z.object({
  message: shortText(2000),
  persona: ChatPersona.default('teacher'),
  /** Recent exchange only, so "why does it do that?" works after the previous answer (`05`). */
  history: z.array(ChatMessage).max(12).default([]),
  context: ModelContext.optional(),
  stream: z.boolean().default(true),
});
export type ChatRequest = z.infer<typeof ChatRequest>;

/** Chat streams as NDJSON too, so both streaming paths share one transport discipline (`05`). */
export const ChatEvent = z.discriminatedUnion('type', [
  z.object({ type: z.literal('delta'), text: z.string().max(4000) }),
  z.object({ type: z.literal('done'), text: z.string().max(16000) }),
  z.object({
    type: z.literal('error'),
    code: shortText(48),
    message: shortText(400),
    requestId: z.string().max(64),
  }),
]);
export type ChatEvent = z.infer<typeof ChatEvent>;

export const QuizRequest = z.object({
  context: ModelContext,
  count: z.number().int().min(1).max(20).default(5),
  difficulty: z.enum(['recall', 'application', 'synthesis', 'mixed']).default('mixed'),
});
export type QuizRequest = z.infer<typeof QuizRequest>;

export const QuizResponse = z.object({
  /** Questions that failed validation are dropped here, not rendered — `05`'s canonical failure fix. */
  questions: z.array(QuizQuestion).max(20),
  dropped: z.number().int().min(0).default(0),
  requestId: z.string().max(64),
});
export type QuizResponse = z.infer<typeof QuizResponse>;

/** A gallery row as the client sees it. Snapshot travels as a URL; bytes never ride a list query (`06`). */
export const GalleryEntry = z.object({
  id: Uuid,
  name: shortText(120),
  subject: shortText(48),
  tags: z.array(shortText(32)).max(12).default([]),
  snapshotUrl: z.string().max(500).nullable(),
  createdAt: EpochMillis,
  updatedAt: EpochMillis,
});
export type GalleryEntry = z.infer<typeof GalleryEntry>;

export const GalleryListQuery = z.object({
  subject: shortText(48).optional(),
  search: shortText(120).optional(),
  /** Bounded, because "an unvalidated limit is one request asking for the entire table" (`06`). */
  limit: z.coerce.number().int().min(1).max(60).default(24),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
});
export type GalleryListQuery = z.infer<typeof GalleryListQuery>;

export const GalleryListResponse = z.object({
  entries: z.array(GalleryEntry),
  total: z.number().int().min(0),
  limit: z.number().int().positive(),
  offset: z.number().int().min(0),
});
export type GalleryListResponse = z.infer<typeof GalleryListResponse>;

export const PublishRequest = z.object({
  bundle: ModelBundle,
  /** Data-URL or base64 PNG/JPEG/WebP snapshot; sniffed by magic bytes server-side, never trusted (`06`). */
  snapshot: z.string().max(4_000_000).optional(),
});
export type PublishRequest = z.infer<typeof PublishRequest>;

export const PublishResponse = z.object({
  id: Uuid,
  shareUrl: z.string().max(500),
  requestId: z.string().max(64),
});
export type PublishResponse = z.infer<typeof PublishResponse>;

/**
 * Health. Liveness and readiness are separate on purpose (`06`): "a liveness probe that fails on a
 * dead *database* causes the platform to restart a healthy process, which fixes nothing and loses
 * in-flight work."
 */
export const HealthResponse = z.object({
  status: z.enum(['ok', 'draining', 'degraded']),
  uptimeSeconds: z.number().min(0),
  version: shortText(32),
  capabilities: z.object({
    ai: z.boolean(),
    database: z.boolean(),
    snapshots: z.boolean(),
  }),
  storage: z.enum(['postgres', 'file', 'memory']),
  /** Non-fatal configuration complaints, so a deployment can be diagnosed without SSH (`04`). */
  warnings: z.array(shortText(240)).default([]),
  openGenerationStreams: z.number().int().min(0).optional(),
});
export type HealthResponse = z.infer<typeof HealthResponse>;
