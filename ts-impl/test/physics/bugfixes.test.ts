/**
 * Регресс-тесты на баги из живого теста демки:
 *  A. Каст фаербола выбрасывал игрока и снаряд за экран (div-by-2 в разрешении коллизий).
 *  B. Нормаль коллизии circle↔aabb была не по контракту → игрока толкало ВНУТРЬ стены.
 *  C. Broad-phase не находил пары через границу ячейки → сквозь стены.
 *  E. Снаряд не деспавнился по max_distance (traveled_distance не копился).
 */

import { describe, it, expect } from 'vitest';
import { GameWorld } from '../../src/ecs/world';
import { PhysicsProvider } from '../../src/physics/physicsProvider';
import { UniformGrid } from '../../src/physics/grid';
import { toFixed, fromFixed, ONE, ZERO } from '../../src/fixed/fixed';
import {
  Position, Velocity, Collider, DynamicBody, CollisionLayer,
} from '../../src/components/types';
import { createGameState, tick, TickInput } from '../../src/tick';
import { createPlayerArchetype } from '../../src/archetypes/player';

function worldAdapter(world: GameWorld) {
  return {
    get: (id: bigint) => world.get(id),
    query: (...c: string[]) => world.query(...(c as any)),
    with: (c: string) => world.with(c as any),
  };
}

describe('Bug B/C: коллизия круга со стеной', () => {
  it('выталкивает динамический круг НАРУЖУ стены, а не внутрь', () => {
    const world = new GameWorld();
    const physics = new PhysicsProvider();

    // Круг слева от стены, слегка в ней увяз (правый край круга = 90 > грань 85)
    const circleId = world.spawn({
      Position: new Position(toFixed(70), ZERO, ZERO),
      Velocity: new Velocity(ZERO, ZERO, ZERO),
      Collider: new Collider('circle', toFixed(20), ZERO, ZERO, toFixed(30)),
      DynamicBody: new DynamicBody(ONE, ZERO, ZERO),
      CollisionLayer: new CollisionLayer(1, 0b1111),
    });
    // Стена: aabb [85..115]
    world.spawn({
      Position: new Position(toFixed(100), ZERO, ZERO),
      Collider: new Collider('aabb', ZERO, toFixed(15), toFixed(40), toFixed(30)),
      CollisionLayer: new CollisionLayer(2, 0b1111),
    } as any);

    physics.step(worldAdapter(world), toFixed(0.016), () => {});

    const x = fromFixed(world.get(circleId)!.Position!.x);
    // Должен уехать ВЛЕВО (наружу), к грани 85 - радиус 20 = 65, а не вправо в стену
    expect(x).toBeLessThan(70);
    expect(x).toBeCloseTo(65, 1);
  });

  it('выталкивает круг, чей центр оказался ВНУТРИ стены', () => {
    const world = new GameWorld();
    const physics = new PhysicsProvider();

    const circleId = world.spawn({
      Position: new Position(toFixed(100), ZERO, ZERO), // ровно в центре стены
      Velocity: new Velocity(ZERO, ZERO, ZERO),
      Collider: new Collider('circle', toFixed(20), ZERO, ZERO, toFixed(30)),
      DynamicBody: new DynamicBody(ONE, ZERO, ZERO),
      CollisionLayer: new CollisionLayer(1, 0b1111),
    });
    world.spawn({
      Position: new Position(toFixed(100), ZERO, ZERO),
      Collider: new Collider('aabb', ZERO, toFixed(15), toFixed(40), toFixed(30)),
      CollisionLayer: new CollisionLayer(2, 0b1111),
    } as any);

    physics.step(worldAdapter(world), toFixed(0.016), () => {});

    const p = world.get(circleId)!.Position!;
    // Центр вытолкнут за пределы AABB [85..115] хотя бы по одной оси
    const insideX = fromFixed(p.x) > 85 && fromFixed(p.x) < 115;
    const insideY = fromFixed(p.y) > -40 && fromFixed(p.y) < 40;
    expect(insideX && insideY).toBe(false);
  });
});

describe('Bug C: broad-phase через границу ячейки', () => {
  it('getPairs находит пару в соседних ячейках', () => {
    const grid = new UniformGrid(toFixed(100));
    grid.add(BigInt(1), toFixed(99), ZERO);   // ячейка 0
    grid.add(BigInt(2), toFixed(101), ZERO);  // ячейка 1 (соседняя)
    const pairs = grid.getPairs();
    expect(pairs.length).toBe(1);
    expect(pairs[0][0]).toBe(BigInt(1));
    expect(pairs[0][1]).toBe(BigInt(2));
  });
});

describe('Bug A: каст фаербола не выбрасывает игрока/снаряд', () => {
  it('игрок остаётся у нуля, фаербол летит и остаётся конечным', () => {
    const gs = createGameState();
    const { world } = gs;
    const pa = createPlayerArchetype();
    const playerId = world.spawn({
      Position: pa.Position, Velocity: pa.Velocity, Collider: pa.Collider,
      DynamicBody: pa.DynamicBody, Health: pa.Health, Cooldowns: pa.Cooldowns,
      MoveIntent: pa.MoveIntent, CollisionLayer: pa.CollisionLayer,
    });

    const cast: TickInput = { commands: [{
      type: 'CastFireballInput', player_id: playerId,
      target_x: toFixed(1000), target_y: ZERO, target_z: ZERO,
    } as any] };
    tick(gs, cast);
    for (let i = 0; i < 5; i++) tick(gs, { commands: [] });

    const player = world.get(playerId)!;
    // Игрока не выбросило: |позиция| мала (раньше было ~-43701)
    expect(Math.abs(fromFixed(player.Position!.x))).toBeLessThan(50);
    expect(Math.abs(fromFixed(player.Position!.y))).toBeLessThan(50);
    // Урона от собственного снаряда нет
    expect(fromFixed(player.Health!.current)).toBe(fromFixed(player.Health!.max));

    const fb = world.all().find((e) => (e as any).Projectile);
    expect(fb).toBeDefined();
    // Фаербол улетел от игрока (виден и движется), но остался конечным
    const fbx = fromFixed(fb!.Position!.x);
    expect(fbx).toBeGreaterThan(20);
    expect(fbx).toBeLessThan(1000);
  });
});

describe('Bug: рывок (dash) завершается, а не летит вечно', () => {
  it('Dash снимается через ~dash_duration_ms и скорость возвращается к обычной', () => {
    const gs = createGameState();
    const { world } = gs;
    const pa = createPlayerArchetype();
    const playerId = world.spawn({
      Position: pa.Position, Velocity: pa.Velocity, Collider: pa.Collider,
      DynamicBody: pa.DynamicBody, Health: pa.Health, Cooldowns: pa.Cooldowns,
      MoveIntent: pa.MoveIntent, CollisionLayer: pa.CollisionLayer,
    });

    // Тик 0: направление влево + рывок
    tick(gs, { commands: [
      { type: 'MoveCommandInput', player_id: playerId, dx: toFixed(-1), dy: ZERO, dz: ZERO } as any,
      { type: 'DashInput', player_id: playerId } as any,
    ] });
    // Рывок активен, скорость рывка (dash_speed=1200)
    expect((world.get(playerId) as any).Dash).toBeDefined();
    expect(Math.abs(fromFixed(world.get(playerId)!.Velocity!.dx))).toBeGreaterThan(1000);

    // dash_duration_ms=200мс ≈ 12 тиков. Продолжаем держать влево.
    for (let i = 0; i < 20; i++) {
      tick(gs, { commands: [
        { type: 'MoveCommandInput', player_id: playerId, dx: toFixed(-1), dy: ZERO, dz: ZERO } as any,
      ] });
    }

    const p = world.get(playerId)!;
    // Рывок закончился
    expect((p as any).Dash).toBeUndefined();
    // Скорость вернулась к обычной ходьбе (<= player_move_speed=300), а не 1200
    expect(Math.abs(fromFixed(p.Velocity!.dx))).toBeLessThanOrEqual(300);
  });

  it('без направления (стоя на месте) рывок не срабатывает', () => {
    const gs = createGameState();
    const { world } = gs;
    const pa = createPlayerArchetype();
    const playerId = world.spawn({
      Position: pa.Position, Velocity: pa.Velocity, Collider: pa.Collider,
      DynamicBody: pa.DynamicBody, Health: pa.Health, Cooldowns: pa.Cooldowns,
      MoveIntent: pa.MoveIntent, CollisionLayer: pa.CollisionLayer,
    });
    tick(gs, { commands: [{ type: 'DashInput', player_id: playerId } as any] });
    expect((world.get(playerId) as any).Dash).toBeUndefined();
  });
});

describe('Bug E: снаряд деспавнится по max_distance', () => {
  it('фаербол исчезает, пролетев дистанцию больше max_distance', () => {
    const gs = createGameState();
    const { world } = gs;
    const pa = createPlayerArchetype();
    const playerId = world.spawn({
      Position: pa.Position, Velocity: pa.Velocity, Collider: pa.Collider,
      DynamicBody: pa.DynamicBody, Health: pa.Health, Cooldowns: pa.Cooldowns,
      MoveIntent: pa.MoveIntent, CollisionLayer: pa.CollisionLayer,
    });

    tick(gs, { commands: [{
      type: 'CastFireballInput', player_id: playerId,
      target_x: toFixed(100000), target_y: ZERO, target_z: ZERO,
    } as any] });

    // fireball_speed=800, dt≈1/60 → ~13.3 ед/тик; max_distance=600 → ~45 тиков.
    // 80 тиков заведомо больше.
    for (let i = 0; i < 80; i++) tick(gs, { commands: [] });

    const fb = world.all().find((e) => (e as any).Projectile);
    expect(fb).toBeUndefined();
  });
});
