/**
 * The loading page's 3D background — an exact port of V1's `loading.js` scene: quiet neural-net
 * points with connection lines drawn between near neighbours, re-tinted on theme change, released
 * explicitly on teardown because "this page exists to navigate away from, and it holds a WebGL
 * context and a render loop".
 */
import * as THREE from 'three';

export class LoadingBackground {
  private frameHandle: number | null = null;
  private running = true;
  private readonly disposers: Array<() => void> = [];

  init(canvas: HTMLCanvasElement): void {
    const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(
      navigator.userAgent,
    );
    const isLowEnd = (navigator.hardwareConcurrency ?? 4) <= 4 || isMobile;

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
    const renderer = new THREE.WebGLRenderer({
      canvas,
      alpha: true,
      antialias: !isMobile,
      powerPreference: isLowEnd ? 'low-power' : 'high-performance',
    });

    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, isLowEnd ? 1.5 : 2));

    const particleCount = isLowEnd ? 60 : 110;
    const positions = new Float32Array(particleCount * 3);
    const velocities: Array<{ x: number; y: number; z: number }> = [];

    for (let i = 0; i < particleCount; i++) {
      positions[i * 3] = (Math.random() - 0.5) * 20;
      positions[i * 3 + 1] = (Math.random() - 0.5) * 20;
      positions[i * 3 + 2] = (Math.random() - 0.5) * 20;

      velocities.push({
        x: (Math.random() - 0.5) * 0.02,
        y: (Math.random() - 0.5) * 0.02,
        z: (Math.random() - 0.5) * 0.02,
      });
    }

    const particlesGeometry = new THREE.BufferGeometry();
    particlesGeometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));

    const particlesMaterial = new THREE.PointsMaterial({
      color: 0x38bdf8,
      size: 0.14,
      transparent: true,
      opacity: 0.6,
      sizeAttenuation: true,
    });

    const particlesMesh = new THREE.Points(particlesGeometry, particlesMaterial);
    scene.add(particlesMesh);

    const linesMaterial = new THREE.LineBasicMaterial({
      color: 0x38bdf8,
      transparent: true,
      opacity: 0.12,
    });

    const linesMesh = new THREE.LineSegments(new THREE.BufferGeometry(), linesMaterial);
    scene.add(linesMesh);

    camera.position.z = 10;

    const animate = () => {
      if (!this.running) return;
      this.frameHandle = requestAnimationFrame(animate);

      const attribute = particlesGeometry.getAttribute('position');
      if (!attribute) return;
      const pos = attribute.array as Float32Array;
      const vAt = (i: number): { x: number; y: number; z: number } =>
        velocities[i] as { x: number; y: number; z: number };

      for (let i = 0; i < particleCount; i++) {
        const v = vAt(i);
        const base = i * 3;
        // Reads go through Number(): noUncheckedIndexedAccess types every typed-array read as
        // `number | undefined`, and this ported V1 arithmetic is bounds-safe by construction —
        // the loop index is bounded by the array that was allocated with it.
        const x = Number(pos[base]);
        const y = Number(pos[base + 1]);
        const z = Number(pos[base + 2]);

        pos[base] = x + v.x;
        pos[base + 1] = y + v.y;
        pos[base + 2] = z + v.z;

        if (Math.abs(x + v.x) > 10) v.x *= -1;
        if (Math.abs(y + v.y) > 10) v.y *= -1;
        if (Math.abs(z + v.z) > 10) v.z *= -1;
      }

      attribute.needsUpdate = true;

      // Rebuild connection lines only every other frame (V1's cheap win).
      const rebuild = (Date.now() & 1) === 0;
      if (rebuild) {
        const linePositions: number[] = [];
        for (let i = 0; i < particleCount; i++) {
          const a = i * 3;
          const ax = Number(pos[a]);
          const ay = Number(pos[a + 1]);
          const az = Number(pos[a + 2]);
          for (let j = i + 1; j < particleCount; j++) {
            const b = j * 3;
            const dx = ax - Number(pos[b]);
            const dy = ay - Number(pos[b + 1]);
            const dz = az - Number(pos[b + 2]);
            if (Math.sqrt(dx * dx + dy * dy + dz * dz) < 3.5) {
              linePositions.push(ax, ay, az, Number(pos[b]), Number(pos[b + 1]), Number(pos[b + 2]));
            }
          }
        }
        linesMesh.geometry.dispose();
        linesMesh.geometry = new THREE.BufferGeometry();
        linesMesh.geometry.setAttribute('position', new THREE.Float32BufferAttribute(linePositions, 3));
      }

      scene.rotation.y += 0.001;
      scene.rotation.x += 0.0005;

      renderer.render(scene, camera);
    };
    animate();

    const onResize = () => {
      camera.aspect = window.innerWidth / window.innerHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(window.innerWidth, window.innerHeight);
    };
    window.addEventListener('resize', onResize);

    const onThemeChange = (event: Event) => {
      const light = (event as CustomEvent<{ theme: string }>).detail.theme === 'light';
      particlesMaterial.color.setHex(light ? 0x0284c7 : 0x38bdf8);
      linesMaterial.color.setHex(light ? 0x0284c7 : 0x38bdf8);
      particlesMaterial.opacity = light ? 0.5 : 0.6;
    };
    document.addEventListener('edu3d:themechange', onThemeChange);

    this.disposers.push(() => {
      this.running = false;
      window.removeEventListener('resize', onResize);
      document.removeEventListener('edu3d:themechange', onThemeChange);
      particlesGeometry.dispose();
      particlesMaterial.dispose();
      linesMesh.geometry.dispose();
      linesMaterial.dispose();
      renderer.dispose();
    });
  }

  destroy(): void {
    for (const dispose of this.disposers) {
      try {
        dispose();
      } catch {
        /* a partial cleanup step must not block the rest */
      }
    }
    this.disposers.length = 0;
  }
}

/**
 * DOM particle accents (`07`): subtle floating depth, suppressed for reduced motion, fewer on
 * mobile — V1's exact distribution.
 */
export function initParticles(container: HTMLElement | null): void {
  if (!container || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(
    navigator.userAgent,
  );
  const count = isMobile ? 14 : 26;

  for (let i = 0; i < count; i++) {
    const particle = document.createElement('div');
    particle.className = 'particle';
    particle.style.left = `${Math.random() * 100}%`;
    particle.style.top = `${Math.random() * 100}%`;
    particle.style.animationDelay = `${Math.random() * 4}s`;
    particle.style.animationDuration = `${Math.random() * 3 + 3}s`;
    container.appendChild(particle);
  }
}
