<!--
  Story mode (`05`): the cinematic guided tour.

  Each beat drives the camera to its target (through the host's focusPart), may set parameters so the
  phenomenon demonstrates itself, and narrates through the subtitle overlay. The story never traps:
  prev/next/cancel are always one click, auto-advance uses reading time, and voice narration — when
  enabled — advances *on error too*, because "a synthesis error must never strand the story on the
  current beat". A beat whose target part vanished skips its camera move and still narrates.
-->
<script lang="ts">
  import type { StoryBeat } from '@edu3d/contracts';

  const {
    story,
    onsetParameter,
    onfocus,
    onclose,
  }: {
    story: StoryBeat[];
    /** The one owner of parameter writes — beats flow through the same history as manual changes (`05`). */
    onsetParameter: (id: string, value: number | boolean | string) => void;
    onfocus: (partId: string | null) => void;
    onclose: () => void;
  } = $props();

  let index = $state(0);
  const beat = $derived(story[index]);
  const HOLD_SECONDS = 6;
  let advanceTimer: ReturnType<typeof setTimeout> | null = null;

  /** Voice narration: optional, and never able to strand the story (`05`). */
  const speech: SpeechSynthesis | null =
    typeof speechSynthesis !== 'undefined' ? speechSynthesis : null;

  $effect(() => {
    void index; // re-run the effect whenever the beat index moves
    play();
    return () => stop();
  });

  function stop() {
    if (advanceTimer) clearTimeout(advanceTimer);
    advanceTimer = null;
    speech?.cancel();
  }

  function play() {
    if (!beat) return;
    // The camera follows the story; a dangling target skips the move, not the narration (`05`).
    onfocus(beat.targetPartId ?? null);
    if (beat.setParameters) {
      for (const [id, value] of Object.entries(beat.setParameters)) onsetParameter(id, value);
    }
    narrate(`${beat.title}. ${beat.narration}`);
    // Auto-advance with reading time; shorter after narration ends.
    const hold = (beat.holdSeconds ?? HOLD_SECONDS) * 1000;
    advanceTimer = setTimeout(() => (index < story.length - 1 ? (index += 1) : onclose()), hold);
  }

  function narrate(text: string) {
    if (!speech) return;
    try {
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.rate = 1;
      utterance.onend = () => {
        // Narration done: advance sooner than the reading-time fallback.
        if (advanceTimer) clearTimeout(advanceTimer);
        advanceTimer = setTimeout(() => (index < story.length - 1 ? (index += 1) : onclose()), 700);
      };
      utterance.onerror = () => {
        /* advance on error, never stall — the reading-time timer still runs */
      };
      speech.speak(utterance);
    } catch {
      /* synthesis unavailable: reading-time auto-advance covers it */
    }
  }

  function go(delta: number) {
    stop();
    const next = index + delta;
    if (next < 0 || next >= story.length) {
      onclose();
      return;
    }
    index = next;
  }
</script>

<svelte:window onkeydown={(event) => event.key === 'Escape' && onclose()} />

<div class="story-overlay" role="dialog" aria-label="Story mode">
  <div class="subtitle glass">
    <div class="subtitle-head">
      <span class="counter">{index + 1} / {story.length}</span>
      <h3>{beat?.title}</h3>
    </div>
    <p class="narration">{beat?.narration}</p>
    <div class="controls">
      <button class="nav" onclick={() => go(-1)} disabled={index === 0}>Previous</button>
      <button class="nav" onclick={onclose}>Cancel</button>
      <button class="nav primary" onclick={() => go(1)}>
        {index === story.length - 1 ? 'Finish' : 'Next'}
      </button>
    </div>
    <!-- The progress of the story itself: which beat, of how many. -->
    <div class="progress" aria-hidden="true">
      {#each story as _, i (i)}
        <span class="dot" class:done={i <= index}></span>
      {/each}
    </div>
  </div>
</div>

<style>
  .story-overlay {
    position: absolute;
    inset: 0;
    display: grid;
    align-items: end;
    justify-items: center;
    padding: var(--space-5);
    pointer-events: none;
    z-index: var(--z-overlay);
  }

  .subtitle {
    pointer-events: auto;
    width: min(38rem, 100%);
    padding: var(--space-4) var(--space-5);
    display: grid;
    gap: var(--space-2);
    animation: rise-in 0.4s var(--ease-out);
  }

  @keyframes rise-in {
    from {
      opacity: 0;
      transform: translateY(12px);
    }
  }

  .subtitle-head {
    display: flex;
    align-items: baseline;
    gap: var(--space-3);
  }

  .counter {
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    color: var(--accent);
    background: var(--accent-soft);
    padding: 0.125rem 0.5rem;
    border-radius: var(--radius-full);
  }

  .subtitle h3 {
    font-size: var(--text-base);
  }

  .narration {
    font-size: var(--text-sm);
    color: var(--text-muted);
    line-height: 1.55;
    max-height: 9.5rem;
    overflow-y: auto;
  }

  .controls {
    display: flex;
    gap: var(--space-2);
    justify-content: flex-end;
  }

  .nav {
    padding: 0.4375rem 0.875rem;
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-sm);
    font-size: var(--text-xs);
    font-weight: 600;
    color: var(--text-muted);
  }

  .nav:hover:not(:disabled) {
    color: var(--text);
    border-color: var(--accent-ring);
  }

  .nav:disabled {
    opacity: 0.4;
  }

  .nav.primary {
    background: var(--gradient-accent);
    border: none;
    color: var(--accent-contrast);
  }

  .progress {
    display: flex;
    gap: 6px;
    justify-content: center;
    padding-top: var(--space-1);
  }

  .dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--border-strong);
    transition: background var(--duration-base) ease;
  }

  .dot.done {
    background: var(--accent);
  }
</style>
