<!--
  Share Blueprint modal — V1's exact markup: link row with copy button + feedback, QR canvas,
  social buttons. The URL points at this app's /viewer?model=<id> after publishing; publishing
  without a backend reports honestly rather than pretending to share (`03` R8).

  Publish-token design (matches the server's fail-closed write guard): POST /api/gallery requires
  `Authorization: Bearer EDU3D_WRITE_TOKEN`. When the server answers 401, this modal prompts the
  author to paste the token once, keeps it in localStorage under `edu3d.publish.token`, and sends
  it as that Bearer header on every attempt.

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
  import { apiFetch, peekBundleCode, peekBundleRuntime } from '$lib/core/api.ts';

  const PUBLISH_TOKEN_KEY = 'edu3d.publish.token';

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

  const { manifest, onclose }: { manifest: ModelManifest | null; onclose: () => void } = $props();

  let shareUrl = $state('');
  let publishing = $state(false);
  let publishError = $state<string | null>(null);
  let copied = $state(false);
  let published = $state(false);
  /** Set when the server answered 401: show the token prompt rather than only an error line. */
  let needsToken = $state(false);
  let publishToken = $state('');

  onMount(() => {
    // A local-only share still resolves: the model is in session storage, so the link opens this
    // browser's viewer. Publishing adds the gallery id when a backend is available.
    shareUrl = `${window.location.origin}/viewer`;
    void publish();
  });

  async function publish() {
    if (!manifest) return;
    publishing = true;

    // The generated bundle when one is waiting in this session; the reference source otherwise —
    // publishing the reference model is legitimate (it is a real model).
    const waiting = peekBundleCode();
    const code = (waiting ?? '').trim() || REFERENCE_MODEL_SOURCE;
    const manifestToStore = manifest;
    // The instrumented twin rides along when the stored bundle has one, so a published model keeps
    // its browser-side loop guard. The reference fallback ships clean source, as it always has.
    const runtime = peekBundleRuntime();

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
        }),
      });
      if (response.ok) {
        shareUrl = `${window.location.origin}${response.data.shareUrl}`;
        published = true;
        needsToken = false;
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
    await navigator.clipboard?.writeText(shareUrl);
    copied = true;
    setTimeout(() => (copied = false), 2000);
  }

  function social(kind: 'twitter' | 'linkedin' | 'email') {
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
        <label>Share Link</label>
        <div class="share-url-row">
          <input type="text" id="shareUrlInput" class="share-url-input" readonly value={shareUrl} />
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
        {#if publishing && !needsToken}<p class="share-status">Publishing…</p>{/if}
        {#if published}<p class="share-status published">
            Published to the gallery — the link below opens this exact model anywhere.
          </p>{/if}
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

      <div class="share-social-section">
        <label>Share on Social</label>
        <div class="share-social-btns">
          <button
            class="social-btn twitter"
            title="Share on Twitter/X"
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
            onclick={() => social('linkedin')}
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"
              ><path
                d="M0 1.146C0 .513.526 0 1.175 0h13.65C15.474 0 16 .513 16 1.146v13.708c0 .633-.526 1.146-1.175 1.146H1.175C.526 16 0 15.487 0 14.854zm4.943 12.248V6.169H2.542v7.225zm-1.2-8.212c.837 0 1.358-.554 1.358-1.248-.015-.709-.52-1.248-1.342-1.248-.822 0-1.359.54-1.359 1.248 0 .694.521 1.248 1.327 1.248zm4.908 8.212V9.359c0-.216.016-.432.08-.586.173-.431.568-.878 1.232-.878.869 0 1.216.662 1.216 1.634v3.865h2.401V9.25c0-2.22-1.184-3.252-2.764-3.252-1.274 0-1.845.7-2.165 1.193v.025h-.016l.016-.025V6.169h-2.4c.03.678 0 7.225 0 7.225z"
              /></svg
            >
          </button>
          <button class="social-btn email" title="Share via Email" onclick={() => social('email')}>
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
