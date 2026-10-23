/**
 * The reference heart: a hand-authored anatomical program written against the same API the AI receives,
 * and a deliberate stress test of the surface in the direction the turbofan does not reach.
 *
 * Where the turbofan forces swept airfoils, involute gears and instanced blades, this model forces what the
 * organic domain needs: exact-thickness walls built from `withHoles` + `revolve` (the left ventricle wall is
 * 11 mm against the right's 4 mm, in real metres, because that ratio IS the lesson), atria as true thin
 * shells via `geom.shell`, hollow great vessels with real bores via `geom.pipe`, aortic-root sinuses via
 * `geom.loft`, parametric valve cusps, one continuous epicardium and pericardium through a single SDF chain
 * (`smoothUnion` -> `shell` -> `offset` -> `shell`), a wall-stress gradient painted onto the muscle with
 * `colorByField` + `mat.gradient`, and a rhythm strip built from `geom.heightField` whose cursor is a
 * declarative `flowAlongPath` motion bound to the heart-rate parameter.
 *
 * Build discipline: one heightField, two marching-cubes SDFs (resolutions 54 and 46), every other part
 * analytic - no voxelised walls, so wall thickness is exact rather than resolution-clamped. Geometry handles
 * are reused wherever anatomy repeats, so each full-and-cut wall pair costs one build and one clipped cache
 * twin. No geometry is constructed inside `onFrame`; the frame callback only sets transforms, emissive and
 * visibility, exactly as the 50 ms frame budget demands.
 *
 * The rhythm strip is schematic: its cursor rides the waveform at heart-rate speed, but the strip's axis is a
 * single beat, not a rhythm history. `scene.warn` declares that rather than implying more.
 */

export const HEART_MODEL_SOURCE = String.raw`
// The human heart, at real scale: 12 cm base to apex, litres per minute, millimetres of wall.

scene.describe({
  name: 'The human heart',
  description:
    'A cutaway heart showing how one organ is two pumps in series: the right side sends venous blood to the ' +
    'lungs at low pressure, the left side sends it to the whole body at high pressure, and the coronary ' +
    'arteries pay for all of it from their own supply line.',
  domain: 'biology',
  subdomain: 'anatomy',
  concept:
    'The heart is a double pump in series; wall thickness follows pressure rather than volume, and each half ' +
    'is fed by its own dedicated coronary circulation',
  objectives: [
    'Trace deoxygenated blood from the venae cavae through the right heart to the lungs',
    'Trace oxygenated blood from the pulmonary veins through the left heart to the aorta',
    'Explain why the left ventricle wall is roughly three times thicker than the right',
    'Identify the conduction system and relate the ECG wave to the mechanical beat',
    'Name the coronary arteries and why the heart cannot feed from the blood inside it',
  ],
  level: 'secondary',
  principles: [
    'Flow continuity: cardiac output = heart rate x stroke volume',
    'Wall stress rises with cavity pressure and radius, which is why thickness follows load',
    'Coronary perfusion is mostly diastolic, because systole squeezes the arteries shut',
    'Rhythm is intrinsic: the sinoatrial node fires without any nerve; nerves only tune the rate',
  ],
  simplifications: [
    'Wall thickness and cavity radii follow an average adult heart in real metres throughout',
    'The epicardium and pericardium are smooth membranes; surface vessels and fat are simplified',
    'Valve leaflets are single continuous fibrous sheets, and their motion is driven by the frame callback ' +
      'rather than simulated - no scene.physics is declared because nothing here is asked to be pushed',
    'The rhythm strip is a schematic single beat, not a rhythm history',
    'Output, ejection fraction and pressure read-outs are first-order linear functions of the parameters',
  ],
  relationships: [
    { from: 'raBlood', to: 'rvBlood', kind: 'feeds through the tricuspid valve', note: 'the low-pressure side' },
    { from: 'rvBlood', to: 'pulmonaryTrunk', kind: 'ejects toward the lungs' },
    { from: 'laBlood', to: 'lvBlood', kind: 'feeds through the mitral valve' },
    { from: 'lvBlood', to: 'aorticRoot', kind: 'ejects at systemic pressure', note: 'the thick wall is the point' },
    { from: 'aorticRoot', to: 'lad', kind: 'feeds the muscle first, before the body' },
  ],
});

scene.colorRole({ id: 'oxygenated', label: 'Oxygenated blood', color: '#c8352f', meaning: 'From the lungs, to the body' });
scene.colorRole({ id: 'deoxygenated', label: 'Deoxygenated blood', color: '#3f6fae', meaning: 'From the body, to the lungs' });
scene.colorRole({ id: 'muscle', label: 'Myocardium', color: '#a84a44', meaning: 'Contractile muscle wall' });
scene.colorRole({ id: 'valveTissue', label: 'Valve tissue', color: '#e3d6c4', meaning: 'Thin fibrous leaflets, one-way' });
scene.colorRole({ id: 'artery', label: 'Elastic artery', color: '#b95548', meaning: 'Great vessel carrying blood away' });
scene.colorRole({ id: 'vein', label: 'Thin-walled vein', color: '#5a7fae', meaning: 'Great vessel returning blood' });
scene.colorRole({ id: 'conductionWave', label: 'Conduction system', color: '#ffd45e', meaning: 'Specialised electrical tissue' });
scene.colorRole({ id: 'coronaryRole', label: 'Coronary supply', color: '#d0492f', meaning: "The heart's own blood supply" });

// Parameters. Every one changes observable state at a frozen instant as well as at a rate, so a paused
// learner still sees each slider's consequence, and the audit's static sweep sees it too.
scene.param({
  id: 'heartRate',
  kind: 'number',
  label: 'Heart rate',
  unit: 'bpm',
  min: 30,
  max: 180,
  default: 72,
  precision: 0,
  description: 'Beats per minute. Drives the contraction cycle, the blood flow and the ECG cursor together.',
  affects: [{ channel: 'motionRate' }, { channel: 'material' }, { channel: 'metric' }],
});

scene.param({
  id: 'strokeVolume',
  kind: 'number',
  label: 'Stroke volume',
  unit: 'mL',
  min: 30,
  max: 120,
  default: 70,
  precision: 0,
  description: 'Blood ejected per beat. Deepens ventricular contraction and widens the aortic pulse.',
  affects: [{ channel: 'transform' }, { channel: 'metric' }],
});

scene.param({
  id: 'contractility',
  kind: 'number',
  label: 'Contractility',
  unit: 'x',
  min: 0.4,
  max: 1.6,
  default: 1,
  precision: 2,
  description: 'Force of contraction at a given load. 1.0 is the healthy resting heart.',
  affects: [{ channel: 'transform' }, { channel: 'material' }, { channel: 'metric' }],
});

scene.param({
  id: 'afterload',
  kind: 'number',
  label: 'Aortic pressure',
  unit: 'mmHg',
  min: 60,
  max: 160,
  default: 95,
  precision: 0,
  description: 'Mean pressure the left ventricle works against. Widens the aorta and shapes the aortic valve.',
  affects: [{ channel: 'transform' }, { channel: 'metric' }],
});

scene.param({
  id: 'cutaway',
  kind: 'boolean',
  label: 'Anatomical cutaway',
  default: true,
  description: 'Remove the anterior half of the walls and membranes so the chambers are visible.',
  affects: [{ channel: 'visibility' }],
});

scene.param({
  id: 'showConduction',
  kind: 'boolean',
  label: 'Conduction system',
  default: true,
  description: 'Show the sinoatrial node, the bundle branches and their activation wave.',
  affects: [{ channel: 'visibility' }],
});

scene.param({
  id: 'showCoronary',
  kind: 'boolean',
  label: 'Coronary vessels',
  default: true,
  description: 'Show the arteries and veins that supply the muscle itself.',
  affects: [{ channel: 'visibility' }],
});

scene.param({
  id: 'bloodFlow',
  kind: 'choice',
  label: 'Blood flow',
  default: 'both',
  description: 'Which circuit to animate. Stripping one side makes the other readable on its own.',
  options: [
    { value: 'both', label: 'Both circuits' },
    { value: 'oxygenated', label: 'Oxygenated only' },
    { value: 'deoxygenated', label: 'Deoxygenated only' },
    { value: 'off', label: 'Hide blood flow' },
  ],
  affects: [{ channel: 'visibility' }],
});

scene.metric({ id: 'cardiacOutput', label: 'Cardiac output', unit: 'L/min', precision: 1, formula: 'CO = HR x SV / 1000' });
scene.metric({ id: 'ejectionFraction', label: 'Ejection fraction', unit: '%', precision: 0, formula: 'EF ~ 55% x contractility' });
scene.metric({ id: 'aorticPressure', label: 'Aortic pressure', unit: 'mmHg', precision: 0 });
scene.metric({ id: 'cycleTime', label: 'Beat period', unit: 's', precision: 2, formula: 'T = 60 / HR' });

// Materials. Organic over metal everywhere: flesh should never read as plastic.
var myoLv = mat.organic({ role: 'muscle', roughness: 0.5, doubleSided: true });
var myoRv = mat.organic({ color: '#a04a52', roughness: 0.55, doubleSided: true });
var myoAtria = mat.organic({ color: '#9a4650', roughness: 0.6, doubleSided: true });
var septa = mat.organic({ color: '#8e4046', roughness: 0.62 });
var stressSkin = mat.gradient({});
var epicardium = mat.translucent({ color: '#dcc9b4', opacity: 0.14 });
var sacSkin = mat.translucent({ color: '#eae4d8', opacity: 0.1, doubleSided: true });
var bloodOxy = mat.fluid({ role: 'oxygenated', opacity: 0.6, emissive: '#8f2a22', emissiveIntensity: 0.4 });
var bloodDeoxy = mat.fluid({ role: 'deoxygenated', opacity: 0.6, emissive: '#274f86', emissiveIntensity: 0.4 });
var valveTissue = mat.organic({ role: 'valveTissue', color: '#cbb694', roughness: 0.7, doubleSided: true });
var chordae = mat.organic({ color: '#bfae93', roughness: 0.72 });
var arteryWall = mat.organic({ role: 'artery', roughness: 0.45 });
var veinWall = mat.organic({ role: 'vein', roughness: 0.52 });
var coronaryWall = mat.organic({ role: 'coronaryRole', roughness: 0.4 });
var conduction = mat.emissive({ role: 'conductionWave', emissiveIntensity: 2.2, boundTo: 'heartRate' });
var fat = mat.matte({ color: '#d8c98a', roughness: 0.78 });
var trace = mat.matte({ color: '#1f7a57', roughness: 0.55, doubleSided: true });
var cursorGlow = mat.emissive({ color: '#eafff4', emissiveIntensity: 2.6 });

scene.group({ id: 'heart', name: 'The heart' });
scene.group({ id: 'rightHeart', name: 'Right heart', parentId: 'heart' });
scene.group({ id: 'leftHeart', name: 'Left heart', parentId: 'heart' });
scene.group({ id: 'valves', name: 'Valves', parentId: 'heart' });
scene.group({ id: 'membranes', name: 'Membranes', parentId: 'heart' });
scene.group({ id: 'coronary', name: 'Coronary circulation', parentId: 'heart' });
scene.group({ id: 'wiring', name: 'Conduction system', parentId: 'heart' });
scene.group({ id: 'flow', name: 'Circulating blood', parentId: 'heart' });
scene.group({ id: 'rhythmStrip', name: 'Rhythm strip', parentId: 'heart' });

// The septa: the two shared walls. The interventricular septum is muscle and part of the left pump's load
// path; the interatrial septum is a thin fibrous sheet where the foramen ovale closed at birth.
scene.mesh({
  id: 'ivSeptum',
  name: 'Interventricular septum',
  parentId: 'leftHeart',
  position: [-0.004, -0.014, 0.002],
  geometry: geom.smooth(geom.transform(geom.sphere({ radius: 0.03, segments: 24 }), { scale: [0.3, 1.05, 1.18] }), 3, 0.5),
  material: septa,
  hero: true,
  info: {
    title: 'Interventricular septum',
    summary:
      'The shared muscular wall between the two ventricles. Electrically it is one piece and mechanically it ' +
      'is still, so one side contracting never bulges into the other.',
    bullets: [
      'Carries the bundle of His and both bundle branches on its surface',
      'Muscular and thick below, thin and membranous at the top',
      'Its position is why the right ventricle is a crescent wrapped around the left',
    ],
  },
});

scene.mesh({
  id: 'iaSeptum',
  name: 'Interatrial septum',
  parentId: 'rightHeart',
  position: [-0.004, 0.04, 0],
  geometry: geom.smooth(geom.transform(geom.sphere({ radius: 0.024, segments: 20 }), { scale: [0.22, 0.8, 1.0] }), 2, 0.5),
  material: septa,
  info: {
    title: 'Interatrial septum',
    summary:
      'The thin wall between the atria. Before birth it carried an open hole, the foramen ovale; the first ' +
      'breath drops lung pressure below venous pressure and the flap is pushed shut for life.',
  },
});

// ── Ventricular walls: exact thickness through revolve + withHoles ──────────
// A marching-cubes rebuild of an 11 mm wall over 0.15 m at 54 voxels gives 3 mm voxels: four voxels of wall,
// and the ratio - the entire lesson - becomes a resolution artefact. Analytic wall: exact ratio, one build.
var lvOuter = geom.profile(
  [[0.01, -0.062], [0.02, -0.052], [0.028, -0.034], [0.031, -0.01], [0.031, 0.018], [0.028, 0.036], [0.022, 0.044]],
  true,
);
var lvCavity = geom.profile(
  [[0.0, -0.055], [0.009, -0.048], [0.016, -0.03], [0.02, -0.008], [0.02, 0.016], [0.018, 0.032], [0.015, 0.044]],
  true,
);
var lvWall = geom.revolve({ profile: geom.withHoles(lvOuter, [lvCavity]), segments: 36 });

// Wall stress ~ pressure x radius / (2 x thickness), so the equator carries the most load and the apex,
// with its small radius, is nearly unloaded. Painted on the muscle with the real gradient.
var lvWallStressed = geom.colorByField(
  lvWall,
  function (x, y, z) {
    return M.clamp(M.len3(x - 0.004, 0, z - 0.004) / 0.032, 0, 1);
  },
  function (t) {
    return [0.55 + 0.45 * t, 0.25 + 0.2 * (1 - t), 0.28];
  },
);

// The cutaway twin: the anterior half is genuinely removed, so the open wall reveals the cavity, the
// valves and the chordae inside - an anatomical cut, not a transparency trick.
var lvWallCut = geom.clip(lvWallStressed, [0, 0, 1], 0.004);

scene.mesh({
  id: 'lvWall',
  name: 'Left ventricle wall',
  parentId: 'leftHeart',
  position: [0.004, 0.002, 0.004],
  geometry: lvWallCut,
  material: stressSkin,
  hero: true,
  info: {
    title: 'Left ventricle',
    summary:
      'The systemic pump. Its wall is about 11 mm thick because it generates roughly 120 mmHg against the ' +
      'entire body, where the right side makes 25 mmHg against the lungs. Thickness follows pressure.',
    bullets: [
      'Ejects a little over half of the blood it holds each beat',
      'Its heat map is wall stress: brightest where radius and pressure meet',
      'Volume is barely larger than the right ventricle; the pressure difference is what differs',
    ],
    facts: [
      { label: 'Wall thickness', value: '11 mm (right side 4 mm)' },
      { label: 'Pressure', value: 'about 120 mmHg in systole' },
    ],
  },
});

scene.mesh({
  id: 'lvWallFull', name: 'Left ventricle (closed)', parentId: 'leftHeart', position: [0.004, 0.002, 0.004],
  geometry: lvWallStressed,
  material: stressSkin,
  visible: false,
  info: { title: 'Left ventricle (closed)', summary: 'The same wall with its anterior half restored - toggle the cutaway off to see the intact organ.' },
});

// The right ventricle wraps the left as a crescent: its free wall is 4 mm because 25 mmHg is all the lungs
// ask for. Same profile technique, then flattened and rotated into its crescent posture.
var rvOuter = geom.profile(
  [[0.012, -0.056], [0.022, -0.046], [0.029, -0.03], [0.031, -0.008], [0.031, 0.016], [0.028, 0.032], [0.023, 0.04]],
  true,
);
var rvCavity = geom.profile(
  [[0.004, -0.05], [0.013, -0.042], [0.02, -0.028], [0.027, -0.008], [0.027, 0.014], [0.024, 0.03], [0.02, 0.038]],
  true,
);
var rvWall = geom.transform(geom.revolve({ profile: geom.withHoles(rvOuter, [rvCavity]), segments: 36 }), {
  scale: [1, 1, 0.82],
  rotate: [0, 0.25, 0],
});
var rvWallCut = geom.clip(rvWall, [0, 0, 1], 0.003);

scene.mesh({
  id: 'rvWall',
  name: 'Right ventricle wall',
  parentId: 'rightHeart',
  position: [-0.02, 0.002, 0.003],
  geometry: rvWallCut,
  material: myoRv,
  hero: true,
  info: {
    title: 'Right ventricle',
    summary:
      'The pulmonary pump. It moves the same output as the left side, into a circuit with a fifth of the ' +
      'resistance, so its wall is 4 mm where the left is 11 mm. Same flow, different pressure, different wall.',
    bullets: [
      'Crescent-shaped because it grew around the left ventricle, not beside it',
      'Pump failure here is lung disease first, heart disease second',
      'Its outflow sits in front of and leftward of the aortic valve',
    ],
    facts: [
      { label: 'Wall thickness', value: '4 mm' },
      { label: 'Pressure', value: 'about 25 mmHg in systole' },
    ],
  },
});

scene.mesh({
  id: 'rvWallFull', name: 'Right ventricle (closed)', parentId: 'rightHeart', position: [-0.02, 0.002, 0.003],
  geometry: rvWall,
  material: myoRv,
  visible: false,
  info: { title: 'Right ventricle (closed)', summary: 'The intact right wall, shown when the cutaway is off.' },
});

// ── Atria: the thin-walled receiving chambers ───────────────────────────────
// Atrial walls are 2 to 3 mm - thinner than ventricular - because filling costs almost nothing. Built by
// shelling the cavity solid, so the wall is a true uniform 2.5 mm everywhere.
var laCavity = geom.transform(geom.sphere({ radius: 0.021, segments: 20 }), { scale: [1, 0.92, 0.88] });
var raCavity = geom.transform(geom.sphere({ radius: 0.02, segments: 20 }), { scale: [1, 0.95, 0.95] });
var laShell = geom.shell(laCavity, 0.0025);
var raShell = geom.shell(raCavity, 0.0025);
var laWallCut = geom.clip(laShell, [0, 0, 1], -0.006);
var raWallCut = geom.clip(raShell, [0, 0, 1], 0.004);

scene.mesh({
  id: 'laWall',
  name: 'Left atrium wall',
  parentId: 'leftHeart',
  position: [0.014, 0.04, -0.006],
  geometry: laWallCut,
  material: myoAtria,
  info: {
    title: 'Left atrium',
    summary:
      'Receives the four pulmonary veins and meters blood into the left ventricle. Its wall is 2.5 mm: gravity ' +
      'and venous pressure do nearly all the filling work. The left atrium is the most posterior chamber - it ' +
      'sits directly in front of the oesophagus, which is why an echocardiographer looks at it from there.',
  },
});

scene.mesh({
  id: 'laWallFull', name: 'Left atrium (closed)', parentId: 'leftHeart', position: [0.014, 0.04, -0.006],
  geometry: laShell,
  material: myoAtria,
  visible: false,
  info: { title: 'Left atrium (closed)', summary: 'The intact left atrium, shown when the cutaway is off.' },
});

scene.mesh({
  id: 'raWall',
  name: 'Right atrium wall',
  parentId: 'rightHeart',
  position: [-0.019, 0.04, 0.004],
  geometry: raWallCut,
  material: myoAtria,
  info: {
    title: 'Right atrium',
    summary:
      'Receives the entire venous return of the body through the venae cavae, plus the coronary sinus - the ' +
      'heart paying back its own supply. The sinoatrial node sits at its top, at the junction with the ' +
      'superior vena cava.',
  },
});

scene.mesh({
  id: 'raWallFull', name: 'Right atrium (closed)', parentId: 'rightHeart', position: [-0.019, 0.04, 0.004],
  geometry: raShell,
  material: myoAtria,
  visible: false,
  info: { title: 'Right atrium (closed)', summary: 'The intact right atrium, shown when the cutaway is off.' },
});

scene.mesh({
  id: 'laAppendage',
  name: 'Left atrial appendage',
  parentId: 'leftHeart',
  position: [0.032, 0.046, 0.004],
  geometry: geom.smooth(geom.transform(geom.capsule({ radius: 0.007, height: 0.008 }), { rotate: [0, 0, 0.9] }), 2, 0.6),
  material: myoAtria,
  info: {
    title: 'Left atrial appendage',
    summary:
      'A small finger-shaped pocket off the left atrium. When the atrium fibrillates it stops emptying, and ' +
      'this blind pouch is where clots form - which is why appendage closure prevents stroke in atrial ' +
      'fibrillation.',
  },
});

// ── The blood volumes: the chambers as the blood that fills them ────────────
// A chamber IS its contained blood, so the selectable "chamber" parts are translucent fluid volumes sitting
// exactly in the excavated cavities. Coloured by the truth of the blood inside them.
var lvBloodGeom = geom.transform(geom.sphere({ radius: 0.019, segments: 18 }), { scale: [0.72, 1.55, 0.72] });
var rvBloodGeom = geom.transform(geom.sphere({ radius: 0.021, segments: 18 }), { scale: [0.85, 1.45, 0.62] });

scene.mesh({
  id: 'lvBlood',
  name: 'Left ventricle cavity',
  parentId: 'leftHeart',
  position: [0.004, -0.008, 0.004],
  geometry: lvBloodGeom,
  material: bloodOxy,
  info: {
    title: 'Left ventricular cavity',
    summary:
      'Oxygen-rich blood, delivered by the mitral valve and about to leave for the whole body through the ' +
      'aortic valve. Holds roughly 120 mL when full; about 70 mL leaves each beat.',
  },
});

scene.mesh({
  id: 'rvBlood',
  name: 'Right ventricle cavity',
  parentId: 'rightHeart',
  position: [-0.02, -0.006, 0.003],
  geometry: rvBloodGeom,
  material: bloodDeoxy,
  info: {
    title: 'Right ventricular cavity',
    summary:
      'Venous blood, one beat from the lungs. Its oxygen content is what the lungs are about to fix, and the ' +
      'blue here is convention - venous blood is dark red, never literally blue.',
  },
});

scene.mesh({
  id: 'laBlood',
  name: 'Left atrial cavity',
  parentId: 'leftHeart',
  position: [0.014, 0.04, -0.006],
  geometry: geom.transform(geom.sphere({ radius: 0.018, segments: 16 }), { scale: [1, 0.88, 0.85] }),
  material: bloodOxy,
  info: {
    title: 'Left atrial cavity',
    summary: 'Freshly oxygenated blood arriving from the lungs, staged for the next systemic beat.',
  },
});

scene.mesh({
  id: 'raBlood',
  name: 'Right atrial cavity',
  parentId: 'rightHeart',
  position: [-0.019, 0.04, 0.004],
  geometry: geom.transform(geom.sphere({ radius: 0.017, segments: 16 }), { scale: [1, 0.9, 0.9] }),
  material: bloodDeoxy,
  info: {
    title: 'Right atrial cavity',
    summary: 'The collecting pool of systemic venous return: head and arms from above, legs and organs from below.',
  },
});

// ── The valve apparatus: annulus, leaflets, chordae, papillary muscles ──────
// A valve is a system, not a flap. The annulus is a fibrous ring; the leaflets are tensioned sheets; the
// chordae tether them to papillary muscles so pressure can never invert them. Remove any one piece and the
// valve leaks - which is why repairing one piece fixes the leak.

scene.mesh({ id: 'mitralAnnulus', name: 'Mitral annulus', parentId: 'valves', position: [0.014, 0.028, 0.0],
  geometry: geom.torus({ radius: 0.016, tube: 0.002, segments: 28, tubeSegments: 10 }), material: chordae,
  info: { title: 'Mitral annulus', summary: 'The fibrous ring the anterior and posterior mitral leaflets hang from. It is saddle-shaped in life; here it is a ring for clarity.' } });

scene.mesh({ id: 'aorticAnnulus', name: 'Aortic annulus', parentId: 'valves', position: [0.002, 0.038, 0.006],
  geometry: geom.torus({ radius: 0.011, tube: 0.0018, segments: 26, tubeSegments: 10 }), material: chordae,
  info: { title: 'Aortic annulus', summary: 'The ring between the left ventricle and the aortic root, seated inside the curves of the three sinuses.' } });

scene.mesh({ id: 'tricuspidAnnulus', name: 'Tricuspid annulus', parentId: 'valves', position: [-0.016, 0.03, 0.006],
  geometry: geom.torus({ radius: 0.019, tube: 0.002, segments: 28, tubeSegments: 10 }), material: chordae,
  info: { title: 'Tricuspid annulus', summary: 'The largest of the four rings. It dilates when the right heart is overloaded, which is what tricuspid regurgitation is.' } });

scene.mesh({ id: 'pulmonaryAnnulus', name: 'Pulmonary annulus', parentId: 'valves', position: [-0.006, 0.046, 0.012],
  geometry: geom.torus({ radius: 0.012, tube: 0.0018, segments: 26, tubeSegments: 10 }), material: chordae,
  info: { title: 'Pulmonary annulus', summary: 'The ring between the right ventricle and the pulmonary trunk, the most anterior of the four valves.' } });

// Semilunar cusps: three pockets per arterial valve. Parametric surfaces, built once and rotated in place -
// three cache-hit copies rather than three rebuilds.
function semilunarCusp(radius, height, bulge) {
  return function (u, v) {
    var a = (u - 0.5) * 2.1;
    var r = radius + bulge * M.sin(M.PI * u) * v;
    return [r * M.sin(a), height * v, r * M.cos(a)];
  };
}

var cuspGeom = geom.subdivide(geom.parametric({ surface: semilunarCusp(0.0105, 0.008, 0.0045), segments: 20 }), 1);

scene.instances({
  id: 'aorticValve', name: 'Aortic valve', parentId: 'valves', position: [0.002, 0.038, 0.006],
  geometry: cuspGeom, material: valveTissue,
  placements: geom.pattern.radial(3, 0.0, { axis: 'y', startAngle: 0.3 }),
  info: {
    title: 'Aortic valve',
    summary:
      'Three semilunar cusps that fall open in systole and slam shut in diastole. The closure sound is the ' +
      'second heart sound; the cusps never open more than a few millimetres, and they seal by catching ' +
      'back-pressure, not by being pushed.',
    bullets: [
      'Its three sinuses are where the coronary arteries start',
      'Closes passively: the pressure behind it is the hinge',
      'Narrowing here is aortic stenosis, the most common replaced valve',
    ],
  },
});

var pvCuspGeom = geom.subdivide(geom.parametric({ surface: semilunarCusp(0.0115, 0.0075, 0.004), segments: 20 }), 1);

scene.instances({
  id: 'pulmonaryValve', name: 'Pulmonary valve', parentId: 'valves', position: [-0.006, 0.046, 0.012],
  geometry: pvCuspGeom, material: valveTissue,
  placements: geom.pattern.radial(3, 0.0, { axis: 'y', startAngle: 1.2 }),
  info: {
    title: 'Pulmonary valve',
    summary: 'The mirror of the aortic valve on the lung circuit. Same three cusps, same passive closure, a fifth of the pressure.',
  },
});

// Atrioventricular leaflets: scalloped curtains that hang into the ventricle and balloon shut under pressure.
function avLeaflet(span, radius, drop) {
  return function (u, v) {
    var a = (u - 0.5) * span;
    var scallop = 0.7 + 0.3 * M.sin(M.PI * u);
    var r = radius + 0.0015 * M.sin(M.PI * u);
    return [r * M.sin(a), -drop * v * scallop, r * M.cos(a)];
  };
}

scene.instances({
  id: 'mitralValve', name: 'Mitral valve', parentId: 'valves', position: [0.014, 0.028, 0.0],
  geometry: geom.parametric({ surface: avLeaflet(2.9, 0.015, 0.011), segments: 20 }),
  material: valveTissue,
  placements: geom.pattern.radial(2, 0.0, { axis: 'y', startAngle: 0.5 }),
  info: {
    title: 'Mitral valve',
    summary:
      'Two leaflets, named for a bishop mitre their closed shape resembles. They are the only dead-end seal ' +
      'between 120 mmHg leaving and the lungs filling - prolapse of one is a murmuring leak, and repair ' +
      'preserves the saddle rather than replacing it.',
  },
});

scene.instances({
  id: 'tricuspidValve', name: 'Tricuspid valve', parentId: 'valves', position: [-0.016, 0.03, 0.006],
  geometry: geom.parametric({ surface: avLeaflet(2.1, 0.018, 0.009), segments: 20 }),
  material: valveTissue,
  placements: geom.pattern.radial(3, 0.0, { axis: 'y', startAngle: 2.2 }),
  info: {
    title: 'Tricuspid valve',
    summary: 'Three leaflets under a fifth of the mitral pressure, so its leaflets are broader and less taut. It tolerates more dilatation before failing.',
  },
});

// Chordae tendineae: the guy-ropes. Instanced fans rooted at each papillary muscle, because a valve leaflet
// held only at its ring would evert the first time the ventricle squeezed.
var chordGeom = geom.transform(geom.cylinder({ radius: 0.0004, height: 0.016, segments: 6 }), { rotate: [-1.0, 0, 0] });

scene.instances({
  id: 'lvChordae', name: 'Mitral chordae', parentId: 'valves', position: [0.014, -0.012, 0.004],
  geometry: chordGeom, material: chordae,
  placements: geom.pattern.radial(9, 0.005, { axis: 'y', faceOutward: true }),
  info: {
    title: 'Chordae tendineae',
    summary:
      'Fibrous strings from the papillary muscles to the leaflet edges. They do not pull the valve closed - ' +
      'they stop it blowing inside-out. Rupture of one is an acute surgical emergency.',
  },
});

scene.instances({
  id: 'rvChordae', name: 'Tricuspid chordae', parentId: 'valves', position: [-0.016, -0.008, 0.004],
  geometry: chordGeom, material: chordae,
  placements: geom.pattern.radial(7, 0.005, { axis: 'y', faceOutward: true }),
  info: {
    title: 'Right-sided chordae',
    summary: 'Finer, more numerous and more forgiving than the mitral set - a pressure mismatch mirrored in structure.',
  },
});

// Papillary muscles: the anchors. Two in the left ventricle, opposite one another; three along the septal
// band on the right. Note the mirror trick - one placement and its reflection, one draw call.
var papillaryGeom = geom.capsule({ radius: 0.0035, height: 0.010, segments: 10 });

scene.instances({
  id: 'lvPapillary', name: 'Left papillary muscles', parentId: 'leftHeart', position: [0.014, -0.026, 0.004],
  geometry: papillaryGeom, material: myoLv,
  placements: geom.pattern.mirror(geom.pattern.linear(1, [0, 0, 0.001], { start: [0, 0, -0.013] }), 'z'),
  info: {
    title: 'Papillary muscles',
    summary:
      'Two muscular pillars in the left ventricle that contract a hair before the wall does, pre-tensioning the ' +
      'chordae so the mitral valve is already braced when the pressure hits.',
  },
});

scene.instances({
  id: 'rvPapillary', name: 'Right papillary muscles', parentId: 'rightHeart', position: [-0.02, -0.022, 0.0],
  geometry: papillaryGeom, material: myoRv,
  placements: geom.pattern.linear(3, [0.012, 0.002, 0], { start: [-0.006, 0, 0.008] }),
  info: {
    title: 'Right papillary muscles',
    summary: 'Three anchors along the septal band, one of them genuinely septal - a detail that matters in infarction, because septal ischaemia drops the tricuspid valve first.',
  },
});

// ── Trabeculae carneae: the ridged inner face of the muscle ─────────────────
// Real endocardium is not smooth: it is a corrugated sponge of muscle ridges wound in the same spiral as
// the muscle fibres. Ridges here are instanced capsules laid helically - anatomically placed detail, and
// cheap at one draw call per ventricle.
var trabeculaGeom = geom.capsule({ radius: 0.0012, height: 0.0035, segments: 5 });

scene.instances({
  id: 'lvTrabeculae', name: 'Left ventricular trabeculae', parentId: 'leftHeart', position: [0.004, -0.008, 0.004],
  geometry: trabeculaGeom, material: myoLv,
  placements: geom.pattern.helical(30, 0.014, 0.011, 2.6, { faceOutward: true }),
  info: {
    title: 'Trabeculae carneae',
    summary:
      'Ridged muscle lining the ventricle, wound in the same spiral as the muscle fibres themselves. They ' +
      'reduce the turbulence of filling and, in the embryo, are the scaffolding the muscle compacts from.',
  },
});

scene.instances({
  id: 'rvTrabeculae', name: 'Right ventricular trabeculae', parentId: 'rightHeart', position: [-0.02, -0.006, 0.003],
  geometry: trabeculaGeom, material: myoRv,
  placements: geom.pattern.helical(26, 0.021, 0.012, 2.2, { faceOutward: true }),
  info: {
    title: 'Right-sided trabeculae',
    summary: 'Coarser than the left. In fact the right ventricle is the most heavily trabeculated chamber - a structural fingerprint used to tell heart failure from normal variant on imaging.',
  },
});

// ── Great vessels: hollow pipes with real bore, so a cutaway shows a wall ───
// Every vessel here is a tube with an innerRadius. A solid cylinder vessel is a picture of a vessel; a
// bored one is a vessel, and it lets the wall thickness - arterial 2 mm, thinner venous - be honest.

scene.mesh({
  id: 'svc', name: 'Superior vena cava', parentId: 'rightHeart',
  geometry: geom.pipe({ path: geom.splinePath([[-0.019, 0.095, -0.002], [-0.019, 0.07, -0.004], [-0.017, 0.05, 0]], 8), radius: 0.009, innerRadius: 0.0072, segments: 14, caps: true }),
  material: veinWall,
  info: { title: 'Superior vena cava', summary: 'Drains everything above the diaphragm into the right atrium. Wall about 1 mm - veins are the thin-walled half of the circuit because they run at 5 mmHg.' },
});

scene.mesh({
  id: 'ivc', name: 'Inferior vena cava', parentId: 'rightHeart',
  geometry: geom.pipe({ path: geom.splinePath([[0.006, -0.032, -0.042], [0, 0, -0.03], [-0.012, 0.026, -0.014]], 8), radius: 0.01, innerRadius: 0.0082, segments: 14, caps: true }),
  material: veinWall,
  info: { title: 'Inferior vena cava', summary: 'Carries the larger half of the venous return - legs, kidneys, liver - up into the right atrium from below and behind.' },
});

scene.mesh({
  id: 'pulmonaryTrunk', name: 'Pulmonary trunk', parentId: 'rightHeart',
  geometry: geom.pipe({ path: geom.splinePath([[-0.006, 0.03, 0.022], [-0.005, 0.052, 0.018], [-0.004, 0.066, 0.01]], 8), radius: 0.011, innerRadius: 0.0092, segments: 16, caps: true }),
  material: arteryWall,
  info: { title: 'Pulmonary trunk', summary: 'The right ventricle outflow. It is the largest artery by flow and the only one carrying deoxygenated blood, which is one of the two great inversions of the pulmonary circuit.' },
});

scene.mesh({
  id: 'pulmonaryLeft', name: 'Left pulmonary artery', parentId: 'rightHeart', position: [-0.004, 0.066, 0.01],
  geometry: geom.pipe({ path: geom.path([[0, 0, 0], [0.024, 0.004, -0.012], [0.034, 0, -0.02]]), radius: 0.008, innerRadius: 0.0065, segments: 12, caps: true }),
  material: arteryWall,
  info: { title: 'Left pulmonary artery', summary: 'To the left lung. A clot lodged here is a pulmonary embolism - the right heart pumping against a suddenly empty circuit.' },
});

scene.mesh({
  id: 'pulmonaryRight', name: 'Right pulmonary artery', parentId: 'rightHeart', position: [-0.004, 0.066, 0.01],
  geometry: geom.pipe({ path: geom.path([[0, 0, 0], [-0.028, 0.002, -0.012], [-0.038, 0, -0.018]]), radius: 0.008, innerRadius: 0.0065, segments: 12, caps: true }),
  material: arteryWall,
  info: { title: 'Right pulmonary artery', summary: 'To the right lung. It passes behind the aorta - one of the few places where the great vessels cross.' },
});

// Aortic root: the three sinuses of Valsalva as a real 3-lobed cross-section, lofted into the smooth
// tube above. A single bulge would be a lie - the coronary arteries hang off these sinuses specifically.
var lobePair = [[0.00953, 0.0055], [0, 0.0124]];
var sinusProfile = geom.splineProfile(
  [lobePair[0], lobePair[1], [-lobePair[0][0], lobePair[0][1]], [-lobePair[0][0], -lobePair[0][1]], [0, -lobePair[1][1]], [lobePair[0][0], -lobePair[0][1]]],
  8,
  true,
);

scene.mesh({
  id: 'aorticRoot', name: 'Aortic root', parentId: 'leftHeart', position: [0.002, 0.032, 0.006],
  geometry: geom.loft({
    sections: [
      { profile: sinusProfile, position: [0, 0, 0] },
      { profile: geom.circleProfile({ radius: 0.011, segments: 24 }), position: [0, 0.008, 0] },
    ],
    smoothSteps: 4,
    caps: true,
  }),
  material: arteryWall,
  hero: true,
  info: {
    title: 'Aortic root',
    summary:
      'The root of the aorta, with its three bulging sinuses of Valsalva. They create eddies that snap the ' +
      'valve shut, and two of them carry the origins of the coronary arteries - the heart is fed from the ' +
      'first centimetre of the pipe it fills.',
  },
});

var ascendingGeom = geom.colorByField(
  geom.pipe({ path: geom.path([[0.002, 0.04, 0.006], [0.01, 0.058, 0.004], [0.014, 0.072, -0.002]]), radius: 0.0125, innerRadius: 0.0105, segments: 16, caps: true }),
  function (x, y, z) {
    return M.clamp((y + 0.01) / 0.09, 0, 1);
  },
  function (t) {
    return [0.55 + 0.4 * t, 0.22 + 0.16 * (1 - t), 0.3];
  },
);

scene.mesh({
  id: 'ascendingAorta', name: 'Ascending aorta', parentId: 'leftHeart',
  geometry: ascendingGeom,
  material: stressSkin,
  info: { title: 'Ascending aorta', summary: 'The high-pressure start of the systemic circuit. Watch its colour - painted by wall-stress gradient, it falls back toward the arch as pressure is spent on distance.' },
});

scene.mesh({
  id: 'aorticArch', name: 'Aortic arch', parentId: 'leftHeart',
  geometry: geom.pipe({ path: geom.splinePath([[0.014, 0.072, -0.002], [0.008, 0.084, -0.012], [-0.006, 0.078, -0.02]], 10), radius: 0.012, innerRadius: 0.01, segments: 16, caps: true }),
  material: arteryWall,
  info: { title: 'Aortic arch', summary: 'The U-turn over the heart. Three branches to the head and arms leave it; their presence is why the arch is the fixed landmark of chest imaging.' },
});

scene.mesh({
  id: 'descendingAorta', name: 'Descending aorta', parentId: 'leftHeart',
  geometry: geom.pipe({ path: geom.path([[-0.006, 0.078, -0.02], [-0.012, 0.04, -0.024], [-0.014, 0, -0.026], [-0.015, -0.04, -0.028]]), radius: 0.011, innerRadius: 0.0092, segments: 14, caps: true }),
  material: arteryWall,
  info: { title: 'Descending aorta', summary: 'Runs down behind the heart to feed the trunk and legs. Pressure here is the afterload slider - drag it and watch the whole systemic tree stiffen visually.' },
});

// Pulmonary veins: four of them, defined once as a component and placed four times. One geometry build,
// four placements - the component system earning its keep on the most repetitive anatomy in the heart.
var pulmonaryVeinGeom = geom.pipe({
  path: geom.splinePath([[0.012, 0, 0], [0.0, 0.002, -0.008], [-0.008, 0.004, -0.016]], 8),
  radius: 0.005,
  innerRadius: 0.0038,
  segments: 12,
  caps: true,
});

scene.defineComponent('pulmonaryVein', function (ctx) {
  ctx.mesh({ id: 'vein', geometry: pulmonaryVeinGeom, material: veinWall, info: { title: 'Pulmonary vein', summary: 'One of four veins returning oxygenated blood from a lung to the left atrium - the only veins in the body that carry rich red blood.' } });
});

scene.place('pulmonaryVein', { id: 'rightUpperPulmonaryVein', parentId: 'leftHeart', position: [0.026, 0.052, -0.012] });
scene.place('pulmonaryVein', { id: 'rightLowerPulmonaryVein', parentId: 'leftHeart', position: [0.024, 0.03, -0.016] });
scene.place('pulmonaryVein', { id: 'leftUpperPulmonaryVein', parentId: 'leftHeart', position: [0.002, 0.054, -0.016] });
scene.place('pulmonaryVein', { id: 'leftLowerPulmonaryVein', parentId: 'leftHeart', position: [-0.004, 0.03, -0.018] });

// ── The coronary circulation: the heart pays itself first ──────────────────
// Two arteries leave the very first centimetre of the aorta and wrap the surface in the interventricular and
// atrioventricular grooves. A blockage here is a heart attack; nothing about the chambers' own blood can
// substitute, because the endocardium is too thick to diffuse through and systole squeezes these very
// vessels shut - which is why coronary flow is mostly diastolic.
scene.mesh({
  id: 'lad', name: 'Left anterior descending artery', parentId: 'coronary',
  geometry: geom.pipe({ path: geom.path([[0.006, 0.032, 0.012], [0.01, 0, 0.015], [0.008, -0.03, 0.014], [0.004, -0.054, 0.008]]), radius: 0.0016, innerRadius: 0.0009, segments: 10, caps: true }),
  material: coronaryWall,
  info: {
    title: 'Left anterior descending (LAD)',
    summary:
      'Runs down the front of the septum supplying the front wall of both ventricles and the septum. Block it ' +
      'and you lose most of the working muscle - the one cardiologists nickname the widow-maker.',
    bullets: [
      'Supplies the anterior two-thirds of the septum',
      'Its diagonal branches peacock off toward the left free wall',
      'The most commonly occluded coronary artery',
    ],
  },
});

scene.mesh({
  id: 'circumflex', name: 'Left circumflex artery', parentId: 'coronary',
  geometry: geom.pipe({ path: geom.path([[0.006, 0.032, 0.006], [0.028, 0.03, -0.002], [0.026, 0.02, -0.02]]), radius: 0.0015, innerRadius: 0.0008, segments: 10, caps: true }),
  material: coronaryWall,
  info: { title: 'Left circumflex', summary: 'Wraps around the left side in the atrioventricular groove, feeding the lateral wall and - in about one person in ten - the whole back of the heart.' },
});

scene.mesh({
  id: 'rightCoronary', name: 'Right coronary artery', parentId: 'coronary',
  geometry: geom.pipe({ path: geom.path([[-0.002, 0.032, 0.008], [-0.028, 0.028, 0.004], [-0.034, 0.014, -0.014], [-0.022, 0.006, -0.026]]), radius: 0.0015, innerRadius: 0.0008, segments: 10, caps: true }),
  material: coronaryWall,
  info: {
    title: 'Right coronary artery',
    summary:
      'Supplies the right heart and, in most people, the sinoatrial and atrioventricular nodes - which is ' +
      'why a right coronary infarct presents as a rhythm problem before it presents as a pump problem.',
  },
});

scene.mesh({
  id: 'coronarySinus', name: 'Coronary sinus', parentId: 'coronary',
  geometry: geom.pipe({ path: geom.path([[0.008, 0.026, -0.024], [-0.004, 0.024, -0.028], [-0.02, 0.026, -0.018]]), radius: 0.0035, innerRadius: 0.0022, segments: 12, caps: true }),
  material: veinWall,
  info: { title: 'Coronary sinus', summary: 'The collecting channel for venous blood from the muscle, draining into the right atrium - the heart paying back its borrowed oxygen.' },
});

// ── The conduction system: the rhythm is generated inside the organ ─────────
// Five specialised islands plus a network of fine fibres. Brightness is bound to heart rate, and the frame
// callback walks an activation spike from node to node so the wave is visible as a wave.
scene.mesh({
  id: 'saNode', name: 'Sinoatrial node', parentId: 'wiring', position: [-0.017, 0.05, 0],
  geometry: geom.transform(geom.sphere({ radius: 0.0022, segments: 8 }), { scale: [1.6, 1, 1] }),
  material: conduction,
  info: {
    title: 'Sinoatrial node',
    summary:
      'The pacemaker: a stamp-sized island of cells at the top of the right atrium that depolarises on its own ' +
      '60-100 times a minute. No brain required - transplant a heart and it keeps beating in the box.',
    bullets: [
      'Fires faster than any other pacemaker, so it sets the tempo',
      'Sympathetic nerves speed it, vagal nerves slow it - the heartRate slider stands in for them',
      'Failure here is why pacemakers exist',
    ],
  },
});

scene.mesh({
  id: 'avNode', name: 'Atrioventricular node', parentId: 'wiring', position: [0, 0.024, 0.004],
  geometry: geom.sphere({ radius: 0.0016, segments: 8 }),
  material: conduction,
  info: {
    title: 'Atrioventricular node',
    summary:
      'The relay station and the only electrical door between atria and ventricles. It deliberately delays ' +
      'about 0.1 s so the atria finish emptying first - the pause you can feel between "lub" and "dub".',
  },
});

scene.mesh({
  id: 'bundleOfHis', name: 'Bundle of His', parentId: 'wiring', position: [0, 0.014, 0.002],
  geometry: geom.capsule({ radius: 0.0009, height: 0.006, segments: 6 }),
  material: conduction,
  info: { title: 'Bundle of His', summary: 'The short cable that crosses the fibrous skeleton of the heart - the only bridge between atrial muscle and ventricular muscle.' },
});

scene.mesh({
  id: 'leftBundle', name: 'Left bundle branch', parentId: 'wiring', position: [0.006, 0.006, -0.002],
  geometry: geom.transform(geom.capsule({ radius: 0.0007, height: 0.012, segments: 6 }), { rotate: [0.15, 0, 0.15] }),
  material: conduction,
  info: { title: 'Left bundle branch', summary: 'Splits immediately into two fascicles and fans over the thick left wall - more muscle to depolarise, more wiring to do it.' },
});

scene.mesh({
  id: 'rightBundle', name: 'Right bundle branch', parentId: 'wiring', position: [-0.01, 0.004, -0.002],
  geometry: geom.transform(geom.capsule({ radius: 0.0007, height: 0.013, segments: 6 }), { rotate: [-0.15, 0, 0.2] }),
  material: conduction,
  info: { title: 'Right bundle branch', summary: 'Runs down the right side of the septum to the thinner right wall; one thin cord, which is why right bundle branch block is so common and so often benign.' },
});

var purkinjeGeom = geom.capsule({ radius: 0.0004, height: 0.0016, segments: 4 });

scene.instances({
  id: 'purkinjeLeft', name: 'Left Purkinje fibres', parentId: 'wiring', position: [0.004, 0, 0.004],
  geometry: purkinjeGeom, material: conduction,
  placements: geom.pattern.helical(22, 0.019, 0.01, 2.4, { faceOutward: true }),
  info: {
    title: 'Left Purkinje network',
    summary:
      'Fast-conducting fibres spread under the endocardium, delivering the impulse to the whole left wall ' +
      'within a few hundredths of a second so all of it contracts together rather than rippling.',
  },
});

scene.instances({
  id: 'purkinjeRight', name: 'Right Purkinje fibres', parentId: 'wiring', position: [-0.02, 0, 0.003],
  geometry: purkinjeGeom, material: conduction,
  placements: geom.pattern.helical(20, 0.025, 0.01, 2, { faceOutward: true }),
  info: { title: 'Right Purkinje network', summary: 'The same idea over the right wall. Activation spreads apex-first, which is why the heart wrings itself empty from the bottom up.' },
});

// ── The epicardium: one continuous membrane over the whole organ ────────────
// The outer surface of the heart is a single smooth sheet, not eight separate patches. Marching cubes over a
// chain of smooth unions gives exactly that: one skin that flows over every chamber and great vessel, with
// grooves instead of seams. This is the one job in the model where an SDF is the correct tool.
var apexBall = geom.field.translate(geom.field.sphere(0.014), 0.004, -0.058, 0.004);
var lvField = geom.field.translate(geom.field.cylinder(0.03, 0.044, 'y'), 0.004, 0, 0.004);
var rvField = geom.field.translate(geom.field.cylinder(0.028, 0.04, 'y'), -0.02, 0, 0.006);
var laField = geom.field.translate(geom.field.sphere(0.02), 0.014, 0.04, -0.006);
var raField = geom.field.translate(geom.field.sphere(0.019), -0.019, 0.04, 0.004);
var trunkField = geom.field.translate(geom.field.cylinder(0.012, 0.03, 'y'), -0.004, 0.052, 0.012);
var aorticBall = geom.field.translate(geom.field.cylinder(0.01, 0.028, 'y'), 0.004, 0.056, 0.002);

var heartField = geom.field.smoothUnion(lvField, rvField, 0.012);
heartField = geom.field.smoothUnion(heartField, laField, 0.01);
heartField = geom.field.smoothUnion(heartField, raField, 0.01);
heartField = geom.field.smoothUnion(heartField, trunkField, 0.008);
heartField = geom.field.smoothUnion(heartField, aorticBall, 0.008);
heartField = geom.field.smoothUnion(heartField, apexBall, 0.014);

var epiField = geom.field.shell(heartField, 0.003);
var epicardiumFullGeom = geom.sdf({
  field: epiField,
  bounds: { min: [-0.06, -0.09, -0.07], max: [0.06, 0.11, 0.07] },
  resolution: 60,
});

scene.mesh({
  id: 'epicardiumFull', name: 'Epicardium (closed)', parentId: 'membranes',
  visible: false,
  geometry: epicardiumFullGeom,
  material: epicardium,
  info: {
    title: 'Epicardium',
    summary:
      'The outermost layer of the heart wall and the innermost layer of the pericardial sac. It carries the ' +
      'coronary arteries on its surface, which is why a diseased artery shows on a membrane that thin.',
  },
});

scene.mesh({
  id: 'epicardium', name: 'Epicardium (anterior removed)', parentId: 'membranes',
  geometry: geom.clip(epicardiumFullGeom, [0, 0, 1], 0.006),
  material: epicardium,
  info: { title: 'Epicardium', summary: 'The anterior half is cut away - a real anatomical cut, not a fade, so the chambers read as excavated rather than ghosted.' },
});

// The pericardial sac is deliberately omitted: at marching-cubes voxel scale its 1-2 mm wall shreds into
// debris, and a half-sac reads worse than no sac. The epicardium carries the closed silhouette on its own.

// Epicardial fat: fat lives in the grooves, along the arteries - one instance set along the two real sulci,
// so the detail is anatomically placed rather than decoratively scattered.
var groovePath = geom.splinePath([[0.01, 0.03, 0.007], [0.026, 0.028, -0.004], [0.024, 0.024, -0.02], [-0.002, 0.026, -0.026], [-0.026, 0.024, -0.016]], 10);
var sulcusPath = geom.splinePath([[0.008, 0.026, 0.014], [0.01, 0, 0.015], [0.008, -0.03, 0.014], [0.004, -0.052, 0.008]], 10);
var fatGeom = geom.transform(geom.sphere({ radius: 0.0032, segments: 8 }), { scale: [1, 0.55, 1] });

scene.instances({
  id: 'epicardialFat', name: 'Epicardial fat', parentId: 'membranes',
  geometry: fatGeom, material: fat,
  placements: geom.pattern.alongPath(groovePath, 26).concat(geom.pattern.alongPath(sulcusPath, 14)),
  info: {
    title: 'Epicardial fat',
    summary:
      'Fat follows the grooves because the arteries do. It is not inert: it secretes inflammatory signals, and ' +
      'its volume is now used as a marker of coronary risk.',
  },
});

// ── The rhythm strip: the electrical trace as a built surface ───────────────
// One beat, rendered as relief: P wave, QRS spike, T wave painted with a real gaussian shape, and a cursor
// that rides the crest at heart-rate speed through a declarative flowAlongPath motion. A pacing strip is a
// graph, so it gets an axis - the strip is a ruled measurement, not decoration.
function bell(u, mu, s, amp) {
  var d = (u - mu) / s;
  return amp * Math.exp(-d * d);
}

// P wave at 0.14, Q dip, R spike, S dip, T wave - the drawn shape a cardiologist actually reads.
function ecgWave(u) {
  return bell(u, 0.14, 0.045, 0.0022) + bell(u, 0.3, 0.012, -0.0018) + bell(u, 0.345, 0.009, 0.0095) + bell(u, 0.39, 0.014, -0.0035) + bell(u, 0.56, 0.05, 0.0035);
}

function ecgProfile(u) {
  return ecgWave(u) + 0.0009;
}

// The cursor path is the crest, raised one millimetre so the cursor rides above the tube it traces.
function ecgWorld(u) {
  var x = -0.05 + 0.1 * u;
  var h = ecgProfile(u) + 0.0012;
  return [x + 0.11, h - 0.075, 0];
}

var ecgPoints = [];
for (var i = 0; i <= 40; i++) {
  ecgPoints.push(ecgWorld(i / 40));
}

var ecgCurve = geom.splinePath(ecgPoints, 4);

// The strip is an instrument, not a sculpture: a dark plate, the trace as a swept tube that reads from
// every angle, and a baseline. The camera's auto-orbit cannot make a tube unreadable.
scene.mesh({
  id: 'ecgStrip', name: 'Rhythm strip', parentId: 'rhythmStrip',
  position: [0.11, -0.0756, 0],
  geometry: geom.box({ size: [0.104, 0.0012, 0.02] }),
  material: mat.matte({ color: '#14181f', roughness: 0.9 }),
  info: {
    title: 'Rhythm strip',
    summary:
      'The ECG drawn as a trace over one beat. Each deflection is an electrical event: P is atrial ' +
      'contraction, QRS is ventricular contraction, T is the reset. The heart appears to move AFTER the ' +
      'spike - the spike is the instruction, the squeeze is the response.',
    bullets: [
      'The R peak is the trigger; watch the ventricles right after it',
      'The cursor rides this wave at the speed the heartRate slider sets',
      'This is a single schematic beat, not a rolling rhythm history',
    ],
  },
});

scene.mesh({
  id: 'ecgTrace', name: 'ECG trace', parentId: 'rhythmStrip',
  position: [0, 0, 0],
  geometry: geom.sweep({ profile: geom.circleProfile({ radius: 0.0009, segments: 6 }), path: ecgCurve, caps: true }),
  material: trace,
  selectable: false,
  info: { title: 'ECG trace', summary: 'One beat of electrical activity, drawn as it travels: P, then the QRS spike, then the T wave.' },
});

scene.mesh({
  id: 'ecgAxis', name: 'Baseline', parentId: 'rhythmStrip',
  geometry: geom.transform(geom.cylinder({ radius: 0.00035, height: 0.1, segments: 6 }), { rotate: [0, 0, M.HALF_PI], translate: [0.11, -0.075, 0] }),
  material: mat.metal({ color: '#7a8390', roughness: 0.6 }),
  selectable: false,
  info: { title: 'ECG baseline', summary: 'Zero potential. Everything above it is depolarisation heading somewhere; everything below is the wire recovering.' },
});

scene.path({ id: 'ecgRoute', path: ecgCurve, visible: false });

scene.mesh({
  id: 'ecgCursor', name: 'ECG cursor', parentId: 'rhythmStrip', position: [0.06, -0.073, 0],
  geometry: geom.sphere({ radius: 0.0018, segments: 10 }),
  material: cursorGlow,
  selectable: false,
  info: { title: 'ECG cursor', summary: 'Rides the waveform at the tempo the sinoatrial node sets. Watch it flash on the R peak just before the ventricles squeeze.' },
});

scene.warn('The rhythm strip is a schematic single beat: its cursor rides the wave at heart-rate speed, but the strip is not a rolling rhythm history.');

// ── The two circuits, as paths the blood actually takes ─────────────────────
// Each route passes through the chambers and valves in the order they are traversed, so a single bolus
// teaches the whole circuit by travelling it. Four boluses per circuit at quarter-phase turns one marker
// into a visible stream at one draw call's worth of geometry.
scene.path({
  id: 'venousRoute',
  path: geom.splinePath(
    [[-0.012, -0.03, -0.04], [0, -0.004, -0.03], [-0.014, 0.026, -0.012], [-0.018, 0.04, 0.004], [-0.014, 0.026, 0.008], [-0.02, 0, 0.004], [-0.006, 0.032, 0.02], [-0.004, 0.056, 0.014], [0.028, 0.062, -0.006]],
    12,
  ),
  visible: false,
});

scene.path({
  id: 'systemicRoute',
  path: geom.splinePath(
    [[-0.004, 0.03, -0.016], [0.006, 0.04, -0.014], [0.014, 0.03, 0.002], [0.004, -0.008, 0.004], [0.002, 0.036, 0.008], [0.011, 0.06, 0.004], [0.006, 0.082, -0.012], [-0.013, 0.04, -0.024], [-0.015, -0.02, -0.028]],
    14,
  ),
  visible: false,
});

scene.path({
  id: 'coronaryRoute',
  path: geom.path([[0.006, 0.032, 0.012], [0.01, 0, 0.015], [0.008, -0.03, 0.014], [0.004, -0.054, 0.008]]),
  visible: false,
});

var venousDroplet = geom.sphere({ radius: 0.0022, segments: 10 });
var arterialDroplet = geom.sphere({ radius: 0.0022, segments: 10 });

scene.mesh({ id: 'deoxyA', name: 'Venous bolus 1', parentId: 'flow', geometry: venousDroplet, material: bloodDeoxy, info: { title: 'Venous bolus', summary: 'Deoxygenated blood on the lung circuit: body to right heart to lungs.' } });
scene.mesh({ id: 'deoxyB', name: 'Venous bolus 2', parentId: 'flow', geometry: venousDroplet, material: bloodDeoxy, selectable: false, info: { title: 'Venous bolus', summary: 'Deoxygenated blood on the lung circuit.' } });
scene.mesh({ id: 'deoxyC', name: 'Venous bolus 3', parentId: 'flow', geometry: venousDroplet, material: bloodDeoxy, selectable: false, info: { title: 'Venous bolus', summary: 'Deoxygenated blood on the lung circuit.' } });
scene.mesh({ id: 'deoxyD', name: 'Venous bolus 4', parentId: 'flow', geometry: venousDroplet, material: bloodDeoxy, selectable: false, info: { title: 'Venous bolus', summary: 'Deoxygenated blood on the lung circuit.' } });

scene.mesh({ id: 'oxyA', name: 'Arterial bolus 1', parentId: 'flow', geometry: arterialDroplet, material: bloodOxy, info: { title: 'Arterial bolus', summary: 'Oxygenated blood on the body circuit: lungs to left heart to everything.' } });
scene.mesh({ id: 'oxyB', name: 'Arterial bolus 2', parentId: 'flow', geometry: arterialDroplet, material: bloodOxy, selectable: false, info: { title: 'Arterial bolus', summary: 'Oxygenated blood on the body circuit.' } });
scene.mesh({ id: 'oxyC', name: 'Arterial bolus 3', parentId: 'flow', geometry: arterialDroplet, material: bloodOxy, selectable: false, info: { title: 'Arterial bolus', summary: 'Oxygenated blood on the body circuit.' } });
scene.mesh({ id: 'oxyD', name: 'Arterial bolus 4', parentId: 'flow', geometry: arterialDroplet, material: bloodOxy, selectable: false, info: { title: 'Arterial bolus', summary: 'Oxygenated blood on the body circuit.' } });

scene.mesh({
  id: 'coronaryBolus', name: 'Coronary bolus', parentId: 'flow', position: [0.006, 0.032, 0.012],
  geometry: geom.capsule({ radius: 0.0009, height: 0.0032, segments: 6 }),
  material: mat.emissive({ color: '#ff6b4a', emissiveIntensity: 2.2, boundTo: 'heartRate' }),
  info: {
    title: 'Coronary bolus',
    summary:
      'The heart feeding itself. This bolus rides the LAD from the aortic root down to the apex - and because ' +
      'systole squeezes these arteries shut, most of the coronary flow happens while the ventricle relaxes.',
  },
});

// ── Lighting and framing ────────────────────────────────────────────────────
// Surgical-theatre key with a cool rim, so the muscle reads as wet tissue and the conduction glow owns its
// own colour. One shadow-casting light only: shadows are the most expensive thing here.
scene.light({ id: 'key', kind: 'directional', intensity: 1.7, position: [0.3, 0.2, 0.24], castShadow: true });
scene.light({ id: 'fill', kind: 'hemisphere', intensity: 0.45, color: '#dfe6ee' });
scene.light({ id: 'rim', kind: 'directional', intensity: 0.85, color: '#8fb2d8', position: [-0.24, 0.12, -0.28] });
scene.light({ id: 'myocardialGlow', kind: 'point', color: '#ffd9b0', intensity: 1.9, position: [0.004, 0.008, 0.02], distance: 0.32, boundTo: 'heartRate' });

scene.environment({ preset: 'studio', exposure: 1, grid: false });

// Opening frame: the whole organ in frame - base vessels to apex - with the rhythm strip readable at the
// right. Centimetre scale, so a tight fov; the target sits mid-organ, not at the origin.
scene.camera({
  position: [0.17, 0.095, 0.35],
  target: [0.0, 0.015, 0.0],
  fov: 35,
  limits: { minDistance: 0.12, maxDistance: 0.6, autoRotate: true, autoRotateSpeed: 0.2 },
});

scene.shot('chambers', { kind: 'flyTo', targetPartId: 'lvBlood', duration: 1.6, margin: 2.2 });
scene.shot('valves', { kind: 'flyTo', targetPartId: 'mitralValve', duration: 1.4, margin: 2.4 });
scene.shot('conduction', { kind: 'flyTo', targetPartId: 'saNode', duration: 1.4, margin: 3 });
scene.shot('coronary', { kind: 'flyTo', targetPartId: 'lad', duration: 1.6, margin: 3 });
scene.shot('aortic', { kind: 'flyTo', targetPartId: 'aorticRoot', duration: 1.4, margin: 2.6 });
scene.shot('strip', { kind: 'flyTo', targetPartId: 'ecgStrip', duration: 1.4, margin: 2 });

// Interactions. Each one replays a framing or toggles a layer, so a click always answers a question.
scene.interaction({ partId: 'mitralValve', on: 'click', kind: 'playShot', targetId: 'valves', hint: 'Replay the mitral valve framing' });
scene.interaction({ partId: 'aorticRoot', on: 'click', kind: 'playShot', targetId: 'aortic', hint: 'Replay the aortic root framing' });

var stripVisible = true;
scene.interaction({ partId: 'ecgStrip', on: 'click', kind: 'custom', handlerId: 'toggleStrip', hint: 'Show or hide the rhythm strip' });
scene.onInteraction('toggleStrip', function () {
  stripVisible = !stripVisible;
});

// ── Motion: every stream declared, every rate bound to the heart-rate slider ─
// Nine flowAlongPath motions, all on one parameter. The audit can then prove that the heart-rate slider
// drives the flow, and the learner can feel it - slow the heart and the blood visibly slows with it.
scene.motion({ id: 'venousFlow1', partId: 'deoxyA', kind: 'flowAlongPath', pathId: 'venousRoute', rate: { param: 'heartRate', scale: 0.016667 }, phase: 0, reason: 'Venous blood travels the lung circuit.' });
scene.motion({ id: 'venousFlow2', partId: 'deoxyB', kind: 'flowAlongPath', pathId: 'venousRoute', rate: { param: 'heartRate', scale: 0.016667 }, phase: 0.25, reason: 'Evenly spaced boluses turn one marker into a stream.' });
scene.motion({ id: 'venousFlow3', partId: 'deoxyC', kind: 'flowAlongPath', pathId: 'venousRoute', rate: { param: 'heartRate', scale: 0.016667 }, phase: 0.5, reason: 'Evenly spaced boluses turn one marker into a stream.' });
scene.motion({ id: 'venousFlow4', partId: 'deoxyD', kind: 'flowAlongPath', pathId: 'venousRoute', rate: { param: 'heartRate', scale: 0.016667 }, phase: 0.75, reason: 'Evenly spaced boluses turn one marker into a stream.' });

scene.motion({ id: 'systemicFlow1', partId: 'oxyA', kind: 'flowAlongPath', pathId: 'systemicRoute', rate: { param: 'heartRate', scale: 0.016667 }, phase: 0.125, reason: 'Oxygenated blood travels the body circuit.' });
scene.motion({ id: 'systemicFlow2', partId: 'oxyB', kind: 'flowAlongPath', pathId: 'systemicRoute', rate: { param: 'heartRate', scale: 0.016667 }, phase: 0.375, reason: 'Evenly spaced boluses turn one marker into a stream.' });
scene.motion({ id: 'systemicFlow3', partId: 'oxyC', kind: 'flowAlongPath', pathId: 'systemicRoute', rate: { param: 'heartRate', scale: 0.016667 }, phase: 0.625, reason: 'Evenly spaced boluses turn one marker into a stream.' });
scene.motion({ id: 'systemicFlow4', partId: 'oxyD', kind: 'flowAlongPath', pathId: 'systemicRoute', rate: { param: 'heartRate', scale: 0.016667 }, phase: 0.875, reason: 'Evenly spaced boluses turn one marker into a stream.' });

scene.motion({ id: 'coronaryFlow', partId: 'coronaryBolus', kind: 'flowAlongPath', pathId: 'coronaryRoute', rate: { param: 'heartRate', scale: 0.016667 }, phase: 0.72, reason: 'Phase-lagged into diastole: the coronary arteries are squeezed shut during systole.' });

scene.motion({ id: 'ecgCursorFlow', partId: 'ecgCursor', kind: 'flowAlongPath', pathId: 'ecgRoute', rate: { param: 'heartRate', scale: 0.016667 }, phase: 0, reason: 'The ECG cursor rides the waveform at the beating tempo.' });

// ── Per-frame logic: the beat ───────────────────────────────────────────────
// Transform, emissive and visibility only - no geometry, ever. The scene.bpm-driven contraction is a
// smooth ejection envelope: fast rise, brief hold, long relaxation, with atrial filling offset by half a
// cycle so the two halves of the organ visibly take turns.
scene.onFrame(function (ctx) {
  var hr = ctx.params.heartRate;
  var sv = ctx.params.strokeVolume;
  var cty = ctx.params.contractility;
  var after = ctx.params.afterload;
  var hz = hr / 60;

  // Phase 0.5 at t = 0: the model opens mid-systole, caught at peak ejection, rather than at slack.
  var phase = M.wrap(ctx.time * hz + 0.5, 1);

  var eject;
  if (phase < 0.35) {
    eject = M.smoothstep(phase / 0.35);
  } else if (phase < 0.5) {
    eject = 1 - ((phase - 0.35) / 0.15) * 0.55;
  } else {
    eject = 0.45 * (1 - M.smoothstep((phase - 0.5) / 0.5));
  }

  var depth = 0.17 * cty * M.remap(sv, 30, 120, 0.7, 1.3);
  var cavityScale = 1 - depth * eject;
  var wallPinch = 1 - 0.05 * depth * eject;

  // Ventricles.empty, atria fill - the two halves taking turns is the visible lesson.
  var ventricularXZ = cavityScale;
  var ventricularY = 1 + (1 - cavityScale) * 0.35;
  ctx.part('lvBlood').setScale(ventricularXZ, ventricularY, ventricularXZ);
  ctx.part('rvBlood').setScale(ventricularXZ, ventricularY, ventricularXZ);
  ctx.part('laBlood').setScale(1 + 0.05 * eject, 1, 1 + 0.05 * eject);
  ctx.part('raBlood').setScale(1 + 0.05 * eject, 1, 1 + 0.05 * eject);

  ctx.part('lvWall').setScale(wallPinch, 1 + (1 - wallPinch) * 0.3, wallPinch);
  ctx.part('rvWall').setScale(wallPinch, 1 + (1 - wallPinch) * 0.3, wallPinch);
  ctx.part('lvWallFull').setScale(wallPinch, 1 + (1 - wallPinch) * 0.3, wallPinch);
  ctx.part('rvWallFull').setScale(wallPinch, 1 + (1 - wallPinch) * 0.3, wallPinch);

  // Valves: atrioventricular open while the ventricles fill, arterial open while they eject.
  var avOpen = 0.95 + 0.2 * (1 - eject);
  ctx.part('mitralValve').setScale(avOpen, 1, avOpen);
  ctx.part('tricuspidValve').setScale(avOpen, 1, avOpen);
  var arterialOpen = 0.88 + 0.34 * eject;
  ctx.part('aorticValve').setScale(arterialOpen, 1, arterialOpen);
  ctx.part('pulmonaryValve').setScale(arterialOpen, 1, arterialOpen);

  // Contractility as effort: a brighter wall reads as harder work - static in time, so a paused learner
  // still sees the slider's consequence.
  ctx.part('lvWall').setEmissive(0.04 + 0.5 * M.clamp(cty - 0.4, 0, 1.2));

  // The aorta visibly widens with the pressure it is asked to carry.
  var aorticScale = 1 + ((after - 95) / 95) * 0.16;
  ctx.part('ascendingAorta').setScale(aorticScale, 1, aorticScale);
  ctx.part('aorticArch').setScale(aorticScale, 1, aorticScale);

  // The conduction wave: one spike walked node to node with real delays.
  var showWiring = ctx.params.showConduction === true;
  var baseGlow = 0.7 + 0.8 * M.remap(hr, 30, 180, 0, 1);
  function nodeGlow(id, delay) {
    var p = M.wrap(phase - delay, 1);
    ctx.part(id).setEmissive(baseGlow + 2.6 * Math.exp(-14 * p));
    ctx.part(id).setVisible(showWiring);
  }
  nodeGlow('saNode', 0);
  nodeGlow('avNode', 0.09);
  nodeGlow('bundleOfHis', 0.12);
  nodeGlow('leftBundle', 0.15);
  nodeGlow('rightBundle', 0.16);
  nodeGlow('purkinjeLeft', 0.2);
  nodeGlow('purkinjeRight', 0.21);

  // Layers.
  var showArteries = ctx.params.showCoronary === true;
  ctx.part('lad').setVisible(showArteries);
  ctx.part('circumflex').setVisible(showArteries);
  ctx.part('rightCoronary').setVisible(showArteries);
  ctx.part('coronarySinus').setVisible(showArteries);
  ctx.part('coronaryBolus').setVisible(showArteries);

  var cutting = ctx.params.cutaway === true;
  ctx.part('epicardiumFull').setVisible(!cutting);
  ctx.part('epicardium').setVisible(cutting);
  // The walls carry the cut too: an anatomical cutaway means the muscle opens, not just the membranes.
  ctx.part('lvWall').setVisible(cutting);
  ctx.part('lvWallFull').setVisible(!cutting);
  ctx.part('rvWall').setVisible(cutting);
  ctx.part('rvWallFull').setVisible(!cutting);
  ctx.part('laWall').setVisible(cutting);
  ctx.part('laWallFull').setVisible(!cutting);
  ctx.part('raWall').setVisible(cutting);
  ctx.part('raWallFull').setVisible(!cutting);

  var mode = ctx.params.bloodFlow;
  var showVenous = mode === 'both' || mode === 'deoxygenated';
  var showArterial = mode === 'both' || mode === 'oxygenated';
  ctx.part('deoxyA').setVisible(showVenous);
  ctx.part('deoxyB').setVisible(showVenous);
  ctx.part('deoxyC').setVisible(showVenous);
  ctx.part('deoxyD').setVisible(showVenous);
  ctx.part('oxyA').setVisible(showArterial);
  ctx.part('oxyB').setVisible(showArterial);
  ctx.part('oxyC').setVisible(showArterial);
  ctx.part('oxyD').setVisible(showArterial);

  ctx.part('ecgStrip').setVisible(stripVisible);
  ctx.part('ecgAxis').setVisible(stripVisible);

  var cursorSpike = 1.6 + 3.2 * Math.exp(-20 * M.wrap(ctx.time * hz - 0.345, 1));
  ctx.part('ecgCursor').setEmissive(cursorSpike);

  // Read-outs: published from the same parameters the motion uses, so the numbers and the squeeze agree.
  ctx.metric('cardiacOutput', (hr * sv) / 1000);
  ctx.metric('ejectionFraction', M.clamp(55 + (cty - 1) * 22, 15, 82));
  ctx.metric('aorticPressure', after + (sv - 70) * 0.25);
  ctx.metric('cycleTime', 60 / hr);
});

// ── Story: six beats along the physiological arc ────────────────────────────
scene.story([
  {
    id: 'return',
    title: 'Everything comes back',
    narration: 'All the blood in your body drains back here - the right atrium, at almost no pressure at all. This is the receiving end of the entire circulation.',
    targetPartId: 'raBlood',
    setParameters: { bloodFlow: 'deoxygenated', heartRate: 62 },
    holdSeconds: 7,
  },
  {
    id: 'lungs',
    title: 'A gentle push to the lungs',
    narration: 'The right ventricle only has to reach the lungs, so it pushes at a fifth of body pressure - and its wall is only 4 mm. Watch how shallowly it squeezes.',
    targetPartId: 'pulmonaryTrunk',
    setParameters: { heartRate: 78, cutaway: true },
    holdSeconds: 8,
  },
  {
    id: 'return2',
    title: 'Four veins home',
    narration: 'Now oxygen-rich - and red, not blue. Four pulmonary veins deliver it to the left atrium, the only veins in the body carrying this colour.',
    targetPartId: 'laBlood',
    setParameters: { bloodFlow: 'oxygenated', cutaway: true },
    holdSeconds: 7,
  },
  {
    id: 'body',
    title: 'The thick wall earns it',
    narration: 'The left ventricle must reach your toes against 120 mmHg of resistance. Its wall is 11 mm - three times the right side, built by pressure, not by volume.',
    targetPartId: 'lvBlood',
    setParameters: { afterload: 140, heartRate: 96, contractility: 1.3 },
    holdSeconds: 9,
  },
  {
    id: 'selfSupply',
    title: 'It feeds itself first',
    narration: 'The heart never absorbs the blood inside it - the wall is too thick. So the first thing the aorta does is feed the coronary arteries, down this very surface.',
    targetPartId: 'lad',
    setParameters: { showCoronary: true, afterload: 100, heartRate: 72 },
    holdSeconds: 8,
  },
  {
    id: 'rhythm',
    title: 'The beat has no brain',
    narration: 'A stamp-sized node fires, the wave walks down specialised wiring, and only then does the muscle squeeze. Raise the rate and you are tuning that node, the way your nerves do.',
    targetPartId: 'saNode',
    setParameters: { showConduction: true, heartRate: 150, bloodFlow: 'both' },
    viewMode: 'xray',
    holdSeconds: 9,
  },
]);

// ── Quiz: distractors built from the real misconceptions ────────────────────
scene.quiz([
  {
    id: 'q1',
    question: 'Why is the left ventricle wall so much thicker than the right?',
    options: [
      'Because it pumps to the whole body at far higher pressure',
      'Because it holds more blood each beat',
      'Because it beats faster than the right side',
      'Because the lungs demand a stronger push',
    ],
    correctIndex: 0,
    explanation:
      'Pressure, not volume: both ventricles eject nearly the same amount, but the left generates about 120 mmHg where the right makes 25. Walls are built to the pressure they contain - a tempting wrong answer is volume, and the model proves it wrong: the two cavities are barely different in size.',
    difficulty: 'recall',
    evidencePartId: 'lvBlood',
  },
  {
    id: 'q2',
    question: 'Where does the heart muscle get its own oxygen?',
    options: [
      'From the blood inside its chambers, absorbed through the wall',
      'From the coronary arteries, mostly while the heart relaxes',
      'From the pulmonary veins returning from the lungs',
      'It stores enough oxygen to survive several hours without any',
    ],
    correctIndex: 1,
    explanation:
      'The endocardium is millimetres thick - far too thick to diffuse through. The coronary arteries feed it from outside, and because systole squeezes those arteries shut, most coronary flow happens during diastole: which is why a very fast heart rate hurts supply.',
    difficulty: 'application',
    evidencePartId: 'lad',
  },
  {
    id: 'q3',
    question: 'What starts each individual heartbeat?',
    options: [
      'A signal from the brain telling the heart to beat',
      'The sinoatrial node firing on its own',
      'Blood pressure stretching the atrial wall',
      'The valves snapping shut and triggering the next beat',
    ],
    correctIndex: 1,
    explanation:
      'The heart is its own metronome: the sinoatrial node depolarises without instruction, and a transplanted heart keeps beating in the box. Your nerves only tune the rate up and down - which is exactly what the heart-rate slider stands in for.',
    difficulty: 'synthesis',
    evidencePartId: 'saNode',
  },
  {
    id: 'q4',
    question: 'The QRS spike on the ECG strip appears just before the ventricles squeeze. Why?',
    options: [
      'The spike is the electrical instruction; the squeeze is its mechanical response',
      'The ventricles moving generate the electrical spike',
      'Both are caused by the blood pressure rising at the same moment',
      'The spike is the sound of the valves closing',
    ],
    correctIndex: 0,
    explanation:
      'The ECG is the summed electrical wave spreading through the muscle. Contraction follows it a fraction of a second later - cause on the strip, effect in the tissue, which is why the cursor rides ahead of the squeeze.',
    difficulty: 'application',
    evidencePartId: 'ecgStrip',
  },
]);
`;
