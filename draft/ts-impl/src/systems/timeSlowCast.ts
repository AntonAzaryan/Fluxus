/**
 * TimeSlowCastSystem
 * Стадия: Intent
 * 
 * Обрабатывает каст замедления времени (CastTimeSlow).
 */

import { GameWorld } from '../ecs/world';
import { EventBus, CastTimeSlow } from '../ecs/events';
import { Resources } from '../resources/resources';
import { add, div, ONE, ZERO } from '../fixed/fixed';

export function timeSlowCastSystem(
  world: GameWorld,
  resources: Resources,
  bus: EventBus
): void {
  const { gameConfig, timeState, timeSlowState } = resources;
  const castEvents = bus.get<CastTimeSlow>('CastTimeSlow');

  for (const event of castEvents) {
    const casterEntity = world.get(event.caster_id);
    if (!casterEntity) continue;

    // Проверка: нет Cooldowns
    if (!casterEntity.Cooldowns) continue;

    // Проверка: кулдаун = 0
    if (casterEntity.Cooldowns.time_slow > ZERO) continue;

    // Проверка: не мёртв
    if (casterEntity.Dead) continue;

    // Установить глобальное замедление времени
    timeState.time_scale = gameConfig.time_slow_scale;

    // Добавить иммунитет кастеру
    casterEntity.TimeSlowImmune = {};

    // Установить локальный масштаб времени для компенсации
    const localScale = div(ONE, gameConfig.time_slow_scale);
    casterEntity.LocalTimeScale = { scale: localScale };

    // Установить кулдаун
    casterEntity.Cooldowns.time_slow = gameConfig.time_slow_cooldown_ms;

    // Вычислить тик окончания эффекта
    const durationTicks = div(gameConfig.time_slow_duration_ms, gameConfig.ms_per_tick);
    timeSlowState.expires_tick = add(timeState.current_tick, durationTicks);
  }
}
