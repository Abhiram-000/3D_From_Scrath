# Logo — generation prompt

## Read this first (it's the difference between a usable result and a wasted hour)

1. **Never ask the image model for the words "EDU-3D".** Generative image models cannot
   render text reliably — you will get letter-shaped mush. Generate the **mark only**; keep
   "EDU-3D" as live text beside it (which is what the app already does, and it stays crisp at
   any size and readable by a screen reader).
2. **Ask for a flat vector mark, not a 3D render or a mockup.** A logo is geometry. Anything
   with gloss, bevel, reflections or a drop shadow is unrecoverable at 16 px.
3. **Pin the colours to this product's real tokens**, or it will look bolted on:
   amber `#d4a055` · bronze `#a56f3f` · cream `#faf6ee` · graphite `#0a0b0e`.
4. **Generate square at 1024 px or larger**, then export a transparent-background copy.
5. **The result is a raster.** A generated logo will look soft at small sizes and cannot be
   recoloured for light mode. The honest finish is to trace it into SVG and put _that_ in the
   app — ask and I'll do it, and add it to the header, favicon and social card.

---

## The concept (why this shape)

The product's one idea: **an AI writes code, and the code becomes a real 3D object** — with the
ceiling set by the API, not a fixed catalogue. The most honest mark for that is _structure
built from layers_: a stack of isometric plates, the top one lifted, as if a part has been
picked out and is being examined. That reads as three things at once — 3D geometry, layers of a
model building up, and the learner lifting a part to look at it — and it stays legible at
favicon size. It also continues the layered mark the app already ships, so nothing looks new.

---

## PRIMARY PROMPT — paste this

```
A minimal flat vector logo mark: three thin isometric rhombus plates stacked vertically with
even spacing, in a 30-degree isometric projection with no perspective. The top plate floats
slightly higher than the two beneath it, lifted as if picked up for inspection. The top plate is
filled solid amber (#d4a055). The lower two plates are hairline outlines in warm bronze
(#a56f3f), each slightly fainter than the one above it. Pure geometric precision: equal line
weight, sharp corners, no rounded edges. The mark is centred on a plain very dark charcoal
backdrop (#0a0b0e) with generous even padding, occupying about half the frame. Flat vector
illustration, crisp clean edges, high contrast, restrained and technical.

no text, no letters, no words, no numbers, no watermark, no signature, no mockup, no
photograph, no 3D render, no gloss, no bevel, no drop shadow, no reflection, no gradient, no
glow, no lens flare, no extra shapes, no border, no frame
```

## VARIANT B — light background (for print, documents, slides)

Same prompt, but swap the last descriptive sentence for:

```
centred on a plain warm cream backdrop (#faf6ee) with generous even padding, the top plate
filled solid deep bronze (#8a5a2e) and the two lower plates hairline outlines in bronze
(#a56f3f)
```

## VARIANT C — single colour (favicon, stamps, embroidery, one-colour print)

```
A minimal flat vector logo mark: three thin isometric rhombus plates stacked vertically with
even spacing, 30-degree isometric projection, no perspective, the top plate floating slightly
higher than the two beneath it. Entirely in ONE flat solid colour — cream (#faf6ee) — thin
uniform strokes with the top plate filled and the two lower plates as outlines, all the same
single colour. Centred on a plain very dark charcoal backdrop (#0a0b0e), generous even padding,
mark occupying about half the frame. Flat vector, crisp edges, high contrast, technical and
restrained.

no text, no letters, no words, no watermark, no mockup, no photograph, no 3D render, no gloss,
no bevel, no shadow, no gradient, no glow, no second colour, no extra shapes, no border
```

## ALTERNATE CONCEPT — "the edge becomes solid" (if the stack feels too quiet)

```
A minimal flat vector logo mark: a single isometric cube drawn as thin amber (#d4a055) wireframe
edges on its two visible side faces, while its top face is filled solid amber — the form caught
mid-way between a wireframe drawing and a real solid object. 30-degree isometric projection, no
perspective, hairline uniform line weight, sharp corners. Centred on a plain very dark charcoal
backdrop (#0a0b0e), generous even padding, mark occupying about half the frame. Flat vector
illustration, crisp edges, high contrast, technical and restrained.

no text, no letters, no words, no watermark, no mockup, no photograph, no 3D render, no gloss,
no bevel, no shadow, no reflection, no gradient, no glow, no extra shapes, no border
```

---

## Palette (the app's real tokens — use these, not whatever the model likes)

| Token            | Hex       | Use                                 |
| ---------------- | --------- | ----------------------------------- |
| `--amber-500`    | `#d4a055` | primary accent, the filled plate    |
| `--amber-400`    | `#e8c882` | highlight on dark, if needed        |
| `--bronze-600`   | `#a56f3f` | secondary strokes                   |
| `--bronze-700`   | `#8a5a2e` | the accent on cream backgrounds     |
| `--cream-100`    | `#faf6ee` | ink on dark, the monochrome variant |
| `--graphite-950` | `#0a0b0e` | the app's dark backdrop             |

## Picking the result

Reject a candidate if: it has any visible text; it uses more than two colours; it has gloss,
bevel or a shadow; the plates are not parallel (isometric rule broken); or the silhouette stops
reading when you shrink it to 32 px and squint. Generate 8–12 candidates, shrink the survivors
to 32 px, and only then choose — a mark that dies at 32 px dies in the toolbar.

## Then

Give me the one you pick and I'll redraw it as clean **SVG**, wire it into the header, set the
favicon and the social preview card, and keep the current mark as the fallback. That's the step
that makes it a logo rather than a picture.
