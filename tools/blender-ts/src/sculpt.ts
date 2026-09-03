/**
 * Клеточные данные из скалпт-поверхности (BLND-13): что следует из высот
 * объединения — уровни, пол, рампы и узловая база остатка кривизны.
 *
 * Саму поверхность («что лежит над точкой») строит `sculptSampler.ts`; этот
 * модуль отвечает на вопрос «какие уровни, флаги и остаток из неё следуют
 * числами», а перевод чисел в символы карт и валидация ассета — `maps.ts` тем
 * же путём, что у grid-объектов (BLND-9).
 *
 * Дискретизация детерминирована (BLND-4): чистая арифметика над выборками, без
 * порядковой зависимости — волна дыр берёт максимум, рампой помечается всегда
 * нижняя клетка пары.
 */
import type { TerrainGrid } from '@fluxus/core';
import { cornerLevels } from '@fluxus/render/visualSurface';
import type { CellGridSpec } from './cells.js';
import { byObjectName } from './layer.js';
import { hasSingleSemantic, type SourceObject } from './normalize.js';
import { EDGE_INSET_RATIO, type SculptSampler } from './sculptSampler.js';

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
 * Число интервалов выборки непрерывности на отрезке между центрами пары клеток.
 * Обрыв ловится ЛЮБОЙ своей позицией внутри пары: скачок целого уровня попадает
 * в один из интервалов и превышает порог, а гладкий склон проходит, пока его
 * крутизна ниже `порог × интервалы` уровней на клетку (при умолчаниях — 4).
 */
const CONTINUITY_INTERVALS = 8;

/** Sculpt-объекты источника в порядке имён (BLND-4). */
export function sculptObjectsOf(objects: readonly SourceObject[]): readonly SourceObject[] {
  return objects.filter((object) => hasSingleSemantic(object, SCULPT_KEY)).sort(byObjectName);
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

/** Кольцо волны: незаполненные соседи клетки берут её значение, если оно старше взятого. */
function spreadToNeighbors(
  ring: Map<number, number>,
  values: readonly (number | null)[],
  fillable: (at: number) => boolean,
  spec: GridShape,
  at: number,
  value: number,
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
    if (neighbor < 0 || values[neighbor] !== null || !fillable(neighbor)) continue;
    const known = ring.get(neighbor);
    if (known === undefined || value > known) ring.set(neighbor, value);
  }
}

/** Форма сетки цели — всё, что нужно волне: клетки адресуются построчно. */
interface GridShape {
  readonly width: number;
  readonly height: number;
}

/**
 * Волна от клеток С ПОЛОМ: кольцо за кольцом, в кольце каждая незаполненная
 * клетка берёт СТАРШЕЕ значение среди примыкающих присвоенных. Заполняет
 * `values` на месте; недостижимые клетки остаются `null`.
 *
 * Реализация одна на оба слоя, которым это правило нужно: уровень клетки без
 * пола (BLND-13) и её слот раскраски (BLND-14). Второй экземпляр обхода
 * разошёлся бы с первым молча (`determinism-core` CORE-3), и «уровень дыры
 * оттуда, слот отсюда» стало бы нечем объяснить автору.
 *
 * Порядок обхода на результат не влияет: максимум коммутативен, а кольцо
 * собирается целиком до присвоения.
 */
export function spreadFromFloor(
  spec: GridShape,
  values: (number | null)[],
  fillable: (at: number) => boolean,
): void {
  const total = spec.width * spec.height;
  let frontier: number[] = [];
  for (let at = 0; at < total; at++) if (values[at] !== null) frontier.push(at);
  while (frontier.length > 0) {
    const ring = new Map<number, number>();
    // Значение клетки фронта присвоено по построению фронта.
    for (const at of frontier) spreadToNeighbors(ring, values, fillable, spec, at, values[at]!);
    frontier = [];
    for (const [at, value] of [...ring.entries()].sort(([a], [b]) => a - b)) {
      frontier.push(at);
      values[at] = value;
    }
  }
}

/**
 * Уровень клеток без пола — той же волной. Уровень дыры не мёртвые данные: из
 * него строятся клифы (TERR-5) и высота восстановленного по ходу матча пола
 * (TERR-3), и ноль дырявил бы плато ложным кольцом обрывов, блокирующим и
 * движение, и обзор. Недостижимые дырами от края до края клетки остаются на
 * нуле.
 */
function fillHoleLevels(spec: CellGridSpec, levelUnit: number, cells: CellArrays): void {
  spreadFromFloor(spec, cells.levels, (at) => cells.noFloor[at] === 1);
  for (const [at, level] of cells.levels.entries()) {
    if (level !== null) cells.heights[at] = level * levelUnit;
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
