/**
 * Юбка обрыва по границе пола (REND-7) — третий чистый генератор геометрии
 * террейна, рядом с полом и стенками из `terrainGeometry.ts`: вдоль ребра
 * клетки с полом, за которым пола нет — сосед без пола либо край сетки, —
 * полоса квадов от кромки пола вниз на глубину юбки. Арена-остров (TERR-6)
 * читается массивом над провалом, выбитая клетка — колодцем, а не сквозным
 * вырезом до фона. Юбка — производная генератора от карты пола и границ сетки:
 * в cliff-геометрию ядра (TERR-5) и физику она не входит.
 *
 * Как и соседи, генератор — ФУНКЦИЯ ДАННЫХ: сцены он не знает, а `tileSize`
 * принимает в точке входной границы рендера (REND-1, TERR-2).
 */
import { FIXED_ONE, type TerrainGrid } from '@fluxus/core';
import { DEFAULT_CURVATURE_TESSELLATION } from '../types.js';
import { costSink } from '../cost.js';
import type { VisualSurface } from '../visualSurface.js';
import { cornerHeight, sampleWallSide, type TerrainGeometryData } from './terrainGeometry.js';

/**
 * Низ «бесконечной» юбки (`depth === Infinity`), мировые единицы. Настоящую
 * бесконечность Float32-геометрия не переносит (нормали и bounding-объёмы
 * вырождаются в NaN), поэтому бесконечность означает «ниже любой видимой точки
 * сцены»: константа лежит на порядки ниже минимума шкалы уровней с кривизной,
 * а дальняя плоскость камеры срезает стенку задолго до этой глубины.
 */
export const SKIRT_BOTTOMLESS_Z = -1024;

/** Растущие буферы юбки — один набор на вызов генератора. */
interface SkirtBuffers {
  readonly positions: number[];
  readonly indices: number[];
}

/**
 * Ребро юбки: клетка-владелец (с полом), сосед за ребром (координаты −1 —
 * ребро на краю сетки, соседа нет) и узлы сетки концов. Одна запись на вызов.
 */
interface SkirtEdge {
  ownerX: number;
  ownerY: number;
  neighborX: number;
  neighborY: number;
  fromNodeX: number;
  fromNodeY: number;
  toNodeX: number;
  toNodeY: number;
}

/** Переиспользуемое ребро юбки — разбор идёт по одному ребру за шаг. */
const SKIRT_EDGE: SkirtEdge = {
  ownerX: 0,
  ownerY: 0,
  neighborX: 0,
  neighborY: 0,
  fromNodeX: 0,
  fromNodeY: 0,
  toNodeX: 0,
  toNodeY: 0,
};

/** Смещения соседа и узлов концов ребра для четырёх сторон клетки (x, y). */
const SKIRT_SIDES: readonly (readonly [number, number, number, number, number, number])[] = [
  // [dnx, dny, fromDX, fromDY, toDX, toDY] — сосед и узлы относительно клетки.
  [0, -1, 0, 0, 1, 0], // юг: ребро y, сосед (x, y-1)
  [1, 0, 1, 0, 1, 1], // восток: ребро x+1, сосед (x+1, y)
  [0, 1, 0, 1, 1, 1], // север: ребро y+1, сосед (x, y+1)
  [-1, 0, 0, 0, 0, 1], // запад: ребро x, сосед (x-1, y)
];

/**
 * Юбка обрыва для прямоугольника клеток [x0..x0+w) × [y0..y0+h) (REND-7).
 *
 * Верх кромки в точке — МЕНЬШАЯ из высот двух клеток ребра (сосед за краем
 * сетки высоты не имеет — берётся владелец): там, где на том же ребре стоит
 * стенка cliff-отрезка, она уже накрывает пролёт от нижней высоты до верхней,
 * и юбка, начатая от нижней, продолжает её вниз встык — без перекрытия в общей
 * плоскости и без щели. Выборка — та же, что у стенок (REND-9): концы по углам
 * клеток, промежуточные точки разбитой кромки — полем в клетке стороны;
 * низ = верх − `depth`, поэтому нижняя кромка следует профилю верхней и полосы
 * соседних клеток смыкаются без швов.
 *
 * `depth <= 0` выключает юбку — геометрия пуста; `depth === Infinity` делает
 * её бездонной — низ уходит на `SKIRT_BOTTOMLESS_Z`, число квадов от глубины
 * не зависит. Владелец ребра — клетка с
 * полом, она лежит ровно в одном чанке, поэтому владение — разбиение, как у
 * стенок: объединение юбок всех чанков не содержит ребра дважды.
 */
export function buildSkirtGeometry(
  grid: TerrainGrid,
  floor: Uint8Array,
  heightStep: number,
  depth: number,
  x0: number,
  y0: number,
  w: number,
  h: number,
  surface?: VisualSurface,
  tessellation: number = DEFAULT_CURVATURE_TESSELLATION,
): TerrainGeometryData {
  const cost = costSink(); // один раз на вызов — как у пола и стенок (PERF-3)
  const out: SkirtBuffers = { positions: [], indices: [] };
  if (depth > 0) {
    const steps = Math.max(1, Math.floor(tessellation));
    const x1 = Math.min(x0 + w, grid.width);
    const y1 = Math.min(y0 + h, grid.height);
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        // Владелец ребра — клетка с полом; без пола рёбер юбки у клетки нет.
        if (floor[y * grid.width + x] === 0) continue;
        pushCellSkirt(out, grid, floor, heightStep, depth, surface, x, y, steps);
      }
    }
  }
  // Те же шесть индексов на квад, что у пола и стенок: ребро без кривизны даёт
  // один, ребро под разбитой кромкой — `divisions` (REND-9).
  if (cost !== undefined) cost.terrainSkirtQuads += out.indices.length / 6;
  return {
    positions: new Float32Array(out.positions),
    indices: new Uint32Array(out.indices),
  };
}

/** Рёбра одной клетки с полом: полоса на каждую сторону, за которой пола нет. */
function pushCellSkirt(
  out: SkirtBuffers,
  grid: TerrainGrid,
  floor: Uint8Array,
  heightStep: number,
  depth: number,
  surface: VisualSurface | undefined,
  x: number,
  y: number,
  steps: number,
): void {
  const edge = SKIRT_EDGE;
  for (const [dnx, dny, fdx, fdy, tdx, tdy] of SKIRT_SIDES) {
    const nx = x + dnx;
    const ny = y + dny;
    const inGrid = nx >= 0 && ny >= 0 && nx < grid.width && ny < grid.height;
    if (inGrid && floor[ny * grid.width + nx] !== 0) continue; // за ребром пол есть
    edge.ownerX = x;
    edge.ownerY = y;
    edge.neighborX = inGrid ? nx : -1;
    edge.neighborY = inGrid ? ny : -1;
    edge.fromNodeX = x + fdx;
    edge.fromNodeY = y + fdy;
    edge.toNodeX = x + tdx;
    edge.toNodeY = y + tdy;
    pushSkirt(out, grid, heightStep, depth, surface, edge, steps);
  }
}

/**
 * Полоса квадов одного ребра юбки: верх — кромка пола, низ — верх − depth; у
 * бесконечной глубины низ — плоский `SKIRT_BOTTOMLESS_Z`, профиль кромки
 * повторять ему незачем: на этой глубине его никто не увидит.
 */
function pushSkirt(
  out: SkirtBuffers,
  grid: TerrainGrid,
  heightStep: number,
  depth: number,
  surface: VisualSurface | undefined,
  edge: SkirtEdge,
  steps: number,
): void {
  // Приём `tileSize` — точка входной границы (REND-1, TERR-2).
  const tile = grid.tileSize / FIXED_ONE;
  const divisions = skirtDivisions(surface, edge, steps);
  let prevX = 0;
  let prevY = 0;
  let prevTop = 0;
  for (let i = 0; i <= divisions; i++) {
    const nodeX = edge.fromNodeX + ((edge.toNodeX - edge.fromNodeX) * i) / divisions;
    const nodeY = edge.fromNodeY + ((edge.toNodeY - edge.fromNodeY) * i) / divisions;
    const wx = nodeX * tile;
    const wy = nodeY * tile;
    const top =
      i === 0 || i === divisions
        ? skirtCornerTop(grid, heightStep, surface, edge, nodeX, nodeY)
        : skirtSampleTop(grid, heightStep, surface, edge, wx, wy);
    if (i > 0) {
      const base = out.positions.length / 3;
      const prevBottom = Number.isFinite(depth) ? prevTop - depth : SKIRT_BOTTOMLESS_Z;
      const bottom = Number.isFinite(depth) ? top - depth : SKIRT_BOTTOMLESS_Z;
      out.positions.push(
        prevX, prevY, prevBottom,
        wx, wy, bottom,
        wx, wy, top,
        prevX, prevY, prevTop,
      );
      // Материал двусторонний — ориентация не нормируется, как у стенок.
      out.indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
    prevX = wx;
    prevY = wy;
    prevTop = top;
  }
}

/** Разбиение кромки юбки — там же, где разбита кромка пола над ней (REND-9). */
function skirtDivisions(
  surface: VisualSurface | undefined,
  edge: SkirtEdge,
  steps: number,
): number {
  if (surface === undefined) return 1;
  const curved =
    surface.hasCellCurvature(edge.ownerX, edge.ownerY) ||
    (edge.neighborX >= 0 && surface.hasCellCurvature(edge.neighborX, edge.neighborY));
  return curved ? steps : 1;
}

/**
 * Верх юбки в узле сетки: меньшая из высот углов клеток ребра. Высота угла —
 * ровно `cornerHeight` стенок (REND-9), включая ветвь без поля: угол рампы
 * поднят к проходимому соседу (TERR-5), и юбка обязана дойти до фактической
 * кромки пола без щели. Своей копии этого правила у юбки нет.
 */
function skirtCornerTop(
  grid: TerrainGrid,
  heightStep: number,
  surface: VisualSurface | undefined,
  edge: SkirtEdge,
  nodeX: number,
  nodeY: number,
): number {
  const ownerCell = edge.ownerY * grid.width + edge.ownerX;
  const owner = cornerHeight(grid, heightStep, surface, ownerCell, nodeX, nodeY);
  if (edge.neighborX < 0) return owner;
  const neighborCell = edge.neighborY * grid.width + edge.neighborX;
  return Math.min(owner, cornerHeight(grid, heightStep, surface, neighborCell, nodeX, nodeY));
}

/** Верх юбки в промежуточной точке разбитой кромки: меньшая из выборок поля. */
function skirtSampleTop(
  grid: TerrainGrid,
  heightStep: number,
  surface: VisualSurface | undefined,
  edge: SkirtEdge,
  wx: number,
  wy: number,
): number {
  const ownerCell = edge.ownerY * grid.width + edge.ownerX;
  const owner = sampleWallSide(grid, heightStep, surface, ownerCell, wx, wy);
  if (edge.neighborX < 0) return owner;
  const neighborCell = edge.neighborY * grid.width + edge.neighborX;
  return Math.min(owner, sampleWallSide(grid, heightStep, surface, neighborCell, wx, wy));
}
