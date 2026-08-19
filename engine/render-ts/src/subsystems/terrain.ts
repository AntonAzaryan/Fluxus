/* eslint-disable max-lines -- baseline */
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
 * У документного продюсера (REND-11) мутабельны и уровни: кисти редактора
 * правят карту уровней, флаги и пол (ED-10), а вьюпорт обязан показать
 * результат не позже следующего кадра (ED-15). Вход для этого один —
 * `applyGrid`, документный источник террейна REND-14, декларативный по образцу
 * `DocumentSource.apply` (REND-11): потребитель отдаёт сетку ЦЕЛИКОМ,
 * пересчитанную ядром (TERR-5, ED-1), а свести её с
 * нарисованным — дело подсистемы. Императивного «подвинь эту клетку» здесь нет
 * по той же причине, по какой его нет у инстансов: картинка обязана быть
 * функцией документа, а не истории вызовов.
 *
 * И пол, и уровни живут в одной сетке, поэтому `applyGrid` заодно закрывает
 * возврат из превью (ED-9): пол подсистема держит собственной копией и мутирует
 * дельтами тика, а сетка документа возвращает её к состоянию документов —
 * выбитая в превью дыра до кадра правки не доживает. Повторная доставка той же
 * сетки поэтому не пустая операция, и REND-14 требует этого явно.
 *
 * Сетка — вторая точка входной границы рендера (REND-1): она приезжает не из
 * `TickResult`, а инициализацией подсистемы (REND-8) — в воркер-сборке
 * хендшейком оболочки (SHELL-5) — либо доставкой после инициализации
 * (REND-14), и `tileSize` с координатами cliff-отрезков в ней fixed-point
 * (TERR-2). Поэтому деления на `FIXED_ONE` здесь стоят в точке
 * приёма и должны там оставаться: глубже по коду рендера fixed-point значений и
 * их арифметики нет.
 */
import * as THREE from 'three';
import { FIXED_ONE, type TerrainGrid } from '@game-mvp/core';
import {
  DEFAULT_CURVATURE_TESSELLATION,
  type QualityDeclaration,
  type QualityValues,
  type RenderContext,
  type RenderSubsystem,
  type ShadowCasterSink,
  type TickView,
} from '../types.js';
import { costSink, type RenderCostCounters } from '../cost.js';
import { cornerLevels, type SurfaceNormal, type VisualSurface } from '../visualSurface.js';
import type { VisualSurfaceSource } from '../surfaceSource.js';

/**
 * Ручка качества подсистемы (`render-quality` QUAL-1): плотность разбиения
 * клетки с кривизной — ПОТОЛОК над значением конфига рендера (REND-9), а не
 * значение вместо него (design D3).
 */
const TERRAIN_TESSELLATION = 'terrain.curvatureTessellation';

// --------------------------------------------------- чистая генерация (тесты)

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
  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  const steps = Math.max(1, Math.floor(tessellation));
  const scratch: SurfaceNormal = { x: 0, y: 0, z: 0 };

  const x1 = Math.min(x0 + w, grid.width);
  const y1 = Math.min(y0 + h, grid.height);
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      if (floor[y * grid.width + x] === 0) continue; // дыра: пола нет
      const divisions = surface?.hasCellCurvature(x, y) === true ? steps : 1;
      if (divisions === 1) {
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
        if (surface === undefined) {
          // Поля нет вовсе — только база: у площадки нормаль вертикальна, у
          // рампы постоянна, и вершины квада получают одну и ту же (REND-7).
          quadNormal(h00, h10, h11, h01, 0.5, 0.5, tile, scratch);
          // eslint-disable-next-line max-depth -- baseline
          for (let i = 0; i < 4; i++) normals.push(scratch.x, scratch.y, scratch.z);
        } else {
          pushSurfaceNormal(normals, surface, x, y, x * tile, y * tile, scratch);
          pushSurfaceNormal(normals, surface, x, y, (x + 1) * tile, y * tile, scratch);
          pushSurfaceNormal(normals, surface, x, y, (x + 1) * tile, (y + 1) * tile, scratch);
          pushSurfaceNormal(normals, surface, x, y, x * tile, (y + 1) * tile, scratch);
        }
        // CCW при взгляде с +Z — нормаль вверх.
        indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
        continue;
      }

      // Разбиение: вершины стоят на поле, а не на хорде между углами клетки.
      const field = surface!;
      for (let j = 0; j < divisions; j++) {
        for (let i = 0; i < divisions; i++) {
          const ax = (x + i / divisions) * tile;
          const bx = (x + (i + 1) / divisions) * tile;
          const ay = (y + j / divisions) * tile;
          const by = (y + (j + 1) / divisions) * tile;
          const base = positions.length / 3;
          pushSurfaceVertex(positions, normals, field, x, y, ax, ay, scratch);
          pushSurfaceVertex(positions, normals, field, x, y, bx, ay, scratch);
          pushSurfaceVertex(positions, normals, field, x, y, bx, by, scratch);
          pushSurfaceVertex(positions, normals, field, x, y, ax, by, scratch);
          indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
        }
      }
    }
  }
  // Квад — шесть индексов, и другой геометрии у пола нет: клетка без кривизны
  // даёт один квад, клетка с кривизной — `divisions²` подклеток, клетка без пола
  // — ни одного. Одно деление в конце вместо инкремента в двух ветках цикла
  // (PERF-3): считать нечего, число уже собрано самим построением.
  if (cost !== undefined) cost.terrainFloorQuads += indices.length / 6;
  return {
    positions: new Float32Array(positions),
    indices: new Uint32Array(indices),
    normals: new Float32Array(normals),
  };
}

/**
 * Вершина на поле: позиция и нормаль читаются в клетке-владельце (REND-9).
 * Выборка — ТЕРРЕЙН-ФОРМА: walkable-поверхность в геометрию террейна не
 * попадает — настил рисует меш самой декорации, и подклетки пола под ним были
 * бы вторым изображением той же поверхности (REND-9).
 */
function pushSurfaceVertex(
  positions: number[],
  normals: number[],
  surface: VisualSurface,
  cellX: number,
  cellY: number,
  wx: number,
  wy: number,
  scratch: SurfaceNormal,
): void {
  positions.push(wx, wy, surface.terrainFormHeightInCell(cellX, cellY, wx, wy));
  pushSurfaceNormal(normals, surface, cellX, cellY, wx, wy, scratch);
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

    if (bounds !== undefined) {
      const ownerX = cellA % grid.width;
      const ownerY = Math.floor(cellA / grid.width);
      if (
        ownerX < bounds.x0 ||
        ownerY < bounds.y0 ||
        ownerX >= bounds.x0 + bounds.w ||
        ownerY >= bounds.y0 + bounds.h
      ) {
        continue;
      }
    }

    const fromNodeX = Math.round(edge.from.x / grid.tileSize);
    const fromNodeY = Math.round(edge.from.y / grid.tileSize);
    const toNodeX = Math.round(edge.to.x / grid.tileSize);
    const toNodeY = Math.round(edge.to.y / grid.tileSize);

    const fx = edge.from.x / FIXED_ONE;
    const fy = edge.from.y / FIXED_ONE;
    const tx = edge.to.x / FIXED_ONE;
    const ty = edge.to.y / FIXED_ONE;

    // Разбиение кромки — ровно там, где разбита кромка пола над стенкой.
    const divisions =
      surface !== undefined &&
      (surface.hasCellCurvature(cellA % grid.width, Math.floor(cellA / grid.width)) ||
        surface.hasCellCurvature(cellB % grid.width, Math.floor(cellB / grid.width)))
        ? steps
        : 1;

    // Концы отрезка берутся по углам клеток — так же, как до разбиения, чтобы
    // отрезок без кривизны давал побитово прежний квад; промежуточные точки —
    // тем же `heightInCell`, каким считает пол.
    let prevX = fx;
    let prevY = fy;
    let prevLow = 0;
    let prevHigh = 0;
    for (let i = 0; i <= divisions; i++) {
      let px: number;
      let py: number;
      let hA: number;
      let hB: number;
      if (i === 0 || i === divisions) {
        const nodeX = i === 0 ? fromNodeX : toNodeX;
        const nodeY = i === 0 ? fromNodeY : toNodeY;
        px = i === 0 ? fx : tx;
        py = i === 0 ? fy : ty;
        hA = cornerHeight(cellA, nodeX, nodeY);
        hB = cornerHeight(cellB, nodeX, nodeY);
      } else {
        px = (fromNodeX + ((toNodeX - fromNodeX) * i) / divisions) * tile;
        py = (fromNodeY + ((toNodeY - fromNodeY) * i) / divisions) * tile;
        hA = sampleWallSide(grid, heightStep, surface, cellA, px, py);
        hB = sampleWallSide(grid, heightStep, surface, cellB, px, py);
      }
      const low = Math.min(hA, hB);
      const high = Math.max(hA, hB);
      if (i > 0) {
        const base = positions.length / 3;
        positions.push(prevX, prevY, prevLow, px, py, low, px, py, high, prevX, prevY, prevHigh);
        // Материал двусторонний — ориентация не нормируется.
        indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
      }
      prevX = px;
      prevY = py;
      prevLow = low;
      prevHigh = high;
    }
  }
  // Те же шесть индексов на квад, что у пола: отрезок без кривизны с обеих
  // сторон даёт один квад, отрезок под разбитой кромкой — `divisions` (REND-9).
  if (cost !== undefined) cost.terrainWallQuads += indices.length / 6;
  return { positions: new Float32Array(positions), indices: new Uint32Array(indices) };
}

/**
 * Высота поля в клетке стороны отрезка; без поля — плоская ступень уровня.
 * Террейн-форма, как у пола: кромка стенки идёт под кромкой пола, а walkable
 * в геометрию террейна не входит (REND-9).
 */
function sampleWallSide(
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

/**
 * BufferGeometry из числовых данных. Готовые нормали ставятся атрибутом (пол:
 * они посчитаны из поля высот, REND-9); если их нет — считаются по
 * треугольникам, и стенка обрыва остаётся плоской.
 */
export function toBufferGeometry(data: TerrainGeometryData): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(data.positions, 3));
  geometry.setIndex(new THREE.BufferAttribute(data.indices, 1));
  // eslint-disable-next-line @typescript-eslint/prefer-optional-chain -- baseline
  if (data.normals !== undefined && data.normals.length === data.positions.length) {
    geometry.setAttribute('normal', new THREE.BufferAttribute(data.normals, 3));
  } else {
    geometry.computeVertexNormals();
  }
  return geometry;
}

// ---------------------------------------------------------------- подсистема

export interface TerrainOptions {
  /** Размер чанка в клетках; мутация сетки пересобирает только свои чанки. */
  readonly chunkSize?: number;
  readonly floorColor?: number;
  readonly wallColor?: number;
  /** Источник визуальной поверхности (REND-9); нет — плоские ступени REND-7. */
  readonly surface?: VisualSurfaceSource;
  /**
   * Приёмник теневых кастеров подсистемы освещения (REND-8). Геометрия террейна
   * — статический ярус: она меняется правкой документа (REND-14), а не кадром,
   * и её тень живёт в кэшированной карте. Нет приёмника — сцена без света, и
   * флагов теней меши чанков не получают вовсе.
   */
  readonly shadows?: ShadowCasterSink;
}

const DEFAULT_CHUNK_SIZE = 16;
const DEFAULT_FLOOR_COLOR = 0x4a5d3a;
const DEFAULT_WALL_COLOR = 0x6b5a48;

/**
 * Радиус влияния правки клетки в клетках. Уровень клетки виден на расстоянии
 * одной клетки — угол усредняется по смежным (REND-9), а угол рампы тянется к
 * проходимому соседу (TERR-5); стенка же читает углы ОБЕИХ своих клеток, и
 * дальняя из них отстоит от правки ещё на клетку. Отсюда двойка: она задаёт
 * область инвалидации, а не пересчёта — чанк всё равно один и тот же.
 */
const SHAPE_RADIUS = 2;

export class TerrainSubsystem implements RenderSubsystem {
  readonly name = 'terrain';

  private grid: TerrainGrid;
  private readonly chunkSize: number;
  private readonly floorColor: number;
  private readonly wallColor: number;
  private readonly surfaceSource: VisualSurfaceSource | undefined;
  private readonly shadows: ShadowCasterSink | undefined;

  private ctx: RenderContext | null = null;
  private heightStep = 1;
  /** Плотность разбиения клеток с кривизной — параметр рендера (REND-9). */
  private tessellation = DEFAULT_CURVATURE_TESSELLATION;
  /**
   * Потолок плотности от пресета качества (QUAL-1, design D3); бесконечность —
   * потолка нет, действует значение конфига рендера.
   */
  private ceiling = Number.POSITIVE_INFINITY;
  /** Собственная копия карты пола: presentation-состояние может жить без террейна. */
  private floor: Uint8Array;
  private chunksX: number;
  private chunksY: number;
  private floorMeshes: (THREE.Mesh | null)[] = [];
  private wallMeshes: (THREE.Mesh | null)[] = [];
  private readonly dirtyChunks = new Set<number>();
  private floorMaterial: THREE.MeshStandardMaterial | null = null;
  private wallMaterial: THREE.MeshStandardMaterial | null = null;

  constructor(grid: TerrainGrid, options: TerrainOptions = {}) {
    this.grid = grid;
    this.chunkSize = options.chunkSize ?? DEFAULT_CHUNK_SIZE;
    this.floorColor = options.floorColor ?? DEFAULT_FLOOR_COLOR;
    this.wallColor = options.wallColor ?? DEFAULT_WALL_COLOR;
    this.surfaceSource = options.surface;
    this.shadows = options.shadows;
    this.floor = new Uint8Array(grid.floor);
    this.chunksX = Math.ceil(grid.width / this.chunkSize);
    this.chunksY = Math.ceil(grid.height / this.chunkSize);
  }

  init(ctx: RenderContext): void {
    this.ctx = ctx;
    this.heightStep = ctx.config.heightStep;
    // Плотность — конфиг рендера под потолком пресета (REND-9, QUAL-1): порядок
    // «init, потом контроллер качества» и обратный дают одно и то же.
    this.tessellation = this.effectiveTessellation();
    this.floorMaterial = new THREE.MeshStandardMaterial({
      color: this.floorColor,
      roughness: 0.95,
      metalness: 0,
    });
    this.wallMaterial = new THREE.MeshStandardMaterial({
      color: this.wallColor,
      roughness: 0.95,
      metalness: 0,
      side: THREE.DoubleSide,
    });

    // Поверхность меняется асинхронной догрузкой карты кривизны (REND-9) и
    // правкой документа (ED-10, ED-11); в первом случае меняется вся, во втором
    // — перечисленные клетки, и пересобираются только их чанки.
    this.surfaceSource?.init(ctx);
    this.surfaceSource?.onChange((cells, walkableOnly) => {
      // Walkable-вклад геометрию террейна не меняет (REND-9): настил рисует меш
      // декорации, и пересборка квадов под его клетками дала бы те же квады.
      if (walkableOnly === true) return;
      // Приход поверхности — свой вход, и сток читается один раз на него
      // (PERF-3): дальше только сложения в захваченную переменную.
      const cost = costSink();
      if (cells === null) this.markAllChunks(cost);
      else for (const cell of cells) this.markShapeCell(cell, cost);
    });

    const cost = costSink();
    this.allocateChunks();
    this.markAllChunks(cost);
    this.flushDirty(cost);
  }

  /**
   * Сетка редактируемого документа целиком (REND-14, ED-10, ED-15): уровни,
   * флаги, пол и производная cliff-геометрия. Считает её ЯДРО
   * (`createTerrainGrid`, TERR-5) — подсистема сводит пришедшее с нарисованным
   * и инвалидирует только затронутые чанки; пересоздавать подсистему на мазок
   * кисти не нужно.
   *
   * Пол сверяется с СОБСТВЕННОЙ копией, а не с прежней сеткой: её мог изменить
   * поток тиков превью (TERR-6), и возврат к документам обязан эту мутацию
   * снять (ED-9). Поэтому повторный `applyGrid` с той же сеткой — не пустая
   * операция, а восстановление пола документа.
   *
   * Смена размеров арены пересобирает раскладку чанков целиком: это правка
   * ассета террейна, а не мазок кисти.
   */
  applyGrid(next: TerrainGrid): void {
    const previous = this.grid;
    if (
      next.width !== previous.width ||
      next.height !== previous.height ||
      next.tileSize !== previous.tileSize
    ) {
      this.resetGrid(next);
      return;
    }

    this.grid = next;
    const cost = costSink(); // один раз на доставку сетки (PERF-3)
    const shape: number[] = [];
    const cells = next.width * next.height;
    for (let cell = 0; cell < cells; cell++) {
      if (previous.levels[cell] !== next.levels[cell] || previous.ramps[cell] !== next.ramps[cell]) {
        shape.push(cell);
      }
      if (this.floor[cell] !== next.floor[cell]) {
        this.floor[cell] = next.floor[cell]!;
        // Пол виден только в своей клетке: высот и стенок он не меняет (TERR-6).
        this.dirtyChunks.add(this.chunkOfCell(cell));
        if (cost !== undefined) cost.terrainChunksMarked++;
      }
    }
    for (const cell of shape) this.markShapeCell(cell, cost);
    // Поверхность стоит на той же сетке — уровни и рампы ей тоже изменились.
    this.surfaceSource?.setGrid(next, shape);
  }

  /** Визуальная поверхность для генераторов; undefined — плоские ступени. */
  private get surface(): VisualSurface | undefined {
    return this.surfaceSource?.current ?? undefined;
  }

  syncTick(view: TickView): void {
    if (view.floorBits === null || view.floorChangedCells.length === 0) return;
    // Сток — один раз на доставку, дальше сложение в захваченную переменную
    // (PERF-3): мутация пола (TERR-6) — единственная работа доставки у террейна.
    const cost = costSink();
    for (const cell of view.floorChangedCells) {
      this.floor[cell] = view.floorBits[cell]!;
      this.dirtyChunks.add(this.chunkOfCell(cell));
      if (cost !== undefined) cost.terrainChunksMarked++;
    }
  }

  updateFrame(_dt: number, _alpha: number): void {
    // Пересборка затронутых чанков — не позже следующего кадра (REND-7, ED-15).
    // Кадр стоящей сцены пометок не находит и не платит ничем: счётчики
    // пересборки остаются нулевыми (PERF-2).
    this.flushDirty(costSink());
  }

  /**
   * Ручки качества подсистемы (`render-quality` QUAL-1, QUAL-3): одна — потолок
   * плотности разбиения клеток с кривизной. Геометрия террейна — вершины и
   * треугольники, растущие площадью арены И квадратом плотности (REND-9);
   * покадровой работы у подсистемы почти нет, но нарисованное ею стоит каждый
   * кадр, и рычаг нужен именно здесь.
   */
  quality(): QualityDeclaration {
    return {
      subsystem: this.name,
      knobs: [
        {
          name: TERRAIN_TESSELLATION,
          cost: 'вершины и треугольники визуальной поверхности: клетка с кривизной даёт N×N подклеток (REND-9)',
          semantics: 'ceiling',
          // Потолка нет — действует значение конфига рендера (REND-9).
          default: Number.POSITIVE_INFINITY,
          min: 1,
          max: 16,
        },
      ],
    };
  }

  /**
   * Потолок плотности разбиения от пресета (QUAL-1, design D3): действующая
   * плотность = min(конфига рендера, потолка). Конфиг остаётся авторским — его
   * подбирает тот, кто смотрит на арену (REND-9), — а пересборка геометрии всех
   * чанков идёт событием смены пресета, а не кадром.
   */
  applyQuality(values: QualityValues): void {
    const ceiling = values.get(TERRAIN_TESSELLATION);
    this.ceiling = typeof ceiling === 'number' ? ceiling : Number.POSITIVE_INFINITY;
    const next = this.effectiveTessellation();
    if (next === this.tessellation) return;
    this.tessellation = next;
    // До init'а чанков ещё нет: плотность возьмётся при первой сборке.
    if (this.ctx === null) return;
    // Смена пресета — событие, и цена его видна тем же счётчиком, что цена
    // кадра: пересобирается вся геометрия арены (QUAL-1, PERF-3).
    const cost = costSink();
    this.markAllChunks(cost);
    this.flushDirty(cost);
  }

  /** Плотность разбиения под потолком пресета; целая — подклетки дробными не бывают. */
  private effectiveTessellation(): number {
    const authored = this.ctx?.config.curvatureTessellation ?? DEFAULT_CURVATURE_TESSELLATION;
    return Math.max(1, Math.floor(Math.min(authored, this.ceiling)));
  }

  /** Число вершин пола — для тестов и профилировки. */
  get floorVertexCount(): number {
    return countVertices(this.floorMeshes);
  }

  /** Число вершин стенок — для тестов и профилировки. */
  get wallVertexCount(): number {
    return countVertices(this.wallMeshes);
  }

  private flushDirty(cost: RenderCostCounters | undefined): void {
    if (this.dirtyChunks.size === 0) return;
    if (cost !== undefined) cost.terrainChunksRebuilt += this.dirtyChunks.size;
    for (const chunk of this.dirtyChunks) this.rebuildChunk(chunk);
    this.dirtyChunks.clear();
  }

  private allocateChunks(): void {
    const count = this.chunksX * this.chunksY;
    this.floorMeshes = new Array<THREE.Mesh | null>(count).fill(null);
    this.wallMeshes = new Array<THREE.Mesh | null>(count).fill(null);
  }

  private markAllChunks(cost: RenderCostCounters | undefined): void {
    const count = this.chunksX * this.chunksY;
    if (cost !== undefined) cost.terrainChunksMarked += count;
    for (let chunk = 0; chunk < count; chunk++) this.dirtyChunks.add(chunk);
  }

  /** Инвалидация окрестности правки уровня/рампы — все чанки в радиусе SHAPE_RADIUS. */
  private markShapeCell(cell: number, cost: RenderCostCounters | undefined): void {
    const { width, height } = this.grid;
    const x = cell % width;
    const y = Math.floor(cell / width);
    const cx0 = Math.floor(Math.max(x - SHAPE_RADIUS, 0) / this.chunkSize);
    const cx1 = Math.floor(Math.min(x + SHAPE_RADIUS, width - 1) / this.chunkSize);
    const cy0 = Math.floor(Math.max(y - SHAPE_RADIUS, 0) / this.chunkSize);
    const cy1 = Math.floor(Math.min(y + SHAPE_RADIUS, height - 1) / this.chunkSize);
    // Правка одной клетки метит окрестность (SHAPE_RADIUS), и повторные пометки
    // соседних клеток считаются: каждая — свой поиск в множестве, а пересборок
    // от них не прибавляется (их считает `terrainChunksRebuilt`).
    if (cost !== undefined) cost.terrainChunksMarked += (cx1 - cx0 + 1) * (cy1 - cy0 + 1);
    for (let cy = cy0; cy <= cy1; cy++) {
      for (let cx = cx0; cx <= cx1; cx++) this.dirtyChunks.add(cy * this.chunksX + cx);
    }
  }

  /** Другая арена: сцена очищается и раскладка чанков считается заново. */
  private resetGrid(next: TerrainGrid): void {
    const ctx = this.ctx;
    if (ctx !== null) {
      for (const mesh of [...this.floorMeshes, ...this.wallMeshes]) {
        if (mesh === null) continue;
        ctx.scene.remove(mesh);
        mesh.geometry.dispose();
      }
    }
    this.grid = next;
    this.floor = new Uint8Array(next.floor);
    this.chunksX = Math.ceil(next.width / this.chunkSize);
    this.chunksY = Math.ceil(next.height / this.chunkSize);
    this.allocateChunks();
    this.dirtyChunks.clear();
    // Поверхность собирается заново под новые размеры и зовёт подписчиков.
    this.surfaceSource?.setGrid(next);
    this.markAllChunks(costSink());
  }

  private chunkOfCell(cell: number): number {
    const x = cell % this.grid.width;
    const y = Math.floor(cell / this.grid.width);
    return Math.floor(y / this.chunkSize) * this.chunksX + Math.floor(x / this.chunkSize);
  }

  private rebuildChunk(chunk: number): void {
    const ctx = this.ctx;
    if (ctx === null || this.floorMaterial === null || this.wallMaterial === null) return;

    const cx = chunk % this.chunksX;
    const cy = Math.floor(chunk / this.chunksX);
    const rect: CellRect = {
      x0: cx * this.chunkSize,
      y0: cy * this.chunkSize,
      w: this.chunkSize,
      h: this.chunkSize,
    };

    this.floorMeshes[chunk] = this.swapMesh(
      this.floorMeshes[chunk] ?? null,
      buildFloorGeometry(
        this.grid,
        this.floor,
        this.heightStep,
        rect.x0,
        rect.y0,
        rect.w,
        rect.h,
        this.surface,
        this.tessellation,
      ),
      this.floorMaterial,
      `terrain:chunk:${cx},${cy}`,
    );
    this.wallMeshes[chunk] = this.swapMesh(
      this.wallMeshes[chunk] ?? null,
      buildWallGeometry(this.grid, this.heightStep, this.surface, rect, this.tessellation),
      this.wallMaterial,
      `terrain:walls:${cx},${cy}`,
    );
  }

  /** Снимает старый меш со сцены и ставит новый; пустая геометрия — меша нет. */
  private swapMesh(
    previous: THREE.Mesh | null,
    data: TerrainGeometryData,
    material: THREE.Material,
    name: string,
  ): THREE.Mesh | null {
    const ctx = this.ctx;
    if (ctx === null) return previous;
    if (previous !== null) {
      // Пересобранный чанк — другой меш: прежний уходит из реестра кастеров
      // вместе со сценой, а вместе с ним устаревает и кэшированная карта теней.
      this.shadows?.dropCaster(previous);
      ctx.scene.remove(previous);
      previous.geometry.dispose();
    }
    if (data.indices.length === 0) return null;
    const mesh = new THREE.Mesh(toBufferGeometry(data), material);
    mesh.name = name;
    ctx.scene.add(mesh);
    // Террейн — статический кастер и приёмник теней при любом режиме, кроме
    // `none`: флаги расставляет сам приёмник, он один знает режим и фазу.
    this.shadows?.setCaster(mesh, 'static');
    return mesh;
  }
}

function countVertices(meshes: readonly (THREE.Mesh | null)[]): number {
  let total = 0;
  for (const mesh of meshes) {
    if (mesh !== null) total += mesh.geometry.getAttribute('position').count;
  }
  return total;
}
