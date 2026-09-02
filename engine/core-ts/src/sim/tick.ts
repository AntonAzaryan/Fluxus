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
import { createCommandBuffer, type CommandBufferHandle } from '../ecs/commands.js';
import { query as runQuery, queryInto as runQueryInto } from '../ecs/query.js';
import {
  clearDirty,
  cloneWorld,
  copyWorldInto,
  dirtyEntities,
  dirtyIsEmpty,
  getField,
  getFieldByHandle,
  getFieldByIndex,
  hasComponent,
  hasComponentByHandle,
  isAlive,
  resolveComponentHandle,
  resolveFieldHandle,
} from '../ecs/world.js';
import { beginSystem, countQuery, endSystem, withDiagnostics } from '../debug.js';
import type { AbilityCatalog } from '../systems/abilities/model.js';
import {
  TIME_SCALE_COMPONENT,
  type ArenaApi,
  type ChangeSet,
  type DiagnosticsSink,
  type InputFrame,
  type MathApi,
  type ModifierRegistry,
  type NavigationApi,
  type PhysicsApi,
  type ReadonlySimulationState,
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
   * Поиск пути (NAV-1). Опционален и для этой игры (DI-4): управление игроками
   * прямое, а крипов и NPC в игре нет. Живёт здесь по той же причине, что и
   * террейн: навигационные данные производны от иммутабельной карты уровней и
   * в снапшот не входят (NAV-3).
   */
  readonly navigation?: NavigationApi;
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
  /**
   * Скомпилированная таблица определений способностей (ABIL-10). Живёт здесь по
   * той же причине, что террейн: порождена данными сцены, иммутабельна и в
   * снапшот не входит — состояние способностей целиком лежит в полях
   * компонентов (ABIL-1). Отсюда её читают превью рендера, бот и валидация
   * редактора; системы платформы получают её при регистрации.
   */
  readonly abilities?: AbilityCatalog;
  /**
   * Приёмник диагностики (DIAG-1). Опционален и инертен (DI-5): его наличие
   * MUST NOT менять результат тика. Живёт здесь, а не в `SimulationState`,
   * именно поэтому: состояние копируется в снапшот и восстанавливается
   * перемоткой, зависимость сборки — нет.
   */
  readonly diagnostics?: DiagnosticsSink;
}

/**
 * Буфер команд каждой симуляции — ПРИВАТНОЕ хозяйство тика, а не поле
 * `Simulation`: `Simulation` экспортируется и раздаётся сборкой наружу, и буфер
 * на нём был бы опубликованным мутирующим API мира общего назначения — `flush`
 * применяет команды к миру вне тика, ровно тот side channel, который запрещает
 * TICK-3 (по той же причине `createCommandBuffer` не экспортируется из
 * `index.ts`). Ключ слабый: буфер живёт ровно столько, сколько симуляция.
 *
 * Заводит его сам тик на первом прогоне (`runSystems`), а не сборка. Живёт он
 * не в `SimulationState` по той же причине, что и диагностика: состояние
 * копируется в снапшот и восстанавливается перемоткой, а буфер между тиками
 * ПУСТ по построению и состоянием симуляции не является — переживают тик
 * только его массивы, то есть выделенная под команды память (аллокационная
 * дисциплина ядра). Одна симуляция — один буфер: две симуляции в одном процессе
 * его не делят.
 */
const buffers = new WeakMap<Simulation, CommandBufferHandle>();

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
  state.tick++;
  // Контекст диагностики устанавливается на время одного тика и снимается
  // после (DIAG-1). Без sink'а тело зовётся напрямую — выключенная
  // диагностика стоит одного сравнения на тик.
  return withDiagnostics(sim.diagnostics, state.tick, () => runSystems(sim, state, inputs, isReplay));
}

function runSystems(
  sim: Simulation,
  state: SimulationState,
  inputs: readonly InputFrame[],
  isReplay: boolean,
): TickResult {
  const world = state.world;

  state.events.clear();
  clearDirty(world);
  // Буфер переживает тик РАДИ СВОИХ МАССИВОВ (аллокационная дисциплина ядра:
  // объект на каждую запись поля был бы аллокацией, пропорциональной числу
  // сущностей), а логически живёт один тик: `reset` на входе привязывает его к
  // миру и очищает журнал.
  //
  // Пост-условие оборванного тика (SYS-9) держится именно этой очисткой на
  // ВХОДЕ. Команды, накопленные упавшей системой, до `flush` не доходят ни на
  // каком пути выхода: исключение уносит вызов, `flush` их не увидит, а
  // следующий вызов `tick()` начинается с `reset` и застаёт журнал пустым —
  // применить накопленное упавшей системой некому и негде. Второй путь к тому
  // же пост-условию держит сам `flush`: он проверяет весь буфер до первой
  // мутации, и отказ внутри него мир не задевает. Единица атомарности —
  // система, та же, что у flush'а.
  let commands = buffers.get(sim);
  if (commands === undefined) {
    commands = createCommandBuffer(world);
    buffers.set(sim, commands);
  }
  commands.reset(world);

  // Контекст собирается один раз на тик, а не на каждую систему: между
  // системами меняется только `rng` (его назначает цикл ниже), остальное
  // неизменно весь тик. Иначе каждый тик стоил бы по объекту с дюжиной
  // замыканий на систему.
  const ctx: Omit<SystemContext, 'rng'> & { rng?: SystemContext['rng'] } = {
    tick: state.tick,
    query: (spec) => {
      const matched = runQuery(world, spec);
      // Пустой отбор — самый частый отказ JSON-системы, и без счётчика он
      // неотличим от удалённой системы (DIAG-3). Замыкание одно на тик, как и
      // весь контекст: счётчик пишется в контекст диагностики, не сюда.
      countQuery(matched.length);
      return matched;
    },
    queryInto: (spec, ids, indices) => {
      const matched = runQueryInto(world, spec, ids, indices);
      // Счётчик считает ОТДАННЫЙ результат (DIAG-3): проба, не поместившаяся в
      // буфер вызывающего, результата не отдала — её место займёт повторный
      // запрос по выросшему буферу, и он же будет посчитан. Иначе число
      // запросов в трейсе зависело бы от того, на каком тике буфер системы
      // дорос, то есть от истории прогона, а не от его состояния.
      if (matched <= Math.min(ids.length, indices.length)) countQuery(matched);
      return matched;
    },
    get: (entity, component, field) => getField(world, entity, component, field),
    has: (entity, component) => hasComponent(world, entity, component),
    // Handle-путь (SYS-10): разрешение имён оплачивается один раз — при
    // конструировании системы или на первом её входе, — а горячий цикл дальше
    // и читает, и заказывает записи без строкового поиска. Изменяемой ссылки на
    // колонку хранилища здесь нет и не появится: запись по handle — та же
    // команда буфера, что и по имени (CMD-1, TICK-3).
    resolveField: (component, field) => resolveFieldHandle(world, component, field),
    resolveComponent: (component) => resolveComponentHandle(world, component),
    getByHandle: (entity, handle) => getFieldByHandle(world, entity, handle),
    hasByHandle: (entity, handle) => hasComponentByHandle(world, entity, handle),
    getByIndex: (index, handle) => getFieldByIndex(world, index, handle),
    isAlive: (entity) => isAlive(world, entity),
    commands,
    events: state.events,
    math: sim.math,
    ...(sim.physics !== undefined ? { physics: sim.physics } : {}),
    ...(sim.navigation !== undefined ? { navigation: sim.navigation } : {}),
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

  for (const system of sim.systems.ordered()) {
    ctx.rng = state.rng.forSystem(system.name);
    // Имя текущей системы проставляется здесь: так атрибуция трейса (DIAG-5)
    // достаётся без изменения интерфейса `CommandBuffer`, которым пользуются
    // все системы.
    beginSystem(system.name);
    try {
      system.run(ctx as SystemContext);
      // Flush в конце каждой системы, а не тика (CMD-2): следующая по order
      // система обязана видеть спавны и удаления предыдущей на этом же тике.
      commands.flush();
    } finally {
      // В `finally`, чтобы граница упавшей системы попала в трейс: по нему и
      // видно, на какой системе оборвался тик (DIAG-1).
      endSystem();
    }
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
 *
 * Принимает read-only проекцию: снятие снапшота — чтение, и наблюдателю,
 * ведущему историю из `onTick`, доступного ему отчёта (OBS-1) для этого хватает.
 */
export function takeSnapshot(state: ReadonlySimulationState): Snapshot {
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
