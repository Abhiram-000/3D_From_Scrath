/**
 * The forbidden-identifier list: every global the guest realm must not be able to name.
 *
 * This list is used three times, and that redundancy is the design. The static gate rejects source
 * that mentions any of these (layer 1); the compiler declares each one as an `undefined` parameter so
 * the name is lexically shadowed whatever exists on the global object (layer 3); and the realm
 * hardening deletes or poisons them before guest code runs (layer 4). Any one layer failing leaves the
 * other two standing, which is the only honest way to treat a boundary that must not be assumed.
 *
 * `00-GOAL.md` states the rule the list enforces: "No DOM, no network, no storage, no globals, no host
 * APIs. One bad model must not be able to touch the page, other models, or the user."
 */

/**
 * Network reach. First on the list because it is the only capability whose abuse is invisible from the
 * page: exfiltrating a learner's topic or beaconing out of a shared model would leave no trace on screen.
 */
export const NETWORK_GLOBALS = Object.freeze([
  'fetch',
  'XMLHttpRequest',
  'WebSocket',
  'EventSource',
  'Request',
  'Response',
  'Headers',
  'navigator',
  'sendBeacon',
  'importScripts',
  'RTCPeerConnection',
  'WebTransport',
]);

/** Persistence. A model that can write storage can outlive its own tab and taint the next model. */
export const STORAGE_GLOBALS = Object.freeze([
  'localStorage',
  'sessionStorage',
  'indexedDB',
  'caches',
  'cookieStore',
  'openDatabase',
  'showOpenFilePicker',
  'showSaveFilePicker',
  'FileSystemHandle',
  'StorageManager',
]);

/**
 * Escape hatches: anything that can reach another realm, spawn one, or address the host.
 *
 * `Worker` matters most. A worker cannot create a fresh realm — there is no iframe and no `Realm`
 * constructor — so deleting `Worker` here is what makes the capability drop *irrecoverable*, which is
 * precisely the property a document-based sandbox cannot offer.
 */
export const REALM_GLOBALS = Object.freeze([
  'Worker',
  'SharedWorker',
  'ServiceWorker',
  'BroadcastChannel',
  'MessageChannel',
  'MessagePort',
  'postMessage',
  'self',
  'globalThis',
  'window',
  'parent',
  'top',
  'frames',
  'opener',
  'document',
  'location',
  'history',
  'customElements',
  'importScripts',
  'WebAssembly',
  'SharedArrayBuffer',
  'Atomics',
  'Notification',
  'PushManager',
]);

/**
 * Dynamic code. Without these the gate is decorative: `eval('fetch')` would resolve `fetch` at runtime
 * regardless of what the source appeared to mention, and `Function('return this')()` is the classic
 * one-line escape from any lexical shadowing.
 */
export const DYNAMIC_CODE_GLOBALS = Object.freeze([
  'eval',
  'Function',
  'AsyncFunction',
  'GeneratorFunction',
  'require',
  'module',
  'exports',
  'process',
  '__dirname',
  '__filename',
  'Deno',
  'Bun',
]);

/**
 * Scheduling. Excluded because the frame loop is the host's clock: a guest timer would run outside the
 * host's deadline accounting, survive a pause, and keep firing after the model was swapped out — the
 * "no stale callbacks fire against the new model" requirement in `03` R6 depends on this.
 */
export const SCHEDULING_GLOBALS = Object.freeze([
  'setTimeout',
  'setInterval',
  'setImmediate',
  'requestAnimationFrame',
  'requestIdleCallback',
  'queueMicrotask',
  'clearTimeout',
  'clearInterval',
  'cancelAnimationFrame',
  'reportError',
]);

/**
 * Ambient device and rendering surfaces. The guest describes a scene; it never touches a GPU context,
 * a media device or a canvas directly. Realization happens on the host side of the boundary.
 */
export const DEVICE_GLOBALS = Object.freeze([
  'OffscreenCanvas',
  'ImageBitmap',
  'createImageBitmap',
  'WebGLRenderingContext',
  'WebGL2RenderingContext',
  'GPU',
  'gpu',
  'AudioContext',
  'webkitAudioContext',
  'MediaRecorder',
  'MediaStream',
  'Bluetooth',
  'usb',
  'serial',
  'hid',
  'geolocation',
  'clipboard',
  'crypto',
  'performance',
]);

/** The union, deduplicated and frozen. This is what the gate and the compiler consult. */
export const FORBIDDEN_GLOBALS: readonly string[] = Object.freeze([
  ...new Set([
    ...NETWORK_GLOBALS,
    ...STORAGE_GLOBALS,
    ...REALM_GLOBALS,
    ...DYNAMIC_CODE_GLOBALS,
    ...SCHEDULING_GLOBALS,
    ...DEVICE_GLOBALS,
  ]),
]);

/**
 * Names denied to the guest but **retained by the host realm**.
 *
 * This distinction is load-bearing, and getting it wrong broke the viewer once: the sandbox worker *is* the host of
 * the render loop, so deleting `requestAnimationFrame` and `performance` from its global stopped the engine one
 * frame after the first model loaded. Three.js needs them too.
 *
 * These names are still completely unavailable to guest code — the static gate rejects the identifier (layer 1) and
 * the compiler binds it as an `undefined` parameter (layer 3) — so nothing is conceded. What changes is only *how*
 * they are denied: by lexical shadowing rather than by realm deletion.
 *
 * The list is deliberately short, and every entry is a scheduler or a clock rather than a capability: none of them
 * can reach the network, storage, another realm, or the page. `fetch` will never appear here.
 */
export const HOST_RETAINED_GLOBALS: readonly string[] = Object.freeze([
  ...SCHEDULING_GLOBALS,
  // A clock. The guest gets authored time through `ctx.time`, so it has no reason to ask for this one — but the
  // renderer measures frame cost with it, and `03` R9 requires every number on screen to be measured.
  'performance',
  // The renderer holds its `OffscreenCanvas` instance already; the constructor is what gets removed. `ImageBitmap`
  // and `createImageBitmap` stay because snapshot capture uses them on the host side.
  'createImageBitmap',
  'ImageBitmap',
]);

/**
 * Capabilities actually deleted from the realm.
 *
 * Everything genuinely dangerous — network, storage, realm escape, DOM, dynamic code, device access — with the
 * host-retained schedulers and clocks removed. This is what `hardenRealm` and `hardeningScript` operate on.
 */
export const REALM_DELETIONS: readonly string[] = Object.freeze(
  FORBIDDEN_GLOBALS.filter((name) => !HOST_RETAINED_GLOBALS.includes(name)),
);

/**
 * Property names that reach the intrinsics from an ordinary object.
 *
 * `({}).constructor.constructor('return this')()` is the canonical realm escape, and `__proto__`
 * assignment is how a guest would poison a shared prototype to affect the host after it returns. The
 * gate rejects these as *member expressions* rather than as identifiers, so an object legitimately
 * named `constructor` in a scene is unaffected.
 */
export const FORBIDDEN_MEMBERS = Object.freeze([
  '__proto__',
  '__defineGetter__',
  '__defineSetter__',
  '__lookupGetter__',
  '__lookupSetter__',
  'constructor',
  'prototype',
]);

/**
 * Intrinsics whose prototypes are frozen before guest code runs.
 *
 * Freezing is not about stopping the guest from breaking itself — it is about the *next* model. The
 * realm is reused across builds in the Node audit host, and a guest that patches `Array.prototype.map`
 * would silently change how every later model behaves. Freezing makes the realm's state a constant.
 */
export const FROZEN_INTRINSICS = Object.freeze([
  'Object',
  'Array',
  'Function',
  'String',
  'Number',
  'Boolean',
  'Symbol',
  'Math',
  'JSON',
  'Map',
  'Set',
  'WeakMap',
  'WeakSet',
  'Promise',
  'RegExp',
  'Date',
  'Error',
  'TypeError',
  'RangeError',
  'ArrayBuffer',
  'DataView',
  'Int8Array',
  'Uint8Array',
  'Int16Array',
  'Uint16Array',
  'Int32Array',
  'Uint32Array',
  'Float32Array',
  'Float64Array',
  'BigInt',
  'Proxy',
  'Reflect',
]);

/**
 * Names the guest *does* receive, so the gate can tell a legitimate reference from a hallucinated one.
 *
 * Deliberately tiny, and deliberately *only* names a host actually binds: every host (browser
 * guest, node host, worker) injects exactly `scene`, `geom`, `mat` and the pure `M` math
 * namespace. Advertising a name no host binds turns a following model into a runtime crash —
 * `phys` sat here unbound until Phase 1b removed it; physics is declarative (`scene.physics` →
 * `manifest.physics` → the runtime solver), and real solver vocabulary gets exposed properly in
 * Phase 7. `console` is present because a model that cannot log is a model nobody can debug, and
 * the host routes it into the diagnostics panel rather than the real console.
 */
export const GUEST_BINDINGS = Object.freeze([
  'scene',
  'geom',
  'mat',
  'M',
  'console',
  'random',
]);
