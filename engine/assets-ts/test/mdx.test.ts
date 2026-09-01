import { beforeAll, describe, expect, it } from 'vitest';
import {
  AssetService,
  mdxLoader,
  type Handle,
  type NormalizedMesh,
  type NormalizedModel,
} from '../src/index.js';
import { FIXTURES_DIR, FsAssetSource, settled } from './helpers.js';

/**
 * Эталонная фикстура ПАРСЕРА (`game-content` CONT-4), а не копия игровой модели:
 * предмет проверок ниже — разбор формата MDX, и краснеть они обязаны от правки
 * загрузчика, а не от того, что дизайнер переэкспортировал героя. Совпадение
 * байтов с моделью дерева контента — общее происхождение, а не связь:
 * синхронизации оно не подлежит, и зависеть тесту движка от дерева контента
 * запрещено тем же требованием.
 */
const MODEL_ID = 'SkeletonBarbarian.mdx';

/** Времена трека строго возрастают, первый ключ не раньше нуля. */
function expectStrictlyIncreasing(times: Float32Array, what: string): void {
  expect(times.length, `${what}: пустой трек`).toBeGreaterThan(0);
  expect(times[0]!, `${what}: время до нуля`).toBeGreaterThanOrEqual(0);
  for (let i = 1; i < times.length; i++) {
    expect(times[i]!, `${what}: времена не строго возрастают (ключ ${i})`).toBeGreaterThan(
      times[i - 1]!,
    );
  }
}

describe('Загрузчик MDX: эталонная модель (ASSET-5: headless в Node)', () => {
  let model: NormalizedModel;

  beforeAll(async () => {
    const svc = new AssetService(new FsAssetSource(FIXTURES_DIR));
    svc.registerLoader(mdxLoader);
    const handle: Handle<NormalizedModel> = svc.request('model', MODEL_ID);
    const state = await settled(svc, handle);
    if (state.status !== 'ready') {
      throw new Error(`модель не загрузилась: ${state.status === 'failed' ? state.reason : state.status}`);
    }
    model = state.data;
  });

  it('скелет: узлы с именами Bone_*, у корней parentIndex -1, без циклов', () => {
    expect(model.bones.length).toBeGreaterThan(0);
    expect(model.bones.some((b) => b.name.startsWith('Bone_'))).toBe(true);

    model.bones.forEach((b, i) => {
      expect(b.index).toBe(i);
      expect(b.position).toHaveLength(3);
      // Поза покоя MDX: повороты и масштаб единичны, привязка выводится из позы.
      expect([...b.rotation]).toEqual([0, 0, 0, 1]);
      expect([...b.scale]).toEqual([1, 1, 1]);
      expect(b.inverseBind).toBeNull();
      if (b.parentIndex !== -1) {
        expect(b.parentIndex).toBeGreaterThanOrEqual(0);
        expect(b.parentIndex).toBeLessThan(model.bones.length);
      }
      // подъём к корню обязан завершиться быстрее, чем за число костей
      let cursor = b.parentIndex;
      let steps = 0;
      while (cursor !== -1) {
        cursor = model.bones[cursor]!.parentIndex;
        steps += 1;
        expect(steps, `цикл родителей у кости "${b.name}"`).toBeLessThanOrEqual(model.bones.length);
      }
    });
    expect(model.bones.some((b) => b.parentIndex === -1)).toBe(true);
  });

  it('меши: буферы согласованы по числу вершин, веса нормированы', () => {
    expect(model.meshes.length).toBeGreaterThan(0);
    for (const mesh of model.meshes) {
      const label = `часть ${mesh.partId}`;
      expect(mesh.positions.length % 3, label).toBe(0);
      const vcount = mesh.positions.length / 3;
      expect(vcount, label).toBeGreaterThan(0);

      expect(mesh.skinIndices.length, label).toBe(vcount * 4);
      expect(mesh.skinWeights.length, label).toBe(vcount * 4);
      if (mesh.normals) expect(mesh.normals.length, label).toBe(vcount * 3);
      if (mesh.uvs) expect(mesh.uvs.length, label).toBe(vcount * 2);

      expect(mesh.indices.length % 3, label).toBe(0);
      for (const idx of mesh.indices) expect(idx, label).toBeLessThan(vcount);

      for (let v = 0; v < vcount; v++) {
        let sum = 0;
        for (let k = 0; k < 4; k++) {
          const bone = mesh.skinIndices[v * 4 + k]!;
          expect(bone, `${label}: skinIndex вершины ${v}`).toBeLessThan(model.bones.length);
          sum += mesh.skinWeights[v * 4 + k]!;
        }
        expect(sum, `${label}: веса вершины ${v} не нормированы`).toBeCloseTo(1, 5);
      }

      expect(mesh.materialIndex).toBeGreaterThanOrEqual(0);
      expect(mesh.materialIndex).toBeLessThan(model.materials.length);
    }
  });

  it('материалы: непустые, карта базового цвета ссылается на существующий слот', () => {
    expect(model.materials.length).toBeGreaterThan(0);
    for (const material of model.materials) {
      expect(material.baseColorFactor).toHaveLength(4);
      expect(material.metallicFactor).toBeGreaterThanOrEqual(0);
      expect(material.roughnessFactor).toBeGreaterThan(0);
      // Карты материала — НОМЕРА слотов, а не пути: слот и есть точка подмены
      // скином манифеста (ASSET-6).
      if (material.baseColorTexture !== null) {
        expect(material.baseColorTexture).toBeGreaterThanOrEqual(0);
        expect(material.baseColorTexture).toBeLessThan(model.textureSlots.length);
      }
      expect(material.alphaMode).toBe('opaque');
    }
  });

  it('интерполяция каналов заявлена и ограничена ступенчатой и линейной', () => {
    // Эрмит и безье MDX сознательно не переводятся в cubic — см. загрузчик.
    const seen = new Set<string>();
    for (const seq of model.sequences) {
      for (const track of seq.boneTracks) {
        for (const channel of [track.position, track.rotation, track.scale]) {
          if (channel === undefined) continue;
          expect(['step', 'linear']).toContain(channel.interpolation);
          seen.add(channel.interpolation);
        }
      }
    }
    expect(seen.size).toBeGreaterThan(0);
  });

  it('секвенции: непустые, duration > 0, знакомые клипы на месте', () => {
    expect(model.sequences.length).toBeGreaterThan(0);
    const names = model.sequences.map((s) => s.name);
    for (const expected of ['Stand', 'Walk', 'Death']) {
      expect(names.some((n) => n.includes(expected)), `нет клипа "${expected}"`).toBe(true);
    }
    for (const seq of model.sequences) {
      expect(seq.duration).toBeGreaterThan(0);
      expect(seq.boneTracks.length, `секвенция "${seq.name}" без треков костей`).toBeGreaterThan(0);
    }
  });

  it('треки костей: времена строго возрастают, размеры каналов кратны ключам', () => {
    for (const seq of model.sequences) {
      for (const track of seq.boneTracks) {
        expect(track.boneIndex).toBeGreaterThanOrEqual(0);
        expect(track.boneIndex).toBeLessThan(model.bones.length);
        const label = `"${seq.name}" кость ${track.boneIndex}`;
        for (const [channel, dim] of [
          [track.position, 3],
          [track.rotation, 4],
          [track.scale, 3],
        ] as const) {
          if (!channel) continue;
          expectStrictlyIncreasing(channel.times, label);
          expect(channel.values.length, label).toBe(channel.times.length * dim);
          expect(channel.times[channel.times.length - 1]!, label).toBeLessThanOrEqual(
            seq.duration + 1e-6,
          );
        }
      }
    }
  });

  it('видимость частей: концевые ключи, значения 0/1, номера частей из модели', () => {
    let total = 0;
    for (const seq of model.sequences) {
      for (const track of seq.partVisibility) {
        total += 1;
        const label = `"${seq.name}" часть ${track.partId}`;
        expectStrictlyIncreasing(track.times, label);
        expect(track.visible.length, label).toBe(track.times.length);
        expect(track.times[0], label).toBe(0);
        expect(track.times[track.times.length - 1]!, label).toBeCloseTo(seq.duration, 5);
        for (const v of track.visible) expect(v === 0 || v === 1, label).toBe(true);
        expect(track.partId, label).toBeGreaterThanOrEqual(0);
        expect(track.partId, label).toBeLessThan(model.meshes.length);
      }
    }
    expect(total).toBeGreaterThan(0);
  });

  it('видимость частей: альфа читается по окну секвенции — в Death живое тело погашено', () => {
    // Регрессия: альфа геосета в MDX — один вектор на всю ленту кадров, и
    // ключи ВНЕ окна секвенции к ней не относятся. Геосеты живого тела эталона
    // несут единственный ключ alpha=0 на первом кадре Death: прочитанные
    // глобально, они оставались видимы и в смерти — вторым слоем поверх
    // варианта смерти, у которого своё включение ровно в этом окне.
    const visibleAtStart = (name: string): Set<number> => {
      const seq = model.sequences.find((s) => s.name === name);
      if (!seq) throw new Error(`в эталоне нет секвенции "${name}"`);
      const hidden = new Set(
        seq.partVisibility.filter((t) => t.visible[0] === 0).map((t) => t.partId),
      );
      return new Set(model.meshes.map((m) => m.partId).filter((id) => !hidden.has(id)));
    };

    const alive = visibleAtStart('Stand');
    const dead = visibleAtStart('Death');
    expect(alive.size).toBeGreaterThan(0);
    expect(dead.size).toBeGreaterThan(0);
    // Живое тело и вариант смерти — непересекающиеся наборы геосетов.
    expect([...dead].filter((id) => alive.has(id))).toEqual([]);

    // Секвенция задаёт состояние части целиком: гаснущая часть получает трек
    // в КАЖДОЙ секвенции, иначе после смерти тело не вернулось бы к жизни.
    const switching = new Set(model.sequences.flatMap((s) => s.partVisibility.map((t) => t.partId)));
    for (const seq of model.sequences) {
      const covered = new Set(seq.partVisibility.map((t) => t.partId));
      for (const id of switching) {
        expect(covered.has(id), `"${seq.name}": нет трека видимости части ${id}`).toBe(true);
      }
    }
  });

  it('слоты текстур: нумерация сквозная, источник — файл либо ничего', () => {
    expect(model.textureSlots.length).toBeGreaterThan(0);
    model.textureSlots.forEach((slot, i) => {
      // Сквозная нумерация — главный инвариант: скины манифеста подменяют
      // текстуры по НОМЕРУ слота (REND-6), поэтому слоты без источника (в MDX
      // это replaceable-слоты team color) из списка не выкидываются, а держат
      // свой номер.
      expect(slot.slot).toBe(i);
      // Встроенных изображений у MDX не бывает: текстуры WC3 — всегда файл.
      expect(slot.source === 'file' || slot.source === 'none').toBe(true);
      if (slot.source === 'file') expect(slot.path.length).toBeGreaterThan(0);
    });
    // У эталона есть и слоты с текстурой, и replaceable-слот без файла.
    expect(model.textureSlots.some((s) => s.source === 'file')).toBe(true);
    expect(model.textureSlots.some((s) => s.source === 'none')).toBe(true);
  });

  it('слоты текстур: те же пути и те же номера, что и до перехода на объединение', () => {
    // Смена ПРЕДСТАВЛЕНИЯ слота не должна была изменить сами слоты: эталонная
    // модель обязана дать то же их число, ту же нумерацию и те же пути.
    const slots = model.textureSlots.map((s) => (s.source === 'file' ? s.path : null));
    expect(slots).toEqual([
      'Textures\\Skeleton.blp',
      null, // replaceable-слот team color — источника нет, номер занят
      'Units\\Creeps\\SkeletonOrc\\SkeletonOrc.blp',
      'Textures\\Centaur.blp',
      'Textures\\Bandit.blp',
      'Units\\Human\\Jaina\\Jaina.blp',
    ]);
  });

  it('height: положительная высота bbox по Z', () => {
    expect(model.height).toBeGreaterThan(0);
    expect(Number.isFinite(model.height)).toBe(true);
  });

  it('модель иммутабельна: корень и вложенные контейнеры заморожены (ASSET-5)', () => {
    // Ассет разделяется всеми инстансами, поэтому запись в него — не «своя»
    // правка, а порча данных у соседей. Типы это запрещают, заморозка ловит
    // обход типов (as any, JS-потребитель). Буферы не проверяем: содержимое
    // TypedArray заморозить нельзя — см. оговорку в model.ts.
    const containers: object[] = [
      model,
      model.bones,
      model.meshes,
      model.sequences,
      model.textureSlots,
      ...model.bones,
      ...model.meshes,
      ...model.sequences,
      ...model.textureSlots,
      ...model.sequences.flatMap((s) => [...s.boneTracks, ...s.partVisibility]),
    ];
    for (const container of containers) {
      expect(Object.isFrozen(container)).toBe(true);
    }

    expect(() => {
      (model as { height: number }).height = 0;
    }).toThrow(TypeError);
    expect(() => {
      (model.meshes as NormalizedMesh[]).pop();
    }).toThrow(TypeError);
  });
});
