/**
 * The material factory: the `mat` namespace guest code calls.
 *
 * `01-MODELS.md` makes materials *semantic* rather than decorative — "they tell the learner what a thing
 * *is*" — and caps the vocabulary on purpose: "a model with five material archetypes used meaningfully reads
 * as designed; a model with fifty ad-hoc materials reads as noise." So unlike geometry, where the ceiling is
 * deliberately open, this surface is deliberately small. The restraint is the feature.
 *
 * Two mechanisms carry most of the teaching value:
 *
 *  - **Color roles.** A model declares "carriers are amber, fields are blue, boundaries are grey" once, and
 *    every part that has that meaning uses the role. After a minute the learner stops reading labels and
 *    starts reading colour as category, which `01` calls the win.
 *  - **Parameter binding.** Emissive intensity bound to a quantity makes brightness *be* the measurement —
 *    "the model becomes its own instrument". Recorded in the manifest so the audit can verify the parameter
 *    actually drives something.
 */
import type { HexColor, MaterialArchetype, MaterialRef } from '@edu3d/contracts';
import { clamp } from '../math/index.ts';

/** What guest code holds. Opaque and frozen, for the same reason geometry handles are. */
export interface MaterialHandle {
  readonly __brand: 'material';
  readonly archetype: MaterialArchetype;
  readonly cacheKey: string;
  /** The declared role this material belongs to, when it came from one. */
  readonly role?: string;
}

/** Thrown when guest code asks for a material the engine cannot make. Message written for the model. */
export class MaterialError extends Error {
  /** Class field ([[Define]] semantics): survives the frozen Error.prototype after realm hardening, where a constructor assignment ([[Set]]) throws. */
  override name = 'MaterialError';
  constructor(message: string) {
    super(message);
  }
}

/** A declared colour role: the semantic system the learner learns to read (`01`). */
export interface ColorRoleDecl {
  id: string;
  label: string;
  color: HexColor;
  meaning: string;
}

/**
 * Physically-plausible defaults per archetype.
 *
 * These exist so a model that writes `mat.metal({ color })` gets a *believable* metal rather than a grey
 * plastic: `01` requires that "material *categories* that map to physical categories let a learner identify
 * substance on sight", and that only works if the defaults are right. Values are the standard PBR ranges —
 * metals are fully metallic and fairly smooth, insulators are dielectric, glass transmits with thickness.
 */
const ARCHETYPE_DEFAULTS: Record<
  MaterialArchetype,
  {
    metalness: number;
    roughness: number;
    opacity: number;
    transmission: number;
    emissiveIntensity: number;
  }
> = {
  metal: { metalness: 1, roughness: 0.28, opacity: 1, transmission: 0, emissiveIntensity: 0 },
  matte: { metalness: 0, roughness: 0.9, opacity: 1, transmission: 0, emissiveIntensity: 0 },
  plastic: { metalness: 0, roughness: 0.45, opacity: 1, transmission: 0, emissiveIntensity: 0 },
  // Glass is transmissive rather than merely transparent: `01` calls transmission with thickness and IOR "the
  // physically honest version", and high transparency "the cheap version".
  glass: { metalness: 0, roughness: 0.05, opacity: 1, transmission: 0.92, emissiveIntensity: 0 },
  translucent: {
    metalness: 0,
    roughness: 0.4,
    opacity: 0.45,
    transmission: 0.3,
    emissiveIntensity: 0,
  },
  emissive: { metalness: 0, roughness: 0.5, opacity: 1, transmission: 0, emissiveIntensity: 2.5 },
  toon: { metalness: 0, roughness: 1, opacity: 1, transmission: 0, emissiveIntensity: 0 },
  wire: { metalness: 0, roughness: 1, opacity: 1, transmission: 0, emissiveIntensity: 0 },
  fluid: { metalness: 0, roughness: 0.12, opacity: 0.8, transmission: 0.5, emissiveIntensity: 0 },
  organic: { metalness: 0, roughness: 0.75, opacity: 1, transmission: 0.06, emissiveIntensity: 0 },
  gradient: { metalness: 0, roughness: 0.6, opacity: 1, transmission: 0, emissiveIntensity: 0 },
};

/** Fallback colours so a material without one is never black — a black part reads as a hole in the model. */
const ARCHETYPE_COLORS: Record<MaterialArchetype, HexColor> = {
  metal: '#b9c0c8',
  matte: '#9aa0a6',
  plastic: '#d8d2c8',
  glass: '#cfe6f2',
  translucent: '#dfe8ee',
  emissive: '#ffb457',
  toon: '#e8a33d',
  wire: '#8a7d72',
  fluid: '#4f9fd8',
  organic: '#c98a72',
  gradient: '#e0a45c',
};

const HEX_PATTERN = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

/**
 * Validate an authored colour.
 *
 * `01` requires one colour-space discipline: authored colours are sRGB, rendering is linear, converted
 * explicitly. Keeping the authored form textual and validated here means the conversion happens in exactly one
 * place downstream rather than being assumed everywhere.
 */
function requireColor(value: unknown, name: string): HexColor {
  if (typeof value !== 'string' || !HEX_PATTERN.test(value)) {
    throw new MaterialError(
      `${name} must be an sRGB hex colour like '#c8a04f' or '#fc0'. Received ${typeof value === 'string' ? `'${value}'` : typeof value}.`,
    );
  }
  return value as HexColor;
}

const optionalNumber = (
  value: unknown,
  name: string,
  min: number,
  max: number,
): number | undefined => {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new MaterialError(`${name} must be a finite number between ${min} and ${max}.`);
  }
  return clamp(value, min, max);
};

/** Options every archetype accepts. Archetype-specific extras are layered on top. */
export interface MaterialOptions {
  color?: string;
  /** Use a declared colour role instead of a literal colour. */
  role?: string;
  metalness?: number;
  roughness?: number;
  opacity?: number;
  transmission?: number;
  emissive?: string;
  emissiveIntensity?: number;
  /**
   * Bind emissive intensity (or colour, for `gradient`) to a parameter.
   *
   * `01`: "Bind the emissive intensity to the quantity it represents so brightness *is* the measurement — the
   * model becomes its own instrument." Recorded in the manifest so the audit can check the parameter leads
   * somewhere.
   */
  boundTo?: string;
  /** True when a procedural surface drives this material — a heat map, brushed direction, field contours. */
  procedural?: boolean;
  /** Render both faces. Needed for open shells and cutaways, where a single-sided wall vanishes when cut. */
  doubleSided?: boolean;
  /** Flat shading, for diagram-style models where clean separation beats realism (`01`). */
  flat?: boolean;
}

/**
 * The material factory.
 *
 * One per build, like the geometry factory, so everything it holds dies with the model — the flat-memory
 * requirement in `08` and the clean-lifecycle requirement in `02` R7 both depend on that.
 */
export class MaterialFactory {
  private readonly cache = new Map<string, MaterialRef>();
  private readonly byHandle = new WeakMap<MaterialHandle, MaterialRef>();
  private readonly roles = new Map<string, ColorRoleDecl>();

  readonly warnings: string[] = [];

  /** Roles the model declared, in declaration order, for the manifest and the info panel's legend. */
  declaredRoles(): ColorRoleDecl[] {
    return [...this.roles.values()];
  }

  /** Every distinct material, for the realizer to create once each. */
  entries(): Iterable<MaterialRef> {
    return this.cache.values();
  }

  resolve(handle: MaterialHandle): MaterialRef | undefined {
    return this.byHandle.get(handle);
  }

  get stats(): { unique: number; roles: number } {
    return { unique: this.cache.size, roles: this.roles.size };
  }

  dispose(): void {
    this.cache.clear();
    this.roles.clear();
    this.warnings.length = 0;
  }

  /** Declare a colour role. Re-declaring an id replaces it and warns, rather than silently diverging. */
  declareRole(decl: ColorRoleDecl): void {
    if (this.roles.has(decl.id)) {
      this.warnings.push(
        `Colour role '${decl.id}' was declared twice; the later declaration replaced the earlier one.`,
      );
    }
    this.roles.set(decl.id, decl);
  }

  /**
   * Build a material, deduplicating by structural key.
   *
   * The dedup matters more here than it looks: a 300-part assembly typically uses six materials, and creating
   * 300 GPU material objects would thrash shader-program state every frame — the driver cost `08` warns about
   * under "render-order and state sorting".
   */
  private make(archetype: MaterialArchetype, options: MaterialOptions = {}): MaterialHandle {
    const defaults = ARCHETYPE_DEFAULTS[archetype];

    let color: HexColor;
    let role: string | undefined;

    if (options.role !== undefined) {
      const declared = this.roles.get(options.role);
      if (!declared) {
        throw new MaterialError(
          `Colour role '${options.role}' has not been declared. Call scene.colorRole({ id, label, color, meaning }) before using it.`,
        );
      }
      color = declared.color;
      role = declared.id;
    } else if (options.color !== undefined) {
      color = requireColor(options.color, `${archetype} color`);
    } else {
      color = ARCHETYPE_COLORS[archetype];
    }

    const ref: MaterialRef = {
      archetype,
      cacheKey: '',
      color,
      ...(role ? { role } : {}),
      metalness: optionalNumber(options.metalness, 'metalness', 0, 1) ?? defaults.metalness,
      roughness: optionalNumber(options.roughness, 'roughness', 0, 1) ?? defaults.roughness,
      opacity: optionalNumber(options.opacity, 'opacity', 0, 1) ?? defaults.opacity,
      transmission:
        optionalNumber(options.transmission, 'transmission', 0, 1) ?? defaults.transmission,
      emissiveIntensity:
        optionalNumber(options.emissiveIntensity, 'emissiveIntensity', 0, 64) ??
        defaults.emissiveIntensity,
      procedural: options.procedural === true,
      ...(options.boundTo ? { boundToParameter: options.boundTo } : {}),
    };

    // The key includes every rendering-relevant field, so two materials that differ only in a bound parameter
    // stay distinct — they will diverge the moment the learner drags a slider.
    const cacheKey = [
      archetype,
      ref.color,
      ref.role ?? '',
      ref.metalness,
      ref.roughness,
      ref.opacity,
      ref.transmission,
      ref.emissiveIntensity,
      ref.procedural ? 'p' : '',
      ref.boundToParameter ?? '',
      options.doubleSided ? 'ds' : '',
      options.flat ? 'flat' : '',
      options.emissive ? requireColor(options.emissive, 'emissive') : '',
    ].join('|');

    const cached = this.cache.get(cacheKey);
    if (cached) {
      const handle = Object.freeze({
        __brand: 'material' as const,
        archetype,
        cacheKey,
        ...(role ? { role } : {}),
      });
      this.byHandle.set(handle, cached);
      return handle;
    }

    const stored: MaterialRef = { ...ref, cacheKey };
    this.cache.set(cacheKey, stored);

    const handle: MaterialHandle = Object.freeze({
      __brand: 'material' as const,
      archetype,
      cacheKey,
      ...(role ? { role } : {}),
    });
    this.byHandle.set(handle, stored);
    return handle;
  }

  /**
   * The frozen facade.
   *
   * Named per archetype rather than a single `mat.create({ archetype })` because the name is the teaching cue:
   * a model author writing `mat.glass(...)` for a containment vessel has made a *semantic* choice, and the
   * audit can read that choice. `mat.create({ archetype: 'glass' })` would carry the same data and none of the
   * intent.
   */
  createFacade(): Readonly<Record<string, unknown>> {
    const facade = {
      /** Machined parts, conductors, structural steel. High metalness, low roughness (`01`). */
      metal: (options?: MaterialOptions) => this.make('metal', options),

      /** Organic matter, insulators, cast surfaces. Low metalness, high roughness. */
      matte: (options?: MaterialOptions) => this.make('matte', options),

      plastic: (options?: MaterialOptions) => this.make('plastic', options),

      /**
       * Containers, lenses, fluids, membranes — anything the lesson needs to see through.
       *
       * `01`: "see-through is how internals stop being hidden." Double-sided by default because a glass shell
       * that is single-sided disappears from inside, which is exactly where the lesson usually is.
       */
      glass: (options?: MaterialOptions) => this.make('glass', { doubleSided: true, ...options }),

      /** Explanatory shells: a cell membrane, reactor containment, skin over organs. Opacity teaches layers. */
      translucent: (options?: MaterialOptions) =>
        this.make('translucent', { doubleSided: true, ...options }),

      /**
       * Energy, charge, heat, signal — anything that emits or carries the phenomenon.
       *
       * Bind `boundTo` to the quantity it represents and brightness becomes the read-out.
       */
      emissive: (options?: MaterialOptions) => this.make('emissive', options),

      /** Diagram style: flat, clean separation. `01` notes maths and abstractions read *better* non-photoreal. */
      toon: (options?: MaterialOptions) => this.make('toon', { flat: true, ...options }),

      /** Structural lines only — topology, construction, and a debugging aid when a model looks wrong. */
      wire: (options?: MaterialOptions) => this.make('wire', options),

      /** Water, coolant, blood, magma. Transmissive and smooth, so flow reads through it. */
      fluid: (options?: MaterialOptions) => this.make('fluid', { doubleSided: true, ...options }),

      /** Tissue, wood, bone, leaf. Slight subsurface transmission is what stops flesh looking like plastic. */
      organic: (options?: MaterialOptions) => this.make('organic', options),

      /**
       * Vertex-colour driven surface, for geometry carrying a scalar field.
       *
       * Pairs with `geom.colorByField`: a stress plot, a temperature map, a potential. `01`'s "read-out wearing
       * a surface".
       */
      gradient: (options?: MaterialOptions) => this.make('gradient', options),

      /**
       * Look up the colour a declared role resolves to.
       *
       * Exposed so a model can use a role's colour for something that is not a material — a line, a label, a
       * particle tint — and keep the semantic system consistent across all of them.
       */
      roleColor: (id: string): string => {
        const declared = this.roles.get(id);
        if (!declared) {
          throw new MaterialError(
            `Colour role '${id}' has not been declared. Call scene.colorRole(...) first.`,
          );
        }
        return declared.color;
      },
    };

    return Object.freeze(facade);
  }
}

/**
 * Contrast ratio between two sRGB hex colours, per WCAG relative luminance.
 *
 * Used by the audit rather than by rendering. `01` requires adjacency contrast — "touching or interacting parts
 * must be distinguishable at a glance — by lightness as much as hue (a dark blue next to a black fails even for
 * fully-sighted learners)" — and that is only machine-checkable with a real luminance calculation.
 */
export function contrastRatio(a: string, b: string): number {
  const luminance = (hex: string): number => {
    const normalised =
      hex.length === 4 ? `#${hex[1]}${hex[1]}${hex[2]}${hex[2]}${hex[3]}${hex[3]}` : hex;
    const channel = (offset: number): number => {
      const value = Number.parseInt(normalised.slice(offset, offset + 2), 16) / 255;
      // The sRGB → linear transfer function. Averaging the raw bytes instead is the common shortcut and it
      // misjudges exactly the mid-tone pairs this check exists to catch.
      return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
  };

  const la = luminance(a);
  const lb = luminance(b);
  const lighter = Math.max(la, lb);
  const darker = Math.min(la, lb);
  return (lighter + 0.05) / (darker + 0.05);
}
