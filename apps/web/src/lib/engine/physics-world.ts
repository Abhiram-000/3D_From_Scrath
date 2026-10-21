/**
 * The physics world: Rapier in SI units, inside the render worker.
 *
 * `02-PHYSICS.md` R1 requires "a production-grade rigid-body solver... integrated in whatever runtime
 * form you judge best", and progressive enhancement is the first rule: if the WASM cannot load here,
 * the model renders and animates without simulation, the UI says so, and nothing crashes. Every rule
 * this file implements is a named `02` requirement:
 *
 *   - R2 real units: gravity 9.81, mass from density × collider volume by default, authored
 *     overrides honored;
 *   - R3 faithful colliders: `auto` derives from the part's render geometry so what the learner sees
 *     touching is what the solver resolves;
 *   - R4 frame-rate independence: a fixed-timestep accumulator with a clamped frame budget — debt is
 *     shed, never accumulated into a spiral;
 *   - R5 live control: `motorTargets` from the scene builder retarget joints every step, and a
 *     parameter change wakes sleeping bodies;
 *   - R6 observable physics: probes publish measured values the UI and formulas read;
 *   - R7 clean lifecycle: `dispose()` frees the WASM world entirely, idempotently.
 *
 * NaN quarantine (`02` Runtime): a body whose simulation explodes is frozen at its last good pose and
 * flagged, so one poisoned body cannot write garbage into the whole scene graph.
 */
import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import type { BodyDecl, JointDecl, ModelManifest } from '@edu3d/contracts';
import { DEVICE_BUDGETS, type DeviceTier } from '@edu3d/contracts';

/** Real densities, kg/m³ — the values `02` names ("steel ~7850, foam ~30"). */
const DENSITIES: Record<string, number> = {
  steel: 7850,
  aluminium: 2700,
  brass: 8500,
  iron: 7870,
  wood: 700,
  rubber: 1100,
  plastic: 950,
  glass: 2500,
  concrete: 2400,
  ice: 917,
  foam: 30,
  water: 1000,
  custom: 1000,
};

const DEFAULT_FRICTION: Record<string, number> = {
  ice: 0.02,
  rubber: 1.2,
  steel: 0.4,
  concrete: 0.8,
};

/** Fixed timestep, seconds. `02` R4: the same scene evolves identically at any render rate. */
const FIXED_DT = 1 / 60;
/**
 * Maximum substeps per frame. A slow frame degrades to slow motion rather than accumulating debt —
 * "a locked tab or an exploding accumulator" are the two named failure modes (`02` R4).
 */
const MAX_SUBSTEPS = 3;
/** Gravity, m/s². Standard Earth gravity: a dropped ball accelerates at 9.8, visibly (`02` R2). */
const GRAVITY = 9.81;

/** One body's linkage between the solver and the rendered part. */
interface BodyLink {
  decl: BodyDecl;
  body: RAPIER.RigidBody;
  /** Last transform known finite — the pose a quarantined body freezes at (`02`). */
  lastGoodPosition: RAPIER.Vector;
  lastGoodRotation: RAPIER.Quaternion;
  quarantined: boolean;
}

/** A published measurement, by probe id (`02` R6). */
export type PhysicsProbes = Record<string, number>;

export class PhysicsWorld {
  private world: RAPIER.World;
  private readonly bodies = new Map<string, BodyLink>();
  private readonly joints = new Map<string, RAPIER.ImpulseJoint>();
  private accumulator = 0;
  private readonly maxBodies: number;
  /** Guards the WASM free against the double-dispose a load/destroy race produces. */
  private disposed = false;

  /** Part transforms by part id, written each step, read by `syncTransforms`'s physics branch. */
  readonly simulatedParts = new Map<
    string,
    { position: [number, number, number]; rotation: [number, number, number] }
  >();

  private constructor(world: RAPIER.World, maxBodies: number) {
    this.world = world;
    this.maxBodies = maxBodies;
  }

  /**
   * Start the WASM runtime while the realm still has `WebAssembly`, and remember the answer.
   *
   * The sandbox deletes `WebAssembly` when it hardens the realm (PLAN.md §A1 layer 4:
   * "...`WebAssembly`... deleted/poisoned"), and hardening happens during every load — before any
   * world is built. So `RAPIER.init()` called from `create()` compiled nothing and always failed,
   * and the worker reported it as "the physics engine could not load on this device": an honest
   * message about a cause that was never the device's fault. Every model that declared physics was
   * therefore dead in the browser while `02` R1's progressive-enhancement path looked healthy.
   *
   * The compile is started at worker boot — the same window `new Function` needs for the guest
   * program's own compilation — and `create()` awaits the same promise, so it happens exactly once
   * and before the capability is dropped. Resolution is memoised, so a second model costs nothing.
   */
  private static runtime: Promise<boolean> | null = null;

  /**
   * Why the runtime failed, when it did.
   *
   * The degraded path is honest but was silent about the cause: the worker could only say "the
   * engine could not load on this device", which is a statement about the device made by code that
   * could not tell device from sandbox. Keeping the rejection here lets the status bar (and the log)
   * name what actually went wrong, which is the difference between a diagnosis and a guess.
   */
  static runtimeFailure: string | null = null;

  /** Compile the solver once, before hardening. Safe to call more than once. */
  static warmUp(): Promise<boolean> {
    PhysicsWorld.runtime ??= RAPIER.init().then(
      () => true,
      (error: unknown) => {
        PhysicsWorld.runtimeFailure =
          error instanceof Error ? error.message : String(error).slice(0, 200);
        return false;
      },
    );
    return PhysicsWorld.runtime;
  }

  /**
   * Build the world on the warmed runtime. Returns null when the runtime could not load — the caller
   * treats that as the honest degraded mode, never as a failure (`02` R1).
   */
  static async create(manifest: ModelManifest, tier: DeviceTier): Promise<PhysicsWorld | null> {
    if (!(await PhysicsWorld.warmUp())) return null;
    const gravity = manifest.physics?.world.gravity ?? [0, -GRAVITY, 0];
    const world = new RAPIER.World({ x: gravity[0], y: gravity[1], z: gravity[2] });
    world.timestep = FIXED_DT;
    const physics = new PhysicsWorld(world, DEVICE_BUDGETS[tier].maxPhysicsBodies);
    physics.build(manifest);
    return physics;
  }

  /** Build bodies and joints from the declaration. Validation happens here, before the solver (`02`). */
  private build(manifest: ModelManifest): void {
    const physics = manifest.physics;
    if (!physics) return;

    const partById = new Map(manifest.parts.map((part) => [part.id, part]));

    for (const decl of physics.bodies.slice(0, this.maxBodies)) {
      const part = partById.get(decl.partId);
      if (!part) continue; // A joint anchored to a missing body is rejected; a body without its part is skipped.

      const density = decl.material.density ?? DENSITIES[decl.material.name] ?? DENSITIES.custom!;

      const friction = decl.material.friction ?? DEFAULT_FRICTION[decl.material.name] ?? 0.6;
      const restitution =
        decl.material.restitution ?? (decl.material.name === 'rubber' ? 0.8 : 0.15);

      const bodyDesc =
        decl.kind === 'dynamic'
          ? RAPIER.RigidBodyDesc.dynamic()
          : decl.kind === 'kinematic'
            ? RAPIER.RigidBodyDesc.kinematicVelocityBased()
            : RAPIER.RigidBodyDesc.fixed();

      bodyDesc
        .setTranslation(
          part.transform.position[0],
          part.transform.position[1],
          part.transform.position[2],
        )
        .setLinearDamping(decl.material.linearDamping ?? 0.04)
        .setAngularDamping(decl.material.angularDamping ?? 0.04)
        .setCanSleep(decl.canSleep)
        .setCcdEnabled(decl.ccd);

      if (decl.gravityScale !== undefined) bodyDesc.setGravityScale(decl.gravityScale);
      if (decl.linearVelocity) {
        bodyDesc.setLinvel(decl.linearVelocity[0], decl.linearVelocity[1], decl.linearVelocity[2]);
      }
      if (decl.angularVelocity) {
        bodyDesc.setAngvel({
          x: decl.angularVelocity[0],
          y: decl.angularVelocity[1],
          z: decl.angularVelocity[2],
        });
      }

      const body = this.world.createRigidBody(bodyDesc);

      // The collider: `auto` derives from the render geometry's bounds — the fidelity rule (`02` R3).
      const colliderDesc = this.describeCollider(decl, part.transform.scale[0], part);
      colliderDesc.setDensity(
        decl.mass ? decl.mass / Math.max(1e-9, this.estimateVolume(decl)) : density,
      );
      colliderDesc.setFriction(friction);
      colliderDesc.setRestitution(restitution);
      colliderDesc.setSensor(decl.collider.sensor);
      if (decl.collider.offset) {
        colliderDesc.setTranslation(
          decl.collider.offset[0],
          decl.collider.offset[1],
          decl.collider.offset[2],
        );
      }
      this.world.createCollider(colliderDesc, body);

      const position = body.translation();
      const rotation = body.rotation();
      this.bodies.set(decl.id, {
        decl,
        body,
        lastGoodPosition: { ...position },
        lastGoodRotation: { ...rotation },
        quarantined: false,
      });
    }

    for (const decl of physics.joints) {
      this.createJoint(decl);
    }
  }

  /** Rough volume for density→mass conversion when an authored mass overrides density. */
  private estimateVolume(decl: BodyDecl): number {
    const r = decl.collider.radius ?? 0.5;
    const h = decl.collider.halfHeight ?? 0.5;
    switch (decl.collider.shape) {
      case 'sphere':
        return (4 / 3) * Math.PI * r ** 3;
      case 'box':
        return (
          8 *
          (decl.collider.size?.[0] ?? r) *
          (decl.collider.size?.[1] ?? r) *
          (decl.collider.size?.[2] ?? r)
        );
      case 'cylinder':
      case 'capsule':
        return Math.PI * r * r * h * 2;
      default:
        return (4 / 3) * Math.PI * r ** 3 * 2;
    }
  }

  private describeCollider(
    decl: BodyDecl,
    partScale: number,
    node?: ModelManifest['parts'][number],
  ): RAPIER.ColliderDesc {
    const scale = Math.max(1e-6, partScale);
    switch (decl.collider.shape) {
      case 'sphere':
        return RAPIER.ColliderDesc.ball((decl.collider.radius ?? 0.5) * scale);
      case 'box':
        return RAPIER.ColliderDesc.cuboid(
          (decl.collider.size?.[0] ?? 0.5) * scale,
          (decl.collider.size?.[1] ?? 0.5) * scale,
          (decl.collider.size?.[2] ?? 0.5) * scale,
        );
      case 'capsule':
        return RAPIER.ColliderDesc.capsule(
          (decl.collider.halfHeight ?? 0.5) * scale,
          (decl.collider.radius ?? 0.25) * scale,
        );
      case 'cylinder':
        return RAPIER.ColliderDesc.cylinder(
          (decl.collider.halfHeight ?? 0.5) * scale,
          (decl.collider.radius ?? 0.5) * scale,
        );
      case 'cone':
        return RAPIER.ColliderDesc.cone(
          (decl.collider.halfHeight ?? 0.5) * scale,
          (decl.collider.radius ?? 0.5) * scale,
        );
      case 'auto':
      default: {
        // The 2026-10-12 plan's load-bearing fix: `auto` infers from the geometry the builder
        // actually made — the measured bounding radius is real data (every handle ships it), and
        // the builder name says what shape wraps it. A model that never declared a collider used
        // to get a hardcoded 0.5 m sphere whatever it was: a 3 m turbine nacelle fell like a
        // marble. Shape-matched factors stay conservative (inscribed, not circumscribed) so
        // inferred colliders err on the side of visible gaps over interpenetration.
        const builder = node?.geometry?.builder ?? '';
        const br = Math.max(1e-6, (node?.geometry?.boundingRadius ?? 0.5) * scale);
        const mm = inferColliderShape(builder, br);
        switch (mm.kind) {
          case 'ball':
            return RAPIER.ColliderDesc.ball(mm.r);
          case 'cylinder':
            return RAPIER.ColliderDesc.cylinder(mm.r2!, mm.r!);
          case 'cone':
            return RAPIER.ColliderDesc.cone(mm.r2!, mm.r!);
          case 'capsule':
            return RAPIER.ColliderDesc.capsule(mm.r2!, mm.r!);
          default:
            return RAPIER.ColliderDesc.cuboid(mm.r2 ?? mm.r, mm.r2 ?? mm.r, mm.r2 ?? mm.r);
        }
      }
    }
  }

  private createJoint(decl: JointDecl): void {
    // A joint anchored to a missing body is skipped, not fatal (`02` Input validation).
    const a = this.bodies.get(decl.bodyA)?.body;
    if (!a) return;
    const b = decl.bodyB ? this.bodies.get(decl.bodyB)?.body : undefined;

    const anchorA = { x: decl.anchorA[0], y: decl.anchorA[1], z: decl.anchorA[2] };
    const anchorB = { x: decl.anchorB[0], y: decl.anchorB[1], z: decl.anchorB[2] };
    const axis = { x: decl.axis?.[0] ?? 0, y: decl.axis?.[1] ?? 1, z: decl.axis?.[2] ?? 0 };

    let params: RAPIER.JointData;
    switch (decl.kind) {
      case 'revolute':
        params = RAPIER.JointData.revolute(anchorA, anchorB, axis);
        break;
      case 'prismatic':
        params = RAPIER.JointData.prismatic(anchorA, anchorB, axis);
        break;
      case 'fixed':
        params = RAPIER.JointData.fixed(anchorA, { x: 0, y: 0, z: 0, w: 1 }, anchorB, {
          x: 0,
          y: 0,
          z: 0,
          w: 1,
        });
        break;
      case 'spherical':
        params = RAPIER.JointData.spherical(anchorA, anchorB);
        break;
      default:
        return;
    }

    if (decl.limits && (decl.kind === 'revolute' || decl.kind === 'prismatic')) {
      params.limitsEnabled = true;
      params.limits = [decl.limits[0], decl.limits[1]];
    }

    // Motor configuration lives on the joint instance once created (Rapier 0.20 API), which is also
    // where live retargeting goes — `setMotorTarget` below uses the same handle.
    const joint = this.world.createImpulseJoint(
      params,
      a,
      b ?? this.world.createRigidBody(RAPIER.RigidBodyDesc.fixed()),
      true,
    );
    const motorVelocity = decl.motor?.targetVelocity;
    if (motorVelocity !== undefined) {
      (joint as RAPIER.RevoluteImpulseJoint).configureMotorVelocity(motorVelocity, 4);
    }
    this.joints.set(decl.id, joint);
  }

  /** Retarget a motor while the scene runs (`02` R5). */
  setMotorTarget(jointId: string, targetVelocity: number): void {
    const joint = this.joints.get(jointId);
    if (!joint || !Number.isFinite(targetVelocity)) return;
    const revolute = joint as RAPIER.RevoluteImpulseJoint & {
      configureMotorVelocity(v: number, factor: number): void;
    };
    revolute.configureMotorVelocity?.(targetVelocity, 4);
  }

  /** Wake every sleeping body — a parameter change must reach what settled (`02` R5). */
  wakeAll(): void {
    for (const link of this.bodies.values()) link.body.wakeUp();
  }

  /** Reset every body to its authored pose — not last frame's (`02` Lifecycle). */
  reset(manifest: ModelManifest): void {
    const partById = new Map(manifest.parts.map((part) => [part.id, part]));
    for (const link of this.bodies.values()) {
      const part = partById.get(link.decl.partId);
      if (!part) continue;
      link.body.setTranslation(
        {
          x: part.transform.position[0],
          y: part.transform.position[1],
          z: part.transform.position[2],
        },
        true,
      );
      link.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
      link.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
      link.quarantined = false;
      link.body.wakeUp();
    }
  }

  /**
   * Advance the fixed-step accumulator and step the world.
   *
   * Returns the probes to publish, and the wall-milliseconds the step cost — the physics budget line
   * the adaptive ladder watches (`02` Performance).
   */
  step(
    frameDeltaSeconds: number,
    motorTargets: ReadonlyMap<string, number>,
  ): { probes: PhysicsProbes; millis: number } {
    const started = performance.now();
    this.accumulator = Math.min(this.accumulator + frameDeltaSeconds, FIXED_DT * MAX_SUBSTEPS);

    // Live motor retargeting happens before the step, so a slider is cause and the very next step is effect.
    for (const [jointId, target] of motorTargets) this.setMotorTarget(jointId, target);

    let stepped = false;
    while (this.accumulator >= FIXED_DT) {
      this.accumulator -= FIXED_DT;
      this.world.step();
      stepped = true;
    }

    const probes: PhysicsProbes = {};
    if (stepped) {
      for (const [id, link] of this.bodies) {
        const translation = link.body.translation();
        const rotation = link.body.rotation();
        const linvel = link.body.linvel();

        // NaN quarantine: freeze at the last good pose; one poisoned body must not write garbage
        // into the whole scene graph (`02` Runtime).
        if (
          !Number.isFinite(translation.x) ||
          !Number.isFinite(translation.y) ||
          !Number.isFinite(translation.z) ||
          !Number.isFinite(rotation.x) ||
          !Number.isFinite(rotation.w)
        ) {
          if (!link.quarantined) {
            link.quarantined = true;
            link.body.setTranslation(link.lastGoodPosition, true);
            link.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
            link.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
          }
          continue;
        }
        link.lastGoodPosition = { ...translation };
        link.lastGoodRotation = { ...rotation };

        // Kinematic bodies follow their parts (the bridge); dynamic bodies drive them.
        if (link.decl.kind !== 'dynamic') continue;
        // Quaternion → Euler via THREE's own XYZ conversion — the hand-rolled atan2 here
        // produced an X-only, degrees-measured triple whose Y and Z were zeroed, so a tumbling
        // body presented a fraction of its rotation. `eulerFromQuatXyz` lives in the engine's
        // motions module, but the converter that already ships with the renderer's own math is
        // the one that provably matches the renderer's convention.
        const euler = new THREE.Euler().setFromQuaternion(
          new THREE.Quaternion(rotation.x, rotation.y, rotation.z, rotation.w),
          'XYZ',
        );
        this.simulatedParts.set(link.decl.partId, {
          position: [translation.x, translation.y, translation.z],
          rotation: [euler.x, euler.y, euler.z],
        });
        // Measured values the UI and the model's formulas read (`02` R6).
        probes[`${id}.speed`] = Math.hypot(linvel.x, linvel.y, linvel.z);
        probes[`${id}.height`] = translation.y;
        const velocity = link.body.linvel();
        const mass = link.body.mass();
        probes[`${id}.kinetic`] =
          0.5 * mass * (velocity.x ** 2 + velocity.y ** 2 + velocity.z ** 2);
      }
    }

    return { probes, millis: performance.now() - started };
  }

  /**
   * Total release. Idempotent and tolerant of partial failures (`02` R7).
   *
   * The idempotence is load-bearing rather than decorative: `sandbox-worker.ts` disposes on scene
   * swap and again on teardown, and a load racing a destroy reaches both paths. Without the guard
   * the second `world.free()` double-frees the WASM world and throws out of the worker's message
   * handler — which surfaces to the learner as a viewer notice.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.bodies.clear();
    this.joints.clear();
    this.simulatedParts.clear();
    try {
      this.world.free();
    } catch {
      // A world that is already gone is the state we wanted anyway; failing loudly here would
      // turn a clean teardown into a learner-facing error.
    }
  }
}

/**
 * Infer collider shape + dimensions from the geometry builder's name and its measured bounding
 * radius — the pure half of describeCollider's 'auto' path, unit-testable without Rapier.
 *
 * Factors are proportions of the bound radius, chosen inscribed: a sphere of bound radius R is a
 * ball R; a cube bound R (half-diagonal √3·h) gets a cuboid of half h = R/√3 ≈ 0.577R; a cylinder
 * is modelled r = 0.7R, half = 0.8R. Unknown builders — new operators, guest mesh output — fall
 * back to the ball, the one shape that is always faithful enough to start.
 */
export function inferColliderShape(
  builder: string,
  boundRadius: number,
): { kind: 'ball' | 'cuboid' | 'cylinder' | 'cone' | 'capsule'; r: number; r2?: number } {
  const r = Math.max(1e-6, boundRadius);
  switch (builder) {
    case 'sphere':
    case 'ball':
    case 'gear':
    case 'torus':
      return { kind: 'ball', r };
    case 'box':
    case 'cube':
    case 'prism':
    case 'beam':
      return { kind: 'cuboid', r: (r / Math.sqrt(3)) * 0.95 };
    case 'cylinder':
    case 'pipe':
    case 'disc':
      return { kind: 'cylinder', r: r * 0.7, r2: r * 0.8 };
    case 'cone':
      return { kind: 'cone', r: r * 0.7, r2: r * 0.8 };
    case 'capsule':
      return { kind: 'capsule', r: r * 0.5, r2: r * 0.5 };
    default:
      return { kind: 'ball', r };
  }
}
