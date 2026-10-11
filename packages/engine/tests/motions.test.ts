/**
 * Declared-motion application tests.
 *
 * `scene.motion()` was captured into the manifest, scored by the audit and asserted by tests — and
 * no runtime code ever applied it: the flagship model's fan stood still while its readouts moved.
 * These tests are the spec for the applicator that fixes that, and they encode the two properties
 * the phase exists to guarantee:
 *
 *   - **absolute, never accumulated** — every pose is a pure function of the authored base, the
 *     resolved parameters and `elapsed`. An applicator that did `rotation += …` fails the
 *     time-backwards test, and that test is the reason reset and time-scrub stay exact.
 *   - **parameter binding** — a rate of `{ param: 'rpm' }` turns when the slider turns. This is
 *     `00`'s "rate, direction and amplitude come from the model's own parameters", made executable.
 *
 * Units are the contract (`behavior.ts`): rad/s for spin and orbit, m/s for translate, Hz for
 * oscillate and pulse, phase in radians. A test that gets a unit wrong is a wrong test.
 */
import { describe, expect, it } from 'vitest';
import type { MotionDeclInput, ScalarSource } from '@edu3d/contracts';
import {
  applyMotions,
  resolveScalar,
  type MotionHost,
  type PartTransformLike,
  type ScalarContext,
} from '../src/runtime/motions.ts';

/** Deep-copy a transform, so the live copy can mutate without touching the base. */
const clone = (t: PartTransformLike): PartTransformLike => ({
  position: [...t.position],
  ...(t.rotation ? { rotation: [...t.rotation] } : {}),
  scale: [...t.scale],
});

/**
 * A motion with every defaulted field made explicit, so each test states its own semantics. Typed
 * as the *input* shape — the way the builder captures a declaration — so a fixture may spell
 * `rate: { param: 'rpm' }` with no `scale`/`offset`, exactly the shape the load path delivers.
 */
const motion = (
  overrides: Partial<MotionDeclInput> & Pick<MotionDeclInput, 'id' | 'partId' | 'kind'>,
): MotionDeclInput => ({
  axis: [0, 1, 0],
  rate: { const: 1 },
  phase: 0,
  runsWhilePaused: false,
  ...overrides,
});

/**
 * A host rig mirroring the worker's contract: `base` is the authored snapshot (never mutated),
 * `live` is what the renderer reads, and the applicator expects the host to have reset `live` back
 * to base before the model's own frame code ran — `resetToBase` is that step, invoked per apply.
 */
function rig(
  parts: Record<string, PartTransformLike>,
  motions: readonly MotionDeclInput[] = [],
  pointOnPath?: MotionHost['pointOnPath'],
) {
  const base = new Map(Object.entries(parts).map(([id, t]) => [id, clone(t)]));
  const live = new Map(Object.entries(parts).map(([id, t]) => [id, clone(t)]));
  const host: MotionHost = {
    motions,
    baseTransform: (id) => base.get(id),
    liveTransform: (id) => live.get(id),
    ...(pointOnPath ? { pointOnPath } : {}),
  };
  return {
    host,
    /** The worker's pre-frame reset: motions compose from base, never from their own last output. */
    resetToBase: () => {
      for (const [id, t] of base) live.set(id, clone(t));
    },
    live: (id: string) => live.get(id) as PartTransformLike,
  };
}

/** The context every apply uses unless a test overrides something deliberately. */
const ctx = (overrides: Partial<ScalarContext> = {}): ScalarContext => ({
  params: {},
  elapsed: 0,
  ...overrides,
});

/**
 * Apply an XYZ Euler triple to a vector (R = Rx·Ry·Rz) — the same convention Three.js
 * `object.rotation` uses.
 *
 * Spin assertions compare *orientations*, not triples: an Euler spelling is not unique (a 2-rad
 * spin about Y also spells (π, π−2, π) — principal-value XYZ, exactly what Three.js's own
 * quaternion→Euler conversion produces), and the rendered pose is the contract.
 */
function applyEuler(
  euler: readonly number[],
  v: readonly [number, number, number],
): [number, number, number] {
  const x = euler[0] ?? 0;
  const y = euler[1] ?? 0;
  const z = euler[2] ?? 0;
  // Rz first, then Ry, then Rx — the right-to-left order of the matrix product.
  const x1 = v[0] * Math.cos(z) - v[1] * Math.sin(z);
  const y1 = v[0] * Math.sin(z) + v[1] * Math.cos(z);
  const x2 = x1 * Math.cos(y) + v[2] * Math.sin(y);
  const z2 = -x1 * Math.sin(y) + v[2] * Math.cos(y);
  return [x2, y1 * Math.cos(x) - z2 * Math.sin(x), y1 * Math.sin(x) + z2 * Math.cos(x)];
}

/** Where a Y-axis spin of `angle` sends the +X basis vector (right-hand rule: x rotates to −z). */
const ySpinOfX = (angle: number): [number, number, number] => [
  Math.cos(angle),
  0,
  -Math.sin(angle),
];

const expectVecClose = (
  actual: readonly number[],
  expected: readonly number[],
  precision = 10,
): void => {
  for (let i = 0; i < 3; i += 1) {
    expect(actual[i], `component ${i}`).toBeCloseTo(expected[i] ?? 0, precision);
  }
};

describe('resolveScalar', () => {
  it('returns the constant', () => {
    expect(resolveScalar({ const: 3.5 }, ctx())).toBe(3.5);
  });

  it('resolves a parameter with scale and offset', () => {
    const source: ScalarSource = { param: 'rpm', scale: 2, offset: 1 };
    expect(resolveScalar(source, ctx({ params: { rpm: 3 } }))).toBe(7);
  });

  it('resolves a missing parameter to 0 — never NaN, which would poison the transform', () => {
    expect(resolveScalar({ param: 'absent' }, ctx())).toBe(0);
  });

  it('resolves time and simTime signals from elapsed, and frame from the frame counter', () => {
    expect(resolveScalar({ signal: 'time', scale: 2 }, ctx({ elapsed: 3 }))).toBe(6);
    // Spelled without `scale` the way guest code declares it: the builder captures the raw
    // object, so the resolver — not the schema — supplies the default on the load path.
    expect(resolveScalar({ signal: 'simTime' }, ctx({ elapsed: 3 }))).toBe(3);
    expect(resolveScalar({ signal: 'frame', scale: 0.5 }, ctx({ elapsed: 1, frame: 10 }))).toBe(5);
  });

  it('resolves probes, defaulting to 0 when the model runs no physics', () => {
    expect(resolveScalar({ probe: 'shaftTorque' }, ctx())).toBe(0);
    expect(
      resolveScalar(
        { probe: 'shaftTorque', scale: 2, offset: 1 },
        ctx({ probes: { shaftTorque: 4 } }),
      ),
    ).toBe(9);
  });

  it('quarantines a non-finite resolution to 0 for that tick', () => {
    // The NaN class `08-PERFORMANCE-AND-DEVICES.md:108` documents: one NaN position silently
    // breaks frustum culling and raycasting for a whole subtree.
    expect(resolveScalar({ param: 'poison' }, ctx({ params: { poison: Number.NaN } }))).toBe(0);
    expect(
      resolveScalar({ param: 'poison' }, ctx({ params: { poison: Number.POSITIVE_INFINITY } })),
    ).toBe(0);
  });
});

describe('applyMotions — spin', () => {
  it('rotates by rate·elapsed about the axis from a base of no rotation', () => {
    const r = rig({ fan: { position: [0, 0, 0], scale: [1, 1, 1] } }, [
      motion({ id: 'spin', partId: 'fan', kind: 'spin', rate: { const: 2 } }),
    ]);

    r.resetToBase();
    applyMotions(r.host, ctx({ elapsed: Math.PI / 4 }), false);

    const rotation = r.live('fan').rotation ?? [];
    expect(rotation[0]).toBeCloseTo(0, 12);
    expect(rotation[1]).toBeCloseTo(Math.PI / 2, 12);
    expect(rotation[2]).toBeCloseTo(0, 12);
  });

  it('binds its rate to a parameter — the case the whole phase exists for', () => {
    const r = rig({ fan: { position: [0, 0, 0], scale: [1, 1, 1] } }, [
      motion({ id: 'spin', partId: 'fan', kind: 'spin', rate: { param: 'rpm' } }),
    ]);

    r.resetToBase();
    applyMotions(r.host, ctx({ params: { rpm: 2 }, elapsed: 1 }), false);
    // rpm·t = 2 rad — asserted as the orientation, because 2 rad is past the Y channel's
    // principal range and the equivalent Euler spelling is (π, π−2, π).
    expectVecClose(applyEuler(r.live('fan').rotation ?? [0, 0, 0], [1, 0, 0]), ySpinOfX(2));
  });

  it('composes with a non-zero base rotation — a pre-tilted part keeps its tilt while spinning', () => {
    const r = rig({ fan: { position: [0, 0, 0], rotation: [0.3, 0, 0], scale: [1, 1, 1] } }, [
      motion({ id: 'spin', partId: 'fan', kind: 'spin', rate: { const: 1 } }),
    ]);

    r.resetToBase();
    applyMotions(r.host, ctx({ elapsed: 0.8 }), false);

    const rotation = r.live('fan').rotation ?? [];
    expect(rotation[0]).toBeCloseTo(0.3, 12);
    expect(rotation[1]).toBeCloseTo(0.8, 12);
    expect(rotation[2]).toBeCloseTo(0, 12);
  });

  it('distributes a set of bodies by phase', () => {
    const r = rig(
      {
        a: { position: [0, 0, 0], scale: [1, 1, 1] },
        b: { position: [0, 0, 0], scale: [1, 1, 1] },
      },
      [
        motion({ id: 'sa', partId: 'a', kind: 'spin', rate: { const: 1 }, phase: 0 }),
        motion({ id: 'sb', partId: 'b', kind: 'spin', rate: { const: 1 }, phase: Math.PI }),
      ],
    );

    r.resetToBase();
    applyMotions(r.host, ctx({ elapsed: 1.7 }), false);

    // Two bodies π apart point opposite ways whatever the Euler spelling — antipodal vectors.
    const a = applyEuler(r.live('a').rotation ?? [0, 0, 0], [1, 0, 0]);
    const b = applyEuler(r.live('b').rotation ?? [0, 0, 0], [1, 0, 0]);
    expect(a[0] * b[0] + a[1] * b[1] + a[2] * b[2]).toBeCloseTo(-1, 10);
  });

  it('quarantines a NaN parameter into a still transform rather than a poisoned one', () => {
    const r = rig({ fan: { position: [0, 0, 0], rotation: [0.1, 0.2, 0.3], scale: [1, 1, 1] } }, [
      motion({ id: 'spin', partId: 'fan', kind: 'spin', rate: { param: 'rpm' } }),
    ]);

    r.resetToBase();
    applyMotions(r.host, ctx({ params: { rpm: Number.NaN }, elapsed: 5 }), false);

    // The NaN resolved to 0 rad/s, so the part keeps exactly its base orientation (component-wise
    // close rather than exactly equal: the quaternion round-trip is exact to float precision).
    const rotation = r.live('fan').rotation ?? [];
    expect(rotation[0]).toBeCloseTo(0.1, 12);
    expect(rotation[1]).toBeCloseTo(0.2, 12);
    expect(rotation[2]).toBeCloseTo(0.3, 12);
  });
});

describe('applyMotions — pause and time', () => {
  it('holds still while paused, unless the motion declares runsWhilePaused', () => {
    const r = rig(
      {
        fan: { position: [0, 0, 0], scale: [1, 1, 1] },
        glow: { position: [0, 0, 0], scale: [1, 1, 1] },
      },
      [
        motion({ id: 'spin', partId: 'fan', kind: 'spin', rate: { const: 1 } }),
        motion({
          id: 'pulse',
          partId: 'glow',
          kind: 'pulse',
          rate: { const: 1 },
          amplitude: { const: 0.5 },
          runsWhilePaused: true,
        }),
      ],
    );

    r.resetToBase();
    applyMotions(r.host, ctx({ elapsed: 1 }), true);
    // A real frame loop resets runsWhilePaused parts to base every frame even while paused,
    // so the pause-time apply is absolute rather than multiplicative across ticks.
    r.resetToBase();
    applyMotions(r.host, ctx({ elapsed: 2 }), true);

    expect(r.live('fan').rotation).toBeUndefined();
    expect(r.live('glow').scale[0]).toBeCloseTo(
      1 + 0.5 * (0.5 + 0.5 * Math.sin(2 * Math.PI * 2)),
      12,
    );
  });

  it('yields the earlier pose exactly when time goes backwards — the reset-exactness property', () => {
    const motions = [motion({ id: 'spin', partId: 'fan', kind: 'spin', rate: { param: 'rpm' } })];
    const r = rig({ fan: { position: [0, 0, 0], scale: [1, 1, 1] } }, motions);

    // Forward to t=10 at 2 rad/s, then scrub back to t=1 through the same host-reset contract a
    // real frame loop applies. The pose must be exactly the fresh t=1 pose.
    r.resetToBase();
    applyMotions(r.host, ctx({ params: { rpm: 2 }, elapsed: 10 }), false);
    r.resetToBase();
    applyMotions(r.host, ctx({ params: { rpm: 2 }, elapsed: 1 }), false);
    const scrubbed = r.live('fan').rotation ?? [];

    const fresh = rig({ fan: { position: [0, 0, 0], scale: [1, 1, 1] } }, motions);
    applyMotions(fresh.host, ctx({ params: { rpm: 2 }, elapsed: 1 }), false);

    expect(scrubbed).toEqual(fresh.live('fan').rotation ?? []);
    expectVecClose(applyEuler(scrubbed, [1, 0, 0]), ySpinOfX(2));
  });

  it('stays deterministic when a parameter changes mid-scrub — the pose is rate·t, not a sum of rate·dt', () => {
    // The case the absolute rule exists for: drag the slider and the pose must snap to what the
    // new rate means at the current time. An accumulated implementation (angle += rate·dt) carries
    // every previous rate's contribution and cannot reproduce rate·elapsed — 2 rad/s for 10 s
    // then 3 rad/s at t=1 must be 3 rad, not 20 + 3·(1 − 10) = −7.
    const motions = [motion({ id: 'spin', partId: 'fan', kind: 'spin', rate: { param: 'rpm' } })];
    const r = rig({ fan: { position: [0, 0, 0], scale: [1, 1, 1] } }, motions);

    r.resetToBase();
    applyMotions(r.host, ctx({ params: { rpm: 2 }, elapsed: 10 }), false);
    r.resetToBase();
    applyMotions(r.host, ctx({ params: { rpm: 3 }, elapsed: 1 }), false);

    expectVecClose(applyEuler(r.live('fan').rotation ?? [0, 0, 0], [1, 0, 0]), ySpinOfX(3));
  });
});

describe('applyMotions — position and scale kinds', () => {
  it('orbits about the centre on the axis, preserving the base radius and turning the part with it', () => {
    const r = rig({ electron: { position: [2, 0, 0], scale: [1, 1, 1] } }, [
      motion({ id: 'orbit', partId: 'electron', kind: 'orbit', rate: { const: 1 } }),
    ]);

    r.resetToBase();
    applyMotions(r.host, ctx({ elapsed: Math.PI / 2 }), false);

    const position = r.live('electron').position;
    // [2,0,0] rotated +90° about +y lands on −z; right-hand rule, radius unchanged.
    expect(position[0]).toBeCloseTo(0, 12);
    expect(position[1]).toBeCloseTo(0, 12);
    expect(position[2]).toBeCloseTo(-2, 12);
    // Tidal orientation: the part's own rotation composes the same revolution angle.
    expect((r.live('electron').rotation ?? [])[1]).toBeCloseTo(Math.PI / 2, 12);
  });

  it('honours an explicit orbit centre', () => {
    const r = rig({ moon: { position: [3, 0, 0], scale: [1, 1, 1] } }, [
      motion({
        id: 'orbit',
        partId: 'moon',
        kind: 'orbit',
        rate: { const: 1 },
        center: [1, 0, 0],
        axis: [0, 0, 1],
      }),
    ]);

    r.resetToBase();
    applyMotions(r.host, ctx({ elapsed: Math.PI }), false);

    const position = r.live('moon').position;
    // Radius 2 about (1,0,0) in the xy plane: half a turn about +z moves x from +3 to −1.
    expect(position[0]).toBeCloseTo(-1, 12);
    expect(position[1]).toBeCloseTo(0, 12);
    expect(position[2]).toBeCloseTo(0, 12);
  });

  it('oscillates along the axis at Hz, resolving amplitude through the same context', () => {
    const r = rig({ bob: { position: [0, 0, 0], scale: [1, 1, 1] } }, [
      motion({
        id: 'osc',
        partId: 'bob',
        kind: 'oscillate',
        rate: { const: 0.5 },
        amplitude: { param: 'stroke', scale: 2 },
      }),
    ]);

    r.resetToBase();
    // 0.5 Hz has a 2 s period, so t=0.5 is the quarter-period peak: sin(π/2) = 1.
    applyMotions(r.host, ctx({ params: { stroke: 1 }, elapsed: 0.5 }), false);

    expect(r.live('bob').position[1]).toBeCloseTo(2, 12);
  });

  it('translates at velocity × time along the axis', () => {
    const r = rig({ cart: { position: [0, 0, 0], scale: [1, 1, 1] } }, [
      motion({
        id: 'move',
        partId: 'cart',
        kind: 'translate',
        axis: [1, 0, 0],
        rate: { const: 3 },
        amplitude: { const: 2 },
      }),
    ]);

    r.resetToBase();
    applyMotions(r.host, ctx({ elapsed: 2 }), false);

    expect(r.live('cart').position[0]).toBeCloseTo(12, 12);
  });

  it('pulses scale between 1 and 1+amplitude, and never reaches zero or below', () => {
    const r = rig({ flame: { position: [0, 0, 0], scale: [2, 2, 2] } }, [
      motion({
        id: 'pulse',
        partId: 'flame',
        kind: 'pulse',
        rate: { const: 1 },
        amplitude: { const: -3 },
      }),
    ]);

    // An amplitude beyond −1 would drive the factor negative on the sin = 1 half-period — an
    // inverted part is geometry corruption, so the factor clamps at a small positive epsilon.
    for (let i = 0; i <= 8; i += 1) {
      r.resetToBase();
      applyMotions(r.host, ctx({ elapsed: i / 8 }), false);
      for (const component of r.live('flame').scale) {
        expect(component).toBeGreaterThan(0);
        expect(Number.isFinite(component)).toBe(true);
      }
    }

    // At t = 0.25 (sin = 1) the unclamped factor would be 1 − 3 = −2; the clamp holds it near zero.
    r.resetToBase();
    applyMotions(r.host, ctx({ elapsed: 0.25 }), false);
    expect(r.live('flame').scale[0]).toBeLessThanOrEqual(2 * 1e-4);
    expect(r.live('flame').scale[0]).toBeGreaterThan(0);
  });

  it('flows along a path, wrapping the sample fraction at 1', () => {
    const r = rig(
      { bead: { position: [0, 0, 0], scale: [1, 1, 1] } },
      [
        motion({
          id: 'flow',
          partId: 'bead',
          kind: 'flowAlongPath',
          rate: { const: 1 },
          pathId: 'pipe',
        }),
      ],
      (pathId, t) => (pathId === 'pipe' ? [t * 10, 1, 2] : undefined),
    );

    r.resetToBase();
    applyMotions(r.host, ctx({ elapsed: 1.25 }), false);
    expect(r.live('bead').position).toEqual([2.5, 1, 2]);

    r.resetToBase();
    applyMotions(r.host, ctx({ elapsed: 2 }), false);
    expect(r.live('bead').position[0]).toBeCloseTo(0, 12);
  });

  it('skips flowAlongPath silently when the path cannot be sampled', () => {
    const r = rig({ bead: { position: [7, 8, 9], scale: [1, 1, 1] } }, [
      motion({
        id: 'flow',
        partId: 'bead',
        kind: 'flowAlongPath',
        rate: { const: 1 },
        pathId: 'missing',
      }),
    ]);

    r.resetToBase();
    applyMotions(r.host, ctx({ elapsed: 3 }), false);

    // Unchanged, not crashed: the frame loop never throws, and the audit's missing-path
    // dimension is the place a bad pathId is reported.
    expect(r.live('bead').position).toEqual([7, 8, 9]);
  });
});

describe('applyMotions — robustness', () => {
  it('is a no-op for a motion targeting a part the host does not know', () => {
    const r = rig({ fan: { position: [0, 0, 0], scale: [1, 1, 1] } }, [
      motion({ id: 'dangling', partId: 'ghost', kind: 'spin' }),
    ]);

    expect(() => applyMotions(r.host, ctx({ elapsed: 1 }), false)).not.toThrow();
    expect(r.live('fan').rotation).toBeUndefined();
  });
});
