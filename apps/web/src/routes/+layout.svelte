<!--
  The root layout.

  It does exactly two things: import the base stylesheet once, and render the active page. All chrome
  belongs to the pages themselves, because `07` gives each of the three pages a distinct UX job and
  the landing page must not pay for the viewer's furniture.
-->
<script lang="ts">
  import '$lib/styles/base.css';

  const { children } = $props();
</script>

{@render children()}
