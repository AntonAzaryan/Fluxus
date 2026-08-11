/**
 * Сверка запечённой позы (`assets` ASSET-12) с позой настоящего скелета —
 * оракулом здесь работает детальный ярус: микшер и `THREE.Skeleton` считают
 * ту же позу другой реализацией, и расхождение ярусов (design, Risks) видно
 * этим сравнением, а не глазами на арене.
 *
 * Тест живёт в `render-ts`, а не в `assets-ts`, ровно поэтому: сравнивать
 * запекание с самим собой смысла нет, а THREE есть только здесь. Модуль ассетов
 * при этом остаётся рендер-агностичным — он о существовании этого теста не
 * знает (ASSET-5).
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { VAT_TEXELS_PER_BONE, bakeDerivatives, type BakedDerivatives } from '@game-mvp/assets';
import { buildSharedModel, createModelInstance } from '../src/index.js';
import { makeModel } from './fixtures.js';

const FPS = 30;
/**
 * Допуск сравнения: запекание считает в double, микшер и скелет THREE — в
 * float32. Расхождение на этом и держится, а не на разной математике.
 */
const TOLERANCE = 1e-5;

/** Матрица кости запечённого кадра — 16 чисел строки VAT. */
function bakedMatrix(baked: BakedDerivatives, frame: number, bone: number): number[] {
  const base = (frame * baked.vat.width + bone * VAT_TEXELS_PER_BONE) * 4;
  return [...baked.vat.data.subarray(base, base + 16)];
}

describe('поза VAT против позы скелета (ASSET-12 → REND-20)', () => {
  const model = makeModel();
  const shared = buildSharedModel(model);
  const result = bakeDerivatives(model, { fps: FPS });
  if (!result.ok) throw new Error(`запекание провалилось: ${result.reason}`);
  const baked = result.derivatives;

  /**
   * Матрицы скининга скелета в момент `time` клипа. Масштаб инстанса взят
   * равным высоте модели, чтобы нормализующая обёртка стала единичной: она —
   * поза инстанса, а не поза скелета, и в запечённые матрицы не входит.
   */
  function skeletonMatrices(clipName: string, time: number): Float32Array {
    const instance = createModelInstance(shared, { scale: model.height });
    const clip = shared.clips.find((candidate) => candidate.name === clipName)!;
    const action = instance.mixer.clipAction(clip);
    // Однократное воспроизведение с фиксацией конца: зацикленное действие на
    // `t = duration` уехало бы в начало клипа, и сравнивались бы разные позы.
    action.setLoop(THREE.LoopOnce, 1);
    action.clampWhenFinished = true;
    action.play();
    instance.mixer.update(time);
    instance.root.updateMatrixWorld(true);
    instance.skeleton.update();
    return boneMatricesOf(instance.skeleton);
  }

  /** Матрицы скининга скелета; их массив заводит `Skeleton` при первом обновлении. */
  function boneMatricesOf(skeleton: THREE.Skeleton): Float32Array {
    const matrices = skeleton.boneMatrices;
    if (matrices == null) throw new Error('скелет не посчитал матрицы костей');
    return matrices;
  }

  it('матрицы костей совпадают на запечённых кадрах клипа', () => {
    const clip = baked.clips.find((candidate) => candidate.name === 'Walk Fast')!;
    // Начало, середина и конец клипа: три точки, в которых сходятся и
    // сэмплирование каналов, и slerp, и обход иерархии.
    for (const frame of [0, Math.floor(clip.length / 2), clip.length - 1]) {
      const time = Math.min(frame / FPS, clip.duration);
      const oracle = skeletonMatrices('Walk Fast', time);
      for (let bone = 0; bone < baked.vat.boneCount; bone++) {
        const mine = bakedMatrix(baked, clip.offset + frame, bone);
        for (let k = 0; k < 16; k++) {
          expect(
            mine[k],
            `кадр ${frame}, кость ${bone}, элемент ${k}`,
          ).toBeCloseTo(oracle[bone * 16 + k]!, 5);
        }
      }
    }
  });

  it('поза покоя совпадает с позой инстанса до первого кадра клипа', () => {
    const instance = createModelInstance(shared, { scale: model.height });
    instance.root.updateMatrixWorld(true);
    instance.skeleton.update();
    const oracle = boneMatricesOf(instance.skeleton);
    for (let bone = 0; bone < baked.vat.boneCount; bone++) {
      const mine = bakedMatrix(baked, baked.restFrame, bone);
      for (let k = 0; k < 16; k++) expect(mine[k]).toBeCloseTo(oracle[bone * 16 + k]!, 5);
    }
  });

  it('скинутая вершина совпадает у обоих ярусов', () => {
    const clip = baked.clips.find((candidate) => candidate.name === 'Walk Fast')!;
    const frame = clip.length - 1;
    const time = Math.min(frame / FPS, clip.duration);
    const oracle = skeletonMatrices('Walk Fast', time);
    const mesh = model.meshes[0]!;

    const vertices = mesh.positions.length / 3;
    for (let vertex = 0; vertex < vertices; vertex++) {
      const mine = skinVertex(mesh, vertex, (bone) => bakedMatrix(baked, clip.offset + frame, bone));
      const theirs = skinVertex(mesh, vertex, (bone) => [
        ...oracle.subarray(bone * 16, bone * 16 + 16),
      ]);
      expect(mine.distanceTo(theirs)).toBeLessThan(TOLERANCE);
    }
  });

  /** Линейный blend skinning вершины по матрицам, которые отдаёт `matrixOf`. */
  function skinVertex(
    mesh: (typeof model.meshes)[number],
    vertex: number,
    matrixOf: (bone: number) => number[],
  ): THREE.Vector3 {
    const source = new THREE.Vector3(
      mesh.positions[vertex * 3],
      mesh.positions[vertex * 3 + 1],
      mesh.positions[vertex * 3 + 2],
    );
    const out = new THREE.Vector3();
    const term = new THREE.Vector3();
    const matrix = new THREE.Matrix4();
    for (let k = 0; k < 4; k++) {
      const weight = mesh.skinWeights[vertex * 4 + k]!;
      if (weight <= 0) continue;
      matrix.fromArray(matrixOf(mesh.skinIndices[vertex * 4 + k]!));
      term.copy(source).applyMatrix4(matrix).multiplyScalar(weight);
      out.add(term);
    }
    return out;
  }
});
