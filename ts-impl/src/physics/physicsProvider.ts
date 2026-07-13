/**
 * Physics Provider
 * 
 * Интеграция позиции, broad-phase, narrow-phase, разрешение коллизий.
 * spec/contracts/physics_v1.md
 */

import { Fixed, add, sub, mul, div, max, ZERO, ONE, HALF } from '../fixed/fixed';
import { Vec3, vec_add, vec_sub, vec_scale, interval_overlap } from '../fixed/vector';
import { UniformGrid } from './grid';
import { circleCircle, circleAabb, aabbAabb } from './narrowphase';
import { PhysicsCollision } from './contract';

const CELL_SIZE = toFixed(100.0);

/**
 * Провайдер физики
 */
export class PhysicsProvider {
  private grid = new UniformGrid(CELL_SIZE);
  private collisions: PhysicsCollision[] = [];

  /**
   * Шаг физики
   */
  step(
    world: {
      get(id: bigint): any;
      query(...components: string[]): any[];
      with(component: string): any[];
    },
    dt: Fixed,
    emitCollision: (event: PhysicsCollision) => void
  ): void {
    this.collisions = [];

    // 1. Собрать все физические тела (динамические и статичные), отсортировать
    //    по возрастанию entity_id — гарантия стабильного порядка обхода (contract §8).
    const allBodies = world
      .query('Position', 'Collider')
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const dynamicBodies = allBodies.filter((entity) => entity.DynamicBody);

    // 2. Построить broad-phase grid из ВСЕХ тел — статичные тела (стены, щиты)
    //    тоже должны участвовать, иначе с ними никогда не будет найдена пара.
    this.grid.clear();
    for (const entity of allBodies) {
      this.grid.add(entity.id, entity.Position.x, entity.Position.y);
    }

    // 3. Получить все пары для проверки
    const pairs = this.grid.getPairs();

    // 4. Интеграция и narrow-phase
    const positions = new Map<bigint, { x: Fixed; y: Fixed; z: Fixed }>();
    const velocities = new Map<bigint, { dx: Fixed; dy: Fixed; dz: Fixed }>();

    // Сохранить текущие позиции
    for (const entity of dynamicBodies) {
      if (entity.Position && entity.Velocity) {
        positions.set(entity.id, { ...entity.Position });
        velocities.set(entity.id, { ...entity.Velocity });
      }
    }

    // Интеграция позиций
    for (const entity of dynamicBodies) {
      if (!entity.Position || !entity.Velocity || !entity.DynamicBody) continue;

      const pos = positions.get(entity.id)!;
      const vel = velocities.get(entity.id)!;

      // effective_dt = global_dt * localTimeScale (если есть)
      let effectiveDt = dt;
      if (entity.LocalTimeScale) {
        effectiveDt = mul(dt, entity.LocalTimeScale.scale);
      }

      // Интеграция: pos += vel * dt
      const newPos = {
        x: add(pos.x, mul(vel.dx, effectiveDt)),
        y: add(pos.y, mul(vel.dy, effectiveDt)),
        z: add(pos.z, mul(vel.dz, effectiveDt)),
      };
      
      // Обновляем Map для последующего разрешения коллизий
      positions.set(entity.id, newPos);
      
      // Обновляем entity
      entity.Position.x = newPos.x;
      entity.Position.y = newPos.y;
      entity.Position.z = newPos.z;
    }

    // 5. Narrow-phase и разрешение коллизий
    for (const [idA, idB] of pairs) {
      const entityA = world.get(idA);
      const entityB = world.get(idB);

      if (!entityA || !entityB) continue;
      if (!entityA.Position || !entityB.Position) continue;
      if (!entityA.Collider || !entityB.Collider) continue;

      // Проверка масок коллизий
      if (entityA.CollisionLayer && entityB.CollisionLayer) {
        const layerA = entityA.CollisionLayer.layer;
        const maskA = entityA.CollisionLayer.mask;
        const layerB = entityB.CollisionLayer.layer;
        const maskB = entityB.CollisionLayer.mask;

        const canCollide = ((maskA & layerB) !== 0) && ((maskB & layerA) !== 0);
        if (!canCollide) continue;
      }

      // Narrow-phase
      const collision = this.checkCollision(entityA, entityB);
      if (!collision) continue;

      // Разрешение коллизии
      this.resolveCollision(entityA, entityB, collision, positions, velocities);

      // Событие коллизии
      const event: PhysicsCollision = {
        entity_a: idA < idB ? idA : idB,
        entity_b: idA < idB ? idB : idA,
        contact_point: collision.contactPoint,
        normal: collision.normal,
        penetration: collision.penetration,
      };
      this.collisions.push(event);
    }

    // 6. Обновить позиции после разрешения
    for (const [id, pos] of positions) {
      const entity = world.get(id);
      if (entity && entity.Position) {
        entity.Position.x = pos.x;
        entity.Position.y = pos.y;
        entity.Position.z = pos.z;
      }
    }

    // 6b. Обновить скорости после разрешения (restitution/отражение, contract §4)
    for (const [id, vel] of velocities) {
      const entity = world.get(id);
      if (entity && entity.Velocity) {
        entity.Velocity.dx = vel.dx;
        entity.Velocity.dy = vel.dy;
        entity.Velocity.dz = vel.dz;
      }
    }

    // 7. Сортировка событий и эмиссия
    this.collisions.sort((a, b) => {
      if (a.entity_a < b.entity_a) return -1;
      if (a.entity_a > b.entity_a) return 1;
      if (a.entity_b < b.entity_b) return -1;
      if (a.entity_b > b.entity_b) return 1;
      return 0;
    });

    for (const event of this.collisions) {
      emitCollision(event);
    }
  }

  private checkCollision(
    entityA: any,
    entityB: any
  ): { penetration: Fixed; normal: Vec3; contactPoint: Vec3 } | null {
    const colliderA = entityA.Collider;
    const colliderB = entityB.Collider;
    const posA = entityA.Position;
    const posB = entityB.Position;

    if (colliderA.shape === 'circle' && colliderB.shape === 'circle') {
      return circleCircle(
        posA, colliderA.radius, colliderA.height,
        posB, colliderB.radius, colliderB.height
      );
    }

    if (colliderA.shape === 'circle' && colliderB.shape === 'aabb') {
      // circleAabb возвращает нормаль «от AABB к кругу». Здесь круг — это A,
      // значит нормаль указывает B→A. Контракт (physics_v1.md §5) требует a→b —
      // инвертируем.
      const c = circleAabb(
        posA, colliderA.radius, colliderA.height,
        posB, colliderB.half_width, colliderB.half_height, colliderB.height
      );
      if (!c) return null;
      return { ...c, normal: { x: neg(c.normal.x), y: neg(c.normal.y), z: c.normal.z } };
    }

    if (colliderA.shape === 'aabb' && colliderB.shape === 'circle') {
      // Здесь круг — это B, нормаль «от AABB(A) к кругу(B)» уже a→b.
      return circleAabb(
        posB, colliderB.radius, colliderB.height,
        posA, colliderA.half_width, colliderA.half_height, colliderA.height
      );
    }

    if (colliderA.shape === 'aabb' && colliderB.shape === 'aabb') {
      return aabbAabb(
        posA, colliderA.half_width, colliderA.half_height, colliderA.height,
        posB, colliderB.half_width, colliderB.half_height, colliderB.height
      );
    }

    return null;
  }

  private resolveCollision(
    entityA: any,
    entityB: any,
    collision: { penetration: Fixed; normal: Vec3; contactPoint: Vec3 },
    positions: Map<bigint, { x: Fixed; y: Fixed; z: Fixed }>,
    velocities: Map<bigint, { dx: Fixed; dy: Fixed; dz: Fixed }>
  ): void {
    const posA = positions.get(entityA.id)!;
    const posB = positions.get(entityB.id)!;
    const velA = velocities.get(entityA.id)!;
    const velB = velocities.get(entityB.id)!;

    const bodyA = entityA.DynamicBody;
    const bodyB = entityB.DynamicBody;

    // Если одно тело статичное
    if (!bodyA && !bodyB) return;

    // Позиционное разрешение
    const penetration = collision.penetration;
    const normal = collision.normal;

    // Коэффициент упругости
    const restitution = bodyA && bodyB
      ? max(bodyA.restitution, bodyB.restitution)
      : bodyA ? bodyA.restitution : bodyB.restitution;

    // Разделение позиций
    if (bodyA && bodyB) {
      const totalMass = add(bodyA.mass, bodyB.mass);
      const ratioA = div(bodyB.mass, totalMass);
      const ratioB = div(bodyA.mass, totalMass);

      // Доли ratioA + ratioB == 1, поэтому суммарный сдвиг двух тел = penetration
      // (без деления на 2). Прежний код делал div(penetration, 2n), где 2n —
      // сырой integer: fixed-point div(pen, 2n) раздувал коррекцию в ~32768 раз
      // (2n в Q16.16 = 2/65536) — отсюда «игрок улетает при выстреле».
      const correction = vec_scale(normal, penetration);
      posA.x = sub(posA.x, mul(correction.x, ratioA));
      posA.y = sub(posA.y, mul(correction.y, ratioA));
      posB.x = add(posB.x, mul(correction.x, ratioB));
      posB.y = add(posB.y, mul(correction.y, ratioB));
    } else if (bodyA) {
      // A динамическое, B статичное. normal направлена a->b (A->B), т.е. к телу B,
      // поэтому A выталкивается в противоположную сторону (sub) — наружу.
      const correction = vec_scale(normal, penetration);
      posA.x = sub(posA.x, correction.x);
      posA.y = sub(posA.y, correction.y);
    } else {
      // B динамическое, A статичное
      const correction = vec_scale(normal, penetration);
      posB.x = add(posB.x, correction.x);
      posB.y = add(posB.y, correction.y);
    }

    // Отскок (restitution) — только для столкновения со статичным телом
    // (стена, щит). Между двумя динамическими телами (в этой игре —
    // только Fireball vs Player) физический импульс не считается: попадание
    // снаряда — это урон+уничтожение (см. projectile_hit.yaml), а не упругий
    // удар. Без этого исключения крошечная масса снаряда (0.1) при
    // restitution=1.0 давала нефизично огромный импульс на игрока и сам
    // снаряд — баг «игрок улетает при выстреле».
    if (bodyA && !bodyB) {
      // Отскок от статичного B. normal направлена A->B (к стене), поэтому
      // сближение со стеной = положительная составляющая скорости вдоль нормали.
      const velAlongNormal = add(add(mul(velA.dx, normal.x), mul(velA.dy, normal.y)), mul(velA.dz, normal.z));
      if (velAlongNormal > ZERO) {
        const j = mul(neg(ONE + restitution), velAlongNormal);
        velA.dx = add(velA.dx, mul(normal.x, j));
        velA.dy = add(velA.dy, mul(normal.y, j));
      }
    } else if (bodyB && !bodyA) {
      // Отскок от статичного A. normal направлена A->B (от стены к B), поэтому
      // сближение со стеной = отрицательная составляющая скорости вдоль нормали.
      const velAlongNormal = add(add(mul(velB.dx, normal.x), mul(velB.dy, normal.y)), mul(velB.dz, normal.z));
      if (velAlongNormal < ZERO) {
        const j = mul(neg(ONE + restitution), velAlongNormal);
        velB.dx = add(velB.dx, mul(normal.x, j));
        velB.dy = add(velB.dy, mul(normal.y, j));
      }
    }
  }

  get capabilities() {
    return {
      deterministic: true,
      cross_platform_deterministic: true,
      rollback: false, // Пока без serialize
    };
  }

  serialize(): Uint8Array {
    return new Uint8Array(0);
  }

  deserialize(_data: Uint8Array): void {
    // Нет состояния для десериализации
  }
}

function toFixed(value: number): Fixed {
  return BigInt(Math.round(value * 65536));
}

function neg(a: Fixed): Fixed {
  return -a;
}
