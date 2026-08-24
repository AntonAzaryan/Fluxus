import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  AssetService,
  gltfLoader,
  type Handle,
  type NormalizedModel,
} from '../src/index.js';
import { FIXTURES_DIR, FsAssetSource, MemoryAssetSource, settled } from './helpers.js';
import {
  buildGlbFixture,
  EMBEDDED_PIXELS,
  EXTERNAL_TEXTURE_PATH,
  GLB_ID,
  GLTF_ID,
  EXTERNAL_PNG_ID,
} from './glbFixture.js';

import {
  buildDanglingSkinFixture,
  buildDataUriFixture,
  buildEmissiveStrengthFixture,
  buildMultiPrimitiveFixture,
  buildTwoSkinsFixture,
  buildUnnormalizedWeightsFixture,
  DANGLING_SKIN_ID,
  DATA_URI_ID,
  EMISSIVE_STRENGTH_ID,
  MULTI_PRIM_ID,
  TWO_SKINS_ID,
  UNNORMALIZED_ID,
} from './gltfVariants.js';

const MODEL_ID = 'gltf-mini/model.gltf';

/** Загрузка одного ID зарегистрированным glTF-загрузчиком (ASSET-3). */
async function loadFrom(source: MemoryAssetSource, id: string): Promise<NormalizedModel> {
  const svc = new AssetService(source);
  svc.registerLoader(gltfLoader);
  const handle: Handle<NormalizedModel> = svc.request('model', id);
  const state = await settled(svc, handle);
  if (state.status !== 'ready') {
    throw new Error(`модель "${id}" не загрузилась: ${state.status === 'failed' ? state.reason : state.status}`);
  }
  return state.data;
}

/** `Mc`: поворот +90° вокруг X, глТФ Y-вверх → канон Z-вверх, (x,y,z) → (x,-z,y). */
const MC_QUAT = [Math.SQRT1_2, 0, 0, Math.SQRT1_2];
// prettier-ignore
const MC_INVERSE = [
  1, 0, 0, 0,
  0, 0, -1, 0,
  0, 1, 0, 0,
  0, 0, 0, 1,
];

function closeArray(actual: ArrayLike<number>, expected: readonly number[]): void {
  expect(actual.length, 'длина массива').toBe(expected.length);
  for (let i = 0; i < expected.length; i++) {
    expect(actual[i]!, `компонента ${i}`).toBeCloseTo(expected[i]!, 5);
  }
}

describe('Загрузчик glTF: рукописная фикстура (ASSET-5: headless в Node)', () => {
  let model: NormalizedModel;

  beforeAll(async () => {
    const svc = new AssetService(new FsAssetSource(FIXTURES_DIR));
    svc.registerLoader(gltfLoader);
    const handle: Handle<NormalizedModel> = svc.request('model', MODEL_ID);
    const state = await settled(svc, handle);
    if (state.status !== 'ready') {
      throw new Error(`модель не загрузилась: ${state.status === 'failed' ? state.reason : state.status}`);
    }
    model = state.data;
  });

  it('скелет: 5 узлов, только настоящий корень получает поворот осей', () => {
    expect(model.bones).toHaveLength(5);
    const [armature, body, root, child, prop] = model.bones;

    // "Armature" — единственный узел без родителя: позиция не меняется (была
    // нулевой), но поворот покоя приобретает Mc — это и есть вся конвертация
    // осей для твёрдой иерархии (см. заголовок gltf.ts).
    expect(armature!.parentIndex).toBe(-1);
    closeArray(armature!.position, [0, 0, 0]);
    closeArray(armature!.rotation, MC_QUAT);
    expect(armature!.inverseBind).toBeNull();

    // "Body" (меш-нода со скином) и кости скелета — НЕ корни: локальный TRS
    // не меняется вовсе, включая позицию кости "Root" [1,2,3].
    expect(body!.parentIndex).toBe(0);
    closeArray(body!.position, [0, 0, 0]);
    closeArray(body!.rotation, [0, 0, 0, 1]);

    expect(root!.parentIndex).toBe(0);
    closeArray(root!.position, [1, 2, 3]);
    closeArray(root!.rotation, [0, 0, 0, 1]);
    // "Root" — сустав скина (skin.joints[0]): inverseBind = raw(identity) · Mc⁻¹.
    expect(root!.inverseBind).not.toBeNull();
    closeArray(root!.inverseBind!, MC_INVERSE);

    expect(child!.parentIndex).toBe(2);
    closeArray(child!.position, [0, 1, 0]);
    closeArray(child!.inverseBind!, MC_INVERSE);

    // "Prop" — меш без скина (экипировка): не сустав, inverseBind не задан
    // (рендер выведет его из позы покоя сам, build.ts: `buildSkeleton`).
    expect(prop!.parentIndex).toBe(3);
    closeArray(prop!.position, [0, 0, 2]);
    expect(prop!.inverseBind).toBeNull();
  });

  it('меши: суставной меш конвертирует вершины напрямую, привязка через skin.joints', () => {
    expect(model.meshes).toHaveLength(2);
    const body = model.meshes.find((m) => m.partId === 0)!;
    // Вершины A(0,0,0) B(1,0,0) C(0,1,0) в Y-вверх → (x,-z,y) в каноне.
    closeArray(body.positions, [0, 0, 0, 1, 0, 0, 0, 0, 1]);
    // JOINTS_0 = [0,0,0,0] на вершину (индекс В SKIN.JOINTS) → узел 2 ("Root").
    for (let v = 0; v < 3; v++) {
      expect(body.skinIndices[v * 4]).toBe(2);
      expect(body.skinWeights[v * 4]).toBe(1);
    }
  });

  it('меши: не-суставной меш запекается в bind-пространство узла и вяжется к себе', () => {
    const prop = model.meshes.find((m) => m.partId === 1)!;
    // Локальная вершина (0,0,0) узла "Prop" → мировая поза покоя (raw, Y-вверх)
    // = сумма трансляций цепочки Root(1,2,3) + Child(0,1,0) + Prop(0,0,2) =
    // (1,3,5) → канон (x,-z,y) = (1,-5,3).
    for (let v = 0; v < 3; v++) {
      closeArray(prop.positions.subarray(v * 3, v * 3 + 3), [1, -5, 3]);
      // Жёсткая привязка к собственному узлу (индекс 4 = "Prop" в bones[]).
      expect(prop.skinIndices[v * 4]).toBe(4);
      expect(prop.skinWeights[v * 4]).toBe(1);
    }
  });

  it('материалы: metallic/roughness, alphaMode и слоты карт приезжают из формата', () => {
    expect(model.materials).toHaveLength(1);
    const material = model.materials[0]!;
    expect(material.metallicFactor).toBeCloseTo(0.25, 5);
    expect(material.roughnessFactor).toBeCloseTo(0.75, 5);
    expect(material.alphaMode).toBe('mask');
    expect(material.alphaCutoff).toBeCloseTo(0.25, 5);
    expect(material.doubleSided).toBe(true);
    // Карта ссылается на НОМЕР слота, а не на путь (ASSET-5): подмена скина
    // работает по слоту (REND-6), поэтому нумерация обязана быть сквозной.
    expect(material.baseColorTexture).toBe(0);
    expect(material.normalTexture).toBeNull();
    // Файл без `KHR_materials_emissive_strength` — сила 1 (ASSET-5): вид модели
    // от появления поля не меняется ни на бит.
    expect(material.emissiveStrength).toBe(1);
  });

  it('слоты текстур: путь разрешается ОТ ID ассета, слот без источника остаётся в нумерации', () => {
    expect(model.textureSlots).toHaveLength(2);
    // "../shared/atlas.png" от ID "gltf-mini/model.gltf" → "shared/atlas.png" (ASSET-3).
    expect(model.textureSlots[0]).toEqual({ slot: 0, source: 'file', path: 'shared/atlas.png' });
    // Изображение без uri и без bufferView — источника нет вовсе, но номер занят.
    expect(model.textureSlots[1]).toEqual({ slot: 1, source: 'none' });
  });

  it('секвенции: канал корневого узла конвертируется, канал некорневого — нет', () => {
    expect(model.sequences).toHaveLength(2);
    const seq = model.sequences[0]!;
    expect(seq.name).toBe('Anim1');
    expect(seq.duration).toBeCloseTo(1, 5);

    const rootTrack = seq.boneTracks.find((t) => t.boneIndex === 0)!; // "Armature"
    expect(rootTrack.position).toBeDefined();
    closeArray(rootTrack.position!.times, [0, 1]);
    // Y-вверх (0,0,0)→(0,0,5) («вперёд» по Z) конвертируется в канон (0,-5,0).
    closeArray(rootTrack.position!.values, [0, 0, 0, 0, -5, 0]);

    const childTrack = seq.boneTracks.find((t) => t.boneIndex === 3)!; // "Child"
    expect(childTrack.rotation).toBeDefined();
    // Некорневой узел: локальный поворот проходит БЕЗ изменений.
    closeArray(childTrack.rotation!.values, [0, 0, 0, 1, 0, 0, Math.SQRT1_2, Math.SQRT1_2]);
    // Режим интерполяции приезжает из формата, а не подразумевается (ASSET-5).
    expect(childTrack.rotation!.interpolation).toBe('linear');
  });

  it('секвенции: STEP-канал сохраняет ступенчатую интерполяцию', () => {
    const seq = model.sequences.find((s) => s.name === 'Anim2_Step')!;
    const track = seq.boneTracks.find((t) => t.boneIndex === 3)!;
    expect(track.scale).toBeDefined();
    // Ступенчатый клип, выпрямленный в линейный, — тихо испорченная анимация.
    expect(track.scale!.interpolation).toBe('step');
    closeArray(track.scale!.values, [1, 1, 1, 2, 2, 2]);
  });
});

describe('Загрузчик glTF: контейнер .glb со встроенным изображением (ASSET-5)', () => {
  let packed: NormalizedModel;
  let unpacked: NormalizedModel;
  let warnings: string[];

  /** Загрузка одного ID тем же загрузчиком — вид упаковки он определит сам. */
  async function loadModel(source: MemoryAssetSource, id: string): Promise<NormalizedModel> {
    const svc = new AssetService(source);
    svc.registerLoader(gltfLoader);
    const handle: Handle<NormalizedModel> = svc.request('model', id);
    const state = await settled(svc, handle);
    if (state.status !== 'ready') {
      throw new Error(`модель "${id}" не загрузилась: ${state.status === 'failed' ? state.reason : state.status}`);
    }
    return state.data;
  }

  beforeAll(async () => {
    const fixture = await buildGlbFixture();
    const source = new MemoryAssetSource(
      new Map([
        [GLB_ID, fixture.glb],
        [GLTF_ID, fixture.gltf],
        ['gltf-mini/model.bin', fixture.bin],
        [EXTERNAL_PNG_ID, fixture.png],
      ]),
    );
    // Предупреждение о недекодируемом изображении — часть контракта загрузчика,
    // поэтому оно перехватывается, а не глушится: тест ниже его проверяет.
    warnings = [];
    const spy = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
      warnings.push(args.map(String).join(' '));
    });
    try {
      packed = await loadModel(source, GLB_ID);
      unpacked = await loadModel(source, GLTF_ID);
    } finally {
      spy.mockRestore();
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('контейнер даёт ту же модель, что и распакованная пара .gltf + .bin', () => {
    // Различаться упаковки вправе ТОЛЬКО источником пикселей в слотах; всё
    // остальное — скелет, меши, секвенции, материалы, высота — это одна и та же
    // модель, и загрузчик у неё один (design, решение 4).
    expect(packed.bones).toEqual(unpacked.bones);
    expect(packed.meshes).toEqual(unpacked.meshes);
    expect(packed.sequences).toEqual(unpacked.sequences);
    expect(packed.materials).toEqual(unpacked.materials);
    expect(packed.height).toBe(unpacked.height);
  });

  it('слот со встроенным изображением несёт декодированные пиксели', () => {
    const slot = packed.textureSlots[0]!;
    expect(slot.source).toBe('embedded');
    if (slot.source !== 'embedded') return;
    // ASSET-5: потребителю приезжают ПИКСЕЛИ, а не байты файла, — декодирование
    // сделано один раз на ассет, внутри загрузчика.
    expect(slot.image.width).toBe(2);
    expect(slot.image.height).toBe(2);
    expect(slot.image.format).toBe('rgba8');
    expect([...slot.image.pixels]).toEqual(EMBEDDED_PIXELS);
  });

  it('слот с внешним uri несёт путь, разрешённый от ID ассета (ASSET-3)', () => {
    // Контейнер не обязывает встраивать всё: внешнее изображение остаётся
    // ссылкой на файл дерева контента ровно как в `.gltf`.
    expect(packed.textureSlots[1]).toEqual({
      slot: 1,
      source: 'file',
      path: EXTERNAL_TEXTURE_PATH,
    });
  });

  it('встроенное изображение без декодера — слот без источника и предупреждение, а не отказ', () => {
    // Модель без одной текстуры полезнее, чем не загрузившаяся модель
    // (design, решение 3).
    expect(packed.textureSlots[2]).toEqual({ slot: 2, source: 'none' });
    expect(packed.textureSlots).toHaveLength(3);
    expect(warnings.some((w) => w.includes('image/jpeg'))).toBe(true);
  });

  it('вид упаковки определяется сигнатурой содержимого, а не расширением', async () => {
    // Тот же байт-в-байт контейнер под именем `.gltf` грузится как контейнер:
    // имя файла — не свойство данных (design, решение 4).
    const fixture = await buildGlbFixture();
    const source = new MemoryAssetSource(
      new Map([
        ['gltf-mini/misnamed.gltf', fixture.glb],
        [EXTERNAL_PNG_ID, fixture.png],
      ]),
    );
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const model = await loadModel(source, 'gltf-mini/misnamed.gltf');
    expect(model.bones).toEqual(packed.bones);
    expect(model.textureSlots[0]!.source).toBe('embedded');
  });
});

describe('Загрузчик glTF: «Embedded»-упаковка — буфер и изображения data-URI', () => {
  let source: MemoryAssetSource;
  let model: NormalizedModel;
  let warnings: string[];

  beforeAll(async () => {
    // В источнике ровно один файл — сама модель: у data-URI читать рядом нечего.
    source = new MemoryAssetSource(new Map([[DATA_URI_ID, await buildDataUriFixture()]]));
    warnings = [];
    const spy = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
      warnings.push(args.map(String).join(' '));
    });
    try {
      model = await loadFrom(source, DATA_URI_ID);
    } finally {
      spy.mockRestore();
    }
  });

  it('геометрия и скелет приезжают из буфера, зашитого в JSON', () => {
    // Тот же скелет и те же меши, что у распакованной фикстуры: значит буфер
    // разобран, а не подменён нулями.
    expect(model.bones).toHaveLength(5);
    const body = model.meshes.find((m) => m.partId === 0)!;
    closeArray(body.positions, [0, 0, 0, 1, 0, 0, 0, 0, 1]);
    expect(source.reads).toEqual([DATA_URI_ID]);
  });

  it('изображение data-URI — встроенный слот с пикселями, а не путь к файлу', () => {
    // Разрешать `data:image/png;base64,...` как относительный путь (ASSET-3)
    // значило бы просить у дерева контента заведомо несуществующий файл.
    const slot = model.textureSlots[0]!;
    expect(slot.source).toBe('embedded');
    if (slot.source !== 'embedded') return;
    expect([...slot.image.pixels]).toEqual(EMBEDDED_PIXELS);
  });

  it('внешний uri в том же документе остаётся слотом-ссылкой', () => {
    expect(model.textureSlots[1]).toEqual({
      slot: 1,
      source: 'file',
      path: EXTERNAL_TEXTURE_PATH,
    });
  });

  it('data-URI формата без декодера — слот без источника и предупреждение', () => {
    expect(model.textureSlots[2]).toEqual({ slot: 2, source: 'none' });
    expect(warnings.some((w) => w.includes('декодера нет'))).toBe(true);
  });
});

describe('Загрузчик glTF: меш из нескольких примитивов (ASSET-5: часть модели)', () => {
  let model: NormalizedModel;

  beforeAll(async () => {
    const fixture = await buildMultiPrimitiveFixture();
    model = await loadFrom(
      new MemoryAssetSource(
        new Map([
          [MULTI_PRIM_ID, fixture.gltf],
          ['gltf-mini/model.bin', fixture.bin],
        ]),
      ),
      MULTI_PRIM_ID,
    );
  });

  it('каждый примитив — отдельная часть со сквозным номером', () => {
    // Экспортёр режет меш по материалам: взять из mesh только первый primitive
    // значило бы тихо потерять геометрию всех прочих материалов.
    expect(model.meshes).toHaveLength(3);
    expect(model.meshes.map((m) => m.partId)).toEqual([0, 1, 2]);
    // Второй примитив "PropMesh" повторяет геометрию первого — и обе части на
    // месте, с одинаковым запеканием в bind-пространство своего узла.
    closeArray(model.meshes[2]!.positions, [...model.meshes[1]!.positions]);
  });

  it('примитив без material берёт материал по умолчанию, а не нулевой авторский', () => {
    // Материал 0 документа — такой же авторский, как любой другой (ASSET-5:
    // отсутствующее описание не восполняется чужими значениями).
    expect(model.meshes[1]!.materialIndex).toBe(0);
    expect(model.meshes[2]!.materialIndex).toBe(1);
    expect(model.materials).toHaveLength(2);
    const fallback = model.materials[1]!;
    expect(fallback.baseColorFactor).toEqual([1, 1, 1, 1]);
    expect(fallback.metallicFactor).toBe(1);
    expect(fallback.roughnessFactor).toBe(1);
    expect(fallback.alphaMode).toBe('opaque');
    expect(fallback.doubleSided).toBe(false);
    expect(fallback.baseColorTexture).toBeNull();
  });
});

describe('Загрузчик glTF: несколько скинов в одном документе', () => {
  it('JOINTS_0 разрешаются через скин СВОЕГО узла, а не через skins[0]', async () => {
    const fixture = await buildTwoSkinsFixture();
    const model = await loadFrom(
      new MemoryAssetSource(
        new Map([
          [TWO_SKINS_ID, fixture.gltf],
          ['gltf-mini/model.bin', fixture.bin],
        ]),
      ),
      TWO_SKINS_ID,
    );
    // "Body" (skin 0, joints [2, 3]) — как в базовой фикстуре: сустав 0 = узел 2.
    const body = model.meshes.find((m) => m.partId === 0)!;
    // "Body2" (skin 1, joints [3, 2]): те же JOINTS_0 = 0, но сустав 0 ЕГО
    // скина — узел 3. Прогон через skins[0] молча привязал бы вершины к узлу 2
    // — тихо испорченный скининг вместо внятной модели (см. заголовок gltf.ts).
    const second = model.meshes.find((m) => m.partId === 2)!;
    for (let v = 0; v < 3; v++) {
      expect(body.skinIndices[v * 4]).toBe(2);
      expect(second.skinIndices[v * 4]).toBe(3);
    }
  });

  it('ссылка узла на несуществующий skin — внятная ошибка, а не чужие суставы', async () => {
    const fixture = await buildDanglingSkinFixture();
    const source = new MemoryAssetSource(
      new Map([
        [DANGLING_SKIN_ID, fixture.gltf],
        ['gltf-mini/model.bin', fixture.bin],
      ]),
    );
    await expect(loadFrom(source, DANGLING_SKIN_ID)).rejects.toThrow('skin 7 не существует');
  });
});

describe('Загрузчик glTF: ненормированные веса скининга', () => {
  it('веса приводятся к сумме 1 на вершину', async () => {
    const fixture = await buildUnnormalizedWeightsFixture();
    const model = await loadFrom(
      new MemoryAssetSource(
        new Map([
          [UNNORMALIZED_ID, fixture.gltf],
          ['gltf-mini/model.bin', fixture.bin],
        ]),
      ),
      UNNORMALIZED_ID,
    );
    // Сумма 1 — инвариант `NormalizedMesh.skinWeights`, а не обещание чужого
    // экспортёра: `[2, 2, 0, 0]` приезжает как `[0.5, 0.5, 0, 0]`.
    const body = model.meshes.find((m) => m.partId === 0)!;
    for (let v = 0; v < 3; v++) {
      closeArray(body.skinWeights.subarray(v * 4, v * 4 + 4), [0.5, 0.5, 0, 0]);
    }
  });
});

describe('Загрузчик glTF: сила эмиссии KHR_materials_emissive_strength (ASSET-5)', () => {
  it('сила 4 доезжает без клампа, а материал без расширения даёт 1', async () => {
    const fixture = await buildEmissiveStrengthFixture();
    const model = await loadFrom(
      new MemoryAssetSource(
        new Map([
          [EMISSIVE_STRENGTH_ID, fixture.gltf],
          ['gltf-mini/model.bin', fixture.bin],
        ]),
      ),
      EMISSIVE_STRENGTH_ID,
    );
    // Значение больше единицы — и есть HDR-свечение: обрежь его загрузчик по
    // единице, материал не пересёк бы порог bloom (`rendering` REND-34).
    expect(model.materials[0]!.emissiveStrength).toBe(4);
    closeArray(model.materials[0]!.emissiveFactor, [1, 0.8, 0.4]);
    // Тот же материал без расширения — сила 1, то есть вид байт-в-байт как до
    // появления поля.
    expect(model.materials[1]!.emissiveStrength).toBe(1);
  });

});
