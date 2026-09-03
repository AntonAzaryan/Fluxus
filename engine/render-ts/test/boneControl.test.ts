/**
 * Bone-контроль (REND-5): математика доворота (кламп лимитом манифеста,
 * экспоненциальное сглаживание) и применение к кости с предупреждением об
 * отсутствующей кости один раз.
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  BoneControlState,
  clampYaw,
  smoothYaw,
  stepYaw,
  wrapAngle,
  type BoneLookup,
} from '../src/index.js';

describe('математика доворота', () => {
  it('wrapAngle приводит угол к (-π, π]', () => {
    expect(wrapAngle(2 * Math.PI + 0.3)).toBeCloseTo(0.3, 6);
    expect(wrapAngle(-2 * Math.PI - 0.3)).toBeCloseTo(-0.3, 6);
    expect(wrapAngle(0.5)).toBeCloseTo(0.5, 6);
  });

  it('clampYaw ограничивает цель лимитом манифеста', () => {
    expect(clampYaw(2, 0.5)).toBeCloseTo(0.5, 6);
    expect(clampYaw(-2, 0.5)).toBeCloseTo(-0.5, 6);
    expect(clampYaw(0.2, 0.5)).toBeCloseTo(0.2, 6);
  });

  it('smoothYaw — экспоненциальное сглаживание, не зависящее от разбиения времени', () => {
    // Один шаг rate=1, dt=1: доворот на (1 - e^-1) от разницы.
    expect(smoothYaw(0, 1, 1, 1)).toBeCloseTo(1 - Math.exp(-1), 6);
    // Два шага по dt=0.5 дают то же, что один на dt=1.
    const half = smoothYaw(smoothYaw(0, 1, 1, 0.5), 1, 1, 0.5);
    expect(half).toBeCloseTo(smoothYaw(0, 1, 1, 1), 6);
    // rate <= 0 — мгновенно.
    expect(smoothYaw(0, 1, 0, 0.016)).toBeCloseTo(1, 6);
  });

  it('smoothYaw идёт по кратчайшей дуге через ±π', () => {
    const yaw = smoothYaw(Math.PI - 0.1, -Math.PI + 0.1, 0, 1);
    expect(wrapAngle(yaw)).toBeCloseTo(-Math.PI + 0.1, 6);
  });

  it('stepYaw сходится к клампленной цели, а не к самой цели', () => {
    const maxRad = Math.PI / 4;
    let yaw = 0;
    for (let i = 0; i < 200; i++) yaw = stepYaw(yaw, Math.PI / 2, maxRad, 20, 0.016);
    expect(yaw).toBeCloseTo(maxRad, 3);
  });
});

describe('BoneControlState.apply (REND-5)', () => {
  function makeInstance(): { bone: THREE.Bone; bonesByName: Map<string, THREE.Bone> } {
    const bone = new THREE.Bone();
    bone.name = 'b1';
    return { bone, bonesByName: new Map([['Bone_Chest', bone]]) };
  }

  it('доворачивает кость вокруг вертикали в пределах лимита', () => {
    const { bone, bonesByName } = makeInstance();
    const control = new BoneControlState({
      torso: { bone: 'Bone_Chest', maxYawDeg: 45, smoothing: 0 }, // мгновенный доворот
    });

    control.apply({ bonesByName }, Math.PI / 2, 0, 0.016);
    // Цель 90°, лимит 45° — кость довёрнута ровно на лимит вокруг Z.
    const euler = new THREE.Euler().setFromQuaternion(bone.quaternion, 'ZYX');
    expect(euler.z).toBeCloseTo(Math.PI / 4, 5);
  });

  it('без цели возвращается в нейтраль; доворот не накапливается между кадрами', () => {
    const { bone, bonesByName } = makeInstance();
    const control = new BoneControlState({
      torso: { bone: 'Bone_Chest', maxYawDeg: 90, smoothing: 0 },
    });

    // Микшер кость не трогает (нет трека) — повторные apply не должны крутить дальше.
    control.apply({ bonesByName }, Math.PI / 4, 0, 0.016);
    control.apply({ bonesByName }, Math.PI / 4, 0, 0.016);
    control.apply({ bonesByName }, Math.PI / 4, 0, 0.016);
    const euler = new THREE.Euler().setFromQuaternion(bone.quaternion, 'ZYX');
    expect(euler.z).toBeCloseTo(Math.PI / 4, 5);

    control.apply({ bonesByName }, null, 0, 0.016);
    const neutral = new THREE.Euler().setFromQuaternion(bone.quaternion, 'ZYX');
    expect(neutral.z).toBeCloseTo(0, 5);
  });

  it('цель считается относительно курса инстанса', () => {
    const { bone, bonesByName } = makeInstance();
    const control = new BoneControlState({
      torso: { bone: 'Bone_Chest', maxYawDeg: 90, smoothing: 0 },
    });
    // Инстанс уже смотрит на цель — довороту некуда.
    control.apply({ bonesByName }, Math.PI / 2, Math.PI / 2, 0.016);
    const euler = new THREE.Euler().setFromQuaternion(bone.quaternion, 'ZYX');
    expect(euler.z).toBeCloseTo(0, 5);
  });

  it('кость не найдена — предупреждение один раз и пропуск, не ошибка', () => {
    const { bonesByName } = makeInstance();
    const warnings: string[] = [];
    const control = new BoneControlState({
      head: { bone: 'Bone_Head', maxYawDeg: 60, smoothing: 10 },
    });

    control.apply({ bonesByName }, 1, 0, 0.016, (message) => warnings.push(message));
    control.apply({ bonesByName }, 1, 0, 0.016, (message) => warnings.push(message));
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain('Bone_Head');
  });
});


/**
 * Доворот идёт вокруг вертикали МОДЕЛИ (REND-5), а не вокруг Z родителя кости.
 * У MDX повороты в позе покоя единичны (`build.ts`), и разницы не видно; риги
 * glTF (BLND-11) приезжают с повёрнутыми Hips/Spine, и `premultiply` вокруг Z
 * родителя разворачивал бы торс вокруг наклонённой оси.
 */
describe('ось доворота при повёрнутой позе покоя (REND-5, BLND-11)', () => {
  /** Поворот родителя в покое: 90° вокруг X — model-up уезжает в −Y родителя. */
  const REST = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2);

  interface TiltedRig {
    readonly bone: THREE.Bone;
    readonly parent: THREE.Bone;
    readonly withSkeleton: BoneLookup;
    readonly withoutSkeleton: BoneLookup;
  }

  function makeTiltedRig(): TiltedRig {
    const parent = new THREE.Bone();
    parent.name = 'b0';
    parent.quaternion.copy(REST);
    const bone = new THREE.Bone();
    bone.name = 'b1';
    parent.add(bone);
    const body = new THREE.Group();
    body.add(parent);
    // Мировые матрицы до сборки скелета — как в `createModelInstance`: иначе
    // матрицы обратной привязки посчитались бы по единичным.
    body.updateMatrixWorld(true);
    const bonesByName = new Map([['Bone_Chest', bone]]);
    return {
      bone,
      parent,
      withSkeleton: { bonesByName, skeleton: new THREE.Skeleton([parent, bone]) },
      withoutSkeleton: { bonesByName },
    };
  }

  /** Мировая ориентация кости: композиция покоя родителя и её локального поворота. */
  function worldOf(rig: TiltedRig): THREE.Quaternion {
    return new THREE.Quaternion().multiplyQuaternions(rig.parent.quaternion, rig.bone.quaternion);
  }

  /** Что обязано получиться: поза покоя, довёрнутая на `yaw` вокруг вертикали модели. */
  function expected(yaw: number): THREE.Quaternion {
    return new THREE.Quaternion()
      .setFromAxisAngle(new THREE.Vector3(0, 0, 1), yaw)
      .multiply(REST);
  }

  it('кость доворачивается вокруг вертикали модели, а не вокруг Z родителя', () => {
    const rig = makeTiltedRig();
    const control = new BoneControlState({
      torso: { bone: 'Bone_Chest', maxYawDeg: 45, smoothing: 0 },
    });

    // Цель 90°, лимит 45°: доворот ровно на лимит — вокруг model-up.
    control.apply(rig.withSkeleton, Math.PI / 2, 0, 0.016);

    expect(worldOf(rig).angleTo(expected(Math.PI / 4))).toBeCloseTo(0, 6);
  });

  it('без скелета ось берётся из накопленных поворотов предков — тот же результат', () => {
    const rig = makeTiltedRig();
    const control = new BoneControlState({
      torso: { bone: 'Bone_Chest', maxYawDeg: 45, smoothing: 0 },
    });

    control.apply(rig.withoutSkeleton, Math.PI / 2, 0, 0.016);

    expect(worldOf(rig).angleTo(expected(Math.PI / 4))).toBeCloseTo(0, 6);
  });

  it('ось считается раз на роль и переживает кадры: доворот не накапливается', () => {
    const rig = makeTiltedRig();
    const control = new BoneControlState({
      torso: { bone: 'Bone_Chest', maxYawDeg: 45, smoothing: 0 },
    });

    for (let i = 0; i < 5; i++) control.apply(rig.withSkeleton, Math.PI / 2, 0, 0.016);
    expect(worldOf(rig).angleTo(expected(Math.PI / 4))).toBeCloseTo(0, 6);

    // Цель снята — кость возвращается ровно в позу покоя, а не «около неё».
    control.apply(rig.withSkeleton, null, 0, 0.016);
    expect(worldOf(rig).angleTo(REST)).toBeCloseTo(0, 6);
  });
});
