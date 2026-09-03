/**
 * Марш луча по визуальной поверхности (REND-15) — терренная ветвь наведения.
 *
 * Отдельно от сервиса, потому что это ЗАМКНУТЫЙ алгоритм: на входе луч и
 * потолок параметра, на выходе — попадание в клетку поля высот. Поверхность и
 * сетка читаются ТЕКУЩИЕ (`VisualSurfaceSource`) — правка кистью меняет ответ,
 * пересоздания сервиса для этого не требуется.
 *
 * Аллокаций на кадр здесь нет: состояние DDA живёт полем марша, а попадание
 * пишется в запись, которую отдаёт вызывающий.
 */
import { FIXED_ONE, type TerrainGrid } from '@fluxus/core';
import type { VisualSurfaceSource } from './surfaceSource.js';
import { clampIndex, type VisualSurface } from './visualSurface.js';
import type { MutablePickHit, PickRay } from './pickContracts.js';
import { EPS_DIR, SLAB_RANGE, slabAxis } from './slab.js';

/**
 * Насколько глубоко под поверхностью клетки должен оказаться луч на её границе,
 * чтобы попадание считалось стенкой обрыва, а не касанием пола на стыке.
 */
const WALL_EPS = 1e-6;
/** Итераций уточнения корня внутри клетки: 24 деления отрезка клетки пополам. */
const REFINE_ITERATIONS = 24;
/** Подшаги клетки корня не нашли — марш идёт дальше. */
const CELL_CONTINUE = -1;
/** Подшаг упёрся в потолок walkable-`t`: террейну корня уже не найти. */
const CELL_STOP = -2;

export class SurfaceMarch {
  private readonly source: VisualSurfaceSource;
  /** Подшагов на клетку; меньше — грубее на выпуклостях. */
  private readonly cellSteps: number;
  /**
   * Состояние DDA-марша по клеткам — поле, а не локальные переменные: переход в
   * следующую клетку вынесен в свой шаг, а луч в луч не вкладывается, поэтому
   * одной записи на марш хватает и он не аллоцирует.
   */
  private readonly walk = {
    cx: 0,
    cy: 0,
    t: 0,
    stepX: 0,
    stepY: 0,
    deltaX: 0,
    deltaY: 0,
    nextX: 0,
    nextY: 0,
  };

  constructor(source: VisualSurfaceSource, cellSteps: number) {
    this.source = source;
    this.cellSteps = cellSteps;
  }

  /**
   * Марш луча по ТЕРРЕЙН-ФОРМЕ поля (REND-9): по клеткам, с уточнением корня
   * внутри клетки. Walkable-высота внутри клетки не гладкая функция углов, и
   * аналитическому маршу не поддаётся — walkable-ветвь считается рейкастом по
   * мешам в `pickSurfaceRay`, а `tLimit` (ближайший walkable-`t`) обрезает марш
   * сверху: террейн-попадание дальше walkable уже не победит (REND-15).
   * Поверхность и сетка читаются ТЕКУЩИЕ — правка кистью меняет ответ,
   * пересоздания сервиса для этого не требуется.
   *
   * Вход в клетку, чья поверхность уже выше луча, — это пересечение вертикальной
   * стенки обрыва: попадание разрешается в ЭТУ клетку, то есть в верхнюю, чью
   * площадку стенка подпирает (REND-7, REND-15).
   */
  pick(ray: PickRay, hit: MutablePickHit, tLimit = Number.POSITIVE_INFINITY): boolean {
    const source = this.source;
    const surface = source.current;
    if (surface === null) return false;
    const grid = source.terrain;
    // Приём сетки — точка входной границы рендера (REND-1, TERR-2).
    const tile = grid.tileSize / FIXED_ONE;

    // Луч обрезается прямоугольником арены: клеток вне сетки не нарисовано.
    SLAB_RANGE.tMin = 0;
    SLAB_RANGE.tMax = Number.POSITIVE_INFINITY;
    if (!slabAxis(ray.originX, ray.dirX, 0, grid.width * tile)) return false;
    if (!slabAxis(ray.originY, ray.dirY, 0, grid.height * tile)) return false;
    const tEnter = SLAB_RANGE.tMin;
    const tExit = SLAB_RANGE.tMax;
    if (tEnter > tExit) return false;
    // Walkable ближе входа в арену — терренной ветви уже не победить.
    if (tEnter > tLimit) return false;

    const px = ray.originX + ray.dirX * tEnter;
    const py = ray.originY + ray.dirY * tEnter;
    const cx = clampIndex(Math.floor(px / tile), grid.width);
    const cy = clampIndex(Math.floor(py / tile), grid.height);
    if (this.enterCell(ray, hit, surface, cx, cy, tEnter)) return true;

    const stepX = axisStep(ray.dirX);
    const stepY = axisStep(ray.dirY);
    if (stepX === 0 && stepY === 0) {
      return this.pickPlumb(ray, hit, surface, cx, cy, px, py, tLimit);
    }
    this.beginWalk(ray, tile, tEnter, cx, cy, stepX, stepY);
    return this.marchCells(ray, hit, surface, grid, tExit, tLimit);
  }

  /**
   * Вход в клетку, чья поверхность уже выше луча, — это пересечение
   * вертикальной стенки обрыва: попадание разрешается в ЭТУ клетку, то есть в
   * верхнюю, чью площадку стенка подпирает (REND-7, REND-15). `false` — луч над
   * поверхностью, марш продолжается.
   */
  private enterCell(
    ray: PickRay,
    hit: MutablePickHit,
    surface: VisualSurface,
    cx: number,
    cy: number,
    t: number,
  ): boolean {
    const px = ray.originX + ray.dirX * t;
    const py = ray.originY + ray.dirY * t;
    const f = ray.originZ + ray.dirZ * t - surface.terrainFormHeightInCell(cx, cy, px, py);
    if (f > 0) return false;
    writeSurfaceHit(hit, this.source.terrain, ray, t, cx, cy, f < -WALL_EPS);
    return true;
  }

  /**
   * Отвесный луч клетки не меняет: высота под ним постоянна, и корень находится
   * прямо, без марша. Отдельная ветка нужна ещё и потому, что прямоугольник
   * арены такой луч не ограничивает — выхода из него нет.
   */
  private pickPlumb(
    ray: PickRay,
    hit: MutablePickHit,
    surface: VisualSurface,
    cx: number,
    cy: number,
    px: number,
    py: number,
    tLimit: number,
  ): boolean {
    if (ray.dirZ >= 0) return false;
    const t = (surface.terrainFormHeightInCell(cx, cy, px, py) - ray.originZ) / ray.dirZ;
    if (t > tLimit) return false;
    writeSurfaceHit(hit, this.source.terrain, ray, t, cx, cy, false);
    return true;
  }

  /** Подготовка DDA: клетка входа, длины шагов по осям и первые их границы. */
  private beginWalk(
    ray: PickRay,
    tile: number,
    t: number,
    cx: number,
    cy: number,
    stepX: number,
    stepY: number,
  ): void {
    const px = ray.originX + ray.dirX * t;
    const py = ray.originY + ray.dirY * t;
    const walk = this.walk;
    walk.cx = cx;
    walk.cy = cy;
    walk.t = t;
    walk.stepX = stepX;
    walk.stepY = stepY;
    walk.deltaX = axisDelta(stepX, ray.dirX, tile);
    walk.deltaY = axisDelta(stepY, ray.dirY, tile);
    walk.nextX = axisNext(stepX, ray.dirX, tile, cx, t, px);
    walk.nextY = axisNext(stepY, ray.dirY, tile, cy, t, py);
  }

  /** Переход в следующую клетку по ближайшей границе; false — вышли из сетки. */
  private advanceWalk(grid: TerrainGrid): boolean {
    const walk = this.walk;
    if (walk.nextX <= walk.nextY) {
      walk.cx += walk.stepX;
      walk.t = walk.nextX;
      walk.nextX += walk.deltaX;
    } else {
      walk.cy += walk.stepY;
      walk.t = walk.nextY;
      walk.nextY += walk.deltaY;
    }
    return walk.cx >= 0 && walk.cy >= 0 && walk.cx < grid.width && walk.cy < grid.height;
  }

  /** Марш по клеткам от подготовленного `beginWalk` состояния до выхода из арены. */
  private marchCells(
    ray: PickRay,
    hit: MutablePickHit,
    surface: VisualSurface,
    grid: TerrainGrid,
    tExit: number,
    tLimit: number,
  ): boolean {
    const walk = this.walk;
    // Клеток вдоль луча не больше периметра арены; запас закрывает вырожденные
    // случаи вроде входа ровно в узел сетки.
    const maxSteps = grid.width + grid.height + 4;
    for (let step = 0; step < maxSteps; step++) {
      const tNext = Math.min(walk.nextX, walk.nextY, tExit);
      const tHit = this.scanCell(ray, surface, walk.cx, walk.cy, walk.t, tNext, tLimit);
      if (tHit === CELL_STOP) return false;
      if (tHit !== CELL_CONTINUE) {
        writeSurfaceHit(hit, this.source.terrain, ray, tHit, walk.cx, walk.cy, false);
        return true;
      }
      if (tNext >= tExit) return false;
      if (!this.advanceWalk(grid)) return false;
      if (this.enterCell(ray, hit, surface, walk.cx, walk.cy, walk.t)) return true;
    }
    return false;
  }

  /**
   * Подшаги внутри клетки: вдоль отрезка внутри неё высота — квадратичная, и
   * выпуклость может уйти под луч и вернуться между концами отрезка.
   *
   * Возвращает уточнённый параметр корня либо `CELL_CONTINUE` (корня в клетке
   * нет) / `CELL_STOP` (подшаг упёрся в потолок walkable-`t`, и дальше искать
   * нечего). Обе метки отрицательны, а параметр марша неотрицателен по
   * построению — спутать их нельзя.
   */
  private scanCell(
    ray: PickRay,
    surface: VisualSurface,
    cx: number,
    cy: number,
    t: number,
    tNext: number,
    tLimit: number,
  ): number {
    const steps = this.cellSteps;
    let tPrev = t;
    for (let i = 1; i <= steps; i++) {
      let ts = t + ((tNext - t) * i) / steps;
      // Подшаг обрезается walkable-`t`: корень за ним террейну не отдаётся,
      // а корень ДО него марш обязан найти (REND-15) — поэтому кламп, а не
      // немедленный выход.
      const capped = ts >= tLimit;
      if (capped) ts = tLimit;
      const px = ray.originX + ray.dirX * ts;
      const py = ray.originY + ray.dirY * ts;
      const fs = ray.originZ + ray.dirZ * ts - surface.terrainFormHeightInCell(cx, cy, px, py);
      if (fs <= 0) return this.refine(ray, surface, cx, cy, tPrev, ts);
      if (capped) return CELL_STOP;
      tPrev = ts;
    }
    return CELL_CONTINUE;
  }

  /** Деление пополам между точкой над поверхностью и точкой под ней. */
  private refine(
    ray: PickRay,
    surface: VisualSurface,
    cx: number,
    cy: number,
    tAbove: number,
    tBelow: number,
  ): number {
    let lo = tAbove;
    let hi = tBelow;
    for (let i = 0; i < REFINE_ITERATIONS; i++) {
      const mid = (lo + hi) / 2;
      const mx = ray.originX + ray.dirX * mid;
      const my = ray.originY + ray.dirY * mid;
      if (ray.originZ + ray.dirZ * mid - surface.terrainFormHeightInCell(cx, cy, mx, my) > 0) lo = mid;
      else hi = mid;
    }
    return hi;
  }
}

/** Знак шага марша по оси; 0 — луч по этой оси вырожден. */
function axisStep(dir: number): number {
  return dir > EPS_DIR ? 1 : dir < -EPS_DIR ? -1 : 0;
}

/** Прирост параметра на одну клетку по оси; ось без шага — бесконечность. */
function axisDelta(step: number, dir: number, tile: number): number {
  return step === 0 ? Number.POSITIVE_INFINITY : tile / Math.abs(dir);
}

/** Параметр ближайшей границы клеток по оси от точки `p` в клетке `cell`. */
function axisNext(
  step: number,
  dir: number,
  tile: number,
  cell: number,
  t: number,
  p: number,
): number {
  if (step === 0) return Number.POSITIVE_INFINITY;
  return t + ((cell + (step > 0 ? 1 : 0)) * tile - p) / dir;
}

/**
 * Кламп клетки — общий с полем (`visualSurface.ts`), а не своя копия: марш и
 * поверхность обязаны одинаково понимать «точка за краем арены». Реэкспорт
 * держит адрес, по которому его берут соседи по наведению (`picking.ts`).
 */
export { clampIndex };

/**
 * Попадание в поверхность: точка, клетка, признак отсутствия пола (REND-15).
 * Пишет в запись вызывающего — она у сервиса одна и переиспользуемая, а вторая
 * её форма разошлась бы с первой (`pickContracts.ts`).
 */
export function writeSurfaceHit(
  hit: MutablePickHit,
  grid: TerrainGrid,
  ray: PickRay,
  t: number,
  cx: number,
  cy: number,
  wall: boolean,
): void {
  const cell = cy * grid.width + cx;
  hit.kind = 'surface';
  hit.handle = null;
  hit.entity = 0;
  hit.decoration = false;
  hit.distance = t;
  hit.x = ray.originX + ray.dirX * t;
  hit.y = ray.originY + ray.dirY * t;
  hit.z = ray.originZ + ray.dirZ * t;
  hit.cell = cell;
  hit.cellX = cx;
  hit.cellY = cy;
  // Дыра — клетка сетки, а не отсутствие клетки: кисть пола ED-10 в неё бьёт.
  hit.noFloor = grid.floor[cell] === 0;
  hit.wall = wall;
}
