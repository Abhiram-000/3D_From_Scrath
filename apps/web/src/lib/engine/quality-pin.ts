/**
 * What a learner's pinned quality means for the adaptive ladder.
 *
 * `08`: "the user's explicit quality choice beats the optimizer, which then only warns". This module
 * is that sentence as arithmetic, extracted from the worker's frame loop so the rule can be tested
 * without a GPU: the ladder still *measures* pressure when a quality is pinned, it simply may not
 * act on it.
 *
 * The warning matters as much as the refusal to act. A learner who pins "high" on a phone that
 * cannot hold it would otherwise see stutter with no explanation — and no way to learn that their
 * own setting is its cause. Honouring the choice silently would be the "never lied to" failure.
 */

/** What the ladder should do with what it just measured. */
export interface LadderDecision {
  /** The rung to step, or null to leave the quality alone. */
  step: 'down' | 'up' | null;
  /** True when the device is failing to hold a quality the learner pinned. */
  warn: boolean;
}

export interface LadderSignals {
  /** Consecutive frames over the pressure band. */
  pressureFrames: number;
  /** Consecutive frames under the headroom band. */
  headroomFrames: number;
  /** How many sustained frames a step requires. */
  sustainFrames: number;
  /** Whether the learner has pinned a quality the optimizer may not override. */
  pinned: boolean;
}

/**
 * Decide whether to step, and whether to warn.
 *
 * Stepping up asks for twice the sustain that stepping down does, which is deliberate asymmetry: a
 * step down that was too eager costs quality the learner can see, a step up that was too eager
 * costs them a stutter.
 */
export function ladderDecision(signals: LadderSignals): LadderDecision {
  const { pressureFrames, headroomFrames, sustainFrames, pinned } = signals;

  if (pinned) {
    return { step: null, warn: pressureFrames >= sustainFrames };
  }

  if (pressureFrames >= sustainFrames) return { step: 'down', warn: false };
  if (headroomFrames >= sustainFrames * 2) return { step: 'up', warn: false };
  return { step: null, warn: false };
}
