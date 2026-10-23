<!--
  The Gallery modal — V1's modal shell, real browsing.

  Lists the backend's gallery (search + subject filter, paginated), shows snapshot thumbnails
  where published, and loads any entry into the viewer through the same atomic-swap path as every
  other model load (`03` R2). Loading a gallery model from inside the viewer must never leave the
  learner staring at a broken scene.

  THUMBNAILS ARE HONEST: an entry either has a real snapshot or it does not, and a snapshot that
  fails to load is treated exactly like one that was never published — an initial-letter placeholder.
  That is why the thumbnail is an `<img>` with an `error` handler rather than a CSS background: a
  background has no way to report a failed load, so a dead URL would render as a blank tile that
  looks like it loaded.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { apiFetch } from '$lib/core/api.ts';

  const {
    onclose,
    onload,
  }: {
    onclose: () => void;
    /** `runtime` is the instrumented twin of `code` — absent on entries published before the guard.
     *  `galleryId` is the entry's own id, so the viewer can update it in place on a later publish. */
    onload: (code: string, name: string, runtime?: string, galleryId?: string) => void;
  } = $props();

  /**
   * The reserved tag the server's auto-save writes on an entry it saved itself (see
   * `AUTO_SAVE_TAG` in `apps/server/src/app.ts`). A published entry carries no such tag, so its
   * presence is how the gallery distinguishes provenance without a wider contract change — useful
   * for a future moderation story. Kept in sync by the same literal on both sides.
   */
  const AUTO_SAVE_TAG = 'auto';

  interface Entry {
    id: string;
    name: string;
    subject: string;
    tags: string[];
    snapshotUrl: string | null;
    createdAt: number;
  }

  /** True when this entry was saved by the server rather than published by a person. */
  function isAutoSaved(entry: Entry): boolean {
    return entry.tags.includes(AUTO_SAVE_TAG);
  }

  let entries = $state<Entry[]>([]);
  let total = $state(0);
  let search = $state('');
  let loading = $state(true);
  let loadingModel = $state<string | null>(null);
  let error = $state<string | null>(null);
  /** Entries whose snapshot URL failed to load; they get the same placeholder as a missing one. */
  const failedThumbs = $state<Set<string>>(new Set());
  let offset = 0;
  const PAGE = 24;

  /** The placeholder for an entry with no usable snapshot: its first letter, or a dot when unnamed. */
  function initial(name: string): string {
    const first = name.trim().match(/[a-z0-9]/i)?.[0];
    return first ? first.toUpperCase() : '·';
  }

  function markThumbFailed(id: string): void {
    failedThumbs.add(id);
  }

  onMount(() => void refresh(true));

  async function refresh(reset = false) {
    if (reset) {
      offset = 0;
      entries = [];
    }
    loading = true;
    error = null;
    const params = [`limit=${PAGE}`, `offset=${offset}`];
    if (search.trim()) params.push(`search=${encodeURIComponent(search.trim())}`);
    const result = await apiFetch<{ entries: Entry[]; total: number }>(
      `/gallery?${params.join('&')}`,
    );
    loading = false;
    if (result.ok) {
      entries = result.ok
        ? reset
          ? result.data.entries
          : [...entries, ...result.data.entries]
        : entries;
      total = result.data.total;
    } else {
      error = 'The gallery could not be reached. Is the backend running?';
    }
  }

  async function load(entry: Entry) {
    loadingModel = entry.id;
    const result = await apiFetch<{ bundle: { code?: string; runtime?: string } }>(
      `/gallery/${entry.id}`,
    );
    loadingModel = null;
    if (result.ok && result.data.bundle?.code) {
      onload(result.data.bundle.code, entry.name, result.data.bundle.runtime, entry.id);
    } else {
      error = 'That model could not be loaded.';
    }
  }

  function timeAgo(timestamp: number): string {
    const minutes = Math.round((Date.now() - timestamp) / 60000);
    if (minutes < 60) return `${Math.max(1, minutes)}m ago`;
    const hours = Math.round(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    return `${Math.round(hours / 24)}d ago`;
  }
</script>

<div class="modal-overlay active" role="dialog" aria-modal="true" aria-label="Gallery">
  <div class="modal-container gallery-modal glass-panel">
    <div class="modal-header">
      <h2>🖼️ Gallery</h2>
      <button class="modal-close-btn" onclick={onclose} aria-label="Close gallery">×</button>
    </div>
    <div class="modal-body">
      <form
        class="gallery-search"
        onsubmit={(event) => {
          event.preventDefault();
          void refresh(true);
        }}
      >
        <input
          type="text"
          class="share-url-input"
          placeholder="Search models…"
          bind:value={search}
        />
        <button class="modal-btn" type="submit">Search</button>
      </form>

      {#if error}
        <p class="gallery-error">{error}</p>
      {/if}

      {#if loading && entries.length === 0}
        <div class="loading-state">
          <div class="spinner"></div>
          <p>Loading gallery…</p>
        </div>
      {:else if entries.length === 0 && !error}
        <div class="chat-empty-state">
          <div class="chat-empty-icon">
            <svg
              width="36"
              height="36"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              stroke-width="1.5"
            >
              <rect x="2" y="3" width="5" height="5" /><rect x="9" y="3" width="5" height="5" />
              <rect x="2" y="10" width="5" height="3" /><rect x="9" y="10" width="5" height="3" />
            </svg>
          </div>
          <h4>No models yet</h4>
          <p>Generate a model and publish it — it will appear here for anyone to explore.</p>
        </div>
      {:else}
        <div class="gallery-grid">
          {#each entries as entry (entry.id)}
            <button
              class="gallery-card"
              class:loading={loadingModel === entry.id}
              disabled={loadingModel !== null}
              onclick={() => void load(entry)}
            >
              <div class="gallery-thumb">
                {#if entry.snapshotUrl && !failedThumbs.has(entry.id)}
                  <img
                    src={entry.snapshotUrl}
                    alt={entry.name}
                    loading="lazy"
                    decoding="async"
                    onerror={() => markThumbFailed(entry.id)}
                  />
                {:else}
                  <!--
                    No usable snapshot: either the entry has none (an auto-saved model — the server
                    never renders a pixel, so `snapshotUrl` is null) or its image failed to load.
                    An initial-letter tile with an explicit "No preview" label, so this reads as a
                    deliberate placeholder rather than a broken image. The label is a sibling, not a
                    background: a background cannot report a failed load, which is why the thumbnail
                    is an `<img>` with an `error` handler above.
                  -->
                  <span class="gallery-thumb-fallback" aria-hidden="true">
                    {initial(entry.name)}
                  </span>
                  <span class="gallery-thumb-note">No preview</span>
                {/if}
              </div>
              <div class="gallery-card-body">
                <span class="gallery-name">{entry.name}</span>
                <span class="gallery-meta">{entry.subject} · {timeAgo(entry.createdAt)}</span>
                {#if isAutoSaved(entry)}
                  <!-- Provenance, shown honestly: the server saved this on its own; no one pressed
                       Publish. A moderation pass can find the same entries by their reserved tag. -->
                  <span class="gallery-provenance" title="Saved automatically when it was generated"
                    >Auto-saved</span
                  >
                {/if}
              </div>
              {#if loadingModel === entry.id}
                <div class="gallery-loading"><div class="spinner"></div></div>
              {:else}
                <span class="gallery-load">Open →</span>
              {/if}
            </button>
          {/each}
        </div>

        {#if entries.length < total}
          <div class="gallery-more">
            <button
              class="modal-btn"
              onclick={() => {
                offset += PAGE;
                void refresh();
              }}
              disabled={loading}
            >
              {loading ? 'Loading…' : `Show more (${entries.length} of ${total})`}
            </button>
          </div>
        {/if}
      {/if}
    </div>
  </div>
</div>

<style>
  .gallery-modal {
    max-width: 720px;
    max-height: 85vh;
  }

  .gallery-search {
    display: flex;
    gap: var(--space-2);
    margin-bottom: var(--space-4);
  }

  .gallery-error {
    color: var(--danger);
    font-size: 0.875rem;
    margin-bottom: var(--space-3);
  }

  .gallery-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
    gap: var(--space-3);
  }

  .gallery-card {
    position: relative;
    display: flex;
    flex-direction: column;
    text-align: left;
    background: var(--bg-elevated);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-md);
    overflow: hidden;
    cursor: pointer;
    transition:
      border-color var(--dur-fast) ease,
      transform var(--dur-fast) var(--ease-out);
  }

  .gallery-card:hover:not(:disabled) {
    border-color: var(--accent);
    transform: translateY(-2px);
  }

  .gallery-card:disabled {
    cursor: wait;
  }

  .gallery-thumb {
    height: 110px;
    display: grid;
    place-items: center;
    background: var(--bg-subtle);
    color: var(--text-dim);
  }

  .gallery-thumb img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }

  .gallery-thumb-fallback {
    font-size: 2rem;
    font-weight: 700;
    color: var(--text-muted);
    text-transform: uppercase;
  }

  /* The two fallback pieces (letter + note) share the grid cell as a stacked column, so the
     placeholder reads as one deliberate tile rather than two competing centred children. */
  .gallery-thumb:has(.gallery-thumb-note) {
    grid-auto-flow: row;
    align-content: center;
    gap: 2px;
  }

  .gallery-thumb-note {
    font-size: 0.625rem;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--text-dim);
  }

  .gallery-card-body {
    padding: var(--space-2) var(--space-3);
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .gallery-name {
    font-size: 0.8125rem;
    font-weight: 600;
    color: var(--text-primary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .gallery-meta {
    font-size: 0.6875rem;
    color: var(--text-muted);
    text-transform: capitalize;
  }

  /* Provenance chip: a small, quiet marker that says who saved this entry. */
  .gallery-provenance {
    align-self: start;
    margin-top: 2px;
    padding: 1px 6px;
    font-size: 0.625rem;
    font-weight: 600;
    letter-spacing: 0.03em;
    text-transform: uppercase;
    color: var(--accent);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-pill, 999px);
  }

  .gallery-load {
    padding: var(--space-2) var(--space-3);
    font-size: 0.75rem;
    font-weight: 600;
    color: var(--accent);
    border-top: 1px solid var(--border-subtle);
  }

  .gallery-loading {
    padding: var(--space-3);
    border-top: 1px solid var(--border-subtle);
    display: grid;
    place-items: center;
  }

  .gallery-more {
    display: grid;
    place-items: center;
    margin-top: var(--space-4);
  }
</style>
