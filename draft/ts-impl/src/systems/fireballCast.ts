/**
 * FireballCastSystem
 * Стадия: Intent
 * 
 * Обрабатывает каст фаербола (CastFireball).
 */

import { GameWorld } from '../ecs/world';
import { EventBus, CastFireball } from '../ecs/events';
import { Resources } from '../resources/resources';
import { vec_sub, vec_length_sq_xy, vec_normalize_xy, Vec3 } from '../fixed/vector';
import { add, div, mul, ZERO, ONE } from '../fixed/fixed';
import { createFireballArchetype } from '../archetypes/fireball';
import { TimeSlowImmune, LocalTimeScale, Position, Velocity, Projectile } from '../components/types';

export function fireballCastSystem(
  world: GameWorld,
  resources: Resources,
  bus: EventBus
): void {
  const { gameConfig, timeState } = resources;
  const castEvents = bus.get<CastFireball>('CastFireball');

  for (const event of castEvents) {
    const casterEntity = world.get(event.caster_id);
    if (!casterEntity) continue;

    // Проверка: нет Cooldowns
    if (!casterEntity.Cooldowns) continue;

    // Проверка: кулдаун = 0
    if (casterEntity.Cooldowns.fireball > ZERO) continue;

    // Проверка: не мёртв
    if (casterEntity.Dead) continue;

    // Получить позицию кастера
    const position = casterEntity.Position;
    if (!position) continue;

    // Вычислить направление полёта
    const target: Vec3 = {
      x: event.target_x,
      y: event.target_y,
      z: event.target_z,
    };

    const delta = vec_sub(target, position);
    const lengthSq = vec_length_sq_xy(delta);

    let dir: Vec3;
    if (lengthSq === ZERO) {
      dir = { x: ONE, y: ZERO, z: ZERO };
    } else {
      dir = vec_normalize_xy(delta);
    }

    // Создать фаербол
    const fireballArchetype = createFireballArchetype();
    const fireballId = world.spawn({
      Position: new Position(position.x, position.y, position.z),
      Velocity: new Velocity(
        mul(dir.x, gameConfig.fireball_speed),
        mul(dir.y, gameConfig.fireball_speed),
        mul(dir.z, gameConfig.fireball_speed)
      ),
      Collider: fireballArchetype.Collider,
      DynamicBody: fireballArchetype.DynamicBody,
      Projectile: new Projectile(
        event.caster_id,
        gameConfig.fireball_damage,
        gameConfig.fireball_max_distance,
        ZERO
      ),
      LocalTimeScale: fireballArchetype.LocalTimeScale,
      CollisionLayer: fireballArchetype.CollisionLayer,
    });

    // Если кастер иммунен к замедлению — снаряд наследует иммунитет
    if (casterEntity.TimeSlowImmune) {
      const fireballEntity = world.get(fireballId);
      if (fireballEntity) {
        fireballEntity.TimeSlowImmune = new TimeSlowImmune();
        fireballEntity.LocalTimeScale = new LocalTimeScale(div(ONE, gameConfig.time_slow_scale));
      }
    }

    // Установить кулдаун
    casterEntity.Cooldowns.fireball = gameConfig.fireball_cooldown;
  }
}
