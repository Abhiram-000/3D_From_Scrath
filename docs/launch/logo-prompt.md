# The mark — "The Fold"

**Status: this is the platform's mark.** One concept, chosen and defended. `#d4a055` amber /
`#a56f3f` bronze / `#0a0b0e` graphite — the app's existing tokens.

---

## The idea, in one sentence

**A flat plane folding up into a solid** — because that is exactly what the platform does: a
typed description becomes a dimensional object.

That is the whole logo. If it needs a second sentence, it is the wrong mark.

## Why this and not the obvious thing

The first concept I proposed was an isometric cube or stack of plates. **It failed the test.**
The standard is that _a mark which executes the category default is competent, not distinct_ —
and "3D cube" is the default for anything 3D: it is a stock illustration category ("3D isometric
cube logo"), it is what a competitor in AI-for-education (Learning Commons) already uses, and
because every isometric form collapses to the same hexagon at 16 px, a cube mark silently
dissolves into every other 3D product's icon.

The education clichés are just as crowded: open books, lightbulbs, graduation caps, rockets,
puzzle pieces, knowledge trees. The dev-tool clichés are triangles and arrows (Vercel owns one of
those silhouettes outright).

A **fold** sidesteps all of them. It is not a closed volume — it is a transformation, which is the
honest thing to draw about a product whose input is text and whose output is a 3D scene.

## It also fits the brand's one real differentiator

Most AI products are dark backgrounds with neon gradients and vague promises — that is now a
recognisable _look_, and it is a liability. This brand is warm bronze on graphite, cream and
amber, which reads as considered and human instead of generated. The fold gives the amber
somewhere to land: the upright face catches the light.

## Construction rules (non-negotiable — these are what make it survive)

1. **Two shapes only**: a flat rhombus (the plane) and an upright quadrilateral (the folded face).
   Nothing else. A mark needing more than two or three shapes to be recognised will not survive
   small sizes.
2. **A thin, even gap of background between the two faces.** This is the whole trick: the negative
   space separates them, so the mark still reads when it is reduced to **one colour**. Without the
   gap it is two flat tones that merge into a blob in black and white.
3. **No outline stroke.** The form is defined by fills and the gap, so it scales cleanly and can be
   recoloured for light mode without redrawing.
4. **30° isometric, no perspective.** The fold line is vertical; the plane's edges are parallel.
5. **Sharp corners, no rounding.**

---

## THE PROMPT — paste this

```
A minimalist flat vector logo mark: a single flat square plane drawn in clean 30-degree isometric
projection, folding upward along its vertical centre line so that one half rises into an upright
face — a flat surface becoming a three-dimensional corner, like a sheet of card folded to stand.
Two shapes only: the flat half and the upright folded half. The two faces are separated by a thin,
perfectly even gap of background, running the length of the fold, so the mark still reads clearly
in a single colour. No outline, no stroke — the form is defined by the two flat fills and the gap.
The flat half is filled solid warm bronze (#a56f3f); the upright folded half is filled solid amber
(#d4a055), as if catching the light. Perfect geometric symmetry, parallel edges, sharp corners,
even proportions. The mark is centred on a plain solid white background with generous even padding,
occupying about half the frame.

flat vector logo, minimalist, icon only, solid white background, no gradients, no shadows
```

**Negative prompt** (Midjourney: append as `--no`, or paste into the negative field):

```
text, letters, words, numbers, signature, watermark, mockup, photograph, 3D render, glossy, bevel,
drop shadow, reflection, gradient, glow, lens flare, texture, outline, second colour, extra shapes,
border, frame, bookmark, page curl, paper note, book
```

**For DALL·E / GPT-image / Ideogram** — those models handle negatives poorly and tend to paint the
thing you told them to avoid. Drop the negative block and instead end the prose with:

```
Nothing else appears in the image: no text, no other objects, no shadow, no outline, no second
colour. Just the two flat shapes on plain white.
```

## Judging the candidates — in this order

Generate **8–12**, then:

1. **Squint at the silhouette at 50 px.** Judge only the shape. If the silhouette is weak, colour
   and detail will never save it.
2. **Shrink to 16 px.** It must still read as _a plane with something standing up on it_. A mark
   that dies at 16 px dies in the browser tab.
3. **Remove all colour.** It must still read. Colour is the last layer, never a crutch.
4. **Cover the name.** Would someone know it is this and not a competitor?
5. **Put it on the shelf** next to a generic isometric cube and a Vercel-style triangle. Does it
   stand apart, or dissolve into the set?

Reject immediately: any text in the image; a page-curl or bookmark reading (the fold must read as
dimensional, not as paper); more than two colours; any gloss, bevel or shadow.

## Responsive system (how it actually ships)

| Where                    | What shows                                                                 |
| ------------------------ | -------------------------------------------------------------------------- |
| 16 px favicon / app icon | the two-shape fold, no padding trickery — it is already minimal            |
| Header / toolbar         | fold + `EDU-3D` wordmark + the `Beta` chip, at the designed lockup spacing |
| Light mode               | bronze `#8a5a2e` for the flat half, amber `#d4a055` for the upright half   |
| One colour               | all-fill single cream `#faf6ee` on graphite — the gap does the separating  |

## Then

Send me the candidate you pick and I will **redraw it as clean SVG** — exact geometry, not a
traced approximation — then wire it into the header, the favicon set and the social preview card,
and keep the current layered mark as the fallback. A generated raster cannot be recoloured for
light mode and goes soft when small; the SVG is what makes it a logo rather than a picture.
