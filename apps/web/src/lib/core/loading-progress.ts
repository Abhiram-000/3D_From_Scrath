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
 *   4. The sentence on screen is the server's. This file keeps the phase *vocabulary* — which
 *      stage a phase belongs to, and where the bar's milestones fall — but not the wording: a
 *      client-side copy of what the server says is a claim about somebody else's behaviour, and
 *      it drifts. (It had drifted: the copy described an audit phase the server never announces.)
 *
 * Order guarantees monotonicity: an event mapping to an earlier index updates wording only.
 */
import { GENERATION_PHASES, type GenerationEvent, type GenerationPhase } from '@edu3d/contracts';

export interface PhaseSpec {
  key: GenerationPhase | 'done';
  from: number;
  to: number;
  /** Roughly how long the phase takes, seconds — shapes easing inside the slice only. */
  tau: number;
  stage: 'thinking' | 'generating' | 'compiling' | 'ready';
  /** The sentence shown until the server says its own. */
  status: string;
}

/** The visible stages, in order — the chips on the page. */
export const STAGES = ['thinking', 'generating', 'compiling', 'ready'] as const;
export type StageName = (typeof STAGES)[number];

/**
 * The milestones, one per phase the server announces.
 *
 * The slices are contiguous in the order the phases actually happen, so the bar's journey matches
 * the run. A phase that is never announced — the gate, the audit, the persist — owns no slice at
 * all: no time is spent on work that did not happen, and a server that does announce one lands on
 * the last milestone before it (see `milestoneIndex`).
 */
export const PHASES: readonly PhaseSpec[] = [
  {
    key: 'queued',
    from: 0,
    to: 3,
    tau: 2,
    stage: 'thinking',
    status: 'Sending your topic to the model…',
  },
  {
    key: 'prompt',
    from: 3,
    to: 6,
    tau: 1,
    stage: 'thinking',
    status: 'Loading the generation contract…',
  },
  {
    key: 'model',
    from: 6,
    to: 55,
    tau: 20,
    stage: 'thinking',
    status: 'The model is designing your 3D scene…',
  },
  {
    key: 'extract',
    from: 55,
    to: 66,
    tau: 2,
    stage: 'generating',
    status: 'Reading the program the model wrote…',
  },
  {
    key: 'repair',
    from: 66,
    to: 74,
    tau: 8,
    stage: 'generating',
    status: 'Repairing the program where it broke the rules…',
  },
  {
    key: 'build',
    from: 74,
    to: 86,
    tau: 4,
    stage: 'generating',
    status: 'Building the model and checking what it teaches…',
  },
  {
    key: 'refine',
    from: 86,
    to: 96,
    tau: 12,
    stage: 'generating',
    status: 'Improving the model where it fell short…',
  },
  {
    key: 'ready',
    from: 96,
    to: 100,
    tau: 1,
    stage: 'compiling',
    status: 'Your 3D model is ready!',
  },
  {
    key: 'done',
    from: 100,
    to: 100,
    tau: 1,
    stage: 'ready',
    status: 'Your 3D model is ready! Launching…',
  },
] as const;

/** Map a server event onto a phase key. Notices carry no phase; heartbeats confirm the current one.
 *
 * Notices are handled before this function in `apply`: they are worth *showing* (a repair pass, a
 * provider retry, a quality downgrade) but never move the bar — they say the *how* changed, not
 * that a milestone was crossed. Dropping them entirely was the old behaviour, and a learner
 * watching a repair pass with a frozen bar and no explanation is a lie by omission.
 */
export function phaseOf(event: GenerationEvent): GenerationPhase | 'done' | null {
  if (event.type === 'phase') return event.phase;
  if (event.type === 'ready') return 'done';
  return null;
}

/**
 * The milestone a phase lands on.
 *
 * Its own, when the client has one. Otherwise — the wire vocabulary is deliberately finer-grained
 * than the UI's — the last milestone *before* it: the work that phase implies has been done, and
 * the work it announces has only just started, so claiming more than that would be a lie.
 */
function milestoneIndex(key: GenerationPhase | 'done'): number {
  const exact = PHASES.findIndex((phase) => phase.key === key);
  if (exact !== -1) return exact;

  const wirePosition = GENERATION_PHASES.indexOf(key as GenerationPhase);
  if (wirePosition === -1) return 0;

  let best = 0;
  for (const [index, phase] of PHASES.entries()) {
    if (phase.key === 'done') continue;
    const position = GENERATION_PHASES.indexOf(phase.key);
    if (position !== -1 && position <= wirePosition) best = index;
  }
  return best;
}

/** What the page renders: plain values, not a model. */
export interface ProgressView {
  value: number;
  status: string;
  stage: StageName;
  completedStages: number;
  /** The latest server notice ("repairing the program…"), or null. Worth showing, never a milestone. */
  notice: string | null;
}

export class ProgressModel {
  index = 0;
  value = 0;
  /** The server's own sentence for the current phase, when it has sent one. */
  private message: string | null = null;
  /** The latest notice ("truncating the program…", "repairing…"), held until another replaces it. */
  private lastNotice: string | null = null;
  private phaseStartedAt: number;

  constructor(now = Date.now()) {
    this.phaseStartedAt = now;
  }

  /** The latest server notice, for UIs that show it beside the status line. */
  get notice(): string | null {
    return this.lastNotice;
  }

  /** Feed a server event; monotonic by construction. */
  apply(event: GenerationEvent, now = Date.now()): void {
    // A notice is surfaced, not consumed: it explains what the pipeline is doing differently
    // (truncation, gate repair, build repair, refinement) without claiming a milestone happened.
    if (event.type === 'notice') {
      this.lastNotice = event.message;
      return;
    }
    const key = phaseOf(event);
    if (key === null) return;
    if (event.type === 'phase') this.message = event.message;
    const next = milestoneIndex(key);
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

  /** The server's sentence, or the local fallback before the first one arrives. */
  get status(): string {
    return this.message ?? PHASES[this.index]?.status ?? '';
  }

  /** The stage chips: everything before the current one is completed. */
  get completedStages(): number {
    return STAGES.indexOf(this.stage);
  }

  /**
   * The values the page renders.
   *
   * A plain object, on purpose: a class instance is not reactive in Svelte, so a page that reads
   * a getter straight from the model reads a value that never invalidates. The page copies this
   * snapshot into its own state, and the copy is what updates.
   */
  view(): ProgressView {
    return {
      value: this.value,
      status: this.status,
      stage: this.stage,
      completedStages: this.completedStages,
      notice: this.lastNotice,
    };
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
