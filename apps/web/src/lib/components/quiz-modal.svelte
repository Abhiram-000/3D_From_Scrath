<!--
  Quiz mode (`05`): authored-first, lock-and-mark, single scoring, guidance back into the model.

  The authored-first rule is enforced by the caller — this component receives questions that already
  went through validation-before-use (unusable ones dropped at the API surface). What it owns:
   - options labeled A/B/C/D so a question can be discussed out loud;
   - on answer: everything locks, the correct option marks, the wrong pick marks differently, and the
     explanation shows *while the answer is still visible*;
   - score counted once per question — re-clicking a locked question cannot inflate it;
   - a results screen whose ending is a doorway back into exploration, not a dead end.
-->
<script lang="ts">
  import type { QuizQuestion } from '@edu3d/contracts';

  const {
    questions,
    onclose,
    source = 'authored',
  }: {
    questions: QuizQuestion[];
    onclose: () => void;
    source?: 'authored' | 'generated';
  } = $props();

  const LETTERS = ['A', 'B', 'C', 'D', 'E', 'F'] as const;

  let answered = $state<Record<string, number>>({});
  let score = $state(0);
  let finished = $state(false);

  function answer(question: QuizQuestion, index: number) {
    // Locked questions stay locked: one score event per question (`05`).
    if (answered[question.id] !== undefined) return;
    answered = { ...answered, [question.id]: index };
    if (index === question.correctIndex) score += 1;
    if (Object.keys(answered).length >= questions.length) finished = true;
  }

  function grade(percentage: number): string {
    if (percentage >= 85) return 'Excellent';
    if (percentage >= 65) return 'Good work';
    return 'Worth another look';
  }
</script>

<div class="backdrop" role="presentation" onclick={onclose}>
  <section
    class="modal glass"
    role="dialog"
    aria-modal="true"
    aria-label="Quiz"
    onclick={(event) => event.stopPropagation()}
    onkeydown={(event) => {
      if (event.key === 'Escape') onclose();
    }}
  >
    <header class="head">
      <h2>
        Quiz — {questions.length} question{questions.length === 1 ? '' : 's'}
        <span
          class="source"
          title={source === 'authored'
            ? 'Written for this exact model'
            : 'Generated for this model'}
        >
          {source === 'authored' ? 'authored' : 'generated'}
        </span>
      </h2>
      <button class="close" onclick={onclose} aria-label="Close quiz">✕</button>
    </header>

    {#if !finished}
      <div class="list">
        {#each questions as question, qIndex (question.id)}
          <article class="question" class:locked={answered[question.id] !== undefined}>
            <h3>{qIndex + 1}. {question.question}</h3>
            <div class="options">
              {#each question.options as option, index (index)}
                <button
                  class="option"
                  class:correct={answered[question.id] !== undefined &&
                    index === question.correctIndex}
                  class:wrong={answered[question.id] === index && index !== question.correctIndex}
                  onclick={() => answer(question, index)}
                  disabled={answered[question.id] !== undefined}
                >
                  <span class="letter">{LETTERS[index]}</span>
                  <span>{option}</span>
                </button>
              {/each}
            </div>
            {#if answered[question.id] !== undefined}
              <p class="explanation">{question.explanation}</p>
            {/if}
          </article>
        {/each}
      </div>
    {:else}
      <div class="results">
        <p class="percentage">{Math.round((score / questions.length) * 100)}%</p>
        <p class="grade">{grade((score / questions.length) * 100)}</p>
        <p class="score-line">{score} of {questions.length} correct</p>
        <p class="guidance">Try changing the parameters to see the same principles in motion.</p>
        <div class="result-actions">
          <button
            class="primary"
            onclick={() => {
              answered = {};
              score = 0;
              finished = false;
            }}>Try again</button
          >
          <button class="secondary" onclick={onclose}>Back to the model</button>
        </div>
      </div>
    {/if}
  </section>
</div>

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    display: grid;
    place-items: center;
    padding: var(--space-4);
    background: rgb(0 0 0 / 55%);
    z-index: var(--z-modal);
    animation: fade-in 0.25s ease;
  }

  @keyframes fade-in {
    from {
      opacity: 0;
    }
  }

  .modal {
    width: min(40rem, 100%);
    max-height: min(42rem, 90vh);
    overflow-y: auto;
    padding: var(--space-5);
    animation: rise 0.3s var(--ease-out);
  }

  @keyframes rise {
    from {
      transform: translateY(14px);
      opacity: 0;
    }
  }

  .head {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: var(--space-4);
  }

  .source {
    font-size: 0.625rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--accent);
    background: var(--accent-soft);
    padding: 0.125rem 0.5rem;
    border-radius: var(--radius-full);
    margin-left: var(--space-2);
    vertical-align: middle;
  }

  .close {
    width: 32px;
    height: 32px;
    border-radius: var(--radius-full);
    color: var(--text-muted);
  }

  .close:hover {
    background: var(--surface-hover);
  }

  .question {
    padding: var(--space-4) 0;
    border-bottom: 1px solid var(--border);
  }

  .question h3 {
    font-size: var(--text-sm);
    font-weight: 600;
    margin-bottom: var(--space-3);
    line-height: 1.4;
  }

  .options {
    display: grid;
    gap: var(--space-2);
  }

  .option {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    width: 100%;
    text-align: left;
    padding: var(--space-2) var(--space-3);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    font-size: var(--text-sm);
    color: var(--text-muted);
    transition:
      border-color var(--duration-fast) ease,
      color var(--duration-fast) ease;
  }

  .option:hover:not(:disabled) {
    border-color: var(--accent-ring);
    color: var(--text);
  }

  .option:disabled {
    cursor: default;
  }

  .letter {
    flex-shrink: 0;
    width: 22px;
    height: 22px;
    display: grid;
    place-items: center;
    border-radius: var(--radius-sm);
    border: 1px solid var(--border-strong);
    font-family: var(--font-mono);
    font-size: 0.6875rem;
  }

  .option.correct {
    border-color: var(--status-ok);
    color: var(--text);
    background: rgb(123 168 136 / 12%);
  }

  .option.correct .letter {
    border-color: var(--status-ok);
    color: var(--status-ok);
  }

  .option.wrong {
    border-color: var(--status-error);
    background: rgb(199 106 106 / 10%);
  }

  .option.wrong .letter {
    border-color: var(--status-error);
    color: var(--status-error);
  }

  .explanation {
    margin-top: var(--space-3);
    padding: var(--space-3);
    border-left: 2px solid var(--accent);
    background: var(--surface);
    border-radius: 0 var(--radius-sm) var(--radius-sm) 0;
    font-size: var(--text-sm);
    color: var(--text-muted);
    line-height: 1.5;
  }

  .results {
    text-align: center;
    padding: var(--space-6) 0;
    display: grid;
    gap: var(--space-2);
    justify-items: center;
  }

  .percentage {
    font-family: var(--font-display);
    font-size: 3rem;
    font-weight: 800;
    background: var(--gradient-accent);
    -webkit-background-clip: text;
    background-clip: text;
    color: transparent;
  }

  .grade {
    font-size: var(--text-lg);
    font-weight: 700;
  }

  .score-line {
    color: var(--text-muted);
    font-size: var(--text-sm);
  }

  .guidance {
    color: var(--text-subtle);
    font-size: var(--text-sm);
    max-width: 34ch;
  }

  .result-actions {
    display: flex;
    gap: var(--space-3);
    margin-top: var(--space-3);
  }

  .primary {
    padding: 0.625rem 1.25rem;
    border-radius: var(--radius-sm);
    background: var(--gradient-accent);
    color: var(--accent-contrast);
    font-weight: 600;
    font-size: var(--text-sm);
  }

  .secondary {
    padding: 0.625rem 1.25rem;
    border-radius: var(--radius-sm);
    border: 1px solid var(--border-strong);
    color: var(--text-muted);
    font-weight: 600;
    font-size: var(--text-sm);
  }
</style>
