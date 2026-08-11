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

  it('длительность не кратна шагу — конец клипа всё равно запечён отдельным кадром', () => {
    // 0.7 с при 4 к/с — это 2.8 шага: округление к БЛИЖАЙШЕМУ отдало бы клипу
    // три кадра (0, 0.25, 0.5), и конечная поза не попала бы в VAT вовсе, а
    // предпоследний кадр совпал бы с последним — клип замирал бы на хвосте.
    const baked = bakeOrThrow(makeModel([turnSequence('Walk', 0.7)]), 4);
    const clip = baked.clips[0]!;
    expect(clip.length).toBe(4); // t = 0, 0.25, 0.5, 0.7 (последний обрезан длительностью)
    // Последний кадр — конец клипа, поворот на 90°.
    const last = matrixAt(baked, clip.offset + clip.length - 1, 1);
    expect(last[0]).toBeCloseTo(0, 6);
    expect(last[1]).toBeCloseTo(1, 6);
    // Предпоследний до конца не дошёл: хвост клипа не продублирован.
    expect(matrixAt(baked, clip.offset + clip.length - 2, 1)[0]).toBeGreaterThan(0.1);
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

  it('скелет без весов скиннинга даёт границы бинд-позы, а не перевёрнутый объём', () => {
    // Кости есть, но ни одна вершина на них не завешена: радиусы влияния
    // нулевые, сферы пусты — и объём остался бы [+∞, −∞], а отсечение по нему
    // вырезало бы модель из кадра насовсем (REND-21).
    const base = makeModel([turnSequence('Walk', 1)]);
    const model: NormalizedModel = {
      ...base,
      meshes: base.meshes.map((mesh) => ({
        ...mesh,
        skinWeights: new Float32Array(mesh.skinWeights.length),
      })),
    };
    const baked = bakeOrThrow(model, 4);
    for (let axis = 0; axis < 3; axis++) {
      expect(Number.isFinite(baked.bounds.min[axis]!)).toBe(true);
      expect(Number.isFinite(baked.bounds.max[axis]!)).toBe(true);
      expect(baked.bounds.max[axis]!).toBeGreaterThanOrEqual(baked.bounds.min[axis]!);
    }
    // Объём накрывает вершины как они лежат в данных.
    expect(baked.bounds.max[0]).toBeGreaterThanOrEqual(1);
  });

  it('у модели без вершин объём вырожден в точку, а не перевёрнут', () => {
    const model: NormalizedModel = { ...makeModel(), meshes: [] };
    const baked = bakeOrThrow(model);
    expect([...baked.bounds.min, ...baked.bounds.max]).toEqual([0, 0, 0, 0, 0, 0]);
  });
});

describe('бюджет VAT-текстуры (ASSET-12 → REND-20)', () => {
  it('текстура за пределом стороны производных не даёт, и причина названа', () => {
    // Клип на полчаса при 30 к/с — 54 тысячи строк: столько не примет ни один
    // GPU, и узнавать об этом при отрисовке поздно.
    const result = bakeDerivatives(makeModel([turnSequence('Long', 1800)]));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/VAT не помещается/);
  });

  it('предел — параметр запекания, и он часть ключа кэша', () => {
    const model = makeModel([turnSequence('Walk', 1)]);
    // Две кости — восемь текселей в строке; предел 4 не пропускает ширину.
    expect(bakeDerivatives(model, { maxTextureSize: 4 }).ok).toBe(false);
    expect(bakeDerivatives(model, { maxTextureSize: 4096 }).ok).toBe(true);
    // Кэш параметры различает: тот же результат при тех же, разный при разных.
    expect(modelDerivatives(model, { maxTextureSize: 4 })).toBe(
      modelDerivatives(model, { maxTextureSize: 4 }),
    );
    expect(modelDerivatives(model, { maxTextureSize: 4 }).ok).toBe(false);
    expect(modelDerivatives(model).ok).toBe(true);
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

describe('LOD-цепочка в производных (ASSET-12 → REND-22)', () => {
  it('модель без цепочки отдаёт пустую: децимации запекание не выдумывает', () => {
    expect(bakeOrThrow(makeModel([turnSequence('Walk', 1)])).lod).toEqual([]);
  });

  it('цепочка модели переносится в производные уровень за уровнем', () => {
    const base = makeModel([turnSequence('Walk', 1)]);
    const coarse = [base.meshes[0]!];
    const model: NormalizedModel = { ...base, lodMeshes: [coarse, coarse] };
    const baked = bakeOrThrow(model);
    expect(baked.lod.length).toBe(2);
    // Геометрия уровня — та же, что дала модель: копии здесь не делается,
    // уровни разделяемы наравне с остальными данными ассета (ASSET-5).
    expect(baked.lod[0]!.meshes[0]).toBe(coarse[0]);
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
