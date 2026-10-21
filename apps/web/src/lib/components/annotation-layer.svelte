<!--
  The annotation overlay: the learner's pinned notes drawn over the live canvas (`03` R7,
  `00-GOAL.md` §"Annotation").

  WHAT THIS OWNS AND WHAT THE PAGE OWNS. The page owns everything that needs the host — entering
  "placing" mode, turning a canvas click into a world point with `host.pickPoint`, persisting notes,
  and publishing the pin set with `host.setAnnotations`. This component owns the drawing and the
  per-pin editing affordances, and it never touches the host. That split is what keeps the projection
  contract one-directional: the worker projects pins every frame and the page hands the answers down
  as `projected`, so the overlay is a pure function of its props plus a little local draft state.

  THE PROPS THE PAGE MOUNTS IT WITH:

    pins       — the model's notes (`Annotation[]` from `@edu3d/contracts`), the same list persisted
                 under `ANNOTATIONS_STORAGE_PREFIX<modelKey>`. A note whose `text` is blank is
                 treated as a pin whose note is still being written: it opens its input on arrival.
    projected  — `ProjectedAnnotation[]` from `HostCallbacks.onAnnotationPositions`. A `visible:
                 false` entry (behind the camera, outside the frustum) is NOT rendered: it has no
                 honest screen position, and projecting it anyway mirrors the pin to the wrong side
                 of the screen.
    placing    — whether the toolbar's placement mode is on. Only affects the `.is-placing` tint; the
                 click that places a note belongs to the canvas listener the page owns.
    onplace    — accepted as part of the page's contract but never called here: wire it to
                 `host.pickPoint` on the canvas, because an overlay that intercepted the click would
                 break orbit. See `03` R7's "never overlap the panel chrome" and the stylesheet's note
                 that only the pins may take pointer events.
    onremove   — drop the note with this id.
    onedit     — commit the note's text. Refused text (blank or past the contract's 500) is the
                 page's call; `lib/annotations/annotations.ts:updateAnnotation` refuses it.
    onrequesttext — fired whenever this layer opens the input for a pin (a fresh pin arriving blank,
                 or the learner activating a committed one), so the page can react — move focus,
                 suspend a shortcut — without this component reaching into page state.

  POINTER DISCIPLINE. The overlay itself must not intercept anything: the canvas must keep every
  orbit drag and every placement click. Only a pin — the one thing the learner deliberately aims at —
  takes pointer events, which the scoped rules below supply.

  TEXT IS A TEXT NODE. Note prose is rendered as a Svelte text node, never `innerHTML` (`09`): a
  learner's own words can contain anything, and none of it is markup.
-->
<script lang="ts">
  import { untrack } from 'svelte';
  import { SvelteSet } from 'svelte/reactivity';
  import type { Annotation, ProjectedAnnotation } from '@edu3d/contracts';

  /**
   * The note-text bound, mirroring `Annotation.text` in `@edu3d/contracts` (`max(500)`). The contract
   * exports no constant for it, and the input must not accept a note storage will refuse.
   */
  const MAX_NOTE_LENGTH = 500;

  // eslint-disable-next-line svelte/no-unused-props -- page-owned, see the header.
  const {
    pins,
    projected,
    placing,
    onremove,
    onedit,
    onrequesttext,
  }: {
    pins: Annotation[];
    projected: ProjectedAnnotation[];
    placing: boolean;
    /** Page-owned (see the header): the canvas listener pairs this with `host.pickPoint`. */
    onplace: (worldPoint: [number, number, number], partId: string | null) => void;
    onremove: (id: string) => void;
    onedit: (id: string, text: string) => void;
    onrequesttext: (id: string) => void;
  } = $props();

  const notesById = $derived(new Map(pins.map((note) => [note.id, note])));

  /** Only a pin the worker could place is drawn; an entry with no coordinates has nowhere to go. */
  const visible = $derived(
    projected.filter((entry) => entry.visible && entry.x !== undefined && entry.y !== undefined),
  );

  let editingId = $state<string | null>(null);
  let draft = $state('');
  let inputElement = $state<HTMLInputElement | null>(null);

  /** Ids already considered for auto-edit, so a blank pin opens its input exactly once. */
  const seen = new SvelteSet<string>();

  /**
   * A newly placed pin arrives with no words yet, so its input opens for the learner straight away
   * — the alternative is a bare dot that looks like the click failed. `editingId` is read untracked
   * because this effect writes it, and reading it tracked would re-run the effect on its own write.
   */
  $effect(() => {
    for (const note of pins) {
      if (seen.has(note.id)) continue;
      seen.add(note.id);
      if (note.text.trim().length === 0 && untrack(() => editingId) === null) beginEdit(note.id);
    }
  });

  /** The input for the pin being written is the only input on screen, so one ref is enough. */
  $effect(() => {
    if (editingId !== null) inputElement?.focus();
  });

  function beginEdit(id: string): void {
    editingId = id;
    draft = notesById.get(id)?.text ?? '';
    onrequesttext(id);
  }

  function commit(): void {
    const id = editingId;
    if (id === null) return;

    const text = draft.trim();
    if (text.length === 0) {
      cancel();
      return;
    }
    // Unchanged text is not an edit; the page's store treats it as a no-op anyway, but skipping the
    // call keeps a blur on an untouched pin from looking like work.
    if (notesById.get(id)?.text !== text) onedit(id, text);
    editingId = null;
    draft = '';
  }

  /**
   * Abandon the edit. A note with no words has nothing to keep, so its pin goes with it — the
   * learner who escaped a placement did not ask for a stray dot with a placeholder label.
   */
  function cancel(): void {
    const id = editingId;
    if (id === null) return;

    const current = notesById.get(id);
    if (!current || current.text.trim().length === 0) onremove(id);
    editingId = null;
    draft = '';
  }

  function onInputKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter') {
      event.preventDefault();
      commit();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      cancel();
    }
  }

  function onTextKeydown(event: KeyboardEvent, id: string): void {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      beginEdit(id);
    }
  }
</script>

<div class="annotation-overlay" class:is-placing={placing}>
  {#each visible as entry (entry.id)}
    {@const note = notesById.get(entry.id)}
    <div class="annotation-pin" style="left: {entry.x}px; top: {entry.y}px">
      <span class="annotation-dot" aria-hidden="true"></span>
      <div class="annotation-bubble">
        {#if editingId === entry.id}
          <input
            class="annotation-input"
            bind:this={inputElement}
            bind:value={draft}
            maxlength={MAX_NOTE_LENGTH}
            placeholder="Add a note…"
            aria-label="Note text"
            onkeydown={onInputKeydown}
            onblur={commit}
          />
        {:else}
          <span
            class="annotation-text"
            class:is-placeholder={!note || note.text.trim().length === 0}
            role="button"
            tabindex="0"
            aria-label="Edit note"
            onclick={() => beginEdit(entry.id)}
            onkeydown={(event) => onTextKeydown(event, entry.id)}
          >
            {note && note.text.trim().length > 0 ? note.text : 'Add a note…'}
          </span>
        {/if}
        <button
          class="annotation-remove"
          type="button"
          aria-label="Remove note"
          onclick={() => {
            // Clearing the draft first means the input's blur-commit has nothing left to write.
            if (editingId === entry.id) {
              editingId = null;
              draft = '';
            }
            onremove(entry.id);
          }}>×</button
        >
      </div>
    </div>
  {/each}
</div>

<style>
  /* The stylesheet's annotation block is written for an overlay that "must not intercept pointer
     events - only the pins", but the shipped `.annotation-overlay` rule omits the declaration. These
     two rules are that missing half: the canvas keeps every orbit drag and every placement click,
     and a pin — the one thing the learner aims at — still takes its own. */
  .annotation-overlay {
    pointer-events: none;
  }

  .annotation-pin {
    pointer-events: auto;
  }
</style>
