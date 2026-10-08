<!--
  The landing page: one job — get a topic into the box and a click on Generate (`07`).

  The V1 experience, rebuilt in Svelte: eyebrow → typing headline → description → the glass prompt
  card (sheen + glow border, live counter, Enter submits) → quick-start chips with ripple. The
  ambient cursor system (dot grid, spotlight, parallax, magnetic, sheen) mounts here exactly as V1
  did, one rAF loop for all of it, gated to fine pointers with motion allowed.

  The page stays deliberately light: no engine, no physics, no viewer code (`08`'s hard budget). The
  wireframe backdrop is the one indulgence and it degrades away on weak devices.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { Ambient, getTheme, setTheme } from '$lib/ambient.ts';

  const HEADLINE = 'Any topic,';
  const HEADLINE_2 = 'in three dimensions.';

  let topic = $state('');
  let typed = $state('');
  let typingDone = $state(false);
  let submitting = $state(false);
  let notice = $state<string | null>(null);
  let shake = $state(false);
  let theme = $state<'dark' | 'light'>('dark');
  let ambient: Ambient | null = null;
  let lastGenerateAt = 0;

  /** A few seconds between attempts, with the wait counted down in the message (`07`). */
  const CLIENT_RATE_LIMIT_MS = 8_000;

  const QUICK_STARTS: ReadonlyArray<{ label: string; topic: string }> = [
    { label: 'Water Molecule', topic: 'How does a water molecule form?' },
    { label: 'Cell Division', topic: 'Explain cellular mitosis' },
    { label: 'Solar System', topic: 'Show me the solar system' },
  ];

  onMount(() => {
    theme = getTheme();
    ambient = new Ambient({ grid: true, magnetStrength: 0.12, magnetRadius: 130 });
    ambient.mount().parallaxize('[data-parallax]').magnetize('[data-magnetic]').sheen('.has-sheen, .has-glow-border');

    // The headline types itself so the page is alive within 350ms of arrival; reduced-motion CSS
    // neutralises the cursor blink, and the typing itself stops early there.
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduced) {
      typed = HEADLINE;
      typingDone = true;
      return () => ambient?.destroy();
    }
    let index = 0;
    const typer = setInterval(() => {
      index += 1;
      typed = HEADLINE.slice(0, index);
      if (index >= HEADLINE.length) {
        clearInterval(typer);
        typingDone = true;
      }
    }, 55);

    // Focus after the entrance animation is seen — but never on touch, where a keyboard popping up
    // uninvited is hostile (`07`).
    const coarse = window.matchMedia('(pointer: coarse)').matches;
    if (!coarse) setTimeout(() => document.getElementById('topic-input')?.focus(), 900);

    return () => {
      clearInterval(typer);
      ambient?.destroy();
    };
  });

  function toggleTheme() {
    theme = setTheme(theme === 'dark' ? 'light' : 'dark');
  }

  /** The suspicious-content screen from `07`: markup and URL schemes are rejected with a clear message. */
  function suspicious(value: string): boolean {
    return [/<script/i, /javascript:/i, /on\w+\s*=/i, /data:text\/html/i, /<iframe/i, /eval\(/i].some(
      (pattern) => pattern.test(value),
    );
  }

  function showNotice(message: string) {
    notice = message;
    shake = true;
    setTimeout(() => (shake = false), 500);
    setTimeout(() => (notice = null), 5000);
  }

  function ripple(event: MouseEvent, element: HTMLElement) {
    const rect = element.getBoundingClientRect();
    const size = Math.max(rect.width, rect.height);
    const dot = document.createElement('span');
    dot.style.cssText = `position:absolute;width:${size}px;height:${size}px;border-radius:50%;background:var(--accent-soft);left:${event.clientX - rect.left - size / 2}px;top:${event.clientY - rect.top - size / 2}px;transform:scale(0);animation:chip-ripple 0.6s ease-out;pointer-events:none;`;
    element.appendChild(dot);
    setTimeout(() => dot.remove(), 600);
  }

  function generate() {
    const value = topic.trim();

    if (value.length === 0 || value.length < 5) {
      showNotice('Describe what you want to see — a few words is enough.');
      return;
    }
    if (suspicious(value)) {
      showNotice('That text looks like code or markup. Describe the topic in plain words.');
      return;
    }

    const now = Date.now();
    const wait = CLIENT_RATE_LIMIT_MS - (now - lastGenerateAt);
    if (wait > 0) {
      showNotice(`Please wait ${Math.ceil(wait / 1000)}s before generating again.`);
      return;
    }
    lastGenerateAt = now;

    submitting = true;
    try {
      sessionStorage.setItem('edu3d.topic', value);
      // The fade-out is the thank-you: a transition, not a jump-cut (`07`).
      document.querySelector('.landing')?.classList.add('is-leaving');
      setTimeout(() => {
        window.location.href = '/loading';
      }, 480);
    } catch {
      showNotice('Could not start. Try again.');
      submitting = false;
    }
  }
</script>

<svelte:head>
  <title>EDU-3D — AI-powered interactive 3D learning</title>
</svelte:head>

<div class="landing">
  <header class="header">
    <div class="brand" data-magnetic data-parallax="6">
      <svg width="28" height="28" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="M12 2L2 7L12 12L22 7L12 2Z" stroke="url(#brand-gradient)" stroke-width="2" stroke-linejoin="round" />
        <path d="M2 17L12 22L22 17" stroke="url(#brand-gradient)" stroke-width="2" stroke-linejoin="round" />
        <path d="M2 12L12 17L22 12" stroke="url(#brand-gradient)" stroke-width="2" stroke-linejoin="round" />
        <defs>
          <linearGradient id="brand-gradient" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stop-color="#f4ecd8" />
            <stop offset="50%" stop-color="#d4a055" />
            <stop offset="100%" stop-color="#c2885c" />
          </linearGradient>
        </defs>
      </svg>
      <span class="brand-name">EDU-3D</span>
    </div>
    <button class="theme-toggle" data-magnetic onclick={toggleTheme} aria-label="Toggle theme">
      <svg class="icon-sun" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
        <circle cx="12" cy="12" r="5" />
        <path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42" />
      </svg>
      <svg class="icon-moon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
        <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
      </svg>
    </button>
  </header>

  <main class="hero">
    <div class="hero-center">
      <p class="eyebrow" data-parallax="8">AI-powered interactive learning</p>

      <h1 class="headline" data-parallax="14">
        <span class="gradient-text">{typed}</span><span class="cursor" aria-hidden="true">|</span>
        {#if typingDone}<span class="headline-second fade-in">in Interactive 3D</span>{/if}
      </h1>

      <p class="description fade-in-delayed" data-parallax="10">
        Transform any concept into an immersive 3D experience. Interactive models, guided tours and
        intelligent assessments — generated in minutes.
      </p>

      <div class="prompt-card glass has-sheen has-glow-border" data-magnetic data-parallax="7">
        <label class="sr-only" for="topic-input">Enter a learning topic</label>
        <textarea
          id="topic-input"
          class="prompt-input"
          class:shake
          placeholder="e.g., How does photosynthesis work? Show me a steam engine. Explain DNA replication…"
          rows="2"
          maxlength="500"
          bind:value={topic}
          onkeydown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              generate();
            }
          }}
        ></textarea>
        <div class="prompt-footer">
          <div class="prompt-meta">
            <div
              class="counter"
              class:warning={topic.length > 450}
              class:error={topic.length >= 500}
              aria-live="polite"
            >
              {topic.length} / 500
            </div>
            <span class="hint">
              Press <kbd>Enter</kbd> to generate · <kbd>Shift</kbd>+<kbd>Enter</kbd> for a new line
            </span>
          </div>
          <button class="generate" onclick={generate} disabled={submitting} data-magnetic>
            <span>{submitting ? 'Starting…' : 'Generate 3D Model'}</span>
            <svg width="18" height="18" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
              <path d="M10 3L18 10L10 17V12H2V8H10V3Z" />
            </svg>
          </button>
        </div>
      </div>

      {#if notice}
        <p class="notice" role="alert">{notice}</p>
      {/if}

      <div class="quick-start fade-in-delayed-2">
        <span class="quick-start-label">Quick Start</span>
        <div class="quick-start-list">
          {#each QUICK_STARTS as chip (chip.label)}
            <button
              class="chip"
              data-magnetic
              onclick={(event) => {
                topic = chip.topic;
                document.getElementById('topic-input')?.focus();
                if (!window.matchMedia('(pointer: coarse)').matches) ripple(event, event.currentTarget);
              }}
            >
              {chip.label}
            </button>
          {/each}
        </div>
      </div>
    </div>
  </main>

  <footer class="footer">
    <p>EDU-3D — Learn anything, in 3D</p>
  </footer>
</div>

<style>
  .landing {
    position: relative;
    z-index: 3;
    height: 100vh;
    height: 100dvh;
    display: grid;
    grid-template-rows: auto 1fr auto;
    overflow: hidden;
    background:
      radial-gradient(1200px 800px at 78% -12%, rgb(212 160 85 / 10%) 0%, transparent 55%),
      radial-gradient(900px 700px at 0% 110%, rgb(194 136 92 / 10%) 0%, transparent 55%),
      var(--bg);
    transition: opacity 0.48s ease, transform 0.48s ease;
  }

  .landing.is-leaving {
    opacity: 0;
    transform: scale(1.012);
    pointer-events: none;
  }

  .header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: clamp(1rem, 2.2vw, 1.5rem) clamp(1.25rem, 4vw, 2.75rem);
    animation: slide-down 0.7s var(--ease-out) both;
  }

  @keyframes slide-down {
    from {
      opacity: 0;
      transform: translateY(-14px);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }

  .brand {
    display: flex;
    align-items: center;
    gap: var(--space-3);
  }

  .brand svg {
    filter: drop-shadow(0 0 14px var(--accent-soft));
  }

  .brand-name {
    font-family: var(--font-display);
    font-weight: 700;
    letter-spacing: -0.02em;
  }

  .theme-toggle {
    position: relative;
    width: 42px;
    height: 42px;
    display: grid;
    place-items: center;
    border: 1px solid var(--border);
    border-radius: var(--radius-full);
    background: var(--surface);
    transition: border-color var(--duration-fast) ease, box-shadow var(--duration-fast) ease;
  }

  .theme-toggle:hover {
    border-color: var(--accent);
    box-shadow: 0 0 0 4px var(--accent-soft);
  }

  .theme-toggle :global(svg) {
    position: absolute;
    color: var(--text-muted);
    transition: opacity var(--duration-base) ease, transform var(--duration-base) var(--ease-out);
  }

  .icon-sun {
    opacity: 0;
    transform: rotate(-90deg) scale(0);
  }

  .icon-moon {
    opacity: 1;
    transform: rotate(0) scale(1);
  }

  :global([data-theme='light']) .icon-sun {
    opacity: 1;
    transform: rotate(0) scale(1);
  }

  :global([data-theme='light']) .icon-moon {
    opacity: 0;
    transform: rotate(90deg) scale(0);
  }

  .hero {
    display: grid;
    place-items: center;
    padding: 0 clamp(1.25rem, 5vw, 2.5rem);
    min-height: 0;
  }

  .hero-center {
    width: 100%;
    max-width: 640px;
    display: flex;
    flex-direction: column;
    align-items: center;
    text-align: center;
    gap: clamp(0.875rem, 2vh, 1.375rem);
  }

  .eyebrow {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    padding: 0.4375rem 0.9375rem;
    font-size: 0.75rem;
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--accent-hover);
    background: var(--accent-soft);
    border: 1px solid var(--accent-ring);
    border-radius: var(--radius-full);
    animation: rise-in 0.7s var(--ease-out) 0.05s both;
  }

  .eyebrow::before {
    content: '';
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--accent);
    box-shadow: 0 0 10px var(--accent);
    animation: pulse-dot 2.4s ease-in-out infinite;
  }

  @keyframes pulse-dot {
    0%,
    100% {
      opacity: 1;
      transform: scale(1);
    }
    50% {
      opacity: 0.5;
      transform: scale(0.8);
    }
  }

  .headline {
    font-size: clamp(2.5rem, 6.5vw, 4.5rem);
    font-weight: 800;
    line-height: 1.05;
    letter-spacing: -0.04em;
    text-wrap: balance;
    animation: rise-in 0.8s var(--ease-out) 0.1s both;
  }

  .cursor {
    animation: blink 1.05s step-start infinite;
    color: var(--accent);
    font-weight: 300;
    margin-left: 1px;
  }

  @keyframes blink {
    50% {
      opacity: 0;
    }
  }

  .headline-second {
    display: block;
    color: var(--text);
    font-weight: 800;
    margin-top: 0.15em;
  }

  .description {
    font-size: clamp(0.9375rem, 1.4vw, 1.0625rem);
    color: var(--text-muted);
    line-height: 1.6;
    max-width: 52ch;
    text-wrap: pretty;
  }

  @keyframes rise-in {
    from {
      opacity: 0;
      transform: translateY(24px);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }

  .fade-in {
    animation: rise-in 0.8s var(--ease-out) 0.12s both;
  }

  .fade-in-delayed {
    animation: rise-in 0.8s var(--ease-out) 0.18s both;
  }

  .fade-in-delayed-2 {
    animation: rise-in 0.8s var(--ease-out) 0.26s both;
  }

  /* The prompt card: the centerpiece. Glass + sheen + a glow border that follows the cursor. */
  .prompt-card {
    position: relative;
    width: 100%;
    max-width: 720px;
    margin-top: clamp(0.25rem, 1.5vh, 0.75rem);
    padding: 0.875rem 0.875rem 0.75rem;
    text-align: left;
    transition: border-color var(--duration-base) ease, box-shadow var(--duration-base) ease;
    animation: rise-in 0.8s var(--ease-out) 0.34s both;
  }

  .prompt-card:focus-within {
    border-color: var(--accent);
    box-shadow: var(--shadow-lg), 0 0 0 4px var(--accent-soft);
  }

  .prompt-input {
    width: 100%;
    background: transparent;
    border: none;
    padding: 0.5rem 0.5rem 0.625rem;
    font-size: 0.9375rem;
    line-height: 1.55;
    color: var(--text);
    resize: none;
    min-height: 48px;
  }

  .prompt-input:focus {
    outline: none;
  }

  .prompt-input::placeholder {
    color: var(--text-subtle);
  }

  .prompt-input.shake {
    animation: shake 0.5s ease;
  }

  @keyframes shake {
    0%,
    100% {
      transform: translateX(0);
    }
    10%,
    30%,
    50%,
    70%,
    90% {
      transform: translateX(-6px);
    }
    20%,
    40%,
    60%,
    80% {
      transform: translateX(6px);
    }
  }

  .prompt-footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
    padding-top: var(--space-2);
    border-top: 1px solid var(--border);
    margin-top: var(--space-1);
  }

  .prompt-meta {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .counter {
    font-size: 0.6875rem;
    color: var(--text-subtle);
    font-variant-numeric: tabular-nums;
  }

  .counter.warning {
    color: var(--status-warn);
  }

  .counter.error {
    color: var(--status-error);
    font-weight: 700;
  }

  .hint {
    font-size: 0.6875rem;
    color: var(--text-subtle);
  }

  .hint kbd {
    font-family: var(--font-mono);
    font-size: 0.625rem;
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 0 4px;
  }

  .generate {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    padding: 0.625rem 1.25rem;
    background: var(--gradient-accent);
    border: none;
    border-radius: var(--radius-full);
    font-size: 0.8125rem;
    font-weight: 650;
    color: var(--accent-contrast);
    box-shadow: 0 4px 18px var(--accent-soft);
    transition:
      transform var(--duration-fast) var(--ease-out),
      box-shadow var(--duration-fast) ease,
      filter var(--duration-fast) ease;
  }

  .generate:hover:not(:disabled) {
    filter: brightness(1.08);
    transform: translateY(-2px);
    box-shadow: 0 8px 26px var(--accent-soft);
  }

  .generate:disabled {
    opacity: 0.55;
    cursor: not-allowed;
    transform: none;
  }

  .notice {
    color: var(--status-error);
    font-size: var(--text-sm);
    animation: rise-in 0.3s var(--ease-out) both;
  }

  .quick-start {
    margin-top: clamp(0.5rem, 1.5vh, 1rem);
  }

  .quick-start-label {
    display: block;
    font-size: 0.6875rem;
    text-transform: uppercase;
    letter-spacing: 0.09em;
    color: var(--text-subtle);
    font-weight: 700;
    margin-bottom: var(--space-3);
  }

  .quick-start-list {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
    justify-content: center;
  }

  .chip {
    position: relative;
    overflow: hidden;
    padding: 0.4375rem 0.9375rem;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-full);
    font-size: 0.8125rem;
    color: var(--text-muted);
    transition:
      background var(--duration-fast) ease,
      border-color var(--duration-fast) ease,
      color var(--duration-fast) ease,
      transform var(--duration-fast) var(--ease-out);
  }

  .chip:hover {
    border-color: var(--accent-ring);
    color: var(--text);
    transform: translateY(-1px);
  }

  @keyframes chip-ripple {
    to {
      transform: scale(4);
      opacity: 0;
    }
  }

  .footer {
    padding: var(--space-4);
    text-align: center;
    color: var(--text-subtle);
    font-size: var(--text-xs);
  }

  @media (max-width: 640px) {
    .hero-center {
      gap: 0.75rem;
    }

    .hint {
      display: none;
    }
  }
</style>
