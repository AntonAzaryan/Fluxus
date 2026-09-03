/**
 * Клеточные данные grid-объекта: высота клетки и её целочисленные каналы
 * (BLND-9, BLND-10). Модуль отвечает на вопрос «что нарисовано в сетке», а «что
 * это значит для ассета» — вопрос `maps.ts`.
 *
 * ## Адрес клетки берётся с ГРАНИ, а не с порядка вершин
 *
 * Аддон строит сетку из отдельных четырёхугольников (`grids.py`): клетка
 * `(x, y)` — грань `y · width + x`, её четыре вершины лежат по углам. Полагаться
 * на этот порядок импортёр не вправе: экспортёр вправе слить вершины с
 * совпадающими позицией и атрибутами, и «по четыре вершины на клетку»
 * перестаёт выполняться, а четырёхугольник он к тому же триангулирует.
 *
 * Поэтому адрес клетки — ОХВАТЫВАЮЩИЙ ПРЯМОУГОЛЬНИК ГРАНИ. Любой треугольник
 * четырёхугольника, разрезанного по диагонали, содержит два противоположных
 * угла клетки, поэтому его охватывающий прямоугольник равен прямоугольнику
 * клетки — у обеих половин квада адрес получается один и тот же, и он не
 * зависит ни от направления разреза, ни от того, слиты вершины или нет.
 * Центроид грани таким свойством НЕ обладает: у половин квада он разный.
 *
 * ## Значение клетки — единогласие её вершин
 *
 * Высота и каналы читаются со всех вершин всех граней клетки и обязаны
 * совпасть; расхождение — ошибка с адресом клетки, а не большинство голосов.
 * Так пишет аддон (одно значение всем четырём вершинам клетки), так переживает
 * сварку (сливаются только вершины с совпадающими значениями), и так молчаливое
 * «клетка получилась не той, что автор видел» становится невозможным (BLND-6).
 *
 * ## Допуски
 *
 * Два и оба — про шум float32 экспорта, а не про свободу автора. Высоты
 * сравниваются с точностью `HEIGHT_EPSILON`, заведомо ниже любого осмысленного
 * шага авторинга (целый уровень — 1.0, ступень кривизны — 1/32), и заведомо
 * выше погрешности float32 на величинах порядка десятков. Центр грани обязан
 * попасть в центр клетки с точностью до четверти клетки — этого хватает, чтобы
 * поймать несведённый трансформ и не поймать шум.
 */
import { GltfParseError, readMeshGeometry, type GltfDocument, type MeshGeometry } from './gltf.js';
import { worldPoint, type SourceObject, type WorldPoint } from './normalize.js';

/**
 * Каналы клеточных атрибутов в экспорте glTF. Аддон держит их атрибутами на
 * домене точек с именами `RAMP`/`NOFLOOR`, а штатный экспортёр отдаёт
 * пользовательские каналы с обязательным префиксом `_` (`CONVENTIONS.md`).
 */
export const RAMP_CHANNEL = '_RAMP';
export const NOFLOOR_CHANNEL = '_NOFLOOR';
/**
 * Слот покрытия клетки (BLND-14): скалярный канал рядом с двумя предыдущими, а
 * НЕ вершинный цвет. Цвет — векторный канал с семантикой цвета, который
 * экспортёр вправе квантовать и переносить между пространствами, а читатель
 * каналов берёт из строки атрибута первый компонент — три четверти `COLOR_0`
 * были бы отброшены молча.
 */
export const PAINT_CHANNEL = '_PAINT';

/** Сетка, с которой обязан совпасть grid-объект (TERR-2). */
export interface CellGridSpec {
  readonly width: number;
  readonly height: number;
  /** Размер клетки в МИРОВЫХ единицах: `tileSize` ассета, переведённый из Q16.16. */
  readonly cellSize: number;
}

/** Прочитанные клеточные данные: по одному значению на клетку, построчно. */
export interface CellGrid {
  readonly width: number;
  readonly height: number;
  /** Высота клетки в мировых единицах — вертикаль мира (glTF `+y`). */
  readonly heights: readonly number[];
  /** Значения запрошенных каналов; канала в экспорте нет — все нули. */
  readonly channels: Readonly<Record<string, readonly number[]>>;
  /**
   * Какие из запрошенных каналов экспорт ДЕЙСТВИТЕЛЬНО нёс. Нули канала,
   * которого в источнике нет, неотличимы от нулей нарисованных, а для
   * производного слоя это разные вещи: «источник его не даёт» означает, что
   * документ не переписывается вовсе (BLND-2).
   */
  readonly present: ReadonlySet<string>;
}

/** Результат чтения: сетка либо перечень ошибок с адресами клеток (BLND-6). */
export interface CellGridRead {
  readonly grid: CellGrid | null;
  readonly errors: readonly string[];
}

/** Шум float32 экспорта; всё, что крупнее, — правка автора, а не погрешность. */
export const HEIGHT_EPSILON = 1e-4;

/** Допуск попадания центра грани в центр клетки — в долях размера клетки. */
const CENTER_TOLERANCE = 0.25;

/** Сколько ошибок читатель называет, прежде чем замолчать: сломанная сетка их даёт по клетке. */
const ERROR_LIMIT = 16;

/** Сколько незакрытых адресов называет отказ покрытия: перечислять всю сетку незачем. */
const MISSING_LIMIT = 4;

/**
 * Адреса первых незаполненных ячеек сетки — не больше `MISSING_LIMIT`. Обход
 * общий у клеток и узлов: «сетка мельче ассета» ловится одинаково (TERR-2), и
 * второе его написание разошлось бы с первым молча.
 */
function missingAddresses(filled: readonly unknown[], width: number, height: number): readonly string[] {
  const missing: string[] = [];
  for (let y = 0; y < height && missing.length < MISSING_LIMIT; y++) {
    for (let x = 0; x < width && missing.length < MISSING_LIMIT; x++) {
      if (filled[y * width + x] === null) missing.push(`(${x}, ${y})`);
    }
  }
  return missing;
}

/**
 * Величина в сообщении. Позиции приезжают из float32, и «высота
 * 1.399999976158142» в отказе называет не то, что автор видит во вьюпорте
 * Blender; отброшенные разряды — заведомо ниже допуска `HEIGHT_EPSILON`, то
 * есть ниже того, что вообще различимо этими проверками.
 */
export function formatHeight(value: number): string {
  return Number.isFinite(value) ? String(Number(value.toFixed(4))) : String(value);
}

interface CellSlot {
  height: number;
  readonly channels: number[];
}

/** Узловые данные grid-объекта: по одному значению на узел (угол клетки), построчно. */
export interface NodeGrid {
  readonly width: number;
  readonly height: number;
  /** Высоты узлов в мировых единицах, ряды длины `width + 1`, рядов `height + 1`. */
  readonly heights: readonly number[];
}

/** Результат чтения узлов: сетка либо перечень ошибок с адресами узлов (BLND-6). */
export interface NodeGridRead {
  readonly grid: NodeGrid | null;
  readonly errors: readonly string[];
}

/**
 * Адрес узла, в который попадает вершина; `null` — вершина узел не адресует, и
 * находка об этом уже записана (BLND-6).
 */
function nodeAddressOf(
  fail: (message: string) => void,
  index: number,
  point: WorldPoint,
  spec: CellGridSpec,
  nodesX: number,
  nodesY: number,
): number | null {
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y) || !Number.isFinite(point.elevation)) {
    fail(`вершина ${index}: координата не является конечным числом`);
    return null;
  }
  const u = point.x / spec.cellSize;
  const v = point.y / spec.cellSize;
  const nx = Math.round(u);
  const ny = Math.round(v);
  if (Math.abs(u - nx) > CENTER_TOLERANCE || Math.abs(v - ny) > CENTER_TOLERANCE) {
    fail(
      `вершина (${formatHeight(point.x)}, ${formatHeight(point.y)}) не попадает в узел сетки: ` +
        `сетка сдвинута либо её трансформ не применён (CONVENTIONS.md)`,
    );
    return null;
  }
  if (nx < 0 || ny < 0 || nx >= nodesX || ny >= nodesY) {
    fail(`вершина адресует узел (${nx}, ${ny}) вне узловой сетки ${nodesX}×${nodesY} (TERR-2)`);
    return null;
  }
  return ny * nodesX + nx;
}

/**
 * Высоты узлов по вершинам меша: совпавшие в узле вершины обязаны согласиться с
 * точностью `HEIGHT_EPSILON` — так переживается сварка вершин экспортёром.
 * Заполняет `heights` на месте, находки уходят в `fail` (BLND-10).
 */
function fillNodeHeights(
  fail: (message: string) => void,
  geometry: MeshGeometry,
  world: readonly number[],
  spec: CellGridSpec,
  nodesX: number,
  nodesY: number,
  heights: (number | null)[],
): void {
  for (const [index, position] of geometry.positions.entries()) {
    const point = worldPoint(world, position);
    const at = nodeAddressOf(fail, index, point, spec, nodesX, nodesY);
    if (at === null) continue;
    const known = heights[at];
    if (known == null) {
      heights[at] = point.elevation;
      continue;
    }
    if (Math.abs(known - point.elevation) > HEIGHT_EPSILON) {
      const nx = at % nodesX;
      fail(
        `узел (${nx}, ${(at - nx) / nodesX}): вершины узла лежат на разной высоте ` +
          `(${formatHeight(known)} и ${formatHeight(point.elevation)})`,
      );
    }
  }
}

/**
 * Узловые данные объекта: вершины grid-меша — узлы сетки, углы клеток
 * (BLND-10). В отличие от клеточного читателя, грань здесь не обязана быть
 * плоской — скульпт свободен, значение несёт каждый узел сам.
 *
 * Вершина обязана попасть в узел с допуском четверти клетки (несведённый
 * трансформ ловится, шум float32 — нет); совпавшие в узле вершины обязаны
 * согласиться по высоте с точностью `HEIGHT_EPSILON` — так переживается
 * сварка вершин экспортёром. Узел без вершины — ошибка покрытия (TERR-2).
 */
export function readNodeGrid(document: GltfDocument, object: SourceObject, spec: CellGridSpec): NodeGridRead {
  const errors: string[] = [];
  const fail = (message: string): void => {
    if (errors.length < ERROR_LIMIT) errors.push(message);
  };

  if (object.mesh === null) {
    return { grid: null, errors: ['объект без геометрии: узловые данные читаются с grid-меша (BLND-10)'] };
  }
  if (!Number.isFinite(spec.cellSize) || spec.cellSize <= 0) {
    return { grid: null, errors: [`размер клетки ${spec.cellSize} не положителен (TERR-2)`] };
  }

  let geometry;
  try {
    geometry = readMeshGeometry(document, object.mesh, []);
  } catch (error) {
    return { grid: null, errors: [error instanceof GltfParseError ? error.message : String(error)] };
  }

  const nodesX = spec.width + 1;
  const nodesY = spec.height + 1;
  const heights = new Array<number | null>(nodesX * nodesY).fill(null);
  fillNodeHeights(fail, geometry, object.world, spec, nodesX, nodesY, heights);

  const missing = missingAddresses(heights, nodesX, nodesY);
  if (missing.length > 0) {
    fail(
      `узловая сетка не покрыта вершинами целиком: ${missing.length === 1 ? 'узел' : 'узлы'} ${missing.join(', ')}` +
        `${missing.length === MISSING_LIMIT ? ' и далее' : ''} — сетка мельче ассета ${nodesX}×${nodesY} (TERR-2)`,
    );
  }
  if (errors.length > 0) return { grid: null, errors };
  return {
    // Незаполненных узлов здесь уже нет: их назвала бы находка покрытия выше.
    grid: { width: spec.width, height: spec.height, heights: heights.map((value) => value!) },
    errors: [],
  };
}

/** Конечны ли плановые координаты точки; вертикаль проверяет `flatFace`. */
function planarFinite(point: WorldPoint): boolean {
  return Number.isFinite(point.x) && Number.isFinite(point.y);
}

/**
 * Адрес клетки грани — по её ОХВАТЫВАЮЩЕМУ ПРЯМОУГОЛЬНИКУ (см. шапку модуля);
 * `null` — грань клетку не адресует, и находка об этом уже записана (BLND-6).
 */
function cellAddressOf(
  fail: (message: string) => void,
  face: number,
  a: WorldPoint,
  b: WorldPoint,
  c: WorldPoint,
  spec: CellGridSpec,
): number | null {
  if (!planarFinite(a) || !planarFinite(b) || !planarFinite(c)) {
    fail(`грань ${face}: координата вершины не является конечным числом`);
    return null;
  }
  const centerX = (Math.min(a.x, b.x, c.x) + Math.max(a.x, b.x, c.x)) / 2;
  const centerY = (Math.min(a.y, b.y, c.y) + Math.max(a.y, b.y, c.y)) / 2;
  const u = centerX / spec.cellSize - 0.5;
  const v = centerY / spec.cellSize - 0.5;
  const x = Math.round(u);
  const y = Math.round(v);
  if (Math.abs(u - x) > CENTER_TOLERANCE || Math.abs(v - y) > CENTER_TOLERANCE) {
    fail(
      `грань ${face} с центром (${formatHeight(centerX)}, ${formatHeight(centerY)}) не попадает в центр ` +
        `клетки: сетка сдвинута ` +
        `либо её трансформ не применён (CONVENTIONS.md)`,
    );
    return null;
  }
  if (x < 0 || y < 0 || x >= spec.width || y >= spec.height) {
    fail(`грань ${face} адресует клетку (${x}, ${y}) вне сетки ${spec.width}×${spec.height} (TERR-2)`);
    return null;
  }
  return y * spec.width + x;
}

/** Совпала ли высота вершины с высотой грани — с точностью `HEIGHT_EPSILON`. */
function sameElevation(first: number, value: number): boolean {
  return Number.isFinite(value) && Math.abs(value - first) <= HEIGHT_EPSILON;
}

/**
 * Высота клетки — единая у всех её вершин: наклонённая грань не разрешается в
 * одно значение, и угадывать его импорт не вправе (BLND-9).
 */
function flatFace(a: WorldPoint, b: WorldPoint, c: WorldPoint): boolean {
  const first = a.elevation;
  if (!Number.isFinite(first)) return false;
  return sameElevation(first, b.elevation) && sameElevation(first, c.elevation);
}

/**
 * Значения каналов клетки — по первой вершине грани, но с проверкой единогласия
 * ВСЕХ её вершин: значение пишет аддон всем четырём сразу, и расхождение
 * означает правку мимо него. `null` — вершины разошлись, находка записана.
 */
function faceChannels(
  fail: (message: string) => void,
  geometry: MeshGeometry,
  channels: readonly string[],
  corners: readonly [number, number, number],
  x: number,
  y: number,
): number[] | null {
  const values = channels.map((name) => {
    const channel = geometry.attributes[name];
    if (channel === undefined || channel === null) return 0;
    return channel[corners[0]] ?? 0;
  });
  for (const [index, name] of channels.entries()) {
    const channel = geometry.attributes[name];
    if (channel === undefined || channel === null) continue;
    if (corners.every((corner) => (channel[corner] ?? 0) === values[index])) continue;
    fail(`клетка (${x}, ${y}): канал "${name}" различается у вершин грани`);
    return null;
  }
  return values;
}

/** Кладёт грань в её клетку; клетка, читанная другой гранью, обязана совпасть (BLND-9). */
function putFace(
  fail: (message: string) => void,
  cells: (CellSlot | null)[],
  at: number,
  x: number,
  y: number,
  height: number,
  values: number[],
  channels: readonly string[],
): void {
  const known = cells[at];
  if (known === null || known === undefined) {
    cells[at] = { height, channels: values };
    return;
  }
  if (Math.abs(known.height - height) > HEIGHT_EPSILON) {
    fail(
      `клетка (${x}, ${y}): грани клетки лежат на разной высоте ` +
        `(${formatHeight(known.height)} и ${formatHeight(height)})`,
    );
    return;
  }
  for (const [index, name] of channels.entries()) {
    if (known.channels[index] === values[index]) continue;
    fail(`клетка (${x}, ${y}): канал "${name}" различается у граней клетки`);
  }
}

/** Раскладывает грани меша по клеткам сетки; находки уходят в `fail` (BLND-9). */
function fillCells(
  fail: (message: string) => void,
  geometry: MeshGeometry,
  world: readonly WorldPoint[],
  spec: CellGridSpec,
  channels: readonly string[],
  cells: (CellSlot | null)[],
): void {
  for (let face = 0; face * 3 < geometry.triangles.length; face++) {
    // Длина списка индексов кратна трём — это проверяет разбор меша, поэтому
    // все три угла грани в нём заведомо есть.
    const corners: readonly [number, number, number] = [
      geometry.triangles[face * 3]!,
      geometry.triangles[face * 3 + 1]!,
      geometry.triangles[face * 3 + 2]!,
    ];
    const a = world[corners[0]];
    const b = world[corners[1]];
    const c = world[corners[2]];
    if (a === undefined || b === undefined || c === undefined) {
      fail(`грань ${face} ссылается на вершину вне меша`);
      continue;
    }
    const at = cellAddressOf(fail, face, a, b, c, spec);
    if (at === null) continue;
    const x = at % spec.width;
    const y = (at - x) / spec.width;
    if (!flatFace(a, b, c)) {
      fail(`клетка (${x}, ${y}): вершины грани лежат на разной высоте — клетка не плоская`);
      continue;
    }
    const values = faceChannels(fail, geometry, channels, corners, x, y);
    if (values === null) continue;
    putFace(fail, cells, at, x, y, a.elevation, values, channels);
  }
}

/** Сетка из разложенных клеток: по одному значению высоты и канала на клетку. */
function gridOfCells(
  cells: readonly (CellSlot | null)[],
  spec: CellGridSpec,
  channels: readonly string[],
  geometry: MeshGeometry,
): CellGrid {
  const total = spec.width * spec.height;
  const heights = new Array<number>(total);
  const read: Record<string, number[]> = {};
  const columns: number[][] = [];
  for (const name of channels) {
    const column = new Array<number>(total).fill(0);
    read[name] = column;
    columns.push(column);
  }
  for (let at = 0; at < total; at++) {
    // Незаполненных клеток здесь уже нет: их назвала бы находка покрытия.
    const cell = cells[at]!;
    heights[at] = cell.height;
    for (const [index, column] of columns.entries()) column[at] = cell.channels[index]!;
  }
  return {
    width: spec.width,
    height: spec.height,
    heights,
    channels: read,
    present: new Set(channels.filter((name) => geometry.attributes[name] != null)),
  };
}

/**
 * Клеточные данные объекта. Ошибки собираются все до предела перечисления и
 * возвращаются вместе с `null`: решать «писать или не писать» — вызывающему
 * (BLND-6), а этому читателю нечего писать.
 */
export function readCellGrid(
  document: GltfDocument,
  object: SourceObject,
  spec: CellGridSpec,
  channels: readonly string[] = [],
): CellGridRead {
  const errors: string[] = [];
  const fail = (message: string): void => {
    if (errors.length < ERROR_LIMIT) errors.push(message);
  };

  if (object.mesh === null) {
    return { grid: null, errors: ['объект без геометрии: клеточные данные читаются с grid-меша (BLND-9)'] };
  }
  if (!Number.isFinite(spec.cellSize) || spec.cellSize <= 0) {
    return { grid: null, errors: [`размер клетки ${spec.cellSize} не положителен (TERR-2)`] };
  }

  let geometry;
  try {
    geometry = readMeshGeometry(document, object.mesh, channels);
  } catch (error) {
    return { grid: null, errors: [error instanceof GltfParseError ? error.message : String(error)] };
  }

  const { width, height } = spec;
  const cells = new Array<CellSlot | null>(width * height).fill(null);
  const world = geometry.positions.map((position) => worldPoint(object.world, position));
  fillCells(fail, geometry, world, spec, channels, cells);

  const missing = missingAddresses(cells, width, height);
  if (missing.length > 0) {
    fail(
      `сетка не покрыта гранями целиком: клетк${missing.length === 1 ? 'а' : 'и'} ${missing.join(', ')}` +
        `${missing.length === MISSING_LIMIT ? ' и далее' : ''} — сетка мельче ассета ${width}×${height} (TERR-2)`,
    );
  }
  if (errors.length > 0) return { grid: null, errors };
  return { grid: gridOfCells(cells, spec, channels, geometry), errors: [] };
}
