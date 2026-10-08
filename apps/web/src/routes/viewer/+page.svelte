<!--
  The viewer.

  The three-column instrument panel from `03-VIEWER.md`, wired to the sandbox host. Everything visible here is
  DOM; everything 3D happens inside the worker on this device, drawing to a canvas the page transferred away.

  Two rules from `03` are structural rather than cosmetic and worth pointing at:

   - **The viewer boots with a dead engine.** Panels, toolbar and status bar render before any model exists, so a
     failed load is an empty instrument rather than a broken page.
   - **Model-authored text is rendered as text.** Svelte's `{...}` interpolation escapes by construction, and there
     is no `{@html}` anywhere in this file. A published model's info text runs in every viewer that opens it.
-->
<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import type { ModelManifest, RuntimeStats } from '@edu3d/contracts';
  import { REFERENCE_MODEL_SOURCE } from '@edu3d/engine';
  import { SandboxHost, sandboxSupported, type HostCallbacks } from '$lib/engine/sandbox-host.ts';
  import type { SerializableVerdict } from '$lib/engine/sandbox-worker.ts';
  import { apiFetch, takeBundle } from '$lib/core/api.ts';
  import type { ModelContext, QuizQuestion } from '@edu3d/contracts';
  import { toContext } from '$lib/core/model-context.ts';
  import ChatPanel from '$lib/components/chat-panel.svelte';
  import QuizModal from '$lib/components/quiz-modal.svelte';
  import StoryMode from '$lib/components/story-mode.svelte';

  /** Canvas container, handed to the host so it can own the element. */
  let canvasHolder = $state<HTMLElement | null>(null);
  let host: SandboxHost | null = null;

  let support = $state<{ supported: boolean; reason?: string }>({ supported: true });
  let engineReady = $state(false);
  let loading = $state(false);
  let loadError = $state<string | null>(null);

  let manifest = $state<ModelManifest | null>(null);
  let verdict = $state<SerializableVerdict | null>(null);
  let stats = $state<RuntimeStats | null>(null);
  let metrics = $state<Record<string, number>>({});
  let parameterValues = $state<Record<string, number | boolean | string>>({});

  let hoveredPart = $state<string | null>(null);
  let selectedPart = $state<string | null>(null);

  let paused = $state(false);
  let viewMode = $state<'normal' | 'xray' | 'wireframe' | 'explode'>('normal');
  let leftOpen = $state(true);
  let rightOpen = $state(true);
  let showDiagnostics = $state(false);

  /** The conversation layer (`05`): one mode at a time; Escape exits any mode back to exploration. */
  let activeMode = $state<'none' | 'story' | 'quiz'>('none');
  let chatOpen = $state(false);
  let quizQuestions = $state<QuizQuestion[]>([]);
  let quizSource = $state<'authored' | 'generated'>('authored');
  /** Set when the worker reported the physics WASM could not load (`02`: say so, never fake it). */
  let simUnavailable = $state(false);
  /** Svelte 5 component instance: an object carrying its exported methods. */
  let chatPanel = $state<{ seedFromModel: (context: ModelContext) => void } | null>(null);

  /** Toasts. `07`: the viewer speaks in short sentences, not dialogs. */
  let toasts = $state<Array<{ id: number; message: string }>>([]);
  let toastSeq = 0;
  let guestLogs = $state<Array<{ level: string; message: string }>>([]);

  /** Pointer drag state for orbit and pan. */
  let dragging: 'orbit' | 'pan' | null = null;
  let lastPointer = { x: 0, y: 0 };

  function toast(message: string) {
    const id = (toastSeq += 1);
    toasts = [...toasts, { id, message }];
    // Auto-dismiss, because a viewer notice is information rather than a decision to make.
    setTimeout(() => {
      toasts = toasts.filter((entry) => entry.id !== id);
    }, 6000);
  }

  /** Read the scene backdrop from the design tokens, so the canvas follows the theme rather than guessing. */
  function readThemeColors(): { top: string; bottom: string } {
    const styles = getComputedStyle(document.documentElement);
    return {
      top: styles.getPropertyValue('--scene-bg-top').trim() || '#17130f',
      bottom: styles.getPropertyValue('--scene-bg-bottom').trim() || '#08070a',
    };
  }

  const callbacks: HostCallbacks = {
    onReady: () => {
      engineReady = true;
    },
    onLoaded: (loadedManifest, loadedVerdict) => {
      manifest = loadedManifest;
      verdict = loadedVerdict;
      loading = false;
      loadError = null;
      // Seed the panel from the manifest's declared defaults, so the controls read correctly before any change.
      const defaults: Record<string, number | boolean | string> = {};
      for (const parameter of loadedManifest.parameters) defaults[parameter.id] = parameter.default;
      parameterValues = defaults;
      // A model swap unloads the previous model's modes (`05`).
      unloadModes();
      simUnavailable = false;
      chatPanel?.seedFromModel(toContext(loadedManifest));
    },
    onLoadFailed: (message, timedOut, logs) => {
      loading = false;
      // The previous model stays on screen if there was one: a failed load never costs the learner what they had.
      loadError = timedOut ? `${message} (it ran too long and was stopped)` : message;
      guestLogs = logs.map((entry) => ({ level: 'error', message: entry }));
    },
    onStats: (nextStats) => {
      stats = nextStats;
    },
    onMetrics: (values) => {
      metrics = values;
    },
    onHover: (partId) => {
      hoveredPart = partId;
    },
    onSelected: (partId) => {
      selectedPart = partId;
    },
    onLog: (level, message) => {
      guestLogs = [...guestLogs.slice(-99), { level, message }];
    },
    onNotice: (message) => {
      toast(message);
      if (/physics simulation is unavailable/i.test(message)) simUnavailable = true;
    },
    onKilled: (reason) => {
      loading = false;
      manifest = null;
      stats = null;
      loadError = reason;
      toast(reason);
    },
    onSnapshot: (blob) => {
      // Downloaded straight from the device that rendered it; the server is not involved.
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `${manifest?.name ?? 'model'}.png`;
      link.click();
      URL.revokeObjectURL(url);
      toast('Snapshot saved.');
    },
  };

  onMount(() => {
    support = sandboxSupported();
    if (!support.supported || !canvasHolder) return;

    host = new SandboxHost(canvasHolder, callbacks);
    host.start();
    host.setTheme(readThemeColors());

    /**
     * The end-to-end test seam.
     *
     * Exposed deliberately, and narrowly: the E2E suite must be able to feed a deliberately broken or runaway
     * program to prove the sandbox contains it, and there is no other way to reach the host from outside the
     * component. It widens nothing — any script already on this page can reach the canvas, and the host holds no
     * secrets. Only the two methods the suite needs are published.
     */
    (window as unknown as Record<string, unknown>).__edu3dHost = Object.freeze({
      load: (code: string, seed?: number) => host?.load(code, seed),
      kill: (reason: string) => host?.kill(reason),
    });

    const observer = new ResizeObserver(() => host?.resize());
    observer.observe(canvasHolder);

    // The load priority order `03` R2 fixes: shared link → session spec → on-disk fallback. A gallery
    // pick is the shared-link path; the freshly generated bundle is the session spec; the reference
    // model is the fallback that means the viewer is never an empty room.
    loading = true;
    const sharedId = new URLSearchParams(window.location.search).get('model');
    const generated = takeBundle();

    if (sharedId) {
      void loadFromGallery(sharedId);
    } else if (generated) {
      host.load(generated, 7);
    } else {
      host.load(REFERENCE_MODEL_SOURCE, 7);
    }

    const onKeyDown = (event: KeyboardEvent) => {
      // Shortcuts never fire while typing in a field (`03` R10).
      const target = event.target as HTMLElement | null;
      if (target && /input|textarea|select/i.test(target.tagName)) return;

      switch (event.key.toLowerCase()) {
        case ' ':
          event.preventDefault();
          togglePaused();
          break;
        case 'r':
          host?.resetTime();
          break;
        case 'x':
          setViewMode(viewMode === 'xray' ? 'normal' : 'xray');
          break;
        case 'w':
          setViewMode(viewMode === 'wireframe' ? 'normal' : 'wireframe');
          break;
        case 'e':
          setViewMode(viewMode === 'explode' ? 'normal' : 'explode');
          break;
        case 'f':
          host?.focusPart(selectedPart);
          break;
        case 'd':
          showDiagnostics = !showDiagnostics;
          break;
        case 't':
          toggleTheme();
          break;
        case 'z':
          if (event.ctrlKey || event.metaKey) {
            event.preventDefault();
            undo();
          }
          break;
        case 'y':
          if (event.ctrlKey || event.metaKey) {
            event.preventDefault();
            redo();
          }
          break;
        case '?':
          showHelp = !showHelp;
          break;
        case 'escape':
          // `05`: Escape exits any mode back to free exploration.
          if (activeMode !== 'none') {
            activeMode = 'none';
            break;
          }
          selectedPart = null;
          setViewMode('normal');
          break;
        default:
          break;
      }
    };

    window.addEventListener('keydown', onKeyDown);

    return () => {
      observer.disconnect();
      window.removeEventListener('keydown', onKeyDown);
    };
  });

  onDestroy(() => {
    host?.dispose();
    host = null;
  });

  function togglePaused() {
    paused = !paused;
    host?.setPaused(paused);
  }

  /**
   * Resolve a shared/gallery link. `03` R2: a deep link to a dead id is "honest message + fallback
   * model, never a blank viewer" — the fallback is the reference model and the notice says what died.
   */
  async function loadFromGallery(id: string) {
    const result = await apiFetch<{ bundle: { code?: string } }>(`/gallery/${encodeURIComponent(id)}`);
    if (result.ok && result.data.bundle?.code) {
      host?.load(result.data.bundle.code, 7);
      return;
    }
    toast('That shared model could not be loaded; showing the reference model instead.');
    host?.load(REFERENCE_MODEL_SOURCE, 7);
  }

  // ── The conversation layer (`05`) ────────────────────────────────────────────

  /** Model swap unloads the previous model's story and quiz — a quiz answering the previous model
   *  is a betrayal. Everything mode-related resets here. */
  function unloadModes() {
    activeMode = 'none';
    quizQuestions = [];
  }

  function enterStory() {
    if (!manifest?.story.length) {
      toast('This model has no story beats.');
      return;
    }
    activeMode = activeMode === 'story' ? 'none' : 'story';
  }

  /** Authored-first: the model's own questions are used before any are generated (`05`). */
  async function enterQuiz() {
    if (activeMode === 'quiz') {
      activeMode = 'none';
      return;
    }
    if (manifest && manifest.quiz.length > 0) {
      quizSource = 'authored';
      quizQuestions = manifest.quiz;
      activeMode = 'quiz';
      return;
    }
    // The fallback path: generation is the fallback, and its failure leaves the viewer untouched.
    if (!manifest) return;
    quizSource = 'generated';
    activeMode = 'quiz';
    const result = await apiFetch<{ questions: typeof quizQuestions; dropped: number }>('/quiz', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        context: toContext(manifest, selectedPart),
        count: 5,
        difficulty: 'mixed',
      }),
    });
    if (result.ok && result.data.questions.length > 0) {
      quizQuestions = result.data.questions;
      if (result.data.dropped > 0) {
        toast(`${result.data.dropped} unusable question${result.data.dropped === 1 ? '' : 's'} were dropped.`);
      }
    } else {
      activeMode = 'none';
      toast('Quiz generation is unavailable right now.');
    }
  }

  /** A story beat's parameter change flows through the same owner as manual changes (`05`). */
  function beatSetParameter(id: string, value: number | boolean | string) {
    parameterValues = { ...parameterValues, [id]: value };
    host?.setParameter(id, value);
  }

  // ── Undo/redo: one step per gesture (`03` R4) ────────────────────────────────

  type ParamSnapshot = Record<string, number | boolean | string>;
  let undoStack = $state<ParamSnapshot[]>([]);
  let redoStack = $state<ParamSnapshot[]>([]);
  /** Set on the first change of a drag gesture; the pre-change snapshot is what lands on the stack. */
  let gestureOpen = false;
  /** Coalescing window: one pointer gesture = one undo step, whatever the event rate. */
  let gestureTimer: ReturnType<typeof setTimeout> | null = null;

  function noteParameterGesture() {
    if (!gestureOpen) {
      gestureOpen = true;
      undoStack = [...undoStack.slice(-49), { ...parameterValues }];
      redoStack = [];
    }
    if (gestureTimer) clearTimeout(gestureTimer);
    // A gesture closes after a quiet period, so a pause-and-resume on the same slider is two steps.
    gestureTimer = setTimeout(() => (gestureOpen = false), 600);
  }

  function undo() {
    const previous = undoStack[undoStack.length - 1];
    if (!previous) return;
    undoStack = undoStack.slice(0, -1);
    redoStack = [...redoStack, { ...parameterValues }];
    applySnapshot(previous);
  }

  function redo() {
    const next = redoStack[redoStack.length - 1];
    if (!next) return;
    redoStack = redoStack.slice(0, -1);
    undoStack = [...undoStack, { ...parameterValues }];
    applySnapshot(next);
  }

  /** A snapshot flows through the one owner so widgets, engine and metrics agree (`03` R4). */
  function applySnapshot(snapshot: ParamSnapshot) {
    parameterValues = { ...snapshot };
    for (const [id, value] of Object.entries(snapshot)) host?.setParameter(id, value);
  }

  // ── Theme, fullscreen, help ─────────────────────────────────────────────────

  function toggleTheme() {
    const next = (document.documentElement.dataset.theme as 'dark' | 'light') === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    document.documentElement.style.colorScheme = next;
    try {
      localStorage.setItem('edu3d.theme', next);
    } catch {
      /* session-only */
    }
    host?.setTheme(readThemeColors());
  }

  function toggleFullscreen() {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void document.documentElement.requestFullscreen().catch(() => toast('Fullscreen is not available here.'));
  }

  let showHelp = $state(false);

  const SHORTCUTS: ReadonlyArray<[string, string]> = [
    ['Space', 'Play / pause'],
    ['R', 'Reset to the authored state'],
    ['X / W / E', 'X-ray / wireframe / explode'],
    ['F', 'Focus the selected part'],
    ['D', 'Diagnostics panel'],
    ['T', 'Toggle theme'],
    ['Ctrl+Z / Ctrl+Y', 'Undo / redo a parameter change'],
    ['Esc', 'Exit any mode, deselect'],
    ['?', 'This list'],
  ];

  function setViewMode(mode: typeof viewMode) {
    viewMode = mode;
    host?.setViewMode(mode);
  }

  function onParameterInput(id: string, value: number | boolean | string) {
    noteParameterGesture();
    parameterValues = { ...parameterValues, [id]: value };
    host?.setParameter(id, value);
  }

  function onPointerDown(event: PointerEvent) {
    if (!canvasHolder) return;
    const rect = canvasHolder.getBoundingClientRect();
    lastPointer = { x: event.clientX, y: event.clientY };
    // Middle button or shift-drag pans; primary orbits. Matches every 3D tool a learner may have met.
    dragging = event.button === 1 || event.shiftKey ? 'pan' : 'orbit';
    host?.pointer(event.clientX - rect.left, event.clientY - rect.top, 'down');
    (event.target as HTMLElement).setPointerCapture(event.pointerId);
  }

  function onPointerMove(event: PointerEvent) {
    if (!canvasHolder) return;
    const rect = canvasHolder.getBoundingClientRect();

    if (!dragging) {
      host?.pointer(event.clientX - rect.left, event.clientY - rect.top, 'move');
      return;
    }

    const deltaX = event.clientX - lastPointer.x;
    const deltaY = event.clientY - lastPointer.y;
    lastPointer = { x: event.clientX, y: event.clientY };

    if (dragging === 'orbit') host?.orbit(deltaX, deltaY);
    else host?.pan(deltaX, deltaY);
  }

  function onPointerUp(event: PointerEvent) {
    dragging = null;
    if (!canvasHolder) return;
    const rect = canvasHolder.getBoundingClientRect();
    host?.pointer(event.clientX - rect.left, event.clientY - rect.top, 'up');
  }

  function onWheel(event: WheelEvent) {
    event.preventDefault();
    host?.zoom(event.deltaY);
  }

  /** The part the panel is describing: the selection, or whatever the pointer is over. */
  const activePart = $derived(
    manifest?.parts.find((part) => part.id === (selectedPart ?? hoveredPart)) ?? null,
  );

  /** Parts worth listing: named, selectable, and not bare scaffolding. */
  const listedParts = $derived(
    manifest?.parts.filter((part) => part.selectable && part.kind !== 'group').slice(0, 200) ?? [],
  );

  const formatMetric = (id: string): string => {
    const declaration = manifest?.metrics.find((metric) => metric.id === id);
    const value = metrics[id];
    if (value === undefined || !declaration) return '—';
    return `${value.toFixed(declaration.precision)}${declaration.unit ? ` ${declaration.unit}` : ''}`;
  };
</script>

<svelte:head>
  <title>{manifest?.name ?? 'Viewer'} — EDU-3D</title>
</svelte:head>

<div class="viewer">
  <!-- Toolbar -->
  <header class="toolbar glass">
    <button
      class="icon"
      onclick={() => (leftOpen = !leftOpen)}
      aria-label="Toggle parameters panel"
    >
      ☰
    </button>

    <span class="model-name">{manifest?.name ?? 'No model loaded'}</span>

    <div class="spacer"></div>

    <button class="chip" onclick={togglePaused} aria-pressed={paused}>
      {paused ? 'Play' : 'Pause'}
    </button>
    <button class="chip" onclick={() => host?.resetTime()}>Reset</button>

    <div class="modes" role="group" aria-label="View mode">
      {#each [{ id: 'normal', label: 'Solid' }, { id: 'xray', label: 'X-ray' }, { id: 'wireframe', label: 'Wire' }, { id: 'explode', label: 'Explode' }] as mode (mode.id)}
        <button
          class="chip"
          class:active={viewMode === mode.id}
          onclick={() => setViewMode(mode.id as typeof viewMode)}
          aria-pressed={viewMode === mode.id}
        >
          {mode.label}
        </button>
      {/each}
    </div>

    <button class="chip" onclick={() => host?.focusPart(selectedPart)}>Focus</button>
    <button class="chip" onclick={() => host?.requestSnapshot()}>Snapshot</button>

    <select
      class="chip presets"
      aria-label="View preset"
      onchange={(event) => {
        host?.viewPreset(event.currentTarget.value as 'front' | 'back' | 'left' | 'right' | 'top' | 'iso');
        event.currentTarget.selectedIndex = 0;
      }}
    >
      <option value="" disabled selected>Views</option>
      <option value="front">Front</option>
      <option value="back">Back</option>
      <option value="left">Left</option>
      <option value="right">Right</option>
      <option value="top">Top</option>
      <option value="iso">Isometric</option>
    </select>

    <button
      class="chip"
      class:active={activeMode === 'story'}
      onclick={enterStory}
      disabled={!manifest?.story.length}
      title={manifest?.story.length ? 'Play the guided tour' : 'This model has no story beats'}
    >
      Story
    </button>
    <button
      class="chip"
      class:active={activeMode === 'quiz'}
      onclick={() => void enterQuiz()}
      title={manifest?.quiz.length ? `${manifest.quiz.length} authored questions` : 'Questions will be generated for this model'}
    >
      Quiz
    </button>

    <button
      class="chip"
      onclick={undo}
      disabled={undoStack.length === 0}
      title="Undo a parameter change (Ctrl+Z)"
    >
      Undo
    </button>
    <button
      class="chip"
      onclick={redo}
      disabled={redoStack.length === 0}
      title="Redo an undone change (Ctrl+Y)"
    >
      Redo
    </button>

    <button class="chip" onclick={toggleTheme} title="Toggle theme (T)">Theme</button>
    <button
      class="chip"
      onclick={toggleFullscreen}
      title="Fullscreen (F11)"
    >
      Full
    </button>
    <button class="chip" onclick={() => (showHelp = !showHelp)} title="Keyboard shortcuts (?)">?</button>

    <button class="icon" onclick={() => (rightOpen = !rightOpen)} aria-label="Toggle info panel">
      ⓘ
    </button>
  </header>

  <div class="body">
    <!-- Left: parameters and metrics -->
    {#if leftOpen}
      <aside class="panel glass" aria-label="Parameters">
        <h2>Controls</h2>

        {#if !manifest}
          <p class="muted">Waiting for a model.</p>
        {:else if manifest.parameters.length === 0}
          <p class="muted">This model has no adjustable parameters.</p>
        {:else}
          {#each manifest.parameters as parameter (parameter.id)}
            <div class="control">
              <label for={`param-${parameter.id}`}>
                <span>{parameter.label}</span>
                {#if parameter.kind === 'number'}
                  <output>
                    {Number(parameterValues[parameter.id] ?? parameter.default).toFixed(
                      parameter.precision ?? 2,
                    )}{parameter.unit ? ` ${parameter.unit}` : ''}
                  </output>
                {/if}
              </label>

              {#if parameter.kind === 'number'}
                <input
                  id={`param-${parameter.id}`}
                  type="range"
                  min={parameter.min}
                  max={parameter.max}
                  step={parameter.step ?? (parameter.max - parameter.min) / 200}
                  value={Number(parameterValues[parameter.id] ?? parameter.default)}
                  oninput={(event) =>
                    onParameterInput(parameter.id, Number(event.currentTarget.value))}
                />
              {:else if parameter.kind === 'boolean'}
                <input
                  id={`param-${parameter.id}`}
                  type="checkbox"
                  checked={Boolean(parameterValues[parameter.id] ?? parameter.default)}
                  onchange={(event) => onParameterInput(parameter.id, event.currentTarget.checked)}
                />
              {:else if parameter.kind === 'choice'}
                <select
                  id={`param-${parameter.id}`}
                  value={String(parameterValues[parameter.id] ?? parameter.default)}
                  onchange={(event) => onParameterInput(parameter.id, event.currentTarget.value)}
                >
                  {#each parameter.options as option (option.value)}
                    <option value={option.value}>{option.label}</option>
                  {/each}
                </select>
              {:else}
                <input
                  id={`param-${parameter.id}`}
                  type="color"
                  value={String(parameterValues[parameter.id] ?? parameter.default)}
                  oninput={(event) => onParameterInput(parameter.id, event.currentTarget.value)}
                />
              {/if}

              {#if parameter.description}
                <p class="hint">{parameter.description}</p>
              {/if}
            </div>
          {/each}
        {/if}

        {#if manifest && manifest.metrics.length > 0}
          <h2>Read-outs</h2>
          <dl class="metrics">
            {#each manifest.metrics as metric (metric.id)}
              <dt>{metric.label}</dt>
              <dd>
                {formatMetric(metric.id)}
                {#if metric.formula}<span class="formula">{metric.formula}</span>{/if}
              </dd>
            {/each}
          </dl>
        {/if}

        {#if manifest && manifest.colorRoles.length > 0}
          <h2>Legend</h2>
          <ul class="legend">
            {#each manifest.colorRoles as role (role.id)}
              <li>
                <span class="swatch" style={`background:${role.color}`}></span>
                <span><strong>{role.label}</strong> — {role.meaning}</span>
              </li>
            {/each}
          </ul>
        {/if}
      </aside>
    {/if}

    <!-- Centre: the canvas the worker draws into -->
    <main class="stage">
      <div
        class="canvas-holder"
        bind:this={canvasHolder}
        onpointerdown={onPointerDown}
        onpointermove={onPointerMove}
        onpointerup={onPointerUp}
        onpointercancel={onPointerUp}
        onwheel={onWheel}
        role="application"
        aria-label="3D model view. Use the part list to select parts with a keyboard."
      ></div>

      {#if !support.supported}
        <div class="overlay">
          <h2>This browser cannot run the 3D engine</h2>
          <p>{support.reason}</p>
        </div>
      {:else if loading}
        <div class="overlay">
          <p class="pulse">Building the model on your device…</p>
        </div>
      {:else if loadError}
        <div class="overlay">
          <h2>The model could not be built</h2>
          <p>{loadError}</p>
          <button class="chip" onclick={() => host?.reload()}>Try again</button>
        </div>
      {:else if !engineReady}
        <div class="overlay"><p class="pulse">Starting the engine…</p></div>
      {/if}

      {#if hoveredPart && !selectedPart}
        <div class="hover-hint">{manifest?.parts.find((p) => p.id === hoveredPart)?.name}</div>
      {/if}

      {#if activeMode === 'story' && manifest?.story.length}
        <StoryMode
          story={manifest.story}
          onsetParameter={beatSetParameter}
          onfocus={(partId) => host?.focusPart(partId)}
          onclose={() => {
            activeMode = 'none';
            host?.focusPart(null);
          }}
        />
      {/if}

      {#if activeMode === 'quiz' && quizQuestions.length > 0}
        <QuizModal
          questions={quizQuestions}
          source={quizSource}
          onclose={() => (activeMode = 'none')}
        />
      {/if}

      <!-- Toasts -->
      <div class="toasts" aria-live="polite">
        {#each toasts as entry (entry.id)}
          <div class="toast glass">{entry.message}</div>
        {/each}
      </div>
    </main>

    <!-- Right: part info, structure, and the tutor -->
    {#if rightOpen}
      <aside class="panel glass" aria-label="Model information">
        <div class="panel-tabs" role="tablist" aria-label="Panel content">
          <button
            role="tab"
            aria-selected={!chatOpen}
            class:active={!chatOpen}
            onclick={() => (chatOpen = false)}
          >
            Info
          </button>
          <button
            role="tab"
            aria-selected={chatOpen}
            class:active={chatOpen}
            onclick={() => (chatOpen = true)}
          >
            Tutor
          </button>
        </div>

        {#if chatOpen}
          <ChatPanel bind:this={chatPanel} />
        {:else if activePart}
          <h2>{activePart.info?.title ?? activePart.name}</h2>
          {#if activePart.info?.summary}
            <p>{activePart.info.summary}</p>
          {/if}
          {#if activePart.info?.bullets && activePart.info.bullets.length > 0}
            <ul>
              {#each activePart.info.bullets as bullet, index (index)}
                <li>{bullet}</li>
              {/each}
            </ul>
          {/if}
          {#if activePart.info?.facts && activePart.info.facts.length > 0}
            <dl class="facts">
              {#each activePart.info.facts as fact, index (index)}
                <dt>{fact.label}</dt>
                <dd>{fact.value}</dd>
              {/each}
            </dl>
          {/if}
          <button class="chip" onclick={() => host?.focusPart(activePart.id)}
            >Focus this part</button
          >
        {:else if manifest}
          <h2>{manifest.name}</h2>
          <p>{manifest.description}</p>
          <h3>What this teaches</h3>
          <p class="muted">{manifest.pedagogy.concept}</p>
          <ul>
            {#each manifest.pedagogy.objectives as objective, index (index)}
              <li>{objective}</li>
            {/each}
          </ul>
          {#if manifest.pedagogy.simplifications.length > 0}
            <h3>Simplifications</h3>
            <ul class="muted">
              {#each manifest.pedagogy.simplifications as note, index (index)}
                <li>{note}</li>
              {/each}
            </ul>
          {/if}
        {:else}
          <h2>No model</h2>
          <p class="muted">Nothing is loaded yet.</p>
        {/if}

        {#if listedParts.length > 0}
          <h3>Parts</h3>
          <!-- A keyboard-reachable equivalent of clicking the canvas: `08` requires the keyboard path never to
               regress, and a canvas cannot be tabbed into. -->
          <ul class="part-list">
            {#each listedParts as part (part.id)}
              <li>
                <button
                  class="part-button"
                  class:active={selectedPart === part.id}
                  onclick={() => {
                    selectedPart = part.id;
                    host?.focusPart(part.id);
                  }}
                >
                  {part.name}
                </button>
              </li>
            {/each}
          </ul>
        {/if}
      </aside>
    {/if}
  </div>

  <!-- Status bar: every number measured, never estimated -->
  <footer class="statusbar">
    {#if stats}
      <span title="Frames per second, measured over a rolling window"
        >{stats.fps.toFixed(0)} fps</span
      >
      <span title="Draw calls this frame">{stats.drawCalls} draws</span>
      <span title="Triangles this frame">{(stats.triangles / 1000).toFixed(0)}k tris</span>
      <span title="Geometry cache hit rate">{(stats.cacheHitRate * 100).toFixed(0)}% cached</span>
      <span title="Device tier">{stats.effectiveTier}</span>
      <span title="Model time">{stats.simSeconds.toFixed(1)}s</span>
    {:else}
      <span class="muted">engine idle</span>
    {/if}

    <div class="spacer"></div>

    {#if verdict && verdict.adjustments.length > 0}
      <span class="degraded" title={verdict.adjustments.map((a) => a.message).join(' ')}>
        quality adapted
      </span>
    {/if}
    {#if manifest?.physics && !simUnavailable}
      <span title="Physics is simulated">physics on</span>
    {:else if manifest?.physics}
      <span class="muted" title="The solver could not load on this device; the model animates instead">physics unavailable</span>
    {:else}
      <span class="muted" title="This model animates rather than simulating">physics off</span>
    {/if}
    <button class="link" onclick={() => (showDiagnostics = !showDiagnostics)}>diagnostics</button>
  </footer>

  {#if showHelp}
    <section class="help glass" role="dialog" aria-label="Keyboard shortcuts">
      <header class="help-head">
        <h2>Keyboard shortcuts</h2>
        <button class="chip" onclick={() => (showHelp = false)}>Close</button>
      </header>
      <dl class="shortcut-list">
        {#each SHORTCUTS as [keys, action] (keys)}
          <dt><kbd>{keys}</kbd></dt>
          <dd>{action}</dd>
        {/each}
      </dl>
    </section>
  {/if}

  {#if showDiagnostics}
    <section class="diagnostics glass" aria-label="Diagnostics">
      <h2>Diagnostics</h2>
      {#if manifest}
        <p>
          {manifest.cost.parts} parts · {manifest.cost.uniqueGeometries} unique geometries ·
          {manifest.cost.instancedSets} instanced sets · {manifest.cost.instances} instances
        </p>
        <p class="muted">Authoring pass took {manifest.cost.authorMillis} ms on this device.</p>
        {#if manifest.warnings.length > 0}
          <h3>Build warnings</h3>
          <ul>
            {#each manifest.warnings as warning, index (index)}
              <li>{warning}</li>
            {/each}
          </ul>
        {/if}
      {/if}
      {#if verdict && verdict.adjustments.length > 0}
        <h3>Quality adjustments</h3>
        <ul>
          {#each verdict.adjustments as adjustment, index (index)}
            <li>{adjustment.message}{adjustment.saved ? ` (${adjustment.saved})` : ''}</li>
          {/each}
        </ul>
      {/if}
      {#if guestLogs.length > 0}
        <h3>Model output</h3>
        <ul class="logs">
          {#each guestLogs as entry, index (index)}
            <li class={entry.level}>{entry.message}</li>
          {/each}
        </ul>
      {/if}
    </section>
  {/if}
</div>

<style>
  .viewer {
    display: grid;
    grid-template-rows: var(--toolbar-height) 1fr var(--statusbar-height);
    height: 100vh;
    height: 100dvh;
    overflow: hidden;
  }

  .toolbar {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: 0 var(--space-3);
    margin: var(--space-2) var(--space-2) 0;
    border-radius: var(--radius-md);
    z-index: var(--z-toolbar);
  }

  .model-name {
    font-family: var(--font-display);
    font-weight: 600;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 22ch;
  }

  .spacer {
    flex: 1;
  }

  .modes {
    display: flex;
    gap: 2px;
  }

  .chip,
  .icon {
    min-height: 32px;
    padding: var(--space-1) var(--space-3);
    border: 1px solid var(--border);
    border-radius: var(--radius-full);
    background: var(--surface);
    color: var(--text);
    font-size: var(--text-sm);
    transition:
      background-color var(--duration-fast) var(--ease-out),
      border-color var(--duration-fast) var(--ease-out);
  }

  .chip:hover,
  .icon:hover {
    background: var(--surface-hover);
    border-color: var(--accent-ring);
  }

  .chip.active {
    background: var(--accent-soft);
    border-color: var(--accent);
    color: var(--accent);
  }

  .icon {
    padding: var(--space-1) var(--space-2);
  }

  .body {
    display: grid;
    grid-template-columns: auto 1fr auto;
    /* One definite row: without it the row grows to content height, the panels overflow the viewport,
       and the part list's clicks land on the panel chrome instead of the buttons — the row must be
       exactly the space the toolbar and status bar leave. */
    grid-template-rows: minmax(0, 1fr);
    gap: var(--space-2);
    padding: var(--space-2);
    min-height: 0;
  }

  .panel {
    width: var(--panel-width);
    padding: var(--space-4);
    overflow-y: auto;
    /* Constrain to the grid row so the panel scrolls internally instead of stretching it. */
    min-height: 0;
    max-height: 100%;
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }

  .panel h2 {
    font-size: var(--text-lg);
    margin: 0;
  }

  /* The Info/Tutor tabs: one mode at a time inside the right panel (`05`). */
  .panel-tabs {
    display: flex;
    gap: 2px;
    border-bottom: 1px solid var(--border);
    padding-bottom: var(--space-2);
  }

  .panel-tabs button {
    padding: var(--space-1) var(--space-3);
    border-radius: var(--radius-full);
    font-size: var(--text-sm);
    color: var(--text-subtle);
    font-weight: 600;
  }

  .panel-tabs button.active {
    background: var(--accent-soft);
    color: var(--accent);
  }

  .panel h3 {
    font-size: var(--text-sm);
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--text-subtle);
    margin: var(--space-2) 0 0;
  }

  .panel p,
  .panel li {
    font-size: var(--text-sm);
    color: var(--text-muted);
  }

  .muted {
    color: var(--text-subtle);
  }

  .stage {
    position: relative;
    border-radius: var(--radius-lg);
    overflow: hidden;
    background: var(--bg-sunken);
    min-height: 0;
  }

  .canvas-holder {
    position: absolute;
    inset: 0;
    /* The canvas must not intercept text selection during an orbit drag. */
    touch-action: none;
    user-select: none;
    cursor: grab;
  }

  .canvas-holder:active {
    cursor: grabbing;
  }

  .overlay {
    position: absolute;
    inset: 0;
    display: grid;
    place-content: center;
    justify-items: center;
    gap: var(--space-3);
    text-align: center;
    padding: var(--space-5);
    background: color-mix(in oklab, var(--bg) 78%, transparent);
    z-index: var(--z-overlay);
  }

  .pulse {
    color: var(--text-muted);
    animation: pulse 1.6s var(--ease-in-out) infinite;
  }

  @keyframes pulse {
    0%,
    100% {
      opacity: 0.55;
    }
    50% {
      opacity: 1;
    }
  }

  .hover-hint {
    position: absolute;
    bottom: var(--space-4);
    left: 50%;
    transform: translateX(-50%);
    padding: var(--space-1) var(--space-3);
    border-radius: var(--radius-full);
    background: var(--glass-bg);
    border: 1px solid var(--border);
    font-size: var(--text-sm);
    pointer-events: none;
  }

  .toasts {
    position: absolute;
    top: var(--space-3);
    right: var(--space-3);
    display: grid;
    gap: var(--space-2);
    max-width: 26rem;
    z-index: var(--z-toast);
  }

  .toast {
    padding: var(--space-2) var(--space-3);
    font-size: var(--text-sm);
  }

  .control {
    display: grid;
    gap: var(--space-1);
  }

  .control label {
    display: flex;
    justify-content: space-between;
    gap: var(--space-2);
    font-size: var(--text-sm);
    color: var(--text);
  }

  .control output {
    font-family: var(--font-mono);
    color: var(--accent);
  }

  .control input[type='range'] {
    width: 100%;
    /* 44px is the comfortable touch target `08` requires; the visual track stays slim. */
    min-height: var(--touch-target);
    accent-color: var(--accent);
  }

  .hint {
    font-size: var(--text-xs);
    color: var(--text-subtle);
  }

  .metrics,
  .facts {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: var(--space-1) var(--space-3);
    margin: 0;
    font-size: var(--text-sm);
  }

  .metrics dt,
  .facts dt {
    color: var(--text-subtle);
  }

  .metrics dd,
  .facts dd {
    margin: 0;
    font-family: var(--font-mono);
    color: var(--text);
  }

  .formula {
    display: block;
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    color: var(--text-subtle);
  }

  .legend {
    list-style: none;
    padding: 0;
    margin: 0;
    display: grid;
    gap: var(--space-2);
  }

  .legend li {
    display: flex;
    align-items: start;
    gap: var(--space-2);
  }

  .swatch {
    width: 14px;
    height: 14px;
    border-radius: var(--radius-sm);
    flex-shrink: 0;
    margin-top: 2px;
    border: 1px solid var(--border-strong);
  }

  .part-list {
    list-style: none;
    padding: 0;
    margin: 0;
    display: grid;
    gap: 2px;
    /* No inner max-height: the panel itself owns scrolling now, and a nested scroller here both
       collapsed the list's height (children clipped out of layout) and fought the panel's scroll —
       one scroller per column, the panel's. */
  }

  .part-button {
    width: 100%;
    text-align: left;
    padding: var(--space-1) var(--space-2);
    border-radius: var(--radius-sm);
    font-size: var(--text-sm);
    color: var(--text-muted);
  }

  .part-button:hover {
    background: var(--surface-hover);
    color: var(--text);
  }

  .part-button.active {
    background: var(--accent-soft);
    color: var(--accent);
  }

  .statusbar {
    display: flex;
    align-items: center;
    gap: var(--space-4);
    padding: 0 var(--space-4);
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    color: var(--text-subtle);
    border-top: 1px solid var(--border);
  }

  .degraded {
    color: var(--status-warn);
  }

  .link {
    color: var(--text-subtle);
    text-decoration: underline;
    font-size: var(--text-xs);
  }

  .link:hover {
    color: var(--accent);
  }

  .presets {
    padding-right: var(--space-2);
  }

  .help {
    position: fixed;
    inset: 0;
    margin: auto;
    width: min(26rem, calc(100vw - 2 * var(--space-4)));
    height: fit-content;
    padding: var(--space-5);
    z-index: var(--z-modal);
  }

  .help-head {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: var(--space-3);
  }

  .shortcut-list {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: var(--space-2) var(--space-4);
    margin: 0;
    font-size: var(--text-sm);
  }

  .shortcut-list kbd {
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-sm);
    padding: 0.0625rem 0.5rem;
    color: var(--text-muted);
  }

  .shortcut-list dd {
    margin: 0;
    color: var(--text-muted);
  }

  .diagnostics {
    position: fixed;
    right: var(--space-3);
    bottom: calc(var(--statusbar-height) + var(--space-3));
    width: min(34rem, calc(100vw - 2 * var(--space-3)));
    max-height: 60vh;
    overflow-y: auto;
    padding: var(--space-4);
    z-index: var(--z-modal);
    font-size: var(--text-sm);
  }

  .logs {
    list-style: none;
    padding: 0;
    margin: 0;
    font-family: var(--font-mono);
    font-size: var(--text-xs);
  }

  .logs .error {
    color: var(--status-error);
  }

  .logs .warn {
    color: var(--status-warn);
  }

  /*
    Phone layout. `08`: the three-panel viewer collapses to a single column, the canvas owns the screen, and panels
    become sheets. This is the compact variant; the full sheet behaviour lands with the mobile pass.
  */
  @media (max-width: 860px) {
    .body {
      grid-template-columns: 1fr;
      grid-template-rows: 1fr;
    }

    .panel {
      position: absolute;
      inset: auto var(--space-2) calc(var(--statusbar-height) + var(--space-2)) var(--space-2);
      width: auto;
      max-height: 45vh;
      z-index: var(--z-panel);
    }

    .modes {
      display: none;
    }
  }
</style>
