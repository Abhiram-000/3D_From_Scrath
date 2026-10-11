<!--
  The loading page — an exact V1 port.

  Markup mirrors loading.html class-for-class (.scene-loader with its halo and three tilted orbit
  rings, .progress-stages, .fact-container, .error-container…); the stylesheet is V1's loading.css
  verbatim; the progress model is the honest monotonic easing model V1 extracted into
  core/loading-progress.js (from/to/tau per phase), driven here by this pipeline's NDJSON phase
  events. The neural-net 3D background, the DOM particles, the non-repeating fact queue, the
  success flourish, and the two-exit error card are all V1 behaviors.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { Ambient } from '$lib/ambient.ts';
  import { LoadingBackground, initParticles } from '$lib/loading-background.ts';
  import { generateStream, storeBundle } from '$lib/core/api.ts';
  import { FactQueue, ProgressModel, STAGES } from '$lib/core/loading-progress.ts';
  import { detectTier } from '$lib/engine/sandbox-host.ts';
  // V1's loading stylesheet, verbatim.
  import '$lib/styles/loading.css';

  let topic = $state('');
  let progress = $state(new ProgressModel());
  let barWidth = $state(0);
  let statusText = $state('Analyzing your topic and planning the 3D model...');
  let fact = $state('Loading amazing facts...');
  let factLeaving = $state(false);
  let failed = $state(false);
  let failureMessage = $state('');
  let canRetry = $state(true);
  let success = $state(false);
  let running = $state(false);

  let ambient: Ambient | null = null;
  let background: LoadingBackground | null = null;
  let progressTimer: ReturnType<typeof setInterval> | null = null;
  let factTimer: ReturnType<typeof setInterval> | null = null;
  let factQueue: FactQueue | null = null;
  let controller: AbortController | null = null;

  let bgCanvas: HTMLCanvasElement | null = $state(null);
  let particles: HTMLElement | null = $state(null);
  let factText: HTMLElement | null = $state(null);

  const STAGE_LABELS = ['Thinking', 'Generating', 'Compiling', 'Ready'] as const;

  onMount(() => {
    // Theme is already applied inline in <head>; the ambient layer and background mount next —
    // the same layered cursor system as the landing page, exactly as V1 configured it.
    topic = takeTopicFromSession();
    ambient = new Ambient({ grid: true, magnetStrength: 0.1, magnetRadius: 90 });
    ambient.mount().parallaxize('[data-parallax]').magnetize('.loading-logo').sheen('.has-sheen');

    if (bgCanvas) {
      background = new LoadingBackground();
      background.init(bgCanvas);
    }
    if (particles && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      initParticles(particles);
    }

    factQueue = new FactQueue(topic || 'science');
    showNextFact();
    factTimer = setInterval(showNextFact, 6500);

    // Frequent enough to look continuous, cheap enough to be invisible next to the WebGL
    // background on the same page — V1's exact 120ms tick.
    progressTimer = setInterval(() => {
      progress.tick();
      renderProgress();
    }, 120);

    // Arriving without a topic is a lost session, not a generation to bill (`07`).
    if (!topic) {
      showError(
        'No topic to generate. Start from the landing page and describe what you want to see.',
        { canRetry: false },
      );
      return cleanup;
    }

    void startGeneration();
    return cleanup;
  });

  function takeTopicFromSession(): string {
    try {
      return (sessionStorage.getItem('edu3d.topic') ?? '').trim();
    } catch {
      return '';
    }
  }

  function cleanup() {
    if (progressTimer) clearInterval(progressTimer);
    if (factTimer) clearInterval(factTimer);
    controller?.abort();
    background?.destroy();
    ambient?.destroy();
  }

  /** Facts slide/fade out and in — never a hard cut (V1's exact transition). */
  function showNextFact() {
    if (factLeaving || !factText || !factQueue) return;
    const nextFact = factQueue.next();
    if (!nextFact) return;

    factLeaving = true;
    setTimeout(() => {
      fact = nextFact;
      factLeaving = false;
      // Force reflow, then animate to the resting state.
      void factText?.offsetWidth;
    }, 400);
  }

  function renderProgress() {
    barWidth = progress.value;
    statusText = progress.status;
  }

  async function startGeneration() {
    if (running) return;
    running = true;
    failed = false;
    progress = new ProgressModel();
    renderProgress();
    controller = new AbortController();

    const { tier } = detectTier();
    const outcome = await generateStream({
      topic,
      tier,
      signal: controller.signal,
      onEvent: (event) => {
        // Every event, heartbeats included, proves the run is alive.
        progress.apply(event);
        renderProgress();
      },
    });

    running = false;
    if (outcome.ok) {
      // The success flourish: orbits pause, the badge goes green, then the viewer takes over.
      success = true;
      stopProgressTimers();
      storeBundle({
        code: outcome.bundle.code,
        manifest: outcome.bundle.manifest,
        raw: outcome.bundle,
      });
      // A short beat so the completed state is actually seen (V1's 900ms).
      setTimeout(() => {
        window.location.href = '/viewer';
      }, 900);
    } else {
      if (outcome.code === 'aborted') return;
      showError(
        outcome.code === 'network'
          ? 'The backend is not running. Start it with pnpm dev, then try again.'
          : outcome.message,
        { canRetry: outcome.code !== 'stalled' },
      );
    }
  }

  function stopProgressTimers() {
    if (progressTimer) clearInterval(progressTimer);
    progressTimer = null;
  }

  function showError(message: string, { canRetry: retryable = true } = {}) {
    failed = true;
    failureMessage = message;
    canRetry = retryable;
    stopProgressTimers();
    if (factTimer) {
      clearInterval(factTimer);
      factTimer = null;
    }
  }

  function hideError() {
    failed = false;
    progress = new ProgressModel();
    renderProgress();
    if (!factTimer) {
      factTimer = setInterval(showNextFact, 6500);
    }
  }

  function retry() {
    if (running) return;
    hideError();
    startGeneration();
  }
</script>

<svelte:head>
  <title>Generating 3D Model | EDU-3D</title>
</svelte:head>

<div class="loading-container">
  <canvas bind:this={bgCanvas} id="bg3d" class="bg-canvas" aria-hidden="true"></canvas>

  <main class="loading-content" class:success>
    {#if !failed}
      <div class="loading-logo">
        <div class="scene-loader" role="img" aria-label="Building your 3D scene">
          <span class="scene-loader__halo"></span>
          <span class="scene-loader__orbit scene-loader__orbit--one"><i></i></span>
          <span class="scene-loader__orbit scene-loader__orbit--two"><i></i></span>
          <span class="scene-loader__orbit scene-loader__orbit--three"><i></i></span>
          <svg
            width="42"
            height="42"
            viewBox="0 0 24 24"
            fill="none"
            class="rotating-logo"
            aria-hidden="true"
          >
            <path
              d="M12 2L2 7L12 12L22 7L12 2Z"
              stroke="url(#logoGradient)"
              stroke-width="1.5"
              stroke-linejoin="round"
            />
            <path
              d="M2 17L12 22L22 17"
              stroke="url(#logoGradient)"
              stroke-width="1.5"
              stroke-linejoin="round"
            />
            <path
              d="M2 12L12 17L22 12"
              stroke="url(#logoGradient)"
              stroke-width="1.5"
              stroke-linejoin="round"
            />
            <defs>
              <linearGradient id="logoGradient" x1="0%" y1="0%" x2="100%" y2="100%">
                <stop offset="0%" stop-color="var(--cream)" />
                <stop offset="52%" stop-color="var(--amber)" />
                <stop offset="100%" stop-color="var(--accent)" />
              </linearGradient>
            </defs>
          </svg>
        </div>
      </div>

      <h1 class="loading-title">
        <span class="gradient-text">Generating your 3D model</span>
      </h1>

      <p class="loading-topic">{topic || 'No topic'}</p>

      <div class="progress-stages" role="list" aria-label="Generation progress">
        {#each STAGES as stage, index (stage)}
          <div
            class="stage"
            class:active={progress.stage === stage}
            class:completed={progress.completedStages > index}
            id={`stage-${stage}`}
            role="listitem"
          >
            <div class="stage-icon">
              {#if index === 0}
                <svg
                  width="20"
                  height="20"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  aria-hidden="true"
                  ><circle cx="12" cy="12" r="10" /><path d="M12 16v-4M12 8h.01" /></svg
                >
              {:else if index === 1}
                <svg
                  width="20"
                  height="20"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  aria-hidden="true"
                  ><path d="M12 2L2 7L12 12L22 7L12 2Z" /><path d="M2 17L12 22L22 17" /></svg
                >
              {:else if index === 2}
                <svg
                  width="20"
                  height="20"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  aria-hidden="true"
                  ><polyline points="16 18 22 12 16 6" /><polyline points="8 6 2 12 8 18" /></svg
                >
              {:else}
                <svg
                  width="20"
                  height="20"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  aria-hidden="true"><polyline points="20 6 9 17 4 12" /></svg
                >
              {/if}
              <div class="stage-spinner" aria-hidden="true"></div>
            </div>
            <span class="stage-label">{STAGE_LABELS[index]}</span>
          </div>
          {#if index < STAGES.length - 1}
            <div class="stage-connector" aria-hidden="true"><div class="connector-line"></div></div>
          {/if}
        {/each}
      </div>

      <div class="status-message" aria-live="polite">{statusText}</div>

      <div class="progress-bar-container">
        <div
          class="progress-bar"
          role="progressbar"
          aria-valuenow={Math.round(barWidth)}
          aria-valuemin="0"
          aria-valuemax="100"
          aria-valuetext={`${Math.round(barWidth)}% — ${statusText}`}
          style={`width:${barWidth.toFixed(1)}%`}
        ></div>
      </div>

      <div class="fact-container" aria-live="polite">
        <p class="fact-label">Did you know?</p>
        <p class="fact-text" class:is-leaving={factLeaving} bind:this={factText}>{fact}</p>
      </div>
    {:else}
      <div class="error-container" role="alert">
        <div class="error-icon-wrap">
          <svg
            width="28"
            height="28"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            aria-hidden="true"
          >
            <circle cx="12" cy="12" r="10" />
            <line x1="15" y1="9" x2="9" y2="15" />
            <line x1="9" y1="9" x2="15" y2="15" />
          </svg>
        </div>
        <h2 class="error-title">Generation Failed</h2>
        <p class="error-message">{failureMessage}</p>
        <div class="error-actions">
          {#if canRetry}
            <button class="retry-btn" onclick={retry}>Try Again</button>
          {/if}
          <!-- Retrying keeps the same topic, so there has to be a way to change it: a topic the
               model cannot build will fail again. -->
          <button class="back-btn" onclick={() => (window.location.href = '/')}>Change topic</button
          >
        </div>
      </div>
    {/if}
  </main>

  <div bind:this={particles} class="particles" aria-hidden="true"></div>
</div>
