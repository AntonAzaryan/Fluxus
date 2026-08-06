/**
 * Скины (REND-6) в headless-среде. Раньше этот путь в Node не исполнялся вовсе:
 * декодирование шло через `createImageBitmap`, которого здесь нет, и тесты
 * молча проверяли только то, что до ветки декодирования доходит управление.
 * Текстура приезжает декодированной (ASSET-5), поэтому проверяется весь путь.
 */
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import type { DecodedImage } from '@game-mvp/assets';
import { applySkin, buildSharedModel, createModelInstance, skinTexturePaths } from '../src/index.js';
import { makeAssets, makeModel } from './fixtures.js';

function image(r: number, g: number, b: number): DecodedImage {
  return { width: 1, height: 1, format: 'rgba8', pixels: Uint8Array.from([r, g, b, 255]) };
}

/**
 * Карта материала как `DataTexture`. `Material.map` объявлен базовым `Texture`,
 * у которого `image` — `unknown`: пиксели в общем случае могут быть чем угодно
 * (canvas, video, ImageBitmap). `applySkin` кладёт туда именно `DataTexture` —
 * сужение и проверяется рядом через `toBeInstanceOf`, поэтому здесь это
 * утверждение о контракте, а не обход типов.
 */
function skinTexture(material: THREE.MeshStandardMaterial): THREE.DataTexture {
  const map = material.map;
  expect(map).toBeInstanceOf(THREE.DataTexture);
  return map as THREE.DataTexture;
}

/** Пиксели карты материала списком — форма, удобная для сравнения в ассерте. */
function skinPixels(material: THREE.MeshStandardMaterial): number[] {
  return [...(skinTexture(material).image.data as Uint8Array)];
}

describe('skinTexturePaths (ASSET-6)', () => {
  it('базовые пути модели, поверх — подмены выбранного скина', () => {
    const model = makeModel();
    const visual = { model: 'unit.mdx', skins: { ember: { '0': 'tex/ember.png' } } };

    expect(skinTexturePaths(model, visual, undefined).get(0)).toBe('tex/base.png');
    expect(skinTexturePaths(model, visual, 'ember').get(0)).toBe('tex/ember.png');
    // Скина нет в манифесте — остаются базовые пути, а не пустота.
    expect(skinTexturePaths(model, visual, 'нет-такого').get(0)).toBe('tex/base.png');
  });
});

describe('applySkin (REND-6)', () => {
  it('готовая текстура попадает в карту материала инстанса', () => {
    const assets = makeAssets();
    const instance = createModelInstance(buildSharedModel(makeModel()));
    assets.resolve('texture', 'tex/base.png', image(10, 20, 30));

    applySkin(instance.textureTargets, new Map([[0, 'tex/base.png']]), assets.service);

    const map = skinTexture(instance.materials[0]!);
    expect(map.image.width).toBe(1);
    expect(skinPixels(instance.materials[0]!)).toEqual([10, 20, 30, 255]);
    // Цветовая карта — sRGB; иначе текстура высветлится на экране.
    expect(map.colorSpace).toBe(THREE.SRGBColorSpace);
  });

  it('текстура в loading — материал остаётся без карты, ошибки нет', () => {
    const assets = makeAssets();
    const instance = createModelInstance(buildSharedModel(makeModel()));

    expect(() =>
      applySkin(instance.textureTargets, new Map([[0, 'tex/base.png']]), assets.service),
    ).not.toThrow();
    expect(instance.materials[0]!.map).toBeNull();

    // ASSET-4: пришло позже — применяется по факту ready.
    assets.resolve('texture', 'tex/base.png', image(1, 2, 3));
    expect(instance.materials[0]!.map).not.toBeNull();
  });

  it('смена скина не трогает другой инстанс той же модели', () => {
    const assets = makeAssets();
    const shared = buildSharedModel(makeModel());
    const first = createModelInstance(shared);
    const second = createModelInstance(shared);
    assets.resolve('texture', 'tex/base.png', image(1, 1, 1));
    assets.resolve('texture', 'tex/ember.png', image(9, 9, 9));

    applySkin(first.textureTargets, new Map([[0, 'tex/base.png']]), assets.service);
    const application = applySkin(
      second.textureTargets,
      new Map([[0, 'tex/base.png']]),
      assets.service,
    );

    // Смена скина второго инстанса: старое применение снимается, ставится новое.
    application.dispose();
    applySkin(second.textureTargets, new Map([[0, 'tex/ember.png']]), assets.service);

    expect(skinPixels(second.materials[0]!)).toEqual([9, 9, 9, 255]);
    expect(skinPixels(first.materials[0]!)).toEqual([1, 1, 1, 255]);
    expect(shared.model.textureSlots[0]!.path).toBe('tex/base.png'); // ассет не тронут
  });

  it('после dispose обновления больше не применяются', () => {
    const assets = makeAssets();
    const instance = createModelInstance(buildSharedModel(makeModel()));
    const application = applySkin(
      instance.textureTargets,
      new Map([[0, 'tex/base.png']]),
      assets.service,
    );
    application.dispose();

    assets.resolve('texture', 'tex/base.png', image(7, 7, 7));
    expect(instance.materials[0]!.map).toBeNull();
  });

  it('слот, который никем не используется, пропускается без запроса', () => {
    const assets = makeAssets();
    const instance = createModelInstance(buildSharedModel(makeModel()));
    applySkin(instance.textureTargets, new Map([[42, 'tex/ghost.png']]), assets.service);
    expect(assets.requests).toEqual([]);
  });
});
