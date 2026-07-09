/**
 * ShieldCastSystem
 * Стадия: Intent
 * 
 * Обрабатывает каст щита (CastShield).
 */

import { GameWorld } from '../ecs/world';
import { EventBus, CastShield } from '../ecs/events';
import { Resources } from '../resources/resources';
import { vec_sub, vec_length_sq_xy, vec_normalize_xy, vec_add, vec_scale, Vec3 } from '../fixed/vector';
import { add, div, mul, ZERO, ONE } from '../fixed/fixed';
import { createShieldArchetype } from '../archetypes/shield';
import { Position, AttachedTo, Lifetime } from '../components/types';

export function shieldCastSystem(
  world: GameWorld,
  resources: Resources,
  bus: EventBus
): void {
  const { gameConfig, timeState } = resources;
  const castEvents = bus.get<CastShield>('CastShield');

  for (const event of castEvents) {
    const casterEntity = world.get(event.caster_id);
    if (!casterEntity) continue;

    // Проверка: нет Cooldowns
    if (!casterEntity.Cooldowns) continue;

    // Проверка: кулдаун щита = 0
    if (casterEntity.Cooldowns.shield > ZERO) continue;

    // Проверка: не мёртв
    if (casterEntity.Dead) continue;

    // Проверка: нет активного щита у кастера
    const allShields = world.with('AttachedTo');
    let activeShieldFound = false;
    for (const shieldEntity of allShields) {
      if (shieldEntity.AttachedTo?.owner_id === event.caster_id) {
        activeShieldFound = true;
        break;
      }
    }
    if (activeShieldFound) continue;

    // Получить позицию кастера
    const position = casterEntity.Position;
    if (!position) continue;

    // Вычислить направление к точке прицеливания
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

    // Вычислить позицию спавна щита
    const shieldPos = vec_add(position, vec_scale(dir, gameConfig.shield_spawn_distance));

    // Вычислить тик истечения щита
    const lifetimeTicks = div(gameConfig.shield_lifetime_ms, gameConfig.ms_per_tick);
    const expiresTick = add(timeState.current_tick, lifetimeTicks);

    // Создать щит
    const shieldArchetype = createShieldArchetype();
    const shieldId = world.spawn({
      Position: new Position(shieldPos.x, shieldPos.y, shieldPos.z),
      Collider: shieldArchetype.Collider,
      StaticBody: shieldArchetype.StaticBody,
      Health: shieldArchetype.Health,
      AttachedTo: new AttachedTo(event.caster_id),
      Lifetime: new Lifetime(expiresTick),
      CollisionLayer: shieldArchetype.CollisionLayer,
    });

    // Установить кулдаун
    casterEntity.Cooldowns.shield = gameConfig.shield_cooldown;
  }
}
