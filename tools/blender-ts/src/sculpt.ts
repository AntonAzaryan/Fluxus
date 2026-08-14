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

/** Отступ пробы непрерывности от границы пары клеток — в долях клетки. */
const PROBE_INSET_RATIO = 1 / 16;

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
      const slack = tolerance / scale;
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
    if (raw !== found.value) {
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
  /** Высота клетки в единицах Blender: `уровень × LEVEL_UNIT`, у клетки без пола 0. */
  readonly heights: readonly number[];
  readonly ramps: readonly number[];
  readonly noFloor: readonly number[];
}

/**
 * Уровни, пол и рампы из объединения скалпта (BLND-13):
 *
 * - уровень — высота центра клетки, квантованная к ближайшему целому (диапазон
 *   алфавита проверяет перевод в символы — `terrainMapsOf`, как у grid-пути);
 * - нет пересечения над центром — клетка без пола `_` (дыра — инструмент);
 * - рампа — по-граничное правило: у пары соседних клеток с перепадом уровня в
 *   единицу проба по обе стороны середины общей границы; скачок ниже порога
 *   обрыва — склон непрерывен, рампу получает НИЖНЯЯ клетка пары (TERR-5).
 */
export function deriveSculptCells(
  sampler: SculptSampler,
  spec: CellGridSpec,
  cliffJump: number,
  levelUnit: number,
): SculptCells {
  const { width, height, cellSize } = spec;
  const total = width * height;
  const heights = new Array<number>(total).fill(0);
  const levels = new Array<number | null>(total).fill(null);
  const ramps = new Array<number>(total).fill(0);
  const noFloor = new Array<number>(total).fill(0);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const at = y * width + x;
      const sampled = sampler.heightAt((x + 0.5) * cellSize, (y + 0.5) * cellSize);
      if (sampled === null) {
        noFloor[at] = 1;
        continue;
      }
      const level = Math.round(sampled / levelUnit);
      levels[at] = level;
      heights[at] = level * levelUnit;
    }
  }

  const probe = cellSize * PROBE_INSET_RATIO;
  const threshold = cliffJump * levelUnit;
  // Пара соседних клеток с |Δ| = 1: непрерывность через общую границу решает,
  // рампа это или обрыв. Обход строчный — но помечается всегда нижняя клетка
  // пары, поэтому от порядка обхода результат не зависит.
  const consider = (aX: number, aY: number, bX: number, bY: number, borderX: number, borderY: number): void => {
    const a = aY * width + aX;
    const b = bY * width + bX;
    if (noFloor[a] === 1 || noFloor[b] === 1) return;
    const levelA = levels[a]!;
    const levelB = levels[b]!;
    if (Math.abs(levelA - levelB) !== 1) return;
    const alongX = aY === bY;
    const hA = sampler.heightAt(borderX - (alongX ? probe : 0), borderY - (alongX ? 0 : probe));
    const hB = sampler.heightAt(borderX + (alongX ? probe : 0), borderY + (alongX ? 0 : probe));
    if (hA === null || hB === null) return;
    if (Math.abs(hA - hB) >= threshold) return;
    const lower = levelA < levelB ? a : b;
    ramps[lower] = 1;
  };
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (x + 1 < width) consider(x, y, x + 1, y, (x + 1) * cellSize, (y + 0.5) * cellSize);
      if (y + 1 < height) consider(x, y, x, y + 1, (x + 0.5) * cellSize, (y + 1) * cellSize);
    }
  }
  return { heights, ramps, noFloor };
}

/**
 * Выборка скалпта в узле сетки: крайние узлы уводятся внутрь арены на отступ —
 * край меша совпадает с краем арены с точностью шума float32 экспорта.
 */
export function sampleNodeHeight(
  sampler: SculptSampler,
  spec: CellGridSpec,
  nodeX: number,
  nodeY: number,
): number | null {
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
 * обязана быть она (design, решение 3).
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
