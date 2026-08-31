/**
 * Запекание навигационных данных из ассета террейна (`pathfinding` NAV-3,
 * NAV-7, NAV-9).
 *
 * Данные производны от ИММУТАБЕЛЬНОЙ карты уровней и живут в неизменяемой части
 * сборки: в снапшот они не входят и при перемотке не пересобираются (NAV-3).
 * Отсюда же следует и то, чего здесь нет: живое состояние пола (компонент
 * `TerrainFloor`, TERR-6) не читается вовсе — снятый в бою пол для `findPath`
 * невидим, и обход дыры остаётся политикой геймплейной системы (NAV-7).
 *
 * Запекается ровно две карты, обе целочисленные:
 *
 * - проходимость клетки — «нет пола» в АССЕТЕ делает клетку непроходимой (NAV-7);
 * - зазор (clearance) — расстояние в клетках до ближайшей непроходимости (NAV-9).
 *
 * Проходимость ПЕРЕХОДА между соседями картой не запекается: она есть функция
 * уровней и рамп (`terrain` TERR-5), и поиск спрашивает о ней тот же предикат,
 * которым строится cliff-геометрия (`terrainStepPassable`), — второй копии
 * правила у ядра нет.
 */
import { terrainStepPassable } from '../terrain.js';
import type { TerrainGrid } from '../../types.js';

/**
 * Метка «до этой клетки волна ещё не дошла» в карте зазора. Расстояний такой
 * величины на сетке, помещающейся в память, не бывает: зазор ограничен
 * половиной меньшей стороны арены.
 */
const UNSET = 0xffff;

/** Запечённая навигационная часть сборки (NAV-3). */
export interface NavGrid {
  readonly grid: TerrainGrid;
  /** 1 — клетка проходима, 0 — нет (NAV-7). Row-major, как все карты террейна. */
  readonly passable: Uint8Array;
  /** Зазор клетки в КЛЕТКАХ: у непроходимой — 0, у соседней с ней — 1 (NAV-9). */
  readonly clearance: Uint16Array;
}

/**
 * Проходимость клетки для запроса (NAV-7, NAV-9): пол в ассете есть и зазор
 * допускает агента. Одна функция на все три места, которым это нужно — раскрытие
 * A*, проверка соседа и проба LOS: разойдись они, «пройти можно» значило бы у
 * поиска и у сглаживания разное.
 */
export function navCellOpen(nav: NavGrid, cell: number, minClearance: number): boolean {
  return nav.passable[cell] === 1 && nav.clearance[cell]! >= minClearance;
}

/**
 * Проходимость перехода между клетками с общей стороной (NAV-7): обе клетки
 * открыты запросу И правило террейна разрешает перепад (TERR-5).
 */
export function navStepOpen(
  nav: NavGrid,
  from: number,
  to: number,
  minClearance: number,
): boolean {
  if (!navCellOpen(nav, to, minClearance)) return false;
  return terrainStepPassable(nav.grid.levels, nav.grid.ramps, from, to);
}

/**
 * Печёт карты проходимости и зазора (NAV-9). Зазор считается brushfire'ом —
 * волновым обходом в ширину от ВСЕХ непроходимостей сразу, целыми числами и без
 * единого деления.
 *
 * Источников волны два, и второй существенен: сами непроходимые клетки (зазор
 * ноль) и КРАЙ сетки (клетка у края получает зазор один). Край — не клетка, но
 * пройти сквозь него нельзя, и агент, чей диаметр шире клетки, у края
 * оказывается ровно в том же положении, что и у стены; забыв про край, карта
 * обещала бы кромке арены бесконечный простор.
 *
 * Обе группы источников попадают в очередь ДО начала обхода и в порядке
 * возрастания расстояния (сначала нули, потом единицы), поэтому обычная FIFO
 * остаётся монотонной и первое присвоение клетке и есть минимальное — тот же
 * инвариант, на котором держится BFS с одним источником.
 *
 * Аллокации здесь — сборочные, по одной на арену: запекание случается один раз
 * до первого тика (NAV-3), в горячий путь запроса оно не входит.
 */
export function bakeNavGrid(grid: TerrainGrid): NavGrid {
  const size = grid.width * grid.height;
  const passable = new Uint8Array(size);
  const clearance = new Uint16Array(size);
  clearance.fill(UNSET);
  const queue = new Int32Array(size);

  const blocked = seedBlocked(grid, passable, clearance, queue);
  const tail = seedBorder(grid, clearance, queue, blocked);
  spread(grid, clearance, queue, tail);

  return { grid, passable, clearance };
}

/**
 * Первая волна: непроходимые клетки с нулевым зазором. Проходимость клетки —
 * пол АССЕТА (NAV-7), а не живая карта пола (TERR-6).
 */
function seedBlocked(
  grid: TerrainGrid,
  passable: Uint8Array,
  clearance: Uint16Array,
  queue: Int32Array,
): number {
  let tail = 0;
  for (let cell = 0; cell < passable.length; cell++) {
    if (grid.floor[cell] === 1) {
      passable[cell] = 1;
      continue;
    }
    clearance[cell] = 0;
    queue[tail++] = cell;
  }
  return tail;
}

/** Вторая волна: проходимые клетки у края сетки, расстояние один. */
function seedBorder(
  grid: TerrainGrid,
  clearance: Uint16Array,
  queue: Int32Array,
  from: number,
): number {
  const { width, height } = grid;
  let tail = from;
  for (let y = 0; y < height; y++) {
    const edgeRow = y === 0 || y === height - 1;
    for (let x = 0; x < width; x++) {
      if (!edgeRow && x !== 0 && x !== width - 1) continue;
      tail = visit(clearance, queue, y * width + x, 1, tail);
    }
  }
  return tail;
}

/**
 * Сам brushfire: волна расходится от уже стоящих в очереди источников.
 *
 * Соседи берутся в том же порядке, что у поиска (NAV-8). На результат порядок не
 * влияет — расстояние минимально по построению обхода, — но одинаковый порядок в
 * двух местах дешевле проверять глазами.
 *
 * DET-2, условие 5: делимое `cell` неотрицательно и меньше площади сетки,
 * делитель `width` — целое ≥ 1 (TERR-2); остаток точен, а отрицательным делимое
 * не бывает — условие 4 неприменимо.
 */
function spread(grid: TerrainGrid, clearance: Uint16Array, queue: Int32Array, from: number): void {
  const { width } = grid;
  const size = clearance.length;
  let tail = from;
  for (let head = 0; head < tail; head++) {
    const cell = queue[head]!;
    const next = clearance[cell]! + 1;
    const x = cell % width;
    if (cell >= width) tail = visit(clearance, queue, cell - width, next, tail);
    if (x > 0) tail = visit(clearance, queue, cell - 1, next, tail);
    if (x + 1 < width) tail = visit(clearance, queue, cell + 1, next, tail);
    if (cell + width < size) tail = visit(clearance, queue, cell + width, next, tail);
  }
}

/**
 * Одна клетка волны: не пройденную помечает расстоянием и ставит в хвост
 * очереди. Возвращает новый хвост — очередь живёт в типизированном массиве, и
 * второго владельца у её длины быть не должно.
 */
function visit(
  clearance: Uint16Array,
  queue: Int32Array,
  cell: number,
  distance: number,
  tail: number,
): number {
  if (clearance[cell] !== UNSET) return tail;
  clearance[cell] = distance;
  queue[tail] = cell;
  return tail + 1;
}
