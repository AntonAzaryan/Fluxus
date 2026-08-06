/**
 * ViewBuffer — main-половина бывшего `RenderHost` (SHELL-2).
 *
 * Принимает плоскую форму `ExtractedTick` (прямым вызовом в однопоточной
 * сборке либо доставленную каналом оболочки) и ведёт presentation-состояние
 * `TickView` для подсистем: скольжение prev/curr двух последних доставленных
 * тиков, snap при спавне/телепорте/разрыве непрерывности (REND-2), зеркало
 * карты пола, альфа интерполяции по часам этого потока (SHELL-7).
 *
 * Мира здесь нет и быть не может: всё, что нужно кадру, обязано приехать
 * в плоской форме (SHELL-1, SHELL-2).
 */
import type { EntityId } from '@game-mvp/core';
import { ENTITY_LEVEL_OVERRIDE, ENTITY_MOVING, type ExtractedTick } from './extractor.js';
import type { EntityView, TickView } from './types.js';

/** Скачок позиции за тик больше этого — телепорт: интерполяция «проехала бы» пол-арены. */
const DEFAULT_SNAP_DISTANCE = 2;

const EMPTY_CELLS: readonly number[] = [];

/** Внутренняя запись сущности: EntityView плюс интерполяционный буфер. */
interface EntityRecord extends EntityView {
  prevX: number;
  prevY: number;
  currX: number;
  currY: number;
  prevLevel: number;
  currLevel: number;
  snap: boolean;
  spawned: boolean;
  moving: boolean;
  levelOverride: boolean;
  facingYaw: number;
  aimYaw: number | null;
}

export interface ViewBufferConfig {
  /** Длительность тика в секундах — знаменатель альфы интерполяции (REND-2). */
  readonly tickSeconds: number;
  /** Скачок позиции за тик больше этого (мировых единиц) — телепорт, snap (REND-2). */
  readonly snapDistance?: number;
  /**
   * Начальное зеркало карты пола (копия `grid.floor`); undefined — сцена без
   * террейна. Буфер владеет переданным массивом и мутирует его дельтами.
   */
  readonly floorBits?: Uint8Array;
  /** Часы в миллисекундах; по умолчанию performance.now — параметр ради тестов. */
  readonly clock?: () => number;
}

/** Кадровые величины для `updateFrame` подсистем (REND-2). */
export interface FrameTiming {
  /** Секунды с прошлого кадра, кламп [0, 0.25]. */
  readonly dt: number;
  /** Доля тика [0..1] между двумя последними доставленными тиками. */
  readonly alpha: number;
}

export class ViewBuffer {
  /** Presentation-состояние последнего доставленного тика. */
  readonly view: TickView;

  private readonly records = new Map<EntityId, EntityRecord>();
  private readonly seen = new Set<EntityId>();
  private readonly tickSeconds: number;
  private readonly snapDistanceSq: number;
  private readonly floorBits: Uint8Array | null;
  private readonly clock: () => number;

  private hasTick = false;
  private lastTickAtMs = 0;
  private lastFrameAtMs: number | null = null;

  constructor(config: ViewBufferConfig) {
    this.tickSeconds = config.tickSeconds;
    const snapDistance = config.snapDistance ?? DEFAULT_SNAP_DISTANCE;
    this.snapDistanceSq = snapDistance * snapDistance;
    this.floorBits = config.floorBits ?? null;
    this.clock = config.clock ?? (() => performance.now());
    this.view = {
      tick: 0,
      mode: 'Running',
      isReplay: false,
      snapAll: false,
      freshEvents: false,
      entities: this.records,
      events: [],
      floorBits: this.floorBits,
      floorChangedCells: [],
    };
  }

  /**
   * Применяет доставленный тик. При conflation (SHELL-4) между прошлым и
   * текущим применением могли пройти невиденные тики: prev/curr скользит по
   * доставленным, телепорт-порог сам переводит большой разрыв в snap.
   */
  apply(ext: ExtractedTick): void {
    const view = this.view;
    const tickAdvanced = !this.hasTick || ext.tick !== view.tick;
    const snapAll = ext.snapAll;

    this.applyEntities(ext, tickAdvanced, snapAll);
    const floorChanged = this.applyFloor(ext);

    view.tick = ext.tick;
    view.mode = ext.mode;
    view.isReplay = ext.isReplay;
    view.snapAll = snapAll;
    view.freshEvents = ext.freshEvents;
    view.events = ext.events;
    view.floorChangedCells = floorChanged;

    if (tickAdvanced || !this.hasTick) this.lastTickAtMs = this.clock();
    this.hasTick = true;
  }

  /**
   * Кадр: считает dt и альфу интерполяции между двумя последними тиками
   * (REND-2). Альфа — по часам ЭТОГО потока от момента `apply` (SHELL-7);
   * null — ни одного тика ещё не доставлено. `now` — миллисекунды тех же
   * часов, что `config.clock`.
   */
  frame(now: number = this.clock()): FrameTiming | null {
    if (!this.hasTick) return null;
    const dtMs = this.lastFrameAtMs === null ? 0 : now - this.lastFrameAtMs;
    this.lastFrameAtMs = now;
    // Кламп dt: после паузы вкладки первый кадр не должен «доигрывать» минуты.
    const dt = Math.min(Math.max(dtMs / 1000, 0), 0.25);
    const alpha =
      this.tickSeconds <= 0
        ? 1
        : Math.min(Math.max((now - this.lastTickAtMs) / 1000 / this.tickSeconds, 0), 1);
    return { dt, alpha };
  }

  private applyEntities(ext: ExtractedTick, tickAdvanced: boolean, snapAll: boolean): void {
    const seen = this.seen;
    seen.clear();

    for (let i = 0; i < ext.count; i++) {
      const id = ext.id[i]!;
      seen.add(id);
      const x = ext.x[i]!;
      const y = ext.y[i]!;
      const level = ext.level[i]!;

      let record = this.records.get(id);
      if (record === undefined) {
        const kindIndex = ext.kind[i]!;
        record = {
          id,
          kind: kindIndex < 0 ? null : (ext.kindTable[kindIndex] ?? null),
          prevX: x,
          prevY: y,
          currX: x,
          currY: y,
          prevLevel: level,
          currLevel: level,
          snap: true,
          spawned: true,
          moving: false,
          levelOverride: false,
          facingYaw: 0,
          aimYaw: null,
        };
        this.records.set(id, record);
      } else if (snapAll) {
        record.prevX = record.currX = x;
        record.prevY = record.currY = y;
        record.prevLevel = record.currLevel = level;
        record.snap = true;
        record.spawned = false;
      } else if (!tickAdvanced) {
        // Замороженный тик (Paused): мир не изменился, буфер не двигаем.
        record.spawned = false;
      } else {
        const dx = x - record.currX;
        const dy = y - record.currY;
        const teleport = dx * dx + dy * dy > this.snapDistanceSq;
        record.prevX = teleport ? x : record.currX;
        record.prevY = teleport ? y : record.currY;
        record.prevLevel = teleport ? level : record.currLevel;
        record.currX = x;
        record.currY = y;
        record.currLevel = level;
        record.snap = teleport;
        record.spawned = false;
      }

      record.moving = (ext.flags[i]! & ENTITY_MOVING) !== 0;
      record.levelOverride = (ext.flags[i]! & ENTITY_LEVEL_OVERRIDE) !== 0;
      const facing = ext.facingYaw[i]!;
      if (!Number.isNaN(facing)) record.facingYaw = facing;
      const aim = ext.aimYaw[i]!;
      record.aimYaw = Number.isNaN(aim) ? null : aim;
    }

    for (const id of this.records.keys()) {
      if (!seen.has(id)) this.records.delete(id);
    }
  }

  /**
   * Дельта пола — пары (клетка, значение): значения переживают conflation,
   * а фильтр «реально изменилось» не даёт пересобирать геометрию впустую.
   */
  private applyFloor(ext: ExtractedTick): readonly number[] {
    const bits = this.floorBits;
    const delta = ext.floorDelta;
    if (bits === null || delta.length === 0) return EMPTY_CELLS;
    let changed: number[] | null = null;
    for (let i = 0; i + 1 < delta.length; i += 2) {
      const cell = delta[i]!;
      const bit = delta[i + 1]!;
      if (bits[cell] !== bit) {
        bits[cell] = bit;
        (changed ??= []).push(cell);
      }
    }
    return changed ?? EMPTY_CELLS;
  }
}
