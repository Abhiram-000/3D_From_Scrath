<!--
  The Settings surface (`00-GOAL.md` §"Toolbar options → Settings", `08-PERFORMANCE-AND-DEVICES.md`).

  `08`'s rule is the reason this dialog exists at all: "the device decides, the platform adapts, the
  user is never asked and never lied to". So the quality preset defaults to Auto and shows the
  detected tier beside it, and every other control is either *honoured* or *visibly disabled with
  the reason* — never silently inert. "Never lied to" is the harder half: a toggle the engine cannot
  act on must say so, because a switch that moves but changes nothing is a lie the learner only
  discovers by watching the frame rate not change.

  Wired (the engine/component takes it):
    - Quality preset  → the host's `setQuality` and the worker's ladder (Auto = null).
    - Physics time scale → the host's `setTimeScale`, applied to the live model's delta.
    - Narration + rate → `narratePart` in `core/settings.ts`, gating story and per-part speech.

  Disabled with a reason (nothing reads them yet):
    - Shadows, post-processing, physics preference → admission-time decisions made inside the
      worker's ladder; the `WorkerRequest` union carries no message for a manual override.
    - Reduced motion → only the `prefers-reduced-motion` media query is honoured today.
    - Camera sensitivity → orbit/pan deltas are scaled by a fixed constant in the worker.

  This component does not reach into the host. A change that must reach the engine is expressed in
  the `onchange` / `onquality` contract, and the viewer owns applying it.

  Styling is entirely `viewer.css`'s shipped settings classes (`.settings-modal`, `.settings-toolbar`,
  `.settings-presets`/`.setting-option-btn`, `.settings-section`, `.setting-group`/`.setting-control`,
  `.setting-slider`/`.setting-select`/`.setting-value`, `.is-disabled`, `.secondary-btn`,
  `.parameter-checkbox`); the component adds no styles of its own.
-->
<script lang="ts">
  import { untrack } from 'svelte';
  import { UserSettings, type DeviceTier, type QualityPreset } from '@edu3d/contracts';

  const {
    open,
    settings,
    tier,
    onchange,
    onclose,
    onquality,
  }: {
    open: boolean;
    settings: UserSettings;
    /** The detected device tier, shown so "Auto" means something. */
    tier: DeviceTier;
    /** The whole, updated settings object — the viewer persists it. */
    onchange: (settings: UserSettings) => void;
    onclose: () => void;
    /** The quality pin alone, so the host can apply it without a full settings round trip. */
    onquality: (quality: QualityPreset | null) => void;
  } = $props();

  /**
   * A local draft so a control answers the pointer immediately; emitted on every change. It starts
   * empty and is filled from the prop when the dialog opens (the effect below), rather than reading
   * the prop at init — a one-way capture that Svelte warns about and that would go stale.
   */
  let draft = $state<UserSettings>(UserSettings.parse({}));

  const QUALITY_OPTIONS: ReadonlyArray<{ value: QualityPreset | null; label: string }> = [
    { value: null, label: 'Auto' },
    { value: 'low', label: 'Low' },
    { value: 'medium', label: 'Mid' },
    { value: 'high', label: 'High' },
  ];

  const TIER_LABEL: Record<DeviceTier, string> = { low: 'Low', mid: 'Mid', high: 'High' };

  /** The badge's palette keys on preset words, so `mid` is `medium` for the stylesheet's sake. */
  const badgeTier = $derived(tier === 'mid' ? 'medium' : tier);

  let panel: HTMLDivElement | null = $state(null);

  // Adopt the viewer's settings whenever they change (a save, a reset, or an external update).
  $effect(() => {
    if (open) draft = settings;
  });

  // Focus the dialog once per open — not on every settings change, which would interrupt a drag.
  $effect(() => {
    if (open) untrack(() => panel?.focus());
  });

  /** Merge a change, refuse one that leaves the schema, then hand the whole object on. */
  function commit(patch: Partial<UserSettings>): void {
    const next = UserSettings.safeParse({ ...draft, ...patch });
    if (!next.success) return;
    draft = next.data;
    onchange(draft);
  }

  function setQuality(value: QualityPreset | null): void {
    commit({ quality: value });
    onquality(value);
  }

  function reset(): void {
    const defaults = UserSettings.parse({});
    draft = defaults;
    onchange(defaults);
    onquality(null);
  }
</script>

<svelte:window
  onkeydown={(event) => {
    if (open && event.key === 'Escape') {
      event.preventDefault();
      onclose();
    }
  }}
/>

{#if open}
  <div
    class="modal-overlay active"
    role="dialog"
    aria-modal="true"
    aria-labelledby="settings-title"
  >
    <div class="modal-container glass-panel settings-modal" bind:this={panel} tabindex="-1">
      <div class="modal-header">
        <h2 id="settings-title">⚙️ Settings</h2>
        <div class="modal-header-actions">
          <!--
            Empty `data-quality` is deliberate: the stylesheet draws a dashed outline for any value
            other than `full`/empty to flag an adaptive downgrade. This badge reports the detected
            device tier, not a reduced quality, so it must not claim one.
          -->
          <span
            class="device-tier-badge"
            data-tier={badgeTier}
            data-quality=""
            title={`Detected ${TIER_LABEL[tier]} device. "Auto" lets the platform adapt to it.`}
          >
            Device: {TIER_LABEL[tier]}
          </span>
          <button class="modal-close-btn" onclick={onclose} aria-label="Close settings">×</button>
        </div>
      </div>

      <div class="modal-body">
        <div class="settings-toolbar">
          <div class="settings-presets" role="group" aria-label="Quality preset">
            {#each QUALITY_OPTIONS as option (option.label)}
              <button
                class="setting-option-btn"
                class:active={draft.quality === option.value}
                aria-pressed={draft.quality === option.value}
                onclick={() => setQuality(option.value)}
              >
                {option.label}
              </button>
            {/each}
          </div>
          <button class="secondary-btn" onclick={reset}>Reset to device defaults</button>
        </div>

        <div class="settings-content">
          <p class="setting-description">
            Detected {TIER_LABEL[tier]} device — Auto adapts the quality to it. A pin is honoured, and
            the platform warns rather than silently overriding it.
          </p>

          <section class="settings-section">
            <h3 class="settings-section-title">Rendering</h3>

            <!-- Disabled: `WorkerRequest` has no shadow message; shadowMap.enabled is set by the
                 admission verdict and by the ladder's `shadows` rung. -->
            <div class="setting-group is-disabled" aria-disabled="true">
              <div class="setting-header">
                <label class="setting-label" for="set-shadows">Shadows</label>
              </div>
              <p class="setting-description" id="set-shadows-help">
                Not wired yet: shadows are decided inside the engine from the model's declared
                budget and the adaptive ladder, and no message carries a manual choice to it.
              </p>
              <div class="setting-control">
                <select
                  id="set-shadows"
                  class="setting-select"
                  disabled
                  aria-describedby="set-shadows-help"
                >
                  <option value="auto" selected={draft.shadows === 'auto'}>Auto</option>
                  <option value="on" selected={draft.shadows === 'on'}>On</option>
                  <option value="off" selected={draft.shadows === 'off'}>Off</option>
                </select>
              </div>
            </div>

            <!-- Disabled: post-processing is a tier decision; the ladder's `postProcessing` rung
                 only lowers pixel ratio — there is no effects-toggle message to the worker. -->
            <div class="setting-group is-disabled" aria-disabled="true">
              <div class="setting-header">
                <label class="setting-label" for="set-post">Post-processing</label>
              </div>
              <p class="setting-description" id="set-post-help">
                Not wired yet: effect quality follows the device tier and the ladder; the engine
                takes no manual post-processing choice.
              </p>
              <div class="setting-control">
                <select
                  id="set-post"
                  class="setting-select"
                  disabled
                  aria-describedby="set-post-help"
                >
                  <option value="auto" selected={draft.postProcessing === 'auto'}>Auto</option>
                  <option value="on" selected={draft.postProcessing === 'on'}>On</option>
                  <option value="off" selected={draft.postProcessing === 'off'}>Off</option>
                </select>
              </div>
            </div>
          </section>

          <section class="settings-section">
            <h3 class="settings-section-title">Physics</h3>

            <!-- Disabled: physics is a per-model admission decision (`manifest.physics`). -->
            <div class="setting-group is-disabled" aria-disabled="true">
              <div class="setting-header">
                <label class="setting-label" for="set-physics">Physics preference</label>
              </div>
              <p class="setting-description" id="set-physics-help">
                Not wired yet: physics is a per-model decision made at admission — the model
                declares whether it needs a solver — and a manual override is not sent to the
                engine.
              </p>
              <div class="setting-control">
                <select
                  id="set-physics"
                  class="setting-select"
                  disabled
                  aria-describedby="set-physics-help"
                >
                  <option value="auto" selected={draft.physics === 'auto'}>Auto</option>
                  <option value="on" selected={draft.physics === 'on'}>On</option>
                  <option value="off" selected={draft.physics === 'off'}>Off</option>
                </select>
              </div>
            </div>

            <!-- Wired: the host's `setTimeScale` reaches the worker and scales the live delta. -->
            <div class="setting-group">
              <div class="setting-header">
                <label class="setting-label" for="set-timescale">Physics time scale</label>
              </div>
              <p class="setting-description" id="set-timescale-help">
                Slow motion for studying collisions; 1× is real time. Applied to the running model
                immediately.
              </p>
              <div class="setting-control">
                <input
                  id="set-timescale"
                  class="setting-slider"
                  type="range"
                  min="0.05"
                  max="2"
                  step="0.05"
                  value={draft.timeScale}
                  aria-describedby="set-timescale-help"
                  oninput={(event) =>
                    commit({ timeScale: Number((event.currentTarget as HTMLInputElement).value) })}
                />
                <span class="setting-value">{draft.timeScale.toFixed(2)}×</span>
              </div>
            </div>
          </section>

          <section class="settings-section">
            <h3 class="settings-section-title">Narration</h3>

            <!-- Wired: every utterance goes through `narratePart`, which returns early when this is
                 false or the browser lacks speech synthesis. -->
            <div class="setting-group">
              <div class="setting-header">
                <label class="setting-label" for="set-narration">Voice narration</label>
              </div>
              <p class="setting-description" id="set-narration-help">
                Reads story beats and the selected part's description aloud. Silent when your
                browser has no speech synthesis — that is a no-op, not an error.
              </p>
              <div class="setting-control">
                <input
                  id="set-narration"
                  class="parameter-checkbox"
                  type="checkbox"
                  checked={draft.narration}
                  aria-describedby="set-narration-help"
                  onchange={(event) =>
                    commit({ narration: (event.currentTarget as HTMLInputElement).checked })}
                />
              </div>
            </div>

            <!-- Wired: `narratePart` sets the utterance's rate from this value. -->
            <div class="setting-group">
              <div class="setting-header">
                <label class="setting-label" for="set-narration-rate">Narration rate</label>
              </div>
              <p class="setting-description" id="set-narration-rate-help">
                How fast narration is spoken. Has no effect while narration is off.
              </p>
              <div class="setting-control">
                <input
                  id="set-narration-rate"
                  class="setting-slider"
                  type="range"
                  min="0.5"
                  max="2"
                  step="0.1"
                  value={draft.narrationRate}
                  aria-describedby="set-narration-rate-help"
                  oninput={(event) =>
                    commit({
                      narrationRate: Number((event.currentTarget as HTMLInputElement).value),
                    })}
                />
                <span class="setting-value">{draft.narrationRate.toFixed(1)}×</span>
              </div>
            </div>
          </section>

          <section class="settings-section">
            <h3 class="settings-section-title">Motion &amp; camera</h3>

            <!-- Disabled: only the `prefers-reduced-motion` media query is honoured today. -->
            <div class="setting-group is-disabled" aria-disabled="true">
              <div class="setting-header">
                <label class="setting-label" for="set-reduced-motion">Reduced motion</label>
              </div>
              <p class="setting-description" id="set-reduced-motion-help">
                Not wired yet: motion follows your system's prefers-reduced-motion setting, and the
                viewer does not read an explicit override.
              </p>
              <div class="setting-control">
                <select
                  id="set-reduced-motion"
                  class="setting-select"
                  disabled
                  aria-describedby="set-reduced-motion-help"
                >
                  <option value="auto" selected={draft.reducedMotion === 'auto'}>Auto</option>
                  <option value="on" selected={draft.reducedMotion === 'on'}>On</option>
                  <option value="off" selected={draft.reducedMotion === 'off'}>Off</option>
                </select>
              </div>
            </div>

            <!-- Disabled: orbit/pan deltas are scaled by a fixed constant in the worker. -->
            <div class="setting-group is-disabled" aria-disabled="true">
              <div class="setting-header">
                <label class="setting-label" for="set-sensitivity">Camera sensitivity</label>
              </div>
              <p class="setting-description" id="set-sensitivity-help">
                Not wired yet: orbit and pan sensitivity is fixed in the worker, so this value is
                not read.
              </p>
              <div class="setting-control">
                <input
                  id="set-sensitivity"
                  class="setting-slider"
                  type="range"
                  min="0.25"
                  max="3"
                  step="0.05"
                  value={draft.cameraSensitivity}
                  disabled
                  aria-describedby="set-sensitivity-help"
                />
                <span class="setting-value">{draft.cameraSensitivity.toFixed(2)}×</span>
              </div>
            </div>
          </section>

          <p class="setting-description">
            Controls the engine cannot yet honour are shown disabled, with the reason — a switch
            that moves but changes nothing would be a lie.
          </p>
        </div>
      </div>
    </div>
  </div>
{/if}
