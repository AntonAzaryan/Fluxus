/**
 * Physics Contract v1 types
 * spec/contracts/physics_v1.md
 */

import { Fixed } from '../fixed/fixed';

/**
 * Событие Collision от провайдера физики
 */
export interface PhysicsCollision {
  entity_a: bigint; // меньший entity_id
  entity_b: bigint; // больший entity_id
  contact_point: { x: Fixed; y: Fixed; z: Fixed };
  normal: { x: Fixed; y: Fixed; z: Fixed };
  penetration: Fixed;
}

/**
 * Событие RaycastHit от провайдера физики
 */
export interface PhysicsRaycastHit {
  ray_source: bigint;
  hit_entity: bigint;
  point: { x: Fixed; y: Fixed; z: Fixed };
  normal: { x: Fixed; y: Fixed; z: Fixed };
  distance: Fixed;
}

/**
 * Событие TriggerEnter от провайдера физики
 */
export interface PhysicsTriggerEnter {
  trigger_entity: bigint;
  other_entity: bigint;
}

/**
 * Capabilities провайдера физики
 */
export interface PhysicsCapabilities {
  deterministic: boolean;
  cross_platform_deterministic: boolean;
  rollback: boolean;
}

/**
 * Интерфейс провайдера физики
 */
export interface PhysicsProvider {
  /**
   * Шаг физики
   * @param world ECS мир
   * @param dt Шаг времени (с учётом time_scale)
   * @param emitCollision Событие коллизии
   */
  step(
    world: { get(id: bigint): any; query(...components: string[]): any[] },
    dt: Fixed,
    emitCollision: (event: PhysicsCollision) => void
  ): void;

  /**
   * Capabilities провайдера
   */
  readonly capabilities: PhysicsCapabilities;

  /**
   * Сериализация состояния (для rollback)
   */
  serialize(): Uint8Array;

  /**
   * Десериализация состояния
   */
  deserialize(data: Uint8Array): void;
}
