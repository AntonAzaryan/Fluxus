/**
 * Микро-слой мозга: steering к цели выбранного исполнителя, стрейф поперёк
 * курса, шум прицела и джиттер таймингов — на Yuka.
 *
 * Слой общий и МЕХАНИЗМ целиком: последовательности steering-примитивов документ
 * поведения не описывает и описывать не вправе (BOT-9).
 *
 * Yuka здесь — движок нижнего слоя и ничего больше: берётся узкий срез
 * (`Vehicle` + `ArriveBehavior`), у которого нет внешних зависимостей, версия
 * пиннится точной. План Б на случай, если библиотека окончательно встанет, —
 * вендоринг этих двух классов: математика тривиальна, а контракт мозга (BOT-2)
 * от неё не зависит вовсе.
 *
 * Float внутри легален (BOT-5) — мозг вне симуляции. Наружу уходит намерение,
 * которое граница превращает в ввод с теми же ограничением и квантованием, что
 * у человека (`input-devices` INP-3).
 *
 * Оси: мир игры — плоскость (x, y), Yuka — трёхмерная (x, y вверх, z). Поэтому
 * `y` мира ложится в `z` вектора, а вертикаль остаётся нулём.
 */
import { ArriveBehavior, Vehicle } from 'yuka';
import type { BotProfile } from '../../profile.js';
import type { PerceivedWorld } from './perception.js';
import type { BehaviorPlan } from './plan.js';
import type { BrainRandom } from './random.js';

const DEGREES = Math.PI / 180;

export interface MicroOptions {
  /**
   * Длительность тика, секунды: шаг интегрирования steering. Величина матча, а
   * не дизайнерская ручка, — темп приезжает клиенту в `Welcome` (NTR-5, NTR-7)
   * и доходит сюда через `BotSelf.tickRate`. На 30 Гц шаг вдвое длиннее, и
   * зашитая константа сделала бы микро-слой вдвое резвее реальности.
   */
  readonly tickSeconds: number;
}

/** Намерение микро-слоя: движение и прицел; кнопки решает слой выше. */
export interface MicroIntent {
  readonly moveX: number;
  readonly moveY: number;
  readonly aimRadians: number;
}

export class MicroLayer {
  private readonly profile: BotProfile;
  private readonly random: BrainRandom;
  private readonly tickSeconds: number;
  private readonly vehicle = new Vehicle();
  private readonly arrive = new ArriveBehavior();
  private aimNoise = 0;
  private noiseUntilTick = -Infinity;
  /** Сторона стрейфа: +1 — влево от курса, −1 — вправо. */
  private strafeSide = 1;
  private strafeUntilTick = -Infinity;
  /**
   * Направление прицела БЕЗ шума. Хранится чистым намеренно: сложи шум обратно
   * в базу — и ошибка начнёт накапливаться, а неподвижный бот без цели за пару
   * сотен тиков провернётся вокруг себя (случайное блуждание вместо дрожания
   * руки).
   */
  private baseAim = 0;

  constructor(profile: BotProfile, random: BrainRandom, options: MicroOptions) {
    this.profile = profile;
    this.random = random;
    this.tickSeconds = options.tickSeconds;
    // Ориентацию `Vehicle` не ведём: прицел бота — своё поле ввода (TICK-2), а
    // не производная от направления движения.
    this.vehicle.updateOrientation = false;
    // Скорость в «единицах стика»: единица — отклонение до упора (INP-3).
    // Мировая скорость героя — свойство сцены, и мозгу она не нужна: он
    // выражает намерение, а не перемещение.
    this.vehicle.maxSpeed = 1;
    this.arrive.tolerance = profile.movement.arriveTolerance;
    this.vehicle.steering.add(this.arrive);
  }

  /**
   * Шаг микро-слоя: положение берётся авторитетным (из наблюдения), скорость —
   * та, что steering набрал сам. Интегрированное Yuka положение выбрасывается:
   * бот не симулирует свой полёт, он только формирует намерение.
   */
  step(plan: BehaviorPlan, world: PerceivedWorld, tick: number): MicroIntent {
    this.vehicle.position.set(world.self.x, 0, world.self.y);
    this.arrive.target.set(plan.targetX, 0, plan.targetY);
    this.vehicle.update(this.tickSeconds);

    const speed = this.profile.movement.maxSpeed;
    const { moveX, moveY } = this.strafed(
      this.vehicle.velocity.x * speed,
      this.vehicle.velocity.z * speed,
      plan,
      world,
      speed,
      tick,
    );

    const aimTarget = plan.aim;
    this.baseAim =
      aimTarget !== undefined
        ? Math.atan2(aimTarget.y - world.self.y, aimTarget.x - world.self.x)
        : moveX === 0 && moveY === 0
          ? this.baseAim
          : Math.atan2(moveY, moveX);
    return { moveX, moveY, aimRadians: this.baseAim + this.noise(tick) };
  }

  /**
   * Направление прицела БЕЗ шума. Наружу его берёт только держание до первого
   * намерения (`hold()` мозга): дальше держание повторяет последний
   * ОТДАННЫЙ прицел — с шумом, каким он ушёл, — иначе замирание мира читалось
   * бы рывком руки на всю амплитуду шума.
   */
  get aim(): number {
    return this.baseAim;
  }

  /**
   * Сброс разгона steering и срока шума: мир, в котором они набирались, стёрт
   * перемоткой (NTR-16). Скорость `Vehicle` — не наблюдение, а инерция решения:
   * оставленная, она первым же кадром после возобновления потащила бы бота
   * туда, куда он шёл в стёртой ветви. Прицел сохраняется — он не про ветвь.
   */
  forget(): void {
    this.vehicle.velocity.set(0, 0, 0);
    this.noiseUntilTick = -Infinity;
    this.strafeUntilTick = -Infinity;
  }

  /**
   * Стрейф (BOT-6): доля хода, уходящая ПОПЕРЁК курса, со стороной, меняющейся
   * раз в период из профиля. Нужен он ровно затем, зачем стрейфит человек:
   * снаряд летит по прямой в упреждение, и цель, идущая ровно на стрелка, сама
   * приезжает под выстрел.
   *
   * Подмешивается к уже набранному ходу, а не заменяет его: бот продолжает
   * сближаться или отрываться — просто не по прямой. Итог прижимается к доле
   * хода из профиля, чтобы поперечная добавка не сделала бота быстрее, чем ему
   * разрешено (INP-3 клампит по единичному кругу, а `maxSpeed` — уже политика
   * профиля, и её граница должна держаться здесь).
   *
   * Ось поперечности берётся от ХОДА, а когда хода нет — от направления на
   * цель прицела. Второй случай — не мелочь: дойдя до дистанции боя, бот целью
   * маршрута выбирает место, где стоит, и ход обнуляется. Без оси от прицела
   * бот замирал бы ровно там, где стрейф нужнее всего, — на линии огня.
   */
  private strafed(
    moveX: number,
    moveY: number,
    plan: BehaviorPlan,
    world: PerceivedWorld,
    speed: number,
    tick: number,
  ): { readonly moveX: number; readonly moveY: number } {
    const bias = this.profile.movement.strafe;
    if (!plan.strafe || bias <= 0) return { moveX, moveY };
    const axis = this.strafeAxis(moveX, moveY, plan, world);
    if (axis === undefined) return { moveX, moveY };
    if (tick >= this.strafeUntilTick) {
      this.strafeSide = this.random.signed() < 0 ? -1 : 1;
      this.strafeUntilTick = tick + this.profile.movement.strafePeriodTicks;
    }
    const amount = axis.length * bias * this.strafeSide;
    const x = moveX + -axis.y * amount;
    const y = moveY + axis.x * amount;
    const mixed = Math.hypot(x, y);
    if (mixed <= speed || mixed === 0) return { moveX: x, moveY: y };
    return { moveX: (x / mixed) * speed, moveY: (y / mixed) * speed };
  }

  /** Единичная ось стрейфа и амплитуда, от которой он считается. */
  private strafeAxis(
    moveX: number,
    moveY: number,
    plan: BehaviorPlan,
    world: PerceivedWorld,
  ): { readonly x: number; readonly y: number; readonly length: number } | undefined {
    const moving = Math.hypot(moveX, moveY);
    if (moving >= 1e-6) return { x: moveX / moving, y: moveY / moving, length: moving };
    const aim = plan.aim;
    if (aim === undefined) return undefined;
    const dx = aim.x - world.self.x;
    const dy = aim.y - world.self.y;
    const facing = Math.hypot(dx, dy);
    if (facing < 1e-6) return undefined;
    // Стоящий бот кружит вокруг цели полной долей хода: половинчатый обход —
    // это тот же неподвижный силуэт, только медленнее.
    return { x: dx / facing, y: dy / facing, length: this.profile.movement.maxSpeed };
  }

  /**
   * Шум прицела (BOT-6): амплитуда и период — из профиля. Период есть потому,
   * что шум, пересчитываемый каждый тик, — дрожь, а не человеческая ошибка:
   * человек промахивается «в сторону» и держится этой ошибки, пока не поправит
   * прицел.
   */
  private noise(tick: number): number {
    if (this.profile.aim.noiseDegrees === 0) return 0;
    if (tick < this.noiseUntilTick) return this.aimNoise;
    this.aimNoise = this.random.signed() * this.profile.aim.noiseDegrees * DEGREES;
    this.noiseUntilTick = tick + this.profile.aim.noisePeriodTicks;
    return this.aimNoise;
  }
}
