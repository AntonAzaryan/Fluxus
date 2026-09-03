/**
 * Виджет миникарты (HUD-6): обычный виджет HUD за единым интерфейсом (HUD-4)
 * с собственной 2D-поверхностью (canvas) внутри DOM-слоя — схема арены, а НЕ
 * второй проход рендера сцены. Источники — только уже доставленное главному
 * потоку:
 *
 * - сетка террейна handshake (SHELL-5) — инъекцией `MinimapTerrainSource` при
 *   регистрации вида виджета: тем же путём подсистема террейна render-ts
 *   получает `TerrainGrid` от сборки (конструктором из `RemoteHost.terrain`),
 *   и `RemoteHost` подходит источником структурно;
 * - зеркало пола и его дельты — из доставленного состояния через биндинг
 *   (`floorBits`/`floorChangedCells`, SHELL-5 → HUD-6);
 * - позиции и визуальные типы сущностей — из доставленного состояния через
 *   биндинг. `kind` здесь — уже ИМЯ визуального типа: индексы конверта
 *   разрешает по таблице handshake сам `RemoteHost` (`readTick`), поэтому
 *   таблица маркеров ключуется именами без второй таблицы соответствий.
 *
 * Скрытое туманом войны миникарта не фильтрует, потому что фильтровать нечего:
 * скрытой сущности нет в доставленном состоянии по построению (HUD-1, NET-12) —
 * та же фильтрация, что у основного вида камеры (HUD-6).
 *
 * Поверхность — ДВА канваса слоями: нижний держит фон (пол/дыры) и
 * перерисовывается точечно по дельтам пола, полная перерисовка — только по
 * снапу или смене сетки; верхний — маркеры, очищается и рисуется целиком на
 * каждой доставке. Слоёный canvas и есть кэш фона: тот же смысл, что у
 * offscreen-канваса, но без создания элементов мимо DOM-описания — и
 * тестируется без браузера.
 *
 * Преобразование мир → миникарта — аффинное, float (presentation-слой; Q16.16
 * остаётся на входной границе `tileSize`): равномерный масштаб
 * `s = min(width / worldW, height / worldH)` с центрированием
 * `offset = (canvas − world·s) / 2`; клетка (cx, cy) занимает мировой квадрат
 * `[cx·tile, (cx+1)·tile] × [cy·tile, (cy+1)·tile]` от начала координат — как
 * у геометрии пола render-ts.
 *
 * Вертикаль ПЕРЕВЁРНУТА (HUD-6): мировая `+Y` идёт на экране вверх, а `y`
 * canvas растёт вниз, поэтому `py = offsetY + (worldH − y)·s`. Без переворота
 * миникарта зеркалила основной вид: сущность, уходящая вверх экрана, ползла
 * вниз по схеме. Отображение одно на всё — маркеры, клетки пола и обратное
 * преобразование клика (`y = worldH − (py − offsetY)/s`), — иначе клик попадал
 * бы не туда, куда показывает маркер. Точка в полях центрирования прижимается
 * к краю арены.
 *
 * Клик — presentation-действие (HUD-2, сценарий «клик миникарты двигает
 * камеру»): виджет дёргает слот `pan` с мировыми `{ x, y }`, композиция ведёт
 * слот в действие камеры; сообщений воркеру не возникает — за этим следит
 * фасад действий, а не виджет.
 */
import type { HudParams } from '../composition.js';
import type { HudDeliveredState } from '../delivery.js';
import { el, type HudNode } from '../dom/node.js';
import { interactive } from '../host.js';
import type { HudSelector } from '../registry.js';
import type { HudActionsPort, HudUpdate, HudWidget, HudWidgetKind } from '../widget.js';
import {
  builtinMarkerRenderers,
  markerColor,
  markerTableFromParams,
  resolveMarkerTable,
  type MinimapContext2D,
  type MinimapEntityView,
  type MinimapRendererRegistry,
  type ResolvedMarker,
  type ResolvedMarkerTable,
} from './markers.js';

/** Q16.16: масштаб `tileSize` из handshake (TERR-2); приём — точка входной границы. */
const FIXED_ONE = 65536;

/** Имя вида виджета в реестре видов (HUD-4). */
export const MINIMAP_WIDGET_NAME = 'minimap';
/** Слот действия клика: композиция ведёт его в presentation-действие камеры (HUD-2). */
export const MINIMAP_PAN_SLOT = 'pan';

// ------------------------------------------------------------------ источники

/** Сетка террейна глазами миникарты — структурное подмножество `TerrainGrid` ядра. */
export interface MinimapTerrainGrid {
  readonly width: number;
  readonly height: number;
  /** Размер клетки в Q16.16 (TERR-2). */
  readonly tileSize: number;
  /**
   * Уровень каждой клетки (`terrain` TERR-4) — тот же массив сетки handshake,
   * которым рисует основной вид (HUD-6): второго его источника нет. Поля нет —
   * подложка рисуется одним цветом пола, как до появления слоёв.
   */
  readonly levels?: ArrayLike<number>;
}

/**
 * След статической декорации на схеме (HUD-6): мировой круг под инстансом.
 * Круг, а не прямоугольник записи документа: миникарта показывает, где на арене
 * стоит препятствие, а не как оно повёрнуто, — и радиус берётся из границ
 * НАРИСОВАННОГО инстанса, то есть из того же, чем декорацию рисует рендер
 * (`rendering` REND-3, REND-18).
 */
export interface MinimapFootprint {
  /** Мировая позиция инстанса. */
  readonly x: number;
  readonly y: number;
  /** Радиус следа в мировых единицах. */
  readonly radius: number;
}

/**
 * Слои подложки сверх пола (HUD-6). Наполняет их СБОРКА — тем, что уже держит
 * для рендера: миникарта документов сцены не читает, второй читатель разошёлся
 * бы с рендером так же, как два определения «что в тумане».
 *
 * Слой, которого сборка не дала, не рисуется вовсе — сцена без воды и без
 * декораций выглядит как прежде.
 */
export interface MinimapTerrainLayers {
  /**
   * Клетки воды (`presentation-scene` PRES-2 → `rendering` REND-35): ненулевое
   * значение — вода есть. Длина — как у сетки; расхождение длины гасит слой.
   */
  readonly water?: ArrayLike<number> | null;
  /** Следы статических декораций; пустой список и отсутствие неразличимы. */
  readonly decorations?: readonly MinimapFootprint[] | null;
}

/**
 * Источник сетки handshake (SHELL-5). `RemoteHost` подходит структурно
 * (`remoteHost.terrain`); до handshake и на сценах без террейна — null,
 * миникарте нечего показывать.
 *
 * Слои подложки (HUD-6) приходят тем же источником и тем же путём — от сборки,
 * а не чтением документа.
 */
export interface MinimapTerrainSource {
  readonly terrain: MinimapTerrainGrid | null;
  readonly layers?: MinimapTerrainLayers | null;
}

/** Значение слота `floor`: зеркало пола и дельты одной доставки (HUD-6). */
export interface MinimapFloorValue {
  readonly bits: Uint8Array;
  readonly changed: readonly number[];
}

/**
 * Слой тумана войны (HUD-6, `fog-of-war` FOW-7): ТА ЖЕ маска видимости, что у
 * fog-mask основного вида, — канвас продюсера маски поверх прямоугольника мира,
 * который он покрывает, и сила затемнения из той же конфигурации (FOW-10).
 * Собственного пересчёта видимости и собственных параметров у миникарты нет:
 * два определения «что в тумане» на одном экране разошлись бы (HUD-6).
 *
 * Объект стабилен: продюсер перерисовывает канвас на месте, а сила читается
 * геттером — виджет вправе держать ссылку между доставками. Верхняя строка
 * канваса — максимальный `y` мира: тот же переворот вертикали, что у самой
 * миникарты (HUD-6), и блит идёт без зеркалирования.
 */
export interface MinimapFogLayer {
  /** Канвас маски; тип за пределами структурного минимума виджету не нужен. */
  readonly canvas: unknown;
  /** Прямоугольник мира, который канвас покрывает. */
  readonly world: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  };
  /** Сила затемнения из конфигурации тумана (FOW-10). */
  readonly strength: number;
}

/**
 * Источник слоя тумана — продюсер маски рендера (в игровой сборке — подсистема
 * тумана, структурно). null — тумана нет, и слой не рисуется вовсе (HUD-6).
 */
export interface MinimapFogSource {
  readonly fog: MinimapFogLayer | null;
}

/** Селектор слота `entities`: сущности доставленного состояния как есть (HUD-4). */
export const minimapEntitiesSelector: HudSelector = (state: HudDeliveredState) => state.entities;

/** Селектор слота `floor`: зеркало пола с дельтами; null — сцена без террейна. */
export const minimapFloorSelector: HudSelector = (state: HudDeliveredState) =>
  state.floorBits === null ? null : { bits: state.floorBits, changed: state.floorChangedCells };

// -------------------------------------------------------------- конфигурация

/**
 * Параметры записи композиции (все — JSON-значения, HUD-4):
 * - `markers` (обязателен) — таблица маркеров `MinimapMarkerTable` (HUD-6);
 * - `width`, `height` — размер поверхности в px;
 * - `floorColor`, `holeColor` — цвет клетки с полом и дыры;
 * - `levelPalette` — цвет клетки по индексу её уровня (HUD-6); пустая палитра
 *   даёт прежнюю картинку — один `floorColor` на всю арену;
 * - `waterColor`, `decorationColor` — цвета слоёв воды и следов декораций.
 *
 * Окраска слоёв — ДАННЫЕ, а не константы кода (HUD-6): сколько уровней у арены
 * и какими они читаются — политика игры.
 */
interface MinimapConfig {
  readonly width: number;
  readonly height: number;
  readonly floorColor: string;
  readonly holeColor: string;
  readonly levelPalette: readonly string[];
  readonly waterColor: string;
  readonly decorationColor: string;
}

const DEFAULT_SIZE = 192;
const DEFAULT_FLOOR_COLOR = '#3d4450';
const DEFAULT_HOLE_COLOR = '#14161a';
const DEFAULT_WATER_COLOR = '#1d5a6b';
const DEFAULT_DECORATION_COLOR = '#5a5f68';

function numberParam(params: HudParams, name: string, fallback: number): number {
  const value = params[name];
  if (value === undefined) return fallback;
  if (typeof value !== 'number') throw new Error(`миникарта: параметр "${name}" должен быть числом`);
  return value;
}

function stringParam(params: HudParams, name: string, fallback: string): string {
  const value = params[name];
  if (value === undefined) return fallback;
  if (typeof value !== 'string') throw new Error(`миникарта: параметр "${name}" должен быть строкой`);
  return value;
}

/** Палитра уровней записи композиции; отсутствие и пустой список неразличимы. */
function paletteParam(params: HudParams, name: string): readonly string[] {
  const value = params[name];
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new Error(`миникарта: параметр "${name}" должен быть списком цветов`);
  }
  return value.map((color, index) => {
    if (typeof color !== 'string') {
      throw new Error(`миникарта: "${name}[${String(index)}]" должен быть строкой цвета`);
    }
    return color;
  });
}

function configFrom(params: HudParams): MinimapConfig {
  return {
    width: numberParam(params, 'width', DEFAULT_SIZE),
    height: numberParam(params, 'height', DEFAULT_SIZE),
    floorColor: stringParam(params, 'floorColor', DEFAULT_FLOOR_COLOR),
    holeColor: stringParam(params, 'holeColor', DEFAULT_HOLE_COLOR),
    levelPalette: paletteParam(params, 'levelPalette'),
    waterColor: stringParam(params, 'waterColor', DEFAULT_WATER_COLOR),
    decorationColor: stringParam(params, 'decorationColor', DEFAULT_DECORATION_COLOR),
  };
}

// ------------------------------------------------------------------- виджет

/**
 * Кэш аффинного преобразования мир → px миникарты (см. шапку модуля) и слоёв
 * подложки этой сетки (HUD-6). Слои лежат здесь, а не читаются у источника на
 * каждую клетку: их состав меняется вместе с сеткой, а перерисовка клетки —
 * горячий путь доставки.
 */
interface MinimapTransform {
  readonly scale: number;
  readonly offsetX: number;
  readonly offsetY: number;
  /** Мировой размер клетки (float). */
  readonly tile: number;
  readonly gridWidth: number;
  readonly worldWidth: number;
  readonly worldHeight: number;
  /** Уровни клеток сетки; null — сетка их не несёт (HUD-6). */
  readonly levels: ArrayLike<number> | null;
  /** Клетки воды; null — слоя нет либо он не по этой сетке. */
  readonly water: ArrayLike<number> | null;
  /** Следы декораций; null — слоя нет. */
  readonly decorations: readonly MinimapFootprint[] | null;
}

/** Канвас глазами виджета — структурный минимум `HTMLCanvasElement`. */
interface MinimapCanvasLike {
  getContext(contextId: '2d'): MinimapContext2D | null;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * Мировая ордината → пиксель canvas (HUD-6): вертикаль перевёрнута, чтобы
 * «вверх экрана» основного вида было «вверх» и здесь. Одна функция на отрисовку
 * и на клик — переворот, сделанный дважды по-разному, и есть тот дефект,
 * который HUD-6 запрещает.
 */
function pixelY(worldY: number, t: MinimapTransform): number {
  return t.offsetY + (t.worldHeight - worldY) * t.scale;
}

/** Обратное к `pixelY`: пиксель canvas → мировая ордината. */
function worldYOf(pixel: number, t: MinimapTransform): number {
  return t.worldHeight - (pixel - t.offsetY) / t.scale;
}

class MinimapWidget implements HudWidget {
  private readonly config: MinimapConfig;
  private readonly table: ResolvedMarkerTable;
  private readonly terrainSource: MinimapTerrainSource;
  private readonly fogSource: MinimapFogSource | null;

  private port: HudActionsPort | null = null;
  private floorCanvas: MinimapCanvasLike | null = null;
  private markerCanvas: MinimapCanvasLike | null = null;
  private floorCtx: MinimapContext2D | null = null;
  private markerCtx: MinimapContext2D | null = null;

  private transform: MinimapTransform | null = null;
  private transformGrid: MinimapTerrainGrid | null = null;
  /** Зеркало пола, отрисованное целиком; не оно в доставке — фон устарел весь. */
  private paintedBits: Uint8Array | null = null;

  constructor(
    params: HudParams,
    terrainSource: MinimapTerrainSource,
    renderers: MinimapRendererRegistry,
    fogSource: MinimapFogSource | null,
  ) {
    this.config = configFrom(params);
    // Резолв таблицы — при создании, по образцу резолва композиции (HUD-4):
    // ошибка конфигурации падает до монтирования и называет запись.
    this.table = resolveMarkerTable(markerTableFromParams(params.markers), renderers);
    this.terrainSource = terrainSource;
    this.fogSource = fogSource;
  }

  mount(actions: HudActionsPort): HudNode {
    this.port = actions;
    const size = { width: String(this.config.width), height: String(this.config.height) };
    const layer: Readonly<Record<string, string>> = { position: 'absolute', inset: '0' };
    return el('div', {
      classes: ['hud-minimap'],
      style: {
        position: 'relative',
        width: `${size.width}px`,
        height: `${size.height}px`,
      },
      children: [
        // Нижний слой — фон из зеркала пола, живёт между доставками (кэш).
        el('canvas', {
          classes: ['hud-minimap-floor'],
          attrs: size,
          style: layer,
          ref: (element) => {
            this.floorCanvas = element as unknown as MinimapCanvasLike;
          },
        }),
        // Верхний слой — маркеры; он же и единственный интерактив виджета
        // (HUD-3): клик в границах миникарты перехватывается, вне их —
        // уходит вьюпорту.
        interactive(
          el('canvas', {
            classes: ['hud-minimap-markers'],
            attrs: size,
            style: layer,
            on: {
              click: (event) => {
                this.onClick(event);
              },
            },
            ref: (element) => {
              this.markerCanvas = element as unknown as MinimapCanvasLike;
            },
          }),
        ),
      ],
    });
  }

  update(update: HudUpdate): void {
    const grid = this.terrainSource.terrain;
    // До handshake и на сценах без террейна рисовать нечего (SHELL-5).
    if (grid === null) return;
    const transform = this.transformFor(grid);
    const floor = (update.values.floor ?? null) as MinimapFloorValue | null;
    this.drawFloor(floor, transform, update.snap);
    this.drawMarkers(
      update.values.entities as ReadonlyMap<number, MinimapEntityView> | undefined,
      transform,
    );
  }

  /**
   * Слой тумана над подложкой (HUD-6): блит канваса маски продюсера с силой
   * затемнения из той же конфигурации (FOW-10). Рисуется на слое маркеров ПОД
   * ними: маркеры — доставленные сущности, скрытых среди них нет по построению
   * (HUD-1), и гасить их туманом нечего. Нет источника или слоя — не рисуется
   * ничего: сцена без тумана выглядит как прежде.
   */
  private drawFog(ctx: MinimapContext2D, t: MinimapTransform): void {
    const layer = this.fogSource?.fog ?? null;
    if (layer === null || ctx.drawImage === undefined) return;
    // Верх канваса маски — дальняя по миру сторона прямоугольника: тот же
    // переворот вертикали, что у клеток пола и маркеров (HUD-6).
    ctx.globalAlpha = layer.strength;
    ctx.drawImage(
      layer.canvas,
      t.offsetX + layer.world.x * t.scale,
      pixelY(layer.world.y + layer.world.height, t),
      layer.world.width * t.scale,
      layer.world.height * t.scale,
    );
    ctx.globalAlpha = 1;
  }

  dispose(): void {
    this.port = null;
    this.floorCanvas = this.markerCanvas = null;
    this.floorCtx = this.markerCtx = null;
    this.transform = this.transformGrid = null;
    this.paintedBits = null;
  }

  // ------------------------------------------------------------- внутренности

  private transformFor(grid: MinimapTerrainGrid): MinimapTransform {
    if (this.transform !== null && this.transformGrid === grid) return this.transform;
    const tile = grid.tileSize / FIXED_ONE;
    const worldWidth = grid.width * tile;
    const worldHeight = grid.height * tile;
    const scale = Math.min(this.config.width / worldWidth, this.config.height / worldHeight);
    const cells = grid.width * grid.height;
    const layers = this.terrainSource.layers ?? null;
    const water = layers?.water ?? null;
    this.transform = {
      scale,
      tile,
      gridWidth: grid.width,
      offsetX: (this.config.width - worldWidth * scale) / 2,
      offsetY: (this.config.height - worldHeight * scale) / 2,
      worldWidth,
      worldHeight,
      levels: grid.levels ?? null,
      // Слой не по этой сетке — не слой: рисовать чужую маску значило бы
      // показать воду не там, где она есть (HUD-6).
      water: water !== null && water.length === cells ? water : null,
      decorations: layers?.decorations ?? null,
    };
    this.transformGrid = grid;
    this.paintedBits = null; // другая сетка — прежний фон недействителен
    return this.transform;
  }

  private context(which: 'floor' | 'marker'): MinimapContext2D {
    const cached = which === 'floor' ? this.floorCtx : this.markerCtx;
    if (cached !== null) return cached;
    const canvas = which === 'floor' ? this.floorCanvas : this.markerCanvas;
    const ctx = canvas?.getContext('2d') ?? null;
    if (ctx === null) throw new Error(`миникарта: 2D-контекст слоя "${which}" недоступен`);
    if (which === 'floor') this.floorCtx = ctx;
    else this.markerCtx = ctx;
    return ctx;
  }

  /**
   * Фон из зеркала пола: полная перерисовка — только по снапу (HUD-5: снап, не
   * доигрывание) или когда целиком этот массив ещё не рисовали; иначе — ровно
   * клетки из дельт доставки (`floorChangedCells`, HUD-6).
   */
  private drawFloor(floor: MinimapFloorValue | null, t: MinimapTransform, snap: boolean): void {
    if (floor === null) return;
    const ctx = this.context('floor');
    if (snap || this.paintedBits !== floor.bits) {
      ctx.clearRect(0, 0, this.config.width, this.config.height);
      for (let cell = 0; cell < floor.bits.length; cell++) this.paintCell(ctx, floor.bits, cell, t);
      this.paintedBits = floor.bits;
      this.paintDecorations(ctx, t);
      return;
    }
    if (floor.changed.length === 0) return;
    for (const cell of floor.changed) this.paintCell(ctx, floor.bits, cell, t);
    // Следы декораций не клеточные (HUD-6): перерисованная клетка стирает тот
    // их кусок, что лежал на ней, — и кладутся они снова целиком. Их единицы,
    // и десяток кругов дешевле второго слоя canvas.
    this.paintDecorations(ctx, t);
  }

  /**
   * Клетка подложки: пол или дыра, а под полом — её уровень (`terrain` TERR-4)
   * и вода (HUD-6). Уровень и вода — свойства КЛЕТКИ, поэтому рисуются здесь же:
   * точечная перерисовка по дельтам доставки их не теряет.
   */
  private paintCell(ctx: MinimapContext2D, bits: Uint8Array, cell: number, t: MinimapTransform): void {
    const cx = cell % t.gridWidth;
    const cy = Math.floor(cell / t.gridWidth);
    const cellPx = t.tile * t.scale;
    const px = t.offsetX + cx * cellPx;
    // Верхний край клетки на экране — её ДАЛЬНЯЯ по миру сторона (HUD-6).
    const py = pixelY((cy + 1) * t.tile, t);
    ctx.fillStyle = bits[cell] === 0 ? this.config.holeColor : this.floorColorOf(cell, t);
    ctx.fillRect(px, py, cellPx, cellPx);
    if (bits[cell] === 0 || !this.hasWater(cell, t)) return;
    // Вода поверх пола, а не вместо него: под ней остаётся тот же уровень, и
    // на дыре воды не бывает — дыра это отсутствие пола, а не мель.
    ctx.fillStyle = this.config.waterColor;
    ctx.fillRect(px, py, cellPx, cellPx);
  }

  /**
   * Цвет пола клетки: цвет её уровня из палитры записи композиции (HUD-6),
   * уровень выше последнего цвета прижимается к последнему. Пустая палитра или
   * сетка без уровней — прежний единственный цвет пола.
   */
  private floorColorOf(cell: number, t: MinimapTransform): string {
    const palette = this.config.levelPalette;
    const levels = t.levels;
    if (palette.length === 0 || levels === null) return this.config.floorColor;
    const level = levels[cell] ?? 0;
    const index = level < 0 ? 0 : Math.min(Math.floor(level), palette.length - 1);
    return palette[index] ?? this.config.floorColor;
  }

  /** Есть ли в клетке вода (HUD-6); слоя нет либо он не по этой сетке — нет. */
  private hasWater(cell: number, t: MinimapTransform): boolean {
    const water = t.water;
    return water !== null && (water[cell] ?? 0) !== 0;
  }

  /**
   * Следы статических декораций (HUD-6): круги по мировым позициям и радиусам,
   * которые дала сборка из НАРИСОВАННЫХ инстансов. Слоя нет — прохода нет.
   */
  private paintDecorations(ctx: MinimapContext2D, t: MinimapTransform): void {
    const footprints = t.decorations;
    if (footprints === null || footprints.length === 0) return;
    ctx.fillStyle = this.config.decorationColor;
    for (const one of footprints) {
      const radius = one.radius * t.scale;
      // Круг рисуется квадратом со скруглением до пикселя: у миникарты клетка
      // и так в единицы пикселей, а `arc` заводил бы второй путь отрисовки
      // ради формы, неразличимой в этом масштабе.
      const size = Math.max(1, radius * 2);
      ctx.fillRect(
        t.offsetX + one.x * t.scale - size / 2,
        pixelY(one.y, t) - size / 2,
        size,
        size,
      );
    }
  }

  /**
   * Маркеры — целиком на каждой доставке, по таблице (HUD-6). Скрытых сущностей
   * здесь не бывает — их нет в доставленном состоянии (HUD-1), фильтровать
   * нечего. Порядок детерминирован: приоритет по возрастанию (больший — поверх),
   * при равенстве — id; картинка не зависит от порядка обхода Map.
   */
  private drawMarkers(
    entities: ReadonlyMap<number, MinimapEntityView> | undefined,
    t: MinimapTransform,
  ): void {
    const ctx = this.context('marker');
    ctx.clearRect(0, 0, this.config.width, this.config.height);
    // Туман — под маркерами, поверх подложки (HUD-6): слой маркеров очищается
    // целиком на каждой доставке, и туман перерисовывается вместе с ним.
    this.drawFog(ctx, t);
    if (entities === undefined) return;

    // ponytail: массив и обёртки аллоцируются на каждую доставку; при сотнях
    // маркеров на реальной сцене — переиспользуемый буфер.
    const drawn: { entity: MinimapEntityView; marker: ResolvedMarker }[] = [];
    for (const entity of entities.values()) {
      // kind === null — сущность не рисуется и в основном виде; это не
      // «неизвестный тип», политика unknownKind к ней не применяется.
      if (entity.kind === null) continue;
      const marker = this.table.markerFor(entity.kind);
      if (marker === null) continue; // политика 'skip' (HUD-6)
      drawn.push({ entity, marker });
    }
    drawn.sort((a, b) => {
      const byPriority = a.marker.spec.priority - b.marker.spec.priority;
      return byPriority !== 0 ? byPriority : a.entity.id - b.entity.id;
    });
    for (const { entity, marker } of drawn) {
      marker.render(
        ctx,
        t.offsetX + entity.currX * t.scale,
        pixelY(entity.currY, t),
        entity,
        { color: markerColor(marker.spec.color, entity), size: marker.spec.size, spec: marker.spec },
      );
    }
  }

  /**
   * Клик: обратное аффинное px → мир и presentation-слот `pan` (HUD-2).
   * Камера двигается локально в главном потоке; сообщений воркеру нет —
   * действие объявлено presentation-адресатом в реестре, не виджетом.
   */
  private onClick(event: Event): void {
    const t = this.transform;
    const port = this.port;
    if (t === null || port === null) return; // до первой доставки вести некуда
    const point = event as unknown as { readonly offsetX?: number; readonly offsetY?: number };
    if (typeof point.offsetX !== 'number' || typeof point.offsetY !== 'number') return;
    port.trigger(MINIMAP_PAN_SLOT, {
      x: clamp((point.offsetX - t.offsetX) / t.scale, 0, t.worldWidth),
      // Обратное к отрисовке — тем же переворотом (HUD-6): точка под отметкой и
      // точка, в которую придёт камера, обязаны совпасть.
      y: clamp(worldYOf(point.offsetY, t), 0, t.worldHeight),
    });
  }
}

// ---------------------------------------------------------------- вид виджета

export interface MinimapWidgetOptions {
  /** Источник сетки handshake; в игровой сборке — сам `RemoteHost` (структурно). */
  readonly terrain: MinimapTerrainSource;
  /**
   * Реестр отрисовщиков; по умолчанию — встроенные формы. Сборка со
   * специальными маркерами (иконка героя, пинг) передаёт реестр, где они
   * зарегистрированы рядом со встроенными — тем же `register` (HUD-6).
   */
  readonly renderers?: MinimapRendererRegistry;
  /**
   * Источник слоя тумана (HUD-6) — продюсер маски видимости рендера; не задан
   * или отдаёт null — слоя нет, миникарта выглядит как без тумана.
   */
  readonly fog?: MinimapFogSource;
}

/**
 * Вид виджета `minimap` для реестра видов (HUD-4). Ожидаемая запись композиции:
 *
 *     {
 *       widget: 'minimap',
 *       zone: 'bottom-left',
 *       params: { markers: <MinimapMarkerTable>, width: 192, height: 192 },
 *       bindings: { entities: '<имя minimapEntitiesSelector>', floor: '<имя minimapFloorSelector>' },
 *       actions: { pan: '<имя presentation-действия камеры>' },
 *     }
 */
export function minimapWidgetKind(options: MinimapWidgetOptions): HudWidgetKind {
  const renderers = options.renderers ?? builtinMarkerRenderers();
  return {
    name: MINIMAP_WIDGET_NAME,
    create: (params) => new MinimapWidget(params, options.terrain, renderers, options.fog ?? null),
  };
}
