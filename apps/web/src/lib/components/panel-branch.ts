/**
 * Whether the right panel is showing a selected part, or the model overview.
 *
 * This is a pure predicate rather than an inline `{#if}` because the condition is the whole bug.
 *
 * `activePart` resolves against `selectedPart ?? hoveredPart`, so merely pointing at the model made
 * `selectedPartInfo` truthy, which flipped the panel's top-level branch — destroying and rebuilding
 * the overview arm, which holds up to 200 part buttons with their effects and click handlers. That is
 * a multi-millisecond synchronous block on every pointer entry and exit, landing exactly while the
 * pointer crosses the canvas. It also removed the keyboard-reachable part list the moment the pointer
 * touched the model, which is the only way to select a part without a mouse.
 *
 * Hover belongs to the tooltip. Selection belongs to the panel.
 */
export function panelShowsSelectedPart(
  selectedPart: string | null,
  selectedPartInfo: unknown,
): boolean {
  return selectedPart !== null && selectedPart !== '' && Boolean(selectedPartInfo);
}
