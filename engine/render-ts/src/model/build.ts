/**
 * Построение THREE-объектов из нормализованных данных ассета — THREE-половина
 * удалённого прототипа ts-render (парсинговая половина живёт в
 * `@game-mvp/assets`).
 *
 * Разделение по REND-3: буферы геометрии и ключи анимаций — общие на ассет
 * (`SharedModelData`, кэшируется подсистемой моделей), скелет и материалы —
 * свои на инстанс (`createModelInstance`).
 */
import * as THREE from 'three';
import type {
  Interpolation,
  NormalizedBone,
  NormalizedMaterial,
  NormalizedModel,
  NormalizedSequence,
} from '@game-mvp/assets';

// --------------------------------------------------------- разделяемая часть

export interface SharedMeshData {
  readonly geometry: THREE.BufferGeometry;
  readonly partId: number;
  readonly materialIndex: number;
}

/** Разделяемые данные одного ассета модели: строятся один раз, живут в кэше подсистемы. */
export interface SharedModelData {
  readonly model: NormalizedModel;
  readonly meshes: readonly SharedMeshData[];
  readonly clips: readonly THREE.AnimationClip[];
}

export function buildSharedModel(model: NormalizedModel): SharedModelData {
  const meshes: SharedMeshData[] = model.meshes.map((mesh) => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(mesh.positions, 3));
    if (mesh.normals !== null && mesh.normals.length === mesh.positions.length) {
      geometry.setAttribute('normal', new THREE.BufferAttribute(mesh.normals, 3));
    }
    if (mesh.uvs !== null) {
      geometry.setAttribute('uv', new THREE.BufferAttribute(mesh.uvs, 2));
    }
    geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(mesh.skinIndices, 4));
    geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(mesh.skinWeights, 4));
    geometry.setIndex(new THREE.BufferAttribute(mesh.indices, 1));
    // eslint-disable-next-line @typescript-eslint/prefer-optional-chain -- baseline
    if (mesh.normals === null || mesh.normals.length !== mesh.positions.length) {
      geometry.computeVertexNormals();
    }
    return { geometry, partId: mesh.partId, materialIndex: mesh.materialIndex };
  });

  return { model, meshes, clips: buildClips(model.sequences) };
}

/**
 * Клипы из секвенций: треки `b<index>.position/.quaternion/.scale` плюс
 * BooleanKeyframeTrack видимости частей модели. Имена узлов (`b0`, `part3`)
 * общие для всех инстансов — поэтому клипы разделяемы, а PropertyBinding
 * микшера резолвит их в узлах конкретного инстанса.
 *
 * ВНИМАНИЕ: имя `part<id>` здесь обязано совпадать с именем SkinnedMesh в
 * `createModelInstance` — это и есть весь «клей» между треком видимости и
 * мешом. Разъедутся — PropertyBinding молча не найдёт узел, и видимость
 * частей перестанет работать без единой ошибки.
 */
export function buildClips(sequences: readonly NormalizedSequence[]): THREE.AnimationClip[] {
  return sequences.map((sequence) => {
    const tracks: THREE.KeyframeTrack[] = [];
    for (const track of sequence.boneTracks) {
      const bone = `b${track.boneIndex}`;
      if (track.position !== undefined) {
        // Значения уже абсолютные локальные (rest + offset) — см. контракт ассетов.
        tracks.push(
          new THREE.VectorKeyframeTrack(
            `${bone}.position`,
            track.position.times,
            track.position.values,
            interpolationMode(track.position.interpolation),
          ),
        );
      }
      if (track.rotation !== undefined) {
        tracks.push(
          new THREE.QuaternionKeyframeTrack(
            `${bone}.quaternion`,
            track.rotation.times,
            track.rotation.values,
            interpolationMode(track.rotation.interpolation),
          ),
        );
      }
      if (track.scale !== undefined) {
        tracks.push(
          new THREE.VectorKeyframeTrack(
            `${bone}.scale`,
            track.scale.times,
            track.scale.values,
            interpolationMode(track.scale.interpolation),
          ),
        );
      }
    }
    for (const visibility of sequence.partVisibility) {
      // Видимость бинарная и ступенчатая: переключаем `.visible`, а не
      // opacity — без проблем с прозрачностью и записью глубины (см. прототип).
      tracks.push(
        new THREE.BooleanKeyframeTrack(
          `part${visibility.partId}.visible`,
          Array.from(visibility.times),
          Array.from(visibility.visible, (v) => v !== 0),
        ),
      );
    }
    return new THREE.AnimationClip(sequence.name, sequence.duration, tracks);
  });
}

/**
 * Режим интерполяции канала → режим трека THREE. Режим приезжает из ассета, а
 * не назначается здесь: клип, записанный ступенчато и проигранный линейно, —
 * это тихо испорченная анимация, и заметить её можно только глазами.
 */
function interpolationMode(mode: Interpolation): THREE.InterpolationModes {
  if (mode === 'step') return THREE.InterpolateDiscrete;
  if (mode === 'cubic') return THREE.InterpolateSmooth;
  return THREE.InterpolateLinear;
}

// ------------------------------------------------------------------ скелет

export interface SkeletonBuild {
  /** Кости в порядке индексов модели; имена `b<index>` — под треки клипов. */
  readonly bones: readonly THREE.Bone[];
  readonly roots: readonly THREE.Bone[];
  /** Кости по ИСХОДНОМУ имени ноды модели (`Bone_Chest`, ...) — для bone-контроля. */
  readonly byName: ReadonlyMap<string, THREE.Bone>;
}

/**
 * THREE.Bone-иерархия из нормализованного скелета. Поза покоя переносится
 * ЦЕЛИКОМ — позиция, поворот и масштаб: у MDX повороты в покое единичны, но
 * формат, где это не так, иначе приехал бы в сцену с потерянной позой.
 */
export function buildBones(bones: readonly NormalizedBone[]): SkeletonBuild {
  const built = bones.map((bone) => {
    const b = new THREE.Bone();
    b.name = `b${bone.index}`;
    b.position.set(bone.position[0], bone.position[1], bone.position[2]);
    b.quaternion.set(bone.rotation[0], bone.rotation[1], bone.rotation[2], bone.rotation[3]);
    b.scale.set(bone.scale[0], bone.scale[1], bone.scale[2]);
    return b;
  });

  const roots: THREE.Bone[] = [];
  const byName = new Map<string, THREE.Bone>();
  bones.forEach((bone, i) => {
    byName.set(bone.name, built[i]!);
    if (bone.parentIndex >= 0 && bone.parentIndex < built.length) {
      built[bone.parentIndex]!.add(built[i]!);
    } else {
      roots.push(built[i]!);
    }
  });

  return { bones: built, roots, byName };
}

// ------------------------------------------------------------------ границы

/** Осевой габаритный объём в тех осях, в которых его посчитали. */
export interface ModelBounds {
  minX: number;
  minY: number;
  minZ: number;
  maxX: number;
  maxY: number;
  maxZ: number;
}

/**
 * Границы модели в КАНОНИЧЕСКИХ осях модуля ассетов (ASSET-5) — до нормализации
 * по высоте и до масштаба записи манифеста. Считаются по позициям мешей в позе
 * покоя: видимого меша на CPU нет (скининг живёт на GPU), и bind-поза — всё, что
 * о форме модели известно этой стороне.
 *
 * Скрытые части (`hiddenParts` записи манифеста, ASSET-6) исключаются: их меши
 * инстанс не создаёт вовсе, а объём обязан быть производным от нарисованного.
 *
 * Модель без вершин даёт вырожденный объём (все нули) — и это верно: рисовать
 * там нечего, значит и попадать не во что.
 */
export function modelBounds(
  model: NormalizedModel,
  hiddenParts?: readonly number[],
): ModelBounds {
  const hidden = hiddenParts === undefined ? null : new Set(hiddenParts);
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;
  for (const mesh of model.meshes) {
    if (hidden?.has(mesh.partId) === true) continue;
    const positions = mesh.positions;
    for (let i = 0; i + 2 < positions.length; i += 3) {
      const x = positions[i]!;
      const y = positions[i + 1]!;
      const z = positions[i + 2]!;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (z < minZ) minZ = z;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
      if (z > maxZ) maxZ = z;
    }
  }
  if (minX > maxX) return { minX: 0, minY: 0, minZ: 0, maxX: 0, maxY: 0, maxZ: 0 };
  return { minX, minY, minZ, maxX, maxY, maxZ };
}

// ----------------------------------------------------------------- инстанс

export interface InstanceOptions {
  /** Множитель масштаба из манифеста поверх нормализации по высоте. */
  readonly scale?: number;
  /** Части модели, исключаемые целиком (арт-дубликаты) — из манифеста (ASSET-6). */
  readonly hiddenParts?: readonly number[];
}

/** Куда ставится текстура слота: конкретная карта конкретного материала. */
export interface TextureTarget {
  readonly material: THREE.MeshStandardMaterial;
  readonly map: 'base' | 'normal' | 'emissive';
}

/** Пер-инстансная часть модели: скелет, меши и материалы — свои, буферы — общие. */
export interface ModelInstance {
  /** Корень инстанса: сюда ставится позиция/курс сущности. */
  readonly root: THREE.Group;
  readonly mixer: THREE.AnimationMixer;
  readonly skeleton: THREE.Skeleton;
  readonly bonesByName: ReadonlyMap<string, THREE.Bone>;
  readonly meshes: readonly THREE.SkinnedMesh[];
  /** Материалы инстанса по индексу материала ассета. */
  readonly materials: readonly THREE.MeshStandardMaterial[];
  /**
   * Слот текстуры → куда его класть. Слот остаётся единицей подмены скина
   * (REND-6, ASSET-6), но теперь один слот может обслуживать несколько
   * материалов и несколько карт — поэтому не «материал на слот», а «места
   * употребления слота».
   */
  readonly textureTargets: ReadonlyMap<number, readonly TextureTarget[]>;
  /**
   * Габариты инстанса в его собственных осях — границы модели (ASSET-5),
   * умноженные на ТОТ ЖЕ множитель нормализации, каким отмасштабирован `body`.
   * Отсюда объём-прокси picking'а (REND-15) и рамка подсветки (REND-16) берут
   * размер: считать его отдельно значило бы завести второй ответ на вопрос
   * «какого размера нарисованный инстанс».
   */
  readonly bounds: ModelBounds;
  /**
   * Переставляет множитель масштаба записи манифеста (ASSET-6) у уже
   * построенного инстанса и пересчитывает `bounds` тем же множителем (REND-17).
   * Масштаб — нормализующая обёртка поверх скининга, а не часть построенного из
   * разделяемых данных: строить инстанс заново ради него незачем.
   */
  setScale(scale: number): void;
  /** Убирает пер-инстансные ресурсы; разделяемая геометрия остаётся в кэше (REND-3). */
  dispose(): void;
}

/**
 * Материал инстанса из описания материала ассета (ASSET-5). Раньше здесь стоял
 * захардкоженный серый MeshStandardMaterial: рендер решал за ассет, как модель
 * выглядит, и модель формата, который материалы описывает, приезжала бы серой.
 * Цвета из ассета линейные — рабочее пространство THREE такое же, поэтому
 * `setRGB` без указания пространства это ровно то, что нужно.
 */
function materialFromAsset(source: NormalizedMaterial): THREE.MeshStandardMaterial {
  const material = new THREE.MeshStandardMaterial({
    roughness: source.roughnessFactor,
    metalness: source.metallicFactor,
    side: source.doubleSided ? THREE.DoubleSide : THREE.FrontSide,
    transparent: source.alphaMode === 'blend',
    opacity: source.baseColorFactor[3],
    alphaTest: source.alphaMode === 'mask' ? source.alphaCutoff : 0,
  });
  material.color.setRGB(source.baseColorFactor[0], source.baseColorFactor[1], source.baseColorFactor[2]);
  material.emissive.setRGB(source.emissiveFactor[0], source.emissiveFactor[1], source.emissiveFactor[2]);
  return material;
}

/** Материал последней надежды: модель без описанных материалов всё же видна. */
const DEFAULT_MATERIAL: NormalizedMaterial = {
  baseColorFactor: [0.5, 0.5, 0.5, 1],
  baseColorTexture: null,
  metallicFactor: 0,
  roughnessFactor: 1,
  normalTexture: null,
  emissiveFactor: [0, 0, 0],
  emissiveTexture: null,
  alphaMode: 'opaque',
  alphaCutoff: 0.5,
  doubleSided: true,
};

/**
 * Скелет с матрицами обратной привязки.
 *
 * Если ассет привязку не дал (`inverseBind: null` — так у MDX, где она честно
 * выводится из позы покоя), отдаём построение самому THREE: он посчитает
 * инверсии по мировым матрицам, которые к этому моменту уже обновлены. Если дал
 * хоть одну — собираем массив целиком: у форматов вроде glTF привязка задана
 * явно и сплошь и рядом НЕ равна инверсии позы покоя, так что вывести её из
 * позы значит получить искажённый скининг.
 */
function buildSkeleton(
  source: readonly NormalizedBone[],
  bones: readonly THREE.Bone[],
): THREE.Skeleton {
  if (!source.some((bone) => bone.inverseBind !== null)) {
    return new THREE.Skeleton([...bones]);
  }
  const inverses = source.map((bone, i) =>
    bone.inverseBind !== null
      ? new THREE.Matrix4().fromArray(bone.inverseBind)
      : new THREE.Matrix4().copy(bones[i]!.matrixWorld).invert(),
  );
  return new THREE.Skeleton([...bones], inverses);
}

export function createModelInstance(
  shared: SharedModelData,
  options: InstanceOptions = {},
): ModelInstance {
  const hidden = new Set(options.hiddenParts ?? []);

  // A. Скелет — свой на инстанс.
  const { bones, roots, byName } = buildBones(shared.model.bones);
  const body = new THREE.Group();
  body.name = 'body';
  for (const root of roots) body.add(root);
  // ВАЖНО: обновить мировые матрицы костей ДО создания Skeleton — иначе
  // Skeleton.calculateInverses() посчитает inverse-bind по единичным матрицам
  // (кости ещё не в графе сцены) и скининг забайндится с искажением/схлопыванием.
  body.updateMatrixWorld(true);
  const skeleton = buildSkeleton(shared.model.bones, bones);

  // B. Материалы — свои на инстанс (REND-6: смена скина не трогает соседей),
  // по одному на материал ассета. Слоты текстур — точки подмены скина —
  // индексируются отдельно: один слот может кормить несколько материалов.
  const materials = shared.model.materials.map(materialFromAsset);
  const textureTargets = new Map<number, TextureTarget[]>();
  const useSlot = (slot: number | null, material: THREE.MeshStandardMaterial, map: TextureTarget['map']): void => {
    if (slot === null) return;
    const targets = textureTargets.get(slot) ?? [];
    targets.push({ material, map });
    textureTargets.set(slot, targets);
  };
  shared.model.materials.forEach((source, i) => {
    const material = materials[i]!;
    useSlot(source.baseColorTexture, material, 'base');
    useSlot(source.normalTexture, material, 'normal');
    useSlot(source.emissiveTexture, material, 'emissive');
  });
  // Модель без материалов (или меш со ссылкой в пустоту) не должна ронять
  // построение инстанса: заглушка по умолчанию виднее, чем исключение.
  const fallbackMaterial = materials[0] ?? materialFromAsset(DEFAULT_MATERIAL);

  // C. SkinnedMesh на каждый меш; геометрия разделяемая, биндинг — до масштаба.
  const meshes: THREE.SkinnedMesh[] = [];
  for (const meshData of shared.meshes) {
    if (hidden.has(meshData.partId)) continue; // арт-дубликат: не создаём вовсе
    const mesh = new THREE.SkinnedMesh(
      meshData.geometry,
      materials[meshData.materialIndex] ?? fallbackMaterial,
    );
    // Имя обязано совпадать с именем узла в треках видимости (buildClips).
    mesh.name = `part${meshData.partId}`;
    body.add(mesh);
    mesh.bind(skeleton);
    mesh.frustumCulled = false;
    meshes.push(mesh);
  }

  // D. Нормализация масштаба: высота модели → 1 мировая единица × scale манифеста.
  // Масштаб — на обёртке ПОСЛЕ биндинга, чтобы bind-матрицы остались в модельном
  // пространстве (порядок как в прототипе). Модель стоит на своём origin —
  // смещения по z нет (нормализованная высота считается от него).
  const height = Math.max(shared.model.height, 1e-3);
  // Габариты инстанса — те же канонические границы под тем же множителем:
  // одно число, а не два похожих (REND-15).
  const canonical = modelBounds(shared.model, options.hiddenParts);
  const bounds: ModelBounds = { minX: 0, minY: 0, minZ: 0, maxX: 0, maxY: 0, maxZ: 0 };
  // Постановка масштаба и пересчёт габаритов — одна операция, потому что второй
  // ответ на вопрос «какого размера нарисованный инстанс» разошёлся бы с первым.
  const setScale = (scale: number): void => {
    const normalized = scale / height;
    body.scale.setScalar(normalized);
    bounds.minX = canonical.minX * normalized;
    bounds.minY = canonical.minY * normalized;
    bounds.minZ = canonical.minZ * normalized;
    bounds.maxX = canonical.maxX * normalized;
    bounds.maxY = canonical.maxY * normalized;
    bounds.maxZ = canonical.maxZ * normalized;
  };
  setScale(options.scale ?? 1);

  const root = new THREE.Group();
  root.add(body);

  const mixer = new THREE.AnimationMixer(root);

  return {
    root,
    mixer,
    skeleton,
    bonesByName: byName,
    meshes,
    materials,
    textureTargets,
    bounds,
    setScale,
    dispose(): void {
      mixer.stopAllAction();
      mixer.uncacheRoot(root);
      for (const material of materials) {
        material.map?.dispose();
        material.normalMap?.dispose();
        material.emissiveMap?.dispose();
        material.dispose();
      }
    },
  };
}
