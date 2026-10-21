/**
 * The contract for the watchdog's patience.
 *
 * The failure these tests exist for: a healthy model was killed for "not responding" on a device
 * whose first frame takes longer than a fast device's silence limit. The kill was right by the
 * rule and wrong in fact — the worker was compiling shaders, which is work, not a hang.
 *
 * A second failure class lives here too: the tab-level demo-killer. While the tab is hidden, the
 * browser throttles timers — including the host's own watchdog interval — so `lastHeartbeatAt`
 * can hold a ~60 s old timestamp at the very tick that sees the tab become visible again. The
 * judgement must treat "the page could not have produced a frame" (hidden *or* occluded) as
 * unjudged silence, and re-arm a fresh window on the tick that sees it return.
 */
import { describe, expect, it } from 'vitest';
import {
  RAF_SILENCE_GAP_MS,
  WATCHDOG,
  buildGraceMs,
  heartbeatTimeoutMs,
  judgeWatchdogTick,
  renderSuppressed,
  type WatchdogState,
} from './watchdog';

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

describe('frames the page cannot produce', () => {
  it('counts a hidden tab as suppressed', () => {
    expect(renderSuppressed({ hidden: true, msSinceRaf: 0 })).toBe(true);
  });

  it('counts an occluded window as suppressed, though `document.hidden` is false', () => {
    // A fully covered window pauses everyone's rAF while claiming to be visible. The rAF clock
    // stalls — that stall *is* the evidence.
    expect(renderSuppressed({ hidden: false, msSinceRaf: RAF_SILENCE_GAP_MS * 10 })).toBe(true);
  });

  it('does not suppress a visible page whose frames are flowing', () => {
    expect(renderSuppressed({ hidden: false, msSinceRaf: 16 })).toBe(false);
  });
});

describe('the watchdog tick judgement', () => {
  const base = { graceUntil: 0, timeoutMs: WATCHDOG.heartbeatTimeoutMs };
  const awake: WatchdogState = { lastHeartbeatAt: 0, wasSuppressed: false, warned: false };

  it('kills a worker whose silence crosses the threshold while visible', () => {
    const verdict = judgeWatchdogTick({ ...base, state: awake, nowMs: 5_000, suppressed: false });
    expect(verdict.kill).toBe(true);
  });

  it('spares nothing-to-judge while the build grace holds', () => {
    const verdict = judgeWatchdogTick({
      ...base,
      state: awake,
      nowMs: 120_000,
      suppressed: false,
      graceUntil: 200_000,
    });
    expect(verdict.kill).toBe(false);
    expect(verdict.state.lastHeartbeatAt).toBe(awake.lastHeartbeatAt);
  });

  it('never judges across a hidden gap, and re-arms on the return tick', () => {
    // The demo-killer, as arithmetic. The tab hides; the browser's throttling means the *next*
    // tick happens a minute later, on the return. The gap must be forgiven, not measured.
    const hiddenTick = judgeWatchdogTick({
      ...base,
      state: awake,
      nowMs: 60_000,
      suppressed: true,
    });
    expect(hiddenTick.kill).toBe(false);
    // The old code "refreshed" the heartbeat here, which laundered the gap only while hidden and
    // left the return tick nothing to be forgiven with. Declared behaviour now: record the
    // suppression, do not touch the clock.
    expect(hiddenTick.state.wasSuppressed).toBe(true);
    expect(hiddenTick.state.lastHeartbeatAt).toBe(0);

    const returnTick = judgeWatchdogTick({
      ...base,
      state: hiddenTick.state,
      nowMs: 121_000, // 61 s of wall time since the last refresh — silence across the whole gap
      suppressed: false,
    });
    expect(returnTick.kill).toBe(false);
    // Re-arm: a full fresh window starts at the return.
    expect(returnTick.state.lastHeartbeatAt).toBe(121_000);
    expect(returnTick.state.wasSuppressed).toBe(false);
  });

  it('still executes a worker that stays silent after the re-arm', () => {
    const hiddenTick = judgeWatchdogTick({
      ...base,
      state: awake,
      nowMs: 60_000,
      suppressed: true,
    });
    const returnTick = judgeWatchdogTick({
      ...base,
      state: hiddenTick.state,
      nowMs: 121_000,
      suppressed: false,
    });
    // No message ever arrives after the return: within the fresh window the silence rebuilds...
    const patient = judgeWatchdogTick({
      ...base,
      state: returnTick.state,
      nowMs: 124_000,
      suppressed: false,
    });
    expect(patient.kill).toBe(false);
    // ...and past it, the kill is exactly as certain as before the fix.
    const verdict = judgeWatchdogTick({
      ...base,
      state: patient.state,
      nowMs: 126_000,
      suppressed: false,
    });
    expect(verdict.kill).toBe(true);
  });

  it('warns once per silence episode, in dev, before the kill', () => {
    const first = judgeWatchdogTick({ ...base, state: awake, nowMs: 3_500, suppressed: false });
    expect(first.warn).not.toBeNull();
    expect(first.kill).toBe(false);
    expect(first.state.warned).toBe(true);
    const second = judgeWatchdogTick({
      ...base,
      state: first.state,
      nowMs: 3_800,
      suppressed: false,
    });
    expect(second.warn).toBeNull();
  });
});
