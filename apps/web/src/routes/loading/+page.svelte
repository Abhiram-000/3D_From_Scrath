<!--
  The loading page: make one to three minutes feel worth it (`07`).

  Everything visible is driven by real server events — the orbital loader is the only unconditional
  motion. The stage stepper and progress bar advance only on phase events; inside a phase the bar
  eases toward but never reaches the next milestone, so slow work looks slow and fast work looks
  fast. The error state replaces the progress UI with the two exits `07` requires: Try Again (same
  topic) and Change Topic (back to landing) — "a topic the model can't build will fail again, and the
  user must not be trapped in a retry loop".
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { Ambient } from '$lib/ambient.ts';
  import { generateStream, storeBundle, takeTopic } from '$lib/core/api.ts';
  import { FactQueue, ProgressModel, STAGES } from '$lib/core/loading-progress.ts';
  import { detectTier } from '$lib/engine/sandbox-host.ts';

  let topic = $state('');
  let progress = $state(new ProgressModel());
  let barValue = $state(0);
  let status = $state('Analyzing your topic and planning the 3D model…');
  let fact = $state('Loading amazing facts…');
  let factLeaving = $state(false);
  let failed = $state(false);
  let failureMessage = $state('');
  let canRetry = $state(true);
  let running = $state(false);

  let ambient: Ambient | null = null;
  let progressTimer: ReturnType<typeof setInterval> | null = null;
  let factTimer: ReturnType<typeof setInterval> | null = null;
  let factQueue: FactQueue | null = null;
  let controller: AbortController | null = null;

  const STAGE_LABELS = ['Thinking', 'Generating', 'Compiling', 'Ready'] as const;

  onMount(() => {
    topic = takeTopic();
    ambient = new Ambient({ grid: true, magnetStrength: 0.1, magnetRadius: 90 });
    ambient.mount().parallaxize('[data-parallax]').magnetize('.loader-badge').sheen('.has-sheen');
    factQueue = new FactQueue(topic || 'science');
    rotateFact();

    // ~6.5s per fact: the wait becomes content (`07`).
    factTimer = setInterval(rotateFact, 6_500);
    progressTimer = setInterval(() => {
      progress.tick();
      barValue = progress.value;
      status = progress.status;
    }, 200);

    // Arriving with no topic is a lost session, not a generation to bill (`07`).
    if (!topic) {
      showError('No topic to generate. Start from the landing page and describe what you want to see.', false);
      return cleanup;
    }

    void start();
    return cleanup;
  });

  function cleanup() {
    if (progressTimer) clearInterval(progressTimer);
    if (factTimer) clearInterval(factTimer);
    ambient?.destroy();
  }

  function rotateFact() {
    if (factLeaving || !factQueue) return;
    factLeaving = true;
    setTimeout(() => {
      fact = factQueue!.next();
      factLeaving = false;
    }, 400);
  }

  async function start() {
    if (running) return;
    running = true;
    failed = false;
    controller = new AbortController();

    const { tier } = detectTier();
    const outcome = await generateStream({
      topic,
      tier,
      signal: controller.signal,
      onEvent: (event) => {
        progress.apply(event);
        barValue = progress.value;
        status = progress.status;
      },
    });

    running = false;
    if (outcome.ok) {
      storeBundle(outcome.bundle.code);
      window.location.href = '/viewer';
    } else {
      // A cancelled run navigated away already; everything else is a real failure with an exit.
      if (outcome.code === 'aborted') return;
      showError(
        outcome.message === 'The server could not be reached. Is the backend running?'
          ? 'The backend is not running. Start it with pnpm dev, then try again.'
          : outcome.message,
        outcome.code !== 'stalled',
      );
    }
  }

  function showError(message: string, retryable = true) {
    failed = true;
    failureMessage = message;
    canRetry = retryable;
  }

  function retry() {
    failed = false;
    progress = new ProgressModel();
    void start();
  }
</script>

<svelte:head>
  <title>Generating your 3D model — EDU-3D</title>
</svelte:head>

<div class="loading">
  <main class="content" class:failed>
    {#if !failed}
      <div class="loader-badge" aria-label="Building your 3D scene">
        <div class="scene-loader" role="img">
          <span class="halo"></span>
          <span class="orbit orbit-one"><i></i></span>
          <span class="orbit orbit-two"><i></i></span>
          <span class="orbit orbit-three"><i></i></span>
          <svg width="42" height="42" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M12 2L2 7L12 12L22 7L12 2Z" stroke="url(#loader-gradient)" stroke-width="1.5" stroke-linejoin="round" />
            <path d="M2 17L12 22L22 17" stroke="url(#loader-gradient)" stroke-width="1.5" stroke-linejoin="round" />
            <path d="M2 12L12 17L22 12" stroke="url(#loader-gradient)" stroke-width="1.5" stroke-linejoin="round" />
            <defs>
              <linearGradient id="loader-gradient" x1="0%" y1="0%" x2="100%" y2="100%">
                <stop offset="0%" stop-color="#f4ecd8" />
                <stop offset="52%" stop-color="#d4a055" />
                <stop offset="100%" stop-color="#c2885c" />
              </linearGradient>
            </defs>
          </svg>
        </div>
      </div>

      <h1 class="title"><span class="gradient-text">Generating your 3D model</span></h1>
      <p class="topic-pill">{topic || 'No topic'}</p>

      <div class="stages" role="list" aria-label="Generation progress">
        {#each STAGES as stage, index (stage)}
          <div
            class="stage"
            role="listitem"
            class:active={progress.stage === stage}
            class:completed={progress.completedStages > index}
          >
            <div class="stage-icon">
              {#if index === 0}
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="10" /><path d="M12 16v-4M12 8h.01" /></svg>
              {:else if index === 1}
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M12 2L2 7L12 12L22 7L12 2Z" /><path d="M2 17L12 22L22 17" /></svg>
              {:else if index === 2}
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><polyline points="16 18 22 12 16 6" /><polyline points="8 6 2 12 8 18" /></svg>
              {:else}
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><polyline points="20 6 9 17 4 12" /></svg>
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

      <p class="status" aria-live="polite">{status}</p>

      <div class="bar-container">
        <div
          class="bar"
          role="progressbar"
          aria-valuenow={Math.round(barValue)}
          aria-valuemin="0"
          aria-valuemax="100"
          style={`width:${barValue}%`}
        ></div>
      </div>

      <div class="fact-card glass has-sheen" aria-live="polite">
        <p class="fact-label">Did you know?</p>
        <p class="fact-text" class:leaving={factLeaving}>{fact}</p>
      </div>
    {:else}
      <div class="error-card glass" role="alert">
        <div class="error-icon">
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
            <circle cx="12" cy="12" r="10" />
            <path d="M15 9l-6 6M9 9l6 6" />
          </svg>
        </div>
        <h2 class="error-title">Generation Failed</h2>
        <p class="error-message">{failureMessage}</p>
        <div class="error-actions">
          {#if canRetry}
            <button class="primary" onclick={retry}>Try Again</button>
          {/if}
          <button class="secondary" onclick={() => (window.location.href = '/')}>Change topic</button>
        </div>
      </div>
    {/if}
  </main>

  <div class="particles decorative" aria-hidden="true">
    {#each Array.from({ length: 14 }) as _, index (index)}
      <span
        class="particle"
        style={`left:${8 + (index * 6.4) % 84}%;top:${15 + ((index * 37) % 70)}%;animation-delay:${(index % 7) * 0.55}s`}
      ></span>
    {/each}
  </div>
</div>

<style>
  .loading {
    position: relative;
    width: 100%;
    height: 100vh;
    height: 100dvh;
    display: grid;
    place-items: center;
    overflow: hidden;
    background:
      radial-gradient(1200px 800px at 78% -12%, rgb(212 160 85 / 10%) 0%, transparent 55%),
      radial-gradient(900px 700px at 0% 110%, rgb(194 136 92 / 10%) 0%, transparent 55%),
      var(--bg);
  }

  .content {
    position: relative;
    z-index: 2;
    text-align: center;
    max-width: 620px;
    width: 100%;
    padding: clamp(1.25rem, 4vw, 2rem);
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--space-6);
    animation: content-in 0.6s var(--ease-out);
  }

  @keyframes content-in {
    from {
      opacity: 0;
      transform: translateY(16px);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }

  /* The loader badge: a glass square holding the orbital construction. */
  .loader-badge {
    display: grid;
    place-items: center;
    width: 84px;
    height: 84px;
    border-radius: var(--radius-xl);
    background: var(--glass-bg);
    border: 1px solid var(--border);
    box-shadow: var(--shadow-md);
  }

  .scene-loader {
    position: relative;
    width: 58px;
    height: 58px;
    display: grid;
    place-items: center;
    isolation: isolate;
  }

  .halo {
    position: absolute;
    inset: 12px;
    border-radius: 50%;
    background: radial-gradient(circle, var(--amber-glow), transparent 68%);
    filter: blur(5px);
    animation: core-pulse 2.4s ease-in-out infinite;
  }

  /* An orbital construction diagram rather than a progress wheel: three tilted rings, each with a
     satellite dot, and the brand mark floating in the centre. */
  .orbit {
    position: absolute;
    inset: 4px;
    border: 1px solid var(--border-strong);
    border-radius: 50%;
    transform: rotate(48deg) scaleY(0.42);
  }

  .orbit-two {
    inset: 8px;
    transform: rotate(-48deg) scaleY(0.42);
    border-color: var(--accent);
    opacity: 0.72;
  }

  .orbit-three {
    inset: 1px;
    transform: rotate(90deg) scaleY(0.3);
    border-color: var(--amber-500, #d4a055);
    opacity: 0.46;
  }

  .orbit i {
    position: absolute;
    top: 50%;
    left: -3px;
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--cream-200, #f4ecd8);
    box-shadow: 0 0 10px var(--accent-soft);
    transform: translateY(-50%);
  }

  .orbit-one {
    animation: orbit-spin 3.2s linear infinite;
  }

  .orbit-two {
    animation: orbit-spin-reverse 2.6s linear infinite;
  }

  .orbit-three {
    animation: orbit-spin-wide 4.4s linear infinite;
  }

  @keyframes orbit-spin {
    to {
      transform: rotate(408deg) scaleY(0.42);
    }
  }

  @keyframes orbit-spin-reverse {
    to {
      transform: rotate(-408deg) scaleY(0.42);
    }
  }

  @keyframes orbit-spin-wide {
    to {
      transform: rotate(408deg) scaleY(0.3);
    }
  }

  @keyframes core-pulse {
    0%,
    100% {
      opacity: 0.42;
      transform: scale(0.82);
    }
    50% {
      opacity: 0.9;
      transform: scale(1.16);
    }
  }

  .scene-loader :global(svg) {
    position: relative;
    z-index: 1;
    filter: drop-shadow(0 0 9px var(--accent-soft));
    animation: logo-float 3.2s var(--ease-out) infinite;
  }

  @keyframes logo-float {
    0%,
    100% {
      transform: translateY(1px) rotate(-3deg) scale(0.96);
    }
    50% {
      transform: translateY(-2px) rotate(3deg) scale(1.04);
    }
  }

  .title {
    font-size: clamp(1.5rem, 4vw, 2.125rem);
    font-weight: 800;
    letter-spacing: -0.035em;
  }

  .topic-pill {
    font-size: 0.875rem;
    color: var(--text-muted);
    font-weight: 600;
    padding: 0.4375rem 0.875rem;
    border-radius: var(--radius-full);
    background: var(--surface);
    border: 1px solid var(--border);
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* ── Stage stepper ── */
  .stages {
    display: flex;
    justify-content: center;
    align-items: flex-start;
    width: 100%;
  }

  .stage {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--space-2);
    opacity: 0.45;
    transition: opacity var(--duration-base) ease;
    flex-shrink: 0;
  }

  .stage.active,
  .stage.completed {
    opacity: 1;
  }

  .stage-icon {
    position: relative;
    width: 46px;
    height: 46px;
    border-radius: var(--radius-full);
    display: grid;
    place-items: center;
    background: var(--bg-raised);
    border: 1.5px solid var(--border-strong);
    color: var(--text-subtle);
    transition:
      border-color var(--duration-base) var(--ease-out),
      background var(--duration-base) ease,
      color var(--duration-base) ease,
      transform var(--duration-base) var(--ease-out);
  }

  .stage.active .stage-icon {
    border-color: var(--accent);
    background: var(--accent-soft);
    color: var(--accent);
    box-shadow: 0 0 0 4px var(--accent-soft);
    transform: scale(1.06);
  }

  .stage.completed .stage-icon {
    border-color: var(--status-ok);
    background: rgb(123 168 136 / 14%);
    color: var(--status-ok);
    animation: success-pop 0.5s var(--ease-spring);
  }

  @keyframes success-pop {
    50% {
      transform: scale(1.14);
    }
  }

  .stage-label {
    font-size: 0.75rem;
    color: var(--text-subtle);
    font-weight: 500;
  }

  .stage.active .stage-label {
    color: var(--text);
    font-weight: 600;
  }

  .stage-spinner {
    position: absolute;
    inset: -5px;
    border: 2px solid transparent;
    border-top-color: var(--accent);
    border-radius: 50%;
    opacity: 0;
  }

  .stage.active .stage-spinner {
    opacity: 1;
    animation: spin 0.9s linear infinite;
  }

  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }

  .stage-connector {
    display: flex;
    align-items: center;
    height: 46px;
    flex: 1 1 auto;
    min-width: 16px;
    max-width: 56px;
  }

  .connector-line {
    width: 100%;
    height: 2px;
    border-radius: 1px;
    background: var(--border);
  }

  .status {
    font-size: 0.875rem;
    color: var(--text-muted);
    min-height: 1.5em;
    max-width: 44ch;
  }

  .bar-container {
    width: 100%;
    height: 5px;
    background: var(--surface);
    border-radius: var(--radius-full);
    overflow: hidden;
  }

  .bar {
    height: 100%;
    border-radius: var(--radius-full);
    background: var(--gradient-accent);
    box-shadow: 0 0 12px var(--accent-soft);
    transition: width 0.2s linear;
  }

  /* ── Fact card ── */
  .fact-card {
    width: 100%;
    text-align: left;
    padding: var(--space-5);
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  .fact-label {
    font-size: 0.6875rem;
    text-transform: uppercase;
    letter-spacing: 0.09em;
    color: var(--accent);
    font-weight: 700;
    display: flex;
    align-items: center;
    gap: var(--space-2);
  }

  .fact-label::before {
    content: '';
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--accent);
    box-shadow: 0 0 8px var(--accent-soft);
  }

  .fact-text {
    font-size: 0.9375rem;
    color: var(--text-muted);
    line-height: 1.6;
    min-height: 3em;
    transition: opacity 0.4s ease, transform 0.4s var(--ease-out);
  }

  .fact-text.leaving {
    opacity: 0;
    transform: translateY(-6px);
  }

  /* ── Error state: replaces the progress UI, not the page ── */
  .error-card {
    width: 100%;
    border-color: var(--status-error);
    padding: var(--space-8) var(--space-6);
    text-align: center;
    animation: content-in 0.4s var(--ease-out);
  }

  .error-icon {
    width: 56px;
    height: 56px;
    border-radius: var(--radius-full);
    background: rgb(199 106 106 / 14%);
    display: grid;
    place-items: center;
    margin: 0 auto var(--space-4);
    color: var(--status-error);
  }

  .error-title {
    font-size: 1.25rem;
    font-weight: 700;
    margin-bottom: var(--space-2);
  }

  .error-message {
    font-size: 0.9375rem;
    color: var(--text-muted);
    margin-bottom: var(--space-6);
    line-height: 1.6;
  }

  .error-actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-3);
    justify-content: center;
  }

  .primary {
    background: var(--gradient-accent);
    border: none;
    border-radius: var(--radius-sm);
    padding: 0.75rem 1.5rem;
    font-size: 0.875rem;
    font-weight: 600;
    color: var(--accent-contrast);
    box-shadow: 0 2px 10px var(--accent-soft);
    transition: transform var(--duration-fast) var(--ease-out), filter var(--duration-fast) ease;
  }

  .primary:hover {
    filter: brightness(1.05);
    transform: translateY(-1px);
  }

  .secondary {
    background: transparent;
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-sm);
    padding: 0.75rem 1.25rem;
    font-size: 0.875rem;
    font-weight: 600;
    color: var(--text-muted);
    transition: color var(--duration-fast) ease, border-color var(--duration-fast) ease;
  }

  .secondary:hover {
    color: var(--text);
    border-color: var(--accent-ring);
  }

  /* ── Particles ── */
  .particles {
    position: absolute;
    inset: 0;
    z-index: 0;
  }

  .particle {
    position: absolute;
    width: 3px;
    height: 3px;
    border-radius: 50%;
    background: var(--accent);
    opacity: 0.25;
    animation: float-particle 4s ease-in-out infinite;
  }

  @keyframes float-particle {
    0%,
    100% {
      transform: translateY(0);
      opacity: 0.12;
    }
    50% {
      transform: translateY(-18px);
      opacity: 0.4;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .orbit,
    .halo,
    .scene-loader :global(svg),
    .particle {
      animation: none;
    }

    .bar {
      transition: none;
    }
  }

  @media (max-width: 640px) {
    .content {
      gap: var(--space-5);
    }

    .stage-icon {
      width: 40px;
      height: 40px;
    }

    .stage-connector {
      height: 40px;
      min-width: 8px;
    }

    .stage-label {
      font-size: 0.6875rem;
    }

    .loader-badge {
      width: 68px;
      height: 68px;
    }
  }

  @media (max-height: 700px) {
    .content {
      gap: var(--space-4);
    }

    .loader-badge {
      width: 60px;
      height: 60px;
    }

    .fact-text {
      min-height: 0;
    }
  }
</style>
