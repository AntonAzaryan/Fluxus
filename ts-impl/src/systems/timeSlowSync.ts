/**
 * TimeSlowSyncSystem
 * Стадия: Simulation
 * 
 * Проверяет истечение эффекта глобального замедления времени.
 */

import { GameWorld } from '../ecs/world';
import { Resources } from '../resources/resources';
import { add, div, ONE } from '../fixed/fixed';

export function timeSlowSyncSystem(
  world: GameWorld,
  resources: Resources
): void {
  const { gameConfig, timeState, timeSlowState } = resources;

  if (timeSlowState.expires_tick === BigInt(0)) {
    // Замедление не активно
    return;
  }

  if (timeState.current_tick >= timeSlowState.expires_tick) {
    // Эффект истёк — снять замедление и иммунитет
    timeState.time_scale = ONE;
    timeSlowState.expires_tick = BigInt(0);

    // Снять иммунитет со всех сущностей
    const immuneEntities = world.with('TimeSlowImmune');
    for (const entity of immuneEntities) {
      if (entity.LocalTimeScale) {
        entity.LocalTimeScale.scale = ONE;
      }
      (entity as any).TimeSlowImmune = undefined;
    }
  } else {
    // Эффект активен — поддерживать корректный компенсирующий масштаб
    const expectedScale = div(ONE, gameConfig.time_slow_scale);

    const immuneEntities = world.with('TimeSlowImmune');
    for (const entity of immuneEntities) {
      if (entity.LocalTimeScale) {
        entity.LocalTimeScale.scale = expectedScale;
      }
    }
  }
}
