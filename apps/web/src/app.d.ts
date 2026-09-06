/**
 * Ambient types for the SvelteKit app.
 *
 * `app.d.ts` is where SvelteKit's per-request shapes are declared. They are empty here because the
 * frontend is a static build with no server hooks — the API lives in `apps/server`, and the browser
 * talks to it over `fetch`. Keeping these interfaces present but empty is deliberate: it documents
 * that the absence is a decision rather than an omission.
 */
declare global {
  namespace App {
    // eslint-disable-next-line @typescript-eslint/no-empty-object-type
    interface Error {}
    // eslint-disable-next-line @typescript-eslint/no-empty-object-type
    interface Locals {}
    // eslint-disable-next-line @typescript-eslint/no-empty-object-type
    interface PageData {}
    // eslint-disable-next-line @typescript-eslint/no-empty-object-type
    interface PageState {}
    // eslint-disable-next-line @typescript-eslint/no-empty-object-type
    interface Platform {}
  }
}

export {};
