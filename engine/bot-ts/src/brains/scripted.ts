/**
 * Скриптовый мозг (design D6): «иди в центр» и ничего больше.
 *
 * Две работы за одну цену. Первая — вторая реализация контракта BOT-2: тест
 * собирает бот-хост со скриптовым мозгом и с классическим ОДНОЙ сборкой, меняя
 * только фабрику, и это и есть проверяемая форма утверждения «замена мозга —
 * замена сборки». Вторая — детерминированный бот для интеграционных прогонов:
 * ни wall-clock, ни случайности здесь нет, поэтому от одного и того же потока
 * снапшотов он даёт один и тот же ввод.
 *
 * Профиль он читает ровно в одном месте — ограничении скорости (BOT-6):
 * человечность скриптовому мозгу не нужна, его назначение — предсказуемость.
 */
import type { BotBrain, BotBrainFactory, BotSelf } from '../brain.js';
import type { BotIntent } from '../boundary.js';
import type { BotProfile } from '../profile.js';
import { readWorldView, type WorldViewNames } from '../worldView.js';
import type { ClientStep } from '@game-mvp/net';

/**
 * Куда идти. Умолчание — начало координат, но сборка обязана передавать сюда
 * настоящий центр арены сцены (`arena` ARENA-1): он живёт в ассете сцены, а не
 * в компоненте, и на арене со смещённым центром «иди в центр» без него означало
 * бы «иди в начало координат» — то есть за край.
 */
export interface ScriptedTarget {
  readonly x: number;
  readonly y: number;
}

export interface ScriptedBrainOptions {
  readonly target?: ScriptedTarget;
  readonly names?: WorldViewNames;
}

class WalkToPointBrain implements BotBrain {
  private readonly profile: BotProfile;
  private readonly self: BotSelf;
  private readonly target: ScriptedTarget;
  private readonly names: WorldViewNames;
  /** Последнее готовое намерение: съём ввода читает его и не ждёт (BOT-2). */
  private intent: BotIntent | undefined;

  constructor(profile: BotProfile, self: BotSelf, options: ScriptedBrainOptions) {
    this.profile = profile;
    this.self = self;
    this.target = options.target ?? { x: 0, y: 0 };
    this.names = options.names ?? {};
  }

  observe(step: ClientStep): void {
    const view = readWorldView(step, this.self.slot, this.names);
    const own = view?.self;
    if (own === undefined) return;
    const dx = this.target.x - own.x;
    const dy = this.target.y - own.y;
    const distance = Math.hypot(dx, dy);
    if (distance <= this.profile.movement.arriveTolerance) {
      // На месте: движения нет, прицел держит прежнее направление.
      this.intent = { moveX: 0, moveY: 0, aimRadians: this.intent?.aimRadians ?? 0 };
      return;
    }
    const speed = this.profile.movement.maxSpeed;
    this.intent = {
      moveX: (dx / distance) * speed,
      moveY: (dy / distance) * speed,
      aimRadians: Math.atan2(dy, dx),
    };
  }

  sample(_tick: number): BotIntent | undefined {
    // Ввода нет, пока не было ни одного наблюдения: молчание на границе
    // выражается отсутствием кадра, а не нулевым кадром (BOT-2). Клампы и
    // квантование — забота хостинга (BOT-5), мозг их не касается.
    return this.intent;
  }
}

/**
 * Фабрика скриптового мозга (BOT-2): та же подпись, что у классического, —
 * различие сборок ботов исчерпывается этой ссылкой.
 */
export function scriptedBrain(options: ScriptedBrainOptions = {}): BotBrainFactory {
  return (profile, self) => new WalkToPointBrain(profile, self, options);
}

/** Готовая фабрика «иди в центр» — умолчание интеграционных прогонов (D6). */
export const walkToCenter: BotBrainFactory = scriptedBrain();
