/**
 * Quiz validation: the rule that makes authored-first safe, applied to generated output too.
 *
 * `05` names the canonical failure this exists to prevent: "every answer was wrong, including the
 * right one". Its inverse is the trap the OLD validator fell into: it "repaired" a question it
 * could not represent — `options.slice(0, 6)` with `Math.min(correctIndex, 5)`, filtering empty
 * options BEFORE indexing (shifting every later answer), and `Number(null) === 0` turning a
 * missing key into "option A" — silently re-pointing the answer key. That is how a validator
 * CAUSES the failure it was written to catch.
 *
 * The rule here is therefore reject, never repair: a question whose key cannot be preserved
 * EXACTLY is dropped and counted in `dropped`, and what is emitted has the key inside it.
 */
import type { QuizQuestion } from '@edu3d/contracts';

export interface QuizValidation {
  questions: QuizQuestion[];
  dropped: number;
}

/** The emission cap in the contract's `options` — the max a question may present. */
const MAX_OPTIONS = 6;

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

/**
 * Whether ONE entry is renderable without corrupting its answer key. Every rule here is a DROP
 * rule, which makes this the single source of truth: `validateQuizQuestions` and any other
 * consumer (the quiz rejection path) agree by construction.
 *
 * The key rule: `correctIndex` must be an integer inside the EMITTED options — the same list the
 * learner will see (`options.slice(0, MAX_OPTIONS)`) — so a cap-violating key is a drop, not a
 * `Math.min` re-point. `null`/`undefined` are drops with no coercion, but string digits still
 * coerce (`"2"` is a model's common spelling of 2).
 */
export function isValidQuizQuestion(entry: unknown): boolean {
  if (!entry || typeof entry !== 'object') return false;
  const record = entry as Record<string, unknown>;
  if (typeof record.question !== 'string' || record.question.length === 0) return false;

  if (!Array.isArray(record.options)) return false;
  const options = record.options;
  // Nothing may shift the list between validation and emission: a question with an empty or
  // non-string option is ambiguous, so it is dropped rather than filtered (filtering was the
  // index-shifting bug).
  if (options.length < 2) return false;
  if (options.some((option) => typeof option !== 'string' || option.length === 0)) return false;

  const key = record.correctIndex;
  if (key === null || key === undefined) return false;
  const index = typeof key === 'string' && /^\d+$/.test(key) ? Number(key) : key;
  if (typeof index !== 'number' || !Number.isInteger(index)) return false;
  return index >= 0 && index < Math.min(options.length, MAX_OPTIONS);
}

export function validateQuizQuestions(raw: string): QuizValidation {
  const parsed = extractJson(raw);
  if (!Array.isArray(parsed)) return { questions: [], dropped: 0 };

  const questions: QuizQuestion[] = [];
  let dropped = 0;

  for (const entry of parsed) {
    if (!isValidQuizQuestion(entry)) {
      dropped += 1;
      continue;
    }
    const record = entry as Record<string, unknown>;
    const emitted = (record.options as string[]).slice(0, MAX_OPTIONS);
    // Non-negotiable: the emitted key is the authored one — bounded exactly as it was validated.
    const correctIndex = Number(record.correctIndex);

    questions.push({
      // Deterministic ids: the client keys React/Svelte lists on them.
      id: `q${questions.length}`,
      question: String(record.question).slice(0, 400),
      options: emitted.map((option) => option.slice(0, 200)),
      correctIndex,
      explanation: String(
        record.explanation ?? 'See the model: the answer is visible on screen.',
      ).slice(0, 800),
      difficulty: 'application',
    });
  }

  return { questions, dropped };
}
