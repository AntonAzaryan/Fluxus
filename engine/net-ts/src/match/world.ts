/**
 * Подъём мира матча — общий для сервера и клиента.
 *
 * Общий он не ради экономии строк, а по существу: сверка хешей `worldInit`
 * (DET-1, NTR-5) имеет смысл ровно постольку, поскольку обе стороны собирают
 * представление одинаково. Две похожие сборки, разошедшиеся в порядке спавна,
 * дали бы расхождение хешей на честных данных — то есть отказ входа там, где
 * входить можно.
 *
 * Пролог здесь намеренно повторяет пролог `runScenario` ядра, а не вызывает
 * его: сетевому слою доступна только опубликованная поверхность ядра (NTR-1), а
 * `runScenario` прогоняет сценарий до конца и на роль «собери и отдай» не
 * годится. Расхождение этого повтора с ядром ловится проверкой парности
 * (NTR-8): она гоняет записанный матч через сам `runScenario`, и любое различие
 * в сборке мира краснеет на первом же тике.
 */
import {
  createPhysicsApi,
  initialState,
  loadScene,
  mathApi,
  requireModifierList,
  staticsFromTerrain,
  world as coreWorld,
  worldInitHash,
  worldInitSpawn,
  InputSystem,
  LocomotionSystem,
  PhysicsSystem,
  PhysicsWorld,
  VisibilitySystem,
  VISION_MODIFIER_COMPONENT,
  type ComponentSchema,
  type LocomotionOptions,
  type PhysicsApi,
  type PhysicsOptions,
  type PlainWorld,
  type ScenarioSpawn,
  type SceneDef,
  type Simulation,
  type SimulationState,
  type VisibilityOptions,
  type WorldState,
} from '@game-mvp/core';

export interface MatchWorldDef {
  readonly scene: SceneDef;
  readonly seed: number;
  /** Порядок задаёт слоты (TICK-5) и входит в воспроизводимость наравне с seed. */
  readonly players: readonly string[];
  readonly initial?: readonly ScenarioSpawn[];
  /** Зависимость сборки, а не данные сцены (DI-3) — поэтому здесь, а не в `SceneDef`. */
  readonly physics?: PhysicsOptions;
  readonly locomotion?: LocomotionOptions;
  readonly visibility?: VisibilityOptions;
}

export interface MatchWorld {
  readonly sim: Simulation;
  readonly state: SimulationState;
  /** Считается после расстановки и до первого тика — ровно тот момент, который DET-1 называет `worldInit`. */
  readonly worldInitHash: string;
}

export function buildMatchWorld(def: MatchWorldDef): MatchWorld {
  const { world, systems, terrain, arena, modifiers } = loadScene(def.scene);
  systems.register(new InputSystem({ players: def.players }));
  if (def.locomotion !== undefined) systems.register(new LocomotionSystem(def.locomotion));

  let physics: PhysicsApi | undefined;
  if (def.physics !== undefined) {
    const statics = terrain === undefined ? [] : staticsFromTerrain(terrain.grid);
    const physicsWorld = new PhysicsWorld(statics, terrain?.grid.tileSize);
    systems.register(new PhysicsSystem(physicsWorld, def.physics));
    physics = createPhysicsApi(world, physicsWorld, def.physics);
  }

  // После физики: видимость считается по финальным позициям тика (FOW-6).
  if (def.visibility !== undefined) {
    systems.register(
      new VisibilitySystem(requireModifierList(modifiers, VISION_MODIFIER_COMPONENT), def.visibility),
    );
  }

  for (const entry of def.initial ?? []) worldInitSpawn(world, entry.prefab, entry.overrides);

  const state = initialState(world, def.seed);
  const hash = worldInitHash({
    world,
    mode: state.mode,
    ...(terrain !== undefined ? { terrain } : {}),
    ...(arena !== undefined ? { arena } : {}),
  });

  const sim: Simulation = {
    systems,
    worldSeed: def.seed,
    math: mathApi,
    modifiers,
    ...(terrain !== undefined ? { terrain } : {}),
    ...(arena !== undefined ? { arena } : {}),
    ...(physics !== undefined ? { physics } : {}),
  };

  return { sim, state, worldInitHash: hash };
}

/**
 * Схемы компонентов в ПОРЯДКЕ ОБЪЯВЛЕНИЯ — то, что `snapshotFromPlain` требует
 * для восстановления мира: порядок задаёт битовые id, то есть смысл `maskWords`
 * (SER-7).
 *
 * Порядок восстанавливается из живого мира клиента по `componentId`, а не
 * пересобирается повторением раскладки `loadScene` (объявленные компоненты,
 * затем карта пола, арена, таймскейл, твин, туман). Повторение этой раскладки в
 * сетевом слое было бы вторым её определением: изменилась бы нормативная
 * очерёдность SER-7 — и разошлись бы битовые id при формально одном конфиге.
 *
 * Имена берутся из самой плоской формы: `toPlain` выгружает все хранилища мира,
 * а не только непустые. Компонент, которого у клиента нет, означает разошедшийся
 * контент-пак — то есть отказ входа (NTR-5), а не тихую потерю поля.
 */
export function orderedSchemas(world: WorldState, plain: PlainWorld): ComponentSchema[] {
  const ordered: { id: number; schema: ComponentSchema }[] = [];
  for (const name of Object.keys(plain.components)) {
    const id = coreWorld.componentId(world, name);
    const schema = coreWorld.componentSchema(world, name);
    if (id === undefined || schema === undefined) {
      throw new Error(`снапшот ссылается на компонент "${name}", которого нет в сцене клиента`);
    }
    ordered.push({ id, schema });
  }
  ordered.sort((a, b) => a.id - b.id);
  return ordered.map((entry) => entry.schema);
}
