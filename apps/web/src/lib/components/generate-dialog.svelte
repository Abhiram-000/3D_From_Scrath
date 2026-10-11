<!--
  The in-viewer Generate dialog.

  V1's flow navigated away and lost the current model. `03` R2's rule — "a model load either fully
  succeeds or leaves the previous model on screen" — applies to generation too: this dialog streams
  the run with the same honest progress UI as the loading page, and only swaps the scene when a
  validated bundle arrives. A failed generation costs the learner nothing.
-->
<script lang="ts">
  import { detectTier } from '$lib/engine/sandbox-host.ts';
  import { generateStream, storeBundle } from '$lib/core/api.ts';
  import { ProgressModel, STAGES } from '$lib/core/loading-progress.ts';

  const {
    onclose,
    ongenerated,
  }: {
    onclose: () => void;
    ongenerated: (code: string, name: string) => void;
  } = $props();

  let topic = $state('');
  let running = $state(false);
  let progress = $state(new ProgressModel());
  let barWidth = $state(0);
  let statusText = $state('Ready when you are.');
  let failureMessage = $state<string | null>(null);
  let controller: AbortController | null = null;
  let progressTimer: ReturnType<typeof setInterval> | null = null;

  const STAGE_LABELS = ['Thinking', 'Generating', 'Compiling', 'Ready'] as const;

  async function start() {
    const value = topic.trim();
    if (value.length < 5 || running) return;

    running = true;
    failureMessage = null;
    progress = new ProgressModel();
    controller = new AbortController();
    progressTimer = setInterval(() => {
      progress.tick();
      barWidth = progress.value;
      statusText = progress.status;
    }, 150);

    const { tier } = detectTier();
    const outcome = await generateStream({
      topic: value,
      tier,
      signal: controller.signal,
      onEvent: (event) => {
        progress.apply(event);
        barWidth = progress.value;
        statusText = progress.status;
      },
    });

    if (progressTimer) clearInterval(progressTimer);
    running = false;

    if (outcome.ok) {
      // Store the session bundle the same way the loading page does, then hand over.
      storeBundle({
        code: outcome.bundle.code,
        manifest: outcome.bundle.manifest,
        raw: outcome.bundle,
      });
      ongenerated(outcome.bundle.code, outcome.bundle.manifest.name);
    } else if (outcome.code === 'aborted') {
      failureMessage = null;
    } else {
      failureMessage =
        outcome.code === 'network'
          ? 'The backend is not running. Start it with pnpm dev, then try again.'
          : outcome.message;
    }
  }

  function cancel() {
    controller?.abort();
    if (progressTimer) clearInterval(progressTimer);
    running = false;
  }
</script>

<div class="modal-overlay active" role="dialog" aria-modal="true" aria-label="Generate a new model">
  <div class="modal-container generate-modal glass-panel">
    <div class="modal-header">
      <h2>✨ Generate a new model</h2>
      <button
        class="modal-close-btn"
        onclick={() => {
          cancel();
          onclose();
        }}
        aria-label="Close generator">×</button
      >
    </div>

    <div class="modal-body">
      {#if !running && !failureMessage}
        <div class="form-group">
          <label for="gen-topic">Describe what you want to explore</label>
          <input
            id="gen-topic"
            type="text"
            class="share-url-input"
            placeholder="e.g., how does a four-stroke engine work"
            maxlength="500"
            bind:value={topic}
            onkeydown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                void start();
              }
            }}
          />
        </div>
        <p class="generate-note">
          Your current model stays on screen until the new one is built and validated — generation
          can take a few minutes.
        </p>
        <button class="primary-btn" disabled={topic.trim().length < 5} onclick={() => void start()}>
          Generate 3D Model
        </button>
      {:else if running}
        <div class="gen-progress">
          <div class="progress-stages" role="list" aria-label="Generation progress">
            {#each STAGES as stage, index (stage)}
              <div
                class="stage"
                class:active={progress.stage === stage}
                class:completed={progress.completedStages > index}
                role="listitem"
              >
                <span class="stage-label">{STAGE_LABELS[index]}</span>
                <div class="stage-spinner" class:spinning={progress.stage === stage}></div>
              </div>
            {/each}
          </div>
          <div class="progress-bar-container">
            <div class="progress-bar" style={`width:${barWidth.toFixed(1)}%`}></div>
          </div>
          <p class="status-message visible" aria-live="polite">{statusText}</p>
          <button class="modal-btn" onclick={cancel}>Cancel generation</button>
        </div>
      {:else}
        <div class="gen-failure">
          <h4>Generation Failed</h4>
          <p>{failureMessage}</p>
          <div class="gen-failure-actions">
            <button class="modal-btn" onclick={() => (failureMessage = null)}>Try Again</button>
            <button class="modal-btn" onclick={onclose}>Keep current model</button>
          </div>
        </div>
      {/if}
    </div>
  </div>
</div>

<style>
  .generate-modal {
    max-width: 520px;
  }

  .generate-note {
    font-size: 0.8125rem;
    color: var(--text-muted);
    line-height: 1.5;
    margin: var(--space-2) 0 var(--space-4);
  }

  .gen-progress {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
    align-items: stretch;
  }

  .progress-stages {
    display: flex;
    gap: var(--space-2);
    justify-content: space-between;
  }

  .stage {
    display: flex;
    align-items: center;
    gap: var(--space-1);
    font-size: 0.75rem;
    color: var(--text-dim);
  }

  .stage.active {
    color: var(--accent);
    font-weight: 600;
  }

  .stage.completed {
    color: var(--text-secondary);
  }

  .stage-spinner {
    width: 12px;
    height: 12px;
    border: 2px solid transparent;
    border-top-color: currentColor;
    border-radius: 50%;
  }

  .stage-spinner.spinning {
    animation: spin 0.9s linear infinite;
  }

  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }

  .progress-bar-container {
    height: 5px;
    background: var(--bg-subtle);
    border-radius: var(--radius-pill);
    overflow: hidden;
  }

  .progress-bar {
    height: 100%;
    background: var(--gradient-accent);
    border-radius: var(--radius-pill);
    transition: width 0.2s linear;
  }

  .status-message.visible {
    display: block;
    font-size: 0.8125rem;
    color: var(--text-muted);
    text-align: center;
  }

  .gen-failure {
    text-align: center;
    display: grid;
    gap: var(--space-2);
    justify-items: center;
    padding: var(--space-4) 0;
  }

  .gen-failure h4 {
    color: var(--danger);
    font-size: 1rem;
  }

  .gen-failure p {
    font-size: 0.875rem;
    color: var(--text-secondary);
    max-width: 40ch;
  }

  .gen-failure-actions {
    display: flex;
    gap: var(--space-2);
    margin-top: var(--space-2);
  }
</style>
