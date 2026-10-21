/**
 * The contract for the cinematic camera move.
 *
 * The camera is the viewer's teaching instrument: when a learner selects a part, the camera has to
 * *travel* to it in a way that reads as deliberate, and it has to get out of the way the moment the
 * learner touches the scene. These tests pin the three properties that make that feel right —
 * the shape of the easing, the direction of travel around the poles, and the fact that the camera
 * never fights a gesture — plus the framing maths, which is where a narrow phone screen quietly
 * breaks a "focus" move that looks perfect on a desktop.
 */
import { describe, expect, it } from 'vitest';
import {
  createGlide,
  dollyPose,
  easeFor,
  easeInOutCubic,
  fitDistance,
  isTapGesture,
  isTapRelease,
  isUsablePose,
  retargetGlide,
  shortestAngleDelta,
  stepGlide,
  type GlideLimits,
  type OrbitPose,
  type ShotEasing,
} from './camera-glide';

const NO_LIMITS: GlideLimits = {
  minPhi: 0.08,
  maxPhi: Math.PI - 0.08,
  minDistance: 0.1,
  maxDistance: 500,
};

function pose(overrides: Partial<OrbitPose> = {}): OrbitPose {
  return {
    theta: 0,
    phi: Math.PI / 2,
    distance: 10,
    target: { x: 0, y: 0, z: 0 },
    ...overrides,
  };
}

describe('the easing curve', () => {
  it('starts at rest and ends at rest', () => {
    // A camera move that starts or ends at speed reads as a cut, not a move.
    expect(easeInOutCubic(0)).toBe(0);
    expect(easeInOutCubic(1)).toBe(1);
  });

  it('is symmetric about the midpoint', () => {
    // The curve's whole character: slow in, slow out, fast through the middle.
    expect(easeInOutCubic(0.5)).toBeCloseTo(0.5, 10);
    expect(easeInOutCubic(0.25) + easeInOutCubic(0.75)).toBeCloseTo(1, 10);
  });

  it('never goes backwards', () => {
    let previous = -1;
    for (let t = 0; t <= 1.0001; t += 0.05) {
      const eased = easeInOutCubic(t);
      expect(eased).toBeGreaterThanOrEqual(previous);
      previous = eased;
    }
  });
});

describe('the angle the camera travels', () => {
  it('takes the short way round', () => {
    // A camera that spins 350° to reach a target 10° away is the difference between a
    // cinematic move and a screensaver.
    expect(shortestAngleDelta(0, Math.PI / 2)).toBeCloseTo(Math.PI / 2, 10);
    expect(shortestAngleDelta(0, -Math.PI / 2)).toBeCloseTo(-Math.PI / 2, 10);
  });

  it('crosses the seam without turning the long way', () => {
    // 0.1 → 2π−0.1 is a 10° move, not a 350° one. The sign depends on which way is shorter
    // (here, backwards past zero), so the assertion is on the magnitude and on landing on the
    // target angle — not on a direction the maths is free to choose.
    const delta = shortestAngleDelta(0.1, 2 * Math.PI - 0.1);
    expect(Math.abs(delta)).toBeCloseTo(0.2, 10);
    const landed = 0.1 + delta;
    expect(Math.cos(landed)).toBeCloseTo(Math.cos(2 * Math.PI - 0.1), 10);
    expect(Math.sin(landed)).toBeCloseTo(Math.sin(2 * Math.PI - 0.1), 10);
  });
});

describe('a glide', () => {
  it('starts where it was asked to start, not somewhere else', () => {
    const glide = createGlide(pose({ distance: 3 }), pose({ distance: 30 }), 0.9);
    const stepped = stepGlide(glide, 0, NO_LIMITS);
    expect(stepped.pose.distance).toBe(3);
    expect(stepped.done).toBe(false);
  });

  it('ends exactly on its target', () => {
    const target = pose({ theta: 1.2, phi: 0.9, distance: 42, target: { x: 2, y: 3, z: 4 } });
    const glide = createGlide(pose(), target, 0.9);
    let stepped = stepGlide(glide, 0.5, NO_LIMITS);
    stepped = stepGlide(stepped.glide, 0.5, NO_LIMITS);
    expect(stepped.done).toBe(true);
    expect(stepped.pose.theta).toBeCloseTo(1.2, 10);
    expect(stepped.pose.phi).toBeCloseTo(0.9, 10);
    expect(stepped.pose.distance).toBeCloseTo(42, 10);
    expect(stepped.pose.target.x).toBeCloseTo(2, 10);
  });

  it('arrives when its time is up, not before and not after', () => {
    const glide = createGlide(pose(), pose({ distance: 20 }), 0.9);
    const half = stepGlide(glide, 0.45, NO_LIMITS);
    expect(half.done).toBe(false);
    // Half the time is not the end of the move.
    expect(half.pose.distance).not.toBeCloseTo(20, 3);
    const done = stepGlide(half.glide, 0.45, NO_LIMITS);
    expect(done.done).toBe(true);
  });

  it('survives a frame longer than the whole move', () => {
    // A backgrounded tab hands back a delta of many seconds. The camera must arrive, not overshoot.
    const glide = createGlide(pose(), pose({ distance: 20 }), 0.9);
    const stepped = stepGlide(glide, 30, NO_LIMITS);
    expect(stepped.done).toBe(true);
    expect(stepped.pose.distance).toBeCloseTo(20, 10);
  });

  it('eases through the middle rather than sliding linearly', () => {
    // At the halfway point the curve is at 0.5 of the distance; a linear slide would be there too,
    // so the distinguishing sample is the quarter: eased progress is well under a quarter of the way.
    const glide = createGlide(pose({ distance: 0 }), pose({ distance: 100 }), 1);
    const quarter = stepGlide(glide, 0.25, NO_LIMITS);
    expect(quarter.pose.distance).toBeLessThan(25);
    expect(quarter.pose.distance).toBeGreaterThan(0);
  });

  it('takes the short way round while travelling', () => {
    // The move from 0.1 to 2π−0.1 must travel the short way round, not swing through π/2.
    const glide = createGlide(pose({ theta: 0.1 }), pose({ theta: 2 * Math.PI - 0.1 }), 0.9);
    const stepped = stepGlide(glide, 0.9, NO_LIMITS);
    expect(Math.cos(stepped.pose.theta)).toBeCloseTo(Math.cos(-0.1), 6);
    expect(Math.sin(stepped.pose.theta)).toBeCloseTo(Math.sin(-0.1), 6);
    // It arrived, and it did not go the long way to get there.
    expect(Math.abs(shortestAngleDelta(0.1, stepped.pose.theta))).toBeCloseTo(0.2, 6);
  });

  it('never leaves the camera outside the frame limits', () => {
    // A glide that ends inside the model, or flips over a pole, is a broken camera.
    const glide = createGlide(
      pose({ phi: 1.5, distance: 5 }),
      pose({ phi: 3, distance: 900 }),
      0.9,
    );
    const stepped = stepGlide(glide, 0.9, NO_LIMITS);
    expect(stepped.pose.phi).toBeLessThanOrEqual(NO_LIMITS.maxPhi);
    expect(stepped.pose.phi).toBeGreaterThanOrEqual(NO_LIMITS.minPhi);
    expect(stepped.pose.distance).toBeLessThanOrEqual(NO_LIMITS.maxDistance);
  });

  it('replaces an in-flight move without a jump', () => {
    // A second selection mid-move must continue from where the camera is, not snap to a stale
    // origin — the snap is the single most visible way to make a camera feel cheap.
    const first = createGlide(pose({ distance: 0 }), pose({ distance: 100 }), 0.9);
    const midway = stepGlide(first, 0.45, NO_LIMITS);
    const second = createGlide(midway.pose, pose({ distance: 50 }), 0.9);
    const stepped = stepGlide(second, 0, NO_LIMITS);
    expect(stepped.pose.distance).toBeCloseTo(midway.pose.distance, 10);
  });

  it('has a floor on its duration, so a zero-length move is still a move', () => {
    const glide = createGlide(pose(), pose({ distance: 10 }), 0);
    expect(glide.duration).toBeGreaterThan(0);
  });
});

describe('framing a part', () => {
  it('keeps the whole object in view on a narrow screen', () => {
    // The bug this prevents: a distance fitted to the vertical field of view alone crops a wide
    // part on a portrait phone. A phone must end up further back than a desktop.
    const portrait = fitDistance(2, 50, 0.5, 1.4);
    const square = fitDistance(2, 50, 1, 1.4);
    expect(portrait).toBeGreaterThan(square);
  });

  it('is governed by the vertical field of view on a wide screen', () => {
    // A wide screen has vertical room to spare, so the vertical fit is the binding one.
    expect(fitDistance(2, 50, 2, 1.4)).toBeCloseTo(fitDistance(2, 50, 1, 1.4), 10);
  });

  it('leaves breathing room around the object', () => {
    // The margin is what stops the part filling the screen edge to edge.
    const tight = fitDistance(2, 50, 1, 1);
    const roomy = fitDistance(2, 50, 1, 2);
    expect(roomy).toBeCloseTo(tight * 2, 10);
  });

  it('never puts the camera inside the object', () => {
    // A camera closer than the object's own radius is inside the geometry.
    expect(fitDistance(3, 50, 1, 1)).toBeGreaterThan(3);
  });
});

describe('telling a tap from a drag', () => {
  it('calls a still press a tap', () => {
    expect(isTapGesture(100, 100, 100, 100)).toBe(true);
  });

  it('calls a small wobble a tap', () => {
    // Fingers are not precise; a couple of pixels of jitter is still a tap.
    expect(isTapGesture(100, 100, 102, 101)).toBe(true);
  });

  it('calls a real drag a drag', () => {
    // A drag is the learner steering the camera, and the camera must not fight them.
    expect(isTapGesture(100, 100, 100, 160)).toBe(false);
    expect(isTapGesture(100, 100, 220, 100)).toBe(false);
  });
});

describe('a release', () => {
  it('is a tap when one finger pressed and did not travel', () => {
    expect(isTapRelease({ x: 100, y: 100, pointers: 1 }, 101, 100)).toBe(true);
  });

  it('is not a tap when the finger travelled', () => {
    expect(isTapRelease({ x: 100, y: 100, pointers: 1 }, 100, 180)).toBe(false);
  });

  it('is not a tap when more than one finger was down', () => {
    // A pinch is the learner changing the distance, not choosing a part. Two fingers held close
    // together barely move, so the travel test alone would call it a tap and the camera would
    // fly away mid-pinch.
    expect(isTapRelease({ x: 100, y: 100, pointers: 2 }, 100, 100)).toBe(false);
  });

  it('is not a tap when no press was recorded', () => {
    // A release with no press is a pointer that went down outside the canvas.
    expect(isTapRelease(null, 100, 100)).toBe(false);
  });
});

describe('a framing', () => {
  it('is usable when its numbers are real', () => {
    expect(isUsablePose(pose({ distance: 12 }))).toBe(true);
  });

  it('is refused when the geometry produced a number that is not a number', () => {
    // A broken mesh can produce a NaN bounding radius, and a NaN camera position takes the
    // renderer down with it. The move is simply not started.
    expect(isUsablePose(pose({ distance: Number.NaN }))).toBe(false);
    expect(isUsablePose(pose({ target: { x: Number.NaN, y: 0, z: 0 } }))).toBe(false);
    expect(isUsablePose(pose({ distance: Number.POSITIVE_INFINITY }))).toBe(false);
  });

  it('is refused when the camera would sit inside the object', () => {
    expect(isUsablePose(pose({ distance: 0 }))).toBe(false);
    expect(isUsablePose(pose({ distance: -4 }))).toBe(false);
  });
});

describe('re-aiming a move at something that moved', () => {
  it('points the move at the part where it is now', () => {
    // A spinning blade is somewhere else by the time the camera arrives. Re-measuring the
    // destination every frame is what makes the camera arrive on the part rather than on the
    // place the part used to be.
    const glide = createGlide(pose(), pose({ distance: 20, target: { x: 0, y: 0, z: 0 } }), 0.9);
    const moved = retargetGlide(glide, { x: 5, y: 0, z: 0 }, 30);
    expect(moved.to.target.x).toBe(5);
    expect(moved.to.distance).toBe(30);
  });

  it('keeps the direction the move was heading in', () => {
    // Re-aiming changes where the camera is going, not where it is looking from: a focus that
    // pushes in along the current view direction must keep pushing in.
    const glide = createGlide(pose({ theta: 1 }), pose({ theta: 1, distance: 20 }), 0.9);
    const moved = retargetGlide(glide, { x: 0, y: 0, z: 0 }, 20);
    expect(moved.to.theta).toBe(1);
    expect(moved.from.theta).toBe(1);
  });

  it('does not restart the move', () => {
    // The clock is the move's own; re-aiming must not send the camera back to the start.
    const glide = createGlide(pose(), pose({ distance: 20 }), 0.9);
    const stepped = stepGlide(glide, 0.45, NO_LIMITS);
    const moved = retargetGlide(stepped.glide, { x: 1, y: 2, z: 3 }, 40);
    expect(moved.elapsed).toBeCloseTo(0.45, 10);
  });
});

describe('the easing vocabulary a shot can ask for', () => {
  it('keeps linear linear', () => {
    expect(easeFor('linear')(0.5)).toBe(0.5);
  });

  it('holds ease-in below the diagonal and ease-out above it', () => {
    expect(easeFor('easeIn')(0.5)).toBeLessThan(0.5);
    expect(easeFor('easeOut')(0.5)).toBeGreaterThan(0.5);
    expect(easeFor('easeInOut')(0.5)).toBeCloseTo(0.5, 10);
  });

  it('lands exactly, whichever curve is chosen', () => {
    for (const kind of [
      'linear',
      'easeIn',
      'easeOut',
      'easeInOut',
    ] as const satisfies readonly ShotEasing[]) {
      expect(easeFor(kind)(0)).toBe(0);
      expect(easeFor(kind)(1)).toBe(1);
    }
  });
});

describe('a glide carrying a shot easing', () => {
  it('follows the easing the shot asked for, not always the cinematic cubic', () => {
    // A linear follow/dolly at the quarter point is a quarter of the way. The cubic default
    // would be well under that — the distinguishing sample.
    const glide = createGlide(pose({ distance: 0 }), pose({ distance: 100 }), 1, 'linear');
    const quarter = stepGlide(glide, 0.25, NO_LIMITS);
    expect(quarter.pose.distance).toBeCloseTo(25, 10);
  });

  it('ease-out arrives early and still lands exactly', () => {
    const glide = createGlide(pose({ distance: 0 }), pose({ distance: 100 }), 1, 'easeOut');
    const quarter = stepGlide(glide, 0.25, NO_LIMITS);
    expect(quarter.pose.distance).toBeGreaterThan(25);
    const done = stepGlide(quarter.glide, 0.75, NO_LIMITS);
    expect(done.done).toBe(true);
    expect(done.pose.distance).toBeCloseTo(100, 10);
  });

  it('defaults to the cinematic cubic, so the focus glide is untouched', () => {
    // The learner-selected focus move predates the shot vocabulary and must keep its curve.
    const glide = createGlide(pose({ distance: 0 }), pose({ distance: 100 }), 1);
    const quarter = stepGlide(glide, 0.25, NO_LIMITS);
    expect(quarter.pose.distance).toBeLessThan(25);
  });
});

describe('a dolly', () => {
  it('moves along the view axis without changing the angle or the pivot', () => {
    const from = pose({ theta: 0.7, phi: 1.1, distance: 10, target: { x: 1, y: 2, z: 3 } });
    const to = dollyPose(from, -3);
    expect(to.distance).toBe(7);
    expect(to.theta).toBe(from.theta);
    expect(to.phi).toBe(from.phi);
    expect(to.target).toEqual(from.target);
  });

  it('dollys out on a positive delta', () => {
    expect(dollyPose(pose({ distance: 4 }), 2).distance).toBe(6);
  });
});
