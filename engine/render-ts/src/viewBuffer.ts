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
import { LOCOMOTION_NORMAL, type EntityId, type WorldMode } from '@fluxus/core';
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

/**
 * Сглаживание оценки «тиков за доставку» (REND-25): доля новой пробы в
 * экспоненциальном среднем. Сырое отношение дрожало бы от каждой сбитой
 * доставки — conflation (SHELL-4) и потеря снапшота меняют пробу на один шаг, а
 * темп клипов от этого дёргаться не должен.
 */
const SPAN_SMOOTHING = 0.25;

/**
 * Границы темпа обратного хода: скраб быстрее живого мира в 4 раза крутит клипы
 * вчетверо быстрее, дальше — уже не «догоняя движение», а мельтешение. Нижняя
 * граница симметрична и бережёт от деления на дрожащую оценку.
 */
const MIN_REWIND_PACE = 0.25;
const MAX_REWIND_PACE = 4;

/** Шаг экспоненциального среднего оценки каденса. */
function blend(previous: number, sample: number): number {
  return previous + (sample - previous) * SPAN_SMOOTHING;
}

/**
 * Потолок памяти курсов (см. `facingMemory`). Идентификаторы сущностей
 * поколенческие и не переиспользуются, поэтому за долгий матч словарь рос бы
 * без границы — по записи на каждую когда-либо доставленную сущность.
 * Несколько тысяч курсов — величина, до которой доходит только матч с очень
 * длинным списком погибших, и переполнение здесь не потеря: чистка выбрасывает
 * курсы сущностей, которых в доставленном состоянии уже нет.
 */
export const FACING_MEMORY_LIMIT = 4096;

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
  /**
   * Часы ГЛАВНОГО ПОТОКА: секунды с прошлого кадра, всегда ≥ 0 и от режима мира
   * не зависящие (тот же кламп [0, 0.25]).
   *
   * Отдельная величина, потому что потребители тоже разные. Клипы, снижения и
   * прочее, что доигрывает мир, ведёт `dt` со знаком — стоящий мир обязан стоять
   * (REND-25). Величины самого потока — счётчик кадров HUD (HUD-5,
   * `HudWidget.frame`) — ведут это: они меряют картинку, а не мир, и в паузе
   * замирать им не с чего. Замороженный `dt` остановил бы счётчик, а
   * отрицательный дал бы отрицательный интервал — то есть враньё о частоте
   * кадров ровно тогда, когда на неё смотрят.
   */
  readonly realDt: number;
}

export class ViewBuffer {
  /** Presentation-состояние последнего доставленного тика. */
  readonly view: TickView;

  private readonly records = new Map<EntityId, EntityRecord>();
  private readonly seen = new Set<EntityId>();
  /**
   * Последний ИЗВЕСТНЫЙ курс сущности (REND-2, REND-13) — память, переживающая
   * удаление записи.
   *
   * Курс приезжает только у движущейся сущности: стоящая приносит `NaN` —
   * «курс не менять» (`Extractor`). Сущность, ушедшую в туман, фильтр снапшота
   * вырезает из доставки целиком (`netcode` NET-12), и её запись здесь
   * удаляется; вернувшись СТОЯЩЕЙ, она заводила бы запись заново — с нулевым
   * курсом, то есть лицом на +X, независимо от того, куда смотрела до тумана.
   * Затравка новой записи берётся отсюда, и юнит возвращается из тумана
   * смотрящим туда же, куда уходил.
   *
   * Память живёт РОВНО одну ветвь истории и гасится разрывом непрерывности
   * (`snapAll`, REND-2). Идентификаторы поколенческие и в пределах мира
   * уникальны, но перемотка откатывает и счётчик поколений (NTR-16): за
   * стёртой ветвью тот же упакованный id достаётся ДРУГОЙ сущности, и хранить
   * её курс от прежней значило бы развернуть новорождённого по чужому следу.
   * Живым сущностям гашение ничего не стоит — их курс лежит в записях, а
   * `snapAll` записи не удаляет; теряется ровно память тех, кто в этот момент
   * в тумане, то есть ровно то, чему после разрыва верить нельзя.
   */
  private readonly facingMemory = new Map<EntityId, number>();
  private readonly tickSeconds: number;
  private readonly snapDistanceSq: number;
  private readonly floorBits: Uint8Array | null;
  private readonly clock: () => number;

  private hasTick = false;
  private lastTickAtMs = 0;
  private lastFrameAtMs: number | null = null;
  /**
   * Тиков за доставку в идущем мире и в скрабе — сглаженные оценки (REND-25).
   * Ноль означает «ещё не наблюдали»: пока одной из них нет, темп обратного хода
   * равен прямому, а не выводится из половины данных.
   *
   * Отношение и есть темп: мир скрабится по `step` тиков за цикл рассылки
   * (REW-13), живой идёт по `tickRate / snapshotRate` за ту же доставку, и клип
   * бега, отматываемый по часам главного потока, отставал бы от сущности ровно
   * во столько раз. «Догоняя обратное движение» из сценария REND-25 — это оно.
   */
  private runningSpan = 0;
  private rewindSpan = 0;
  private lastMode: WorldMode = 'Running';

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
    // Тиков между доставками — по МОДУЛЮ: вперёд их пропускает conflation
    // (SHELL-4), назад их проходит шаг скраба (REW-13, REND-2). Порог телепорта
    // задан на ОДИН тик, и мерить им скачок за несколько тиков значило бы
    // объявлять телепортом обычное движение тем вернее, чем крупнее шаг.
    const span = !this.hasTick ? 1 : Math.max(1, Math.abs(ext.tick - view.tick));
    // Первая доставка сессии пробой каденса не является: мерить её не с чем.
    this.observeSpan(ext.mode, tickAdvanced && this.hasTick, span);

    this.applyEntities(ext, tickAdvanced, snapAll, span);
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
    // Темп обратного хода — отношение наблюдаемых каденсов (REND-25): мир,
    // скрабящийся вдвое быстрее живого, и клипы отматывает вдвое быстрее.
    // Кламп по модулю остаётся тем же и после умножения.
    const dt = Math.min(magnitude * this.pace(), 0.25) * clockDirection(this.view.mode);
    const alpha =
      this.tickSeconds <= 0
        ? 1
        : Math.min(Math.max((now - this.lastTickAtMs) / 1000 / this.tickSeconds, 0), 1);
    // ponytail: три числа кадра уезжают новой записью — ОДНОЙ на кадр, а не на
    // инстанс, поэтому давление на GC от неё не растёт ни с числом сущностей,
    // ни с объёмом контента. Переиспользуемая запись сделала бы величины кадра
    // живущими до следующего вызова — цена, которую платить стоит по замеру на
    // реальной сцене, а не по вкусу.
    return { dt, alpha, realDt: magnitude };
  }

  /**
   * Наблюдение каденса доставок по режимам (REND-25). Оценка скраба заводится
   * заново на КАЖДОМ входе в перемотку: шаг ведения точки — конфиг матча, и
   * прошлая перемотка о нынешней ничего не говорит. Оценка живого мира,
   * наоборот, копится всю сессию: это темп рассылки, и он не меняется.
   *
   * Доставка, не сдвинувшая тик (замороженный мир, повтор), пробой не является:
   * «ноль тиков за доставку» — не каденс, а его отсутствие.
   */
  private observeSpan(mode: WorldMode, tickAdvanced: boolean, span: number): void {
    if (mode === 'Rewinding' && this.lastMode !== 'Rewinding') this.rewindSpan = 0;
    this.lastMode = mode;
    if (!tickAdvanced) return;
    if (mode === 'Running') {
      this.runningSpan = this.runningSpan === 0 ? span : blend(this.runningSpan, span);
    } else if (mode === 'Rewinding') {
      this.rewindSpan = this.rewindSpan === 0 ? span : blend(this.rewindSpan, span);
    }
  }

  /**
   * Множитель хода часов презентации. Единица везде, кроме перемотки: скраб
   * идёт своим шагом по тикам (REW-13), и клипы обязаны идти назад в том же
   * темпе, иначе бег «отстаёт» от собственных ног. Пока какой-то из каденсов не
   * наблюдался, множитель — единица: выводить темп из половины данных хуже, чем
   * не выводить вовсе.
   */
  private pace(): number {
    if (this.view.mode !== 'Rewinding') return 1;
    if (this.runningSpan <= 0 || this.rewindSpan <= 0) return 1;
    const ratio = this.rewindSpan / this.runningSpan;
    return Math.min(Math.max(ratio, MIN_REWIND_PACE), MAX_REWIND_PACE);
  }

  private applyEntities(
    ext: ExtractedTick,
    tickAdvanced: boolean,
    snapAll: boolean,
    span: number,
  ): void {
    // Порог телепорта на весь этот шаг: `snapDistance` — скачок ЗА ТИК, и на
    // доставке через `span` тиков сущность вправе пройти во столько же раз
    // больше. Сравнение идёт квадратами, поэтому и множитель квадратичный.
    const teleportSq = this.snapDistanceSq * span * span;
    // Разрыв непрерывности стирает память курсов (см. `facingMemory`): за
    // стёртой ветвью истории упакованный id принадлежит уже другой сущности.
    if (snapAll) this.facingMemory.clear();
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
          // Ноль — только для сущности, курса которой не знали никогда:
          // новорождённой либо не сделавшей ни шага (см. `facingMemory`).
          facingYaw: this.facingMemory.get(id) ?? 0,
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
        const teleport = dx * dx + dy * dy > teleportSq;
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
      if (!Number.isNaN(facing)) {
        record.facingYaw = facing;
        this.rememberFacing(id, facing);
      }
      const aim = ext.aimYaw[i]!;
      record.aimYaw = Number.isNaN(aim) ? null : aim;
    }

    for (const id of this.records.keys()) {
      if (!seen.has(id)) this.records.delete(id);
    }
  }

  /**
   * Курсов в памяти (см. `facingMemory`) — величина стенда, а не картины кадра:
   * ограниченность памяти проверить снаружи иначе нечем, а `records` о ней
   * ничего не говорит.
   */
  get facingMemorySize(): number {
    return this.facingMemory.size;
  }

  /**
   * Запоминает доставленный курс (см. `facingMemory`). Чистка идёт ТОЛЬКО по
   * переполнению и разом — горячий путь доставки при этом не аллоцирует и в
   * обычном тике вообще ничего не делает сверх одной записи в словарь.
   *
   * Выбрасываются курсы сущностей, которых нет в записях буфера НА ЭТОТ МОМЕНТ.
   * Момент — середина обхода доставки, и записи ушедших сущностей ещё живы:
   * удаляют их в конце `applyEntities`. Чистка поэтому пропускает часть мёртвых
   * курсов — до следующего переполнения, — и это ровно та сторона, в которую
   * ошибаться безопасно: лишний курс стоит одной записи в словаре, а выброшенный
   * рано вернул бы юниту из тумана нулевой разворот. Сбрасывать память целиком
   * (`clear`) приходится, только когда живых сущностей больше потолка: расти без
   * границы ей нельзя, а выбрасывать нечего.
   */
  private rememberFacing(id: EntityId, facing: number): void {
    const memory = this.facingMemory;
    memory.set(id, facing);
    if (memory.size <= FACING_MEMORY_LIMIT) return;
    for (const key of memory.keys()) {
      if (!this.records.has(key)) memory.delete(key);
    }
    if (memory.size > FACING_MEMORY_LIMIT) memory.clear();
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
