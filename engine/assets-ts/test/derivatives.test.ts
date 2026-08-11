/**
 * Запечённые производные модели (ASSET-12): раскладка bone-VAT и таблица
 * клипов, консервативные границы по всем клипам, маска видимости частей, кэш по
 * идентичности ассета и побитовый детерминизм.
 *
 * Всё headless (ASSET-5): ни браузера, ни GPU, ни рендер-библиотеки — на входе
 * каноническая модель, на выходе TypedArray. Сверка запечённой позы с позой
 * настоящего скелета живёт в `render-ts` (`test/derivatives.test.ts`): там есть
 * независимый оракул — микшер и скелет THREE.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_BAKE_FPS,
  VAT_TEXELS_PER_BONE,
  bakeDerivatives,
  modelDerivatives,
  type BakedDerivatives,
  type NormalizedModel,
} from '../src/index.js';
import { hideSequence, makeModel, turnSequence } from './vatFixtures.js';

/** Матрица кости в кадре — 16 чисел строки VAT (четыре столбца по текселю). */
function matrixAt(baked: BakedDerivatives, frame: number, bone: number): number[] {
  const base = (frame * baked.vat.width + bone * VAT_TEXELS_PER_BONE) * 4;
  return [...baked.vat.data.subarray(base, base + 16)];
}

function bakeOrThrow(model: NormalizedModel, fps?: number): BakedDerivatives {
  const result = bakeDerivatives(model, fps === undefined ? {} : { fps });
  if (!result.ok) throw new Error(`запекание провалилось: ${result.reason}`);
  return result.derivatives;
}

describe('bakeDerivatives: раскладка VAT и таблица клипов (ASSET-12)', () => {
  it('строка — кадр, четыре текселя — матрица кости; поза покоя лежит первой', () => {
    const baked = bakeOrThrow(makeModel([turnSequence('Walk', 1)]), 10);
    expect(baked.fps).toBe(10);
    expect(baked.vat.boneCount).toBe(2);
    expect(baked.vat.width).toBe(2 * VAT_TEXELS_PER_BONE);
    // Строка покоя плюс кадры единственного клипа.
    expect(baked.restFrame).toBe(0);
    expect(baked.clips).toHaveLength(1);
    expect(baked.clips[0]!.offset).toBe(1);
    expect(baked.vat.height).toBe(1 + baked.clips[0]!.length);
    expect(baked.vat.data.length).toBe(baked.vat.width * baked.vat.height * 4);

    // Привязка у модели выводится из позы покоя, значит в покое матрица
    // скининга единична — по ней и видно, что запеклось именно `world × invBind`.
    expect(matrixAt(baked, 0, 1)).toEqual([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  });

  it('кадры идут с шагом 1/fps, последний лежит на конце клипа', () => {
    const baked = bakeOrThrow(makeModel([turnSequence('Walk', 1)]), 4);
    const clip = baked.clips[0]!;
    expect(clip.length).toBe(5); // t = 0, 0.25, 0.5, 0.75, 1
    expect(clip.duration).toBeCloseTo(1, 6);

    // Середина клипа — поворот на 45°: кость 1 стоит в (2,0,0), и точка (1,0,0)
    // её локальных осей уезжает по Y ровно на sin 45°.
    const middle = matrixAt(baked, clip.offset + 2, 1);
    expect(middle[0]).toBeCloseTo(Math.SQRT1_2, 6);
    expect(middle[1]).toBeCloseTo(Math.SQRT1_2, 6);
    // Последний кадр — поворот на 90°.
    const last = matrixAt(baked, clip.offset + clip.length - 1, 1);
    expect(last[0]).toBeCloseTo(0, 6);
    expect(last[1]).toBeCloseTo(1, 6);
  });

  it('ступенчатый канал не интерполируется: до последнего ключа держится первый', () => {
    const baked = bakeOrThrow(makeModel([turnSequence('Step', 1, 'step')]), 4);
    const clip = baked.clips[0]!;
    expect(matrixAt(baked, clip.offset + 2, 1)[0]).toBeCloseTo(1, 6); // ещё не повёрнут
    expect(matrixAt(baked, clip.offset + clip.length - 1, 1)[0]).toBeCloseTo(0, 6);
  });

  it('замкнутость клипа — свойство запечённых кадров, а не догадка о формате', () => {
    const turning = bakeOrThrow(makeModel([turnSequence('Walk', 1)]), 4);
    expect(turning.clips[0]!.loop).toBe(false); // конец не совпал с началом

    const still: NormalizedModel = {
      ...makeModel(),
      sequences: [{ name: 'Stand', duration: 1, boneTracks: [], partVisibility: [] }],
    };
    expect(bakeOrThrow(still, 4).clips[0]!.loop).toBe(true);
  });

  it('клипов нет вовсе — остаётся поза покоя: рисовать запись всё равно чем-то надо', () => {
    const baked = bakeOrThrow(makeModel());
    expect(baked.clips).toEqual([]);
    expect(baked.vat.height).toBe(1);
    expect(baked.fps).toBe(DEFAULT_BAKE_FPS);
  });

  it('модель без костей производных не даёт, и отсутствие названо (REND-20)', () => {
    const model: NormalizedModel = { ...makeModel(), bones: [] };
    const result = bakeDerivatives(model);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/костей/);
  });
});

describe('консервативные границы по клипам (ASSET-12 → REND-21)', () => {
  it('объём накрывает вершины во всех кадрах, а не только бинд-позу', () => {
    // Клип уводит кость 1 поворотом на 90°: её треугольник, лежавший вдоль +X,
    // встаёт вдоль +Y — и границы обязаны это увидеть.
    const baked = bakeOrThrow(makeModel([turnSequence('Walk', 1)]), 8);
    expect(baked.bounds.max[1]).toBeGreaterThan(1.5);
    // Объём объемлющий: он не тесен, но и не пуст.
    expect(baked.bounds.min[0]).toBeLessThanOrEqual(0);
    expect(baked.bounds.max[0]).toBeGreaterThanOrEqual(3);
  });

  it('модель без клипов даёт границы позы покоя', () => {
    const baked = bakeOrThrow(makeModel());
    expect(baked.bounds.max[0]).toBeGreaterThanOrEqual(3);
    expect(baked.bounds.max[1]).toBeGreaterThanOrEqual(1);
  });
});

describe('маска видимости частей по кадрам (ASSET-12)', () => {
  it('часть без трека видима; трек гасит её с того кадра, где ключ сработал', () => {
    const baked = bakeOrThrow(makeModel([hideSequence('Hide', 1)]), 4);
    const clip = baked.clips[0]!;
    const visible = (frame: number, part: number): boolean => {
      const bit = baked.partVisibility.parts.indexOf(part);
      const word = baked.partVisibility.mask[frame * baked.partVisibility.wordsPerFrame + (bit >> 5)]!;
      return (word & (1 << bit % 32)) !== 0;
    };
    expect(baked.partVisibility.parts).toEqual([0, 1]);
    expect(baked.partVisibility.wordsPerFrame).toBe(1);
    // Часть 0 трека не имеет — видима везде.
    expect(visible(clip.offset, 0)).toBe(true);
    expect(visible(clip.offset + clip.length - 1, 0)).toBe(true);
    // Часть 1 гаснет после ключа t = 0.5 (кадр 2 при fps 4).
    expect(visible(clip.offset + 1, 1)).toBe(true);
    expect(visible(clip.offset + 2, 1)).toBe(false);
    expect(visible(clip.offset + clip.length - 1, 1)).toBe(false);
  });
});

describe('детерминизм и кэш (ASSET-12, ASSET-2)', () => {
  it('двойное запекание даёт побитово одинаковые буферы', () => {
    const sequences = [turnSequence('Walk', 1), hideSequence('Hide', 0.7), turnSequence('Idle', 1.3, 'step')];
    const first = bakeOrThrow(makeModel(sequences), 24);
    const second = bakeOrThrow(makeModel(sequences), 24);
    // Побитово — это про байты буферов, а не про «близко»: кэш и сверка
    // артефактов иначе теряют смысл.
    expect(new Uint8Array(second.vat.data.buffer)).toEqual(new Uint8Array(first.vat.data.buffer));
    expect(new Uint8Array(second.partVisibility.mask.buffer)).toEqual(
      new Uint8Array(first.partVisibility.mask.buffer),
    );
    expect(second.bounds).toEqual(first.bounds);
    expect(second.clips).toEqual(first.clips);
  });

  it('запекание — один раз на ассет: тот же объект модели даёт тот же результат', () => {
    const model = makeModel([turnSequence('Walk', 1)]);
    const first = modelDerivatives(model);
    const second = modelDerivatives(model);
    expect(second).toBe(first); // разделение производных этим и наблюдаемо
    // Другие параметры запекания — другие производные: они часть входа.
    expect(modelDerivatives(model, { fps: 60 })).not.toBe(first);
    // Другая модель — своё запекание, а не чужое из кэша.
    expect(modelDerivatives(makeModel([turnSequence('Walk', 1)]))).not.toBe(first);
  });

  it('несуразная частота сэмплирования — отказ с названной причиной', () => {
    const result = bakeDerivatives(makeModel(), { fps: 0 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/частота/);
  });
});
