/**
 * MovementSystem
 * Стадия: Simulation
 * 
 * Конвертирует MoveIntent в Velocity для движения персонажа.
 */

import { GameWorld } from '../ecs/world';
import { Resources } from '../resources/resources';
import { vec_length_sq_xy, vec_normalize_xy, Vec3 } from '../fixed/vector';
import { mul, ZERO, ONE } from '../fixed/fixed';

export function movementSystem(
  world: GameWorld,
  resources: Resources
): void {
  const { gameConfig } = resources;
  const moveSpeed = gameConfig.player_move_speed;

  // Для каждой сущности с Position, Velocity, MoveIntent
  const entities = world.query('Position', 'Velocity', 'MoveIntent');

  for (const entity of entities) {
    // Если есть активный рывок — пропустить
    if (entity.Dash) continue;

    // Если мёртв — не двигаться
    if (entity.Dead) continue;

    const moveIntent = entity.MoveIntent!;
    const velocity = entity.Velocity!;

    const intentVec: Vec3 = {
      x: moveIntent.dx,
      y: moveIntent.dy,
      z: moveIntent.dz,
    };

    if (moveIntent.dx !== ZERO || moveIntent.dy !== ZERO || moveIntent.dz !== ZERO) {
      const lengthSq = vec_length_sq_xy(intentVec);

      let normalized: Vec3;
      if (lengthSq > ONE) {
        normalized = vec_normalize_xy(intentVec);
      } else {
        normalized = intentVec;
      }

      // Установить Velocity
      velocity.dx = mul(normalized.x, moveSpeed);
      velocity.dy = mul(normalized.y, moveSpeed);
      velocity.dz = mul(normalized.z, moveSpeed);
    } else {
      // Остановить персонажа
      velocity.dx = ZERO;
      velocity.dy = ZERO;
      velocity.dz = ZERO;
    }
  }
}
