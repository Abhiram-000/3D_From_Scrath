/**
 * The settings store's contract.
 *
 * The rules under pin come from `08`: the device decides, the platform adapts, and the learner is
 * never asked — so every setting's default is "auto" or the detected value, and nothing depends on
 * the learner having tuned anything. What the store has to get right is the *unhappy* path:
 * storage that is empty, corrupt, written by an older version, or unavailable altogether must all
 * land on the defaults rather than on a half-parsed object or a crash.
 */
import { describe, expect, it } from 'vitest';
import { UserSettings } from '@edu3d/contracts';
import { loadSettings, saveSettings, SettingsStore } from './settings';

/** A storage that behaves like the real one, with a switch for the ways it fails. */
function fakeStorage(initial?: string, options: { throws?: boolean } = {}) {
  let value = initial ?? null;
  return {
    getItem: (key: string) => {
      if (options.throws) throw new Error('storage unavailable');
      return key === 'edu3d.settings.v1' ? value : null;
    },
    setItem: (key: string, next: string) => {
      if (options.throws) throw new Error('storage unavailable');
      if (key === 'edu3d.settings.v1') value = next;
    },
    read: () => value,
  };
}

describe('reading settings', () => {
  it('gives every setting a default when nothing has been stored', () => {
    const settings = loadSettings(fakeStorage());
    // Parsing the contract's own schema is what makes "defaulted" provable rather than assumed.
    expect(settings).toEqual(UserSettings.parse({}));
    expect(settings.quality).toBeNull();
    expect(settings.theme).toBe('system');
  });

  it('reads back what was stored', () => {
    const storage = fakeStorage();
    saveSettings(UserSettings.parse({ quality: 'medium', theme: 'light' }), storage);
    const settings = loadSettings(storage);
    expect(settings.quality).toBe('medium');
    expect(settings.theme).toBe('light');
  });

  it('fills in settings an older version never wrote', () => {
    // A stored object from before a field existed must not fail to parse; it must gain the default.
    const storage = fakeStorage(JSON.stringify({ quality: 'high' }));
    const settings = loadSettings(storage);
    expect(settings.quality).toBe('high');
    expect(settings.autoRotate).toBe(true);
    expect(settings.timeScale).toBe(1);
  });

  it('falls back to the defaults when the stored value is corrupt', () => {
    const settings = loadSettings(fakeStorage('{not json at all'));
    expect(settings).toEqual(UserSettings.parse({}));
  });

  it('falls back to the defaults when a stored value is out of range', () => {
    // `{quality: 'enormous'}` is not a quality; a learner who somehow has that stored gets the
    // defaults rather than a crashed viewer.
    const settings = loadSettings(fakeStorage(JSON.stringify({ quality: 'enormous' })));
    expect(settings.quality).toBeNull();
  });

  it('falls back to the defaults when storage itself throws', () => {
    // Private browsing throws on read. A settings load must never be the reason a page fails.
    const settings = loadSettings(fakeStorage(undefined, { throws: true }));
    expect(settings).toEqual(UserSettings.parse({}));
  });
});

describe('writing settings', () => {
  it('reports whether the write landed', () => {
    expect(saveSettings(UserSettings.parse({ quality: 'low' }), fakeStorage())).toBe(true);
    expect(saveSettings(UserSettings.parse({}), fakeStorage(undefined, { throws: true }))).toBe(
      false,
    );
  });

  it('stores the whole object, so a later load needs no special cases', () => {
    const storage = fakeStorage();
    saveSettings(UserSettings.parse({ quality: 'low', theme: 'dark' }), storage);
    const stored = JSON.parse(storage.read() ?? '{}');
    expect(stored.quality).toBe('low');
    expect(stored.theme).toBe('dark');
    expect(Object.keys(stored).length).toBeGreaterThan(5);
  });
});

describe('the store the app uses', () => {
  it('starts on whatever was stored, and updates through itself', () => {
    const store = new SettingsStore(fakeStorage());
    expect(store.current.quality).toBeNull();

    store.update({ quality: 'medium' });

    expect(store.current.quality).toBe('medium');
    // The change is persisted, not just held: a pin that forgets itself on reload is not a pin.
    expect(loadSettings(fakeStorage(store.serialized())).quality).toBe('medium');
  });

  it('keeps the rest of the settings when one changes', () => {
    const store = new SettingsStore(fakeStorage());
    store.update({ theme: 'light' });
    store.update({ quality: 'high' });
    expect(store.current.theme).toBe('light');
    expect(store.current.quality).toBe('high');
  });

  it('refuses an update that does not fit the schema, keeping what it had', () => {
    // A bad patch must not be able to destroy the settings the learner already has. Refusing it
    // and leaving the store untouched is the honest failure: the alternative — writing it anyway —
    // corrupts the stored object, and silently ignoring it would make a broken control look like a
    // working one.
    const store = new SettingsStore(fakeStorage());
    store.update({ quality: 'high' });
    store.update({ quality: 'enormous' } as never);
    expect(store.current.quality).toBe('high');
  });
});
