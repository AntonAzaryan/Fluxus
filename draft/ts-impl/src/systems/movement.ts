/**
 * MovementSystem
 * Стадия: Simulation
 *
 * Конвертирует MoveIntent в Velocity для движения персонажа.
 */

import { GameWorld } from '../ecs/world';
import { Resources } from '../resources/resources';
import {
  vec_length_sq_xy,
  vec_length_xy,
  vec_normalize_xy,
  vec_scale,
  vec_sub,
  Vec3,
} from '../fixed/vector';
import { Fixed, add, mul, ZERO, ONE } from '../fixed/fixed';

export function movementSystem(
  world: GameWorld,
  resources: Resources,
  dt: Fixed
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

    // Целевая скорость: направление намерения * player_move_speed,
    // либо ноль, если клавиши отпущены.
    const moving =
      moveIntent.dx !== ZERO || moveIntent.dy !== ZERO || moveIntent.dz !== ZERO;
    let target: Vec3 = { x: ZERO, y: ZERO, z: ZERO };

    if (moving) {
      const lengthSq = vec_length_sq_xy(intentVec);

      let normalized: Vec3;
      if (lengthSq > ONE) {
        normalized = vec_normalize_xy(intentVec);
      } else {
        normalized = intentVec;
      }

      target = vec_scale(normalized, moveSpeed);
    }

    // Velocity не прыгает на target мгновенно, а идёт к нему ограниченным шагом:
    // player_accel при нажатой клавише, player_decel при отпущенной.
    // effective_dt масштабируем LocalTimeScale ровно как физика
    // (physicsProvider.step) — иначе при замедлении времени разгон занимал бы
    // столько же тиков, но на укороченном пути, и рывок с места выглядел бы резче.
    let effectiveDt = dt;
    if (entity.LocalTimeScale) {
      effectiveDt = mul(dt, entity.LocalTimeScale.scale);
    }
    const maxDelta = mul(
      moving ? gameConfig.player_accel : gameConfig.player_decel,
      effectiveDt
    );

    // Шаг считаем по ВЕКТОРУ разницы, а не покомпонентно: покомпонентный clamp
    // разгонял бы диагональ в √2 раза быстрее прямой.
    const delta = vec_sub(target, { x: velocity.dx, y: velocity.dy, z: velocity.dz });
    const dist = vec_length_xy(delta);

    if (dist <= maxDelta) {
      // За этот тик дошли — садимся точно на target, иначе останется
      // бесконечное подползание на остаточных квантах скорости.
      velocity.dx = target.x;
      velocity.dy = target.y;
    } else {
      const step = vec_scale(vec_normalize_xy(delta), maxDelta);
      velocity.dx = add(velocity.dx, step.x);
      velocity.dy = add(velocity.dy, step.y);
    }

    // MVP: арена плоская, вертикальную скорость не разгоняем.
    velocity.dz = target.z;
  }
}
