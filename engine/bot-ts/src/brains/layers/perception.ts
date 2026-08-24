/**
 * Восприятие мозга (BOT-3): модель мира из `ClientStep`, память «последнее
 * виденное» под FoW, экстраполяция проджектайлов и буфер задержки реакции.
 *
 * Слой общий, а не принадлежащий одной реализации: наблюдение — вход контракта
 * BOT-2, и данные считываются из шага одинаково любым мозгом. Политика выбора
 * действий этого слоя не касается вовсе — она приезжает документом (BOT-8).
 *
 * Задержка реакции — не косметика, а обязательная часть первого мозга (design,
 * Risks): точные координаты приезжают боту авторитетным снапшотом, и без
 * задержки его игра сверхчеловечна. Реализована она буфером наблюдений:
 * наблюдение, снятое на тике T, становится доступным решению не раньше
 * `T + delayTicks (+ джиттер)` — числа из профиля (BOT-6).
 *
 * Память под туманом войны держит границу BOT-3 честной: враг, ушедший из
 * персонального снапшота, остаётся у мозга ПОСЛЕДНИМ ВИДЕННЫМ положением с
 * номером тика наблюдения — знать актуальное мозг не может, как не может и
 * клиент человека. Экстраполируются только снаряды: их полёт уже наблюдался, и
 * это то же предсказание, которое делает глазами игрок.
 *
 * Вся память здесь адресована ОДНОЙ ветви истории, и перемотка эту ветвь
 * стирает (`rewind` REW-1, NTR-16). Поэтому у восприятия есть второй вход,
 * кроме наблюдений: разрыв непрерывности доставки (SHELL-7) и вход в перемотку
 * либо выход из неё (WSM-1) — сигнал «то, что помнил, больше не про этот мир».
 * По нему память сбрасывается целиком; без сброса очередь наблюдений и правило
 * «картинка назад не ходит» удерживали бы мозг на СТЁРТОМ будущем на всю
 * глубину отката. Пауза и возобновление ветвь НЕ трогают и памяти не стоят.
 */
import type { EntityId, WorldMode } from '@fluxus/core';
import type { ClientStep } from '@fluxus/net';
import type { BotSelf } from '../../brain.js';
import type { BotProfile } from '../../profile.js';
import {
  readWorldView,
  type BotEntityView,
  type BotSlotView,
  type BotWorldView,
  type WorldViewNames,
} from '../../worldView.js';
import type { BrainRandom } from './random.js';

/** Враг, каким мозг его помнит: с меткой наблюдения и признаком «виден сейчас». */
export interface RememberedEnemy extends BotEntityView {
  readonly seenTick: number;
  readonly visible: boolean;
}

/** Снаряд с положением, экстраполированным на текущий тик. */
export interface ThreatView {
  readonly id: EntityId;
  readonly x: number;
  readonly y: number;
  readonly vx: number;
  readonly vy: number;
  readonly distance: number;
  /** Сближается ли снаряд с ботом: уклоняться от улетающего незачем. */
  readonly closing: boolean;
}

export interface PerceivedWorld {
  /** Тик, на который мозг спрашивает мир, — тик съёма ввода. */
  readonly tick: number;
  /**
   * Тик наблюдения, из которого мир собран. Отстаёт от `tick` на задержку
   * реакции и на буфер интерполяции: бот знает, насколько его картинка стара.
   */
  readonly observedTick: number;
  readonly self: BotEntityView;
  /**
   * Слоты способностей бота из его собственного снапшота (ABIL-1). Отстают на
   * ту же задержку реакции, что остальная картинка, и это верно: мозг узнаёт о
   * состоянии своего каста тем же каналом, каким игрок видит его на экране.
   */
  readonly slots: readonly BotSlotView[];
  readonly enemies: readonly RememberedEnemy[];
  readonly threats: readonly ThreatView[];
  readonly arenaRadius: number | undefined;
  /**
   * Держит ли бот пойманный снаряд (`worldView.ts`). Отстаёт на ту же задержку
   * реакции, что остальная картинка, и это верно: о том, что захват удался,
   * мозг узнаёт тем же каналом, каким игрок видит шар в своих руках.
   */
  readonly carrying: boolean;
}

interface Observation {
  /** Тик, раньше которого наблюдение решению не отдаётся (задержка реакции). */
  readonly readyAtTick: number;
  readonly view: BotWorldView;
}

/** Скорость ниже этой считается покоем: реквизит сцены — не снаряд. */
const MOVING_EPSILON = 1e-4;

export class Perception {
  private readonly profile: BotProfile;
  private readonly self: BotSelf;
  private readonly names: WorldViewNames;
  private readonly random: BrainRandom;
  private readonly pending: Observation[] = [];
  private readonly memory = new Map<EntityId, RememberedEnemy>();
  private awareOf: BotWorldView | undefined;
  /** Режим ПОСЛЕДНЕГО доставленного состояния (WSM-1), а не осознанного. */
  private deliveredMode: WorldMode = 'Running';
  /** Непрочитанный разрыв непрерывности; гасится чтением, как у `MatchSample`. */
  private broken = false;

  constructor(profile: BotProfile, self: BotSelf, random: BrainRandom, names: WorldViewNames = {}) {
    this.profile = profile;
    this.self = self;
    this.random = random;
    this.names = names;
  }

  /**
   * Режим мира по последнему ДОСТАВЛЕННОМУ состоянию (WSM-1) — без задержки
   * реакции намеренно: это свойство канала, а не наблюдение за противником.
   * Замерший мир человек видит замершим сразу, и «не успел заметить перемотку»
   * человечностью не является.
   */
  get mode(): WorldMode {
    return this.deliveredMode;
  }

  /**
   * Был ли разрыв непрерывности с прошлого чтения (SHELL-7). Читается один раз
   * и гасится — ровно как признак в `MatchSample`: второй потребитель этого
   * знания в мозге завёл бы вторую, расходящуюся картину мира.
   */
  takeDiscontinuity(): boolean {
    const broken = this.broken;
    this.broken = false;
    return broken;
  }

  /** Наблюдение (BOT-3): всё, что мозг узнаёт о мире, приходит только отсюда. */
  observe(step: ClientStep): void {
    const view = readWorldView(step, this.self.slot, this.names);
    if (view === undefined) return;
    // Разрыв ветви истории читается двумя независимыми признаками одного и того
    // же события. Флаг доставки (SHELL-7) — основной; смена режима — страховка
    // на случай, когда вход в перемотку и выход из неё приходят соседними
    // состояниями, а разрыв погашен как скраб внутри одной перемотки (NTR-10).
    //
    // Страховка узкая: только переходы, одна сторона которых — `Rewinding`.
    // Ветвь истории стирает ПЕРЕМОТКА, а не всякая смена режима: пауза и
    // возобновление (WSM-1) оставляют мир там же, где он был, и сброс памяти на
    // них означал бы, что игрок, поставивший паузу, дарит боту амнезию —
    // противник, стоящий на виду, забывается и переоценивается заново.
    if (view.discontinuity || this.rewindEdge(view.mode)) {
      this.broken = true;
      this.forgetBranch();
    }
    this.deliveredMode = view.mode;
    const { delayTicks, jitterTicks } = this.profile.reaction;
    const jitter = jitterTicks === 0 ? 0 : this.random.below(jitterTicks + 1);
    this.pending.push({ readyAtTick: view.tick + delayTicks + jitter, view });
  }

  /** Кромка перемотки: смена режима, одна сторона которой — `Rewinding` (WSM-1). */
  private rewindEdge(mode: WorldMode): boolean {
    if (mode === this.deliveredMode) return false;
    return mode === 'Rewinding' || this.deliveredMode === 'Rewinding';
  }

  /**
   * Стёртая ветвь истории: очередь наблюдений, осознанная картинка и память о
   * врагах — всё это адресовано моменту, которого больше нет.
   *
   * Сбрасывается ЦЕЛИКОМ, а не подчищается по тикам, по двум причинам. Первая:
   * правило `release` «картинка назад не ходит» иначе держало бы мозг на
   * доперемоточном наблюдении всю глубину отката — номера тиков после перемотки
   * идут назад (NTR-16), и ни одно новое наблюдение не оказалось бы свежее.
   * Вторая: помнимое положение врага из стёртой ветви — это координаты, по
   * которым бот пошёл бы в место, где противник не был и не будет.
   */
  private forgetBranch(): void {
    this.pending.length = 0;
    this.memory.clear();
    this.awareOf = undefined;
  }

  /**
   * Мир, каким мозг его осознал к тику. `undefined` — осознанного наблюдения
   * ещё нет: буфер интерполяции не набрался либо задержка реакции не истекла.
   */
  perceive(tick: number): PerceivedWorld | undefined {
    this.release(tick);
    const view = this.awareOf;
    const own = view?.self;
    if (view === undefined || own === undefined) return undefined;
    this.forget(tick);
    return {
      tick,
      observedTick: view.tick,
      self: own,
      slots: view.slots,
      enemies: [...this.memory.values()],
      threats: this.threats(view, own, tick),
      arenaRadius: view.arenaRadius,
      carrying: view.carrying,
    };
  }

  /** Наблюдения, чей срок реакции истёк, становятся знанием — по возрастанию тика. */
  private release(tick: number): void {
    while (this.pending.length > 0 && this.pending[0]!.readyAtTick <= tick) {
      const { view } = this.pending.shift()!;
      // Наблюдение прошлого тика не заменяет более свежее осознанное: джиттер
      // задержки вправе переставить пару наблюдений, а картинка назад не ходит.
      if (this.awareOf !== undefined && view.tick < this.awareOf.tick) continue;
      this.awareOf = view;
      this.remember(view);
    }
  }

  private remember(view: BotWorldView): void {
    const seen = new Set<EntityId>();
    for (const other of view.others) {
      if (other.slot === undefined || other.slot === this.self.slot) continue;
      seen.add(other.id);
      this.memory.set(other.id, { ...other, seenTick: view.tick, visible: true });
    }
    for (const [id, enemy] of this.memory) {
      if (seen.has(id)) continue;
      // Пропал из персонального снапшота — ушёл в туман (NET-12..15): у мозга
      // остаётся последнее виденное положение и метка, когда оно виделось.
      if (enemy.visible) this.memory.set(id, { ...enemy, visible: false });
    }
  }

  /** Горизонт памяти из профиля (BOT-6): дизайнер решает, насколько бот злопамятен. */
  private forget(tick: number): void {
    const horizon = this.profile.reaction.memoryTicks;
    for (const [id, enemy] of this.memory) {
      if (!enemy.visible && tick - enemy.seenTick > horizon) this.memory.delete(id);
    }
  }

  /**
   * Снаряды: сущности без слота игрока, идущие с заметной скоростью. Положение
   * экстраполируется на прошедшие тики — скорость приехала тем же снапшотом,
   * это предсказание полёта, а не знание о невидимом.
   */
  private threats(view: BotWorldView, own: BotEntityView, tick: number): ThreatView[] {
    // Горизонт предсказания — СВОЯ задержка реакции, а не весь отрыв тика съёма
    // от тика наблюдения. Отрыв включает буфер интерполяции и задержку ввода
    // (NET-3, NTR-7) — плату, которую платит и человек: его экран показывает ту
    // же отставшую картинку. Предсказывать дальше неё значит компенсировать
    // задержку канала, то есть видеть мир свежее игрока с тем же клиентом
    // (BOT-3).
    //
    // Число это не косметика. Снаряд демо летит 0.625 клетки за тик, а полный
    // отрыв доходит до полутора десятков тиков: экстраполированный на него шар
    // оказывается ЗА спиной бота, `closing` гаснет, и защищаться становится не
    // от чего — бот стоит под обстрелом, честно считая, что всё уже пролетело.
    const { delayTicks, jitterTicks } = this.profile.reaction;
    const elapsed = Math.min(Math.max(0, tick - view.tick), delayTicks + jitterTicks);
    const out: ThreatView[] = [];
    for (const other of view.others) {
      if (other.slot !== undefined) continue;
      if (Math.hypot(other.vx, other.vy) < MOVING_EPSILON) continue;
      const x = other.x + other.vx * elapsed;
      const y = other.y + other.vy * elapsed;
      const dx = own.x - x;
      const dy = own.y - y;
      out.push({
        id: other.id,
        x,
        y,
        vx: other.vx,
        vy: other.vy,
        distance: Math.hypot(dx, dy),
        closing: dx * other.vx + dy * other.vy > 0,
      });
    }
    return out;
  }
}
