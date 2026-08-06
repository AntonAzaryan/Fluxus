/**
 * Загрузчик glTF 2.0 поверх ручного разбора JSON — без THREE.js и DOM
 * (ASSET-5), в духе `mdxLoader`. Формат многофайловый: `.gltf` (JSON) плюс
 * внешний `.bin` (геометрия/скелет/анимации) и внешние `.png`-текстуры,
 * читаемые через `ctx.read` относительно ID модели (ASSET-3). `.glb`
 * (двоичный контейнер с зашитыми буфером/текстурами) НЕ поддерживается —
 * встроенные текстуры некуда деть без второго механизма подмены (текстуры
 * остаются путём в `textureSlots`, а не пикселями, ASSET-5); контент готовится
 * распаковкой `.glb` в `.gltf`+`.bin`+PNG один раз при добавлении ассета.
 *
 * ПОДДЕРЖАННОЕ ПОДМНОЖЕСТВО (осознанно уже, чем весь glTF 2.0):
 * - Один буфер, внешний (`buffers[0].uri`); встроенные data-URI и sparse-
 *   accessor'ы не разбираются — внятная ошибка вместо молчаливой потери данных.
 * - Примитивы TRIANGLES (mode по умолчанию), один primitive на mesh.
 * - Интерполяция каналов LINEAR и STEP переносятся как есть; CUBICSPLINE
 *   упрощается до LINEAR по значению ключа (без внутренней/внешней
 *   касательной) — как и `mdxLoader` для Hermite/Bezier, это фиксация
 *   поведения, а не потеря: играна она и так была бы линейно.
 *
 * КОНВЕРТАЦИЯ ОСЕЙ (module.ts: канон — правая тройка, Z вверх): glTF — правая
 * тройка, Y вверх. Свойство ЛОКАЛЬНЫХ трансформаций твёрдой иерархии узлов:
 * поворот всей сцены на фиксированную Mc не меняет ЛОКАЛЬНЫЕ TRS дочерних
 * узлов относительно родителя (мировые матрицы у обоих отличаются на Mc
 * слева на каждом уровне, а при вычислении Local = World(parent)^-1 · World
 * этот множитель схлопывается). Меняются только: (1) TRS настоящих корневых
 * узлов (без родителя) — им Mc применяется явно; (2) сырые вершинные данные
 * (position/normal) — они не часть цепочки локальных трансформаций, а точки
 * в bind-пространстве, и Mc к ним применяется напрямую; (3) inverseBind —
 * матрица, отображающая bind-пространство в пространство сустава, домножается
 * на Mc⁻¹ справа, чтобы компенсировать переход bind-пространства. Доказательство
 * (World_new(n) = Mc · World_orig(n) индукцией по глубине, отсюда и все три
 * правила) — в design-заметках приложения; здесь только код.
 */
import type {
  AssetLoader,
  LoaderContext,
} from '../types.js';
import type {
  BoneTrack,
  ChannelKeys,
  Interpolation,
  NormalizedBone,
  NormalizedMaterial,
  NormalizedMesh,
  NormalizedModel,
  NormalizedSequence,
  TextureSlotRef,
} from '../model.js';
import { resolveDependencyPath } from '../service.js';

// ============================================================== glTF JSON

interface GltfAccessor {
  readonly bufferView?: number;
  readonly byteOffset?: number;
  readonly componentType: number;
  readonly normalized?: boolean;
  readonly count: number;
  readonly type: string;
  readonly sparse?: unknown;
}
interface GltfBufferView {
  readonly buffer: number;
  readonly byteOffset?: number;
  readonly byteLength: number;
  readonly byteStride?: number;
}
interface GltfNode {
  readonly name?: string;
  readonly children?: readonly number[];
  readonly mesh?: number;
  readonly skin?: number;
  readonly translation?: readonly [number, number, number];
  readonly rotation?: readonly [number, number, number, number];
  readonly scale?: readonly [number, number, number];
}
interface GltfPrimitive {
  readonly attributes: Record<string, number>;
  readonly indices?: number;
  readonly material?: number;
  readonly mode?: number;
}
interface GltfMesh {
  readonly name?: string;
  readonly primitives: readonly GltfPrimitive[];
}
interface GltfSkin {
  readonly joints: readonly number[];
  readonly inverseBindMatrices?: number;
}
interface GltfTextureRef {
  readonly index: number;
}
interface GltfMaterial {
  readonly name?: string;
  readonly pbrMetallicRoughness?: {
    readonly baseColorFactor?: readonly [number, number, number, number];
    readonly baseColorTexture?: GltfTextureRef;
    readonly metallicFactor?: number;
    readonly roughnessFactor?: number;
  };
  readonly normalTexture?: GltfTextureRef;
  readonly emissiveFactor?: readonly [number, number, number];
  readonly emissiveTexture?: GltfTextureRef;
  readonly alphaMode?: 'OPAQUE' | 'MASK' | 'BLEND';
  readonly alphaCutoff?: number;
  readonly doubleSided?: boolean;
}
interface GltfAnimationChannel {
  readonly sampler: number;
  readonly target: { readonly node?: number; readonly path: string };
}
interface GltfAnimationSampler {
  readonly input: number;
  readonly output: number;
  readonly interpolation?: 'LINEAR' | 'STEP' | 'CUBICSPLINE';
}
interface GltfAnimation {
  readonly name?: string;
  readonly channels: readonly GltfAnimationChannel[];
  readonly samplers: readonly GltfAnimationSampler[];
}
interface GltfDocument {
  readonly asset: { readonly version: string };
  readonly buffers: readonly { readonly uri?: string; readonly byteLength: number }[];
  readonly bufferViews: readonly GltfBufferView[];
  readonly accessors: readonly GltfAccessor[];
  readonly nodes: readonly GltfNode[];
  readonly meshes: readonly GltfMesh[];
  readonly skins?: readonly GltfSkin[];
  readonly materials?: readonly GltfMaterial[];
  readonly textures?: readonly { readonly source: number }[];
  readonly images?: readonly { readonly uri?: string }[];
  readonly animations?: readonly GltfAnimation[];
}

// ==================================================================== math
//
// Минимальная 4x4/кватернионная арифметика для конвертации осей и запекания
// трансформа неприкреплённых-к-скину узлов (экипировка) в bind-пространство —
// намеренно свои, а не THREE (ASSET-5: рендер-агностичный модуль).

type Vec3 = readonly [number, number, number];
type Quat = readonly [number, number, number, number];
/** Column-major 4x4, как `NormalizedBone.inverseBind`. */
type Mat4 = Float32Array;

/** Mc: поворот +90° вокруг X, глTF Y-вверх → канон Z-вверх: (x,y,z) → (x,-z,y). */
function axisConvertVec3(v: Vec3): [number, number, number] {
  return [v[0], -v[2], v[1]];
}

/** Кватернион Mc: поворот +90° вокруг X. */
const MC_QUAT: Quat = [Math.SQRT1_2, 0, 0, Math.SQRT1_2];

/** Хэмилтоново произведение: `a ⊗ b` — сперва `b`, затем `a`. */
function quatMultiply(a: Quat, b: Quat): [number, number, number, number] {
  const [ax, ay, az, aw] = a;
  const [bx, by, bz, bw] = b;
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}

/** `Mc⁻¹` 4x4 (column-major): обратный поворот, (x,y,z) → (x,z,-y). */
// prettier-ignore
const MC_INVERSE: Mat4 = Float32Array.from([
  1, 0, 0, 0,
  0, 0, -1, 0,
  0, 1, 0, 0,
  0, 0, 0, 1,
]);

/** `a · b` (column-major, «сперва b, затем a»). */
function mat4Multiply(a: Mat4, b: Mat4): Mat4 {
  const out = new Float32Array(16);
  for (let col = 0; col < 4; col++) {
    for (let row = 0; row < 4; row++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += a[k * 4 + row]! * b[col * 4 + k]!;
      out[col * 4 + row] = sum;
    }
  }
  return out;
}

/** TRS → 4x4 (column-major), стандартная композиция T · R · S. */
function mat4Compose(t: Vec3, q: Quat, s: Vec3): Mat4 {
  const [x, y, z, w] = q;
  const x2 = x + x;
  const y2 = y + y;
  const z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2;
  const yy = y * y2, yz = y * z2, zz = z * z2;
  const wx = w * x2, wy = w * y2, wz = w * z2;
  const [sx, sy, sz] = s;
  // prettier-ignore
  return Float32Array.from([
    (1 - (yy + zz)) * sx, (xy + wz) * sx, (xz - wy) * sx, 0,
    (xy - wz) * sy, (1 - (xx + zz)) * sy, (yz + wx) * sy, 0,
    (xz + wy) * sz, (yz - wx) * sz, (1 - (xx + yy)) * sz, 0,
    t[0], t[1], t[2], 1,
  ]);
}

/** Точка через 4x4 (со смещением). */
function mat4TransformPoint(m: Mat4, p: Vec3): [number, number, number] {
  const [x, y, z] = p;
  return [
    m[0]! * x + m[4]! * y + m[8]! * z + m[12]!,
    m[1]! * x + m[5]! * y + m[9]! * z + m[13]!,
    m[2]! * x + m[6]! * y + m[10]! * z + m[14]!,
  ];
}

/** Направление через линейную часть 4x4 (без смещения, без учёта неравномерного масштаба). */
function mat4TransformDirection(m: Mat4, v: Vec3): [number, number, number] {
  const [x, y, z] = v;
  return [
    m[0]! * x + m[4]! * y + m[8]! * z,
    m[1]! * x + m[5]! * y + m[9]! * z,
    m[2]! * x + m[6]! * y + m[10]! * z,
  ];
}

// ============================================================= accessors

const COMPONENT_SIZE: Readonly<Record<number, number>> = {
  5120: 1, // BYTE
  5121: 1, // UNSIGNED_BYTE
  5122: 2, // SHORT
  5123: 2, // UNSIGNED_SHORT
  5125: 4, // UNSIGNED_INT
  5126: 4, // FLOAT
};
const TYPE_COMPONENTS: Readonly<Record<string, number>> = {
  SCALAR: 1,
  VEC2: 2,
  VEC3: 3,
  VEC4: 4,
  MAT4: 16,
};

/** Один читатель компоненты accessor'а по смещению в байтах от начала буфера. */
function componentReader(view: DataView, componentType: number): (byteOffset: number) => number {
  switch (componentType) {
    case 5120:
      return (o) => view.getInt8(o);
    case 5121:
      return (o) => view.getUint8(o);
    case 5122:
      return (o) => view.getInt16(o, true);
    case 5123:
      return (o) => view.getUint16(o, true);
    case 5125:
      return (o) => view.getUint32(o, true);
    case 5126:
      return (o) => view.getFloat32(o, true);
    default:
      throw new Error(`glTF: неизвестный componentType ${componentType}`);
  }
}

/**
 * Разбор accessor'а в плоский массив «числа как есть» (`count * itemSize`).
 * Нормализованные целые (ASSET-5: явно из формата) приводятся к [0..1]/[-1..1]
 * по правилу спецификации; JOINTS_0 читается тем же путём, но БЕЗ нормализации
 * (индексы, не веса) — вызывающий код это учитывает отдельно.
 */
function readAccessor(
  doc: GltfDocument,
  buffers: readonly Uint8Array[],
  accessorIndex: number,
  normalize: boolean,
): { readonly values: Float64Array; readonly count: number; readonly itemSize: number } {
  const acc = doc.accessors[accessorIndex];
  if (acc == null) throw new Error(`glTF: accessor ${accessorIndex} не существует`);
  if (acc.sparse != null) throw new Error(`glTF: sparse-accessor (${accessorIndex}) не поддержан`);
  const itemSize = TYPE_COMPONENTS[acc.type];
  if (itemSize == null) throw new Error(`glTF: неизвестный тип accessor'а "${acc.type}"`);
  const compSize = COMPONENT_SIZE[acc.componentType];
  if (compSize == null) throw new Error(`glTF: неизвестный componentType ${acc.componentType}`);

  const out = new Float64Array(acc.count * itemSize);
  if (acc.bufferView == null) return { values: out, count: acc.count, itemSize }; // все нули — валидно для glTF

  const bv = doc.bufferViews[acc.bufferView];
  if (bv == null) throw new Error(`glTF: bufferView ${acc.bufferView} не существует`);
  const buffer = buffers[bv.buffer];
  if (buffer == null) throw new Error(`glTF: buffer ${bv.buffer} не загружен`);

  const base = (bv.byteOffset ?? 0) + (acc.byteOffset ?? 0);
  const stride = bv.byteStride ?? compSize * itemSize;
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const read = componentReader(view, acc.componentType);

  for (let i = 0; i < acc.count; i++) {
    const itemOffset = base + i * stride;
    for (let c = 0; c < itemSize; c++) {
      const raw = read(itemOffset + c * compSize);
      out[i * itemSize + c] = normalize ? normalizedComponent(raw, acc.componentType) : raw;
    }
  }
  return { values: out, count: acc.count, itemSize };
}

/** Целое → [0..1]/[-1..1] по правилу normalized-accessor'ов спецификации glTF. */
function normalizedComponent(raw: number, componentType: number): number {
  switch (componentType) {
    case 5121: // UNSIGNED_BYTE
      return raw / 255;
    case 5123: // UNSIGNED_SHORT
      return raw / 65535;
    case 5120: // BYTE
      return Math.max(raw / 127, -1);
    case 5122: // SHORT
      return Math.max(raw / 32767, -1);
    default: // 5126 FLOAT — уже нормировано форматом
      return raw;
  }
}

// ============================================================= normalize

const LINE_TYPE: Readonly<Record<string, Interpolation>> = {
  LINEAR: 'linear',
  STEP: 'step',
  CUBICSPLINE: 'linear', // упрощение: берём только значение ключа, без касательных (см. заголовок файла)
};

/** Индекс родителя каждого узла из `children[]` (glTF не хранит обратную ссылку). */
function buildParentIndex(nodes: readonly GltfNode[]): Int32Array {
  const parent = new Int32Array(nodes.length).fill(-1);
  nodes.forEach((n, i) => {
    for (const child of n.children ?? []) parent[child] = i;
  });
  return parent;
}

/** Мировые матрицы покоя всех узлов в СЫРОМ (Y-вверх) пространстве — для запекания экипировки. */
function buildRestWorldMatrices(nodes: readonly GltfNode[], parent: Int32Array): Mat4[] {
  const local = nodes.map((n) =>
    mat4Compose(n.translation ?? [0, 0, 0], n.rotation ?? [0, 0, 0, 1], n.scale ?? [1, 1, 1]),
  );
  const world = new Array<Mat4 | undefined>(nodes.length);
  // Родитель всегда имеет меньший индекс, чем ребёнок, в порядке glTF? Гарантии
  // нет — обходим по возрастанию и на лету пере-вычисляем, если родитель ещё не готов.
  const resolve = (i: number): Mat4 => {
    if (world[i] !== undefined) return world[i];
    const p = parent[i]!;
    const m = p === -1 ? local[i]! : mat4Multiply(resolve(p), local[i]!);
    world[i] = m;
    return m;
  };
  return nodes.map((_n, i) => resolve(i));
}

export function normalizeGltf(
  doc: GltfDocument,
  buffers: readonly Uint8Array[],
  assetId: string,
): NormalizedModel {
  if (!doc.asset.version.startsWith('2.')) {
    throw new Error(`glTF: неподдержанная версия "${doc.asset.version}" (нужна 2.x)`);
  }
  const nodes = doc.nodes;
  const parentOf = buildParentIndex(nodes);
  const restWorld = buildRestWorldMatrices(nodes, parentOf);
  const skin = doc.skins?.[0];

  // ============================================================ A. Скелет
  const inverseBindByNode = new Map<number, Mat4>();
  if (skin?.inverseBindMatrices != null) {
    const ibm = readAccessor(doc, buffers, skin.inverseBindMatrices, false);
    skin.joints.forEach((nodeIndex, j) => {
      const raw = Float32Array.from(ibm.values.subarray(j * 16, j * 16 + 16));
      inverseBindByNode.set(nodeIndex, mat4Multiply(raw, MC_INVERSE));
    });
  }

  const bones: NormalizedBone[] = nodes.map((n, i) => {
    const isRoot = parentOf[i] === -1;
    const rawT = n.translation ?? [0, 0, 0];
    const rawR = n.rotation ?? [0, 0, 0, 1];
    const rawS = n.scale ?? [1, 1, 1];
    const position = isRoot ? axisConvertVec3(rawT) : [...rawT];
    const rotation = isRoot ? quatMultiply(MC_QUAT, rawR) : [...rawR];
    return Object.freeze({
      index: i,
      name: n.name ?? `node${i}`,
      parentIndex: parentOf[i]!,
      position: Object.freeze(position as [number, number, number]),
      rotation: Object.freeze(rotation as [number, number, number, number]),
      scale: Object.freeze([...rawS] as [number, number, number]),
      inverseBind: inverseBindByNode.get(i) ?? null,
    });
  });

  // ============================================================= B. Меши
  //
  // Меш без скина (экипировка, привязанная узлом-родителем, не суставами) —
  // запекается в bind-пространство узла и жёстко привязывается к «суставу»
  // = самому этому узлу (вес 1); отсутствующий `inverseBind` для такого узла
  // рендер выведет из позы покоя сам (build.ts: `buildSkeleton`) — и это
  // ровно матрица, обратная его мировой матрице покоя, то есть корректно.
  const meshes: NormalizedMesh[] = [];
  nodes.forEach((n, nodeIndex) => {
    if (n.mesh == null) return;
    const mesh = doc.meshes[n.mesh];
    if (mesh == null) throw new Error(`glTF: mesh ${n.mesh} не существует (узел "${n.name}")`);
    const prim = mesh.primitives[0];
    if (prim == null) throw new Error(`glTF: mesh "${mesh.name}" без примитивов`);
    if (prim.mode != null && prim.mode !== 4) {
      throw new Error(`glTF: mesh "${mesh.name}" — режим ${prim.mode} (нужен TRIANGLES=4)`);
    }

    const posAcc = prim.attributes['POSITION'];
    if (posAcc == null) throw new Error(`glTF: mesh "${mesh.name}" без POSITION`);
    const pos = readAccessor(doc, buffers, posAcc, false);
    const vcount = pos.count;
    const positions = new Float32Array(vcount * 3);
    const normalsAcc = prim.attributes['NORMAL'];
    const norm = normalsAcc != null ? readAccessor(doc, buffers, normalsAcc, false) : null;
    const normals = norm != null ? new Float32Array(vcount * 3) : null;

    const skinned = prim.attributes['JOINTS_0'] != null && prim.attributes['WEIGHTS_0'] != null;
    const skinIndices = new Uint16Array(vcount * 4);
    const skinWeights = new Float32Array(vcount * 4);

    if (skinned) {
      const joints = readAccessor(doc, buffers, prim.attributes['JOINTS_0']!, false);
      const weights = readAccessor(doc, buffers, prim.attributes['WEIGHTS_0']!, true);
      const jointNodes = skin?.joints ?? [];
      for (let v = 0; v < vcount; v++) {
        for (let k = 0; k < 4; k++) {
          const j = joints.values[v * 4 + k]!;
          skinIndices[v * 4 + k] = jointNodes[j] ?? 0;
          skinWeights[v * 4 + k] = weights.values[v * 4 + k]!;
        }
      }
      for (let v = 0; v < vcount; v++) {
        positions.set(axisConvertVec3([pos.values[v * 3]!, pos.values[v * 3 + 1]!, pos.values[v * 3 + 2]!]), v * 3);
        if (norm != null && normals != null) {
          normals.set(axisConvertVec3([norm.values[v * 3]!, norm.values[v * 3 + 1]!, norm.values[v * 3 + 2]!]), v * 3);
        }
      }
    } else {
      // Не суставной меш: жёсткая привязка к своему узлу — вершины запекаются
      // в мировое (bind) пространство узла ДО перевода осей (см. заголовок).
      const world = restWorld[nodeIndex]!;
      for (let v = 0; v < vcount; v++) skinIndices[v * 4] = nodeIndex;
      for (let v = 0; v < vcount; v++) skinWeights[v * 4] = 1;
      for (let v = 0; v < vcount; v++) {
        const local: Vec3 = [pos.values[v * 3]!, pos.values[v * 3 + 1]!, pos.values[v * 3 + 2]!];
        positions.set(axisConvertVec3(mat4TransformPoint(world, local)), v * 3);
        if (norm != null && normals != null) {
          const nLocal: Vec3 = [norm.values[v * 3]!, norm.values[v * 3 + 1]!, norm.values[v * 3 + 2]!];
          normals.set(axisConvertVec3(mat4TransformDirection(world, nLocal)), v * 3);
        }
      }
    }

    const uvAcc = prim.attributes['TEXCOORD_0'];
    const uvs =
      uvAcc != null
        ? Float32Array.from(readAccessor(doc, buffers, uvAcc, false).values)
        : null;

    let indices: Uint16Array | Uint32Array;
    if (prim.indices != null) {
      const idx = readAccessor(doc, buffers, prim.indices, false);
      indices =
        doc.accessors[prim.indices]!.componentType === 5125
          ? Uint32Array.from(idx.values)
          : Uint16Array.from(idx.values);
    } else {
      // Без индексов — треугольники по порядку вершин (редкий, но валидный случай).
      indices = vcount <= 65536 ? new Uint16Array(vcount) : new Uint32Array(vcount);
      for (let i = 0; i < vcount; i++) indices[i] = i;
    }

    meshes.push(
      Object.freeze({
        partId: n.mesh,
        positions,
        normals,
        uvs,
        indices,
        skinIndices,
        skinWeights,
        materialIndex: prim.material ?? 0,
      }),
    );
  });

  // ========================================================= C. Материалы
  const textures = doc.textures ?? [];
  const images = doc.images ?? [];
  const materialsSource = doc.materials != null && doc.materials.length > 0 ? doc.materials : [undefined];
  const materials: NormalizedMaterial[] = materialsSource.map((m) => {
    const pbr = m?.pbrMetallicRoughness;
    return Object.freeze({
      baseColorFactor: Object.freeze((pbr?.baseColorFactor ?? [1, 1, 1, 1]) as [number, number, number, number]),
      baseColorTexture: pbr?.baseColorTexture?.index ?? null,
      metallicFactor: pbr?.metallicFactor ?? 1,
      roughnessFactor: pbr?.roughnessFactor ?? 1,
      normalTexture: m?.normalTexture?.index ?? null,
      emissiveFactor: Object.freeze((m?.emissiveFactor ?? [0, 0, 0]) as [number, number, number]),
      emissiveTexture: m?.emissiveTexture?.index ?? null,
      alphaMode: m?.alphaMode === 'MASK' ? 'mask' : m?.alphaMode === 'BLEND' ? 'blend' : 'opaque',
      alphaCutoff: m?.alphaCutoff ?? 0.5,
      doubleSided: m?.doubleSided ?? false,
    });
  });

  // ====================================================== D. Слоты текстур
  //
  // Слот = индекс в `textures[]` (совпадает с тем, на что ссылаются
  // материалы выше). Изображение без внешнего `uri` (data-URI, встроенное
  // в `.glb`) — слот объявлен, но файла за ним нет, как replaceable-слот
  // MDX (см. `mdxLoader`).
  const textureSlots: TextureSlotRef[] = textures.map((t, slot) => {
    const image = images[t.source];
    const path = image?.uri != null ? resolveDependencyPath(assetId, image.uri) : null;
    return Object.freeze({ slot, path });
  });

  // ======================================================== E. Секвенции
  const sequences: NormalizedSequence[] = (doc.animations ?? []).map((anim) => {
    const tracksByNode = new Map<number, { position?: ChannelKeys; rotation?: ChannelKeys; scale?: ChannelKeys }>();
    let duration = 0.001;

    for (const channel of anim.channels) {
      const targetNode = channel.target.node;
      if (targetNode == null) continue; // 'weights' и т.п. без узла — вне модели скелета
      const sampler = anim.samplers[channel.sampler];
      if (sampler == null) continue;
      const times = readAccessor(doc, buffers, sampler.input, false).values;
      if (times.length > 0) duration = Math.max(duration, times[times.length - 1]!);
      const interpolation = LINE_TYPE[sampler.interpolation ?? 'LINEAR'] ?? 'linear';
      const isRoot = parentOf[targetNode] === -1;

      const path = channel.target.path;
      if (path !== 'translation' && path !== 'rotation' && path !== 'scale') continue; // 'weights' — не поддержан
      const dim = path === 'rotation' ? 4 : 3;
      const rawOut = readAccessor(doc, buffers, sampler.output, false).values;
      // CUBICSPLINE: тройка (in-tangent, value, out-tangent) на ключ — берём средний блок (см. заголовок).
      const cubic = sampler.interpolation === 'CUBICSPLINE';
      const values = new Float32Array(times.length * dim);
      for (let k = 0; k < times.length; k++) {
        const srcBase = cubic ? k * dim * 3 + dim : k * dim;
        let vec: [number, number, number, number] | [number, number, number];
        if (path === 'translation') {
          vec = isRoot
            ? axisConvertVec3([rawOut[srcBase]!, rawOut[srcBase + 1]!, rawOut[srcBase + 2]!])
            : [rawOut[srcBase]!, rawOut[srcBase + 1]!, rawOut[srcBase + 2]!];
        } else if (path === 'rotation') {
          const q: Quat = [rawOut[srcBase]!, rawOut[srcBase + 1]!, rawOut[srcBase + 2]!, rawOut[srcBase + 3]!];
          vec = isRoot ? quatMultiply(MC_QUAT, q) : [...q];
        } else {
          vec = [rawOut[srcBase]!, rawOut[srcBase + 1]!, rawOut[srcBase + 2]!]; // scale — не конвертируется
        }
        values.set(vec, k * dim);
      }

      const entry = tracksByNode.get(targetNode) ?? {};
      const keys: ChannelKeys = { times: Float32Array.from(times), values, interpolation };
      if (path === 'translation') entry.position = keys;
      else if (path === 'rotation') entry.rotation = keys;
      else entry.scale = keys;
      tracksByNode.set(targetNode, entry);
    }

    const boneTracks: BoneTrack[] = [...tracksByNode.entries()].map(([boneIndex, t]) =>
      Object.freeze({
        boneIndex,
        ...(t.position ? { position: Object.freeze(t.position) } : {}),
        ...(t.rotation ? { rotation: Object.freeze(t.rotation) } : {}),
        ...(t.scale ? { scale: Object.freeze(t.scale) } : {}),
      }),
    );

    return Object.freeze({
      name: anim.name ?? 'sequence',
      duration,
      boneTracks: Object.freeze(boneTracks),
      partVisibility: Object.freeze([]), // glTF не знает видимости частей по секвенции
    });
  });

  // ============================================================ F. Высота
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const mesh of meshes) {
    for (let k = 2; k < mesh.positions.length; k += 3) {
      const z = mesh.positions[k]!;
      if (z < minZ) minZ = z;
      if (z > maxZ) maxZ = z;
    }
  }
  const height = Math.max(maxZ - minZ, 1e-3);

  return Object.freeze({
    bones: Object.freeze(bones),
    meshes: Object.freeze(meshes),
    sequences: Object.freeze(sequences),
    materials: Object.freeze(materials),
    textureSlots: Object.freeze(textureSlots),
    height,
  });
}

/** Загрузчик glTF для реестра сервиса (ASSET-3). */
export const gltfLoader: AssetLoader<NormalizedModel> = {
  kind: 'model',
  extensions: ['.gltf'],
  async load(bytes: ArrayBuffer, ctx: LoaderContext): Promise<NormalizedModel> {
    let doc: GltfDocument;
    try {
      doc = JSON.parse(new TextDecoder('utf-8').decode(bytes)) as GltfDocument;
    } catch (e) {
      throw new Error(`ассет "${ctx.id}": не удалось распарсить glTF JSON — ${e instanceof Error ? e.message : String(e)}`);
    }
    if (doc.buffers.length !== 1) {
      throw new Error(`ассет "${ctx.id}": поддержан ровно один buffer, получено ${doc.buffers.length}`);
    }
    const bufferUri = doc.buffers[0]!.uri;
    if (bufferUri == null) {
      throw new Error(`ассет "${ctx.id}": buffers[0] без внешнего uri (встроенные/data-URI буферы не поддержаны)`);
    }
    const bytesOfBuffer = await ctx.read(bufferUri);
    return normalizeGltf(doc, [new Uint8Array(bytesOfBuffer)], ctx.id);
  },
};
