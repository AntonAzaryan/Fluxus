/**
 * Сэмплер ввода: свёртка активных источников в один канонический ввод игрока
 * на границе тика (input-devices INP-2, INP-3, INP-5). Латчинг фронтов и
 * квантование float → Q16.16 живут только здесь — источники о битах, fixed
 * и `InputFrame` не знают.
 */
import { fixed, type Vec2 } from '@game-mvp/core';
import { TURN_UNITS, type ActionSink, type ContinuousSample, type InputSource } from './types.js';

/** Готовый канонический ввод тика — аргументы `RemoteHost.sendInput` (SHELL-6). */
export interface CanonicalInput {
  readonly move: Vec2;
  readonly aimDir: number;
  readonly buttons: number;
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
  /** Номера выборок последних изменений: «последний активный» — максимум. */
  moveChangedAt: number;
  aimChangedAt: number;
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
      moveChangedAt: 0,
      aimChangedAt: 0,
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
    for (const t of this.tracked) {
      const s = t.source.poll();
      t.current = s;
      // Свёртка удержаний нескольких источников — OR (INP-5): клавиатура и
      // геймпад одного игрока дают одно и то же действие.
      const heldActions = t.source.held?.();
      if (heldActions != null) for (const action of heldActions) held |= this.bitOf(action);
      if (s === null) continue;
      if (s.moveX !== t.prevMoveX || s.moveY !== t.prevMoveY) t.moveChangedAt = this.counter;
      if (s.aim !== t.prevAim) t.aimChangedAt = this.counter;
      t.prevMoveX = s.moveX;
      t.prevMoveY = s.moveY;
      t.prevAim = s.aim;
    }

    // Движение: ненулевое с самым свежим изменением; пропавший источник
    // (current === null) не участвует — нейтраль, а не залипание (INP-5).
    let moveX = 0;
    let moveY = 0;
    let moveAt = -1;
    let aim = this.lastAim;
    let aimAt = -1;
    for (const t of this.tracked) {
      if (t.current === null) continue;
      const { moveX: mx, moveY: my, aim: a } = t.current;
      if ((mx !== 0 || my !== 0) && t.moveChangedAt > moveAt) {
        moveAt = t.moveChangedAt;
        moveX = mx;
        moveY = my;
      }
      if (a !== null && t.aimChangedAt > aimAt) {
        aimAt = t.aimChangedAt;
        aim = a;
      }
    }
    this.lastAim = aim;

    // Кламп единичным кругом: диагональ клавиатуры не быстрее стика (INP-3).
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
      aimDir: Math.round(aim) & (TURN_UNITS - 1),
      buttons,
    };
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
