/**
 * Bounded model-context extraction for the conversational modes.
 *
 * `05` sets the discipline: "Sending the entire model JSON burns tokens, dilutes the model's attention,
 * and leaks implementation detail into prose. Extract what a teacher would glance at, not everything
 * that exists." This is the one place that reduction happens, so chat and quiz share it exactly.
 */
import type { ModelContext, ModelManifest } from '@edu3d/contracts';

/** Depth/count caps from `05`: "…and 23 more" beats a wall of 60 names that dilutes the answer. */
const MAX_PARTS = 40;

export function extractModelContext(manifest: ModelManifest): string {
  const context = toContext(manifest);
  return JSON.stringify(context);
}

/** Build the wire's `ModelContext` from a manifest, applying every cap the schema declares. */
export function toContext(manifest: ModelManifest): ModelContext {
  const namedParts = manifest.parts.filter((part) => part.kind !== 'group');
  const shown = namedParts.slice(0, MAX_PARTS);

  return {
    name: manifest.name,
    description: manifest.description.slice(0, 1200),
    domain: manifest.domain,
    concept: manifest.pedagogy.concept,
    objectives: manifest.pedagogy.objectives.slice(0, 8),
    parts: shown.map((part) => ({
      id: part.id,
      name: part.name,
      ...(part.info?.summary ? { summary: part.info.summary.slice(0, 240) } : {}),
    })),
    partsOmitted: Math.max(0, namedParts.length - shown.length),
    parameters: manifest.parameters.slice(0, 24).map((parameter) => ({
      id: parameter.id,
      label: parameter.label,
      ...(parameter.unit ? { unit: parameter.unit } : {}),
      ...(parameter.kind === 'number' ? { min: parameter.min, max: parameter.max } : {}),
    })),
  };
}
