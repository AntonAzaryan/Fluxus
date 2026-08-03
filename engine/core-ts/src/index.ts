// базис
export * from './types.js';
export { DEBUG, assert, assertInvariant, setAssertSink } from './debug.js';
export type { AssertSink } from './debug.js';

// math — детерминированная арифметика
export * as fixed from './math/fixed.js';
export * as vec from './math/vector.js';
export { mathApi } from './math/mathApi.js';
export { createRngRegistry, XorShift128Stream, seedStateFromName, fnv1a32 } from './math/rng.js';

// ecs — хранилище мира
export * as world from './ecs/world.js';
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
export {
  cellAt,
  createTerrainApi,
  createTerrainGrid,
  floorComponentSchema,
  terrainPrefab,
  FLOOR_COMPONENT,
  TERRAIN_PREFAB,
} from './systems/terrain.js';
export type { TerrainDef } from './systems/terrain.js';
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
export type { ArenaDef, ArenaOptions } from './systems/arena.js';
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
export { runScenario, runScenarioBytes } from './sim/scenario.js';
export type { RunOutput, ScenarioDef, ScenarioSpawn, TickRecord } from './sim/scenario.js';
