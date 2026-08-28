/**
 * Геометрия наложений, лежащих НА визуальной поверхности (REND-16): клеточная
 * заливка и контурная сетка.
 *
 * Отдельно от подсистемы, потому что это ЧИСТАЯ функция данных: набор клеток
 * плюс поле высот дают буфер вершин, и ни сцены, ни материалов, ни узлов
 * наложения здесь нет. Выборка идёт тем же полем и тем же разбиением, что и пол
 * террейна (REND-9): наложение обязано лежать на нарисованной поверхности, а не
 * на её спрямлении, — прямой контур на сглаженном холме резал бы его насквозь.
 *
 * Приём сетки — точка входной границы рендера (REND-1, TERR-2): `tileSize`
 * делится на `FIXED_ONE` здесь, глубже fixed-point не проникает.
 */
import * as THREE from 'three';
import { FIXED_ONE, type TerrainGrid } from '@fluxus/core';
import type { VisualSurface } from '../visualSurface.js';
import type { OverlayGrid } from './overlayItems.js';

/**
 * Заливка набора клеток; null — рисовать нечего (все клетки вне сетки).
 * Клетка без кривизны и без walkable-накрытия идёт быстрым путём по своим
 * углам; накрытая или изогнутая — разбиением по выборке поля (REND-9): в такой
 * клетке высота не выводится из углов.
 */
export function cellsGeometry(
  cells: readonly number[],
  surface: VisualSurface,
  grid: TerrainGrid,
  lift: number,
  tessellation: number,
): THREE.BufferGeometry | null {
  const tile = grid.tileSize / FIXED_ONE;
  const positions: number[] = [];
  const indices: number[] = [];
  for (const cell of cells) {
    if (cell < 0 || cell >= grid.width * grid.height) continue;
    const x = cell % grid.width;
    const y = Math.floor(cell / grid.width);
    if (!surface.hasCellCurvature(x, y) && !surface.hasCellWalkable(x, y)) {
      pushFlatCell(positions, indices, surface, x, y, tile, lift);
      continue;
    }
    pushDividedCell(positions, indices, surface, x, y, tile, lift, tessellation);
  }
  if (indices.length === 0) return null;
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3));
  geometry.setIndex(new THREE.BufferAttribute(new Uint32Array(indices), 1));
  return geometry;
}

/** Быстрый путь: квад по четырём углам клетки. */
function pushFlatCell(
  positions: number[],
  indices: number[],
  surface: VisualSurface,
  x: number,
  y: number,
  tile: number,
  lift: number,
): void {
  const [h00, h10, h11, h01] = surface.cornerHeights(x, y);
  const base = positions.length / 3;
  positions.push(
    x * tile, y * tile, h00 + lift,
    (x + 1) * tile, y * tile, h10 + lift,
    (x + 1) * tile, (y + 1) * tile, h11 + lift,
    x * tile, (y + 1) * tile, h01 + lift,
  );
  indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
}

/** Клетка под кривизной или настилом — подклетки с вершинами на поле (REND-9). */
function pushDividedCell(
  positions: number[],
  indices: number[],
  surface: VisualSurface,
  x: number,
  y: number,
  tile: number,
  lift: number,
  divisions: number,
): void {
  for (let j = 0; j < divisions; j++) {
    for (let i = 0; i < divisions; i++) {
      const ax = (x + i / divisions) * tile;
      const bx = (x + (i + 1) / divisions) * tile;
      const ay = (y + j / divisions) * tile;
      const by = (y + (j + 1) / divisions) * tile;
      const base = positions.length / 3;
      pushLiftedPoint(positions, surface, x, y, ax, ay, lift);
      pushLiftedPoint(positions, surface, x, y, bx, ay, lift);
      pushLiftedPoint(positions, surface, x, y, bx, by, lift);
      pushLiftedPoint(positions, surface, x, y, ax, by, lift);
      indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
  }
}

/**
 * Контурная сетка прямоугольника клеток; null — рисовать нечего. Сетка идёт по
 * углам клеток той же поверхности — контур клетки, а не плоскости.
 */
export function gridGeometry(
  item: OverlayGrid,
  surface: VisualSurface,
  grid: TerrainGrid,
  lift: number,
  tessellation: number,
): THREE.BufferGeometry | null {
  const tile = grid.tileSize / FIXED_ONE;
  const x0 = Math.max(item.x0 ?? 0, 0);
  const y0 = Math.max(item.y0 ?? 0, 0);
  const x1 = Math.min(item.x1 ?? grid.width - 1, grid.width - 1);
  const y1 = Math.min(item.y1 ?? grid.height - 1, grid.height - 1);
  const positions: number[] = [];
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      pushCellOutline(positions, surface, x, y, tile, lift, tessellation);
    }
  }
  if (positions.length === 0) return null;
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3));
  return geometry;
}

/**
 * Четыре ребра клетки по визуальной поверхности. Клетка с кривизной даёт
 * ломаную по той же выборке поля, что и её пол (REND-9): прямой контур на
 * сглаженном холме резал бы его насквозь.
 */
function pushCellOutline(
  out: number[],
  surface: VisualSurface,
  x: number,
  y: number,
  tile: number,
  lift: number,
  tessellation: number,
): void {
  const x0 = x * tile;
  const y0 = y * tile;
  const x1 = (x + 1) * tile;
  const y1 = (y + 1) * tile;
  // Как у ячеек: под walkable-поверхностью контур идёт выборкой поля (REND-9).
  if (!surface.hasCellCurvature(x, y) && !surface.hasCellWalkable(x, y)) {
    const [h00, h10, h11, h01] = surface.cornerHeights(x, y);
    const z00 = h00 + lift;
    const z10 = h10 + lift;
    const z11 = h11 + lift;
    const z01 = h01 + lift;
    out.push(
      x0, y0, z00, x1, y0, z10,
      x1, y0, z10, x1, y1, z11,
      x1, y1, z11, x0, y1, z01,
      x0, y1, z01, x0, y0, z00,
    );
    return;
  }
  // Рёбра в том же порядке: юг (y0), восток (x1), север (y1), запад (x0).
  pushOutlineEdge(out, surface, x, y, lift, tessellation, x0, y0, x1, y0);
  pushOutlineEdge(out, surface, x, y, lift, tessellation, x1, y0, x1, y1);
  pushOutlineEdge(out, surface, x, y, lift, tessellation, x1, y1, x0, y1);
  pushOutlineEdge(out, surface, x, y, lift, tessellation, x0, y1, x0, y0);
}

/** Ребро контура ломаной по полю: `tessellation` отрезков вместо одного. */
function pushOutlineEdge(
  out: number[],
  surface: VisualSurface,
  cellX: number,
  cellY: number,
  lift: number,
  tessellation: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): void {
  let px = ax;
  let py = ay;
  let pz = surface.heightInCell(cellX, cellY, ax, ay) + lift;
  for (let i = 1; i <= tessellation; i++) {
    const t = i / tessellation;
    const qx = ax + (bx - ax) * t;
    const qy = ay + (by - ay) * t;
    const qz = surface.heightInCell(cellX, cellY, qx, qy) + lift;
    out.push(px, py, pz, qx, qy, qz);
    px = qx;
    py = qy;
    pz = qz;
  }
}

/** Точка ячейки наложения на поле, поднятая над ним на `lift`. */
function pushLiftedPoint(
  out: number[],
  surface: VisualSurface,
  cellX: number,
  cellY: number,
  wx: number,
  wy: number,
  lift: number,
): void {
  out.push(wx, wy, surface.heightInCell(cellX, cellY, wx, wy) + lift);
}
