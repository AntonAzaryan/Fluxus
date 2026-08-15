/**
 * Общий хвост загрузчиков моделей: высота bbox и сборка нормализованной модели.
 *
 * Форматы разные (glTF — модельный, ASSET-3, ASSET-5; MDX — исторический реестр,
 * BLND-11), а конец разбора у них один — представление нормировано одно
 * (ASSET-5), и собирается оно здесь, чтобы «что заморожено» и «как считается
 * высота» имели по одному ответу на модуль ассетов.
 */
import type {
  NormalizedBone,
  NormalizedMaterial,
  NormalizedMesh,
  NormalizedModel,
  NormalizedSequence,
  TextureSlotRef,
} from '../model.js';

/** Нижняя граница высоты: плоская модель не должна давать нулевой масштаб. */
const MIN_HEIGHT = 1e-3;

/**
 * Высота bbox по Z (канонической вертикали) — для нормализации масштаба
 * инстанса рендером. Вход — массивы позиций как они лежат в формате: тройки
 * `x, y, z` подряд (геосет MDX, primitive glTF).
 */
export function heightOfPositions(chunks: readonly ArrayLike<number>[]): number {
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const positions of chunks) {
    for (let k = 2; k < positions.length; k += 3) {
      const z = positions[k]!;
      if (z < minZ) minZ = z;
      if (z > maxZ) maxZ = z;
    }
  }
  return Math.max(maxZ - minZ, MIN_HEIGHT);
}

/** Части нормализованной модели, собранные загрузчиком формата. */
export interface NormalizedModelParts {
  readonly bones: readonly NormalizedBone[];
  readonly meshes: readonly NormalizedMesh[];
  readonly sequences: readonly NormalizedSequence[];
  readonly materials: readonly NormalizedMaterial[];
  readonly textureSlots: readonly TextureSlotRef[];
  readonly height: number;
}

/**
 * Ассет разделяется всеми инстансами (ASSET-5): корень и все контейнеры
 * замораживаем, чтобы случайная запись в поле модели падала, а не тихо портила
 * данные соседям. Содержимое TypedArray заморозить невозможно — см. оговорку в
 * model.ts.
 */
export function freezeNormalizedModel(parts: NormalizedModelParts): NormalizedModel {
  return Object.freeze({
    bones: Object.freeze(parts.bones),
    meshes: Object.freeze(parts.meshes),
    sequences: Object.freeze(parts.sequences),
    materials: Object.freeze(parts.materials),
    textureSlots: Object.freeze(parts.textureSlots),
    height: parts.height,
  });
}
