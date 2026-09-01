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
  DETECTION_SOURCES_COMPONENT,
  DETECTION_STATE_COMPONENT,
  STEALTH_SOURCES_COMPONENT,
  STEALTH_STATE_COMPONENT,
  VISION_COMPONENT,
  VISION_MODIFIER_COMPONENT,
  MAX_TEAMS,
  VISIBILITY_COMPONENT,
} from '../src/systems/visibility.js';
import { requireModifierList } from '../src/systems/modifiers.js';
import { buildSimulation } from '../src/sim/build.js';
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
        DetectionSources: {},
        DetectionState: { mask: 0 },
      },
    },
    {
      name: 'Enemy',
      components: {
        Position: { x: 0, y: 0 },
        Visibility: { visibleTo: 0 },
        Team: { id: 1 },
        StealthSources: {},
        StealthState: { mask: 0 },
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

function harness(
  terrainDef: typeof TERRAIN = TERRAIN,
  softStealthChannels?: readonly number[],
  extra: Partial<SceneDef> = {},
) {
  const { world, terrain, systems, modifiers, stealthHardMask } = loadScene({
    ...SCENE,
    terrain: terrainDef,
    ...(softStealthChannels === undefined ? {} : { softStealthChannels }),
    ...extra,
  });
  const physicsWorld = new PhysicsWorld(staticsFromTerrain(terrain!.grid), terrain!.grid.tileSize);
  const visionModifiers = requireModifierList(modifiers, VISION_MODIFIER_COMPONENT);
  systems.register(
    new VisibilitySystem({
      lists: {
        vision: visionModifiers,
        stealth: requireModifierList(modifiers, STEALTH_SOURCES_COMPONENT),
        detection: requireModifierList(modifiers, DETECTION_SOURCES_COMPONENT),
      },
      hardStealthMask: stealthHardMask ?? ~0,
    }),
  );
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
    systems,
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
 * Сторона флага рампы — инвариант модели террейна (TERR-5): флаг стоит на
 * НИЖНЕЙ клетке перехода, значит сущность на подъёме ещё несёт нижний уровень.
 * Наблюдаемое поведение «как в Warcraft 3» из этого следует БЕЗ единой строчки
 * в `VisibilitySystem`: цель верхнего уровня отсекает существующий фильтр
 * высоты FOW-5, а сама сущность на рампе остаётся видимой снизу.
 */
describe('видимость на рампе (TERR-5, FOW-5)', () => {
  /**
   * Ступенька с проёмом рампы: колонки 0–3 — уровень 0, колонки 4–7 — уровень 1,
   * клетки (3, 3) и (3, 4) помечены рампой и несут нижний уровень 0. Граница
   * рампы проходима (TERR-5), поэтому cliff-отрезка в проёме нет — луч через
   * него свободен, и цель наверху отсекает только высота.
   */
  const TERRAIN_RAMP = {
    ...TERRAIN,
    levels: Array.from({ length: 8 }, () => '00001111'),
    flags: Array.from({ length: 8 }, (_unused, y) =>
      y === 3 || y === 4 ? '...^....' : '........',
    ),
  };

  it('наблюдатель на рампе не видит верхний уровень: он ещё внизу', () => {
    const h = harness(TERRAIN_RAMP);
    // Наблюдатель — в центре клетки рампы (3, 3): её уровень 0, а не 1.
    const watcher = h.place('Watcher', { Position: { x: F(3.5), y: F(3.5) } });
    const enemy = h.place('Enemy', { Position: { x: F(5.5), y: F(3.5) } });
    h.step();
    expect(h.mask(enemy)).toBe(teamBit(1));

    // Анти-вакуумность и сам скачок уровня (TERR-5): сойдя с рампы на ВЕРХНЮЮ
    // клетку (4, 3), тот же наблюдатель уровня 1 открывает плато целиком.
    h.move(watcher, 4.5, 3.5);
    h.step();
    expect(h.mask(enemy)).toBe(teamBit(0) | teamBit(1));
  });

  it('сущность на рампе видна снизу: её уровень — нижний', () => {
    const h = harness(TERRAIN_RAMP);
    h.place('Watcher', { Position: { x: F(1.5), y: F(3.5) } });
    const enemy = h.place('Enemy', { Position: { x: F(3.5), y: F(3.5) } });
    h.step();

    expect(h.mask(enemy)).toBe(teamBit(0) | teamBit(1));
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

describe('стелс-каналы и детекция (FOW-3, FOW-12)', () => {
  const CH_WEAK = 1 << 0;
  const CH_STRONG = 1 << 1;

  /** Источник стелса/детекции руками, в обход команд: тестовое удобство. */
  const addSource = (h: ReturnType<typeof harness>, entity: EntityId, component: string, slot: number, id: number, mask: number): void => {
    setField(h.world, entity, component, `id${slot}`, id);
    setField(h.world, entity, component, `value${slot}`, mask);
  };

  it('жёсткий канал гасит биты чужих команд, свою команду не трогает', () => {
    const h = harness();
    h.place('Watcher', { Position: { x: F(1), y: F(1) } });
    const enemy = h.place('Enemy', { Position: { x: F(1), y: F(3) } });

    h.step();
    expect(h.mask(enemy)).toBe(teamBit(0) | teamBit(1));

    addSource(h, enemy, STEALTH_SOURCES_COMPONENT, 0, 7, CH_WEAK);
    h.step();
    expect(h.mask(enemy)).toBe(teamBit(1));
  });

  it('лестница: детектор слабого канала не вскрывает сильный, детектор обоих видит всех (FOW-3)', () => {
    const h = harness();
    const watcher = h.place('Watcher', { Position: { x: F(1), y: F(1) } });
    const enemy = h.place('Enemy', { Position: { x: F(1), y: F(3) } });
    addSource(h, enemy, STEALTH_SOURCES_COMPONENT, 0, 7, CH_STRONG);

    // Детекция только слабого: сильный канал не вскрыт — скрыт.
    addSource(h, watcher, DETECTION_SOURCES_COMPONENT, 0, 3, CH_WEAK);
    h.step();
    expect(h.mask(enemy)).toBe(teamBit(1));

    // Детектор сильного несёт и бит слабого — лестница собрана контентной
    // конвенцией битов, ядро про уровни не знает.
    addSource(h, watcher, DETECTION_SOURCES_COMPONENT, 0, 3, CH_WEAK | CH_STRONG);
    h.step();
    expect(h.mask(enemy)).toBe(teamBit(0) | teamBit(1));
  });

  it('детекция одного наблюдателя взводит бит всей команды (FOW-5, гранулярность FOW-2)', () => {
    const h = harness();
    const blind = h.place('Watcher', { Position: { x: F(1), y: F(1) } });
    const seer = h.place('Watcher', { Position: { x: F(3), y: F(1) } });
    const enemy = h.place('Enemy', { Position: { x: F(2), y: F(3) } });
    addSource(h, enemy, STEALTH_SOURCES_COMPONENT, 0, 7, CH_WEAK);
    addSource(h, seer, DETECTION_SOURCES_COMPONENT, 0, 3, CH_WEAK);
    h.step();

    expect(h.mask(enemy)).toBe(teamBit(0) | teamBit(1));
    // Оба наблюдателя видимы только своей команде — стелса у них нет.
    expect(h.mask(blind)).toBe(teamBit(0));
  });

  it('два источника в разных каналах: снятие одного не открывает второй (FOW-3)', () => {
    const h = harness();
    const watcher = h.place('Watcher', { Position: { x: F(1), y: F(1) } });
    const enemy = h.place('Enemy', { Position: { x: F(1), y: F(3) } });
    addSource(h, watcher, DETECTION_SOURCES_COMPONENT, 0, 3, CH_WEAK);
    addSource(h, enemy, STEALTH_SOURCES_COMPONENT, 0, 7, CH_WEAK);
    addSource(h, enemy, STEALTH_SOURCES_COMPONENT, 1, 8, CH_STRONG);
    h.step();
    // Сильный канал не вскрыт — скрыт, хотя слабый детекция покрывает.
    expect(h.mask(enemy)).toBe(teamBit(1));

    // Снятие сильного источника: остался слабый, а его детекция вскрывает.
    addSource(h, enemy, STEALTH_SOURCES_COMPONENT, 1, 0, 0);
    h.step();
    expect(h.mask(enemy)).toBe(teamBit(0) | teamBit(1));
  });

  it('мягкий канал битмаску Visibility не гасит (FOW-12, FOW-13)', () => {
    const h = harness(TERRAIN, [0]); // канал 0 объявлен мягким
    h.place('Watcher', { Position: { x: F(1), y: F(1) } });
    const enemy = h.place('Enemy', { Position: { x: F(1), y: F(3) } });
    addSource(h, enemy, STEALTH_SOURCES_COMPONENT, 0, 7, CH_WEAK);
    h.step();

    // Доставка не режется — мягкое состояние едет в снапшоте (StealthState).
    expect(h.mask(enemy)).toBe(teamBit(0) | teamBit(1));
    expect(getField(h.world, enemy, STEALTH_STATE_COMPONENT, 'mask')).toBe(CH_WEAK);

    // Тот же источник в жёстком канале 1 — режет: мягкость пришла из таблицы
    // сцены, а не из источника.
    addSource(h, enemy, STEALTH_SOURCES_COMPONENT, 0, 7, CH_STRONG);
    h.step();
    expect(h.mask(enemy)).toBe(teamBit(1));
  });
});

describe('политика таргетинга сквозь стелс — JSON-система (FOW-13, EXPR-2)', () => {
  const CH = 1 << 2;

  /**
   * Политика способности как контент: цель берётся, только когда её свёртка
   * стелса покрыта детекцией кастера — один `maskCovered`, без перебора каналов.
   * `order` 500 — раньше якоря 900: система читает свёртки прошлого пересчёта.
   */
  const TARGET_POLICY: NonNullable<SceneDef['systems']> = [
    {
      name: 'TargetPolicy',
      order: 500,
      query: { all: [VISION_COMPONENT, 'Team', 'Position'] },
      as: 'caster',
      do: [
        {
          forEach: {
            query: { all: [STEALTH_SOURCES_COMPONENT] },
            as: 'candidate',
            do: [
              {
                if: {
                  cond: {
                    maskCovered: [
                      { getComponent: [{ var: 'candidate' }, STEALTH_STATE_COMPONENT, 'mask'] },
                      { getComponent: [{ var: 'caster' }, DETECTION_STATE_COMPONENT, 'mask'] },
                    ],
                  },
                  then: [
                    {
                      emitEvent: {
                        type: 'TargetAcquired',
                        data: { entity: { var: 'candidate' }, source: { var: 'caster' } },
                      },
                    },
                  ],
                },
              },
            ],
          },
        },
      ],
    },
  ];

  it('невскрытая цель не берётся, детекция возвращает право таргета', () => {
    const h = harness(TERRAIN, undefined, { systems: TARGET_POLICY });
    const watcher = h.place('Watcher', { Position: { x: F(1), y: F(1) } });
    const enemy = h.place('Enemy', { Position: { x: F(1), y: F(3) } });
    const acquired = (): boolean =>
      [...h.step().events].some((event) => event.type === 'TargetAcquired');

    // Без стелса свёртка 0 покрыта любой детекцией — цель берётся.
    expect(acquired()).toBe(true);

    setField(h.world, enemy, STEALTH_SOURCES_COMPONENT, 'id0', 7);
    setField(h.world, enemy, STEALTH_SOURCES_COMPONENT, 'value0', CH);
    // Первый тик политика ещё видит прошлую свёртку (order 500 < 900)…
    expect(acquired()).toBe(true);
    // …со следующего — канал не вскрыт, таргет запрещён контентным условием.
    expect(acquired()).toBe(false);

    setField(h.world, watcher, DETECTION_SOURCES_COMPONENT, 'id0', 3);
    setField(h.world, watcher, DETECTION_SOURCES_COMPONENT, 'value0', CH);
    h.step();
    expect(acquired()).toBe(true);
  });
});

describe('публикация свёрток StealthState/DetectionState (FOW-3)', () => {
  const CH = 1 << 4;

  it('свёртка — OR занятых слотов, эмит только при изменении', () => {
    const h = harness();
    const watcher = h.place('Watcher', { Position: { x: F(1), y: F(1) } });
    const enemy = h.place('Enemy', { Position: { x: F(1), y: F(3) } });
    h.step();
    expect(getField(h.world, enemy, STEALTH_STATE_COMPONENT, 'mask')).toBe(0);

    setField(h.world, enemy, STEALTH_SOURCES_COMPONENT, 'id0', 7);
    setField(h.world, enemy, STEALTH_SOURCES_COMPONENT, 'value0', CH);
    setField(h.world, watcher, DETECTION_SOURCES_COMPONENT, 'id0', 3);
    setField(h.world, watcher, DETECTION_SOURCES_COMPONENT, 'value0', CH);
    const changed = h.step();
    expect(getField(h.world, enemy, STEALTH_STATE_COMPONENT, 'mask')).toBe(CH);
    expect(getField(h.world, watcher, DETECTION_STATE_COMPONENT, 'mask')).toBe(CH);
    expect([...changed.changes.changedEntities(STEALTH_STATE_COMPONENT)]).toEqual([enemy]);
    expect([...changed.changes.changedEntities(DETECTION_STATE_COMPONENT)]).toEqual([watcher]);

    // Источники не менялись — состояние не dirty, сетевая дельта не растёт.
    const idle = h.step();
    expect(idle.changes.changedEntities(STEALTH_STATE_COMPONENT).size).toBe(0);
    expect(idle.changes.changedEntities(DETECTION_STATE_COMPONENT).size).toBe(0);
  });

  it('непарный StealthSources: состояние дописывается пересчётом при ненулевой свёртке', () => {
    const h = harness();
    h.place('Watcher', { Position: { x: F(1), y: F(1) } });
    // Носитель источников БЕЗ объявленного состояния и без Visibility: контент
    // не обязан спаривать компоненты сам — иначе потребители состояния (NPC-10,
    // maskCovered, доставка FOW-13) молча видели бы нуль при взведённой маске.
    const bearer = h.place('Wall', { Position: { x: F(2), y: F(2) } });
    addComponent(h.world, bearer, STEALTH_SOURCES_COMPONENT, {});
    h.step();
    // Свёртка нулевая — компонент не дописан: пустого состояния не публикуется.
    expect(getField(h.world, bearer, STEALTH_STATE_COMPONENT, 'mask')).toBe(0);

    setField(h.world, bearer, STEALTH_SOURCES_COMPONENT, 'id0', 7);
    setField(h.world, bearer, STEALTH_SOURCES_COMPONENT, 'value0', CH);
    h.step();
    expect(getField(h.world, bearer, STEALTH_STATE_COMPONENT, 'mask')).toBe(CH);

    // Источник снят — дописанное состояние гаснет, а не черствеет.
    setField(h.world, bearer, STEALTH_SOURCES_COMPONENT, 'id0', 0);
    setField(h.world, bearer, STEALTH_SOURCES_COMPONENT, 'value0', 0);
    h.step();
    expect(getField(h.world, bearer, STEALTH_STATE_COMPONENT, 'mask')).toBe(0);
  });

  it('публикация идёт и на тике без единой пары Visibility+Position (FOW-5)', () => {
    const h = harness();
    // В мире НЕТ целей пересчёта — только носитель источников детекции.
    const ward = h.place('Wall', { Position: { x: F(1), y: F(1) } });
    addComponent(h.world, ward, DETECTION_SOURCES_COMPONENT, {});
    setField(h.world, ward, DETECTION_SOURCES_COMPONENT, 'id0', 3);
    setField(h.world, ward, DETECTION_SOURCES_COMPONENT, 'value0', CH);
    h.step();

    expect(getField(h.world, ward, DETECTION_STATE_COMPONENT, 'mask')).toBe(CH);
  });

  it('система раньше якоря 900 читает свёртку прошлого пересчёта', () => {
    const h = harness();
    const enemy = h.place('Enemy', { Position: { x: F(1), y: F(3) } });
    const seen: number[] = [];
    h.systems.register({
      name: 'Probe',
      order: 100,
      run: (ctx) => {
        seen.push(ctx.get(enemy, STEALTH_STATE_COMPONENT, 'mask'));
      },
    });

    setField(h.world, enemy, STEALTH_SOURCES_COMPONENT, 'id0', 7);
    setField(h.world, enemy, STEALTH_SOURCES_COMPONENT, 'value0', CH);
    h.step();
    h.step();
    // Первый тик: источник уже стоит, но свёртка публикуется якорем 900 —
    // проба видит прошлое значение; со второго тика — свежее (FOW-3).
    expect(seen).toEqual([0, CH]);
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

  it('softStealthChannels без fog отвергается адресно (SER-7, FOW-12)', () => {
    const { fog: _fog, ...noFog } = SCENE;
    expect(() => loadScene({ ...noFog, prefabs: [], softStealthChannels: [1] })).toThrow(/SER-7/);
    expect(() => loadScene({ ...noFog, prefabs: [], softStealthChannels: [1] })).toThrow(/fog/);
  });

  it('номер канала вне [0, 31] и повтор отвергаются, называя причину (SER-7)', () => {
    expect(() => loadScene({ ...SCENE, softStealthChannels: [32] })).toThrow(/\[0, 31\]/);
    expect(() => loadScene({ ...SCENE, softStealthChannels: [-1] })).toThrow(/\[0, 31\]/);
    expect(() => loadScene({ ...SCENE, softStealthChannels: [3, 3] })).toThrow(/дважды/);
  });

  it('не-массив в softStealthChannels — адресный отказ, а не сырой TypeError (SER-5)', () => {
    const broken = { ...SCENE, softStealthChannels: 3 as unknown as readonly number[] };
    expect(() => loadScene(broken)).toThrow(/SER-7.*softStealthChannels/);
  });

  it('без перечисления все каналы жёсткие, с перечислением мягкие биты сняты (FOW-12)', () => {
    expect(loadScene(SCENE).stealthHardMask).toBe(~0);
    expect(loadScene({ ...SCENE, softStealthChannels: [0, 4] })).toHaveProperty(
      'stealthHardMask',
      ~((1 << 0) | (1 << 4)),
    );
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

/**
 * Вторая дверь того же запрета (FOW-5). Первую — сцену с `fog` без `terrain` —
 * закрывает загрузчик (SER-7, describe выше), но пересчёт видимости включает не
 * поле сцены, а флаг документа прогона (FOW-4, CLI-2), и компоненты видимости
 * сцена вправе объявить руками. Именно на такой сцене молчаливый фолбэк «уровня
 * нет» и жил: FoW считалась бы, а фильтр по высоте был бы выключен.
 */
describe('пересчёт видимости документа прогона без террейна (FOW-5)', () => {
  /** Компоненты тумана объявлены руками, флага `fog` нет — SER-7 тут молчит. */
  const HANDMADE: SceneDef = {
    components: [
      { name: 'Position', fields: { x: 'fixed', y: 'fixed' } },
      { name: 'Vision', fields: { radius: 'fixed' } },
      { name: VISIBILITY_COMPONENT, fields: { visibleTo: 'i32' } },
      { name: 'Team', fields: { id: 'i32' } },
    ],
  };

  it('сборка отвергает прогон до первого тика, называя недостающий террейн', () => {
    const build = (): unknown =>
      buildSimulation({ scene: HANDMADE, seed: 1, visibility: {} }, { where: 'тест' });
    expect(build).toThrow(/FOW-5/);
    expect(build).toThrow(/terrain/);
  });

  it('та же сцена с террейном собирается штатно', () => {
    expect(() =>
      buildSimulation(
        { scene: { ...HANDMADE, terrain: TERRAIN }, seed: 1, visibility: {} },
        { where: 'тест' },
      ),
    ).not.toThrow();
  });

  it('сцена без компонентов видимости прогону не мешает: считать в ней нечего', () => {
    // Так собраны записанные матчи (CLI-10): пересчёт объявлен наравне с
    // физикой, а компонентов тумана в сцене нет — фолбэка никто не наблюдает.
    expect(() =>
      buildSimulation(
        { scene: { components: [{ name: 'Position', fields: { x: 'fixed', y: 'fixed' } }] }, seed: 1, visibility: {} },
        { where: 'тест' },
      ),
    ).not.toThrow();
  });

  it('система, собранная мимо сборки, обрывает тик, а не считает без высоты', () => {
    const { world, systems, modifiers, stealthHardMask } = loadScene(SCENE);
    systems.register(
      new VisibilitySystem({
        lists: {
          vision: requireModifierList(modifiers, VISION_MODIFIER_COMPONENT),
          stealth: requireModifierList(modifiers, STEALTH_SOURCES_COMPONENT),
          detection: requireModifierList(modifiers, DETECTION_SOURCES_COMPONENT),
        },
        hardStealthMask: stealthHardMask ?? ~0,
      }),
    );
    // Тот же мир, но террейн сборке не отдан: раньше здесь молча выключался
    // фильтр по высоте, теперь тик обрывается.
    const sim: Simulation = { systems, worldSeed: 1, math: mathApi, modifiers };
    const state = initialState(world, 1);
    spawn(world, 'Watcher', { Position: { x: F(1), y: F(1) } });
    spawn(world, 'Enemy', { Position: { x: F(1), y: F(2) } });

    expect(() => tick(sim, state)).toThrow(/FOW-5/);
  });
});
