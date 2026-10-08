/**
 * The reference model: a hand-authored mechanical watch movement.
 *
 * WHY A WATCH, AND WHY THIS ONE
 *
 * A landing page has about three seconds to answer "is this real?". A movement answers it in a way a
 * gearbox cannot, because a movement is the one machine people already believe is hard — and it is
 * the only common machine whose entire purpose is a number you cannot see.
 *
 * It was chosen against the alternatives deliberately:
 *   - A gear simulator already exists, free, several of them. A better one is a worse bet.
 *   - A four-stroke engine teaches well and photographs badly. It is a piston in a box.
 *   - A watch is the densest intersection of the three things this engine is for: real involute
 *     geometry, a motion the eye cannot fake, and a *causal* claim that is checkable.
 *
 * WHAT IT DEMONSTRATES, AND WHY NO MESH GENERATOR CAN
 *
 * The claim this model exists to make is that a watch keeps time *because* of the balance and spring,
 * and the demonstration is the parameter. Turning the timing screws changes the balance's moment of
 * inertia, which changes its natural frequency, which changes the rate. That is the entire physics
 * of a mechanical watch, and it is a causal chain with a number at the end of it. A static mesh —
 * however beautiful, however detailed — is a picture of that chain's *result* with the chain removed.
 *
 * The escapement sells it just as well, and sells it silently: the escape wheel does not rotate, it
 * *steps*, one tooth at a time, and the pallet fork rocks between two locks in lockstep. Everything
 * else in the movement turns smoothly. That contrast is the visual signature of a mechanical watch
 * and it is an emergent consequence of the mechanism, not an animation someone keyframed.
 *
 * HONESTY
 *
 * `simplifications` below declares every liberty taken, because a model that lied about its own
 * accuracy would undercut the one thing it is arguing for. The largest is the inertia range: real
 * timing adjustments move the rate by seconds per day and are therefore invisible on screen, so the
 * slider spans a far wider range than a real watchmaker would use. The *direction* and the *cause*
 * are real. The magnitude is exaggerated so the cause is visible. That is stated on the model rather
 * than hidden.
 *
 * Exported as a source *string*, like the turbofan: it must travel through the same gate,
 * instrumentation, hardening and sandbox as anything a model would write. A fixture that bypassed the
 * boundary would prove nothing about the boundary.
 */

export const WATCH_MODEL_SOURCE = String.raw`
// A mechanical watch movement. Units are millimetres and seconds throughout.

scene.describe({
  name: 'Mechanical Watch Movement',
  description:
    'A cutaway automatic movement showing how a watch keeps time: the mainspring pushes the gear train, ' +
    'the escape wheel releases it one tooth at a time, and the balance wheel and hairspring decide how ' +
    'often that happens.',
  domain: 'mechanical-engineering',
  subdomain: 'horology',
  concept: 'A watch keeps time because a balance wheel and a spiral spring form an oscillator of almost fixed period.',
  objectives: [
    'Trace the power path from the mainspring barrel to the escape wheel',
    'Explain why the escape wheel steps instead of turning smoothly',
    'Predict how adding inertia to the balance changes the rate',
    'Describe why a run-down mainspring costs the watch accuracy',
  ],
  level: 'secondary',
  principles: [
    'A balance wheel and hairspring form a harmonic oscillator: f = (1/2*pi) * sqrt(k / I)',
    'The escapement meters the mainspring energy into discrete beats',
    'A watch is a tuned resonator, not a motor',
  ],
  simplifications: [
    'The inertia slider spans a far wider range than a real timing adjustment. Real changes move the ' +
      'rate by seconds per day and would be invisible; the direction and the cause are real, the ' +
      'magnitude is exaggerated so the cause can be seen.',
    'Tooth counts are reduced so individual teeth stay legible at screen size.',
    'The mainspring is shown as a wound ribbon rather than a coiled strip, so its state is readable.',
  ],
  relationships: [
    { from: 'barrel', to: 'trainWheels', kind: 'drives', note: 'mainspring power enters here' },
    { from: 'trainWheels', to: 'escapeWheel', kind: 'drives', note: 'train exists to turn the escape wheel' },
    { from: 'escapeWheel', to: 'palletFork', kind: 'releases', note: 'one tooth per beat' },
    { from: 'palletFork', to: 'balance', kind: 'impulses', note: 'the only power the balance receives' },
    { from: 'balance', to: 'hairspring', kind: 'opposes', note: 'the restoring force' },
  ],
});

// Colour roles: the semantic system the learner learns to read.
scene.colorRole({ id: 'gold', label: 'Gold-plated', color: '#d4a055', meaning: 'Wheels and pinions' });
scene.colorRole({ id: 'steel', label: 'Steel', color: '#b9bec4', meaning: 'Plates, bridges and levers' });
scene.colorRole({ id: 'ruby', label: 'Ruby jewel', color: '#c0392b', meaning: 'Synthetic bearings, 25 of them' });
scene.colorRole({ id: 'blue', label: 'Blued steel', color: '#3b6ea5', meaning: 'Screws and the hairspring' });
scene.colorRole({ id: 'motive', label: 'Motive power', color: '#e07b39', meaning: 'Mainspring energy' });

// ── Parameters ───────────────────────────────────────────────────────────────
scene.param({
  id: 'beatRate',
  kind: 'number',
  label: 'Beat rate',
  unit: 'bph',
  min: 18000,
  max: 28800,
  default: 28800,
  precision: 0,
  description:
    'Vibrations per hour. 28800 is four ticks a second. A higher rate means a smaller, stiffer balance ' +
    'oscillating faster, which is why chronometers beat faster than dress watches.',
  affects: [{ channel: 'motionRate' }, { channel: 'metric' }],
});

scene.param({
  id: 'inertia',
  kind: 'number',
  label: 'Balance inertia',
  min: 0.6,
  max: 1.8,
  default: 1,
  precision: 2,
  description:
    'How much mass the balance carries. Turning the timing screws in or out changes this, and because ' +
    'the rate goes as the inverse square root of inertia, a heavier balance runs slow.',
  affects: [{ channel: 'motionRate' }, { channel: 'metric' }],
});

scene.param({
  id: 'powerReserve',
  kind: 'number',
  label: 'Power reserve',
  unit: 'h',
  min: 0,
  max: 72,
  default: 68,
  precision: 0,
  description:
    'Hours of stored mainspring energy left. As it runs down the barrel torque falls, the impulse into ' +
    'the balance weakens, the swing narrows — and a smaller swing is a less accurate swing.',
  affects: [{ channel: 'material' }, { channel: 'metric' }],
});

scene.param({
  id: 'cutaway',
  kind: 'boolean',
  label: 'Cutaway view',
  default: true,
  description: 'Lift the main plate away so the train and escapement are visible.',
  affects: [{ channel: 'visibility' }],
});

// Derived read-outs. Published by this model's own frame code, so the numbers on screen and the '
// 'motion on screen cannot disagree.
scene.metric({ id: 'rate', label: 'Rate', unit: 's/day', precision: 0, formula: 'dev = (1/sqrt(I) - 1) * 86400' });
scene.metric({ id: 'amplitude', label: 'Amplitude', unit: 'deg', precision: 0, formula: 'A = A0 * sqrt(reserve) * sqrt(k/I)' });
scene.metric({ id: 'beatHz', label: 'Beat', unit: 'Hz', precision: 2, formula: 'f = bph / 3600' });
scene.metric({ id: 'reserveHours', label: 'Reserve left', unit: 'h', precision: 0 });

// ── Materials ────────────────────────────────────────────────────────────────
var goldWheel = mat.metal({ role: 'gold', roughness: 0.24 });
var goldBright = mat.metal({ role: 'gold', roughness: 0.12 });
var steelPlate = mat.metal({ role: 'steel', roughness: 0.34 });
var steelBridge = mat.metal({ role: 'steel', roughness: 0.2 });
var steelLever = mat.metal({ role: 'steel', roughness: 0.18 });
var blued = mat.metal({ role: 'blue', roughness: 0.16 });
var ruby = mat.organic({ role: 'ruby', opacity: 0.85 });
var rubyBright = mat.emissive({ role: 'ruby', emissiveIntensity: 0.35 });
var springSteel = mat.metal({ role: 'motive', roughness: 0.28 });
var rotorMetal = mat.metal({ color: '#c9ccd1', roughness: 0.14 });

// ── Structure ────────────────────────────────────────────────────────────────
scene.group({ id: 'movement', name: 'Movement' });
scene.group({ id: 'staticParts', name: 'Plates and bridges', parentId: 'movement', group: 'static' });
scene.group({ id: 'goingTrain', name: 'Going train', parentId: 'movement', group: 'rotating' });
scene.group({ id: 'escapement', name: 'Escapement', parentId: 'movement', group: 'escapement' });

// ── The main plate ───────────────────────────────────────────────────────────
scene.mesh({
  id: 'mainPlate',
  name: 'Main plate',
  parentId: 'staticParts',
  // An annular profile revolved about z: the profile's x is the radius, its y the thickness. A washer is
  // exactly a closed rectangle in that plane, so the main plate needs no special builder.
  geometry: geom.revolve({
    profile: geom.profile(
      [
        [0.2, -0.08],
        [2.5, -0.08],
        [2.5, 0.08],
        [0.2, 0.08],
      ],
      true
    ),
    segments: 96,
  }),
  material: steelPlate,
  group: 'static',
  hero: false,
  info: {
    title: 'Main plate',
    summary:
      'The foundation everything else is jewelled to. It carries the pivot holes for the whole train and ' +
      'takes the shock of every impact, which is why movements are built as a sandwich: plate, train, bridge.',
  },
});

// ── Barrel and mainspring ────────────────────────────────────────────────────
var barrelWheel = geom.gear(80, 0.16, 0.1, 0.55);
scene.mesh({
  id: 'barrel',
  name: 'Mainspring barrel',
  parentId: 'goingTrain',
  geometry: barrelWheel,
  material: goldWheel,
  group: 'rotating',
  hero: false,
  info: {
    title: 'Mainspring barrel',
    summary:
      'A coiled ribbon of steel inside a toothed drum. It is the only energy source in the watch, and it ' +
      'stores about forty turns of torque.',
  },
});

// The ribbon itself: a flat spiral, read as a coil rather than a single wind.
var springPts = [];
for (var si = 0; si <= 96; si++) {
  var st = si / 96;
  var srad = 0.16 + st * 0.36;
  var sang = st * M.TAU * 3.2;
  springPts.push([M.cos(sang) * srad, M.sin(sang) * srad]);
}
var mainspring = geom.extrude({
  profile: geom.profile(springPts, false),
  depth: 0.055,
  direction: [0, 0, 1],
});
scene.mesh({
  id: 'mainspring',
  name: 'Mainspring',
  parentId: 'barrel',
  geometry: mainspring,
  material: springSteel,
  group: 'rotating',
  hero: false,
  info: {
    title: 'Mainspring',
    summary:
      'Wound by turning the crown, it pushes the barrel teeth as it relaxes. A full wind gives roughly ' +
      'forty hours of stored energy.',
  },
});

scene.mesh({
  id: 'crown',
  name: 'Winding crown',
  parentId: 'staticParts',
  geometry: geom.bevel(geom.gear(24, 0.14, 0.22, 0.1), 0.35),
  material: rotorMetal,
  group: 'static',
  hero: false,
  info: {
    title: 'Crown',
    summary: 'The only part of the watch the owner touches. It sets the time and winds the spring.',
  },
});

scene.mesh({
  id: 'stem',
  name: 'Winding stem',
  parentId: 'staticParts',
  geometry: geom.cylinder(1.1, 0.09, 20),
  material: steelLever,
  group: 'static',
  hero: false,
  info: { title: 'Winding stem', summary: 'Carries torque from the crown to the barrel and the hands.' },
});

// ── The going train ──────────────────────────────────────────────────────────
// Barrel drives the centre wheel, which drives the third, then the fourth, then the escape wheel.
// Each step trades speed for torque; the whole train exists to deliver exactly two impulses per
// oscillation to the balance.
function wheel(id, name, teeth, radius, thickness, parentId, groupName, hero, summary) {
  return scene.mesh({
    id: id,
    name: name,
    parentId: parentId,
    geometry: geom.gear(teeth, 0.14, thickness, radius * 0.16),
    material: hero ? goldBright : goldWheel,
    group: groupName,
    hero: hero,
    info: { title: name, summary: summary },
  });
}

wheel(
  'centreWheel',
  'Centre wheel',
  64,
  0.9,
  0.08,
  'goingTrain',
  'rotating',
  false,
  'Turns once an hour. Its pinion carries the minute hand, which is why this wheel is the movement\u2019s time reference.'
);
wheel(
  'thirdWheel',
  'Third wheel',
  60,
  0.66,
  0.07,
  'goingTrain',
  'rotating',
  false,
  'A pure ratio step. It exists only to multiply torque and divide speed toward the escape wheel.'
);
wheel(
  'fourthWheel',
  'Fourth wheel',
  56,
  0.5,
  0.07,
  'goingTrain',
  'rotating',
  false,
  'Turns once a minute and carries the small seconds hand, which is why the seconds hand sweeps rather than ticks.'
);
wheel(
  'escapeWheel',
  'Escape wheel',
  15,
  0.36,
  0.055,
  'escapement',
  'escapement',
  true,
  'The heart of the escapement. It does not turn smoothly — it is released one tooth at a time, so its ' +
    'motion is fifteen discrete steps per revolution. That stepping is what turns continuous spring ' +
    'power into countable beats.'
);

// Pivots: the steel arbors the wheels turn on, visible between the wheels.
scene.mesh({
  id: 'arbors',
  name: 'Train arbors',
  parentId: 'goingTrain',
  geometry: geom.cylinder(0.14, 0.62, 18),
  material: steelLever,
  group: 'rotating',
  hero: false,
  info: { title: 'Arbors', summary: 'The steel axles each wheel turns on, running in jewelled bearings.' },
});

// ── The pallet fork ──────────────────────────────────────────────────────────
scene.mesh({
  id: 'palletFork',
  name: 'Pallet fork',
  parentId: 'escapement',
  geometry: geom.extrude({
    profile: geom.profile(
      [
        [-0.05, -0.34],
        [0.05, -0.34],
        [0.07, 0.02],
        [0.3, 0.26],
        [0.24, 0.36],
        [0.0, 0.16],
        [-0.24, 0.36],
        [-0.3, 0.26],
        [-0.07, 0.02],
      ],
      true
    ),
    depth: 0.05,
    direction: [0, 0, 1],
  }),
  material: steelLever,
  group: 'escapement',
  hero: true,
  info: {
    title: 'Pallet fork',
    summary:
      'A steel lever with two ruby jewels that alternately lock and release the escape wheel. It is the ' +
      'part that turns the balance\u2019s swing into countable ticks.',
  },
});

// The two pallet jewels: the only part of the fork that touches the escape wheel.
var palletJewel = geom.box(0.07, 0.055, 0.075);
scene.instances({
  id: 'palletJewels',
  name: 'Pallet jewels',
  parentId: 'palletFork',
  geometry: palletJewel,
  material: ruby,
  placements: geom.pattern.linear(2, 0.3, { axis: 'y' }),
  group: 'escapement',
  hero: false,
  info: {
    title: 'Pallet jewels',
    summary:
      'Two rubies that the escape wheel tooth slides against. Ruby is used because it takes a polish no ' +
      'steel can hold and because it wears slowly against the wheel.',
  },
});

// ── The balance and hairspring ───────────────────────────────────────────────
var balanceRim = geom.revolve({
  profile: geom.profile([[0.52, -0.045], [0.62, -0.02], [0.62, 0.02], [0.52, 0.045]], true),
  segments: 64,
});
scene.mesh({
  id: 'balanceWheel',
  name: 'Balance wheel',
  parentId: 'escapement',
  geometry: balanceRim,
  material: goldBright,
  group: 'escapement',
  hero: true,
  info: {
    title: 'Balance wheel',
    summary:
      'A weighted wheel on a fine staff that swings back and forth at a near-constant rate. Its inertia ' +
      'and the hairspring\u2019s stiffness together fix the period — and that period is the time the watch keeps.',
  },
});

// Timing screws around the rim. Their real job is to trim inertia; making them visible is the
// whole point of the model.
var timingScrew = geom.cylinder(0.035, 0.07, 12);
scene.instances({
  id: 'timingScrews',
  name: 'Timing screws',
  parentId: 'balanceWheel',
  geometry: timingScrew,
  material: blued,
  placements: geom.pattern.radial(8, 0.62, { axis: 'y', faceOutward: true }),
  group: 'escapement',
  hero: false,
  info: {
    title: 'Timing screws',
    summary:
      'Turning these in or out moves mass in or out, changing the balance\u2019s moment of inertia. A ' +
      'watchmaker uses them to put the watch in beat — a few seconds a day.',
  },
});

scene.mesh({
  id: 'staff',
  name: 'Balance staff',
  parentId: 'balanceWheel',
  geometry: geom.cylinder(0.028, 0.5, 14),
  material: steelLever,
  group: 'escapement',
  hero: false,
  info: { title: 'Staff', summary: 'The pivot the balance turns on, running in two jewels.' },
});

// The hairspring: a flat Archimedean spiral. In a real watch it breathes — coiling tighter on one
// side of the swing and relaxing on the other — which is exactly what makes it a restoring force.
var hairPts = [];
for (var hi = 0; hi <= 120; hi++) {
  var ht = hi / 120;
  var hrad = 0.1 + ht * 0.34;
  var hang = ht * M.TAU * 3.6;
  hairPts.push([M.cos(hang) * hrad, M.sin(hang) * hrad]);
}
var hairspringFlat = geom.extrude({
  profile: geom.profile(hairPts, false),
  depth: 0.012,
  direction: [0, 0, 1],
});
scene.mesh({
  id: 'hairspring',
  name: 'Hairspring',
  parentId: 'escapement',
  geometry: hairspringFlat,
  material: blued,
  group: 'escapement',
  hero: true,
  info: {
    title: 'Hairspring',
    summary:
      'A flat spiral of blued steel, about a third of a millimetre thick. It is the restoring force that ' +
      'pulls the balance back to centre — and it breathes with every swing, coiling tighter one way ' +
      'and opening the other.',
  },
});

scene.mesh({
  id: 'balanceCock',
  name: 'Balance cock',
  parentId: 'staticParts',
  geometry: geom.extrude({
    profile: geom.profile(
      [
        [-0.34, -0.5],
        [0.34, -0.5],
        [0.42, 0.16],
        [0.24, 0.34],
        [-0.24, 0.34],
        [-0.42, 0.16],
      ],
      true
    ),
    depth: 0.07,
    direction: [0, 0, 1],
  }),
  material: steelBridge,
  group: 'static',
  hero: false,
  info: {
    title: 'Balance cock',
    summary:
      'The bridge over the balance. Its top surface is usually the most decorated part of a movement, ' +
      'which tells you a watchmaker it was finished to be looked at.',
  },
});

// ── Jewels and screws ────────────────────────────────────────────────────────
var jewel = geom.revolve({
  profile: geom.profile([[0.045, 0], [0.085, 0.03], [0.085, 0.075], [0.045, 0.06]], true),
  segments: 24,
});
scene.instances({
  id: 'jewels',
  name: 'Ruby bearings',
  parentId: 'staticParts',
  geometry: jewel,
  material: ruby,
  placements: geom.pattern.radial(12, 1.5, { axis: 'y' }),
  group: 'static',
  hero: false,
  info: {
    title: 'Ruby bearings',
    summary:
      'Seventeen to twenty-five synthetic rubies hold every pivot. Hard, smooth and dimensionally stable, ' +
      'they cut friction so the watch needs less power and lasts decades.',
  },
});

var bridgeScrew = geom.bevel(geom.cylinder(0.05, 0.06, 14), 0.4);
scene.instances({
  id: 'bridgeScrews',
  name: 'Bridge screws',
  parentId: 'staticParts',
  geometry: bridgeScrew,
  material: blued,
  placements: geom.pattern.radial(6, 2.0, { axis: 'y' }),
  group: 'static',
  hero: false,
  info: {
    title: 'Blued screws',
    summary:
      'Polished steel heated to about 290 degrees until it turns blue. The colour is a thermal oxide ' +
      'layer, not a coating, and it is why a movement looks finished.',
  },
});

// ── Train bridge ─────────────────────────────────────────────────────────────
scene.mesh({
  id: 'trainBridge',
  name: 'Train bridge',
  parentId: 'staticParts',
  geometry: geom.extrude({
    profile: geom.profile(
      [
        [-0.2, -1.5],
        [1.5, -1.1],
        [2.0, -0.1],
        [1.4, 0.75],
        [-0.2, 0.55],
      ],
      true
    ),
    depth: 0.07,
    direction: [0, 0, 1],
  }),
  material: steelBridge,
  group: 'static',
  hero: false,
  info: {
    title: 'Train bridge',
    summary:
      'Holds the top pivots of the going train. Shaped to follow the wheels it covers — function first, ' +
      'but in a good movement the shape is what makes it beautiful.',
  },
});

// ── The automatic rotor ──────────────────────────────────────────────────────
scene.mesh({
  id: 'rotor',
  name: 'Oscillating weight',
  parentId: 'staticParts',
  geometry: geom.revolve({
    profile: geom.profile([[0.32, -0.16], [2.0, -0.16], [2.0, 0.16], [0.32, 0.16]], true),
    segments: 72,
    angle: M.PI * 1.25,
  }),
  material: rotorMetal,
  group: 'static',
  hero: true,
  info: {
    title: 'Oscillating weight',
    summary:
      'A half-moon of heavy metal on the back that winds the mainspring with the motion of your wrist. It ' +
      'is also the part that makes an automatic recognisable from the back.',
  },
});

scene.mesh({
  id: 'rotorBearing',
  name: 'Rotor bearing',
  parentId: 'rotor',
  geometry: geom.cylinder(0.16, 0.5, 24),
  material: steelLever,
  group: 'static',
  hero: false,
  info: { title: 'Rotor bearing', summary: 'A ball bearing, the only bearing in a watch that is not a jewel.' },
});

// ── Lighting and camera ──────────────────────────────────────────────────────
scene.light({ id: 'key', kind: 'directional', intensity: 2.6, position: [2.4, 3.2, 2.6], castShadow: true });
scene.light({ id: 'rim', kind: 'directional', intensity: 1.1, color: '#8ab4d8', position: [-2.8, 1.2, -2.2] });
scene.light({ id: 'fill', kind: 'hemisphere', intensity: 0.42, color: '#e8ddc8' });
scene.light({
  id: 'jewelSpark',
  kind: 'point',
  color: '#ff8a6b',
  intensity: 2.2,
  position: [0.5, 0.6, 0.5],
  distance: 4,
});

scene.environment({ preset: 'studio', exposure: 0.25, grid: false });

scene.camera({
  position: [2.1, 1.5, 2.4],
  target: [0, 0, 0.1],
  fov: 42,
});

// ── Continuous rotation ──────────────────────────────────────────────────────
// The escape wheel is the only wheel driven here, because its stepping is the point. The rest of the
// train is geared off it through scene.motion rates in the correct inverse ratio, so a viewer can
// check the arithmetic against the tooth counts.
scene.motion({
  id: 'barrelTurn',
  partId: 'barrel',
  kind: 'spin',
  axis: [0, 0, 1],
  rate: { param: 'beatRate', scale: 0.00000042 },
  reason: 'One barrel turn per many hours. It is the slowest wheel in the movement.',
});

scene.motion({
  id: 'trainTurn',
  partId: 'trainBridge',
  kind: 'spin',
  axis: [0, 0, 1],
  rate: { param: 'beatRate', scale: 0 },
  reason: 'The bridge is static; declared so the motion table has a home for the train description.',
});

// ── Per-frame physics ────────────────────────────────────────────────────────
scene.onFrame(function (ctx) {
  var bph = ctx.params.beatRate;
  var inertia = ctx.params.inertia;
  var reserve = ctx.params.powerReserve;

  // Beats per second, and the oscillator's actual frequency.
  var beatsPerSecond = bph / 3600;
  var nominalHz = 28800 / 7200; // 4 Hz
  var actualHz = nominalHz / M.sqrt(inertia);

  // Torque falls off with the square root of remaining wind, which is what a spiral spring does as
  // it relaxes — and that is why the amplitude falls away over the power reserve.
  var torqueFactor = M.sqrt(M.clamp(reserve / 72, 0, 1));
  var amplitude = 270 * torqueFactor / M.sqrt(inertia);

  // Seconds gained or lost per day.
  var rate = (1 / M.sqrt(inertia) - 1) * 86400;

  ctx.metric('beatHz', actualHz);
  ctx.metric('rate', rate);
  ctx.metric('amplitude', amplitude);
  ctx.metric('reserveHours', reserve);

  // ── The balance: a sinusoid at the true frequency, in radians.
  var theta = M.sin(ctx.time * actualHz * M.TAU) * M.rad(amplitude);
  ctx.part('balanceWheel').setRotation(0, 0, theta);

  // The hairspring breathes with the swing: it is drawn as a flat spiral, and rotating it about its
  // own axis by the same angle as the balance is the honest 2D shadow of a real breathing spring.
  ctx.part('hairspring').setRotation(0, 0, theta * 0.32);

  // ── The escapement: a step function, not a sine.
  // One tooth per two beats, so the wheel advances TAU/15 every half oscillation.
  var beats = ctx.time * beatsPerSecond;
  var stepIndex = M.floor(beats / 2);
  var escapeAngle = stepIndex * ((M.TAU / 15) * 0.5);
  ctx.part('escapeWheel').setRotation(0, 0, -escapeAngle);

  // The fork rocks between its two locks, switching on every beat.
  var lockSide = M.floor(beats) % 2 === 0 ? 1 : -1;
  ctx.part('palletFork').setRotation(0, 0, lockSide * 0.26);

  // The train follows the escape wheel through the tooth ratios, so the gear arithmetic is visible.
  // Escape wheel 15 teeth on the fourth wheel's pinion, driven by a 56-tooth wheel.
  var trainAngle = escapeAngle * (15 / 56);
  ctx.part('fourthWheel').setRotation(0, 0, trainAngle);
  ctx.part('thirdWheel').setRotation(0, 0, -trainAngle * (56 / 60));
  ctx.part('centreWheel').setRotation(0, 0, trainAngle * (56 / 60) * (60 / 64));
  ctx.part('barrel').setRotation(0, 0, -trainAngle * (56 / 60) * (60 / 64) * (64 / 80));

  // The rotor is driven by the wrist, not the watch: a slow, lazy swing unrelated to the train.
  ctx.part('rotor').setRotation(ctx.time * 0.42, ctx.time * 0.31, 0);

  // The mainspring tightens visibly as the reserve is spent: it contracts as it unwinds.
  var wind = M.clamp(reserve / 72, 0, 1);
  ctx.part('mainspring').setScale(0.82 + wind * 0.18, 0.82 + wind * 0.18, 1);

  // A run-down spring shows as a dimmer escape wheel — less energy reaching the escapement.
  ctx.part('escapeWheel').setEmissive(0.15 + torqueFactor * 0.5);
});

// ── Story: the causal arc ───────────────────────────────────────────────────
scene.story([
  {
    id: 'stored',
    title: 'Energy is stored',
    narration:
      'Everything a watch does starts here. A flat steel ribbon is coiled inside a drum about forty turns ' +
      'tight, and it pushes the barrel teeth as it tries to relax. That stored torque is the only energy ' +
      'the watch will ever have.',
    targetPartId: 'mainspring',
    setParameters: { powerReserve: 72 },
    holdSeconds: 8,
  },
  {
    id: 'train',
    title: 'The train trades speed for torque',
    narration:
      'The barrel drives four wheels in sequence, each one smaller than the last. Nothing else changes — ' +
      'the whole going train exists to arrive at the escape wheel turning at a useful speed with enough ' +
      'torque left to be useful.',
    targetPartId: 'fourthWheel',
    setParameters: { powerReserve: 48 },
    holdSeconds: 8,
  },
  {
    id: 'escapement',
    title: 'Power arrives in steps',
    narration:
      'Here is the part no drawing can teach. The escape wheel is locked by the pallet fork and released ' +
      'one tooth at a time. It does not rotate — it steps, fifteen times per revolution. The mainspring ' +
      'pushes continuously; the watch receives its power in countable lumps.',
    targetPartId: 'escapeWheel',
    setParameters: { powerReserve: 30 },
    holdSeconds: 9,
  },
  {
    id: 'balance',
    title: 'The balance decides the time',
    narration:
      'Each release pushes the fork, and the fork pushes the balance. The balance swings back against a ' +
      'spiral hairspring, and it will swing at almost the same rate forever — because its period depends ' +
      'on its own inertia and the spring\u2019s stiffness, and nothing else. That is the watch.',
    targetPartId: 'hairspring',
    setParameters: { powerReserve: 20, inertia: 1 },
    holdSeconds: 10,
  },
  {
    id: 'inertia',
    title: 'Mass is the timekeeping',
    narration:
      'Now turn the timing screws in. The balance gets heavier, its natural frequency falls as one over ' +
      'the square root of inertia, and the watch starts running slow. Push the screws back out and it ' +
      'runs fast. This is the whole adjustment a watchmaker makes.',
    targetPartId: 'timingScrews',
    setParameters: { inertia: 1.45 },
    holdSeconds: 10,
  },
  {
    id: 'reserve',
    title: 'A flat spring is an inaccurate spring',
    narration:
      'Drop the power reserve toward empty. The barrel torque falls, so the impulse into the balance ' +
      'weakens and the swing narrows. A smaller swing is a less certain swing, so the rate drifts. A ' +
      'mechanical watch is most accurate in the middle of its reserve, not at either end.',
    targetPartId: 'mainspring',
    setParameters: { powerReserve: 6, inertia: 1 },
    holdSeconds: 10,
  },
]);

// ── Quiz ────────────────────────────────────────────────────────────────────
scene.quiz([
  {
    id: 'q1',
    question: 'The escape wheel rotates at a steady rate. True or false?',
    options: [
      'False — it advances one tooth at a time, in discrete steps',
      'True — the train drives it continuously',
      'True — but the steps are too small to see',
      'False — it only moves while the mainspring is fully wound',
    ],
    correctIndex: 0,
    explanation:
      'It steps. The pallet fork alternately locks and releases the wheel, so torque arrives in fifteen ' +
      'discrete lumps per revolution. That stepping is what turns continuous spring power into beats.',
    difficulty: 'recall',
    evidencePartId: 'escapeWheel',
  },
  {
    id: 'q2',
    question: 'A watchmaker adds mass to the balance to adjust its rate. Which way does it run?',
    options: [
      'Slow — the frequency falls as one over the square root of inertia',
      'Fast — a heavier balance carries more momentum',
      'It runs at the same rate, because the spring is unchanged',
      'It stops, because the train cannot turn it',
    ],
    correctIndex: 0,
    explanation:
      'Slow. The balance and hairspring form a harmonic oscillator, so f = (1/2pi)sqrt(k/I). Increase I ' +
      'and f falls, so each oscillation takes longer and the watch loses time.',
    difficulty: 'application',
    evidencePartId: 'timingScrews',
  },
  {
    id: 'q3',
    question: 'Why is a mechanical watch least accurate when the mainspring is nearly empty?',
    options: [
      'Because low torque gives the balance a small swing, and a small swing is less regular',
      'Because the spring gets physically shorter as it unwinds',
      'Because the train has to move faster to keep the same rate',
      'Because the jewels lose lubrication at low speed',
    ],
    correctIndex: 0,
    explanation:
      'Low barrel torque weakens the impulse into the balance, so its amplitude drops. A watch is most ' +
      'accurate when the swing is healthy, which is why accuracy specifications are quoted mid-reserve.',
    difficulty: 'application',
    evidencePartId: 'mainspring',
  },
  {
    id: 'q4',
    question: 'What is the pallet fork actually for?',
    options: [
      'To alternately lock and release the escape wheel, metering its power',
      'To keep the balance wheel centred',
      'To transfer the mainspring\u2019s torque to the barrel',
      'To hold the train jewels in place',
    ],
    correctIndex: 0,
    explanation:
      'The fork is the metering device. Its two ruby jewels lock the escape wheel on one side and release ' +
      'it to the other, so the mainspring\u2019s continuous push becomes a countable beat.',
    difficulty: 'recall',
    evidencePartId: 'palletFork',
  },
]);

// ── Direct interaction ───────────────────────────────────────────────────────
scene.onSelect(function (partId) {
  console.log('selected part: ' + partId);
});
`;