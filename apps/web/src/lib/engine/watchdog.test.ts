/**
 * The contract for the watchdog's patience.
 *
 * The failure these tests exist for: a healthy model was killed for "not responding" on a device
 * whose first frame takes longer than a fast device's silence limit. The kill was right by the
 * rule and wrong in fact — the worker was compiling shaders, which is work, not a hang.
 */
import { describe, expect, it } from 'vitest';
import { WATCHDOG, buildGraceMs, heartbeatTimeoutMs } from './watchdog';

describe('the silence the worker is allowed', () => {
  it('is generous before the worker has ever presented a frame', () => {
    // The first frame compiles every shader the model needs. On a software rasterizer that is
    // tens of seconds of legitimate work, and there is no measurement yet to scale by — so the
    // window is the cap, not the fast-device base.
    expect(heartbeatTimeoutMs({ hasMeasuredFrame: false, frameMillis: 0 })).toBe(
      WATCHDOG.maxHeartbeatTimeoutMs,
    );
  });

  it('grows past the base as soon as frames are measured', () => {
    // Six frames of slack past the base: a 16 ms frame gives 4,096 ms, and the base itself is the
    // floor for a device that reports nothing but fast frames.
    const fast = heartbeatTimeoutMs({ hasMeasuredFrame: true, frameMillis: 16 });
    expect(fast).toBe(WATCHDOG.heartbeatTimeoutMs + 16 * WATCHDOG.frameSlackMultiplier);
    expect(fast).toBeGreaterThan(WATCHDOG.heartbeatTimeoutMs);
  });

  it('grows with the frames the worker has actually been presenting', () => {
    // A device whose frames take a second needs a second of silence, or every slow-but-alive
    // model is executed.
    const slow = heartbeatTimeoutMs({ hasMeasuredFrame: true, frameMillis: 1_000 });
    expect(slow).toBe(WATCHDOG.heartbeatTimeoutMs + 1_000 * WATCHDOG.frameSlackMultiplier);
    expect(slow).toBeGreaterThan(WATCHDOG.heartbeatTimeoutMs);
  });

  it('is capped, so a pathological measurement cannot disable the watchdog', () => {
    const absurd = heartbeatTimeoutMs({ hasMeasuredFrame: true, frameMillis: 60_000 });
    expect(absurd).toBe(WATCHDOG.maxHeartbeatTimeoutMs);
  });

  it('never falls below the base', () => {
    // A device reporting impossibly fast frames is still a device; the floor stands.
    expect(heartbeatTimeoutMs({ hasMeasuredFrame: true, frameMillis: 0 })).toBe(
      WATCHDOG.heartbeatTimeoutMs,
    );
  });
});

describe('the grace a load is given', () => {
  it('is longer on a weaker device', () => {
    // Realization and shader compilation are several times more expensive on a weak device, and
    // the grace is what keeps the watchdog from firing on work that was going to finish.
    expect(buildGraceMs('low')).toBeGreaterThan(buildGraceMs('mid'));
    expect(buildGraceMs('mid')).toBeGreaterThan(buildGraceMs('high'));
  });
});
