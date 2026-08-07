/**
 * Подсистема террейна (REND-7, REND-9): ступени из тех же данных, что видит
 * симуляция, плюс визуальная кривизна поверх них.
 *
 * Горизонтальные площадки — на высоте `уровень × heightStep`, вертикальные
 * стенки — по cliff-отрезкам, ПЕРЕИСПОЛЬЗОВАННЫМ из производной геометрии ядра
 * (`TerrainGrid.cliffs`, TERR-5), а не выведенным заново; рампы — наклонные
 * площадки; клетки без пола — дыры. Силуэт совпадает с симуляционным по
 * построению: источник данных один. Кривизна (REND-9) приходит через
 * `VisualSurfaceSource`: углы клеток и кромки стенок берутся из визуальной
 * поверхности, амплитуда меньше полушага — силуэт не расходится.
 *
 * Мутация пола (TERR-6) приходит дельтой клеток из presentation-состояния и
 * пересобирает затронутый чанк не позже следующего кадра; полная пересборка
 * чанка — осознанный выбор MVP (см. design Risks).
 *
 * Сетка — вторая точка входной границы рендера (REND-1): она приезжает не из
 * `TickResult`, а инициализацией подсистемы (REND-8) — в воркер-сборке
 * хендшейком оболочки (SHELL-5), — и `tileSize` с координатами cliff-отрезков в
 * ней fixed-point (TERR-2). Поэтому деления на `FIXED_ONE` здесь стоят в точке
 * приёма и должны там оставаться: глубже по коду рендера fixed-point значений и
 * их арифметики нет.
 */
import * as THREE from 'three';
import { FIXED_ONE, type TerrainGrid } from '@game-mvp/core';
import type { RenderContext, RenderSubsystem, TickView } from '../types.js';
import { cornerLevels, type VisualSurface } from '../visualSurface.js';
import type { VisualSurfaceSource } from '../surfaceSource.js';

// --------------------------------------------------- чистая генерация (тесты)

export interface TerrainGeometryData {
  readonly positions: Float32Array;
  readonly indices: Uint32Array;
}

/**
 * Площадки пола для прямоугольника клеток [x0..x0+w) × [y0..y0+h): квад на
 * клетку с пола́ми по углам из `cornerLevels`, при наличии `surface` — из
 * визуальной поверхности с кривизной (REND-9; без карты кривизны значения
 * совпадают). Клетка без пола (`floor[cell] === 0`) не получает геометрии
 * вовсе — это и есть дыра (REND-7).
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
): TerrainGeometryData {
  // Приём `tileSize` — точка входной границы (REND-1, SHELL-5, TERR-2).
  const tile = grid.tileSize / FIXED_ONE;
  const positions: number[] = [];
  const indices: number[] = [];

  const x1 = Math.min(x0 + w, grid.width);
  const y1 = Math.min(y0 + h, grid.height);
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      if (floor[y * grid.width + x] === 0) continue; // дыра: пола нет
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
      const base = positions.length / 3;
      positions.push(
        x * tile, y * tile, h00,
        (x + 1) * tile, y * tile, h10,
        (x + 1) * tile, (y + 1) * tile, h11,
        x * tile, (y + 1) * tile, h01,
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
 *
 * При наличии `surface` кромки стенки на каждом конце отрезка тянутся до
 * фактических визуальных высот углов обеих клеток (skirt): кривизна смещает
 * кромку пола, и стенка обязана дойти до неё без щели (REND-9).
 */
export function buildWallGeometry(
  grid: TerrainGrid,
  heightStep: number,
  surface?: VisualSurface,
): TerrainGeometryData {
  const positions: number[] = [];
  const indices: number[] = [];

  /** Высота угла клетки (cx, cy) в узле сетки (nodeX, nodeY). */
  const cornerHeight = (cell: number, nodeX: number, nodeY: number): number => {
    const cx = cell % grid.width;
    const cy = Math.floor(cell / grid.width);
    if (surface === undefined) return grid.levels[cell]! * heightStep;
    const heights = surface.cornerHeights(cx, cy);
    // Индекс угла по смещению узла от клетки: (0,0)→c00, (1,0)→c10, (1,1)→c11, (0,1)→c01.
    const dx = nodeX - cx;
    const dy = nodeY - cy;
    return heights[dy === 0 ? dx : 3 - dx]!;
  };

  for (const edge of grid.cliffs) {
    // Координаты отрезка — тоже точка входной границы (REND-1, TERR-2, TERR-5):
    // индекс клетки считается в fixed-домене (кратность tileSize делает деление
    // точным), мировые координаты кромки конвертируются во float ниже, и дальше
    // геометрия строится целиком во float.
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

    const fromNodeX = Math.round(edge.from.x / grid.tileSize);
    const fromNodeY = Math.round(edge.from.y / grid.tileSize);
    const toNodeX = Math.round(edge.to.x / grid.tileSize);
    const toNodeY = Math.round(edge.to.y / grid.tileSize);
    const fromA = cornerHeight(cellA, fromNodeX, fromNodeY);
    const fromB = cornerHeight(cellB, fromNodeX, fromNodeY);
    const toA = cornerHeight(cellA, toNodeX, toNodeY);
    const toB = cornerHeight(cellB, toNodeX, toNodeY);
    const lowFrom = Math.min(fromA, fromB);
    const highFrom = Math.max(fromA, fromB);
    const lowTo = Math.min(toA, toB);
    const highTo = Math.max(toA, toB);

    const fx = edge.from.x / FIXED_ONE;
    const fy = edge.from.y / FIXED_ONE;
    const tx = edge.to.x / FIXED_ONE;
    const ty = edge.to.y / FIXED_ONE;

    const base = positions.length / 3;
    positions.push(fx, fy, lowFrom, tx, ty, lowTo, tx, ty, highTo, fx, fy, highFrom);
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
  /** Источник визуальной поверхности (REND-9); нет — плоские ступени REND-7. */
  readonly surface?: VisualSurfaceSource;
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
  private readonly surfaceSource: VisualSurfaceSource | undefined;

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
    this.surfaceSource = options.surface;
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

    // Кривизна (REND-9) догружается асинхронно: по готовности поверхность
    // подменяется и вся геометрия пересобирается — уровни при этом те же,
    // силуэт не меняется.
    this.surfaceSource?.init(ctx);
    this.surfaceSource?.onChange(() => {
      this.rebuildWalls();
      for (let chunk = 0; chunk < this.chunkMeshes.length; chunk++) this.dirtyChunks.add(chunk);
    });

    this.rebuildWalls();
    this.chunkMeshes = new Array<THREE.Mesh | null>(this.chunksX * this.chunksY).fill(null);
    for (let chunk = 0; chunk < this.chunkMeshes.length; chunk++) this.rebuildChunk(chunk);
  }

  /** Визуальная поверхность для генераторов; undefined — плоские ступени. */
  private get surface(): VisualSurface | undefined {
    return this.surfaceSource?.current ?? undefined;
  }

  /** Стенки пересобираются только при подмене поверхности: уровни иммутабельны (TERR-6). */
  private rebuildWalls(): void {
    const ctx = this.ctx;
    if (ctx === null) return;
    const previous = this.wallMesh;
    const material =
      previous?.material instanceof THREE.MeshStandardMaterial
        ? previous.material
        : new THREE.MeshStandardMaterial({
            color: this.wallColor,
            roughness: 0.95,
            metalness: 0,
            side: THREE.DoubleSide,
          });
    if (previous !== null) {
      ctx.scene.remove(previous);
      previous.geometry.dispose();
    }
    const walls = new THREE.Mesh(
      toBufferGeometry(buildWallGeometry(this.grid, this.heightStep, this.surface)),
      material,
    );
    walls.name = 'terrain:walls';
    ctx.scene.add(walls);
    this.wallMesh = walls;
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
      this.surface,
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
