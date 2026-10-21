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
