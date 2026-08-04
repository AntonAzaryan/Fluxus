import { describe, expect, it } from 'vitest';
import { contentPackHash } from '../src/sim/contentPack.js';
import { runScenario, type ScenarioDef } from '../src/sim/scenario.js';
import type { SceneDef } from '../src/sim/scene.js';

/**
 * Хеш контент-пака (NET-17). Сцена держится минимальной, но обязана содержать
 * всё, что в состав входит, — компоненты, prefab, JSON-систему, твины и флаги, —
 * иначе тесты границы проверяют пустоту.
 */
const BASE: SceneDef = {
  components: [
    { name: 'Position', fields: { x: 'fixed', y: 'fixed' } },
    { name: 'Health', fields: { value: 'fixed' }, defaults: { value: 65536 } },
  ],
  prefabs: [{ name: 'Unit', components: { Position: { x: 65536, y: 65536 }, Health: {} } }],
  systems: [
    {
      name: 'drift',
      order: 10,
      query: { all: ['Position'] },
      do: [
        {
          modifyComponent: {
            entity: { var: 'entity' },
            component: 'Position',
            values: { x: { getComponent: [{ var: 'entity' }, 'Position', 'x'] } },
          },
        },
      ],
    },
  ],
  terrain: {
    width: 4,
    height: 3,
    tileSize: 65536,
    levels: ['0122', '0122', '0011'],
    flags: ['..^_', '..^.', '....'],
  },
  arena: { center: { x: 131072, y: 98304 }, radius: 262144 },
  tweens: [{ target: 'Health.value' }],
  timeScale: true,
  fog: true,
  capacity: 16,
};

const withScene = (patch: Partial<SceneDef>): SceneDef => ({ ...BASE, ...patch });

/** Хеш `worldInit` той же сцены — нужен там, где проверяется граница двух зон. */
const worldInitHashOf = (scene: SceneDef): string =>
  runScenario({
    name: 'contentpack',
    seed: 7,
    ticks: 0,
    scene,
    initial: [{ prefab: 'Unit' }],
  } as ScenarioDef).worldInitHash;

describe('хеш контент-пака (NET-17)', () => {
  it('восемь строчных hex-цифр и повторяемость', () => {
    const hash = contentPackHash(BASE);
    expect(hash).toMatch(/^[0-9a-f]{8}$/);
    expect(contentPackHash(BASE)).toBe(hash);
  });

  it('устойчив к переформатированию конфига', () => {
    // Тот же конфиг с другим порядком ключей во всех объектах: хеш считается от
    // канонического представления, а не от записи документа.
    const reordered: SceneDef = {
      fog: true,
      capacity: 16,
      timeScale: true,
      tweens: [{ target: 'Health.value' }],
      arena: { radius: 262144, center: { y: 98304, x: 131072 } },
      terrain: {
        flags: ['..^_', '..^.', '....'],
        levels: ['0122', '0122', '0011'],
        tileSize: 65536,
        height: 3,
        width: 4,
      },
      systems: [
        {
          do: [
            {
              modifyComponent: {
                values: { x: { getComponent: [{ var: 'entity' }, 'Position', 'x'] } },
                component: 'Position',
                entity: { var: 'entity' },
              },
            },
          ],
          query: { all: ['Position'] },
          order: 10,
          name: 'drift',
        },
      ],
      prefabs: [{ components: { Health: {}, Position: { y: 65536, x: 65536 } }, name: 'Unit' }],
      components: [
        { fields: { y: 'fixed', x: 'fixed' }, name: 'Position' },
        { defaults: { value: 65536 }, fields: { value: 'fixed' }, name: 'Health' },
      ],
    };
    expect(contentPackHash(reordered)).toBe(contentPackHash(BASE));
  });

  it('ловит перестановку компонентов и перестановку систем', () => {
    // Порядок компонентов задаёт битовые id, порядок систем — порядок
    // исполнения (SER-7, DET-3): и то и другое — разные правила.
    const swapped = withScene({ components: [BASE.components[1]!, BASE.components[0]!] });
    expect(contentPackHash(swapped)).not.toBe(contentPackHash(BASE));

    const second = { ...BASE.systems![0]!, name: 'other', order: 20 };
    const forward = withScene({ systems: [BASE.systems![0]!, second] });
    const backward = withScene({ systems: [second, BASE.systems![0]!] });
    expect(contentPackHash(backward)).not.toBe(contentPackHash(forward));
  });

  it('ловит правку тела JSON-системы', () => {
    // Базовый сценарий, ради которого требование заведено: правила — данные,
    // и правка одной системы обязана быть сменой версии.
    const edited = withScene({
      systems: [
        {
          ...BASE.systems![0]!,
          do: [
            {
              modifyComponent: {
                entity: { var: 'entity' },
                component: 'Position',
                values: { y: { getComponent: [{ var: 'entity' }, 'Position', 'y'] } },
              },
            },
          ],
        },
      ],
    });
    expect(contentPackHash(edited)).not.toBe(contentPackHash(BASE));
  });

  it('разрешает умолчания до хеширования', () => {
    const { modifierSlots: _omitted, ...withoutSlots } = { ...BASE, modifierSlots: 4 };
    expect(contentPackHash(withoutSlots as SceneDef)).toBe(contentPackHash({ ...BASE, modifierSlots: 4 }));
    expect(contentPackHash({ ...BASE, modifierSlots: 8 })).not.toBe(contentPackHash(BASE));

    // Нулевое умолчание поля — то же самое, что его отсутствие: `spawn` читает
    // `defaults?.[field] ?? 0`.
    const zeroDefault = withScene({
      components: [{ ...BASE.components[0]!, defaults: { x: 0, y: 0 } }, BASE.components[1]!],
    });
    expect(contentPackHash(zeroDefault)).toBe(contentPackHash(BASE));
  });

  it('не различает пустые и отсутствующие prefabs/systems, но различает таблицу твинов', () => {
    // Загрузчик берёт prefabs и systems через `?? []` — записи эквивалентны.
    const { prefabs: _p, systems: _s, ...withoutLists } = BASE;
    expect(contentPackHash({ ...withoutLists, prefabs: [], systems: [] })).toBe(
      contentPackHash(withoutLists as SceneDef),
    );

    // А отсутствие таблицы твинов выключает `TweenSystem` и убирает компонент
    // `Tween` из состава — это другой формат снапшота, а не другая запись.
    const { tweens: _t, ...withoutTweens } = BASE;
    expect(contentPackHash({ ...withoutTweens, tweens: [] })).not.toBe(contentPackHash(withoutTweens as SceneDef));
  });

  it('не пересекается с хешем worldInit: ассеты и ёмкость мира — не его зона', () => {
    // Обе зоны в одном тесте намеренно: граница NET-17 против DET-1 должна
    // проверяться, а не подразумеваться.
    const otherArena = withScene({ arena: { center: { x: 65536, y: 65536 }, radius: 131072 } });
    const otherTerrain = withScene({
      terrain: { ...BASE.terrain!, levels: ['0000', '0000', '0000'] },
    });
    const otherCapacity = withScene({ capacity: 32 });

    for (const scene of [otherArena, otherTerrain, otherCapacity]) {
      expect(contentPackHash(scene)).toBe(contentPackHash(BASE));
      expect(worldInitHashOf(scene)).not.toBe(worldInitHashOf(BASE));
    }
  });
});
