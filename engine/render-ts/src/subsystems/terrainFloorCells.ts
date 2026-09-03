/**
 * Клетка пола в буферах геометрии (REND-7, REND-9): плоский квад по углам,
 * сваренная решётка подклеток по кривизне и выборки поля, из которых обе
 * складываются. Отдельно от `terrainGeometry.ts`, потому что там — обход
 * прямоугольника клеток и упаковка результата, а здесь то, что кладётся в
 * буферы на ОДНОЙ клетке; вместе они не читались.
 *
 * Ничего о сцене, ассетах и потолках пресета модуль не знает: на входе сетка,
 * поверхность и источник раскраски, на выходе плоские массивы.
 */
import { type TerrainGrid } from '@fluxus/core';
import { cornerLevels, type SurfaceNormal, type VisualSurface } from '../visualSurface.js';
import { pushPaintWeights, type TerrainPaintSource } from './terrainPaintWeights.js';

/** Накопитель плоских буферов: массивы, растущие вместе с геометрией. */
export interface MeshBuffers {
  readonly positions: number[];
  readonly normals: number[];
  readonly indices: number[];
  /** Веса слотов; `null` — сцена без текстурирования, атрибута не будет. */
  readonly paint: number[] | null;
  /** Раскраска клеток; `null` — весов не считаем. */
  readonly source: TerrainPaintSource | null;
}

/** Одна клетка пола: квад по углам либо разбиение по кривизне (REND-9). */
export function pushFloorCell(
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
  pushPaintWeights(out.paint, out.source, x * tile, y * tile, tile);
  pushPaintWeights(out.paint, out.source, (x + 1) * tile, y * tile, tile);
  pushPaintWeights(out.paint, out.source, (x + 1) * tile, (y + 1) * tile, tile);
  pushPaintWeights(out.paint, out.source, x * tile, (y + 1) * tile, tile);
  // CCW при взгляде с +Z — нормаль вверх.
  out.indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
}

/**
 * Клетка с кривизной — `divisions²` подклеток на СВАРЕННОЙ решётке `(N+1)²`
 * вершин (REND-9). Сварка внутри клетки точна по построению: и позиция, и
 * нормаль суть функции клетки и точки (`terrainFormHeightInCell`,
 * `terrainFormNormalInCell`), поэтому у соседних подклеток на общем ребре они
 * совпадают побитово — вершина одна, а не две с равными значениями.
 *
 * Сварки МЕЖДУ клетками нет намеренно: через cliff-границу нормали не
 * усредняются (REND-9), и общая вершина сшила бы силуэт кромки. Квадов при этом
 * ровно столько же — `terrainFloorQuads` считает индексы, а не вершины.
 */
function pushCurvedCell(
  out: MeshBuffers,
  surface: VisualSurface,
  x: number,
  y: number,
  tile: number,
  divisions: number,
  scratch: SurfaceNormal,
): void {
  const base = out.positions.length / 3;
  const span = divisions + 1;
  for (let j = 0; j < span; j++) {
    const wy = (y + j / divisions) * tile;
    for (let i = 0; i < span; i++) {
      pushSurfaceVertex(out, surface, x, y, (x + i / divisions) * tile, wy, tile, scratch);
    }
  }
  for (let j = 0; j < divisions; j++) {
    for (let i = 0; i < divisions; i++) {
      const a = base + j * span + i;
      const b = a + 1;
      const c = a + span + 1;
      const d = a + span;
      // Тот же обход, что у плоской клетки: CCW при взгляде с +Z.
      out.indices.push(a, b, c, a, c, d);
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
  tile: number,
  scratch: SurfaceNormal,
): void {
  out.positions.push(wx, wy, surface.terrainFormHeightInCell(cellX, cellY, wx, wy));
  pushSurfaceNormal(out.normals, surface, cellX, cellY, wx, wy, scratch);
  pushPaintWeights(out.paint, out.source, wx, wy, tile);
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
