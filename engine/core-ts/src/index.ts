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
// Фабрики командного буфера в публичной поверхности нет намеренно (TICK-3):
// `createCommandBuffer` принимает ЛЮБОЙ живой мир и отдаёт ровно те операции,
// публикацию которых требование называет несуществующей (`spawn`, `destroy`,
// `addComponent`, `removeComponent`, `setField`), а `flush()` применяет их к
// миру немедленно — то есть вне тика. Внутри системы этот канал легален, но
// буфер там выдаёт сам тик через `ctx.commands` (DET-7), и отдельного экспорта
// для этого не нужно. Вместе с фабрикой не публикуется и тип её выдачи
// (`CommandBufferHandle`): употребить его снаружи нечем. Контракт самих
// операций (`CommandBuffer` в `types.ts`) публичен и дальше — по нему пишутся
// системы. Комментарий строчный намеренно: он объясняет ОТСУТСТВИЕ экспорта, а
// doc-блок JSDoc приписал бы это объяснение соседнему объявлению.
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
export { EvaluatedSystem, validateActions, validateExpression, validateSystem } from './dsl/evaluatedSystem.js';
export type { SystemDef } from './dsl/evaluatedSystem.js';
/**
 * Общая модель utility-скоринга (`npc-behavior` NPC-3, `bot-player` BOT-9):
 * закрытый набор форм кривых, состав их параметров, оценка оси и композиция.
 * Наружу уходит потому, что потребителей у неё двое и один из них — вне ядра:
 * поведение NPC считает её `…Fixed`-телами внутри тика, мозг бота — обычными
 * телами вне симуляции. Мутирующей поверхности это не расширяет (TICK-3):
 * функции чистые и мира не касаются.
 */
export {
  clamp01,
  clamp01Fixed,
  combineUtility,
  combineUtilityFixed,
  considerationScore,
  considerationScoreFixed,
  curveValue,
  curveValueFixed,
  finishUtility,
  finishUtilityFixed,
  logisticFixed,
  CURVE_CONSTANT,
  CURVE_LINEAR,
  CURVE_LOGISTIC,
  CURVE_QUADRATIC,
  SCORING_CURVES,
  SCORING_CURVE_FIELDS,
  UTILITY_IDENTITY,
  UTILITY_IDENTITY_FIXED,
} from './dsl/scoring.js';
export type { FixedCurve, ScoringCurve, ScoringCurveField, ScoringCurveType } from './dsl/scoring.js';
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
  colliderHeightDeclared,
  createPhysicsApi,
  staticsFromTerrain,
  PhysicsSystem,
  PhysicsWorld,
  BLOCKS_MOVEMENT,
  BLOCKS_VISION,
  COLLIDER_HEIGHT_FIELD,
  PHYSICS_EVENTS,
  SHAPE_AABB,
  SHAPE_CIRCLE,
  STATIC_COLLIDER,
} from './systems/physics.js';
export type { PhysicsDeps, PhysicsOptions, StaticCollider } from './systems/physics.js';
/**
 * Сборка Navigation API (`pathfinding` NAV-1). Наружу уходит только сборка:
 * `findPath` за ней — чистый запрос (NAV-2), мира он не касается, и мутирующей
 * поверхности это не расширяет (TICK-3). Зовёт её `buildSimulation`, а прямой
 * экспорт нужен тому, кто поднимает навигацию рядом с собственной сборкой —
 * стендам и замерам (PERF-5).
 */
export { buildNavigation } from './systems/nav/navigation.js';
export type { NavigationOptions } from './systems/nav/navigation.js';
export {
  createArenaApi,
  arenaPrefab,
  ArenaSystem,
  ARENA_COMPONENT,
  ARENA_COMPONENTS,
  ARENA_EVENTS,
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
export { InputSystem, INPUT_FIELDS, INPUT_TARGET_FIELDS, inputTargetDeclared } from './systems/inputSystem.js';
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
/**
 * Платформа способностей (ABIL-1..11). Наружу уходит чистая функция разбора и
 * читаемые константы: мутирующей поверхности это не расширяет (TICK-3), а
 * скомпилированная таблица служит превью рендера (REND-28), профилю бота
 * (BOT-6) и валидации редактора (ED-29) — одно определение, один разбор.
 * Системы платформы регистрирует загрузчик сцены (SER-7), поэтому их классы
 * здесь и не нужны.
 */
export { compileAbilityCatalog } from './systems/abilities/catalog.js';
export {
  ABILITY_COMPONENTS,
  ABILITY_COOLDOWN_COMPONENT,
  ABILITY_COOLDOWN_SCHEMA,
  ABILITY_DURATION_COMPONENT,
  ABILITY_DURATION_SCHEMA,
  ABILITY_PROJECTILE_COMPONENT,
  ABILITY_PROJECTILE_SCHEMA,
  ABILITY_SLOT_COMPONENT,
  ABILITY_SLOT_SCHEMA,
  ABILITY_STEPS,
  BUFF_COMPONENTS,
  BUFF_INSTANCE_COMPONENT,
  BUFF_INSTANCE_SCHEMA,
  NO_BUFF_CLASS,
  NO_INTERRUPT,
  NO_PHASE,
} from './systems/abilities/components.js';
export {
  defaultOutcome,
  interruptCode,
  INTERRUPT_SOURCES,
} from './systems/abilities/interrupt.js';
export {
  BUFF_NEGATIVE,
  BUFF_POSITIVE,
  COOLDOWN_FULL,
  COOLDOWN_PARTIAL,
  COOLDOWN_REFUND,
  PHASE_AUTO,
  PHASE_COMMIT,
  PHASE_HOLD,
  PHASE_RELEASE,
  STACKING_INDEPENDENT,
  STACKING_REFRESH,
  STACKING_STACK,
  STAGED_KEEP,
  STAGED_RESET,
  STEP_NONE,
  STEP_POINT,
  STEP_UNIT,
  STEP_VECTOR,
  TIMEOUT_CANCEL,
  TIMEOUT_COMMIT,
  TIMEOUT_NONE,
  TRIGGER_ALWAYS,
  TRIGGER_EVENT,
  TRIGGER_INPUT,
} from './systems/abilities/model.js';
export type {
  AbilityCatalog,
  AbilityCatalogDef,
  AbilityDef,
  AbilityInterruptDef,
  AbilityInterruptsDef,
  AbilityPhaseDef,
  AbilityRuntimeDef,
  AbilityShapeDef,
  AbilityStepDef,
  AbilityTargetingDef,
  BuffDef,
  BuffPeriodicDef,
  BuffStatModDef,
  BuffTriggerDef,
  CompiledAbility,
  CompiledBindings,
  CompiledBuff,
  CompiledBuffTrigger,
  CompiledOutcome,
  CompiledPhase,
  CompiledStatMod,
  CompiledStep,
} from './systems/abilities/model.js';

// sim — сборка сцены и прогон тиков
// `restoreSnapshot` в этой строке — исключения 2 и 4 TICK-3: применение снапшота
// ядром при перемотке (REW-2) и применение авторитетного снапшота сетевой
// оболочкой, у которой собственного тика нет вовсе (`client-shell` SHELL-8,
// NTR-10). Требование велит публиковать эту операцию отдельно от read-only
// поверхности и по назначению; мутирующей поверхности общего назначения это не
// расширяет: единица её работы — состояние целиком, а не поле, сущность или
// состав компонентов, то есть ни одна из операций, публикацию которых TICK-3
// объявляет несуществующей (перечень — в шапке `world` выше). Комментарий
// строчный намеренно: doc-блок приписал бы объяснение всей строке экспортов.
export { tick, dispatch, initialState, takeSnapshot, restoreSnapshot } from './sim/tick.js';
export type { Simulation } from './sim/tick.js';
export { RingHistory } from './sim/history.js';
export type { RingHistoryOptions } from './sim/history.js';
export { createRewindController, createInputLog } from './sim/rewind.js';
export type {
  ExemptComponent,
  ExemptEntry,
  ExemptField,
  InputLog,
  RewindController,
  RewindOptions,
} from './sim/rewind.js';
export { filterSnapshot, relevantEntityVisible, VIEWPOINT_ALL, EVENT_ENTITY_FIELDS } from './sim/filter.js';
export type { EventVisibility } from './sim/filter.js';
export { loadScene } from './sim/scene.js';
export type { Scene, SceneDef } from './sim/scene.js';
/**
 * Сборка симуляции до первого `tick()` — тот же класс, что `worldInitSpawn`:
 * исключение `worldInit` из TICK-3, и по той же причине опубликовано отдельно
 * от read-only поверхности. Чужой мир функция не мутирует — поднимает свой,
 * поэтому side-channel'ом мимо Command Buffer (DET-7) не является.
 *
 * Наружу она уходит, чтобы порядок регистрации систем, расстановка и момент
 * хеша `worldInit` (DET-1) существовали в одном экземпляре: сетевой слой
 * поднимает мир матча через неё (NTR-5), а не повторением пролога ядра.
 */
export { buildSimulation } from './sim/build.js';
export type { BuiltSimulation, SimulationBuildDef, SimulationBuildOptions } from './sim/build.js';
export { jsonSerializer, prettyJsonSerializer, snapshotToPlain, snapshotFromPlain } from './sim/serialization.js';
export type { PlainSnapshot, Serializer } from './sim/serialization.js';
export { createJsonlSink, parseTraceSelect, selectingSink, traceLine } from './sim/trace.js';
export { runScenario, runScenarioBytes } from './sim/scenario.js';
export type { RunOutput, ScenarioDef, TickRecord } from './sim/scenario.js';
/**
 * Запись расстановки — формат SER-8, общий конфигу сцены, сценарию CLI и
 * конфигу матча. Имя экспорта историческое: тип жил полем сценария.
 * `applyPlacement` наружу не уходит — расстановку применяют загрузчик сцены и
 * `buildSimulation` до первого тика, а мутатор чужого мира публичен ровно один
 * (`worldInitSpawn`, TICK-3).
 */
export type { ScenarioSpawn } from './sim/placement.js';
export { worldInitHash, worldInitForm } from './sim/worldInit.js';
export type { WorldInitParts } from './sim/worldInit.js';
export { contentPackHash, contentPackForm } from './sim/contentPack.js';
