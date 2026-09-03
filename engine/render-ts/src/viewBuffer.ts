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
import type { EntityId } from '@fluxus/core';
import { ENTITY_LEVEL_OVERRIDE, ENTITY_MOVING, STATE_BITS_SHIFT } from './channelLayout.js';
import type { ExtractedTick } from './extractor.js';
import type { TickView } from './types.js';
import {
  collapsePair,
  kindOf,
  slideFacing,
  slidePair,
  stagePending,
  type EntityRecord,
} from './entityRecord.js';
import { CadenceTracker, DEFAULT_MAX_RENDER_DELAY } from './deliveryCadence.js';
import { assertTimeScale, frameStep } from './presentationClock.js';
import { peak } from './footprint.js';

/** Скачок позиции за тик больше этого — телепорт: интерполяция «проехала бы» пол-арены. */
const DEFAULT_SNAP_DISTANCE = 2;

/**
 * Допуск сравнения времени показа со штампом доставки, миллисекунды (design
 * D1). См. `displayReached`: он держит тождество «отставание в интервал = путь
 * до буфера джиттера» против ошибки округления, а не против дрожания канала.
 */
const DISPLAY_EPSILON_MS = 1e-3;

const EMPTY_CELLS: readonly number[] = [];

/**
 * Потолок памяти курсов (см. `facingMemory`). Идентификаторы сущностей
 * поколенческие и не переиспользуются, поэтому за долгий матч словарь рос бы
 * без границы — по записи на каждую когда-либо доставленную сущность.
 * Несколько тысяч курсов — величина, до которой доходит только матч с очень
 * длинным списком погибших, и переполнение здесь не потеря: чистка выбрасывает
 * курсы сущностей, которых в доставленном состоянии уже нет.
 */
export const FACING_MEMORY_LIMIT = 4096;

const EMPTY_STAT_NAMES: readonly string[] = [];

export interface ViewBufferConfig {
  /** Длительность тика в секундах — знаменатель альфы интерполяции (REND-2). */
  readonly tickSeconds: number;
  /**
   * Потолок отставания показа в секундах (REND-2, design D2): сверх него
   * задержка отклика дороже плавности. Сверху его всё равно ограничивает
   * глубина буфера — одна отложенная доставка, то есть два интервала.
   */
  readonly maxRenderDelay?: number;
  /** Скачок позиции за тик больше этого (мировых единиц) — телепорт, snap (REND-2). */
  readonly snapDistance?: number;
  /**
   * Начальное зеркало карты пола (копия `grid.floor`); undefined — сцена без
   * террейна. Буфер владеет переданным массивом и мутирует его дельтами.
   */
  readonly floorBits?: Uint8Array;
  /** Часы в миллисекундах; по умолчанию performance.now — параметр ради тестов. */
  readonly clock?: () => number;
  /**
   * Мировой множитель хода часов презентации (REND-25): `0` — заморозка, `1` —
   * обычный ход, `0.25` — замедленный вчетверо показ. Не задан — единица.
   * Величина СМОТРЯЩЕГО: в доставке её нет, и на состав кадра она не влияет.
   */
  readonly timeScale?: number;
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
   * Память живёт РОВНО одну ветвь истории и гасится СМЕНОЙ ВЕТВИ
   * (`branchChanged` доставки, SHELL-7). Идентификаторы поколенческие и в
   * пределах мира уникальны, но перемотка откатывает и счётчик поколений
   * (NTR-16): за стёртой ветвью тот же упакованный id достаётся ДРУГОЙ
   * сущности, и хранить её курс от прежней значило бы развернуть
   * новорождённого по чужому следу. Живым сущностям гашение ничего не стоит —
   * их курс лежит в записях, а разрыв записи не удаляет; теряется ровно память
   * тех, кто в этот момент в тумане, то есть ровно то, чему после смены ветви
   * верить нельзя.
   *
   * Гасит её именно смена ветви, а не всякий `snapAll`: пауза матча (NTR-20) —
   * смена режима, то есть разрыв картинки, но ветвь та же и id принадлежат тем
   * же сущностям. Стирать память на паузе значило бы возвращать простоявших её
   * в тумане юнитов лицом к +X — ровно артефакт, ради которого память заведена.
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
   * Наблюдатель каденса доставок (SHELL-7): тиков за доставку, секунд между
   * ними и дрожание — по режимам мира. Из него выводятся темп обратного хода
   * (REND-25), знаменатель альфы и отставание показа (REND-2).
   */
  private readonly cadenceTracker: CadenceTracker;
  /**
   * Штампы прибытия ОТОБРАЖАЕМОЙ пары (часы главного потока, SHELL-7): время
   * показа `now − delay` лежит между ними, и альфа — доля от `prevStampMs`.
   */
  private prevStampMs = 0;
  private currStampMs = 0;
  /** Мировой множитель хода часов презентации (REND-25); ставится сеттером. */
  private timeScaleValue = 1;
  /**
   * Штамп доставки, чьё время показа ещё не наступило; null — отложенной нет.
   * Слот один (design D2): пришедшая при занятом слоте доставка продвигает
   * отложенную немедленно — так пачка проигрывается сегментами, а не скачком.
   */
  private pendingStampMs: number | null = null;
  /** Тиков между отложенной доставкой и отображаемым `curr` — порог телепорта. */
  private pendingSpan = 1;


  constructor(config: ViewBufferConfig) {
    this.tickSeconds = config.tickSeconds;
    const snapDistance = config.snapDistance ?? DEFAULT_SNAP_DISTANCE;
    this.snapDistanceSq = snapDistance * snapDistance;
    this.floorBits = config.floorBits ?? null;
    this.cadenceTracker = new CadenceTracker(
      config.tickSeconds,
      config.maxRenderDelay ?? DEFAULT_MAX_RENDER_DELAY,
    );
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
      expiredEvents: 0,
      floorBits: this.floorBits,
      floorChangedCells: [],
      cadence: this.cadenceTracker.probe,
      presentationTimeScale: this.timeScaleValue,
    };
    // Сеттером, а не присваиванием: проверка величины у множителя одна, и
    // опция сборки обязана проходить её так же, как рантайм-правка.
    if (config.timeScale !== undefined) this.setTimeScale(config.timeScale);
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
   *
   * `expiredEvents` — величина КАНАЛА, а не извлечения (`client-shell`
   * SHELL-4): сколько событий вытеснила граница аккумулятора с прошлой
   * доставки, знает приёмник конверта, и он же называет её здесь. Умолчание —
   * ноль: у сборки без канала (`RenderHost`) вытеснять события нечем.
   */
  apply(ext: ExtractedTick, expiredEvents = 0): void {
    const view = this.view;
    const now = this.clock();
    const tickAdvanced = !this.hasTick || ext.tick !== view.tick;
    const snapAll = ext.snapAll;
    // Тиков между доставками — по МОДУЛЮ: вперёд их пропускает conflation
    // (SHELL-4), назад их проходит шаг скраба (REW-13, REND-2). Порог телепорта
    // задан на ОДИН тик, и мерить им скачок за несколько тиков значило бы
    // объявлять телепортом обычное движение тем вернее, чем крупнее шаг.
    const span = !this.hasTick ? 1 : Math.max(1, Math.abs(ext.tick - view.tick));
    // Первая доставка сессии пробой каденса не является: мерить её не с чем.
    this.cadenceTracker.observeDelivery(ext.mode, tickAdvanced && this.hasTick, span, now);

    // Слот один: занят — освобождаем. Сперва по времени показа (обычный ход),
    // а если оно ещё не дошло — принудительно: пришедшая пачкой доставка не
    // имеет права вытеснить не показанную (REND-2).
    if (this.pendingStampMs !== null && !this.advanceDisplay(now)) this.promote();
    // Разрыв непрерывности отставанию не подчиняется (REND-2): отложенное несёт
    // стёртую ветвь либо прежний режим, и показывать его больше нечего.
    if (snapAll) this.dropPending();
    // Немедленно ли эта доставка вступает в показ. При отставании в один
    // интервал (ровный канал, локальная оболочка) — всегда, и путь тогда ровно
    // тот же, каким он был до буфера джиттера. Ненаблюдаемый каденс — тоже
    // всегда: буферизовать против неизвестного интервала нечего, а стенд с
    // неподвижными часами обязан вести себя как прежде.
    const immediate =
      snapAll ||
      !this.hasTick ||
      !tickAdvanced ||
      this.cadenceTracker.intervalOf(ext.mode) <= 0 ||
      this.displayReached(now, this.currStampMs);

    this.applyEntities(ext, tickAdvanced, snapAll, span, immediate);
    if (tickAdvanced || !this.hasTick) {
      if (immediate) {
        this.prevStampMs = this.currStampMs;
        this.currStampMs = now;
      } else {
        this.pendingStampMs = now;
        this.pendingSpan = span;
      }
    }
    const floorChanged = this.applyFloor(ext);

    view.tick = ext.tick;
    view.statNames = ext.statNames;
    view.mode = ext.mode;
    view.isReplay = ext.isReplay;
    view.snapAll = snapAll;
    view.freshEvents = ext.freshEvents;
    view.events = ext.events;
    view.expiredEvents = expiredEvents;
    view.floorChangedCells = floorChanged;
    view.presentationTimeScale = this.timeScaleValue;

    if (tickAdvanced || !this.hasTick) this.lastTickAtMs = now;
    // Первая доставка сессии: пары нет — обе её стороны и есть этот момент.
    if (!this.hasTick) this.prevStampMs = this.currStampMs = now;
    this.hasTick = true;
    this.cadenceTracker.publish(ext.mode);

    // Величины состояния приёма доставки (PERF-8): записи сущностей и память
    // курсов — то, что оборот обязан возвращать (PERF-9). Две пробы на
    // доставку, а не на сущность, и без стока — два сравнения.
    peak('viewRecords', this.records.size);
    peak('viewFacingMemory', this.facingMemory.size);
  }

  /** Действующий мировой множитель хода часов презентации (REND-25). */
  get timeScale(): number {
    return this.timeScaleValue;
  }

  /**
   * Мировой множитель хода часов презентации (REND-25): им делаются slow-motion
   * реплея, скорость скраба и заморозка фото-режима. Умножает ТОЛЬКО ход,
   * выдаваемый подсистемам; реальное время кадра (`realDt` — часы HUD и дренаж
   * переходов картинки) и альфа интерполяции (REND-2) ему не подчиняются.
   *
   * Направления множитель не несёт — оно принадлежит режиму мира, — поэтому
   * отрицательное значение это ошибка вызывающего, а не «ход назад». Ноль
   * законен и тождествен замороженному миру.
   */
  setTimeScale(scale: number): void {
    assertTimeScale(scale, 'ViewBuffer');
    this.timeScaleValue = scale;
    this.view.presentationTimeScale = scale;
  }

  /**
   * Забыть момент прошлого кадра: следующий вызов `frame` считает `dt` нулём,
   * а не интервалом простоя.
   *
   * Нужно продюсеру, которого сцена сейчас не ведёт (REND-11): пока
   * presentation-состояние наполняет другой, кадры этого не рисуются вовсе, и
   * первый кадр после возвращения принёс бы подсистемам всё накопленное время
   * — до потолка в 0.25 с. Клипы «доиграли» бы четверть секунды за один кадр
   * ровно в момент, когда игрок вернулся смотреть. Тот же сброс делает
   * документный источник (`DocumentSource.frame`), и по тому же основанию.
   */
  dropFrameClock(): void {
    this.lastFrameAtMs = null;
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
    // Отложенная доставка вступает в показ ЗДЕСЬ, когда время показа дошло до
    // штампа отображаемого `curr` (REND-2, design D1): при отставании в один
    // интервал это уже случилось в `apply`, и кадр не делает ничего.
    this.advanceDisplay(now);
    const dtMs = this.lastFrameAtMs === null ? 0 : now - this.lastFrameAtMs;
    this.lastFrameAtMs = now;
    // Кламп МОДУЛЯ: после паузы вкладки первый кадр не должен «доигрывать»
    // минуты; знак кламп не трогает — он от режима, а не от часов.
    const magnitude = Math.min(Math.max(dtMs / 1000, 0), 0.25);
    // Шаг подсистем — три множителя одного времени (`presentationClock.ts`):
    // темп обратного хода по наблюдаемым каденсам, мировой множитель показа и
    // направление по режиму мира.
    const dt = frameStep(
      magnitude,
      this.cadenceTracker.pace(this.view.mode),
      this.timeScaleValue,
      this.view.mode,
    );
    // Альфа — доля пройденного от штампа `prev` до `curr` по ВРЕМЕНИ ПОКАЗА
    // (design D1). Знаменатель — сглаженный интервал, а не фактический зазор
    // штампов: зазор внёс бы дрожание канала прямо в скорость движения.
    const alpha =
      this.tickSeconds <= 0
        ? 1
        : Math.min(
            Math.max(
              (this.renderTimeMs(now) - this.prevStampMs) /
                1000 /
                this.cadenceTracker.alphaSeconds(this.view.mode),
              0,
            ),
            1,
          );
    // Наблюдаемая величина показа (RDBG-7) обновляется и здесь: сеттер вправе
    // сработать между доставками, а отладочный слой читает состояние покадрово.
    this.view.presentationTimeScale = this.timeScaleValue;
    // ponytail: три числа кадра уезжают новой записью — ОДНОЙ на кадр, а не на
    // инстанс, поэтому давление на GC от неё не растёт ни с числом сущностей,
    // ни с объёмом контента. Переиспользуемая запись сделала бы величины кадра
    // живущими до следующего вызова — цена, которую платить стоит по замеру на
    // реальной сцене, а не по вкусу.
    return { dt, alpha, realDt: magnitude };
  }

  /** Время показа в миллисекундах тех же часов: `now − отставание` (design D1). */
  private renderTimeMs(nowMs: number): number {
    return nowMs - this.cadenceTracker.delay(this.view.mode) * 1000;
  }

  /**
   * Дошло ли время показа до штампа `stampMs` — С ДОПУСКОМ (design D1).
   *
   * Допуск здесь не бережёт «на всякий случай», а держит ТОЖДЕСТВО: на ровном
   * канале отставание равно интервалу, и время показа обязано попадать в штамп
   * ровно. Обе величины при этом идут разными дорогами округления — интервал
   * живёт секундами (проба `(now − prev)/1000`, экспоненциальное среднее),
   * штамп миллисекундами, — и разность в единицы 1e-14 мс переворачивала бы
   * сравнение то так, то этак. Микросекунда заведомо крупнее этой ошибки и
   * заведомо мельче любого наблюдаемого дрожания канала.
   */
  private displayReached(nowMs: number, stampMs: number): boolean {
    return this.renderTimeMs(nowMs) >= stampMs - DISPLAY_EPSILON_MS;
  }

  /**
   * Отложенная доставка вступает в показ, когда время показа дошло до штампа
   * отображаемого `curr` (design D1). Ни от кадра, ни от доставки не зависит:
   * зовут её оба, и оба — с одними часами.
   */
  private advanceDisplay(nowMs: number): boolean {
    if (this.pendingStampMs === null) return false;
    if (!this.displayReached(nowMs, this.currStampMs)) return false;
    this.promote();
    return true;
  }

  /**
   * Пара сдвигается на одну доставку: `prev ← curr`, `curr ← отложенное`.
   * Запись без отложенного СХЛОПЫВАЕТ пару — она не менялась (частичный кадр,
   * SHELL-3) либо её доставка уже показана; иначе альфа, пробегая 0→1 каждый
   * интервал, дёргала бы её назад в начало сегмента. Здесь же гаснут кадровые
   * признаки записи: `snap` и `spawned` принадлежат ОДНОМУ показанному шагу.
   */
  private promote(): void {
    const teleportSq = this.snapDistanceSq * this.pendingSpan * this.pendingSpan;
    for (const record of this.records.values()) {
      if (record.hasPending) {
        record.hasPending = false;
        slidePair(
          record,
          record.pendX,
          record.pendY,
          record.pendLevel,
          record.pendMotionPhase,
          record.pendMotion,
          teleportSq,
        );
        slideFacing(record, record.pendFacingYaw, true);
      } else {
        collapsePair(record);
      }
    }
    this.prevStampMs = this.currStampMs;
    if (this.pendingStampMs !== null) this.currStampMs = this.pendingStampMs;
    this.pendingStampMs = null;
  }

  /** Отложенное сбрасывается разрывом непрерывности: показывать его нечего. */
  private dropPending(): void {
    this.pendingStampMs = null;
    for (const record of this.records.values()) record.hasPending = false;
  }

  private applyEntities(
    ext: ExtractedTick,
    tickAdvanced: boolean,
    snapAll: boolean,
    span: number,
    immediate: boolean,
  ): void {
    // Порог телепорта на весь этот шаг: `snapDistance` — скачок ЗА ТИК, и на
    // доставке через `span` тиков сущность вправе пройти во столько же раз
    // больше. Сравнение идёт квадратами, поэтому и множитель квадратичный.
    const teleportSq = this.snapDistanceSq * span * span;
    // Память курсов стирает СМЕНА ВЕТВИ (см. `facingMemory`): за стёртой ветвью
    // истории упакованный id принадлежит уже другой сущности. Разрыв без смены
    // ветви (пауза матча, NTR-20) её не трогает.
    if (ext.branchChanged) this.facingMemory.clear();
    const seen = this.seen;
    seen.clear();
    // Курсор разреженной секции статов: пары идут подряд по сущностям в том же
    // порядке, что и сами сущности, — своего индекса им не нужно (HUD-8).
    let statAt = 0;

    for (let i = 0; i < ext.count; i++) {
      const id = ext.id[i]!;
      seen.add(id);
      let record = this.records.get(id);
      // Вид записи неизменен на всю её жизнь (`kind` — readonly поле
      // `EntityView`), а за разрывом непрерывности упакованный id вправе
      // принадлежать УЖЕ ДРУГОЙ сущности (NTR-16): унаследованный вид держался
      // бы до её смерти — вплоть до `null`, «не рисуется». Запись поэтому
      // пересоздаётся — то же правило, которое `KeyedInstanceSet` применяет к
      // размещённым объектам документа.
      if (record !== undefined && snapAll && record.kind !== kindOf(ext, i)) {
        this.records.delete(id);
        record = undefined;
      }
      if (record === undefined) {
        record = this.spawnRecord(ext, i, id);
        this.records.set(id, record);
        statAt = this.applyTickFields(record, ext, i, statAt, id);
        slideFacing(record, ext.facingYaw[i]!, tickAdvanced);
        continue;
      }
      if (immediate) {
        this.advanceRecord(record, ext, i, tickAdvanced, snapAll, teleportSq);
        statAt = this.applyTickFields(record, ext, i, statAt, id);
        slideFacing(record, ext.facingYaw[i]!, tickAdvanced);
        continue;
      }
      // Время показа этой доставки ещё не наступило: интерполируемые величины
      // ложатся в отложенный слот, остальные применяются сразу (design D3).
      stagePending(record, ext, i);
      statAt = this.applyTickFields(record, ext, i, statAt, id);
    }

    this.reconcileRecords(ext, tickAdvanced, immediate);
  }

  /**
   * Что делать с записями, строк которых в кадре не было.
   *
   * Полный кадр АВТОРИТЕТЕН (SHELL-3): запись без строки в нём — мёртвая.
   * Частичный несёт только изменившиеся строки, и отсутствие означает «не
   * менялась»; о смерти в нём говорит явный список исчезнувших, а не молчание.
   *
   * Неизменившиеся обязаны СХЛОПНУТЬ пару — иначе альфа, пробегая 0→1 каждый
   * интервал, дёргала бы их назад в начало прежнего сегмента. В отложенном пути
   * это делает продвижение (там проход по записям и так есть), а в немедленном
   * — вот этот проход. Он O(записей) на доставку и аллокаций не делает: SHELL-3
   * запрещает аллокацию, растущую со сценой, а не работу приёмника, и экономия
   * change'а — байты канала, а не такты.
   */
  private reconcileRecords(ext: ExtractedTick, tickAdvanced: boolean, immediate: boolean): void {
    const seen = this.seen;
    if (ext.full) {
      for (const id of this.records.keys()) {
        if (!seen.has(id)) this.records.delete(id);
      }
      return;
    }
    for (let i = 0; i < ext.removedCount; i++) this.records.delete(ext.removed[i]!);
    if (!immediate || !tickAdvanced) return;
    for (const [id, record] of this.records) {
      if (!seen.has(id)) collapsePair(record);
    }
  }

  /**
   * Запись появившейся сущности: обе стороны интерполяции — доставленный тик,
   * `snap` поднят (REND-2). Фаза манёвра берётся в обе стороны по той же
   * причине: показывать нечего, кроме этого тика.
   */
  private spawnRecord(ext: ExtractedTick, i: number, id: EntityId): EntityRecord {
    const x = ext.x[i]!;
    const y = ext.y[i]!;
    const level = ext.level[i]!;
    const phase = ext.motionPhase[i]!;
    const motion = ext.motion[i]!;
    const kindIndex = ext.kind[i]!;
    return {
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
      simLevel: ext.simLevel[i]!,
      // Ноль — только для сущности, курса которой не знали никогда:
      // новорождённой либо не сделавшей ни шага (см. `facingMemory`).
      // Пара интерполяции у появившейся записи схлопнута, как и позиция:
      // показывать нечего, кроме этого тика (REND-2).
      prevFacingYaw: this.facingMemory.get(id) ?? 0,
      facingYaw: this.facingMemory.get(id) ?? 0,
      aimYaw: null,
      states: 0,
      // Пара вида манёвра у появившейся записи схлопнута, как позиция и фаза:
      // прошлого тика у неё нет, и вклад прошлого обязан считаться высотой её
      // собственного манёвра, а не обычного шага (REND-12).
      motion,
      prevMotion: motion,
      prevMotionPhase: phase,
      currMotionPhase: phase,
      flightPhase: Number.NaN,
      // Обычный темп до первого чтения колонки (REND-38): затравка записи —
      // единица, а не ноль, иначе появившаяся сущность на один вызов замерла
      // бы. Настоящую величину тика ставит `applyTickFields` тут же следом.
      timeScale: 1,
      // Появившаяся запись показывается сразу: откладывать нечего — обе стороны
      // её пары и так этот тик (design D3).
      pendX: x,
      pendY: y,
      pendLevel: level,
      pendMotionPhase: phase,
      pendMotion: motion,
      pendFacingYaw: 0,
      hasPending: false,
    };
  }

  /**
   * Существующая запись под доставленный тик: пара тиков интерполяции (REND-2).
   *
   * Фаза манёвра скользит по тем же двум тикам, что позиция (REND-12): дуга
   * манёвра интерполируется вместе с ней, а не ступеньками по тикам. Вид
   * манёвра скользит ВМЕСТЕ с фазой: высота дуги задана на вид, и вклад
   * прошлого тика обязан считаться высотой того манёвра, который на нём и шёл.
   */
  private advanceRecord(
    record: EntityRecord,
    ext: ExtractedTick,
    i: number,
    tickAdvanced: boolean,
    snapAll: boolean,
    teleportSq: number,
  ): void {
    const x = ext.x[i]!;
    const y = ext.y[i]!;
    const level = ext.level[i]!;
    const phase = ext.motionPhase[i]!;
    const motion = ext.motion[i]!;
    if (snapAll) {
      record.prevX = record.currX = x;
      record.prevY = record.currY = y;
      record.prevLevel = record.currLevel = level;
      record.prevMotionPhase = record.currMotionPhase = phase;
      record.prevMotion = record.motion = motion;
      record.snap = true;
      record.spawned = false;
      return;
    }
    if (!tickAdvanced) {
      // Замороженный тик (Paused): мир не изменился, буфер не двигаем.
      record.spawned = false;
      return;
    }
    slidePair(record, x, y, level, phase, motion, teleportSq);
  }

  /**
   * Поля, которые доставленный тик задаёт целиком, — без пары для
   * интерполяции: они одинаковы у появившейся записи и у продолжающейся.
   * Возвращает сдвинутый курсор разреженной секции статов (HUD-8).
   */
  private applyTickFields(
    record: EntityRecord,
    ext: ExtractedTick,
    i: number,
    statAt: number,
    id: EntityId,
  ): number {
    // Вид манёвра сюда НЕ входит: он член пары интерполяции и двигается вместе
    // с фазой — в `slidePair`, по показанному шагу (REND-12, design D3).
    // Фаза полёта — величина последнего доставленного тика, а не пара для
    // интерполяции (REND-12): дуга производна от неё, и conflation (SHELL-4)
    // ей не вредит — пропущенный тик просто не был показан.
    record.flightPhase = ext.flightPhase[i]!;
    // Персональная шкала — тоже величина последнего доставленного тика
    // (REND-38): интерполировать её незачем — плавность спада даёт tween ауры
    // в самой симуляции, и conflation (SHELL-4) ей не вредит.
    record.timeScale = ext.timeScale[i]!;
    const next = this.applyStats(ext, record, i, statAt);
    // Уровень глазами симуляции — величина последнего доставленного тика:
    // маска тумана строится по доставке, а не интерполяцией (FOW-9).
    record.simLevel = ext.simLevel[i]!;
    const flags = ext.flags[i]!;
    record.moving = (flags & ENTITY_MOVING) !== 0;
    record.levelOverride = (flags & ENTITY_LEVEL_OVERRIDE) !== 0;
    record.states = flags >>> STATE_BITS_SHIFT;
    // Память курса пополняется ДОСТАВКОЙ, а не показом (см. `facingMemory`):
    // это «последний известный курс», и отставание показа его не касается.
    const facing = ext.facingYaw[i]!;
    if (!Number.isNaN(facing)) this.rememberFacing(id, facing);
    const aim = ext.aimYaw[i]!;
    record.aimYaw = Number.isNaN(aim) ? null : aim;
    return next;
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

/**
 * Кадр ПРОДЮСЕРА ПОТОКА ТИКОВ — общее тело `RenderHost.frame` и
 * `RemoteHost.frame` (REND-2, REND-8, REND-11). Хосты различаются тем, откуда
 * приезжает тик (прямой вызов против канала оболочки, SHELL-2), а кадр у них
 * один и тот же, и написанный дважды он разъезжался: часы кадра сбрасывал
 * только документный источник.
 *
 * `buffer` — null до первой доставки (у сетевого хоста буфер заводит
 * handshake). Пока сцену ведёт другой продюсер, кадр не рисуется и часы
 * сбрасываются: см. `ViewBuffer.dropFrameClock`.
 */
export function tickStreamFrame(
  stage: {
    isActive(producer: object): boolean;
    frame(dt: number, alpha: number, realDt: number): void;
  },
  producer: object,
  buffer: ViewBuffer | null,
  now: number | undefined,
): void {
  if (buffer === null) return;
  if (!stage.isActive(producer)) {
    buffer.dropFrameClock();
    return;
  }
  const timing = now === undefined ? buffer.frame() : buffer.frame(now);
  if (timing === null) return;
  stage.frame(timing.dt, timing.alpha, timing.realDt);
}
