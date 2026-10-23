<!--
  Share Blueprint modal — V1's exact markup: link row with copy button + feedback, QR canvas,
  social buttons. The URL points at this app's /viewer?model=<id> after publishing; publishing
  without a backend reports honestly rather than pretending to share (`03` R8).

  WHAT GETS PUBLISHED: exactly the program the viewer page says is on screen (the `program` prop).
  When that is null — the built-in reference model is showing — the reference source ships, which
  is legitimate (it is a real model), and the modal says so in the UI instead of letting the
  fallback pass silently under the current manifest. The reference fallback itself is honest and
  stays; publishing it *unlabelled* was the lie.

  Publish-token design (matches the server's fail-closed write guard): POST /api/gallery requires
  `Authorization: Bearer EDU3D_WRITE_TOKEN`. When the server answers 401, this modal prompts the
  author to paste the token once, keeps it in localStorage under `edu3d.publish.token`, and sends
  it as that Bearer header on every attempt.

  THE LINK IS A PROMISE: `shareUrl` stays empty until a publish actually succeeds, so the dialog can
  never hand out a link that 404s. A failure shows the failure and no link, and the copy/social/QR
  controls stay hidden rather than pointing somewhere broken.

  QR + THUMBNAIL (`00-GOAL.md`: "share via link + QR code", "publish ... with snapshot thumbnail"):
  the published link is drawn as a real QR code by `lib/core/qr.ts`, or the modal says the code is
  unavailable — a decorative pattern that scans to nothing would be worse than no code. Publishing
  also attaches a snapshot of the live viewer as the gallery thumbnail. The capture belongs to the
  viewer page, which owns the sandbox host, and arrives as the optional `requestSnapshot` prop; a
  missing function, a failed capture or an oversized image simply leaves the thumbnail out. A
  thumbnail must never be the reason a publish fails.

  Say plainly what this is and is not: it is an ABUSE GATE, not authentication. There is no login
  on this platform; the token is a plain string that gates who may write to the shared gallery.
  Whatever is entered here is readable by anything running on this origin (localStorage), so it
  must not be a credential that protects anything else, and it travels only to this same-origin
  API — never logged, never in a URL. It is also not enforceable against a determined client that
  hosts the page itself; the gate lives on the server, and this UI only ships the header it asks for.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { REFERENCE_MODEL_SOURCE } from '@edu3d/engine';
  import type { ModelManifest } from '@edu3d/contracts';
  import { apiFetch } from '$lib/core/api.ts';
  import { drawQr, encodeQr, qrPixelSize } from '$lib/core/qr.ts';

  const PUBLISH_TOKEN_KEY = 'edu3d.publish.token';

  /**
   * The snapshot cap, mirrored from the server's own numbers: `SNAPSHOT_MAX_BYTES` in
   * `apps/server/src/services/gallery-store.ts` measures the decoded image, while
   * `PublishRequest.snapshot` in `packages/contracts/src/wire/api.ts` measures the base64 string in
   * the request. Base64 costs 4/3 of the image, so the string is the binding limit; an image past
   * three quarters of the byte cap is left out rather than sent to be rejected.
   */
  const SNAPSHOT_MAX_BYTES = 4_000_000;
  const SNAPSHOT_MAX_BLOB_BYTES = Math.floor((SNAPSHOT_MAX_BYTES * 3) / 4);

  /** Base64 of the raw bytes, built in chunks so a large snapshot does not overflow the call stack. */
  function bytesToBase64(bytes: Uint8Array): string {
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
  }

  interface SnapshotOutcome {
    /** Base64 for the payload's `snapshot` field, or null when there is nothing usable to send. */
    data: string | null;
    /** True when a snapshot existed but was too large — the UI says so rather than dropping it silently. */
    oversized: boolean;
  }

  /**
   * Ask the viewer for a snapshot and turn it into the publish payload's `snapshot` field.
   *
   * Every failure here is soft by design: no capture function, a capture that throws, a device that
   * returns nothing, or an image past the cap all leave `data` null and let the publish proceed. The
   * thumbnail is a nice-to-have; the model is the point.
   */
  async function captureSnapshot(
    request: (() => Promise<Blob | null>) | undefined,
  ): Promise<SnapshotOutcome> {
    if (request === undefined) return { data: null, oversized: false };

    let blob: Blob | null;
    try {
      blob = await request();
    } catch {
      return { data: null, oversized: false };
    }
    if (blob === null || blob.size === 0) return { data: null, oversized: false };
    if (blob.size > SNAPSHOT_MAX_BLOB_BYTES) return { data: null, oversized: true };

    try {
      const base64 = bytesToBase64(new Uint8Array(await blob.arrayBuffer()));
      if (base64.length > SNAPSHOT_MAX_BYTES) return { data: null, oversized: true };
      return { data: base64, oversized: false };
    } catch {
      return { data: null, oversized: false };
    }
  }

  /** Storage is optional (private mode); a read failure behaves exactly like "no token yet". */
  function storedPublishToken(): string {
    try {
      return localStorage.getItem(PUBLISH_TOKEN_KEY) ?? '';
    } catch {
      return '';
    }
  }

  function savePublishToken(token: string): void {
    try {
      if (token.length === 0) localStorage.removeItem(PUBLISH_TOKEN_KEY);
      else localStorage.setItem(PUBLISH_TOKEN_KEY, token);
    } catch {
      /* private mode: keep the token in memory below and let the retry carry it */
      memoryToken = token;
    }
  }

  /** Fallback for the rare browser where localStorage throws: lasts as long as the page does. */
  let memoryToken = '';

  /** The token that goes on the wire, joined whichever store above produced it. */
  function currentToken(): string {
    return storedPublishToken() || memoryToken;
  }

  const {
    manifest,
    program,
    galleryId,
    onclose,
    requestSnapshot,
  }: {
    manifest: ModelManifest | null;
    /**
     * The program currently on screen, owned by the viewer page: `{ code, runtime? }` for a
     * generated or gallery-loaded model, null when the built-in reference model is showing.
     * Publishing reads it directly — never a storage peek, which goes stale on any model swap.
     */
    program: { code: string; runtime?: string } | null;
    /**
     * The gallery entry this model already occupies — the id auto-save minted, or the id it was
     * loaded from. Sent as `PublishRequest.galleryId` so publishing UPDATES that row instead of
     * adding a duplicate. Null when the model has no entry yet, where publishing mints one.
     */
    galleryId: string | null;
    onclose: () => void;
    /**
     * Capture the live viewer as a PNG blob for the gallery thumbnail. Owned by the viewer page,
     * which owns the sandbox host that renders it. Optional because the page may have no host yet
     * (or none that can capture); without it the publish simply carries no thumbnail.
     */
    requestSnapshot?: () => Promise<Blob | null>;
  } = $props();

  let shareUrl = $state('');
  let publishing = $state(false);
  let publishError = $state<string | null>(null);
  let copied = $state(false);
  let published = $state(false);
  /** Set when the server answered 401: show the token prompt rather than only an error line. */
  let needsToken = $state(false);
  let publishToken = $state('');
  /** True when a snapshot was offered but skipped for size; surfaced next to the success line. */
  let snapshotSkipped = $state(false);
  let qrCanvas = $state<HTMLCanvasElement | null>(null);

  /** True when what is on screen (and about to be published) is the built-in reference model.
   *  Shown in the UI: the fallback is honest, but only when labelled. */
  const usingReferenceModel = $derived(program === null);
  /** Nothing to publish without a manifest, so the dialog says that instead of showing an empty url. */
  const nothingToPublish = $derived(manifest === null);
  /** The published link encoded as a QR code; null until a publish succeeds, or if the URL is too
   *  long for the encoder — the template turns that null into an honest "unavailable" line. */
  const qrMatrix = $derived(shareUrl.length > 0 ? encodeQr(shareUrl) : null);

  onMount(() => {
    // Publish on open. The link is a promise: it appears only once the server has actually stored the
    // model, so the dialog never offers a URL that would 404 for the person it is sent to.
    void publish();
  });

  /**
   * Draw the QR whenever the published link changes. The canvas is sized from the matrix rather than
   * stretched by CSS so every module lands on whole pixels — a fractional module size is exactly what
   * makes a displayed QR unscannable.
   */
  $effect(() => {
    const canvas = qrCanvas;
    const matrix = qrMatrix;
    if (canvas === null || matrix === null) return;
    const context = canvas.getContext('2d');
    if (context === null) return;
    const moduleSize = 6;
    canvas.width = qrPixelSize(matrix, moduleSize);
    canvas.height = canvas.width;
    drawQr(context, matrix, { moduleSize });
  });

  async function publish() {
    if (!manifest) return;
    publishing = true;
    publishError = null;
    snapshotSkipped = false;

    // Exactly the program on screen, from the page that loaded it. When the reference model is
    // showing, the reference source ships — it is what the link will open anywhere (`?model=`), so
    // the published code and the manifest can never disagree about which model they describe.
    const code = program?.code ?? REFERENCE_MODEL_SOURCE;
    const manifestToStore = manifest;
    // The instrumented twin rides along when the on-screen program has one, so a published model
    // keeps its browser-side loop guard. The reference fallback ships clean source, as it always has.
    const runtime = program?.runtime;

    // Captured before the POST so the thumbnail is the pose the learner is looking at. Absence or an
    // oversized image is not an error — the publish goes ahead without it.
    const snapshot = await captureSnapshot(requestSnapshot);

    const token = currentToken();
    try {
      const response = await apiFetch<{ id: string; shareUrl: string }>('/gallery', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          bundle: { manifest: manifestToStore, code, ...(runtime ? { runtime } : {}) },
          // The exact field the server reads: `PublishRequest.snapshot`, base64 (no data-URL prefix
          // needed — the server strips one if present and sniffs the bytes either way).
          ...(snapshot.data !== null ? { snapshot: snapshot.data } : {}),
          // Update the entry this model already occupies instead of adding a second one. Absent for
          // a model with no entry yet (the reference model, a pre-auto-save session), where the
          // server mints a fresh id exactly as before.
          ...(galleryId ? { galleryId } : {}),
        }),
      });
      if (response.ok) {
        // Only now is there a link worth showing.
        shareUrl = `${window.location.origin}${response.data.shareUrl}`;
        published = true;
        needsToken = false;
        snapshotSkipped = snapshot.oversized;
      } else {
        publishError = response.message;
        // The fail-closed server's answer to a write without (or with a wrong) token: surface the
        // one input that can fix it instead of a dead end (the old behaviour when a deployment
        // had a token — the modal printed the error text and nothing else).
        if (response.code === 'unauthorized') needsToken = true;
      }
    } finally {
      publishing = false;
    }
  }

  async function saveTokenAndRetry() {
    const token = publishToken.trim();
    if (token.length === 0) return;
    savePublishToken(token);
    publishToken = '';
    publishError = null;
    await publish();
  }

  async function copy() {
    if (shareUrl.length === 0) return;
    await navigator.clipboard?.writeText(shareUrl);
    copied = true;
    setTimeout(() => (copied = false), 2000);
  }

  function social(kind: 'twitter' | 'linkedin' | 'email') {
    // No link, no share target: a social intent pointing at an empty url would send a dead link.
    if (shareUrl.length === 0) return;
    const text = encodeURIComponent(`Check out this 3D model of ${manifest?.name ?? 'a concept'}`);
    const url = encodeURIComponent(shareUrl);
    const targets = {
      twitter: `https://twitter.com/intent/tweet?text=${text}&url=${url}`,
      linkedin: `https://www.linkedin.com/sharing/share-offsite/?url=${url}`,
      email: `mailto:?subject=${text}&body=${url}`,
    };
    window.open(targets[kind], '_blank', 'noopener');
  }
</script>

<div class="modal-container share-modal glass-panel">
  <div class="modal-header">
    <h2>🔗 Share Blueprint</h2>
    <button class="modal-close-btn" onclick={onclose} aria-label="Close share dialog">×</button>
  </div>
  <div class="modal-body">
    <div class="share-content">
      <div class="share-url-section">
        <label for="shareUrlInput">Share Link</label>
        {#if shareUrl}
          <div class="share-url-row">
            <input
              type="text"
              id="shareUrlInput"
              class="share-url-input"
              readonly
              value={shareUrl}
            />
            <button class="share-copy-btn" onclick={() => void copy()}>
              <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                <rect
                  x="5"
                  y="5"
                  width="8"
                  height="8"
                  rx="1"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.5"
                />
                <path d="M3 11V3h8" stroke="currentColor" stroke-width="1.5" fill="none" />
              </svg>
              Copy
            </button>
          </div>
          <div class="share-copy-feedback visible-when-copied" class:visible={copied}>
            Copied to clipboard!
          </div>
        {:else}
          <!-- No link until there is a real one. Showing origin/viewer here was a link that 404s. -->
          <p class="share-status">
            {#if publishing}
              Preparing the link…
            {:else if nothingToPublish}
              There is nothing to publish yet.
            {:else}
              No link — this model has not been published.
            {/if}
          </p>
        {/if}
        {#if usingReferenceModel}
          <p class="share-status">
            This is the built-in reference model — the link shares it as-is, not an AI-generated
            model.
          </p>
        {/if}
        {#if published}<p class="share-status published">
            Published to the gallery — the link above opens this exact model anywhere.
          </p>{/if}
        {#if published && snapshotSkipped}
          <p class="share-status">
            Published without a thumbnail — the snapshot was too large for the gallery.
          </p>
        {/if}
        {#if !published && needsToken}
          <!-- The recovery path for a token-protected server: one paste, one retry. -->
          <div class="share-url-section" style="margin-top: 0.75rem;">
            <label for="publishTokenInput">Publish token</label>
            <p class="share-status" style="margin-bottom: 0.5rem;">
              This server protects publishing with a write token. Paste the token the operator gave
              you — it is kept in this browser only (localStorage) and sent as a Bearer header to
              the same-origin API.
            </p>
            <div class="share-url-row">
              <input
                id="publishTokenInput"
                class="share-url-input"
                type="password"
                autocomplete="off"
                spellcheck="false"
                placeholder="paste the publish token"
                bind:value={publishToken}
                onkeydown={(event) => {
                  if (event.key === 'Enter') void saveTokenAndRetry();
                }}
              />
              <button
                class="share-copy-btn"
                disabled={publishing}
                onclick={() => void saveTokenAndRetry()}
              >
                {publishing ? 'Publishing…' : 'Publish'}
              </button>
            </div>
          </div>
        {/if}
        {#if publishError}<p class="share-status error">{publishError}</p>{/if}
      </div>

      {#if shareUrl}
        <div class="share-qr-section">
          <label for="shareQrCanvas">Scan to open</label>
          {#if qrMatrix}
            <!-- The canvas is decorative to a screen reader; the wrapper carries the name. -->
            <div
              class="share-qr-container"
              role="img"
              aria-label="QR code that opens this published model"
            >
              <canvas id="shareQrCanvas" bind:this={qrCanvas}></canvas>
            </div>
          {:else}
            <!-- A QR that cannot encode is reported, never faked; the link above still works. -->
            <p class="share-status">QR unavailable — use the link above instead.</p>
          {/if}
        </div>
      {/if}

      <div class="share-social-section">
        <!-- This label names the button group as a whole, so there is no single control to point
             `for` at; the buttons carry their own titles. -->
        <!-- svelte-ignore a11y_label_has_associated_control -->
        <label>Share on Social</label>
        <div class="share-social-btns">
          <button
            class="social-btn twitter"
            title="Share on Twitter/X"
            disabled={!shareUrl}
            onclick={() => social('twitter')}
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"
              ><path
                d="M12.6.75h2.454l-5.36 6.142L16 15.25h-4.937l-3.867-5.07-4.425 5.07H.316l5.733-6.57L0 .75h5.063l3.495 4.633L12.601.75zm-.86 13.028h1.36L4.323 2.145H2.865z"
              /></svg
            >
          </button>
          <button
            class="social-btn linkedin"
            title="Share on LinkedIn"
            disabled={!shareUrl}
            onclick={() => social('linkedin')}
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"
              ><path
                d="M0 1.146C0 .513.526 0 1.175 0h13.65C15.474 0 16 .513 16 1.146v13.708c0 .633-.526 1.146-1.175 1.146H1.175C.526 16 0 15.487 0 14.854zm4.943 12.248V6.169H2.542v7.225zm-1.2-8.212c.837 0 1.358-.554 1.358-1.248-.015-.709-.52-1.248-1.342-1.248-.822 0-1.359.54-1.359 1.248 0 .694.521 1.248 1.327 1.248zm4.908 8.212V9.359c0-.216.016-.432.08-.586.173-.431.568-.878 1.232-.878.869 0 1.216.662 1.216 1.634v3.865h2.401V9.25c0-2.22-1.184-3.252-2.764-3.252-1.274 0-1.845.7-2.165 1.193v.025h-.016l.016-.025V6.169h-2.4c.03.678 0 7.225 0 7.225z"
              /></svg
            >
          </button>
          <button
            class="social-btn email"
            title="Share via Email"
            disabled={!shareUrl}
            onclick={() => social('email')}
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"
              ><path
                d="M0 4a2 2 0 012-2h12a2 2 0 012 2v8a2 2 0 01-2 2H2a2 2 0 01-2-2zm2-1a1 1 0 00-1 1v.217l7 4.2 7-4.2V4a1 1 0 00-1-1zm13 2.383l-4.708 2.825L15 11.105zm-.034 6.876l-5.64-3.471L8 9.583l-1.326-.795-5.64 3.47A1 1 0 002 13h12a1 1 0 00.966-.741M1 11.105l4.708-2.897L1 5.383z"
              /></svg
            >
          </button>
        </div>
      </div>
    </div>
  </div>
</div>
