/**
 * Построение инстанса из NormalizedModel (REND-3): скелет из NormalizedBone
 * (иерархия и мировые позиции), разделяемая геометрия, клипы из секвенций,
 * нормализация масштаба.
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  buildBones,
  buildSharedModel,
  createModelInstance,
  type NormalizedModel,
} from '../src/index.js';
import { makeModel } from './fixtures.js';

describe('buildBones: скелет из NormalizedBone', () => {
  it('строит иерархию по parentIndex; pivot — локальная позиция', () => {
    const { bones, roots, byName } = buildBones(makeModel().bones);
    expect(bones.length).toBe(2);
    expect(roots).toEqual([bones[0]]);
    expect(bones[1]!.parent).toBe(bones[0]);
    expect(bones[0]!.name).toBe('b0'); // имена под треки клипов
    expect(byName.get('Bone_Chest')).toBe(bones[1]);
    expect(bones[1]!.position.toArray()).toEqual([10, 0, 0]);
  });

  it('мировая позиция кости — сумма цепочки pivot', () => {
    const { bones, roots } = buildBones(makeModel().bones);
    const group = new THREE.Group();
    for (const root of roots) group.add(root);
    group.updateMatrixWorld(true);
    const world = new THREE.Vector3();
    bones[1]!.getWorldPosition(world);
    expect(world.toArray()).toEqual([11, 2, 3]);
  });
});

describe('createModelInstance: скелет и биндинг', () => {
  it('inverse-bind считается по мировым матрицам, а не по единичным', () => {
    const shared = buildSharedModel(makeModel());
    const instance = createModelInstance(shared);
    // Мировая позиция chest в бинд-позе — (11,2,3); её инверсия обязана
    // возвращать точку в ноль. Если бы Skeleton создавался до
    // updateMatrixWorld, инверсия была бы единичной и тест бы упал.
    const inverse = instance.skeleton.boneInverses[1]!;
    const probe = new THREE.Vector3(11, 2, 3).applyMatrix4(inverse);
    expect(probe.length()).toBeLessThan(1e-6);
  });

  it('меши забинжены на скелет инстанса и не отсекаются фрустумом', () => {
    const instance = createModelInstance(buildSharedModel(makeModel()));
    expect(instance.meshes.length).toBe(1);
    expect(instance.meshes[0]!.skeleton).toBe(instance.skeleton);
    expect(instance.meshes[0]!.frustumCulled).toBe(false);
    expect(instance.meshes[0]!.name).toBe('part0'); // под треки видимости
  });

  it('геометрия разделяется между инстансами, материалы — свои (REND-3, REND-6)', () => {
    const shared = buildSharedModel(makeModel());
    const a = createModelInstance(shared);
    const b = createModelInstance(shared);
    expect(a.meshes[0]!.geometry).toBe(b.meshes[0]!.geometry);
    expect(a.meshes[0]!.geometry).toBe(shared.meshes[0]!.geometry);
    expect(a.skeleton).not.toBe(b.skeleton);
    expect(a.materialsBySlot.get(0)).not.toBe(b.materialsBySlot.get(0));
  });

  it('нормализация масштаба: высота модели → одна единица × scale манифеста', () => {
    const shared = buildSharedModel(makeModel()); // height = 2
    const plain = createModelInstance(shared);
    expect((plain.root.children[0] as THREE.Group).scale.x).toBeCloseTo(0.5, 6);
    const scaled = createModelInstance(shared, { scale: 2 });
    expect((scaled.root.children[0] as THREE.Group).scale.x).toBeCloseTo(1, 6);
  });

  it('hiddenParts исключает часть модели целиком', () => {
    const instance = createModelInstance(buildSharedModel(makeModel()), { hiddenParts: [0] });
    expect(instance.meshes.length).toBe(0);
  });
});

describe('buildSharedModel: клипы из секвенций (REND-4)', () => {
  it('треки костей и видимости частей собираются в AnimationClip', () => {
    const shared = buildSharedModel(makeModel());
    expect(shared.clips.map((clip) => clip.name)).toEqual([
      'Stand - 1',
      'Walk Fast',
      'Attack - 1',
      'Death',
    ]);

    const stand = shared.clips[0]!;
    expect(stand.duration).toBeCloseTo(1, 6);
    expect(stand.tracks.length).toBe(2); // b1.quaternion + part0.visible
    expect(stand.tracks.map((track) => track.name).sort()).toEqual([
      'b1.quaternion',
      'part0.visible',
    ]);
    expect(stand.tracks.find((track) => track.name === 'part0.visible')).toBeInstanceOf(
      THREE.BooleanKeyframeTrack,
    );

    const walk = shared.clips[1]!;
    expect(walk.tracks.length).toBe(1);
    expect(walk.tracks[0]).toBeInstanceOf(THREE.QuaternionKeyframeTrack);
  });

  it('клип реально гнёт кость инстанса через микшер', () => {
    const shared = buildSharedModel(makeModel());
    const instance = createModelInstance(shared);
    const chest = instance.bonesByName.get('Bone_Chest')!;
    const before = chest.quaternion.clone();

    const action = instance.mixer.clipAction(shared.clips[0] as THREE.AnimationClip);
    action.play();
    instance.mixer.update(0.5); // середина клипа: identity → 90° вокруг Z
    expect(chest.quaternion.equals(before)).toBe(false);
  });

  it('трек видимости реально гасит меш: имя узла в клипе и имя SkinnedMesh синхронны', () => {
    // Единственный «клей» между треком видимости и мешом — совпадение имени
    // `part<id>` в buildClips и в createModelInstance. Разъедутся — THREE не
    // найдёт узел и просто ничего не сделает, без ошибки. Поэтому проверяем не
    // литералы имён (их легко переименовать в обоих местах теста заодно), а
    // факт резолва: микшер обязан переключить `visible`.
    const base = makeModel();
    const model: NormalizedModel = {
      ...base,
      sequences: [
        {
          name: 'Hide',
          duration: 1,
          boneTracks: [],
          partVisibility: [
            { partId: 0, times: new Float32Array([0, 0.5]), visible: new Uint8Array([1, 0]) },
          ],
        },
      ],
    };

    const shared = buildSharedModel(model);
    const instance = createModelInstance(shared);
    const mesh = instance.meshes[0]!;
    expect(mesh.visible).toBe(true);

    instance.mixer.clipAction(shared.clips[0] as THREE.AnimationClip).play();
    instance.mixer.update(0.75); // после ключа t=0.5 часть скрыта
    expect(mesh.visible).toBe(false);
  });
});
