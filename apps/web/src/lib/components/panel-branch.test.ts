/**
 * The right panel's branch condition.
 *
 * The load-bearing case is the first one: a non-null selection must be the gate, not mere
 * hoverability. Before this predicate existed the condition was `{#if selectedPartInfo}`, and because
 * `activePart` resolves against `hoveredPart` as well as `selectedPart`, pointing at the model was
 * enough to flip the panel away from the overview — destroying and rebuilding up to 200 part
 * buttons on every pointer entry and exit.
 */
import { describe, expect, it } from 'vitest';
import { panelShowsSelectedPart } from './panel-branch';

describe('which branch the right panel takes', () => {
  it('stays on the overview while the model is only hovered', () => {
    // The regression, stated as a truth: a hovered part has info, and the panel must not switch.
    expect(panelShowsSelectedPart(null, { title: 'Fan blades' })).toBe(false);
    expect(panelShowsSelectedPart('', { title: 'Fan blades' })).toBe(false);
  });

  it('shows the selected part when one is actually selected', () => {
    expect(panelShowsSelectedPart('fanBlades', { title: 'Fan blades' })).toBe(true);
  });

  it('shows the overview when the selected part has nothing to describe', () => {
    // A selection with no info object must not open an empty panel.
    expect(panelShowsSelectedPart('fanBlades', null)).toBe(false);
    expect(panelShowsSelectedPart('fanBlades', undefined)).toBe(false);
  });
});
