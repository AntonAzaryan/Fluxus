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
import { LOCOMOTION_NORMAL, type EntityId, type WorldMode } from '@game-mvp/core';
import {
  ENTITY_LEVEL_OVERRIDE,
  ENTITY_MOVING,
  STATE_BITS_SHIFT,
  type ExtractedTick,
} from './extractor.js';
import type { EntityView, TickView } from './types.js';

/** Скачок позиции за тик больше этого — телепорт: интерполяция «проехала бы» пол-арены. */
const DEFAULT_SNAP_DISTANCE = 2;

/**
 * Ход часов презентации по режиму доставленного мира (REND-25): вперёд в
 * `Running`, стоп в `Paused`, назад в `Rewinding`. Своего «времени перемотки»
 * рендер не заводит — направление есть чистая функция режима, а движение назад
 * приносят сами восстановленные состояния.
 */
function clockDirection(mode: WorldMode): number {
  switch (mode) {
    case 'Running':
      return 1;
    case 'Rewinding':
      return -1;
    default:
      return 0;
  }
}

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
  states: number;
  motion: number;
  prevMotion: number;
  prevMotionPhase: number;
  currMotionPhase: number;
  /** Фаза полёта последнего доставленного тика; `NaN` — сущность не летит (REND-12). */
  flightPhase: number;
  /**
   * Статы сущности (HUD-8). Словарь заводится ЛЕНИВО — у сущности без статов
   * его нет вовсе — и переиспользуется между доставками: запись живёт всё время
   * жизни сущности, и пересоздавать словарь на каждый тик значило бы
   * аллоцировать пропорционально числу сущностей.
   */
  stats?: Map<string, number>;
}

const EMPTY_STAT_NAMES: readonly string[] = [];

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
  /**
   * Часы презентации: секунды с прошлого кадра СО ЗНАКОМ хода мира (REND-25) —
   * `+|dt|` в `Running`, ноль в `Paused`, `−|dt|` в `Rewinding`. Модуль
   * клампится в [0, 0.25]. Знак — направление анимационного времени; величины,
   * которые сходятся к цели кадр за кадром (доворот, наклон), направления не
   * имеют и берут модуль.
   */
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
      statNames: EMPTY_STAT_NAMES,
      events: [],
      floorBits: this.floorBits,
      floorChangedCells: [],
    };
  }

  /**
   * Применяет доставленный тик. При conflation (SHELL-4) между прошлым и
   * текущим применением могли пройти невиденные тики: prev/curr скользит по
   * доставленным, телепорт-порог сам переводит большой разрыв в snap.
   *
   * Направления у скольжения нет: восстановленные состояния скраба приезжают с
   * УБЫВАЮЩИМИ номерами тиков, и та же пара prev→curr даёт обратный ход
   * обычной интерполяцией (REND-2). Разрывом перемотка становится только на
   * входе и выходе — их приносит `snapAll` продюсера (смена режима, эпоха,
   * `isReplay`), а не номер тика.
   */
  apply(ext: ExtractedTick): void {
    const view = this.view;
    const tickAdvanced = !this.hasTick || ext.tick !== view.tick;
    const snapAll = ext.snapAll;

    this.applyEntities(ext, tickAdvanced, snapAll);
    const floorChanged = this.applyFloor(ext);

    view.tick = ext.tick;
    view.statNames = ext.statNames;
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
   *
   * Ход часов презентации задаёт режим ПОСЛЕДНЕГО доставленного состояния
   * (REND-25): пока мир стоит или идёт назад, время подсистем вперёд не
   * продвигается. Реальный интервал между кадрами при этом не теряется — он
   * уезжает модулем, и обратный ход идёт с той же скоростью, что прямой.
   */
  frame(now: number = this.clock()): FrameTiming | null {
    if (!this.hasTick) return null;
    const dtMs = this.lastFrameAtMs === null ? 0 : now - this.lastFrameAtMs;
    this.lastFrameAtMs = now;
    // Кламп МОДУЛЯ: после паузы вкладки первый кадр не должен «доигрывать»
    // минуты; знак кламп не трогает — он от режима, а не от часов.
    const magnitude = Math.min(Math.max(dtMs / 1000, 0), 0.25);
    const dt = magnitude * clockDirection(this.view.mode);
    const alpha =
      this.tickSeconds <= 0
        ? 1
        : Math.min(Math.max((now - this.lastTickAtMs) / 1000 / this.tickSeconds, 0), 1);
    return { dt, alpha };
  }

  private applyEntities(ext: ExtractedTick, tickAdvanced: boolean, snapAll: boolean): void {
    const seen = this.seen;
    seen.clear();
    // Курсор разреженной секции статов: пары идут подряд по сущностям в том же
    // порядке, что и сами сущности, — своего индекса им не нужно (HUD-8).
    let statAt = 0;

    for (let i = 0; i < ext.count; i++) {
      const id = ext.id[i]!;
      seen.add(id);
      const x = ext.x[i]!;
      const y = ext.y[i]!;
      const level = ext.level[i]!;
      // Фаза манёвра скользит по тем же двум тикам, что позиция (REND-12):
      // дуга манёвра интерполируется вместе с ней, а не ступеньками по тикам.
      const phase = ext.motionPhase[i]!;
      // Вид манёвра скользит ВМЕСТЕ с фазой: высота дуги задана на вид, и
      // вклад прошлого тика обязан считаться высотой того манёвра, который на
      // нём и шёл (REND-12).
      const motion = ext.motion[i]!;

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
          states: 0,
          motion: LOCOMOTION_NORMAL,
          prevMotion: LOCOMOTION_NORMAL,
          prevMotionPhase: phase,
          currMotionPhase: phase,
          flightPhase: Number.NaN,
        };
        this.records.set(id, record);
      } else if (snapAll) {
        record.prevX = record.currX = x;
        record.prevY = record.currY = y;
        record.prevLevel = record.currLevel = level;
        record.prevMotionPhase = record.currMotionPhase = phase;
        record.prevMotion = motion;
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
        record.prevMotionPhase = teleport ? phase : record.currMotionPhase;
        record.prevMotion = teleport ? motion : record.motion;
        record.currX = x;
        record.currY = y;
        record.currLevel = level;
        record.currMotionPhase = phase;
        record.snap = teleport;
        record.spawned = false;
      }

      record.motion = motion;
      // Фаза полёта — величина последнего доставленного тика, а не пара для
      // интерполяции (REND-12): дуга производна от неё, и conflation (SHELL-4)
      // ей не вредит — пропущенный тик просто не был показан.
      record.flightPhase = ext.flightPhase[i]!;
      statAt = this.applyStats(ext, record, i, statAt);
      record.moving = (ext.flags[i]! & ENTITY_MOVING) !== 0;
      record.levelOverride = (ext.flags[i]! & ENTITY_LEVEL_OVERRIDE) !== 0;
      record.states = ext.flags[i]! >>> STATE_BITS_SHIFT;
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
   * Статы сущности из разреженной секции (HUD-8): словарь записи очищается и
   * наполняется заново — стат, переставший приезжать, ИСЧЕЗАЕТ, а не застывает
   * прошлым значением. Возвращает сдвинутый курсор секции.
   */
  private applyStats(ext: ExtractedTick, record: EntityRecord, index: number, at: number): number {
    const count = ext.statCount[index] ?? 0;
    if (count === 0) {
      record.stats?.clear();
      return at;
    }
    const stats = (record.stats ??= new Map<string, number>());
    stats.clear();
    for (let k = 0; k < count; k++) {
      const name = ext.statNames[ext.statIndex[at + k]!];
      // Имя вне словаря доставки — рассинхрон канала, а не «стат без имени»:
      // молча положить его под номером значило бы отдать виджету число, за
      // которым неизвестно что.
      if (name !== undefined) stats.set(name, ext.statValue[at + k]!);
    }
    return at + count;
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
