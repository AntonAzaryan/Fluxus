// базис
export * from './types.js';
/**
 * `withDiagnostics` — область действия приёмника (DIAG-1): он устанавливается
 * на время переданного тела и снимается после. Прежний `setAssertSink`
 * удалён: модульная переменная делала приёмник общим на процесс, и две
 * симуляции рядом писали бы в один (DI-1, DI-5).
 */
export { DEBUG, assert, assertInvariant, withDiagnostics } from './debug.js';
export type { DiagnosticsContext } from './debug.js';

// math — детерминированная арифметика
export * as fixed from './math/fixed.js';
export * as vec from './math/vector.js';
export { mathApi } from './math/mathApi.js';
export { createRngRegistry, XorShift128Stream, seedStateFromName, fnv1a32 } from './math/rng.js';

// ecs — хранилище мира
import * as worldModule from './ecs/world.js';

/**
 * Чтение мира — публично; запись — нет (TICK-3). Мутаторы `spawn`/`destroy`/
 * `setField`/`addComponent`/`removeComponent`/`addTag` и служебные
 * `createWorld`/`fromPlain`/`copyWorldInto`/`clearDirty` остаются внутренними:
 * опубликованные, они и есть тот side-channel, который TICK-3 объявляет
 * несуществующим. Внутри тика мутации идут через Command Buffer (DET-7),
 * начальная расстановка — через `worldInitSpawn`.
 *
 * `componentMasks` тоже не публичен: он отдаёт живой Uint32Array мира, то есть
 * запись в состав компонентов в обход команд.
 */
export const world = {
  cloneWorld: worldModule.cloneWorld,
  componentId: worldModule.componentId,
  componentNames: worldModule.componentNames,
  componentSchema: worldModule.componentSchema,
  dirtyEntities: worldModule.dirtyEntities,
  dirtyIsEmpty: worldModule.dirtyIsEmpty,
  getField: worldModule.getField,
  hasComponent: worldModule.hasComponent,
  hasTag: worldModule.hasTag,
  indexOf: worldModule.indexOf,
  isAlive: worldModule.isAlive,
  listAlive: worldModule.listAlive,
  prefabNames: worldModule.prefabNames,
  prefabOf: worldModule.prefabOf,
  toPlain: worldModule.toPlain,
} as const;

/**
 * Единственный мутирующий хелпер в публичной поверхности: расстановка
 * `worldInit` ДО первого `tick()` (TICK-3, исключение 1; DET-1). Порядок
 * вызовов входит в воспроизводимость — он задаёт выданные ID (ID-2).
 * Вызов после первого тика — нарушение TICK-3, а не поддержанный сценарий.
 */
export const worldInitSpawn = worldModule.spawn;

export type { PrefabDef, PlainWorld } from './ecs/world.js';
export * as entityIndex from './ecs/entityIndex.js';
export * as componentMask from './ecs/componentMask.js';
export { query } from './ecs/query.js';
export { createCommandBuffer } from './ecs/commands.js';
export type { CommandBufferHandle } from './ecs/commands.js';
export { EventBus } from './ecs/events.js';

// dsl — evaluate-системы и выражения из JSON
export * as expr from './dsl/expr.js';
export * as actions from './dsl/actions.js';
export type { Action } from './dsl/actions.js';
export type {
  Expression,
  ExpressionEvaluator,
  ExprValue,
  ExprVars,
  ExprWorld,
} from './dsl/expr.js';
export { EvaluatedSystem, validateSystem } from './dsl/evaluatedSystem.js';
export type { SystemDef } from './dsl/evaluatedSystem.js';
export { schemaFiles, schemaFileContent } from './dsl/schemas.js';

// systems — системы на TS, их API и реестр порядка исполнения
export { SystemRegistry } from './systems/registry.js';
/**
 * `terrainLevelChar`/`terrainFlagChar` — запись клетки текстовой карты (TERR-3)
 * для того, кто ассет пишет (редактор, ED-10): разбор ядро уже даёт
 * `createTerrainGrid`, и без обратного хода потребитель заводил бы вторую копию
 * алфавита (ED-1, CORE-3). Мутирующей поверхности это не расширяет (TICK-3):
 * функции чистые и работают с символами ассета, а не с миром.
 */
export {
  cellAt,
  createTerrainApi,
  createTerrainGrid,
  floorComponentSchema,
  terrainFlagChar,
  terrainLevelChar,
  terrainPrefab,
  FLOOR_COMPONENT,
  TERRAIN_CELL_KINDS,
  TERRAIN_LEVEL_MAX,
  TERRAIN_PREFAB,
} from './systems/terrain.js';
export type { TerrainCellKind, TerrainDef } from './systems/terrain.js';
export {
  createPhysicsApi,
  staticsFromTerrain,
  PhysicsSystem,
  PhysicsWorld,
  BLOCKS_MOVEMENT,
  BLOCKS_VISION,
  SHAPE_AABB,
  SHAPE_CIRCLE,
  STATIC_COLLIDER,
} from './systems/physics.js';
export type { PhysicsOptions, StaticCollider } from './systems/physics.js';
export {
  createArenaApi,
  arenaPrefab,
  ArenaSystem,
  ARENA_COMPONENT,
  ARENA_COMPONENTS,
  ARENA_PREFAB,
  ARENA_STATE_COMPONENT,
} from './systems/arena.js';
export type { ArenaDef } from './systems/arena.js';
export {
  VisibilitySystem,
  teamBit,
  isVisibleTo,
  fowComponents,
  VISION_COMPONENT,
  VISIBILITY_COMPONENT,
  STEALTH_COMPONENT,
  TEAM_COMPONENT,
  VISION_SCHEMA,
  VISIBILITY_SCHEMA,
  STEALTH_SCHEMA,
  TEAM_SCHEMA,
  VISION_MODIFIER_COMPONENT,
  VISION_SCALE_MIN,
  VISION_SCALE_MAX,
  MAX_TEAMS,
} from './systems/visibility.js';
export type { VisibilityOptions } from './systems/visibility.js';
export { InputSystem, INPUT_FIELDS } from './systems/inputSystem.js';
export type { InputSystemOptions } from './systems/inputSystem.js';
export {
  LocomotionSystem,
  LOCOMOTION_NORMAL,
  LOCOMOTION_DODGE,
  LOCOMOTION_ROLL,
  LOCOMOTION_AIRBORNE,
  LOCOMOTION_WINDOW,
} from './systems/locomotion.js';
export type { LocomotionOptions } from './systems/locomotion.js';
export { modifierList, requireModifierList, DEFAULT_MODIFIER_SLOTS } from './systems/modifiers.js';
export {
  TimeScaleSystem,
  timeComponents,
  TIME_SCALE_MAX,
  TIME_SCALE_MIN,
  TIME_SCALE_MODIFIERS_COMPONENT,
  TIME_SCALE_SCHEMA,
} from './systems/time.js';
export type { TimeScaleSystemOptions } from './systems/time.js';
export {
  TweenSystem,
  EASING_INSTANT,
  EASING_LINEAR,
  TWEEN_COMPONENT,
  TWEEN_SCHEMA,
} from './systems/tween.js';
export type { TweenDef, TweenSystemOptions } from './systems/tween.js';

// sim — сборка сцены и прогон тиков
export { tick, dispatch, initialState, takeSnapshot, restoreSnapshot } from './sim/tick.js';
export type { Simulation } from './sim/tick.js';
export { RingHistory } from './sim/history.js';
export type { RingHistoryOptions } from './sim/history.js';
export { createRewindController, createInputLog } from './sim/rewind.js';
export type { ExemptField, InputLog, RewindController, RewindOptions } from './sim/rewind.js';
export { filterSnapshot, relevantEntityVisible, VIEWPOINT_ALL, EVENT_ENTITY_FIELDS } from './sim/filter.js';
export type { EventVisibility } from './sim/filter.js';
export { loadScene } from './sim/scene.js';
export type { Scene, SceneDef } from './sim/scene.js';
export { jsonSerializer, prettyJsonSerializer, snapshotToPlain, snapshotFromPlain } from './sim/serialization.js';
export type { PlainSnapshot, Serializer } from './sim/serialization.js';
export { createJsonlSink, traceLine } from './sim/trace.js';
export { runScenario, runScenarioBytes } from './sim/scenario.js';
export type { RunOutput, ScenarioDef, TickRecord } from './sim/scenario.js';
/**
 * Запись расстановки — формат SER-8, общий конфигу сцены, сценарию CLI и
 * конфигу матча. Имя экспорта историческое: тип жил полем сценария.
 * `applyPlacement` наружу не уходит — расстановку применяют загрузчик и прогон
 * до первого тика, а публичный мутатор остаётся один (TICK-3).
 */
export type { ScenarioSpawn } from './sim/placement.js';
export { worldInitHash, worldInitForm } from './sim/worldInit.js';
export type { WorldInitParts } from './sim/worldInit.js';
export { contentPackHash, contentPackForm } from './sim/contentPack.js';
