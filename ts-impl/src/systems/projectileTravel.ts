/**
 * ProjectileTravelSystem
 * Стадия: Simulation
 *
 * Накапливает Projectile.traveled_distance по пути, который снаряд пройдёт за
 * этот тик (|velocity| * effective_dt — та же величина, что интегрирует физика),
 * и уничтожает снаряд по достижении max_distance.
 *
 * До этой системы поле traveled_distance объявлялось как «накапливается»
 * (projectile.yaml), но никто его не обновлял — снаряды жили вечно.
 */

import { GameWorld } from '../ecs/world';
import { Resources } from '../resources/resources';
import { Fixed, add, mul, div, toFixed } from '../fixed/fixed';
import { vec_length_xy } from '../fixed/vector';

export function projectileTravelSystem(
  world: GameWorld,
  resources: Resources
): void {
  const { gameConfig, timeState } = resources;

  // dt в секундах с учётом глобального замедления времени — как в tick.ts
  const dt: Fixed = mul(div(gameConfig.ms_per_tick, toFixed(1000.0)), timeState.time_scale);

  const entities = world.query('Projectile', 'Velocity');
  const toDestroy: bigint[] = [];

  for (const entity of entities) {
    const projectile = entity.Projectile!;
    const velocity = entity.Velocity!;

    // Локальное замедление снаряда (например, иммунитет к time slow)
    let effectiveDt = dt;
    if (entity.LocalTimeScale) {
      effectiveDt = mul(dt, entity.LocalTimeScale.scale);
    }

    const speed = vec_length_xy({ x: velocity.dx, y: velocity.dy, z: velocity.dz });
    const step = mul(speed, effectiveDt);
    projectile.traveled_distance = add(projectile.traveled_distance, step);

    if (projectile.traveled_distance >= projectile.max_distance) {
      toDestroy.push(entity.id);
    }
  }

  // Уничтожаем после обхода, чтобы не мутировать выборку на лету
  for (const id of toDestroy) {
    world.destroy(id);
  }
}
