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
import type { ClientStep } from '@game-mvp/net';
import type { BotBrain, BotBrainFactory, BotSelf } from '../../brain.js';
import type { BotIntent } from '../../boundary.js';
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
   * Умолчание — начало координат: на арене со смещённым центром сборка обязана
   * передать настоящий, иначе «отступить к центру» уводит бота за край.
   */
  readonly center?: ArenaCenter;
  /**
   * Длительность тика, секунды — ПЕРЕОПРЕДЕЛЕНИЕ. Обычно её знать не нужно:
   * темп матча приезжает клиенту в `Welcome` (NTR-7) и достаётся мозгу в
   * `BotSelf.tickRate`. Поле оставлено прогонам, которые двигают бота сами.
   */
  readonly tickSeconds?: number;
}

const DEFAULT_SEED = 1;

class ClassicBrain implements BotBrain {
  private readonly profile: BotProfile;
  private readonly center: ArenaCenter;
  private readonly random: BrainRandom;
  private readonly perception: Perception;
  private readonly utility: UtilityLayer;
  private readonly micro: MicroLayer;
  private intent: BotIntent | undefined;
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
      // Настоящий темп матча, а не константа: на 30 Гц шаг интегрирования
      // steering вдвое длиннее, и зашитые 60 сделали бы микро-слой вдвое
      // резвее реальности (NTR-7).
      tickSeconds: options.tickSeconds ?? 1 / self.tickRate,
    });
  }

  observe(step: ClientStep): void {
    this.perception.observe(step);
  }

  sample(tick: number): BotIntent | undefined {
    // Разрыв непрерывности (SHELL-7): ветвь истории, для которой выбирались
    // поведение, срок передумывания, кулдаун способности и разгон steering,
    // стёрта — вместе с ней уходят и они. Все четыре величины — сроки в тиках
    // и инерция решения, а номера тиков после перемотки идут НАЗАД (NTR-16):
    // оставленные, они держали бы бота на планах стёртого будущего ровно ту
    // глубину, которую унесла перемотка.
    if (this.perception.takeDiscontinuity()) {
      this.utility.forget();
      this.micro.forget();
      this.abilityReadyAtTick = -Infinity;
      this.intent = this.hold();
    }
    // Мир не идёт — бот не играет (WSM-1). Живых тиков в `Paused`/`Rewinding`
    // нет, ввод замороженного мира клиент и так маскирует (NET-11), и
    // «думать» в эти тики значило бы жечь сроки решений и шума на времени,
    // которого в матче не было. Отдаётся ДЕРЖАНИЕ, а не `undefined`: молчание
    // источника сервер замещает повторением последнего кадра (TICK-2), то есть
    // зажатым направлением движения — бот уезжал бы, пока игрок смотрит откат.
    if (this.perception.mode !== 'Running') return (this.intent = this.hold());
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
    this.intent = {
      moveX: micro.moveX,
      moveY: micro.moveY,
      aimRadians: micro.aimRadians,
      buttons: fire ? 1 << this.profile.ability.button : 0,
    };
    return this.intent;
  }

  /**
   * Держание: стоять, не жать ничего, прицел оставить РОВНО как был — тем
   * самым числом, которое ушло наружу прошлым намерением, вместе с шумом.
   * База микро-слоя (`micro.aim`) шума не содержит, и на профиле с ненулевым
   * `aim.noiseDegrees` держание отдавало бы прицел, отличающийся от последнего
   * отданного на всю амплитуду шума: замирание мира выглядело бы РЫВКОМ
   * прицела, хотя бот именно что перестал думать. Умолчание нужно ровно один
   * раз — на держании до первого намерения, когда отдавать ещё нечего.
   */
  private hold(): BotIntent {
    return {
      moveX: 0,
      moveY: 0,
      aimRadians: this.intent?.aimRadians ?? this.micro.aim,
      buttons: 0,
    };
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
