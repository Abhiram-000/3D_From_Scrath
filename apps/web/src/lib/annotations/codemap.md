# apps/web/src/lib/annotations/

## Responsibility

The learner's pinned notes: the pure model and its per-model persistence (`03` R7, `00-GOAL.md` §"Annotation"). It is framework-free and DOM-free beyond the `Storage` slice it is handed — `annotations.ts` knows nothing about a canvas, a camera or the sandbox host.

## Design

- The rule this folder exists to keep is `08`'s: **storage is never the reason a page fails.** A model annotated in one browser may have no entry (a different browser), a half-written one from an older schema, or an unreadable one (private browsing throws on read); all three land on an empty list, never a half-parsed note pinned to a point nobody chose. `loadAnnotations` validates each entry on its own, so one bad note is dropped while its neighbours survive; `saveAnnotations` returns false when storage refuses (private browsing, quota) and the caller can say "session-only" instead of promising notes that will not be there.
- The cap is enforced here _and_ in the wire schema (`SetAnnotationsRequest.pins` maxes at the same `MAX_ANNOTATIONS_PER_MODEL`): a bound applied at one end of a pipe is a bound the other end can exceed. `addAnnotation` refuses the _new_ note at the cap rather than evicting the oldest (the learner just wrote this one); `saveAnnotations` slices on write too, so a hand-built list cannot persist past what the reader accepts.
- Every mutator returns the **identical reference** when it changes nothing (a refused edit, a remove of an absent id), which is what lets `AnnotationStore.commit` skip a no-op write and notification — the store only broadcasts when the list is genuinely new.
- `createAnnotation` refuses a blank label (`text` is `min(1)` and a spaces-only note reads as an empty bubble, hence `trim`) and any coordinate the schema rejects; `Annotation.text` is capped at 500, mirrored by the overlay's `maxlength`. Ids are a counter plus the clock, unique within one model and readable when a developer inspects storage.
- `AnnotationStore` is the object the viewer page subscribes to `host.setAnnotations`: one mutation → one new list → one notification, so the worker's pin set is never a version behind the screen. `toAnnotationPins` sends only `{id, point}` across the boundary — the worker projects, it cannot read prose, so cloning text every frame would be paying for words nobody uses. `persisted` reports the last write's outcome.

## Flow

A canvas click is resolved to a world point by the page (`host.pickPoint`, raycast in the worker) → a draft `AnnotationDraft` (possibly blank text) exists only in page state so an abandoned placement never reaches storage → committing the words calls `AnnotationStore.add`/`update` → `createAnnotation`/`updateAnnotation` validate through `Annotation.safeParse` → `saveAnnotations` writes the per-model key (`ANNOTATIONS_STORAGE_PREFIX<modelKey>`) → subscribers receive the new list → the page republishes `toAnnotationPins(list)` to the worker and re-renders the overlay.

## Integration

- Depends on `@edu3d/contracts` (`Annotation`, `AnnotationPin`, `ANNOTATIONS_STORAGE_PREFIX`, `MAX_ANNOTATIONS_PER_MODEL`); `StorageLike` is structural so tests pass a plain object.
- Consumers: `routes/viewer/+page.svelte` (owns the store, placement and the `setAnnotations` publication), `components/annotation-layer.svelte` (renders the pins and edits text, never touches the store or the host). Pinned by `annotations.test.ts` (corrupt/older-schema entries, per-note validation, cap refusal, no-op identity).
