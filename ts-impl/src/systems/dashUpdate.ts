/**
 * DashUpdateSystem
 * Стадия: Simulation
 * 
 * Обновляет сущности с активным рывком.
 */

import { GameWorld } from '../ecs/world';
import { Resources } from '../resources/resources';
import { add, mul, sub, ZERO } from '../fixed/fixed';

export function dashUpdateSystem(
  world: GameWorld,
  resources: Resources
): void {
  const { gameConfig, timeState } = resources;
  const dashSpeed = gameConfig.dash_speed;
  const dashDurationMs = gameConfig.dash_duration_ms;
  const msPerTick = gameConfig.ms_per_tick;

  const entities = world.with('Dash');

  for (const entity of entities) {
    const dash = entity.Dash!;
    const velocity = entity.Velocity!;

    // Вычислить, истёк ли рывок.
    // current_tick — целочисленный счётчик тиков (u64, conventions.md §4),
    // поэтому elapsed ms = (число тиков) * ms_per_tick (fixed). Это
    // масштабирование fixed на ЦЕЛОЕ — обычное умножение без сдвига, а НЕ mul():
    // у mul сдвиг >>16 обнулял бы результат (ms_elapsed всегда ~0), и рывок
    // никогда не заканчивался — игрок улетал бесконечно в сторону рывка.
    const ticksElapsed = sub(timeState.current_tick, dash.start_tick);
    const msElapsed = ticksElapsed * msPerTick;

    if (msElapsed >= dash.duration_ms) {
      // Рывок закончился — удалить компонент Dash и остановить
      (entity as any).Dash = undefined;
      velocity.dx = ZERO;
      velocity.dy = ZERO;
      velocity.dz = ZERO;
    } else {
      // Установить скорость рывка
      velocity.dx = mul(dash.dir_x, dashSpeed);
      velocity.dy = mul(dash.dir_y, dashSpeed);
      velocity.dz = mul(dash.dir_z, dashSpeed);
    }
  }
}
