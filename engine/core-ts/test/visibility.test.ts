import { describe, expect, it } from 'vitest';
import * as fixed from '../src/math/fixed.js';
import { mathApi } from '../src/math/mathApi.js';
import { addComponent, componentNames, getField, setField, spawn } from '../src/ecs/world.js';
import {
  colliderHeightDeclared,
  createPhysicsApi,
  BLOCKS_VISION,
  PhysicsWorld,
  SHAPE_AABB,
  staticsFromTerrain,
} from '../src/systems/physics.js';
import {
  isVisibleTo,
  teamBit,
  VisibilitySystem,
  VISION_MODIFIER_COMPONENT,
  MAX_TEAMS,
  VISIBILITY_COMPONENT,
} from '../src/systems/visibility.js';
import { requireModifierList } from '../src/systems/modifiers.js';
import { loadScene, type SceneDef } from '../src/sim/scene.js';
import { initialState, tick, type Simulation } from '../src/sim/tick.js';
import { LEVEL_OVERRIDE_COMPONENT, type EntityId, type FieldOverrides, type TickResult } from '../src/types.js';

const F = fixed.fromFloat;

/** Ровная сетка: обрывов нет, и высота задаётся только через `LevelOverride` (ARENA-6). */
const TERRAIN = {
  width: 8,
  height: 8,
  tileSize: fixed.fromInt(1),
  levels: Array.from({ length: 8 }, () => '00000000'),
  flags: Array.from({ length: 8 }, () => '........'),
};

const SCENE: SceneDef = {
  components: [
    { name: 'Position', fields: { x: 'fixed', y: 'fixed' } },
    // Поле высоты объявлено, но нигде не задано: колоночный гейт (PHYS-14)
    // включён схемой, а полосы у всех не ограничены — остальные тесты файла
    // проверяют, что LoS от этого не меняется.
    {
      name: 'Collider',
      fields: { halfX: 'fixed', halfY: 'fixed', radius: 'fixed', shape: 'i32', height: 'i32' },
    },
    { name: LEVEL_OVERRIDE_COMPONENT, fields: { level: 'i32' } },
  ],
  fog: true,
  prefabs: [
    {
      name: 'Watcher',
      components: {
        Position: { x: 0, y: 0 },
        Vision: { radius: F(5) },
        Visibility: { visibleTo: 0 },
        Team: { id: 0 },
        VisionModifier: {},
      },
    },
    {
      name: 'Enemy',
      components: {
        Position: { x: 0, y: 0 },
        Visibility: { visibleTo: 0 },
        Team: { id: 1 },
        Stealth: { active: 0 },
      },
    },
    /** Нейтральная цель без команды: своей её не считает никто. */
    { name: 'Crate', components: { Position: { x: 0, y: 0 }, Visibility: { visibleTo: 0 } } },
    {
      name: 'Wall',
      components: {
        Position: { x: 0, y: 0 },
        Collider: { halfX: F(0.5), halfY: F(0.5), radius: F(0.5), shape: SHAPE_AABB },
      },
      tags: [BLOCKS_VISION],
    },
  ],
  terrain: TERRAIN,
};

function harness(terrainDef: typeof TERRAIN = TERRAIN) {
  const { world, terrain, systems, modifiers } = loadScene({ ...SCENE, terrain: terrainDef });
  const physicsWorld = new PhysicsWorld(staticsFromTerrain(terrain!.grid), terrain!.grid.tileSize);
  const visionModifiers = requireModifierList(modifiers, VISION_MODIFIER_COMPONENT);
  systems.register(new VisibilitySystem(visionModifiers));
  const sim: Simulation = {
    systems,
    worldSeed: 1,
    math: mathApi,
    physics: createPhysicsApi(world, physicsWorld, {}, {
      height: colliderHeightDeclared(world),
      terrain: terrain!,
    }),
    terrain: terrain!,
    modifiers,
  };
  const state = initialState(world, 1);

  return {
    world,
    visionModifiers,
    place: (prefab: string, overrides?: FieldOverrides) => spawn(world, prefab, overrides),
    step: (): TickResult => tick(sim, state),
    mask: (entity: EntityId): number => getField(world, entity, VISIBILITY_COMPONENT, 'visibleTo'),
    move: (entity: EntityId, x: number, y: number): void => {
      setField(world, entity, 'Position', 'x', F(x));
      setField(world, entity, 'Position', 'y', F(y));
    },
    level: (entity: EntityId, value: number): void => {
      addComponent(world, entity, LEVEL_OVERRIDE_COMPONENT, { level: value });
    },
  };
}

describe('битмаска команд (FOW-2)', () => {
  it('бит на команду, знаковый — у команды 31', () => {
    expect(teamBit(0)).toBe(1);
    expect(teamBit(3)).toBe(8);
    expect(teamBit(MAX_TEAMS - 1)).toBe(fixed.INT32_MIN);
    expect(isVisibleTo(teamBit(1) | teamBit(3), 3)).toBe(true);
    expect(isVisibleTo(teamBit(1) | teamBit(3), 2)).toBe(false);
  });

  it('команда вне 32 бит — ошибка, а не молчаливое переполнение', () => {
    expect(() => teamBit(MAX_TEAMS)).toThrow(/FOW-2/);
    expect(() => teamBit(-1)).toThrow(/FOW-2/);
  });
});

describe('пересчёт видимости (FOW-5)', () => {
  it('свободный луч в радиусе взводит бит наблюдателя', () => {
    const h = harness();
    const watcher = h.place('Watcher', { Position: { x: F(1), y: F(1) } });
    const enemy = h.place('Enemy', { Position: { x: F(1), y: F(3) } });
    h.step();

    expect(h.mask(enemy)).toBe(teamBit(0) | teamBit(1));
    // Наблюдателя видит только его собственная команда: чужих наблюдателей нет.
    expect(h.mask(watcher)).toBe(teamBit(0));
  });

  it('цель в радиусе, но за стеной — бит не взводится', () => {
    const h = harness();
    h.place('Watcher', { Position: { x: F(1), y: F(1) } });
    h.place('Wall', { Position: { x: F(2), y: F(1) } });
    const enemy = h.place('Enemy', { Position: { x: F(3), y: F(1) } });
    h.step();

    expect(h.mask(enemy)).toBe(teamBit(1));
  });

  it('цель вне радиуса не видна, а VisionModifier её открывает (FOW-3)', () => {
    const h = harness();
    const watcher = h.place('Watcher', { Position: { x: F(1), y: F(1) }, Vision: { radius: F(2) } });
    const enemy = h.place('Enemy', { Position: { x: F(5), y: F(1) } });

    h.step();
    expect(h.mask(enemy)).toBe(teamBit(1));

    // Источник обзора ×2: радиус 2 → 4, дистанция ровно 4, граница включающая (QUERY-1).
    setField(h.world, watcher, 'VisionModifier', 'id0', 7);
    setField(h.world, watcher, 'VisionModifier', 'value0', F(2));
    h.step();
    expect(h.mask(enemy)).toBe(teamBit(0) | teamBit(1));
  });

  it('наблюдатель снизу не видит цель на возвышении', () => {
    const h = harness();
    const watcher = h.place('Watcher', { Position: { x: F(1), y: F(1) } });
    const enemy = h.place('Enemy', { Position: { x: F(1), y: F(3) } });
    h.level(watcher, 0);
    h.level(enemy, 1);
    h.step();

    expect(h.mask(enemy)).toBe(teamBit(1));
  });

  it('наблюдатель сверху видит цель внизу', () => {
    const h = harness();
    const watcher = h.place('Watcher', { Position: { x: F(1), y: F(1) } });
    const enemy = h.place('Enemy', { Position: { x: F(1), y: F(3) } });
    h.level(watcher, 1);
    h.level(enemy, 0);
    h.step();

    expect(h.mask(enemy)).toBe(teamBit(0) | teamBit(1));
  });

  it('нейтральная цель без команды видна только по-настоящему', () => {
    const h = harness();
    h.place('Watcher', { Position: { x: F(1), y: F(1) } });
    const near = h.place('Crate', { Position: { x: F(1), y: F(3) } });
    const far = h.place('Crate', { Position: { x: F(7), y: F(7) } });
    h.step();

    expect(h.mask(near)).toBe(teamBit(0));
    expect(h.mask(far)).toBe(0);
  });

  it('видимость считается по финальной позиции тика (FOW-6)', () => {
    const h = harness();
    h.place('Watcher', { Position: { x: F(1), y: F(1) } });
    h.place('Wall', { Position: { x: F(2), y: F(1) } });
    const enemy = h.place('Enemy', { Position: { x: F(1), y: F(3) } });

    h.step();
    expect(h.mask(enemy)).toBe(teamBit(0) | teamBit(1));

    h.move(enemy, 3, 1); // за укрытие
    h.step();
    expect(h.mask(enemy)).toBe(teamBit(1));
  });
});

describe('асимметрия высоты через ребро обрыва (FOW-5, PHYS-13)', () => {
  /** Ступенька: колонки 0–3 — уровень 0, колонки 4–7 — уровень 1; обрыв на x = 4. */
  const TERRAIN_STEP = { ...TERRAIN, levels: Array.from({ length: 8 }, () => '00001111') };
  /** Долина: плато по краям (колонки 0–1 и 6–7), низ посередине; обрывы x = 2 и x = 6. */
  const TERRAIN_VALLEY = { ...TERRAIN, levels: Array.from({ length: 8 }, () => '11000011') };

  it('наблюдатель сверху видит цель внизу через само ребро обрыва', () => {
    const h = harness(TERRAIN_STEP);
    // Линия взгляда пересекает обрыв x = 4 с верхней стороны: ребро луч не
    // перекрывает (PHYS-13), а фильтр по высоте обзор вниз не ограничивает —
    // бит взводится (FOW-5, сценарий «Наблюдатель сверху, цель за обрывом внизу»).
    h.place('Watcher', { Position: { x: F(5.5), y: F(1.5) } });
    const enemy = h.place('Enemy', { Position: { x: F(2.5), y: F(1.5) } });
    h.step();

    expect(h.mask(enemy)).toBe(teamBit(0) | teamBit(1));
  });

  it('наблюдатель снизу не видит цель на плато: ребро перекрывает луч снизу вверх', () => {
    const h = harness(TERRAIN_STEP);
    // Снизу вверх асимметрия полная (FOW-5): луч через ребро перекрыт
    // (PHYS-13), а обход по высоте отсёк бы фильтр уровня.
    h.place('Watcher', { Position: { x: F(2.5), y: F(1.5) } });
    const enemy = h.place('Enemy', { Position: { x: F(5.5), y: F(1.5) } });
    h.step();

    expect(h.mask(enemy)).toBe(teamBit(1));
  });

  it('свой уровень через низину: видно и цель внизу, и плато того же уровня за ней', () => {
    const h = harness(TERRAIN_VALLEY);
    // Наблюдатель на левом плато (уровень 1): рёбра x = 2 и x = 6 не выше его
    // уровня и луч не перекрывают (PHYS-13) — видны и цель в низине, и цель на
    // плато того же уровня за ней (FOW-5, сценарий «Цель на плато того же
    // уровня через низину»). Обратно с низины плато закрыто: ребро выше уровня
    // наблюдателя, и фильтр высоты отсёк бы цель и в обход.
    h.place('Watcher', { Position: { x: F(1.5), y: F(1.5) } });
    const below = h.place('Enemy', { Position: { x: F(4.5), y: F(1.5) } });
    const farPlateau = h.place('Enemy', { Position: { x: F(6.5), y: F(1.5) } });
    h.step();

    expect(h.mask(below)).toBe(teamBit(0) | teamBit(1));
    expect(h.mask(farPlateau)).toBe(teamBit(0) | teamBit(1));
  });
});

/**
 * Колоночный гейт (PHYS-14) достаёт до луча LoS: опция уровня у `raycast` одна
 * и та же — ту же, что PHYS-13 отдаёт обрывам, `VisibilitySystem` передаёт как
 * уровень наблюдателя (FOW-5). Следствие поэтому нормативно, а не побочно:
 * укрытие с ОГРАНИЧЕННОЙ полосой перестаёт перекрывать обзор наблюдателю, чей
 * уровень в эту полосу не попал. Полоса не задана — укрытие перекрывает как
 * раньше, и это то умолчание, на котором стоит весь остальной файл.
 */
describe('полоса укрытия в луче обзора (FOW-5, PHYS-14)', () => {
  it('укрытие своей полосы обзор перекрывает', () => {
    const h = harness();
    h.place('Watcher', { Position: { x: F(1), y: F(1) } });
    h.place('Wall', { Position: { x: F(2), y: F(1) }, Collider: { height: 1 } });
    const enemy = h.place('Enemy', { Position: { x: F(3), y: F(1) } });
    h.step();

    // Наблюдатель, цель и укрытие — все уровня 0, полоса укрытия [0, 0].
    expect(h.mask(enemy)).toBe(teamBit(1));
  });

  it('то же укрытие наблюдателю выше его полосы обзор не перекрывает', () => {
    const h = harness();
    const watcher = h.place('Watcher', { Position: { x: F(1), y: F(1) } });
    h.place('Wall', { Position: { x: F(2), y: F(1) }, Collider: { height: 1 } });
    const enemy = h.place('Enemy', { Position: { x: F(3), y: F(1) } });
    // Наблюдатель и цель — на уровне 2 (ARENA-6), укрытие осталось на нуле:
    // фильтр высоты FOW-5 цель пропускает (уровни равны), а луч уровня 2 в
    // полосу [0, 0] укрытия не попадает и проходит насквозь.
    h.level(watcher, 2);
    h.level(enemy, 2);
    h.step();

    expect(h.mask(enemy)).toBe(teamBit(0) | teamBit(1));
  });

  it('укрытие без полосы перекрывает луч любого уровня — умолчание не изменилось', () => {
    const h = harness();
    const watcher = h.place('Watcher', { Position: { x: F(1), y: F(1) } });
    // Высота 0 — полоса не ограничена: ровно то укрытие, что было до PHYS-14.
    h.place('Wall', { Position: { x: F(2), y: F(1) }, Collider: { height: 0 } });
    const enemy = h.place('Enemy', { Position: { x: F(3), y: F(1) } });
    h.level(watcher, 2);
    h.level(enemy, 2);
    h.step();

    // Отличие предыдущего теста — полоса укрытия, а не высота наблюдателя.
    expect(h.mask(enemy)).toBe(teamBit(1));
  });
});

describe('стелс (FOW-3)', () => {
  it('гасит биты чужих команд, свою команду не трогает', () => {
    const h = harness();
    h.place('Watcher', { Position: { x: F(1), y: F(1) } });
    const enemy = h.place('Enemy', { Position: { x: F(1), y: F(3) } });

    h.step();
    expect(h.mask(enemy)).toBe(teamBit(0) | teamBit(1));

    setField(h.world, enemy, 'Stealth', 'active', 1);
    h.step();
    expect(h.mask(enemy)).toBe(teamBit(1));
  });
});

describe('эмит только при изменении (FOW-6)', () => {
  it('никто не сдвинулся — команд не эмитится, компонент не dirty', () => {
    const h = harness();
    const watcher = h.place('Watcher', { Position: { x: F(1), y: F(1) } });
    const enemy = h.place('Enemy', { Position: { x: F(1), y: F(3) } });

    // Первый тик взводит биты собственных команд обоим — это и есть изменение.
    const first = h.step();
    expect([...first.changes.changedEntities(VISIBILITY_COMPONENT)]).toEqual([watcher, enemy]);

    const second = h.step();
    expect(second.changes.changedEntities(VISIBILITY_COMPONENT).size).toBe(0);
    expect(second.changes.isEmpty).toBe(true);
  });

  it('изменение битов эмитится', () => {
    const h = harness();
    h.place('Watcher', { Position: { x: F(1), y: F(1) } });
    const enemy = h.place('Enemy', { Position: { x: F(1), y: F(3) } });
    h.step();

    h.move(enemy, 7, 7);
    const result = h.step();
    expect([...result.changes.changedEntities(VISIBILITY_COMPONENT)]).toEqual([enemy]);
    expect(h.mask(enemy)).toBe(teamBit(1));
  });
});

describe('туман войны без террейна отвергается загрузчиком (SER-7, FOW-5)', () => {
  /** Та же сцена без ассета террейна: `fog` остаётся, запрос уровня исчезает. */
  const withoutTerrain = (): SceneDef => {
    const { terrain: _terrain, ...rest } = SCENE;
    return rest;
  };

  it('сцена с fog и без terrain не поднимается, и сообщение называет зависимость', () => {
    expect(() => loadScene(withoutTerrain())).toThrow(/SER-7/);
    // Фолбэка «все уровни нулевые» нет намеренно: он выглядел бы исправной FoW
    // и отличался бы от неё только на сценах с перепадом высот.
    expect(() => loadScene(withoutTerrain())).toThrow(/terrain/);
    expect(() => loadScene(withoutTerrain())).toThrow(/FOW-5/);
  });

  it('сцена с обоими полями поднимается, компоненты тумана дописаны', () => {
    const { world } = loadScene(SCENE);
    expect(componentNames(world)).toContain(VISIBILITY_COMPONENT);
  });

  it('террейн без тумана — штатная сцена, ограничение односторонне', () => {
    // Prefabs сцены выше ссылаются на компоненты, которые дописывает сам флаг
    // `fog`, поэтому обратное сочетание проверяется на минимальной сцене.
    const { world } = loadScene({
      components: [{ name: 'Position', fields: { x: 'fixed', y: 'fixed' } }],
      terrain: TERRAIN,
    });
    expect(componentNames(world)).not.toContain(VISIBILITY_COMPONENT);
  });
});
