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
 * у геометрии пола render-ts. Клик обращает то же преобразование:
 * `world = (px − offset) / s`, точка в полях центрирования прижимается к краю
 * арены.
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
}

/**
 * Источник сетки handshake (SHELL-5). `RemoteHost` подходит структурно
 * (`remoteHost.terrain`); до handshake и на сценах без террейна — null,
 * миникарте нечего показывать.
 */
export interface MinimapTerrainSource {
  readonly terrain: MinimapTerrainGrid | null;
}

/** Значение слота `floor`: зеркало пола и дельты одной доставки (HUD-6). */
export interface MinimapFloorValue {
  readonly bits: Uint8Array;
  readonly changed: readonly number[];
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
 * - `floorColor`, `holeColor` — цвет клетки с полом и дыры.
 */
interface MinimapConfig {
  readonly width: number;
  readonly height: number;
  readonly floorColor: string;
  readonly holeColor: string;
}

const DEFAULT_SIZE = 192;
const DEFAULT_FLOOR_COLOR = '#3d4450';
const DEFAULT_HOLE_COLOR = '#14161a';

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

function configFrom(params: HudParams): MinimapConfig {
  return {
    width: numberParam(params, 'width', DEFAULT_SIZE),
    height: numberParam(params, 'height', DEFAULT_SIZE),
    floorColor: stringParam(params, 'floorColor', DEFAULT_FLOOR_COLOR),
    holeColor: stringParam(params, 'holeColor', DEFAULT_HOLE_COLOR),
  };
}

// ------------------------------------------------------------------- виджет

/** Кэш аффинного преобразования мир → px миникарты (см. шапку модуля). */
interface MinimapTransform {
  readonly scale: number;
  readonly offsetX: number;
  readonly offsetY: number;
  /** Мировой размер клетки (float). */
  readonly tile: number;
  readonly gridWidth: number;
  readonly worldWidth: number;
  readonly worldHeight: number;
}

/** Канвас глазами виджета — структурный минимум `HTMLCanvasElement`. */
interface MinimapCanvasLike {
  getContext(contextId: '2d'): MinimapContext2D | null;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

class MinimapWidget implements HudWidget {
  private readonly config: MinimapConfig;
  private readonly table: ResolvedMarkerTable;
  private readonly terrainSource: MinimapTerrainSource;

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
  ) {
    this.config = configFrom(params);
    // Резолв таблицы — при создании, по образцу резолва композиции (HUD-4):
    // ошибка конфигурации падает до монтирования и называет запись.
    this.table = resolveMarkerTable(markerTableFromParams(params.markers), renderers);
    this.terrainSource = terrainSource;
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
    this.transform = {
      scale,
      tile,
      gridWidth: grid.width,
      offsetX: (this.config.width - worldWidth * scale) / 2,
      offsetY: (this.config.height - worldHeight * scale) / 2,
      worldWidth,
      worldHeight,
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
      return;
    }
    for (const cell of floor.changed) this.paintCell(ctx, floor.bits, cell, t);
  }

  private paintCell(ctx: MinimapContext2D, bits: Uint8Array, cell: number, t: MinimapTransform): void {
    const cx = cell % t.gridWidth;
    const cy = Math.floor(cell / t.gridWidth);
    const cellPx = t.tile * t.scale;
    ctx.fillStyle = bits[cell] === 0 ? this.config.holeColor : this.config.floorColor;
    ctx.fillRect(t.offsetX + cx * cellPx, t.offsetY + cy * cellPx, cellPx, cellPx);
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
        t.offsetY + entity.currY * t.scale,
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
      y: clamp((point.offsetY - t.offsetY) / t.scale, 0, t.worldHeight),
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
    create: (params) => new MinimapWidget(params, options.terrain, renderers),
  };
}
