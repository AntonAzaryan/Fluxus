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
 * правилом, что запрос уровня (`terrain` TERR-4, `cellAt`), совпадение ТОЧЕК
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

/**
 * Поверхность поля `navigation` ДОКУМЕНТА ПРОГОНА (`cli-testing` CLI-2,
 * `netcode-transport` NTR-14, SER-7): числа геймдизайнера, не ядра — механизм
 * против политики; сам шов навигации опционален на уровне ядра (DI-4).
 *
 * Ровно эти поля публикует опубликованная схема документа (SER-5), и состав их
 * закрыт с обеих сторон: поля, которого схема не называет, у документа быть не
 * должно так же, как не должно быть поля, которое схема отвергает.
 */
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
 * Параметры сборки навигации — поверхность документа плюс то, чем распоряжается
 * ВЫЗЫВАЮЩАЯ СБОРКА, а не автор документа (SER-5). Отдельным типом, потому что
 * второе полем документа быть MUST NOT: путь из JSON к переключателю счётчиков
 * стоимости означал бы, что документ прогона вправе отменить учёт своей же
 * работы (PERF-3).
 */
export interface NavigationBuildOptions extends NavigationOptions {
  /**
   * Считать ли работу запросов в счётчики стоимости тика (PERF-3). По умолчанию
   * да: сборка симуляции — оплачиваемый путь.
   *
   * `false` — сборка ВНЕ оплачиваемого пути: отладочный слой рендера, которому
   * `render-debug` RDBG-8 прямо запрещает записывать собственную работу в
   * счётчики («нужен собственный расчёт — он идёт в отладочном слое, вне
   * оплачиваемого пути»). Гарантия эта обязана держаться устройством, а не тем,
   * что отладку зовут в удачный момент: сток диагностики ядра — переменная
   * модуля (DIAG-1), и проба, снятая внутри тика, иначе дописала бы свои узлы в
   * сводку игрового кадра.
   */
  readonly cost?: boolean;
}

/**
 * Предел величин целочисленного обхода отрезка (`smooth.ts`): его знаменатель
 * `tileSize² · max(width, height)` обязан оставаться точным в двоичном
 * контейнере (DET-2, условие 3). Проверяется явно и на сборке — молчаливая
 * потеря точности дала бы расхождение реализаций там, где его труднее всего
 * искать.
 *
 * Оценка выведена для отрезка, оба конца которого ЛЕЖАТ В СЕТКЕ: только тогда
 * `|dx| ≤ width · tileSize` и `|dy| ≤ height · tileSize`. Конец за пределами
 * сетки законен (NAV-5), и такой отрезок оценке не подчиняется — но и ответа не
 * меняет: клетка вне сетки непроходима по построению (`smooth.ts`, `indexOf`),
 * обход обязан в неё войти, чтобы дойти до конца, и возвращает «не видно» при
 * любом порядке пересечений. Точность решает ТОЛЬКО порядок, а исход у него в
 * этом случае один.
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
export function buildNavigation(grid: TerrainGrid, options: NavigationBuildOptions): NavigationApi {
  checkOptions(grid, options);
  const nav = bakeNavGrid(grid);
  const search = new NavSearch(nav);
  const smoothing = new NavSmoothing(nav);
  const budget = options.budget;
  const tileSize = grid.tileSize;
  const metered = options.cost ?? true;

  return {
    findPath: (from: Vec2, to: Vec2, request): PathResult => {
      const radius = request?.agentRadius ?? 0;
      const minClearance = radius <= 0 ? 0 : cellsForRadius(radius, tileSize);
      // Совпадение СТАРТА И ЦЕЛИ — единственное исключение NAV-1: путь состоял
      // бы из одной лишь точки `from`, которую путь не содержит, то есть из
      // ничего (NAV-5). Сравниваются точки, а не их клетки: цель, лежащая в
      // клетке агента, но не в его позиции, — обычная достижимая цель, и
      // выбросить её значило бы вернуть `found`, не ведущий никуда.
      if (from.x === to.x && from.y === to.y) return FOUND_HERE;
      const fromCell = cellAt(grid, from);
      const toCell = cellAt(grid, to);
      // Одна клетка на двоих — отрезок между точками целиком внутри неё, и
      // сглаживать нечего: путь есть сама цель (NAV-1).
      if (fromCell === toCell) return { status: 'found', waypoints: [{ x: to.x, y: to.y }] };

      const status = search.run(fromCell, toCell, minClearance, budget);
      if (status !== 'found') {
        if (metered) countCostNavNodes(search.expansions);
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
      if (metered) countCostNavNodes(search.expansions + smoothing.probes);
      return { status: 'found', waypoints };
    },
  };
}

/**
 * Проверки сборки. Отказ здесь, до первого тика: сборка с непроходимыми по
 * физике путями выглядела бы исправной навигацией и расходилась бы с нормой
 * только там, где это дорого заметить.
 */
function checkOptions(grid: TerrainGrid, options: NavigationBuildOptions): void {
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
 * Полклетки в требовании — не запас, а геометрия карты зазора: у клетки с
 * зазором `k` ближайшая непроходимость отстоит от её ЦЕНТРА на `(k − ½) ·
 * tileSize`, потому что первая клетка расстояния тратится на полклетки до
 * собственной границы. Отсюда требование `k ≥ radius / tileSize + ½`, то есть
 * `ceil((2·radius + tileSize) / (2·tileSize))`. Внутри области TERR-7 (радиус не
 * больше половины клетки) это ровно единица — та же, что дало бы простое
 * `ceil(radius / tileSize)`; за её пределами простое округление занижало бы
 * требование на клетку и пропускало агента в проход, в который он не входит.
 *
 * DET-2, условия 3 и 5: делимое `2·radius + 3·tileSize − 1` — сумма
 * положительных `i32` с малыми множителями, то есть меньше 2^34; делитель
 * `2 · tileSize` — целое ≥ 2 (TERR-2). Оба неотрицательны, поэтому конвенция
 * округления отрицательных (условие 4) здесь не возникает.
 */
function cellsForRadius(radius: Fixed, tileSize: Fixed): number {
  return Math.floor((2 * radius + 3 * tileSize - 1) / (2 * tileSize));
}
