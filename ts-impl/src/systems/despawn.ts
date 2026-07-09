/**
 * DespawnSystem
 * Стадия: Resolution
 * 
 * Обрабатывает респавн мёртвых сущностей.
 */

import { GameWorld } from '../ecs/world';
import { Resources } from '../resources/resources';
import { ZERO } from '../fixed/fixed';

export function despawnSystem(
  world: GameWorld,
  resources: Resources
): void {
  const { timeState } = resources;

  const deadEntities = world.with('Dead');

  for (const entity of deadEntities) {
    const dead = entity.Dead!;

    // Проверить, наступил ли тик респавна
    if (timeState.current_tick < dead.respawn_tick) {
      continue;
    }

    // Респавн!

    // Удалить компонент Dead
    (entity as any).Dead = undefined;

    // Восстановить здоровье
    if (entity.Health) {
      entity.Health.current = entity.Health.max;
    }

    // Сбросить кулдауны
    if (entity.Cooldowns) {
      entity.Cooldowns.fireball = ZERO;
      entity.Cooldowns.shield = ZERO;
      entity.Cooldowns.dash = ZERO;
      entity.Cooldowns.time_slow = ZERO;
    }

    // Остановить сущность
    if (entity.Velocity) {
      entity.Velocity.dx = ZERO;
      entity.Velocity.dy = ZERO;
      entity.Velocity.dz = ZERO;
    }
  }
}
