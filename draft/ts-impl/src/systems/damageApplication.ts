/**
 * DamageApplicationSystem
 * Стадия: Resolution
 * 
 * Применяет урон к цели из DamageCommand.
 */

import { GameWorld } from '../ecs/world';
import { EventBus, DamageCommand } from '../ecs/events';
import { Resources } from '../resources/resources';
import { add, div, sub, ZERO } from '../fixed/fixed';

export function damageApplicationSystem(
  world: GameWorld,
  resources: Resources,
  bus: EventBus
): void {
  const { gameConfig, timeState } = resources;
  const damageCommands = bus.get<DamageCommand>('DamageCommand');

  for (const event of damageCommands) {
    const targetEntity = world.get(event.target_id);
    if (!targetEntity) continue;

    // Проверка: есть Health
    if (!targetEntity.Health) continue;

    // Проверка: ещё не мертва
    if (targetEntity.Dead) continue;

    // Применить урон
    const newHealth = sub(targetEntity.Health.current, event.damage);
    targetEntity.Health.current = newHealth;

    // Проверить смерть
    if (newHealth <= ZERO) {
      // Вычислить тик респавна
      const respawnTicks = div(gameConfig.respawn_delay_ms, gameConfig.ms_per_tick);
      const respawnTick = add(timeState.current_tick, respawnTicks);

      // Добавить компонент Dead
      targetEntity.Dead = { respawn_tick: respawnTick };

      // Остановить сущность
      if (targetEntity.Velocity) {
        targetEntity.Velocity.dx = ZERO;
        targetEntity.Velocity.dy = ZERO;
        targetEntity.Velocity.dz = ZERO;
      }
    }
  }
}
