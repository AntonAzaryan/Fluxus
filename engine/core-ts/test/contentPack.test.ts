import { describe, expect, it } from 'vitest';
import { contentPackHash } from '../src/sim/contentPack.js';
import { runScenario } from '../src/sim/scenario.js';
import { NO_ENTITY } from '../src/types.js';
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
    levels: ['0112', '0112', '0011'],
    flags: ['..^_', '..^.', '....'],
  },
  arena: { center: { x: 131072, y: 98304 }, radius: 262144 },
  tweens: [{ target: 'Health.value' }],
  timeScale: true,
  fog: true,
  capacity: 16,
};

const withScene = (patch: Partial<SceneDef>): SceneDef => ({ ...BASE, ...patch });

/**
 * Та же сцена с платформой способностей: таблицы определений и блок биндингов
 * (NET-17). Определения минимальны, но каждое несёт величину, которую правит
 * дизайнер, — кулдаун у способности и длительность у баффа.
 */
const ABILITY: SceneDef = withScene({
  components: [
    ...BASE.components,
    { name: 'Player', fields: { slot: 'i32' } },
    { name: 'Dead', fields: { atTick: 'i32' } },
  ],
  abilities: [
    {
      id: 'bolt',
      trigger: { input: { bit: 0 } },
      cooldownTicks: 30,
      effects: [{ emitEvent: { type: 'Bolt', data: { slot: { var: 'self' } } } }],
    },
  ],
  buffs: [{ id: 'burn', class: 'negative', durationTicks: 60 }],
  abilityRuntime: { deadMarker: 'Dead', teamField: ['Player', 'slot'] },
});

const withAbilityScene = (patch: Partial<SceneDef>): SceneDef => ({ ...ABILITY, ...patch });

/** Хеш `worldInit` той же сцены — нужен там, где проверяется граница двух зон. */
const worldInitHashOf = (scene: SceneDef): string =>
  runScenario({
    name: 'contentpack',
    seed: 7,
    ticks: 0,
    scene,
    initial: [{ prefab: 'Unit' }],
  }).worldInitHash;

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
        levels: ['0112', '0112', '0011'],
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

    // Умолчание, равное нейтральному значению ТИПА поля, — то же самое, что его
    // отсутствие: `spawn` и `addComponent` читают `defaults?.[field] ?? neutralValue(type)`,
    // и у `i32`/`fixed` нейтральное — ноль (ECS-3).
    const zeroDefault = withScene({
      components: [{ ...BASE.components[0]!, defaults: { x: 0, y: 0 } }, BASE.components[1]!],
    });
    expect(contentPackHash(zeroDefault)).toBe(contentPackHash(BASE));
  });

  /**
   * NET-17 (зонтичное правило): представление воспроизводит различения
   * загрузчика. У `entity`-поля нейтральное значение — «ссылки нет» (`NO_ENTITY`,
   * ECS-6), а ноль — валидный `EntityId` первого слота мира: `{other: 0}` и
   * отсутствие умолчания загрузчик различает — обязан различать и хеш, иначе два
   * участника с такими конфигами прошли бы сверку версий (NET-16) и разошлись
   * на первом же рантайм-спавне компонента.
   */
  it('нулевое умолчание entity-поля значимо: ноль — ссылка, а не «нет ссылки» (NET-17, ECS-6)', () => {
    const link = (defaults?: Record<string, number>): SceneDef =>
      withScene({
        components: [...BASE.components, { name: 'Link', fields: { other: 'entity' }, ...(defaults ? { defaults } : {}) }],
      });

    // `{other: 0}` — ссылка на нулевой слот, отсутствие — `NO_ENTITY`: правила разные.
    expect(contentPackHash(link({ other: 0 }))).not.toBe(contentPackHash(link()));
    // А явно выписанное «ссылки нет» и есть нейтральное значение типа.
    expect(contentPackHash(link({ other: NO_ENTITY }))).toBe(contentPackHash(link()));
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

  it('softStealthChannels — зона правил: хеш пака двигается, worldInit — нет (FOW-12)', () => {
    // Жёсткость канала меняет пересчёт видимости при том же мире: таблица в
    // снапшот не входит, но правила ею другие — граница противоположна ассетам.
    const soft = withScene({ softStealthChannels: [3] });
    expect(contentPackHash(soft)).not.toBe(contentPackHash(BASE));
    expect(worldInitHashOf(soft)).toBe(worldInitHashOf(BASE));

    // Отсутствие поля и пустой список загрузчик не различает — не различает и хеш;
    // порядок перечисления — множество, нормализуется сортировкой.
    expect(contentPackHash(withScene({ softStealthChannels: [] }))).toBe(contentPackHash(BASE));
    expect(contentPackHash(withScene({ softStealthChannels: [4, 1] }))).toBe(
      contentPackHash(withScene({ softStealthChannels: [1, 4] })),
    );
  });
});

describe('хеш контент-пака: определения способностей и баффов (NET-17)', () => {
  it('дизайнер поправил кулдаун — хеши не совпадают, и матч не собирается', () => {
    // Базовый сценарий, ради которого определения в представление и вошли:
    // участники с разной длительностью кулдауна играют в разные игры, и
    // расхождение обязано обнаружиться до старта, а не по исходу боя.
    const tweaked = withAbilityScene({
      abilities: [{ ...ABILITY.abilities![0]!, cooldownTicks: 45 }],
    });
    expect(contentPackHash(tweaked)).not.toBe(contentPackHash(ABILITY));

    // То же и у баффа: длительность — правило, а не оформление.
    const shorter = withAbilityScene({ buffs: [{ ...ABILITY.buffs![0]!, durationTicks: 30 }] });
    expect(contentPackHash(shorter)).not.toBe(contentPackHash(ABILITY));
  });

  it('изменён биндинг смерти — хеш меняется', () => {
    // Определения те же, а касты прерываются в разные моменты: блок биндингов
    // называет, что в этой сцене значит смерть (ABIL-8).
    const rebound = withAbilityScene({
      abilityRuntime: { ...ABILITY.abilityRuntime!, deadMarker: 'Downed' },
    });
    expect(contentPackHash(rebound)).not.toBe(contentPackHash(ABILITY));
  });

  it('заменён ассет арены — хеш не меняется и при объявленных определениях', () => {
    // Контроль границы двух зон (NET-17 против DET-1): появление таблиц
    // определений её не двигает.
    const otherArena = withAbilityScene({ arena: { center: { x: 0, y: 0 }, radius: 131072 } });
    expect(contentPackHash(otherArena)).toBe(contentPackHash(ABILITY));
  });

  it('отсутствующая и пустая таблицы дают разные хеши, а блок биндингов — один', () => {
    // Отсутствие таблицы убирает из состава компоненты платформы и её системы
    // (SER-7) — это другой формат снапшота, а пустая таблица его не меняет.
    const { abilities: _a, ...withoutAbilities } = ABILITY;
    expect(contentPackHash({ ...withoutAbilities, abilities: [] })).not.toBe(
      contentPackHash(withoutAbilities as SceneDef),
    );
    const { buffs: _b, ...withoutBuffs } = ABILITY;
    expect(contentPackHash({ ...withoutBuffs, buffs: [] })).not.toBe(contentPackHash(withoutBuffs as SceneDef));

    // А биндинг, которого нет, и биндинг, который ничего не называет, загрузчик
    // не различает — не различает и хеш.
    const { abilityRuntime: _r, ...withoutRuntime } = ABILITY;
    expect(contentPackHash({ ...withoutRuntime, abilityRuntime: {} })).toBe(
      contentPackHash(withoutRuntime as SceneDef),
    );
  });

  it('порядок определений — часть формата, порядок ключей внутри них — нет', () => {
    // Индекс в таблице есть адрес определения в мире (ABIL-1), поэтому
    // перестановка определений — смена правил.
    const second = { ...ABILITY.abilities![0]!, id: 'dart', cooldownTicks: 10 };
    const forward = withAbilityScene({ abilities: [ABILITY.abilities![0]!, second] });
    const backward = withAbilityScene({ abilities: [second, ABILITY.abilities![0]!] });
    expect(contentPackHash(backward)).not.toBe(contentPackHash(forward));

    // А запись того же определения другим порядком ключей — то же правило.
    const reordered = withAbilityScene({
      abilities: [
        {
          effects: [{ emitEvent: { data: { slot: { var: 'self' } }, type: 'Bolt' } }],
          cooldownTicks: 30,
          trigger: { input: { bit: 0 } },
          id: 'bolt',
        },
      ],
      abilityRuntime: { teamField: ['Player', 'slot'], deadMarker: 'Dead' },
    });
    expect(contentPackHash(reordered)).toBe(contentPackHash(ABILITY));
  });
});
