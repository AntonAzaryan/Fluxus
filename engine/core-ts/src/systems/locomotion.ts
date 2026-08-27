/**
 * Локомоушен (LOC-1..LOC-7): разгон/торможение к желаемой скорости и машина
 * манёвров Dodge/Window/Roll/Airborne. Система читает компонент ввода и
 * конфигурацию из компонентов сущности, а пишет скорость и своё состояние
 * только через Command Buffer (DET-7); позицией и столкновениями занимается
 * физика (PHYS-8).
 *
 * Тайминги манёвров и окно даблтапа считаются в ГЛОБАЛЬНЫХ тиках —
 * документированный отказ от `getEffectiveDelta` (TIME-4, TIME-5, LOC-6):
 * замедление зоны времени действует на сущность через масштабирование её
 * перемещения в точке интеграции физикой, поэтому замедленный перекат длится
 * те же тики, но покрывает меньшую дистанцию.
 *
 * Имена компонентов и биты кнопок — опции конструктора, а не конвенция ядра
 * (LOC-1, D2); все балансные числа — поля конфиг-компонента, заполняемые
 * контентом. Тем же порядком задан и селективный лок манёвров (LOC-7): имя
 * компонента-маски и бит «манёвры запрещены» — опции, без них система лока не
 * знает и ведёт себя ровно как прежде. Состояние манёвра целиком лежит в
 * компонентах мира: оно обязано попадать в снапшот и переживать rewind
 * (LOC-3, SNAP-1).
 */
import { abs, add, clamp, mul, sub } from '../math/fixed.js';
import * as vec from '../math/vector.js';
import { optionalComponentHandle } from './optionalHandle.js';
import {
  LEVEL_OVERRIDE_COMPONENT,
  type ComponentHandle,
  type EntityId,
  type FieldHandle,
  type Fixed,
  type QuerySpec,
  type System,
  type SystemContext,
} from '../types.js';

/**
 * Значения поля `state` (D1). Нумерация заморожена: она лежит в снапшотах и
 * golden-эталонах, а окно даблтапа — отдельное состояние, а не флаг: одно
 * поле исключает одновременные манёвры по построению (LOC-3).
 */
export const LOCOMOTION_NORMAL = 0;
export const LOCOMOTION_DODGE = 1;
export const LOCOMOTION_ROLL = 2;
export const LOCOMOTION_AIRBORNE = 3;
export const LOCOMOTION_WINDOW = 4;

export interface LocomotionOptions {
  readonly name?: string;
  /** Компонент ввода; поля пишет `InputSystem` (TICK-4). */
  readonly inputComponent?: string;
  /** Компонент скорости; интегрирует её физика (PHYS-8). */
  readonly velocityComponent?: string;
  /** Конфигурация: все тюнимые числа — поля этого компонента (LOC-1). */
  readonly configComponent?: string;
  /** Состояние машины манёвров (LOC-3, D1). */
  readonly stateComponent?: string;
  /** Компонент коллайдера — сюда пишется `cliffRise` на время прыжка (PHYS-11, D3). */
  readonly colliderComponent?: string;
  /**
   * Индексы битов в маске кнопок; раскладку ввода ядро не знает (LOC-1).
   *
   * `dodgeButton: null` — «уклон система не стартует»: триггер манёвра держит
   * сцена (например, определение способности, `ability-system` ABIL-3), и
   * второй, системный, триггер на том же бите дал бы двойной старт с одного
   * нажатия. LOC-4 этим не отменяется: он говорит, что делает ФРОНТ КНОПКИ
   * уклона, а кнопки уклона у такой сборки нет вовсе — как нет её у сборки без
   * `InputSystem`. Пустой (`undefined`) опция при этом остаётся умолчанием
   * сборки: молчаливая смена умолчания выключила бы уклон у всех сборок, его не
   * называющих, и обнаружилось бы это отсутствием манёвра, а не ошибкой.
   *
   * Окно даблтапа и перекат (LOC-4) при выключенном триггере недостижимы по
   * построению: в `Window` сущность попадает только по завершении уклона, а
   * начать из него перекат нечем.
   */
  readonly dodgeButton?: number | null;
  readonly jumpButton?: number;
  /**
   * Компонент селективного лока действий (LOC-7): поле `mask` — битовая маска
   * заблокированных классов. Не задан — система лок не читает вовсе.
   */
  readonly lockComponent?: string;
  /**
   * Индекс бита «манёвры запрещены» в маске лока. Смысл остальных битов —
   * конвенция контента, ядро их не интерпретирует (LOC-7).
   */
  readonly maneuverLockBit?: number;
}

/** Якорь шкалы `order` (DET-9); параметром сборки не является. */
const ANCHOR_ORDER = 0;

const DEFAULTS = {
  name: 'Locomotion',
  inputComponent: 'Input',
  velocityComponent: 'Velocity',
  configComponent: 'Locomotion',
  stateComponent: 'LocomotionState',
  colliderComponent: 'Collider',
  dodgeButton: 1,
  jumpButton: 2,
  maneuverLockBit: 0,
} as const;

/**
 * Поле маски в компоненте лока (LOC-7). Имя поля — часть контракта системы,
 * как `state`/`ticksLeft` у компонента состояния манёвра: параметризуется имя
 * компонента, а не раскладка его полей.
 */
const LOCK_MASK_FIELD = 'mask';

/**
 * Handle полей, которые читаются НА КАЖДУЮ сущность КАЖДЫЙ тик (SYS-10):
 * состояние манёвра, ввод, скорость и три числа доводчика. Разрешаются один
 * раз, на первом входе в систему.
 *
 * Разовые числа стартов манёвра (`dodgeTicks`, `windowTicks`, `jumpHeight`,
 * скорости манёвров) остались на строковом пути намеренно (design D3): они
 * читаются на переходе, а не в цикле, — а разрешить их заранее значило бы
 * ОТКАЗАТЬ сцене, которая манёвра не имеет и его чисел не объявила. Строковый
 * путь этого не требовал, и требовать он не начинает.
 */
interface LocomotionHandles {
  readonly state: FieldHandle;
  readonly ticksLeft: FieldHandle;
  readonly dirX: FieldHandle;
  readonly dirY: FieldHandle;
  readonly buttons: FieldHandle;
  readonly prevButtons: FieldHandle;
  readonly moveX: FieldHandle;
  readonly moveY: FieldHandle;
  readonly velocityX: FieldHandle;
  readonly velocityY: FieldHandle;
  readonly maxSpeed: FieldHandle;
  readonly accel: FieldHandle;
  readonly decel: FieldHandle;
  /**
   * Компоненты, наличие которых система СПРАШИВАЕТ (`ctx.has`), а не требует:
   * `undefined` — их в схемах сцены нет вовсе, и ответ тот же `false`, что у
   * строкового пути (`systems/optionalHandle.ts`).
   */
  readonly collider: ComponentHandle | undefined;
  readonly levelOverride: ComponentHandle | undefined;
  /** `undefined` — лока в сборке нет: ни одного нового чтения мира (LOC-7). */
  readonly lock: ComponentHandle | undefined;
  readonly lockMask: FieldHandle | undefined;
}

/** Фронт кнопки — бит установлен сейчас и снят в прошлой маске (LOC-3, TICK-4). */
function buttonEdge(buttons: number, prevButtons: number, bit: number): boolean {
  const mask = 1 << bit;
  return (buttons & mask) !== 0 && (prevButtons & mask) === 0;
}

/**
 * Покомпонентный доводчик (LOC-2): шаг за тик ограничен разгоном или
 * торможением, цель в пределах шага фиксируется точно — осцилляции вокруг
 * желаемой скорости нет.
 */
function approach(current: Fixed, desired: Fixed, accel: Fixed, decel: Fixed): Fixed {
  const rate = abs(desired) > abs(current) ? accel : decel;
  return add(current, clamp(sub(desired, current), -rate, rate));
}

export class LocomotionSystem implements System {
  readonly name: string;
  readonly order = ANCHOR_ORDER;
  private readonly input: string;
  private readonly velocity: string;
  private readonly config: string;
  private readonly state: string;
  private readonly collider: string;
  /** `null` — система уклон не стартует (см. `LocomotionOptions.dodgeButton`). */
  private readonly dodgeButton: number | null;
  private readonly jumpButton: number;
  /** `undefined` — лока в сборке нет: ни одного нового чтения мира (LOC-7). */
  private readonly lock: string | undefined;
  private readonly maneuverLockMask: number;
  private readonly querySpec: QuerySpec;
  /** Разрешаются на первом входе, ПОСЛЕ раннего выхода (SYS-10). */
  private handles: LocomotionHandles | undefined;

  constructor(options: LocomotionOptions = {}) {
    this.name = options.name ?? DEFAULTS.name;
    this.input = options.inputComponent ?? DEFAULTS.inputComponent;
    this.velocity = options.velocityComponent ?? DEFAULTS.velocityComponent;
    this.config = options.configComponent ?? DEFAULTS.configComponent;
    this.state = options.stateComponent ?? DEFAULTS.stateComponent;
    this.collider = options.colliderComponent ?? DEFAULTS.colliderComponent;
    // Явное сравнение с `undefined`, а не `??`: `null` — назначенное значение
    // «триггера уклона нет», и нулевое слияние вернуло бы на нём умолчание.
    this.dodgeButton =
      options.dodgeButton === undefined ? DEFAULTS.dodgeButton : options.dodgeButton;
    this.jumpButton = options.jumpButton ?? DEFAULTS.jumpButton;
    const lockBit = options.maneuverLockBit ?? DEFAULTS.maneuverLockBit;
    if (!Number.isInteger(lockBit) || lockBit < 0 || lockBit > 30) {
      throw new Error(`LocomotionSystem: maneuverLockBit вне 0..30: ${lockBit}`);
    }
    if (options.lockComponent === undefined && options.maneuverLockBit !== undefined) {
      throw new Error('LocomotionSystem: maneuverLockBit без lockComponent — лок читать неоткуда');
    }
    this.lock = options.lockComponent;
    this.maneuverLockMask = 1 << lockBit;
    // Участие определяется составом компонентов (LOC-1); спецификация запроса
    // строится один раз — горячий путь тика не аллоцирует её заново.
    this.querySpec = { all: [this.config, this.state, this.input, this.velocity] };
  }

  run(ctx: SystemContext): void {
    const entities = ctx.query(this.querySpec);
    if (entities.length === 0) return;
    const h = (this.handles ??= this.resolveHandles(ctx));
    for (const entity of entities) {
      const state = ctx.getByHandle(entity, h.state);
      if (
        state === LOCOMOTION_DODGE ||
        state === LOCOMOTION_ROLL ||
        state === LOCOMOTION_AIRBORNE
      ) {
        this.maneuver(ctx, h, entity, state);
      } else {
        this.grounded(ctx, h, entity, state);
      }
    }
  }

  private resolveHandles(ctx: SystemContext): LocomotionHandles {
    const lock = this.lock === undefined ? undefined : optionalComponentHandle(ctx, this.lock);
    return {
      state: ctx.resolveField(this.state, 'state'),
      ticksLeft: ctx.resolveField(this.state, 'ticksLeft'),
      dirX: ctx.resolveField(this.state, 'dirX'),
      dirY: ctx.resolveField(this.state, 'dirY'),
      buttons: ctx.resolveField(this.input, 'buttons'),
      prevButtons: ctx.resolveField(this.input, 'prevButtons'),
      moveX: ctx.resolveField(this.input, 'moveX'),
      moveY: ctx.resolveField(this.input, 'moveY'),
      velocityX: ctx.resolveField(this.velocity, 'x'),
      velocityY: ctx.resolveField(this.velocity, 'y'),
      maxSpeed: ctx.resolveField(this.config, 'maxSpeed'),
      accel: ctx.resolveField(this.config, 'accel'),
      decel: ctx.resolveField(this.config, 'decel'),
      collider: optionalComponentHandle(ctx, this.collider),
      levelOverride: optionalComponentHandle(ctx, LEVEL_OVERRIDE_COMPONENT),
      lock,
      lockMask: lock === undefined ? undefined : ctx.resolveField(this.lock!, LOCK_MASK_FIELD),
    };
  }

  /**
   * `Normal` и `Window`: фронты кнопок стартуют манёвр, иначе — разгон и
   * торможение к желаемой скорости (LOC-2, LOC-4, LOC-5).
   */
  private grounded(
    ctx: SystemContext,
    h: LocomotionHandles,
    entity: EntityId,
    state: number,
  ): void {
    const buttons = ctx.getByHandle(entity, h.buttons);
    const prevButtons = ctx.getByHandle(entity, h.prevButtons);
    const moveX = ctx.getByHandle(entity, h.moveX);
    const moveY = ctx.getByHandle(entity, h.moveY);
    // Лок гейтит только старты манёвров (LOC-7): разгон и торможение ниже он не
    // трогает, а проигнорированный фронт нигде не копится — после снятия лока
    // манёвр стартует только новым нажатием.
    const locked = this.maneuversLocked(ctx, h, entity);

    if (!locked && this.dodgeButton !== null && buttonEdge(buttons, prevButtons, this.dodgeButton)) {
      if (state === LOCOMOTION_WINDOW) {
        this.startRoll(ctx, h, entity, moveX, moveY);
        return;
      }
      if (moveX !== 0 || moveY !== 0) {
        this.startDodge(ctx, h, entity, moveX, moveY);
        return;
      }
      // Уклон без направления игнорируется (LOC-4): манёвр без направления
      // не имеет смысла, ввод продолжает рулить скоростью штатно.
    }

    // Прыжок — только из `Normal` (LOC-5): окно даблтапа его не открывает.
    if (!locked && state === LOCOMOTION_NORMAL && buttonEdge(buttons, prevButtons, this.jumpButton)) {
      this.startJump(ctx, h, entity, moveX, moveY);
      return;
    }

    this.steer(ctx, h, entity, moveX, moveY);

    if (state === LOCOMOTION_WINDOW) {
      const ticksLeft = ctx.getByHandle(entity, h.ticksLeft) - 1;
      ctx.commands.setField(entity, this.state, 'ticksLeft', ticksLeft);
      if (ticksLeft <= 0) {
        ctx.commands.setField(entity, this.state, 'state', LOCOMOTION_NORMAL);
      }
    }
  }

  /**
   * Запрещены ли сущности старты манёвров (LOC-7). Лок — обычный компонент
   * мира: его ставит и снимает контент через Command Buffer, он попадает в
   * снапшот на общих основаниях (SNAP-1), и своего состояния система не
   * заводит. Идущий манёвр сюда не заходит вовсе — гейтится только старт.
   */
  private maneuversLocked(ctx: SystemContext, h: LocomotionHandles, entity: EntityId): boolean {
    if (h.lock === undefined || h.lockMask === undefined) return false;
    if (!ctx.hasByHandle(entity, h.lock)) return false;
    return (ctx.getByHandle(entity, h.lockMask) & this.maneuverLockMask) !== 0;
  }

  /**
   * `Dodge`/`Roll`/`Airborne`: ввод не влияет на скорость (LOC-3). Скорость
   * переписывается каждый тик — манёвр владеет ею, чужая запись не переживает
   * следующий тик.
   */
  private maneuver(
    ctx: SystemContext,
    h: LocomotionHandles,
    entity: EntityId,
    state: number,
  ): void {
    const speedField =
      state === LOCOMOTION_DODGE ? 'dodgeSpeed' : state === LOCOMOTION_ROLL ? 'rollSpeed' : 'jumpSpeed';
    const speed = ctx.get(entity, this.config, speedField);
    const dirX = ctx.getByHandle(entity, h.dirX);
    const dirY = ctx.getByHandle(entity, h.dirY);
    this.setVelocity(ctx, entity, mul(dirX, speed), mul(dirY, speed));

    const ticksLeft = ctx.getByHandle(entity, h.ticksLeft) - 1;
    ctx.commands.setField(entity, this.state, 'ticksLeft', ticksLeft);
    if (ticksLeft > 0) return;

    if (state === LOCOMOTION_DODGE) {
      // Окно даблтапа (LOC-4); dirX/dirY сохраняются — fallback направления
      // переката при нулевом векторе движения на момент повторного нажатия.
      ctx.commands.setField(entity, this.state, 'state', LOCOMOTION_WINDOW);
      ctx.commands.setField(entity, this.state, 'ticksLeft', ctx.get(entity, this.config, 'windowTicks'));
      return;
    }

    ctx.commands.setField(entity, this.state, 'state', LOCOMOTION_NORMAL);
    if (state === LOCOMOTION_AIRBORNE) {
      // Тик приземления (LOC-5): override снимается ДО проверки пола арены
      // (якоря 0 и 110, DET-9) — приземление в дыру даёт провал штатно.
      if (h.levelOverride !== undefined && ctx.hasByHandle(entity, h.levelOverride)) {
        ctx.commands.removeComponent(entity, LEVEL_OVERRIDE_COMPONENT);
      }
      if (h.collider !== undefined && ctx.hasByHandle(entity, h.collider)) {
        ctx.commands.setField(entity, this.collider, 'cliffRise', 0);
      }
    }
  }

  /** Разгон/торможение к `move × maxSpeed` покомпонентно (LOC-2). */
  private steer(
    ctx: SystemContext,
    h: LocomotionHandles,
    entity: EntityId,
    moveX: Fixed,
    moveY: Fixed,
  ): void {
    const maxSpeed = ctx.getByHandle(entity, h.maxSpeed);
    const accel = ctx.getByHandle(entity, h.accel);
    const decel = ctx.getByHandle(entity, h.decel);
    const vx = ctx.getByHandle(entity, h.velocityX);
    const vy = ctx.getByHandle(entity, h.velocityY);
    const nx = approach(vx, mul(moveX, maxSpeed), accel, decel);
    const ny = approach(vy, mul(moveY, maxSpeed), accel, decel);
    if (nx !== vx) ctx.commands.setField(entity, this.velocity, 'x', nx);
    if (ny !== vy) ctx.commands.setField(entity, this.velocity, 'y', ny);
  }

  /** Направление фиксируется на момент нажатия (LOC-3) — нормированный вектор движения. */
  private startDodge(
    ctx: SystemContext,
    h: LocomotionHandles,
    entity: EntityId,
    moveX: Fixed,
    moveY: Fixed,
  ): void {
    const dir = vec.normalize({ x: moveX, y: moveY });
    this.start(ctx, entity, LOCOMOTION_DODGE, 'dodgeTicks', dir.x, dir.y, 'dodgeSpeed');
  }

  /** Нулевой вектор на повторном нажатии — направление предыдущего уклона (LOC-4). */
  private startRoll(
    ctx: SystemContext,
    h: LocomotionHandles,
    entity: EntityId,
    moveX: Fixed,
    moveY: Fixed,
  ): void {
    let dirX: Fixed;
    let dirY: Fixed;
    if (moveX !== 0 || moveY !== 0) {
      const dir = vec.normalize({ x: moveX, y: moveY });
      dirX = dir.x;
      dirY = dir.y;
    } else {
      dirX = ctx.getByHandle(entity, h.dirX);
      dirY = ctx.getByHandle(entity, h.dirY);
    }
    this.start(ctx, entity, LOCOMOTION_ROLL, 'rollTicks', dirX, dirY, 'rollSpeed');
  }

  /**
   * Нулевой вектор движения — прыжок на месте (LOC-5). Override уровня
   * фиксирует уровень на момент отрыва (ARENA-6), `cliffRise` открывает
   * подъём через обрыв на высоту прыжка (PHYS-11, D3).
   */
  private startJump(
    ctx: SystemContext,
    h: LocomotionHandles,
    entity: EntityId,
    moveX: Fixed,
    moveY: Fixed,
  ): void {
    const dir = vec.normalize({ x: moveX, y: moveY });
    this.start(ctx, entity, LOCOMOTION_AIRBORNE, 'jumpTicks', dir.x, dir.y, 'jumpSpeed');
    // Сцена без террейна тикает штатно (DI-3): без уровней override не нужен.
    if (ctx.terrain !== undefined) {
      ctx.commands.addComponent(entity, LEVEL_OVERRIDE_COMPONENT, {
        level: ctx.terrain.levelOf(entity),
      });
    }
    if (h.collider !== undefined && ctx.hasByHandle(entity, h.collider)) {
      ctx.commands.setField(entity, this.collider, 'cliffRise', ctx.get(entity, this.config, 'jumpHeight'));
    }
  }

  private start(
    ctx: SystemContext,
    entity: EntityId,
    state: number,
    ticksField: string,
    dirX: Fixed,
    dirY: Fixed,
    speedField: string,
  ): void {
    ctx.commands.setField(entity, this.state, 'state', state);
    ctx.commands.setField(entity, this.state, 'ticksLeft', ctx.get(entity, this.config, ticksField));
    ctx.commands.setField(entity, this.state, 'dirX', dirX);
    ctx.commands.setField(entity, this.state, 'dirY', dirY);
    const speed = ctx.get(entity, this.config, speedField);
    this.setVelocity(ctx, entity, mul(dirX, speed), mul(dirY, speed));
  }

  private setVelocity(ctx: SystemContext, entity: EntityId, x: Fixed, y: Fixed): void {
    ctx.commands.setField(entity, this.velocity, 'x', x);
    ctx.commands.setField(entity, this.velocity, 'y', y);
  }
}
