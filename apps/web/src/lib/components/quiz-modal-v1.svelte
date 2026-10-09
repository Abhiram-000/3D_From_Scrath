<!--
  Quiz mode — V1's exact modal markup and behavior.

  Structure from index.html's #quizModal: header with score, .quiz-question-area with .quiz-counter,
  .quiz-options as a one-column grid of .quiz-option buttons (marker circle + label), .quiz-status
  feedback area, footer with score + Next. Styling comes verbatim from viewer.css's quiz block.

  `05` rules: authored-first is the caller's job; options lock on answer with correct/wrong marks;
  the explanation shows while the answer is visible; score counts once per question.
-->
<script lang="ts">
  import type { QuizQuestion } from '@edu3d/contracts';

  const {
    questions,
    onclose,
    source = 'authored',
  }: { questions: QuizQuestion[]; onclose: () => void; source?: 'authored' | 'generated' } = $props();

  const LETTERS = ['A', 'B', 'C', 'D', 'E', 'F'] as const;

  let current = $state(0);
  let answered = $state<Record<string, number>>({});
  let score = $state(0);
  let finished = $state(false);

  const question = $derived(questions[current] as QuizQuestion | undefined);

  function answer(index: number) {
    if (!question || answered[question.id] !== undefined) return;
    answered = { ...answered, [question.id]: index };
    if (index === question.correctIndex) score += 1;
  }

  function next() {
    if (current < questions.length - 1) current += 1;
    else finished = true;
  }

  function restart() {
    current = 0;
    answered = {};
    score = 0;
    finished = false;
  }

  function grade(percentage: number): string {
    if (percentage >= 85) return 'Excellent!';
    if (percentage >= 65) return 'Good work!';
    return 'Worth another look';
  }
</script>

<div class="modal-container quiz-modal glass-panel">
  <div class="modal-header">
    <h2>Quiz Mode</h2>
    <span class="quiz-source-badge" title={source === 'authored' ? 'Written for this exact model' : 'Generated for this model'}>
      {source === 'authored' ? 'authored' : 'generated'}
    </span>
    <button class="modal-close-btn" onclick={onclose} aria-label="Close quiz">×</button>
  </div>

  {#if !finished && question}
    <div class="modal-body">
      <div class="quiz-simple-container">
        <div class="quiz-question-area">
          <span class="quiz-counter">Q{current + 1}/{questions.length}</span>
          <h3>{question.question}</h3>
        </div>

        <div class="quiz-options" role="group" aria-label="Answer choices">
          {#each question.options as option, index (index)}
            <button
              class="quiz-option"
              class:is-correct={answered[question.id] !== undefined && index === question.correctIndex}
              class:is-wrong={answered[question.id] === index && index !== question.correctIndex}
              class:is-selected={answered[question.id] === index}
              onclick={() => answer(index)}
              disabled={answered[question.id] !== undefined}
            >
              <span class="quiz-option-marker">{LETTERS[index]}</span>
              <span class="quiz-option-label">{option}</span>
            </button>
          {/each}
        </div>

        {#if answered[question.id] !== undefined}
          <div class="quiz-status visible" class:correct={answered[question.id] === question.correctIndex} class:wrong={answered[question.id] !== question.correctIndex}>
            <div class="feedback-title">
              {answered[question.id] === question.correctIndex ? '✓ Correct!' : '✗ Not quite.'}
            </div>
            <p>{question.explanation}</p>
          </div>
        {/if}
      </div>
    </div>

    <div class="modal-footer" style="display:flex; justify-content:space-between; align-items:center; padding: 0 24px 20px;">
      <span class="quiz-score">Score: {score}</span>
      <button class="modal-btn" onclick={next} disabled={question ? answered[question.id] === undefined : true}>
        {current === questions.length - 1 ? 'Finish' : 'Next'}
      </button>
    </div>
  {:else}
    <div class="modal-body" style="text-align:center; padding: 40px 24px;">
      <p class="results-percentage">{Math.round((score / questions.length) * 100)}%</p>
      <p class="results-grade">{grade((score / questions.length) * 100)}</p>
      <p class="results-line">{score} of {questions.length} correct</p>
      <p class="results-guidance">Try changing the parameters to see the same principles in motion.</p>
      <div class="results-actions" style="display:flex; gap:12px; justify-content:center; margin-top:20px;">
        <button class="modal-btn" onclick={restart}>Try again</button>
        <button class="modal-btn" onclick={onclose}>Back to the model</button>
      </div>
    </div>
  {/if}
</div>
