/**
 * Единственная точка входа в симуляцию (TICK-1) и наблюдаемость результата
 * (OBS-1..3). Side-effect'ов внутри тика нет: всё, что должно попасть наружу,
 * идёт событиями в `TickResult`, а исполняется внешним слоем в `dispatch()`.
 *
 * Мир мутабелен (TICK-1): `tick()` продвигает переданное состояние на месте и
 * возвращает ссылку на него же. Прошлое живёт не рядом в памяти, а снапшотами
 * в истории (SNAP-4) — иначе глубина rewind в 420 тиков стоила бы сотни
 * мегабайт полных копий.
 */
import { EventBus } from '../ecs/events.js';
import { createRngRegistry } from '../math/rng.js';
import { SystemRegistry } from '../systems/registry.js';
import { createCommandBuffer } from '../ecs/commands.js';
import { query as runQuery } from '../ecs/query.js';
import {
  clearDirty,
  cloneWorld,
  copyWorldInto,
  dirtyEntities,
  dirtyIsEmpty,
  getField,
  hasComponent,
  isAlive,
} from '../ecs/world.js';
import {
  TIME_SCALE_COMPONENT,
  type ArenaApi,
  type ChangeSet,
  type InputFrame,
  type MathApi,
  type ModifierRegistry,
  type PhysicsApi,
  type SimulationState,
  type Snapshot,
  type SystemContext,
  type TerrainApi,
  type TickObserver,
  type TickResult,
  type WorldState,
} from '../types.js';

/** Неизменяемая часть: зависимости и набор систем. Живёт вне `SimulationState`. */
export interface Simulation {
  readonly systems: SystemRegistry;
  readonly worldSeed: number;
  /** Обязательная зависимость (DI-2). */
  readonly math: MathApi;
  /** Опциональна на уровне ядра: без неё тик отрабатывает штатно (DI-3). */
  readonly physics?: PhysicsApi;
  /**
   * Террейн сцены (TERR-4). Живёт здесь, а не в `SimulationState`: карта
   * уровней иммутабельна и в снапшот не входит (TERR-6).
   */
  readonly terrain?: TerrainApi;
  /** Арена сцены (ARENA-1): центр иммутабелен, радиус лежит в компоненте. */
  readonly arena?: ArenaApi;
  /**
   * Списки источников-модификаторов сцены (TIME-7, FOW-3). Живут здесь по той
   * же причине, что террейн: порождены данными сцены и иммутабельны, а их
   * содержимое — обычные компоненты, которые снапшотятся сами.
   */
  readonly modifiers?: ModifierRegistry;
}

export function initialState(world: WorldState, worldSeed: number): SimulationState {
  return {
    world,
    tick: 0,
    rng: createRngRegistry(worldSeed),
    events: new EventBus(),
    mode: 'Running',
  };
}

/**
 * Продвигает мир на один тик, мутируя `state` (TICK-1). Возвращаемый
 * `TickResult.state` — тот же объект.
 *
 * Тик вне режима `Running` систем не исполняет и номер тика не двигает: во
 * время `Paused` мир заморожен, во время `Rewinding` темп задаёт rewind-
 * механизм, а обычные системы выключены (REW-4, TIME-9). Внешний цикл может
 * звать `tick()` каждый кадр, не зная режима.
 */
export function tick(
  sim: Simulation,
  state: SimulationState,
  inputs: readonly InputFrame[] = [],
): TickResult {
  if (state.mode !== 'Running') {
    // Замороженный тик ничего не изменил; шину при этом не чистим — она равна
    // состоянию текущего тика и обязана его пережить (REW-10).
    clearDirty(state.world);
    return result(state, false);
  }
  return advance(sim, state, inputs, false);
}

/**
 * Тело тика без проверки режима. Отдельно от `tick()` ради реплея внутри
 * `Rewinding` (REW-2): доигрывание от снапшота обязано исполнять системы, хотя
 * мир формально не в `Running`.
 */
export function advance(
  sim: Simulation,
  state: SimulationState,
  inputs: readonly InputFrame[],
  isReplay: boolean,
): TickResult {
  const world = state.world;
  state.tick++;

  state.events.clear();
  clearDirty(world);
  const commands = createCommandBuffer(world);

  for (const system of sim.systems.ordered()) {
    const ctx: SystemContext = {
      tick: state.tick,
      query: (spec) => runQuery(world, spec),
      get: (entity, component, field) => getField(world, entity, component, field),
      has: (entity, component) => hasComponent(world, entity, component),
      isAlive: (entity) => isAlive(world, entity),
      commands,
      events: state.events,
      rng: state.rng.forSystem(system.name),
      math: sim.math,
      ...(sim.physics !== undefined ? { physics: sim.physics } : {}),
      ...(sim.terrain !== undefined ? { terrain: sim.terrain } : {}),
      ...(sim.arena !== undefined ? { arena: sim.arena } : {}),
      ...(sim.modifiers !== undefined ? { modifiers: sim.modifiers } : {}),
      inputs,
      // TIME-3: множитель берётся из уже сведённого `TimeScale.value`; сведение
      // списка источников — работа `TimeScaleSystem` (TIME-7), не тика.
      getEffectiveDelta: (entity, globalDelta) =>
        hasComponent(world, entity, TIME_SCALE_COMPONENT)
          ? sim.math.mul(globalDelta, getField(world, entity, TIME_SCALE_COMPONENT, 'value'))
          : globalDelta,
    };
    system.run(ctx);
    // Flush в конце каждой системы, а не тика (CMD-2): следующая по order
    // система обязана видеть спавны и удаления предыдущей на этом же тике.
    commands.flush();
  }

  return result(state, isReplay);
}

function result(state: SimulationState, isReplay: boolean): TickResult {
  const world = state.world;
  // Живой view на dirty мира, а не копия: валиден внутри dispatch (OBS-3, OBS-6).
  const changes: ChangeSet = {
    get isEmpty() {
      return dirtyIsEmpty(world);
    },
    changedEntities: (component) => dirtyEntities(world, component),
  };
  return {
    state,
    tick: state.tick,
    mode: state.mode,
    isReplay,
    events: state.events,
    changes,
  };
}

/**
 * Полная копия состояния для истории (SNAP-1). Снимается с интервалом, который
 * выбирает потребитель (SNAP-4), а не на каждом тике.
 */
export function takeSnapshot(state: SimulationState): Snapshot {
  return {
    tick: state.tick,
    world: cloneWorld(state.world),
    rng: state.rng.snapshot(),
    events: [...state.events],
    mode: state.mode,
  };
}

/**
 * Восстанавливает состояние из снапшота НА МЕСТЕ (REW-2). Доигрывание
 * промежуточных тиков до нужного — работа вызывающей стороны; здесь только
 * применение снапшота. Мир копируется внутрь существующего `WorldState`, а не
 * подменяется: на него замкнуты `TerrainApi` и `PhysicsApi` сцены.
 *
 * Снапшот в истории остаётся пригодным к повторному применению: из него
 * копируют, его самого не отдают.
 */
export function restoreSnapshot(state: SimulationState, snapshot: Snapshot): void {
  copyWorldInto(state.world, snapshot.world);
  state.rng.restore(snapshot.rng);
  state.events.restore(snapshot.events);
  state.tick = snapshot.tick;
  state.mode = snapshot.mode;
}

/**
 * Внешний слой вызывает наблюдателей ПОСЛЕ тика (OBS-2). View валиден только
 * синхронно внутри этого вызова: кому нужно пережить тик — копирует сам (OBS-3).
 */
export function dispatch(result: TickResult, observers: readonly TickObserver[]): void {
  for (const observer of observers) {
    observer.onTick(result);
  }
}
