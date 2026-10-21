/**
 * Quiz validation: the answer key must survive validation exactly.
 *
 * `05-CONTENT.md` names the canonical failure this validator exists to prevent: "every answer
 * was wrong, including the right one." The old implementation could CAUSE that failure:
 * it validated `correctIndex` against the full options list, then emitted
 * `options.slice(0, 6)` with `correctIndex: Math.min(correctIndex, 5)` — silently re-pointing
 * the key — and filtered empty options *before* indexing, shifting every later index. A
 * missing key became "option A" via `Number(null) === 0`.
 *
 * The rule pinned here: reject rather than repair — a question whose key cannot be preserved
 * exactly is dropped and counted.
 */
import { describe, expect, it } from 'vitest';
import { QuizQuestion } from '@edu3d/contracts';
import { isValidQuizQuestion, validateQuizQuestions } from '../src/services/quiz.ts';

const quiz = (entry: unknown) => JSON.stringify([entry]);

describe('the emitted answer key must be the authored one', () => {
  it('drops a 7-option question whose correct answer would be cut by the 6-option cap', () => {
    const { questions, dropped } = validateQuizQuestions(
      quiz({
        question: 'Q?',
        options: ['A', 'B', 'C', 'D', 'E', 'F', 'G(the right one)'],
        correctIndex: 6,
      }),
    );
    expect(questions, 'the key cannot survive the emission cap — drop, never re-point').toEqual([]);
    expect(dropped).toBe(1);
  });

  it('keeps a 7-option question whose correct answer is inside the emitted 6', () => {
    const { questions, dropped } = validateQuizQuestions(
      quiz({
        question: 'Q?',
        options: ['A', 'right one', 'C', 'D', 'E', 'F', 'G(spare)'],
        correctIndex: 1,
      }),
    );
    expect(dropped).toBe(0);
    expect(questions).toHaveLength(1);
    expect(questions[0]?.options).toHaveLength(6);
    expect(questions[0]?.options[questions[0]?.correctIndex ?? -1]).toBe('right one');
  });

  it('does not shift indices around empty options — filters only as a final, key-preserving check', () => {
    const { questions, dropped } = validateQuizQuestions(
      quiz({
        question: 'Q?',
        options: ['', 'B', 'C(right)', 'D'],
        correctIndex: 2,
      }),
    );
    // Filtering the empty first option shifts every subsequent index: the key WAS option 2 in
    // the authored list, which becomes option 1 after filtering — cannot be preserved exactly.
    expect(questions).toEqual([]);
    expect(dropped).toBe(1);
  });

  it('treats a missing/null answer key as a dropped question, never "option A"', () => {
    for (const correctIndex of [undefined, null]) {
      const { questions, dropped } = validateQuizQuestions(
        quiz({
          question: 'Q?',
          options: ['A', 'B'],
          correctIndex,
        }),
      );
      expect(questions).toEqual([]);
      expect(dropped).toBe(1);
    }
  });

  it('string digits are still coerced ("2" means option C), other junk is dropped', () => {
    const good = validateQuizQuestions(
      quiz({ question: 'Q?', options: ['A', 'B', 'C'], correctIndex: '2' }),
    );
    expect(good.questions).toHaveLength(1);
    expect(good.questions[0]?.options[good.questions[0]?.correctIndex ?? -1]).toBe('C');

    const bad = validateQuizQuestions(
      quiz({ question: 'Q?', options: ['A', 'B', 'C'], correctIndex: 'C' }),
    );
    expect(bad.questions).toEqual([]);
    expect(bad.dropped).toBe(1);
  });

  it('drops a question whose non-string or empty options make the key ambiguous', () => {
    const { questions, dropped } = validateQuizQuestions(
      quiz({
        question: 'Q?',
        options: ['A', 42, 'C', null],
        correctIndex: 0,
      }),
    );
    expect(questions).toEqual([]);
    expect(dropped).toBe(1);
  });

  it('valid questions survive and satisfy the contract shape', () => {
    const { questions } = validateQuizQuestions(
      quiz({
        question: 'Why does the fan spool up?',
        options: [
          'Because of fuel',
          'Because of the parameter',
          'Because of magic',
          'Because of gravity',
        ],
        correctIndex: 1,
      }),
    );
    expect(questions).toHaveLength(1);
    const parsed = QuizQuestion.safeParse(questions[0]);
    expect(parsed.success).toBe(true);
  });

  it('isValidQuizQuestion mirrors the drop rule for single entries', () => {
    expect(
      isValidQuizQuestion({
        question: 'Q?',
        options: ['A', 'B', 'C', 'D', 'E', 'F', 'G'],
        correctIndex: 6,
      }),
    ).toBe(false);
    expect(isValidQuizQuestion({ question: 'Q?', options: ['A', 'B'], correctIndex: 1 })).toBe(
      true,
    );
  });
});
