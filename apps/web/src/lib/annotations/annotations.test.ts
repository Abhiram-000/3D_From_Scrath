/**
 * The annotation model's contract (`03` R7).
 *
 * The rules under pin are the same unhappy-path rules `08` sets for settings, applied per note:
 * storage that is absent, corrupt, written by an older schema, or unavailable altogether must land
 * on an empty list rather than on a note pinned to a point nobody chose. The cap and the text bound
 * are checked here too, because both are claims the UI relies on — "a stuck click cannot fill
 * storage" and "an over-long note is refused" are only true if the code that adds notes refuses.
 *
 * The host is deliberately absent: nothing here knows about a worker, a canvas or a camera. What is
 * tested is the pure model and its `Storage` slice.
 */
import { describe, expect, it } from 'vitest';
import { MAX_ANNOTATIONS_PER_MODEL, type Annotation } from '@edu3d/contracts';
import {
  addAnnotation,
  annotationId,
  annotationsKey,
  AnnotationStore,
  createAnnotation,
  loadAnnotations,
  removeAnnotation,
  saveAnnotations,
  toAnnotationPins,
  updateAnnotation,
  type StorageLike,
} from './annotations';

const KEY = 'edu3d.annotations.model-1';

/** A note that satisfies the schema, so a test can build a list without repeating five fields. */
function note(id: string, text = 'note text'): Annotation {
  return { id, point: [1, 2, 3], text, createdAt: 0 };
}

/** A storage that behaves like the real one, with a switch for the way it fails. */
function memoryStorage(initial: Record<string, string> = {}) {
  const map = new Map<string, string>(Object.entries(initial));
  let refuseWrites = false;
  const storage: StorageLike = {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      if (refuseWrites) throw new Error('quota exceeded');
      map.set(key, value);
    },
  };
  return {
    storage,
    read: (key: string) => map.get(key) ?? null,
    refuseWrites: () => {
      refuseWrites = true;
    },
  };
}

describe('the annotation key', () => {
  it('is namespaced per model', () => {
    expect(annotationsKey('cube')).toBe(`edu3d.annotations.cube`);
  });

  it('produces distinct, non-empty ids', () => {
    const first = annotationId(1000);
    const second = annotationId(1000);
    expect(first).not.toBe(second);
    expect(first.length).toBeGreaterThan(0);
  });
});

describe('building a note', () => {
  it('trims the text and stamps an id and a time', () => {
    const created = createAnnotation({
      point: [1, 2, 3],
      text: '  hello  ',
      createdAt: 7,
      id: 'a1',
    });
    expect(created).toEqual({ id: 'a1', point: [1, 2, 3], text: 'hello', createdAt: 7 });
  });

  it('omits partId when there is none', () => {
    const created = createAnnotation({ point: [0, 0, 0], text: 'x', id: 'a1', createdAt: 0 });
    expect(created && 'partId' in created).toBe(false);
  });

  it('keeps partId when the geometry named one', () => {
    const created = createAnnotation({
      point: [0, 0, 0],
      partId: 'gear',
      text: 'x',
      id: 'a1',
      createdAt: 0,
    });
    expect(created?.partId).toBe('gear');
  });

  it('refuses a blank note rather than storing an empty label', () => {
    expect(createAnnotation({ point: [0, 0, 0], text: '   ' })).toBeNull();
  });

  it('refuses a note past the schema length', () => {
    expect(createAnnotation({ point: [0, 0, 0], text: 'x'.repeat(501) })).toBeNull();
  });

  it('refuses a non-finite point', () => {
    expect(createAnnotation({ point: [0, 0, Number.NaN], text: 'x' })).toBeNull();
  });
});

describe('editing the list', () => {
  it('appends a valid note', () => {
    const added = addAnnotation([], { point: [1, 1, 1], text: 'hi', id: 'a1', createdAt: 0 });
    expect(added.map((note) => note.text)).toEqual(['hi']);
  });

  it('refuses the new note at the cap instead of evicting an older one', () => {
    const full = Array.from({ length: MAX_ANNOTATIONS_PER_MODEL }, (_, i) => note(`n${i}`));
    const added = addAnnotation(full, { point: [0, 0, 0], text: 'one too many' });
    expect(added).toBe(full);
  });

  it('refuses an over-long note and leaves the list untouched', () => {
    const list = [note('a')];
    expect(addAnnotation(list, { point: [0, 0, 0], text: 'x'.repeat(501) })).toBe(list);
  });

  it('updates a note in place', () => {
    const list = [note('a', 'old'), note('b')];
    const updated = updateAnnotation(list, 'a', 'new');
    expect(updated.map((note) => note.text)).toEqual(['new', 'note text']);
    expect(updated[1]).toBe(list[1]);
    expect(list.map((note) => note.text)).toEqual(['old', 'note text']);
  });

  it('refuses an over-long edit and changes nothing', () => {
    const list = [note('a', 'old')];
    expect(updateAnnotation(list, 'a', 'x'.repeat(501))).toBe(list);
  });

  it('refuses a blank edit', () => {
    const list = [note('a', 'old')];
    expect(updateAnnotation(list, 'a', '   ')).toBe(list);
  });

  it('ignores an edit for an unknown id', () => {
    const list = [note('a')];
    expect(updateAnnotation(list, 'missing', 'new')).toBe(list);
  });

  it('removes a note and is a no-op for an unknown id', () => {
    const list = [note('a'), note('b')];
    expect(removeAnnotation(list, 'a').map((n) => n.id)).toEqual(['b']);
    expect(removeAnnotation(list, 'zzz')).toBe(list);
  });
});

describe('the projection payload', () => {
  it('carries only the id and point, never the prose', () => {
    const pins = toAnnotationPins([note('a', 'a long explanation nobody in the worker can read')]);
    expect(pins).toEqual([{ id: 'a', point: [1, 2, 3] }]);
  });
});

describe('persistence', () => {
  it('round-trips a model’s notes', () => {
    const { storage } = memoryStorage();
    expect(saveAnnotations('model-1', [note('a', 'first'), note('b', 'second')], storage)).toBe(
      true,
    );
    expect(loadAnnotations('model-1', storage)).toEqual([note('a', 'first'), note('b', 'second')]);
  });

  it('lands on an empty list when nothing has been stored', () => {
    const { storage } = memoryStorage();
    expect(loadAnnotations('model-1', storage)).toEqual([]);
  });

  it('lands on an empty list when the stored value is not JSON', () => {
    const { storage } = memoryStorage({ [KEY]: '{not json' });
    expect(loadAnnotations('model-1', storage)).toEqual([]);
  });

  it('lands on an empty list when the stored value is not an array', () => {
    const { storage } = memoryStorage({ [KEY]: JSON.stringify({ id: 'a' }) });
    expect(loadAnnotations('model-1', storage)).toEqual([]);
  });

  it('discards only the entries that fail the schema', () => {
    const { storage } = memoryStorage({
      [KEY]: JSON.stringify([
        note('good'),
        { id: 'missing-createdAt', point: [0, 0, 0], text: 'partial' },
        { id: 'no-text', point: [0, 0, 0], createdAt: 0 },
        { id: 'long-text', point: [0, 0, 0], text: 'x'.repeat(501), createdAt: 0 },
        note('also-good'),
      ]),
    });
    expect(loadAnnotations('model-1', storage).map((n) => n.id)).toEqual(['good', 'also-good']);
  });

  it('keeps no more than the cap when storage holds too many', () => {
    const many = Array.from({ length: MAX_ANNOTATIONS_PER_MODEL + 10 }, (_, i) => note(`n${i}`));
    const { storage } = memoryStorage({ [KEY]: JSON.stringify(many) });
    expect(loadAnnotations('model-1', storage)).toHaveLength(MAX_ANNOTATIONS_PER_MODEL);
  });

  it('slices a hand-built list to the cap on write', () => {
    const many = Array.from({ length: MAX_ANNOTATIONS_PER_MODEL + 10 }, (_, i) => note(`n${i}`));
    const { storage, read } = memoryStorage();
    saveAnnotations('model-1', many, storage);
    expect(JSON.parse(read(KEY) as string)).toHaveLength(MAX_ANNOTATIONS_PER_MODEL);
  });

  it('reports failure and changes nothing when storage is absent', () => {
    expect(saveAnnotations('model-1', [note('a')], null)).toBe(false);
    expect(loadAnnotations('model-1', null)).toEqual([]);
  });

  it('lands on an empty list when reading throws', () => {
    const storage: StorageLike = {
      getItem: () => {
        throw new Error('private browsing');
      },
      setItem: () => undefined,
    };
    expect(loadAnnotations('model-1', storage)).toEqual([]);
  });
});

describe('the store', () => {
  it('persists a change and notifies subscribers with the new list', () => {
    const { storage, read } = memoryStorage();
    const store = new AnnotationStore('model-1', storage);
    const seen: string[][] = [];
    store.subscribe((notes) => seen.push(notes.map((n) => n.id)));

    store.add({ point: [1, 2, 3], text: 'first', id: 'a', createdAt: 0 });
    expect(seen).toEqual([['a']]);
    expect(store.current).toHaveLength(1);
    expect(JSON.parse(read(KEY) as string)).toHaveLength(1);
  });

  it('keeps session-only notes alive when storage refuses the write', () => {
    const { storage } = memoryStorage();
    storage.setItem = () => {
      throw new Error('quota exceeded');
    };
    const store = new AnnotationStore('model-1', storage);

    store.add({ point: [1, 2, 3], text: 'kept anyway', id: 'a', createdAt: 0 });
    expect(store.current.map((n) => n.text)).toEqual(['kept anyway']);
    expect(store.persisted).toBe(false);
  });

  it('does not notify on a refused edit', () => {
    const { storage } = memoryStorage();
    const store = new AnnotationStore('model-1', storage);
    store.add({ point: [1, 2, 3], text: 'first', id: 'a', createdAt: 0 });

    let notifications = 0;
    store.subscribe(() => {
      notifications += 1;
    });
    store.update('a', 'x'.repeat(501));
    expect(notifications).toBe(0);
    expect(store.current.map((note) => note.text)).toEqual(['first']);
  });

  it('stops notifying after an unsubscribe', () => {
    const { storage } = memoryStorage();
    const store = new AnnotationStore('model-1', storage);
    let notifications = 0;
    const off = store.subscribe(() => {
      notifications += 1;
    });
    off();
    store.add({ point: [1, 2, 3], text: 'first', id: 'a', createdAt: 0 });
    expect(notifications).toBe(0);
  });

  it('reads the notes back when re-created for the same model', () => {
    const { storage } = memoryStorage();
    new AnnotationStore('model-1', storage).add({
      point: [1, 2, 3],
      text: 'first',
      id: 'a',
      createdAt: 0,
    });
    expect(new AnnotationStore('model-1', storage).current.map((n) => n.id)).toEqual(['a']);
  });
});
