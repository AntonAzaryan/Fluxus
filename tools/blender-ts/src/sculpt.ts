/**
 * Скалпт-поверхность как источник рельефа (BLND-13): объединение sculpt-мешей
 * источника, сэмплирование его высоты по решётке и деривация клеточных данных.
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
 * Перевод высот в символы карт и валидация ассета — `maps.ts` тем же путём, что
 * у grid-объектов (BLND-9): этот модуль отвечает на вопрос «какова высота
 * скалпта в точке» и «какие уровни/флаги из этого следуют числами», а формат —
 * вопрос ядра.
 */
import type { TerrainGrid } from '@fluxus/core';
import { cornerLevels } from '@fluxus/render/visualSurface';
import type { CellGridSpec } from './cells.js';
import { GltfParseError, readMeshGeometry, type GltfDocument } from './gltf.js';
import { byObjectName } from './layer.js';
import { hasSingleSemantic, worldPoint, type SourceObject } from './normalize.js';

/** Семантическое свойство скалпт-поверхности (BLND-3, BLND-13). */
const SCULPT_KEY = 'sculpt';

/**
 * Custom property порога обрыва на sculpt-объекте (BLND-13): скачок высоты на
 * границе клеток НЕ НИЖЕ порога — обрыв, ниже — непрерывный склон и рампа.
 * Единица — шаг высоты (уровень). Число автора, а не константа импортёра.
 */
const CLIFF_JUMP_KEY = 'cliffJump';

/** Умолчание порога обрыва — пол-уровня (CONVENTIONS.md, «Sculpt-объекты»). */
const DEFAULT_CLIFF_JUMP = 0.5;

/**
 * Отступ выборки от края арены и от границы клеток — в долях клетки. Крайняя
 * вершина скалпта лежит ровно на краю арены с точностью float32 экспорта, и
 * выборка «ровно в ребро» зависела бы от его шума; отступ уводит её внутрь
 * заведомо дальше этого шума и заведомо мельче всего, что различает квантование.
 */
const EDGE_INSET_RATIO = 1 / 64;

/**
 * Число интервалов выборки непрерывности на отрезке между центрами пары клеток.
 * Обрыв ловится ЛЮБОЙ своей позицией внутри пары: скачок целого уровня попадает
 * в один из интервалов и превышает порог, а гладкий склон проходит, пока его
 * крутизна ниже `порог × интервалы` уровней на клетку (при умолчаниях — 4).
 */
const CONTINUITY_INTERVALS = 8;

/** Относительный допуск принадлежности точки проекции треугольника. */
const BARYCENTRIC_TOLERANCE = 1e-9;

/** Сколько ошибок сэмплер называет, прежде чем замолчать (как у cells.ts). */
const ERROR_LIMIT = 16;

/** Sculpt-объекты источника в порядке имён (BLND-4). */
export function sculptObjectsOf(objects: readonly SourceObject[]): readonly SourceObject[] {
  return objects.filter((object) => hasSingleSemantic(object, SCULPT_KEY)).sort(byObjectName);
}

/** Высота объединения скалпта в точке плана; `null` — геометрии над точкой нет. */
export interface SculptSampler {
  heightAt(x: number, y: number): number | null;
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
 */
function appendObjectTriangles(
  document: GltfDocument,
  object: SourceObject,
  fail: (object: string, message: string) => void,
  triangles: Triangle[],
): void {
  if (object.mesh === null) {
    fail(object.name, 'объект без геометрии: скалпт-поверхность читается с меша (BLND-13)');
    return;
  }
  let geometry;
  try {
    geometry = readMeshGeometry(document, object.mesh, []);
  } catch (error) {
    fail(object.name, error instanceof GltfParseError ? error.message : String(error));
    return;
  }
  const world = geometry.positions.map((position) => worldPoint(object.world, position));
  for (const point of world) {
    if (Number.isFinite(point.x) && Number.isFinite(point.y) && Number.isFinite(point.elevation)) continue;
    fail(object.name, 'координата вершины не является конечным числом');
    return;
  }
  for (let face = 0; face * 3 < geometry.triangles.length; face++) {
    // Длина списка индексов кратна трём — это проверяет разбор меша.
    const a = world[geometry.triangles[face * 3]!];
    const b = world[geometry.triangles[face * 3 + 1]!];
    const c = world[geometry.triangles[face * 3 + 2]!];
    if (a === undefined || b === undefined || c === undefined) {
      fail(object.name, `грань ${face} ссылается на вершину вне меша`);
      continue;
    }
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
    });
  }
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

/** Высота объединения в точке — максимум по пересечениям её клетки (BLND-13). */
function createSampler(
  triangles: readonly Triangle[],
  buckets: readonly (readonly number[])[],
  spec: CellGridSpec,
): SculptSampler {
  const { width, height, cellSize } = spec;
  return {
    heightAt(x: number, y: number): number | null {
      const at = clampIndex(Math.floor(y / cellSize), height) * width + clampIndex(Math.floor(x / cellSize), width);
      let best: number | null = null;
      // Индекс зажат границами сетки, корзина по нему есть всегда.
      for (const index of buckets[at]!) {
        const elevation = intersectHeight(triangles[index]!, x, y);
        if (elevation === null) continue;
        if (best === null || elevation > best) best = elevation;
      }
      return best;
    },
  };
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
  for (const object of objects) appendObjectTriangles(document, object, fail, triangles);
  if (errors.length > 0) return { sampler: null, errors };

  return { sampler: createSampler(triangles, bucketTriangles(triangles, spec), spec), errors: [] };
}

/**
 * Порог обрыва из custom properties sculpt-объектов: свойство законно на любом
 * из них, разные значения — ошибка (BLND-13, «у параметра один источник»).
 * Возвращается пара «значение, находки»; при находках значение — умолчание.
 */
export function cliffJumpOf(objects: readonly SourceObject[]): {
  readonly value: number;
  readonly errors: readonly { readonly object: string; readonly message: string }[];
} {
  const errors: { object: string; message: string }[] = [];
  let found: { object: string; value: number } | null = null;
  for (const object of objects) {
    const raw = object.extras[CLIFF_JUMP_KEY];
    if (raw === undefined) continue;
    if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) {
      errors.push({
        object: object.name,
        message: `"${CLIFF_JUMP_KEY}": порог обрыва — положительное число шагов высоты, а не ${JSON.stringify(raw)} (BLND-13)`,
      });
      continue;
    }
    if (found === null) {
      found = { object: object.name, value: raw };
      continue;
    }
    // Допуск — про float32: значение из панели аддона хранится одинарной
    // точностью, а то же число, введённое руками в Custom Properties, — двойной,
    // и «0.7 ≠ 0.7» превращалось бы в ложный отказ «разные значения».
    if (Math.abs(raw - found.value) > 1e-6) {
      errors.push({
        object: object.name,
        message:
          `"${CLIFF_JUMP_KEY}": значение ${raw} расходится с ${found.value} объекта "${found.object}" — ` +
          `у параметра один источник (BLND-13)`,
      });
    }
  }
  return { value: errors.length === 0 && found !== null ? found.value : DEFAULT_CLIFF_JUMP, errors };
}

/** Клеточные данные, выведенные из скалпта, — числа до перевода в символы карт. */
export interface SculptCells {
  /** Высота клетки в единицах Blender: `уровень × LEVEL_UNIT`. */
  readonly heights: readonly number[];
  readonly ramps: readonly number[];
  readonly noFloor: readonly number[];
  /** Клетки, чья высота даёт уровень вне алфавита, — с сырой высотой для отказа. */
  readonly outOfRange: readonly { readonly x: number; readonly y: number; readonly height: number }[];
}

/** Рабочие массивы деривации: по одному значению на клетку сетки цели. */
interface CellArrays {
  readonly heights: number[];
  /** Уровень клетки; `null` — ещё не назначен (дыра либо клетка вне алфавита). */
  readonly levels: (number | null)[];
  readonly ramps: number[];
  readonly noFloor: number[];
  readonly outOfRange: { x: number; y: number; height: number }[];
}

/**
 * Уровень клетки — высота её ЦЕНТРА, квантованная к ближайшему целому; уровень
 * вне алфавита схемы собирается в `outOfRange` вместе с сырой высотой. Нет
 * пересечения над центром — клетка без пола `_` (дыра — инструмент).
 */
function sampleCellLevels(
  sampler: SculptSampler,
  spec: CellGridSpec,
  maxLevel: number,
  levelUnit: number,
  cells: CellArrays,
): void {
  const { width, height, cellSize } = spec;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const at = y * width + x;
      const sampled = sampler.heightAt((x + 0.5) * cellSize, (y + 0.5) * cellSize);
      if (sampled === null) {
        cells.noFloor[at] = 1;
        continue;
      }
      const level = Math.round(sampled / levelUnit);
      if (level < 0 || level > maxLevel) {
        cells.outOfRange.push({ x, y, height: sampled });
        continue;
      }
      cells.levels[at] = level;
      cells.heights[at] = level * levelUnit;
    }
  }
}

/** Кольцо волны: соседи-дыры клетки берут её уровень, если он старше уже взятого. */
function spreadHoleLevel(
  ring: Map<number, number>,
  cells: CellArrays,
  spec: CellGridSpec,
  at: number,
  level: number,
): void {
  const { width, height } = spec;
  const x = at % width;
  const y = (at - x) / width;
  for (const neighbor of [
    x > 0 ? at - 1 : -1,
    x + 1 < width ? at + 1 : -1,
    y > 0 ? at - width : -1,
    y + 1 < height ? at + width : -1,
  ]) {
    if (neighbor < 0 || cells.noFloor[neighbor] !== 1 || cells.levels[neighbor] !== null) continue;
    const known = ring.get(neighbor);
    if (known === undefined || level > known) ring.set(neighbor, level);
  }
}

/**
 * Уровень клеток без пола — волной от клеток с полом: кольцо за кольцом, в
 * кольце каждая дыра берёт СТАРШИЙ уровень среди примыкающих присвоенных.
 * Уровень дыры не мёртвые данные: из него строятся клифы (TERR-5) и высота
 * восстановленного по ходу матча пола (TERR-3), и ноль дырявил бы плато ложным
 * кольцом обрывов. Порядок обхода на результат не влияет (максимум
 * коммутативен), недостижимые дырами от края до края клетки остаются на нуле.
 */
function fillHoleLevels(spec: CellGridSpec, levelUnit: number, cells: CellArrays): void {
  const total = spec.width * spec.height;
  let frontier: number[] = [];
  for (let at = 0; at < total; at++) if (cells.levels[at] !== null) frontier.push(at);
  while (frontier.length > 0) {
    const ring = new Map<number, number>();
    // Уровень клетки фронта присвоен по построению фронта.
    for (const at of frontier) spreadHoleLevel(ring, cells, spec, at, cells.levels[at]!);
    frontier = [];
    for (const [at, level] of [...ring.entries()].sort(([a], [b]) => a - b)) {
      frontier.push(at);
      cells.levels[at] = level;
      cells.heights[at] = level * levelUnit;
    }
  }
}

/**
 * Пара соседних клеток с перепадом в единицу: отрезок между их центрами
 * сэмплируется `CONTINUITY_INTERVALS` интервалами, и если максимальный скачок
 * между соседними выборками ниже порога обрыва, рампу получает НИЖНЯЯ клетка
 * пары (TERR-5). Обрыв ловится любой своей позицией внутри пары, а не только у
 * самой границы; помечается всегда нижняя клетка, поэтому от порядка обхода
 * результат не зависит.
 */
function considerRamp(
  sampler: SculptSampler,
  spec: CellGridSpec,
  cells: CellArrays,
  threshold: number,
  aX: number,
  aY: number,
  bX: number,
  bY: number,
): void {
  const { width, cellSize } = spec;
  const a = aY * width + aX;
  const b = bY * width + bX;
  if (cells.noFloor[a] === 1 || cells.noFloor[b] === 1) return;
  const levelA = cells.levels[a] ?? null;
  const levelB = cells.levels[b] ?? null;
  if (levelA === null || levelB === null || Math.abs(levelA - levelB) !== 1) return;
  const fromX = (aX + 0.5) * cellSize;
  const fromY = (aY + 0.5) * cellSize;
  const stepX = ((bX - aX) * cellSize) / CONTINUITY_INTERVALS;
  const stepY = ((bY - aY) * cellSize) / CONTINUITY_INTERVALS;
  let previous: number | null = null;
  for (let i = 0; i <= CONTINUITY_INTERVALS; i++) {
    const sampled = sampler.heightAt(fromX + stepX * i, fromY + stepY * i);
    // Разрыв геометрии на отрезке (щель уже клетки) — та же непроходимость,
    // что и скачок: рампы нет.
    if (sampled === null) return;
    if (previous !== null && Math.abs(sampled - previous) >= threshold) return;
    previous = sampled;
  }
  cells.ramps[levelA < levelB ? a : b] = 1;
}

/** Рампы по всем парам соседних клеток — вправо и вниз: пара считается один раз. */
function markRamps(
  sampler: SculptSampler,
  spec: CellGridSpec,
  cliffJump: number,
  levelUnit: number,
  cells: CellArrays,
): void {
  const threshold = cliffJump * levelUnit;
  const { width, height } = spec;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (x + 1 < width) considerRamp(sampler, spec, cells, threshold, x, y, x + 1, y);
      if (y + 1 < height) considerRamp(sampler, spec, cells, threshold, x, y, x, y + 1);
    }
  }
}

/**
 * Уровни, пол и рампы из объединения скалпта (BLND-13):
 *
 * - уровень — высота центра клетки, квантованная к ближайшему целому; уровень
 *   вне алфавита схемы собирается в `outOfRange` вместе с сырой высотой — отказ
 *   обязан называть клетку И ЕЁ ВЫСОТУ, а не уже квантованный уровень
 *   (`sampleCellLevels`);
 * - нет пересечения над центром — клетка без пола `_`, а её уровень берётся
 *   волной от ближайших клеток с полом (`fillHoleLevels`);
 * - рампа — непрерывность на отрезке между центрами пары клеток с перепадом в
 *   единицу (`markRamps`, TERR-5).
 */
export function deriveSculptCells(
  sampler: SculptSampler,
  spec: CellGridSpec,
  cliffJump: number,
  maxLevel: number,
  levelUnit: number,
): SculptCells {
  const total = spec.width * spec.height;
  const cells: CellArrays = {
    heights: new Array<number>(total).fill(0),
    levels: new Array<number | null>(total).fill(null),
    ramps: new Array<number>(total).fill(0),
    noFloor: new Array<number>(total).fill(0),
    outOfRange: [],
  };

  sampleCellLevels(sampler, spec, maxLevel, levelUnit, cells);
  fillHoleLevels(spec, levelUnit, cells);
  markRamps(sampler, spec, cliffJump, levelUnit, cells);

  return {
    heights: cells.heights,
    ramps: cells.ramps,
    noFloor: cells.noFloor,
    outOfRange: cells.outOfRange,
  };
}

/**
 * Выборка скалпта в узле сетки. Узел сэмплируется в своей точной позиции;
 * крайний узел арены при промахе (край меша разошёлся с краем арены на шум
 * float32 экспорта) пересэмплируется с отступом внутрь. Отступ — запасной ход,
 * а не правило: на наклонной поверхности выборка с отступом сдвинула бы
 * крайний узел на пол-кванта решётки, и у арены появился бы шов из ничего.
 */
export function sampleNodeHeight(
  sampler: SculptSampler,
  spec: CellGridSpec,
  nodeX: number,
  nodeY: number,
): number | null {
  const exact = sampler.heightAt(nodeX * spec.cellSize, nodeY * spec.cellSize);
  if (exact !== null) return exact;
  const boundary = nodeX === 0 || nodeY === 0 || nodeX === spec.width || nodeY === spec.height;
  if (!boundary) return null;
  const inset = spec.cellSize * EDGE_INSET_RATIO;
  const x = nodeX === 0 ? inset : nodeX === spec.width ? spec.width * spec.cellSize - inset : nodeX * spec.cellSize;
  const y = nodeY === 0 ? inset : nodeY === spec.height ? spec.height * spec.cellSize - inset : nodeY * spec.cellSize;
  return sampler.heightAt(x, y);
}

/**
 * Узловая высота ступенчатой террейн-формы в уровнях: максимум по значениям
 * `cornerLevels` примыкающих клеток. Правило углов — ТО ЖЕ, что у визуальной
 * поверхности рендера (REND-9): второй реализации BLND-13 не допускает, иначе
 * остаток кривизны перестал бы восстанавливать скалпт. Максимум — выбор верхней
 * кромки: выборка скалпта у обрыва ложится на верхнюю поверхность, и точной
 * обязана быть она. В узлах прямой цепочки — там, где в общий угол пары не
 * тянет второе ребро клетки, — выбирать не из чего: пара смыкается по уровню
 * верхней клетки (REND-9), и длинный склон остаток восстанавливает точно;
 * неоднозначны узлы обрыва и углы со вторым притяжением (BLND-13).
 */
export function nodeBaseLevels(grid: TerrainGrid): Float64Array {
  const nodesX = grid.width + 1;
  const nodesY = grid.height + 1;
  const base = new Float64Array(nodesX * nodesY).fill(Number.NEGATIVE_INFINITY);
  const raise = (nodeX: number, nodeY: number, level: number): void => {
    const at = nodeY * nodesX + nodeX;
    if (level > base[at]!) base[at] = level;
  };
  for (let y = 0; y < grid.height; y++) {
    for (let x = 0; x < grid.width; x++) {
      const corners = cornerLevels(grid, x, y);
      raise(x, y, corners[0]);
      raise(x + 1, y, corners[1]);
      raise(x + 1, y + 1, corners[2]);
      raise(x, y + 1, corners[3]);
    }
  }
  return base;
}
