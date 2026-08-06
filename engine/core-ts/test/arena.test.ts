import { describe, expect, it } from 'vitest';
import * as fixed from '../src/math/fixed.js';
import { getField, setField, spawn } from '../src/ecs/world.js';
import { query } from '../src/ecs/query.js';
import { mathApi } from '../src/math/mathApi.js';
import {
  arenaPrefab,
  createArenaApi,
  ArenaSystem,
  ARENA_COMPONENT,
  ARENA_COMPONENTS,
  ARENA_PREFAB,
  ARENA_STATE_COMPONENT,
  type ArenaDef,
} from '../src/systems/arena.js';
import { FLOOR_COMPONENT, type TerrainDef } from '../src/systems/terrain.js';
import { createPhysicsApi, PhysicsWorld, SHAPE_CIRCLE } from '../src/systems/physics.js';
import { loadScene, type SceneDef } from '../src/sim/scene.js';
import { initialState, restoreSnapshot, takeSnapshot, tick, type Simulation } from '../src/sim/tick.js';
import { FIXED_ONE, LEVEL_OVERRIDE_COMPONENT, type GameEvent, type Vec2 } from '../src/types.js';

const F = fixed.fromFloat;
const at = (x: number, y: number): Vec2 => ({ x: F(x), y: F(y) });

/**
 * Сетка 8×8 по единице: колонка 0 поднята на уровень 1 (возвышение у края),
 * клетка (5, 4) — без пола (дыра для снаряда).
 */
const TERRAIN: TerrainDef = {
  width: 8,
  height: 8,
  tileSize: fixed.fromInt(1),
  levels: Array.from({ length: 8 }, () => '10000000'),
  flags: [
    '........',
    '........',
    '........',
    '........',
    '....._..',
    '........',
    '........',
    '........',
  ],
};

const ARENA: ArenaDef = { center: at(4, 4), radius: fixed.fromInt(3) };

const SCENE: SceneDef = {
  components: [
    { name: 'Position', fields: { x: 'fixed', y: 'fixed' } },
    { name: LEVEL_OVERRIDE_COMPONENT, fields: { level: 'i32' } },
    ...ARENA_COMPONENTS,
  ],
  prefabs: [
    {
      name: 'Actor',
      components: { Position: { x: 0, y: 0 }, [ARENA_STATE_COMPONENT]: {} },
    },
    // Снаряд отличается только явным уровнем: он не стоит на земле (ARENA-6).
    {
      name: 'Projectile',
      components: {
        Position: { x: 0, y: 0 },
        [ARENA_STATE_COMPONENT]: {},
        [LEVEL_OVERRIDE_COMPONENT]: { level: 1 },
      },
    },
    arenaPrefab(ARENA),
  ],
  terrain: TERRAIN,
};

function harness() {
  const { world, terrain, systems } = loadScene(SCENE);
  const arena = createArenaApi(world, ARENA, spawn(world, ARENA_PREFAB));
  systems.register(new ArenaSystem());
  const sim: Simulation = { systems, worldSeed: 1, math: mathApi, terrain: terrain!, arena };
  const state = initialState(world, 1);

  return {
    world,
    arena,
    terrain: terrain!,
    state,
    place: (prefab: string, x: number, y: number) =>
      spawn(world, prefab, { Position: { x: F(x), y: F(y) } }),
    move: (entity: number, x: number, y: number) => {
      setField(world, entity, 'Position', 'x', F(x));
      setField(world, entity, 'Position', 'y', F(y));
    },
    /** Сужение — обычная мутация поля (ARENA-4); здесь напрямую, в бою — командой политики. */
    shrink: (radius: number) => setField(world, arena.entity, ARENA_COMPONENT, 'radius', F(radius)),
    breakFloor: (cell: number) => {
      const [floorEntity] = query(world, { all: [FLOOR_COMPONENT] });
      const word = `w${cell >>> 5}`;
      const bits = getField(world, floorEntity!, FLOOR_COMPONENT, word);
      setField(world, floorEntity!, FLOOR_COMPONENT, word, bits & ~(1 << (cell & 31)));
    },
    step: (): readonly GameEvent[] => [...tick(sim, state).events],
  };
}

const types = (events: readonly GameEvent[]) => events.map((e) => e.type);

describe('ассет арены (ARENA-1)', () => {
  it('радиус попадает в компонент, центр — нет', () => {
    const prefab = arenaPrefab(ARENA);
    expect(prefab.components[ARENA_COMPONENT]).toEqual({ radius: fixed.fromInt(3) });
  });

  it('отвергает нулевой и дробный радиус', () => {
    expect(() => arenaPrefab({ ...ARENA, radius: 0 })).toThrow(/ARENA-1/);
    expect(() => arenaPrefab({ ...ARENA, radius: 1.5 })).toThrow(/ARENA-1/);
  });

  it('отвергает центр вне Q16.16', () => {
    expect(() => arenaPrefab({ ...ARENA, center: { x: 1e12, y: 0 } })).toThrow(/ARENA-1/);
  });
});

describe('принадлежность арене (ARENA-2)', () => {
  it('точка ровно на границе считается внутри', () => {
    const h = harness();
    expect(h.arena.contains(at(7, 4))).toBe(true);
    expect(h.arena.contains(at(7.0001, 4))).toBe(false);
  });

  it('высота на принадлежность не влияет', () => {
    const h = harness();
    // Колонка 0 поднята, но она за радиусом — сущность снаружи.
    expect(h.terrain.levelAt(at(0.5, 4.5))).toBe(1);
    expect(h.arena.contains(at(0.5, 4.5))).toBe(false);
  });

  it('радиус читается живым из компонента', () => {
    const h = harness();
    expect(h.arena.radius()).toBe(fixed.fromInt(3));
    h.shrink(1);
    expect(h.arena.radius()).toBe(fixed.fromInt(1));
    expect(h.arena.contains(at(6, 4))).toBe(false);
  });
});

describe('выход за границу (ARENA-3)', () => {
  it('переход внутрь→наружу даёт событие, и ядро не трогает сущность', () => {
    const h = harness();
    const actor = h.place('Actor', 4, 4);
    expect(types(h.step())).toEqual([]);

    h.move(actor, 0.5, 4.5);
    const events = h.step();
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ type: 'LeftArena', data: { entity: actor } });
    // Никаких эффектов: позиция и жизнь сущности — дело политики.
    expect(getField(h.world, actor, 'Position', 'x')).toBe(F(0.5));
  });

  it('событие эмитится один раз на переходе, а не каждый тик', () => {
    const h = harness();
    const actor = h.place('Actor', 4, 4);
    h.step();
    h.move(actor, 0.5, 4.5);
    expect(types(h.step())).toEqual(['LeftArena']);
    expect(types(h.step())).toEqual([]);
    expect(types(h.step())).toEqual([]);

    // Вернулась и вышла снова — это новый переход и новое событие.
    h.move(actor, 4, 4);
    expect(types(h.step())).toEqual([]);
    h.move(actor, 0.5, 4.5);
    expect(types(h.step())).toEqual(['LeftArena']);
  });

  it('сужение догнало неподвижную сущность — тот же переход', () => {
    const h = harness();
    const actor = h.place('Actor', 6.5, 4);
    expect(types(h.step())).toEqual([]);

    h.shrink(2);
    const events = h.step();
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ type: 'LeftArena', data: { entity: actor } });
  });
});

describe('сужение и снапшот (ARENA-4, SNAP-1)', () => {
  it('радиус возвращается вместе с остальным состоянием', () => {
    const h = harness();
    const actor = h.place('Actor', 6.5, 4);
    h.step();
    const snapshot = takeSnapshot(h.state);

    h.shrink(2);
    expect(types(h.step())).toEqual(['LeftArena']);
    expect(h.arena.radius()).toBe(fixed.fromInt(2));

    restoreSnapshot(h.state, snapshot);
    expect(h.arena.radius()).toBe(fixed.fromInt(3));
    expect(h.arena.contains(at(6.5, 4))).toBe(true);
    // Прошлая сторона границы откатилась вместе с миром: переход повторяем.
    expect(getField(h.world, actor, ARENA_STATE_COMPONENT, 'inside')).toBe(1);
    h.shrink(2);
    expect(types(h.step())).toEqual(['LeftArena']);
  });
});

describe('провал сквозь пол (ARENA-5)', () => {
  it('снятый бит пола под стоящей сущностью даёт событие', () => {
    const h = harness();
    const actor = h.place('Actor', 4.5, 4.5);
    expect(types(h.step())).toEqual([]);

    h.breakFloor(4 * 8 + 4);
    const events = h.step();
    expect(events).toEqual([{ type: 'FellThroughFloor', data: { entity: actor } }]);
    expect(types(h.step())).toEqual([]);
  });

  it('обычная сущность над дырой из ассета проваливается сразу', () => {
    const h = harness();
    const actor = h.place('Actor', 5.5, 4.5);
    expect(h.terrain.hasFloorAt(at(5.5, 4.5))).toBe(false);
    expect(types(h.step())).toEqual(['FellThroughFloor']);
    expect(getField(h.world, actor, ARENA_STATE_COMPONENT, 'onFloor')).toBe(0);
  });

  it('снаряд с override уровня над той же дырой не проваливается (ARENA-6)', () => {
    const h = harness();
    h.place('Projectile', 5.5, 4.5);
    expect(types(h.step())).toEqual([]);
    expect(types(h.step())).toEqual([]);
  });

  it('снаряд за краем всё равно даёт LeftArena: пол и граница независимы', () => {
    const h = harness();
    const projectile = h.place('Projectile', 4, 4);
    h.step();
    h.move(projectile, 0.5, 4.5);
    expect(types(h.step())).toEqual(['LeftArena']);
  });
});

/** Сцена с коллайдерами: опорная область — круг support × inradius (ARENA-5). */
const SUPPORT_SCENE: SceneDef = {
  components: [
    { name: 'Position', fields: { x: 'fixed', y: 'fixed' } },
    { name: LEVEL_OVERRIDE_COMPONENT, fields: { level: 'i32' } },
    { name: 'Collider', fields: { shape: 'i32', radius: 'fixed', halfX: 'fixed', halfY: 'fixed' } },
    ...ARENA_COMPONENTS,
  ],
  prefabs: [
    // Опора — половина коллайдера-круга радиуса 0.6: радиус области 0.3.
    {
      name: 'Heavy',
      components: {
        Position: { x: 0, y: 0 },
        Collider: { shape: SHAPE_CIRCLE, radius: F(0.6), halfX: F(0.6), halfY: F(0.6) },
        [ARENA_STATE_COMPONENT]: { support: F(0.5) },
      },
    },
    // Дефолтный support = 0: коллайдер есть, но проверка — по центру.
    {
      name: 'Walker',
      components: {
        Position: { x: 0, y: 0 },
        Collider: { shape: SHAPE_CIRCLE, radius: F(0.6), halfX: F(0.6), halfY: F(0.6) },
        [ARENA_STATE_COMPONENT]: {},
      },
    },
    // Тот же коэффициент без коллайдера: области не из чего строиться.
    {
      name: 'Ghost',
      components: { Position: { x: 0, y: 0 }, [ARENA_STATE_COMPONENT]: { support: F(0.5) } },
    },
    arenaPrefab(ARENA),
  ],
  terrain: TERRAIN,
};

function supportHarness(withPhysics = true) {
  const { world, terrain, systems } = loadScene(SUPPORT_SCENE);
  const arena = createArenaApi(world, ARENA, spawn(world, ARENA_PREFAB));
  systems.register(new ArenaSystem());
  const physics = createPhysicsApi(world, new PhysicsWorld([]));
  const sim: Simulation = {
    systems,
    worldSeed: 1,
    math: mathApi,
    terrain: terrain!,
    arena,
    ...(withPhysics ? { physics } : {}),
  };
  const state = initialState(world, 1);
  return {
    place: (prefab: string, x: number, y: number) =>
      spawn(world, prefab, { Position: { x: F(x), y: F(y) } }),
    move: (entity: number, x: number, y: number) => {
      setField(world, entity, 'Position', 'x', F(x));
      setField(world, entity, 'Position', 'y', F(y));
    },
    step: (): readonly GameEvent[] => [...tick(sim, state).events],
  };
}

describe('опорная область (ARENA-5, support)', () => {
  // Дыра из ассета — клетка (5, 4): x ∈ [5, 6), y ∈ [4, 5).

  it('нависание краем над дырой — не провал, пока область пересекает пол', () => {
    const h = supportHarness();
    // Центр в дыре, но до клетки (4, 4) с полом 0.2 < 0.3.
    h.place('Heavy', 5.2, 4.5);
    expect(types(h.step())).toEqual([]);
    expect(types(h.step())).toEqual([]);
  });

  it('полная потеря опоры даёт событие', () => {
    const h = supportHarness();
    const heavy = h.place('Heavy', 5.2, 4.5);
    h.step();
    // До любой клетки с полом 0.5 > 0.3: круг целиком в дыре.
    h.move(heavy, 5.5, 4.5);
    expect(types(h.step())).toEqual(['FellThroughFloor']);
  });

  it('нулевой коэффициент — прежняя проверка по центру', () => {
    const h = supportHarness();
    h.place('Walker', 5.2, 4.5);
    expect(types(h.step())).toEqual(['FellThroughFloor']);
  });

  it('ненулевой коэффициент без коллайдера — по центру: уменьшать нечего', () => {
    const h = supportHarness();
    h.place('Ghost', 5.2, 4.5);
    expect(types(h.step())).toEqual(['FellThroughFloor']);
  });

  it('сборка без Physics API тикает штатно и вырождается в центр (DI-3)', () => {
    const h = supportHarness(false);
    h.place('Heavy', 5.2, 4.5);
    expect(types(h.step())).toEqual(['FellThroughFloor']);
  });

  it('перенос через дыру за один тик провала не даёт', () => {
    const h = supportHarness();
    const heavy = h.place('Heavy', 4.5, 4.5);
    h.step();
    // Дыра осталась строго между позициями тиков: траектория не свипается.
    h.move(heavy, 6.5, 4.5);
    expect(types(h.step())).toEqual([]);
  });

  it('support вне [0, 1] отвергается загрузкой (ARENA-3)', () => {
    const withSupport = (support: number) =>
      loadScene({
        ...SUPPORT_SCENE,
        prefabs: [
          {
            name: 'Bad',
            components: { Position: { x: 0, y: 0 }, [ARENA_STATE_COMPONENT]: { support } },
          },
        ],
      });
    expect(() => withSupport(F(1.5))).toThrow(/ARENA-3/);
    expect(() => withSupport(-1)).toThrow(/ARENA-3/);
    // Сырое дробное вместо Q16.16 — та же ошибка контента.
    expect(() => withSupport(0.5)).toThrow(/ARENA-3/);
    expect(() => withSupport(FIXED_ONE)).not.toThrow();
  });
});
