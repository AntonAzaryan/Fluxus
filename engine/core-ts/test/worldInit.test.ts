import { describe, expect, it } from 'vitest';
import { runScenario, type ScenarioDef } from '../src/sim/scenario.js';
import { worldInitForm, type WorldInitParts } from '../src/sim/worldInit.js';
import { loadScene } from '../src/sim/scene.js';
import { canonicalJson } from '../src/sim/canonicalJson.js';
import { listAlive, spawn } from '../src/ecs/world.js';

/**
 * Хеш `worldInit` (DET-1). Сцена держится минимальной, но обязана содержать и
 * террейн, и арену: обе иммутабельные части в снапшот не входят (TERR-6,
 * ARENA-1), и именно на них хеш от снапшота тика 0 промахнулся бы.
 */
const BASE: ScenarioDef = {
  name: 'worldinit',
  seed: 7,
  ticks: 0,
  scene: {
    components: [{ name: 'Position', fields: { x: 'fixed', y: 'fixed' } }],
    prefabs: [{ name: 'Unit', components: { Position: { x: 65536, y: 65536 } } }],
    terrain: {
      width: 4,
      height: 3,
      tileSize: 65536,
      levels: ['0122', '0122', '0011'],
      flags: ['..^_', '..^.', '....'],
    },
    arena: { center: { x: 131072, y: 98304 }, radius: 262144 },
    capacity: 16,
  },
  initial: [{ prefab: 'Unit' }],
};

const hashOf = (def: ScenarioDef): string => runScenario(def).worldInitHash;

/**
 * Части `worldInit` из загруженной сцены — той же сборкой, какой их собирает
 * `buildMatchWorld` (`sim/build.ts`): часть, которой у сцены нет, ключа не
 * получает вовсе. Форма читает ИМЕННО отсутствие (`parts.terrain !==
 * undefined`), и собирать её из ключей со значением `undefined` значило бы
 * проверять состояние, в котором сборка матча не бывает.
 */
const partsOf = (loaded: ReturnType<typeof loadScene>): WorldInitParts => ({
  world: loaded.world,
  mode: 'Running',
  ...(loaded.terrain !== undefined ? { terrain: loaded.terrain } : {}),
  ...(loaded.arena !== undefined ? { arena: loaded.arena } : {}),
});

/** Глубокая правка сцены без мутации исходника: сценарии в тестах переиспользуются. */
const withScene = (patch: Record<string, unknown>): ScenarioDef => ({
  ...BASE,
  scene: { ...BASE.scene, ...patch },
});

describe('worldInit hash (DET-1)', () => {
  it('устойчив к переформатированию ассета', () => {
    // Тот же контент двумя разными документами: компактный против pretty с
    // другим порядком ключей. Хеш считается от распакованного представления,
    // поэтому оба обязаны дать одно значение (DET-1, «Переформатирование ассета»).
    const compact = JSON.stringify(BASE);
    const reordered = JSON.stringify(
      {
        scene: {
          arena: { radius: 262144, center: { y: 98304, x: 131072 } },
          capacity: 16,
          terrain: {
            flags: ['..^_', '..^.', '....'],
            levels: ['0122', '0122', '0011'],
            tileSize: 65536,
            height: 3,
            width: 4,
          },
          prefabs: [{ name: 'Unit', components: { Position: { y: 65536, x: 65536 } } }],
          components: [{ name: 'Position', fields: { y: 'fixed', x: 'fixed' } }],
        },
        initial: [{ prefab: 'Unit' }],
        ticks: 0,
        seed: 7,
        name: 'worldinit',
      },
      null,
      2,
    );

    expect(hashOf(JSON.parse(compact) as ScenarioDef)).toBe(
      hashOf(JSON.parse(reordered) as ScenarioDef),
    );
  });

  it('не зависит от seed', () => {
    // Стартовое состояние стримов выводится из seed (RNG-7) и в worldInit не
    // входит: расхождение случайности не должно выдавать себя за расхождение данных.
    expect(hashOf({ ...BASE, seed: 999_999 })).toBe(hashOf(BASE));
  });

  it('меняется при другой карте уровней', () => {
    const other = withScene({
      terrain: { ...BASE.scene.terrain!, levels: ['0123', '0122', '0011'] },
    });
    expect(hashOf(other)).not.toBe(hashOf(BASE));
  });

  it('меняется при другом центре арены', () => {
    // Центр в компонент не кладётся (ARENA-1), в мир не попадает и в снапшоте
    // его нет — если бы форма собиралась из снапшота, этот тест был бы красным.
    const other = withScene({ arena: { center: { x: 131073, y: 98304 }, radius: 262144 } });
    expect(hashOf(other)).not.toBe(hashOf(BASE));
  });

  it('меняется при другом стартовом радиусе арены', () => {
    // Радиус, в отличие от центра, живёт компонентом и входит через мир —
    // сценарий ARENA-1 требует, чтобы хеш учитывал оба.
    const other = withScene({ arena: { center: { x: 131072, y: 98304 }, radius: 262145 } });
    expect(hashOf(other)).not.toBe(hashOf(BASE));
  });

  it('меняется при другой стартовой расстановке', () => {
    expect(hashOf({ ...BASE, initial: [{ prefab: 'Unit' }, { prefab: 'Unit' }] })).not.toBe(
      hashOf(BASE),
    );
  });

  it('меняется при других значениях полей расстановки', () => {
    const other: ScenarioDef = {
      ...BASE,
      initial: [{ prefab: 'Unit', overrides: { Position: { x: 131072 } } }],
    };
    expect(hashOf(other)).not.toBe(hashOf(BASE));
  });

  it('считается для сцены без террейна и без арены', () => {
    const bare: ScenarioDef = {
      name: 'bare',
      seed: 1,
      ticks: 0,
      scene: {
        components: [{ name: 'Position', fields: { x: 'fixed', y: 'fixed' } }],
        prefabs: [{ name: 'Unit', components: { Position: { x: 0, y: 0 } } }],
        capacity: 8,
      },
      initial: [{ prefab: 'Unit' }],
    };
    expect(hashOf(bare)).toMatch(/^[0-9a-f]{8}$/);
  });

  it('всегда восемь строчных hex-цифр, включая старший нулевой полубайт', () => {
    // Ширина фиксирована, чтобы порт на языке со знаковым 32-битным целым не
    // напечатал отрицательное и чтобы значение с ведущим нулём не ужалось.
    const hashes = Array.from({ length: 64 }, (_, i) =>
      hashOf({ ...BASE, initial: [{ prefab: 'Unit', overrides: { Position: { x: i } } }] }),
    );
    for (const hash of hashes) expect(hash).toMatch(/^[0-9a-f]{8}$/);
    // Детерминированный набор: если бы `padStart` пропал, эти значения стали бы короче.
    expect(hashes.filter((hash) => hash.startsWith('0')).length).toBeGreaterThan(0);
  });

  it('стабилен между прогонами', () => {
    expect(hashOf(BASE)).toBe(hashOf(BASE));
  });

  it('зафиксирован значением: изменение состава представления сдвинуло бы хеш молча', () => {
    // Сравнение двух прогонов ловит недетерминизм, но не ловит изменение
    // канонического представления: оно двигает хеш одинаково в обоих прогонах.
    // Литерал — единственное, что превращает такой сдвиг в красный тест.
    expect(hashOf(BASE)).toBe('dd82396b');
  });

  it('DET-1: список свободных слотов входит в представление пустым списком', () => {
    // Стартовая расстановка только спавнит и ничего не удаляет, поэтому список
    // пуст, а счётчик равен числу расставленных сущностей (ID-2, ID-6). Пустота
    // при этом не основание опустить поле: опущенный ключ дал бы другой поток
    // байт на тех же данных.
    const loaded = loadScene(BASE.scene);
    spawn(loaded.world, 'Unit');
    spawn(loaded.world, 'Unit');
    const form = worldInitForm(partsOf(loaded));
    const plain = form.world as { freeList: readonly number[]; nextIndex: number };

    expect(plain.freeList).toEqual([]);
    // Счётчик равен числу расставленных сущностей — включая те, что ставит сам
    // загрузчик сцены (границы арены): переиспользований слотов до первого тика нет.
    expect(plain.nextIndex).toBe(listAlive(loaded.world).length);
    expect(canonicalJson(form)).toContain('"freeList":[]');
  });

  it('в каноническую форму не входят RNG, шина событий и номер тика', () => {
    const loaded = loadScene(BASE.scene);
    spawn(loaded.world, 'Unit');
    const form = worldInitForm(partsOf(loaded));

    expect(Object.keys(form).sort()).toEqual(['arena', 'mode', 'terrain', 'world']);
    // Производная геометрия обрывов — результат обработки карт, а не данные.
    expect(Object.keys(form.terrain as object).sort()).toEqual([
      'floor',
      'height',
      'levels',
      'ramps',
      'tileSize',
      'width',
    ]);
  });
});
