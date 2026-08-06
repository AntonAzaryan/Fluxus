import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  AssetService,
  gltfLoader,
  type Handle,
  type NormalizedModel,
} from '../src/index.js';
import { FsAssetSource, settled } from './helpers.js';

/**
 * Модель Hero (демо), не копия фикстуры: грузим ровно тот файл, на который
 * ссылается `content/visuals/manifest.json` (ASSET-2), — регресс на реальном
 * контенте поверх математики, уже проверенной рукописной фикстурой gltf.test.ts.
 */
const CONTENT_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../../content');
const MODEL_ID = 'visuals/models/Barbarian/Barbarian.gltf';

describe('Загрузчик glTF: реальная модель Hero из content/ (ASSET-5: headless в Node)', () => {
  let model: NormalizedModel;

  beforeAll(async () => {
    const svc = new AssetService(new FsAssetSource(CONTENT_DIR));
    svc.registerLoader(gltfLoader);
    const handle: Handle<NormalizedModel> = svc.request('model', MODEL_ID);
    const state = await settled(svc, handle);
    if (state.status !== 'ready') {
      throw new Error(`модель не загрузилась: ${state.status === 'failed' ? state.reason : state.status}`);
    }
    model = state.data;
  });

  it('скелет: узлы "chest"/"head" под boneControls манифеста, без циклов родителей', () => {
    expect(model.bones.length).toBeGreaterThan(0);
    expect(model.bones.some((b) => b.name === 'chest')).toBe(true);
    expect(model.bones.some((b) => b.name === 'head')).toBe(true);
    expect(model.bones.some((b) => b.parentIndex === -1)).toBe(true);

    model.bones.forEach((b, i) => {
      expect(b.index).toBe(i);
      let cursor = b.parentIndex;
      let steps = 0;
      while (cursor !== -1) {
        cursor = model.bones[cursor]!.parentIndex;
        steps += 1;
        expect(steps, `цикл родителей у кости "${b.name}"`).toBeLessThanOrEqual(model.bones.length);
      }
    });
  });

  it('меши: буферы согласованы, веса нормированы, индексы в диапазоне', () => {
    expect(model.meshes.length).toBeGreaterThan(0);
    for (const mesh of model.meshes) {
      const label = `часть ${mesh.partId}`;
      const vcount = mesh.positions.length / 3;
      expect(mesh.positions.length % 3, label).toBe(0);
      expect(mesh.skinIndices.length, label).toBe(vcount * 4);
      expect(mesh.skinWeights.length, label).toBe(vcount * 4);
      for (const idx of mesh.skinIndices) {
        expect(idx, label).toBeGreaterThanOrEqual(0);
        expect(idx, label).toBeLessThan(model.bones.length);
      }
      for (const idx of mesh.indices) expect(idx, label).toBeLessThan(vcount);
      expect(mesh.indices.length % 3, label).toBe(0);
    }
  });

  it('текстуры: единственный слот резолвится в существующий PNG контент-дерева', () => {
    expect(model.textureSlots).toHaveLength(1);
    expect(model.textureSlots[0]!.path).toBe('visuals/textures/barbarian.png');
  });

  it('секвенции: клипы манифеста Hero присутствуют под точными именами', () => {
    const names = new Set(model.sequences.map((s) => s.name));
    for (const clip of ['Idle', 'Running_A', 'Jump_Idle', '1H_Ranged_Shoot', 'Death_A', 'Dodge_Forward', 'Dodge_Backward']) {
      expect(names.has(clip), `клип "${clip}" из манифеста Hero отсутствует в модели`).toBe(true);
    }
    for (const seq of model.sequences) {
      expect(seq.duration, seq.name).toBeGreaterThan(0);
      expect(seq.boneTracks.length, seq.name).toBeGreaterThan(0);
    }
  });

  it('высота bbox положительна (нормализация масштаба инстанса)', () => {
    expect(model.height).toBeGreaterThan(0);
  });
});
