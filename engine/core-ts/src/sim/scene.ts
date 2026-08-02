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
import type { ComponentSchema, TerrainApi, WorldState } from '../types.js';

export interface SceneDef {
  /** Порядок задаёт битовые id компонентов и потому является частью формата (SER-7). */
  readonly components: readonly ComponentSchema[];
  readonly prefabs?: readonly PrefabDef[];
  readonly systems?: readonly SystemDef[];
  readonly capacity?: number;
  /** Ассет террейна (TERR-2). Компонент карты пола и его prefab порождаются из него. */
  readonly terrain?: TerrainDef;
}

export interface Scene {
  readonly world: WorldState;
  readonly systems: SystemRegistry;
  /** Есть, если сцена содержит террейн. */
  readonly terrain?: TerrainApi;
}

export function loadScene(def: SceneDef): Scene {
  // Схема карты пола зависит от размеров сетки, поэтому дописывается к
  // объявленным компонентам, а не пишется в сцене руками (TERR-6).
  const grid = def.terrain === undefined ? undefined : createTerrainGrid(def.terrain);
  const components =
    grid === undefined ? def.components : [...def.components, floorComponentSchema(grid)];
  const prefabs = grid === undefined ? (def.prefabs ?? []) : [...(def.prefabs ?? []), terrainPrefab(grid)];

  const world = createWorld(components, prefabs, def.capacity);
  // Сущность террейна спавнится до начальной расстановки: она часть worldInit
  // (DET-1), и её ID обязан быть первым, иначе расстановка сцены сдвигала бы
  // выдаваемые ID (ID-2, DET-6).
  const terrain =
    grid === undefined
      ? undefined
      : createTerrainApi(world, grid, spawn(world, TERRAIN_PREFAB));
  const systems = new SystemRegistry();
  // Валидация каждой системы — внутри registerFromJson (SYS-3): конфиг с
  // опечаткой не должен доживать до первого тика.
  for (const system of def.systems ?? []) systems.registerFromJson(system, world);
  return { world, systems, ...(terrain !== undefined ? { terrain } : {}) };
}
