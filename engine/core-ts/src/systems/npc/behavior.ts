/**
 * Поведение NPC внутри тика (`npc-behavior` NPC-1, NPC-4, NPC-7): исполнение
 * HFSM, детерминированный каденс решений с бюджетом и выбор действия скорингом.
 *
 * Система обычная, за общим интерфейсом `System` (SYS-1): восприятие — прямое
 * чтение мира, влияние — Command Buffer (CMD-1), случайность — именованный
 * поток `npc-ai` (RNG-2, D9). Слота ростера, клиента, персонального
 * FoW-снапшота и `InputFrame` у NPC нет и не будет (NPC-1): поведение
 * воспроизводится в реплее из состояния и записанных вводов ИГРОКОВ, а
 * собственных записываемых вводов у него не существует.
 *
 * Место в тике — между накоплением прицеливания и фазами каста: событие,
 * которым ротация просит способность (NPC-7), обязано быть видно машине фаз на
 * ЭТОМ же тике, а шину система видит только от систем с меньшим `order`
 * (EVT-2). Второго пути исполнения способностей платформа не вводит.
 *
 * Каденс (NPC-4): агент пересматривает решение в окне `(тик + его место в
 * обходе) % интервал`, и число пересмотров за тик ограничено бюджетом сцены.
 * Распределение — функция состояния мира и только его: ни свободного времени,
 * ни адаптивности от нагрузки здесь нет, иначе два прогона одного матча
 * разошлись бы.
 */
import { NpcDecider, NO_ACTION } from './decide.js';
import { NpcRoutes } from './routes.js';
import { healthFraction, isDead, livingAgents, posX, posY, teamOf } from './runtime.js';
import { NPC_ACTION_NONE, NPC_AGENT_COMPONENT } from './components.js';
import { resolveNpcHandles, type NpcHandles } from './handles.js';
import {
  COND_ELAPSED,
  COND_EVENT,
  COND_HAS_TARGET,
  COND_HEALTH_ABOVE,
  COND_HEALTH_BELOW,
  COND_NO_TARGET,
  COND_ROUTE_DONE,
  COND_TARGET_BEYOND,
  COND_TARGET_WITHIN,
  EXEC_CAST,
  type CompiledBehavior,
  type CompiledState,
  type NpcCatalog,
} from './model.js';
import { NpcPerception } from './perception.js';
import { NO_ENTITY, type EntityId, type QuerySpec, type System, type SystemContext } from '../../types.js';

/** Место в шкале `order` и его основание — таблица DET-9; параметром сборки не является. */
const ANCHOR_ORDER = -795;

/** Имя подпотока ГПСЧ решений (RNG-4, D9). */
const RNG_STREAM = 'npc-ai';

/**
 * Размер клетки сетки соседей — величина мира, не баланса: две единицы
 * примерно вдвое больше диаметра бойца, поэтому при штатной плотности арены в
 * клетке лежит один-два агента, и обход цепочки не вырождается в перебор.
 */
const CELL_SIZE = 2 << 16;

export class NpcBehaviorSystem implements System {
  readonly name = 'NpcBehavior';
  readonly order = ANCHOR_ORDER;
  private readonly catalog: NpcCatalog;
  private readonly decider = new NpcDecider(CELL_SIZE);
  private readonly routes = new NpcRoutes();
  private readonly spec: QuerySpec;
  /**
   * Вход в состояние состоялся на этом тике: признак хранится ПОЛЕМ, а не
   * возвращается парой с индексом, — пара была бы объектом на каждого агента
   * каждый тик, то есть аллокацией, пропорциональной числу сущностей.
   */
  private entered = false;
  /**
   * Handle платформы (SYS-10): разрешаются на первом входе, один раз на имя, и
   * ПОСЛЕ раннего выхода — сцена, где решать некому, не должна падать на
   * биндинге, до которого она бы и не дошла.
   */
  private handles: NpcHandles | undefined;

  constructor(catalog: NpcCatalog) {
    this.catalog = catalog;
    this.spec = livingAgents(catalog);
  }

  run(ctx: SystemContext): void {
    const agents = ctx.query(this.spec);
    if (agents.length === 0) return;
    const bindings = this.catalog.bindings;
    const handles = (this.handles ??= resolveNpcHandles(ctx, bindings));
    this.decider.perception.rebuild(ctx, bindings, handles);
    this.routes.rebuild(ctx, bindings.position, handles);
    const rng = ctx.rng.stream(RNG_STREAM);
    let budget = this.catalog.decisionBudget;

    for (let slot = 0; slot < agents.length; slot++) {
      const entity = agents[slot]!;
      const behavior = this.catalog.behaviors[ctx.getByHandle(entity, handles.agentBehavior)];
      // Индекс за таблицей поймать здесь нечем: документ проверен на загрузке
      // (NPC-2), а расстановка вправе поставить любое число. Агент без
      // документа просто не ведёт себя — молчаливым умолчанием это не является,
      // потому что и решения у него нет.
      if (behavior === undefined) continue;
      const route = ctx.hasByHandle(entity, handles.route)
        ? ctx.getByHandle(entity, handles.routeRoute)
        : -1;
      this.decider.frame(
        entity,
        posX(ctx, handles, entity),
        posY(ctx, handles, entity),
        teamOf(ctx, handles, entity) ?? 0,
        ctx.getByHandle(entity, handles.agentTarget),
        ctx.getByHandle(entity, handles.agentEnteredTick),
        route,
        route < 0 ? 0 : ctx.getByHandle(entity, handles.routeIndex),
      );
      const state = this.advanceState(ctx, handles, behavior, entity);
      if (this.wants(ctx, handles, behavior, entity, this.entered, slot) && budget > 0) {
        budget--;
        this.decide(ctx, handles, behavior, entity, state, rng.next());
      }
    }
  }

  /**
   * Переходы HFSM (NPC-7): срабатывает ПЕРВЫЙ выполнившийся переход текущего
   * состояния — порядок документа нормативен. Смена состояния сбрасывает
   * выбранное действие: набор действий у нового состояния свой.
   */
  private advanceState(
    ctx: SystemContext,
    handles: NpcHandles,
    behavior: CompiledBehavior,
    entity: EntityId,
  ): number {
    this.entered = false;
    let index = ctx.getByHandle(entity, handles.agentState);
    if (index < 0 || index >= behavior.states.length) {
      // Начальное состояние — первое в документе (NPC-2).
      this.enter(ctx, entity, 0);
      return 0;
    }
    const current = behavior.states[index]!;
    for (const transition of current.transitions) {
      if (
        !this.holds(
          ctx,
          handles,
          behavior,
          entity,
          transition.kind,
          transition.value,
          transition.ticks,
          transition.eventType,
          transition.eventEntityField,
        )
      ) {
        continue;
      }
      if (transition.to === index) continue;
      index = transition.to;
      this.enter(ctx, entity, index);
      return index;
    }
    return index;
  }

  private enter(ctx: SystemContext, entity: EntityId, state: number): void {
    this.entered = true;
    ctx.commands.setField(entity, NPC_AGENT_COMPONENT, 'state', state);
    ctx.commands.setField(entity, NPC_AGENT_COMPONENT, 'enteredTick', ctx.tick);
    ctx.commands.setField(entity, NPC_AGENT_COMPONENT, 'action', NPC_ACTION_NONE);
    // Кадр решателя правится тем же значением: пересмотр случается на ЭТОМ же
    // тике, а мир поставленной команды ещё не видит (CMD-5). Без этого вход
    // «сколько агент в состоянии» отвечал бы о состоянии, которое агент только
    // что покинул.
    this.decider.stateEnteredTick = ctx.tick;
  }

  /** Условие перехода — закрытый словарь документа (NPC-2, NPC-7). */
  private holds(
    ctx: SystemContext,
    handles: NpcHandles,
    behavior: CompiledBehavior,
    entity: EntityId,
    kind: number,
    value: number,
    ticks: number,
    eventType: string,
    entityField: string,
  ): boolean {
    const target = this.decider.chosenTarget;
    switch (kind) {
      case COND_HEALTH_BELOW:
        return healthFraction(ctx, handles, entity) < value;
      case COND_HEALTH_ABOVE:
        return healthFraction(ctx, handles, entity) > value;
      case COND_ELAPSED:
        return ctx.tick - ctx.getByHandle(entity, handles.agentEnteredTick) >= ticks;
      case COND_EVENT:
        return hasEvent(ctx, eventType, entityField, entity);
      case COND_TARGET_WITHIN:
        return NpcPerception.reaches(ctx, handles, entity, target, value);
      case COND_TARGET_BEYOND:
        return target !== NO_ENTITY && !NpcPerception.reaches(ctx, handles, entity, target, value);
      case COND_HAS_TARGET:
        return target !== NO_ENTITY && ctx.isAlive(target) && !isDead(ctx, handles, target);
      case COND_NO_TARGET:
        return target === NO_ENTITY || !ctx.isAlive(target) || isDead(ctx, handles, target);
      case COND_ROUTE_DONE:
        return this.routeDone(ctx, handles, entity);
      default:
        return false;
    }
  }

  private routeDone(ctx: SystemContext, handles: NpcHandles, entity: EntityId): boolean {
    if (!ctx.hasByHandle(entity, handles.route)) return true;
    const route = ctx.getByHandle(entity, handles.routeRoute);
    return this.routes.at(route, ctx.getByHandle(entity, handles.routeIndex)) === NO_ENTITY;
  }

  /**
   * Пора ли пересматривать решение (NPC-4). Окно каденса — функция стабильного
   * места агента в обходе (QUERY-2) и интервала документа; сверх него решение
   * форсируют вход в новое состояние и просроченность, которую ставит система
   * угрозы, увидев провокацию (NPC-5). Форс — это переход, а не нарушение
   * каденса, и в бюджет тика он входит наравне с плановым пересмотром.
   */
  private wants(
    ctx: SystemContext,
    handles: NpcHandles,
    behavior: CompiledBehavior,
    entity: EntityId,
    entered: boolean,
    slot: number,
  ): boolean {
    if (entered) return true;
    const decidedTick = ctx.getByHandle(entity, handles.agentDecidedTick);
    if (decidedTick < 0) return true;
    const target = ctx.getByHandle(entity, handles.agentTarget);
    if (target !== NO_ENTITY && (!ctx.isAlive(target) || isDead(ctx, handles, target))) {
      // Смерть цели — событие, а не срок: держать мёртвую цель до следующего
      // окна значило бы стоять на месте, пока идёт бой.
      return true;
    }
    return (ctx.tick + slot) % behavior.intervalTicks === 0;
  }

  /** Пересмотр: цель, скоринг действий и публикация события каста (NPC-3, NPC-7). */
  private decide(
    ctx: SystemContext,
    handles: NpcHandles,
    behavior: CompiledBehavior,
    entity: EntityId,
    stateIndex: number,
    jitter: number,
  ): void {
    const target = this.decider.chooseTarget(ctx, handles, behavior);
    const state: CompiledState = behavior.states[stateIndex]!;
    const action = this.decider.chooseAction(ctx, handles, behavior, this.routes, state, jitter);
    // Прежнее действие читается СНАЧАЛА из уже поставленных команд буфера,
    // потом из мира (CMD-5): вход в состояние сбросил его командой на этом же
    // тике, а мир до flush её не видит.
    const previous =
      ctx.commands.peekField(entity, NPC_AGENT_COMPONENT, 'action') ??
      ctx.getByHandle(entity, handles.agentAction);
    ctx.commands.setField(entity, NPC_AGENT_COMPONENT, 'target', target);
    ctx.commands.setField(entity, NPC_AGENT_COMPONENT, 'action', action);
    ctx.commands.setField(entity, NPC_AGENT_COMPONENT, 'decidedTick', ctx.tick);
    if (action === NO_ACTION || action === previous) return;
    const chosen = state.actions[action]!;
    if (chosen.executor !== EXEC_CAST) return;
    // Ротация ПРОСИТ способность событием (NPC-7): дальше работают штатные фазы
    // каста, телеграф и прерывания (ABIL-4, ABIL-6), второго пути исполнения
    // нет. Просьба — ФРОНТ, а не уровень: событие уходит на тике, когда
    // действие ВЫБРАНО заново, а не каждый тик, пока оно выбрано. Иначе шина
    // тика превратилась бы в уровень сигнала, а журнал боя — в поток из
    // шестидесяти «просьб» в секунду на один состоявшийся каст. Повторный каст
    // выражается документом: цикл состояний ротации (NPC-7), а не повтором
    // одной и той же просьбы.
    ctx.events.emit(chosen.eventType, {
      caster: entity,
      target,
      x: posX(ctx, handles, entity),
      y: posY(ctx, handles, entity),
    });
  }
}

/**
 * Есть ли на шине событие этого типа, адресованное агенту (NPC-7). Имя поля
 * адресата называет ДОКУМЕНТ (NPC-2): у одной сцены получатель зовётся
 * `entity`, у другой `target`, и угадывать за неё платформа не вправе.
 *
 * Пустое имя — документ адресата не назвал: событие читается как общий сигнал
 * сцены («колонна разрушена»), и переход по нему законен для всех агентов.
 */
function hasEvent(ctx: SystemContext, type: string, field: string, entity: EntityId): boolean {
  for (let index = 0; index < ctx.events.length; index++) {
    const event = ctx.events.at(index);
    if (event.type !== type) continue;
    if (field === '') return true;
    if (event.data[field] === entity) return true;
  }
  return false;
}
