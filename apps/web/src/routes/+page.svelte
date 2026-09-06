<!--
  Placeholder landing page.

  The real landing experience (typed headline, wireframe backdrop, cursor system, prompt card) is P9 in
  `PLAN.md`. This exists now so the route graph, theme-before-paint script and token sheet are provably
  wired end to end from the first phase, rather than being verified for the first time much later.
-->
<script lang="ts">
  import { onMount } from 'svelte';

  let theme = $state<'dark' | 'light'>('dark');

  onMount(() => {
    theme = (document.documentElement.dataset.theme as 'dark' | 'light') ?? 'dark';
  });

  function toggleTheme() {
    theme = theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
    try {
      localStorage.setItem('edu3d.theme', theme);
    } catch {
      // Private browsing: the choice applies for this session and simply is not remembered.
    }
  }
</script>

<svelte:head>
  <title>EDU-3D — interactive 3D lessons from any topic</title>
</svelte:head>

<main>
  <p class="eyebrow">AI-powered interactive learning</p>
  <h1 class="gradient-text">Any topic, in three dimensions.</h1>
  <p class="lede">
    Type a concept. An AI writes the program that builds it — explorable, adjustable, and physically
    honest.
  </p>

  <section class="glass card">
    <p class="status">
      Foundation phase: contracts and tooling are wired. The prompt card lands in P9.
    </p>
    <button class="ghost" onclick={toggleTheme}>
      Switch to {theme === 'dark' ? 'light' : 'dark'} theme
    </button>
  </section>
</main>

<style>
  main {
    min-height: 100vh;
    min-height: 100dvh;
    display: grid;
    align-content: center;
    justify-items: start;
    gap: var(--space-4);
    padding: var(--space-7) var(--space-5);
    max-width: 60rem;
    margin: 0 auto;
  }

  .eyebrow {
    font-size: var(--text-sm);
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--text-subtle);
  }

  h1 {
    font-size: var(--text-hero);
  }

  .lede {
    font-size: var(--text-lg);
    color: var(--text-muted);
    max-width: 42rem;
  }

  .card {
    margin-top: var(--space-4);
    padding: var(--space-5);
    display: grid;
    gap: var(--space-4);
    justify-items: start;
  }

  .status {
    color: var(--text-muted);
    font-size: var(--text-sm);
  }

  .ghost {
    padding: var(--space-2) var(--space-4);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-full);
    background: var(--surface);
    color: var(--text);
    transition:
      background-color var(--duration-fast) var(--ease-out),
      border-color var(--duration-fast) var(--ease-out);
    min-height: var(--touch-target);
  }

  .ghost:hover {
    background: var(--surface-hover);
    border-color: var(--accent-ring);
  }
</style>
