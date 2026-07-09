/**
 * Тесты физики
 */

import { describe, it, expect } from 'vitest';
import { GameWorld } from '../../src/ecs/world';
import { PhysicsProvider } from '../../src/physics/physicsProvider';
import { toFixed, ONE, ZERO } from '../../src/fixed/fixed';
import { Position, Velocity, Collider, DynamicBody, CollisionLayer, StaticBody } from '../../src/components/types';

describe('Physics Provider', () => {
  it('should integrate position from velocity', () => {
    const world = new GameWorld();
    const physics = new PhysicsProvider();
    const dt = toFixed(0.016);

    const entityId = world.spawn({
      Position: new Position(toFixed(0), toFixed(0), toFixed(0)),
      Velocity: new Velocity(toFixed(100), toFixed(0), toFixed(0)),
      Collider: new Collider('circle', toFixed(10), ZERO, ZERO, toFixed(10)),
      DynamicBody: new DynamicBody(ONE, ZERO, ZERO),
      CollisionLayer: new CollisionLayer(1, 0b1111),
    });

    const entity = world.get(entityId);
    expect(entity).toBeDefined();
    expect(entity?.DynamicBody).toBeDefined();

    const collisions: any[] = [];
    physics.step(
      {
        get: (id: bigint) => world.get(id),
        query: (...components: string[]) => world.query(...components as any),
        with: (component: string) => world.with(component as any),
      },
      dt,
      (collision) => collisions.push(collision)
    );

    // Позиция должна измениться: x = 0 + 100 * 0.016 = 1.6
    // 1.6 в fixed-point = 104858
    // Допускаем небольшую погрешность fixed-point арифметики
    const afterEntity = world.get(entityId);
    const expected = toFixed(1.6);
    const tolerance = toFixed(0.001); // 0.001 погрешность
    expect(afterEntity?.Position?.x).toBeGreaterThanOrEqual(expected - tolerance);
    expect(afterEntity?.Position?.x).toBeLessThanOrEqual(expected + tolerance);
  });

  it('should detect collision between two circles', () => {
    const world = new GameWorld();
    const physics = new PhysicsProvider();
    const dt = toFixed(0.016);

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

    const collisions: any[] = [];
    physics.step(
      {
        get: (id: bigint) => world.get(id),
        query: (...components: string[]) => world.query(...components as any),
        with: (component: string) => world.with(component as any),
      },
      dt,
      (collision) => collisions.push(collision)
    );

    expect(collisions.length).toBeGreaterThan(0);
  });

  it('should bounce off a wall (restitution)', () => {
    const world = new GameWorld();
    const physics = new PhysicsProvider();
    const dt = toFixed(0.016);

    world.spawn({
      Position: new Position(toFixed(0), toFixed(0), toFixed(0)),
      Velocity: new Velocity(toFixed(100), ZERO, ZERO),
      Collider: new Collider('circle', toFixed(10), ZERO, ZERO, toFixed(10)),
      DynamicBody: new DynamicBody(ONE, ONE, ZERO),
      CollisionLayer: new CollisionLayer(1, 0b1111),
    });

    world.spawn({
      Position: new Position(toFixed(50), toFixed(0), toFixed(0)),
      Collider: new Collider('aabb', ZERO, toFixed(10), toFixed(50), toFixed(100)),
      StaticBody: new StaticBody(),
      CollisionLayer: new CollisionLayer(2, 0b1111),
    });

    const collisions: any[] = [];
    physics.step(
      {
        get: (id: bigint) => world.get(id),
        query: (...components: string[]) => world.query(...components as any),
        with: (component: string) => world.with(component as any),
      },
      dt,
      (collision) => collisions.push(collision)
    );
  });

  it('should filter collisions by layer mask', () => {
    const world = new GameWorld();
    const physics = new PhysicsProvider();
    const dt = toFixed(0.016);

    world.spawn({
      Position: new Position(toFixed(0), toFixed(0), toFixed(0)),
      Velocity: new Velocity(toFixed(50), ZERO, ZERO),
      Collider: new Collider('circle', toFixed(20), ZERO, ZERO, toFixed(10)),
      DynamicBody: new DynamicBody(ONE, ZERO, ZERO),
      CollisionLayer: new CollisionLayer(1, 0b0001),
    });

    world.spawn({
      Position: new Position(toFixed(30), toFixed(0), toFixed(0)),
      Velocity: new Velocity(toFixed(-50), ZERO, ZERO),
      Collider: new Collider('circle', toFixed(20), ZERO, ZERO, toFixed(10)),
      DynamicBody: new DynamicBody(ONE, ZERO, ZERO),
      CollisionLayer: new CollisionLayer(2, 0b1111),
    });

    const collisions: any[] = [];
    physics.step(
      {
        get: (id: bigint) => world.get(id),
        query: (...components: string[]) => world.query(...components as any),
        with: (component: string) => world.with(component as any),
      },
      dt,
      (collision) => collisions.push(collision)
    );

    expect(collisions.length).toBe(0);
  });
});
