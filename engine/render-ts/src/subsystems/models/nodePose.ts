/**
 * Мировая поза НАЗВАННОГО УЗЛА инстанса (REND-20, REND-24) — одинаково у обоих
 * ярусов.
 *
 * Сокет эмиттера (ASSET-14), крепление реквизита, метка попадания — всё это
 * вопрос «где сейчас кость по имени», и ответ на него не вправе зависеть от
 * того, чем инстанс нарисован: REND-20 требует совпадения ЯРУСОВ по
 * наблюдаемому, а сокет наблюдаем прямо в кадре. У детального яруса ответ
 * лежит в скелете; у батчевого скелета нет вовсе — там поза кости берётся
 * ВЫБОРКОЙ ИЗ VAT на CPU: строки текстуры уже в памяти (ASSET-12), и читаются
 * ровно те две, между которыми смешивает шейдер, с тем же весом.
 *
 * Стоимость этого — выборка на ЗАПРОС, а не на инстанс кадра: спрашивает её
 * потребитель сокетов по своим эмиттерам, и пока он не спросил, батчевый ярус
 * не платит ничего.
 */
import * as THREE from 'three';
import type { BoneVat } from '@fluxus/assets';
import type { InstanceRecord, SharedEntry } from './instanceRecord.js';

/**
 * Поза узла в мировых осях — переиспользуемая запись потребителя, как у
 * носителей света (REND-33): вызов на эмиттер каждый кадр своего объекта иметь
 * не должен.
 */
export interface NodePose {
  x: number;
  y: number;
  z: number;
  qx: number;
  qy: number;
  qz: number;
  qw: number;
}

/** Хозяйство выборки — переиспользуемое: у запроса своих матриц быть не должно. */
const SKIN_A = new THREE.Matrix4();
const SKIN_B = new THREE.Matrix4();
const NODE_MATRIX = new THREE.Matrix4();
const INSTANCE_MATRIX = new THREE.Matrix4();
const SCRATCH_POSITION = new THREE.Vector3();
const SCRATCH_QUAT = new THREE.Quaternion();
const SCRATCH_SCALE = new THREE.Vector3();

/**
 * Поза узла инстанса; `false` — узла у него нет (другое имя, модель ещё едет,
 * вид рисуют частицы). Ответ ОДИН на оба яруса: различается только источник —
 * скелет детального поддерева либо строки VAT батчевой записи.
 */
export function nodePoseOf(
  record: InstanceRecord,
  node: string,
  entry: SharedEntry | undefined,
  out: NodePose,
): boolean {
  const model = record.model;
  if (model !== null) return detailedNodePose(model, node, out);
  return batchedNodePose(record, node, entry, out);
}

/** Детальный ярус: узел живёт в поддереве инстанса, и его матрица уже мировая. */
function detailedNodePose(
  model: { readonly root: THREE.Object3D; readonly bonesByName: ReadonlyMap<string, THREE.Bone> },
  node: string,
  out: NodePose,
): boolean {
  // Сперва ИСХОДНОЕ имя ноды модели (`Bone_Chest`), потом любое имя узла
  // поддерева: сокеты авторских ригов приходят первыми, а мешам и обёрткам
  // имена ставит сборка инстанса.
  const found = model.bonesByName.get(node) ?? model.root.getObjectByName(node) ?? null;
  if (found === null) return false;
  // Матрицы предков сводятся явно: кадр подсистемы идёт ДО отрисовки, и мировая
  // матрица узла иначе отставала бы на кадр.
  found.updateWorldMatrix(true, false);
  found.matrixWorld.decompose(SCRATCH_POSITION, SCRATCH_QUAT, SCRATCH_SCALE);
  writePose(out);
  return true;
}

/**
 * Батчевый ярус: скелета нет, и поза кости собирается из VAT (ASSET-12) —
 * `skin = world · inverseBind` в двух строках кадра, смешанных тем же весом,
 * что и в шейдере (`vatMaterial`, покомпонентно). Обратно к мировой матрице
 * узла её возвращает поза ПРИВЯЗКИ: `world = skin · bind`.
 */
function batchedNodePose(
  record: InstanceRecord,
  node: string,
  entry: SharedEntry | undefined,
  out: NodePose,
): boolean {
  const batch = record.batch;
  const vat = record.vat;
  if (batch === null || vat === null || entry === undefined) return false;
  const derivatives = entry.derivatives;
  if (derivatives === null || entry.data === null) return false;
  const bone = boneIndexOf(entry, node);
  if (bone < 0) return false;

  readVatMatrix(derivatives.vat, vat.rowA, bone, SKIN_A);
  readVatMatrix(derivatives.vat, vat.rowB, bone, SKIN_B);
  blendInto(SKIN_A, SKIN_B, vat.blend, NODE_MATRIX);
  NODE_MATRIX.multiply(bindMatrixOf(entry, bone));

  // Модельные оси → мировые: та же инстанс-матрица, которой батч рисует запись
  // (`carrier/batched.ts`), с той же нормализацией по высоте.
  SCRATCH_SCALE.setScalar(record.scale * batch.normalized);
  INSTANCE_MATRIX.compose(record.pos, record.quat, SCRATCH_SCALE);
  NODE_MATRIX.premultiply(INSTANCE_MATRIX);
  NODE_MATRIX.decompose(SCRATCH_POSITION, SCRATCH_QUAT, SCRATCH_SCALE);
  writePose(out);
  return true;
}

function writePose(out: NodePose): void {
  out.x = SCRATCH_POSITION.x;
  out.y = SCRATCH_POSITION.y;
  out.z = SCRATCH_POSITION.z;
  out.qx = SCRATCH_QUAT.x;
  out.qy = SCRATCH_QUAT.y;
  out.qz = SCRATCH_QUAT.z;
  out.qw = SCRATCH_QUAT.w;
}

/**
 * Матрица кости в строке VAT: четыре текселя подряд — четыре СТОЛБЦА матрицы,
 * то есть ровно тот порядок, в котором их читает `Matrix4.fromArray`.
 */
function readVatMatrix(vat: BoneVat, row: number, bone: number, out: THREE.Matrix4): void {
  out.fromArray(vat.data, (row * vat.width + bone * 4) * 4);
}

/** Смешивание двух поз — покомпонентное, как в шейдере: `a + (b − a) · w`. */
function blendInto(a: THREE.Matrix4, b: THREE.Matrix4, weight: number, out: THREE.Matrix4): void {
  const from = a.elements;
  const to = b.elements;
  const target = out.elements;
  for (let k = 0; k < 16; k++) target[k] = from[k]! + (to[k]! - from[k]!) * weight;
}

/**
 * Индекс кости по ИСХОДНОМУ имени ноды — раз на ассет: имена приходят из
 * записи манифеста (ASSET-14), а перебор костей на каждый запрос был бы работой
 * по числу костей на каждый эмиттер каждого кадра.
 */
function boneIndexOf(entry: SharedEntry, node: string): number {
  let index = entry.boneIndex;
  if (index === null) {
    index = new Map<string, number>();
    entry.data?.model.bones.forEach((bone) => index!.set(bone.name, bone.index));
    entry.boneIndex = index;
  }
  return index.get(node) ?? -1;
}

/**
 * Матрица позы ПРИВЯЗКИ кости в модельных осях — раз на ассет. Формат, задавший
 * привязку явно (glTF `inverseBindMatrices`), обращается; формат без неё (MDX)
 * привязан позой покоя, и она собирается по иерархии.
 */
function bindMatrixOf(entry: SharedEntry, bone: number): THREE.Matrix4 {
  let binds = entry.boneBinds;
  if (binds === null) {
    binds = buildBindMatrices(entry);
    entry.boneBinds = binds;
  }
  return binds[bone] ?? IDENTITY;
}

const IDENTITY = new THREE.Matrix4();

function buildBindMatrices(entry: SharedEntry): THREE.Matrix4[] {
  const bones = entry.data?.model.bones ?? [];
  const world: THREE.Matrix4[] = [];
  const local = new THREE.Matrix4();
  const position = new THREE.Vector3();
  const rotation = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  bones.forEach((bone, i) => {
    if (bone.inverseBind !== null) {
      world[i] = new THREE.Matrix4().fromArray(bone.inverseBind).invert();
      return;
    }
    position.set(bone.position[0], bone.position[1], bone.position[2]);
    rotation.set(bone.rotation[0], bone.rotation[1], bone.rotation[2], bone.rotation[3]);
    scale.set(bone.scale[0], bone.scale[1], bone.scale[2]);
    local.compose(position, rotation, scale);
    const parent = bone.parentIndex >= 0 ? world[bone.parentIndex] : undefined;
    world[i] = parent === undefined
      ? new THREE.Matrix4().copy(local)
      : new THREE.Matrix4().multiplyMatrices(parent, local);
  });
  return world;
}
