/**
 * Опорная модель тестов запекания (ASSET-11): скелет из двух костей, один
 * треугольник на кость и три секвенции — ступенчатая, линейная и с треком
 * видимости части. Числа подобраны читаемыми: поворот на 90° вокруг Z за
 * секунду, сдвиг на единицу — по позе видно, что запеклось.
 */
import type { NormalizedModel, NormalizedSequence } from '../src/index.js';

/** Секвенция: поворот кости 1 вокруг Z от нуля до 90°. */
export function turnSequence(
  name: string,
  duration: number,
  interpolation: 'linear' | 'step' = 'linear',
): NormalizedSequence {
  return {
    name,
    duration,
    boneTracks: [
      {
        boneIndex: 1,
        rotation: {
          times: Float32Array.from([0, duration]),
          values: Float32Array.from([0, 0, 0, 1, 0, 0, Math.SQRT1_2, Math.SQRT1_2]),
          interpolation,
        },
      },
    ],
    partVisibility: [],
  };
}

/** Секвенция, гасящая часть 1 во второй половине. */
export function hideSequence(name: string, duration: number): NormalizedSequence {
  return {
    name,
    duration,
    boneTracks: [],
    partVisibility: [
      {
        partId: 1,
        times: Float32Array.from([0, duration / 2]),
        visible: Uint8Array.from([1, 0]),
      },
    ],
  };
}

export function makeModel(sequences: readonly NormalizedSequence[] = []): NormalizedModel {
  return {
    bones: [
      {
        index: 0,
        name: 'Bone_Root',
        parentIndex: -1,
        position: [0, 0, 0],
        rotation: [0, 0, 0, 1],
        scale: [1, 1, 1],
        inverseBind: null,
      },
      {
        index: 1,
        name: 'Bone_Chest',
        parentIndex: 0,
        position: [2, 0, 0],
        rotation: [0, 0, 0, 1],
        scale: [1, 1, 1],
        inverseBind: null,
      },
    ],
    meshes: [
      mesh(0, 0, [0, 0, 0, 1, 0, 0, 0, 1, 0]),
      mesh(1, 1, [2, 0, 0, 3, 0, 0, 2, 1, 0]),
    ],
    sequences,
    materials: [],
    textureSlots: [],
    height: 1,
  };
}

/** Меш-треугольник, целиком привязанный к одной кости. */
function mesh(partId: number, bone: number, positions: readonly number[]): NormalizedModel['meshes'][number] {
  const vertices = positions.length / 3;
  const skinIndices = new Uint16Array(vertices * 4);
  const skinWeights = new Float32Array(vertices * 4);
  for (let v = 0; v < vertices; v++) {
    skinIndices[v * 4] = bone;
    skinWeights[v * 4] = 1;
  }
  return {
    partId,
    positions: Float32Array.from(positions),
    normals: null,
    uvs: null,
    indices: Uint16Array.from([0, 1, 2]),
    skinIndices,
    skinWeights,
    materialIndex: 0,
  };
}
