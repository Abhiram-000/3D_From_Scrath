<!--
  The viewer — an exact V1 port.

  Markup mirrors index.html class-for-class: .app-container → .top-toolbar (brand + grouped
  .control-group buttons with separators) → .content-area (.left-panel with Parameters/AI Chat tabs,
  .viewport-container with the canvas + tooltip + story subtitle overlay, .right-panel with the
  Information sections) → .bottom-bar stats. Modals: quiz, shortcuts, settings (presets), share
  (link + QR + social), export, AI output. The stylesheets are V1's styles.css and ui-extended.css
  verbatim, imported globally; the engine wiring (SandboxHost, contracts) is ours.

  `03`'s rules that V1's markup already carries structurally: the shell boots with a dead engine;
  every toolbar button has a tooltip and a shortcut; the canvas is aria-hidden because the part list
  is the keyboard path; all model-authored text renders as text nodes.
-->
<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import type { ModelManifest, QuizQuestion, RuntimeStats } from '@edu3d/contracts';
  import { REFERENCE_MODEL_SOURCE } from '@edu3d/engine';
  import { SandboxHost, sandboxSupported, type HostCallbacks } from '$lib/engine/sandbox-host.ts';
  import type { SerializableVerdict } from '$lib/engine/sandbox-worker.ts';
  import { apiFetch, takeBundle, storedRuntime } from '$lib/core/api.ts';
  import { panelShowsSelectedPart } from '$lib/components/panel-branch.ts';
  import { shouldSendPointerNow, toCanvasPoint, type RectLike } from '$lib/core/pointer.ts';
  import { anyOverlayOpen, shouldPauseRender } from '$lib/core/render-pause.ts';
  import { toContext } from '$lib/core/model-context.ts';
  import { Ambient, getTheme, setTheme } from '$lib/ambient.ts';
  // V1's viewer stylesheets, verbatim (app shell + extended modals).
  import '$lib/styles/viewer.css';
  import '$lib/styles/viewer-extended.css';
  import ChatPanel from '$lib/components/chat-panel-v1.svelte';
  import QuizModal from '$lib/components/quiz-modal-v1.svelte';
  import StoryMode from '$lib/components/story-mode.svelte';
  import ShareModal from '$lib/components/share-modal.svelte';
  import CodeViewModal from '$lib/components/code-view-modal.svelte';
  import GalleryModal from '$lib/components/gallery-modal.svelte';
  import GenerateDialog from '$lib/components/generate-dialog.svelte';

  // ── View state ────────────────────────────────────────────────────────────
  let canvasHolder = $state<HTMLElement | null>(null);
  let host: SandboxHost | null = null;

  let support = $state<{ supported: boolean; reason?: string }>({ supported: true });
  let engineReady = $state(false);
  /** A mid-session model swap: the engine is up, a new model is authoring + realizing. */
  let modelLoading = $state(false);
  let loadError = $state<string | null>(null);

  // All five below are `$state.raw` deliberately. Every one is assigned a fresh value on write and
  // never mutated in place — `parameterValues` spreads on each of its three write sites — so the deep
  // proxy `$state` builds bought nothing and charged a `get` trap for every property read. That
  // matters most on `manifest`: the parts array can be hundreds of entries, the tooltip and panel read
  // it on every hover change, and `code-view-modal` stringifies it, which through a proxy walks every
  // scalar leaf through a trap.
  //
  // `$state.raw` tracks reassignment only. If any of these ever needs an in-place write it must go back
  // to `$state`, or the change will be silently invisible.
  //
  // Deliberately NOT `progress` in loading/+page.svelte or generate-dialog.svelte: ProgressModel is a
  // class whose `index` is mutated in place and read back through getters, and `.raw` would freeze the
  // stage chips without any error.
  let manifest = $state.raw<ModelManifest | null>(null);
  let verdict = $state.raw<SerializableVerdict | null>(null);
  let stats = $state.raw<RuntimeStats | null>(null);
  let metrics = $state.raw<Record<string, number>>({});
  let parameterValues = $state.raw<Record<string, number | boolean | string>>({});

  let hoveredPart = $state<string | null>(null);
  let selectedPart = $state<string | null>(null);
  let paused = $state(false);
  let viewMode = $state<'normal' | 'xray' | 'wireframe' | 'explode'>('normal');

  // V1 shell state
  let leftOpen = $state(true);
  let rightOpen = $state(true);
  let activeTab = $state<'parameters' | 'aichat'>('parameters');
  let activeMode = $state<'none' | 'story' | 'quiz'>('none');
  let topicName = $state('Loading...');
  let deviceTier = $state('');
  let theme = $state<'dark' | 'light'>('dark');

  // Pointer/orbit state
  let dragging: 'orbit' | 'pan' | null = null;
  let lastPointer = { x: 0, y: 0 };
  // Plain, non-reactive: the canvas rect and the coalesced hover sample are consumed by pointer
  // handlers and nothing in the template ever reads them, so a proxy here would only cost.
  let canvasRect: RectLike | null = null;
  let pendingHover: { x: number; y: number } | null = null;
  let hoverFrame: number | null = null;

  // Dropdown / modals (V1 modal set)
  let viewPresetsOpen = $state(false);
  let quizModalOpen = $state(false);
  let shortcutsModalOpen = $state(false);
  let shareModalOpen = $state(false);
  let galleryOpen = $state(false);
  let generateOpen = $state(false);
  let codeViewModalOpen = $state(false);
  let codeViewTab = $state<'raw' | 'spec'>('raw');
  let quizQuestions = $state<QuizQuestion[]>([]);
  let quizSource = $state<'authored' | 'generated'>('authored');

  let ambient: Ambient | null = null;

  // Toasts (V1-style, top-right, slide-in)
  let toasts = $state<Array<{ id: number; message: string }>>([]);
  let toastSeq = 0;

  function toast(message: string) {
    const id = (toastSeq += 1);
    toasts = [...toasts, { id, message }];
    setTimeout(() => {
      toasts = toasts.filter((entry) => entry.id !== id);
    }, 4500);
  }

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
      modelLoading = false;
      manifest = loadedManifest;
      verdict = loadedVerdict;

      loadError = null;
      topicName = loadedManifest.name;
      const defaults: Record<string, number | boolean | string> = {};
      for (const parameter of loadedManifest.parameters) defaults[parameter.id] = parameter.default;
      parameterValues = defaults;
      // A model swap unloads the previous model's modes (`05`).
      unloadModes();
    },
    onLoadFailed: (message, timedOut) => {
      modelLoading = false;

      loadError = timedOut ? `${message} (it ran too long and was stopped)` : message;
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
      if (level === 'error') console.error(`[model] ${message}`);
    },
    onNotice: (message) => toast(message),
    onKilled: (reason) => {
      manifest = null;
      stats = null;
      loadError = reason;
      toast(reason);
    },
    onSnapshot: (blob) => {
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `${manifest?.name ?? 'model'}.png`;
      link.click();
      URL.revokeObjectURL(url);
      toast('Screenshot saved.');
    },
  };

  onMount(() => {
    support = sandboxSupported();
    theme = getTheme();
    if (!support.supported || !canvasHolder) return;

    // The viewer is chrome-heavy and has no cursor system. `blobs: false` matters more than it looks:
    // the ambient blobs are blur(60px) on ~780px surfaces, and this page has an opaque WebGL canvas
    // underneath them, where a non-integer animated scale forces the blur to re-rasterise on every
    // presented frame. Passing only grid/spotlight left them created anyway.
    ambient = new Ambient({ grid: false, spotlight: false, blobs: false });
    ambient.mount();

    host = new SandboxHost(canvasHolder, callbacks);
    host.start();
    host.setTheme(readThemeColors());
    deviceTier = host.deviceTier;

    (window as unknown as Record<string, unknown>).__edu3dHost = Object.freeze({
      load: (code: string, seed?: number) => host?.load(code, seed),
      kill: (reason: string) => host?.kill(reason),
    });

    // The canvas is `position: absolute; inset: 0`, so its rect changes only on a resize — which is
    // exactly what this observer already watches. Caching it here removes a layout query from every
    // pointermove.
    canvasRect = canvasHolder.getBoundingClientRect();
    const observer = new ResizeObserver(() => {
      canvasRect = canvasHolder?.getBoundingClientRect() ?? null;
      host?.resize();
    });
    observer.observe(canvasHolder);

    // `03` R2's priority order: shared link → session spec → on-disk fallback.

    const sharedId = new URLSearchParams(window.location.search).get('model');
    const generated = takeBundle();
    if (sharedId) {
      void loadFromGallery(sharedId);
    } else if (generated) {
      // The stored raw bundle carries the instrumented twin of code; loading it is what gives the
      // model its browser-side loop guard.
      host.load(generated.code, 7, storedRuntime(generated));
      topicName =
        typeof (generated.manifest as { name?: string })?.name === 'string'
          ? (generated.manifest as { name: string }).name
          : 'Generated model';
    } else {
      host.load(REFERENCE_MODEL_SOURCE, 7);
    }

    const onKeyDown = (event: KeyboardEvent) => {
      // Shortcuts never fire while typing in a field (`03`).
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
        case 'v':
          host?.viewPreset('iso');
          break;
        case '1':
          host?.viewPreset('front');
          break;
        case '2':
          host?.viewPreset('back');
          break;
        case '3':
          host?.viewPreset('left');
          break;
        case '4':
          host?.viewPreset('right');
          break;
        case '5':
          host?.viewPreset('top');
          break;
        case '6':
          host?.viewPreset('iso');
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
          toggleFullscreen();
          break;
        case 'g':
          codeViewModalOpen = true;
          break;
        case 't':
          toggleTheme();
          break;
        case '?':
          shortcutsModalOpen = !shortcutsModalOpen;
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
        case 'escape':
          if (
            quizModalOpen ||
            shortcutsModalOpen ||
            shareModalOpen ||
            codeViewModalOpen ||
            galleryOpen ||
            generateOpen
          ) {
            quizModalOpen = shortcutsModalOpen = shareModalOpen = codeViewModalOpen = false;
            galleryOpen = generateOpen = false;
          } else if (activeMode !== 'none') {
            activeMode = 'none';
          } else {
            selectedPart = null;
            setViewMode('normal');
          }
          break;
        default:
          break;
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => {
      observer.disconnect();
      window.removeEventListener('keydown', onKeyDown);
      ambient?.destroy();
    };
  });

  onDestroy(() => {
    cancelPendingHover();
    // The handle closes over a SandboxHost that is about to be disposed. Leaving it on `window`
    // means a later caller would postMessage to a terminated worker.
    delete (window as unknown as { __edu3dHost?: unknown }).__edu3dHost;
    host?.dispose();
    host = null;
  });

  async function loadFromGallery(id: string) {
    const result = await apiFetch<{ bundle: { code?: string; runtime?: string } }>(
      `/gallery/${encodeURIComponent(id)}`,
    );
    if (result.ok && result.data.bundle?.code) {
      // Entries published before the guard carry no runtime; they load clean, as they always did.
      host?.load(result.data.bundle.code, 7, result.data.bundle.runtime);
      return;
    }
    toast('That shared model could not be loaded; showing the reference model instead.');
    host?.load(REFERENCE_MODEL_SOURCE, 7);
  }

  function togglePaused() {
    paused = !paused;
    host?.setPaused(paused);
  }

  function setViewMode(mode: typeof viewMode) {
    viewMode = mode;
    host?.setViewMode(mode);
  }

  function toggleTheme() {
    theme = setTheme(theme === 'dark' ? 'light' : 'dark');
    host?.setTheme(readThemeColors());
  }

  function toggleFullscreen() {
    if (document.fullscreenElement) void document.exitFullscreen();
    else
      void document.documentElement
        .requestFullscreen()
        .catch(() => toast('Fullscreen is not available here.'));
  }

  function onParameterInput(id: string, value: number | boolean | string) {
    noteParameterGesture();
    parameterValues = { ...parameterValues, [id]: value };
    host?.setParameter(id, value);
  }

  // ── Undo/redo: one step per gesture (`03` R4) ──────────────────────────────
  type ParamSnapshot = Record<string, number | boolean | string>;
  let undoStack = $state<ParamSnapshot[]>([]);
  let redoStack = $state<ParamSnapshot[]>([]);
  let gestureOpen = false;
  let gestureTimer: ReturnType<typeof setTimeout> | null = null;

  function noteParameterGesture() {
    if (!gestureOpen) {
      gestureOpen = true;
      undoStack = [...undoStack.slice(-49), { ...parameterValues }];
      redoStack = [];
    }
    if (gestureTimer) clearTimeout(gestureTimer);
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

  function applySnapshot(snapshot: ParamSnapshot) {
    parameterValues = { ...snapshot };
    for (const [id, value] of Object.entries(snapshot)) host?.setParameter(id, value);
  }

  // ── Modes ─────────────────────────────────────────────────────────────────
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

  async function enterQuiz() {
    if (activeMode === 'quiz') {
      activeMode = 'none';
      return;
    }
    if (manifest && manifest.quiz.length > 0) {
      quizSource = 'authored';
      quizQuestions = manifest.quiz;
      activeMode = 'quiz';
      quizModalOpen = true;
      return;
    }
    if (!manifest) return;
    quizSource = 'generated';
    const result = await apiFetch<{ questions: QuizQuestion[]; dropped: number }>('/quiz', {
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
      activeMode = 'quiz';
      quizModalOpen = true;
    } else {
      toast('Quiz generation is unavailable right now.');
    }
  }

  function beatSetParameter(id: string, value: number | boolean | string) {
    parameterValues = { ...parameterValues, [id]: value };
    host?.setParameter(id, value);
  }

  async function shareModel() {
    if (!manifest) return;
    shareModalOpen = true;
  }

  /** A generated or gallery model lands through the same atomic swap as every load (`03` R2). */
  function swapInModel(code: string, name: string, runtime?: string) {
    modelLoading = true;
    loadError = null;
    topicName = name;
    generateOpen = false;
    galleryOpen = false;
    host?.load(code, Math.floor(Math.random() * 0xffffffff), runtime);
  }

  // ── Derived data ──────────────────────────────────────────────────────────
  // An id → part index, built once per manifest. The tooltip and the panel each looked a part up
  // with a linear `.find()` per read, and each of those reads walked a Svelte deep proxy, so a
  // single hover change cost several full scans of the parts array.
  const partsById = $derived(new Map((manifest?.parts ?? []).map((part) => [part.id, part])));

  const metricsById = $derived(
    new Map((manifest?.metrics ?? []).map((metric) => [metric.id, metric])),
  );

  const activePart = $derived(partsById.get(selectedPart ?? hoveredPart ?? '') ?? null);

  const listedParts = $derived(
    manifest?.parts.filter((part) => part.selectable && part.kind !== 'group').slice(0, 200) ?? [],
  );

  const selectedPartInfo = $derived(
    activePart
      ? {
          title: activePart.info?.title ?? activePart.name,
          summary: activePart.info?.summary ?? '',
          bullets: activePart.info?.bullets ?? [],
          facts: activePart.info?.facts ?? [],
        }
      : null,
  );

  const overviewHtmlSafe = $derived(
    manifest
      ? {
          name: manifest.name,
          description: manifest.description,
          concept: manifest.pedagogy.concept,
          objectives: manifest.pedagogy.objectives,
          simplifications: manifest.pedagogy.simplifications,
        }
      : null,
  );

  const formatMetric = (id: string): string => {
    const declaration = metricsById.get(id);
    const value = metrics[id];
    if (value === undefined || !declaration) return '—';
    return `${value.toFixed(declaration.precision)}${declaration.unit ? ` ${declaration.unit}` : ''}`;
  };

  const formatTime = (seconds: number): string => {
    const minutes = Math.floor(seconds / 60);
    const rest = Math.floor(seconds % 60);
    return `${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}`;
  };

  const VIEW_PRESETS = [
    { id: 'front', label: 'Front' },
    { id: 'back', label: 'Back' },
    { id: 'left', label: 'Left' },
    { id: 'right', label: 'Right' },
    { id: 'top', label: 'Top' },
    { id: 'bottom', label: 'Bottom' },
    { id: 'iso', label: 'Isometric' },
  ] as const;

  const SHORTCUT_CATEGORIES: ReadonlyArray<{
    title: string;
    items: ReadonlyArray<[string, string]>;
  }> = [
    {
      title: 'Playback',
      items: [
        ['Space', 'Play / Pause'],
        ['R', 'Reset'],
        ['V', 'Reset View'],
      ],
    },
    {
      title: 'Views',
      items: [
        ['1', 'Front View'],
        ['2', 'Back View'],
        ['3', 'Left View'],
        ['4', 'Right View'],
        ['5', 'Top View'],
        ['6', 'Isometric View'],
      ],
    },
    {
      title: 'Display Modes',
      items: [
        ['F', 'Fullscreen'],
        ['X', 'X-ray Mode'],
        ['W', 'Wireframe Mode'],
        ['E', 'Explode View'],
      ],
    },
    {
      title: 'Modes',
      items: [
        ['G', 'AI Output'],
        ['S', 'Story Mode'],
      ],
    },
    {
      title: 'Actions',
      items: [
        ['Ctrl+Z', 'Undo'],
        ['Ctrl+Y', 'Redo'],
      ],
    },
    {
      title: 'General',
      items: [
        ['T', 'Toggle Theme'],
        ['?', 'Show Shortcuts'],
        ['Esc', 'Close Modal'],
      ],
    },
  ];

  /**
   * Stop the engine while an overlay is open.
   *
   * `viewer.css` documents this - "the engine's render loop is stopped while it is open" - and no
   * handler implemented it. The worker kept presenting frames behind a modal whose overlay the
   * compositor was re-filtering every frame, which is the freeze that comment was written about.
   *
   * An effect rather than a call in each of the fifteen places a modal flag is assigned, because a
   * missed site is a missed pause and nothing would say so. It reads every flag AND `paused`, so it
   * re-runs when the learner pauses or resumes too — which is what makes it impossible to latch, and
   * impossible for one modal's pause to survive into the next model.
   */
  $effect(() => {
    const overlayOpen = anyOverlayOpen({
      quizModalOpen,
      shortcutsModalOpen,
      shareModalOpen,
      galleryOpen,
      generateOpen,
      codeViewModalOpen,
      viewPresetsOpen,
    });
    // Read both before acting, so the dependency set includes them.
    const requestedPause = shouldPauseRender(overlayOpen, paused);
    if (!engineReady) return;
    host?.setPaused(requestedPause);
  });

  // ── Pointer handlers (V1: primary orbits, middle/shift pans) ──────────────
  /**
   * One place that decides whether a pointer sample goes out now or waits for the next frame.
   *
   * `down` and `up` always go immediately: the learner acted on the pose they saw, and deferring a
   * click by a frame is perceptible. `move` waits, because the worker already collapses hover
   * raycasts to one per frame — every extra message is a structured clone plus a task competing with
   * the render loop for the worker's event loop.
   */
  function dispatchPointer(kind: 'move' | 'down' | 'up', clientX: number, clientY: number): void {
    if (!canvasRect) return;
    const point = toCanvasPoint(clientX, clientY, canvasRect);
    if (shouldSendPointerNow(kind)) {
      cancelPendingHover();
      host?.pointer(point.x, point.y, kind);
      return;
    }
    pendingHover = point;
    if (hoverFrame === null) hoverFrame = requestAnimationFrame(flushHover);
  }

  function flushHover(): void {
    hoverFrame = null;
    if (!pendingHover) return;
    const { x, y } = pendingHover;
    pendingHover = null;
    host?.pointer(x, y, 'move');
  }

  function cancelPendingHover(): void {
    pendingHover = null;
    if (hoverFrame !== null) {
      cancelAnimationFrame(hoverFrame);
      hoverFrame = null;
    }
  }

  function onPointerDown(event: PointerEvent) {
    if (!canvasHolder) return;
    cancelPendingHover();
    lastPointer = { x: event.clientX, y: event.clientY };
    dragging = event.button === 1 || event.shiftKey ? 'pan' : 'orbit';
    dispatchPointer('down', event.clientX, event.clientY);
    (event.target as HTMLElement).setPointerCapture(event.pointerId);
  }

  function onPointerMove(event: PointerEvent) {
    if (!canvasHolder) return;
    if (!dragging) {
      dispatchPointer('move', event.clientX, event.clientY);
      return;
    }
    const deltaX = event.clientX - lastPointer.x;
    const deltaY = event.clientY - lastPointer.y;
    lastPointer = { x: event.clientX, y: event.clientY };
    if (dragging === 'orbit') host?.orbit(deltaX, deltaY);
    else host?.pan(deltaX, deltaY);
  }

  /**
   * Release. Bound to `pointercancel` as well as `pointerup`: a cancelled pointer capture never
   * delivers an `up`, so without this the drag flag would stay set and the camera would keep
   * orbiting for the rest of the session.
   */
  function onPointerUp(event: PointerEvent) {
    dragging = null;
    cancelPendingHover();
    if (!canvasHolder) return;
    dispatchPointer('up', event.clientX, event.clientY);
  }

  function onWheel(event: WheelEvent) {
    event.preventDefault();
    host?.zoom(event.deltaY);
  }
</script>

<svelte:head>
  <title>{manifest?.name ?? 'Viewer'} — EDU-3D</title>
</svelte:head>

<div class="app-container">
  <!-- ── Top Toolbar ──────────────────────────────────────────────────────── -->
  <header class="top-toolbar glass-panel">
    <div class="toolbar-brand">
      <div class="brand-icon">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
          <path
            d="M12 2L2 7L12 12L22 7L12 2Z"
            stroke="currentColor"
            stroke-width="2"
            stroke-linejoin="round"
          />
          <path
            d="M2 17L12 22L22 17"
            stroke="currentColor"
            stroke-width="2"
            stroke-linejoin="round"
          />
          <path
            d="M2 12L12 17L22 12"
            stroke="currentColor"
            stroke-width="2"
            stroke-linejoin="round"
          />
        </svg>
      </div>
      <span class="brand-text">EDU-3D</span>
      <span class="topic-separator">›</span>
      <span class="topic-name">{topicName}</span>
    </div>

    <nav class="toolbar-controls">
      <!-- Playback -->
      <div class="control-group">
        <button
          class="toolbar-btn toggle-btn"
          id="btnPlayPause"
          title="Play/Pause (Space)"
          onclick={togglePaused}
        >
          <div class:icon-play={!paused} class:hidden-icon={paused}>
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"
              ><path d="M3 2L13 8L3 14V2Z" /></svg
            >
          </div>
          <div class:icon-pause={paused} class:hidden-icon={!paused}>
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"
              ><rect x="4" y="2" width="3" height="12" /><rect
                x="9"
                y="2"
                width="3"
                height="12"
              /></svg
            >
          </div>
          <span>{paused ? 'Play' : 'Pause'}</span>
        </button>
        <button class="toolbar-btn" title="Reset (R)" onclick={() => host?.resetTime()}>
          <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"
            ><path
              d="M8 2C4.7 2 2 4.7 2 8s2.7 6 6 6 6-2.7 6-6h-2c0 2.2-1.8 4-4 4s-4-1.8-4-4 1.8-4 4-4V2z"
            /><path d="M8 2L11 5L8 8V2Z" /></svg
          >
          <span>Reset</span>
        </button>
        <button class="toolbar-btn" title="Reset View (V)" onclick={() => host?.viewPreset('iso')}>
          <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"
            ><rect
              x="2"
              y="2"
              width="12"
              height="12"
              rx="1"
              fill="none"
              stroke="currentColor"
              stroke-width="1.5"
            /><circle cx="8" cy="8" r="3" /></svg
          >
          <span>Reset View</span>
        </button>
        <button class="toolbar-btn" title="Take Screenshot" onclick={() => host?.requestSnapshot()}>
          <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"
            ><rect
              x="2"
              y="4"
              width="12"
              height="9"
              rx="1"
              fill="none"
              stroke="currentColor"
              stroke-width="1.5"
            /><circle cx="8" cy="9" r="2" /><rect x="6" y="2" width="4" height="2" rx="0.5" /></svg
          >
          <span>Screenshot</span>
        </button>
      </div>

      <!-- View Presets dropdown -->
      <div class="control-group">
        <div class="dropdown-wrapper">
          <button
            class="toolbar-btn dropdown-trigger"
            title="View Presets"
            onclick={() => (viewPresetsOpen = !viewPresetsOpen)}
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"
              ><path d="M8 3L12 8L8 13L4 8L8 3Z" /></svg
            >
            <span>View</span>
            <svg
              class="dropdown-arrow"
              width="12"
              height="12"
              viewBox="0 0 12 12"
              fill="currentColor"><path d="M6 8L2 4h8L6 8Z" /></svg
            >
          </button>
          <div class="dropdown-menu glass-panel" class:active={viewPresetsOpen}>
            {#each VIEW_PRESETS as preset (preset.id)}
              <button
                class="dropdown-item"
                onclick={() => {
                  host?.viewPreset(preset.id);
                  viewPresetsOpen = false;
                }}
              >
                {preset.label}
              </button>
            {/each}
          </div>
        </div>
      </div>

      <!-- Content -->
      <div class="control-group">
        <button
          class="toolbar-btn primary-action"
          title="Generate a model with AI (G)"
          onclick={() => (generateOpen = true)}
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"
            ><path d="M8 1l1.6 3.9L13.5 6.5 9.6 8.1 8 12 6.4 8.1 2.5 6.5 6.4 4.9 8 1z" /><circle
              cx="12.5"
              cy="12.5"
              r="1.5"
            /></svg
          >
          <span>Generate</span>
        </button>
        <button
          class="toolbar-btn"
          title="Browse the gallery (Ctrl+G)"
          onclick={() => (galleryOpen = true)}
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            stroke-width="1.5"
            ><rect x="2" y="3" width="5" height="5" /><rect x="9" y="3" width="5" height="5" /><rect
              x="2"
              y="10"
              width="5"
              height="3"
            /><rect x="9" y="10" width="5" height="3" /></svg
          >
          <span>Gallery</span>
        </button>
        <button class="toolbar-btn" title="Publish this model (Ctrl+P)" onclick={shareModel}>
          <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"
            ><path d="M8 2l4 4h-2.5v5h-3V6H4l4-4z" /><rect
              x="3"
              y="12"
              width="10"
              height="2"
              rx="1"
            /></svg
          >
          <span>Publish</span>
        </button>
      </div>

      <!-- Modes -->
      <div class="control-group">
        <button
          class="toolbar-btn mode-btn"
          class:active={activeMode === 'story'}
          title="Story Mode (S)"
          onclick={enterStory}
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"
            ><path
              d="M3 2h10a1 1 0 011 1v10a1 1 0 01-1 1H3a1 1 0 01-1-1V3a1 1 0 011-1z"
              fill="none"
              stroke="currentColor"
              stroke-width="1.5"
            /><path d="M5 6h6M5 9h4" /></svg
          >
          <span>Story</span>
        </button>
        <button
          class="toolbar-btn mode-btn"
          class:active={activeMode === 'quiz'}
          title="Quiz Mode"
          onclick={() => void enterQuiz()}
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"
            ><circle
              cx="8"
              cy="8"
              r="6"
              fill="none"
              stroke="currentColor"
              stroke-width="1.5"
            /><text
              x="8"
              y="11"
              text-anchor="middle"
              font-size="8"
              font-weight="bold"
              fill="currentColor">?</text
            ></svg
          >
          <span>Quiz</span>
        </button>
      </div>

      <!-- Display modes -->
      <div class="control-group">
        <button class="toolbar-btn toggle-btn" title="Fullscreen (F)" onclick={toggleFullscreen}>
          <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"
            ><path
              d="M2 2h4v2H4v2H2V2zM10 2h4v4h-2V4h-2V2zM2 10h2v2h2v2H2v-4zM12 12h-2v2h4v-4h-2v2z"
            /></svg
          >
          <span>Fullscreen</span>
        </button>
        <button
          class="toolbar-btn toggle-btn"
          class:active={viewMode === 'xray'}
          title="X-ray Mode (X)"
          onclick={() => setViewMode(viewMode === 'xray' ? 'normal' : 'xray')}
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"
            ><circle
              cx="8"
              cy="8"
              r="6"
              fill="none"
              stroke="currentColor"
              stroke-width="1.5"
              opacity="0.5"
            /><circle cx="8" cy="8" r="3" fill="currentColor" opacity="0.7" /></svg
          >
          <span>X-ray</span>
        </button>
        <button
          class="toolbar-btn toggle-btn"
          class:active={viewMode === 'wireframe'}
          title="Wireframe (W)"
          onclick={() => setViewMode(viewMode === 'wireframe' ? 'normal' : 'wireframe')}
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            stroke-width="1.5"
            ><rect x="3" y="3" width="10" height="10" /><line x1="3" y1="8" x2="13" y2="8" /><line
              x1="8"
              y1="3"
              x2="8"
              y2="13"
            /></svg
          >
          <span>Wireframe</span>
        </button>
        <button
          class="toolbar-btn toggle-btn"
          class:active={viewMode === 'explode'}
          title="Explode View (E)"
          onclick={() => setViewMode(viewMode === 'explode' ? 'normal' : 'explode')}
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"
            ><circle cx="8" cy="8" r="1.5" /><circle cx="3" cy="3" r="1" opacity="0.7" /><circle
              cx="13"
              cy="3"
              r="1"
              opacity="0.7"
            /><circle cx="3" cy="13" r="1" opacity="0.7" /><circle
              cx="13"
              cy="13"
              r="1"
              opacity="0.7"
            /><line
              x1="8"
              y1="8"
              x2="3"
              y2="3"
              stroke="currentColor"
              stroke-width="1"
              opacity="0.5"
            /><line
              x1="8"
              y1="8"
              x2="13"
              y2="3"
              stroke="currentColor"
              stroke-width="1"
              opacity="0.5"
            /><line
              x1="8"
              y1="8"
              x2="3"
              y2="13"
              stroke="currentColor"
              stroke-width="1"
              opacity="0.5"
            /><line
              x1="8"
              y1="8"
              x2="13"
              y2="13"
              stroke="currentColor"
              stroke-width="1"
              opacity="0.5"
            /></svg
          >
          <span>Explode</span>
        </button>
      </div>

      <!-- Panels -->
      <div class="control-group">
        <button
          class="toolbar-btn toggle-btn"
          class:active={leftOpen}
          title="Toggle Left Panel"
          onclick={() => (leftOpen = !leftOpen)}
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"
            ><rect x="2" y="2" width="5" height="12" rx="1" /><rect
              x="9"
              y="2"
              width="5"
              height="12"
              rx="1"
              opacity="0.3"
            /></svg
          >
          <span>Left Panel</span>
        </button>
        <button
          class="toolbar-btn toggle-btn"
          class:active={rightOpen}
          title="Toggle Right Panel"
          onclick={() => (rightOpen = !rightOpen)}
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"
            ><rect x="2" y="2" width="5" height="12" rx="1" opacity="0.3" /><rect
              x="9"
              y="2"
              width="5"
              height="12"
              rx="1"
            /></svg
          >
          <span>Right Panel</span>
        </button>
      </div>

      <!-- Undo/Redo -->
      <div class="control-group">
        <button
          class="toolbar-btn"
          title="Undo (Ctrl+Z)"
          disabled={undoStack.length === 0}
          onclick={undo}
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"
            ><path d="M4 8l4-4v3h4a3 3 0 010 6H8v-2h4a1 1 0 000-2H8v3l-4-4z" /></svg
          >
          <span>Undo</span>
        </button>
        <button
          class="toolbar-btn"
          title="Redo (Ctrl+Y)"
          disabled={redoStack.length === 0}
          onclick={redo}
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"
            ><path d="M12 8l-4-4v3H4a3 3 0 000 6h4v-2H4a1 1 0 010-2h4v3l4-4z" /></svg
          >
          <span>Redo</span>
        </button>
      </div>

      <!-- Additional -->
      <div class="control-group">
        <button class="toolbar-btn" title="Toggle Theme (T)" onclick={toggleTheme}>
          <svg class="icon-sun" width="16" height="16" viewBox="0 0 16 16" fill="currentColor"
            ><circle cx="8" cy="8" r="3" /><path
              d="M8 1v2M8 13v2M1 8h2M13 8h2M3.05 3.05l1.41 1.41M11.54 11.54l1.41 1.41M3.05 12.95l1.41-1.41M11.54 4.46l1.41-1.41"
              stroke="currentColor"
              stroke-width="1.5"
              fill="none"
            /></svg
          >
          <svg class="icon-moon" width="16" height="16" viewBox="0 0 16 16" fill="currentColor"
            ><path
              d="M13.5 8a5.5 5.5 0 01-9.14 4.14A5.5 5.5 0 018 2.5a4 4 0 000 11 4 4 0 01-1.14-7.86A5.49 5.49 0 0113.5 8z"
            /></svg
          >
          <span>Theme</span>
        </button>
        <button class="toolbar-btn" title="Share Blueprint" onclick={shareModel}>
          <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"
            ><circle cx="12" cy="4" r="2" /><circle cx="4" cy="8" r="2" /><circle
              cx="12"
              cy="12"
              r="2"
            /><path
              d="M6 7l4-2M6 9l4 2"
              stroke="currentColor"
              stroke-width="1.5"
              fill="none"
            /></svg
          >
          <span>Share</span>
        </button>
        <button
          class="toolbar-btn"
          title="View the AI's output for this model"
          onclick={() => (codeViewModalOpen = true)}
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            stroke-width="1.5"><path d="M5.5 4L2 8l3.5 4M10.5 4L14 8l-3.5 4" /></svg
          >
          <span>AI Output</span>
        </button>
        <button
          class="toolbar-btn"
          title="Keyboard Shortcuts (?)"
          onclick={() => (shortcutsModalOpen = true)}
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"
            ><circle
              cx="8"
              cy="8"
              r="6"
              fill="none"
              stroke="currentColor"
              stroke-width="1.5"
            /><text x="8" y="11" text-anchor="middle" font-size="8" font-weight="bold">?</text></svg
          >
          <span>Help</span>
        </button>
      </div>
    </nav>
  </header>

  <!-- ── Main Content Area ────────────────────────────────────────────────── -->
  <main class="content-area">
    <!-- Left Panel -->
    <aside class="left-panel panel glass-panel" class:collapsed={!leftOpen}>
      <div class="panel-tabs">
        <button
          class="tab-btn"
          class:active={activeTab === 'parameters'}
          onclick={() => (activeTab = 'parameters')}
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"
            ><circle cx="3" cy="8" r="2" /><line
              x1="5"
              y1="8"
              x2="14"
              y2="8"
              stroke="currentColor"
              stroke-width="2"
            /></svg
          >
          Parameters
        </button>
        <button
          class="tab-btn"
          class:active={activeTab === 'aichat'}
          onclick={() => (activeTab = 'aichat')}
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"
            ><path
              d="M2 2h12v9H6l-4 3V2z"
              fill="none"
              stroke="currentColor"
              stroke-width="1.5"
            /><circle cx="5" cy="6" r="0.5" /><circle cx="8" cy="6" r="0.5" /><circle
              cx="11"
              cy="6"
              r="0.5"
            /></svg
          >
          AI Chat
        </button>
      </div>

      <div class="panel-content">
        {#if activeTab === 'parameters'}
          <div class="tab-content active">
            <div class="param-panel">
              <div class="param-panel-intro">
                <h4 class="param-panel-title">Model Controls</h4>
                <p class="param-panel-hint">Adjust values to reshape the model in real time.</p>
              </div>

              {#if !manifest}
                <div class="loading-state">
                  <div class="spinner"></div>
                  <p>Loading parameters...</p>
                </div>
              {:else if manifest.parameters.length === 0}
                <div class="empty-state">This model has no adjustable parameters.</div>
              {:else}
                <div class="parameters-container">
                  {#each manifest.parameters as parameter (parameter.id)}
                    <div class="parameter-item">
                      <div class="parameter-header">
                        <span class="parameter-label">{parameter.label}</span>
                        {#if parameter.kind === 'number'}
                          <span class="parameter-value">
                            {Number(parameterValues[parameter.id] ?? parameter.default).toFixed(
                              parameter.precision ?? 2,
                            )}{parameter.unit ? ` ${parameter.unit}` : ''}
                          </span>
                        {/if}
                      </div>

                      {#if parameter.kind === 'number'}
                        <input
                          type="range"
                          class="parameter-slider"
                          id={'param-' + parameter.id}
                          min={parameter.min}
                          max={parameter.max}
                          step={parameter.step ?? (parameter.max - parameter.min) / 200}
                          value={Number(parameterValues[parameter.id] ?? parameter.default)}
                          aria-label={parameter.label}
                          oninput={(event) =>
                            onParameterInput(parameter.id, Number(event.currentTarget.value))}
                        />
                      {:else if parameter.kind === 'boolean'}
                        <div class="checkbox-container">
                          <label class="toggle-switch">
                            <input
                              type="checkbox"
                              checked={Boolean(parameterValues[parameter.id] ?? parameter.default)}
                              onchange={(event) =>
                                onParameterInput(parameter.id, event.currentTarget.checked)}
                            />
                            <span class="toggle-slider"></span>
                          </label>
                        </div>
                      {:else if parameter.kind === 'choice'}
                        <select
                          class="parameter-select"
                          value={String(parameterValues[parameter.id] ?? parameter.default)}
                          onchange={(event) =>
                            onParameterInput(parameter.id, event.currentTarget.value)}
                        >
                          {#each parameter.options as option (option.value)}
                            <option value={option.value}>{option.label}</option>
                          {/each}
                        </select>
                      {:else}
                        <input
                          type="color"
                          value={String(parameterValues[parameter.id] ?? parameter.default)}
                          oninput={(event) =>
                            onParameterInput(parameter.id, event.currentTarget.value)}
                        />
                      {/if}

                      {#if parameter.description}
                        <p class="param-panel-hint">{parameter.description}</p>
                      {/if}
                    </div>
                  {/each}

                  {#if manifest.metrics.length > 0}
                    <div class="info-section metrics-section">
                      <h4 class="info-heading">Live Metrics</h4>
                      <div class="info-content metrics-grid">
                        {#each manifest.metrics as metric (metric.id)}
                          <div class="metric-item">
                            <span class="metric-label">{metric.label}</span>
                            <span class="metric-value">{formatMetric(metric.id)}</span>
                          </div>
                        {/each}
                      </div>
                    </div>
                  {/if}

                  {#if manifest.colorRoles.length > 0}
                    <div class="info-section">
                      <h4 class="info-heading">Legend</h4>
                      <div class="info-content">
                        {#each manifest.colorRoles as role (role.id)}
                          <div class="property-row">
                            <span class="property-key"
                              ><span class="swatch" style={`background:${role.color}`}
                              ></span>{role.label}</span
                            >
                            <span class="property-val">{role.meaning}</span>
                          </div>
                        {/each}
                      </div>
                    </div>
                  {/if}
                </div>
              {/if}
            </div>
          </div>
        {:else}
          <div class="tab-content active">
            <ChatPanel {manifest} {selectedPart} />
          </div>
        {/if}
      </div>
    </aside>

    <!-- 3D Viewport -->
    <section class="viewport-container">
      <div
        bind:this={canvasHolder}
        class="main-canvas-holder"
        onpointerdown={onPointerDown}
        onpointermove={onPointerMove}
        onpointerup={onPointerUp}
        onpointercancel={onPointerUp}
        onwheel={onWheel}
        role="application"
        aria-label="3D model view. Use the part list to select parts with a keyboard."
      ></div>

      <!-- Tooltip -->
      {#if hoveredPart && !selectedPart}
        <div class="tooltip-3d">
          <div class="tooltip-header">
            {partsById.get(hoveredPart)?.name}
          </div>
          {#if partsById.get(hoveredPart)?.info?.bullets?.length}
            <ul class="tooltip-bullets">
              {#each partsById.get(hoveredPart)?.info?.bullets as bullet, index (index)}
                <li>{bullet}</li>
              {/each}
            </ul>
          {/if}
        </div>
      {/if}

      <!-- Story subtitle overlay -->
      {#if activeMode === 'story' && manifest?.story.length}
        <div class="subtitle-overlay active">
          <StoryMode
            story={manifest.story}
            onsetParameter={beatSetParameter}
            onfocus={(partId) => host?.focusPart(partId)}
            onclose={() => {
              activeMode = 'none';
              host?.focusPart(null);
            }}
          />
        </div>
      {/if}

      <!-- Loading overlay -->
      {#if modelLoading}
        <div class="loading-overlay">
          <div class="loading-content">
            <div class="spinner-large"></div>
            <h2>Building {topicName}</h2>
            <p>Authoring and realizing on this device…</p>
          </div>
        </div>
      {:else if !engineReady && !loadError}
        <div class="loading-overlay">
          <div class="loading-content">
            <div class="spinner-large"></div>
            <h2>Loading 3D Model</h2>
            <p>Authoring, pricing and realizing on this device…</p>
          </div>
        </div>
      {:else if loadError}
        <div class="loading-overlay">
          <div class="loading-content">
            <h2>The model could not be built</h2>
            <p>{loadError}</p>
            <button class="modal-btn" onclick={() => host?.reload()}>Try again</button>
          </div>
        </div>
      {:else if !support.supported}
        <div class="loading-overlay">
          <div class="loading-content">
            <h2>This browser cannot run the 3D engine</h2>
            <p>{support.reason}</p>
          </div>
        </div>
      {/if}

      <!-- Toasts -->
      <div class="toasts" aria-live="polite">
        {#each toasts as entry (entry.id)}
          <div class="toast">{entry.message}</div>
        {/each}
      </div>
    </section>

    <!-- Right Panel -->
    <aside class="right-panel panel glass-panel" class:collapsed={!rightOpen}>
      <div class="panel-header">
        <svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor">
          <circle cx="10" cy="10" r="8" fill="none" stroke="currentColor" stroke-width="2" />
          <path d="M10 6v4M10 14h.01" />
        </svg>
        <h3>Information</h3>
      </div>

      <div class="panel-content">
        <div class="info-panel">
          {#if selectedPartInfo && panelShowsSelectedPart(selectedPart, selectedPartInfo)}
            <div class="info-section">
              <h4 class="info-heading">Selected part</h4>
              <div class="info-content">
                <h4 class="part-title">{selectedPartInfo.title}</h4>
                {#if selectedPartInfo.summary}<p>{selectedPartInfo.summary}</p>{/if}
              </div>
              {#if selectedPartInfo.bullets.length > 0}
                <ul class="info-bullets">
                  {#each selectedPartInfo.bullets as bullet, index (index)}
                    <li>{bullet}</li>
                  {/each}
                </ul>
              {/if}
              {#if selectedPartInfo.facts.length > 0}
                <div class="properties-grid">
                  {#each selectedPartInfo.facts as fact, index (index)}
                    <div class="property-row">
                      <span class="property-key">{fact.label}</span>
                      <span class="property-val">{fact.value}</span>
                    </div>
                  {/each}
                </div>
              {/if}
              <button
                class="modal-btn"
                onclick={() => selectedPart && host?.focusPart(selectedPart)}
                >Focus this part</button
              >
            </div>
          {:else if overviewHtmlSafe}
            <div class="info-section overview-section">
              <h4 class="info-heading">Overview</h4>
              <div class="info-content">
                <h4 class="part-title">{overviewHtmlSafe.name}</h4>
                <p>{overviewHtmlSafe.description}</p>
                <p class="concept-line">{overviewHtmlSafe.concept}</p>
              </div>
            </div>

            <div class="info-section">
              <h4 class="info-heading">What this teaches</h4>
              <ul class="info-bullets">
                {#each overviewHtmlSafe.objectives as objective, index (index)}
                  <li>{objective}</li>
                {/each}
              </ul>
            </div>

            {#if overviewHtmlSafe.simplifications.length > 0}
              <div class="info-section">
                <h4 class="info-heading">Simplifications</h4>
                <ul class="info-bullets muted">
                  {#each overviewHtmlSafe.simplifications as note, index (index)}
                    <li>{note}</li>
                  {/each}
                </ul>
              </div>
            {/if}

            <!-- Parts list — the keyboard-reachable selection path -->
            {#if listedParts.length > 0}
              <div class="info-section">
                <h4 class="info-heading">Parts</h4>
                <div class="part-list">
                  {#each listedParts as part (part.id)}
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
                  {/each}
                </div>
              </div>
            {/if}
          {:else}
            <p class="loading-state">Loading topic information...</p>
          {/if}
        </div>
      </div>
    </aside>
  </main>

  <!-- ── Bottom Stats Bar ─────────────────────────────────────────────────── -->
  <footer class="bottom-bar glass-panel">
    <div class="stats-group">
      <div
        class="stat-item"
        data-stat="fps"
        title="Frames per second, measured over a rolling window"
      >
        <span class="stat-label">FPS</span>
        <span class="stat-value">{stats ? stats.fps.toFixed(0) : '—'}</span>
      </div>
      <div class="stat-item" data-stat="draws" title="Draw calls in the last rendered frame">
        <span class="stat-label">Draws</span>
        <span class="stat-value">{stats?.drawCalls ?? '—'}</span>
      </div>
      <div class="stat-item" data-stat="triangles" title="Triangles this frame">
        <span class="stat-label">Triangles</span>
        <span class="stat-value">{stats ? `${(stats.triangles / 1000).toFixed(0)}k` : '—'}</span>
      </div>
      <div class="stat-item" data-stat="time" title="Model time">
        <span class="stat-label">Time</span>
        <span class="stat-value">{stats ? formatTime(stats.simSeconds) : '00:00'}</span>
      </div>
    </div>
    <div class="stats-group">
      <div class="stat-item" data-stat="tier" title="Device tier">
        <span class="stat-label">Tier</span>
        <span class="stat-value">{deviceTier || '—'}</span>
      </div>
      <div class="stat-item">
        <span class="stat-label">Physics</span>
        <span class="stat-value">{manifest?.physics ? 'On' : 'Off'}</span>
      </div>
      {#if verdict && verdict.adjustments.length > 0}
        <div
          class="stat-item"
          data-stat="quality"
          title={verdict.adjustments.map((a) => a.message).join(' ')}
        >
          <span class="stat-label">Quality</span>
          <span class="stat-value warning">Adapted</span>
        </div>
      {/if}
    </div>
  </footer>

  <!-- ── Quiz Modal (V1 structure) ────────────────────────────────────────── -->
  {#if quizModalOpen && quizQuestions.length > 0}
    <div class="modal-overlay active" role="dialog" aria-modal="true" aria-label="Quiz mode">
      <QuizModal
        questions={quizQuestions}
        source={quizSource}
        onclose={() => {
          quizModalOpen = false;
          activeMode = 'none';
        }}
      />
    </div>
  {/if}

  <!-- ── Shortcuts Modal ──────────────────────────────────────────────────── -->
  {#if shortcutsModalOpen}
    <div
      class="modal-overlay active"
      role="dialog"
      aria-modal="true"
      aria-label="Keyboard shortcuts"
    >
      <div class="modal-container shortcuts-modal glass-panel">
        <div class="modal-header">
          <h2>⌨️ Keyboard Shortcuts</h2>
          <button class="modal-close-btn" onclick={() => (shortcutsModalOpen = false)}>×</button>
        </div>
        <div class="modal-body">
          <div class="shortcuts-grid">
            {#each SHORTCUT_CATEGORIES as category (category.title)}
              <div class="shortcut-category">
                <h4>{category.title}</h4>
                {#each category.items as item (item[0])}
                  <div class="shortcut-item"><kbd>{item[0]}</kbd><span>{item[1]}</span></div>
                {/each}
              </div>
            {/each}
          </div>
        </div>
      </div>
    </div>
  {/if}

  <!-- ── Share Modal ──────────────────────────────────────────────────────── -->
  {#if galleryOpen}
    <GalleryModal onclose={() => (galleryOpen = false)} onload={swapInModel} />
  {/if}

  {#if generateOpen}
    <GenerateDialog onclose={() => (generateOpen = false)} ongenerated={swapInModel} />
  {/if}

  {#if shareModalOpen}
    <ShareModal {manifest} onclose={() => (shareModalOpen = false)} />
  {/if}

  <!-- ── AI Output viewer ─────────────────────────────────────────────────── -->
  {#if codeViewModalOpen}
    <CodeViewModal
      {manifest}
      tab={codeViewTab}
      ontab={(t) => (codeViewTab = t)}
      onclose={() => (codeViewModalOpen = false)}
    />
  {/if}
</div>

<style>
  /* The canvas holder fills the viewport container; V1's canvas element itself was sized by the engine. */
  .main-canvas-holder {
    position: absolute;
    inset: 0;
    touch-action: none;
    user-select: none;
    cursor: grab;
  }

  .main-canvas-holder:active {
    cursor: grabbing;
  }

  .hidden-icon {
    display: none;
  }

  .toasts {
    position: absolute;
    top: var(--space-4);
    right: var(--space-4);
    display: grid;
    gap: var(--space-2);
    max-width: 26rem;
    z-index: 3000;
  }

  .toast {
    padding: 0.875rem 1.25rem;
    font-size: 0.875rem;
    font-weight: 600;
    color: var(--text-primary);
    /* Solid, and not `.glass-panel`: this sits over the canvas at z-index 3000, so a backdrop blur
       here re-blurred it on every presented frame for the 4.5s the toast lived. */
    background: var(--bg-surface-solid, var(--bg-panel));
    backdrop-filter: none;
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-md, 10px);
    box-shadow: var(--shadow-md);
    animation: toastIn 0.4s var(--ease-out);
  }

  /* The hover tooltip had no CSS at all. `.tooltip-3d` matched nothing in any stylesheet, so it was a
     static, full-viewport-width in-flow block laid out over the canvas while carrying .glass-panel's
     16px backdrop blur - a full-width blurred band over the model, on every orbit frame. It now has
     real geometry and a solid background. */
  .tooltip-3d {
    position: absolute;
    left: var(--space-4, 1rem);
    bottom: var(--space-4, 1rem);
    z-index: 2000;
    max-width: 20rem;
    padding: 0.625rem 0.875rem;
    pointer-events: none;
    font-size: 0.8125rem;
    background: var(--bg-surface-solid, var(--bg-panel));
    backdrop-filter: none;
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-md, 10px);
    box-shadow: var(--shadow-md);
  }

  .tooltip-header {
    font-weight: 600;
    margin-bottom: 0.25rem;
  }

  .tooltip-bullets {
    margin: 0;
    padding-left: 1rem;
  }

  @keyframes toastIn {
    from {
      transform: translateX(400px);
      opacity: 0;
    }
    to {
      transform: translateX(0);
      opacity: 1;
    }
  }

  .swatch {
    display: inline-block;
    width: 12px;
    height: 12px;
    border-radius: 4px;
    border: 1px solid var(--border-strong);
    margin-right: 6px;
    vertical-align: -1px;
  }

  .part-title {
    font-size: 1.0625rem;
    font-weight: 700;
    color: var(--text-primary);
    letter-spacing: -0.01em;
    margin-bottom: var(--space-2);
  }

  .concept-line {
    margin-top: var(--space-2);
    color: var(--text-muted);
    font-style: italic;
  }

  .info-bullets {
    display: grid;
    gap: var(--space-2);
    font-size: 0.8125rem;
    color: var(--text-secondary);
    line-height: 1.5;
    padding-left: 1.125rem;
  }

  .info-bullets.muted {
    color: var(--text-dim);
  }

  .part-list {
    display: grid;
    gap: 2px;
    max-height: 20rem;
    overflow-y: auto;
  }

  .part-button {
    width: 100%;
    text-align: left;
    padding: var(--space-2) var(--space-3);
    border-radius: var(--radius-sm);
    font-size: 0.8125rem;
    color: var(--text-secondary);
    transition:
      background var(--dur-fast) ease,
      color var(--dur-fast) ease;
  }

  .part-button:hover {
    background: var(--bg-hover);
    color: var(--text-primary);
  }

  .part-button.active {
    background: var(--accent-muted);
    color: var(--accent);
  }

  .stat-value.warning {
    color: var(--warning);
  }
</style>
