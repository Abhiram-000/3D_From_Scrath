/**
 * The settings store's contract.
 *
 * The rules under pin come from `08`: the device decides, the platform adapts, and the learner is
 * never asked — so every setting's default is "auto" or the detected value, and nothing depends on
 * the learner having tuned anything. What the store has to get right is the *unhappy* path:
 * storage that is empty, corrupt, written by an older version, or unavailable altogether must all
 * land on the defaults rather than on a half-parsed object or a crash.
 *
 * It also covers the one reader that lives beside the schema — `narratePart` — because the promise
 * that "narration off means silence, and a browser without speech synthesis is a no-op" is a claim
 * about settings, and a claim about settings belongs in the file that tests settings.
 */
import { describe, expect, it, vi } from 'vitest';
import { UserSettings } from '@edu3d/contracts';
import { loadSettings, narratePart, saveSettings, SettingsStore, type SpeechApi } from './settings';

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

/**
 * A speech API that records what it was asked to say — so "did it speak?" and "what did it say?"
 * are observable without a DOM. `speechSynthesis` does not exist under vitest's node environment,
 * which is what makes the absent-API case the default.
 */
function fakeSpeech() {
  const spoken: SpeechSynthesisUtterance[] = [];
  const api: SpeechApi = {
    speak: (utterance) => spoken.push(utterance),
    cancel: vi.fn(),
  };
  return { api, spoken };
}

/** A stand-in utterance: only the fields `narratePart` touches. */
function fakeUtterance(text: string): SpeechSynthesisUtterance {
  return {
    text,
    rate: 1,
    voice: null,
    onend: null,
    onerror: null,
  } as unknown as SpeechSynthesisUtterance;
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

  it('fills defaults for every field a partial object omits', () => {
    // An object written by an older schema is not corrupt: the fields it does carry are kept and
    // the rest gain their defaults rather than the whole thing being thrown away.
    const settings = loadSettings(fakeStorage(JSON.stringify({ shadows: 'off' })));
    expect(settings.shadows).toBe('off');
    expect(settings.quality).toBeNull();
    expect(settings.narration).toBe(false);
    expect(settings.timeScale).toBe(1);
  });

  it('discards the whole object when one field has the wrong type', () => {
    // A single mistyped field drops the entire stored object to defaults: the surviving fields are
    // not self-evidently a coherent set, and `timeScale` must never become the string 'fast'.
    const settings = loadSettings(
      fakeStorage(JSON.stringify({ quality: 'high', timeScale: 'fast' })),
    );
    expect(settings).toEqual(UserSettings.parse({}));
    expect(settings.timeScale).toBe(1);
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

describe('a pinned quality survives the round trip', () => {
  it('keeps the learner’s pin rather than an auto-resolved value', () => {
    // `08`: the explicit choice beats the optimizer. The ladder resolves a quality for the device
    // and only *reads* settings — it never writes its answer back, so an unrelated change (or a
    // reload) must still report the pin, not the resolved value.
    const storage = fakeStorage();
    const store = new SettingsStore(storage);
    store.update({ quality: 'high' }); // the learner pins High
    store.update({ theme: 'dark' }); // an unrelated change, as a save would produce
    expect(store.current.quality).toBe('high');
    expect(loadSettings(fakeStorage(store.serialized())).quality).toBe('high');
  });
});

describe('narration obeys its own setting', () => {
  const on = { narration: true, narrationRate: 1 };
  const off = { narration: false, narrationRate: 1 };

  it('says nothing when narration is off', () => {
    const { api, spoken } = fakeSpeech();
    const narrated = narratePart('The rotor spins.', off, {
      speech: api,
      makeUtterance: fakeUtterance,
    });
    expect(narrated).toBe(false);
    expect(spoken).toHaveLength(0);
  });

  it('speaks through the platform when narration is on', () => {
    const { api, spoken } = fakeSpeech();
    const narrated = narratePart(
      'The rotor spins.',
      { narration: true, narrationRate: 1.5 },
      {
        speech: api,
        makeUtterance: fakeUtterance,
      },
    );
    const [utterance] = spoken;
    expect(narrated).toBe(true);
    expect(spoken).toHaveLength(1);
    expect(utterance?.text).toBe('The rotor spins.');
    expect(utterance?.rate).toBe(1.5);
  });

  it('hands the platform an end callback so a story can advance early', () => {
    const { api, spoken } = fakeSpeech();
    let ended = false;
    narratePart('The rotor spins.', on, {
      speech: api,
      makeUtterance: fakeUtterance,
      onend: () => (ended = true),
    });
    const [utterance] = spoken;
    utterance?.onend?.call(utterance, new Event('end') as SpeechSynthesisEvent);
    expect(ended).toBe(true);
  });

  it('is a silent no-op when the browser cannot speak', () => {
    // No `speechSynthesis` at all — the vitest node environment, or a browser without the API.
    // `05`: absence of speech is silence, not an error and never a stall.
    expect(narratePart('The rotor spins.', on)).toBe(false);
  });
});
