/**
 * Export that is real (`00-GOAL.md`: "Screenshots at multiple resolutions (HD, Full HD, 4K)" and
 * "Video clip recording of the viewport"; `03` R8).
 *
 * Three things are pinned here, all of them honesty problems rather than feature problems:
 *
 *   1. **The snapshot restore is verified.** Rendering a 4K file means resizing the drawing buffer to
 *      4K and back. If the "back" half silently failed, every later frame would cost four times the
 *      fragments and the learner would have paid for one export for the rest of the session — so the
 *      restore is checked against the renderer, and a renderer that refuses the restore is *detected*.
 *   2. **The WebM container is structurally real.** WebCodecs returns encoded chunks, not a file, and
 *      the platform ships no muxer. The bytes built here are parsed back element by element, because a
 *      blob whose magic bytes are wrong is not a clip — it is a file that claims to be one.
 *   3. **No recording is faked.** With no `VideoEncoder` (the Node case, and the platform's honest
 *      degraded state) a request produces a `recordingFailed` with a reason, never an empty clip and
 *      never silence.
 *
 * The worker module is imported with its worker globals stubbed, as the other worker suites do.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import type * as WorkerModule from './sandbox-worker.ts';

const posted: Array<Record<string, unknown>> = [];
vi.stubGlobal('postMessage', (message: unknown) => {
  posted.push(message as Record<string, unknown>);
});
vi.stubGlobal('requestAnimationFrame', (_cb: (t: number) => void) => 0);
vi.stubGlobal('setInterval', () => 0);
vi.stubGlobal('addEventListener', () => undefined);

/**
 * A renderer double that actually keeps the numbers `setSize`/`setPixelRatio` write, so the restore
 * can be observed rather than assumed. `ignoreResize` models a renderer that silently refuses the
 * restore — the case the verification exists to catch.
 */
function makeRenderer() {
  const size = { x: 800, y: 600, pixelRatio: 2 };
  return {
    size,
    ignoreResize: false,
    setPixelRatio(value: number): void {
      if (this.ignoreResize) return;
      size.pixelRatio = value;
    },
    getPixelRatio(): number {
      return size.pixelRatio;
    },
    setSize(width: number, height: number, _updateStyle?: boolean): void {
      if (this.ignoreResize) return;
      size.x = width;
      size.y = height;
    },
    getSize(target: THREE.Vector2): THREE.Vector2 {
      target.x = size.x;
      target.y = size.y;
      return target;
    },
  };
}

type FakeRenderer = ReturnType<typeof makeRenderer>;

function makeState(renderer: FakeRenderer = makeRenderer()): WorkerModule.WorkerState {
  return {
    renderer: renderer as unknown as THREE.WebGLRenderer,
    camera: new THREE.PerspectiveCamera(45, 800 / 600, 0.01, 2000),
    width: 800,
    height: 600,
    videoCapability: null,
    recording: null,
  } as unknown as WorkerModule.WorkerState;
}

beforeEach(() => {
  posted.length = 0;
});

describe('snapshot resolution', () => {
  it('renders at the authored size and restores the previous size exactly', async () => {
    const worker = await import('./sandbox-worker.ts');
    const target = makeState();

    const { restore, width, height } = worker.beginSnapshot(target, 3840, 2160);

    // The export render is pixel-exact: 4K means 4K, not 4K times the device pixel ratio.
    expect({ width, height }).toEqual({ width: 3840, height: 2160 });
    expect(target.renderer.getSize(new THREE.Vector2())).toMatchObject({ x: 3840, y: 2160 });
    expect(target.renderer.getPixelRatio()).toBe(1);
    expect(target.camera.aspect).toBeCloseTo(3840 / 2160, 9);

    // And the restore is exact, so a 4K export cannot leave the canvas stuck at 4K.
    expect(worker.endSnapshot(target, restore)).toBe(true);
    expect(target.renderer.getSize(new THREE.Vector2())).toMatchObject({ x: 800, y: 600 });
    expect(target.renderer.getPixelRatio()).toBe(2);
    expect(target.camera.aspect).toBeCloseTo(800 / 600, 9);
    expect(target.needsRender).toBe(true);
  });

  it('caps the export edge so a 4K-file request cannot allocate a buffer the GPU refuses', async () => {
    const worker = await import('./sandbox-worker.ts');
    const target = makeState();

    const { width, height } = worker.beginSnapshot(target, 100_000, 100_000);

    expect(width).toBe(worker.MAX_SNAPSHOT_EDGE);
    expect(height).toBe(worker.MAX_SNAPSHOT_EDGE);
  });

  it('reports a failed restore instead of pretending the view came back', async () => {
    const worker = await import('./sandbox-worker.ts');
    const renderer = makeRenderer();
    const target = makeState(renderer);

    const { restore } = worker.beginSnapshot(target, 3840, 2160);

    // The renderer honours the export resize but silently refuses the restore, which is exactly the
    // failure that would otherwise leave every later frame rendering at 4K.
    renderer.ignoreResize = true;

    expect(worker.endSnapshot(target, restore)).toBe(false);
  });
});

describe('the WebM container', () => {
  /** The leading-one-bit length prefix both EBML ids and sizes use. */
  function vintLength(firstByte: number): number {
    for (let length = 1; length <= 8; length += 1) {
      if ((firstByte & (0x80 >> (length - 1))) !== 0) return length;
    }
    return 8;
  }

  interface Element {
    id: number;
    payloadOffset: number;
    end: number;
  }

  function readElement(bytes: Uint8Array, offset: number): Element {
    const idLength = vintLength(bytes[offset] ?? 0);
    let id = 0;
    for (let index = 0; index < idLength; index += 1) id = id * 256 + (bytes[offset + index] ?? 0);

    const sizeOffset = offset + idLength;
    const sizeLength = vintLength(bytes[sizeOffset] ?? 0);
    // Mask off the length marker to leave the raw size.
    let size = (bytes[sizeOffset] ?? 0) & (0xff >> sizeLength);
    for (let index = 1; index < sizeLength; index += 1) {
      size = size * 256 + (bytes[sizeOffset + index] ?? 0);
    }
    const payloadOffset = sizeOffset + sizeLength;
    return { id, payloadOffset, end: payloadOffset + size };
  }

  /** Walk a container's direct children; `size` fields must tile its payload exactly. */
  function children(bytes: Uint8Array, parent: Element): Element[] {
    const found: Element[] = [];
    let offset = parent.payloadOffset;
    while (offset < parent.end) {
      const child = readElement(bytes, offset);
      expect(child.end, 'every element size must land inside its parent').toBeLessThanOrEqual(
        parent.end,
      );
      found.push(child);
      offset = child.end;
    }
    expect(offset, 'child sizes must tile the parent payload with no gap').toBe(parent.end);
    return found;
  }

  const frames = [
    { data: Uint8Array.of(0x10, 0x20, 0x30), timestampUs: 0, key: true },
    { data: Uint8Array.of(0x40, 0x50), timestampUs: 33_000, key: false },
    { data: Uint8Array.of(0x60, 0x70, 0x80, 0x90), timestampUs: 66_000, key: false },
  ];

  it('is a complete EBML document a decoder can walk', async () => {
    const worker = await import('./sandbox-worker.ts');
    const bytes = worker.muxWebmVp8(frames, 1280, 720, 1000 / 30);

    // EBML magic.
    expect([...bytes.subarray(0, 4)]).toEqual([0x1a, 0x45, 0xdf, 0xa3]);
    // The DocType, codec and dimension strings the container declares.
    const text = new TextDecoder().decode(bytes);
    expect(text).toContain('webm');
    expect(text).toContain('V_VP8');
    expect(text).toContain('edu3d');

    const header = readElement(bytes, 0);
    expect(header.id).toBe(0x1a45dfa3);
    const segment = readElement(bytes, header.end);
    expect(segment.id).toBe(0x18538067);
    expect(segment.end).toBe(bytes.byteLength);

    const segmentChildren = children(bytes, segment);
    const ids = segmentChildren.map((element) => element.id);
    expect(ids).toContain(0x1549a966); // Info
    expect(ids).toContain(0x1654ae6b); // Tracks

    const clusters = segmentChildren.filter((element) => element.id === 0x1f43b675);
    expect(clusters).toHaveLength(1);

    // Every frame became exactly one SimpleBlock, in order.
    const blocks = children(bytes, clusters[0]!);
    const blockElements = blocks.filter((element) => element.id === 0xa3);
    expect(blockElements).toHaveLength(frames.length);

    for (let index = 0; index < frames.length; index += 1) {
      const block = blockElements[index]!;
      const payload = bytes.subarray(block.payloadOffset, block.end);
      expect(payload[0], 'track number, one-byte vint').toBe(0x81);
      expect(payload[3], 'keyframe flag').toBe(index === 0 ? 0x80 : 0x00);
      expect([...payload.subarray(4)]).toEqual([...frames[index]!.data]);
    }
  });

  it('declares the encoded pixel dimensions', async () => {
    const worker = await import('./sandbox-worker.ts');
    const bytes = worker.muxWebmVp8(frames, 1920, 1080, 1000 / 30);

    const header = readElement(bytes, 0);
    const segment = readElement(bytes, header.end);
    const segmentChildren = children(bytes, segment);
    const tracks = segmentChildren.find((element) => element.id === 0x1654ae6b)!;
    const trackEntry = children(bytes, tracks).find((element) => element.id === 0xae)!;
    const video = children(bytes, trackEntry).find((element) => element.id === 0xe0)!;
    const videoChildren = children(bytes, video);
    const pixelWidth = videoChildren.find((element) => element.id === 0xb0)!;
    const pixelHeight = videoChildren.find((element) => element.id === 0xba)!;

    // Big-endian unsigned integers: 1920 = 0x0780, 1080 = 0x0438.
    expect([...bytes.subarray(pixelWidth.payloadOffset, pixelWidth.end)]).toEqual([0x07, 0x80]);
    expect([...bytes.subarray(pixelHeight.payloadOffset, pixelHeight.end)]).toEqual([0x04, 0x38]);
  });

  it('produces nothing rather than an empty container when there are no frames', async () => {
    const worker = await import('./sandbox-worker.ts');
    expect(worker.muxWebmVp8([], 640, 480, 33).byteLength).toBe(0);
  });
});

describe('recording capability', () => {
  it('refuses honestly instead of delivering a clip that never happened', async () => {
    const worker = await import('./sandbox-worker.ts');
    const target = makeState();

    worker.startRecording(target, 30);

    expect(target.recording).toBeNull();
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({ type: 'recordingFailed' });
    expect(String((posted[0] as { message: string }).message)).toMatch(/not available/i);
  });

  it('reports the device’s real capability, with the caps it will enforce', async () => {
    const worker = await import('./sandbox-worker.ts');
    const { VIDEO_CLIP_LIMITS } = await import('@edu3d/contracts');
    const target = makeState();

    await worker.probeVideoCapability(target);

    // Node has no `VideoEncoder`, which is exactly the platform's honest degraded state: unsupported,
    // with a reason, and never a claim the device cannot back.
    expect(target.videoCapability?.supported).toBe(false);
    expect(target.videoCapability?.reason).toBeTruthy();
    expect(target.videoCapability).toMatchObject({
      maxSeconds: VIDEO_CLIP_LIMITS.maxSeconds,
      maxBytes: VIDEO_CLIP_LIMITS.maxBytes,
    });
    expect(posted.at(-1)).toMatchObject({ type: 'capabilities' });
  });
});
