/**
 * Скины (REND-6) в headless-среде. Раньше этот путь в Node не исполнялся вовсе:
 * декодирование шло через `createImageBitmap`, которого здесь нет, и тесты
 * молча проверяли только то, что до ветки декодирования доходит управление.
 * Текстура приезжает декодированной (ASSET-5), поэтому проверяется весь путь.
 */
import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import type { DecodedImage, NormalizedModel } from '@fluxus/assets';
import {
  applySkin,
  buildSharedModel,
  createModelInstance,
  createSkinTextureCache,
  skinTextureSources,
  textureFromImage,
} from '../src/index.js';
import type { SkinTextureSource } from '../src/model/skins.js';
import { makeAssets, makeModel } from './fixtures.js';

function image(r: number, g: number, b: number): DecodedImage {
  return { width: 1, height: 1, format: 'rgba8', pixels: Uint8Array.from([r, g, b, 255]) };
}

/** Источник-путь: слот, за которым лежит отдельный файл дерева контента. */
function path(id: string): SkinTextureSource {
  return { kind: 'path', path: id };
}

/** Модель, у которой слот 0 несёт ВСТРОЕННОЕ изображение (`.glb`), а не путь. */
function modelWithEmbeddedSlot(pixels: DecodedImage): NormalizedModel {
  const base = makeModel();
  return { ...base, textureSlots: [{ slot: 0, source: 'embedded', image: pixels }] };
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

describe('skinTextureSources (ASSET-6)', () => {
  it('базовые пути модели, поверх — подмены выбранного скина', () => {
    const model = makeModel();
    const visual = { model: 'unit.mdx', skins: { ember: { '0': 'tex/ember.png' } } };

    expect(skinTextureSources(model, visual, undefined).get(0)).toEqual(path('tex/base.png'));
    expect(skinTextureSources(model, visual, 'ember').get(0)).toEqual(path('tex/ember.png'));
    // Скина нет в манифесте — остаются базовые пути, а не пустота.
    expect(skinTextureSources(model, visual, 'нет-такого').get(0)).toEqual(path('tex/base.png'));
  });

  it('встроенное изображение слота отдаётся как источник-пиксели, а не как путь', () => {
    const pixels = image(4, 5, 6);
    const model = modelWithEmbeddedSlot(pixels);

    // ASSET-5: модель-контейнер употребима без распаковки — запрашивать по
    // слоту нечего, декодированные пиксели уже лежат в разделяемом ассете.
    expect(skinTextureSources(model, undefined, undefined).get(0)).toEqual({
      kind: 'image',
      image: pixels,
    });
  });

  it('скин манифеста подменяет источник целиком — и поверх встроенного слота', () => {
    const model = modelWithEmbeddedSlot(image(4, 5, 6));
    const visual = { model: 'unit.glb', skins: { ember: { '0': 'tex/ember.png' } } };

    // Скин остаётся путевым (ASSET-6) и работает одинаково поверх обоих видов
    // слота: он не «дописывает путь» к встроенным пикселям, а заменяет источник.
    expect(skinTextureSources(model, visual, 'ember').get(0)).toEqual(path('tex/ember.png'));
  });

  it('слот без источника в карту не попадает, но номер за ним закреплён', () => {
    const base = makeModel();
    const model: NormalizedModel = {
      ...base,
      textureSlots: [{ slot: 0, source: 'none' }, { slot: 1, source: 'file', path: 'tex/b.png' }],
    };
    const sources = skinTextureSources(model, undefined, undefined);
    expect(sources.has(0)).toBe(false);
    expect(sources.get(1)).toEqual(path('tex/b.png'));

    // Нумерация сквозная (REND-6): скин занимает пустой слот по его номеру.
    const visual = { model: 'unit.mdx', skins: { team: { '0': 'tex/team.png' } } };
    expect(skinTextureSources(model, visual, 'team').get(0)).toEqual(path('tex/team.png'));
  });
});

describe('applySkin (REND-6)', () => {
  it('готовая текстура попадает в карту материала инстанса', () => {
    const assets = makeAssets();
    const instance = createModelInstance(buildSharedModel(makeModel()));
    assets.resolve('texture', 'tex/base.png', image(10, 20, 30));

    applySkin(instance.ownTextureTargets(), new Map([[0, path('tex/base.png')]]), assets.service);

    const map = skinTexture(instance.materials[0]!);
    expect(map.image.width).toBe(1);
    expect(skinPixels(instance.materials[0]!)).toEqual([10, 20, 30, 255]);
    // Цветовая карта — sRGB; иначе текстура высветлится на экране.
    expect(map.colorSpace).toBe(THREE.SRGBColorSpace);
  });

  it('встроенное изображение ставится сразу и не идёт через AssetService', () => {
    const assets = makeAssets();
    const instance = createModelInstance(buildSharedModel(makeModel()));

    applySkin(
      instance.ownTextureTargets(),
      new Map([[0, { kind: 'image' as const, image: image(3, 4, 5) }]]),
      assets.service,
    );

    // Пиксели уже декодированы загрузчиком модели (ASSET-5): ждать `ready`
    // нечего, а запрос был бы вторым кэшем поверх разделяемых данных модели.
    expect(skinPixels(instance.materials[0]!)).toEqual([3, 4, 5, 255]);
    expect(assets.requests).toEqual([]);
  });

  it('текстура в loading — материал остаётся без карты, ошибки нет', () => {
    const assets = makeAssets();
    const instance = createModelInstance(buildSharedModel(makeModel()));

    expect(() =>
      applySkin(instance.ownTextureTargets(), new Map([[0, path('tex/base.png')]]), assets.service),
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

    applySkin(first.ownTextureTargets(), new Map([[0, path('tex/base.png')]]), assets.service);
    const application = applySkin(
      second.ownTextureTargets(),
      new Map([[0, path('tex/base.png')]]),
      assets.service,
    );

    // Смена скина второго инстанса: старое применение снимается, ставится новое.
    application.dispose();
    applySkin(second.ownTextureTargets(), new Map([[0, path('tex/ember.png')]]), assets.service);

    expect(skinPixels(second.materials[0]!)).toEqual([9, 9, 9, 255]);
    expect(skinPixels(first.materials[0]!)).toEqual([1, 1, 1, 255]);
    expect(shared.model.textureSlots[0]).toEqual({
      slot: 0,
      source: 'file',
      path: 'tex/base.png',
    }); // ассет не тронут
  });

  it('после dispose обновления больше не применяются', () => {
    const assets = makeAssets();
    const instance = createModelInstance(buildSharedModel(makeModel()));
    const application = applySkin(
      instance.ownTextureTargets(),
      new Map([[0, path('tex/base.png')]]),
      assets.service,
    );
    application.dispose();

    assets.resolve('texture', 'tex/base.png', image(7, 7, 7));
    expect(instance.materials[0]!.map).toBeNull();
  });

  it('слот, который никем не используется, пропускается без запроса', () => {
    const assets = makeAssets();
    const instance = createModelInstance(buildSharedModel(makeModel()));
    applySkin(instance.ownTextureTargets(), new Map([[42, path('tex/ghost.png')]]), assets.service);
    expect(assets.requests).toEqual([]);
  });
});


/**
 * Кэш GPU-текстур скина (REND-6, REND-31): пиксели ассета разделяются модулем
 * ассетов (ASSET-2), и заливать их в видеопамять по разу на инстанс незачем.
 */
describe('createSkinTextureCache', () => {
  it('одни пиксели — одна текстура; цветовое пространство их разделяет', () => {
    const cache = createSkinTextureCache();
    const pixels = image(1, 2, 3);

    const base = cache.acquire(pixels, 'base');
    expect(cache.acquire(pixels, 'base')).toBe(base);
    // Эмиссия — то же пространство, что базовый цвет: та же текстура.
    expect(cache.acquire(pixels, 'emissive')).toBe(base);
    // Карта нормалей линейна (`textureFromImage`) — ей нужна своя.
    const normal = cache.acquire(pixels, 'normal');
    expect(normal).not.toBe(base);
    expect(base.colorSpace).toBe(THREE.SRGBColorSpace);
    expect(normal.colorSpace).toBe(THREE.NoColorSpace);

    // Другие пиксели — другая текстура, сколько бы их ни было в кэше.
    expect(cache.acquire(image(4, 5, 6), 'base')).not.toBe(base);
  });

  it('текстура освобождается последней ссылкой, а не первой', () => {
    const cache = createSkinTextureCache();
    const pixels = image(7, 7, 7);
    const texture = cache.acquire(pixels, 'base');
    cache.acquire(pixels, 'base');
    const disposed = vi.spyOn(texture, 'dispose');

    cache.release(texture);
    expect(disposed).not.toHaveBeenCalled();
    cache.release(texture);
    expect(disposed).toHaveBeenCalledTimes(1);

    // Отпущенные пиксели снова спрашивают — строится НОВАЯ текстура: прежняя
    // отдана, и держать её было бы утечкой (REND-31).
    expect(cache.acquire(pixels, 'base')).not.toBe(texture);
  });

  it('чужую текстуру не трогает, а свои отдаёт со сносом ассета', () => {
    const cache = createSkinTextureCache();
    const own = cache.acquire(image(1, 1, 1), 'base');
    const foreign = textureFromImage(image(2, 2, 2), 'base');
    const ownDisposed = vi.spyOn(own, 'dispose');
    const foreignDisposed = vi.spyOn(foreign, 'dispose');

    cache.release(foreign);
    expect(foreignDisposed).not.toHaveBeenCalled();

    cache.dispose();
    expect(ownDisposed).toHaveBeenCalledTimes(1);
  });
});
