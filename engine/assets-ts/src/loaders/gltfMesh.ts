/**
 * Части модели из примитивов glTF (ASSET-5): геометрия, веса скиннинга и
 * индексы в канонических осях модуля.
 *
 * Одна ЧАСТЬ модели (`NormalizedMesh`) = один primitive: экспортёр режет меш по
 * материалам, и «только первый primitive узла» тихо терял бы геометрию всех
 * остальных материалов. Номер части — сквозной по порядку обхода узлов и
 * примитивов внутри узла; индекс в `doc.meshes` номером не годится, потому что
 * на один mesh вправе ссылаться несколько узлов — части слились бы, а
 * `hiddenParts` манифеста и треки видимости адресуют часть именно номером (как
 * геосет в MDX).
 *
 * Меш без скина (экипировка, привязанная узлом-родителем, не суставами)
 * запекается в bind-пространство узла и жёстко привязывается к «суставу» =
 * самому этому узлу (вес 1); отсутствующий `inverseBind` для такого узла рендер
 * выведет из позы покоя сам (`render-ts`, `model/build.ts`) — и это ровно
 * матрица, обратная его мировой матрице покоя, то есть корректно.
 *
 * Правила конвертации осей — в заголовке `gltf.ts`.
 */
import type { NormalizedMesh } from '../model.js';
import { readAccessor } from './gltfAccessor.js';
import type { GltfDocument, GltfPrimitive, GltfSkin } from './gltfDocument.js';
import {
  axisConvertVec3,
  mat4TransformDirection,
  mat4TransformPoint,
  type Mat4,
  type Vec3,
} from './gltfMath.js';

/** Значения одного accessor'а плоским массивом — то, что отдаёт `readAccessor`. */
type AccessorValues = ReturnType<typeof readAccessor>;

/**
 * Части модели плюс то, что о материалах знает только этот проход: примитив без
 * `material` получает материал ПО УМОЛЧАНИЮ (спецификация glTF, §3.7.2)
 * отдельной строкой в конце таблицы, а не нулевой материал документа — материал
 * 0 такой же авторский, как любой другой, и подставить его значило бы покрасить
 * деталь чужой краской.
 */
export interface NormalizedMeshes {
  readonly meshes: NormalizedMesh[];
  readonly defaultMaterialIndex: number;
  readonly usesDefaultMaterial: boolean;
}

/** Имя узла в находках — то же, каким узел приезжает в скелет модели. */
function nodeNameOf(name: string | undefined, index: number): string {
  return name ?? `node${index}`;
}

/**
 * Скин, через который разрешаются индексы JOINTS_0 примитивов узла. Это скин
 * СВОЕГО узла (`node.skin`): при нескольких скинах joints первого молча
 * перепривязали бы вершины чужого меша к посторонним узлам. Узел без
 * объявленного скина сохраняет прежний допуск — первый скин документа; битая
 * ссылка — внятная ошибка.
 */
function nodeSkinOf(doc: GltfDocument, skin: number | undefined, nodeName: string): GltfSkin | undefined {
  if (skin == null) return doc.skins?.[0];
  const found = doc.skins?.[skin];
  if (found == null) throw new Error(`glTF: skin ${skin} не существует (узел "${nodeName}")`);
  return found;
}

/** Веса и индексы суставов вершин скинутого примитива, вершины — в канон. */
function fillSkinnedVertices(
  jointNodes: readonly number[],
  joints: AccessorValues,
  weights: AccessorValues,
  pos: AccessorValues,
  norm: AccessorValues | null,
  out: { positions: Float32Array; normals: Float32Array | null; skinIndices: Uint16Array; skinWeights: Float32Array },
  vcount: number,
): void {
  const { positions, normals, skinIndices, skinWeights } = out;
  for (let v = 0; v < vcount; v++) {
    for (let k = 0; k < 4; k++) {
      const j = joints.values[v * 4 + k]!;
      skinIndices[v * 4 + k] = jointNodes[j] ?? 0;
      skinWeights[v * 4 + k] = weights.values[v * 4 + k]!;
    }
  }
  normalizeWeights(skinWeights, vcount);
  for (let v = 0; v < vcount; v++) {
    positions.set(axisConvertVec3([pos.values[v * 3]!, pos.values[v * 3 + 1]!, pos.values[v * 3 + 2]!]), v * 3);
    if (norm !== null && normals !== null) {
      normals.set(axisConvertVec3([norm.values[v * 3]!, norm.values[v * 3 + 1]!, norm.values[v * 3 + 2]!]), v * 3);
    }
  }
}

/**
 * Вершины не суставного меша: жёсткая привязка к своему узлу — они запекаются
 * в мировое (bind) пространство узла ДО перевода осей (см. заголовок `gltf.ts`).
 */
function fillRigidVertices(
  world: Mat4,
  nodeIndex: number,
  pos: AccessorValues,
  norm: AccessorValues | null,
  out: { positions: Float32Array; normals: Float32Array | null; skinIndices: Uint16Array; skinWeights: Float32Array },
  vcount: number,
): void {
  const { positions, normals, skinIndices, skinWeights } = out;
  for (let v = 0; v < vcount; v++) skinIndices[v * 4] = nodeIndex;
  for (let v = 0; v < vcount; v++) skinWeights[v * 4] = 1;
  for (let v = 0; v < vcount; v++) {
    const local: Vec3 = [pos.values[v * 3]!, pos.values[v * 3 + 1]!, pos.values[v * 3 + 2]!];
    positions.set(axisConvertVec3(mat4TransformPoint(world, local)), v * 3);
    if (norm !== null && normals !== null) {
      const nLocal: Vec3 = [norm.values[v * 3]!, norm.values[v * 3 + 1]!, norm.values[v * 3 + 2]!];
      normals.set(axisConvertVec3(mat4TransformDirection(world, nLocal)), v * 3);
    }
  }
}

/**
 * Веса скининга к сумме 1 на вершину — инвариант `NormalizedMesh.skinWeights`.
 * Спецификация glTF требует того же от экспортёра, но требование к чужому коду
 * инвариантом нашего представления не является: экспортёры выдают и слегка
 * «уплывшую» сумму (квантование в UNSIGNED_BYTE), и вершины вовсе без весов.
 * Вершина с нулевой суммой целиком отходит первому своему суставу — тем же
 * правилом, что у `mdxLoader` для вершины без групп.
 */
function normalizeWeights(weights: Float32Array, vcount: number): void {
  for (let v = 0; v < vcount; v++) {
    const base = v * 4;
    const sum = weights[base]! + weights[base + 1]! + weights[base + 2]! + weights[base + 3]!;
    if (sum === 0) {
      weights[base] = 1;
      continue;
    }
    if (sum === 1) continue;
    for (let k = 0; k < 4; k++) weights[base + k]! /= sum;
  }
}

/** Индексы примитива; без них — треугольники по порядку вершин (редкий, но валидный случай). */
function readIndices(
  doc: GltfDocument,
  buffers: readonly Uint8Array[],
  prim: GltfPrimitive,
  vcount: number,
): Uint16Array | Uint32Array {
  if (prim.indices == null) {
    const indices = vcount <= 65536 ? new Uint16Array(vcount) : new Uint32Array(vcount);
    for (let i = 0; i < vcount; i++) indices[i] = i;
    return indices;
  }
  const idx = readAccessor(doc, buffers, prim.indices, false);
  return doc.accessors[prim.indices]!.componentType === 5125
    ? Uint32Array.from(idx.values)
    : Uint16Array.from(idx.values);
}

/** Одна часть модели из одного примитива узла. */
function normalizePrimitive(
  doc: GltfDocument,
  buffers: readonly Uint8Array[],
  prim: GltfPrimitive,
  node: { readonly index: number; readonly meshName: string; readonly skin: GltfSkin | undefined; readonly world: Mat4 },
  partId: number,
  defaultMaterialIndex: number,
): NormalizedMesh {
  if (prim.mode != null && prim.mode !== 4) {
    throw new Error(`glTF: mesh "${node.meshName}" — режим ${prim.mode} (нужен TRIANGLES=4)`);
  }
  const posAcc = prim.attributes.POSITION;
  if (posAcc == null) throw new Error(`glTF: mesh "${node.meshName}" без POSITION`);
  const pos = readAccessor(doc, buffers, posAcc, false);
  const vcount = pos.count;
  const normalsAcc = prim.attributes.NORMAL;
  const norm = normalsAcc != null ? readAccessor(doc, buffers, normalsAcc, false) : null;
  const out = {
    positions: new Float32Array(vcount * 3),
    normals: norm !== null ? new Float32Array(vcount * 3) : null,
    skinIndices: new Uint16Array(vcount * 4),
    skinWeights: new Float32Array(vcount * 4),
  };

  const jointsAcc = prim.attributes.JOINTS_0;
  const weightsAcc = prim.attributes.WEIGHTS_0;
  if (jointsAcc != null && weightsAcc != null) {
    fillSkinnedVertices(
      node.skin?.joints ?? [],
      readAccessor(doc, buffers, jointsAcc, false),
      readAccessor(doc, buffers, weightsAcc, true),
      pos,
      norm,
      out,
      vcount,
    );
  } else {
    fillRigidVertices(node.world, node.index, pos, norm, out, vcount);
  }

  const uvAcc = prim.attributes.TEXCOORD_0;
  return Object.freeze({
    partId,
    positions: out.positions,
    normals: out.normals,
    uvs: uvAcc != null ? Float32Array.from(readAccessor(doc, buffers, uvAcc, false).values) : null,
    indices: readIndices(doc, buffers, prim, vcount),
    skinIndices: out.skinIndices,
    skinWeights: out.skinWeights,
    materialIndex: prim.material ?? defaultMaterialIndex,
  });
}

/** Все части модели в порядке обхода узлов и примитивов внутри узла. */
export function normalizeMeshes(
  doc: GltfDocument,
  buffers: readonly Uint8Array[],
  restWorld: readonly Mat4[],
): NormalizedMeshes {
  const defaultMaterialIndex = (doc.materials ?? []).length;
  let usesDefaultMaterial = false;
  const meshes: NormalizedMesh[] = [];
  doc.nodes.forEach((n, nodeIndex) => {
    if (n.mesh == null) return;
    const nodeName = nodeNameOf(n.name, nodeIndex);
    const mesh = doc.meshes[n.mesh];
    if (mesh == null) throw new Error(`glTF: mesh ${n.mesh} не существует (узел "${nodeName}")`);
    const meshName = mesh.name ?? `mesh${n.mesh}`;
    if (mesh.primitives.length === 0) throw new Error(`glTF: mesh "${meshName}" без примитивов`);
    const node = {
      index: nodeIndex,
      meshName,
      skin: nodeSkinOf(doc, n.skin, nodeName),
      world: restWorld[nodeIndex]!,
    };
    for (const prim of mesh.primitives) {
      if (prim.material == null) usesDefaultMaterial = true;
      meshes.push(normalizePrimitive(doc, buffers, prim, node, meshes.length, defaultMaterialIndex));
    }
  });
  return { meshes, defaultMaterialIndex, usesDefaultMaterial };
}
