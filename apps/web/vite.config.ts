/**
 * Vite configuration for the frontend.
 *
 * Two settings carry real weight. The dev proxy lets the browser talk to `/api` on the same origin, so
 * development exercises the same-origin path production uses instead of a CORS-only path that hides
 * mistakes. And the manual chunking keeps `08`'s loading discipline honest: Three.js, the physics WASM
 * wrapper and CSG each land in their own chunk, so the landing page downloads none of them and the
 * viewer's heavy code streams *during* the generation wait rather than after it.
 */
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

/** Where the Hono server listens in development; matches `apps/server/.env.example`. */
const SERVER_ORIGIN = process.env.API_ORIGIN ?? 'http://127.0.0.1:8787';

export default defineConfig({
  plugins: [sveltekit()],
  server: {
    proxy: {
      '/api': {
        target: SERVER_ORIGIN,
        changeOrigin: true,
        // Generation streams for minutes; a proxy that buffers or times out defeats the whole design.
        timeout: 0,
        proxyTimeout: 0,
      },
      '/snapshots': { target: SERVER_ORIGIN, changeOrigin: true },
    },
  },
  build: {
    target: 'es2022',
    // Source maps ship because the diagnostics panel is a first-class feature, not a debug afterthought.
    sourcemap: true,
    rollupOptions: {
      output: {
        manualChunks: (id) => {
          if (id.includes('node_modules/three')) return 'three';
          if (id.includes('@dimforge/rapier3d')) return 'physics';
          if (id.includes('three-bvh-csg') || id.includes('three-mesh-bvh')) return 'geometry-ops';
          return undefined;
        },
      },
    },
  },
  optimizeDeps: {
    // Rapier is WASM-backed; pre-bundling it confuses the loader and costs a page reload in dev.
    exclude: ['@dimforge/rapier3d-compat'],
  },
});
