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
import { cloneWorld, getField, hasComponent, isAlive } from '../ecs/world.js';
import type {
  ChangeSet,
  InputFrame,
  MathApi,
  PhysicsApi,
  SimulationState,
  Snapshot,
  SystemContext,
  TerrainApi,
  TickObserver,
  TickResult,
  WorldState,
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
}

const EMPTY_ENTITIES: ReadonlySet<number> = new Set();

/** Заглушка до этапа 14: интерфейс финальный, наполнит его dirty-tracking (OBS-6). */
const EMPTY_CHANGES: ChangeSet = {
  isEmpty: true,
  changedEntities: () => EMPTY_ENTITIES,
};

export function initialState(world: WorldState, worldSeed: number): SimulationState {
  return { world, tick: 0, rng: createRngRegistry(worldSeed) };
}

/**
 * Продвигает мир на один тик, мутируя `state` (TICK-1). Возвращаемый
 * `TickResult.state` — тот же объект.
 */
export function tick(
  sim: Simulation,
  state: SimulationState,
  inputs: readonly InputFrame[] = [],
): TickResult {
  const world = state.world;
  state.tick++;
  const tickNumber = state.tick;

  const events = new EventBus();
  const commands = createCommandBuffer(world);

  for (const system of sim.systems.ordered()) {
    const ctx: SystemContext = {
      tick: tickNumber,
      query: (spec) => runQuery(world, spec),
      get: (entity, component, field) => getField(world, entity, component, field),
      has: (entity, component) => hasComponent(world, entity, component),
      isAlive: (entity) => isAlive(world, entity),
      commands,
      events,
      rng: state.rng.forSystem(system.name),
      math: sim.math,
      ...(sim.physics !== undefined ? { physics: sim.physics } : {}),
      ...(sim.terrain !== undefined ? { terrain: sim.terrain } : {}),
      inputs,
    };
    system.run(ctx);
    // Flush в конце каждой системы, а не тика (CMD-2): следующая по order
    // система обязана видеть спавны и удаления предыдущей на этом же тике.
    commands.flush();
  }

  return {
    state,
    tick: tickNumber,
    mode: 'Running', // до этапа 16 машины состояний мира нет
    isReplay: false, // до этапа 16 честный проход всегда первый
    events,
    changes: EMPTY_CHANGES,
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
  };
}

/**
 * Восстанавливает состояние из снапшота. Доигрывание промежуточных тиков до
 * нужного — работа вызывающей стороны (REW-2); здесь только применение
 * снапшота. Копия снимается и на восстановлении: снапшот в истории должен
 * пережить последующие мутации восстановленного мира.
 */
export function restoreSnapshot(snapshot: Snapshot, worldSeed: number): SimulationState {
  const rng = createRngRegistry(worldSeed);
  rng.restore(snapshot.rng);
  return { world: cloneWorld(snapshot.world), tick: snapshot.tick, rng };
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
