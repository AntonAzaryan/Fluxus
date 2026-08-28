/**
 * Сэмплер ввода: свёртка активных источников в один канонический ввод игрока
 * на границе тика (input-devices INP-2, INP-3, INP-5). Латчинг фронтов и
 * квантование float → Q16.16 живут только здесь — источники о битах, fixed
 * и `InputFrame` не знают.
 */
import { FIXED_ONE, fixed, type Vec2 } from '@fluxus/core';
import { TURN_UNITS, type ActionSink, type ContinuousSample, type InputSource } from './types.js';

/** Готовый канонический ввод тика — аргументы `RemoteHost.sendInput` (SHELL-6). */
export interface CanonicalInput {
  readonly move: Vec2;
  readonly aimDir: number;
  /**
   * Точка прицела в Q16.16 (`tick-loop` TICK-2); `null` — ни один источник
   * точкой не владел. Именно `null`, а не начало координат: «прицела нет» и
   * «целюсь в центр арены» — разные высказывания, и кадр без точки не обязан
   * возить её вовсе.
   */
  readonly target: Vec2 | null;
  readonly buttons: number;
}

/**
 * Область мировых координат, представимая в Q16.16 (INP-3). Границы взяты у
 * ядра, а не выписаны числами: это i32-контейнер `Fixed` (FP-1), и второго
 * определения этой области в репозитории быть не должно.
 */
const WORLD_MIN = fixed.INT32_MIN / FIXED_ONE;
const WORLD_MAX = fixed.INT32_MAX / FIXED_ONE;

/**
 * Единственная точка приведения мировой координаты к Q16.16 (INP-3).
 * Ограничивается ровно представимость — геймплейными границами (дальностью
 * способности, границей арены, видимостью цели) слой ввода точку ограничивать
 * не вправе: обрезанная здесь, дальность способности стала бы свойством
 * клиента, то есть досталась бы тому, кто клиентом управляет (ABIL-5).
 *
 * Экспортируется затем, чтобы точка бота проходила ЭТО ЖЕ приведение, а не
 * его копию (`bot-player` BOT-5): ввод бота не выражает того, чего не выражает
 * ввод человека, и держится это общим кодом, а не совпадением двух формул.
 */
export function toWorldFixed(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return fixed.fromFloat(value < WORLD_MIN ? WORLD_MIN : value > WORLD_MAX ? WORLD_MAX : value);
}

export interface SamplerOptions {
  /**
   * Имя действия → индекс бита `buttons` (0..15, `tick-loop` TICK-2).
   * Данные уровня контента, как `locomotion.dodgeButton` (INP-4, design D3).
   */
  readonly actionBits: Readonly<Record<string, number>>;
}

interface TrackedSource {
  readonly source: InputSource;
  /** Последний опрос — для детекции «изменился» (правило свёртки D4). */
  prevMoveX: number;
  prevMoveY: number;
  prevAim: number | null;
  prevTargetX: number;
  prevTargetY: number;
  prevHadTarget: boolean;
  /** Номера выборок последних изменений: «последний активный» — максимум. */
  moveChangedAt: number;
  aimChangedAt: number;
  targetChangedAt: number;
  /** Текущий опрос этой выборки; null — источник неактивен. */
  current: ContinuousSample | null;
}

export class InputSampler {
  private readonly actionBits: Readonly<Record<string, number>>;
  private readonly tracked: TrackedSource[] = [];
  /** Латч фронтов до ближайшей выборки (INP-2). */
  private latched = 0;
  /** Счётчик выборок — часы правила «последний активный» (INP-5). */
  private counter = 0;
  /** Прицел переживает молчание источников: направление — не «нажатие». */
  private lastAim = 0;
  /**
   * Точка прицела переживает молчание источников по тому же правилу (INP-5) и
   * по тому же, по которому её не гасит пропущенный кадр в ядре (TICK-2): это
   * последнее известное состояние ввода. `hasTarget === false` — точки не давал
   * никто и никогда, и кадру возить нечего.
   */
  private lastTargetX = 0;
  private lastTargetY = 0;
  private hasTarget = false;
  /**
   * Свежесть ПЕРЕЖИВШЕГО значения — номер выборки, на которой оно принято.
   *
   * Без неё правило «последний менявший» (INP-5) работало бы только внутри
   * одной выборки: пережившее значение входило бы в свёртку с нулевой
   * свежестью, и его перебивал бы ЛЮБОЙ источник, отдающий непустую величину, —
   * даже тот, чьё значение не менялось с прошлой эры. Ровно так и ломался
   * прицел мыши: `KeyboardMouseSource` владеет прицелом момента клика (INP-1) и
   * отдаёт его дальше неизменным, а непрерывный источник указателя на кадре
   * отпускания замолкает, — и вместо живого прицела кадра в тик уезжала точка
   * НАЖАТИЯ, то есть снаряд улетал туда, где кнопку зажали, а не туда, куда
   * игрок целился, отпуская её (`ability-system` ABIL-5: шаг цепочки пишется
   * прицеливанием тика подтверждения).
   */
  private lastAimAt = 0;
  private lastTargetAt = 0;
  /**
   * Движение выборки: поля, а не локальные переменные, потому что свёртка
   * вынесена отдельным методом. Выборку они НЕ переживают — свёртка обнуляет их
   * первым делом: пропавший источник даёт нейтраль, а не залипание (INP-5).
   */
  private moveX = 0;
  private moveY = 0;

  constructor(options: SamplerOptions) {
    for (const [action, bit] of Object.entries(options.actionBits)) {
      if (!Number.isInteger(bit) || bit < 0 || bit > 15) {
        throw new Error(`InputSampler: бит действия "${action}" вне 0..15 (TICK-2): ${bit}`);
      }
    }
    this.actionBits = options.actionBits;
  }

  /** Бит действия; неизвестное действие — ошибка конфигурации, не тишина. */
  private bitOf(action: string): number {
    const bit = this.actionBits[action];
    if (bit === undefined) {
      throw new Error(`InputSampler: действие "${action}" не объявлено в actionBits`);
    }
    return 1 << bit;
  }

  /** Латч фронта до ближайшей выборки (INP-2). */
  private readonly press: ActionSink = (action) => {
    this.latched |= this.bitOf(action);
  };

  add(source: InputSource): void {
    if (this.tracked.some((t) => t.source === source)) {
      throw new Error(`InputSampler: источник "${source.id}" уже добавлен`);
    }
    this.tracked.push({
      source,
      prevMoveX: 0,
      prevMoveY: 0,
      prevAim: null,
      prevTargetX: 0,
      prevTargetY: 0,
      prevHadTarget: false,
      moveChangedAt: 0,
      aimChangedAt: 0,
      targetChangedAt: 0,
      current: null,
    });
    source.start(this.press);
  }

  remove(source: InputSource): void {
    const index = this.tracked.findIndex((t) => t.source === source);
    if (index === -1) throw new Error(`InputSampler: источник "${source.id}" не добавлен`);
    this.tracked.splice(index, 1);
    source.stop();
  }

  /**
   * Выборка на границе тика: опрос источников (опросные пушат фронты внутри
   * `poll`), свёртка — действия OR удержаний и латча фронтов, непрерывные от
   * последнего активного источника, — затем кламп и квантование (INP-3).
   */
  sample(): CanonicalInput {
    this.counter += 1;
    // Удержания собираются заново каждую выборку: залипание невозможно по
    // построению — бит живёт ровно пока источник о нём сообщает (INP-2).
    let held = 0;
    for (const t of this.tracked) held |= this.pollSource(t);
    this.foldContinuous();

    // Кламп единичным кругом: диагональ клавиатуры не быстрее стика (INP-3).
    let moveX = this.moveX;
    let moveY = this.moveY;
    const length = Math.hypot(moveX, moveY);
    if (length > 1) {
      moveX /= length;
      moveY /= length;
    }

    // Обнуляется только латч: удержание пересобирается опросом источников, и
    // короткий тап между тиками остаётся ровно одним тиком с битом (INP-2).
    const buttons = held | this.latched;
    this.latched = 0;
    return {
      move: { x: fixed.fromFloat(moveX), y: fixed.fromFloat(moveY) },
      aimDir: Math.round(this.lastAim) & (TURN_UNITS - 1),
      target: this.hasTarget
        ? { x: toWorldFixed(this.lastTargetX), y: toWorldFixed(this.lastTargetY) }
        : null,
      buttons,
    };
  }

  /**
   * Опрос одного источника: выборка запоминается, и отмечается, что в ней
   * изменилось (правило свёртки D4). Возвращает удержания источника — их
   * свёртка нескольких источников есть OR (INP-5): клавиатура и геймпад одного
   * игрока дают одно и то же действие.
   *
   * Метод, а не стрелка внутри цикла: замыкания на источник за выборку здесь
   * заводиться не должно.
   */
  private pollSource(t: TrackedSource): number {
    const s = t.source.poll();
    t.current = s;
    let held = 0;
    const heldActions = t.source.held?.();
    if (heldActions != null) for (const action of heldActions) held |= this.bitOf(action);
    if (s === null) return held;
    if (s.moveX !== t.prevMoveX || s.moveY !== t.prevMoveY) t.moveChangedAt = this.counter;
    if (s.aim !== t.prevAim) t.aimChangedAt = this.counter;
    // Точка сравнивается по значению, а не по ссылке: запись источника
    // переиспользуется, и одна и та же ссылка означает разные точки.
    const hasTarget = s.target !== null;
    if (
      hasTarget !== t.prevHadTarget ||
      (s.target !== null && (s.target.x !== t.prevTargetX || s.target.y !== t.prevTargetY))
    ) {
      t.targetChangedAt = this.counter;
    }
    t.prevMoveX = s.moveX;
    t.prevMoveY = s.moveY;
    t.prevAim = s.aim;
    t.prevHadTarget = hasTarget;
    if (s.target !== null) {
      t.prevTargetX = s.target.x;
      t.prevTargetY = s.target.y;
    }
    return held;
  }

  /**
   * Свёртка непрерывных величин по правилу «последний менявший» (INP-5).
   *
   * Движение: ненулевое с самым свежим изменением; пропавший источник
   * (`current === null`) не участвует — нейтраль, а не залипание. Направление и
   * точка ПЕРЕЖИВАЮТ молчание источников, поэтому соревнуются со своей
   * свежестью (`lastAimAt`, `lastTargetAt`), а не с нулевой: источник перебивает
   * пережившее значение, только если менял своё ПОЗЖЕ, а не самим фактом, что
   * ему есть что сказать.
   */
  private foldContinuous(): void {
    this.moveX = 0;
    this.moveY = 0;
    let moveAt = -1;
    for (const t of this.tracked) {
      if (t.current === null) continue;
      const { moveX: mx, moveY: my, aim: a, target: p } = t.current;
      if ((mx !== 0 || my !== 0) && t.moveChangedAt > moveAt) {
        moveAt = t.moveChangedAt;
        this.moveX = mx;
        this.moveY = my;
      }
      if (a !== null && t.aimChangedAt > this.lastAimAt) {
        this.lastAimAt = t.aimChangedAt;
        this.lastAim = a;
      }
      // Точка выбирается тем же правилом, что и направление, и по тому же
      // основанию: игрок целится тем устройством, которым он только что шевелил.
      if (p !== null && t.targetChangedAt > this.lastTargetAt) {
        this.lastTargetAt = t.targetChangedAt;
        // Значениями, а не ссылкой: запись принадлежит источнику и будет
        // переписана следующим опросом, а держим мы её до следующей выборки.
        this.lastTargetX = p.x;
        this.lastTargetY = p.y;
        this.hasTarget = true;
      }
    }
  }
}

/**
 * Фронты для опросных устройств (INP-2): rising edge по множествам удержанных
 * действий prev/current. Общий хелпер слоя — источники не изобретают латчинг.
 */
export class HeldActions {
  private prev: ReadonlySet<string> = new Set();

  update(current: ReadonlySet<string>, press: ActionSink): void {
    for (const action of current) if (!this.prev.has(action)) press(action);
    this.prev = new Set(current);
  }

  /** Сброс при пропаже устройства: переподключение не дожимает старые кнопки. */
  reset(): void {
    this.prev = new Set();
  }
}
