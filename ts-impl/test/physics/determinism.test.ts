/**
 * Тесты на детерминизм физики
 * 
 * Проверяют, что одинаковые входы дают одинаковые выходы
 * при многократном запуске с одинаковым seed.
 */

import { describe, it, expect } from 'vitest';
import { GameWorld } from '../../src/ecs/world';
import { PhysicsProvider } from '../../src/physics/physicsProvider';
import { toFixed, ONE, ZERO } from '../../src/fixed/fixed';
import { Position, Velocity, Collider, DynamicBody, CollisionLayer, StaticBody } from '../../src/components/types';
import { pcg32_srandom, next_u32 } from '../../src/rng/pcg32';

/**
 * Сериализует состояние мира для сравнения
 */
function serializeWorld(world: GameWorld): string {
  const entities = world.all().map(e => ({
    id: e.id.toString(),
    x: e.Position?.x.toString() ?? null,
    y: e.Position?.y.toString() ?? null,
    z: e.Position?.z.toString() ?? null,
    dx: e.Velocity?.dx.toString() ?? null,
    dy: e.Velocity?.dy.toString() ?? null,
    dz: e.Velocity?.dz.toString() ?? null,
  }));
  return JSON.stringify(entities);
}

/**
 * Создаёт тестовый сценарий с двумя сталкивающимися телами
 */
function createCollisionScenario(): GameWorld {
  const world = new GameWorld();

  world.spawn({
    Position: new Position(toFixed(0), toFixed(0), toFixed(0)),
    Velocity: new Velocity(toFixed(50), ZERO, ZERO),
    Collider: new Collider('circle', toFixed(20), ZERO, ZERO, toFixed(10)),
    DynamicBody: new DynamicBody(ONE, toFixed(0.5), ZERO),
    CollisionLayer: new CollisionLayer(1, 0b1111),
  });

  world.spawn({
    Position: new Position(toFixed(30), toFixed(0), toFixed(0)),
    Velocity: new Velocity(toFixed(-50), ZERO, ZERO),
    Collider: new Collider('circle', toFixed(20), ZERO, ZERO, toFixed(10)),
    DynamicBody: new DynamicBody(ONE, toFixed(0.5), ZERO),
    CollisionLayer: new CollisionLayer(2, 0b1111),
  });

  return world;
}

/**
 * Создаёт сценарий с гравитацией и полом
 */
function createGravityScenario(): GameWorld {
  const world = new GameWorld();

  // Падающий объект
  world.spawn({
    Position: new Position(toFixed(100), toFixed(100), toFixed(0)),
    Velocity: new Velocity(ZERO, toFixed(-10), ZERO),
    Collider: new Collider('circle', toFixed(5), ZERO, ZERO, toFixed(5)),
    DynamicBody: new DynamicBody(ONE, ZERO, ZERO),
    CollisionLayer: new CollisionLayer(1, 0b1111),
  });

  // Пол
  world.spawn({
    Position: new Position(toFixed(100), toFixed(0), toFixed(0)),
    Collider: new Collider('aabb', ZERO, toFixed(100), toFixed(10), toFixed(10)),
    StaticBody: new StaticBody(),
    CollisionLayer: new CollisionLayer(2, 0b1111),
  });

  return world;
}

describe('Physics Determinism', () => {
  it('should produce identical results for collision scenario (5 runs)', () => {
    const numRuns = 5;
    const dt = toFixed(0.016);
    const results: string[] = [];

    for (let i = 0; i < numRuns; i++) {
      const world = createCollisionScenario();
      const physics = new PhysicsProvider();
      const collisions: any[] = [];

      // 10 шагов физики
      for (let step = 0; step < 10; step++) {
        physics.step(
          {
            get: (id: bigint) => world.get(id),
            query: (...components: string[]) => world.query(...components as any),
            with: (component: string) => world.with(component as any),
          },
          dt,
          (collision) => collisions.push({ ...collision })
        );
      }

      results.push(serializeWorld(world));
    }

    // Все результаты должны быть идентичны
    for (let i = 1; i < numRuns; i++) {
      expect(results[i]).toBe(results[0]);
    }
  });

  it('should produce identical results for gravity scenario (5 runs)', () => {
    const numRuns = 5;
    const dt = toFixed(0.016);
    const results: string[] = [];

    for (let i = 0; i < numRuns; i++) {
      const world = createGravityScenario();
      const physics = new PhysicsProvider();
      const collisions: any[] = [];

      // 20 шагов физики (падение + столкновение с полом)
      for (let step = 0; step < 20; step++) {
        physics.step(
          {
            get: (id: bigint) => world.get(id),
            query: (...components: string[]) => world.query(...components as any),
            with: (component: string) => world.with(component as any),
          },
          dt,
          (collision) => collisions.push({ ...collision })
        );
      }

      results.push(serializeWorld(world));
    }

    // Все результаты должны быть идентичны
    for (let i = 1; i < numRuns; i++) {
      expect(results[i]).toBe(results[0]);
    }
  });

  it('should produce identical collision impulses (3 runs)', () => {
    const numRuns = 3;
    const dt = toFixed(0.016);
    const allCollisions: any[][] = [];

    for (let i = 0; i < numRuns; i++) {
      const world = createCollisionScenario();
      const physics = new PhysicsProvider();
      const collisions: any[] = [];

      // 5 шагов физики
      for (let step = 0; step < 5; step++) {
        physics.step(
          {
            get: (id: bigint) => world.get(id),
            query: (...components: string[]) => world.query(...components as any),
            with: (component: string) => world.with(component as any),
          },
          dt,
          (collision) => collisions.push({
            a_id: collision.a_id,
            b_id: collision.b_id,
            normal: collision.normal,
            depth: collision.depth,
          })
        );
      }

      allCollisions.push(collisions);
    }

    // Все коллизии должны быть идентичны
    for (let i = 1; i < numRuns; i++) {
      expect(allCollisions[i].length).toBe(allCollisions[0].length);
      for (let j = 0; j < allCollisions[i].length; j++) {
        expect(allCollisions[i][j]).toEqual(allCollisions[0][j]);
      }
    }
  });

  it('should be deterministic with multiple entities (stress test)', () => {
    const numRuns = 3;
    const dt = toFixed(0.016);
    const numEntities = 10;
    const results: string[] = [];

    for (let run = 0; run < numRuns; run++) {
      const world = new GameWorld();

      // Создаём 10 объектов с разными начальными позициями
      for (let i = 0; i < numEntities; i++) {
        world.spawn({
          Position: new Position(
            toFixed(i * 10),
            toFixed(i * 5),
            ZERO
          ),
          Velocity: new Velocity(
            toFixed(i),
            toFixed(-i),
            ZERO
          ),
          Collider: new Collider('circle', toFixed(5), ZERO, ZERO, toFixed(5)),
          DynamicBody: new DynamicBody(ONE, toFixed(0.3), ZERO),
          CollisionLayer: new CollisionLayer(1, 0b1111),
        });
      }

      const physics = new PhysicsProvider();
      const collisions: any[] = [];

      // 15 шагов физики
      for (let step = 0; step < 15; step++) {
        physics.step(
          {
            get: (id: bigint) => world.get(id),
            query: (...components: string[]) => world.query(...components as any),
            with: (component: string) => world.with(component as any),
          },
          dt,
          (collision) => collisions.push({ ...collision })
        );
      }

      results.push(serializeWorld(world));
    }

    // Все результаты должны быть идентичны
    for (let i = 1; i < numRuns; i++) {
      expect(results[i]).toBe(results[0]);
    }
  });
});
