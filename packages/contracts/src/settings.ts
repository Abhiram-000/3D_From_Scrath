/**
 * User settings, persisted client-side and applied before first paint where they affect rendering.
 *
 * Two rules govern this file. `08` requires that "the device decides, the platform adapts, the user is
 * never asked and never lied to" — so every setting here defaults to `auto` or to the detected value,
 * and nothing forces a learner to tune anything. And `08` again: "the user's explicit quality choice
 * beats the optimizer, which then only warns" — which is why `quality` is a nullable override rather
 * than a plain value.
 */
import { z } from 'zod';
import { QualityPreset } from './budgets.ts';
import { ChatPersona } from './wire/api.ts';

/** Theme is applied by an inline script before any style, so a wrong-colour flash never happens (`07`). */
export const ThemeChoice = z.enum(['dark', 'light', 'system']);
export type ThemeChoice = z.infer<typeof ThemeChoice>;

export const UserSettings = z.object({
  theme: ThemeChoice.default('system'),

  /** Null means "let the adaptive ladder decide". A value pins quality and demotes the optimizer to a warner. */
  quality: QualityPreset.nullable().default(null),
  shadows: z.enum(['auto', 'on', 'off']).default('auto'),
  postProcessing: z.enum(['auto', 'on', 'off']).default('auto'),

  /** Physics is a progressive enhancement; `off` is honest, never a silent fake (`02` R1). */
  physics: z.enum(['auto', 'on', 'off']).default('auto'),
  /** Slow-motion for collision study. 1 is real time (`02` interaction). */
  timeScale: z.number().min(0.05).max(2).default(1),

  /** Voice narration. Absence of speech synthesis is silent, not an error (`05`). */
  narration: z.boolean().default(false),
  narrationRate: z.number().min(0.5).max(2).default(1),
  narrationVoice: z.string().max(120).optional(),

  chatPersona: ChatPersona.default('teacher'),

  /** Mirrors `prefers-reduced-motion` by default; an explicit choice overrides the media query. */
  reducedMotion: z.enum(['auto', 'on', 'off']).default('auto'),

  /** Camera idle orbit. On by default because "a viewer that is inert until clicked wastes the medium". */
  autoRotate: z.boolean().default(true),
  /** Orbit sensitivity multiplier, shared by mouse and touch so the feel matches across inputs. */
  cameraSensitivity: z.number().min(0.25).max(3).default(1),

  /** Shows the diagnostics panel and per-frame counters by default for power users. */
  showDiagnostics: z.boolean().default(false),

  /** Bearer token for write endpoints when the deployment configures one (`06`). Never sent in a URL. */
  writeToken: z.string().max(200).optional(),
});
export type UserSettings = z.infer<typeof UserSettings>;

/** Storage key. Versioned so a schema change can be migrated rather than silently mis-parsed. */
export const SETTINGS_STORAGE_KEY = 'edu3d.settings.v1';

/** Theme is read by the inline head script, which cannot parse the whole settings object cheaply. */
export const THEME_STORAGE_KEY = 'edu3d.theme';

/** Annotations are per model and capped, so a stuck click cannot fill storage (`03` R7). */
export const ANNOTATIONS_STORAGE_PREFIX = 'edu3d.annotations.';
export const MAX_ANNOTATIONS_PER_MODEL = 64;

/** A learner's pinned note, glued to a world point on the geometry (`03` R7). */
export const Annotation = z.object({
  id: z.string().max(64),
  /** World-space point on the model; re-projected every frame as the camera moves. */
  point: z.tuple([z.number().finite(), z.number().finite(), z.number().finite()]),
  /** The part it was pinned to, so a model swap can discard notes that no longer have a home. */
  partId: z.string().max(64).optional(),
  text: z.string().min(1).max(500),
  createdAt: z.number().int().nonnegative(),
});
export type Annotation = z.infer<typeof Annotation>;
