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
import type { TerrainGrid } from '@game-mvp/core';
import { cornerLevels } from '@game-mvp/render/visualSurface';
import type { CellGridSpec } from './cells.js';
import { GltfParseError, readMeshGeometry, type GltfDocument } from './gltf.js';
import { worldPoint, type SourceObject } from './normalize.js';

/** Семантическое свойство скалпт-поверхности (BLND-3, BLND-13). */
export const SCULPT_KEY = 'sculpt';

/**
 * Custom property порога обрыва на sculpt-объекте (BLND-13): скачок высоты на
 * границе клеток НЕ НИЖЕ порога — обрыв, ниже — непрерывный склон и рампа.
 * Единица — шаг высоты (уровень). Число автора, а не константа импортёра.
 */
export const CLIFF_JUMP_KEY = 'cliffJump';

/** Умолчание порога обрыва — пол-уровня (CONVENTIONS.md, «Sculpt-объекты»). */
export const DEFAULT_CLIFF_JUMP = 0.5;

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
  return objects
    .filter((object) => object.semantics.length === 1 && object.semantics[0] === SCULPT_KEY)
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
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
  const errors: { object: string; message: string }[] = [];
  const fail = (object: string, message: string): void => {
    if (errors.length < ERROR_LIMIT) errors.push({ object, message });
  };

  if (!Number.isFinite(spec.cellSize) || spec.cellSize <= 0) {
    return { sampler: null, errors: [{ object: objects[0]?.name ?? '', message: `размер клетки ${spec.cellSize} не положителен (TERR-2)` }] };
  }
  if (!Number.isInteger(spec.width) || !Number.isInteger(spec.height) || spec.width <= 0 || spec.height <= 0) {
    // Ассет с нецелой или неположительной сеткой отвергает и ядро; здесь отказ
    // нужен ДО раскладки по клеткам — иначе индекс корзины уехал бы за массив.
    return {
      sampler: null,
      errors: [{ object: objects[0]?.name ?? '', message: `сетка ${spec.width}×${spec.height} не является целой положительной (TERR-2)` }],
    };
  }

  const triangles: Triangle[] = [];
  for (const object of objects) {
    if (object.mesh === null) {
      fail(object.name, 'объект без геометрии: скалпт-поверхность читается с меша (BLND-13)');
      continue;
    }
    let geometry;
    try {
      geometry = readMeshGeometry(document, object.mesh, []);
    } catch (error) {
      fail(object.name, error instanceof GltfParseError ? error.message : String(error));
      continue;
    }
    const world = geometry.positions.map((position) => worldPoint(object.world, position));
    let broken = false;
    for (const point of world) {
      if ([point.x, point.y, point.elevation].every((value) => Number.isFinite(value))) continue;
      fail(object.name, 'координата вершины не является конечным числом');
      broken = true;
      break;
    }
    if (broken) continue;
    for (let face = 0; face * 3 < geometry.triangles.length; face++) {
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
  if (errors.length > 0) return { sampler: null, errors };

  // Ускоряющая решётка: треугольник лежит во всех клетках своего bbox (с
  // запасом на отступ выборок), выборка смотрит только клетку точки.
  const { width, height, cellSize } = spec;
  const margin = cellSize * EDGE_INSET_RATIO;
  const buckets: number[][] = Array.from({ length: width * height }, () => []);
  const clampX = (value: number): number => Math.min(Math.max(value, 0), width - 1);
  const clampY = (value: number): number => Math.min(Math.max(value, 0), height - 1);
  for (let index = 0; index < triangles.length; index++) {
    const t = triangles[index]!;
    const x0 = clampX(Math.floor((Math.min(t.ax, t.bx, t.cx) - margin) / cellSize));
    const x1 = clampX(Math.floor((Math.max(t.ax, t.bx, t.cx) + margin) / cellSize));
    const y0 = clampY(Math.floor((Math.min(t.ay, t.by, t.cy) - margin) / cellSize));
    const y1 = clampY(Math.floor((Math.max(t.ay, t.by, t.cy) + margin) / cellSize));
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) buckets[y * width + x]!.push(index);
    }
  }

  const heightAt = (x: number, y: number): number | null => {
    const bucket = buckets[clampY(Math.floor(y / cellSize)) * width + clampX(Math.floor(x / cellSize))]!;
    let best: number | null = null;
    for (const index of bucket) {
      const t = triangles[index]!;
      // Знаковые площади подтреугольников: точка внутри, когда все три одного
      // знака (с допуском на float32); нулевая полная площадь — стенка.
      const area = (t.bx - t.ax) * (t.cy - t.ay) - (t.by - t.ay) * (t.cx - t.ax);
      const scale = Math.abs(area);
      const tolerance =
        BARYCENTRIC_TOLERANCE *
        Math.max(1, Math.abs(t.ax), Math.abs(t.ay), Math.abs(t.bx), Math.abs(t.by), Math.abs(t.cx), Math.abs(t.cy)) ** 2;
      if (scale <= tolerance) continue;
      const wa = ((t.bx - x) * (t.cy - y) - (t.by - y) * (t.cx - x)) / area;
      const wb = ((t.cx - x) * (t.ay - y) - (t.cy - y) * (t.ax - x)) / area;
      const wc = 1 - wa - wb;
      // Кламп сверху: у почти вырожденного треугольника `tolerance / scale`
      // растёт без предела, и точка ВНЕ его проекции принималась бы с
      // экстраполированной высотой.
      const slack = Math.min(tolerance / scale, 1e-6);
      if (wa < -slack || wb < -slack || wc < -slack) continue;
      const elevation = wa * t.az + wb * t.bz + wc * t.cz;
      if (best === null || elevation > best) best = elevation;
    }
    return best;
  };
  return { sampler: { heightAt }, errors: [] };
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

/**
 * Уровни, пол и рампы из объединения скалпта (BLND-13):
 *
 * - уровень — высота центра клетки, квантованная к ближайшему целому; уровень
 *   вне алфавита схемы собирается в `outOfRange` вместе с сырой высотой — отказ
 *   обязан называть клетку И ЕЁ ВЫСОТУ, а не уже квантованный уровень;
 * - нет пересечения над центром — клетка без пола `_` (дыра — инструмент);
 *   уровень такой клетки — уровень БЛИЖАЙШЕЙ клетки с полом (при равных
 *   расстояниях — старший): уровень дыры не мёртвые данные, из него строятся
 *   клифы (TERR-5) и высота восстановленного по ходу матча пола (TERR-3), и
 *   ноль дырявил бы плато ложным кольцом обрывов;
 * - рампа — непрерывность на отрезке между центрами пары клеток с перепадом в
 *   единицу: отрезок сэмплируется `CONTINUITY_INTERVALS` интервалами, и если
 *   максимальный скачок между соседними выборками ниже порога обрыва, рампу
 *   получает НИЖНЯЯ клетка пары (TERR-5). Обрыв ловится любой своей позицией
 *   внутри пары, а не только у самой границы.
 */
export function deriveSculptCells(
  sampler: SculptSampler,
  spec: CellGridSpec,
  cliffJump: number,
  maxLevel: number,
  levelUnit: number,
): SculptCells {
  const { width, height, cellSize } = spec;
  const total = width * height;
  const heights = new Array<number>(total).fill(0);
  const levels = new Array<number | null>(total).fill(null);
  const ramps = new Array<number>(total).fill(0);
  const noFloor = new Array<number>(total).fill(0);
  const outOfRange: { x: number; y: number; height: number }[] = [];

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const at = y * width + x;
      const sampled = sampler.heightAt((x + 0.5) * cellSize, (y + 0.5) * cellSize);
      if (sampled === null) {
        noFloor[at] = 1;
        continue;
      }
      const level = Math.round(sampled / levelUnit);
      if (level < 0 || level > maxLevel) {
        outOfRange.push({ x, y, height: sampled });
        continue;
      }
      levels[at] = level;
      heights[at] = level * levelUnit;
    }
  }

  // Уровень клеток без пола — волной от клеток с полом: кольцо за кольцом,
  // в кольце каждая дыра берёт СТАРШИЙ уровень среди примыкающих присвоенных.
  // Порядок обхода на результат не влияет (максимум коммутативен), недостижимые
  // дырами от края до края клетки остаются на нуле.
  let frontier: number[] = [];
  for (let at = 0; at < total; at++) if (levels[at] !== null) frontier.push(at);
  while (frontier.length > 0) {
    const ring = new Map<number, number>();
    for (const at of frontier) {
      const x = at % width;
      const y = (at - x) / width;
      const level = levels[at]!;
      for (const neighbor of [
        x > 0 ? at - 1 : -1,
        x + 1 < width ? at + 1 : -1,
        y > 0 ? at - width : -1,
        y + 1 < height ? at + width : -1,
      ]) {
        if (neighbor < 0 || noFloor[neighbor] !== 1 || levels[neighbor] !== null) continue;
        const known = ring.get(neighbor);
        if (known === undefined || level > known) ring.set(neighbor, level);
      }
    }
    frontier = [...ring.keys()].sort((a, b) => a - b);
    for (const at of frontier) {
      const level = ring.get(at)!;
      levels[at] = level;
      heights[at] = level * levelUnit;
    }
  }

  const threshold = cliffJump * levelUnit;
  // Пара соседних клеток с |Δ| = 1: непрерывность скалпта между их центрами
  // решает, рампа это или обрыв. Помечается всегда нижняя клетка пары, поэтому
  // от порядка обхода результат не зависит.
  const consider = (aX: number, aY: number, bX: number, bY: number): void => {
    const a = aY * width + aX;
    const b = bY * width + bX;
    if (noFloor[a] === 1 || noFloor[b] === 1) return;
    const levelA = levels[a] ?? null;
    const levelB = levels[b] ?? null;
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
    const lower = levelA < levelB ? a : b;
    ramps[lower] = 1;
  };
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (x + 1 < width) consider(x, y, x + 1, y);
      if (y + 1 < height) consider(x, y, x, y + 1);
    }
  }
  return { heights, ramps, noFloor, outOfRange };
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
