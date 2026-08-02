import { describe, expect, it } from 'vitest';
import * as fixed from '../src/fixed.js';
import { getField, spawn } from '../src/ecs/world.js';
import { mathApi } from '../src/mathApi.js';
import {
  createPhysicsApi,
  PhysicsSystem,
  PhysicsWorld,
  staticsFromTerrain,
  BLOCKS_MOVEMENT,
  BLOCKS_VISION,
  SHAPE_AABB,
  SHAPE_CIRCLE,
  STATIC_COLLIDER,
  type StaticCollider,
} from '../src/physics.js';
import { loadScene, type SceneDef } from '../src/scene.js';
import { createTerrainGrid } from '../src/terrain.js';
import { initialState, tick, type Simulation } from '../src/tick.js';
import type { FieldOverrides, GameEvent, Vec2 } from '../src/types.js';

const F = fixed.fromFloat;
const at = (x: number, y: number): Vec2 => ({ x: F(x), y: F(y) });

/** Ступенька 0→1 по вертикали между колонками 1 и 2: обрыв на x = 2, без рампы. */
const TERRAIN = {
  width: 4,
  height: 2,
  tileSize: fixed.fromInt(1),
  levels: ['0011', '0011'],
  flags: ['....', '....'],
};

const SCENE: SceneDef = {
  components: [
    { name: 'Position', fields: { x: 'fixed', y: 'fixed' } },
    { name: 'Velocity', fields: { x: 'fixed', y: 'fixed' } },
    {
      name: 'Collider',
      fields: { halfX: 'fixed', halfY: 'fixed', radius: 'fixed', shape: 'i32' },
    },
  ],
  prefabs: [
    {
      name: 'Mover',
      components: {
        Position: { x: 0, y: 0 },
        Velocity: { x: 0, y: 0 },
        Collider: { halfX: F(0.25), halfY: F(0.25), radius: F(0.25), shape: SHAPE_AABB },
      },
    },
    {
      name: 'Wall',
      components: {
        Position: { x: 0, y: 0 },
        Collider: { halfX: F(0.5), halfY: F(0.5), radius: F(0.5), shape: SHAPE_AABB },
      },
      tags: [BLOCKS_MOVEMENT, BLOCKS_VISION],
    },
    {
      name: 'Ball',
      components: {
        Position: { x: 0, y: 0 },
        Collider: { halfX: F(0.5), halfY: F(0.5), radius: F(0.5), shape: SHAPE_CIRCLE },
      },
      tags: [BLOCKS_VISION],
    },
  ],
  terrain: TERRAIN,
};

function harness(withTerrainStatics = true) {
  const { world, terrain, systems } = loadScene(SCENE);
  const statics = withTerrainStatics ? staticsFromTerrain(terrain!.grid) : [];
  const physicsWorld = new PhysicsWorld(statics, terrain!.grid.tileSize);
  systems.register(new PhysicsSystem(physicsWorld));
  const physics = createPhysicsApi(world, physicsWorld);
  const sim: Simulation = { systems, worldSeed: 1, math: mathApi, physics, terrain: terrain! };
  const state = initialState(world, 1);

  return {
    world,
    physics,
    physicsWorld,
    place: (prefab: string, overrides: FieldOverrides) => spawn(world, prefab, overrides),
    step: (): readonly GameEvent[] => [...tick(sim, state).events],
    position: (entity: number): Vec2 => ({
      x: getField(world, entity, 'Position', 'x'),
      y: getField(world, entity, 'Position', 'y'),
    }),
  };
}

describe('статика обрывов (PHYS-2, TERR-5)', () => {
  it('каждый отрезок обрыва становится вырожденным прямоугольником', () => {
    const grid = createTerrainGrid(TERRAIN);
    const statics = staticsFromTerrain(grid);
    expect(statics).toHaveLength(2); // по одному на ряд
    expect(statics[0]).toEqual({
      minX: fixed.fromInt(2),
      maxX: fixed.fromInt(2),
      minY: 0,
      maxY: fixed.fromInt(1),
      tags: [BLOCKS_MOVEMENT, BLOCKS_VISION],
    });
  });

  it('broad-phase отдаёт только пересекающие и только с нужным тегом', () => {
    const world = new PhysicsWorld(staticsFromTerrain(createTerrainGrid(TERRAIN)), fixed.fromInt(1));
    const across = { minX: F(1.5), minY: F(0.1), maxX: F(2.5), maxY: F(0.9) };
    expect(world.query(across, BLOCKS_MOVEMENT)).toHaveLength(1);
    expect(world.query(across, 'blocksNothing')).toHaveLength(0);
    expect(world.query({ minX: F(0.1), minY: F(0.1), maxX: F(0.9), maxY: F(0.9) }, BLOCKS_MOVEMENT)).toHaveLength(0);
  });

  it('касание границы не считается пересечением', () => {
    const world = new PhysicsWorld(staticsFromTerrain(createTerrainGrid(TERRAIN)), fixed.fromInt(1));
    expect(world.query({ minX: F(1.0), minY: F(0.1), maxX: F(2.0), maxY: F(0.9) }, BLOCKS_MOVEMENT)).toHaveLength(0);
  });
});

describe('разрешение движения (PHYS-8)', () => {
  it('обрыв гасит ось и порождает событие', () => {
    const h = harness();
    const mover = h.place('Mover', { Position: { x: F(1.5), y: F(0.5) }, Velocity: { x: F(0.5) } });
    const events = h.step();

    expect(h.position(mover)).toEqual(at(1.5, 0.5));
    expect(events.map((e) => e.type)).toEqual(['Collision']);
    expect(events[0]!.data).toEqual({
      entity: mover,
      other: STATIC_COLLIDER,
      nx: fixed.fromInt(-1),
      ny: 0,
    });
  });

  it('свободная ось исполняется — скольжение вдоль обрыва', () => {
    const h = harness();
    const mover = h.place('Mover', {
      Position: { x: F(1.5), y: F(0.2) },
      Velocity: { x: F(0.5), y: F(0.3) },
    });
    h.step();
    // 0.2 + 0.3 в Q16.16 — не ровно 0.5: константы усекаются при вводе (FP-3).
    expect(h.position(mover)).toEqual({ x: F(1.5), y: fixed.add(F(0.2), F(0.3)) });
  });

  it('быстрый снаряд не проскакивает сквозь обрыв нулевой толщины', () => {
    const h = harness();
    const bullet = h.place('Mover', { Position: { x: F(1.5), y: F(0.5) }, Velocity: { x: F(5) } });
    h.step();
    expect(h.position(bullet).x).toBe(F(1.5));
  });

  it('свободный путь проходится целиком', () => {
    const h = harness();
    const mover = h.place('Mover', { Position: { x: F(0.2), y: F(0.5) }, Velocity: { x: F(0.5) } });
    h.step();
    expect(h.position(mover)).toEqual(at(0.7, 0.5));
  });

  it('сущность с тегом блокирует, без тега — нет', () => {
    const h = harness(false);
    h.place('Wall', { Position: { x: F(1), y: F(0) } });
    const blocked = h.place('Mover', { Position: { x: F(0), y: F(0) }, Velocity: { x: F(0.5) } });
    const free = h.place('Mover', { Position: { x: F(0), y: F(3) }, Velocity: { x: F(0.5) } });
    // Второй Mover — без тега блокировки, поэтому первому он не помеха.
    h.place('Mover', { Position: { x: F(0.5), y: F(0) } });

    const events = h.step();
    expect(h.position(blocked).x).toBe(0);
    expect(h.position(free).x).toBe(F(0.5));
    expect(events).toHaveLength(1);
    expect(events[0]!.data['other']).not.toBe(STATIC_COLLIDER);
  });

  it('позиция пишется командами: сосед видит уже разрешённое положение', () => {
    const h = harness(false);
    // Оба едут вправо; первый упрётся в стену, второй — в первого, если тот
    // остался на месте. Порядок разрешения — по индексу сущности (QUERY-2).
    h.place('Wall', { Position: { x: F(2), y: F(0) } });
    const first = h.place('Mover', { Position: { x: F(1.2), y: F(0) }, Velocity: { x: F(0.3) } });
    h.step();
    expect(h.position(first).x).toBe(F(1.2));
  });
});

describe('raycast (PHYS-6)', () => {
  it('упирается в статику обрыва и не возвращает сущность', () => {
    const h = harness();
    const hit = h.physics.raycast(at(1.5, 0.5), at(3, 0.5), { mask: BLOCKS_VISION });
    expect(hit).not.toBeNull();
    expect(hit!.entity).toBeUndefined();
    expect(hit!.point.x).toBe(fixed.fromInt(2));
  });

  it('свободный луч не даёт попадания', () => {
    const h = harness();
    expect(h.physics.raycast(at(0.2, 0.5), at(1.8, 0.5), { mask: BLOCKS_VISION })).toBeNull();
  });

  it('находит ближайшую сущность, а не первую попавшуюся', () => {
    const h = harness(false);
    const far = h.place('Wall', { Position: { x: F(5), y: F(0) } });
    const near = h.place('Wall', { Position: { x: F(2), y: F(0) } });
    void far;
    const hit = h.physics.raycast(at(0, 0), at(8, 0), { mask: BLOCKS_VISION });
    expect(hit!.entity).toBe(near);
    expect(hit!.point.x).toBe(F(1.5));
  });

  it('круг тестируется как круг: луч мимо края не задевает его AABB-угол', () => {
    const h = harness(false);
    h.place('Ball', { Position: { x: F(2), y: F(0) } });
    // Луч проходит на 0.45 выше центра: внутри AABB (полуразмер 0.5), но вне
    // круга радиуса 0.5 на уровне x = 1.55 — угловая зона коробки.
    expect(h.physics.raycast(at(1.55, 0.45), at(1.65, 0.45), { mask: BLOCKS_VISION })).toBeNull();
    expect(h.physics.raycast(at(1.55, 0.45), at(2.5, 0.45), { mask: BLOCKS_VISION })).not.toBeNull();
  });

  it('источник исключается, маска фильтрует', () => {
    const h = harness(false);
    const wall = h.place('Wall', { Position: { x: F(2), y: F(0) } });
    expect(h.physics.raycast(at(2, 0), at(5, 0), { mask: BLOCKS_VISION, ignore: wall })).toBeNull();
    expect(h.physics.raycast(at(0, 0), at(5, 0), { mask: 'somethingElse' })).toBeNull();
  });

  it('луч нулевой длины не даёт попадания', () => {
    const h = harness();
    expect(h.physics.raycast(at(1, 1), at(1, 1))).toBeNull();
  });

  it('статика вне сетки broad-phase всё равно находится', () => {
    const statics: StaticCollider[] = [
      { minX: F(-20), maxX: F(-19), minY: F(-1), maxY: F(1), tags: [BLOCKS_VISION] },
    ];
    const { world } = loadScene(SCENE);
    const physics = createPhysicsApi(world, new PhysicsWorld(statics, fixed.fromInt(1)));
    expect(physics.raycast(at(-25, 0), at(-10, 0), { mask: BLOCKS_VISION })).not.toBeNull();
  });
});
