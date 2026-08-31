/**
 * Сглаживание прямой видимости (`pathfinding` NAV-10): найденный коридор клеток
 * превращается в короткую ломаную мировых точек Q16.16.
 *
 * Обход отрезка ЦЕЛОЧИСЛЕННЫЙ — ни float, ни корня, ни деления в шаге нет
 * (NAV-2, `determinism-core` CORE-2). Это супер-обход (supercover): проверяется
 * КАЖДАЯ клетка, которой отрезок касается, а не одна на столбец, — иначе
 * «видимость» пролезала бы сквозь стык двух стен.
 *
 * ## Как решается, какую границу луч пересекает раньше
 *
 * Пусть `ux`, `uy` — расстояния от текущей точки до ближайшей границы клетки по
 * ходу луча, `ax = |dx|`, `ay = |dy|` — модули проекций отрезка. Граница по X
 * ближе, когда `ux / ax < uy / ay`, то есть когда `E = ux·ay − uy·ax < 0`.
 * Величина `E` обновляется СЛОЖЕНИЕМ и остаётся точной:
 *
 * - пересекли границу по X: `ux` становится `tileSize`, значит `E += tileSize·ay`;
 * - пересекли границу по Y: `E −= tileSize·ax`.
 *
 * Знак `E` держит её в коридоре `(−tileSize·ax, tileSize·ay)`: прибавляем, пока
 * `E < 0`, вычитаем, пока `E > 0`. Отсюда и оценка величин для DET-2 (условие
 * 3): `|E| < tileSize · max(ax, ay) ≤ tileSize² · max(width, height)`, и эту
 * оценку сборка навигации проверяет явно (`navigation.ts`), а не подразумевает.
 *
 * `E === 0` — луч идёт РОВНО через угол. Такой проход разрешается, только если
 * проходимы ОБА огибающих угол пути — и клетками, и границами между ними:
 * сомнительный угол считается непроходимым, та же безопасная сторона, что
 * округление зазора вверх (NAV-9).
 */
import { navCellOpen, navStepOpen, type NavGrid } from './bake.js';
import type { Fixed, Vec2 } from '../../types.js';

/** Запрос сглаживания: карта, требования запроса и точки его концов. */
export class NavSmoothing {
  private readonly nav: NavGrid;
  /** Пробы клеток последнего сглаживания — единица стоимости (PERF-3). */
  probes = 0;
  private minClearance = 0;
  /**
   * Клетка старта запроса: она освобождена от проверки проходимости — агент в
   * ней стоит (NAV-5), и требовать от неё зазора значило бы объявить невидимой
   * собственную позицию прижатого к стене агента.
   */
  private exempt = -1;

  constructor(nav: NavGrid) {
    this.nav = nav;
  }

  /**
   * Жадное string pulling по коридору (NAV-10): опорная точка тянется к самой
   * дальней точке коридора, которую видит, и только на потере видимости
   * предыдущая точка становится новой опорой.
   *
   * Точки промежуточные — ЦЕНТРЫ клеток, последняя — точная цель запроса
   * (NAV-1). Первой опорой служит точная позиция `from`, но в путь она не входит
   * (NAV-1): агент в ней уже стоит.
   *
   * Список точек — единственная аллокация запроса, и она принадлежит контракту
   * (NAV-1 возвращает точки), а не реализации: длина её — длина ломаной, а не
   * число сущностей или клеток арены.
   *
   * ponytail: в прямом коридоре длины L опора не двигается, а проверяемая точка
   * уходит всё дальше — проб выходит порядка L². Работа эта видна счётчику
   * `navNodes` (PERF-3) и ограничена сверху бюджетом поиска (коридор не длиннее
   * числа раскрытий, NAV-5), поэтому потолок у неё есть уже сейчас. Предел
   * ЗАГЛЯДЫВАНИЯ вперёд — рычаг на случай, если профиль реальной арены упрётся
   * в эти пробы; вводить его до того значило бы менять выбор точек (NAV-10) ради
   * стоимости, которой на аренах `content/scenes/` пока нет.
   */
  build(
    corridor: Int32Array,
    length: number,
    from: Vec2,
    to: Vec2,
    minClearance: number,
    exempt: number,
  ): Vec2[] {
    this.probes = 0;
    this.minClearance = minClearance;
    this.exempt = exempt;
    const out: Vec2[] = [];
    let anchorX = from.x;
    let anchorY = from.y;
    const last = length - 1;
    for (let i = 2; i <= last; i++) {
      const pointX = i === last ? to.x : this.centerX(corridor[i]!);
      const pointY = i === last ? to.y : this.centerY(corridor[i]!);
      if (this.visible(anchorX, anchorY, pointX, pointY)) continue;
      anchorX = this.centerX(corridor[i - 1]!);
      anchorY = this.centerY(corridor[i - 1]!);
      out.push({ x: anchorX, y: anchorY });
    }
    out.push({ x: to.x, y: to.y });
    return out;
  }

  /**
   * Центр клетки: начало плюс половина `tileSize`, УСЕЧЁННАЯ вниз. При нечётном
   * `tileSize` точный центр в Q16.16 не представим, и правило округления здесь
   * то же, что у области снятия пола (`terrain` TERR-8): одно правило центра на
   * ядро, а не два.
   */
  private centerX(cell: number): Fixed {
    const { width, tileSize } = this.nav.grid;
    return (cell % width) * tileSize + (tileSize >> 1);
  }

  /**
   * DET-2, условия 3 и 5: делимое `cell` — линейный индекс клетки,
   * неотрицательный и меньший площади сетки; делитель `width` — целое ≥ 1
   * (TERR-2). Произведение ряда на `tileSize` не превышает `height · tileSize`,
   * то есть остаётся в `i32` (TERR-2). Отрицательным делимое не бывает —
   * условие 4 неприменимо.
   */
  private centerY(cell: number): Fixed {
    const { width, tileSize } = this.nav.grid;
    return Math.floor(cell / width) * tileSize + (tileSize >> 1);
  }

  /**
   * Видит ли точка точку: супер-обход клеток отрезка целыми числами. Отрезок,
   * задевший непроходимую для запроса клетку — или пересёкший непроходимую
   * ГРАНИЦУ, обрыв между уровнями (`terrain` TERR-5), — видимости не даёт:
   * сглаживание обязано спрямлять путь по тем же правилам, по каким его нашёл
   * поиск (NAV-7, NAV-10).
   */
  private visible(fromX: Fixed, fromY: Fixed, toX: Fixed, toY: Fixed): boolean {
    const tileSize = this.nav.grid.tileSize;
    let cx = cellCoord(fromX, tileSize);
    let cy = cellCoord(fromY, tileSize);
    const endX = cellCoord(toX, tileSize);
    const endY = cellCoord(toY, tileSize);
    let cell = this.enter(cx, cy);
    if (cell < 0) return false;

    let stepsX = Math.abs(endX - cx);
    let stepsY = Math.abs(endY - cy);
    const dx = toX - fromX;
    const dy = toY - fromY;
    const sx = dx < 0 ? -1 : 1;
    const sy = dy < 0 ? -1 : 1;
    const ax = Math.abs(dx);
    const ay = Math.abs(dy);
    // Расстояния до ближайших границ по ходу луча.
    const ux = sx > 0 ? (cx + 1) * tileSize - fromX : fromX - cx * tileSize;
    const uy = sy > 0 ? (cy + 1) * tileSize - fromY : fromY - cy * tileSize;
    const gainX = tileSize * ay;
    const gainY = tileSize * ax;
    let error = ux * ay - uy * ax;

    while (stepsX > 0 || stepsY > 0) {
      const crossing = nextCrossing(stepsX, stepsY, error);
      if (crossing === CROSS_X) {
        cell = this.step(cell, cx + sx, cy);
        cx += sx;
        stepsX--;
        error += gainX;
      } else if (crossing === CROSS_Y) {
        cell = this.step(cell, cx, cy + sy);
        cy += sy;
        stepsY--;
        error -= gainY;
      } else {
        cell = this.corner(cell, cx, cy, sx, sy);
        cx += sx;
        cy += sy;
        stepsX--;
        stepsY--;
        error += gainX - gainY;
      }
      if (cell < 0) return false;
    }
    return true;
  }

  /**
   * Луч идёт РОВНО через угол четырёх клеток (NAV-10): пройти можно, только если
   * проходимы ОБА огибающих угол пути — и клетками, и границами между ними.
   * Сомнительный угол считается непроходимым: это та же безопасная сторона, что
   * округление зазора вверх (NAV-9), и правило симметрично — угол, закрытый для
   * прохода туда, закрыт и обратно.
   */
  private corner(from: number, cx: number, cy: number, sx: number, sy: number): number {
    const alongX = this.step(from, cx + sx, cy);
    if (alongX < 0) return -1;
    const throughX = this.step(alongX, cx + sx, cy + sy);
    if (throughX < 0) return -1;
    const alongY = this.step(from, cx, cy + sy);
    if (alongY < 0) return -1;
    return this.step(alongY, cx + sx, cy + sy);
  }

  /**
   * Первая клетка обхода — та, в которой отрезок начинается: у неё проверяется
   * только собственная проходимость, границы позади неё обход не касаются.
   */
  private enter(x: number, y: number): number {
    this.probes++;
    const cell = this.indexOf(x, y);
    if (cell < 0) return -1;
    if (cell === this.exempt) return cell;
    return navCellOpen(this.nav, cell, this.minClearance) ? cell : -1;
  }

  /**
   * Переход обхода в соседнюю клетку: та должна быть проходима запросу, а
   * граница между ними — проходима по правилу террейна (NAV-7). Возвращает
   * индекс клетки либо `-1`.
   *
   * Каждая проба — единица работы навигации (PERF-3), и считается она здесь, в
   * единственном месте, где обход спрашивает клетку.
   */
  private step(from: number, x: number, y: number): number {
    this.probes++;
    const cell = this.indexOf(x, y);
    if (cell < 0) return -1;
    return navStepOpen(this.nav, from, cell, this.minClearance) ? cell : -1;
  }

  /** Линейный индекс клетки; за пределами сетки прохода нет — `-1`. */
  private indexOf(x: number, y: number): number {
    const { width, height } = this.nav.grid;
    if (x < 0 || y < 0 || x >= width || y >= height) return -1;
    return y * width + x;
  }
}

/** Какую границу клетки луч пересекает следующей. */
const CROSS_X = 0;
const CROSS_Y = 1;
const CROSS_CORNER = 2;

/**
 * Решение шага обхода: граница по X ближе при `error < 0`, по Y — при
 * `error > 0`, ноль означает проход РОВНО через угол. Исчерпанное число
 * пересечений по оси решает за знак: у отрезка, доехавшего до столбца цели,
 * границ по X больше не осталось.
 */
function nextCrossing(stepsX: number, stepsY: number, error: number): number {
  if (stepsX > 0 && (stepsY === 0 || error < 0)) return CROSS_X;
  if (stepsY > 0 && (stepsX === 0 || error > 0)) return CROSS_Y;
  return CROSS_CORNER;
}

/**
 * Координата клетки под мировой координатой, БЕЗ зажима к сетке: обход обязан
 * видеть выход за край как непроходимость, а не как крайнюю клетку. Зажим —
 * правило адресации точки запроса (`terrain` TERR-4), и оно живёт в `cellAt`.
 *
 * Отрицательная координата отдаётся одним значением `-1`, а не своей клеткой, и
 * это не приближение, а снятие условия 4 DET-2: конвенция округления
 * отрицательного частного (floor у JS против усечения к нулю у второй
 * реализации ядра) на ответ обхода не влияет ровно потому, что ЛЮБАЯ
 * отрицательная клетка лежит вне сетки. Начальная точка вне сетки обрывает обход
 * сразу, а до конечной обход дойдёт через ту же границу `-1` — и в обоих случаях
 * ответ «не видно» одинаков при любой конвенции.
 *
 * DET-2, условия 3 и 5: делимое — неотрицательная мировая координата в Q16.16,
 * то есть меньше 2^31; делитель `tileSize` — целое ≥ 1 (TERR-2).
 */
function cellCoord(value: Fixed, tileSize: Fixed): number {
  if (value < 0) return -1;
  return Math.floor(value / tileSize);
}
