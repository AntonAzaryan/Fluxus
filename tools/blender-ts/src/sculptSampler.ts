/**
 * Сэмплер скалпт-поверхности (BLND-13): объединение sculpt-мешей источника и
 * ответ на единственный вопрос — что лежит над точкой плана.
 *
 * ## Объединение — правило верхнего пересечения, не булева операция
 *
 * Высота точки — максимум по вертикальным пересечениям со ВСЕМИ треугольниками
 * всех sculpt-объектов. Пересечения и наложения мешей легальны, замкнутость не
 * требуется, а максимум коммутативен — результат не зависит от порядка объектов
 * (BLND-13). Blender объединить за нас не может: экспорт идёт с
 * `export_apply=False`, и boolean-модификаторы в glTF не попадают.
 *
 * ## Вертикальный луч без Möller–Trumbore
 *
 * Луч строго вертикален, поэтому пересечение — это попадание точки `(x, y)` в
 * проекцию треугольника на план и барицентрическая интерполяция высоты. Вырож-
 * денные в проекции треугольники (вертикальные стенки) высоты не определяют и
 * пропускаются: у стенки нет «высоты поверхности», она соединяет два уровня.
 *
 * ## Канал раскраски едет с геометрией
 *
 * Слот клетки у скалпта — значение канала `_PAINT` у той грани, что дала
 * верхнее пересечение (BLND-14). Поэтому выборка отдаёт не одну высоту, а пару
 * «высота и состояние канала»: второго правила «верхнего пересечения» для
 * раскраски не заводится.
 *
 * ## Детерминизм
 *
 * Вход — байты glTF, выход — числа из чистой арифметики IEEE-754 без порядковой
 * зависимости (максимум) и без источников недетерминизма; один источник даёт
 * байт-в-байт те же слои (BLND-4). Ускоряющая решётка меняет только порядок
 * ПРОВЕРОК, не значения: кандидаты берутся по клетке точки, а треугольник кладёт
 * себя во все клетки своего bbox.
 *
 * ## Что здесь НЕ решается
 *
 * Что из высот следует для карт — вопрос `sculpt.ts` (уровни, пол, рампы,
 * остаток кривизны), а формат карт — вопрос ядра и `maps.ts`.
 *
 * Выборка отдаёт `SculptHit` объектом, а не парой чисел: это инструмент времени
 * авторинга (BLND-7), потикового пути здесь нет, и дисциплина аллокаций ядра
 * (CLAUDE.md, «Allocation discipline») к нему не применяется — за читаемость
 * правила верхнего пересечения платится одним маленьким объектом на выборку.
 */
import { PAINT_CHANNEL, type CellGridSpec } from './cells.js';
import { GltfParseError, readMeshGeometry, type GltfDocument } from './gltf.js';
import { worldPoint, type SourceObject } from './normalize.js';

/**
 * Отступ выборки от края арены и от границы клеток — в долях клетки. Крайняя
 * вершина скалпта лежит ровно на краю арены с точностью float32 экспорта, и
 * выборка «ровно в ребро» зависела бы от его шума; отступ уводит её внутрь
 * заведомо дальше этого шума и заведомо мельче всего, что различает квантование.
 */
export const EDGE_INSET_RATIO = 1 / 64;

/** Относительный допуск принадлежности точки проекции треугольника. */
const BARYCENTRIC_TOLERANCE = 1e-9;

/** Сколько ошибок сэмплер называет, прежде чем замолчать (как у cells.ts). */
const ERROR_LIMIT = 16;

/**
 * Верхнее пересечение в точке плана: высота поверхности и состояние канала
 * раскраски у той геометрии, что это пересечение дала (BLND-14).
 */
export interface SculptHit {
  /** Высота поверхности в мировых единицах. */
  readonly elevation: number;
  /** Значение канала раскраски у грани; `null` — объект канала не несёт. */
  readonly paint: number | null;
  /** Вершины грани разошлись значениями канала: выбирать импорт не вправе. */
  readonly paintSplit: boolean;
  /** Имя объекта Blender — адрес находки (BLND-6). */
  readonly object: string;
}

/** Высота объединения скалпта в точке плана; `null` — геометрии над точкой нет. */
export interface SculptSampler {
  heightAt(x: number, y: number): number | null;
  /**
   * То же пересечение целиком — с каналом раскраски. Отдельного правила
   * «верхнего пересечения» у раскраски нет: слот берётся у ТОЙ ЖЕ геометрии,
   * что дала высоту (BLND-14).
   */
  topAt(x: number, y: number): SculptHit | null;
  /**
   * Несёт ли канал раскраски хоть один объект объединения. Спрашивается
   * НАЛИЧИЕ, а не значения: нули отсутствующего канала неотличимы от
   * нарисованных, и «источник раскраски не даёт» — это отдельный от «покрашено
   * нулевым слотом» случай (BLND-14, BLND-2).
   */
  readonly painted: boolean;
}

export interface SculptSamplerRead {
  readonly sampler: SculptSampler | null;
  /** Ошибки геометрии с именем объекта-виновника (BLND-6). */
  readonly errors: readonly { readonly object: string; readonly message: string }[];
}

interface Triangle {
  readonly ax: number;
  readonly ay: number;
  readonly az: number;
  readonly bx: number;
  readonly by: number;
  readonly bz: number;
  readonly cx: number;
  readonly cy: number;
  readonly cz: number;
  /** Имя объекта-владельца: адрес находки о ЕГО грани (BLND-6). */
  readonly object: string;
  /** Значение канала раскраски у вершин грани; `null` — объекта канал не несёт. */
  readonly paint: number | null;
  /** Вершины грани разошлись значениями канала (BLND-14). */
  readonly paintSplit: boolean;
}

/**
 * Ранг канала грани в сравнении кандидатов на РАВНОЙ высоте (BLND-14).
 * Геометрия без канала уступает любой несущей канал (`−∞`), а расходящаяся
 * грань старше любого слота (`+∞`): при ничьей с корректной гранью она обязана
 * выиграть и дать отказ, иначе расхождение тонуло бы в ничьей молча.
 */
function paintRank(triangle: Triangle): number {
  if (triangle.paintSplit) return Number.POSITIVE_INFINITY;
  return triangle.paint ?? Number.NEGATIVE_INFINITY;
}

/** Почему по такой сетке скалпт разложить нельзя; `null` — сетка годна (TERR-2). */
function specRefusal(spec: CellGridSpec): string | null {
  if (!Number.isFinite(spec.cellSize) || spec.cellSize <= 0) {
    return `размер клетки ${spec.cellSize} не положителен (TERR-2)`;
  }
  if (!Number.isInteger(spec.width) || !Number.isInteger(spec.height) || spec.width <= 0 || spec.height <= 0) {
    // Ассет с нецелой или неположительной сеткой отвергает и ядро; здесь отказ
    // нужен ДО раскладки по клеткам — иначе индекс корзины уехал бы за массив.
    return `сетка ${spec.width}×${spec.height} не является целой положительной (TERR-2)`;
  }
  return null;
}

/** Индекс клетки, зажатый границами сетки: и по x, и по y — правило одно. */
function clampIndex(value: number, size: number): number {
  return Math.min(Math.max(value, 0), size - 1);
}

/**
 * Треугольники одного sculpt-объекта в мировых величинах конвейера
 * (`worldPoint` — то же соответствие осей, что у размещений). Находки уходят в
 * `fail`; объект с нечисловой вершиной не даёт ни одного треугольника.
 *
 * Канал раскраски читается тем же чтением геометрии (BLND-14): значение слота
 * принадлежит грани, а не клетке, — клеток у скалпта нет.
 */
function appendObjectTriangles(
  document: GltfDocument,
  object: SourceObject,
  fail: (object: string, message: string) => void,
  triangles: Triangle[],
): boolean {
  if (object.mesh === null) {
    fail(object.name, 'объект без геометрии: скалпт-поверхность читается с меша (BLND-13)');
    return false;
  }
  let geometry;
  try {
    geometry = readMeshGeometry(document, object.mesh, [PAINT_CHANNEL]);
  } catch (error) {
    fail(object.name, error instanceof GltfParseError ? error.message : String(error));
    return false;
  }
  // `null` — канала нет НИ У ОДНОГО примитива объекта, то есть объект его не
  // несёт; нули у части примитивов — значение по умолчанию нового атрибута.
  const paint = geometry.attributes[PAINT_CHANNEL] ?? null;
  const world = geometry.positions.map((position) => worldPoint(object.world, position));
  for (const point of world) {
    if (Number.isFinite(point.x) && Number.isFinite(point.y) && Number.isFinite(point.elevation)) continue;
    fail(object.name, 'координата вершины не является конечным числом');
    return paint !== null;
  }
  for (let face = 0; face * 3 < geometry.triangles.length; face++) {
    // Длина списка индексов кратна трём — это проверяет разбор меша.
    const corners = [
      geometry.triangles[face * 3]!,
      geometry.triangles[face * 3 + 1]!,
      geometry.triangles[face * 3 + 2]!,
    ] as const;
    const a = world[corners[0]];
    const b = world[corners[1]];
    const c = world[corners[2]];
    if (a === undefined || b === undefined || c === undefined) {
      fail(object.name, `грань ${face} ссылается на вершину вне меша`);
      continue;
    }
    // Единогласие ВЕРШИН ГРАНИ (BLND-14): расхождение здесь не отказ — грань
    // могла и не решать ни одной клетки, — а признак, с которым разбирается
    // выборка, попавшая именно в неё.
    const values = paint === null ? null : corners.map((corner) => paint[corner] ?? 0);
    triangles.push({
      ax: a.x,
      ay: a.y,
      az: a.elevation,
      bx: b.x,
      by: b.y,
      bz: b.elevation,
      cx: c.x,
      cy: c.y,
      cz: c.elevation,
      object: object.name,
      paint: values?.[0] ?? null,
      paintSplit: values !== null && (values[0] !== values[1] || values[0] !== values[2]),
    });
  }
  return paint !== null;
}

/**
 * Ускоряющая решётка: треугольник кладёт себя во все клетки своего bbox (с
 * запасом на отступ выборок), выборка смотрит только клетку точки. Меняется от
 * неё порядок ПРОВЕРОК, а не значения (BLND-4).
 */
function bucketTriangles(triangles: readonly Triangle[], spec: CellGridSpec): readonly (readonly number[])[] {
  const { width, height, cellSize } = spec;
  const margin = cellSize * EDGE_INSET_RATIO;
  const buckets: number[][] = Array.from({ length: width * height }, () => []);
  for (const [index, t] of triangles.entries()) {
    const x0 = clampIndex(Math.floor((Math.min(t.ax, t.bx, t.cx) - margin) / cellSize), width);
    const x1 = clampIndex(Math.floor((Math.max(t.ax, t.bx, t.cx) + margin) / cellSize), width);
    const y0 = clampIndex(Math.floor((Math.min(t.ay, t.by, t.cy) - margin) / cellSize), height);
    const y1 = clampIndex(Math.floor((Math.max(t.ay, t.by, t.cy) + margin) / cellSize), height);
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) buckets[y * width + x]!.push(index);
    }
  }
  return buckets;
}

/**
 * Высота вертикального пересечения луча `(x, y)` с треугольником; `null` — луч
 * мимо его проекции либо треугольник в проекции вырожден (вертикальная стенка
 * высоты поверхности не определяет).
 */
function intersectHeight(t: Triangle, x: number, y: number): number | null {
  // Знаковые площади подтреугольников: точка внутри, когда все три одного
  // знака (с допуском на float32); нулевая полная площадь — стенка.
  const area = (t.bx - t.ax) * (t.cy - t.ay) - (t.by - t.ay) * (t.cx - t.ax);
  const scale = Math.abs(area);
  const tolerance =
    BARYCENTRIC_TOLERANCE *
    Math.max(1, Math.abs(t.ax), Math.abs(t.ay), Math.abs(t.bx), Math.abs(t.by), Math.abs(t.cx), Math.abs(t.cy)) ** 2;
  if (scale <= tolerance) return null;
  const wa = ((t.bx - x) * (t.cy - y) - (t.by - y) * (t.cx - x)) / area;
  const wb = ((t.cx - x) * (t.ay - y) - (t.cy - y) * (t.ax - x)) / area;
  const wc = 1 - wa - wb;
  // Кламп сверху: у почти вырожденного треугольника `tolerance / scale`
  // растёт без предела, и точка ВНЕ его проекции принималась бы с
  // экстраполированной высотой.
  const slack = Math.min(tolerance / scale, 1e-6);
  if (wa < -slack || wb < -slack || wc < -slack) return null;
  return wa * t.az + wb * t.bz + wc * t.cz;
}

/**
 * Верхнее пересечение в точке — максимум по пересечениям её клетки (BLND-13).
 *
 * Сравнение кандидатов ПОЛНОЕ: сперва высота, при её равенстве — ранг канала
 * (`paintRank`). Строгого «выше» одного мало: две плоские пластины на одном
 * уровне — обычное дело у наложенных примитивов, и «первый встреченный» зависел
 * бы от порядка объектов, чего BLND-13 не допускает. Ничья и по рангу означает
 * одинаковые данные, и разрешает её порядок треугольников — функция от пары
 * «имя объекта, номер грани», потому что объекты отсортированы по имени
 * (BLND-4).
 */
function createSampler(
  triangles: readonly Triangle[],
  buckets: readonly (readonly number[])[],
  spec: CellGridSpec,
  painted: boolean,
): SculptSampler {
  const { width, height, cellSize } = spec;
  const sampler: SculptSampler = {
    painted,
    topAt(x: number, y: number): SculptHit | null {
      const at = clampIndex(Math.floor(y / cellSize), height) * width + clampIndex(Math.floor(x / cellSize), width);
      let best: Triangle | null = null;
      let bestElevation = 0;
      // Индекс зажат границами сетки, корзина по нему есть всегда.
      for (const index of buckets[at]!) {
        const triangle = triangles[index]!;
        const elevation = intersectHeight(triangle, x, y);
        if (elevation === null) continue;
        if (best === null || elevation > bestElevation) {
          best = triangle;
          bestElevation = elevation;
          continue;
        }
        if (elevation === bestElevation && paintRank(triangle) > paintRank(best)) best = triangle;
      }
      if (best === null) return null;
      return { elevation: bestElevation, paint: best.paint, paintSplit: best.paintSplit, object: best.object };
    },
    heightAt(x: number, y: number): number | null {
      return sampler.topAt(x, y)?.elevation ?? null;
    },
  };
  return sampler;
}

/**
 * Сэмплер объединения sculpt-объектов. Треугольники приводятся в мировые
 * величины конвейера (`worldPoint` — то же соответствие осей, что у размещений)
 * и раскладываются по клеткам сетки цели: кандидаты выборки — клетка точки.
 */
export function buildSculptSampler(
  document: GltfDocument,
  objects: readonly SourceObject[],
  spec: CellGridSpec,
): SculptSamplerRead {
  const refusal = specRefusal(spec);
  if (refusal !== null) {
    return { sampler: null, errors: [{ object: objects[0]?.name ?? '', message: refusal }] };
  }

  const errors: { object: string; message: string }[] = [];
  const fail = (object: string, message: string): void => {
    if (errors.length < ERROR_LIMIT) errors.push({ object, message });
  };
  const triangles: Triangle[] = [];
  let painted = false;
  // Раскраска у ОБЪЕДИНЕНИЯ есть, если канал объявлен хотя бы одним объектом
  // (BLND-14): нераскрашенный объект рядом с раскрашенным — не «раскраски нет»,
  // а клетка без данных, и разбирается она выборкой.
  for (const object of objects) painted = appendObjectTriangles(document, object, fail, triangles) || painted;
  if (errors.length > 0) return { sampler: null, errors };

  return {
    sampler: createSampler(triangles, bucketTriangles(triangles, spec), spec, painted),
    errors: [],
  };
}
