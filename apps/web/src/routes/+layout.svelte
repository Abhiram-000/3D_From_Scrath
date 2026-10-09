<!--
  The root layout.

  Imports base.css, which chains the full design system: tokens.css (legacy app tokens, first) →
  theme.css (the V1 Sunset Graphite system, loaded last so it wins every shared name) → the reset,
  glass, and shared classes. Page-specific stylesheets (landing.css, loading.css, viewer.css,
  viewer-extended.css) are imported by their pages, so each page ships only its own CSS (`07`).

  All chrome belongs to the pages themselves.
-->
<script lang="ts">
  import '$lib/styles/base.css';

  const { children } = $props();
</script>

{@render children()}
