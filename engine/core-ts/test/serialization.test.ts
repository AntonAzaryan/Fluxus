import { describe, expect, it } from 'vitest';
import {
  jsonSerializer,
  prettyJsonSerializer,
  snapshotFromPlain,
  snapshotToPlain,
} from '../src/sim/serialization.js';
import { canonicalJson } from '../src/sim/canonicalJson.js';
import { loadScene, type SceneDef } from '../src/sim/scene.js';
import { initialState, restoreSnapshot, takeSnapshot, tick, type Simulation } from '../src/sim/tick.js';
import { mathApi } from '../src/math/mathApi.js';
import * as fixed from '../src/math/fixed.js';
import {
  addTag,
  createWorld,
  destroy,
  fromPlain,
  getField,
  hasTag,
  listAlive,
  setField,
  spawn,
  toPlain,
  type PrefabDef,
} from '../src/ecs/world.js';
import { numberedFieldIndex } from '../src/ecs/worldSchema.js';
import type { ComponentSchema, SystemDef } from '../src/index.js';

const F = fixed.fromFloat;

const COMPONENTS: ComponentSchema[] = [
  { name: 'Position', fields: { x: 'fixed', y: 'fixed' } },
  { name: 'Health', fields: { current: 'fixed', max: 'fixed' } },
  { name: 'Burning', fields: { dps: 'fixed' } },
];

const PREFABS: PrefabDef[] = [
  { name: 'Torch', components: { Health: { current: F(30), max: F(30) }, Burning: { dps: F(10) } }, tags: ['fire'] },
  { name: 'Rock', components: { Position: { x: 0, y: 0 } } },
];

const BURNING: SystemDef = {
  name: 'Burning',
  order: 10,
  query: { all: ['Burning', 'Health'] },
  as: 'e',
  do: [
    {
      modifyComponent: {
        entity: { var: 'e' },
        component: 'Health',
        values: {
          current: {
            '-': [
              { getComponent: [{ var: 'e' }, 'Health', 'current'] },
              { getComponent: [{ var: 'e' }, 'Burning', 'dps'] },
            ],
          },
        },
      },
    },
  ],
};

const SCENE: SceneDef = { components: COMPONENTS, prefabs: PREFABS, systems: [BURNING], capacity: 64 };

/**
 * Мир с непустым freeList и тегами — то, что легко потерять при выгрузке.
 * Освобождения нарочно в невозрастающем порядке (слот 3, затем 0): список
 * [3, 0] отличим и от перечня живых, и от отсортированного набора (ID-4) —
 * круг, сохраняющий состав, но не порядок, здесь краснеет.
 */
function populated(): ReturnType<typeof createWorld> {
  const world = createWorld(COMPONENTS, PREFABS, 64);
  const first = spawn(world, 'Torch');
  spawn(world, 'Rock');
  const third = spawn(world, 'Torch');
  const fourth = spawn(world, 'Rock');
  destroy(world, fourth); // слот 3 уходит в freeList первым
  destroy(world, first); // слот 0 ложится поверх — стек [3, 0]
  setField(world, third, 'Health', 'current', F(7));
  addTag(world, third, 'lit');
  return world;
}

describe('plain-форма мира (SER-1)', () => {
  it('round-trip сохраняет состояние, теги и выдачу следующего ID', () => {
    const original = populated();
    const plain = toPlain(original);
    const restored = fromPlain(plain, COMPONENTS, PREFABS);

    expect(toPlain(restored)).toEqual(plain);
    expect([...listAlive(restored)]).toEqual([...listAlive(original)]);

    const alive = [...listAlive(restored)];
    for (const entity of alive) {
      expect(getField(restored, entity, 'Health', 'current')).toBe(getField(original, entity, 'Health', 'current'));
      expect(hasTag(restored, entity, 'lit')).toBe(hasTag(original, entity, 'lit'));
    }

    // Переиспользование слота из freeList — то, ради чего выгружается индекс целиком.
    expect(spawn(restored, 'Rock')).toBe(spawn(original, 'Rock'));
  });

  it('ID-4: круг сохраняет все три части состояния схемы идентификаторов', () => {
    const original = populated(); // слоты 3 и 0 освобождены в этом порядке, живы 1 и 2
    const plain = toPlain(original);

    // Ни одна из трёх частей не выводится из остальных: перечень живых не даёт
    // ни поколений освободившихся слотов, ни порядка их освобождения. Порядок
    // [3, 0] невозрастающий — сортировка или вывод из признака занятости дали
    // бы [0, 3] и другой слот первому спавну.
    expect(plain.nextIndex).toBe(4);
    expect(plain.freeList).toEqual([3, 0]);
    expect(plain.generations).toEqual([1, 0, 0, 1]);

    const restored = toPlain(fromPlain(plain, COMPONENTS, PREFABS));

    expect(restored.nextIndex).toBe(plain.nextIndex);
    expect(restored.freeList).toEqual(plain.freeList);
    expect(restored.generations).toEqual(plain.generations);
  });

  it('DET-1 п. 3: пустой список свободных слотов лежит в форме полем, а не опускается', () => {
    // Опущенный ключ дал бы другой поток байт на тех же данных — ложное
    // расхождение ровно там, где хеш `worldInit` заводился ради истинного.
    const fresh = createWorld(COMPONENTS, PREFABS, 8);
    spawn(fresh, 'Rock');
    const plain = toPlain(fresh);

    expect(Object.keys(plain)).toContain('freeList');
    expect(plain.freeList).toEqual([]);
    expect(canonicalJson(plain)).toContain('"freeList":[]');
  });

  it('отвергает компонент, которого нет в схемах сцены', () => {
    const plain = toPlain(populated());
    const withoutBurning = COMPONENTS.filter((c) => c.name !== 'Burning');
    expect(() => fromPlain(plain, withoutBurning, PREFABS)).toThrow(/компонент "Burning"/);
  });
});

describe('детерминированный порядок ключей (SER-6)', () => {
  it('не зависит от порядка объявления полей', () => {
    const straight = createWorld([{ name: 'P', fields: { x: 'i32', y: 'i32' } }]);
    const reversed = createWorld([{ name: 'P', fields: { y: 'i32', x: 'i32' } }]);

    expect(Object.keys(toPlain(straight).components.P!)).toEqual(['x', 'y']);
    expect(Object.keys(toPlain(reversed).components.P!)).toEqual(['x', 'y']);
  });

  it('теги отсортированы и идут по возрастанию индекса', () => {
    const world = createWorld(COMPONENTS, PREFABS, 8);
    const a = spawn(world, 'Torch');
    const b = spawn(world, 'Torch');
    addTag(world, b, 'zeta');
    addTag(world, b, 'alpha');
    addTag(world, a, 'omega');

    expect(toPlain(world).tags).toEqual([
      [0, ['fire', 'omega']],
      [1, ['alpha', 'fire', 'zeta']],
    ]);
  });

  /**
   * SER-6: «имена слотов SHALL дополняться нулями слева до одинаковой длины, и
   * число цифр SHALL быть минимально достаточным … Число цифр — функция от
   * числа слотов на конкретном ассете, а не константа формата».
   *
   * Правило живёт одной функцией ядра, и все четыре порождённые раскладки
   * (карта пола, списки источников-модификаторов, шаги прицеливания, слоты
   * threat-таблицы NPC) зовут её, а не повторяют. Проверяется здесь сама
   * функция: своя копия в каждой раскладке ломала бы формат снапшота ровно там,
   * где копию забыли обновить при росте ёмкости.
   */
  it('номер порождённого слота дополняется нулями до минимально достаточной ширины', () => {
    // До десяти слотов ширина единичная — имена не меняются.
    expect(numberedFieldIndex(0, 4)).toBe('0');
    expect(numberedFieldIndex(3, 4)).toBe('3');
    expect(numberedFieldIndex(9, 10)).toBe('9');

    // Одиннадцать слотов — уже две цифры, и лексикографический порядок совпал
    // с числовым: без дополнения было бы `0, 1, 10, 2, …`.
    const names = Array.from({ length: 11 }, (_, i) => `source${numberedFieldIndex(i, 11)}`);
    expect(names[0]).toBe('source00');
    expect(names[10]).toBe('source10');
    expect([...names].sort()).toEqual(names);

    // Ширина — функция от ЧИСЛА слотов, а не константа формата.
    expect(numberedFieldIndex(1, 100)).toBe('01');
    expect(numberedFieldIndex(1, 101)).toBe('001');
  });

  it('байты двух прогонов одного сценария совпадают', () => {
    const play = (): Uint8Array => {
      const { world, systems } = loadScene(SCENE);
      spawn(world, 'Torch');
      spawn(world, 'Rock');
      const sim: Simulation = { systems, worldSeed: 7, math: mathApi };
      const state = initialState(world, 7);
      tick(sim, state);
      tick(sim, state);
      return jsonSerializer.encode(snapshotToPlain(takeSnapshot(state)));
    };

    expect(play()).toEqual(play());
  });
});

describe('Serializer (SER-2)', () => {
  it('json и json-pretty дают одно значение при декодировании', () => {
    const plain = snapshotToPlain(takeSnapshot(initialState(populated(), 3)));

    expect(jsonSerializer.decode(jsonSerializer.encode(plain))).toEqual(plain);
    expect(prettyJsonSerializer.decode(prettyJsonSerializer.encode(plain))).toEqual(plain);
    expect(jsonSerializer.encode(plain)).toBeInstanceOf(Uint8Array);
  });

  it('снапшот через байты восстанавливается и симуляция продолжается идентично', () => {
    const start = (): { sim: Simulation; state: ReturnType<typeof initialState> } => {
      const { world, systems } = loadScene(SCENE);
      spawn(world, 'Torch');
      spawn(world, 'Torch');
      return { sim: { systems, worldSeed: 5, math: mathApi }, state: initialState(world, 5) };
    };

    const honest = start();
    tick(honest.sim, honest.state);
    const snapshot = takeSnapshot(honest.state);
    tick(honest.sim, honest.state);

    const bytes = jsonSerializer.encode(snapshotToPlain(snapshot));
    const decoded = snapshotFromPlain(
      jsonSerializer.decode(bytes) as ReturnType<typeof snapshotToPlain>,
      COMPONENTS,
      PREFABS,
    );
    const fresh = start();
    restoreSnapshot(fresh.state, decoded);
    tick(fresh.sim, fresh.state);

    expect(toPlain(fresh.state.world)).toEqual(toPlain(honest.state.world));
    expect(fresh.state.tick).toBe(honest.state.tick);
  });
});

/**
 * Стримы RNG в plain-форме (SER-1, SER-6, RNG-5, DET-1). Круг через байты —
 * единственная проверка, которая ловит потерю СОСТОЯНИЯ стрима: мир, события и
 * режим сходятся и при пустом `rng`, а разошедшийся генератор виден только на
 * следующем броске. Сцены выше RNG не тратят вовсе, поэтому здесь своя.
 */
describe('rng в plain-форме снапшота (SER-1, RNG-5)', () => {
  const DICE: ComponentSchema = { name: 'Dice', fields: { crit: 'fixed', main: 'fixed' } };
  const DICE_PREFAB: PrefabDef = { name: 'Dicer', components: { Dice: { crit: 0, main: 0 } } };

  const DICE_SCENE: SceneDef = { components: [DICE], prefabs: [DICE_PREFAB] };

  function start(seed: number) {
    const { world, systems } = loadScene(DICE_SCENE);
    // Тратит два именованных стрима на тик (RNG-4): основной и суб-стрим системы.
    systems.register({
      name: 'Dice',
      order: 0,
      run: (ctx) => {
        for (const entity of ctx.query({ all: ['Dice'] })) {
          // Через Command Buffer, как любая мутация в тике (DET-7, CMD-4).
          ctx.commands.setField(entity, 'Dice', 'main', ctx.rng.stream().nextFixed());
          ctx.commands.setField(entity, 'Dice', 'crit', ctx.rng.stream('crit').nextFixed());
        }
      },
    });
    const dicer = spawn(world, 'Dicer');
    const sim: Simulation = { systems, worldSeed: seed, math: mathApi };
    return {
      state: initialState(world, seed),
      sim,
      rolled: () => [getField(world, dicer, 'Dice', 'main'), getField(world, dicer, 'Dice', 'crit')],
    };
  }

  it('состояние стримов переживает круг через байты: продолжение совпадает с непрерывным', () => {
    const honest = start(11);
    tick(honest.sim, honest.state);
    tick(honest.sim, honest.state);
    const snapshot = takeSnapshot(honest.state);
    tick(honest.sim, honest.state);
    const expected = honest.rolled();

    const plain = snapshotToPlain(snapshot);
    // Стримы созданы лениво по имени и отсортированы (SER-6); при пустом
    // списке круг был бы вакуумным — генератор просто пересеялся бы заново.
    expect(plain.rng.map((stream) => stream.name)).toEqual(['Dice', 'Dice/crit']);
    expect(plain.rng[0]!.state).toHaveLength(4);

    const decoded = snapshotFromPlain(
      jsonSerializer.decode(jsonSerializer.encode(plain)) as typeof plain,
      [DICE],
      [DICE_PREFAB],
    );
    const restored = start(11);
    restoreSnapshot(restored.state, decoded);
    tick(restored.sim, restored.state);

    expect(restored.rolled()).toEqual(expected);
  });

  it('без восстановления тот же тик даёт другие броски — состояние стримов и правда переносится', () => {
    // Анти-вакуумность: третий тик отличим от первого, иначе предыдущий тест
    // прошёл бы и на выброшенном `rng`.
    const honest = start(11);
    tick(honest.sim, honest.state);
    const first = honest.rolled();
    tick(honest.sim, honest.state);
    tick(honest.sim, honest.state);

    expect(honest.rolled()).not.toEqual(first);
  });
});

describe('конфиг сцены (SER-7)', () => {
  it('поднимает мир и системы из одного документа', () => {
    const { world, systems } = loadScene(SCENE);
    const torch = spawn(world, 'Torch');
    const sim: Simulation = { systems, worldSeed: 1, math: mathApi };
    const state = initialState(world, 1);

    tick(sim, state);

    expect(systems.ordered().map((s) => s.name)).toEqual(['Burning']);
    expect(getField(world, torch, 'Health', 'current')).toBe(F(20));
    expect(hasTag(world, torch, 'fire')).toBe(true);
  });

  it('роняет загрузку на системе с несуществующим компонентом (SER-5)', () => {
    const broken: SceneDef = { ...SCENE, systems: [{ ...BURNING, query: { all: ['Ghost'] } }] };
    expect(() => loadScene(broken)).toThrow(/компонент "Ghost" не зарегистрирован/);
  });

  it('работает без prefabs и systems', () => {
    const { world, systems } = loadScene({ components: COMPONENTS });
    expect(systems.ordered()).toEqual([]);
    expect([...listAlive(world)]).toEqual([]);
  });
});
