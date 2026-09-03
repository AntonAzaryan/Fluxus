/**
 * Раскладка арены террейна по чанкам и учёт пометок к пересборке (REND-7).
 *
 * Отдельно от подсистемы по той же причине, по какой отдельно генераторы
 * геометрии: это ФУНКЦИЯ ДАННЫХ — сетка, размер чанка и перечень правок, — и о
 * сцене, материалах и мешах она не знает ничего. Подсистема остаётся про
 * нарисованное; здесь живёт арифметика «клетка → чанк» и два множества
 * помеченных чанков.
 *
 * Множеств два, и это не оптимизация ради оптимизации (TERR-6, TERR-5):
 *
 * - `shape` — правка уровней, рамп, кривизны и walkable-вклада: меняются пол,
 *   стенки обрывов и юбка;
 * - `floor` — мутация карты пола: выбитая клетка меняет пол и юбку соседей
 *   (REND-7), а cliff-геометрию ядро выводит из карты УРОВНЕЙ (TERR-5), и пол в
 *   неё не входит вовсе — стенкам от такой пометки меняться нечем.
 *
 * Cliff-отрезки раскладываются по чанку-ВЛАДЕЛЬЦУ один раз на доставку сетки:
 * иначе пересборка одного чанка обходила бы все обрывы арены — мазок кисти
 * стоил бы O(обрывы) на каждый помеченный чанк, а полная пересборка —
 * O(чанки × обрывы).
 */
import type { TerrainGrid } from '@fluxus/core';
import type { RenderCostCounters } from '../cost.js';
import { cliffOwnerCell } from './terrainGeometry.js';
import type { CellRect } from './terrainGeometry.js';

/** Cliff-отрезок сетки — тот же тип, что отдаёт ядро (TERR-5). */
type CliffEdge = TerrainGrid['cliffs'][number];

/**
 * Радиус влияния правки уровня/рампы в клетках. Уровень клетки виден на
 * расстоянии одной клетки — угол усредняется по смежным (REND-9), а угол рампы
 * тянется к проходимому соседу (TERR-5); стенка же читает углы ОБЕИХ своих
 * клеток, и дальняя из них отстоит от правки ещё на клетку. Отсюда двойка: она
 * задаёт область инвалидации, а не пересчёта — чанк всё равно один и тот же.
 */
const SHAPE_RADIUS = 2;

/**
 * Радиус влияния мутации пола (TERR-6): сам пол виден только в своей клетке,
 * но юбка обрыва (REND-7) стоит на рёбрах с СОСЕДЯМИ — выбитая клетка меняет
 * юбку четырёх смежных, и дальше собственной клетки их рёбра не уходят.
 */
const FLOOR_RADIUS = 1;

export class TerrainChunkMap {
  readonly countX: number;
  readonly countY: number;
  /** Помеченные правкой формы — пол, стенки и юбка чанка устарели. */
  readonly shape = new Set<number>();
  /** Помеченные мутацией пола — устарели пол и юбка, стенки прежние. */
  readonly floor = new Set<number>();
  /** Отрезки обрывов по чанку-владельцу; индекс — номер чанка. */
  private buckets: CliffEdge[][] = [];
  private readonly size: number;
  private grid: TerrainGrid;

  constructor(grid: TerrainGrid, chunkSize: number) {
    this.size = chunkSize;
    this.grid = grid;
    this.countX = Math.ceil(grid.width / chunkSize);
    this.countY = Math.ceil(grid.height / chunkSize);
    this.bucketCliffs();
  }

  /** Чанков в раскладке — величина состояния подсистемы (PERF-8). */
  get count(): number {
    return this.countX * this.countY;
  }

  /** Сетка сменилась в прежних размерах: обрывы другие, раскладка та же. */
  setGrid(grid: TerrainGrid): void {
    this.grid = grid;
    this.bucketCliffs();
  }

  /** Прямоугольник клеток чанка — область пересборки его геометрии. */
  rect(chunk: number): CellRect {
    return {
      x0: (chunk % this.countX) * this.size,
      y0: Math.floor(chunk / this.countX) * this.size,
      w: this.size,
      h: this.size,
    };
  }

  /** Отрезки обрывов, чей владелец лежит в этом чанке (TERR-5). */
  cliffsOf(chunk: number): readonly CliffEdge[] {
    return this.buckets[chunk] ?? [];
  }

  /** Чанк клетки — им адресуется владение отрезком обрыва. */
  chunkOfCell(cell: number): number {
    const x = cell % this.grid.width;
    const y = Math.floor(cell / this.grid.width);
    return Math.floor(y / this.size) * this.countX + Math.floor(x / this.size);
  }

  /** Вся арена устарела формой: смена пресета, новая поверхность, новая сетка. */
  markAll(cost: RenderCostCounters | undefined): void {
    if (cost !== undefined) cost.terrainChunksMarked += this.count;
    for (let chunk = 0; chunk < this.count; chunk++) this.shape.add(chunk);
  }

  /** Правка уровня, рампы или кривизны клетки — окрестность SHAPE_RADIUS. */
  markShape(cell: number, cost: RenderCostCounters | undefined): void {
    this.markRadius(cell, SHAPE_RADIUS, this.shape, cost);
  }

  /** Мутация пола клетки (TERR-6) — окрестность FLOOR_RADIUS, только пол. */
  markFloor(cell: number, cost: RenderCostCounters | undefined): void {
    this.markRadius(cell, FLOOR_RADIUS, this.floor, cost);
  }

  /** Ни одной пометки — кадр стоящей сцены не платит ничем (PERF-2). */
  get clean(): boolean {
    return this.shape.size === 0 && this.floor.size === 0;
  }

  clear(): void {
    this.shape.clear();
    this.floor.clear();
  }

  /** Пометка чанков всех клеток в радиусе `radius` от правки. */
  private markRadius(
    cell: number,
    radius: number,
    target: Set<number>,
    cost: RenderCostCounters | undefined,
  ): void {
    const { width, height } = this.grid;
    const x = cell % width;
    const y = Math.floor(cell / width);
    const cx0 = Math.floor(Math.max(x - radius, 0) / this.size);
    const cx1 = Math.floor(Math.min(x + radius, width - 1) / this.size);
    const cy0 = Math.floor(Math.max(y - radius, 0) / this.size);
    const cy1 = Math.floor(Math.min(y + radius, height - 1) / this.size);
    // Правка одной клетки метит окрестность, и повторные пометки соседних
    // клеток считаются: каждая — свой поиск в множестве, а пересборок от них не
    // прибавляется (их считает `terrainChunksRebuilt`).
    if (cost !== undefined) cost.terrainChunksMarked += (cx1 - cx0 + 1) * (cy1 - cy0 + 1);
    for (let cy = cy0; cy <= cy1; cy++) {
      for (let cx = cx0; cx <= cx1; cx++) target.add(cy * this.countX + cx);
    }
  }

  private bucketCliffs(): void {
    this.buckets = Array.from({ length: this.count }, (): CliffEdge[] => []);
    for (const edge of this.grid.cliffs) {
      this.buckets[this.chunkOfCell(cliffOwnerCell(this.grid, edge))]!.push(edge);
    }
  }
}
