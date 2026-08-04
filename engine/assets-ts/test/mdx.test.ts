import { beforeAll, describe, expect, it } from 'vitest';
import {
  AssetService,
  mdxLoader,
  type Handle,
  type NormalizedMesh,
  type NormalizedModel,
} from '../src/index.js';
import { FIXTURES_DIR, FsAssetSource, settled } from './helpers.js';

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
      expect(b.pivot).toHaveLength(3);
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

      expect(mesh.textureSlot).toBeGreaterThanOrEqual(0);
      expect(mesh.textureSlot).toBeLessThan(model.textureSlots.length);
    }
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

  it('видимость частей: только многоключевая geoset-альфа, концевые ключи, значения 0/1', () => {
    // у эталона одноключевые GeosetAnim — placeholder базового тела (геосет 0
    // и др.); они НЕ должны порождать треки видимости
    const animatedIds = new Set<number>();
    let total = 0;
    for (const seq of model.sequences) {
      for (const track of seq.partVisibility) {
        total += 1;
        animatedIds.add(track.partId);
        const label = `"${seq.name}" часть ${track.partId}`;
        expectStrictlyIncreasing(track.times, label);
        expect(track.visible.length, label).toBe(track.times.length);
        expect(track.times[0], label).toBe(0);
        expect(track.times[track.times.length - 1]!, label).toBeCloseTo(seq.duration, 5);
        for (const v of track.visible) expect(v === 0 || v === 1, label).toBe(true);
      }
    }
    expect(total).toBeGreaterThan(0); // настоящие тумблеры (Defend-варианты) есть
    expect(animatedIds.has(0)).toBe(false); // placeholder базового тела игнорирован
    for (const id of animatedIds) {
      expect(id).toBeGreaterThanOrEqual(0);
      expect(id).toBeLessThan(model.meshes.length);
    }
  });

  it('слоты текстур: нумерация сквозная, путь либо непустой, либо null', () => {
    expect(model.textureSlots.length).toBeGreaterThan(0);
    model.textureSlots.forEach((slot, i) => {
      // Сквозная нумерация — главный инвариант: скины манифеста подменяют
      // текстуры по НОМЕРУ слота, поэтому слоты без файла (в MDX это
      // replaceable-слоты team color) из списка не выкидываются, а приезжают
      // с path === null и держат свой номер.
      expect(slot.slot).toBe(i);
      expect(slot.path === null || slot.path.length > 0).toBe(true);
    });
    // У эталона есть и слоты с текстурой, и replaceable-слот без файла.
    expect(model.textureSlots.some((s) => s.path !== null)).toBe(true);
    expect(model.textureSlots.some((s) => s.path === null)).toBe(true);
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
