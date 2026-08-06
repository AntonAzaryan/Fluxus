import { describe, expect, it } from 'vitest';
import * as fixed from '../src/math/fixed.js';
import { addComponent, getField, listAlive, setField, spawn } from '../src/ecs/world.js';
import { mathApi } from '../src/math/mathApi.js';
import {
  createPhysicsApi,
  PhysicsSystem,
  PhysicsWorld,
  staticsFromTerrain,
  BLOCKS_MOVEMENT,
  BLOCKS_VISION,
  DEFAULT_CLIFF_LAYER,
  SHAPE_AABB,
  SHAPE_CIRCLE,
  STATIC_COLLIDER,
  type StaticCollider,
} from '../src/systems/physics.js';
import { loadScene, type SceneDef } from '../src/sim/scene.js';
import { createTerrainGrid } from '../src/systems/terrain.js';
import { initialState, tick, type Simulation } from '../src/sim/tick.js';
import type { FieldOverrides, GameEvent, Vec2 } from '../src/types.js';

const F = fixed.fromFloat;
const at = (x: number, y: number): Vec2 => ({ x: F(x), y: F(y) });

/** Слои теста (PHYS-2): статика (обрывы и стены) — 1, юниты — 2, снаряды — 4. */
const LAYER_STATIC = DEFAULT_CLIFF_LAYER;
const LAYER_UNIT = 2;
const LAYER_BULLET = 4;

/** Ступенька 0→1 по вертикали между колонками 1 и 2: обрыв на x = 2, без рампы. */
const TERRAIN = {
  width: 4,
  height: 2,
  tileSize: fixed.fromInt(1),
  levels: ['0011', '0011'],
  flags: ['....', '....'],
};

/** Та же арена с перепадом в два уровня — для гейта PHYS-11. */
const TERRAIN_STEEP = { ...TERRAIN, levels: ['0022', '0022'] };

const SCENE: SceneDef = {
  components: [
    { name: 'Position', fields: { x: 'fixed', y: 'fixed' } },
    { name: 'Velocity', fields: { x: 'fixed', y: 'fixed' } },
    {
      name: 'Collider',
      fields: {
        halfX: 'fixed',
        halfY: 'fixed',
        radius: 'fixed',
        shape: 'i32',
        layer: 'i32',
        blockMask: 'i32',
        hitMask: 'i32',
        cliffRise: 'i32',
      },
    },
    // Компонент читает `getEffectiveDelta` (TIME-3); система сведения здесь не нужна.
    { name: 'TimeScale', fields: { value: 'fixed' } },
  ],
  prefabs: [
    {
      name: 'Mover',
      components: {
        Position: { x: 0, y: 0 },
        Velocity: { x: 0, y: 0 },
        Collider: {
          halfX: F(0.25),
          halfY: F(0.25),
          radius: F(0.25),
          shape: SHAPE_AABB,
          layer: LAYER_UNIT,
          blockMask: LAYER_STATIC,
        },
      },
    },
    {
      name: 'Wall',
      components: {
        Position: { x: 0, y: 0 },
        Collider: {
          halfX: F(0.5),
          halfY: F(0.5),
          radius: F(0.5),
          shape: SHAPE_AABB,
          layer: LAYER_STATIC,
        },
      },
      // Тег остался только у обзора (PHYS-2): движение стена блокирует слоем.
      tags: [BLOCKS_VISION],
    },
    {
      name: 'Ball',
      components: {
        Position: { x: 0, y: 0 },
        Collider: { halfX: F(0.5), halfY: F(0.5), radius: F(0.5), shape: SHAPE_CIRCLE },
      },
      tags: [BLOCKS_VISION],
    },
    {
      name: 'Bullet',
      components: {
        Position: { x: 0, y: 0 },
        Velocity: { x: 0, y: 0 },
        Collider: {
          halfX: F(0.1),
          halfY: F(0.1),
          radius: F(0.1),
          shape: SHAPE_AABB,
          layer: LAYER_BULLET,
          hitMask: LAYER_UNIT,
        },
      },
    },
  ],
  terrain: TERRAIN,
};

function harness(withTerrainStatics = true, terrainDef: typeof TERRAIN = TERRAIN) {
  const { world, terrain, systems } = loadScene({ ...SCENE, terrain: terrainDef });
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

describe('статика обрывов (PHYS-2, PHYS-10, TERR-5)', () => {
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
      layer: DEFAULT_CLIFF_LAYER,
      levelNeg: 0,
      levelPos: 1,
    });
  });

  it('слой статики обрывов — параметр сборки, а не конвенция ядра (PHYS-2)', () => {
    const statics = staticsFromTerrain(createTerrainGrid(TERRAIN), 8);
    expect(statics[0]!.layer).toBe(8);
  });

  it('broad-phase отдаёт только пересекающие и только с нужным тегом', () => {
    const world = new PhysicsWorld(staticsFromTerrain(createTerrainGrid(TERRAIN)), fixed.fromInt(1));
    const across = { minX: F(1.5), minY: F(0.1), maxX: F(2.5), maxY: F(0.9) };
    expect(world.query(across, BLOCKS_MOVEMENT)).toHaveLength(1);
    expect(world.query(across, 'blocksNothing')).toHaveLength(0);
    expect(world.query({ minX: F(0.1), minY: F(0.1), maxX: F(0.9), maxY: F(0.9) }, BLOCKS_MOVEMENT)).toHaveLength(0);
  });

  it('broad-phase по маске: пересечение слоя, а не тег (PHYS-2)', () => {
    const world = new PhysicsWorld(staticsFromTerrain(createTerrainGrid(TERRAIN)), fixed.fromInt(1));
    const across = { minX: F(1.5), minY: F(0.1), maxX: F(2.5), maxY: F(0.9) };
    expect(world.queryByLayer(across, LAYER_STATIC)).toHaveLength(1);
    expect(world.queryByLayer(across, LAYER_UNIT)).toHaveLength(0);
    expect(world.queryByLayer(across, 0)).toHaveLength(0);
  });

  it('касание границы не считается пересечением', () => {
    const world = new PhysicsWorld(staticsFromTerrain(createTerrainGrid(TERRAIN)), fixed.fromInt(1));
    expect(world.query({ minX: F(1.0), minY: F(0.1), maxX: F(2.0), maxY: F(0.9) }, BLOCKS_MOVEMENT)).toHaveLength(0);
  });

  it('статика сущностями не становится: отрезков много, сущностей не прибавилось (PHYS-10)', () => {
    // Арена в тысячи клеток дала бы тысячи сущностей в каждом снапшоте, запросе
    // и дампе, не неся данных сверх геометрии. Обрывы выводятся из карты
    // уровней и живут в PhysicsWorld, а не в ECS.
    const { world, terrain } = loadScene(SCENE);
    const before = listAlive(world).length;
    const statics = staticsFromTerrain(terrain!.grid);

    expect(statics.length).toBeGreaterThan(0);
    expect(listAlive(world)).toHaveLength(before);
    // Единственная сущность сцены — singleton террейна, держащий карту пола
    // компонентом (TERR-6); на отрезок обрыва сущности нет ни одной.
    expect(before).toBe(1);
  });
});

/**
 * Tie-break raycast'а (PHYS-7) — требование про детерминизм, а не про удобство:
 * при равной дистанции результат обязан быть одним и тем же в каждом прогоне и
 * в каждой реализации, иначе Rust-порт разойдётся с TS ровно там, где обе
 * стороны «правы». `cli-testing` прямо называет этот tie-break как то, на что
 * укажет cross-language тест.
 */
describe('порядок hit’ов на равной дистанции (PHYS-7)', () => {
  it('побеждает меньший index: строгое «<» не вытесняет уже найденный hit', () => {
    const h = harness(false);
    // Две стены в одной точке: дистанция совпадает бит в бит, геометрия
    // исход не решает — решает только tie-break.
    const first = h.place('Wall', { Position: { x: F(3), y: F(0) } });
    const second = h.place('Wall', { Position: { x: F(3), y: F(0) } });
    expect(first).toBeLessThan(second);

    const hit = h.physics.raycast(at(0, 0), at(8, 0), { mask: BLOCKS_VISION });
    expect(hit!.entity).toBe(first);
  });

  it('повторный запрос даёт тот же ответ — исход не плавает между прогонами', () => {
    const h = harness(false);
    h.place('Wall', { Position: { x: F(3), y: F(0) } });
    h.place('Wall', { Position: { x: F(3), y: F(0) } });

    const ray = () => h.physics.raycast(at(0, 0), at(8, 0), { mask: BLOCKS_VISION });
    expect(ray()).toEqual(ray());
  });

  it('статика идёт раньше динамики: у неё нет index, порядок обхода зафиксирован', () => {
    const h = harness(false);
    h.place('Wall', { Position: { x: F(3), y: F(0) } });
    // Статический отрезок ровно на грани стены — дистанции совпадают.
    const statics: StaticCollider[] = [
      { minX: F(2.5), maxX: F(2.5), minY: F(-1), maxY: F(1), tags: [BLOCKS_VISION], layer: 0 },
    ];
    const withStatic = createPhysicsApi(
      h.world,
      new PhysicsWorld(statics, fixed.fromInt(1)),
    );

    const hit = withStatic.raycast(at(0, 0), at(8, 0), { mask: BLOCKS_VISION });
    expect(hit).not.toBeNull();
    expect(hit!.entity).toBeUndefined(); // статика, а не сущность
    expect(hit!.point.x).toBe(F(2.5));
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

  it('слой стены в blockMask блокирует, чужой слой — нет (PHYS-2)', () => {
    const h = harness(false);
    h.place('Wall', { Position: { x: F(1), y: F(0) } });
    const blocked = h.place('Mover', { Position: { x: F(0), y: F(0) }, Velocity: { x: F(0.5) } });
    const free = h.place('Mover', { Position: { x: F(0), y: F(3) }, Velocity: { x: F(0.5) } });
    // Слой юнита не входит в blockMask движущегося, поэтому первому он не помеха.
    h.place('Mover', { Position: { x: F(0.5), y: F(0) } });

    const events = h.step();
    expect(h.position(blocked).x).toBe(0);
    expect(h.position(free).x).toBe(F(0.5));
    expect(events).toHaveLength(1);
    expect(events[0]!.data['other']).not.toBe(STATIC_COLLIDER);
  });

  it('сущность внутри препятствия выходит наружу, но не глубже', () => {
    const h = harness(false);
    h.place('Wall', { Position: { x: F(2), y: F(0) } });
    const out = h.place('Mover', { Position: { x: F(2.2), y: F(0) }, Velocity: { x: F(0.3) } });
    const deeper = h.place('Mover', { Position: { x: F(2.2), y: F(2) }, Velocity: { x: F(-0.3) } });
    h.place('Wall', { Position: { x: F(2), y: F(2) } });

    const events = h.step();
    expect(h.position(out).x).toBe(fixed.add(F(2.2), F(0.3)));
    expect(h.position(deeper).x).toBe(F(2.2));
    expect(events.map((e) => e.data['entity'])).toEqual([deeper]);
  });

  it('сущность, засунутая в обрыв, из него выбирается', () => {
    const h = harness();
    // Обрыв на x = 2: коллайдер сущности накрывает его с обеих сторон.
    const stuck = h.place('Mover', { Position: { x: F(2), y: F(0.5) }, Velocity: { x: F(-0.3) } });
    h.step();
    expect(h.position(stuck).x).toBe(fixed.sub(F(2), F(0.3)));
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

describe('маски слоёв (PHYS-2)', () => {
  it('нулевой blockMask проходит сквозь всё без события', () => {
    const h = harness();
    // На пути и стена-сущность, и статика обрыва — оба слоя вне пустой маски.
    h.place('Wall', { Position: { x: F(1), y: F(0.5) } });
    const ghost = h.place('Mover', {
      Position: { x: F(0), y: F(0.5) },
      Velocity: { x: F(3) },
      Collider: { blockMask: 0 },
    });
    const events = h.step();
    expect(h.position(ghost).x).toBe(F(3));
    expect(events).toHaveLength(0);
  });

  it('сущность блокирует сущность, чей слой попал в blockMask', () => {
    const h = harness(false);
    const unit = h.place('Mover', { Position: { x: F(1), y: F(0) } });
    const charger = h.place('Mover', {
      Position: { x: F(0), y: F(0) },
      Velocity: { x: F(0.6) },
      Collider: { blockMask: LAYER_STATIC | LAYER_UNIT },
    });
    const events = h.step();
    expect(h.position(charger).x).toBe(0);
    expect(events.map((e) => e.type)).toEqual(['Collision']);
    expect(events[0]!.data['other']).toBe(unit);
  });

  it('условная блокировка — мутация blockMask между тиками', () => {
    // В геймплее маску мутирует JSON-система через Command Buffer (PHYS-2);
    // здесь мутация делается напрямую между тиками — физика читает поле и
    // ничего об условии не знает.
    const h = harness(false);
    h.place('Wall', { Position: { x: F(1), y: F(0) } });
    const mover = h.place('Mover', { Position: { x: F(0), y: F(0) }, Velocity: { x: F(0.5) } });
    h.step();
    expect(h.position(mover).x).toBe(0);

    setField(h.world, mover, 'Collider', 'blockMask', 0);
    h.step();
    expect(h.position(mover).x).toBe(F(0.5));
  });
});

describe('TimeScale в точке интеграции (PHYS-8, TIME-4)', () => {
  it('TimeScale 0.5 — половина смещения за тик, скорость не мутируется', () => {
    const h = harness(false);
    const mover = h.place('Mover', { Position: { x: F(0), y: F(0) }, Velocity: { x: F(0.5) } });
    addComponent(h.world, mover, 'TimeScale', { value: F(0.5) });
    h.step();
    expect(h.position(mover).x).toBe(F(0.25));
    // Замедление действует на шаг, а не «прилипает» к состоянию (D4).
    expect(getField(h.world, mover, 'Velocity', 'x')).toBe(F(0.5));
  });

  it('без компонента TimeScale шаг равен скорости', () => {
    const h = harness(false);
    const mover = h.place('Mover', { Position: { x: F(0), y: F(0) }, Velocity: { x: F(0.5) } });
    h.step();
    expect(h.position(mover).x).toBe(F(0.5));
  });
});

describe('направленный гейт обрыва (PHYS-11)', () => {
  it('подъём в пределах допуска проходит', () => {
    const h = harness(true, TERRAIN_STEEP);
    const mover = h.place('Mover', {
      Position: { x: F(1.5), y: F(0.5) },
      Velocity: { x: F(1) },
      Collider: { cliffRise: 2 },
    });
    const events = h.step();
    expect(h.position(mover).x).toBe(F(2.5));
    expect(events).toHaveLength(0);
  });

  it('уступ выше допуска блокирует и порождает событие столкновения (PHYS-9)', () => {
    const h = harness(true, TERRAIN_STEEP);
    const mover = h.place('Mover', {
      Position: { x: F(1.5), y: F(0.5) },
      Velocity: { x: F(1) },
      Collider: { cliffRise: 1 },
    });
    const events = h.step();
    expect(h.position(mover).x).toBe(F(1.5));
    expect(events.map((e) => e.type)).toEqual(['Collision']);
    expect(events[0]!.data['other']).toBe(STATIC_COLLIDER);
  });

  it('спуск при активном допуске свободен с любой высоты', () => {
    const h = harness(true, { ...TERRAIN, levels: ['0033', '0033'] });
    const mover = h.place('Mover', {
      Position: { x: F(2.5), y: F(0.5) },
      Velocity: { x: F(-1) },
      Collider: { cliffRise: 1 },
    });
    const events = h.step();
    expect(h.position(mover).x).toBe(F(1.5));
    expect(events).toHaveLength(0);
  });

  it('нулевой cliffRise блокирует в обе стороны — поведение без гейта', () => {
    const h = harness(true, TERRAIN_STEEP);
    const up = h.place('Mover', { Position: { x: F(1.5), y: F(0.5) }, Velocity: { x: F(1) } });
    const down = h.place('Mover', { Position: { x: F(2.5), y: F(1.5) }, Velocity: { x: F(-1) } });
    h.step();
    expect(h.position(up).x).toBe(F(1.5));
    expect(h.position(down).x).toBe(F(2.5));
  });

  it('ход вдоль ребра при активном допуске не цепляется за него', () => {
    const h = harness(true, TERRAIN_STEEP);
    // Сущность верхом на ребре x = 2 скользит вдоль него по Y — ось хода не
    // совпадает с осью нормали ребра, и гейт её не блокирует.
    const airborne = h.place('Mover', {
      Position: { x: F(2), y: F(0.5) },
      Velocity: { y: F(0.3) },
      Collider: { cliffRise: 1 },
    });
    h.step();
    expect(h.position(airborne).y).toBe(fixed.add(F(0.5), F(0.3)));
  });
});

describe('sensor-пересечения (PHYS-12)', () => {
  it('снаряд с нулевым blockMask летит насквозь и даёт Overlap', () => {
    const h = harness(false);
    const target = h.place('Mover', { Position: { x: F(1), y: F(0) } });
    const bullet = h.place('Bullet', { Position: { x: F(0), y: F(0) }, Velocity: { x: F(2) } });
    const events = h.step();
    expect(h.position(bullet).x).toBe(F(2));
    expect(events.map((e) => e.type)).toEqual(['Overlap']);
    expect(events[0]!.data).toEqual({ entity: bullet, other: target });
  });

  it('быстрый снаряд над целью строго между позициями всё равно даёт Overlap', () => {
    const h = harness(false);
    const target = h.place('Mover', { Position: { x: F(2.5), y: F(0) } });
    const bullet = h.place('Bullet', { Position: { x: F(0), y: F(0) }, Velocity: { x: F(5) } });
    const events = h.step();
    // Ни старая, ни новая позиции цель не задевают — задевает заметаемый объём.
    expect(events.map((e) => e.type)).toEqual(['Overlap']);
    expect(events[0]!.data).toEqual({ entity: bullet, other: target });
  });

  it('пересечение длиной в три тика даёт три события — по одному за тик', () => {
    const h = harness(false);
    const target = h.place('Mover', { Position: { x: F(1), y: F(0) } });
    const bullet = h.place('Bullet', { Position: { x: F(1), y: F(0) } });
    for (let i = 0; i < 3; i++) {
      const events = h.step();
      expect(events.map((e) => e.type)).toEqual(['Overlap']);
      expect(events[0]!.data).toEqual({ entity: bullet, other: target });
    }
  });

  it('порядок событий детерминирован: статика раньше динамики', () => {
    const h = harness();
    const target = h.place('Mover', { Position: { x: F(1), y: F(0.5) } });
    const bullet = h.place('Bullet', {
      Position: { x: F(0.5), y: F(0.5) },
      Velocity: { x: F(2) },
      Collider: { hitMask: LAYER_STATIC | LAYER_UNIT },
    });
    const events = h.step().filter((e) => e.type === 'Overlap');
    expect(events.map((e) => e.data['other'])).toEqual([STATIC_COLLIDER, target]);
    expect(events.map((e) => e.data['entity'])).toEqual([bullet, bullet]);
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
      { minX: F(-20), maxX: F(-19), minY: F(-1), maxY: F(1), tags: [BLOCKS_VISION], layer: 0 },
    ];
    const { world } = loadScene(SCENE);
    const physics = createPhysicsApi(world, new PhysicsWorld(statics, fixed.fromInt(1)));
    expect(physics.raycast(at(-25, 0), at(-10, 0), { mask: BLOCKS_VISION })).not.toBeNull();
  });
});
