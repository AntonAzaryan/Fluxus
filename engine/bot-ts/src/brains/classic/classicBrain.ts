/**
 * Классический мозг (design D4): три слоя за одним контрактом BOT-2 —
 * восприятие (`perception.ts`), решения (`utility.ts`), микро (`micro.ts`).
 *
 * Здесь — только склейка и то, что принадлежит мозгу целиком: чтение профиля на
 * конструировании (BOT-6), кулдаун способности с джиттером и последнее готовое
 * намерение, которое отдаётся на съёме (BOT-2). Мозг синхронный: думает он
 * дёшево, и асинхронное «думаю в фоне» здесь было бы сложностью без причины —
 * контракт её допускает, но не требует.
 *
 * Детерминизм на мозг не распространяется (BOT-5): float, память между тиками и
 * собственный генератор шума законны. В симуляцию не уходит ничего, кроме
 * `InputSample`, а он — канонические данные, от которых реплей воспроизводится
 * без единого запуска мозга.
 */
import type { ClientStep, InputSample } from '@game-mvp/net';
import type { BotBrain, BotBrainFactory, BotSelf } from '../../brain.js';
import { toInputSample } from '../../boundary.js';
import type { BotProfile } from '../../profile.js';
import type { WorldViewNames } from '../../worldView.js';
import { MicroLayer } from './micro.js';
import { Perception } from './perception.js';
import { brainRandom, type BrainRandom } from './random.js';
import { UtilityLayer, planFor, type ArenaCenter } from './utility.js';

export interface ClassicBrainOptions {
  /** Имена компонентов сцены (TICK-4): умолчания — как у клиента и сцены дуэли. */
  readonly names?: WorldViewNames;
  /**
   * Центр арены. Радиус мозг читает из состояния (`arena` ARENA-1), а центр в
   * компонентах не живёт вовсе — он в ассете сцены, поэтому приезжает сборкой.
   */
  readonly center?: ArenaCenter;
  /** Длительность тика матча, секунды: шаг интегрирования steering. */
  readonly tickSeconds?: number;
}

const DEFAULT_TICK_SECONDS = 1 / 60;
const DEFAULT_SEED = 1;

class ClassicBrain implements BotBrain {
  private readonly profile: BotProfile;
  private readonly center: ArenaCenter;
  private readonly random: BrainRandom;
  private readonly perception: Perception;
  private readonly utility: UtilityLayer;
  private readonly micro: MicroLayer;
  private intent: InputSample | undefined;
  private abilityReadyAtTick = -Infinity;

  constructor(profile: BotProfile, self: BotSelf, options: ClassicBrainOptions) {
    // Профиль читается ЗДЕСЬ и больше нигде (BOT-6): слои получают его целиком
    // на конструировании, и новый уровень сложности — это документ, а не правка.
    this.profile = profile;
    this.center = options.center ?? { x: 0, y: 0 };
    const seed = profile.seed ?? DEFAULT_SEED;
    this.random = brainRandom(seed, `bot-${self.playerId}`);
    this.perception = new Perception(profile, self, this.random, options.names ?? {});
    this.utility = new UtilityLayer(profile, this.random);
    this.micro = new MicroLayer(profile, this.random, {
      tickSeconds: options.tickSeconds ?? DEFAULT_TICK_SECONDS,
    });
  }

  observe(step: ClientStep): void {
    this.perception.observe(step);
  }

  sample(tick: number): InputSample | undefined {
    const world = this.perception.perceive(tick);
    if (world === undefined) return this.intent;
    const abilityReady = tick >= this.abilityReadyAtTick;
    const behavior = this.utility.choose(world, tick, { abilityReady, center: this.center });
    const plan = planFor(behavior, world, this.profile, this.center);
    const micro = this.micro.step(plan, world, tick);
    const fire = plan.fire && abilityReady;
    if (fire) {
      // Джиттер кулдауна (BOT-6): бот, жмущий способность ровно по таймеру,
      // читается как автомат — им он и является, и профиль обязан уметь это
      // скрыть.
      const { cooldownTicks } = this.profile.ability;
      const jitter = this.profile.decision.jitterTicks;
      this.abilityReadyAtTick =
        tick + cooldownTicks + (jitter === 0 ? 0 : this.random.below(jitter + 1));
    }
    this.intent = toInputSample({
      moveX: micro.moveX,
      moveY: micro.moveY,
      aimRadians: micro.aimRadians,
      buttons: fire ? 1 << this.profile.ability.button : 0,
    });
    return this.intent;
  }
}

/**
 * Фабрика классического мозга (BOT-2). Подпись — общая для всех реализаций
 * контракта: замена на обученный мозг меняет эту ссылку в сборке и ничего
 * больше.
 */
export function classicBrain(options: ClassicBrainOptions = {}): BotBrainFactory {
  return (profile, self) => new ClassicBrain(profile, self, options);
}
