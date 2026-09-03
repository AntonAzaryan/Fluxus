/**
 * Одно правило «клетка на визуальной поверхности» (REND-9): насколько дробно
 * выбирать поле, чтобы наложение легло НА нарисованную поверхность, а не на её
 * спрямление.
 *
 * Отдельным модулем, потому что строителей у этого правила два — геометрия
 * служебных наложений (`subsystems/overlaySurface.ts`, REND-16) и рисовальщик
 * отладочного слоя (`debug/painter.ts`, RDBG-3), — и разошлись они уже: первый
 * дробил клетку по тесселяции, второй сэмплировал одни вершины, то есть рисовал
 * клетку холма плоским веером сквозь него. Правило здесь одно на обоих; сами
 * буферы каждый строит свои — общего у них ровно дробление.
 *
 * Аллокаций тут нет вовсе: обе функции возвращают число.
 */
import type { TerrainGrid } from '@fluxus/core';
import type { VisualSurface } from './visualSurface.js';

/**
 * Потолок делений стороны для мирового прямоугольника: наложение поперёк всей
 * арены иначе стоило бы `(клетки × тесселяция)²` треугольников. Потолок — на
 * ПРОИЗВОДНОЙ величине (сколько подшагов уместилось), а не на самой
 * тесселяции: у одной клетки он не срабатывает никогда.
 */
const MAX_AREA_STEPS = 16;

/**
 * Делений стороны КЛЕТКИ (REND-9): 1 — высота внутри выводится из её углов, и
 * квад по ним лежит на поверхности точно; иначе — тесселяция поля.
 *
 * Клетка под кривизной или под walkable-накрытием — тот самый случай, когда
 * высота из углов не выводится: у первой поле квадратично внутри клетки, у
 * второй настил накрывает её собственной формой.
 */
export function cellSubdivisions(
  surface: VisualSurface,
  x: number,
  y: number,
  tessellation: number,
): number {
  if (!surface.hasCellCurvature(x, y) && !surface.hasCellWalkable(x, y)) return 1;
  return Math.max(1, Math.floor(tessellation));
}

/**
 * Делений стороны для МИРОВОГО ПРЯМОУГОЛЬНИКА, накрывающего сколько-то клеток:
 * 1 — все накрытые клетки плоские (быстрый путь остаётся бесплатным), иначе —
 * тесселяция на каждую накрытую клетку, чтобы подшаг был не крупнее подклетки.
 *
 * Прямоугольник — а не сам полигон — потому что дробление обязано быть
 * одинаковым у всех его частей: разное число подшагов у соседних треугольников
 * оставило бы между ними щель.
 */
export function areaSubdivisions(
  surface: VisualSurface,
  grid: TerrainGrid,
  tile: number,
  minX: number,
  minY: number,
  maxX: number,
  maxY: number,
  tessellation: number,
): number {
  const x0 = cellIndex(minX, tile, grid.width);
  const y0 = cellIndex(minY, tile, grid.height);
  const x1 = cellIndex(maxX, tile, grid.width);
  const y1 = cellIndex(maxY, tile, grid.height);
  let divided = false;
  for (let y = y0; y <= y1 && !divided; y++) {
    for (let x = x0; x <= x1; x++) {
      if (cellSubdivisions(surface, x, y, tessellation) > 1) {
        divided = true;
        break;
      }
    }
  }
  if (!divided) return 1;
  const cells = Math.max(x1 - x0, y1 - y0) + 1;
  return Math.min(MAX_AREA_STEPS, Math.max(1, Math.floor(tessellation)) * cells);
}

/** Индекс клетки под мировой координатой, прижатый к сетке. */
function cellIndex(world: number, tile: number, size: number): number {
  return Math.min(Math.max(Math.floor(world / tile), 0), size - 1);
}
