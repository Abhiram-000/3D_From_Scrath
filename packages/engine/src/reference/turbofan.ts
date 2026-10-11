/**
 * The reference model: a hand-authored program written against the same API the AI receives.
 *
 * It exists for four reasons, and each one is load-bearing:
 *
 *  1. **It proves the API is usable before any AI is involved.** If a human cannot express a turbine in this
 *     surface, no prompt will fix that. `00-GOAL.md` makes the scene API "the product", and this is the first
 *     honest test of it.
 *  2. **It is the on-disk fallback model** the viewer loads when no AI key is configured, so the platform is
 *     explorable in a degraded deployment (`04`: "the gallery and viewer keep working entirely").
 *  3. **It is the few-shot exemplar** the generation prompt is built from, which is why it is written in the
 *     style the prompt asks for rather than in the shortest way that works.
 *  4. **It is the fixture** for the realizer, physics, viewer and audit test suites — one model that exercises
 *     every mechanism, so a regression anywhere shows up somewhere.
 *
 * The subject is a two-spool turbofan because it forces the whole surface at once: swept airfoils (not boxes),
 * involute gears in the accessory drive, a true helical spring, an instanced blade array that must be one draw
 * call, an SDF-blended nacelle fairing, a raw computed mesh, parameters that visibly change motion, and a story
 * that walks the causal chain from intake to thrust.
 *
 * Exported as a source *string* rather than as a function: it must travel through the same gate, instrumentation
 * and sandbox as generated code. A fixture that bypassed the boundary would prove nothing about the boundary.
 */

export const REFERENCE_MODEL_SOURCE = String.raw`
// A two-spool turbofan. Units are metres, radians and seconds throughout.

scene.describe({
  name: 'Two-spool turbofan',
  description:
    'A cutaway turbofan showing how a single shaft system turns fuel into thrust: the fan pulls air in, the ' +
    'compressor squeezes it, combustion adds energy, and the turbine takes back just enough to drive the ' +
    'compressor while the rest leaves as thrust.',
  domain: 'mechanics',
  subdomain: 'propulsion',
  concept: 'A gas turbine converts chemical energy to kinetic energy through a continuous Brayton cycle.',
  objectives: [
    'Trace the air path from intake through fan, compressor, combustor, turbine and nozzle',
    'Explain why the turbine and compressor must share a shaft',
    'Predict what happens to thrust when spool speed or bypass ratio changes',
    'Identify why most thrust in a modern engine comes from bypass air, not the core',
  ],
  level: 'undergraduate',
  principles: [
    'Newton third law: thrust is the reaction to accelerated mass flow',
    'Brayton cycle: compress, heat at constant pressure, expand',
    'Conservation of angular momentum across a shared spool',
  ],
  simplifications: [
    'Blade counts are reduced from production values so individual blades stay visible',
    'The combustor flame is shown as a single emissive volume rather than a resolved flame front',
  ],
  relationships: [
    { from: 'fan', to: 'bypassDuct', kind: 'drives airflow', note: 'most thrust comes from here' },
    { from: 'compressor', to: 'combustor', kind: 'feeds pressurised air' },
    { from: 'combustor', to: 'turbine', kind: 'drives with hot gas' },
    { from: 'turbine', to: 'compressor', kind: 'powers via shared shaft' },
  ],
});

// Colour roles: the semantic system the learner learns to read.
scene.colorRole({ id: 'coldAir', label: 'Cold air', color: '#5b93c9', meaning: 'Air before combustion' });
scene.colorRole({ id: 'hotGas', label: 'Hot gas', color: '#d95c4a', meaning: 'Air after combustion' });
scene.colorRole({ id: 'rotating', label: 'Rotating', color: '#c8a04f', meaning: 'Parts on the spool' });
scene.colorRole({ id: 'static', label: 'Static', color: '#8a8f96', meaning: 'Casing and stators' });
scene.colorRole({ id: 'fuel', label: 'Fuel', color: '#7bbf6a', meaning: 'Fuel system' });

// Parameters. Each one must visibly change the model, not merely move a slider.
scene.param({
  id: 'spoolRpm',
  kind: 'number',
  label: 'Spool speed',
  unit: 'rpm',
  min: 0,
  max: 12000,
  default: 4800,
  precision: 0,
  description: 'Rotational speed of the shared shaft. Drives fan, compressor and turbine together.',
  affects: [{ channel: 'motionRate' }, { channel: 'metric' }],
});

scene.param({
  id: 'fuelFlow',
  kind: 'number',
  label: 'Fuel flow',
  unit: 'kg/s',
  min: 0,
  max: 1.4,
  default: 0.55,
  precision: 2,
  description: 'Fuel into the combustor. Raises turbine inlet temperature and flame brightness.',
  affects: [{ channel: 'material' }, { channel: 'metric' }],
});

scene.param({
  id: 'bypassRatio',
  kind: 'number',
  label: 'Bypass ratio',
  min: 1,
  max: 12,
  default: 8,
  precision: 1,
  description: 'Mass of bypass air per unit of core air. Higher is quieter and more efficient at cruise.',
  affects: [{ channel: 'metric' }, { channel: 'transform' }],
});

scene.param({
  id: 'cutaway',
  kind: 'boolean',
  label: 'Cutaway view',
  default: true,
  description: 'Hide the outer half of the nacelle so the core is visible.',
  affects: [{ channel: 'visibility' }],
});

// Derived read-outs. Values are published by this model's own frame code, so the numbers and the motion
// cannot disagree.
scene.metric({ id: 'thrust', label: 'Thrust', unit: 'kN', precision: 1, formula: 'F = m_dot x delta_v' });
scene.metric({ id: 'tipSpeed', label: 'Fan tip speed', unit: 'm/s', precision: 0, formula: 'v = omega x r' });
scene.metric({ id: 'turbineTemp', label: 'Turbine inlet', unit: 'K', precision: 0 });

// ── Materials ────────────────────────────────────────────────────────────────
var steel = mat.metal({ role: 'rotating', roughness: 0.22 });
var casing = mat.metal({ role: 'static', roughness: 0.4 });
var nacelleSkin = mat.metal({ color: '#cfd4d9', roughness: 0.18 });
var coldFlow = mat.translucent({ role: 'coldAir', opacity: 0.22 });
var hotFlow = mat.emissive({ role: 'hotGas', emissiveIntensity: 2.2, boundTo: 'fuelFlow' });
var flame = mat.emissive({ color: '#ffb457', emissiveIntensity: 3.5, boundTo: 'fuelFlow' });
var fuelLine = mat.plastic({ role: 'fuel', roughness: 0.55 });
var glassShell = mat.glass({ color: '#cfe6f2', transmission: 0.94 });

// ── Structure ────────────────────────────────────────────────────────────────
scene.group({ id: 'engine', name: 'Turbofan' });
scene.group({ id: 'spool', name: 'Rotating assembly', parentId: 'engine', group: 'rotating' });
scene.group({ id: 'staticStructure', name: 'Casing and stators', parentId: 'engine', group: 'static' });
scene.group({ id: 'core', name: 'Core flow path', parentId: 'engine', group: 'core' });

// The shaft: a plain revolve, but the part every other rotating part hangs from.
var shaftProfile = geom.profile([[0.06, -1.5], [0.06, 1.5]], false);
scene.mesh({
  id: 'shaft',
  name: 'Main shaft',
  parentId: 'spool',
  geometry: geom.revolve({ profile: shaftProfile, segments: 24 }),
  material: steel,
  group: 'rotating',
  hero: false,
  info: {
    title: 'Main shaft',
    summary:
      'The turbine and compressor are bolted to the same shaft, so the turbine cannot spin without driving ' +
      'the compressor. That coupling is what makes the cycle self-sustaining once it is lit.',
    bullets: [
      'Carries torque from turbine to compressor',
      'Rides on bearings held by the static structure',
      'Both ends must turn at exactly the same speed',
    ],
    facts: [
      { label: 'Diameter', value: '120 mm' },
      { label: 'Material', value: 'Nickel alloy' },
    ],
  },
});

// ── The fan: a swept airfoil, instanced ──────────────────────────────────────
// A blade must be a swept airfoil section, not a curved box: a box does not read as a blade the moment it
// spins, and it cannot show twist.
var fanRoot = geom.airfoilProfile({ chord: 0.42, thickness: 0.11, camber: 0.03 });
var fanSpan = geom.path([[0, 0, 0], [0.05, 0.42, 0], [0.08, 0.85, 0], [0.06, 1.18, 0]]);
var fanBlade = geom.sweep({ profile: fanRoot, path: fanSpan, twist: -0.62, endScale: 0.55 });

scene.mesh({
  id: 'fanHub',
  name: 'Fan hub',
  parentId: 'spool',
  position: [0, 0, -1.25],
  geometry: geom.revolve({
    profile: geom.profile([[0.08, -0.12], [0.34, -0.1], [0.36, 0.1], [0.1, 0.14]], true),
    segments: 32,
  }),
  material: steel,
  group: 'rotating',
});

// 22 blades, one draw call. Authored as 22 meshes this would cost 22 draw calls.
scene.instances({
  id: 'fanBlades',
  name: 'Fan blades',
  parentId: 'fanHub',
  geometry: fanBlade,
  material: steel,
  placements: geom.pattern.radial(22, 0.34, {
    axis: 'z',
    faceOutward: true,
    label: function (index) {
      return 'Fan blade ' + (index + 1);
    },
  }),
  group: 'rotating',
  hero: true,
  info: {
    title: 'Fan blades',
    summary:
      'The fan is the biggest thrust producer in a high-bypass engine: most of the air it moves never enters ' +
      'the core. Each blade is twisted along its span so every radius meets the airflow at a working angle.',
    bullets: [
      'Produces roughly 80% of total thrust at cruise',
      'Twisted because tip speed is far higher than root speed',
      'Swept forward at the tip to delay shock formation',
    ],
    facts: [
      { label: 'Blades', value: '22' },
      { label: 'Tip diameter', value: '3.0 m' },
    ],
  },
});

// ── Compressor: repeated stages from one component definition ────────────────
// This is how 300-part ambition stays affordable: a few parameterised definitions, not 300 blocks.
scene.defineComponent('compressorStage', function (ctx) {
  var stageRadius = ctx.params.radius;
  var bladeCount = ctx.params.blades;
  var stageNumber = ctx.params.stage;

  ctx.mesh({
    id: 'disc',
    name: 'Stage ' + stageNumber + ' disc',
    geometry: geom.revolve({
      profile: geom.profile(
        [[0.07, -0.02], [stageRadius * 0.9, -0.015], [stageRadius * 0.9, 0.015], [0.07, 0.02]],
        true,
      ),
      segments: 28,
    }),
    material: steel,
    group: 'rotating',
    info: {
      title: 'Compressor stage ' + stageNumber + ' disc',
      summary:
        'Carries this stage of blades and transmits their torque into the shaft. Each disc downstream is ' +
        'smaller than the last, because compressed air needs less room for the same mass flow.',
      facts: [
        { label: 'Tip radius', value: (stageRadius * 100).toFixed(0) + ' cm' },
        { label: 'Blades', value: String(bladeCount) },
      ],
    },
  });

  var vane = geom.extrude({
    profile: geom.airfoilProfile({ chord: stageRadius * 0.5, thickness: 0.14 }),
    depth: 0.03,
    twist: 0.3,
  });

  ctx.instances({
    id: 'blades',
    name: 'Stage ' + stageNumber + ' blades',
    geometry: vane,
    material: steel,
    placements: geom.pattern.radial(bladeCount, stageRadius * 0.7, { axis: 'z', faceOutward: true }),
    group: 'rotating',
    info: {
      title: 'Compressor stage ' + stageNumber + ' blades',
      summary:
        'Each stage adds a modest pressure rise; seven of them multiply to roughly thirty atmospheres. ' +
        'Blades are twisted because tip and root meet the airflow at different speeds.',
    },
  });
});

for (var stage = 0; stage < 7; stage++) {
  // Compressor stages shrink toward the rear: the same mass flow at rising pressure needs less area.
  var taper = 1 - stage * 0.075;
  scene.place('compressorStage', {
    id: 'compressorStage' + stage,
    parentId: 'spool',
    position: [0, 0, -0.75 + stage * 0.16],
    params: { radius: 0.42 * taper, blades: 18 + stage * 2, stage: stage + 1 },
  });
}

// ── Stator rings: identical by design, so the geometry cache earns its keep ──
// Real compressors reuse one stator design between several stages. Building the same geometry with the same
// arguments seven times costs one build and six cache hits, which is the mechanism that makes a 300-part
// assembly affordable rather than merely possible.
scene.defineComponent('statorRing', function (ctx) {
  var vane = geom.extrude({
    profile: geom.airfoilProfile({ chord: 0.14, thickness: 0.16, camber: 0.05 }),
    depth: 0.022,
    twist: -0.25,
  });

  ctx.instances({
    id: 'vanes',
    name: 'Stator vanes',
    geometry: vane,
    material: casing,
    placements: geom.pattern.radial(26, 0.3, { axis: 'z', faceOutward: true }),
    group: 'static',
    info: {
      title: 'Stator vanes',
      summary:
        'Fixed vanes between rotating stages. They straighten the swirl the rotor imparted, so the next stage ' +
        'meets the air head-on instead of at an angle. Identical between stages, which is why one design is ' +
        'built once and placed many times.',
    },
  });
});

for (var ring = 0; ring < 6; ring++) {
  scene.place('statorRing', {
    id: 'stator' + ring,
    parentId: 'staticStructure',
    position: [0, 0, -0.67 + ring * 0.16],
  });
}

// ── Combustor: an SDF-blended annulus with a flame inside ────────────────────
// The blend is the point: a hard boolean union would leave a crease where the liner meets the dome, which
// reads as two shapes stuck together rather than one moulded part.
var linerOuter = geom.field.cylinder(0.36, 0.26, 'z');
var linerInner = geom.field.cylinder(0.22, 0.3, 'z');
var domeBulge = geom.field.translate(geom.field.sphere(0.2), 0, 0, -0.24);
var combustorField = geom.field.smoothUnion(
  geom.field.subtract(linerOuter, linerInner),
  geom.field.shell(domeBulge, 0.05),
  0.06,
);

scene.mesh({
  id: 'combustor',
  name: 'Combustor liner',
  parentId: 'staticStructure',
  position: [0, 0, 0.55],
  geometry: geom.sdf({
    field: combustorField,
    bounds: { min: [-0.45, -0.45, -0.45], max: [0.45, 0.45, 0.4] },
    resolution: 52,
  }),
  material: casing,
  group: 'static',
  hero: true,
  info: {
    title: 'Combustor',
    summary:
      'Fuel is sprayed into compressed air and burned at roughly constant pressure. The liner keeps the flame ' +
      'away from the metal by holding a film of cooler air against the wall.',
    bullets: [
      'Adds energy without adding pressure',
      'Runs hotter than the melting point of its own metal',
      'Cooled by a film of bypass air along the liner',
    ],
    facts: [
      { label: 'Peak gas temp', value: '~1900 K' },
      { label: 'Pressure', value: '~30 bar' },
    ],
  },
});

scene.mesh({
  id: 'flameVolume',
  name: 'Flame',
  parentId: 'core',
  position: [0, 0, 0.55],
  geometry: geom.revolve({
    profile: geom.profile([[0.02, -0.2], [0.2, -0.05], [0.19, 0.12], [0.03, 0.24]], true),
    segments: 24,
  }),
  material: flame,
  group: 'core',
  info: {
    title: 'Flame front',
    summary: 'Brightness here tracks fuel flow. More fuel means a hotter, brighter flame and a hotter turbine.',
  },
});

// ── Turbine: the stage that pays for the compressor ─────────────────────────
scene.mesh({
  id: 'turbineDisc',
  name: 'Turbine disc',
  parentId: 'spool',
  position: [0, 0, 1.0],
  geometry: geom.revolve({
    profile: geom.profile([[0.07, -0.03], [0.3, -0.02], [0.3, 0.02], [0.07, 0.03]], true),
    segments: 28,
  }),
  material: steel,
  group: 'rotating',
});

var turbineBlade = geom.sweep({
  profile: geom.airfoilProfile({ chord: 0.16, thickness: 0.18, camber: 0.06 }),
  path: geom.path([[0, 0, 0], [0.01, 0.1, 0], [0.02, 0.19, 0]]),
  twist: 0.5,
});

scene.instances({
  id: 'turbineBlades',
  name: 'Turbine blades',
  parentId: 'turbineDisc',
  geometry: turbineBlade,
  material: steel,
  placements: geom.pattern.radial(38, 0.3, { axis: 'z', faceOutward: true }),
  group: 'rotating',
  hero: true,
  info: {
    title: 'Turbine blades',
    summary:
      'Hot gas pushes these blades round, and they drive the compressor through the shaft. The engine only ' +
      'produces thrust with what is left over after the compressor is paid.',
    bullets: [
      'Extracts just enough energy to run the compressor',
      'Cooled internally because gas is hotter than the alloy melting point',
      'Highly cambered to turn the flow sharply',
    ],
  },
});

// ── Accessory drive: involute gears ─────────────────────────────────────────
// Trapezoid teeth would visibly slip the moment the train turns, which is exactly when a learner is watching.
scene.mesh({
  id: 'driveGear',
  name: 'Accessory drive gear',
  parentId: 'spool',
  position: [0, 0, -0.95],
  geometry: geom.gear({ teeth: 24, module: 0.012, thickness: 0.03, bore: 0.06 }),
  material: steel,
  group: 'rotating',
  info: {
    title: 'Accessory drive',
    summary: 'Taps shaft power to run the fuel pump, oil pump and generator.',
  },
});

scene.mesh({
  id: 'pumpGear',
  name: 'Fuel pump gear',
  parentId: 'staticStructure',
  position: [0.32, 0, -0.95],
  geometry: geom.gear({ teeth: 12, module: 0.012, thickness: 0.03, bore: 0.03 }),
  material: casing,
  group: 'static',
});

// ── Fuel line: a swept pipe with a real bore, and a helical spring ───────────
var fuelPath = geom.splinePath(
  [[0.34, 0.02, -0.9], [0.4, 0.18, -0.4], [0.34, 0.24, 0.1], [0.22, 0.2, 0.5]],
  10,
);
scene.path({ id: 'fuelRoute', path: fuelPath, visible: false });

scene.mesh({
  id: 'fuelLine',
  name: 'Fuel line',
  parentId: 'staticStructure',
  geometry: geom.pipe({ path: fuelPath, radius: 0.022, innerRadius: 0.016, segments: 14 }),
  material: fuelLine,
  group: 'static',
  info: {
    title: 'Fuel line',
    summary: 'Carries metered fuel from the pump to the combustor injectors. Hollow, so a cutaway shows a wall.',
  },
});

// A true helical sweep, so pitch is a real dimension rather than a picture of a spring.
scene.mesh({
  id: 'governorSpring',
  name: 'Governor spring',
  parentId: 'staticStructure',
  position: [0.42, 0.06, -0.72],
  geometry: geom.helix({ radius: 0.035, wireRadius: 0.006, turns: 7, pitch: 0.018 }),
  material: steel,
  group: 'static',
  info: {
    title: 'Governor spring',
    summary: 'Balances fuel-pump pressure against spool speed. Compresses as demand rises.',
  },
});

// ── Nacelle: half hidden in cutaway mode ────────────────────────────────────
var nacelleProfile = geom.splineProfile(
  [[0.62, -1.5], [0.86, -1.1], [0.92, -0.2], [0.86, 0.9], [0.68, 1.45]],
  10,
);

scene.mesh({
  id: 'nacelle',
  name: 'Nacelle',
  parentId: 'staticStructure',
  geometry: geom.revolve({ profile: nacelleProfile, angle: M.PI, segments: 40, caps: true }),
  material: nacelleSkin,
  group: 'static',
  info: {
    title: 'Nacelle',
    summary:
      'The aerodynamic housing. Half of it is hidden here so the core is visible; the bypass air flows between ' +
      'it and the core casing.',
  },
});

scene.mesh({
  id: 'nacelleFull',
  name: 'Nacelle (closed)',
  parentId: 'staticStructure',
  visible: false,
  geometry: geom.revolve({ profile: nacelleProfile, segments: 40 }),
  material: glassShell,
  group: 'static',
});

// ── Bypass flow: a raw computed mesh ────────────────────────────────────────
// The escape hatch, used deliberately: a ribbon whose vertices this program computed itself, proving that
// anything expressible as triangles is expressible in this API.
var ribbonPositions = [];
var ribbonIndices = [];
var ribbonSteps = 48;
for (var i = 0; i <= ribbonSteps; i++) {
  var t = i / ribbonSteps;
  var z = -1.4 + t * 2.9;
  // The duct narrows through the middle, so the ribbon follows the annulus rather than a straight tube.
  var r = 0.52 + M.sin(t * M.PI) * 0.07;
  var wobble = M.sin(t * M.PI * 4) * 0.01;
  ribbonPositions.push(r + wobble, -0.04, z);
  ribbonPositions.push(r + wobble, 0.04, z);
  if (i < ribbonSteps) {
    var base = i * 2;
    ribbonIndices.push(base, base + 1, base + 3, base, base + 3, base + 2);
  }
}

scene.mesh({
  id: 'bypassRibbon',
  name: 'Bypass airflow',
  parentId: 'core',
  geometry: geom.mesh({ positions: ribbonPositions, indices: ribbonIndices }),
  material: coldFlow,
  group: 'core',
  selectable: true,
  info: {
    title: 'Bypass airflow',
    summary:
      'Air that goes around the core rather than through it. In a high-bypass engine this is most of the ' +
      'thrust, and it is why modern engines are quieter than early jets.',
  },
});

// A hot exhaust cone, so the core flow is visible too.
scene.mesh({
  id: 'exhaustPlume',
  name: 'Core exhaust',
  parentId: 'core',
  position: [0, 0, 1.5],
  geometry: geom.cone({ radius: 0.26, height: 0.9, segments: 28 }),
  material: hotFlow,
  group: 'core',
  info: {
    title: 'Core exhaust',
    summary: 'What is left after the turbine has taken its share. Hot, fast, and a minority of total thrust.',
  },
});

// ── Lighting and framing ────────────────────────────────────────────────────
scene.light({ id: 'key', kind: 'directional', intensity: 2.4, position: [3, 4, 2], castShadow: true });
scene.light({ id: 'fill', kind: 'hemisphere', intensity: 0.5, color: '#cfe6f2' });
scene.light({
  id: 'combustorGlow',
  kind: 'point',
  color: '#ff9a3c',
  intensity: 6,
  position: [0, 0, 0.55],
  distance: 3,
  boundTo: 'fuelFlow',
});

scene.environment({ preset: 'studio', exposure: 0.2, grid: false });

// The opening frame is authored: a three-quarter view that shows the whole air path at once.
scene.camera({
  position: [3.4, 1.5, 3.2],
  target: [0, 0, 0.1],
  fov: 42,
  limits: { minDistance: 1.4, maxDistance: 12, autoRotate: true, autoRotateSpeed: 0.25 },
});

scene.shot('intake', { kind: 'flyTo', targetPartId: 'fanBlades', duration: 1.6, margin: 1.5 });
scene.shot('combustorShot', { kind: 'flyTo', targetPartId: 'combustor', duration: 1.4, margin: 1.6 });

// ── Motion ──────────────────────────────────────────────────────────────────
// Declared so it is auditable: rate comes from a parameter, not a constant.
scene.motion({
  id: 'spoolSpin',
  partId: 'spool',
  kind: 'spin',
  axis: [0, 0, 1],
  rate: { param: 'spoolRpm', scale: 0.000105 },
  reason: 'The whole rotating assembly turns as one because it shares a shaft.',
});

scene.motion({
  id: 'pumpSpin',
  partId: 'pumpGear',
  kind: 'spin',
  axis: [0, 0, 1],
  // Twice the shaft rate and reversed: a 24-tooth gear driving a 12-tooth gear doubles the speed and flips
  // the direction. Getting this wrong is exactly the visible error an involute profile exposes.
  rate: { param: 'spoolRpm', scale: -0.00021 },
  reason: 'Driven by the accessory gear at a 2:1 ratio.',
});

// ── Per-frame logic ─────────────────────────────────────────────────────────
scene.onFrame(function (ctx) {
  var rpm = ctx.params.spoolRpm;
  var fuel = ctx.params.fuelFlow;
  var bypass = ctx.params.bypassRatio;

  var omega = (rpm * M.TAU) / 60;
  var fanTipRadius = 1.5;
  var tipSpeed = omega * fanTipRadius;

  // A deliberately simple thrust model, but one whose inputs are the real parameters, so the number on screen
  // and the motion on screen come from the same source.
  var coreFlow = 0.02 * rpm * 0.001 + fuel * 12;
  var bypassFlow = coreFlow * bypass;
  var exitVelocity = 180 + fuel * 260;
  var thrust = ((coreFlow + bypassFlow) * exitVelocity) / 1000;

  ctx.metric('thrust', thrust);
  ctx.metric('tipSpeed', tipSpeed);
  ctx.metric('turbineTemp', 288 + fuel * 1250 + rpm * 0.02);

  // The flame brightens with fuel, and the exhaust cone stretches with it — the phenomenon demonstrating itself.
  var flamePart = ctx.part('flameVolume');
  flamePart.setEmissive(1.2 + fuel * 4.5);
  flamePart.setScale(1, 1, 0.8 + fuel * 0.9);

  var plume = ctx.part('exhaustPlume');
  plume.setEmissive(0.6 + fuel * 3);
  plume.setScale(1, 1, 0.7 + fuel * 1.2);

  // Bypass ribbon widens with bypass ratio, so the parameter has a visible geometric consequence.
  ctx.part('bypassRibbon').setScale(1 + (bypass - 6) * 0.04, 1, 1);

  // A subtle flicker, scaled by fuel so an idling engine is steady and a hot one is turbulent.
  var flicker = 1 + M.sin(ctx.time * 26) * 0.04 * fuel;
  ctx.part('flameVolume').setScale(flicker, flicker, 0.8 + fuel * 0.9);

  // Cutaway: swap the two nacelle halves rather than re-mesh a live boolean — visibility is
  // instant. Declared-then-reacted (the frame reads the parameter, so the change lands on the
  // next frame even on a paused model, and the audit's sweep observes the visibility channel).
  var cut = ctx.params.cutaway === true;
  ctx.part('nacelle').setVisible(cut);
  ctx.part('nacelleFull').setVisible(!cut);
});

// ── Story: the causal arc ───────────────────────────────────────────────────
scene.story([
  {
    id: 'intake',
    title: 'Air comes in',
    narration:
      'The fan pulls in far more air than the core can use. Most of it will bypass the engine entirely, and ' +
      'that bypass air is where most of the thrust comes from.',
    targetPartId: 'fanBlades',
    setParameters: { spoolRpm: 3000, fuelFlow: 0.2 },
    holdSeconds: 7,
  },
  {
    id: 'squeeze',
    title: 'Pressure builds',
    narration:
      'Seven compressor stages squeeze the core air. Each stage is smaller than the last, because the same ' +
      'mass of air takes less room once it is compressed.',
    targetPartId: 'compressorStage3',
    setParameters: { spoolRpm: 6500 },
    holdSeconds: 7,
  },
  {
    id: 'burn',
    title: 'Energy added',
    narration:
      'Fuel burns in the compressed air at almost constant pressure. Watch the flame brighten as fuel flow ' +
      'rises: this is the only place energy enters the cycle.',
    targetPartId: 'combustor',
    setParameters: { fuelFlow: 1.1 },
    viewMode: 'xray',
    holdSeconds: 8,
  },
  {
    id: 'extract',
    title: 'The turbine takes its share',
    narration:
      'Hot gas drives the turbine, which drives the compressor through the shaft. The engine keeps only what ' +
      'is left after paying the compressor.',
    targetPartId: 'turbineBlades',
    holdSeconds: 7,
  },
  {
    id: 'thrust',
    title: 'Thrust leaves the back',
    narration:
      'Bypass air and core exhaust both leave faster than they arrived. That change in momentum is the thrust. ' +
      'Raise the bypass ratio and watch thrust rise without more fuel.',
    targetPartId: 'exhaustPlume',
    setParameters: { spoolRpm: 9500, bypassRatio: 11 },
    holdSeconds: 8,
  },
]);

// ── Quiz: distractors built from real misconceptions ────────────────────────
scene.quiz([
  {
    id: 'q1',
    question: 'In a modern high-bypass turbofan, where does most of the thrust come from?',
    options: [
      'The bypass air pushed by the fan',
      'The hot core exhaust leaving the nozzle',
      'The combustor pressure pushing forward on the liner',
      'The compressor pushing air backwards',
    ],
    correctIndex: 0,
    explanation:
      'Most thrust comes from bypass air. The hot core exhaust is a tempting answer because it is the fastest ' +
      'flow, but it is a small fraction of the mass — and thrust depends on mass flow as much as velocity.',
    difficulty: 'application',
    evidencePartId: 'bypassRibbon',
  },
  {
    id: 'q2',
    question: 'Why must the turbine and compressor share a shaft?',
    options: [
      'The turbine extracts energy to drive the compressor',
      'It keeps the engine balanced against vibration',
      'It lets exhaust gas flow back into the compressor',
      'The shaft cools both components',
    ],
    correctIndex: 0,
    explanation:
      'The compressor needs continuous power, and the turbine is where that power comes from. Balance is a real ' +
      'design concern, but it is not why they are coupled.',
    difficulty: 'recall',
    evidencePartId: 'shaft',
  },
  {
    id: 'q3',
    question: 'You raise fuel flow while holding spool speed constant. What happens?',
    options: [
      'Turbine inlet temperature rises and thrust increases',
      'Nothing changes, because thrust depends only on rpm',
      'Thrust falls, because burning more fuel wastes energy',
      'The compressor stalls immediately',
    ],
    correctIndex: 0,
    explanation:
      'More fuel means hotter, faster-expanding gas and more thrust. Assuming rpm alone sets thrust is the ' +
      'common misconception — try it: hold the spool slider and move the fuel slider.',
    difficulty: 'synthesis',
    evidencePartId: 'flameVolume',
  },
]);
`;

/**
 * A deliberately small model, for tests that need a valid manifest without a 400-part build.
 *
 * Kept separate rather than trimming the turbofan per-test, because the turbofan's value is that it exercises
 * *everything* — shrinking it for convenience would quietly reduce what the suite covers.
 */
export const MINIMAL_MODEL_SOURCE = String.raw`
scene.describe({
  name: 'Simple pendulum',
  description: 'A mass on a rigid rod, swinging under gravity.',
  domain: 'mechanics',
  concept: 'The period of a simple pendulum depends on its length, not its mass.',
  objectives: ['Predict how period changes with length'],
});

scene.param({
  id: 'length',
  kind: 'number',
  label: 'Rod length',
  unit: 'm',
  min: 0.2,
  max: 2,
  default: 1,
  affects: [{ channel: 'transform' }, { channel: 'metric' }],
});

scene.metric({ id: 'period', label: 'Period', unit: 's', precision: 2, formula: 'T = 2*pi*sqrt(L/g)' });

var brass = mat.metal({ color: '#c8a04f' });
var rodMaterial = mat.metal({ color: '#9aa0a6', roughness: 0.5 });

scene.group({ id: 'pendulum', name: 'Pendulum' });

scene.mesh({
  id: 'rod',
  name: 'Rod',
  parentId: 'pendulum',
  geometry: geom.cylinder({ radius: 0.01, height: 1, segments: 12 }),
  material: rodMaterial,
  info: { title: 'Rod', summary: 'Rigid and effectively massless, so only its length matters.' },
});

scene.mesh({
  id: 'bob',
  name: 'Bob',
  parentId: 'pendulum',
  position: [0, -0.5, 0],
  geometry: geom.sphere({ radius: 0.06, segments: 24 }),
  material: brass,
  hero: true,
  info: { title: 'Bob', summary: 'The mass. Changing it does not change the period, which surprises most people.' },
});

scene.camera({ position: [2, 0.4, 2.2], target: [0, -0.4, 0], fov: 45 });
scene.light({ id: 'key', kind: 'directional', intensity: 2.2, position: [2, 3, 2] });

scene.onFrame(function (ctx) {
  var length = ctx.params.length;
  var omega = M.sqrt(M.GRAVITY / length);
  var angle = 0.35 * M.sin(ctx.time * omega);

  ctx.part('pendulum').setRotation(0, 0, angle);
  ctx.part('rod').setScale(1, length, 1);
  ctx.part('rod').setPosition(0, -length / 2, 0);
  ctx.part('bob').setPosition(0, -length, 0);
  ctx.metric('period', (2 * M.PI) / omega);
});
`;
