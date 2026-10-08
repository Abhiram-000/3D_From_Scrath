/**
 * Quiz validation: the rule that makes authored-first safe, applied to generated output too.
 *
 * `05` names the canonical failure this exists to prevent: "every answer was wrong, including the
 * right one". A question with no options, fewer than two, or an out-of-range correct index is
 * *dropped*, not rendered — and the dropped count is reported so the caller can say so honestly.
 */
import type { QuizQuestion } from '@edu3d/contracts';

export interface QuizValidation {
  questions: QuizQuestion[];
  dropped: number;
}

/** Pull a JSON array out of a reply that may have wrapped it in prose or a fence. */
function extractJson(raw: string): unknown {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate: string = fenced?.[1] ?? raw;
  const start = candidate.indexOf('[');
  const end = candidate.lastIndexOf(']');
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return null;
  }
}

export function validateQuizQuestions(raw: string): QuizValidation {
  const parsed = extractJson(raw);
  if (!Array.isArray(parsed)) return { questions: [], dropped: 0 };

  const questions: QuizQuestion[] = [];
  let dropped = 0;

  for (const entry of parsed) {
    if (!entry || typeof entry !== 'object') { dropped += 1; continue; }
    const record = entry as Record<string, unknown>;
    const options = Array.isArray(record.options)
      ? record.options.filter((option): option is string => typeof option === 'string' && option.length > 0)
      : [];
    const correctIndex = Number(record.correctIndex);

    if (
      typeof record.question !== 'string' ||
      options.length < 2 ||
      !Number.isInteger(correctIndex) ||
      correctIndex < 0 ||
      correctIndex >= options.length
    ) {
      dropped += 1;
      continue;
    }

    questions.push({
      // Deterministic ids: the client keys React/Svelte lists on them.
      id: `q${questions.length}`,
      question: record.question.slice(0, 400),
      options: options.slice(0, 6).map((option) => option.slice(0, 200)),
      correctIndex: Math.min(correctIndex, 5),
      explanation: String(record.explanation ?? 'See the model: the answer is visible on screen.').slice(0, 800),
      difficulty: 'application',
    });
  }

  return { questions, dropped };
}
