#!/usr/bin/env node
/**
 * Compositor-cost check.
 *
 * Two mechanisms cost a frame on every presented frame, and both are expressible in CSS:
 *
 *  1. **An animated large blur.** `filter: blur(N)` is a convolution, not a layer transform. When
 *     the element is also animated — especially to a non-integer `scale()`, which defeats Chrome's
 *     cached filtered texture — the blur is re-rasterised every frame instead of once.
 *  2. **A backdrop blur over the canvas.** The WebGL canvas is opaque (`alpha: false`), so every
 *     presented frame is a full-canvas damage rect. Anything with a `backdrop-filter` sitting over
 *     it forces the compositor to re-read and re-blur that backdrop every frame.
 *
 * Chromium reproduces (2) directly: a 4px `backdrop-filter` over an animating canvas takes 60fps to
 * 10-20fps and composite time from 2-3ms to 30-80ms.
 *
 * Scoped to the mechanism, not to a selector, so it catches the class of cost rather than one
 * instance. See `check-compositor.test.ts` for what it deliberately cannot see.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/**
 * Selectors that sit over the 3D canvas. A `backdrop-filter` on any of these re-blurs the canvas.
 *
 * This list is a claim, not a guess: each name here is a class whose rule positions it over
 * `.main-canvas-holder`. Desktop side panels are deliberately absent — they are flex siblings of the
 * viewport and read a static gradient, so blurring them is free.
 */
export const CANVAS_OVERLAY_CLASSES = Object.freeze([
  '.modal-overlay',
  '.tooltip-3d',
  '.toast',
  '.subtitle',
  '.subtitle-content',
  '.panel',
]);

/** Blur radius at or above which a backdrop blur over the canvas is treated as a cost. */
const MIN_BACKDROP_RADIUS_PX = 5;
/** Blur radius at or above which a `filter: blur` is treated as a cost when animated. */
const MIN_ANIMATED_FILTER_RADIUS_PX = 20;

/**
 * Offenders the repository has accepted, each with the reason it is acceptable and who removes it.
 *
 * This is a work order, not an excuse. `check-compositor.test.ts` fails if an entry stops matching a
 * real offender, so a cost that has been fixed cannot quietly stay listed as accepted.
 */
export const KNOWN_OFFENDERS = Object.freeze({
  '.ambient-blob':
    'Landing and loading pages only — the viewer must pass blobs:false (performance plan Phase 1, Task 4). ' +
    'The blob CSS is global and shared, so no stylesheet rule can prove the viewer is exempt; that is ' +
    'enforced at runtime instead.',
  '.modal-overlay':
    'Full-viewport backdrop blur while the engine is still rendering (performance plan Phase 1, Task 8). ' +
    'Viewer.css already documents the diagnosis and implements the solid-background half.',
});

/** Read every stylesheet the viewer ships. */
export function readStylesheets() {
  const dir = join(ROOT, 'apps/web/src/lib/styles');
  return readdirSync(dir)
    .filter((name) => name.endsWith('.css'))
    .map((name) => ({ file: name, text: readFileSync(join(dir, name), 'utf8') }));
}

/** Largest `blur(Npx)` radius in a declaration block, or null when there is no literal radius. */
function blurRadius(declarations) {
  let largest = null;
  // A `var()` radius cannot be resolved without a cascade, so it is deliberately not counted: a
  // wrong number here would either invent an offender or hide one.
  //
  // The lookbehind matters: without it `filter:` matches inside `backdrop-filter:` and
  // `-webkit-backdrop-filter:`, so every glass surface in the app was reported as a plain filter.
  // That produced a false positive on `.prompt-card` the first time this ran.
  for (const match of declarations.matchAll(/(?<![\w-])filter:\s*blur\(\s*(\d+)px/g)) {
    const radius = Number(match[1]);
    if (largest === null || radius > largest) largest = radius;
  }
  return largest;
}

/** Largest `backdrop-filter: blur(Npx)` radius in a declaration block, ignoring an explicit `none`. */
function backdropRadius(declarations) {
  let largest = null;
  for (const match of declarations.matchAll(
    /(?<![\w-])backdrop-filter:\s*blur\(\s*(\d+)px/g,
  )) {
    const radius = Number(match[1]);
    if (largest === null || radius > largest) largest = radius;
  }
  return largest;
}

/** Class tokens in a selector list, lowercased. */
function classTokens(selectors) {
  const tokens = new Set();
  for (const selector of selectors) {
    for (const match of selector.matchAll(/\.([A-Za-z_][\w-]*)/g)) tokens.add(match[1]);
  }
  return tokens;
}

/**
 * Whether `token` is the animated class or a base of it.
 *
 * The real `.ambient-blob` rule declares the blur and declares no animation; the animation lives on
 * `.ambient-blob-a` and `.ambient-blob-b`, and the element carries both classes. A rule that only
 * looked for an animation in its own block therefore missed the single largest compositor cost in
 * the app. Class composition is how CSS actually applies these, so the check resolves across rules.
 */
function isAnimatedClass(token, animatedClasses) {
  for (const animated of animatedClasses) {
    if (animated === token) return true;
    if (animated.startsWith(`${token}-`)) return true;
    if (token.startsWith(`${animated}-`)) return true;
  }
  return false;
}

/**
 * Every rule that costs a compositor pass per presented frame.
 *
 * Returns one entry per (selector, property) at its largest radius, so a rule declaring both
 * `-webkit-backdrop-filter` and `backdrop-filter` is reported once rather than twice.
 */
export function findCompositorOffenders(sheets) {
  const worst = new Map();

  const record = (file, selector, property, radius, reason) => {
    const key = `${file}|${selector}|${property}`;
    const existing = worst.get(key);
    if (!existing || radius > existing.radius) {
      worst.set(key, { file, selector, property, radius, reason });
    }
  };

  // Pass one: collect every class that any rule animates, so a blur declared on a base class can be
  // attributed to an animation declared on a variant of it.
  const animatedClasses = new Set();
  const blocks = [];
  for (const { file, text } of sheets) {
    // Comments are stripped first so a commented-out rule cannot be linted; nested at-rules fall out
    // naturally because their contents match as their own blocks.
    const source = text.replace(/\/\*[\s\S]*?\*\//g, '');
    for (const match of source.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const selectors = match[1]
        .split(',')
        .map((part) => part.trim().replace(/\s+/g, ' '))
        .filter(Boolean);
      if (selectors.length === 0) continue;
      const declarations = match[2];
      blocks.push({ file, selectors, declarations });
      if (/(?:^|;)\s*animation(?:-name)?\s*:/.test(declarations)) {
        for (const token of classTokens(selectors)) animatedClasses.add(token);
      }
    }
  }

  for (const { file, selectors, declarations } of blocks) {
    const filterRadius = blurRadius(declarations);
    const backRadius = backdropRadius(declarations);

    for (const selector of selectors) {
      // Rule 1: a large blur on something that animates, whether the animation is declared in this
      // same rule or on a class the element also carries.
      if (filterRadius !== null && filterRadius >= MIN_ANIMATED_FILTER_RADIUS_PX) {
        const animatedHere = [...classTokens([selector])].some((token) =>
          isAnimatedClass(token, animatedClasses),
        );
        if (animatedHere) {
          record(
            file,
            selector,
            'filter',
            filterRadius,
            `animated blur of ${filterRadius}px re-rasterises every presented frame`,
          );
        }
      }

      // Rule 2: a backdrop blur on something that covers the canvas.
      if (
        CANVAS_OVERLAY_CLASSES.includes(selector) &&
        backRadius !== null &&
        backRadius >= MIN_BACKDROP_RADIUS_PX
      ) {
        record(
          file,
          selector,
          'backdrop-filter',
          backRadius,
          `backdrop blur of ${backRadius}px re-blurs the canvas every presented frame`,
        );
      }
    }
  }

  return [...worst.values()].sort(
    (a, b) => a.file.localeCompare(b.file) || a.selector.localeCompare(b.selector),
  );
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const offenders = findCompositorOffenders(readStylesheets());
  const unaccounted = offenders.filter((offender) => !KNOWN_OFFENDERS[offender.selector]);

  if (offenders.length === 0) console.log('  no compositor-cost rules found');

  for (const offender of offenders) {
    const known = KNOWN_OFFENDERS[offender.selector];
    const mark = known ? 'known' : 'UNACCOUNTED';
    console.log(
      `  ${mark.padEnd(11)} ${offender.file}: ${offender.property} ${offender.radius}px ` +
        `on ${offender.selector} — ${offender.reason}`,
    );
    if (known) console.log(`              accepted because: ${known}`);
  }

  if (unaccounted.length > 0) {
    console.error(
      `\ncompositor check FAILED: ${unaccounted.length} unaccounted rule(s). Each one re-blurs or ` +
        `re-rasterises every presented frame. Fix it, or add it to KNOWN_OFFENDERS with the reason it ` +
        `is acceptable and which change removes it.`,
    );
    process.exit(1);
  }

  console.log('\ncompositor check passed');
}