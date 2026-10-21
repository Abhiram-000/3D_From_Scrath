/**
 * The quality pin's contract.
 *
 * `08` states the rule this implements, and it is one sentence: "the user's explicit quality choice
 * beats the optimizer, which then only warns". Two halves, and both matter — the platform must stop
 * adjusting, and it must still *say* something when the device cannot keep up with what was asked
 * for. Silently honouring a pin that the device cannot sustain is the "never lied to" failure: the
 * learner would see stutter they had no explanation for, and no way to know that their own setting
 * caused it.
 */
import { describe, expect, it } from 'vitest';
import { ladderDecision } from './quality-pin';

/** The adaptive ladder's sustain window, per the worker's timing table. */
const SUSTAIN = 45;

describe('without a pin', () => {
  it('steps down after sustained pressure', () => {
    const decision = ladderDecision({
      pressureFrames: SUSTAIN,
      headroomFrames: 0,
      sustainFrames: SUSTAIN,
      pinned: false,
    });
    expect(decision.step).toBe('down');
  });

  it('steps back up after sustained headroom, more slowly', () => {
    // Twice the window: stepping up should be more cautious than stepping down, because the cost of
    // being wrong is a stutter the learner sees.
    const decision = ladderDecision({
      pressureFrames: 0,
      headroomFrames: SUSTAIN * 2,
      sustainFrames: SUSTAIN,
      pinned: false,
    });
    expect(decision.step).toBe('up');
  });

  it('does nothing in between', () => {
    const decision = ladderDecision({
      pressureFrames: SUSTAIN - 1,
      headroomFrames: SUSTAIN - 1,
      sustainFrames: SUSTAIN,
      pinned: false,
    });
    expect(decision.step).toBeNull();
    expect(decision.warn).toBe(false);
  });
});

describe('with a pin', () => {
  it('never adjusts, however long the pressure lasts', () => {
    // The learner's choice beats the optimizer. This is the whole point of the pin.
    const decision = ladderDecision({
      pressureFrames: SUSTAIN * 10,
      headroomFrames: 0,
      sustainFrames: SUSTAIN,
      pinned: true,
    });
    expect(decision.step).toBeNull();
  });

  it('does not adjust upward either — the pin is the target, not a floor', () => {
    const decision = ladderDecision({
      pressureFrames: 0,
      headroomFrames: SUSTAIN * 10,
      sustainFrames: SUSTAIN,
      pinned: true,
    });
    expect(decision.step).toBeNull();
  });

  it('warns when the device cannot hold what was asked for', () => {
    // The other half of the rule: honour the choice, and say when it is costing the learner.
    const decision = ladderDecision({
      pressureFrames: SUSTAIN,
      headroomFrames: 0,
      sustainFrames: SUSTAIN,
      pinned: true,
    });
    expect(decision.warn).toBe(true);
  });

  it('says nothing while the device keeps up', () => {
    const decision = ladderDecision({
      pressureFrames: SUSTAIN - 1,
      headroomFrames: 0,
      sustainFrames: SUSTAIN,
      pinned: true,
    });
    expect(decision.warn).toBe(false);
  });
});
