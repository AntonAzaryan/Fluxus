/**
 * Подсистема террейна (REND-7, REND-9): ступени из тех же данных, что видит
 * симуляция, плюс визуальная кривизна поверх них.
 *
 * Горизонтальные площадки — на высоте `уровень × heightStep`, вертикальные
 * стенки — по cliff-отрезкам, ПЕРЕИСПОЛЬЗОВАННЫМ из производной геометрии ядра
 * (`TerrainGrid.cliffs`, TERR-5), а не выведенным заново; рампы — наклонные
 * площадки; клетки без пола — дыры, а граница пола — обрыв вниз юбкой на
 * глубину `skirtDepth`. Силуэт совпадает с симуляционным по
 * построению: источник данных один. Кривизна (REND-9) приходит через
 * `VisualSurfaceSource`: углы клеток и кромки стенок берутся из визуальной
 * поверхности, амплитуда меньше полушага — силуэт не расходится.
 *
 * Мутация пола (TERR-6) приходит дельтой клеток из presentation-состояния и
 * пересобирает затронутый чанк не позже следующего кадра; полная пересборка
 * чанка — осознанный выбор (см. design Risks).
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
import { FIXED_ONE, type TerrainGrid } from '@fluxus/core';
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
import {
  buildFloorGeometry,
  buildWallGeometry,
  type CellRect,
  type TerrainGeometryData,
} from './terrainGeometry.js';
import { toBufferGeometry } from './terrainMesh.js';
import { TerrainCoverLoader, type TerrainCover, type TerrainUvMapping } from './terrainCover.js';
import { buildSkirtGeometry } from './terrainSkirt.js';
import type { DebugSource } from '../debug/contract.js';
import { terrainSurfaceDebugSource } from '../debug/terrainSource.js';
import type { VisualSurface } from '../visualSurface.js';
import type { VisualSurfaceSource } from '../surfaceSource.js';
import { own, peak } from '../footprint.js';

/**
 * Ручка качества подсистемы (`render-quality` QUAL-1): плотность разбиения
 * клетки с кривизной — ПОТОЛОК над значением конфига рендера (REND-9), а не
 * значение вместо него (design D3).
 */
const TERRAIN_TESSELLATION = 'terrain.curvatureTessellation';

// ---------------------------------------------------------------- подсистема

export interface TerrainOptions {
  /** Размер чанка в клетках; мутация сетки пересобирает только свои чанки. */
  readonly chunkSize?: number;
  readonly floorColor?: number;
  readonly wallColor?: number;
  readonly skirtColor?: number;
  /**
   * Глубина юбки обрыва в мировых единицах (REND-7): полоса от кромки пола вниз
   * вдоль рёбер, за которыми пола нет — сосед без пола либо край сетки. Ноль
   * выключает юбку целиком; `Infinity` делает её бездонной — низ уходит на
   * `SKIRT_BOTTOMLESS_Z`, ниже любой видимой точки сцены, и обрыв не имеет
   * видимой нижней кромки ни с одного ракурса. Число квадов от глубины не
   * зависит. Параметр рендера, как `heightStep`: цифру подбирает тот, кто
   * смотрит на арену.
   */
  readonly skirtDepth?: number;
  /** Источник визуальной поверхности (REND-9); нет — плоские ступени REND-7. */
  readonly surface?: VisualSurfaceSource;
  /**
   * Приёмник теневых кастеров подсистемы освещения (REND-8). Геометрия террейна
   * — статический ярус: она меняется правкой документа (REND-14), а не кадром,
   * и её тень живёт в кэшированной карте. Нет приёмника — сцена без света, и
   * флагов теней меши чанков не получают вовсе.
   */
  readonly shadows?: ShadowCasterSink;
  /**
   * Покрытие площадок пола: тайлящаяся текстура по ID дерева контента (ASSET-2),
   * спроецированная сверху с периодом в мировых единицах. Нет — пол одноцветен
   * (`floorColor`). ВРЕМЕННЫЙ параметр рендера в ряду `floorColor`: одно
   * покрытие на весь пол, пока текстурирование не приехало раскраской клеток
   * из Blender (стаб `terrain-texturing`); недоступный ассет — предупреждение
   * и заливка цветом, не отказ кадра (по образцу детали воды, REND-35).
   */
  readonly floorCover?: TerrainCover;
  /** Покрытие стенок обрывов и юбки: проекция вдоль стенки и по высоте. */
  readonly wallCover?: TerrainCover;
  /** Канал предупреждений; не задан — `console.warn` (недоступное покрытие). */
  readonly warn?: (message: string) => void;
}

const DEFAULT_CHUNK_SIZE = 16;
const DEFAULT_FLOOR_COLOR = 0x4a5d3a;
const DEFAULT_WALL_COLOR = 0x6b5a48;
/** Темнее стенок: уходящий вниз срез читается глубиной на фоне сцены (REND-7). */
const DEFAULT_SKIRT_COLOR = 0x453a2f;
/**
 * Глубина юбки по умолчанию, мировые единицы: достаточно, чтобы изометрическая
 * камера не заглядывала под нижнюю кромку на аренах масштаба демо (48×48).
 */
const DEFAULT_SKIRT_DEPTH = 8;
/**
 * Радиус влияния правки клетки в клетках. Уровень клетки виден на расстоянии
 * одной клетки — угол усредняется по смежным (REND-9), а угол рампы тянется к
 * проходимому соседу (TERR-5); стенка же читает углы ОБЕИХ своих клеток, и
 * дальняя из них отстоит от правки ещё на клетку. Отсюда двойка: она задаёт
 * область инвалидации, а не пересчёта — чанк всё равно один и тот же.
 */
const SHAPE_RADIUS = 2;

/**
 * Радиус влияния мутации пола (TERR-6): сам пол виден только в своей клетке,
 * но юбка обрыва (REND-7) стоит на рёбрах с СОСЕДЯМИ — выбитая клетка меняет
 * юбку четырёх смежных, и дальше собственной клетки их рёбра не уходят.
 */
const FLOOR_RADIUS = 1;

export class TerrainSubsystem implements RenderSubsystem {
  readonly name = 'terrain';

  private grid: TerrainGrid;
  private readonly chunkSize: number;
  private readonly floorColor: number;
  private readonly wallColor: number;
  private readonly skirtColor: number;
  private readonly skirtDepth: number;
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
  private skirtMeshes: (THREE.Mesh | null)[] = [];
  private readonly dirtyChunks = new Set<number>();
  private floorMaterial: THREE.MeshStandardMaterial | null = null;
  private wallMaterial: THREE.MeshStandardMaterial | null = null;
  private skirtMaterial: THREE.MeshStandardMaterial | null = null;
  /** Покрытия пола и стенок: текстуры, подписки и раскладки UV чанков. */
  private readonly covers: TerrainCoverLoader;

  constructor(grid: TerrainGrid, options: TerrainOptions = {}) {
    this.grid = grid;
    this.chunkSize = options.chunkSize ?? DEFAULT_CHUNK_SIZE;
    this.floorColor = options.floorColor ?? DEFAULT_FLOOR_COLOR;
    this.wallColor = options.wallColor ?? DEFAULT_WALL_COLOR;
    this.skirtColor = options.skirtColor ?? DEFAULT_SKIRT_COLOR;
    this.skirtDepth = options.skirtDepth ?? DEFAULT_SKIRT_DEPTH;
    this.surfaceSource = options.surface;
    this.shadows = options.shadows;
    const covers = { floor: options.floorCover, wall: options.wallCover };
    this.covers = new TerrainCoverLoader(covers, options.warn);
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
    this.floorMaterial = own(
      'material',
      'terrain',
      new THREE.MeshStandardMaterial({
        color: this.floorColor,
        roughness: 0.95,
        metalness: 0,
      }),
    );
    this.wallMaterial = own(
      'material',
      'terrain',
      new THREE.MeshStandardMaterial({
        color: this.wallColor,
        roughness: 0.95,
        metalness: 0,
        side: THREE.DoubleSide,
      }),
    );
    this.skirtMaterial = own(
      'material',
      'terrain',
      new THREE.MeshStandardMaterial({
        color: this.skirtColor,
        roughness: 0.95,
        metalness: 0,
        side: THREE.DoubleSide,
      }),
    );
    this.covers.attach(ctx, {
      floor: this.floorMaterial,
      wall: this.wallMaterial,
      skirt: this.skirtMaterial,
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
   * Снос подсистемы (REND-31): геометрии чанков пола и стен и два разделяемых
   * материала — всё, что подсистема положила в GPU. Источник визуальной
   * поверхности сюда не входит: он приходит опцией сборки и принадлежит ей, а
   * не подсистеме (REND-8).
   */
  dispose(): void {
    this.clearMeshes(false);
    this.floorMeshes = [];
    this.wallMeshes = [];
    this.skirtMeshes = [];
    this.dirtyChunks.clear();
    this.floorMaterial?.dispose();
    this.floorMaterial = null;
    this.wallMaterial?.dispose();
    this.wallMaterial = null;
    this.skirtMaterial?.dispose();
    this.skirtMaterial = null;
    this.covers.dispose();
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
        // Высот и стенок пол не меняет (TERR-6), но юбка соседей следует за
        // его границей (REND-7) — метится окрестность FLOOR_RADIUS.
        this.markCellRadius(cell, FLOOR_RADIUS, cost);
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
      // Окрестность FLOOR_RADIUS: юбка обрыва соседей следует за границей пола.
      this.markCellRadius(cell, FLOOR_RADIUS, cost);
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
          cost:
            'вершины и треугольники визуальной поверхности: клетка с кривизной даёт N×N подклеток, ' +
            'кромки стенок и юбки обрыва под ней делятся на N пролётов (REND-9, REND-7)',
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
   * Отладочный источник поверхности (`render-debug` RDBG-1, REND-27): сетка,
   * рампы, дыры пола и walkable-вклад — то самое поле высот, по которому
   * построена геометрия и посажены инстансы (REND-9). Данные принадлежат
   * подсистеме, поэтому и объявляет их она, а не отладочный слой.
   */
  debugSources(): readonly DebugSource[] {
    return [
      terrainSurfaceDebugSource({
        grid: () => this.grid,
        surface: () => this.surfaceSource?.current ?? null,
        // Живая карта пола подсистемы (TERR-6), а не начальная из ассета:
        // выбитая доставкой клетка обязана быть видна дырой сразу.
        floorBits: () => this.floor,
        // Приём сетки — точка входной границы рендера (REND-1, TERR-2).
        tileWorldUnits: () => this.grid.tileSize / FIXED_ONE,
        heightStepWorldUnits: () => this.heightStep,
        curvatureTessellation: () => this.tessellation,
      }),
    ];
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

  /** Число вершин юбки обрыва — для тестов и профилировки. */
  get skirtVertexCount(): number {
    return countVertices(this.skirtMeshes);
  }

  private flushDirty(cost: RenderCostCounters | undefined): void {
    if (this.dirtyChunks.size === 0) return;
    if (cost !== undefined) cost.terrainChunksRebuilt += this.dirtyChunks.size;
    for (const chunk of this.dirtyChunks) this.rebuildChunk(chunk);
    this.dirtyChunks.clear();
    // Чанков в сетке (PERF-8): величина растёт площадью арены и мельчанием
    // чанка, а не частотой пересборок — снимается после неё, когда геометрия
    // чанков уже построена.
    peak('terrainChunks', this.chunksX * this.chunksY);
  }

  private allocateChunks(): void {
    const count = this.chunksX * this.chunksY;
    this.floorMeshes = new Array<THREE.Mesh | null>(count).fill(null);
    this.wallMeshes = new Array<THREE.Mesh | null>(count).fill(null);
    this.skirtMeshes = new Array<THREE.Mesh | null>(count).fill(null);
  }

  private markAllChunks(cost: RenderCostCounters | undefined): void {
    const count = this.chunksX * this.chunksY;
    if (cost !== undefined) cost.terrainChunksMarked += count;
    for (let chunk = 0; chunk < count; chunk++) this.dirtyChunks.add(chunk);
  }

  /** Инвалидация окрестности правки уровня/рампы — все чанки в радиусе SHAPE_RADIUS. */
  private markShapeCell(cell: number, cost: RenderCostCounters | undefined): void {
    this.markCellRadius(cell, SHAPE_RADIUS, cost);
  }

  /** Пометка чанков всех клеток в радиусе `radius` от правки. */
  private markCellRadius(
    cell: number,
    radius: number,
    cost: RenderCostCounters | undefined,
  ): void {
    const { width, height } = this.grid;
    const x = cell % width;
    const y = Math.floor(cell / width);
    const cx0 = Math.floor(Math.max(x - radius, 0) / this.chunkSize);
    const cx1 = Math.floor(Math.min(x + radius, width - 1) / this.chunkSize);
    const cy0 = Math.floor(Math.max(y - radius, 0) / this.chunkSize);
    const cy1 = Math.floor(Math.min(y + radius, height - 1) / this.chunkSize);
    // Правка одной клетки метит окрестность (SHAPE_RADIUS), и повторные пометки
    // соседних клеток считаются: каждая — свой поиск в множестве, а пересборок
    // от них не прибавляется (их считает `terrainChunksRebuilt`).
    if (cost !== undefined) cost.terrainChunksMarked += (cx1 - cx0 + 1) * (cy1 - cy0 + 1);
    for (let cy = cy0; cy <= cy1; cy++) {
      for (let cx = cx0; cx <= cx1; cx++) this.dirtyChunks.add(cy * this.chunksX + cx);
    }
  }

  /**
   * Снимает нарисованные чанки со сцены и освобождает их геометрии. Общее у
   * смены арены (REND-14) и сноса подсистемы (REND-31); разделяемые материалы
   * переживают первое и отдаются на втором.
   */
  private clearMeshes(dropCasters: boolean): void {
    const ctx = this.ctx;
    for (const list of [this.floorMeshes, this.wallMeshes, this.skirtMeshes]) {
      for (const mesh of list) {
        if (mesh === null) continue;
        // Меш прежней арены уходит и из реестра теневых кастеров (REND-8): в
        // сцене его больше нет, а оставшаяся ссылка держала бы снятую геометрию
        // и считала бы её кадру — тем же порядком, что у пересборки чанка. На
        // сносе реестр не трогается вовсе: своё освещение снимает само (REND-31).
        if (dropCasters) this.shadows?.dropCaster(mesh);
        ctx?.scene.remove(mesh);
        mesh.geometry.dispose();
      }
    }
  }

  /** Другая арена: сцена очищается и раскладка чанков считается заново. */
  private resetGrid(next: TerrainGrid): void {
    this.clearMeshes(true);
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
      true,
      this.covers.floorMapping,
    );
    this.wallMeshes[chunk] = this.swapMesh(
      this.wallMeshes[chunk] ?? null,
      buildWallGeometry(this.grid, this.heightStep, this.surface, rect, this.tessellation),
      this.wallMaterial,
      `terrain:walls:${cx},${cy}`,
      true,
      this.covers.wallMapping,
    );
    if (this.skirtMaterial === null) return;
    this.skirtMeshes[chunk] = this.swapMesh(
      this.skirtMeshes[chunk] ?? null,
      buildSkirtGeometry(
        this.grid,
        this.floor,
        this.heightStep,
        this.skirtDepth,
        rect.x0,
        rect.y0,
        rect.w,
        rect.h,
        this.surface,
        this.tessellation,
      ),
      this.skirtMaterial,
      `terrain:skirt:${cx},${cy}`,
      // Юбка — не кастер: ниже неё нет приёмника тени, а карта теней платила
      // бы за её геометрию каждую перестройку (REND-7).
      false,
      this.covers.wallMapping,
    );
  }

  /** Снимает старый меш со сцены и ставит новый; пустая геометрия — меша нет. */
  private swapMesh(
    previous: THREE.Mesh | null,
    data: TerrainGeometryData,
    material: THREE.Material,
    name: string,
    caster: boolean,
    mapping: TerrainUvMapping | undefined,
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
    const mesh = new THREE.Mesh(toBufferGeometry(data, mapping), material);
    mesh.name = name;
    ctx.scene.add(mesh);
    // Террейн — статический кастер и приёмник теней при любом режиме, кроме
    // `none`: флаги расставляет сам приёмник, он один знает режим и фазу.
    if (caster) this.shadows?.setCaster(mesh, 'static');
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
