/**
 * A learner's pinned notes: the pure model and its per-model persistence (`03` R7, `00-GOAL.md`
 * §"Annotation").
 *
 * The rule this file exists to keep is `08`'s: **storage is never the reason a page fails.** A model
 * the learner annotated in one browser may have no entry at all (a different browser), a
 * half-written one from an older schema, or an unreadable one (private browsing throws on read).
 * All three land on an empty list — never on a half-parsed note pinned to a point nobody chose — and
 * a write that storage refuses leaves the notes in memory, so "storage failures are non-fatal,
 * session-only annotations still work" (`03` R7) is true by construction rather than by luck.
 *
 * It is deliberately DOM-free beyond the `Storage` slice it is handed: the pin's world point is
 * re-projected every frame inside the worker (`sandbox-host.ts:setAnnotations`), so nothing here
 * knows about a canvas, a camera or the host. The layer that renders the pins and the page that owns
 * placement both read from this module; neither is reached from it.
 *
 * The cap is enforced here as well as in the wire schema (`SetAnnotationsRequest.pins` maxes at the
 * same number) so a stuck click cannot grow the projection, the storage entry, or the persisted
 * file — a bound applied at one end of a pipe is a bound the other end can exceed.
 */
import {
  ANNOTATIONS_STORAGE_PREFIX,
  Annotation,
  MAX_ANNOTATIONS_PER_MODEL,
  type AnnotationPin,
} from '@edu3d/contracts';

/** The slice of `Storage` this needs — structural, so tests can pass a plain object. */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** The browser's storage, or null when even referencing it throws (`localStorage` itself can). */
export function browserStorage(): StorageLike | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/** Where one model's notes live. Per model, because a note pinned to *this* assembly means nothing on another. */
export function annotationsKey(modelKey: string): string {
  return `${ANNOTATIONS_STORAGE_PREFIX}${modelKey}`;
}

/** A note the learner has written, before it is given an id and a timestamp. */
export interface AnnotationDraft {
  /** World-space point the pick ray landed on. Non-finite values are refused by the schema. */
  point: readonly [number, number, number];
  /** The part the point belonged to, when the geometry named one. */
  partId?: string | null;
  text: string;
  /** Injected by tests and by a caller that re-creates a note from a diagnostic read-out. */
  id?: string;
  createdAt?: number;
}

/**
 * Ids are a counter plus the clock, not a UUID: they only have to be unique within one model's
 * list, and a short readable id makes a persisted entry legible when a developer inspects storage.
 */
let idSequence = 0;

export function annotationId(now: number = Date.now()): string {
  idSequence += 1;
  return `a${now.toString(36)}-${idSequence.toString(36)}`;
}

/**
 * Build a note, or refuse one that cannot be persisted.
 *
 * `null` is the honest answer for a note with no words (`text` is `min(1)` in the schema, and a
 * blank label is not a label) or with a coordinate the schema rejects — the caller must not be able
 * to add a note that storage will silently drop on the next load.
 */
export function createAnnotation(draft: AnnotationDraft): Annotation | null {
  const candidate = {
    id: draft.id ?? annotationId(),
    point: [draft.point[0], draft.point[1], draft.point[2]],
    ...(draft.partId ? { partId: draft.partId } : {}),
    // Trimmed, because a note of nothing but spaces passes `min(1)` and reads as an empty bubble.
    text: draft.text.trim(),
    createdAt: draft.createdAt ?? Date.now(),
  };
  const parsed = Annotation.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

/**
 * Append a note, or return the list unchanged.
 *
 * At the cap this refuses the *new* note rather than evicting the oldest: the learner just wrote
 * this one, and silently discarding an earlier note they are still looking at is the more surprising
 * loss. Returning the identical reference (rather than an equal list) is what lets a caller's
 * reactive update skip a no-op write.
 */
export function addAnnotation(annotations: Annotation[], draft: AnnotationDraft): Annotation[] {
  if (annotations.length >= MAX_ANNOTATIONS_PER_MODEL) return annotations;
  const created = createAnnotation(draft);
  if (!created) return annotations;
  return [...annotations, created];
}

/** Change one note's text. Refused text (blank, or past the schema's 500) changes nothing. */
export function updateAnnotation(
  annotations: Annotation[],
  id: string,
  text: string,
): Annotation[] {
  const current = annotations.find((note) => note.id === id);
  if (!current) return annotations;

  const parsed = Annotation.safeParse({ ...current, text: text.trim() });
  if (!parsed.success || parsed.data.text === current.text) return annotations;

  return annotations.map((note) => (note.id === id ? parsed.data : note));
}

/** Drop one note. Removing an id that is not there changes nothing. */
export function removeAnnotation(annotations: Annotation[], id: string): Annotation[] {
  const next = annotations.filter((note) => note.id !== id);
  return next.length === annotations.length ? annotations : next;
}

/**
 * The projection payload: id and world point, and nothing else.
 *
 * `Annotation` is the persisted record; the worker only needs an id to answer with and a point to
 * project. Sending the prose across the boundary every frame would be paying to clone text the
 * worker cannot read.
 */
export function toAnnotationPins(annotations: readonly Annotation[]): AnnotationPin[] {
  return annotations.map(({ id, point }) => ({ id, point: [point[0], point[1], point[2]] }));
}

/**
 * Read a model's notes.
 *
 * Each entry is validated on its own, so one note written by an older schema is dropped while its
 * neighbours survive — the same "a settings load must never break the page" discipline as
 * `lib/core/settings.ts`, applied per note because notes are independent. An entry past the cap is
 * dropped rather than the whole read abandoned.
 */
export function loadAnnotations(
  modelKey: string,
  storage: StorageLike | null = browserStorage(),
): Annotation[] {
  if (!storage) return [];

  let raw: string | null;
  try {
    raw = storage.getItem(annotationsKey(modelKey));
  } catch {
    return [];
  }
  if (raw === null) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const kept: Annotation[] = [];
  for (const entry of parsed) {
    if (kept.length >= MAX_ANNOTATIONS_PER_MODEL) break;
    const result = Annotation.safeParse(entry);
    if (result.success) kept.push(result.data);
  }
  return kept;
}

/** Write a model's notes. Returns false when storage refused them (private browsing, quota). */
export function saveAnnotations(
  modelKey: string,
  annotations: readonly Annotation[],
  storage: StorageLike | null = browserStorage(),
): boolean {
  if (!storage) return false;
  try {
    // Sliced to the cap even though `addAnnotation` already holds it: a caller that built a list by
    // hand (a test, a migration) must not be able to write past the bound the reader enforces.
    storage.setItem(
      annotationsKey(modelKey),
      JSON.stringify(annotations.slice(0, MAX_ANNOTATIONS_PER_MODEL)),
    );
    return true;
  } catch {
    return false;
  }
}

/** Called with the whole list after every change, so the page can publish it to the host. */
export type AnnotationsListener = (annotations: readonly Annotation[]) => void;

/**
 * One model's notes in memory, persisted on change, with the change broadcast.
 *
 * This is the object the viewer page subscribes `host.setAnnotations` to: every mutation produces
 * one new list and one notification, so the worker's pin set is never a version behind the screen.
 * `persisted` reports the last write's outcome, because a learner who is in private browsing is in a
 * session-only state and the UI can say so instead of promising notes that will not be there.
 */
export class AnnotationStore {
  private annotations: Annotation[];
  private lastSaved = true;
  private readonly modelKey: string;
  private readonly storage: StorageLike | null;
  private readonly listeners = new Set<AnnotationsListener>();

  constructor(modelKey: string, storage: StorageLike | null = browserStorage()) {
    this.modelKey = modelKey;
    this.storage = storage;
    this.annotations = loadAnnotations(modelKey, storage);
  }

  get current(): readonly Annotation[] {
    return this.annotations;
  }

  /** False once a write has failed, so "these notes are session-only" can be said out loud. */
  get persisted(): boolean {
    return this.lastSaved;
  }

  add(draft: AnnotationDraft): readonly Annotation[] {
    return this.commit(addAnnotation(this.annotations, draft));
  }

  update(id: string, text: string): readonly Annotation[] {
    return this.commit(updateAnnotation(this.annotations, id, text));
  }

  remove(id: string): readonly Annotation[] {
    return this.commit(removeAnnotation(this.annotations, id));
  }

  /** Swap the whole set, for a model change that needs no re-read of storage. */
  reset(annotations: Annotation[]): readonly Annotation[] {
    return this.commit(annotations.slice(0, MAX_ANNOTATIONS_PER_MODEL));
  }

  subscribe(listener: AnnotationsListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Adopt a new list, persist it, and tell everyone — but only when it is genuinely a new list.
   * A refused edit returns the same reference, so the no-op case costs no write and no notification.
   */
  private commit(next: Annotation[]): readonly Annotation[] {
    if (next === this.annotations) return this.annotations;
    this.annotations = next;
    this.lastSaved = saveAnnotations(this.modelKey, this.annotations, this.storage);
    for (const listener of this.listeners) listener(this.annotations);
    return this.annotations;
  }
}
