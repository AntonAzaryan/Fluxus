/**
 * Сборка Navigation API (`pathfinding` NAV-1, NAV-3, NAV-5, NAV-9; `terrain`
 * TERR-7).
 *
 * Здесь сходятся три части реализации: запечённые карты (`bake.ts`), поиск по
 * сетке (`astar.ts`) и сглаживание (`smooth.ts`). Наружу уходит ровно то, что
 * объявляет NAV-1, — один `findPath`.
 *
 * Оба числа сборки — параметры, а не константы ядра: бюджет раскрытий подбирает
 * геймдизайнер под размер арены и цену тика (NAV-5), а наибольший радиус агента
 * приходит из контента (NAV-1) и служит источником диаметра для проверки
 * `tileSize` (TERR-7). Ни одной величины баланса в ядре от этого не появляется.
 *
 * Запрос ТОТАЛЕН (NAV-5): точка за краем сетки адресует ближайшую клетку тем же
 * правилом, что запрос уровня (`terrain` TERR-4, `cellAt`), совпадение клеток
 * старта и цели даёт `found` с пустым списком, а старт внутри непроходимой
 * геометрии ищет честно и отвечает `unreachable`, если выхода из него нет.
 * Исключений `findPath` не бросает: исключение посреди тика останавливает матч.
 */
import { countCostNavNodes } from '../../debug.js';
import { cellAt } from '../terrain.js';
import { bakeNavGrid } from './bake.js';
import { NavSearch } from './astar.js';
import { NavSmoothing } from './smooth.js';
import type {
  Fixed,
  NavigationApi,
  PathResult,
  TerrainGrid,
  Vec2,
} from '../../types.js';

/** Зависимости сборки навигации (DI-3): числа геймдизайнера, не ядра. */
export interface NavigationOptions {
  /** Предельное число раскрытых узлов одного запроса (NAV-5). */
  readonly budget: number;
  /**
   * Наибольший радиус агента, который игра намерена передавать в `agentRadius`
   * (TERR-7). Источник диаметра для проверки `tileSize`; сам запрос радиусом не
   * ограничен и остаётся тотальным (NAV-5).
   */
  readonly maxAgentRadius: Fixed;
}

/**
 * Предел величин целочисленного обхода отрезка (`smooth.ts`): его знаменатель
 * `tileSize² · max(width, height)` обязан оставаться точным в двоичном
 * контейнере (DET-2, условие 3). Проверяется явно и на сборке — молчаливая
 * потеря точности дала бы расхождение реализаций там, где его труднее всего
 * искать.
 */
const EXACT_INTEGER_MAX = Number.MAX_SAFE_INTEGER;

/** Пустой список точек: при статусе кроме `found` он именно пуст (NAV-1). */
const NO_WAYPOINTS: readonly Vec2[] = Object.freeze([]);

/**
 * Ответы без пути — общие замороженные значения, а не свежие объекты на запрос:
 * недостижимость и исчерпание бюджета случаются в горячем пути тика, и
 * аллокация на каждый такой ответ была бы пропорциональна числу агентов.
 */
const FOUND_HERE: PathResult = Object.freeze({ status: 'found', waypoints: NO_WAYPOINTS });
const UNREACHABLE: PathResult = Object.freeze({ status: 'unreachable', waypoints: NO_WAYPOINTS });
const BUDGET_EXHAUSTED: PathResult = Object.freeze({
  status: 'budgetExhausted',
  waypoints: NO_WAYPOINTS,
});

/**
 * Строит Navigation API над сеткой террейна. Зовётся там же, где строится
 * Terrain API, — до первого тика: карты производны от иммутабельного ассета, в
 * снапшот не входят и при перемотке не пересобираются (NAV-3).
 */
export function buildNavigation(grid: TerrainGrid, options: NavigationOptions): NavigationApi {
  checkOptions(grid, options);
  const nav = bakeNavGrid(grid);
  const search = new NavSearch(nav);
  const smoothing = new NavSmoothing(nav);
  const budget = options.budget;
  const tileSize = grid.tileSize;

  return {
    findPath: (from: Vec2, to: Vec2, request): PathResult => {
      const radius = request?.agentRadius ?? 0;
      const minClearance = radius <= 0 ? 0 : cellsForRadius(radius, tileSize);
      const fromCell = cellAt(grid, from);
      const toCell = cellAt(grid, to);
      // Одна клетка на двоих — путь состоит из одной лишь точки `from`, которую
      // путь не содержит (NAV-1), то есть из ничего (NAV-5).
      if (fromCell === toCell) return FOUND_HERE;

      const status = search.run(fromCell, toCell, minClearance, budget);
      if (status !== 'found') {
        countCostNavNodes(search.expansions);
        return status === 'budgetExhausted' ? BUDGET_EXHAUSTED : UNREACHABLE;
      }
      const waypoints = smoothing.build(
        search.corridor,
        search.corridorLength,
        from,
        to,
        minClearance,
        fromCell,
      );
      // Работа навигации за запрос — раскрытия поиска плюс пробы клеток обхода
      // видимости: ровно то, что ограничивает бюджет и растит стоимость тика
      // (PERF-3, NAV-5). Один вызов на запрос, а не на узел: в горячем цикле
      // счёт идёт в поля, а сюда приходит готовой суммой.
      countCostNavNodes(search.expansions + smoothing.probes);
      return { status: 'found', waypoints };
    },
  };
}

/**
 * Проверки сборки. Отказ здесь, до первого тика: сборка с непроходимыми по
 * физике путями выглядела бы исправной навигацией и расходилась бы с нормой
 * только там, где это дорого заметить.
 */
function checkOptions(grid: TerrainGrid, options: NavigationOptions): void {
  const { budget, maxAgentRadius } = options;
  if (!Number.isInteger(budget) || budget < 1) {
    throw new Error(`NAV-5: бюджет поиска — целое ≥ 1, получено ${String(budget)}`);
  }
  if (!Number.isInteger(maxAgentRadius) || maxAgentRadius < 0) {
    throw new Error(
      `NAV-1: "maxAgentRadius" — целое ≥ 0 в Q16.16 (FP-1), получено ${String(maxAgentRadius)}`,
    );
  }
  // TERR-7: клетка не мельче диаметра крупнейшего агента — иначе поиск по
  // клеткам вернул бы путь, непроходимый физически. Находка называет ОБА
  // значения: по одному из них автор ассета не поймёт, что чинить.
  if (grid.tileSize < 2 * maxAgentRadius) {
    throw new Error(
      `TERR-7: tileSize ${grid.tileSize} меньше удвоенного наибольшего радиуса агента ` +
        `${maxAgentRadius} (диаметр ${2 * maxAgentRadius}) — путь по клеткам был бы непроходим физически`,
    );
  }
  // DET-2, условие 3: величины целочисленного обхода отрезка (`smooth.ts`)
  // обязаны оставаться точными.
  const extent = Math.max(grid.width, grid.height);
  if (grid.tileSize * grid.tileSize * extent > EXACT_INTEGER_MAX) {
    throw new Error(
      `NAV-10: клетка ${grid.tileSize} на сетке ${grid.width}×${grid.height} слишком велика ` +
        'для точного целочисленного обхода видимости (DET-2)',
    );
  }
}

/**
 * Радиус агента в клетках зазора (NAV-9): округление ВВЕРХ — вернуть путь уже
 * агента нельзя, а вернуть его шире дозволенного лишь осторожнее.
 *
 * DET-2, условия 3 и 5: делимое `radius + tileSize − 1` — сумма двух
 * положительных `i32`, то есть меньше 2^32; делитель `tileSize` — целое ≥ 1
 * (TERR-2). Оба неотрицательны, поэтому конвенция округления отрицательных
 * (условие 4) здесь не возникает.
 */
function cellsForRadius(radius: Fixed, tileSize: Fixed): number {
  return Math.floor((radius + tileSize - 1) / tileSize);
}
