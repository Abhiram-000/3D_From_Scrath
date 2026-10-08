/**
 * The loading page's progress model — ported from V1's `core/loading-progress.js`, adapted to this
 * pipeline's phase names.
 *
 * WHAT MAKES IT HONEST (`07`):
 *   1. The bar only passes a milestone when the phase behind it has *actually started* — driven by
 *      the server's phase events, never by local timers.
 *   2. Inside a phase it eases toward, but never reaches, the next milestone — movement means
 *      "still working", a jump means "a step really completed".
 *   3. It never moves backwards: the refinement pass re-runs earlier phases and those events must
 *      read as progress, not rewind.
 *
 * Order guarantees monotonicity: an event mapping to an earlier index updates wording only.
 */
import type { GenerationEvent, GenerationPhase } from '@edu3d/contracts';

export interface PhaseSpec {
  key: GenerationPhase | 'done';
  from: number;
  to: number;
  /** Roughly how long the phase takes, seconds — shapes easing inside the slice only. */
  tau: number;
  stage: 'thinking' | 'generating' | 'compiling' | 'ready';
  status: string;
}

/** The visible stages, in order — the chips on the page. */
export const STAGES = ['thinking', 'generating', 'compiling', 'ready'] as const;
export type StageName = (typeof STAGES)[number];

export const PHASES: readonly PhaseSpec[] = [
  { key: 'queued', from: 0, to: 3, tau: 2, stage: 'thinking', status: 'Sending your topic to the model…' },
  { key: 'prompt', from: 3, to: 6, tau: 1, stage: 'thinking', status: 'Loading the generation contract…' },
  { key: 'model', from: 6, to: 55, tau: 20, stage: 'thinking', status: 'The model is designing your 3D scene…' },
  { key: 'extract', from: 55, to: 63, tau: 2, stage: 'generating', status: 'Reading the program the model wrote…' },
  { key: 'gate', from: 63, to: 66, tau: 1, stage: 'generating', status: 'Checking the program against the sandbox rules…' },
  { key: 'repair', from: 66, to: 74, tau: 8, stage: 'generating', status: 'Repairing the program where it broke the rules…' },
  { key: 'build', from: 74, to: 80, tau: 4, stage: 'generating', status: 'Building the model to measure it…' },
  { key: 'audit', from: 80, to: 86, tau: 3, stage: 'generating', status: 'Auditing what the model teaches…' },
  { key: 'refine', from: 86, to: 95, tau: 12, stage: 'generating', status: 'Improving the model where it fell short…' },
  { key: 'persist', from: 95, to: 98, tau: 2, stage: 'compiling', status: 'Saving your model…' },
  { key: 'ready', from: 98, to: 100, tau: 1, stage: 'compiling', status: 'Building the final experience…' },
  { key: 'done', from: 100, to: 100, tau: 1, stage: 'ready', status: 'Your 3D model is ready! Launching…' },
] as const;

const PHASE_INDEX = new Map(PHASES.map((phase, index) => [phase.key, index]));

/** Map a server event onto a phase key. Notices carry no phase; heartbeats confirm the current one. */
export function phaseOf(event: GenerationEvent): GenerationPhase | 'done' | null {
  if (event.type === 'phase') return event.phase;
  if (event.type === 'ready') return 'done';
  return null;
}

export class ProgressModel {
  index = 0;
  value = 0;
  private phaseStartedAt: number;

  constructor(now = Date.now()) {
    this.phaseStartedAt = now;
  }

  /** Feed a server event; monotonic by construction. */
  apply(event: GenerationEvent, now = Date.now()): void {
    const key = phaseOf(event);
    if (key === null) return;
    const next = PHASE_INDEX.get(key);
    if (next === undefined) return;
    if (next > this.index) {
      // Jump to the new milestone: a step really completed.
      this.index = next;
      this.value = Math.max(this.value, PHASES[next]?.from ?? this.value);
      this.phaseStartedAt = now;
    } else if (next === this.index) {
      this.phaseStartedAt = now;
    }
    // An earlier-phase event (refinement re-running parse/audit) never moves the bar back.
  }

  /** Ease within the current slice toward — never reaching — its end. */
  tick(now = Date.now()): number {
    const phase = PHASES[this.index];
    if (!phase) return this.value;
    if (phase.to <= phase.from) return phase.to;
    const elapsed = (now - this.phaseStartedAt) / 1000;
    // 1 − e^(−t/τ): fast start, asymptotic approach, cannot cross `to`.
    const eased = 1 - Math.exp(-elapsed / phase.tau);
    const target = phase.from + (phase.to - phase.from) * eased * 0.96;
    this.value = Math.max(this.value, Math.min(target, phase.to - 0.5));
    return this.value;
  }

  get stage(): StageName {
    return PHASES[this.index]?.stage ?? 'thinking';
  }

  get status(): string {
    return PHASES[this.index]?.status ?? '';
  }

  /** The stage chips: everything before the current one is completed. */
  get completedStages(): number {
    return STAGES.indexOf(this.stage);
  }
}

/**
 * Topic-aware facts ("Did you know?"), rotated without repeats within a cycle (`07`).
 *
 * Category words pick the pool; the queue shuffles and refills when exhausted, so the wait itself
 * becomes content rather than dead time.
 */
const FACT_POOLS: Record<string, string[]> = {
  default: [
    'The first computer bug was an actual moth, found inside a Harvard Mark II in 1947.',
    'Light from the Sun takes about 8 minutes and 20 seconds to reach you.',
    'A neutron star is so dense that one teaspoon would weigh about a billion tonnes.',
    'DNA in one human body, stretched out, would reach the Sun and back over 300 times.',
    'The Eiffel Tower grows about 15 centimetres taller in summer heat.',
    'Honey never spoils — archaeologists have eaten 3,000-year-old honey from tombs.',
  ],
  space: [
    'Venus rotates so slowly that its day is longer than its year.',
    'There are more possible chess games than atoms in the observable universe.',
    'Jupiter’s Great Red Spot is a storm wider than Earth, running for centuries.',
    'Space is completely silent — there is no medium for sound to travel through.',
  ],
  bio: [
    'Your body makes about 25 million new cells every second.',
    'Octopuses have three hearts and blue blood.',
    'Bananas are radioactive — potassium-40, harmless in the doses you eat.',
    'Mitochondria were once free-living bacteria that moved into our cells.',
  ],
  machine: [
    'A jet engine at takeoff sucks in about one tonne of air per second.',
    'The Wright brothers’ first flight was shorter than a modern airliner’s wingspan.',
    'Gears mesh because of their involute curve — it keeps contact rolling, not sliding.',
    'A mechanical watch’s balance wheel beats faster than a hummingbird’s wings.',
  ],
};

const categorise = (topic: string): string => {
  const lowered = topic.toLowerCase();
  if (/space|planet|star|solar|orbit|galaxy|moon|universe/.test(lowered)) return 'space';
  if (/cell|dna|bio|body|heart|brain|plant|animal|photosynth/.test(lowered)) return 'bio';
  if (/engine|machine|gear|motor|turbine|pump|bridge|mechanic/.test(lowered)) return 'machine';
  return 'default';
};

export class FactQueue {
  private queue: string[] = [];

  constructor(topic: string) {
    this.refill(topic);
  }

  private refill(topic: string): void {
    const primary = FACT_POOLS[categorise(topic)] ?? [];
    const fallback = FACT_POOLS.default ?? [];
    const pool = [...primary, ...fallback];
    // Fisher–Yates; a fresh shuffle each cycle so repeats never cluster.
    for (let i = pool.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      const swapped: string | undefined = pool[i];
      pool[i] = pool[j] ?? '';
      pool[j] = swapped ?? '';
    }
    this.queue = pool;
  }

  next(): string {
    if (this.queue.length === 0) this.refill('');
    return this.queue.pop() ?? '';
  }
}
