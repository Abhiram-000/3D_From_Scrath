/**
 * Compositor-cost contract for the stylesheets.
 *
 * The dominant cost in the viewer's orbit interaction was static and detectable in the source: a
 * `filter: blur(60px)` on an 780px layer, animated to a non-integer scale, sitting above an opaque
 * WebGL canvas and re-rasterized every frame for decoration the viewer had explicitly disabled.
 * Chromium reproduces the same shape for `backdrop-filter` over an animating canvas: 60fps down to
 * 10-20, with composite time going from 2-3ms to 30-80ms.
 *
 * This test pins the *mechanism* — an animated large blur, or a backdrop blur on something that
 * covers the canvas — rather than any one selector, so it catches the class rather than the instance.
 *
 * What it cannot do, stated plainly so nobody over-reads a green run: CSS cannot express geometric
 * overlap, and an element can acquire a blur by carrying a shared class. `.toast` and `.tooltip-3d`
 * carry `glass-panel`, and `viewer.css` declares `backdrop-filter: blur(16px)` on `.glass-panel`
 * itself — so no selector-matching rule here can see them. Those are handled where the class is
 * applied, not here. What this catches is the animated-blur case, which is both the largest single
 * cost and exactly expressible.
 */
import { describe, expect, it } from 'vitest';
import {
  CANVAS_OVERLAY_CLASSES,
  KNOWN_OFFENDERS,
  findCompositorOffenders,
  readStylesheets,
} from './check-compositor.mjs';

const sheets = readStylesheets();

describe('the compositor linter', () => {
  it('flags a large blur that is animated forever', () => {
    // The measured shape: a filter on a layer large enough for the blur to cost real time, animated
    // on an infinite cycle. A non-integer scale in the keyframe defeats Chrome's cached filtered
    // texture, so the blur re-rasterizes every frame rather than once.
    const offenders = findCompositorOffenders([
      {
        file: 'synthetic.css',
        text: [
          '.blob {',
          '  width: 780px;',
          '  height: 780px;',
          '  filter: blur(60px);',
          '  animation: drift 32s ease infinite alternate;',
          '}',
        ].join('\n'),
      },
    ]);
    expect(offenders).toHaveLength(1);
    expect(offenders[0]?.property).toBe('filter');
    expect(offenders[0]?.selector).toBe('.blob');
  });

  it('does not flag a blur small enough to be free, even when animated', () => {
    const offenders = findCompositorOffenders([
      {
        file: 'synthetic.css',
        text: '.halo { width: 34px; height: 34px; filter: blur(5px); animation: pulse 2s infinite; }',
      },
    ]);
    expect(offenders).toEqual([]);
  });

  it('does not flag a large blur that never animates', () => {
    // Static filters are rasterised once and cached as a layer texture. The cost is the animation.
    const offenders = findCompositorOffenders([
      { file: 'synthetic.css', text: '.static { filter: blur(60px); }' },
    ]);
    expect(offenders).toEqual([]);
  });

  it('flags a blur declared on a base class when a variant class animates it', () => {
    // The shape that actually shipped, and the reason the naive version of this check missed the
    // single largest compositor cost in the app: the blur is on `.blob`, the animation is on
    // `.blob-a`, and the element carries both classes.
    const offenders = findCompositorOffenders([
      {
        file: 'synthetic.css',
        text: [
          '.blob {',
          '  width: 780px;',
          '  height: 780px;',
          '  filter: blur(60px);',
          '}',
          '.blob-a {',
          '  animation: drift 32s ease infinite alternate;',
          '}',
        ].join('\n'),
      },
    ]);
    expect(offenders).toHaveLength(1);
    expect(offenders[0]?.selector).toBe('.blob');
  });

  it('does not mistake a backdrop-filter for a plain filter', () => {
    // `backdrop-filter:` contains the substring `filter:`, so a rule that reads radii without a
    // lookbehind reports every glass surface in the app as an animated plain filter. `.prompt-card`
    // was that false positive.
    const offenders = findCompositorOffenders([
      {
        file: 'synthetic.css',
        text: '.prompt-card { backdrop-filter: blur(28px) saturate(160%); animation: rise 8s infinite; }',
      },
    ]);
    expect(offenders).toEqual([]);
  });

  it('flags a backdrop blur on a known canvas overlay', () => {
    const offenders = findCompositorOffenders([
      {
        file: 'synthetic.css',
        text: '.modal-overlay { position: fixed; backdrop-filter: blur(5px); }',
      },
    ]);
    expect(offenders).toHaveLength(1);
    expect(offenders[0]?.property).toBe('backdrop-filter');
    expect(offenders[0]?.selector).toBe('.modal-overlay');
  });

  it('ignores an explicit backdrop-filter: none, which is the fix', () => {
    const offenders = findCompositorOffenders([
      { file: 'synthetic.css', text: '.modal-overlay { position: fixed; backdrop-filter: none; }' },
    ]);
    expect(offenders).toEqual([]);
  });

  it('ignores a backdrop blur below the radius floor', () => {
    const offenders = findCompositorOffenders([
      { file: 'synthetic.css', text: '.chip { backdrop-filter: blur(2px); }' },
    ]);
    expect(offenders).toEqual([]);
  });

  it('ignores a static panel that does not cover the canvas', () => {
    // The desktop toolbar and side panels are flex siblings of the viewport and read a static
    // gradient backdrop. Blurring those is fine, and the linter must not make it a debt.
    const offenders = findCompositorOffenders([
      {
        file: 'synthetic.css',
        text: '.left-panel { backdrop-filter: blur(16px); display: flex; }',
      },
    ]);
    expect(offenders).toEqual([]);
  });

  it('has every real offender accounted for, each with a reason and an owner', () => {
    const offenders = findCompositorOffenders(sheets);
    for (const offender of offenders) {
      const reason: string | undefined = (KNOWN_OFFENDERS as Readonly<Record<string, string>>)[
        offender.selector
      ];
      expect(
        reason,
        `unaccounted compositor cost: ${offender.property} ${offender.radius}px on ` +
          `${offender.selector} in ${offender.file}. Either fix it, or add it to KNOWN_OFFENDERS ` +
          `with the reason it is acceptable.`,
      ).toBeTruthy();
    }
  });

  it('names only selectors it can recognise as canvas overlays', () => {
    // A guard on the list itself: adding a class here is a claim that the class covers the canvas,
    // which is not true of every element that could be added by name.
    for (const name of CANVAS_OVERLAY_CLASSES) {
      expect(name.startsWith('.'), name).toBe(true);
    }
  });
});

describe('the known-offender allow-list', () => {
  it('does not carry entries for selectors that no longer offend', () => {
    // A stale entry is worse than none: it keeps a fixed cost looking accepted after the cost is gone.
    const actual = new Set(findCompositorOffenders(sheets).map((o) => o.selector));
    for (const selector of Object.keys(KNOWN_OFFENDERS)) {
      expect(
        actual.has(selector),
        `KNOWN_OFFENDERS lists "${selector}" but it no longer trips the linter. Remove the entry.`,
      ).toBe(true);
    }
  });
});
