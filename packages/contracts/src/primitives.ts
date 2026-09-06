/**
 * Primitive value schemas shared by every other contract: identifiers, vectors, colors and the
 * bounded strings that cross the wire.
 *
 * These live in one file because the platform's trust boundary is made of them. A vector that is
 * allowed to contain `NaN` reaches the physics solver (`02` R1) and poisons a whole scene graph; an
 * id without a shape is a query parameter that reaches the database. Bounding them once, here, is
 * what makes every downstream schema safe by construction.
 */
import { z } from 'zod';

/** Rejects NaN and ±Infinity. `z.number()` alone accepts both, which is how a solver gets poisoned. */
export const finite = z.number().finite();

/** A finite number constrained to a range, used wherever a physical quantity has real limits. */
export const finiteIn = (min: number, max: number) => finite.min(min).max(max);

/**
 * Identifiers authored by the AI. Deliberately narrow: these become object names, map keys, DOM
 * `id` fragments and story-beat targets, so anything outside this alphabet is a future escaping bug.
 */
export const AuthoredId = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z][A-Za-z0-9_.-]*$/, 'must start with a letter and contain only [A-Za-z0-9_.-]');
export type AuthoredId = z.infer<typeof AuthoredId>;

/** Server-generated identifiers for stored rows. Anything not shaped like this dies at the route (06). */
export const Uuid = z.string().uuid();
export type Uuid = z.infer<typeof Uuid>;

/** Correlation id echoed to the client and written in every log line for the same request (04). */
export const RequestId = z.string().min(8).max(64);
export type RequestId = z.infer<typeof RequestId>;

export const Vec2 = z.tuple([finite, finite]);
export type Vec2 = z.infer<typeof Vec2>;

export const Vec3 = z.tuple([finite, finite, finite]);
export type Vec3 = z.infer<typeof Vec3>;

/** Quaternion, xyzw. Normalisation is the engine's job; finiteness is the contract's. */
export const Quat = z.tuple([finite, finite, finite, finite]);
export type Quat = z.infer<typeof Quat>;

/**
 * Colors are authored as sRGB hex or as a declared color-role name. `01-MODELS` requires authored
 * colors to be sRGB and rendering to be linear, with an explicit conversion — keeping the authored
 * form textual makes that conversion a single, findable place instead of an assumption.
 */
export const HexColor = z
  .string()
  .regex(/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/, 'expected #rgb or #rrggbb');
export type HexColor = z.infer<typeof HexColor>;

/** Free text authored by the AI or typed by a user. Always rendered as a text node, never as markup. */
export const shortText = (max: number) => z.string().min(1).max(max);

/** Optional prose with the same bound; empty strings are normalised away rather than stored. */
export const optionalText = (max: number) =>
  z
    .string()
    .max(max)
    .transform((value) => (value.trim().length === 0 ? undefined : value))
    .optional();

/** A unit label such as `m`, `kg`, `rad/s`. Display-only, but bounded so it cannot carry a payload. */
export const UnitLabel = z.string().max(16);
export type UnitLabel = z.infer<typeof UnitLabel>;

/** Millisecond wall-clock timestamps on the wire; `Date` objects never cross a process boundary. */
export const EpochMillis = z.number().int().nonnegative();
export type EpochMillis = z.infer<typeof EpochMillis>;
