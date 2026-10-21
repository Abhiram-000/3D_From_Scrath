<!--
  The export menu: screenshots at the authored resolutions and a bounded video clip (`00-GOAL.md`
  §"Export & diagnostics", `03` R8).

  HONESTY IS THE WHOLE DESIGN. `03` R8 promises "video clip recording of the canvas with codec
  fallbacks and a duration cap", and the worker answers whether this device can encode at all through
  `SandboxHost.recordingCapability` — `MediaRecorder`/`captureStream` do not exist on an
  `OffscreenCanvas` in any browser, so the only route is WebCodecs. When the probe says
  `supported: false`, the record item is *disabled and shows the reason*: a live-looking button that
  does nothing is exactly the lie this platform refuses. `capability: null` means the probe has not
  answered yet, and that reads as "checking" rather than as "available" for the same reason.

  The elapsed-seconds read-out and the stop-at-cap check live here as well as in the worker. The
  worker's own bound is the guarantee (an export that can run until the tab dies eventually does);
  stopping here is what keeps the menu's countdown from counting past a clip that has already ended.

  THE PROPS THE PAGE MOUNTS IT WITH:

    capability  — `host.recordingCapability` (`VideoRecordingCapability | null` while probing).
    recording   — whether the worker is capturing right now.
    seconds     — elapsed seconds of the clip in flight, so the menu can show the countdown.
    onscreenshot(preset) — a `SnapshotPreset` (`'hd' | 'fullHd' | 'uhd4k'`): the page calls
                  `host.requestSnapshot(preset)`; the PNG arrives on `onSnapshot`, which the page
                  owns, because only the page can name and download the file.
    onstartrecording() / onstoprecording() — `host.startRecording()` / `host.stopRecording()`, whose
                  results arrive on the page's `onVideoClip` / `onRecordingFailed` callbacks.

  Like the view-presets dropdown, this is a single button plus a `.dropdown-menu`; the page decides
  where in the toolbar it sits.
-->
<script lang="ts">
  import type { VideoRecordingCapability } from '@edu3d/contracts';
  import { SNAPSHOT_PRESETS, type SnapshotPreset } from '$lib/engine/sandbox-host.ts';

  const {
    capability,
    recording,
    seconds,
    onscreenshot,
    onstartrecording,
    onstoprecording,
  }: {
    capability: VideoRecordingCapability | null;
    recording: boolean;
    seconds: number;
    onscreenshot: (preset: SnapshotPreset) => void;
    onstartrecording: () => void;
    onstoprecording: () => void;
  } = $props();

  let open = $state(false);

  /**
   * The three authored resolutions, named from the same table the worker renders from, so a label
   * can never promise a size the export does not produce.
   */
  const SHOTS: ReadonlyArray<{ preset: Exclude<SnapshotPreset, 'viewport'>; name: string }> = [
    { preset: 'hd', name: 'HD' },
    { preset: 'fullHd', name: 'Full HD' },
    { preset: 'uhd4k', name: '4K' },
  ];
  const shotItems = SHOTS.map((shot) => ({
    preset: shot.preset,
    label: `${shot.name} (${SNAPSHOT_PRESETS[shot.preset].width}×${
      SNAPSHOT_PRESETS[shot.preset].height
    })`,
  }));

  /** The reason the record item is dead, or null when it is live or already recording. */
  const blockedReason = $derived(
    capability === null
      ? 'Checking whether this device can record video…'
      : capability.supported
        ? null
        : (capability.reason ?? 'Recording is not available on this device.'),
  );

  /** The worker's hard cap, mirrored so the menu's countdown stops where the clip stops. */
  const maxSeconds = $derived(capability?.supported ? capability.maxSeconds : null);

  $effect(() => {
    if (recording && maxSeconds !== null && seconds >= maxSeconds) onstoprecording();
  });

  function takeScreenshot(preset: SnapshotPreset): void {
    onscreenshot(preset);
    open = false;
  }

  function toggleRecording(): void {
    if (recording) {
      onstoprecording();
      return;
    }
    if (blockedReason !== null) return;
    onstartrecording();
  }
</script>

<svelte:window onkeydown={(event) => event.key === 'Escape' && open && (open = false)} />

<div class="dropdown-wrapper">
  <button
    class="toolbar-btn dropdown-trigger"
    title="Export"
    aria-expanded={open}
    onclick={() => (open = !open)}
  >
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"
      ><path
        d="M8 1v8m0 0L5 6m3 3l3-3"
        fill="none"
        stroke="currentColor"
        stroke-width="1.5"
        stroke-linecap="round"
      /><path d="M2 10v3h12v-3" fill="none" stroke="currentColor" stroke-width="1.5" /></svg
    >
    <span>Export</span>
    <svg class="dropdown-arrow" width="12" height="12" viewBox="0 0 12 12" fill="currentColor"
      ><path d="M6 8L2 4h8L6 8Z" /></svg
    >
  </button>

  <div class="dropdown-menu glass-panel" class:active={open}>
    {#each shotItems as shot (shot.preset)}
      <button class="dropdown-item" type="button" onclick={() => takeScreenshot(shot.preset)}>
        Screenshot — {shot.label}
      </button>
    {/each}

    {#if recording}
      <button class="dropdown-item" type="button" onclick={toggleRecording}>
        Stop recording — {seconds.toFixed(1)}s
        {#if maxSeconds !== null}/ {maxSeconds}s{/if}
      </button>
    {:else}
      <button
        class="dropdown-item"
        type="button"
        disabled={blockedReason !== null}
        title={blockedReason ?? undefined}
        onclick={toggleRecording}
      >
        Record a clip
        {#if blockedReason !== null}
          <span class="export-reason">{blockedReason}</span>
        {/if}
      </button>
    {/if}
  </div>
</div>

<style>
  /* `viewer.css` styles `.dropdown-item` for an enabled button and has no disabled state, so a
     disabled record item would look exactly like a live one — the lie `03` R8 forbids. Dim it and
     take away the hover highlight, so "not available" is visible instead of discoverable by
     clicking. `.export-reason` is the other genuinely missing piece: the reason a recording is
     unavailable has to be readable inside the item that offers it. */
  .dropdown-item:disabled {
    opacity: 0.55;
    cursor: not-allowed;
  }

  .dropdown-item:disabled:hover {
    background: transparent;
    color: var(--text-secondary);
  }

  .export-reason {
    display: block;
    margin-top: 2px;
    font-size: 11px;
    font-weight: 400;
    color: var(--text-secondary);
  }
</style>
