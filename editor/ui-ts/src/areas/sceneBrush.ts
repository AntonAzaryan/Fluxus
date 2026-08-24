/**
 * @contribution Кисти вьюпорта — террейна (ED-10) и кривизны (ED-11) — вклад
 * области сцены, а не часть каркаса.
 *
 * Ни DOM, ни THREE здесь нет намеренно, как и у инструмента расстановки: кисть
 * — политика над двумя сервисами рендера (picking REND-15 и набор наложений
 * REND-16), и оба она видит через узкие интерфейсы. Поэтому вся её логика
 * проверяется headless, а картинку проверяет глаз на живой сцене.
 *
 * ## Один мазок — одна запись истории (ED-18)
 *
 * «Непрерывный мазок кисти SHALL считаться одной операцией: undo снимает мазок
 * целиком, а не по клеткам». Механизм — тот же, что у перетаскивания
 * (`sceneInteraction.ts`), и намеренно тот же, а не второй свой:
 * `beginOperation` открывает транзакцию на первой клетке, `extend` продолжает
 * её на каждой следующей, `commit` закрывает одной записью. Прежние значения
 * сессия берёт с первого касания места, поэтому undo возвращает карты к тому,
 * что было ДО нажатия, а не к промежуточному состоянию мазка.
 *
 * Отличие от перетаскивания одно: транзакция открывается сразу на нажатии, без
 * порога сдвига. Клик кистью по одной клетке — это правка, а не выделение, и
 * ждать движения тут нечего; клик по клетке, которая уже такая, записи не
 * оставит сам — сессия не считает правкой запись того же значения.
 *
 * Закрыться мазок обязан в любом исходе, и все исходы идут одним путём
 * (`cancel`): отпускание, до вьюпорта не дошедшее (фаза `cancel` — окно
 * потеряло фокус, кадр снесён), нажатие поверх незакрытого мазка, смена
 * инструмента и отказ операции посреди мазка. Оставленная открытой транзакция —
 * не косметика: пока она открыта, сессия не даёт ни следующей операции, ни undo.
 *
 * ## Два слоя данных
 *
 * Кисть террейна правит sim-ассет (TERR-2), кисть кривизны —
 * presentation-ассет (ASSET-7). Слой выбирается один на мазок и определяет и
 * операцию, и документ: у кисти кривизны нет пути внутрь карт террейна, потому
 * что операция кривизны его не имеет (`sceneTerrain.ts`). «Кисть кривизны не
 * пересчитывает cliff-геометрию» выполняется тем же способом — пересчитать её
 * отсюда нечем вовсе, её выводит ядро из карты уровней (TERR-5).
 *
 * ## Почему клетки приходят от picking'а
 *
 * REND-15 отдаёт вместе с попаданием индекс клетки сетки и признак отсутствия
 * пола: «что делать с попаданием в дыру — политика инструмента, а не рендера».
 * Политика здесь простая: кисть красит клетку сетки независимо от того, есть в
 * ней пол или нет, — иначе вернуть пол в дыру было бы нечем (ED-10).
 *
 * Своего пересчёта экранной точки в клетку у кисти нет и быть не должно:
 * попадание считается по визуальной поверхности (REND-9), и второй расчёт по
 * плоскости уровня красил бы не те клетки, которые автор видит под курсором.
 */
import type {
  DocumentId,
  EditorSession,
  JsonPath,
  OperationParams,
  OperationTransaction,
} from '@fluxus/editor-core';
import type { SceneOverlay, ScenePicker, StagePointer } from './sceneInteraction.js';
import {
  MAX_LEVEL,
  TERRAIN_OPERATIONS,
  type TerrainCellKind,
} from './sceneTerrain.js';

/** Слой данных, который правит кисть: sim-ассет террейна или карта кривизны. */
export type BrushLayer = 'terrain' | 'curvature';

/**
 * Что кисть террейна делает с клеткой (ED-10). Четыре значения — четыре глагола
 * требования: задать уровень, пометить рампой, снять пол, вернуть пол.
 */
export const TERRAIN_BRUSH_MODES = ['level', 'ramp', 'removeFloor', 'restoreFloor'] as const;
export type TerrainBrushMode = (typeof TERRAIN_BRUSH_MODES)[number];

/** Вид клетки, который ставит каждый режим, кроме уровневого (TERR-3). */
const KIND_OF: Readonly<Record<Exclude<TerrainBrushMode, 'level'>, TerrainCellKind>> = {
  ramp: 'ramp',
  removeFloor: 'noFloor',
  restoreFloor: 'plain',
};

/** Уровни, из которых автор выбирает, — весь выразимый диапазон (TERR-3). */
export const BRUSH_LEVELS: readonly number[] = Object.freeze(
  Array.from({ length: MAX_LEVEL + 1 }, (_unused, level) => level),
);

/**
 * Размеры кисти — сторона квадрата в клетках. Только нечётные: у чётной стороны
 * нет клетки под курсором, и автор красил бы не там, куда показывает.
 */
export const BRUSH_SIZES: readonly number[] = Object.freeze([1, 3, 5]);

/** Где лежит правимый ассет: документ и путь внутри него (пустой — сам документ). */
export interface BrushTarget {
  readonly document: DocumentId;
  readonly path: JsonPath;
}

/** Размеры сетки — столько, сколько нужно кисти, чтобы не выйти за карту. */
export interface BrushGrid {
  readonly width: number;
  readonly height: number;
}

/**
 * Слой, доступный кисти: куда писать и какого размера карта. Приходит вместе с
 * кадром, а не при заведении инструмента: карту кривизны называет манифест
 * (ASSET-6), то есть она известна только после открытия проекта, а размеры
 * сетки меняются правкой документа.
 */
export interface BrushSurface {
  readonly target: BrushTarget;
  readonly grid: BrushGrid;
}

export interface BrushToolOptions {
  readonly session: EditorSession;
  /** Просьба перерисовать: кисть изменила своё состояние или документ. */
  readonly refresh?: () => void;
}

/** Что кисть видит из кадра; подаётся отрисовкой области перед любым обращением. */
export interface BrushToolInput {
  readonly picker: ScenePicker | null;
  /** Ассет террейна (TERR-2) и его сетка; null — террейна в документе нет. */
  readonly terrain: BrushSurface | null;
  /** Карта кривизны (ASSET-7); null — её у сцены нет или она не разобралась. */
  readonly curvature: BrushSurface | null;
}

export interface BrushTool {
  readonly layer: BrushLayer;
  setLayer(layer: BrushLayer): void;
  readonly mode: TerrainBrushMode;
  setMode(mode: TerrainBrushMode): void;
  readonly level: number;
  setLevel(level: number): void;
  /** Смещение кривизны — целый множитель решётки 1/32 шага высоты (ASSET-7). */
  readonly offset: number;
  setOffset(offset: number): void;
  readonly size: number;
  setSize(size: number): void;
  readonly showGrid: boolean;
  setShowGrid(on: boolean): void;
  /** Есть ли что править на слое (ED-26): без карты кисть недоступна, а не молчалива. */
  available(layer?: BrushLayer): boolean;
  /** Идёт ли мазок — по нему видно, что взаимодействие ещё не закрыто. */
  readonly painting: boolean;
  attach(input: BrushToolInput): void;
  pointer(event: StagePointer): void;
  /** Бросить незакрытый мазок: смена инструмента, снос области, потеря фокуса. */
  cancel(): void;
  /** Полный набор наложений кисти по текущему состоянию (REND-16). */
  overlays(): readonly SceneOverlay[];
}

/** Ключи наложений кисти в общем наборе области (REND-16): устойчивые и свои. */
export const BRUSH_OVERLAY_KEYS = { cells: 'brush:cells', grid: 'brush:grid' } as const;

interface Cell {
  readonly x: number;
  readonly y: number;
}

interface Stroke {
  transaction: OperationTransaction | null;
  /**
   * Клетки, уже покрашенные этим мазком. Нужны, чтобы возврат курсора на
   * пройденное не превращался в лишние применения: клетку, покрашенную мазком,
   * он второй раз не трогает.
   */
  readonly painted: Set<number>;
}

export function createBrushTool(options: BrushToolOptions): BrushTool {
  const { session } = options;
  const refresh = options.refresh ?? ((): void => undefined);

  let layer: BrushLayer = 'terrain';
  let mode: TerrainBrushMode = 'level';
  let level = 1;
  let offset = 1;
  let size = BRUSH_SIZES[0] ?? 1;
  let showGrid = true;
  let input: BrushToolInput | null = null;
  let stroke: Stroke | null = null;
  /** Клетка под курсором: из неё строится превью мазка (REND-16). */
  let hover: Cell | null = null;

  const surfaceOf = (which: BrushLayer): BrushSurface | null =>
    (which === 'curvature' ? input?.curvature : input?.terrain) ?? null;

  const available = (which: BrushLayer = layer): boolean => surfaceOf(which) !== null;

  /** Квадрат клеток вокруг курсора, обрезанный по карте правимого слоя. */
  const cellsAround = (centre: Cell, grid: BrushGrid): readonly Cell[] => {
    const radius = (size - 1) / 2;
    const cells: Cell[] = [];
    for (let y = centre.y - radius; y <= centre.y + radius; y++) {
      for (let x = centre.x - radius; x <= centre.x + radius; x++) {
        if (x < 0 || y < 0 || x >= grid.width || y >= grid.height) continue;
        cells.push({ x, y });
      }
    }
    return cells;
  };

  const paramsFor = (target: BrushTarget, cell: Cell): OperationParams =>
    layer === 'curvature'
      ? // Кисть кривизны красит узлы — углы клеток мазка (ED-11, ASSET-7).
        { document: target.document, path: [...target.path], nodeX: cell.x, nodeY: cell.y, offset }
      : {
          document: target.document,
          path: [...target.path],
          cellX: cell.x,
          cellY: cell.y,
          ...(mode === 'level' ? { level } : { kind: KIND_OF[mode] }),
        };

  /**
   * Узлы под квадратом мазка: углы покрытых клеток. Узловая сетка на единицу
   * шире и выше клеточной (ASSET-7), поэтому границы включают width и height.
   */
  const nodesAround = (centre: Cell, grid: BrushGrid): readonly Cell[] => {
    const radius = (size - 1) / 2;
    const nodes: Cell[] = [];
    for (let y = centre.y - radius; y <= centre.y + radius + 1; y++) {
      for (let x = centre.x - radius; x <= centre.x + radius + 1; x++) {
        if (x < 0 || y < 0 || x > grid.width || y > grid.height) continue;
        nodes.push({ x, y });
      }
    }
    return nodes;
  };

  const operationId = (): string =>
    layer === 'curvature'
      ? TERRAIN_OPERATIONS.curvature
      : mode === 'level'
        ? TERRAIN_OPERATIONS.level
        : TERRAIN_OPERATIONS.cell;

  /**
   * Бросает мазок, вернув карты к состоянию до нажатия. Это же — ответ на отказ
   * операции посреди мазка: половина покрашенных клеток есть состояние, которого
   * не производит ни одна операция целиком, и `commit` записал бы его в историю
   * как достижимое (ED-18).
   */
  const cancelStroke = (): void => {
    const open = stroke;
    stroke = null;
    if (open?.transaction == null) return;
    open.transaction.cancel();
    refresh();
  };

  /**
   * Красит клетки под курсором, продолжая тот же мазок.
   *
   * Просьбы перерисовать здесь нет: применение внутри ещё не закрытой
   * транзакции сессия объявляет событием наравне с записанным в историю, и
   * кадр сводится с картами по нему — клетка меняется во вьюпорте по ходу
   * мазка, а не после отпускания кнопки (ED-15).
   */
  const paintAt = (event: StagePointer): void => {
    const open = stroke;
    const picker = input?.picker;
    const surface = surfaceOf(layer);
    if (open === null || picker == null || surface === null) return;
    const grid = surface.grid;
    const hit = picker.pickSurface(event.x, event.y);
    // Курсор ушёл за арену: красить нечего, а мазок при этом не прерывается.
    if (hit === null) return;
    const centre = { x: hit.cellX, y: hit.cellY };
    const targets = layer === 'curvature' ? nodesAround(centre, grid) : cellsAround(centre, grid);
    try {
      for (const cell of targets) {
        const index = cell.y * (grid.width + 1) + cell.x;
        if (open.painted.has(index)) continue;
        open.painted.add(index);
        const params = paramsFor(surface.target, cell);
        if (open.transaction === null) {
          open.transaction = session.beginOperation(operationId(), params);
        } else {
          open.transaction.extend(params);
        }
      }
    } catch {
      // Отказ операции мазок не продолжает: карты возвращаются к состоянию до
      // нажатия, в истории не остаётся ничего. Причина наружу не поднимается —
      // это отказ записи, а не сломанный документ, и показывать его должен
      // тот же путь валидации, что показывает сломанное (ED-8).
      cancelStroke();
    }
  };

  /** Клетка под курсором: превью обязано лежать там, где кисть покрасит. */
  const trackHover = (event: StagePointer): void => {
    const picker = input?.picker;
    const hit = picker == null ? null : picker.pickSurface(event.x, event.y);
    const next = hit === null ? null : { x: hit.cellX, y: hit.cellY };
    if (next?.x === hover?.x && next?.y === hover?.y) return;
    hover = next;
    // Перерисовка на смену клетки, а не на каждое движение мыши: набор
    // наложений отдаётся сборкой страницы, и просить её на каждый пиксель
    // значило бы пересобирать страницу десятки раз в секунду впустую.
    refresh();
  };

  return {
    get layer(): BrushLayer {
      return layer;
    },
    setLayer(next) {
      if (next === layer) return;
      cancelStroke();
      layer = next;
      refresh();
    },
    get mode(): TerrainBrushMode {
      return mode;
    },
    setMode(next) {
      if (next === mode) return;
      cancelStroke();
      mode = next;
      refresh();
    },
    get level(): number {
      return level;
    },
    setLevel(next) {
      level = next;
      refresh();
    },
    get offset(): number {
      return offset;
    },
    setOffset(next) {
      offset = next;
      refresh();
    },
    get size(): number {
      return size;
    },
    setSize(next) {
      size = next;
      refresh();
    },
    get showGrid(): boolean {
      return showGrid;
    },
    setShowGrid(on) {
      showGrid = on;
      refresh();
    },
    available,
    get painting(): boolean {
      return stroke?.transaction != null;
    },

    attach(next) {
      input = next;
    },

    pointer(event) {
      if (event.phase === 'cancel') {
        hover = null;
        cancelStroke();
        return;
      }
      if (event.phase === 'leave') {
        // Курсор ушёл с холста: показывать нечего — клетки под ним больше нет.
        // Мазок при этом не прерывается (ED-18): кнопку отпустят где угодно, и
        // отпускание придёт с документа.
        if (hover === null) return;
        hover = null;
        refresh();
        return;
      }
      if (event.phase === 'up') {
        const open = stroke;
        stroke = null;
        if (open?.transaction == null) return;
        // Одна запись истории на весь мазок (ED-18).
        open.transaction.commit();
        refresh();
        return;
      }
      if (event.phase === 'down') {
        // Нажатие поверх незакрытого мазка: отпускание до вьюпорта не дошло.
        // Прежний мазок закрывается здесь, а не забывается ссылкой — забытая
        // транзакция осталась бы открытой в сессии навсегда (ED-18).
        if (stroke !== null) cancelStroke();
        trackHover(event);
        // Пока идёт чужое взаимодействие, второй операции сессия не начнёт и
        // отказывает исключением: молча ничего не сделать, а не уронить
        // обработчик указателя.
        if (!available() || session.pending) return;
        stroke = { transaction: null, painted: new Set<number>() };
        paintAt(event);
        return;
      }
      trackHover(event);
      if (stroke !== null) paintAt(event);
    },

    cancel: cancelStroke,

    overlays() {
      // Набор — функция состояния кисти, а не история вызовов (REND-16), и
      // отдаётся он целиком: сводит его подсистема, а складывает с чужими
      // наложениями область.
      const items: SceneOverlay[] = [];
      const terrain = surfaceOf('terrain');
      if (terrain === null) return items;
      if (showGrid) items.push({ kind: 'grid', key: BRUSH_OVERLAY_KEYS.grid });
      const surface = surfaceOf(layer);
      if (hover === null || surface === null) return items;
      // Индексы клеток — индексы сетки террейна: ими picking их и называет
      // (REND-15), и на визуальной поверхности рисует их подсистема. Клетки
      // правимого слоя поэтому пересекаются с сеткой террейна: карта кривизны
      // бывает другого размера (ED-11, ASSET-7), и клетка за её краем, свёрнутая
      // шагом террейна, подсветила бы чужую строку.
      const cells = cellsAround(hover, surface.grid)
        .filter((cell) => cell.x < terrain.grid.width && cell.y < terrain.grid.height)
        .map((cell) => cell.y * terrain.grid.width + cell.x);
      if (cells.length > 0) items.push({ kind: 'cells', key: BRUSH_OVERLAY_KEYS.cells, cells });
      return items;
    },
  };
}
