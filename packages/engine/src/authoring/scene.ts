/**
 * The `scene` namespace: the authoring API the AI's program is written against.
 *
 * This is the product. `00-GOAL.md`: "The scene API design — this is the product. What the API exposes is what
 * the AI can build."
 *
 * It is the first half of the two-stage build in `PLAN.md` §A2. The program runs *once* against this surface
 * and produces two things: a `ModelManifest` (pure data, serialisable, GPU-free) and a set of registered
 * callbacks that stay live in the sandbox realm for per-frame work. Nothing here creates a Three.js object, so
 * the same code path runs in the browser worker and in `node:vm` for the headless audit — which is what makes
 * server-side auditing, admission pricing and provable parameter leverage possible at all.
 *
 * Design rules that show up everywhere below:
 *
 *  - **Declare, then react.** Structure is declared once; behaviour that must vary per frame goes through
 *    `onFrame`, which receives capability-scoped handles so every write is attributable to a declared target.
 *  - **Every id is checked at the boundary.** A duplicate or malformed id is a hard error with a sentence the
 *    repair pass can act on, because a dangling reference discovered at render time is much harder to explain.
 *  - **Warnings, not silent fixes.** Clamped values and dropped duplicates are recorded on the manifest so the
 *    diagnostics panel and the audit can both see what the engine changed.
 */
import {
  type BuildCost,
  type CameraPose,
  type Domain,
  type InteractionDecl,
  type MetricDecl,
  type ModelManifest,
  type MotionDecl,
  type ParameterDecl,
  type PartNode,
  type PathDecl,
  type Pedagogy,
  type PhysicsDecl,
  type QuizQuestion,
  type ShotDecl,
  type StoryBeat,
  MAX_INSTANCES_PER_SET,
  MAX_PARTS,
  PhysicsDecl as PhysicsDeclSchema,
} from '@edu3d/contracts';
import { GeometryFactory, type GeometryHandle, type PathHandle } from '../geometry/factory.ts';
import { MaterialFactory, type MaterialHandle } from '../materials/factory.ts';
import type { Placement } from '../geometry/patterns.ts';
import { clamp } from '../math/index.ts';

/** Thrown when a program declares something the engine must refuse. Messages address the generator. */
export class SceneError extends Error {
  /** Class field ([[Define]] semantics): survives the frozen Error.prototype after realm hardening, where a constructor assignment ([[Set]]) throws. */
  override name = 'SceneError';
  constructor(message: string) {
    super(message);
  }
}

const ID_PATTERN = /^[A-Za-z][A-Za-z0-9_.-]*$/;

/**
 * A per-frame handle onto one declared part.
 *
 * The narrow write surface that makes parameter leverage provable: every setter records which channel it
 * touched, so the dry-run sweep in `04` can report "the temperature parameter changes nothing visible" as a
 * fact rather than a suspicion.
 */
export interface PartRef {
  readonly id: string;
  setPosition(x: number, y: number, z: number): void;
  setRotation(x: number, y: number, z: number): void;
  setScale(x: number, y: number, z: number): void;
  setVisible(visible: boolean): void;
  /** Emissive intensity, for the "model as its own instrument" binding. */
  setEmissive(intensity: number): void;
  setOpacity(opacity: number): void;
  setColor(hex: string): void;
  /** Current authored position, so incremental motion can read before it writes. */
  position(): readonly [number, number, number];
  rotation(): readonly [number, number, number];
}

/** What a frame callback receives. Deliberately small: a clock, the parameters, and part handles. */
export interface FrameContext {
  /** Seconds since the model started, authored time — unaffected by the render rate (`02` R4). */
  readonly time: number;
  /** Seconds since the previous frame, already clamped by the host so a backgrounded tab cannot jump. */
  readonly dt: number;
  readonly paused: boolean;
  /** Live parameter values by id. */
  readonly params: Readonly<Record<string, number | boolean | string>>;
  /** Physics measurements published by the solver, by probe id (`02` R6). */
  readonly probes: Readonly<Record<string, number>>;
  part(id: string): PartRef;
  /** Publish a derived value so the UI read-out and the motion cannot disagree (`00`). */
  metric(id: string, value: number): void;
  /** Retarget a joint motor while the scene runs (`02` R5). */
  motor(jointId: string, targetVelocity: number): void;
}

/** Registered callbacks, kept in the realm rather than serialised. */
export interface CallbackTable {
  frame: Array<(ctx: FrameContext) => void>;
  parameterChange: Array<(id: string, value: number | boolean | string) => void>;
  select: Array<(partId: string) => void>;
  interactions: Map<string, (partId: string) => void>;
}

/** Which channels each parameter was observed to write, filled by the dry-run sweep. */
export type ObservedWrites = Map<string, Set<string>>;

/**
 * One recorded sweep point: the quantised observable state of the whole model, and the time it
 * was sampled at. Consumers compare points *within the same time* only (see `SWEEP_TIMES` in the
 * audit) — comparing across times would make every time-driven write read as parameter causality.
 */
export interface SweepPoint {
  time: number;
  state: string;
}

/**
 * Decimal places a swept value is rounded to before sweep points are compared.
 *
 * Models are authored in metres, radians, 0–1 opacity and 0–64 emissive intensity, so three
 * decimals puts the change threshold at a millimetre / milliradian / a thousandth of a unit — far
 * below the smallest effect a learner can see (the reference model's subtlest binding moves a
 * channel by ~0.02) and far above the float jitter of recomputing the same expression, which is
 * exactly the band an honest differential sweep must draw its line in.
 */
const SWEEP_QUANTUM_DECIMALS = 3;

/** Quantise one number to the sweep's comparison precision, normalising −0 so it equals 0. */
const quantise = (value: number): number => {
  const scaled = Math.round(value * 10 ** SWEEP_QUANTUM_DECIMALS) / 10 ** SWEEP_QUANTUM_DECIMALS;
  return Object.is(scaled, -0) ? 0 : scaled;
};

interface PartRecord {
  node: PartNode;
  /** Set on any frame that wrote to this part, so the audit can see which parts are actually alive. */
  touchedChannels: Set<string>;
}

/**
 * The scene builder.
 *
 * Holds every declaration the program makes, then emits a validated manifest. One instance per build; disposing
 * it releases the geometry and material caches with it.
 */
export class SceneBuilder {
  readonly geometry = new GeometryFactory();
  readonly materials = new MaterialFactory();

  private readonly parts = new Map<string, PartRecord>();
  private readonly order: string[] = [];
  private readonly parameters = new Map<string, ParameterDecl>();
  private readonly parameterValues = new Map<string, number | boolean | string>();
  private readonly metrics = new Map<string, MetricDecl>();
  private readonly metricValues = new Map<string, number>();
  private readonly motions: MotionDecl[] = [];
  private readonly paths = new Map<string, PathDecl>();
  private readonly interactions: InteractionDecl[] = [];
  private readonly lights: ModelManifest['lights'][number][] = [];
  private readonly shots = new Map<string, ShotDecl>();
  private readonly story: StoryBeat[] = [];
  private readonly quiz: QuizQuestion[] = [];
  private readonly components = new Map<string, (ctx: ComponentContext) => void>();
  private readonly warnings: string[] = [];

  private describeCalled = false;
  private name = 'Untitled model';
  private description = '';
  private domain: Domain = 'other';
  private subdomain: string | undefined;
  private pedagogy: Pedagogy | undefined;
  private cameraPose: CameraPose | undefined;
  private cameraLimits: ModelManifest['camera']['limits'] | undefined;
  private environment: ModelManifest['environment'] | undefined;
  private physics: PhysicsDecl | undefined;

  /** The active parent while a component body runs, so `place` can nest without the author passing parents. */
  private parentStack: string[] = [];

  readonly callbacks: CallbackTable = {
    frame: [],
    parameterChange: [],
    select: [],
    interactions: new Map(),
  };

  /** Channels each parameter wrote during a dry run, keyed by parameter id. */
  readonly observedWrites: ObservedWrites = new Map();
  /** The parameter currently being swept, so writes can be attributed to it. */
  private sweepingParameter: string | null = null;

  /**
   * Quantised model state at each sweep point, keyed by parameter id — the evidence the
   * differential sweep compares. A parameter is causally live only if these states differ between
   * points sampled at the same time; write presence alone proves nothing, because a frame
   * callback writes every frame regardless of any parameter's value.
   */
  readonly sweepStates: Map<string, SweepPoint[]> = new Map();

  /**
   * The authored state every sweep point starts from: parameter values, part transforms,
   * visibility, materials, metrics and motor targets, deep-copied at the first sweep call.
   *
   * Restoring it before each point is what makes a point's snapshot a pure function of
   * (parameter value, sample time). Without the restore, incremental frame code
   * (`rotation += rate·dt`) accumulates across points and every parameter looks live — the same
   * false pass the differential sweep exists to remove, arriving through the back door.
   */
  private sweepBaseline: {
    parameterValues: Array<[string, number | boolean | string]>;
    parts: Array<
      [
        string,
        {
          position: [number, number, number];
          rotation: [number, number, number] | undefined;
          scale: [number, number, number];
          visible: boolean;
          /** The authored material reference; sweep-time setters fork copies, so this object is never mutated. */
          material: PartNode['material'];
        },
      ]
    >;
    metrics: Array<[string, number]>;
    motors: Array<[string, number]>;
  } | null = null;

  private authorStart = 0;

  dispose(): void {
    this.geometry.dispose();
    this.materials.dispose();
    this.parts.clear();
    this.order.length = 0;
    this.parameters.clear();
    this.callbacks.frame.length = 0;
    this.callbacks.parameterChange.length = 0;
    this.callbacks.select.length = 0;
    this.callbacks.interactions.clear();
  }

  // ── Validation helpers ────────────────────────────────────────────────────

  private requireId(value: unknown, what: string): string {
    if (typeof value !== 'string' || !ID_PATTERN.test(value) || value.length > 64) {
      throw new SceneError(
        `${what} must be an id starting with a letter and containing only letters, digits, '_', '.' or '-'. Received ${typeof value === 'string' ? `'${value}'` : typeof value}.`,
      );
    }
    return value;
  }

  private requireText(value: unknown, what: string, max: number): string {
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new SceneError(`${what} must be a non-empty string.`);
    }
    if (value.length > max) {
      this.warnings.push(`${what} was truncated from ${value.length} to ${max} characters.`);
      return value.slice(0, max);
    }
    return value;
  }

  private optionalNumber(value: unknown, what: string): number | undefined {
    if (value === undefined) return undefined;
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new SceneError(`${what} must be a finite number. Received ${String(value)}.`);
    }
    return value;
  }

  private vec3(
    value: unknown,
    what: string,
    fallback?: readonly [number, number, number],
  ): [number, number, number] {
    if (value === undefined && fallback) return [...fallback] as [number, number, number];
    if (!Array.isArray(value) || value.length < 3) {
      throw new SceneError(`${what} must be [x, y, z].`);
    }
    const out: [number, number, number] = [0, 0, 0];
    for (let i = 0; i < 3; i += 1) {
      const component = value[i];
      if (typeof component !== 'number' || !Number.isFinite(component)) {
        throw new SceneError(
          `${what}[${i}] must be a finite number. Received ${String(component)}.`,
        );
      }
      out[i] = component;
    }
    return out;
  }

  /** Register a part, rejecting duplicates and unknown parents. */
  private addPart(node: PartNode): string {
    if (this.parts.has(node.id)) {
      throw new SceneError(
        `Part id '${node.id}' is already used. Every part needs a unique id — append an index when placing repeated parts.`,
      );
    }
    if (this.parts.size >= MAX_PARTS) {
      throw new SceneError(
        `This model declares more than ${MAX_PARTS} parts. Use scene.instances() for repeated geometry instead of one part each.`,
      );
    }
    if (node.parentId !== null && !this.parts.has(node.parentId)) {
      throw new SceneError(
        `Part '${node.id}' names parent '${node.parentId}', which has not been created yet. Declare parents before children.`,
      );
    }
    this.parts.set(node.id, { node, touchedChannels: new Set() });
    this.order.push(node.id);
    return node.id;
  }

  /** Resolve the effective parent: explicit argument, else the enclosing component, else the root. */
  private resolveParent(explicit: unknown, forId: string): string | null {
    if (explicit === null) return null;
    if (typeof explicit === 'string') {
      const parent = this.requireId(explicit, `part '${forId}' parentId`);
      if (!this.parts.has(parent)) {
        throw new SceneError(
          `Part '${forId}' names parent '${parent}', which does not exist. Declare the parent group first.`,
        );
      }
      return parent;
    }
    const enclosing = this.parentStack[this.parentStack.length - 1];
    if (enclosing) return enclosing;
    // The first part declared with no parent becomes the root; later orphans attach to it, because a manifest
    // with two roots cannot be framed or exploded coherently.
    const existingRoot = this.order.find((id) => this.parts.get(id)?.node.parentId === null);
    return existingRoot ?? null;
  }

  private transform(spec: Record<string, unknown>): PartNode['transform'] {
    return {
      position: this.vec3(spec.position, 'position', [0, 0, 0]),
      ...(spec.rotation !== undefined ? { rotation: this.vec3(spec.rotation, 'rotation') } : {}),
      scale:
        spec.scale === undefined
          ? [1, 1, 1]
          : typeof spec.scale === 'number'
            ? [spec.scale, spec.scale, spec.scale]
            : this.vec3(spec.scale, 'scale'),
    };
  }

  private info(spec: unknown, partId: string): PartNode['info'] | undefined {
    if (!spec || typeof spec !== 'object') return undefined;
    const source = spec as Record<string, unknown>;
    if (source.title === undefined) return undefined;
    return {
      title: this.requireText(source.title, `part '${partId}' info.title`, 120),
      ...(typeof source.summary === 'string' && source.summary.trim().length > 0
        ? { summary: source.summary.slice(0, 1200) }
        : {}),
      bullets: Array.isArray(source.bullets)
        ? source.bullets
            .filter((item): item is string => typeof item === 'string')
            .slice(0, 8)
            .map((item) => item.slice(0, 240))
        : [],
      tags: Array.isArray(source.tags)
        ? source.tags
            .filter((item): item is string => typeof item === 'string')
            .slice(0, 12)
            .map((item) => item.slice(0, 32))
        : [],
      facts: Array.isArray(source.facts)
        ? (source.facts as Array<Record<string, unknown>>)
            .filter((fact) => typeof fact?.label === 'string' && typeof fact?.value === 'string')
            .slice(0, 12)
            .map((fact) => ({
              label: String(fact.label).slice(0, 48),
              value: String(fact.value).slice(0, 64),
            }))
        : [],
    };
  }

  /** Record that a channel was written, and attribute it to the parameter being swept, if any. */
  private noteWrite(partId: string, channel: string): void {
    const record = this.parts.get(partId);
    if (record) record.touchedChannels.add(channel);
    if (this.sweepingParameter) {
      const set = this.observedWrites.get(this.sweepingParameter) ?? new Set<string>();
      set.add(channel);
      this.observedWrites.set(this.sweepingParameter, set);
    }
  }

  // ── Dry-run support, used by the audit ────────────────────────────────────

  /**
   * Set a parameter, run the reaction and frame callbacks, and record the *observable state* the
   * point produced — not just which channels were written.
   *
   * The frame dispatch stays (deliberately): many legitimate models drive parameters from inside
   * `onFrame` (`00:206` endorses exactly that), and removing it would false-flag every one of
   * them. What changed is the verdict the audit draws: writes are coincidental evidence (a frame
   * callback writes every frame regardless of parameter values); the *differential* between
   * points' recorded states is the causal proof.
   */
  sweepParameter(id: string, value: number | boolean | string, ctxTime = 0): void {
    if (!this.parameters.has(id)) return;
    this.sweepBaseline ??= this.captureSweepBaseline();
    this.restoreSweepBaseline();
    this.parameterValues.set(id, value);
    this.sweepingParameter = id;
    try {
      for (const callback of this.callbacks.parameterChange) callback(id, value);
      const ctx = this.createFrameContext(ctxTime, 1 / 60, false);
      for (const callback of this.callbacks.frame) callback(ctx);
      const points = this.sweepStates.get(id) ?? [];
      points.push({ time: ctxTime, state: this.sweepStateSignature() });
      this.sweepStates.set(id, points);
    } finally {
      this.sweepingParameter = null;
    }
  }

  /**
   * Restore the authored state after sweeping, so the manifest the audit returns — and anything
   * that inspects the builder afterwards — sees the model as built, not as the last sweep point
   * left it.
   */
  endParameterSweep(): void {
    if (!this.sweepBaseline) return;
    this.restoreSweepBaseline();
  }

  /** Snapshot the authored state the first sweep finds, before any point has mutated it. */
  private captureSweepBaseline() {
    return {
      parameterValues: [...this.parameterValues.entries()],
      parts: this.order.map((id) => {
        const node = (this.parts.get(id) as PartRecord).node;
        return [
          id,
          {
            position: [...node.transform.position] as [number, number, number],
            rotation: node.transform.rotation
              ? ([...node.transform.rotation] as [number, number, number])
              : undefined,
            scale: [...node.transform.scale] as [number, number, number],
            visible: node.visible,
            material: node.material,
          },
        ] as [
          string,
          {
            position: [number, number, number];
            rotation: [number, number, number] | undefined;
            scale: [number, number, number];
            visible: boolean;
            material: PartNode['material'];
          },
        ];
      }),
      metrics: [...this.metricValues.entries()],
      motors: [...this.motorTargets.entries()],
    };
  }

  /** Put the baseline back: parameters, transforms, visibility, materials, metrics, motors. */
  private restoreSweepBaseline(): void {
    if (!this.sweepBaseline) return;
    this.parameterValues.clear();
    for (const [key, value] of this.sweepBaseline.parameterValues) this.parameterValues.set(key, value);
    for (const [id, entry] of this.sweepBaseline.parts) {
      const record = this.parts.get(id);
      if (!record) continue;
      record.node.transform.position = [...entry.position];
      record.node.transform.rotation = entry.rotation ? [...entry.rotation] : undefined;
      record.node.transform.scale = [...entry.scale];
      record.node.visible = entry.visible;
      record.node.material = entry.material;
    }
    this.metricValues.clear();
    for (const [key, value] of this.sweepBaseline.metrics) this.metricValues.set(key, value);
    this.motorTargets.clear();
    for (const [key, value] of this.sweepBaseline.motors) this.motorTargets.set(key, value);
  }

  /**
   * Serialise the observable state every part channel a frame callback can write — transform,
   * visibility, material color/emissive/opacity — plus published metrics and motor targets, with
   * numbers quantised. A deterministic string per point is all the comparison needs: same string
   * at every point of one time slice means the swept parameter changed nothing visible.
   */
  private sweepStateSignature(): string {
    const snapshot: unknown[] = [];
    for (const id of this.order) {
      const node = (this.parts.get(id) as PartRecord).node;
      snapshot.push([
        id,
        node.transform.position.map(quantise),
        (node.transform.rotation ?? [0, 0, 0]).map(quantise),
        node.transform.scale.map(quantise),
        node.visible ? 1 : 0,
        node.material?.color ?? null,
        node.material?.emissiveIntensity !== undefined
          ? quantise(node.material.emissiveIntensity)
          : null,
        node.material?.opacity !== undefined ? quantise(node.material.opacity) : null,
      ]);
    }
    snapshot.push([...this.metricValues.entries()].map(([key, value]) => [key, quantise(value)]));
    snapshot.push([...this.motorTargets.entries()].map(([key, value]) => [key, quantise(value)]));
    return JSON.stringify(snapshot);
  }

  /** Run one frame without attributing writes — used to check liveliness. */
  runFrame(time: number, dt = 1 / 60, paused = false): void {
    const ctx = this.createFrameContext(time, dt, paused);
    for (const callback of this.callbacks.frame) callback(ctx);
  }

  /**
   * Publish solver measurements, so `ctx.probes` in the next frame carries what the solver actually
   * did (`02` R6: "numbers on screen and motion on screen must never disagree").
   */
  publishProbes(probes: Readonly<Record<string, number>>): void {
    this.publishedProbes = { ...probes };
  }

  /** Probes from the most recent solver step; read into every frame context. */
  private publishedProbes: Readonly<Record<string, number>> = {};

  /** Parts whose channels were written during any frame — the audit's liveliness evidence. */
  touchedParts(): Map<string, Set<string>> {
    const result = new Map<string, Set<string>>();
    for (const [id, record] of this.parts) {
      if (record.touchedChannels.size > 0) result.set(id, record.touchedChannels);
    }
    return result;
  }

  /**
   * Build the per-frame context handed to callbacks.
   *
   * Recreated per frame but shallow: the `params` object is a live proxy over the value map rather than a copy,
   * because copying 24 parameters every frame is the kind of per-frame allocation `08` bans from the hot path.
   */
  createFrameContext(time: number, dt: number, paused: boolean): FrameContext {
    const params = new Proxy(
      {},
      {
        get: (_target, key: string) => this.parameterValues.get(key),
        has: (_target, key: string) => this.parameterValues.has(key),
        ownKeys: () => [...this.parameterValues.keys()],
        getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true }),
      },
    ) as Readonly<Record<string, number | boolean | string>>;

    const partRefCache = new Map<string, PartRef>();

    const makePartRef = (id: string): PartRef => {
      const record = this.parts.get(id);
      if (!record) {
        throw new SceneError(
          `ctx.part('${id}') does not exist. Check the id matches a part declared during the build.`,
        );
      }
      const node = record.node;
      return {
        id,
        setPosition: (x, y, z) => {
          if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return;
          node.transform.position = [x, y, z];
          this.noteWrite(id, 'transform');
        },
        setRotation: (x, y, z) => {
          if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return;
          node.transform.rotation = [x, y, z];
          this.noteWrite(id, 'transform');
        },
        setScale: (x, y, z) => {
          if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return;
          node.transform.scale = [x, y, z];
          this.noteWrite(id, 'transform');
        },
        setVisible: (visible) => {
          node.visible = !!visible;
          this.noteWrite(id, 'visibility');
        },
        setEmissive: (intensity) => {
          if (!Number.isFinite(intensity)) return;
          if (node.material)
            node.material = { ...node.material, emissiveIntensity: clamp(intensity, 0, 64) };
          this.noteWrite(id, 'material');
        },
        setOpacity: (opacity) => {
          if (!Number.isFinite(opacity)) return;
          if (node.material) node.material = { ...node.material, opacity: clamp(opacity, 0, 1) };
          this.noteWrite(id, 'material');
        },
        setColor: (hex) => {
          if (typeof hex !== 'string' || !/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(hex)) return;
          if (node.material) node.material = { ...node.material, color: hex };
          this.noteWrite(id, 'material');
        },
        position: () => node.transform.position,
        rotation: () => node.transform.rotation ?? [0, 0, 0],
      };
    };

    return {
      time,
      dt,
      paused,
      params,
      probes: this.publishedProbes,
      part: (id: string) => {
        const cached = partRefCache.get(id);
        if (cached) return cached;
        const ref = makePartRef(id);
        partRefCache.set(id, ref);
        return ref;
      },
      metric: (id: string, value: number) => {
        if (!Number.isFinite(value)) return;
        this.metricValues.set(id, value);
        this.noteWrite('__metrics', 'metric');
      },
      motor: (jointId: string, targetVelocity: number) => {
        if (!Number.isFinite(targetVelocity)) return;
        // Recorded as a physics write; the physics world reads the value on its next step.
        this.motorTargets.set(jointId, targetVelocity);
        this.noteWrite('__physics', 'physics');
      },
    };
  }

  /** Live motor targets, read by the physics world each step (`02` R5: retargetable at runtime). */
  readonly motorTargets = new Map<string, number>();

  /** Current metric values, for the UI read-out. */
  currentMetrics(): Record<string, number> {
    return Object.fromEntries(this.metricValues);
  }

  /** Current parameter values, for the panel and for the manifest's defaults round-trip. */
  currentParameters(): Record<string, number | boolean | string> {
    return Object.fromEntries(this.parameterValues);
  }

  /** Apply a parameter change from the UI, notifying the model's own reaction callbacks. */
  setParameter(id: string, value: number | boolean | string): void {
    if (!this.parameters.has(id)) return;
    this.parameterValues.set(id, value);
    for (const callback of this.callbacks.parameterChange) callback(id, value);
  }

  // ── The facade ────────────────────────────────────────────────────────────

  createFacade(): Readonly<Record<string, unknown>> {
    const facade = {
      /**
       * Declare what the model is and what it teaches.
       *
       * Required. `01`'s design order starts with the concept, and the audit checks the story and parts against
       * the objectives declared here — a model that declares nothing cannot be checked for teaching anything.
       */
      describe: (spec: {
        name: string;
        description: string;
        domain?: Domain;
        subdomain?: string;
        concept: string;
        objectives: string[];
        level?: 'primary' | 'secondary' | 'undergraduate' | 'expert';
        principles?: string[];
        simplifications?: string[];
        relationships?: Array<{ from: string; to: string; kind: string; note?: string }>;
      }): void => {
        this.name = this.requireText(spec?.name, 'describe.name', 120);
        this.description = this.requireText(spec?.description, 'describe.description', 2000);
        this.domain = (spec?.domain ?? 'other') as Domain;
        this.subdomain =
          typeof spec?.subdomain === 'string' ? spec.subdomain.slice(0, 80) : undefined;

        const objectives = Array.isArray(spec?.objectives)
          ? spec.objectives.filter(
              (item): item is string => typeof item === 'string' && item.trim().length > 0,
            )
          : [];
        if (objectives.length === 0) {
          throw new SceneError(
            'describe.objectives must list at least one thing the learner should be able to do after using this model.',
          );
        }

        this.pedagogy = {
          concept: this.requireText(spec?.concept, 'describe.concept', 240),
          objectives: objectives.slice(0, 8).map((item) => item.slice(0, 240)),
          studentLevel: spec?.level ?? 'secondary',
          principles: (spec?.principles ?? [])
            .slice(0, 8)
            .map((item) => String(item).slice(0, 200)),
          simplifications: (spec?.simplifications ?? [])
            .slice(0, 8)
            .map((item) => String(item).slice(0, 240)),
          relationships: (spec?.relationships ?? []).slice(0, 64).map((item) => ({
            from: String(item.from).slice(0, 64),
            to: String(item.to).slice(0, 64),
            kind: String(item.kind).slice(0, 48),
            ...(item.note ? { note: String(item.note).slice(0, 200) } : {}),
          })),
        };
        this.describeCalled = true;
      },

      /**
       * Declare a colour role — the semantic system the learner learns to read (`01`).
       *
       * "After a minute, the learner stops reading labels and starts reading *colour as category* — that is the
       * win."
       */
      colorRole: (spec: { id: string; label: string; color: string; meaning: string }): void => {
        this.materials.declareRole({
          id: this.requireId(spec?.id, 'colorRole.id'),
          label: this.requireText(spec?.label, 'colorRole.label', 48),
          color: spec.color as `#${string}`,
          meaning: this.requireText(spec?.meaning, 'colorRole.meaning', 120),
        });
      },

      /** A container node. Groups should follow function, so selecting a group selects a concept (`01`). */
      group: (spec: {
        id: string;
        name?: string;
        parentId?: string | null;
        position?: unknown;
        rotation?: unknown;
        scale?: unknown;
        group?: string;
      }): string => {
        const id = this.requireId(spec?.id, 'group.id');
        return this.addPart({
          id,
          parentId: this.resolveParent(spec?.parentId, id),
          kind: 'group',
          name: typeof spec?.name === 'string' ? spec.name.slice(0, 120) : id,
          ...(spec?.group ? { group: String(spec.group).slice(0, 64) } : {}),
          transform: this.transform(spec as Record<string, unknown>),
          selectable: false,
          visible: true,
          hero: false,
          staticGeometry: false,
        });
      },

      /** A renderable part. The core declaration: geometry + material + meaning. */
      mesh: (spec: {
        id: string;
        geometry: GeometryHandle;
        material: MaterialHandle;
        name?: string;
        parentId?: string | null;
        position?: unknown;
        rotation?: unknown;
        scale?: unknown;
        group?: string;
        info?: unknown;
        selectable?: boolean;
        visible?: boolean;
        hero?: boolean;
        static?: boolean;
        explodeOffset?: unknown;
      }): string => {
        const id = this.requireId(spec?.id, 'mesh.id');
        const geometryRef = this.geometry.resolve(spec?.geometry);
        if (!geometryRef) {
          throw new SceneError(
            `mesh '${id}' needs a geometry created by a geom.* function. Received ${typeof spec?.geometry}.`,
          );
        }
        const materialRef = this.materials.resolve(spec?.material);
        if (!materialRef) {
          throw new SceneError(
            `mesh '${id}' needs a material created by a mat.* function. Received ${typeof spec?.material}.`,
          );
        }

        return this.addPart({
          id,
          parentId: this.resolveParent(spec?.parentId, id),
          kind: 'mesh',
          name: typeof spec?.name === 'string' ? spec.name.slice(0, 120) : id,
          ...(spec?.group ? { group: String(spec.group).slice(0, 64) } : {}),
          transform: this.transform(spec as Record<string, unknown>),
          geometry: {
            builder: spec.geometry.builder,
            cacheKey: spec.geometry.cacheKey,
            triangles: spec.geometry.triangles,
            vertices: spec.geometry.vertices,
            modifiers: [...spec.geometry.modifiers],
            decimated: false,
            boundingRadius: spec.geometry.boundingRadius,
          },
          material: materialRef,
          ...(this.info(spec?.info, id) ? { info: this.info(spec?.info, id) } : {}),
          selectable: spec?.selectable !== false,
          visible: spec?.visible !== false,
          hero: spec?.hero === true,
          staticGeometry: spec?.static === true,
          ...(spec?.explodeOffset
            ? { explodeOffset: this.vec3(spec.explodeOffset, 'explodeOffset') }
            : {}),
        });
      },

      /**
       * An instanced set: one geometry, many placements, one draw call.
       *
       * The mechanism `00` requires for affordable ambition and `08` prices as "N × geometry cost, 1 × draw
       * call". Placements come from `geom.pattern.*` or from the model's own loop.
       */
      instances: (spec: {
        id: string;
        geometry: GeometryHandle;
        material: MaterialHandle;
        placements: readonly Placement[];
        name?: string;
        parentId?: string | null;
        group?: string;
        info?: unknown;
        selectable?: boolean;
        hero?: boolean;
      }): string => {
        const id = this.requireId(spec?.id, 'instances.id');
        if (!Array.isArray(spec?.placements) || spec.placements.length === 0) {
          throw new SceneError(
            `instances '${id}' needs a non-empty placements array. Use geom.pattern.radial(...) or build one in a loop.`,
          );
        }
        if (spec.placements.length > MAX_INSTANCES_PER_SET) {
          throw new SceneError(
            `instances '${id}' has ${spec.placements.length} placements, over the ${MAX_INSTANCES_PER_SET} limit for one set. Split it into several sets.`,
          );
        }
        const geometryHandle = spec?.geometry;
        const materialRef = this.materials.resolve(spec?.material);
        if (!this.geometry.resolve(geometryHandle) || !materialRef) {
          throw new SceneError(
            `instances '${id}' needs a geometry from geom.* and a material from mat.*.`,
          );
        }

        return this.addPart({
          id,
          parentId: this.resolveParent(spec?.parentId, id),
          kind: 'instances',
          name: typeof spec?.name === 'string' ? spec.name.slice(0, 120) : id,
          ...(spec?.group ? { group: String(spec.group).slice(0, 64) } : {}),
          transform: { position: [0, 0, 0], scale: [1, 1, 1] },
          geometry: {
            builder: geometryHandle.builder,
            cacheKey: geometryHandle.cacheKey,
            triangles: geometryHandle.triangles,
            vertices: geometryHandle.vertices,
            modifiers: [...geometryHandle.modifiers],
            decimated: false,
            boundingRadius: geometryHandle.boundingRadius,
          },
          material: materialRef,
          instances: spec.placements.map((placement) => ({
            transform: {
              position: [...placement.position] as [number, number, number],
              ...(placement.rotation
                ? { rotation: [...placement.rotation] as [number, number, number] }
                : {}),
              scale: placement.scale
                ? ([...placement.scale] as [number, number, number])
                : [1, 1, 1],
            },
            ...(placement.label ? { label: placement.label.slice(0, 64) } : {}),
          })),
          ...(this.info(spec?.info, id) ? { info: this.info(spec?.info, id) } : {}),
          selectable: spec?.selectable !== false,
          visible: true,
          hero: spec?.hero === true,
          staticGeometry: false,
        });
      },

      /** A point cloud — particle fields, electron clouds, star catalogues. */
      points: (spec: {
        id: string;
        geometry: GeometryHandle;
        material: MaterialHandle;
        name?: string;
        parentId?: string | null;
        info?: unknown;
      }): string => {
        const id = this.requireId(spec?.id, 'points.id');
        const materialRef = this.materials.resolve(spec?.material);
        if (!this.geometry.resolve(spec?.geometry) || !materialRef) {
          throw new SceneError(
            `points '${id}' needs a geometry from geom.points and a material from mat.*.`,
          );
        }
        return this.addPart({
          id,
          parentId: this.resolveParent(spec?.parentId, id),
          kind: 'points',
          name: typeof spec?.name === 'string' ? spec.name.slice(0, 120) : id,
          transform: { position: [0, 0, 0], scale: [1, 1, 1] },
          geometry: {
            builder: spec.geometry.builder,
            cacheKey: spec.geometry.cacheKey,
            triangles: 0,
            vertices: spec.geometry.vertices,
            modifiers: [],
            decimated: false,
            boundingRadius: spec.geometry.boundingRadius,
          },
          material: materialRef,
          ...(this.info(spec?.info, id) ? { info: this.info(spec?.info, id) } : {}),
          selectable: false,
          visible: true,
          hero: false,
          staticGeometry: false,
        });
      },

      /**
       * Define a reusable subassembly.
       *
       * `00`'s affordability rule in API form: "an engine with 300 parts is built from a few parameterized
       * definitions, not 300 hand-written blocks." The body receives a context whose `mesh`/`group` calls are
       * automatically parented and id-prefixed, so a component can be placed many times without id collisions.
       */
      defineComponent: (name: string, body: (ctx: ComponentContext) => void): void => {
        const id = this.requireId(name, 'defineComponent name');
        if (typeof body !== 'function') {
          throw new SceneError(`defineComponent('${id}') needs a function body.`);
        }
        this.components.set(id, body);
      },

      /** Place a defined component, prefixing every id inside it. */
      place: (
        component: string,
        spec: {
          id: string;
          parentId?: string | null;
          position?: unknown;
          rotation?: unknown;
          scale?: unknown;
          params?: Record<string, unknown>;
        },
      ): string => {
        const componentName = this.requireId(component, 'place component name');
        const body = this.components.get(componentName);
        if (!body) {
          throw new SceneError(
            `Component '${componentName}' has not been defined. Call scene.defineComponent('${componentName}', ...) first.`,
          );
        }
        const instanceId = this.requireId(spec?.id, 'place.id');

        // The placement's own group node anchors the component, so the whole subassembly moves as one.
        const anchor = this.addPart({
          id: instanceId,
          parentId: this.resolveParent(spec?.parentId, instanceId),
          kind: 'group',
          name: instanceId,
          group: componentName,
          component: componentName,
          transform: this.transform(spec as Record<string, unknown>),
          selectable: false,
          visible: true,
          hero: false,
          staticGeometry: false,
        });

        this.parentStack.push(anchor);
        try {
          body(this.createComponentContext(anchor, instanceId, spec?.params ?? {}));
        } finally {
          this.parentStack.pop();
        }
        return anchor;
      },

      /**
       * Declare a parameter.
       *
       * `00`: "Every user-facing control must visibly and meaningfully change what the model does." The `affects`
       * list is the model's own claim about what it drives; the dry-run sweep verifies it, and a parameter that
       * writes nothing becomes an enumerated deficiency rather than a shipped disappointment.
       */
      param: (spec: Record<string, unknown>): string => {
        const id = this.requireId(spec?.id, 'param.id');
        if (this.parameters.has(id)) {
          throw new SceneError(`Parameter '${id}' is declared twice.`);
        }
        if (this.parameters.size >= 24) {
          throw new SceneError(
            'A model may declare at most 24 parameters; more than that overwhelms the panel.',
          );
        }

        const kind = spec?.kind ?? 'number';
        const label = this.requireText(spec?.label, `param '${id}' label`, 64);
        const affects = Array.isArray(spec?.affects)
          ? (spec.affects as Array<Record<string, unknown>>).slice(0, 64).map((entry) => ({
              ...(typeof entry.partId === 'string' ? { partId: entry.partId } : {}),
              channel: (entry.channel ?? 'transform') as never,
            }))
          : [];

        const base = {
          id,
          label,
          ...(typeof spec?.description === 'string'
            ? { description: spec.description.slice(0, 400) }
            : {}),
          ...(typeof spec?.unit === 'string' ? { unit: spec.unit.slice(0, 16) } : {}),
          affects,
          order: this.parameters.size,
        };

        let decl: ParameterDecl;
        if (kind === 'boolean') {
          const value = spec?.default === true;
          decl = { ...base, kind: 'boolean', default: value };
          this.parameterValues.set(id, value);
        } else if (kind === 'color') {
          const value = typeof spec?.default === 'string' ? spec.default : '#ffffff';
          decl = { ...base, kind: 'color', default: value as `#${string}` };
          this.parameterValues.set(id, value);
        } else if (kind === 'choice') {
          const options = Array.isArray(spec?.options)
            ? (spec.options as Array<Record<string, unknown>>)
                .filter((option) => typeof option?.value === 'string')
                .slice(0, 12)
                .map((option) => ({
                  value: String(option.value).slice(0, 48),
                  label: String(option.label ?? option.value).slice(0, 64),
                }))
            : [];
          if (options.length < 2) {
            throw new SceneError(
              `Choice parameter '${id}' needs at least two options; one option is not a control.`,
            );
          }
          const value =
            typeof spec?.default === 'string'
              ? spec.default
              : (options[0] as { value: string }).value;
          decl = { ...base, kind: 'choice', options, default: value };
          this.parameterValues.set(id, value);
        } else {
          const min = this.optionalNumber(spec?.min, `param '${id}' min`) ?? 0;
          const max = this.optionalNumber(spec?.max, `param '${id}' max`) ?? 1;
          if (max <= min) {
            throw new SceneError(
              `Parameter '${id}' has max (${max}) not greater than min (${min}).`,
            );
          }
          const value = clamp(
            this.optionalNumber(spec?.default, `param '${id}' default`) ?? min,
            min,
            max,
          );
          decl = {
            ...base,
            kind: 'number',
            min,
            max,
            default: value,
            scale: spec?.scale === 'log' ? 'log' : 'linear',
            ...(spec?.step !== undefined
              ? { step: this.optionalNumber(spec.step, 'step') as number }
              : {}),
            ...(spec?.precision !== undefined
              ? { precision: clamp(Math.floor(Number(spec.precision)), 0, 6) }
              : {}),
          };
          this.parameterValues.set(id, value);
        }

        this.parameters.set(id, decl);
        return id;
      },

      /** Declare a derived read-out. Values are published from the model's own frame code (`00`). */
      metric: (spec: {
        id: string;
        label: string;
        unit?: string;
        formula?: string;
        precision?: number;
        source?: 'model' | 'physics';
      }): string => {
        const id = this.requireId(spec?.id, 'metric.id');
        this.metrics.set(id, {
          id,
          label: this.requireText(spec?.label, `metric '${id}' label`, 64),
          ...(spec?.unit ? { unit: String(spec.unit).slice(0, 16) } : {}),
          ...(spec?.formula ? { formula: String(spec.formula).slice(0, 200) } : {}),
          precision: clamp(Math.floor(spec?.precision ?? 2), 0, 6),
          source: spec?.source === 'physics' ? 'physics' : 'model',
        });
        return id;
      },

      /**
       * Declare motion.
       *
       * Declared motion is *auditable* motion: a spin whose rate is `{ param: 'rpm' }` can be checked, where an
       * opaque closure cannot. Arbitrary per-frame logic remains available through `onFrame`.
       */
      motion: (spec: Record<string, unknown>): void => {
        const id = this.requireId(spec?.id, 'motion.id');
        const partId = this.requireId(spec?.partId, `motion '${id}' partId`);
        if (!this.parts.has(partId)) {
          throw new SceneError(`motion '${id}' targets part '${partId}', which does not exist.`);
        }
        // The wire enum keeps `follow` and `sequence` for compatibility, but a motion declaration
        // cannot express them: no targetPartId, no states list. Accepting one stored a motion no
        // runtime could apply — a silent no-op wearing the audit's score — so it is refused here,
        // as loudly as a dangling part id.
        const kind = String(spec?.kind ?? 'spin');
        if (kind === 'follow' || kind === 'sequence') {
          throw new SceneError(
            `motion '${id}' uses kind '${kind}', which a motion declaration cannot express. ` +
              `Supported kinds: spin, oscillate, orbit, translate, pulse, flowAlongPath.`,
          );
        }
        this.motions.push({
          id,
          partId,
          kind: kind as never,
          axis: this.vec3(spec?.axis, 'motion axis', [0, 1, 0]),
          rate: (spec?.rate ?? { const: 1 }) as never,
          ...(spec?.amplitude !== undefined ? { amplitude: spec.amplitude as never } : {}),
          phase: this.optionalNumber(spec?.phase, 'motion phase') ?? 0,
          ...(spec?.center ? { center: this.vec3(spec.center, 'motion center') } : {}),
          ...(spec?.pathId ? { pathId: String(spec.pathId) } : {}),
          runsWhilePaused: spec?.runsWhilePaused === true,
          ...(typeof spec?.reason === 'string' ? { reason: spec.reason.slice(0, 240) } : {}),
        });
      },

      /** Register a named 3D path: flow lines, orbits, particle routes, camera rails. */
      path: (spec: { id: string; path: PathHandle; visible?: boolean }): string => {
        const id = this.requireId(spec?.id, 'path.id');
        const resolved = this.geometry.resolvePath(spec?.path);
        if (!resolved) {
          throw new SceneError(
            `path '${id}' needs a path created by geom.path() or geom.splinePath().`,
          );
        }
        const points: Array<[number, number, number]> = [];
        for (let i = 0; i < resolved.points.length; i += 3) {
          points.push([
            resolved.points[i] as number,
            resolved.points[i + 1] as number,
            resolved.points[i + 2] as number,
          ]);
        }
        this.paths.set(id, {
          id,
          points,
          closed: resolved.closed,
          visible: spec?.visible === true,
        });
        return id;
      },

      /** Add a light. Augments the default rig rather than replacing it (`00`: never lit flat or pitch black). */
      light: (spec: Record<string, unknown>): void => {
        const id = this.requireId(spec?.id, 'light.id');
        this.lights.push({
          id,
          kind: (spec?.kind ?? 'point') as never,
          color: (typeof spec?.color === 'string' ? spec.color : '#ffffff') as `#${string}`,
          intensity: clamp(this.optionalNumber(spec?.intensity, 'light intensity') ?? 1, 0, 1000),
          ...(spec?.position ? { position: this.vec3(spec.position, 'light position') } : {}),
          ...(spec?.target ? { target: this.vec3(spec.target, 'light target') } : {}),
          ...(spec?.angle !== undefined
            ? { angle: clamp(Number(spec.angle), 0, Math.PI / 2) }
            : {}),
          ...(spec?.penumbra !== undefined ? { penumbra: clamp(Number(spec.penumbra), 0, 1) } : {}),
          ...(spec?.distance !== undefined ? { distance: Math.max(0, Number(spec.distance)) } : {}),
          castShadow: spec?.castShadow === true,
          ...(spec?.boundTo ? { boundToParameter: String(spec.boundTo) } : {}),
        });
      },

      /**
       * Set the opening camera framing.
       *
       * `00`: "every model opens with the full concept in view — the AI author sets the initial camera; auto-frame
       * the bounding sphere is the fallback, never the default answer."
       */
      camera: (spec: {
        position: unknown;
        target?: unknown;
        fov?: number;
        limits?: Record<string, unknown>;
      }): void => {
        this.cameraPose = {
          position: this.vec3(spec?.position, 'camera position'),
          target: this.vec3(spec?.target, 'camera target', [0, 0, 0]),
          fov: clamp(this.optionalNumber(spec?.fov, 'camera fov') ?? 45, 10, 120),
        };
        if (spec?.limits) {
          const limits = spec.limits;
          this.cameraLimits = {
            ...(limits.minDistance !== undefined
              ? { minDistance: Number(limits.minDistance) }
              : {}),
            ...(limits.maxDistance !== undefined
              ? { maxDistance: Number(limits.maxDistance) }
              : {}),
            ...(limits.minPolarAngle !== undefined
              ? { minPolarAngle: Number(limits.minPolarAngle) }
              : {}),
            ...(limits.maxPolarAngle !== undefined
              ? { maxPolarAngle: Number(limits.maxPolarAngle) }
              : {}),
            damping: clamp(Number(limits.damping ?? 0.08), 0, 1),
            autoRotate: limits.autoRotate !== false,
            autoRotateSpeed: clamp(Number(limits.autoRotateSpeed ?? 0.35), -4, 4),
          };
        }
      },

      /** Register a named cinematic shot, replayable from a story beat or an interaction (`00`). */
      shot: (name: string, spec: Record<string, unknown>): void => {
        const id = this.requireId(name, 'shot name');
        this.shots.set(id, {
          kind: (spec?.kind ?? 'flyTo') as never,
          duration: clamp(Number(spec?.duration ?? 1.2), 0, 60),
          easing: (spec?.easing ?? 'easeInOut') as never,
          ...(spec?.targetPartId ? { targetPartId: String(spec.targetPartId) } : {}),
          ...(spec?.pose ? { pose: spec.pose as never } : {}),
          ...(spec?.distance !== undefined ? { distance: Number(spec.distance) } : {}),
          ...(spec?.sweep !== undefined ? { sweep: Number(spec.sweep) } : {}),
          ...(spec?.fov !== undefined ? { fov: clamp(Number(spec.fov), 10, 120) } : {}),
          margin: clamp(Number(spec?.margin ?? 1.35), 1, 4),
        });
      },

      /** Set the backdrop and tone. The engine keeps model contrast in both themes (`00`, `08`). */
      environment: (spec: Record<string, unknown>): void => {
        this.environment = {
          preset: (spec?.preset ?? 'studio') as never,
          ...(typeof spec?.backgroundDark === 'string'
            ? { backgroundDark: spec.backgroundDark as `#${string}` }
            : {}),
          ...(typeof spec?.backgroundLight === 'string'
            ? { backgroundLight: spec.backgroundLight as `#${string}` }
            : {}),
          grid: spec?.grid === true,
          exposure: clamp(Number(spec?.exposure ?? 0), -4, 4),
          ...(spec?.fog ? { fog: spec.fog as never } : {}),
        };
      },

      /** Declare a story beat. 3–6 beats following the causal arc (`05`). */
      story: (beats: Array<Record<string, unknown>>): void => {
        if (!Array.isArray(beats)) throw new SceneError('scene.story expects an array of beats.');
        for (const beat of beats.slice(0, 12)) {
          const id = this.requireId(beat?.id, 'story beat id');
          this.story.push({
            id,
            title: this.requireText(beat?.title, `beat '${id}' title`, 120),
            narration: this.requireText(beat?.narration, `beat '${id}' narration`, 1200),
            ...(beat?.targetPartId ? { targetPartId: String(beat.targetPartId) } : {}),
            shots: Array.isArray(beat?.shots) ? (beat.shots as ShotDecl[]).slice(0, 6) : [],
            ...(beat?.setParameters ? { setParameters: beat.setParameters as never } : {}),
            ...(beat?.holdSeconds !== undefined
              ? { holdSeconds: clamp(Number(beat.holdSeconds), 1, 60) }
              : {}),
            ...(beat?.viewMode ? { viewMode: beat.viewMode as never } : {}),
          });
        }
      },

      /**
       * Declare quiz questions.
       *
       * `05`'s authored-first rule makes these the primary path: they were written for this exact model, cost
       * nothing to use, and work with the backend down. Unusable questions are dropped here rather than shown.
       */
      quiz: (questions: Array<Record<string, unknown>>): void => {
        if (!Array.isArray(questions))
          throw new SceneError('scene.quiz expects an array of questions.');
        for (const question of questions.slice(0, 20)) {
          const id = this.requireId(question?.id, 'quiz question id');
          const options = Array.isArray(question?.options)
            ? question.options
                .filter((option): option is string => typeof option === 'string')
                .slice(0, 6)
            : [];
          const correctIndex = Number(question?.correctIndex);

          // The canonical failure `05` exists to prevent: "every answer was wrong, including the right one".
          if (
            options.length < 2 ||
            !Number.isInteger(correctIndex) ||
            correctIndex < 0 ||
            correctIndex >= options.length
          ) {
            this.warnings.push(
              `Quiz question '${id}' was dropped: it needs at least two options and a correctIndex inside that range.`,
            );
            continue;
          }

          this.quiz.push({
            id,
            question: this.requireText(question?.question, `question '${id}' text`, 400),
            options: options.map((option) => option.slice(0, 200)),
            correctIndex,
            explanation: this.requireText(
              question?.explanation,
              `question '${id}' explanation`,
              800,
            ),
            difficulty: (question?.difficulty ?? 'application') as never,
            ...(question?.evidencePartId
              ? { evidencePartId: String(question.evidencePartId) }
              : {}),
          });
        }
      },

      /** Declare an interaction beyond selection. */
      interaction: (spec: Record<string, unknown>): void => {
        const partId = this.requireId(spec?.partId, 'interaction.partId');
        if (!this.parts.has(partId)) {
          throw new SceneError(`interaction targets part '${partId}', which does not exist.`);
        }
        this.interactions.push({
          partId,
          on: (spec?.on ?? 'click') as never,
          kind: (spec?.kind ?? 'select') as never,
          ...(spec?.targetId ? { targetId: String(spec.targetId) } : {}),
          ...(spec?.value !== undefined ? { value: spec.value as never } : {}),
          ...(spec?.shot ? { shot: spec.shot as never } : {}),
          ...(spec?.impulse ? { impulse: this.vec3(spec.impulse, 'interaction impulse') } : {}),
          ...(spec?.handlerId ? { handlerId: String(spec.handlerId) } : {}),
          ...(typeof spec?.hint === 'string' ? { hint: spec.hint.slice(0, 160) } : {}),
        });
      },

      /**
       * Register per-frame logic.
       *
       * The escape hatch that keeps the AI a programmer rather than a form-filler: arbitrary state machines,
       * custom motion laws, conditional behaviour. Runs inside the sandbox on the learner's device, receiving
       * capability-scoped handles so every write is attributable.
       */
      onFrame: (callback: (ctx: FrameContext) => void): void => {
        if (typeof callback !== 'function')
          throw new SceneError('scene.onFrame expects a function.');
        if (this.callbacks.frame.length >= 16) {
          throw new SceneError('At most 16 onFrame callbacks; combine them into one function.');
        }
        this.callbacks.frame.push(callback);
      },

      /** React to a parameter change outside the frame loop — for work too expensive to redo every frame. */
      onParameterChange: (
        callback: (id: string, value: number | boolean | string) => void,
      ): void => {
        if (typeof callback !== 'function')
          throw new SceneError('scene.onParameterChange expects a function.');
        this.callbacks.parameterChange.push(callback);
      },

      /** React to a part being selected. */
      onSelect: (callback: (partId: string) => void): void => {
        if (typeof callback !== 'function')
          throw new SceneError('scene.onSelect expects a function.');
        this.callbacks.select.push(callback);
      },

      /** Register a named handler an interaction can invoke. */
      onInteraction: (id: string, callback: (partId: string) => void): void => {
        const handlerId = this.requireId(id, 'onInteraction id');
        if (typeof callback !== 'function')
          throw new SceneError('scene.onInteraction expects a function.');
        this.callbacks.interactions.set(handlerId, callback);
      },

      /** Declare the physics world. Absent means the model animates rather than simulates (`01`). */
      physics: (spec: PhysicsDecl): void => {
        // Parsed here rather than at the manifest boundary, so a model's physics declaration is
        // normalised the moment it is made: zod fills the world defaults, and a NaN gravity or a
        // negative density is refused while the author still gets a usable message. Storing the
        // spec verbatim meant `bodies` could be absent and every later reader had to defend
        // against it — one of them (`computeCost`) did not, and the authoring pass crashed outright
        // for any model that declared a world without listing its bodies by hand.
        const parsed = PhysicsDeclSchema.safeParse(spec ?? {});
        if (!parsed.success) {
          const issue = parsed.error.issues[0];
          throw new SceneError(
            `scene.physics: ${issue?.path.join('.') || 'declaration'} — ${issue?.message ?? 'invalid'}.`,
          );
        }
        this.physics = parsed.data;
      },

      /** Record a non-fatal note for the diagnostics panel. */
      warn: (message: string): void => {
        if (typeof message === 'string' && message.trim().length > 0) {
          this.warnings.push(message.slice(0, 240));
        }
      },
    };

    return Object.freeze(facade);
  }

  /** The context a component body receives: parented and id-prefixed automatically. */
  private createComponentContext(
    anchorId: string,
    prefix: string,
    params: Record<string, unknown>,
  ): ComponentContext {
    const facade = this.createFacade() as Record<string, (spec: Record<string, unknown>) => string>;

    const prefixed = (spec: Record<string, unknown>): Record<string, unknown> => ({
      ...spec,
      // Ids are prefixed so the same component can be placed many times without collisions — the whole reason
      // component reuse works for a 300-part assembly.
      id: `${prefix}.${String(spec.id)}`,
      parentId: spec.parentId === undefined ? anchorId : spec.parentId,
    });

    return {
      params,
      anchorId,
      group: (spec) => facade.group?.(prefixed(spec)) as string,
      mesh: (spec) => facade.mesh?.(prefixed(spec)) as string,
      instances: (spec) => facade.instances?.(prefixed(spec)) as string,
      points: (spec) => facade.points?.(prefixed(spec)) as string,
      /** Fully-qualified id of something declared inside this component, for later reference. */
      id: (local: string) => `${prefix}.${local}`,
    };
  }

  // ── Manifest emission ─────────────────────────────────────────────────────

  beginTiming(): void {
    this.authorStart = Date.now();
  }

  /**
   * Emit the manifest.
   *
   * Every check that would otherwise become a confusing render-time failure happens here: a model with no parts,
   * a story beat pointing at a part that no longer exists, a motion on a deleted part. `04`'s audit consumes the
   * result, so a fault detected here becomes an enumerated instruction rather than a blank canvas.
   */
  toManifest(): ModelManifest {
    if (!this.describeCalled || !this.pedagogy) {
      throw new SceneError(
        'The model never called scene.describe({ name, description, concept, objectives }). Declare what the model teaches before building it.',
      );
    }
    if (this.parts.size === 0) {
      throw new SceneError(
        'The model declared no parts. A scene with no geometry cannot teach anything.',
      );
    }

    const nodes = this.order.map((id) => (this.parts.get(id) as PartRecord).node);

    // Dangling story targets are downgraded to warnings rather than errors: `05` requires one bad target to skip
    // its camera move, not to kill the tour.
    for (const beat of this.story) {
      if (beat.targetPartId && !this.parts.has(beat.targetPartId)) {
        this.warnings.push(
          `Story beat '${beat.id}' targets part '${beat.targetPartId}', which does not exist; its camera move will be skipped.`,
        );
      }
    }

    const cost = this.computeCost(nodes);

    return {
      formatVersion: 1,
      name: this.name,
      description: this.description,
      domain: this.domain,
      ...(this.subdomain ? { subdomain: this.subdomain } : {}),
      pedagogy: this.pedagogy,
      parts: nodes,
      colorRoles: this.materials.declaredRoles().map((role) => ({
        id: role.id,
        label: role.label,
        color: role.color,
        meaning: role.meaning,
      })),
      lights: this.lights,
      environment: this.environment ?? {
        preset: 'studio',
        grid: false,
        exposure: 0,
      },
      camera: {
        // The authored pose is required by `00`; auto-framing is the fallback the realizer applies when absent.
        initial: this.cameraPose ?? this.deriveCamera(nodes),
        limits: this.cameraLimits ?? {
          damping: 0.08,
          autoRotate: true,
          autoRotateSpeed: 0.35,
        },
        shots: Object.fromEntries(this.shots),
      },
      parameters: [...this.parameters.values()],
      metrics: [...this.metrics.values()],
      motions: this.motions,
      paths: [...this.paths.values()],
      interactions: this.interactions,
      ...(this.physics ? { physics: this.physics } : {}),
      story: this.story,
      quiz: this.quiz,
      cost,
      callbacks: {
        hasFrame: this.callbacks.frame.length > 0,
        hasParameterChange: this.callbacks.parameterChange.length > 0,
        interactionHandlers: [...this.callbacks.interactions.keys()],
        metricComputers: [...this.metrics.keys()],
      },
      warnings: [...this.warnings, ...this.geometry.warnings, ...this.materials.warnings].slice(
        0,
        64,
      ),
      createdAt: Date.now(),
    };
  }

  /** Measure the build. Every number comes from the declarations, not from an estimate (`08`). */
  private computeCost(nodes: PartNode[]): BuildCost {
    const geometryKeys = new Set<string>();
    const materialKeys = new Set<string>();
    let triangles = 0;
    let vertices = 0;
    let drawCalls = 0;
    let instancedSets = 0;
    let instances = 0;

    for (const node of nodes) {
      if (node.material) materialKeys.add(node.material.cacheKey);
      if (!node.geometry) continue;
      geometryKeys.add(node.geometry.cacheKey);

      if (node.kind === 'instances') {
        const count = node.instances?.length ?? 0;
        instancedSets += 1;
        instances += count;
        // The whole point of instancing: N × geometry cost, 1 × draw call (`08`).
        triangles += node.geometry.triangles * count;
        vertices += node.geometry.vertices;
        drawCalls += 1;
        continue;
      }

      triangles += node.geometry.triangles;
      vertices += node.geometry.vertices;
      drawCalls += 1;
    }

    return {
      parts: nodes.length,
      uniqueGeometries: geometryKeys.size,
      uniqueMaterials: materialKeys.size,
      triangles,
      vertices,
      drawCalls,
      instancedSets,
      instances,
      shadowCastingLights: this.lights.filter((light) => light.castShadow).length,
      physicsBodies: this.physics?.bodies.length ?? 0,
      authorMillis: Math.max(0, Date.now() - this.authorStart),
    };
  }

  /**
   * Fallback camera framing.
   *
   * `00` calls auto-framing "the fallback, never the default answer", so this exists only for models that did not
   * call `scene.camera`. The 2.4× distance and 25° elevation put a typical assembly comfortably in frame from a
   * three-quarter view, which reads as a deliberate product shot rather than an axis-aligned diagram.
   */
  private deriveCamera(nodes: PartNode[]): CameraPose {
    let radius = 1;
    for (const node of nodes) {
      const nodeRadius = node.geometry?.boundingRadius ?? 0;
      const distance = Math.hypot(...node.transform.position) + nodeRadius;
      if (distance > radius) radius = distance;
    }
    const distance = radius * 2.4;
    const elevation = 25 * (Math.PI / 180);
    this.warnings.push(
      'The model did not set an opening camera, so the view was auto-framed. Call scene.camera({ position, target }) to frame the concept deliberately.',
    );
    return {
      position: [
        distance * Math.cos(elevation) * 0.7,
        distance * Math.sin(elevation),
        distance * Math.cos(elevation) * 0.7,
      ],
      target: [0, 0, 0],
      fov: 45,
    };
  }
}

/** What a component body receives. Ids are prefixed and parents wired automatically. */
export interface ComponentContext {
  readonly params: Record<string, unknown>;
  readonly anchorId: string;
  group(spec: Record<string, unknown>): string;
  mesh(spec: Record<string, unknown>): string;
  instances(spec: Record<string, unknown>): string;
  points(spec: Record<string, unknown>): string;
  id(local: string): string;
}
