/**
 * Разбор экспорта Blender — glTF 2.0 в двух его формах: текстовый `.gltf`
 * (JSON) и контейнер `.glb` (заголовок, JSON-чанк, бинарный чанк). Конвейеру
 * нужны от формата ровно два подмножества (design, решение 2):
 *
 * - `nodes` — имя, трансформ (матрица либо TRS) и `extras`: из них собирается
 *   пространственный слой (BLND-3);
 * - `accessors`/`bufferViews`/`buffers` для позиций вершин grid-мешей: из них
 *   позже читаются клеточные данные террейна и кривизны (BLND-9, BLND-10).
 *
 * Всё остальное — материалы, анимации, скиннинг, меши размещений — игнорируется
 * молча: импортёр не рендерит, а читает разметку сцены. Поэтому и парсер свой,
 * а не GLTFLoader three.js: рендер-зависимость в headless-инструменте оплачена
 * была бы чужими краевыми случаями с `extras`, а нужное подмножество — это
 * сотни строк без единой зависимости.
 *
 * Модуль ничего не знает ни о мире, ни о документах: он отвечает на вопрос «что
 * лежит в файле», а «что это значит» — вопрос `normalize.ts` и `layer.ts`.
 */

/** Произвольное значение JSON — форма, в которой приходят `extras` и сам документ. */
export type GltfJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly GltfJsonValue[]
  | { readonly [key: string]: GltfJsonValue };

/**
 * Узел сцены. Трансформ приходит одной из двух форм — матрицей 4×4 (16 чисел,
 * по столбцам) либо тройкой TRS, — и формат разрешает обе: экспортёр выбирает
 * сам, а импортёр обязан понимать обе (design, риск «экспортёр между версиями
 * меняет представление трансформов»).
 */
export interface GltfNode {
  readonly name?: string;
  readonly matrix?: readonly number[];
  readonly translation?: readonly number[];
  readonly rotation?: readonly number[];
  readonly scale?: readonly number[];
  readonly children?: readonly number[];
  readonly mesh?: number;
  readonly extras?: Readonly<Record<string, GltfJsonValue>>;
}

export interface GltfAccessor {
  readonly bufferView?: number;
  readonly byteOffset?: number;
  readonly componentType: number;
  readonly count: number;
  readonly type: string;
  readonly normalized?: boolean;
}

export interface GltfBufferView {
  readonly buffer: number;
  readonly byteOffset?: number;
  readonly byteLength: number;
  readonly byteStride?: number;
}

export interface GltfBuffer {
  readonly byteLength: number;
  readonly uri?: string;
}

export interface GltfPrimitive {
  /**
   * Тот же случай, что у `primitives` меша: форматом поле обязательно, а типом
   * — нет. Документ приезжает разбором чужого JSON, и примитив без атрибутов
   * означает не невозможное, а сломанный экспорт. С обязательным типом такой
   * экспорт кончался бы безымянным `TypeError` при чтении `attributes.POSITION`
   * — а BLND-6 требует внятной находки. С опциональным примитив без атрибутов
   * проходит той же веткой, что и примитив без `POSITION`: пропускается, и о
   * непокрытых адресах сообщает уже вызывающий.
   */
  readonly attributes?: Readonly<Record<string, number>>;
  readonly indices?: number;
  readonly mode?: number;
}

export interface GltfMesh {
  readonly name?: string;
  /**
   * Форматом поле обязательно, а типом — нет: документ приезжает разбором
   * чужого JSON, и «меш без примитивов» здесь означает не невозможное, а
   * сломанный экспорт. Тип честнее обещания формата — как и у `nodes`,
   * `meshes`, `accessors` документа.
   */
  readonly primitives?: readonly GltfPrimitive[];
}

export interface GltfScene {
  readonly nodes?: readonly number[];
}

/** Документ glTF в том объёме, в котором его читает конвейер. */
export interface GltfJson {
  readonly asset?: { readonly version?: string };
  readonly scene?: number;
  readonly scenes?: readonly GltfScene[];
  readonly nodes?: readonly GltfNode[];
  readonly meshes?: readonly GltfMesh[];
  readonly accessors?: readonly GltfAccessor[];
  readonly bufferViews?: readonly GltfBufferView[];
  readonly buffers?: readonly GltfBuffer[];
}

/**
 * Разобранный экспорт: JSON плюс бинарный чанк контейнера, если он был.
 * Текстовый `.gltf` бинарного чанка не имеет — его буферы приезжают `data:`-URI
 * либо внешними файлами.
 */
export interface GltfDocument {
  readonly json: GltfJson;
  readonly binaryChunk: Uint8Array | null;
}

/** Отказ разбора источника. Адресуется файлом и местом внутри него. */
export class GltfParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GltfParseError';
  }
}

/** `glTF` — магическое слово контейнера, первые четыре байта `.glb`. */
const GLB_MAGIC = 0x46546c67;
const GLB_CHUNK_JSON = 0x4e4f534a;
const GLB_CHUNK_BIN = 0x004e4942;

const decoder = new TextDecoder();

/** Контейнер ли это: решает магическое слово, а не расширение файла. */
export function isGlb(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 4) return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, 4);
  return view.getUint32(0, true) === GLB_MAGIC;
}

/**
 * Разбор байтов экспорта. Форма определяется содержимым: контейнер узнаётся по
 * магическому слову, всё прочее читается как JSON. Расширение файла для выбора
 * не используется — оно свойство имени, а не данных.
 */
export function parseGltf(bytes: Uint8Array): GltfDocument {
  return isGlb(bytes) ? parseGlb(bytes) : parseGltfJson(decoder.decode(bytes));
}

/** Текстовая форма: сам JSON и есть документ, бинарного чанка у неё нет. */
export function parseGltfJson(text: string): GltfDocument {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new GltfParseError(`glTF: документ не разбирается как JSON (${String(error)})`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new GltfParseError('glTF: документ — объект JSON');
  }
  return { json: parsed, binaryChunk: null };
}

/**
 * Контейнер `.glb`: заголовок из трёх uint32 (магия, версия, полная длина), за
 * ним чанки «длина, тип, данные». Порядок чанков форматом закреплён — JSON
 * первым, — но искать их по типу дешевле, чем полагаться на порядок: чужой
 * экспортёр может дописать свои чанки, и пропустить их обязан читатель.
 */
export function parseGlb(bytes: Uint8Array): GltfDocument {
  if (bytes.byteLength < 12) throw new GltfParseError('glb: файл короче заголовка контейнера');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== GLB_MAGIC) throw new GltfParseError('glb: не контейнер glTF');
  const version = view.getUint32(4, true);
  if (version !== 2) throw new GltfParseError(`glb: версия контейнера ${version}, поддержана 2`);
  const total = view.getUint32(8, true);
  if (total > bytes.byteLength) {
    throw new GltfParseError(`glb: заголовок обещает ${total} байт, в файле ${bytes.byteLength}`);
  }

  let offset = 12;
  let json: GltfJson | null = null;
  let binaryChunk: Uint8Array | null = null;
  while (offset + 8 <= total) {
    const length = view.getUint32(offset, true);
    const kind = view.getUint32(offset + 4, true);
    const start = offset + 8;
    const end = start + length;
    if (end > total) throw new GltfParseError(`glb: чанк на смещении ${offset} выходит за файл`);
    if (kind === GLB_CHUNK_JSON && json === null) {
      json = parseGltfJson(decoder.decode(bytes.subarray(start, end))).json;
    } else if (kind === GLB_CHUNK_BIN && binaryChunk === null) {
      binaryChunk = bytes.subarray(start, end);
    }
    // Чанки выровнены по четырём байтам; невыровненная длина — дополняется.
    offset = end + ((4 - (length % 4)) % 4);
  }
  if (json === null) throw new GltfParseError('glb: JSON-чанк не найден');
  return { json, binaryChunk };
}

/** Узлы документа в порядке массива; их индекс — и есть их адрес в glTF. */
export function nodesOf(document: GltfDocument): readonly GltfNode[] {
  return document.json.nodes ?? [];
}

/**
 * Индексы корневых узлов сцены. Сцена по умолчанию — `scene`; её нет — берётся
 * первая. Ни одной сцены в документе — корнями считаются все узлы, на которые
 * никто не ссылается: экспорт без сцен формально валиден, и терять его узлы
 * молча хуже, чем разобрать.
 */
export function rootNodesOf(document: GltfDocument): readonly number[] {
  const scenes = document.json.scenes ?? [];
  const index = document.json.scene ?? 0;
  const scene = scenes[index] ?? scenes[0];
  if (scene?.nodes !== undefined) return scene.nodes;
  const nodes = nodesOf(document);
  const child = new Set<number>();
  for (const node of nodes) for (const kid of node.children ?? []) child.add(kid);
  const roots: number[] = [];
  for (let i = 0; i < nodes.length; i++) if (!child.has(i)) roots.push(i);
  return roots;
}

/** Число компонент по типу аксессора — всё, что нужно знать о `type`. */
const COMPONENTS_OF_TYPE: Readonly<Record<string, number>> = {
  SCALAR: 1,
  VEC2: 2,
  VEC3: 3,
  VEC4: 4,
  MAT2: 4,
  MAT3: 9,
  MAT4: 16,
};

/** Размер компоненты в байтах по её типу (5120…5126 — коды glTF). */
const SIZE_OF_COMPONENT: Readonly<Record<number, number>> = {
  5120: 1,
  5121: 1,
  5122: 2,
  5123: 2,
  5125: 4,
  5126: 4,
};

function readComponent(view: DataView, at: number, componentType: number): number {
  switch (componentType) {
    case 5120:
      return view.getInt8(at);
    case 5121:
      return view.getUint8(at);
    case 5122:
      return view.getInt16(at, true);
    case 5123:
      return view.getUint16(at, true);
    case 5125:
      return view.getUint32(at, true);
    case 5126:
      return view.getFloat32(at, true);
    default:
      throw new GltfParseError(`glTF: неизвестный componentType ${componentType}`);
  }
}

const BASE64_PREFIX = ';base64,';

/**
 * Байты буфера. Источников два: бинарный чанк контейнера (буфер без `uri`) и
 * `data:`-URI текстовой формы. Внешний файл рядом с документом — законная форма
 * glTF, но её чтение требует среды, а не парсера: отказ здесь честнее пустого
 * результата (образец ED-12), и вызывающий подаёт байты сам.
 */
function bufferBytes(document: GltfDocument, index: number): Uint8Array {
  const buffer = document.json.buffers?.[index];
  if (buffer === undefined) throw new GltfParseError(`glTF: буфер #${index} не объявлен`);
  if (buffer.uri === undefined) {
    if (document.binaryChunk === null) {
      throw new GltfParseError(`glTF: буфер #${index} без "uri", а бинарного чанка нет`);
    }
    return document.binaryChunk;
  }
  if (!buffer.uri.startsWith('data:')) {
    throw new GltfParseError(
      `glTF: буфер #${index} лежит внешним файлом ("${buffer.uri}") — конвейер читает контейнер .glb либо data:-URI`,
    );
  }
  const marker = buffer.uri.indexOf(BASE64_PREFIX);
  if (marker < 0) throw new GltfParseError(`glTF: буфер #${index} — data:-URI не в base64`);
  const base64 = buffer.uri.slice(marker + BASE64_PREFIX.length);
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * Значения аксессора построчно: массив кортежей длиной по числу компонент типа.
 * Разрежённые (`sparse`) аксессоры не поддержаны — экспорт Blender их не пишет,
 * и молчаливо вернуть нули было бы хуже отказа.
 */
export function readAccessor(document: GltfDocument, index: number): readonly (readonly number[])[] {
  const accessor = document.json.accessors?.[index];
  if (accessor === undefined) throw new GltfParseError(`glTF: аксессор #${index} не объявлен`);
  const components = COMPONENTS_OF_TYPE[accessor.type];
  if (components === undefined) throw new GltfParseError(`glTF: аксессор #${index} типа "${accessor.type}"`);
  const componentSize = SIZE_OF_COMPONENT[accessor.componentType];
  if (componentSize === undefined) {
    throw new GltfParseError(`glTF: аксессор #${index}: componentType ${accessor.componentType}`);
  }
  if (accessor.bufferView === undefined) {
    // Аксессор без bufferView означает нули — законная форма, и она читаема.
    return Array.from({ length: accessor.count }, () => new Array<number>(components).fill(0));
  }
  const bufferView = document.json.bufferViews?.[accessor.bufferView];
  if (bufferView === undefined) {
    throw new GltfParseError(`glTF: аксессор #${index} ссылается на bufferView #${accessor.bufferView}`);
  }
  const bytes = bufferBytes(document, bufferView.buffer);
  const viewStart = bufferView.byteOffset ?? 0;
  if (viewStart + bufferView.byteLength > bytes.byteLength) {
    throw new GltfParseError(`glTF: bufferView #${accessor.bufferView} выходит за буфер`);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset + viewStart, bufferView.byteLength);
  const stride = bufferView.byteStride ?? components * componentSize;
  const start = accessor.byteOffset ?? 0;
  const rows: number[][] = [];
  for (let i = 0; i < accessor.count; i++) {
    const at = start + i * stride;
    if (at + components * componentSize > bufferView.byteLength) {
      throw new GltfParseError(`glTF: аксессор #${index}: строка ${i} выходит за bufferView`);
    }
    const row = new Array<number>(components);
    for (let c = 0; c < components; c++) row[c] = readComponent(view, at + c * componentSize, accessor.componentType);
    rows.push(row);
  }
  return rows;
}

/**
 * Позиции вершин меша — сырьё клеточных данных террейна и кривизны (BLND-9,
 * BLND-10). Примитивы меша склеиваются в один список в порядке объявления:
 * grid-mesh экспортируется одним примитивом, а несколько — уже не сетка, и
 * судить об этом вправе тот, кто знает про сетку, а не парсер.
 */
export function meshPositions(document: GltfDocument, mesh: number): readonly (readonly number[])[] {
  const def = document.json.meshes?.[mesh];
  if (def === undefined) throw new GltfParseError(`glTF: меш #${mesh} не объявлен`);
  const rows: (readonly number[])[] = [];
  for (const primitive of def.primitives ?? []) {
    const accessor = primitive.attributes?.POSITION;
    if (accessor === undefined) continue;
    for (const row of readAccessor(document, accessor)) rows.push(row);
  }
  return rows;
}

/** Режим примитива, которым экспортируется геометрия: треугольники. */
const MODE_TRIANGLES = 4;

/**
 * Геометрия меша в объёме, нужном клеточным данным (BLND-9, BLND-10): позиции
 * вершин, грани и запрошенные пользовательские каналы вершин.
 *
 * Грани нужны потому, что адрес клетки восстанавливается по ГРАНИ, а не по
 * порядку вершин: экспортёр вправе слить вершины с совпадающими позицией и
 * атрибутами, и «по четыре вершины на клетку» перестаёт выполняться
 * (`CONVENTIONS.md`, «Адресация клетки»).
 */
export interface MeshGeometry {
  /** Позиции вершин в пространстве glTF, примитивы подряд в порядке объявления. */
  readonly positions: readonly (readonly number[])[];
  /** Индексы вершин треугольников — по три подряд; адресуют `positions`. */
  readonly triangles: readonly number[];
  /**
   * Значения запрошенных каналов по вершинам. `null` — канала нет ни у одного
   * примитива; отсутствие у ЧАСТИ примитивов даёт нули: ноль — значение нового
   * атрибута по умолчанию, а не выдумка (`grids.py` аддона).
   */
  readonly attributes: Readonly<Record<string, readonly number[] | null>>;
}

/**
 * Значения запрошенных каналов ОДНОГО примитива — по одному на его вершину.
 * Канала у примитива нет: его вершины получают `null` («значения не было»);
 * нулём это станет только у канала, которого нет ни у одного примитива.
 */
function appendPrimitiveChannels(
  document: GltfDocument,
  mesh: number,
  primitive: GltfPrimitive,
  channels: ReadonlyMap<string, (number | null)[]>,
  vertices: number,
): void {
  for (const [name, values] of channels) {
    const index = primitive.attributes?.[name];
    if (index === undefined) {
      for (let i = 0; i < vertices; i++) values.push(null);
      continue;
    }
    const read = readAccessor(document, index);
    if (read.length !== vertices) {
      throw new GltfParseError(
        `glTF: меш #${mesh}: канал "${name}" даёт ${read.length} значений на ${vertices} вершин`,
      );
    }
    for (const row of read) values.push(row[0] ?? 0);
  }
}

/** Индексы треугольников примитива со сдвигом на уже прочитанные вершины. */
function appendPrimitiveTriangles(
  document: GltfDocument,
  primitive: GltfPrimitive,
  offset: number,
  vertices: number,
  triangles: number[],
): void {
  if (primitive.indices === undefined) {
    // Неиндексированный примитив: вершины идут тройками — сами треугольники.
    for (let i = 0; i < vertices; i++) triangles.push(offset + i);
    return;
  }
  for (const row of readAccessor(document, primitive.indices)) triangles.push(offset + (row[0] ?? 0));
}

export function readMeshGeometry(
  document: GltfDocument,
  mesh: number,
  attributes: readonly string[] = [],
): MeshGeometry {
  const def = document.json.meshes?.[mesh];
  if (def === undefined) throw new GltfParseError(`glTF: меш #${mesh} не объявлен`);
  const positions: number[][] = [];
  const triangles: number[] = [];
  // Порядок обхода каналов — порядок запроса: карта заведена под него один раз
  // и дальше служит и перечнем каналов, и их накопителем.
  const channels = new Map<string, (number | null)[]>();
  for (const name of attributes) channels.set(name, []);

  for (const primitive of def.primitives ?? []) {
    const mode = primitive.mode ?? MODE_TRIANGLES;
    if (mode !== MODE_TRIANGLES) {
      throw new GltfParseError(
        `glTF: меш #${mesh}: примитив режима ${mode} — клеточные данные читаются с треугольников (mode 4)`,
      );
    }
    const accessor = primitive.attributes?.POSITION;
    if (accessor === undefined) continue;
    const offset = positions.length;
    const rows = readAccessor(document, accessor);
    for (const row of rows) positions.push([...row]);
    appendPrimitiveChannels(document, mesh, primitive, channels, rows.length);
    appendPrimitiveTriangles(document, primitive, offset, rows.length, triangles);
  }

  if (triangles.length % 3 !== 0) {
    throw new GltfParseError(`glTF: меш #${mesh}: ${triangles.length} индексов вершин — не кратно трём`);
  }
  const out: Record<string, readonly number[] | null> = {};
  for (const [name, values] of channels) {
    out[name] = values.every((value) => value === null) ? null : values.map((value) => value ?? 0);
  }
  return { positions, triangles, attributes: out };
}
