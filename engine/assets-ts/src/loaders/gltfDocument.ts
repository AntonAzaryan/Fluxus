/**
 * Формат файла glTF 2.0 глазами загрузчика: форма JSON-документа, три упаковки
 * его буфера и разбор двоичного контейнера `.glb`.
 *
 * Живёт отдельно от нормализации (`gltf.ts`) потому, что это разные вопросы:
 * здесь — ЧТО написано в файле, там — как это становится канонической моделью
 * модуля (ASSET-5). Названы только те поля, которые загрузчик читает;
 * поддержанное подмножество формата описано в заголовке `gltf.ts`.
 */

// ------------------------------------------------------------- data-URI
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

export function isDataUri(uri: string): boolean {
  return uri.slice(0, 5).toLowerCase() === 'data:';
}

/**
 * Байты base64-data-URI. Текстовые (percent-encoded) data-URI отвергаются: ни
 * буфер, ни изображение в них не приезжают, а молчаливо вернуть пустоту хуже,
 * чем назвать причину.
 */
export function dataUriBytes(uri: string): Uint8Array {
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
export interface GltfNode {
  readonly name?: string;
  readonly children?: readonly number[];
  readonly mesh?: number;
  readonly skin?: number;
  readonly translation?: readonly [number, number, number];
  readonly rotation?: readonly [number, number, number, number];
  readonly scale?: readonly [number, number, number];
}
export interface GltfPrimitive {
  readonly attributes: Record<string, number>;
  readonly indices?: number;
  readonly material?: number;
  readonly mode?: number;
}
interface GltfMesh {
  readonly name?: string;
  readonly primitives: readonly GltfPrimitive[];
}
export interface GltfSkin {
  readonly joints: readonly number[];
  readonly inverseBindMatrices?: number;
}
interface GltfTextureRef {
  readonly index: number;
}
export interface GltfMaterial {
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
  /**
   * Расширения материала. Единственное читаемое —
   * `KHR_materials_emissive_strength` (ASSET-5): множитель эмиссии сверх
   * единицы, без которого HDR-свечение не доезжает до порога bloom (REND-34).
   * Остальные расширения формата модуль не знает и молча пропускает — таков
   * контракт расширений glTF.
   */
  readonly extensions?: {
    readonly KHR_materials_emissive_strength?: { readonly emissiveStrength?: number };
  };
  readonly alphaMode?: 'OPAQUE' | 'MASK' | 'BLEND';
  readonly alphaCutoff?: number;
  readonly doubleSided?: boolean;
}
/**
 * Изображение glTF задано ЛИБО внешним `uri`, ЛИБО куском буфера
 * (`bufferView` + `mimeType`) — спецификация разрешает ровно одно из двух, и
 * именно этой развилке отвечают два вида источника слота (ASSET-5).
 */
export interface GltfImage {
  readonly uri?: string;
  readonly bufferView?: number;
  readonly mimeType?: string;
}
export interface GltfAnimationChannel {
  readonly sampler: number;
  readonly target: { readonly node?: number; readonly path: string };
}
interface GltfAnimationSampler {
  readonly input: number;
  readonly output: number;
  readonly interpolation?: 'LINEAR' | 'STEP' | 'CUBICSPLINE';
}
export interface GltfAnimation {
  readonly name?: string;
  readonly channels: readonly GltfAnimationChannel[];
  readonly samplers: readonly GltfAnimationSampler[];
}
export interface GltfDocument {
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
export function isGlb(bytes: ArrayBuffer): boolean {
  if (bytes.byteLength < 12) return false;
  return new DataView(bytes).getUint32(0, true) === GLB_MAGIC;
}

/** JSON-чанк и BIN-чанк контейнера; BIN необязателен (буфер может быть внешним и у `.glb`). */
export function parseGlb(bytes: ArrayBuffer, id: string): { json: string; bin: Uint8Array | null } {
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

