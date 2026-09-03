/**
 * Чистые генераторы геометрии террейна (REND-7, REND-9) — площадки пола и
 * вертикальные стенки обрывов из сетки ядра и визуальной поверхности; юбка
 * границы пола — третий генератор, в соседнем `terrainSkirt.ts`.
 *
 * Отдельно от подсистемы, потому что генераторы — ФУНКЦИИ ДАННЫХ и ничего о
 * сцене не знают: их зовут и подсистема при пересборке чанка, и редактор, и
 * тесты, а результат один и тот же на одном и том же входе. Сцена, материалы,
 * чанки и ручки качества остаются в `terrain.ts`.
 *
 * Сетка — точка входной границы рендера (REND-1): `tileSize` и координаты
 * cliff-отрезков в ней fixed-point (TERR-2), поэтому деления на `FIXED_ONE`
 * стоят здесь, в точке приёма, и должны там оставаться — глубже по коду
 * рендера fixed-point значений и их арифметики нет.
 */
import { FIXED_ONE, type TerrainGrid } from '@fluxus/core';
import { DEFAULT_CURVATURE_TESSELLATION } from '../types.js';
import { costSink } from '../cost.js';
import { cornerLevels, type SurfaceNormal, type VisualSurface } from '../visualSurface.js';

export interface TerrainGeometryData {
  readonly positions: Float32Array;
  readonly indices: Uint32Array;
  /**
   * Нормали вершин, если генератор посчитал их сам (REND-9): пол берёт их из
   * поля высот в клетке-владельце вершины. Нет — нормали считает
   * `toBufferGeometry` по треугольникам, и стенка обрыва остаётся плоской.
   */
  readonly normals?: Float32Array;
}

/** Прямоугольник клеток [x0..x0+w) × [y0..y0+h) — область пересборки чанка. */
export interface CellRect {
  readonly x0: number;
  readonly y0: number;
  readonly w: number;
  readonly h: number;
}

/** Накопитель плоских буферов: три массива, растущие вместе с геометрией. */
interface MeshBuffers {
  readonly positions: number[];
  readonly normals: number[];
  readonly indices: number[];
}

/**
 * Площадки пола для прямоугольника клеток [x0..x0+w) × [y0..y0+h). Геометрия —
 * ВЫБОРКА визуальной поверхности (REND-9), а не её углы: клетка, у которой хотя
 * бы одно узловое смещение ненулевое, разбивается на `tessellation ×
 * tessellation` подклеток с вершинами на поле; клетка без кривизны остаётся
 * одним квадом по `cornerHeights`, и сцена без карты кривизны собирает ровно ту
 * же геометрию, что и до сглаживания. Без `surface` высоты берутся из
 * `cornerLevels` — плоские ступени REND-7.
 *
 * Нормали генератор считает сам, из поля в клетке-владельце вершины: соседние
 * клетки одного уровня сходятся на общем ребре по построению, а через
 * cliff-границу не усредняются вовсе (REND-9).
 *
 * Клетка без пола (`floor[cell] === 0`) не получает геометрии вовсе — это и
 * есть дыра (REND-7).
 */
export function buildFloorGeometry(
  grid: TerrainGrid,
  floor: Uint8Array,
  heightStep: number,
  x0: number,
  y0: number,
  w: number,
  h: number,
  surface?: VisualSurface,
  tessellation: number = DEFAULT_CURVATURE_TESSELLATION,
): TerrainGeometryData {
  // Сток читается один раз на ВЫЗОВ, как у растра маски тумана (PERF-3): счётчик
  // живёт у генератора, а не у обвязки, — прямой вызов генератора (редактор,
  // тесты) считается ровно так же, как пересборка чанка подсистемой.
  const cost = costSink();
  // Приём `tileSize` — точка входной границы (REND-1, SHELL-5, TERR-2).
  const tile = grid.tileSize / FIXED_ONE;
  const out: MeshBuffers = { positions: [], normals: [], indices: [] };
  const steps = Math.max(1, Math.floor(tessellation));
  const scratch: SurfaceNormal = { x: 0, y: 0, z: 0 };

  const x1 = Math.min(x0 + w, grid.width);
  const y1 = Math.min(y0 + h, grid.height);
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      if (floor[y * grid.width + x] === 0) continue; // дыра: пола нет
      pushFloorCell(out, grid, x, y, tile, heightStep, steps, surface, scratch);
    }
  }
  // Квад — шесть индексов, и другой геометрии у пола нет: клетка без кривизны
  // даёт один квад, клетка с кривизной — `divisions²` подклеток, клетка без пола
  // — ни одного. Одно деление в конце вместо инкремента в двух ветках цикла
  // (PERF-3): считать нечего, число уже собрано самим построением.
  if (cost !== undefined) cost.terrainFloorQuads += out.indices.length / 6;
  return {
    positions: new Float32Array(out.positions),
    indices: new Uint32Array(out.indices),
    normals: new Float32Array(out.normals),
  };
}

/** Одна клетка пола: квад по углам либо разбиение по кривизне (REND-9). */
function pushFloorCell(
  out: MeshBuffers,
  grid: TerrainGrid,
  x: number,
  y: number,
  tile: number,
  heightStep: number,
  steps: number,
  surface: VisualSurface | undefined,
  scratch: SurfaceNormal,
): void {
  const divisions = surface?.hasCellCurvature(x, y) === true ? steps : 1;
  if (surface === undefined || divisions === 1) {
    pushFlatCell(out, grid, x, y, tile, heightStep, surface, scratch);
    return;
  }
  // Разбиение: вершины стоят на поле, а не на хорде между углами клетки.
  pushCurvedCell(out, surface, x, y, tile, divisions, scratch);
}

/** Клетка без кривизны — один квад по углам поля либо по ступеням уровней. */
function pushFlatCell(
  out: MeshBuffers,
  grid: TerrainGrid,
  x: number,
  y: number,
  tile: number,
  heightStep: number,
  surface: VisualSurface | undefined,
  scratch: SurfaceNormal,
): void {
  let h00: number;
  let h10: number;
  let h11: number;
  let h01: number;
  if (surface !== undefined) {
    [h00, h10, h11, h01] = surface.cornerHeights(x, y);
  } else {
    const [c00, c10, c11, c01] = cornerLevels(grid, x, y);
    h00 = c00 * heightStep;
    h10 = c10 * heightStep;
    h11 = c11 * heightStep;
    h01 = c01 * heightStep;
  }
  const base = out.positions.length / 3;
  out.positions.push(
    x * tile, y * tile, h00,
    (x + 1) * tile, y * tile, h10,
    (x + 1) * tile, (y + 1) * tile, h11,
    x * tile, (y + 1) * tile, h01,
  );
  if (surface === undefined) {
    // Поля нет вовсе — только база: у площадки нормаль вертикальна, у
    // рампы постоянна, и вершины квада получают одну и ту же (REND-7).
    quadNormal(h00, h10, h11, h01, 0.5, 0.5, tile, scratch);
    for (let i = 0; i < 4; i++) out.normals.push(scratch.x, scratch.y, scratch.z);
  } else {
    pushSurfaceNormal(out.normals, surface, x, y, x * tile, y * tile, scratch);
    pushSurfaceNormal(out.normals, surface, x, y, (x + 1) * tile, y * tile, scratch);
    pushSurfaceNormal(out.normals, surface, x, y, (x + 1) * tile, (y + 1) * tile, scratch);
    pushSurfaceNormal(out.normals, surface, x, y, x * tile, (y + 1) * tile, scratch);
  }
  // CCW при взгляде с +Z — нормаль вверх.
  out.indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
}

/** Клетка с кривизной — `divisions²` подклеток с вершинами на поле (REND-9). */
function pushCurvedCell(
  out: MeshBuffers,
  surface: VisualSurface,
  x: number,
  y: number,
  tile: number,
  divisions: number,
  scratch: SurfaceNormal,
): void {
  for (let j = 0; j < divisions; j++) {
    for (let i = 0; i < divisions; i++) {
      const ax = (x + i / divisions) * tile;
      const bx = (x + (i + 1) / divisions) * tile;
      const ay = (y + j / divisions) * tile;
      const by = (y + (j + 1) / divisions) * tile;
      const base = out.positions.length / 3;
      pushSurfaceVertex(out, surface, x, y, ax, ay, scratch);
      pushSurfaceVertex(out, surface, x, y, bx, ay, scratch);
      pushSurfaceVertex(out, surface, x, y, bx, by, scratch);
      pushSurfaceVertex(out, surface, x, y, ax, by, scratch);
      out.indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
  }
}

/**
 * Вершина на поле: позиция и нормаль читаются в клетке-владельце (REND-9).
 * Выборка — ТЕРРЕЙН-ФОРМА: walkable-поверхность в геометрию террейна не
 * попадает — настил рисует меш самой декорации, и подклетки пола под ним были
 * бы вторым изображением той же поверхности (REND-9).
 */
function pushSurfaceVertex(
  out: MeshBuffers,
  surface: VisualSurface,
  cellX: number,
  cellY: number,
  wx: number,
  wy: number,
  scratch: SurfaceNormal,
): void {
  out.positions.push(wx, wy, surface.terrainFormHeightInCell(cellX, cellY, wx, wy));
  pushSurfaceNormal(out.normals, surface, cellX, cellY, wx, wy, scratch);
}

function pushSurfaceNormal(
  normals: number[],
  surface: VisualSurface,
  cellX: number,
  cellY: number,
  wx: number,
  wy: number,
  scratch: SurfaceNormal,
): void {
  surface.terrainFormNormalInCell(cellX, cellY, wx, wy, scratch);
  normals.push(scratch.x, scratch.y, scratch.z);
}

/**
 * Нормаль билинейной площадки по её углам — вырожденный случай «поля нет»:
 * слагаемого кривизны не существует, остаётся производная базы. Второй
 * реализации ПОЛЯ это не заводит (REND-9): поля здесь нет вовсе.
 */
function quadNormal(
  h00: number,
  h10: number,
  h11: number,
  h01: number,
  u: number,
  v: number,
  tile: number,
  out: SurfaceNormal,
): void {
  const dhdx = ((1 - v) * (h10 - h00) + v * (h11 - h01)) / tile;
  const dhdy = ((1 - u) * (h01 - h00) + u * (h11 - h10)) / tile;
  const invLen = 1 / Math.sqrt(dhdx * dhdx + dhdy * dhdy + 1);
  out.x = -dhdx * invLen;
  out.y = -dhdy * invLen;
  out.z = invLen;
}

/**
 * Разобранный cliff-отрезок: клетки его сторон, узлы сетки на концах и мировые
 * координаты концов. Одна запись на вызов — разбор отрезка не аллоцирует.
 */
interface WallEdge {
  cellA: number;
  cellB: number;
  fromNodeX: number;
  fromNodeY: number;
  toNodeX: number;
  toNodeY: number;
  fx: number;
  fy: number;
  tx: number;
  ty: number;
}

/** Точка кромки стенки: мировая горизонталь и вертикальный пролёт под полом. */
interface WallPoint {
  x: number;
  y: number;
  low: number;
  high: number;
}

/**
 * Вертикальные стенки по cliff-отрезкам ядра (TERR-5 → REND-7). Отрезок лежит
 * на границе двух клеток; стенка тянется от нижнего уровня пары до верхнего.
 * Сами отрезки не пересчитываются — берутся из `grid.cliffs` как есть.
 *
 * При наличии `surface` кромки стенки на каждом конце отрезка тянутся до
 * фактических визуальных высот углов обеих клеток (skirt): кривизна смещает
 * кромку пола, и стенка обязана дойти до неё без щели (REND-9).
 *
 * Если хотя бы одна из клеток отрезка несёт кривизну, кромка пола над стенкой
 * разбита — и стенка разбивается вместе с ней на `tessellation` квадов теми же
 * выборками поля: спрямлённая хордой стенка под разбитым полом дала бы щель
 * (REND-9). Отрезок без кривизны с обеих сторон остаётся одним квадом.
 *
 * `bounds` ограничивает выборку отрезками, чья ВЛАДЕЮЩАЯ клетка попала в
 * прямоугольник. Владелец — клетка с меньшей координатой по нормали ребра
 * (`cellA`), поэтому владение — разбиение: объединение стенок всех чанков даёт
 * ровно `grid.cliffs` и ни одного отрезка дважды.
 */
export function buildWallGeometry(
  grid: TerrainGrid,
  heightStep: number,
  surface?: VisualSurface,
  bounds?: CellRect,
  tessellation: number = DEFAULT_CURVATURE_TESSELLATION,
): TerrainGeometryData {
  const cost = costSink(); // один раз на вызов — как у пола (PERF-3)
  const positions: number[] = [];
  const indices: number[] = [];
  // Приём `tileSize` — та же точка входной границы, что у пола (REND-1, TERR-2).
  const tile = grid.tileSize / FIXED_ONE;
  const steps = Math.max(1, Math.floor(tessellation));
  const wall: WallEdge = {
    cellA: 0,
    cellB: 0,
    fromNodeX: 0,
    fromNodeY: 0,
    toNodeX: 0,
    toNodeY: 0,
    fx: 0,
    fy: 0,
    tx: 0,
    ty: 0,
  };
  for (const edge of grid.cliffs) {
    readWallCells(grid, edge, wall);
    if (outsideBounds(grid, bounds, wall.cellA)) continue;
    readWallEnds(grid, edge, wall);
    pushWall(positions, indices, grid, heightStep, surface, wall, tile, steps);
  }
  // Те же шесть индексов на квад, что у пола: отрезок без кривизны с обеих
  // сторон даёт один квад, отрезок под разбитой кромкой — `divisions` (REND-9).
  if (cost !== undefined) cost.terrainWallQuads += indices.length / 6;
  return { positions: new Float32Array(positions), indices: new Uint32Array(indices) };
}

/**
 * Клетки сторон отрезка. Координаты отрезка — точка входной границы (REND-1,
 * TERR-2, TERR-5): индекс клетки считается в fixed-домене — кратность
 * `tileSize` делает деление точным.
 */
function readWallCells(grid: TerrainGrid, edge: TerrainGrid['cliffs'][number], out: WallEdge): void {
  if (edge.from.x === edge.to.x) {
    // Вертикальная граница x = X: клетки (X-1, Y) и (X, Y).
    const x = Math.round(edge.from.x / grid.tileSize);
    const y = Math.round(Math.min(edge.from.y, edge.to.y) / grid.tileSize);
    out.cellA = y * grid.width + (x - 1);
    out.cellB = y * grid.width + x;
    return;
  }
  // Горизонтальная граница y = Y: клетки (X, Y-1) и (X, Y).
  const y = Math.round(edge.from.y / grid.tileSize);
  const x = Math.round(Math.min(edge.from.x, edge.to.x) / grid.tileSize);
  out.cellA = (y - 1) * grid.width + x;
  out.cellB = y * grid.width + x;
}

/** Узлы сетки на концах отрезка и их мировые координаты во float (REND-1). */
function readWallEnds(grid: TerrainGrid, edge: TerrainGrid['cliffs'][number], out: WallEdge): void {
  out.fromNodeX = Math.round(edge.from.x / grid.tileSize);
  out.fromNodeY = Math.round(edge.from.y / grid.tileSize);
  out.toNodeX = Math.round(edge.to.x / grid.tileSize);
  out.toNodeY = Math.round(edge.to.y / grid.tileSize);
  out.fx = edge.from.x / FIXED_ONE;
  out.fy = edge.from.y / FIXED_ONE;
  out.tx = edge.to.x / FIXED_ONE;
  out.ty = edge.to.y / FIXED_ONE;
}

/** Владеющая клетка отрезка вне прямоугольника пересборки — стенка не наша. */
function outsideBounds(
  grid: TerrainGrid,
  bounds: CellRect | undefined,
  owner: number,
): boolean {
  if (bounds === undefined) return false;
  const ownerX = owner % grid.width;
  const ownerY = Math.floor(owner / grid.width);
  return (
    ownerX < bounds.x0 ||
    ownerY < bounds.y0 ||
    ownerX >= bounds.x0 + bounds.w ||
    ownerY >= bounds.y0 + bounds.h
  );
}

/** Переиспользуемая точка кромки: разбор отрезка идёт по одной точке за шаг. */
const WALL_POINT: WallPoint = { x: 0, y: 0, low: 0, high: 0 };

/** Полоса квадов одной стенки: по квадру на пролёт между соседними кромками. */
function pushWall(
  positions: number[],
  indices: number[],
  grid: TerrainGrid,
  heightStep: number,
  surface: VisualSurface | undefined,
  wall: WallEdge,
  tile: number,
  steps: number,
): void {
  const divisions = wallDivisions(grid, surface, wall, steps);
  const point = WALL_POINT;
  // Концы отрезка берутся по углам клеток — так же, как до разбиения, чтобы
  // отрезок без кривизны давал побитово прежний квад; промежуточные точки —
  // тем же `heightInCell`, каким считает пол.
  let prevX = wall.fx;
  let prevY = wall.fy;
  let prevLow = 0;
  let prevHigh = 0;
  for (let i = 0; i <= divisions; i++) {
    wallPoint(grid, heightStep, surface, wall, tile, divisions, i, point);
    if (i > 0) {
      const base = positions.length / 3;
      positions.push(
        prevX, prevY, prevLow,
        point.x, point.y, point.low,
        point.x, point.y, point.high,
        prevX, prevY, prevHigh,
      );
      // Материал двусторонний — ориентация не нормируется.
      indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
    prevX = point.x;
    prevY = point.y;
    prevLow = point.low;
    prevHigh = point.high;
  }
}

/** Разбиение кромки — ровно там, где разбита кромка пола над стенкой (REND-9). */
function wallDivisions(
  grid: TerrainGrid,
  surface: VisualSurface | undefined,
  wall: WallEdge,
  steps: number,
): number {
  if (surface === undefined) return 1;
  const curved =
    surface.hasCellCurvature(wall.cellA % grid.width, Math.floor(wall.cellA / grid.width)) ||
    surface.hasCellCurvature(wall.cellB % grid.width, Math.floor(wall.cellB / grid.width));
  return curved ? steps : 1;
}

/** Кромка стенки на шаге `i`: концы — по углам клеток, середина — выборкой поля. */
function wallPoint(
  grid: TerrainGrid,
  heightStep: number,
  surface: VisualSurface | undefined,
  wall: WallEdge,
  tile: number,
  divisions: number,
  i: number,
  out: WallPoint,
): void {
  if (i === 0) {
    wallEnd(grid, heightStep, surface, wall, true, out);
    return;
  }
  if (i === divisions) {
    wallEnd(grid, heightStep, surface, wall, false, out);
    return;
  }
  out.x = (wall.fromNodeX + ((wall.toNodeX - wall.fromNodeX) * i) / divisions) * tile;
  out.y = (wall.fromNodeY + ((wall.toNodeY - wall.fromNodeY) * i) / divisions) * tile;
  wallSpan(
    out,
    sampleWallSide(grid, heightStep, surface, wall.cellA, out.x, out.y),
    sampleWallSide(grid, heightStep, surface, wall.cellB, out.x, out.y),
  );
}

/** Конец отрезка: кромка тянется до фактических высот углов обеих клеток. */
function wallEnd(
  grid: TerrainGrid,
  heightStep: number,
  surface: VisualSurface | undefined,
  wall: WallEdge,
  first: boolean,
  out: WallPoint,
): void {
  const nodeX = first ? wall.fromNodeX : wall.toNodeX;
  const nodeY = first ? wall.fromNodeY : wall.toNodeY;
  out.x = first ? wall.fx : wall.tx;
  out.y = first ? wall.fy : wall.ty;
  wallSpan(
    out,
    cornerHeight(grid, heightStep, surface, wall.cellA, nodeX, nodeY),
    cornerHeight(grid, heightStep, surface, wall.cellB, nodeX, nodeY),
  );
}

/** Вертикальный пролёт кромки: от нижней высоты пары клеток до верхней. */
function wallSpan(out: WallPoint, hA: number, hB: number): void {
  out.low = Math.min(hA, hB);
  out.high = Math.max(hA, hB);
}

/**
 * Высота угла клетки `cell` в узле сетки (nodeX, nodeY). Экспорт — для
 * генератора юбки (`terrainSkirt.ts`): кромка юбки обязана считаться теми же
 * выборками, что кромка стенки (REND-9), а не их копией.
 */
export function cornerHeight(
  grid: TerrainGrid,
  heightStep: number,
  surface: VisualSurface | undefined,
  cell: number,
  nodeX: number,
  nodeY: number,
): number {
  if (surface === undefined) return grid.levels[cell]! * heightStep;
  const cx = cell % grid.width;
  const cy = Math.floor(cell / grid.width);
  const heights = surface.cornerHeights(cx, cy);
  // Индекс угла по смещению узла от клетки: (0,0)→c00, (1,0)→c10, (1,1)→c11, (0,1)→c01.
  const dx = nodeX - cx;
  const dy = nodeY - cy;
  return heights[dy === 0 ? dx : 3 - dx]!;
}

/**
 * Высота поля в клетке стороны отрезка; без поля — плоская ступень уровня.
 * Террейн-форма, как у пола: кромка стенки идёт под кромкой пола, а walkable
 * в геометрию террейна не входит (REND-9). Экспорт — для генератора юбки, по
 * той же причине, что у `cornerHeight`.
 */
export function sampleWallSide(
  grid: TerrainGrid,
  heightStep: number,
  surface: VisualSurface | undefined,
  cell: number,
  wx: number,
  wy: number,
): number {
  if (surface === undefined) return grid.levels[cell]! * heightStep;
  return surface.terrainFormHeightInCell(cell % grid.width, Math.floor(cell / grid.width), wx, wy);
}
