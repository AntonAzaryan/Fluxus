/**
 * Конфиг сцены (SER-7) — то, что пишет редактор: компоненты, prefabs и
 * системы одним документом.
 *
 * Загрузчик поднимает мир и реестр, но не создаёт `SimulationState` и не
 * тикает: `math` и `physics` — зависимости сборки (DI-2, DI-3), а не данные
 * сцены, и в конфиге их нет.
 */
import { createWorld, type PrefabDef } from './ecs/world.js';
import { SystemRegistry } from './system.js';
import type { SystemDef } from './evaluatedSystem.js';
import type { ComponentSchema, WorldState } from './types.js';

export interface SceneDef {
  /** Порядок задаёт битовые id компонентов и потому является частью формата (SER-7). */
  readonly components: readonly ComponentSchema[];
  readonly prefabs?: readonly PrefabDef[];
  readonly systems?: readonly SystemDef[];
  readonly capacity?: number;
}

export interface Scene {
  readonly world: WorldState;
  readonly systems: SystemRegistry;
}

export function loadScene(def: SceneDef): Scene {
  const world = createWorld(def.components, def.prefabs ?? [], def.capacity);
  const systems = new SystemRegistry();
  // Валидация каждой системы — внутри registerFromJson (SYS-3): конфиг с
  // опечаткой не должен доживать до первого тика.
  for (const system of def.systems ?? []) systems.registerFromJson(system, world);
  return { world, systems };
}
