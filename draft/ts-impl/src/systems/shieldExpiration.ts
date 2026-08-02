/**
 * ShieldExpirationSystem
 * Стадия: Resolution
 * 
 * Проверяет время жизни щитов и удаляет истёкшие.
 */

import { GameWorld } from '../ecs/world';
import { Resources } from '../resources/resources';

export function shieldExpirationSystem(
  world: GameWorld,
  resources: Resources
): void {
  const { timeState } = resources;

  // Удалить щиты, у которых здоровье <= 0
  const shieldsWithHealth = world.query('Health', 'AttachedTo');
  for (const entity of shieldsWithHealth) {
    if (entity.Health.current <= BigInt(0)) {
      world.destroy(entity.id);
    }
  }

  // Удалить щиты, у которых истекло время жизни
  const shieldsWithLifetime = world.query('Lifetime', 'AttachedTo');
  for (const entity of shieldsWithLifetime) {
    if (
      entity.Lifetime.expires_tick !== BigInt(0) &&
      timeState.current_tick >= entity.Lifetime.expires_tick
    ) {
      world.destroy(entity.id);
    }
  }
}
