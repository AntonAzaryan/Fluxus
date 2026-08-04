/**
 * Подсистема террейна (REND-7): ступени из тех же данных, что видит симуляция.
 *
 * Горизонтальные площадки — на высоте `уровень × heightStep`, вертикальные
 * стенки — по cliff-отрезкам, ПЕРЕИСПОЛЬЗОВАННЫМ из производной геометрии ядра
 * (`TerrainGrid.cliffs`, TERR-5), а не выведенным заново; рампы — наклонные
 * площадки; клетки без пола — дыры. Силуэт совпадает с симуляционным по
 * построению: источник данных один.
 *
 * Мутация пола (TERR-6) приходит дельтой клеток из presentation-состояния и
 * пересобирает затронутый чанк не позже следующего кадра; полная пересборка
 * чанка — осознанный выбор MVP (см. design Risks).
 */
import * as THREE from 'three';
import { FIXED_ONE, type TerrainGrid } from '@game-mvp/core';
import type { RenderContext, RenderSubsystem, TickView } from '../types.js';

// --------------------------------------------------- чистая генерация (тесты)

export interface TerrainGeometryData {
  readonly positions: Float32Array;
  readonly indices: Uint32Array;
}

/**
 * Уровни четырёх углов клетки в порядке [c00, c10, c11, c01] (x,y → x+1,y →
 * x+1,y+1 → x,y+1). У обычной клетки все углы на её уровне; у рампы рёбра,
 * смежные с проходимым перепадом в единицу (TERR-5), поднимаются/опускаются
 * до уровня соседа — так пара «рампа + плато» смыкается без щелей.
 * Порядок рёбер фиксирован (W, E, N, S): последняя запись побеждает —
 * однозначность вместо зависимости от данных.
 */
export function cornerLevels(
  grid: TerrainGrid,
  x: number,
  y: number,
): [number, number, number, number] {
  const cell = y * grid.width + x;
  const own = grid.levels[cell]!;
  const corners: [number, number, number, number] = [own, own, own, own];
  if (grid.ramps[cell] !== 1) return corners;

  const stepNeighbour = (nx: number, ny: number): number | null => {
    if (nx < 0 || ny < 0 || nx >= grid.width || ny >= grid.height) return null;
    const level = grid.levels[ny * grid.width + nx]!;
    // Сама клетка — рампа, поэтому перепад ровно в единицу проходим (TERR-5).
    return Math.abs(level - own) === 1 ? level : null;
  };

  const west = stepNeighbour(x - 1, y);
  if (west !== null) {
    corners[0] = west;
    corners[3] = west;
  }
  const east = stepNeighbour(x + 1, y);
  if (east !== null) {
    corners[1] = east;
    corners[2] = east;
  }
  const north = stepNeighbour(x, y - 1);
  if (north !== null) {
    corners[0] = north;
    corners[1] = north;
  }
  const south = stepNeighbour(x, y + 1);
  if (south !== null) {
    corners[3] = south;
    corners[2] = south;
  }
  return corners;
}

/**
 * Площадки пола для прямоугольника клеток [x0..x0+w) × [y0..y0+h): квад на
 * клетку с пола́ми по углам из `cornerLevels`. Клетка без пола (`floor[cell]
 * === 0`) не получает геометрии вовсе — это и есть дыра (REND-7).
 */
export function buildFloorGeometry(
  grid: TerrainGrid,
  floor: Uint8Array,
  heightStep: number,
  x0: number,
  y0: number,
  w: number,
  h: number,
): TerrainGeometryData {
  const tile = grid.tileSize / FIXED_ONE;
  const positions: number[] = [];
  const indices: number[] = [];

  const x1 = Math.min(x0 + w, grid.width);
  const y1 = Math.min(y0 + h, grid.height);
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      if (floor[y * grid.width + x] === 0) continue; // дыра: пола нет
      const [c00, c10, c11, c01] = cornerLevels(grid, x, y);
      const base = positions.length / 3;
      positions.push(
        x * tile, y * tile, c00 * heightStep,
        (x + 1) * tile, y * tile, c10 * heightStep,
        (x + 1) * tile, (y + 1) * tile, c11 * heightStep,
        x * tile, (y + 1) * tile, c01 * heightStep,
      );
      // CCW при взгляде с +Z — нормаль вверх.
      indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
  }
  return { positions: new Float32Array(positions), indices: new Uint32Array(indices) };
}

/**
 * Вертикальные стенки по cliff-отрезкам ядра (TERR-5 → REND-7). Отрезок лежит
 * на границе двух клеток; стенка тянется от нижнего уровня пары до верхнего.
 * Сами отрезки не пересчитываются — берутся из `grid.cliffs` как есть.
 */
export function buildWallGeometry(grid: TerrainGrid, heightStep: number): TerrainGeometryData {
  const positions: number[] = [];
  const indices: number[] = [];

  for (const edge of grid.cliffs) {
    // Координаты отрезка кратны tileSize (fixed-домен — деление точное).
    let cellA: number;
    let cellB: number;
    if (edge.from.x === edge.to.x) {
      // Вертикальная граница x = X: клетки (X-1, Y) и (X, Y).
      const x = Math.round(edge.from.x / grid.tileSize);
      const y = Math.round(Math.min(edge.from.y, edge.to.y) / grid.tileSize);
      cellA = y * grid.width + (x - 1);
      cellB = y * grid.width + x;
    } else {
      // Горизонтальная граница y = Y: клетки (X, Y-1) и (X, Y).
      const y = Math.round(edge.from.y / grid.tileSize);
      const x = Math.round(Math.min(edge.from.x, edge.to.x) / grid.tileSize);
      cellA = (y - 1) * grid.width + x;
      cellB = y * grid.width + x;
    }
    const levelA = grid.levels[cellA]!;
    const levelB = grid.levels[cellB]!;
    const low = Math.min(levelA, levelB) * heightStep;
    const high = Math.max(levelA, levelB) * heightStep;

    const fx = edge.from.x / FIXED_ONE;
    const fy = edge.from.y / FIXED_ONE;
    const tx = edge.to.x / FIXED_ONE;
    const ty = edge.to.y / FIXED_ONE;

    const base = positions.length / 3;
    positions.push(fx, fy, low, tx, ty, low, tx, ty, high, fx, fy, high);
    // Материал двусторонний — ориентация не нормируется.
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  return { positions: new Float32Array(positions), indices: new Uint32Array(indices) };
}

/** BufferGeometry из числовых данных; нормали считаются по треугольникам. */
export function toBufferGeometry(data: TerrainGeometryData): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(data.positions, 3));
  geometry.setIndex(new THREE.BufferAttribute(data.indices, 1));
  geometry.computeVertexNormals();
  return geometry;
}

// ---------------------------------------------------------------- подсистема

export interface TerrainOptions {
  /** Размер чанка в клетках; мутация пола пересобирает только свой чанк. */
  readonly chunkSize?: number;
  readonly floorColor?: number;
  readonly wallColor?: number;
}

const DEFAULT_CHUNK_SIZE = 16;
const DEFAULT_FLOOR_COLOR = 0x4a5d3a;
const DEFAULT_WALL_COLOR = 0x6b5a48;

export class TerrainSubsystem implements RenderSubsystem {
  readonly name = 'terrain';

  private readonly grid: TerrainGrid;
  private readonly chunkSize: number;
  private readonly floorColor: number;
  private readonly wallColor: number;

  private ctx: RenderContext | null = null;
  private heightStep = 1;
  /** Собственная копия карты пола: presentation-состояние может жить без террейна. */
  private readonly floor: Uint8Array;
  private readonly chunksX: number;
  private readonly chunksY: number;
  private chunkMeshes: (THREE.Mesh | null)[] = [];
  private readonly dirtyChunks = new Set<number>();
  private floorMaterial: THREE.MeshStandardMaterial | null = null;
  private wallMesh: THREE.Mesh | null = null;

  constructor(grid: TerrainGrid, options: TerrainOptions = {}) {
    this.grid = grid;
    this.chunkSize = options.chunkSize ?? DEFAULT_CHUNK_SIZE;
    this.floorColor = options.floorColor ?? DEFAULT_FLOOR_COLOR;
    this.wallColor = options.wallColor ?? DEFAULT_WALL_COLOR;
    this.floor = new Uint8Array(grid.floor);
    this.chunksX = Math.ceil(grid.width / this.chunkSize);
    this.chunksY = Math.ceil(grid.height / this.chunkSize);
  }

  init(ctx: RenderContext): void {
    this.ctx = ctx;
    this.heightStep = ctx.config.heightStep;
    this.floorMaterial = new THREE.MeshStandardMaterial({
      color: this.floorColor,
      roughness: 0.95,
      metalness: 0,
    });

    // Стенки статичны: карта уровней иммутабельна (TERR-6 мутирует только пол).
    const walls = new THREE.Mesh(
      toBufferGeometry(buildWallGeometry(this.grid, this.heightStep)),
      new THREE.MeshStandardMaterial({
        color: this.wallColor,
        roughness: 0.95,
        metalness: 0,
        side: THREE.DoubleSide,
      }),
    );
    walls.name = 'terrain:walls';
    ctx.scene.add(walls);
    this.wallMesh = walls;

    this.chunkMeshes = new Array<THREE.Mesh | null>(this.chunksX * this.chunksY).fill(null);
    for (let chunk = 0; chunk < this.chunkMeshes.length; chunk++) this.rebuildChunk(chunk);
  }

  syncTick(view: TickView): void {
    if (view.floorBits === null || view.floorChangedCells.length === 0) return;
    for (const cell of view.floorChangedCells) {
      this.floor[cell] = view.floorBits[cell]!;
      this.dirtyChunks.add(this.chunkOfCell(cell));
    }
  }

  updateFrame(_dt: number, _alpha: number): void {
    // Пересборка затронутых чанков — не позже следующего кадра (REND-7).
    if (this.dirtyChunks.size === 0) return;
    for (const chunk of this.dirtyChunks) this.rebuildChunk(chunk);
    this.dirtyChunks.clear();
  }

  /** Число вершин пола — для тестов и профилировки. */
  get floorVertexCount(): number {
    let total = 0;
    for (const mesh of this.chunkMeshes) {
      if (mesh !== null) total += mesh.geometry.getAttribute('position').count;
    }
    return total;
  }

  private chunkOfCell(cell: number): number {
    const x = cell % this.grid.width;
    const y = Math.floor(cell / this.grid.width);
    return Math.floor(y / this.chunkSize) * this.chunksX + Math.floor(x / this.chunkSize);
  }

  private rebuildChunk(chunk: number): void {
    const ctx = this.ctx;
    if (ctx === null || this.floorMaterial === null) return;

    const previous = this.chunkMeshes[chunk] ?? null;
    if (previous !== null) {
      ctx.scene.remove(previous);
      previous.geometry.dispose();
    }

    const cx = chunk % this.chunksX;
    const cy = Math.floor(chunk / this.chunksX);
    const data = buildFloorGeometry(
      this.grid,
      this.floor,
      this.heightStep,
      cx * this.chunkSize,
      cy * this.chunkSize,
      this.chunkSize,
      this.chunkSize,
    );
    if (data.indices.length === 0) {
      this.chunkMeshes[chunk] = null;
      return;
    }
    const mesh = new THREE.Mesh(toBufferGeometry(data), this.floorMaterial);
    mesh.name = `terrain:chunk:${cx},${cy}`;
    ctx.scene.add(mesh);
    this.chunkMeshes[chunk] = mesh;
  }
}
