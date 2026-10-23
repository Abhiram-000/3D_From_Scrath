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
  import { SvelteMap } from 'svelte/reactivity';
  import type {
    Annotation,
    DeviceTier,
    ModelLabel,
    ModelManifest,
    ProjectedAnnotation,
    ProjectedLabel,
    QualityPreset,
    QuizQuestion,
    RuntimeStats,
    ShotDecl,
    VideoRecordingCapability,
  } from '@edu3d/contracts';
  import { HEART_MODEL_SOURCE, REFERENCE_MODEL_SOURCE } from '@edu3d/engine';
  import {
    SandboxHost,
    sandboxSupported,
    type HostCallbacks,
    type SnapshotPreset,
  } from '$lib/engine/sandbox-host.ts';
  import type { SerializableVerdict } from '$lib/engine/sandbox-worker.ts';
  import { apiFetch, takeBundle, storedRuntime } from '$lib/core/api.ts';
  import { SettingsStore, narratePart } from '$lib/core/settings.ts';
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
  import SettingsModal from '$lib/components/settings-modal.svelte';
  import AnnotationLayer from '$lib/components/annotation-layer.svelte';
  import ModelLabels from '$lib/components/model-labels.svelte';
  import ExportMenu from '$lib/components/export-menu.svelte';
  import { AnnotationStore, annotationId, toAnnotationPins } from '$lib/annotations/annotations.ts';

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

  /**
   * The program currently on screen — `{ code, runtime? }` — or null when the screen shows the
   * built-in reference model.
   *
   * This page is the single owner of that answer. The loading handoff (`takeBundle`) is consumed
   * exactly once, here; every later model load (share link, gallery entry, Generate swap) replaces
   * this value along with the model. The share modal and the code panel receive it as a prop, so
   * the program published or displayed can never disagree with the manifest beside it. The previous
   * design peeks the consumed session-storage key instead, which after one load is empty — the
   * share modal then published the reference source under the generated model's manifest, both
   * silently.
   */
  let currentProgram = $state<{ code: string; runtime?: string } | null>(null);

  // V1 shell state
  let leftOpen = $state(true);
  let rightOpen = $state(true);
  let activeTab = $state<'parameters' | 'aichat'>('parameters');
  let activeMode = $state<'none' | 'story' | 'quiz'>('none');
  let topicName = $state('Loading...');
  let deviceTier = $state<DeviceTier | ''>('');
  let theme = $state<'dark' | 'light'>('dark');

  /**
   * The learner's settings, and the quality they have pinned (`08`: their explicit choice beats the
   * optimizer, which then only warns).
   *
   * The store is a plain object rather than `$state`: it is not rendered, only read at mount and
   * written by the control — and the pin itself is mirrored into reactive state so the control can
   * show what is currently chosen.
   */
  const settings = new SettingsStore();
  let pinnedQuality = $state<QualityPreset | null>(null);

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
  let settingsOpen = $state(false);
  let codeViewTab = $state<'raw' | 'spec'>('raw');
  let quizQuestions = $state<QuizQuestion[]>([]);
  let quizSource = $state<'authored' | 'generated'>('authored');

  let ambient: Ambient | null = null;

  // Toasts (V1-style, top-right, slide-in)
  let toasts = $state<Array<{ id: number; message: string }>>([]);
  let toastSeq = 0;
  /** Per-toast timers, so unmount can stop them firing into a destroyed component. */
  const toastTimers = new SvelteMap<number, ReturnType<typeof setTimeout>>();

  function toast(message: string) {
    const id = (toastSeq += 1);
    toasts = [...toasts, { id, message }];
    toastTimers.set(
      id,
      setTimeout(() => {
        toastTimers.delete(id);
        toasts = toasts.filter((entry) => entry.id !== id);
      }, 4500),
    );
  }

  /**
   * The four theme values the engine draws with: the backdrop gradient's two stops and the ground
   * grid's two weights. All four come from CSS, so the canvas follows the theme rather than fighting
   * it (`07`), and each grid token already carries the intended alpha.
   */
  function readThemeColors(): { top: string; bottom: string; grid: string; gridMajor: string } {
    const styles = getComputedStyle(document.documentElement);
    return {
      top: styles.getPropertyValue('--scene-bg-top').trim() || '#17130f',
      bottom: styles.getPropertyValue('--scene-bg-bottom').trim() || '#08070a',
      grid: styles.getPropertyValue('--scene-grid').trim() || 'rgb(255 255 255 / 14%)',
      gridMajor: styles.getPropertyValue('--scene-grid-major').trim() || 'rgb(255 255 255 / 40%)',
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

      // The model's own words, beside the parts they name. The worker projects them and answers with
      // `onLabelPositions`; until that reply lands the overlay has no positions and draws nothing.
      modelLabels = loadedManifest.labels;
      projectedLabels = [];

      loadError = null;
      topicName = loadedManifest.name;
      const defaults: Record<string, number | boolean | string> = {};
      for (const parameter of loadedManifest.parameters) defaults[parameter.id] = parameter.default;
      parameterValues = defaults;
      // Notes are per model (`03` R7): a new model brings its own set, and the worker is told about
      // it before the first frame so a returning learner sees their pins immediately.
      annotationStore = new AnnotationStore(loadedManifest.name);
      draftAnnotation = null;
      syncNotes();
      if (!annotationStore.persisted) {
        toast('Notes will last this session only — this browser refused to store them.');
      }
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
      modelLabels = [];
      projectedLabels = [];
      stats = null;
      loadError = reason;
      toast(reason);
    },
    onSnapshot: (blob, info) => {
      // A caller waiting on a one-shot capture (the share dialog publishing a thumbnail) takes
      // precedence over the download path: it asked for exactly this snapshot.
      if (pendingSnapshot) {
        const { resolve, timeout } = pendingSnapshot;
        pendingSnapshot = null;
        clearTimeout(timeout);
        resolve(blob);
        return;
      }
      // The worker reports the pixels it actually rendered, so the file names itself honestly
      // rather than claiming a resolution the device could not afford.
      downloadBlob(blob, `${manifest?.name ?? 'model'} ${info.width}×${info.height}.png`);
      toast(`Screenshot saved (${info.width}×${info.height}).`);
    },
    onAnnotationPositions: (positions) => {
      projectedAnnotations = positions;
    },
    onLabelPositions: (positions) => {
      projectedLabels = positions;
    },
    onRecordingCapability: (capability) => {
      recordingCapability = capability;
    },
    onVideoClip: (blob, info) => {
      stopRecordingTimer();
      downloadBlob(blob, `${manifest?.name ?? 'model'} clip ${Math.round(info.seconds)}s.webm`);
      toast(
        `Clip saved — ${Math.round(info.seconds)}s, ${(info.bytes / 1024 / 1024).toFixed(1)} MB.`,
      );
    },
    onRecordingFailed: (message) => {
      stopRecordingTimer();
      toast(message);
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

    // The learner's settings, read once here and handed to the host: a pin is a session-level
    // choice, and the worker needs it at spawn (see `host.setQuality`).
    pinnedQuality = settings.current.quality;

    host = new SandboxHost(canvasHolder, callbacks, { quality: pinnedQuality });
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
      // model its browser-side loop guard. The page keeps this program (below) as the current one,
      // so share/code panels display exactly what is on screen.
      currentProgram = { code: generated.code, runtime: storedRuntime(generated) };
      host.load(generated.code, 7, storedRuntime(generated));
      topicName =
        typeof (generated.manifest as { name?: string })?.name === 'string'
          ? (generated.manifest as { name: string }).name
          : 'Generated model';
    } else {
      // The honest reference fallback: nothing was generated or shared in this session. Null is
      // meaningful — the share modal labels it rather than passing the reference off as generated.
      currentProgram = null;
      host.load(referenceModel, 7);
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
          resetModel();
          break;
        case 's':
          // Story Mode, as the shortcuts panel (line ~575) advertises — previously listed and
          // never bound, reachable only from the toolbar button.
          activeMode = activeMode === 'story' ? 'none' : 'story';
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
        case 'q':
          void enterQuiz();
          break;
        case 'n':
          generateOpen = true;
          break;
        case 'l':
          galleryOpen = true;
          break;
        case 'p':
          shareModalOpen = true;
          break;
        case 'c':
          host?.requestSnapshot('hd');
          break;
        case 'a':
          toggleNotePlacing();
          break;
        case '[':
          leftOpen = !leftOpen;
          break;
        case ']':
          rightOpen = !rightOpen;
          break;
        case 't':
          toggleTheme();
          break;
        case '?':
          shortcutsModalOpen = !shortcutsModalOpen;
          break;
        case ',':
          settingsOpen = !settingsOpen;
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
            generateOpen ||
            settingsOpen
          ) {
            quizModalOpen = shortcutsModalOpen = shareModalOpen = codeViewModalOpen = false;
            galleryOpen = generateOpen = settingsOpen = false;
          } else if (activeMode !== 'none') {
            activeMode = 'none';
          } else if (placingNote) {
            // A note being placed is a mode too, and Escape has to leave it: otherwise the next click
            // on the model pins a note the learner had stopped wanting.
            placingNote = false;
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
    // Timers with no component left to receive them: a toast dismissal or a gesture-window close
    // firing after unmount is a write into destroyed state.
    for (const timer of toastTimers.values()) clearTimeout(timer);
    toastTimers.clear();
    if (gestureTimer) clearTimeout(gestureTimer);
    gestureOpen = false;
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
      const { code, runtime } = result.data.bundle;
      currentProgram = runtime ? { code, runtime } : { code };
      host?.load(code, 7, runtime);
      return;
    }
    // The failure fallback is the reference model, and the current-program tracking says so.
    currentProgram = null;
    toast('That shared model could not be loaded; showing the reference model instead.');
    host?.load(referenceModel, 7);
  }

  // A reference preview only ever applies when nothing better exists to load: below the shared link and
  // below this session's generation - exactly the rung the on-disk turbofan holds, with a param that lets a
  // second reference model be previewed without faking gallery data.
  const referenceModel =
    typeof window === 'undefined'
      ? REFERENCE_MODEL_SOURCE
      : new URLSearchParams(window.location.search).get('reference') === 'heart'
        ? HEART_MODEL_SOURCE
        : REFERENCE_MODEL_SOURCE;

  function togglePaused() {
    paused = !paused;
    host?.setPaused(paused);
  }

  function setViewMode(mode: typeof viewMode) {
    viewMode = mode;
    host?.setViewMode(mode);
  }

  /**
   * Capture one frame as a promise, for callers that need the bytes rather than a download.
   *
   * The worker's snapshot arrives on the `onSnapshot` callback, which the Download button uses for a
   * fire-and-forget save; publishing a gallery thumbnail needs the bytes back, so this brackets the
   * same message with a one-shot resolver. The timeout matters: a viewer whose worker was killed
   * mid-capture must not leave the share dialog waiting forever on a snapshot that is never coming.
   */
  const SNAPSHOT_TIMEOUT_MS = 5_000;
  let pendingSnapshot: {
    resolve: (blob: Blob | null) => void;
    timeout: ReturnType<typeof setTimeout>;
  } | null = null;

  function captureSnapshot(preset: SnapshotPreset = 'hd'): Promise<Blob | null> {
    if (!host) return Promise.resolve(null);
    return new Promise((resolve) => {
      // A second request while one is in flight replaces the first: the newer capture is the one the
      // learner is looking at, and the older promise resolves null rather than hanging.
      if (pendingSnapshot) {
        clearTimeout(pendingSnapshot.timeout);
        pendingSnapshot.resolve(null);
        pendingSnapshot = null;
      }
      const timeout = setTimeout(() => {
        pendingSnapshot = null;
        resolve(null);
      }, SNAPSHOT_TIMEOUT_MS);
      pendingSnapshot = { resolve, timeout };
      host?.requestSnapshot(preset);
    });
  }

  function toggleTheme() {
    theme = setTheme(theme === 'dark' ? 'light' : 'dark');
    host?.setTheme(readThemeColors());
  }

  /**
   * Pin (or unpin) the quality preset — `08`: "the user's explicit quality choice beats the
   * optimizer's". This is the function the viewer's codemap has been claiming exists since the page
   * was written; until the Settings dialog arrived there was no control to call it, so a learner
   * could not actually make the choice the contract said they could.
   *
   * The toast says what the pin means rather than congratulating the click: a pinned quality stops
   * the ladder from stepping down, so the frame rate is the learner's to own.
   */
  function setPinnedQuality(quality: QualityPreset | null) {
    settings.update({ quality });
    pinnedQuality = quality;
    host?.setQuality(quality);
    toast(
      quality === null
        ? 'Quality set to Auto — the platform will adapt to this device.'
        : `Quality pinned to ${quality}. The ladder will not step down on its own.`,
    );
  }

  // ── Notes (`03` R7) ───────────────────────────────────────────────────────
  /**
   * The learner's pinned notes, and the one place the pin set reaches the worker.
   *
   * Storage and validation belong to `lib/annotations/annotations.ts`; the page owns *when* to write
   * and what the worker is told. `draftAnnotation` is the note being written: a pin exists the moment
   * its point is picked, but `Annotation.text` has a minimum length of one, so an unwritten note is
   * deliberately not in the store and is appended to the pin set only for projection — a textless
   * pin that the learner abandons therefore never reaches storage at all.
   */
  let annotationStore: AnnotationStore | null = null;
  let notes = $state.raw<Annotation[]>([]);
  let projectedAnnotations = $state.raw<ProjectedAnnotation[]>([]);
  /**
   * Model-authored labels: the words come from the loaded manifest, the positions from the worker's
   * `labelPositions` reply. Both are cleared on a model swap so a previous model's words cannot linger
   * over a new model's parts.
   */
  let projectedLabels = $state.raw<ProjectedLabel[]>([]);
  let modelLabels = $state.raw<ModelLabel[]>([]);
  let placingNote = $state(false);
  let draftAnnotation = $state.raw<Annotation | null>(null);

  function syncNotes(): void {
    const stored = annotationStore ? [...annotationStore.current] : [];
    const shown = draftAnnotation ? [...stored, draftAnnotation] : stored;
    notes = shown;
    host?.setAnnotations(toAnnotationPins(shown));
  }

  function toggleNotePlacing(): void {
    if (!manifest) {
      toast('A note needs a model to pin it to.');
      return;
    }
    placingNote = !placingNote;
    if (placingNote) toast('Tap the model to pin a note.');
  }

  /** Pick a world point under the click and open a fresh note there. The raycast runs in the worker. */
  async function placeNote(clientX: number, clientY: number): Promise<void> {
    if (!canvasRect || !host) return;
    const point = toCanvasPoint(clientX, clientY, canvasRect);
    const picked = await host.pickPoint(point.x, point.y);
    placingNote = false;
    if (!picked.point) {
      toast('That was empty space — pin the note on the model itself.');
      return;
    }
    draftAnnotation = {
      id: annotationId(),
      point: picked.point,
      ...(picked.partId ? { partId: picked.partId } : {}),
      text: '',
      createdAt: Date.now(),
    };
    syncNotes();
  }

  /** Commit the draft (or an edit) into the per-model store, then republish the pins. */
  function saveNote(id: string, text: string): void {
    if (draftAnnotation && draftAnnotation.id === id) {
      annotationStore?.add({
        point: draftAnnotation.point,
        ...(draftAnnotation.partId ? { partId: draftAnnotation.partId } : {}),
        text,
      });
      draftAnnotation = null;
    } else {
      annotationStore?.update(id, text);
    }
    syncNotes();
  }

  function deleteNote(id: string): void {
    if (draftAnnotation?.id === id) draftAnnotation = null;
    annotationStore?.remove(id);
    syncNotes();
  }

  /**
   * The layer asks for a note's current text when it opens an input.
   *
   * The layer owns its own editing UI (input, Enter/blur, Escape), so the page has nothing to do
   * with the request today. The prop is answered with a named function rather than an inline arrow
   * because a function prop's identity is a dependency of whatever reads it — see the story-mode
   * freeze this codebase already paid for.
   */
  function answerNoteRequest(): void {
    // Intentionally empty: the layer's own state is the source of the text it is editing.
  }

  // ── Export and recording (`03` R8) ────────────────────────────────────────
  let recordingCapability = $state.raw<VideoRecordingCapability | null>(null);
  let recording = $state(false);
  let recordingSeconds = $state(0);
  let recordingTimer: ReturnType<typeof setInterval> | null = null;

  function stopRecordingTimer(): void {
    if (recordingTimer) clearInterval(recordingTimer);
    recordingTimer = null;
    recording = false;
  }

  function startRecording(): void {
    recording = true;
    recordingSeconds = 0;
    if (recordingTimer) clearInterval(recordingTimer);
    recordingTimer = setInterval(() => (recordingSeconds += 1), 1000);
    host?.startRecording();
  }

  function stopRecording(): void {
    host?.stopRecording();
    stopRecordingTimer();
  }

  /** Save a blob the worker produced (a snapshot or a clip) as a file the learner keeps. */
  function downloadBlob(blob: Blob, filename: string): void {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.click();
    URL.revokeObjectURL(url);
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
  /**
   * The undo and redo stacks share one cap.
   *
   * Both are full parameter snapshots, and both used to grow without bound — the cap was enforced
   * on the slider path alone, so undo and redo pushes walked past it. A long session of undo/redo
   * cycles is exactly the flow that leaks.
   */
  const SNAPSHOT_CAP = 50;

  function pushCapped(stack: ParamSnapshot[], snapshot: ParamSnapshot): ParamSnapshot[] {
    return [...stack.slice(-(SNAPSHOT_CAP - 1)), snapshot];
  }

  let undoStack = $state<ParamSnapshot[]>([]);
  let redoStack = $state<ParamSnapshot[]>([]);
  let gestureOpen = false;
  let gestureTimer: ReturnType<typeof setTimeout> | null = null;

  function noteParameterGesture() {
    if (!gestureOpen) {
      gestureOpen = true;
      undoStack = pushCapped(undoStack, { ...parameterValues });
      redoStack = [];
    }
    if (gestureTimer) clearTimeout(gestureTimer);
    gestureTimer = setTimeout(() => (gestureOpen = false), 600);
  }

  function undo() {
    const previous = undoStack[undoStack.length - 1];
    if (!previous) return;
    undoStack = undoStack.slice(0, -1);
    redoStack = pushCapped(redoStack, { ...parameterValues });
    applySnapshot(previous);
  }

  function redo() {
    const next = redoStack[redoStack.length - 1];
    if (!next) return;
    redoStack = redoStack.slice(0, -1);
    undoStack = pushCapped(undoStack, { ...parameterValues });
    applySnapshot(next);
  }

  function applySnapshot(snapshot: ParamSnapshot) {
    parameterValues = { ...snapshot };
    for (const [id, value] of Object.entries(snapshot)) host?.setParameter(id, value);
  }

  /**
   * Reset: the authored initial state, not just a clock.
   *
   * `00-GOAL.md:298` is explicit — "time back to zero, **parameters back to defaults**, motion back
   * to its starting pose" — and `03` R5 adds the authored camera. This button used to call
   * `resetTime()` alone, so a learner who had dragged every slider ended up with a model that no
   * longer matched the pose it was authored to open in, and no way back except a reload. Live
   * verification caught it: Reset left the turbofan's spool at 12 000 rpm.
   *
   * The gesture history is dropped rather than pushed: a reset is not an edit to walk back from, and
   * `Undo` after a Reset must not restore the state the learner just deliberately left.
   */
  function resetModel() {
    if (manifest) {
      const defaults: ParamSnapshot = {};
      for (const parameter of manifest.parameters) defaults[parameter.id] = parameter.default;
      applySnapshot(defaults);
    }
    undoStack = [];
    redoStack = [];
    gestureOpen = false;
    if (gestureTimer) {
      clearTimeout(gestureTimer);
      gestureTimer = null;
    }
    host?.resetTime();
    host?.resetCamera();
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

  /**
   * Story callbacks as named functions, not inline arrows in the markup.
   *
   * An arrow in the markup is a new function on every render, and the story component's beat effect
   * used to track those identities — so a beat writing a parameter re-rendered this page, which
   * handed down fresh callbacks, which re-ran the effect. The loop froze the viewer (Svelte:
   * `effect_update_depth_exceeded`). The component now untracks them as well; stable identities are
   * the other half of the same fix, and they keep the story subtree from being re-created per frame.
   */
  function focusStoryPart(partId: string | null) {
    host?.focusPart(partId);
  }

  function playStoryShot(shot: ShotDecl) {
    host?.playShot(shot);
  }

  function closeStory() {
    activeMode = 'none';
    host?.focusPart(null);
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
    // Whoever just produced this load owns "what is on screen" from here on — including the
    // share/code panels reading `currentProgram`.
    currentProgram = runtime ? { code, runtime } : { code };
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

  /**
   * The quality line reports what is running, not what was asked for.
   *
   * It used to print "Adapted" whenever the *admission verdict* carried any adjustment — a verdict
   * computed once when the model loaded — while the live ladder could have stepped down (or back up)
   * several rungs since. `08`'s rule is that the platform never lies to the learner about what it is
   * doing: the value here is the effective preset the worker is actually running, and the ladder's
   * own rungs are what mark it as adapted.
   */
  const qualityDegraded = $derived((stats?.degradedRungs.length ?? 0) > 0);
  const qualityLabel = $derived(
    stats ? `${stats.quality}${qualityDegraded ? ' (adapted)' : ''}` : '—',
  );
  const qualityTitle = $derived(
    [
      `Effective preset: ${stats?.quality ?? 'unknown'} on a ${stats?.effectiveTier ?? deviceTier ?? '?'}-tier device.`,
      qualityDegraded ? `Stepped down from: ${stats?.degradedRungs.join(', ')}.` : '',
      ...(verdict?.adjustments.map((adjustment) => adjustment.message) ?? []),
    ]
      .filter(Boolean)
      .join(' '),
  );

  /**
   * The Physics line tells the truth about the solver, not about the declaration.
   *
   * It used to read "On" whenever `manifest.physics` existed — a device where Rapier failed to load
   * therefore showed a running simulation while only a toast admitted otherwise (`03` R9: runtime
   * trust indicators). The worker publishes whether the world is actually stepping, and the reason
   * when it is not, so the three real states are distinguishable: no simulation declared (Off), a
   * solver that is stepping (its per-frame cost), and one that should be but is not (Unavailable).
   */
  const physicsUnavailable = $derived(Boolean(manifest?.physics) && stats?.physicsActive === false);
  const physicsLabel = $derived(
    !manifest?.physics
      ? 'Off'
      : stats?.physicsActive
        ? `${stats.physicsMillis.toFixed(1)} ms`
        : 'Unavailable',
  );
  const physicsTitle = $derived(
    !manifest?.physics
      ? 'This model declares no simulation, so nothing is solved. Animation is not physics.'
      : stats?.physicsActive
        ? 'Solver time per frame for the model’s declared physics world.'
        : `The model declares physics but the solver is not running: ${stats?.physicsUnavailableReason ?? 'this device could not start it'}.`,
  );

  /**
   * Read a part's description aloud when it is selected — `05`'s narration, extended to the part the
   * learner pointed at.
   *
   * Gated entirely inside `narratePart`: narration off (the default) makes this effect cost one
   * boolean check, and a browser with no `speechSynthesis` is silence rather than an error. The last
   * announced id is remembered so re-selecting the same part does not restart the sentence.
   */
  let announcedPart = $state<string | null>(null);
  $effect(() => {
    const partId = selectedPart;
    if (!partId || partId === announcedPart) return;
    const part = partsById.get(partId);
    if (!part) return;
    announcedPart = partId;
    const text = [part.name, part.info?.title, part.info?.summary].filter(Boolean).join('. ');
    narratePart(text, settings.current);
  });

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

  // Camera distance from its pivot, in metres (the scene is SI).
  const formatDistance = (metres: number): string => `${metres.toFixed(1)} m`;

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
        ['Q', 'Quiz'],
      ],
    },
    {
      title: 'Model',
      items: [
        ['N', 'Generate a new model'],
        ['L', 'Gallery'],
        ['P', 'Share / Publish'],
        ['C', 'Screenshot (HD)'],
        ['A', 'Add a note'],
      ],
    },
    {
      title: 'Panels',
      items: [
        ['[', 'Toggle Parameters / Chat'],
        [']', 'Toggle Information'],
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
        [',', 'Settings'],
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
      settingsOpen,
    });
    // Read both before acting, so the dependency set includes them.
    const requestedPause = shouldPauseRender(overlayOpen, paused);
    if (!engineReady) return;
    host?.setPaused(requestedPause);
  });

  // ── Pointer handlers (V1: primary orbits, middle/shift pans; touch is new) ─
  /**
   * Touch parity (`00`: "one-finger orbit, two-finger pan and pinch zoom, matching every mouse
   * capability").
   *
   * Every pointer used to be the same pointer: a second finger simply replaced `lastPointer`, so a
   * pinch read as a violent orbit and the model slewed off screen while zooming. Pointers are now
   * tracked by id and the gesture follows from how many are down — one finger orbits, two pinch and
   * pan, a second tap inside the double-tap window focuses the part the first tap selected.
   */
  const activePointers = new SvelteMap<number, { x: number; y: number }>();
  /** While two fingers are down: the separation and midpoint the next frame's deltas are measured against. */
  let pinch: { distance: number; midpoint: { x: number; y: number } } | null = null;
  /** A second tap inside this window, and within this slop, is a double tap. */
  const DOUBLE_TAP_MS = 300;
  const TAP_SLOP_PX = 12;
  let lastTap = { at: 0, x: 0, y: 0 };

  const midpointOf = (a: { x: number; y: number }, b: { x: number; y: number }) => ({
    x: (a.x + b.x) / 2,
    y: (a.y + b.y) / 2,
  });
  const distanceBetween = (a: { x: number; y: number }, b: { x: number; y: number }) =>
    Math.hypot(a.x - b.x, a.y - b.y);

  /**
   * The first two live pointers, or null when fewer than two are down.
   *
   * A guard rather than a destructure of `[...values()]`: the map is keyed by pointer id and an entry
   * is removed on `pointerup`, so "two are down" and "two entries are readable" are only the same
   * statement by luck.
   */
  function pinchPair(): [{ x: number; y: number }, { x: number; y: number }] | null {
    const points = [...activePointers.values()];
    const first = points[0];
    const second = points[1];
    return first && second ? [first, second] : null;
  }

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
    // A note being placed owns the click: an orbit or a selection underneath it would fight the pin
    // the learner is trying to drop. The gesture handlers below never see this press.
    if (placingNote) {
      void placeNote(event.clientX, event.clientY);
      return;
    }
    cancelPendingHover();
    activePointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (activePointers.size === 2) {
      // A second finger turns the gesture into a pinch. `dragging` is cleared so the two-finger
      // move below cannot also orbit — the model would slew sideways while zooming.
      const pair = pinchPair();
      if (pair) {
        pinch = {
          distance: distanceBetween(pair[0], pair[1]),
          midpoint: midpointOf(pair[0], pair[1]),
        };
      }
      dragging = null;
    } else if (activePointers.size === 1) {
      lastPointer = { x: event.clientX, y: event.clientY };
      dragging = event.button === 1 || event.shiftKey ? 'pan' : 'orbit';
    }
    // Every finger sends its own `down`, including the second one: the worker counts presses to tell
    // a pinch from a choice (`pointersDown`), and a pinch it never heard about would select the part
    // under the fingers when they lift.
    dispatchPointer('down', event.clientX, event.clientY);
    (event.target as HTMLElement).setPointerCapture(event.pointerId);
  }

  function onPointerMove(event: PointerEvent) {
    if (!canvasHolder) return;
    const tracked = activePointers.get(event.pointerId);
    if (tracked) {
      tracked.x = event.clientX;
      tracked.y = event.clientY;
    }
    if (activePointers.size >= 2) {
      const pair = pinchPair();
      if (!pair) return;
      const [first, second] = pair;
      const distance = distanceBetween(first, second);
      const midpoint = midpointOf(first, second);
      if (pinch && pinch.distance > 0 && distance > 0) {
        // `zoom` takes a multiplicative delta (`distance * (1 + delta / 1000)`), so the separation
        // ratio maps straight onto it: fingers apart closes the distance, exactly like a scroll notch.
        host?.zoom((distance / pinch.distance - 1) * 1000);
        host?.pan(midpoint.x - pinch.midpoint.x, midpoint.y - pinch.midpoint.y);
      }
      pinch = { distance, midpoint };
      return;
    }
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
   *
   * Also the one place a double tap can be recognised: the worker answers a travelling press with
   * nothing and a still press with a selection, so a tap that selected something and was followed by
   * a second tap inside the double-tap window is a request to *look* at it — the touch spelling of
   * "Focus this part" in the information panel.
   */
  function onPointerUp(event: PointerEvent) {
    const wasTracked = activePointers.delete(event.pointerId);
    cancelPendingHover();
    if (!canvasHolder || !wasTracked) return;
    dispatchPointer('up', event.clientX, event.clientY);

    if (activePointers.size === 1) {
      // One finger is still down: it becomes the drag origin, so lifting the other finger does not
      // jump the camera by the distance between them.
      pinch = null;
      const remaining = [...activePointers.values()][0];
      if (remaining) {
        lastPointer = { x: remaining.x, y: remaining.y };
        dragging = 'orbit';
      }
      return;
    }

    pinch = null;
    dragging = null;

    if (event.pointerType !== 'touch') return;
    const now = event.timeStamp;
    const isDoubleTap =
      now - lastTap.at <= DOUBLE_TAP_MS &&
      Math.abs(event.clientX - lastTap.x) <= TAP_SLOP_PX &&
      Math.abs(event.clientY - lastTap.y) <= TAP_SLOP_PX;
    lastTap = { at: now, x: event.clientX, y: event.clientY };
    if (isDoubleTap && selectedPart) host?.focusPart(selectedPart);
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
        <button class="toolbar-btn" title="Reset (R)" onclick={resetModel}>
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
        <button
          class="toolbar-btn toggle-btn"
          title="Add a note (A)"
          class:active={placingNote}
          onclick={toggleNotePlacing}
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            stroke-width="1.5"
          >
            <path d="M2 12.5V14h1.5l7.2-7.2-1.5-1.5L2 12.5z" fill="currentColor" stroke="none" />
            <path d="M11.6 2.9l1.5 1.5" />
          </svg>
          <span>Note</span>
        </button>
        <ExportMenu
          capability={recordingCapability}
          {recording}
          seconds={recordingSeconds}
          onscreenshot={(preset) => host?.requestSnapshot(preset)}
          onstartrecording={startRecording}
          onstoprecording={stopRecording}
        />
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
          title="Generate a model with AI (N)"
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
        <button class="toolbar-btn" title="Gallery (L)" onclick={() => (galleryOpen = true)}>
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
        <button class="toolbar-btn" title="Share / Publish (P)" onclick={shareModel}>
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
          title="Quiz Mode (Q)"
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
          title="Toggle Left Panel ([)"
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
          title="Toggle Right Panel (])"
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
        <button class="toolbar-btn" title="Settings (,)" onclick={() => (settingsOpen = true)}>
          <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"
            ><path
              d="M8 5.5A2.5 2.5 0 1 0 8 10.5 2.5 2.5 0 0 0 8 5.5zm0 3.5a1 1 0 1 1 0-2 1 1 0 0 1 0 2z"
            /><path
              d="M13.3 9.2l1.2-.9-1.2-2.1-1.4.5a4.6 4.6 0 0 0-.9-.5l-.2-1.5H8.2L8 6.2a4.6 4.6 0 0 0-.9.5l-1.4-.5-1.2 2.1 1.2.9a4.5 4.5 0 0 0 0 1l-1.2.9 1.2 2.1 1.4-.5c.3.2.6.4.9.5l.2 1.5h2.6l.2-1.5c.3-.1.6-.3.9-.5l1.4.5 1.2-2.1-1.2-.9a4.5 4.5 0 0 0 0-1z"
              opacity="0.75"
            /></svg
          >
          <span>Settings</span>
        </button>
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
    <aside class="left-panel panel glass-panel" class:collapsed={!leftOpen} class:active={leftOpen}>
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

      <!--
        The model's own labels (`01`: parts self-describing). Beneath the learner notes and inert to
        every pointer event, so a caption can never intercept an orbit or a part selection.
      -->
      <ModelLabels labels={modelLabels} projected={projectedLabels} />

      <!--
        Learner notes (`03` R7). Inside the canvas holder so a pin's canvas-space coordinates are its
        own: the overlay is `pointer-events: none` except on the pins themselves, so orbit never
        notices it.
      -->
      <AnnotationLayer
        pins={notes}
        projected={projectedAnnotations}
        placing={placingNote}
        onplace={(point, partId) => {
          draftAnnotation = {
            id: annotationId(),
            point,
            ...(partId ? { partId } : {}),
            text: '',
            createdAt: Date.now(),
          };
          syncNotes();
        }}
        onremove={deleteNote}
        onedit={saveNote}
        onrequesttext={answerNoteRequest}
      />

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
            onfocus={focusStoryPart}
            onshot={playStoryShot}
            onclose={closeStory}
            narration={settings.current}
          />
        </div>
      {/if}

      <!--
        Loading overlay.

        The unsupported branch comes FIRST, and that ordering is the whole point of it: it used to be
        last in the chain, behind `!engineReady`, so a browser that cannot create a WebGL context —
        the one case it exists for — was told to wait for an engine that was never going to start,
        while the explanation sat unreachable below. A state that cannot be reached is not a state.
      -->
      {#if !support.supported}
        <div class="loading-overlay">
          <div class="loading-content">
            <h2>This browser cannot run the 3D engine</h2>
            <p>{support.reason}</p>
          </div>
        </div>
      {:else if modelLoading}
        <div class="loading-overlay">
          <div class="loading-content">
            <div class="spinner-large"></div>
            <h2>Building {topicName}</h2>
            <p>Authoring and realizing on this device…</p>
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
      {:else if !engineReady}
        <div class="loading-overlay">
          <div class="loading-content">
            <div class="spinner-large"></div>
            <h2>Loading 3D Model</h2>
            <p>Authoring, pricing and realizing on this device…</p>
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
    <aside
      class="right-panel panel glass-panel"
      class:collapsed={!rightOpen}
      class:active={rightOpen}
    >
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
          {:else}
            <p class="loading-state">Loading topic information...</p>
          {/if}

          <!--
            Parts list — the keyboard-reachable selection path.

            It lives outside the branch above on purpose. Every arm used to replace the whole panel,
            so selecting one part removed the list that selecting another part needs: the canvas
            became the only way to change the selection, and a learner without a mouse (or on a
            phone, where the canvas is a thumb) was stuck on the first part they touched. The list is
            the one selection surface that does not depend on hitting geometry, so it stays.
          -->
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
      <div class="stat-item" data-stat="distance" title="Camera distance from its pivot">
        <span class="stat-label">Distance</span>
        <span class="stat-value">{stats ? formatDistance(stats.cameraDistance) : '—'}</span>
      </div>
      <div class="stat-item" data-stat="physics" title={physicsTitle}>
        <span class="stat-label">Physics</span>
        <span class="stat-value" class:warning={physicsUnavailable}>{physicsLabel}</span>
      </div>
      <div
        class="stat-item"
        data-stat="cache"
        title="Geometry and material cache hit rate, as a share of authoring lookups"
      >
        <span class="stat-label">Cache</span>
        <span class="stat-value">
          {stats ? `${Math.round(stats.cacheHitRate * 100)}%` : '—'}
        </span>
      </div>
      <div class="stat-item" data-stat="quality" title={qualityTitle}>
        <span class="stat-label">Quality</span>
        <span class="stat-value" class:warning={qualityDegraded}>{qualityLabel}</span>
      </div>
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

  {#if settingsOpen}
    <SettingsModal
      open={settingsOpen}
      settings={settings.current}
      tier={deviceTier || stats?.effectiveTier || 'mid'}
      onchange={(next) => settings.update(next)}
      onquality={setPinnedQuality}
      onclose={() => (settingsOpen = false)}
    />
  {/if}

  {#if shareModalOpen}
    <ShareModal
      {manifest}
      program={currentProgram}
      requestSnapshot={captureSnapshot}
      onclose={() => (shareModalOpen = false)}
    />
  {/if}

  <!-- ── AI Output viewer ─────────────────────────────────────────────────── -->
  {#if codeViewModalOpen}
    <CodeViewModal
      {manifest}
      code={currentProgram?.code ?? null}
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
