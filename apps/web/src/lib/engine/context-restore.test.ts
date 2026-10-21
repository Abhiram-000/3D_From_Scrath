/**
 * The WebGL context-recovery contract.
 *
 * The audit found the recovery theatre: a `RESOURCE_TEXTURES` set declared, iterated on restore,
 * and never populated by anything — so the restore loop marked zero textures, `renderer.render`
 * kept running against the dead context every frame, and the UI posted "Graphics memory restored —
 * the model is back" regardless. A false recovery message is worse than an honest failure, so the
 * fix makes recovery real: the set is populated from the model's materials at load, textures are
 * re-uploaded on restore, and rendering pauses while the context is gone (the browser is trying to
 * reclaim memory; drawing into it fights the reclaim).
 */
import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { collectModelTextures, reuploadTextures } from './context-restore';

describe('collecting the textures a context loss would destroy', () => {
  it('finds texture-bearing materials on meshes', () => {
    const map = new THREE.Texture();
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshStandardMaterial({ map, emissiveMap: new THREE.Texture() }),
    );
    const root = new THREE.Group();
    root.add(mesh);

    const textures = collectModelTextures(root);
    expect(textures.size).toBe(2);
  });

  it('covers material arrays and instanced meshes', () => {
    const a = new THREE.Texture();
    const b = new THREE.Texture();
    const geometry = new THREE.BoxGeometry(1, 1, 1);
    const instanced = new THREE.InstancedMesh(
      geometry,
      [
        new THREE.MeshStandardMaterial({ map: a }),
        new THREE.MeshStandardMaterial({ colorMapPlaceholder: b } as never),
      ],
      1,
    );
    const root = new THREE.Group();
    root.add(instanced);

    const textures = collectModelTextures(root);
    // `colorMapPlaceholder` is not a real channel — only the real ones count.
    expect(textures.has(a)).toBe(true);
    expect(textures.has(b)).toBe(false);
  });

  it('tolerates parts without materials and materials without textures', () => {
    const root = new THREE.Group();
    const plain = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial());
    const naked = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
    root.add(plain, naked, new THREE.Group());

    const textures = collectModelTextures(root);
    expect(textures.size).toBe(0);
  });
});

describe('re-uploading the survivors', () => {
  it('marks every collected texture for re-upload', () => {
    // `needsUpdate` is a set-only accessor in three (it bumps the texture's version), so the test
    // observes the setter rather than reading the property back.
    const a = new THREE.Texture();
    const b = new THREE.Texture();
    const spyA = vi.spyOn(a, 'needsUpdate', 'set');
    const spyB = vi.spyOn(b, 'needsUpdate', 'set');

    reuploadTextures([a, b]);
    expect(spyA).toHaveBeenCalledWith(true);
    expect(spyB).toHaveBeenCalledWith(true);
  });

  it('tolerates gaps in the set (a disposed entry should not break the loop)', () => {
    const a = new THREE.Texture();
    const spy = vi.spyOn(a, 'needsUpdate', 'set');
    reuploadTextures([null as never, a, undefined as never]);
    expect(spy).toHaveBeenCalledWith(true);
  });
});
