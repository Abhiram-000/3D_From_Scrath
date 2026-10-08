/**
 * The bounded model summary the conversational modes share.
 *
 * Mirrors the server's extraction so the client can seed suggestion chips and build the request
 * context without a round trip — one shape, defined once on each side of the wire from the same
 * schema (`05`'s context discipline applies on both ends).
 */
import type { ModelContext, ModelManifest } from '@edu3d/contracts';

export function toContext(manifest: ModelManifest, selectedPartId?: string | null): ModelContext {
  const namedParts = manifest.parts.filter((part) => part.kind !== 'group');
  const shown = namedParts.slice(0, 40);

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
    ...(selectedPartId ? { selectedPartId } : {}),
  };
}
