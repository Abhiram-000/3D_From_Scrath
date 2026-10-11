/**
 * The shared ambient interaction layer — a faithful port of V1's `ambient.js`.
 *
 * One rAF loop drives every cursor effect (`07`: "one rAF loop, all effects"), writing only transforms
 * and custom properties so nothing ever animates layout. Five effects, each individually cheap:
 *
 *   1. reactive dot grid — revealed around the pointer through a mask driven by --gx/--gy;
 *   2. trailing spotlight — a soft radial glow that eases behind the cursor;
 *   3. parallax depth — `data-parallax` elements drift against the pointer, per-element strength;
 *   4. magnetic pull — `data-magnetic` elements lean toward the cursor within a radius;
 *   5. sheen — `has-sheen`/`has-glow-border` surfaces catch a light sweep at --sx/--sy.
 *
 * Touch devices and reduced-motion users get the always-on drifting blobs (and a calm idle grid)
 * rather than effects that would follow a cursor they do not have.
 */

const lerp = (from: number, to: number, amount: number): number => from + (to - from) * amount;

interface Magnet {
  el: HTMLElement;
  x: number;
  y: number;
}

interface ParallaxLayer {
  el: HTMLElement;
  depth: number;
  x: number;
  y: number;
}

export interface AmbientOptions {
  grid?: boolean;
  spotlight?: boolean;
  magnetStrength?: number;
  magnetRadius?: number;
  /** Spotlight easing speed; the grid trails slightly slower for depth. */
  ease?: number;
}

export class Ambient {
  private readonly tracking: boolean;
  private readonly magnetStrength: number;
  private readonly magnetRadius: number;
  private readonly ease: number;
  private readonly gridEase = 0.075;

  private layer: HTMLElement | null = null;
  private grid: HTMLElement | null = null;
  private spot: HTMLElement | null = null;
  private frame: number | null = null;

  private readonly magnets: Magnet[] = [];
  private readonly parallax: ParallaxLayer[] = [];
  private readonly sheens: HTMLElement[] = [];

  private pointerX = globalThis.innerWidth / 2;
  private pointerY = globalThis.innerHeight * 0.42;
  private spotX = this.pointerX;
  private spotY = this.pointerY;
  private gridX = this.pointerX;
  private gridY = this.pointerY;
  private active = false;

  private readonly onPointerMove = (event: PointerEvent): void => {
    this.pointerX = event.clientX;
    this.pointerY = event.clientY;
    if (!this.active) {
      this.active = true;
      document.documentElement.classList.add('ambient-active');
      // Start the trailers where the cursor entered so nothing flies across the screen.
      this.spotX = this.pointerX;
      this.spotY = this.pointerY;
      this.gridX = this.pointerX;
      this.gridY = this.pointerY;
    }
  };

  private readonly onPointerLeave = (): void => {
    this.active = false;
    document.documentElement.classList.remove('ambient-active');
  };

  private readonly tick = (): void => {
    this.frame = requestAnimationFrame(this.tick);

    const width = globalThis.innerWidth;
    const height = globalThis.innerHeight;

    // Two speeds give the layers real depth: the spotlight leads, the grid trails.
    this.spotX = lerp(this.spotX, this.pointerX, this.ease);
    this.spotY = lerp(this.spotY, this.pointerY, this.ease);
    this.gridX = lerp(this.gridX, this.pointerX, this.gridEase);
    this.gridY = lerp(this.gridY, this.pointerY, this.gridEase);

    this.spot?.style.setProperty(
      'transform',
      `translate3d(${this.spotX.toFixed(1)}px,${this.spotY.toFixed(1)}px,0) translate(-50%,-50%)`,
    );
    this.grid?.style.setProperty('--gx', `${this.gridX.toFixed(1)}px`);
    this.grid?.style.setProperty('--gy', `${this.gridY.toFixed(1)}px`);

    // Pointer offset from centre, normalised to -1..1; zero when idle so layers settle home.
    let nx = (this.pointerX / width) * 2 - 1;
    let ny = (this.pointerY / height) * 2 - 1;
    if (!this.active) {
      nx = 0;
      ny = 0;
    }

    for (const layer of this.parallax) {
      layer.x = lerp(layer.x, -nx * layer.depth, this.ease);
      layer.y = lerp(layer.y, -ny * layer.depth, this.ease);
      layer.el.style.transform = `translate3d(${layer.x.toFixed(2)}px,${layer.y.toFixed(2)}px,0)`;
    }

    for (const magnet of this.magnets) {
      const rect = magnet.el.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const dx = this.pointerX - cx;
      const dy = this.pointerY - cy;
      const dist = Math.hypot(dx, dy);
      const reach = Math.max(rect.width, rect.height) / 2 + this.magnetRadius;

      let goalX = 0;
      let goalY = 0;
      if (this.active && dist < reach) {
        const falloff = 1 - dist / reach;
        goalX = dx * this.magnetStrength * falloff;
        goalY = dy * this.magnetStrength * falloff;
      }
      magnet.x = lerp(magnet.x, goalX, 0.16);
      magnet.y = lerp(magnet.y, goalY, 0.16);
      magnet.el.style.transform =
        Math.abs(magnet.x) < 0.02 && Math.abs(magnet.y) < 0.02
          ? ''
          : `translate3d(${magnet.x.toFixed(2)}px,${magnet.y.toFixed(2)}px,0)`;
    }

    for (const element of this.sheens) {
      const rect = element.getBoundingClientRect();
      element.style.setProperty('--sx', `${(this.pointerX - rect.left).toFixed(1)}px`);
      element.style.setProperty('--sy', `${(this.pointerY - rect.top).toFixed(1)}px`);
    }
  };

  constructor(options: AmbientOptions = {}) {
    // Cursor tracking only makes sense with a real pointer and motion allowed.
    const finePointer = window.matchMedia('(hover: hover) and (pointer: fine)').matches;
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.tracking = finePointer && !reducedMotion;
    this.magnetStrength = options.magnetStrength ?? 0.12;
    this.magnetRadius = options.magnetRadius ?? 120;
    this.ease = options.ease ?? 0.11;
    this.useGrid = options.grid !== false;
    this.useSpot = options.spotlight !== false;
  }

  private readonly useGrid: boolean;
  private readonly useSpot: boolean;

  mount(): this {
    if (this.layer) return this;

    const layer = document.createElement('div');
    layer.className = 'ambient-layer';
    layer.setAttribute('aria-hidden', 'true');

    // Slow-drifting colour blobs: the always-on base, and the whole show on touch devices.
    const blobA = document.createElement('div');
    blobA.className = 'ambient-blob ambient-blob-a';
    const blobB = document.createElement('div');
    blobB.className = 'ambient-blob ambient-blob-b';
    layer.append(blobA, blobB);

    if (this.useSpot && this.tracking) {
      this.spot = document.createElement('div');
      this.spot.className = 'ambient-spot';
      layer.appendChild(this.spot);
    }

    document.body.appendChild(layer);
    this.layer = layer;

    if (this.useGrid) {
      const grid = document.createElement('div');
      grid.className = 'ambient-grid';
      grid.setAttribute('aria-hidden', 'true');
      // Without a pointer the grid cannot be revealed by a cursor: calm, evenly-lit texture instead.
      if (!this.tracking) grid.classList.add('is-idle');
      document.body.insertBefore(grid, document.body.firstChild);
      this.grid = grid;
    }

    requestAnimationFrame(() => layer.classList.add('is-visible'));

    if (this.tracking) {
      window.addEventListener('pointermove', this.onPointerMove, { passive: true });
      document.addEventListener('pointerleave', this.onPointerLeave, { passive: true });
      window.addEventListener('blur', this.onPointerLeave);
      this.start();
    }
    return this;
  }

  /** Elements that lean toward the cursor. */
  magnetize(selector: string): this {
    if (!this.tracking) return this;
    for (const element of document.querySelectorAll<HTMLElement>(selector)) {
      this.magnets.push({ el: element, x: 0, y: 0 });
    }
    if (this.magnets.length > 0) this.start();
    return this;
  }

  /** Depth layers; each reads its own travel in pixels from `data-parallax`. */
  parallaxize(selector: string): this {
    if (!this.tracking) return this;
    for (const element of document.querySelectorAll<HTMLElement>(selector)) {
      const depth = Number.parseFloat(element.dataset.parallax ?? '');
      this.parallax.push({ el: element, depth: Number.isFinite(depth) ? depth : 12, x: 0, y: 0 });
    }
    if (this.parallax.length > 0) this.start();
    return this;
  }

  /** Glass surfaces that catch a light sweep. */
  sheen(selector: string): this {
    if (!this.tracking) return this;
    for (const element of document.querySelectorAll<HTMLElement>(selector))
      this.sheens.push(element);
    if (this.sheens.length > 0) this.start();
    return this;
  }

  private start(): void {
    if (this.frame === null && this.tracking) this.frame = requestAnimationFrame(this.tick);
  }

  destroy(): void {
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    this.frame = null;
    window.removeEventListener('pointermove', this.onPointerMove);
    document.removeEventListener('pointerleave', this.onPointerLeave);
    window.removeEventListener('blur', this.onPointerLeave);
    this.layer?.remove();
    this.grid?.remove();
    this.layer = null;
    this.grid = null;
  }
}

/** Theme get/set/toggle matching V1's storage key and flash-free swap. */
const THEME_KEY = 'edu3d-theme';

export function getTheme(): 'dark' | 'light' {
  return document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
}

export function setTheme(theme: 'dark' | 'light'): 'dark' | 'light' {
  const root = document.documentElement;
  // Suppress transitions for one frame while tokens swap, so the toggle never shows a half-swapped colour.
  root.classList.add('theme-switching');
  root.setAttribute('data-theme', theme);
  root.style.colorScheme = theme;
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    /* private browsing: the theme still applies for this session */
  }
  // Force a style flush before transitions resume.
  void root.offsetWidth;
  requestAnimationFrame(() => root.classList.remove('theme-switching'));
  document.dispatchEvent(new CustomEvent('edu3d:themechange', { detail: { theme } }));
  return theme;
}

export function toggleTheme(): 'dark' | 'light' {
  return setTheme(getTheme() === 'dark' ? 'light' : 'dark');
}
