/**
 * CooldownTickSystem
 * Стадия: Intent
 * 
 * Уменьшает кулдауны способностей на 1 тик (на величину dt в мс).
 */

import { GameWorld } from '../ecs/world';
import { Resources } from '../resources/resources';
import { add, sub, ZERO } from '../fixed/fixed';

export function cooldownTickSystem(
  world: GameWorld,
  resources: Resources
): void {
  const { gameConfig } = resources;
  const msPerTick = gameConfig.ms_per_tick;

  // Для каждой сущности с Cooldowns
  const entities = world.with('Cooldowns');
  
  for (const entity of entities) {
    const cooldowns = entity.Cooldowns!;
    
    // Уменьшаем каждый кулдаун
    if (cooldowns.fireball > ZERO) {
      cooldowns.fireball = sub(cooldowns.fireball, msPerTick);
      if (cooldowns.fireball < ZERO) cooldowns.fireball = ZERO;
    }
    
    if (cooldowns.shield > ZERO) {
      cooldowns.shield = sub(cooldowns.shield, msPerTick);
      if (cooldowns.shield < ZERO) cooldowns.shield = ZERO;
    }
    
    if (cooldowns.dash > ZERO) {
      cooldowns.dash = sub(cooldowns.dash, msPerTick);
      if (cooldowns.dash < ZERO) cooldowns.dash = ZERO;
    }
    
    if (cooldowns.time_slow > ZERO) {
      cooldowns.time_slow = sub(cooldowns.time_slow, msPerTick);
      if (cooldowns.time_slow < ZERO) cooldowns.time_slow = ZERO;
    }
  }
}
