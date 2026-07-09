/**
 * GameWorld: обёртка над miniplex.World<Entity>
 * 
 * - spawn(archetype, overrides) → entity_id
 * - destroy(id)
 * - get(id)
 * - query(...components) с сортировкой по id
 */

import { World } from 'miniplex';
import { Entity } from './entity';
import { ComponentTypes } from '../components/types';

/**
 * GameWorld: обёртка над miniplex с управлением entity_id
 */
export class GameWorld {
  private world: World<Entity>;
  private nextId: bigint = BigInt(1);

  constructor() {
    this.world = new World<Entity>();
  }

  /**
   * Создать сущность с компонентами
   */
  spawn(components: Partial<ComponentTypes>): bigint {
    const entity: Entity = {
      id: this.nextId++,
      ...components,
    };
    this.world.add(entity);
    return entity.id;
  }

  /**
   * Уничтожить сущность по id
   */
  destroy(id: bigint): void {
    const entity = this.get(id);
    if (entity) {
      this.world.remove(entity);
    }
  }

  /**
   * Получить сущность по id
   */
  get(id: bigint): Entity | undefined {
    for (const entity of this.world.entities) {
      if (entity.id === id) {
        return entity;
      }
    }
    return undefined;
  }

  /**
   * Query сущностей с компонентами (ручная фильтрация)
   */
  query<K extends keyof ComponentTypes>(
    ...componentNames: K[]
  ): Array<Entity & Pick<ComponentTypes, K>> {
    const result: Array<Entity & Pick<ComponentTypes, K>> = [];

    for (const entity of this.world.entities) {
      const hasAll = componentNames.every(name => entity[name] !== undefined);
      if (hasAll) {
        result.push(entity as Entity & Pick<ComponentTypes, K>);
      }
    }

    // Сортировка по id (возрастание) для детерминизма
    result.sort((a, b) => {
      if (a.id < b.id) return -1;
      if (a.id > b.id) return 1;
      return 0;
    });

    return result;
  }

  /**
   * Query сущностей с одним компонентом (ручная фильтрация)
   */
  with<K extends keyof ComponentTypes>(
    component: K
  ): Array<Entity & Pick<ComponentTypes, K>> {
    const result: Array<Entity & Pick<ComponentTypes, K>> = [];

    for (const entity of this.world.entities) {
      if (entity[component] !== undefined) {
        result.push(entity as Entity & Pick<ComponentTypes, K>);
      }
    }

    result.sort((a, b) => {
      if (a.id < b.id) return -1;
      if (a.id > b.id) return 1;
      return 0;
    });

    return result;
  }

  /**
   * Получить все сущности
   */
  all(): Entity[] {
    return [...this.world.entities].sort((a, b) => {
      if (a.id < b.id) return -1;
      if (a.id > b.id) return 1;
      return 0;
    });
  }

  /**
   * Проверить наличие сущности
   */
  has(id: bigint): boolean {
    return this.get(id) !== undefined;
  }

  /**
   * Получить внутренний world (для продвинутых операций)
   */
  getInnerWorld(): World<Entity> {
    return this.world;
  }
}
