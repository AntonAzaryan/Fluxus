/**
 * Перечисление состава мира: `componentNames` и `prefabNames` (ECS-4, SER-7).
 *
 * Спрашивать `componentSchema`/`prefabOf` можно только по имени, а имён у
 * потребителя нет — редактору они нужны, чтобы предлагать ровно то множество,
 * которое ядро принимает (решение 5а change'а `editor-authoring-areas`).
 * Проверяется здесь ровно то, на что редактор опирается: порядок совпадает с
 * порядком объявления (он нормативен, SER-7, и задаёт битовые id), в перечне
 * присутствуют схемы и prefabs, дописанные загрузчиком, и оба хелпера — чтение
 * (мир после вызова тот же, TICK-3).
 */
import { describe, expect, it } from 'vitest';
import {
  cloneWorld,
  componentId,
  componentNames,
  componentSchema,
  createWorld,
  prefabNames,
  prefabOf,
  toPlain,
} from '../src/ecs/world.js';
import { loadScene, type SceneDef } from '../src/sim/scene.js';
import { FLOOR_COMPONENT, TERRAIN_PREFAB, type TerrainDef } from '../src/systems/terrain.js';
import { ARENA_COMPONENT, ARENA_PREFAB, ARENA_STATE_COMPONENT } from '../src/systems/arena.js';
import {
  STEALTH_COMPONENT,
  TEAM_COMPONENT,
  VISIBILITY_COMPONENT,
  VISION_COMPONENT,
  VISION_MODIFIER_COMPONENT,
} from '../src/systems/visibility.js';
import * as core from '../src/index.js';
import type { ComponentSchema } from '../src/types.js';

const TERRAIN: TerrainDef = {
  width: 2,
  height: 2,
  tileSize: 65536,
  levels: ['00', '00'],
  flags: ['..', '..'],
};

const ARENA = { center: { x: 0, y: 0 }, radius: 262144 } as const;

/**
 * Имена компонентов нарочно не по алфавиту: перечень обязан вернуть порядок
 * объявления, а не отсортированный (в отличие от `toPlain`, SER-6).
 */
const DECLARED: readonly ComponentSchema[] = [
  { name: 'Zeta', fields: { a: 'i32' } },
  { name: 'Alpha', fields: { x: 'fixed', y: 'fixed' } },
  { name: 'Mid', fields: { hp: 'i32' } },
];

const SCENE: SceneDef = {
  components: DECLARED,
  prefabs: [
    { name: 'Prop', components: { Mid: { hp: 1 } } },
    { name: 'Actor', components: { Alpha: {}, [ARENA_STATE_COMPONENT]: {} } },
  ],
  capacity: 16,
  terrain: TERRAIN,
  arena: ARENA,
  fog: true,
};

describe('componentNames: перечень компонентов мира (SER-7)', () => {
  it('порядок совпадает с порядком объявления схем, а не с алфавитом', () => {
    const world = createWorld(DECLARED);
    expect(componentNames(world)).toEqual(['Zeta', 'Alpha', 'Mid']);
  });

  it('порядок перечня — это порядок битовых id (componentId)', () => {
    const { world } = loadScene(SCENE);
    const ids = componentNames(world).map((name) => componentId(world, name));
    expect(ids).toEqual(ids.map((_, position) => position));
  });

  it('каждое имя перечня принимается componentSchema, и других имён у мира нет', () => {
    const { world } = loadScene(SCENE);
    const names = componentNames(world);
    for (const name of names) expect(componentSchema(world, name)?.name).toBe(name);
    expect(componentSchema(world, 'Ghost')).toBeUndefined();
    expect(new Set(names).size).toBe(names.length);
  });

  it('схемы, дописанные загрузчиком, в перечне есть — и стоят после объявленных', () => {
    const { world } = loadScene(SCENE);
    const names = componentNames(world);
    expect(names.slice(0, 3)).toEqual(['Zeta', 'Alpha', 'Mid']);
    // Порядок дописывания нормативен (SER-7): floor → arena → … → fow.
    expect(names.slice(3)).toEqual([
      FLOOR_COMPONENT,
      ARENA_COMPONENT,
      ARENA_STATE_COMPONENT,
      VISION_COMPONENT,
      VISIBILITY_COMPONENT,
      STEALTH_COMPONENT,
      TEAM_COMPONENT,
      VISION_MODIFIER_COMPONENT,
    ]);
  });

  it('сцена без террейна, арены и тумана перечисляет только объявленное', () => {
    const { world } = loadScene({ components: DECLARED, capacity: 8 });
    expect(componentNames(world)).toEqual(['Zeta', 'Alpha', 'Mid']);
  });

  it('копия мира перечисляет то же самое в том же порядке', () => {
    const { world } = loadScene(SCENE);
    expect(componentNames(cloneWorld(world))).toEqual(componentNames(world));
  });
});

describe('prefabNames: перечень prefab’ов мира (ECS-4)', () => {
  it('содержит объявленные сценой и дописанные загрузчиком носители', () => {
    const { world } = loadScene(SCENE);
    expect(prefabNames(world)).toEqual(['Prop', 'Actor', TERRAIN_PREFAB, ARENA_PREFAB]);
  });

  it('каждое имя перечня принимается prefabOf, и других имён у мира нет', () => {
    const { world } = loadScene(SCENE);
    for (const name of prefabNames(world)) expect(prefabOf(world, name)?.name).toBe(name);
    expect(prefabOf(world, 'Ghost')).toBeUndefined();
  });

  it('мир без prefab’ов даёт пустой перечень, а не отказ', () => {
    expect(prefabNames(createWorld(DECLARED))).toEqual([]);
  });
});

describe('перечисление — чтение (TICK-3)', () => {
  it('вызовы не меняют мир и не отдают наружу его внутренних структур', () => {
    const { world } = loadScene(SCENE);
    const before = toPlain(world);
    const names = componentNames(world) as string[];
    const prefabs = prefabNames(world) as string[];
    // Массив свой: правка возвращённого не задевает мир.
    names.push('Injected');
    prefabs.length = 0;
    expect(toPlain(world)).toEqual(before);
    expect(componentSchema(world, 'Injected')).toBeUndefined();
    expect(componentNames(world)).toHaveLength(names.length - 1);
    expect(prefabNames(world)).toHaveLength(4);
  });

  it('обе функции опубликованы в пространстве world рядом с componentSchema/prefabOf', () => {
    const { world } = loadScene(SCENE);
    expect(core.world.componentNames(world)).toEqual(componentNames(world));
    expect(core.world.prefabNames(world)).toEqual(prefabNames(world));
    // Публикуется только чтение: мутаторов мира в пространстве по-прежнему нет.
    expect(Object.keys(core.world)).not.toContain('spawn');
    expect(Object.keys(core.world)).not.toContain('setField');
  });
});
