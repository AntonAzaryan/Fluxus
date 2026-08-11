/**
 * Набор вариантов скинов записи (ASSET-11): раскладка под массив текстур —
 * слой на вариант, сквозные индексы, нормализация размеров. Headless
 * (ASSET-5): на входе декодированные пиксели, на выходе байты и раскладка.
 */
import { describe, expect, it } from 'vitest';
import {
  bakeSkinVariants,
  skinVariantIndex,
  type DecodedImage,
  type SkinVariantSource,
} from '../src/index.js';

/** Одноцветное изображение заданного размера — по цвету и видно, чей это слой. */
function solid(width: number, height: number, r: number, g: number, b: number): DecodedImage {
  const pixels = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    pixels[i * 4] = r;
    pixels[i * 4 + 1] = g;
    pixels[i * 4 + 2] = b;
    pixels[i * 4 + 3] = 255;
  }
  return { width, height, format: 'rgba8', pixels };
}

function variant(name: string, images: readonly [number, DecodedImage][]): SkinVariantSource {
  return { name, images: new Map(images) };
}

/** Пиксель слоя `layer` слота по координатам. */
function pixelAt(
  slot: { width: number; height: number; pixels: Uint8Array },
  layer: number,
  x: number,
  y: number,
): number[] {
  const base = layer * slot.width * slot.height * 4 + (y * slot.width + x) * 4;
  return [...slot.pixels.subarray(base, base + 4)];
}

describe('bakeSkinVariants (ASSET-11 → REND-6)', () => {
  it('слой на вариант, индексы сквозные и в порядке подачи', () => {
    const set = bakeSkinVariants([
      variant('', [[0, solid(2, 2, 10, 0, 0)]]),
      variant('red', [[0, solid(2, 2, 200, 0, 0)]]),
      variant('blue', [[0, solid(2, 2, 0, 0, 200)]]),
    ]);
    expect(set.variants).toEqual(['', 'red', 'blue']);
    expect(set.slots).toHaveLength(1);
    const slot = set.slots[0]!;
    expect(slot.slot).toBe(0);
    expect(slot.pixels.length).toBe(slot.width * slot.height * 4 * 3);
    expect(pixelAt(slot, 0, 0, 0)).toEqual([10, 0, 0, 255]);
    expect(pixelAt(slot, 1, 0, 0)).toEqual([200, 0, 0, 255]);
    expect(pixelAt(slot, 2, 0, 0)).toEqual([0, 0, 200, 255]);

    expect(skinVariantIndex(set, 'blue')).toBe(2);
    expect(skinVariantIndex(set, undefined)).toBe(0); // базовый вариант — без имени
    expect(skinVariantIndex(set, 'missing')).toBe(-1);
  });

  it('размеры слоёв одного слота нормализуются: массиву текстур нужен один размер', () => {
    const set = bakeSkinVariants([
      variant('', [[0, solid(2, 2, 1, 1, 1)]]),
      variant('big', [[0, solid(3, 5, 2, 2, 2)]]),
    ]);
    const slot = set.slots[0]!;
    // Ближайшая сверху степень двойки от максимума вариантов.
    expect(slot.width).toBe(4);
    expect(slot.height).toBe(8);
    // Ресайз — выборка ближайшего: одноцветное остаётся одноцветным.
    expect(pixelAt(slot, 0, 3, 7)).toEqual([1, 1, 1, 255]);
    expect(pixelAt(slot, 1, 3, 7)).toEqual([2, 2, 2, 255]);
  });

  it('слот, о котором вариант молчит, берётся у базового (ASSET-6)', () => {
    const set = bakeSkinVariants([
      variant('', [
        [0, solid(1, 1, 9, 9, 9)],
        [2, solid(1, 1, 5, 5, 5)],
      ]),
      // Скин подменяет только слот 0; слот 2 остаётся модельным.
      variant('team', [[0, solid(1, 1, 7, 7, 7)]]),
    ]);
    expect(set.slots.map((slot) => slot.slot)).toEqual([0, 2]);
    expect(pixelAt(set.slots[0]!, 1, 0, 0)).toEqual([7, 7, 7, 255]);
    expect(pixelAt(set.slots[1]!, 1, 0, 0)).toEqual([5, 5, 5, 255]);
  });

  it('бюджет стороны слоя обрезает крупные исходники', () => {
    const set = bakeSkinVariants([variant('', [[0, solid(64, 64, 3, 3, 3)]])], { maxSize: 8 });
    expect(set.slots[0]!.width).toBe(8);
    expect(set.slots[0]!.height).toBe(8);
    expect(pixelAt(set.slots[0]!, 0, 7, 7)).toEqual([3, 3, 3, 255]);
  });

  it('запекание детерминировано: два прогона дают побитово одно и то же', () => {
    const sources = (): SkinVariantSource[] => [
      variant('', [
        [3, solid(3, 3, 1, 2, 3)],
        [0, solid(5, 2, 4, 5, 6)],
      ]),
      variant('alt', [[0, solid(2, 2, 7, 8, 9)]]),
    ];
    const first = bakeSkinVariants(sources());
    const second = bakeSkinVariants(sources());
    // Порядок слотов не зависит от порядка вставки в Map — иначе побитового
    // совпадения не добиться (ASSET-11).
    expect(second.slots.map((slot) => slot.slot)).toEqual([0, 3]);
    first.slots.forEach((slot, i) => {
      expect(second.slots[i]!.pixels).toEqual(slot.pixels);
    });
  });

  it('пустой набор вариантов — пустой набор слоёв, а не ошибка', () => {
    expect(bakeSkinVariants([])).toEqual({ variants: [], slots: [] });
  });
});
