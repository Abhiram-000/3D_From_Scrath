/**
 * The landing page's 3D wireframe background — an exact port of V1's `landing.js` scene.
 *
 * Floating translucent wireframe polyhedra (icosahedra, octahedra, tori…) drifting and rotating
 * slowly — "a visual promise of what the platform makes" (`07`). Corner-biased placement keeps the
 * center clear for the headline. Device-aware throughout: fewer shapes and lower opacity on low-end
 * devices, capped pixel ratio, antialiasing only where it is affordable, and a graceful hide if
 * WebGL fails. Re-tints on the theme-change event the shared ambient layer dispatches.
 */
import * as THREE from 'three';

/** Wireframe palette per theme — Sunset Graphite's single warm hue family. */
const DARK_SHAPE_COLORS = [0xc2885c, 0xd4a055, 0xe8c882, 0xf4ecd8, 0xa56f3f, 0xc2885c, 0xb5842f];
const LIGHT_SHAPE_COLORS = [0xa56f3f, 0xb5842f, 0x8a5a2e, 0xc2885c, 0x6b5b7a, 0xa56f3f, 0x4a4138];

export class LandingBackground {
  private animationFrameId: number | null = null;
  private scene: THREE.Scene | null = null;
  private camera: THREE.PerspectiveCamera | null = null;
  private renderer: THREE.WebGLRenderer | null = null;
  private shapes: THREE.Mesh[] = [];

  private readonly isMobile: boolean;
  private readonly isLowEnd: boolean;

  constructor() {
    this.isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(
      navigator.userAgent,
    );
    this.isLowEnd = (navigator.hardwareConcurrency ?? 4) <= 4 || this.isMobile;
  }

  init(canvas: HTMLCanvasElement): void {
    try {
      this.scene = new THREE.Scene();
      this.camera = new THREE.PerspectiveCamera(
        60,
        window.innerWidth / window.innerHeight,
        0.1,
        2000,
      );

      this.renderer = new THREE.WebGLRenderer({
        canvas,
        alpha: true,
        antialias: !this.isMobile,
        powerPreference: this.isLowEnd ? 'low-power' : 'high-performance',
      });

      this.renderer.setSize(window.innerWidth, window.innerHeight);
      this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, this.isLowEnd ? 1.5 : 2));

      const geometries = [
        new THREE.IcosahedronGeometry(1.2, 0),
        new THREE.OctahedronGeometry(1.3, 0),
        new THREE.TetrahedronGeometry(1.1, 0),
        new THREE.TorusGeometry(0.8, 0.3, 16, 32),
        new THREE.DodecahedronGeometry(1, 0),
        new THREE.SphereGeometry(0.9, 16, 16),
        new THREE.BoxGeometry(1.5, 1.5, 1.5),
      ];

      // `project()` reads the camera's world matrix, which a camera outside a rendered scene has
      // never computed; without this every projection returns the identity and the clearance test
      // silently passes every shape through.
      this.camera.updateMatrixWorld();

      const shapeCount = this.isLowEnd ? 12 : 20;
      const theme =
        document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
      const colors = theme === 'light' ? LIGHT_SHAPE_COLORS : DARK_SHAPE_COLORS;

      for (let i = 0; i < shapeCount; i++) {
        const geometry = geometries[i % geometries.length] as THREE.BufferGeometry;
        const material = new THREE.MeshBasicMaterial({
          color: colors[i % colors.length],
          wireframe: true,
          transparent: true,
          opacity: this.isLowEnd ? 0.09 : 0.14,
        });

        const mesh = new THREE.Mesh(geometry, material);

        // Bias toward corners/edges, keep center clearer for text — V1's exact distribution.
        const cornerBias = Math.random() < 0.6;
        let x: number;
        let y: number;

        if (cornerBias) {
          const quadrant = Math.floor(Math.random() * 4);
          const baseDist = 28 + Math.random() * 12;
          const angleOffset = (Math.random() - 0.5) * 0.8;

          let baseAngle: number;
          switch (quadrant) {
            case 0:
              baseAngle = -2.356;
              break; // top-left (-135°)
            case 1:
              baseAngle = -0.785;
              break; // top-right (-45°)
            case 2:
              baseAngle = 0.785;
              break; // bottom-right (45°)
            default:
              baseAngle = 2.356;
              break; // bottom-left (135°)
          }
          const angle = baseAngle + angleOffset;
          x = Math.cos(angle) * baseDist;
          y = Math.sin(angle) * baseDist;
        } else {
          x = (Math.random() - 0.5) * 20;
          y = (Math.random() - 0.5) * 20;
        }

        const z = (Math.random() - 0.5) * 30 - 5;
        mesh.position.set(x, y, z);
        this.pushClearOfCopy(mesh);
        mesh.rotation.set(
          Math.random() * Math.PI * 2,
          Math.random() * Math.PI * 2,
          Math.random() * Math.PI * 2,
        );

        const scale = 0.7 + Math.random() * 1.4;
        mesh.scale.set(scale, scale, scale);

        mesh.userData = {
          rotationSpeed: {
            x: (Math.random() - 0.5) * 0.005,
            y: (Math.random() - 0.5) * 0.005,
            z: (Math.random() - 0.5) * 0.004,
          },
          floatSpeed: Math.random() * 0.0006 + 0.0004,
          floatOffset: Math.random() * Math.PI * 2,
          driftSpeed: {
            x: (Math.random() - 0.5) * 0.01,
            y: (Math.random() - 0.5) * 0.01,
          },
          /*
           * The authored home of the shape, kept so the float can be *computed from* it rather than
           * added to it. The placement above deliberately biases shapes into the four corners so the
           * field frames a 640px content column instead of sitting behind it — but the animation
           * used to accumulate (`position.x += …`), which is an integrator, not an oscillator: every
           * frame added a signed delta to a running total, so any bias in the mean walked the shape
           * out of its corner and, over a page's lifetime, into the headline. This is task 9.2 of
           * the production-gap plan ("the composition stops drifting apart"), fixed at the source.
           */
          basePosition: { x, y },
        };

        this.shapes.push(mesh);
        this.scene.add(mesh);
      }

      this.camera.position.z = 8;
      this.animate();

      window.addEventListener('resize', this.handleResize, { passive: true });
      document.addEventListener('edu3d:themechange', this.onThemeChange as EventListener);
    } catch {
      // A failed background must never take the page: hide the canvas and let the hero carry it (`07`).
      canvas.style.display = 'none';
    }
  }

  private readonly handleResize = (): void => {
    if (!this.camera || !this.renderer) return;
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(window.innerWidth, window.innerHeight);
  };

  private readonly onThemeChange = (event: Event): void => {
    const theme = (event as CustomEvent<{ theme: 'dark' | 'light' }>).detail.theme;
    if (!this.shapes || this.shapes.length === 0) return;

    const colors = theme === 'light' ? LIGHT_SHAPE_COLORS : DARK_SHAPE_COLORS;
    const opacity = theme === 'light' ? 0.12 : 0.14;

    this.shapes.forEach((shape, index) => {
      if (shape.material) {
        (shape.material as THREE.MeshBasicMaterial).color.setHex(
          colors[index % colors.length] as number,
        );
        (shape.material as THREE.MeshBasicMaterial).opacity = this.isLowEnd
          ? Math.min(opacity, 0.09)
          : opacity;
      }
    });
  };

  /**
   * Walk a shape sideways until it no longer lands on the copy.
   *
   * Placement biases shapes toward the corners in *world* space, which is not the same as screen
   * space: a 60° perspective camera with z anywhere in -20..+10 puts a 45° world corner anywhere on
   * screen. Some shapes therefore landed directly on the headline — the one element on the page
   * that has to stay legible, and the largest. Rather than fight the projection, this asks where the
   * shape actually ends up and walks it outward until it is clear, measuring against the same 640px
   * column the hero reserves.
   *
   * Runs once at init, so it costs one projection per shape — and the float is computed from the
   * corrected base, so the clearance holds for the life of the page rather than decaying.
   */
  private pushClearOfCopy(mesh: THREE.Mesh): void {
    if (!this.camera) return;
    const projected = new THREE.Vector3();
    const copyFraction = Math.min(640, window.innerWidth) / window.innerWidth;
    for (let attempt = 0; attempt < 8; attempt++) {
      projected.copy(mesh.position).project(this.camera);
      if (Math.abs(projected.x) >= copyFraction) return;
      // Push toward whichever edge it is already nearer; dead centre picks one at random.
      const direction = projected.x === 0 ? (Math.random() < 0.5 ? -1 : 1) : Math.sign(projected.x);
      mesh.position.x += direction * 7;
    }
  }

  private animate = (): void => {
    this.animationFrameId = requestAnimationFrame(this.animate);
    if (!this.camera || !this.renderer || !this.scene) return;

    const time = Date.now();

    for (const shape of this.shapes) {
      shape.rotation.x += (shape.userData.rotationSpeed as { x: number }).x;
      shape.rotation.y += (shape.userData.rotationSpeed as { y: number }).y;
      shape.rotation.z += (shape.userData.rotationSpeed as { z: number }).z;

      const t = time * (shape.userData.floatSpeed as number);
      const offset = shape.userData.floatOffset as number;
      // Base-relative, so the oscillation is bounded and periodic: a shape returns to the corner it
      // was placed in forever instead of walking out of it.
      const base = shape.userData.basePosition as { x: number; y: number };
      shape.position.y = base.y + Math.sin(t + offset) * 0.008;
      shape.position.x =
        base.x + Math.cos(t * 0.7 + offset) * (shape.userData.driftSpeed as { x: number }).x * 0.01;
    }

    this.renderer.render(this.scene, this.camera);
  };

  destroy(): void {
    if (this.animationFrameId) cancelAnimationFrame(this.animationFrameId);
    this.animationFrameId = null;

    for (const shape of this.shapes) {
      shape.geometry.dispose();
      (shape.material as THREE.Material).dispose();
    }
    this.shapes = [];

    this.renderer?.dispose();
    window.removeEventListener('resize', this.handleResize);
    document.removeEventListener('edu3d:themechange', this.onThemeChange as EventListener);
  }
}
