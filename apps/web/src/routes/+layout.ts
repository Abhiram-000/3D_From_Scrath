/**
 * Route-level configuration for the whole app.
 *
 * `prerender` produces static HTML for the shell at build time, and `ssr = false` keeps every page a
 * client-rendered island. That combination is deliberate: the pages have no server-side data to fetch
 * (the API is a separate origin), the viewer is inherently browser-only, and skipping hydration
 * mismatch entirely keeps the landing page's first paint as cheap as `08` demands.
 */
export const prerender = true;
export const ssr = false;
/** Preloading is decided per link in the markup, so a landing visitor never fetches the viewer chunk. */
export const trailingSlash = 'never';
