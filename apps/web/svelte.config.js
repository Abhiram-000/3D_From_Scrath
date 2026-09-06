/**
 * SvelteKit configuration.
 *
 * The static adapter is deliberate: the three pages are a landing funnel, a progress screen and a
 * viewer, none of which need server rendering, and `08` requires the landing page to be kilobytes on
 * a phone over 4G. A static build also means the frontend deploys to a CDN while the Hono server
 * handles only API traffic — two deploy roots, as `09` allows for halves that ship separately.
 */
import adapter from '@sveltejs/adapter-static';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** @type {import('@sveltejs/kit').Config} */
const config = {
  preprocess: vitePreprocess(),
  kit: {
    adapter: adapter({
      // A single fallback document keeps deep links (`/viewer?model=<id>`) resolvable on any static host.
      fallback: 'index.html',
      strict: false,
    }),
    alias: {
      $lib: 'src/lib',
    },
  },
};

export default config;
