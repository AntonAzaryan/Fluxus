/**
 * DashStartSystem
 * Стадия: Intent
 * 
 * Обрабатывает команду рывка (DashCommand).
 */

import { GameWorld } from '../ecs/world';
import { EventBus, DashCommand } from '../ecs/events';
import { Resources } from '../resources/resources';
import { vec_length_sq_xy, vec_normalize_xy, Vec3 } from '../fixed/vector';
import { ZERO } from '../fixed/fixed';

export function dashStartSystem(
  world: GameWorld,
  resources: Resources,
  bus: EventBus
): void {
  const { gameConfig, timeState } = resources;
  const dashCommands = bus.get<DashCommand>('DashCommand');

  for (const command of dashCommands) {
    const entity = world.get(command.player_id);
    if (!entity) continue;

    // Проверка: нет Cooldowns
    if (!entity.Cooldowns) continue;

    // Проверка: кулдаун рывка = 0
    if (entity.Cooldowns.dash > ZERO) continue;

    // Проверка: нет активного рывка
    if (entity.Dash) continue;

    // Проверка: не мёртв
    if (entity.Dead) continue;

    // Получить направление из MoveIntent
    const moveIntent = entity.MoveIntent;
    if (!moveIntent) continue;

    const intentVec: Vec3 = {
      x: moveIntent.dx,
      y: moveIntent.dy,
      z: moveIntent.dz,
    };

    const lengthSq = vec_length_sq_xy(intentVec);
    if (lengthSq === ZERO) {
      // Персонаж стоит — рывок не срабатывает
      continue;
    }

    // Нормализовать направление
    const dir = vec_normalize_xy(intentVec);

    // Установить кулдаун
    entity.Cooldowns.dash = gameConfig.dash_cooldown_ms;

    // Добавить компонент Dash
    entity.Dash = {
      start_tick: timeState.current_tick,
      duration_ms: gameConfig.dash_duration_ms,
      dir_x: dir.x,
      dir_y: dir.y,
      dir_z: dir.z,
    };
  }
}
