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
 * шага авторинга (целый уровень — 1.0, ступень кривизны — 1/16), и заведомо
 * выше погрешности float32 на величинах порядка десятков. Центр грани обязан
 * попасть в центр клетки с точностью до четверти клетки — этого хватает, чтобы
 * поймать несведённый трансформ и не поймать шум.
 */
import { GltfParseError, readMeshGeometry, type GltfDocument } from './gltf.js';
import { worldPoint, type SourceObject } from './normalize.js';

/**
 * Каналы клеточных атрибутов в экспорте glTF. Аддон держит их атрибутами на
 * домене точек с именами `RAMP`/`NOFLOOR`, а штатный экспортёр отдаёт
 * пользовательские каналы с обязательным префиксом `_` (`CONVENTIONS.md`).
 */
export const RAMP_CHANNEL = '_RAMP';
export const NOFLOOR_CHANNEL = '_NOFLOOR';

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
  const total = width * height;
  const cells = new Array<CellSlot | null>(total).fill(null);
  const world = geometry.positions.map((position) => worldPoint(object.world, position));

  for (let face = 0; face * 3 < geometry.triangles.length; face++) {
    const corners = [
      geometry.triangles[face * 3]!,
      geometry.triangles[face * 3 + 1]!,
      geometry.triangles[face * 3 + 2]!,
    ];
    const points = corners.map((index) => world[index]);
    if (points.some((point) => point === undefined)) {
      fail(`грань ${face} ссылается на вершину вне меша`);
      continue;
    }
    const xs = points.map((point) => point!.x);
    const ys = points.map((point) => point!.y);
    if ([...xs, ...ys].some((value) => !Number.isFinite(value))) {
      fail(`грань ${face}: координата вершины не является конечным числом`);
      continue;
    }

    // Охватывающий прямоугольник грани равен прямоугольнику клетки — см. шапку.
    const centerX = (Math.min(...xs) + Math.max(...xs)) / 2;
    const centerY = (Math.min(...ys) + Math.max(...ys)) / 2;
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
      continue;
    }
    if (x < 0 || y < 0 || x >= width || y >= height) {
      fail(`грань ${face} адресует клетку (${x}, ${y}) вне сетки ${width}×${height} (TERR-2)`);
      continue;
    }

    // Высота клетки — единая у всех её вершин: наклонённая грань не разрешается
    // в одно значение, и угадывать его импорт не вправе (BLND-9).
    const elevations = corners.map((index) => world[index]!.elevation);
    const first = elevations[0]!;
    if (elevations.some((value) => !Number.isFinite(value) || Math.abs(value - first) > HEIGHT_EPSILON)) {
      fail(`клетка (${x}, ${y}): вершины грани лежат на разной высоте — клетка не плоская`);
      continue;
    }

    const values = channels.map((name) => {
      const channel = geometry.attributes[name];
      if (channel === undefined || channel === null) return 0;
      return channel[corners[0]!] ?? 0;
    });
    // Единогласие каналов — по всем вершинам грани, а не по первой: значение
    // пишет аддон всем четырём сразу, и расхождение означает правку мимо него.
    let disagreed = false;
    for (let c = 0; c < channels.length; c++) {
      const channel = geometry.attributes[channels[c]!];
      if (channel === undefined || channel === null) continue;
      for (const index of corners) {
        if ((channel[index] ?? 0) === values[c]) continue;
        fail(`клетка (${x}, ${y}): канал "${channels[c]}" различается у вершин грани`);
        disagreed = true;
        break;
      }
      if (disagreed) break;
    }
    if (disagreed) continue;

    const at = y * width + x;
    const known = cells[at];
    if (known === null || known === undefined) {
      cells[at] = { height: first, channels: values };
      continue;
    }
    if (Math.abs(known.height - first) > HEIGHT_EPSILON) {
      fail(
        `клетка (${x}, ${y}): грани клетки лежат на разной высоте ` +
          `(${formatHeight(known.height)} и ${formatHeight(first)})`,
      );
      continue;
    }
    for (let c = 0; c < channels.length; c++) {
      if (known.channels[c] === values[c]) continue;
      fail(`клетка (${x}, ${y}): канал "${channels[c]}" различается у граней клетки`);
    }
  }

  const missing: string[] = [];
  for (let y = 0; y < height && missing.length < 4; y++) {
    for (let x = 0; x < width && missing.length < 4; x++) {
      if (cells[y * width + x] === null) missing.push(`(${x}, ${y})`);
    }
  }
  if (missing.length > 0) {
    fail(
      `сетка не покрыта гранями целиком: клетк${missing.length === 1 ? 'а' : 'и'} ${missing.join(', ')}` +
        `${missing.length === 4 ? ' и далее' : ''} — сетка мельче ассета ${width}×${height} (TERR-2)`,
    );
  }
  if (errors.length > 0) return { grid: null, errors };

  const heights = new Array<number>(total);
  const read: Record<string, number[]> = {};
  for (const name of channels) read[name] = new Array<number>(total).fill(0);
  for (let at = 0; at < total; at++) {
    const cell = cells[at]!;
    heights[at] = cell.height;
    for (let c = 0; c < channels.length; c++) read[channels[c]!]![at] = cell.channels[c]!;
  }
  return { grid: { width, height, heights, channels: read }, errors: [] };
}
