/**
 * Восприятие классического мозга (задача 3.1): модель мира из `ClientStep`,
 * память «последнее виденное» под FoW, экстраполяция проджектайлов и буфер
 * задержки реакции.
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
 */
import type { EntityId } from '@game-mvp/core';
import type { ClientStep } from '@game-mvp/net';
import type { BotSelf } from '../../brain.js';
import type { BotProfile } from '../../profile.js';
import { readWorldView, type BotEntityView, type BotWorldView, type WorldViewNames } from '../../worldView.js';
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
  readonly enemies: readonly RememberedEnemy[];
  readonly threats: readonly ThreatView[];
  readonly arenaRadius: number | undefined;
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

  constructor(profile: BotProfile, self: BotSelf, random: BrainRandom, names: WorldViewNames = {}) {
    this.profile = profile;
    this.self = self;
    this.random = random;
    this.names = names;
  }

  /** Наблюдение (BOT-3): всё, что мозг узнаёт о мире, приходит только отсюда. */
  observe(step: ClientStep): void {
    const view = readWorldView(step, this.self.slot, this.names);
    if (view === undefined) return;
    const { delayTicks, jitterTicks } = this.profile.reaction;
    const jitter = jitterTicks === 0 ? 0 : this.random.below(jitterTicks + 1);
    this.pending.push({ readyAtTick: view.tick + delayTicks + jitter, view });
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
      enemies: [...this.memory.values()],
      threats: this.threats(view, own, tick),
      arenaRadius: view.arenaRadius,
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
    const elapsed = Math.max(0, tick - view.tick);
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
