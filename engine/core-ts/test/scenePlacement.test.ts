/**
 * Начальная расстановка конфига сцены (SER-7, SER-8).
 *
 * Проверяется ровно то, от чего зависит хеш `worldInit`: порядок выдачи ID
 * (ID-2, DET-6), сложение расстановки сцены с расстановкой документа прогона,
 * граница хеша контент-пака (NET-17) и отказ загрузки на битой записи
 * (SER-5, ECS-5).
 */
import { describe, expect, it } from 'vitest';
import { getField, hasComponent, indexOf, listAlive } from '../src/ecs/world.js';
import { loadScene, type SceneDef } from '../src/sim/scene.js';
import { runScenario, type ScenarioDef } from '../src/sim/scenario.js';
import { contentPackHash } from '../src/sim/contentPack.js';
import { FLOOR_COMPONENT } from '../src/systems/terrain.js';
import { ARENA_COMPONENT } from '../src/systems/arena.js';
import type { ScenarioSpawn } from '../src/sim/placement.js';

/**
 * Минимальная сцена: один компонент-метка, чтобы расставленные сущности
 * отличались друг от друга значением поля, а не порядком в тесте.
 */
const BASE: SceneDef = {
  components: [{ name: 'Mark', fields: { id: 'i32' } }],
  prefabs: [{ name: 'Prop', components: { Mark: { id: 0 } } }],
  capacity: 16,
};

const TERRAIN = {
  width: 2,
  height: 2,
  tileSize: 65536,
  levels: ['00', '00'],
  flags: ['..', '..'],
} as const;

const ARENA = { center: { x: 0, y: 0 }, radius: 262144 } as const;

const prop = (id: number): ScenarioSpawn => ({ prefab: 'Prop', overrides: { Mark: { id } } });

const withScene = (patch: Partial<SceneDef>): SceneDef => ({ ...BASE, ...patch });

/** Метки всех расставленных сущностей в порядке индексов слотов. */
function marks(scene: SceneDef): number[] {
  const { world } = loadScene(scene);
  const out: number[] = [];
  for (const entity of listAlive(world)) {
    if (hasComponent(world, entity, 'Mark')) out.push(getField(world, entity, 'Mark', 'id'));
  }
  return out;
}

const hashOf = (def: Partial<ScenarioDef> & { scene: SceneDef }): string =>
  runScenario({ name: 'placement', seed: 7, ticks: 0, ...def }).worldInitHash;

describe('расстановка конфига сцены (SER-7, SER-8)', () => {
  it('носители порождённых компонентов идут первыми, расставленное — в порядке списка (SER-7, SER-8)', () => {
    const { world } = loadScene(
      withScene({ terrain: TERRAIN, arena: ARENA, initial: [prop(1), prop(2), prop(3)] }),
    );

    const alive = [...listAlive(world)];
    expect(alive).toHaveLength(5);
    // Слоты выдаются подряд: ID расставленного — функция порядка, а не удачи (ID-2).
    expect(alive.map((entity) => indexOf(world, entity))).toEqual([0, 1, 2, 3, 4]);
    expect(hasComponent(world, alive[0]!, FLOOR_COMPONENT)).toBe(true);
    expect(hasComponent(world, alive[1]!, ARENA_COMPONENT)).toBe(true);
    expect(alive.slice(2).map((entity) => getField(world, entity, 'Mark', 'id'))).toEqual([1, 2, 3]);
  });

  it('перестановка двух записей меняет index местами и меняет worldInitHash (SER-8)', () => {
    const straight = withScene({ initial: [prop(1), prop(2)] });
    const swapped = withScene({ initial: [prop(2), prop(1)] });

    expect(marks(straight)).toEqual([1, 2]);
    expect(marks(swapped)).toEqual([2, 1]);
    expect(hashOf({ scene: swapped })).not.toBe(hashOf({ scene: straight }));
  });

  it('добавление арены сдвигает index расставленного на один (SER-7)', () => {
    const plain = withScene({ initial: [prop(1), prop(2)] });
    const withArena = withScene({ arena: ARENA, initial: [prop(1), prop(2)] });

    const { world } = loadScene(plain);
    const placed = [...listAlive(world)];
    expect(placed.map((entity) => indexOf(world, entity))).toEqual([0, 1]);

    const shifted = loadScene(withArena);
    const aliveShifted = [...listAlive(shifted.world)];
    expect(hasComponent(shifted.world, aliveShifted[0]!, ARENA_COMPONENT)).toBe(true);
    // Расстановка не менялась, а ID сдвинулись — законное изменение worldInit.
    expect(aliveShifted.slice(1).map((entity) => indexOf(shifted.world, entity))).toEqual([1, 2]);
    expect(hashOf({ scene: withArena })).not.toBe(hashOf({ scene: plain }));
  });

  it('две записи с одним prefab’ом дают две сущности с последовательными index (SER-8)', () => {
    const { world } = loadScene(withScene({ initial: [{ prefab: 'Prop' }, { prefab: 'Prop' }] }));

    const alive = [...listAlive(world)];
    expect(alive).toHaveLength(2);
    expect(alive[0]).not.toBe(alive[1]);
    expect(alive.map((entity) => indexOf(world, entity))).toEqual([0, 1]);
  });

  it('расстановки сцены и прогона складываются, сцена первой (SER-8)', () => {
    const scene = withScene({ initial: [prop(1), prop(2)] });
    const { ticks } = runScenario({
      name: 'placement',
      seed: 7,
      ticks: 0,
      scene,
      initial: [prop(3)],
    });

    // Расстановка сценария не замещает расстановку сцены: в мире три сущности,
    // и порядок «сцена, затем прогон» виден по значениям меток на первых слотах.
    expect(ticks[0]!.world.aliveCount).toBe(3);
    expect(ticks[0]!.world.components['Mark']!['id']!.slice(0, 3)).toEqual([1, 2, 3]);
  });

  it('отсутствующий и пустой initial неразличимы (SER-8)', () => {
    const absent = withScene({});
    const empty = withScene({ initial: [] });

    expect(loadScene(empty).world).toBeDefined();
    expect([...listAlive(loadScene(empty).world)]).toHaveLength(0);
    expect(hashOf({ scene: empty })).toBe(hashOf({ scene: absent }));
    expect(contentPackHash(empty)).toBe(contentPackHash(absent));
  });

  it('правка initial меняет worldInitHash и не меняет contentPackHash (NET-17, SER-8)', () => {
    const one = withScene({ initial: [prop(1)] });
    const two = withScene({ initial: [prop(1), prop(2)] });

    expect(hashOf({ scene: two })).not.toBe(hashOf({ scene: one }));
    // Расстановка — данные матча, а не правила: в каноническое представление
    // контент-пака она не входит (NET-17).
    expect(contentPackHash(two)).toBe(contentPackHash(one));
    expect(contentPackHash(withScene({ initial: [prop(9)] }))).toBe(contentPackHash(BASE));
  });
});

describe('валидация записи расстановки на загрузке (SER-5, ECS-5)', () => {
  it('неизвестное имя prefab’а — ошибка с именем', () => {
    expect(() => loadScene(withScene({ initial: [{ prefab: 'Ghost' }] }))).toThrow(/Ghost/);
  });

  it('компонент вне состава prefab’а — ошибка с именем компонента (CMD-6)', () => {
    expect(() =>
      loadScene(withScene({ initial: [{ prefab: 'Prop', overrides: { Health: { value: 1 } } }] })),
    ).toThrow(/не содержит компонент "Health"/);
  });

  it('поле вне схемы компонента — ошибка с именем поля (ECS-3)', () => {
    expect(() =>
      loadScene(withScene({ initial: [{ prefab: 'Prop', overrides: { Mark: { hp: 1 } } }] })),
    ).toThrow(/нет поля "hp"/);
  });

  it('ошибка называет номер записи — по имени prefab’а автор её не найдёт', () => {
    expect(() =>
      loadScene(withScene({ initial: [{ prefab: 'Prop' }, { prefab: 'Ghost' }] })),
    ).toThrow(/запись #1/);
  });

  it('запись без prefab’а отвергается до первого тика', () => {
    const broken = { overrides: { Mark: { id: 1 } } } as unknown as ScenarioSpawn;
    expect(() => loadScene(withScene({ initial: [broken] }))).toThrow(/"prefab"/);
  });
});
