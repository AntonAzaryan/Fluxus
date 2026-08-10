/* eslint-disable max-lines -- baseline */
/**
 * Загрузчик glTF 2.0 поверх ручного разбора JSON — без THREE.js и DOM
 * (ASSET-5), в духе `mdxLoader`. Разбирает обе упаковки одного и того же
 * формата:
 *
 * - `.gltf` — JSON плюс внешний `.bin` (геометрия/скелет/анимации) и внешние
 *   `.png`-текстуры, читаемые через `ctx.read` относительно ID модели (ASSET-3);
 * - `.glb` — двоичный контейнер: 12-байтовый заголовок, чанк JSON и чанк BIN,
 *   то есть ровно те же JSON и буфер, что у `.gltf` лежат по разным файлам.
 *   Изображения внутри контейнера декодируются здесь же и приезжают в модель
 *   встроенными слотами (`TextureSlotEmbedded`) — распаковывать `.glb` на
 *   части руками больше не нужно.
 *
 * Загрузчик один на оба расширения, и вид упаковки определяется СИГНАТУРОЙ
 * СОДЕРЖИМОГО (`glTF`), а не именем файла: второй загрузчик означал бы две
 * реализации одного формата, которые неизбежно разъедутся, а имя файла — не
 * свойство данных.
 *
 * ПОДДЕРЖАННОЕ ПОДМНОЖЕСТВО (осознанно уже, чем весь glTF 2.0):
 * - Один буфер: внешний (`buffers[0].uri`), BIN-чанк контейнера либо
 *   base64-data-URI внутри самого JSON — три упаковки одного и того же буфера,
 *   и все три отдаёт штатный экспортёр Blender («Separate», «Binary»,
 *   «Embedded»). Sparse-accessor'ы не разбираются — внятная ошибка вместо
 *   молчаливой потери данных.
 * - Из встроенных изображений (BIN-чанк или data-URI) декодируется PNG
 *   (модульный `decodePng`); формат без декодера (JPEG) даёт слот без источника
 *   и предупреждение.
 * - Примитивы TRIANGLES (mode по умолчанию); каждый primitive — отдельная ЧАСТЬ
 *   модели (`NormalizedMesh`), как геосет в MDX: экспортёр режет меш по
 *   материалам, и взять из mesh только первый primitive значило бы тихо потерять
 *   геометрию всех прочих материалов.
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
import type { DecodedImage } from '../image.js';
import { resolveDependencyPath } from '../service.js';
import { decodePng } from './png.js';

// ================================================================ data-URI
//
// «Embedded»-экспорт кладёт буфер и изображения прямо в JSON строкой
// `data:<mime>;base64,<...>` (RFC 2397). Для модуля это тот же ВСТРОЕННЫЙ
// источник, что и BIN-чанк контейнера: читать рядом нечего, `ctx.read` не при
// делах — путь дерева контента из такой строки не следует (ASSET-2), и
// разрешать её как относительный путь означало бы запрос несуществующего файла.

/**
 * `atob` есть и в Node >= 16, и в браузерах, но объявлен в `lib.dom`, которую
 * пакет намеренно не подключает (ASSET-5: никакого DOM). Объявляем ровно то,
 * чем пользуемся, — тем же приёмом, что `DecompressionStream` в `png.ts`.
 */
declare const atob: (data: string) => string;

function isDataUri(uri: string): boolean {
  return uri.slice(0, 5).toLowerCase() === 'data:';
}

/**
 * Байты base64-data-URI. Текстовые (percent-encoded) data-URI отвергаются: ни
 * буфер, ни изображение в них не приезжают, а молчаливо вернуть пустоту хуже,
 * чем назвать причину.
 */
function dataUriBytes(uri: string): Uint8Array {
  const comma = uri.indexOf(',');
  const header = comma === -1 ? '' : uri.slice(0, comma);
  if (comma === -1 || !header.toLowerCase().endsWith(';base64')) {
    throw new Error('glTF: data-URI без base64-полезной нагрузки не поддержан');
  }
  const binary = atob(uri.slice(comma + 1));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

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
/**
 * Изображение glTF задано ЛИБО внешним `uri`, ЛИБО куском буфера
 * (`bufferView` + `mimeType`) — спецификация разрешает ровно одно из двух, и
 * именно этой развилке отвечают два вида источника слота (ASSET-5).
 */
interface GltfImage {
  readonly uri?: string;
  readonly bufferView?: number;
  readonly mimeType?: string;
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
  readonly images?: readonly GltfImage[];
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

/**
 * Байты изображения, лежащего внутри буфера (`.glb` или общий `.bin`).
 * Возвращает null, если ссылка битая: это повод для предупреждения, а не для
 * отказа грузить модель целиком.
 */
function imageBytes(
  doc: GltfDocument,
  buffers: readonly Uint8Array[],
  bufferViewIndex: number,
): Uint8Array | null {
  const bv = doc.bufferViews[bufferViewIndex];
  if (bv == null) return null;
  const buffer = buffers[bv.buffer];
  if (buffer == null) return null;
  const start = bv.byteOffset ?? 0;
  return buffer.subarray(start, start + bv.byteLength);
}

/** Сигнатура PNG — единственный формат встроенных изображений, который модуль умеет. */
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;

function isPng(bytes: Uint8Array): boolean {
  return bytes.length >= PNG_SIGNATURE.length && PNG_SIGNATURE.every((b, i) => bytes[i] === b);
}

/**
 * Декодирование встроенных изображений — ОДИН РАЗ НА АССЕТ и один раз на
 * изображение: несколько текстур могут ссылаться на один `images[i]`, и второй
 * прогон декодера дал бы вторую копию пикселей у того же ассета.
 *
 * Формат без декодера (JPEG) и битые байты не роняют загрузку модели: слот
 * останется без источника, а причина уйдёт предупреждением. Модель без одной
 * текстуры полезнее, чем не загрузившаяся модель; отдельного канала
 * предупреждений у `LoaderContext` сегодня нет, поэтому `console.warn` — тем
 * же способом, каким `AssetService` сообщает о бросившем подписчике.
 */
async function decodeEmbeddedImages(
  doc: GltfDocument,
  buffers: readonly Uint8Array[],
  assetId: string,
): Promise<Map<number, DecodedImage>> {
  const decoded = new Map<number, DecodedImage>();
  const images = doc.images ?? [];
  for (let i = 0; i < images.length; i++) {
    const image = images[i]!;
    let bytes: Uint8Array | null;
    if (image.uri != null) {
      if (!isDataUri(image.uri)) continue; // внешний файл — слот-ссылка, не наше дело
      try {
        bytes = dataUriBytes(image.uri);
      } catch (e) {
        console.warn(
          `ассет "${assetId}": встроенное изображение ${i} — ${e instanceof Error ? e.message : String(e)}; слот останется без текстуры`,
        );
        continue;
      }
    } else if (image.bufferView != null) {
      bytes = imageBytes(doc, buffers, image.bufferView);
    } else {
      continue; // пустая запись: ни файла, ни байтов
    }
    if (bytes == null) {
      console.warn(
        `ассет "${assetId}": встроенное изображение ${i} ссылается на несуществующий bufferView ${image.bufferView} — слот останется без текстуры`,
      );
      continue;
    }
    if (!isPng(bytes)) {
      console.warn(
        `ассет "${assetId}": встроенное изображение ${i} (${image.mimeType ?? 'неизвестный тип'}) — декодера нет, поддержан только PNG; слот останется без текстуры`,
      );
      continue;
    }
    // `decodePng` ждёт ArrayBuffer, а срез буфера — вид на чужой: копируем
    // ровно этот кусок, иначе декодер увидел бы соседние чанки контейнера.
    const own = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(own).set(bytes);
    try {
      decoded.set(i, await decodePng(own, `${assetId}#image${i}`));
    } catch (e) {
      console.warn(
        `ассет "${assetId}": встроенное изображение ${i} не декодировалось — ${e instanceof Error ? e.message : String(e)}; слот останется без текстуры`,
      );
    }
  }
  return decoded;
}

export async function normalizeGltf(
  doc: GltfDocument,
  buffers: readonly Uint8Array[],
  assetId: string,
): Promise<NormalizedModel> {
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
  // Одна ЧАСТЬ модели (`NormalizedMesh`) = один primitive: экспортёр режет меш
  // по материалам, и «только первый primitive узла» тихо терял бы геометрию
  // всех остальных материалов. Номер части — сквозной по порядку обхода узлов
  // и примитивов внутри узла; индекс в `doc.meshes` номером не годится, потому
  // что на один mesh вправе ссылаться несколько узлов — части слились бы, а
  // `hiddenParts` манифеста и треки видимости адресуют часть именно номером
  // (как геосет в MDX).
  //
  // Меш без скина (экипировка, привязанная узлом-родителем, не суставами) —
  // запекается в bind-пространство узла и жёстко привязывается к «суставу»
  // = самому этому узлу (вес 1); отсутствующий `inverseBind` для такого узла
  // рендер выведет из позы покоя сам (build.ts: `buildSkeleton`) — и это
  // ровно матрица, обратная его мировой матрице покоя, то есть корректно.
  //
  // Примитив без `material` получает материал ПО УМОЛЧАНИЮ (спецификация glTF,
  // §3.7.2) отдельной строкой в конце таблицы, а не нулевой материал документа:
  // материал 0 — такой же авторский, как любой другой, и подставить его значило
  // бы покрасить деталь чужой краской.
  const defaultMaterialIndex = (doc.materials ?? []).length;
  let usesDefaultMaterial = false;
  const meshes: NormalizedMesh[] = [];
  nodes.forEach((n, nodeIndex) => {
    if (n.mesh == null) return;
    const mesh = doc.meshes[n.mesh];
    if (mesh == null) throw new Error(`glTF: mesh ${n.mesh} не существует (узел "${n.name}")`);
    if (mesh.primitives.length === 0) throw new Error(`glTF: mesh "${mesh.name}" без примитивов`);

    for (const prim of mesh.primitives) {
      if (prim.mode != null && prim.mode !== 4) {
        throw new Error(`glTF: mesh "${mesh.name}" — режим ${prim.mode} (нужен TRIANGLES=4)`);
      }

      const posAcc = prim.attributes.POSITION;
      if (posAcc == null) throw new Error(`glTF: mesh "${mesh.name}" без POSITION`);
      const pos = readAccessor(doc, buffers, posAcc, false);
      const vcount = pos.count;
      const positions = new Float32Array(vcount * 3);
      const normalsAcc = prim.attributes.NORMAL;
      const norm = normalsAcc != null ? readAccessor(doc, buffers, normalsAcc, false) : null;
      const normals = norm != null ? new Float32Array(vcount * 3) : null;

      const skinned = prim.attributes.JOINTS_0 != null && prim.attributes.WEIGHTS_0 != null;
      const skinIndices = new Uint16Array(vcount * 4);
      const skinWeights = new Float32Array(vcount * 4);

      if (skinned) {
        const joints = readAccessor(doc, buffers, prim.attributes.JOINTS_0!, false);
        const weights = readAccessor(doc, buffers, prim.attributes.WEIGHTS_0!, true);
        const jointNodes = skin?.joints ?? [];
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

      const uvAcc = prim.attributes.TEXCOORD_0;
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

      if (prim.material == null) usesDefaultMaterial = true;
      meshes.push(
        Object.freeze({
          partId: meshes.length,
          positions,
          normals,
          uvs,
          indices,
          skinIndices,
          skinWeights,
          materialIndex: prim.material ?? defaultMaterialIndex,
        }),
      );
    }
  });

  // ========================================================= C. Материалы
  const textures = doc.textures ?? [];
  const images = doc.images ?? [];
  // Строка материала по умолчанию (`undefined` — все значения из умолчаний
  // формата) добавляется в конец, если её кто-то занял, либо если своих
  // материалов у документа нет вовсе: меш обязан на что-то ссылаться.
  const materialsSource: readonly (GltfMaterial | undefined)[] =
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- baseline
    usesDefaultMaterial || defaultMaterialIndex === 0
      ? [...(doc.materials ?? []), undefined]
      : (doc.materials ?? []);
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
  // Слот = индекс в `textures[]` (совпадает с тем, на что ссылаются материалы
  // выше), и номер слота от вида источника не зависит — скин подменяет по
  // номеру (REND-6). Три источника, ровно три варианта `TextureSlotRef`:
  // внешний `uri` — путь, разрешённый от ID модели (ASSET-3); `bufferView` —
  // уже декодированные пиксели контейнера; всё остальное (в том числе
  // недекодируемый формат) — слот без источника.
  const embedded = await decodeEmbeddedImages(doc, buffers, assetId);
  const textureSlots: TextureSlotRef[] = textures.map((t, slot) => {
    const image = images[t.source];
    if (image?.uri != null && !isDataUri(image.uri)) {
      return Object.freeze({
        slot,
        source: 'file' as const,
        path: resolveDependencyPath(assetId, image.uri),
      });
    }
    const pixels = embedded.get(t.source);
    if (pixels !== undefined) {
      return Object.freeze({ slot, source: 'embedded' as const, image: pixels });
    }
    return Object.freeze({ slot, source: 'none' as const });
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

// ============================================================ контейнер .glb
//
// Раскладка контейнера (glTF 2.0, §4.4): заголовок 12 байт — magic `glTF`,
// версия, полная длина файла; дальше чанки «длина, тип, данные», выровненные
// по 4 байтам. Первый чанк обязан быть JSON, второй (если есть) — BIN.

/** `glTF` little-endian — сигнатура СОДЕРЖИМОГО, по ней и различаются упаковки. */
const GLB_MAGIC = 0x46546c67;
const GLB_CHUNK_JSON = 0x4e4f534a;
const GLB_CHUNK_BIN = 0x004e4942;

/** Похожи ли байты на двоичный контейнер. Имя файла не спрашиваем — оно не свойство данных. */
function isGlb(bytes: ArrayBuffer): boolean {
  if (bytes.byteLength < 12) return false;
  return new DataView(bytes).getUint32(0, true) === GLB_MAGIC;
}

/** JSON-чанк и BIN-чанк контейнера; BIN необязателен (буфер может быть внешним и у `.glb`). */
function parseGlb(bytes: ArrayBuffer, id: string): { json: string; bin: Uint8Array | null } {
  const view = new DataView(bytes);
  const version = view.getUint32(4, true);
  if (version !== 2) {
    throw new Error(`ассет "${id}": версия контейнера .glb ${version} (поддержана 2)`);
  }
  let json: string | null = null;
  let bin: Uint8Array | null = null;
  let offset = 12;
  while (offset + 8 <= bytes.byteLength) {
    const length = view.getUint32(offset, true);
    const type = view.getUint32(offset + 4, true);
    const start = offset + 8;
    if (start + length > bytes.byteLength) {
      throw new Error(`ассет "${id}": чанк .glb выходит за конец файла`);
    }
    if (type === GLB_CHUNK_JSON && json === null) {
      json = new TextDecoder('utf-8').decode(new Uint8Array(bytes, start, length));
    } else if (type === GLB_CHUNK_BIN && bin === null) {
      bin = new Uint8Array(bytes, start, length);
    }
    // Чанки выровнены по 4 байта; хвостовое выравнивание в length не входит.
    offset = start + length + ((4 - (length % 4)) % 4);
  }
  if (json === null) throw new Error(`ассет "${id}": в контейнере .glb нет JSON-чанка`);
  return { json, bin };
}

/**
 * Загрузчик glTF для реестра сервиса (ASSET-3) — оба расширения одним
 * загрузчиком (см. заголовок файла). Разбор JSON и добывание буфера
 * различаются, вся нормализация — общая.
 */
export const gltfLoader: AssetLoader<NormalizedModel> = {
  kind: 'model',
  extensions: ['.gltf', '.glb'],
  async load(bytes: ArrayBuffer, ctx: LoaderContext): Promise<NormalizedModel> {
    const container = isGlb(bytes) ? parseGlb(bytes, ctx.id) : null;
    const text = container?.json ?? new TextDecoder('utf-8').decode(bytes);

    let doc: GltfDocument;
    try {
      doc = JSON.parse(text) as GltfDocument;
    } catch (e) {
      throw new Error(`ассет "${ctx.id}": не удалось распарсить glTF JSON — ${e instanceof Error ? e.message : String(e)}`);
    }
    if (doc.buffers.length !== 1) {
      throw new Error(`ассет "${ctx.id}": поддержан ровно один buffer, получено ${doc.buffers.length}`);
    }

    // Три упаковки одного буфера: data-URI внутри JSON, файл рядом по `uri`,
    // BIN-чанк контейнера. Буфер без `uri` — это BIN-чанк, а не ошибка: так
    // его и задаёт спецификация.
    const bufferUri = doc.buffers[0]!.uri;
    let buffer: Uint8Array;
    if (bufferUri != null && isDataUri(bufferUri)) {
      try {
        buffer = dataUriBytes(bufferUri);
      } catch (e) {
        throw new Error(`ассет "${ctx.id}": буфер — ${e instanceof Error ? e.message : String(e)}`);
      }
    } else if (bufferUri != null) {
      buffer = new Uint8Array(await ctx.read(bufferUri));
    } else if (container?.bin != null) {
      buffer = container.bin;
    } else {
      throw new Error(`ассет "${ctx.id}": buffers[0] без внешнего uri и без BIN-чанка`);
    }

    return normalizeGltf(doc, [buffer], ctx.id);
  },
};
