/**
 * Пересмотр решения агента (`npc-behavior` NPC-3, NPC-4, NPC-5): выбор цели по
 * threat-таблице и соседям, вычисление входов и выбор действия скорингом.
 *
 * Скоринг — ОБЩАЯ МОДЕЛЬ ядра (NPC-3), та же, что у документа поведения бота:
 * своей реализации кривых и композиции здесь нет. Своим остаётся словарь
 * ВХОДОВ — он производен от прямого чтения мира (NPC-1), а не от
 * отфильтрованного наблюдения.
 *
 * Кадр агента — поля этого объекта, а не аргумент-структура: пересмотр
 * случается для сотен агентов, и объект на каждый был бы аллокацией,
 * пропорциональной числу сущностей.
 */
import { div, mul } from '../../math/fixed.js';
import { lengthOf } from '../../math/vector.js';
import {
  combineUtilityFixed,
  considerationScoreFixed,
  finishUtilityFixed,
  UTILITY_IDENTITY_FIXED,
} from '../../dsl/scoring.js';
import { NPC_THREAT_SLOTS } from './components.js';
import type { NpcHandles } from './handles.js';
import {
  INPUT_ALWAYS,
  INPUT_CROWDING,
  INPUT_HEALTH_FRACTION,
  INPUT_ROUTE_REMAINING,
  INPUT_STATE_ELAPSED,
  INPUT_TARGET_DISTANCE,
  INPUT_TARGET_KNOWN,
  type CompiledBehavior,
  type CompiledState,
} from './model.js';
import { NpcPerception } from './perception.js';
import type { NpcRoutes } from './routes.js';
import {
  healthFraction,
  isDead,
  posX,
  posY,
  threatOf,
  threatSourceAt,
  threatValueAt,
} from './runtime.js';
import { FIXED_ONE, NO_ENTITY, type EntityId, type Fixed, type SystemContext } from '../../types.js';

/** Действие не выбрано: очков не набрал никто (NPC-2). */
export const NO_ACTION = -1;

/**
 * Предел равных по полезности действий, между которыми решает жребий. Больше
 * этого числа ничьих в одном состоянии — не политика, а копия документа сама с
 * собой; лишние читаются порядком документа.
 */
const TIE_LIMIT = 8;

export class NpcDecider {
  readonly perception: NpcPerception;
  private readonly ties = new Int32Array(TIE_LIMIT);

  // Кадр текущего агента: заполняется перед пересмотром и живёт до его конца.
  private entity: EntityId = NO_ENTITY;
  private x: Fixed = 0;
  private y: Fixed = 0;
  private team = 0;
  private target: EntityId = NO_ENTITY;
  private enteredTick = 0;
  private route = -1;
  private routeIndex = 0;
  private crowd = -1;

  constructor(cellSize: Fixed) {
    this.perception = new NpcPerception(cellSize);
  }

  /** Ставит кадр агента: позиция, сторона, текущая цель и прогресс маршрута. */
  frame(
    entity: EntityId,
    x: Fixed,
    y: Fixed,
    team: number,
    target: EntityId,
    enteredTick: number,
    route: number,
    routeIndex: number,
  ): void {
    this.entity = entity;
    this.x = x;
    this.y = y;
    this.team = team;
    this.target = target;
    this.enteredTick = enteredTick;
    this.route = route;
    this.routeIndex = routeIndex;
    this.crowd = -1;
  }

  /** Текущая цель кадра — её ставит `chooseTarget`, читают входы и переходы. */
  get chosenTarget(): EntityId {
    return this.target;
  }

  /**
   * Тик входа в текущее состояние. Ставится ЗАНОВО при смене состояния
   * (`behavior.ts`): вход пишет поле командой, а мир до flush её не видит
   * (CMD-5), и без этой поправки вход `stateElapsed` на тике входа отвечал бы о
   * ПРЕДЫДУЩЕМ состоянии — то есть ровно на том тике, на котором каденс и
   * заставляет пересмотреть решение (NPC-3, NPC-4).
   */
  set stateEnteredTick(tick: number) {
    this.enteredTick = tick;
  }

  /**
   * Выбор цели (NPC-5): лидер threat-таблицы, если он превосходит угрозу
   * текущей цели на порог документа; иначе — текущая цель, а при её отсутствии
   * ближайший враг в радиусе чувства.
   *
   * Порог — ЧИСЛО ДОКУМЕНТА, а не кода: «на сколько охотнее переключаться» и
   * есть та ручка, которой дизайнер правит агрессивность крипа (NPC-2).
   */
  chooseTarget(ctx: SystemContext, handles: NpcHandles, behavior: CompiledBehavior): EntityId {
    const current = NpcPerception.reaches(ctx, handles, this.entity, this.target, behavior.sense)
      ? this.target
      : NO_ENTITY;
    let leader = NO_ENTITY;
    let leaderValue = 0;
    for (let slot = 0; slot < NPC_THREAT_SLOTS; slot++) {
      const source = threatSourceAt(ctx, handles, this.entity, slot);
      if (source === NO_ENTITY || !ctx.isAlive(source) || isDead(ctx, handles, source)) continue;
      const value = threatValueAt(ctx, handles, this.entity, slot);
      if (value <= leaderValue) continue;
      leaderValue = value;
      leader = source;
    }
    if (leader !== NO_ENTITY && leader !== current) {
      const held = current === NO_ENTITY ? 0 : threatOf(ctx, handles, this.entity, current);
      if (leaderValue > held + mul(held, behavior.switchMargin)) {
        this.target = leader;
        return leader;
      }
    }
    this.target =
      current !== NO_ENTITY
        ? current
        : this.perception.nearestEnemy(
            ctx,
            handles,
            this.entity,
            this.x,
            this.y,
            this.team,
            behavior.sense,
          );
    return this.target;
  }

  /**
   * Значение входа словаря NPC в [0, 1] (NPC-3). Нормировка — код, как и у
   * бота: масштаб берётся из документа (радиус чувства, шкала тесноты), и
   * дизайнеру незачем повторять её в каждой кривой.
   */
  inputValue(
    ctx: SystemContext,
    handles: NpcHandles,
    behavior: CompiledBehavior,
    routes: NpcRoutes,
    input: number,
  ): Fixed {
    switch (input) {
      case INPUT_TARGET_KNOWN:
        return this.target === NO_ENTITY ? 0 : FIXED_ONE;
      case INPUT_TARGET_DISTANCE: {
        // Цели нет — «дальше некуда»: сближаться не с кем, и говорит это вход
        // `targetKnown`, а не подмена расстояния.
        if (this.target === NO_ENTITY || behavior.sense <= 0) return FIXED_ONE;
        const dx = posX(ctx, handles, this.target) - this.x;
        const dy = posY(ctx, handles, this.target) - this.y;
        return clampUnit(div(lengthOf(dx, dy), behavior.sense));
      }
      case INPUT_HEALTH_FRACTION:
        return healthFraction(ctx, handles, this.entity);
      case INPUT_CROWDING: {
        if (this.crowd < 0) {
          this.crowd = this.perception.allies(
            ctx,
            handles,
            this.entity,
            this.x,
            this.y,
            this.team,
            behavior.separation,
          );
        }
        return clampUnit(div(this.crowd * FIXED_ONE, behavior.crowdScale * FIXED_ONE));
      }
      case INPUT_STATE_ELAPSED:
        return clampUnit(
          div((ctx.tick - this.enteredTick) * FIXED_ONE, behavior.elapsedScale * FIXED_ONE),
        );
      case INPUT_ROUTE_REMAINING:
        return this.route < 0 || routes.at(this.route, this.routeIndex) === NO_ENTITY ? 0 : FIXED_ONE;
      default:
        // `always`: ось-константа для действия без условий.
        return input === INPUT_ALWAYS ? FIXED_ONE : 0;
    }
  }

  /**
   * Выбор действия состояния скорингом (NPC-3): побеждает наибольшая
   * полезность, нулевая не выбирается вовсе, а точную ничью решает жребий из
   * потока `npc-ai` (D9). Жребий тянется РОВНО ОДИН на пересмотр — число
   * обращений к ГПСЧ есть функция каденса, а не плотности ничьих (NPC-4).
   */
  chooseAction(
    ctx: SystemContext,
    handles: NpcHandles,
    behavior: CompiledBehavior,
    routes: NpcRoutes,
    state: CompiledState,
    jitter: number,
  ): number {
    let best: Fixed = 0;
    let tied = 0;
    for (let index = 0; index < state.actions.length; index++) {
      const action = state.actions[index]!;
      let utility = UTILITY_IDENTITY_FIXED;
      for (const consideration of action.considerations) {
        const value = this.inputValue(ctx, handles, behavior, routes, consideration.input);
        utility = combineUtilityFixed(
          utility,
          considerationScoreFixed(consideration.curve, consideration.weight, value),
        );
        if (utility === 0) break; // ось с нулём выключает действие целиком
      }
      utility = finishUtilityFixed(utility);
      if (utility === 0) continue;
      if (utility > best) {
        best = utility;
        tied = 1;
        this.ties[0] = index;
        continue;
      }
      if (utility === best && tied < TIE_LIMIT) {
        this.ties[tied] = index;
        tied++;
      }
    }
    if (tied === 0) return NO_ACTION;
    return this.ties[jitter % tied]!;
  }
}

/** Доля в [0, 1]: отношение уже посчитано в Q16.16, остаются обе границы. */
function clampUnit(value: Fixed): Fixed {
  if (value <= 0) return 0;
  return value >= FIXED_ONE ? FIXED_ONE : value;
}
