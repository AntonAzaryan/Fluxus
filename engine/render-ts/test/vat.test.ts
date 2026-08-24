/**
 * VAT-материал и набор вариантов скина батчевого яруса (REND-20, REND-6,
 * `assets` ASSET-12).
 *
 * Компилятора GLSL в headless-прогоне нет, но `onBeforeCompile` — обычная
 * функция над строками, и её работу проверить МОЖНО: зовём её тем же объектом
 * шейдера, что подсовывает рендерер, и смотрим, что подменено и что связано.
 * Так под тестом оказывается всё, кроме самого компилятора драйвера.
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import type { DecodedImage, VisualManifest } from '@fluxus/assets';
import {
  ModelsSubsystem,
  createSkinPlaceholder,
  createVatMaterial,
  createVatTexture,
  materialMapKinds,
  skinVariantNames,
  type RenderContext,
  type VatMapKind,
} from '../src/index.js';
import { makeAssets, makeEntityView, makeModel, makeTickView } from './fixtures.js';

const MODEL_ID = 'models/runner.mdx';

/** Тот же объект, что рендерер отдаёт в `onBeforeCompile`. */
function shaderStub(): {
  uniforms: Record<string, { value: unknown }>;
  vertexShader: string;
  fragmentShader: string;
} {
  return {
    uniforms: {},
    vertexShader: THREE.ShaderLib.physical.vertexShader,
    fragmentShader: THREE.ShaderLib.physical.fragmentShader,
  };
}

function compile(maps: Iterable<VatMapKind>): ReturnType<typeof shaderStub> {
  const texture = createVatTexture(8, 2, new Float32Array(8 * 2 * 4));
  const vat = createVatMaterial(
    new THREE.MeshStandardMaterial(),
    texture,
    new Set(maps),
    createSkinPlaceholder(),
  );
  const shader = shaderStub();
  vat.material.onBeforeCompile(shader as unknown as THREE.WebGLProgramParametersWithUniforms, null!);
  return shader;
}

describe('VAT-материал: подмена скиннинга (REND-20, ASSET-12)', () => {
  it('скиннинг идёт по VAT-текстуре, а не по костям скелета', () => {
    const shader = compile([]);
    // Атрибуты скининга объявлены руками: батч — не SkinnedMesh, и USE_SKINNING
    // three не поднимает, а буферы у геометрии те же самые.
    expect(shader.vertexShader).toContain('attribute vec4 skinIndex;');
    expect(shader.vertexShader).toContain('attribute vec4 instancePose;');
    expect(shader.vertexShader).toContain('texelFetch( vatMap');
    // Chunk'и скининга three заменены целиком — ни один не остался.
    expect(shader.vertexShader).not.toContain('#include <skinbase_vertex>');
    expect(shader.vertexShader).not.toContain('#include <skinning_vertex>');
    expect(shader.vertexShader).not.toContain('#include <skinnormal_vertex>');
    // Поза считается один раз на вершину: выборок из VAT не вдвое больше.
    expect(shader.vertexShader.split('vatSkinMatrix()').length - 1).toBe(2);
    expect(shader.uniforms.vatMap!.value).not.toBeNull();
  });

  it('карты читаются из массива вариантов только у тех видов, что у материала есть', () => {
    const base = compile(['base']);
    expect(base.fragmentShader).toContain('uniform highp sampler2DArray vatSkinBase;');
    expect(base.fragmentShader).toContain('texture( vatSkinBase, vec3( vMapUv, vSkinLayer ) )');
    // Материал без карты нормалей сэмплера под неё не объявляет и chunk не трогает.
    expect(base.fragmentShader).not.toContain('vatSkinNormal');
    expect(base.fragmentShader).toContain('#include <normal_fragment_maps>');
    expect(base.uniforms.vatSkinBase).toBeDefined();
    expect(base.uniforms.vatSkinNormal).toBeUndefined();

    const full = compile(['base', 'normal', 'emissive']);
    expect(full.fragmentShader).toContain('texture( vatSkinNormal, vec3( vNormalMapUv, vSkinLayer ) )');
    expect(full.fragmentShader).toContain(
      'texture( vatSkinEmissive, vec3( vEmissiveMapUv, vSkinLayer ) )',
    );
    expect(full.fragmentShader).not.toContain('#include <map_fragment>');
  });

  it('ключ кэша программы различает материалы с разным набором карт', () => {
    const texture = createVatTexture(4, 1, new Float32Array(16));
    const placeholder = createSkinPlaceholder();
    const source = new THREE.MeshStandardMaterial();
    const a = createVatMaterial(source, texture, new Set<VatMapKind>(['base']), placeholder);
    const b = createVatMaterial(source, texture, new Set<VatMapKind>([]), placeholder);
    expect(a.material.customProgramCacheKey()).not.toBe(b.material.customProgramCacheKey());
    // Исходный материал ассета не тронут: он разделяется детальным ярусом.
    expect(source.map).toBeNull();
    expect(a.material).not.toBe(source);
  });

  it('виды карт материала выводятся из слотов текстур модели (ASSET-5)', () => {
    const model = makeModel();
    expect([...materialMapKinds(model.materials[0]!)]).toEqual(['base']);
  });
});

// ------------------------------------------------------- варианты скинов

describe('набор вариантов скина записи (REND-6, ASSET-12)', () => {
  function image(width: number, height: number, fill: number): DecodedImage {
    return {
      width,
      height,
      format: 'rgba8',
      pixels: new Uint8Array(width * height * 4).fill(fill),
    };
  }

  const manifest: VisualManifest = {
    entities: {
      Runner: {
        model: MODEL_ID,
        defaultSkin: 'red',
        skins: { red: { '0': 'tex/red.png' }, blue: { '0': 'tex/blue.png' } },
      },
    },
  };

  it('порядок вариантов не зависит от порядка ключей записи', () => {
    expect(skinVariantNames(manifest.entities.Runner)).toEqual(['', 'blue', 'red']);
    // Тот же состав, другой порядок ключей — тот же порядок индексов: иначе
    // переподача манифеста (REND-17) переставляла бы скины живым записям.
    expect(
      skinVariantNames({ model: MODEL_ID, skins: { red: {}, blue: {} } }),
    ).toEqual(['', 'blue', 'red']);
  });

  it('пиксели вариантов приезжают слоями массива и связываются с материалом', () => {
    const assets = makeAssets();
    const ctx: RenderContext = {
      scene: new THREE.Scene(),
      assets: assets.service,
      config: { heightStep: 0.5 },
    };
    const subsystem = new ModelsSubsystem(manifest, { warn: () => {} });
    subsystem.init(ctx);
    subsystem.syncTick(makeTickView([makeEntityView(1), makeEntityView(2)]));
    assets.resolve('model', MODEL_ID, makeModel());

    const mesh = subsystem.batchMeshes()[0]!;
    const material = mesh.material as THREE.MeshStandardMaterial;
    const before = shaderStub();
    material.onBeforeCompile(before as unknown as THREE.WebGLProgramParametersWithUniforms, null!);
    // До прихода пикселей связана заглушка: несвязанный сэмплер читать нельзя.
    const placeholder = before.uniforms.vatSkinBase!.value as THREE.DataArrayTexture;
    expect(placeholder.image.depth).toBe(1);

    // Базовый вариант берёт текстуру самой модели, скины — свои пути.
    assets.resolve('texture', 'tex/base.png', image(2, 2, 10));
    assets.resolve('texture', 'tex/red.png', image(4, 4, 20));
    assets.resolve('texture', 'tex/blue.png', image(4, 4, 30));

    const array = before.uniforms.vatSkinBase!.value as THREE.DataArrayTexture;
    expect(array).not.toBe(placeholder);
    // Слоёв — по числу вариантов; сторона слоя нормализована по максимуму.
    expect(array.image.depth).toBe(3);
    expect(array.image.width).toBe(4);
    const pixels = array.image.data as Uint8Array;
    const layer = 4 * 4 * 4;
    expect(pixels[0]).toBe(10); // базовый
    expect(pixels[layer]).toBe(30); // blue
    expect(pixels[layer * 2]).toBe(20); // red
    // Массив разделяемый: пер-инстансной копии материала не появилось.
    expect(subsystem.batchStats()).toMatchObject({ batches: 1, records: 2 });
  });
});
