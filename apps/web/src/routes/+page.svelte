<!--
  The landing page.

  Structure and motion come from V1's landing.html/landing.css (.landing-container, .prompt-card,
  .suggestion-chip…), and the behaviors come from landing.js: Enter submits / Shift+Enter newlines,
  the live counter with warning at 90% and error at 100%, suspicious-content rejection, a 3s client
  rate limit with a countdown in the message, the chip ripple, the toast that slides in from the
  right, and the 0.5s fade-out before navigating to /loading.

  The copy is deliberately short. Conversion research is blunt about it: 70–80% of visitors who don't
  convert never scroll past the hero, above-the-fold is ~70% of a page's outcome, and the two named
  failure modes are "content overload" and "tagline-first headline". So the hero carries one value
  proposition and nothing else — no eyebrow, no feature bullets, no footer tagline.

  Two rules govern every string here:
    1. Outcome, never architecture. "Real code, not a template" is a differentiator to engineers and
       noise to everyone else; high-converting AI pages (Copy.ai, Descript, Gamma, Lumen5) name no
       model architecture at all. Say what the learner gets.
    2. Only claims the platform honours *today*, and the two physics defects this rule was written
       around are fixed: the rotation is reported through THREE's own quaternion conversion
       (3aa908e) and colliders are derived from the geometry the builder actually made, measured
       from its bounding radius (f2774fd). Both are pinned by regression tests in
       physics-world.test.ts ("gives a large body a large collider, not a fixed 0.5 m ball" and
       "rotation is reported in radians"), so the claim holds by test rather than by memory. The
       rule still stands: every proof line below is backed by a passing test or a shipped behavior.
       (It was originally written against a plan that has since landed — a rule that outlives the
       defect it was written for stops being caution and starts being a stale claim of its own.)

  The page ships no engine code (`08`): the one indulgence is the wireframe background, which
  degrades to nothing on weak devices.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { resolve } from '$app/paths';
  import { COMPLEXITY_LEVELS, type ComplexityPreference } from '@edu3d/contracts';
  import { Ambient, getTheme, setTheme } from '$lib/ambient.ts';
  import { LandingBackground } from '$lib/landing-background.ts';
  import { suspiciousContent } from '$lib/validate-topic.ts';
  import {
    DEFAULT_COMPLEXITY,
    storeComplexity,
    storeTopic,
    takeComplexity,
  } from '$lib/core/api.ts';
  // V1's landing stylesheet, verbatim. The scoped block at the bottom only adds the fade-out class.
  import '$lib/styles/landing.css';

  const HEADLINE_TEXT = 'Learn Anything';
  /**
   * The typewriter's budget, not its speed. V1 typed at a fixed 80ms/char, which is right for this
   * 13-character headline and wrong for a longer one — so the delay is derived from the text and
   * clamped. At 13 characters it lands on exactly 80ms, which reproduces V1's timing precisely; the
   * arithmetic only takes over if the headline is ever lengthened.
   */
  const HEADLINE_TYPING_MS = 1300;
  const HEADLINE_MIN_STEP_MS = 35;
  const HEADLINE_MAX_STEP_MS = 80;
  const HEADLINE_START_DELAY_MS = 350;

  const RATE_LIMIT_MS = 3000;

  let topic = $state('');
  let typed = $state('');
  let complexity = $state<ComplexityPreference>(DEFAULT_COMPLEXITY);
  let submitting = $state(false);
  let theme = $state<'dark' | 'light'>('dark');

  /** The chosen level's own numbers, rendered from contracts so the label cannot drift from the ask. */
  const level = $derived(COMPLEXITY_LEVELS.find((entry) => entry.id === complexity)!);

  let lastGenerateTime = 0;
  let ambient: Ambient | null = null;
  let background: LandingBackground | null = null;
  let bgCanvas: HTMLCanvasElement | null = $state(null);

  const QUICK_STARTS: ReadonlyArray<{ label: string; topic: string }> = [
    { label: 'Water Molecule', topic: 'How does a water molecule form?' },
    { label: 'Cell Division', topic: 'Explain cellular mitosis' },
    { label: 'Solar System', topic: 'Show me the solar system' },
  ];

  onMount(() => {
    theme = getTheme();
    complexity = takeComplexity();

    // The layered cursor system: reactive dot grid, trailing spotlight, parallax depth, magnetic
    // pull and glass sheen — one rAF loop, exactly as V1 configured it.
    ambient = new Ambient({ grid: true, magnetStrength: 0.12, magnetRadius: 130 });
    ambient
      .mount()
      .parallaxize('[data-parallax]')
      .magnetize('[data-magnetic]')
      .sheen('.has-sheen, .has-glow-border');

    if (bgCanvas) {
      background = new LandingBackground();
      background.init(bgCanvas);
    }

    /*
     * The typewriter, back. It earns its place: the page is alive within 350ms of arrival, and a
     * headline that writes itself says "this is the thing that does the work" before a word of the
     * description is read. What changed is only the rate — see HEADLINE_TYPING_MS.
     *
     * Reduced-motion users get the finished headline immediately; the cursor is suppressed there by
     * the media query in landing.css rather than by a second code path.
     */
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduced) {
      typed = HEADLINE_TEXT;
      return () => {
        ambient?.destroy();
        background?.destroy();
      };
    }

    const step = Math.min(
      HEADLINE_MAX_STEP_MS,
      Math.max(HEADLINE_MIN_STEP_MS, Math.round(HEADLINE_TYPING_MS / HEADLINE_TEXT.length)),
    );
    let index = 0;
    let typer: ReturnType<typeof setTimeout>;
    const type = () => {
      if (index < HEADLINE_TEXT.length) {
        typed = HEADLINE_TEXT.substring(0, index + 1);
        index += 1;
        typer = setTimeout(type, step);
      }
    };
    typer = setTimeout(type, HEADLINE_START_DELAY_MS);

    // Focus the input after the entrance animation is seen — never on touch, where an uninvited
    // keyboard is hostile (`07`).
    if (!window.matchMedia('(pointer: coarse)').matches) {
      setTimeout(() => document.getElementById('topicInput')?.focus(), 900);
    }

    return () => {
      clearTimeout(typer);
      ambient?.destroy();
      background?.destroy();
    };
  });

  function toggleTheme() {
    theme = setTheme(theme === 'dark' ? 'light' : 'dark');
    // V1's little flourish: the toggle leans back as the sun and moon cross-fade.
    const toggle = document.getElementById('themeToggle');
    if (toggle) {
      toggle.style.transform = 'scale(0.9) rotate(180deg)';
      setTimeout(() => (toggle.style.transform = ''), 300);
    }
  }

  function updateCounter(): { warning: boolean; error: boolean } {
    return { warning: topic.length > 500 * 0.9, error: topic.length >= 500 };
  }

  const suspicious = suspiciousContent;

  /** V1's toast: slides in from the right, out again 3.5s later. */
  function showError(message: string) {
    const toast = document.createElement('div');
    toast.textContent = message;
    toast.className = 'error-toast';
    toast.style.cssText = `
        position: fixed;
        top: 20px;
        right: 20px;
        max-width: min(90vw, 360px);
        background: var(--danger-muted);
        backdrop-filter: blur(10px);
        border: 1px solid var(--danger);
        color: var(--danger);
        padding: 0.875rem 1.25rem;
        border-radius: var(--radius-md);
        font-weight: 600;
        font-size: 0.875rem;
        z-index: 10000;
        animation: slideInRight 0.4s var(--ease-out);
        box-shadow: var(--shadow-md);
    `;
    if (!document.querySelector('#toast-styles')) {
      const style = document.createElement('style');
      style.id = 'toast-styles';
      style.textContent = `
          @keyframes slideInRight {
              from { transform: translateX(400px); opacity: 0; }
              to { transform: translateX(0); opacity: 1; }
          }
          @keyframes slideOutRight {
              from { transform: translateX(0); opacity: 1; }
              to { transform: translateX(400px); opacity: 0; }
          }
      `;
      document.head.appendChild(style);
    }
    document.body.appendChild(toast);
    setTimeout(() => {
      toast.style.animation = 'slideOutRight 0.3s ease-out';
      setTimeout(() => toast.remove(), 300);
    }, 3500);
  }

  function shakeElement(element: HTMLElement) {
    element.style.animation = 'shake 0.5s ease';
    setTimeout(() => (element.style.animation = ''), 500);
    if (!document.querySelector('#shake-styles')) {
      const style = document.createElement('style');
      style.id = 'shake-styles';
      style.textContent = `
          @keyframes shake {
              0%, 100% { transform: translateX(0); }
              10%, 30%, 50%, 70%, 90% { transform: translateX(-6px); }
              20%, 40%, 60%, 80% { transform: translateX(6px); }
          }
      `;
      document.head.appendChild(style);
    }
  }

  function createRipple(element: HTMLElement, event: MouseEvent) {
    const rect = element.getBoundingClientRect();
    const size = Math.max(rect.width, rect.height);
    const ripple = document.createElement('span');
    ripple.style.cssText = `
        position: absolute;
        width: ${size}px;
        height: ${size}px;
        border-radius: 50%;
        background: var(--accent-glow);
        left: ${event.clientX - rect.left - size / 2}px;
        top: ${event.clientY - rect.top - size / 2}px;
        transform: scale(0);
        animation: ripple 0.6s ease-out;
        pointer-events: none;
    `;
    if (!document.querySelector('#ripple-styles')) {
      const style = document.createElement('style');
      style.id = 'ripple-styles';
      style.textContent = '@keyframes ripple { to { transform: scale(4); opacity: 0; } }';
      document.head.appendChild(style);
    }
    element.style.position = 'relative';
    element.style.overflow = 'hidden';
    element.appendChild(ripple);
    setTimeout(() => ripple.remove(), 600);
  }

  function handleGenerate() {
    const value = topic.trim();

    if (!value) {
      showError('Please enter a topic to generate');
      shakeElement(document.getElementById('topicInput') as HTMLElement);
      return;
    }
    if (value.length < 5) {
      showError('Please provide more details (at least 5 characters)');
      shakeElement(document.getElementById('topicInput') as HTMLElement);
      return;
    }
    if (value.length > 500) {
      showError('Topic is too long (maximum 500 characters)');
      return;
    }

    const now = Date.now();
    if (now - lastGenerateTime < RATE_LIMIT_MS) {
      const waitTime = Math.ceil((RATE_LIMIT_MS - (now - lastGenerateTime)) / 1000);
      showError(`Please wait ${waitTime} second${waitTime > 1 ? 's' : ''} before generating again`);
      return;
    }

    if (suspicious(value)) {
      showError('Invalid input detected. Please enter a valid learning topic');
      return;
    }

    lastGenerateTime = now;
    submitting = true;

    try {
      storeTopic(value);
      // The depth travels with the topic: "what I want built" and "how thoroughly" are one
      // decision, and the loading page reads both before it calls the pipeline.
      storeComplexity(complexity);
      // The conversion that matters: the fade-out thanks the learner for committing — a transition,
      // not a jump-cut (`07`).
      document.querySelector('.landing-container')?.classList.add('is-leaving');
      setTimeout(() => {
        window.location.href = '/loading';
      }, 500);
    } catch {
      showError('Failed to start generation. Please try again.');
      submitting = false;
    }
  }
</script>

<svelte:head>
  <title>EDU-3D | Any Topic, in Interactive 3D</title>
</svelte:head>

<div class="landing-container">
  <header class="landing-header">
    <div class="brand-logo" data-magnetic data-parallax="6">
      <svg
        width="28"
        height="28"
        viewBox="0 0 24 24"
        fill="none"
        class="logo-icon"
        aria-hidden="true"
      >
        <path
          d="M12 2L2 7L12 12L22 7L12 2Z"
          stroke="url(#gradient1)"
          stroke-width="2"
          stroke-linejoin="round"
        />
        <path
          d="M2 17L12 22L22 17"
          stroke="url(#gradient1)"
          stroke-width="2"
          stroke-linejoin="round"
        />
        <path
          d="M2 12L12 17L22 12"
          stroke="url(#gradient1)"
          stroke-width="2"
          stroke-linejoin="round"
        />
        <defs>
          <linearGradient id="gradient1" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stop-color="#F4ECD8" />
            <stop offset="50%" stop-color="#D4A055" />
            <stop offset="100%" stop-color="#C2885C" />
          </linearGradient>
        </defs>
      </svg>
      <span class="brand-name">EDU-3D</span>
    </div>

    <button
      id="themeToggle"
      class="theme-toggle"
      data-magnetic
      data-parallax="6"
      aria-label="Toggle theme"
      onclick={toggleTheme}
    >
      <svg
        class="sun-icon"
        width="18"
        height="18"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        aria-hidden="true"
      >
        <circle cx="12" cy="12" r="5" />
        <line x1="12" y1="1" x2="12" y2="3" />
        <line x1="12" y1="21" x2="12" y2="23" />
        <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
        <line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
        <line x1="1" y1="12" x2="3" y2="12" />
        <line x1="21" y1="12" x2="23" y2="12" />
        <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
        <line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
      </svg>
      <svg
        class="moon-icon"
        width="18"
        height="18"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        aria-hidden="true"
      >
        <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
      </svg>
    </button>
  </header>

  <main class="hero-section">
    <div class="hero-center">
      <p class="hero-eyebrow" data-parallax="8">AI-powered interactive learning</p>

      <h1 class="hero-title" data-parallax="14">
        <!--
          The full headline is always in the DOM; the animation only reveals it. Mutating the text
          node one character at a time made the page's only <h1> announce as "Lear", "Learnin",
          "Learnin…" to a screen reader for the length of the animation — an unstable accessible
          name on the single most important element on the page. A visually-hidden copy carries the
          meaning; the animated span is decoration.

          The caret is a drawn bar, not a "|" character — see `.cursor-blink` for why. It stays in
          the flow deliberately: that is the only way it follows the text as it types.
        -->
        <span class="hero-line">
          <span class="sr-only">{HEADLINE_TEXT}</span>
          <span aria-hidden="true">
            <span class="gradient-text typing-animation">{typed}</span><span class="cursor-blink"
            ></span>
          </span>
        </span>
        <span class="hero-subtitle fade-in-delayed">in Interactive 3D</span>
      </h1>

      <p class="hero-description fade-in-delayed-2" data-parallax="10">
        Transform any concept into an immersive 3D experience. Interactive models, guided tours, and
        intelligent assessments — generated in seconds.
      </p>

      <div class="prompt-card glass-card has-sheen has-glow-border" data-magnetic data-parallax="7">
        <!--
          The chips below demonstrate the range, so the placeholder's only job is to show the *shape*
          of a good input: a natural-language question, not a title. The previous 89-character
          placeholder wrapped to a third line in this two-row textarea and was clipped mid-word on a
          390px phone, directly above the fold.
        -->
        <label for="topicInput" class="sr-only">Enter a learning topic</label>
        <textarea
          id="topicInput"
          class="prompt-input"
          placeholder="e.g. How does a steam engine work?"
          rows="2"
          maxlength="500"
          bind:value={topic}
          onkeydown={(event) => {
            if (event.key !== 'Enter') return;
            // Enter submits, Shift+Enter inserts a newline — the first thing anyone tries.
            if (event.shiftKey) return;
            event.preventDefault();
            handleGenerate();
          }}></textarea>
        <div class="input-footer">
          <div class="input-meta">
            <!--
              How thorough, in the same row as the thing it applies to — and in the footer where the
              gesture hint used to be, so the card reads input → choice → action with no spare row.

              A native <select>, deliberately. A custom popover would mean re-implementing focus
              trapping, arrow-key navigation, Escape, aria-activedescendant and the type-ahead a
              screen reader expects — a listbox is a solved problem the platform already ships in
              better form, and the browser's version opens the list of four on press and works on
              touch, keyboard and assistive tech with no code of ours to get wrong.

              The numbers in each option come from COMPLEXITY_LEVELS in contracts — the same table
              the generation prompt derives its targets from — so this control cannot promise "60–150
              parts" while the model is asked for something else.
            -->
            <div class="depth-control">
              <label class="depth-label" for="depthSelect">Detail</label>
              <div class="depth-select-wrap">
                <select
                  id="depthSelect"
                  class="depth-select"
                  bind:value={complexity}
                  aria-describedby="depthBlurb"
                >
                  {#each COMPLEXITY_LEVELS as option (option.id)}
                    <option value={option.id}>
                      {option.label} — {option.parts[0]}–{option.parts[1]} parts
                    </option>
                  {/each}
                </select>
                <svg
                  class="depth-chevron"
                  width="12"
                  height="12"
                  viewBox="0 0 12 12"
                  aria-hidden="true"
                >
                  <path
                    d="M2.5 4.5L6 8l3.5-3.5"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="1.5"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  />
                </svg>
              </div>
            </div>
            <div
              class="input-counter"
              class:warning={updateCounter().warning}
              class:error={updateCounter().error}
              aria-live="polite"
            >
              {topic.length} / 500
            </div>
          </div>
          <button
            id="generateBtn"
            class="generate-btn"
            class:loading={submitting}
            aria-label="Generate 3D model"
            onclick={handleGenerate}
            disabled={submitting}
          >
            <span class="btn-text">{submitting ? 'Generating' : 'Generate 3D Model'}</span>
            <svg
              class="btn-icon"
              width="18"
              height="18"
              viewBox="0 0 20 20"
              fill="currentColor"
              aria-hidden="true"
            >
              <path d="M10 3L18 10L10 17V12H2V8H10V3Z" />
            </svg>
          </button>
        </div>
      </div>

      <!--
        What the chosen level costs, stated before the learner waits rather than discovered as a
        stutter afterwards. `08` requires the honest answer: a Maximum model is a ~2M-triangle
        scene, and on a budget phone it will step quality down visibly. Saying so up front is the
        difference between a tradeoff and a betrayal.

        aria-live so changing the select announces the new cost, not just the new label.
      -->
      <p
        id="depthBlurb"
        class="depth-blurb"
        class:is-heavy={complexity === 'maximum'}
        aria-live="polite"
      >
        {level.blurb}
        <span class="depth-cost"
          >{level.parts[0]}–{level.parts[1]} parts · {level.triangles} triangles</span
        >
      </p>

      <!--
        Three chips, and they stay exactly as they are. Breadth would read better on paper, but the
        measured build rate is 62%, so a proven topic is worth more than a wider spread of
        unproven ones — a chip that generates a failure is worse copy than a narrow chip.
      -->
      <div class="suggestion-chips">
        <span class="suggestions-label">Quick Start</span>
        <div class="suggestion-list">
          {#each QUICK_STARTS as chip (chip.label)}
            <button
              class="suggestion-chip"
              data-topic={chip.topic}
              onclick={(event) => {
                topic = chip.topic;
                document.getElementById('topicInput')?.focus();
                if (!window.matchMedia('(pointer: coarse)').matches)
                  createRipple(event.currentTarget, event);
              }}
            >
              {chip.label}
            </button>
          {/each}
        </div>
      </div>

      <!--
        The highest-returning line on the page. A learner who does not know what to type, or who
        does not want to wait four minutes to find out what this is, has exactly one question left
        — "show me". The reference turbofan needs no API key, no database and no login, so the demo
        is not a compromise; it is the product running for real.

        It sits below the quick-start chips, not inside the prompt card: the chips exist to fill the
        input, so anything wedged between the field and its chips breaks that pair, and a second
        control in the input footer crowds out Generate. Here it is still above the fold and still
        a peer of the card in width — an escape hatch, not a second primary button.

        The note names what you will actually see. The reassurance it replaced ("no sign-up, nothing
        to install") was reassurance nobody asked for — the absence of a signup form is not a feature
        a visitor is missing.
      -->
      <a class="demo-link" href={resolve('/viewer')}>
        <svg
          class="demo-icon"
          width="16"
          height="16"
          viewBox="0 0 20 20"
          fill="currentColor"
          aria-hidden="true"
        >
          <path
            d="M6.5 4.5l8 5.5-8 5.5v-11zM4 3.5a1 1 0 00-1 1v11a1 1 0 001.5.87L15 11.87a1 1 0 000-1.74L4.5 3.63A1 1 0 004 3.5z"
          />
        </svg>
        <span>See a live demo</span>
        <span class="demo-note">try a cutaway jet engine</span>
      </a>
    </div>
  </main>

  <footer class="landing-footer">
    <p>EDU-3D &mdash; Learn anything, in 3D</p>
  </footer>
</div>

<canvas bind:this={bgCanvas} id="bgCanvas3d" class="bg-canvas-3d" aria-hidden="true"></canvas>

<style>
  /* V1's landing.css is imported globally below; the only scoped addition is the fade-out class,
     which is new-app behavior (V1 navigated between flat pages with the same fade). */
  .landing-container {
    transition:
      opacity 0.5s ease-out,
      transform 0.5s ease-out;
  }

  .landing-container.is-leaving {
    opacity: 0;
    transform: scale(0.99);
    pointer-events: none;
  }
</style>
