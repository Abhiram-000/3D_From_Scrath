<!--
  AI Output viewer — V1's exact codeViewModal: solid (not glass, `07`'s compositor rule), meta
  chips, raw/validated tabs, copy/download actions. Shows the exact document the model produced
  plus the manifest the engine built, so "why does the model look like this" is answered from the
  artifact. All content is untrusted text rendered as text (`03` R3).
-->
<script lang="ts">
  import type { ModelManifest } from '@edu3d/contracts';
  import { peekBundleCode } from '$lib/core/api.ts';

  const {
    manifest,
    tab,
    ontab,
    onclose,
  }: {
    manifest: ModelManifest | null;
    tab: 'raw' | 'spec';
    ontab: (tab: 'raw' | 'spec') => void;
    onclose: () => void;
  } = $props();

  let rawCode = $state('');

  $effect(() => {
    rawCode =
      peekBundleCode() ?? '(the model came from the reference set — no AI output for this session)';
  });

  async function copy() {
    const text = tab === 'raw' ? rawCode : JSON.stringify(manifest, null, 2);
    await navigator.clipboard?.writeText(text);
  }

  function download() {
    const blob = new Blob([tab === 'raw' ? rawCode : JSON.stringify(manifest, null, 2)], {
      type: 'text/plain',
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = tab === 'raw' ? 'model-output.js' : 'scene-spec.json';
    link.click();
    URL.revokeObjectURL(url);
  }
</script>

<div class="modal-container code-view-modal glass-panel">
  <div class="modal-header">
    <h2>AI Output</h2>
    <button class="modal-close-btn" onclick={onclose} aria-label="Close output viewer">×</button>
  </div>

  <div class="code-view-meta">
    {#if manifest}
      <span class="code-view-chip"><strong>{manifest.name}</strong></span>
      <span class="code-view-chip">{manifest.cost.parts} parts</span>
      <span class="code-view-chip">{manifest.cost.triangles.toLocaleString()} triangles</span>
      <span class="code-view-chip">authoring {manifest.cost.authorMillis} ms</span>
      {#if manifest.warnings.length > 0}
        <span class="code-view-chip">{manifest.warnings.length} warnings</span>
      {/if}
    {/if}
  </div>

  <div class="code-view-tabs">
    <button class="code-view-tab" class:active={tab === 'raw'} onclick={() => ontab('raw')}
      >Model output (raw)</button
    >
    <button class="code-view-tab" class:active={tab === 'spec'} onclick={() => ontab('spec')}
      >Scene spec (validated)</button
    >
  </div>

  <div class="modal-body">
    {#if tab === 'raw'}
      <pre class="code-view-pre"><code>{rawCode}</code></pre>
    {:else}
      <pre class="code-view-pre"><code>{JSON.stringify(manifest, null, 2) ?? ''}</code></pre>
    {/if}
  </div>

  <div class="modal-footer">
    <span class="code-view-note">
      {tab === 'raw'
        ? 'The exact text the model wrote, before extraction.'
        : 'The manifest the engine validated and built from.'}
    </span>
    <div class="code-view-actions">
      <button class="modal-btn" onclick={() => void copy()}>Copy</button>
      <button class="modal-btn" onclick={download}>Download</button>
    </div>
  </div>
</div>
