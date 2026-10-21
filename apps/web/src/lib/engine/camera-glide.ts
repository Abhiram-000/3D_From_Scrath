/**
 * The cinematic camera move.
 *
 * When a learner selects a part, the camera travels to it. This module is the arithmetic of that
 * travel, kept free of THREE and of the DOM so it can be reasoned about — and tested — on its own.
 *
 * The shape of the move was settled in the first version of this platform and carried over here on
 * purpose: a cubic ease-in-out over 0.9 s, the camera approaching along the view direction it
 * already had, and any gesture from the learner cancelling the move outright rather than fighting
 * it. What this version adds is the part the first version got wrong on phones: a distance fitted
 * to the vertical field of view alone crops a wide object on a narrow screen, so the fit considers
 * both axes.
 *
 * Since the declared shot vocabulary became playable, this module also carries the arithmetic the
 * shot player needs: the easing vocabulary a `ShotDecl` names (a follow or dolly may ask for
 * linear, a landing for ease-out) and the view-axis dolly step. The cinematic cubic stays the
 * default, so the learner-selected focus move is untouched by any of it.
 *
 * The camera's own state is spherical — an angle around the model, a polar angle, a distance and a
 * pivot — because that is what a hand-rolled orbit rig is. Interpolating that state, rather than
 * interpolating a position and re-deriving the rig afterwards, keeps the orbit rig the single
 * source of truth: a gesture that lands mid-move continues from exactly where the camera is.
 */
import type { ShotEasing } from '@edu3d/contracts';

/** The camera's position expressed as the orbit rig understands it. */
export interface OrbitPose {
  /** Angle around the model, in radians. */
  theta: number;
  /** Angle from the vertical pole, in radians. */
  phi: number;
  /** Distance from the pivot. */
  distance: number;
  /** The pivot the camera looks at. */
  target: { x: number; y: number; z: number };
}

/** The limits the rig enforces, so a move can never end somewhere the rig would refuse. */
export interface GlideLimits {
  minPhi: number;
  maxPhi: number;
  minDistance: number;
  maxDistance: number;
}

/** A move in flight. */
export interface Glide {
  from: OrbitPose;
  to: OrbitPose;
  elapsed: number;
  duration: number;
  /** The angle to travel, already resolved to the short way round. */
  thetaDelta: number;
  /**
   * The curve this travel follows. Defaulted to the cinematic cubic so the focus glide never has
   * to name it; a declared shot carries its own choice.
   */
  easing: ShotEasing;
}

/** How long a camera move takes, in seconds. */
export const GLIDE_DURATION = 0.9;

/**
 * The floor on a move's duration.
 *
 * A zero-length move would divide by zero, and a move that is over before it starts reads as a
 * cut — the one thing a camera move exists to avoid.
 */
const MIN_DURATION = 0.01;

/**
 * The distance in pixels a pointer may travel and still count as a tap.
 *
 * A finger is not precise; a couple of pixels of jitter is still a tap. Beyond this the learner is
 * steering the camera, and the camera must yield.
 */
export const TAP_THRESHOLD_PX = 6;

/**
 * Cubic ease-in-out: slow in, fast through the middle, slow out.
 *
 * The curve is what makes the move read as deliberate. A linear slide reads as a slider being
 * dragged; this reads as a camera operator moving.
 */
export function easeInOutCubic(t: number): number {
  const clamped = Math.min(1, Math.max(0, t));
  return clamped < 0.5 ? 4 * clamped * clamped * clamped : 1 - Math.pow(-2 * clamped + 2, 3) / 2;
}

/** The easing vocabulary a `ShotDecl` names, as pure functions of normalized time. */
export function easeLinear(t: number): number {
  return t;
}
export function easeInCubic(t: number): number {
  return t * t * t;
}
export function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

/**
 * The curve a shot asked for. A module-level lookup rather than a closure factory: this runs once
 * per frame while a move is in flight, and a per-frame allocation here is exactly the churn the
 * frame budget exists to prevent.
 */
export function easeFor(easing: ShotEasing): (t: number) => number {
  switch (easing) {
    case 'linear':
      return easeLinear;
    case 'easeIn':
      return easeInCubic;
    case 'easeOut':
      return easeOutCubic;
    default:
      return easeInOutCubic;
  }
}

/**
 * The signed angle from one bearing to another, taking the short way round.
 *
 * A camera that spins 350° to reach a target 10° away is the difference between a cinematic move
 * and a screensaver.
 */
export function shortestAngleDelta(from: number, to: number): number {
  const turn = 2 * Math.PI;
  let delta = (to - from) % turn;
  if (delta > Math.PI) delta -= turn;
  if (delta < -Math.PI) delta += turn;
  return delta;
}

/** A copy, so a glide never aliases the live camera state it was built from. */
function clonePose(pose: OrbitPose): OrbitPose {
  return {
    theta: pose.theta,
    phi: pose.phi,
    distance: pose.distance,
    target: { x: pose.target.x, y: pose.target.y, z: pose.target.z },
  };
}

function lerp(from: number, to: number, t: number): number {
  return from + (to - from) * t;
}

/**
 * Begin a move.
 *
 * The origin is whatever the camera is doing now, so a second move started mid-flight continues
 * from there rather than snapping back to a stale origin.
 */
export function createGlide(
  from: OrbitPose,
  to: OrbitPose,
  duration: number = GLIDE_DURATION,
  easing: ShotEasing = 'easeInOut',
): Glide {
  return {
    from: clonePose(from),
    to: clonePose(to),
    elapsed: 0,
    duration: Math.max(MIN_DURATION, duration),
    thetaDelta: shortestAngleDelta(from.theta, to.theta),
    easing,
  };
}

/**
 * Advance a move by one frame.
 *
 * Pure: it returns the new state and the pose to use, and changes nothing. The caller applies the
 * pose, which keeps the camera's own state in one place and this arithmetic testable.
 */
export function stepGlide(
  glide: Glide,
  deltaSeconds: number,
  limits?: GlideLimits,
): { glide: Glide; pose: OrbitPose; done: boolean } {
  const elapsed = glide.elapsed + Math.max(0, deltaSeconds);
  const t = Math.min(1, elapsed / glide.duration);
  const eased = easeFor(glide.easing)(t);

  const pose: OrbitPose = {
    theta: glide.from.theta + glide.thetaDelta * eased,
    phi: lerp(glide.from.phi, glide.to.phi, eased),
    distance: lerp(glide.from.distance, glide.to.distance, eased),
    target: {
      x: lerp(glide.from.target.x, glide.to.target.x, eased),
      y: lerp(glide.from.target.y, glide.to.target.y, eased),
      z: lerp(glide.from.target.z, glide.to.target.z, eased),
    },
  };

  if (limits) {
    // The rig's own limits, applied to the pose rather than to the endpoints: a move that ends
    // outside them would leave the camera somewhere the rig refuses to be.
    pose.phi = Math.max(limits.minPhi, Math.min(limits.maxPhi, pose.phi));
    pose.distance = Math.max(limits.minDistance, Math.min(limits.maxDistance, pose.distance));
  }

  return { glide: { ...glide, elapsed }, pose, done: t >= 1 };
}

/**
 * The distance at which a sphere of the given radius fits the view.
 *
 * Both axes are considered. Fitting the vertical field of view alone — which is what the first
 * version of this platform did — crops a wide object on a portrait phone, because a phone's
 * horizontal field of view is the narrow one.
 */
export function fitDistance(
  radius: number,
  fovDegrees: number,
  aspect: number,
  margin: number,
): number {
  const verticalHalf = (fovDegrees * Math.PI) / 360;
  const horizontalHalf = Math.atan(Math.tan(verticalHalf) * Math.max(0.0001, aspect));
  const verticalFit = radius / Math.max(1e-6, Math.sin(verticalHalf));
  const horizontalFit = radius / Math.max(1e-6, Math.sin(horizontalHalf));
  return Math.max(verticalFit, horizontalFit) * margin;
}

/**
 * Whether a pointer gesture was a tap rather than a drag.
 *
 * This is what separates "the learner chose a part" from "the learner is steering the camera".
 * The camera must only travel for the first.
 */
export function isTapGesture(
  downX: number,
  downY: number,
  upX: number,
  upY: number,
  thresholdPx: number = TAP_THRESHOLD_PX,
): boolean {
  const dx = upX - downX;
  const dy = upY - downY;
  return Math.sqrt(dx * dx + dy * dy) <= thresholdPx;
}

/** A press in progress, and how many fingers were part of it. */
export interface PointerPress {
  x: number;
  y: number;
  /**
   * How many pointers took part in the press.
   *
   * More than one means a pinch: the learner is changing the distance, not choosing a part. Two
   * fingers held close together barely move, so the travel test alone would mistake a pinch for a
   * tap and the camera would fly away in the middle of it.
   */
  pointers: number;
}

/**
 * Whether a release ends a tap.
 *
 * The three ways a release is not a tap: no press was recorded (the pointer went down outside the
 * canvas), more than one finger was involved (a pinch), or the finger travelled (a drag).
 */
export function isTapRelease(press: PointerPress | null, upX: number, upY: number): boolean {
  if (!press) return false;
  if (press.pointers !== 1) return false;
  return isTapGesture(press.x, press.y, upX, upY);
}

/**
 * Whether a pose can be used at all.
 *
 * A mesh with a broken vertex can produce a bounding radius that is not a number, and a camera at
 * a position that is not a number takes the renderer down with it. A move to an impossible place is
 * simply not started.
 */
export function isUsablePose(pose: OrbitPose): boolean {
  return (
    Number.isFinite(pose.theta) &&
    Number.isFinite(pose.phi) &&
    Number.isFinite(pose.distance) &&
    pose.distance > 0 &&
    Number.isFinite(pose.target.x) &&
    Number.isFinite(pose.target.y) &&
    Number.isFinite(pose.target.z)
  );
}

/**
 * The destination of a dolly: `delta` along the view axis, the angle and pivot untouched.
 *
 * "Toward the target when negative" is the contract's sign — the camera slides along the line it
 * is already looking down. Distance limits are deliberately *not* applied here: `stepGlide`
 * applies them to the pose every frame, so clamping happens on the travel rather than only at the
 * endpoints, and an endpoint clamp can never strand the camera somewhere the rig refuses.
 */
export function dollyPose(pose: OrbitPose, delta: number): OrbitPose {
  return {
    theta: pose.theta,
    phi: pose.phi,
    distance: pose.distance + delta,
    target: { x: pose.target.x, y: pose.target.y, z: pose.target.z },
  };
}

/**
 * Point a move at a destination that has moved.
 *
 * A spinning blade is somewhere else by the time the camera arrives, so the destination is
 * re-measured while the camera travels. The direction the camera is heading in and the move's own
 * clock are untouched: re-aiming changes where the camera is going, not where it came from, and it
 * must not send the camera back to the start.
 */
export function retargetGlide(
  glide: Glide,
  target: { x: number; y: number; z: number },
  distance: number,
): Glide {
  return {
    ...glide,
    to: {
      ...glide.to,
      target: { x: target.x, y: target.y, z: target.z },
      distance,
    },
  };
}
