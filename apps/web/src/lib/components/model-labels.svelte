<!--
  The model-label overlay: the AI's own words drawn beside the parts they name (`01`: parts
  self-describing; spatial contiguity).

  WHAT THIS OWNS AND WHAT THE PAGE OWNS. The page owns the projection contract — it hands the worker
  the manifest's labels via the realized model and receives `onLabelPositions` back. This component
  owns the drawing and nothing else: it is a pure function of `labels` (the manifest list, carrying
  the words) and `projected` (the worker's screen positions), with no host access and no state.

  A LABEL IS READ-ONLY. Unlike the learner-note layer next door, a model label is authored content:
  it has no edit affordance, no remove button, and — deliberately — no pointer events at all. The
  overlay is `pointer-events: none` entirely, so a label can never intercept an orbit drag, a
  placement click, or a part selection. It is a caption, not a control.

  HONEST VISIBILITY. Only an entry the worker placed with coordinates is drawn. A `visible: false`
  entry — the part is behind the camera or outside the frustum — has no honest screen position, and
  drawing it from a mirrored coordinate would put the word on the wrong side of the screen from the
  part it names (`03` R7's rule, inherited: "hide behind the camera").

  TEXT IS A TEXT NODE. The label's word comes from the model, which is untrusted content. It is
  rendered as a Svelte text node, never `innerHTML` (`09`): a generated model's string is data, and
  none of it is markup.
-->
<script lang="ts">
  import type { ModelLabel, ProjectedLabel } from '@edu3d/contracts';

  const {
    labels,
    projected,
  }: {
    /** The manifest's labels — the words, keyed by id. */
    labels: ModelLabel[];
    /** The worker's projection of the same ids. Empty until the first projection lands. */
    projected: ProjectedLabel[];
  } = $props();

  const textById = $derived(new Map(labels.map((label) => [label.id, label.text])));

  /** Only a label the worker could place is drawn; an entry with no coordinates has nowhere to go. */
  const visible = $derived(
    projected.filter((entry) => entry.visible && entry.x !== undefined && entry.y !== undefined),
  );
</script>

<div class="label-overlay">
  {#each visible as entry (entry.id)}
    {@const text = textById.get(entry.id)}
    <div class="model-label" style="left: {entry.x}px; top: {entry.y}px">
      <span class="model-label-text">{text ?? ''}</span>
    </div>
  {/each}
</div>

<style>
  /* The whole layer is inert: a label must never take a pointer event. This is the one property that
     separates it from the annotation overlay, and it is why a label cannot break orbit or picking. */
  .label-overlay {
    position: absolute;
    inset: 0;
    overflow: hidden;
    pointer-events: none;
    z-index: 35;
  }

  .model-label {
    position: absolute;
    /* Anchor the text's leading edge on the projected point rather than the box corner, so the word
       starts beside the part it names. */
    transform: translate(0, -50%);
    max-width: 200px;
    padding: 2px 6px;
    font-size: 12px;
    line-height: 1.25;
    white-space: nowrap;
    color: var(--text-primary);
    background: color-mix(in srgb, var(--bg-panel-solid, rgba(15, 23, 42, 0.9)) 82%, transparent);
    border-radius: 4px;
    text-shadow: 0 1px 2px rgba(0, 0, 0, 0.6);
  }

  .model-label-text {
    overflow: hidden;
    text-overflow: ellipsis;
  }
</style>
