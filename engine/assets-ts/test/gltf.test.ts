import { beforeAll, describe, expect, it } from 'vitest';
import {
  AssetService,
  gltfLoader,
  type Handle,
  type NormalizedModel,
} from '../src/index.js';
import { FIXTURES_DIR, FsAssetSource, settled } from './helpers.js';

const MODEL_ID = 'gltf-mini/model.gltf';

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
  });

  it('слоты текстур: путь разрешается ОТ ID ассета, слот без файла остаётся в нумерации', () => {
    expect(model.textureSlots).toHaveLength(2);
    // "../shared/atlas.png" от ID "gltf-mini/model.gltf" → "shared/atlas.png" (ASSET-3).
    expect(model.textureSlots[0]).toEqual({ slot: 0, path: 'shared/atlas.png' });
    // Изображение без внешнего uri (встроенное) — слот объявлен, файла за ним нет.
    expect(model.textureSlots[1]).toEqual({ slot: 1, path: null });
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
