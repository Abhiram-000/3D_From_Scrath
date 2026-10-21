/**
 * The learner's settings, persisted client-side.
 *
 * `08`'s rule is the reason this file is small: "the device decides, the platform adapts, the user
 * is never asked and never lied to". Every setting's default is `auto` or the detected value, so a
 * learner who never opens settings still gets a platform that has adapted to their device — and a
 * learner who *does* pin something gets their choice honoured over the optimizer's.
 *
 * The unhappy paths are the ones this module exists to get right. Storage can be empty, corrupt,
 * written by an older version of the schema, or unavailable entirely (private browsing throws on
 * read). All four land on the contract's defaults rather than on a half-parsed object, because a
 * settings load must never be the reason a page fails.
 *
 * It also owns the one runtime reader that cannot be separated from the schema it reads: narration.
 * `narration` and `narrationRate` only mean anything where speech is emitted, so the gate — speak
 * only when the setting is on, and only when the platform can speak — lives beside the defaults or
 * the two drift apart. `narratePart` is the single door to speech: the story's beats and the
 * viewer's per-part read-out both go through it, and neither can speak when nothing is set.
 */
import { SETTINGS_STORAGE_KEY, UserSettings } from '@edu3d/contracts';

/** The slice of `Storage` this needs — structural, so tests can pass a plain object. */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** The browser's storage, or null when reading it throws (`localStorage` itself can throw). */
function browserStorage(): StorageLike | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/**
 * Read the settings.
 *
 * A stored object that no longer fits the schema — because a field was removed, renamed, or holds a
 * value from an older range — is discarded whole rather than patched. The defaults are always a
 * coherent set; a half-applied old one is not.
 */
export function loadSettings(storage: StorageLike | null = browserStorage()): UserSettings {
  if (!storage) return UserSettings.parse({});

  let raw: string | null;
  try {
    raw = storage.getItem(SETTINGS_STORAGE_KEY);
  } catch {
    // Private browsing throws on read; a settings load must never be the reason a page fails.
    return UserSettings.parse({});
  }
  if (raw === null) return UserSettings.parse({});

  try {
    // `parse` fills in every field the stored object does not carry, so a settings file written
    // before a field existed still loads and simply gains that field's default.
    return UserSettings.parse(JSON.parse(raw));
  } catch {
    return UserSettings.parse({});
  }
}

/** Write the settings. Returns false when storage refused them (private browsing, quota). */
export function saveSettings(
  settings: UserSettings,
  storage: StorageLike | null = browserStorage(),
): boolean {
  if (!storage) return false;
  try {
    storage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
    return true;
  } catch {
    return false;
  }
}

/** The slice of `SpeechSynthesis` narration needs — structural, so tests can pass a plain object. */
export interface SpeechApi {
  speak(utterance: SpeechSynthesisUtterance): void;
  cancel(): void;
}

/** The fields narration reads. Narrower than `UserSettings` so a caller can pass just these. */
export type NarrationSettings = Pick<
  UserSettings,
  'narration' | 'narrationRate' | 'narrationVoice'
>;

/** The browser's speech synthesis, or null when it has none (or referencing it throws). */
export function speechSynthesisApi(): SpeechApi | null {
  try {
    return typeof speechSynthesis !== 'undefined' ? speechSynthesis : null;
  } catch {
    return null;
  }
}

/** The utterance constructor, or null where the platform has none. */
function browserUtteranceFactory(): ((text: string) => SpeechSynthesisUtterance) | null {
  try {
    return typeof SpeechSynthesisUtterance === 'function'
      ? (text: string) => new SpeechSynthesisUtterance(text)
      : null;
  } catch {
    return null;
  }
}

/**
 * Read `text` aloud, and only when the learner has asked for it.
 *
 * This is the one place the platform speaks, so the hostile cases are handled here rather than at
 * each call site: narration off is silence, an empty string is silence, a browser with no
 * `speechSynthesis` is silence, and a synthesiser that throws mid-utterance is swallowed. `05` and
 * `00` are explicit that absence of speech is a first-class silent state, never an error and never
 * a stall — so this returns whether it spoke, and callers keep their own non-speech fallback.
 *
 * `speech` and `makeUtterance` are injectable purely so the gate can be tested without a DOM; both
 * default to the browser's own objects.
 */
export function narratePart(
  text: string,
  settings: NarrationSettings,
  options: {
    /** Fired when the utterance finishes, so a caller can advance sooner than its reading timer. */
    onend?: () => void;
    speech?: SpeechApi | null;
    makeUtterance?: (text: string) => SpeechSynthesisUtterance;
  } = {},
): boolean {
  // The setting is the first gate: a control that says "off" must mean off, whatever the device can do.
  if (!settings.narration) return false;

  const speech = options.speech ?? speechSynthesisApi();
  const makeUtterance = options.makeUtterance ?? browserUtteranceFactory();
  if (!speech || !makeUtterance) return false;

  const spoken = text.trim();
  if (spoken.length === 0) return false;

  try {
    const utterance = makeUtterance(spoken);
    utterance.rate = settings.narrationRate;
    utterance.onend = options.onend ? () => options.onend?.() : null;
    speech.speak(utterance);
    return true;
  } catch {
    // Synthesis unavailable or refused: reading-time auto-advance covers it.
    return false;
  }
}

/**
 * The settings the app reads and writes while it runs.
 *
 * Holds the current object so callers read one coherent set, and persists on every change so a
 * choice survives a reload. An update that does not fit the schema is refused and changes nothing:
 * a bad patch must not be able to destroy settings the learner already has, and silently ignoring
 * one would make a broken control look like a working one.
 */
export class SettingsStore {
  private settings: UserSettings;
  private readonly storage: StorageLike | null;

  constructor(storage: StorageLike | null = browserStorage()) {
    this.storage = storage;
    this.settings = loadSettings(storage);
  }

  get current(): UserSettings {
    return this.settings;
  }

  /** Apply a partial change. Returns the settings as they now stand, whether or not it landed. */
  update(patch: Partial<UserSettings>): UserSettings {
    const parsed = UserSettings.safeParse({ ...this.settings, ...patch });
    if (parsed.success) {
      this.settings = parsed.data;
      saveSettings(this.settings, this.storage);
    }
    return this.settings;
  }

  /** The stored form, for callers that need to hand it on (a test, a diagnostic). */
  serialized(): string {
    return JSON.stringify(this.settings);
  }
}
