/**
 * Построение THREE-объектов из нормализованных данных ассета — THREE-половина
 * бывшего `draft/ts-render/src/mdxModel.ts` (парсинговая половина живёт в
 * `@game-mvp/assets`).
 *
 * Разделение по REND-3: буферы геометрии и ключи анимаций — общие на ассет
 * (`SharedModelData`, кэшируется подсистемой моделей), скелет и материалы —
 * свои на инстанс (`createModelInstance`).
 */
import * as THREE from 'three';
import type {
  NormalizedBone,
  NormalizedModel,
  NormalizedSequence,
} from '@game-mvp/assets';

// --------------------------------------------------------- разделяемая часть

export interface SharedMeshData {
  readonly geometry: THREE.BufferGeometry;
  readonly partId: number;
  readonly textureSlot: number;
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
    if (mesh.normals === null || mesh.normals.length !== mesh.positions.length) {
      geometry.computeVertexNormals();
    }
    return { geometry, partId: mesh.partId, textureSlot: mesh.textureSlot };
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
          new THREE.VectorKeyframeTrack(`${bone}.position`, track.position.times, track.position.values),
        );
      }
      if (track.rotation !== undefined) {
        tracks.push(
          new THREE.QuaternionKeyframeTrack(`${bone}.quaternion`, track.rotation.times, track.rotation.values),
        );
      }
      if (track.scale !== undefined) {
        tracks.push(
          new THREE.VectorKeyframeTrack(`${bone}.scale`, track.scale.times, track.scale.values),
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

// ------------------------------------------------------------------ скелет

export interface SkeletonBuild {
  /** Кости в порядке индексов модели; имена `b<index>` — под треки клипов. */
  readonly bones: readonly THREE.Bone[];
  readonly roots: readonly THREE.Bone[];
  /** Кости по ИСХОДНОМУ имени ноды модели (`Bone_Chest`, ...) — для bone-контроля. */
  readonly byName: ReadonlyMap<string, THREE.Bone>;
}

/** THREE.Bone-иерархия из нормализованного скелета: position — локальный pivot. */
export function buildBones(bones: readonly NormalizedBone[]): SkeletonBuild {
  const built = bones.map((bone) => {
    const b = new THREE.Bone();
    b.name = `b${bone.index}`;
    b.position.set(bone.pivot[0], bone.pivot[1], bone.pivot[2]);
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

// ----------------------------------------------------------------- инстанс

export interface InstanceOptions {
  /** Множитель масштаба из манифеста поверх нормализации по высоте. */
  readonly scale?: number;
  /** Части модели, исключаемые целиком (арт-дубликаты) — из манифеста (ASSET-6). */
  readonly hiddenParts?: readonly number[];
}

/** Пер-инстансная часть модели: скелет, меши и материалы — свои, буферы — общие. */
export interface ModelInstance {
  /** Корень инстанса: сюда ставится позиция/курс сущности. */
  readonly root: THREE.Group;
  readonly mixer: THREE.AnimationMixer;
  readonly skeleton: THREE.Skeleton;
  readonly bonesByName: ReadonlyMap<string, THREE.Bone>;
  readonly meshes: readonly THREE.SkinnedMesh[];
  /** Материал на слот текстуры — единица подмены скина (REND-6). */
  readonly materialsBySlot: ReadonlyMap<number, THREE.MeshStandardMaterial>;
  /** Убирает пер-инстансные ресурсы; разделяемая геометрия остаётся в кэше (REND-3). */
  dispose(): void;
}

const BASE_MATERIAL_COLOR = 0xb8b8b0;

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
  const skeleton = new THREE.Skeleton([...bones]);

  // B. Материалы — свои на инстанс, по одному на слот текстуры (REND-6).
  const materialsBySlot = new Map<number, THREE.MeshStandardMaterial>();
  const materialFor = (slot: number): THREE.MeshStandardMaterial => {
    let material = materialsBySlot.get(slot);
    if (material === undefined) {
      material = new THREE.MeshStandardMaterial({
        color: BASE_MATERIAL_COLOR,
        roughness: 0.85,
        metalness: 0.05,
        side: THREE.DoubleSide,
      });
      materialsBySlot.set(slot, material);
    }
    return material;
  };

  // C. SkinnedMesh на каждый меш; геометрия разделяемая, биндинг — до масштаба.
  const meshes: THREE.SkinnedMesh[] = [];
  for (const meshData of shared.meshes) {
    if (hidden.has(meshData.partId)) continue; // арт-дубликат: не создаём вовсе
    const mesh = new THREE.SkinnedMesh(meshData.geometry, materialFor(meshData.textureSlot));
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
  body.scale.setScalar((options.scale ?? 1) / height);

  const root = new THREE.Group();
  root.add(body);

  const mixer = new THREE.AnimationMixer(root);

  return {
    root,
    mixer,
    skeleton,
    bonesByName: byName,
    meshes,
    materialsBySlot,
    dispose(): void {
      mixer.stopAllAction();
      mixer.uncacheRoot(root);
      for (const material of materialsBySlot.values()) {
        material.map?.dispose();
        material.dispose();
      }
    },
  };
}
