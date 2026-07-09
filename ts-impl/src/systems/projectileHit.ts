/**
 * ProjectileHitSystem
 * Стадия: Reaction
 * 
 * Обрабатывает коллизии снарядов (Collision события от физики).
 */

import { GameWorld } from '../ecs/world';
import { EventBus, Collision, DamageCommand } from '../ecs/events';
import { Resources } from '../resources/resources';
import { sub } from '../fixed/fixed';

export function projectileHitSystem(
  world: GameWorld,
  resources: Resources,
  bus: EventBus
): void {
  const collisionEvents = bus.get<Collision>('Collision');

  for (const event of collisionEvents) {
    // Определить, какая сущность снаряд, а какая цель
    let projectileId: bigint | null = null;
    let targetId: bigint | null = null;

    // Проверить entity_a на Projectile
    const entityA = world.get(event.entity_a);
    if (entityA?.Projectile) {
      projectileId = event.entity_a;
      targetId = event.entity_b;
    }
    // Проверить entity_b на Projectile
    else if (world.get(event.entity_b)?.Projectile) {
      projectileId = event.entity_b;
      targetId = event.entity_a;
    }
    // Нет снаряда — игнорировать
    else {
      continue;
    }

    const projectileEntity = world.get(projectileId);
    const targetEntity = world.get(targetId!);

    if (!projectileEntity || !targetEntity) continue;

    const projectile = projectileEntity.Projectile!;

    // Проверить, является ли цель щитом (AttachedTo)
    if (targetEntity.AttachedTo) {
      // Щит блокирует и отражает снаряд
      if (targetEntity.Health) {
        targetEntity.Health.current = sub(targetEntity.Health.current, projectile.damage);
      }
      continue;
    }

    // Проверить, что цель имеет Health
    if (!targetEntity.Health) {
      // Столкновение со стеной — проверить максимальную дистанцию
      if (projectile.traveled_distance >= projectile.max_distance) {
        world.destroy(projectileId!);
      }
      continue;
    }

    // Цель имеет Health — нанести урон
    bus.emit('DamageCommand', {
      target_id: targetId!,
      source_id: projectile.owner_id,
      damage: projectile.damage,
      damage_type: 'projectile',
    });

    // Уничтожить снаряд
    world.destroy(projectileId!);
  }
}
