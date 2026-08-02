/**
 * Конфиг сцены (SER-7) — то, что пишет редактор: компоненты, prefabs и
 * системы одним документом.
 *
 * Загрузчик поднимает мир и реестр, но не создаёт `SimulationState` и не
 * тикает: `math` и `physics` — зависимости сборки (DI-2, DI-3), а не данные
 * сцены, и в конфиге их нет.
 */
import { createWorld, spawn, type PrefabDef } from '../ecs/world.js';
import { SystemRegistry } from '../systems/registry.js';
import type { SystemDef } from '../dsl/evaluatedSystem.js';
import {
  createTerrainApi,
  createTerrainGrid,
  floorComponentSchema,
  terrainPrefab,
  TERRAIN_PREFAB,
  type TerrainDef,
} from '../systems/terrain.js';
import {
  arenaPrefab,
  createArenaApi,
  ARENA_COMPONENTS,
  ARENA_PREFAB,
  type ArenaDef,
} from '../systems/arena.js';
import { FOW_COMPONENTS } from '../systems/visibility.js';
import { TimeScaleSystem, TIME_COMPONENTS } from '../systems/time.js';
import { TweenSystem, TWEEN_SCHEMA, type TweenDef } from '../systems/tween.js';
import type { ArenaApi, ComponentSchema, TerrainApi, WorldState } from '../types.js';

export interface SceneDef {
  /** Порядок задаёт битовые id компонентов и потому является частью формата (SER-7). */
  readonly components: readonly ComponentSchema[];
  readonly prefabs?: readonly PrefabDef[];
  readonly systems?: readonly SystemDef[];
  readonly capacity?: number;
  /** Ассет террейна (TERR-2). Компонент карты пола и его prefab порождаются из него. */
  readonly terrain?: TerrainDef;
  /** Ассет арены (ARENA-1). Компоненты радиуса и состояния и prefab порождаются из него. */
  readonly arena?: ArenaDef;
  /** Подключает `TimeScale`, `TimeScaleModifiers` и сведение источников (TIME-2, TIME-7). */
  readonly timeScale?: boolean;
  /** Таблица определений твинов (TWEEN-1, TWEEN-3): наличие включает `TweenSystem`. */
  readonly tweens?: readonly TweenDef[];
  /**
   * Подключает компоненты тумана войны (FOW-1..3). Саму `VisibilitySystem`
   * сцена не регистрирует: ей нужен raycast, то есть зависимость сборки (DI-3).
   */
  readonly fog?: boolean;
}

export interface Scene {
  readonly world: WorldState;
  readonly systems: SystemRegistry;
  /** Есть, если сцена содержит террейн. */
  readonly terrain?: TerrainApi;
  /** Есть, если сцена содержит арену. */
  readonly arena?: ArenaApi;
}

export function loadScene(def: SceneDef): Scene {
  // Схемы карты пола и арены зависят от ассетов, поэтому дописываются к
  // объявленным компонентам, а не пишутся в сцене руками (TERR-6, ARENA-1).
  const grid = def.terrain === undefined ? undefined : createTerrainGrid(def.terrain);
  const components = [
    ...def.components,
    ...(grid === undefined ? [] : [floorComponentSchema(grid)]),
    ...(def.arena === undefined ? [] : ARENA_COMPONENTS),
    ...(def.timeScale === true ? TIME_COMPONENTS : []),
    ...(def.tweens === undefined ? [] : [TWEEN_SCHEMA]),
    ...(def.fog === true ? FOW_COMPONENTS : []),
  ];
  const prefabs = [
    ...(def.prefabs ?? []),
    ...(grid === undefined ? [] : [terrainPrefab(grid)]),
    // Ассет арены валидируется здесь же, до `createWorld`.
    ...(def.arena === undefined ? [] : [arenaPrefab(def.arena)]),
  ];

  const world = createWorld(components, prefabs, def.capacity);
  // Сущности террейна и арены спавнятся до начальной расстановки: они часть
  // worldInit (DET-1), и их ID обязаны быть первыми, иначе расстановка сцены
  // сдвигала бы выдаваемые ID (ID-2, DET-6).
  const terrain =
    grid === undefined
      ? undefined
      : createTerrainApi(world, grid, spawn(world, TERRAIN_PREFAB));
  const arena =
    def.arena === undefined
      ? undefined
      : createArenaApi(world, def.arena, spawn(world, ARENA_PREFAB));
  const systems = new SystemRegistry();
  // Нативные системы, включаемые самим составом сцены. Их регистрация здесь, а
  // не у вызывающего: без них объявленные компоненты — мёртвые данные.
  // `TweenSystem` разбирает пути к полям в конструкторе, поэтому битый
  // `target` падает на загрузке сцены, а не в середине матча (SYS-3).
  if (def.timeScale === true) systems.register(new TimeScaleSystem());
  if (def.tweens !== undefined) systems.register(new TweenSystem(def.tweens));
  // Валидация каждой системы — внутри registerFromJson (SYS-3): конфиг с
  // опечаткой не должен доживать до первого тика.
  for (const system of def.systems ?? []) systems.registerFromJson(system, world);
  return {
    world,
    systems,
    ...(terrain !== undefined ? { terrain } : {}),
    ...(arena !== undefined ? { arena } : {}),
  };
}
