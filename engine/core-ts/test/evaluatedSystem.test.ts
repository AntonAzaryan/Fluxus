import { describe, expect, it } from 'vitest';
import { EvaluatedSystem, validateSystem, type SystemDef } from '../src/dsl/evaluatedSystem.js';
import { actionNames, requiredArgs } from '../src/dsl/actions.js';
import { SystemRegistry } from '../src/systems/registry.js';
import { initialState, tick, type Simulation } from '../src/sim/tick.js';
import * as fixed from '../src/math/fixed.js';
import { mathApi } from '../src/math/mathApi.js';
import { createWorld, getField, listAlive, spawn, type PrefabDef } from '../src/ecs/world.js';
import type { ComponentSchema, System, SystemContext } from '../src/types.js';

const F = fixed.fromFloat;

const Health: ComponentSchema = { name: 'Health', fields: { current: 'fixed', max: 'fixed' } };
const Burning: ComponentSchema = { name: 'Burning', fields: { dps: 'fixed' } };
const SCHEMAS = [Health, Burning];

const PREFABS: PrefabDef[] = [
  { name: 'Torch', components: { Health: { current: F(30), max: F(30) }, Burning: { dps: F(10) } } },
  { name: 'Rock', components: { Health: { current: F(30), max: F(30) } } },
];

function makeWorld(): ReturnType<typeof createWorld> {
  return createWorld(SCHEMAS, PREFABS);
}

const v = (name: string): object => ({ var: name });
const field = (entity: object, component: string, name: string): object => ({
  getComponent: [entity, component, name],
});

/** Горение: каждый тик минус dps, на нуле — событие и смерть. */
const BURNING_JSON: SystemDef = {
  name: 'Burning',
  order: 10,
  query: { all: ['Burning', 'Health'] },
  as: 'e',
  do: [
    {
      modifyComponent: {
        entity: v('e'),
        component: 'Health',
        values: { current: { '-': [field(v('e'), 'Health', 'current'), field(v('e'), 'Burning', 'dps')] } },
      },
    },
    {
      if: {
        cond: { '<=': [field(v('e'), 'Health', 'current'), field(v('e'), 'Burning', 'dps')] },
        then: [{ emitEvent: { type: 'Died', data: { entity: v('e') } } }, { destroyEntity: { entity: v('e') } }],
      },
    },
  ],
};

/** Та же логика на TS — эталон парности для SYS-8. */
class NativeBurning implements System {
  readonly name = 'Burning';
  readonly order = 10;

  run(ctx: SystemContext): void {
    for (const entity of ctx.query({ all: ['Burning', 'Health'] })) {
      const current = ctx.get(entity, 'Health', 'current');
      const dps = ctx.get(entity, 'Burning', 'dps');
      ctx.commands.setField(entity, 'Health', 'current', ctx.math.sub(current, dps));
      if (current <= dps) {
        ctx.events.emit('Died', { entity });
        ctx.commands.destroy(entity);
      }
    }
  }
}

/** Полное состояние сцены в виде строки — сверка evaluate- и TS-версии. */
function dump(world: ReturnType<typeof createWorld>): string {
  return [...listAlive(world)]
    .map((e) => `${e}=${getField(world, e, 'Health', 'current')}`)
    .join(' ');
}

function run(system: System, ticks: number): { world: ReturnType<typeof createWorld>; events: string[] } {
  const world = makeWorld();
  spawn(world, 'Torch');
  spawn(world, 'Rock');
  spawn(world, 'Torch');

  const registry = new SystemRegistry();
  registry.register(system);
  const sim: Simulation = { systems: registry, worldSeed: 1, math: mathApi };
  const state = initialState(world, 1);

  const events: string[] = [];
  for (let i = 0; i < ticks; i++) {
    for (const event of tick(sim, state).events) events.push(`${event.type}:${event.data.entity}`);
  }
  return { world, events };
}

describe('EvaluatedSystem в тике (SYS-1, SYS-4)', () => {
  it('evaluate-система исполняется наравне с системой на TS', () => {
    const { world } = run(new EvaluatedSystem(BURNING_JSON), 1);
    const [torch, rock] = [...listAlive(world)];

    expect(getField(world, torch!, 'Health', 'current')).toBe(F(20));
    expect(getField(world, rock!, 'Health', 'current')).toBe(F(30)); // без Burning — не задет
  });

  it('система без query исполняет do один раз за тик', () => {
    const counter: SystemDef = {
      name: 'Counter',
      order: 5,
      do: [{ emitEvent: { type: 'Beat', data: { n: { tick: [] } } } }],
    };
    const world = makeWorld();
    spawn(world, 'Torch');
    spawn(world, 'Torch');

    const registry = new SystemRegistry();
    registry.registerFromJson(counter, world);
    const sim: Simulation = { systems: registry, worldSeed: 1, math: mathApi };
    const state = initialState(world, 1);

    const first = [...tick(sim, state).events];
    const second = [...tick(sim, state).events];

    expect(first).toEqual([{ type: 'Beat', data: { n: 1 } }]);
    expect(second).toEqual([{ type: 'Beat', data: { n: 2 } }]);
  });
});

describe('JSON-система читает события тика (EVT-2, ACT-1)', () => {
  /** Публикует факт: сколько урона нанесено и кому. */
  const emitter: SystemDef = {
    name: 'Scorcher',
    order: 10,
    query: { all: ['Burning'] },
    as: 'e',
    do: [{ emitEvent: { type: 'Scorch', data: { target: v('e'), amount: F(5) } } }],
  };

  /** Политика: реакция на факт. Адресат и величина берутся из данных события. */
  const reactor = (order: number): SystemDef => ({
    name: 'ScorchDamage',
    order,
    do: [
      {
        forEachEvent: {
          type: 'Scorch',
          as: 'hit',
          do: [
            {
              modifyComponent: {
                entity: { eventField: [v('hit'), 'target'] },
                component: 'Health',
                values: {
                  current: {
                    '-': [
                      field({ eventField: [v('hit'), 'target'] }, 'Health', 'current'),
                      { eventField: [v('hit'), 'amount'] },
                    ],
                  },
                },
              },
            },
          ],
        },
      },
    ],
  });

  const runPair = (reactorOrder: number): ReturnType<typeof makeWorld> => {
    const world = makeWorld();
    spawn(world, 'Torch');
    spawn(world, 'Rock');

    const registry = new SystemRegistry();
    registry.registerFromJson(emitter, world);
    registry.registerFromJson(reactor(reactorOrder), world);
    tick({ systems: registry, worldSeed: 1, math: mathApi }, initialState(world, 1));
    return world;
  };

  it('реагирует на событие системы с меньшим order', () => {
    const world = runPair(20);
    const [torch, rock] = [...listAlive(world)];

    expect(getField(world, torch!, 'Health', 'current')).toBe(F(25));
    expect(getField(world, rock!, 'Health', 'current')).toBe(F(30)); // не был адресатом
  });

  it('с меньшим order не видит ничего: порядок реакции задаётся order', () => {
    const world = runPair(5);
    const [torch] = [...listAlive(world)];

    expect(getField(world, torch!, 'Health', 'current')).toBe(F(30));
  });

  it('валидация ловит ссылку на событие вне тела и нелитеральное имя поля', () => {
    const leaked: SystemDef = {
      ...reactor(20),
      do: [
        { forEachEvent: { type: 'Scorch', as: 'hit', do: [] } },
        { destroyEntity: { entity: { eventField: [v('hit'), 'target'] } } },
      ],
    };
    const computed: SystemDef = {
      ...reactor(20),
      do: [
        {
          forEachEvent: {
            type: 'Scorch',
            as: 'hit',
            do: [{ destroyEntity: { entity: { eventField: [v('hit'), v('hit')] } } }],
          },
        },
      ],
    };

    expect(() => { validateSystem(leaked, makeWorld()); }).toThrow(/переменная "hit" не связана/);
    expect(() => { validateSystem(computed, makeWorld()); }).toThrow(/ожидался строковый литерал/);
  });
});

describe('парность evaluate- и TS-реализации (SYS-6, SYS-8)', () => {
  it('одинаковое состояние мира и одинаковые события за три тика', () => {
    const json = run(new EvaluatedSystem(BURNING_JSON), 3);
    const native = run(new NativeBurning(), 3);

    expect(json.events).toEqual(native.events);
    expect(dump(json.world)).toBe(dump(native.world));
    expect(json.events.length).toBe(2); // оба факела догорели на третьем тике
  });
});

describe('SystemRegistry.override (SYS-7)', () => {
  const registry = (): SystemRegistry => {
    const r = new SystemRegistry();
    r.register(new EvaluatedSystem(BURNING_JSON));
    return r;
  };

  it('подменяет реализацию, сохраняя место в порядке', () => {
    const r = registry();
    r.register({ name: 'After', order: 20, run: () => {} });
    r.override(new NativeBurning());

    expect(r.ordered().map((s) => s.name)).toEqual(['Burning', 'After']);
    expect(r.ordered()[0]).toBeInstanceOf(NativeBurning);
  });

  it('отвергает подмену с другим order', () => {
    const other: System = { name: 'Burning', order: 11, run: () => {} };
    expect(() => { registry().override(other); }).toThrow(/order 10.*заявляет 11/);
  });

  it('отвергает подмену незарегистрированной системы', () => {
    expect(() => { registry().override({ name: 'Ghost', order: 1, run: () => {} }); }).toThrow(/не зарегистрирована/);
  });
});

describe('валидация на регистрации (SYS-3)', () => {
  const invalid = (patch: Partial<SystemDef>): (() => void) => {
    const world = makeWorld();
    return () => { validateSystem({ ...BURNING_JSON, ...patch }, world); };
  };

  it('пропускает корректную систему', () => {
    expect(invalid({})).not.toThrow();
  });

  it('ловит неизвестный компонент в запросе', () => {
    expect(invalid({ query: { all: ['Ghost'] } })).toThrow(/компонент "Ghost" не зарегистрирован/);
  });

  it('ловит неизвестный компонент в действии', () => {
    expect(invalid({ do: [{ removeComponent: { entity: v('e'), component: 'Ghost' } }] })).toThrow(/"Ghost"/);
  });

  it('ловит неизвестное поле компонента', () => {
    expect(
      invalid({ do: [{ modifyComponent: { entity: v('e'), component: 'Health', values: { hp: 1 } } }] }),
    ).toThrow(/нет поля "hp"/);
  });

  it('ловит неизвестное поле в getComponent', () => {
    expect(invalid({ do: [{ destroyEntity: { entity: field(v('e'), 'Health', 'hp') } }] })).toThrow(/нет поля "hp"/);
  });

  it('ловит неизвестный prefab и чужой компонент в overrides', () => {
    expect(invalid({ do: [{ spawnEntity: { prefab: 'Ghost' } }] })).toThrow(/prefab "Ghost" не зарегистрирован/);
    expect(
      invalid({ do: [{ spawnEntity: { prefab: 'Rock', overrides: { Burning: { dps: 1 } } } }] }),
    ).toThrow(/не содержит компонент "Burning"/);
  });

  it('ловит несвязанную переменную', () => {
    expect(invalid({ do: [{ destroyEntity: { entity: v('trget') } }] })).toThrow(/переменная "trget" не связана/);
  });

  it('ловит неизвестное действие и неизвестный оператор', () => {
    expect(invalid({ do: [{ teleport: {} }] })).toThrow(/неизвестное действие "teleport"/);
    expect(invalid({ do: [{ destroyEntity: { entity: { '**': [1, 2] } } }] })).toThrow(/неизвестный оператор/);
  });

  it('называет путь до узла', () => {
    expect(invalid({ do: [{ destroyEntity: { entity: v('e') } }, { destroyEntity: { entity: v('x') } }] })).toThrow(
      /система "Burning"\[0\]\.forEach\.do\[1\]\.destroyEntity\.entity\.var/,
    );
  });

  it('переменная из let видна в теле и не видна снаружи', () => {
    const bound: SystemDef = {
      ...BURNING_JSON,
      do: [{ let: { bindings: { dmg: F(1) }, do: [{ emitEvent: { type: 'X', data: { d: v('dmg') } } }] } }],
    };
    const leaked: SystemDef = {
      ...BURNING_JSON,
      do: [
        { let: { bindings: { dmg: F(1) }, do: [] } },
        { emitEvent: { type: 'X', data: { d: v('dmg') } } },
      ],
    };

    expect(() => { validateSystem(bound, makeWorld()); }).not.toThrow();
    expect(() => { validateSystem(leaked, makeWorld()); }).toThrow(/переменная "dmg" не связана/);
  });

  it('переменная из random видна в теле и не видна снаружи (RNG-6)', () => {
    const bound: SystemDef = {
      ...BURNING_JSON,
      do: [{ random: { as: 'roll', do: [{ emitEvent: { type: 'X', data: { d: v('roll') } } }] } }],
    };
    const leaked: SystemDef = {
      ...BURNING_JSON,
      do: [
        { randomBelow: { as: 'face', bound: F(6), subStream: 'dice', do: [] } },
        { emitEvent: { type: 'X', data: { d: v('face') } } },
      ],
    };

    expect(() => { validateSystem(bound, makeWorld()); }).not.toThrow();
    expect(() => { validateSystem(leaked, makeWorld()); }).toThrow(/переменная "face" не связана/);
  });

  it('опечатка в имени случайного действия падает на регистрации (ACT-1)', () => {
    const typo = { ...BURNING_JSON, do: [{ randomBelwo: { as: 'r', bound: F(6), do: [] } }] } as SystemDef;
    expect(() => { validateSystem(typo, makeWorld()); }).toThrow(/неизвестное действие "randomBelwo"/);
  });

  it('ловит ошибку арности в неисполняемой ветке if (EXPR-8)', () => {
    // Ветка ложна и никогда не сработает — момент обнаружения от этого не зависит.
    const dead: Partial<SystemDef> = {
      do: [
        {
          if: {
            cond: false,
            then: [{ destroyEntity: { entity: { '+': [v('e'), F(1), F(2)] } } }],
          },
        },
      ],
    };
    expect(invalid(dead)).toThrow(/оператор "\+": ожидалось аргументов 2, получено 3/);
  });

  it('ловит арность у операторов переменной арности', () => {
    expect(invalid({ do: [{ destroyEntity: { entity: { if: [true, v('e')] } } }] })).toThrow(
      /оператор "if": ожидалось \[cond, then, …, else\]/,
    );
    expect(invalid({ do: [{ destroyEntity: { entity: { and: [true] } } }] })).toThrow(
      /оператор "and": ожидалось аргументов не менее 2, получено 1/,
    );
  });

  it('ловит строку в позиции выражения и выражение в литеральной позиции', () => {
    expect(invalid({ do: [{ destroyEntity: { entity: { '+': [F(1), 'два'] } } }] })).toThrow(
      /строка допустима только в позиции имени/,
    );
    expect(
      invalid({ do: [{ destroyEntity: { entity: { getComponent: [v('e'), v('e'), 'current'] } } }] }),
    ).toThrow(/ожидался строковый литерал/);
  });

  it('ловит литеральный номер бита вне диапазона, но не вычисляемый (EXPR-2, SYS-9)', () => {
    expect(invalid({ do: [{ destroyEntity: { entity: { if: [{ bitTest: [1, 32] }, v('e'), v('e')] } } }] })).toThrow(
      /ожидалось целое 0\.\.31, получено 32/,
    );
    // Вычисляемый номер на регистрации неизвестен — он остаётся ошибкой тика.
    expect(
      invalid({
        do: [{ destroyEntity: { entity: { if: [{ bitTest: [1, field(v('e'), 'Health', 'current')] }, v('e'), v('e')] } } }],
      }),
    ).not.toThrow();
  });

  it('называет путь до узла в ошибке арности (SYS-3)', () => {
    expect(invalid({ do: [{ destroyEntity: { entity: { '+': [F(1)] } } }] })).toThrow(
      /система "Burning"\[0\]\.forEach\.do\[0\]\.destroyEntity\.entity\.\+: оператор "\+"/,
    );
  });

  it('отвергает имя из цепочки прототипов в позиции оператора (EXPR-6)', () => {
    expect(invalid({ do: [{ destroyEntity: { entity: { constructor: [] } } }] })).toThrow(
      /неизвестный оператор "constructor"/,
    );
    // Через JSON.parse, а не литералом: в литерале `__proto__` меняет прототип
    // вместо того, чтобы стать собственным ключом, — а система приезжает из JSON.
    const fromJson = JSON.parse('{"do":[{"destroyEntity":{"entity":{"__proto__":[]}}}]}') as Partial<SystemDef>;
    expect(invalid(fromJson)).toThrow(/неизвестный оператор "__proto__"/);
    expect(invalid({ do: [{ destroyEntity: { entity: { toString: [v('e')] } } }] })).toThrow(
      /неизвестный оператор "toString"/,
    );
  });

  it('registerFromJson не регистрирует систему, не прошедшую валидацию', () => {
    const r = new SystemRegistry();
    expect(() => { r.registerFromJson({ ...BURNING_JSON, query: { all: ['Ghost'] } }, makeWorld()); }).toThrow();
    expect(r.ordered()).toEqual([]);
  });

  it('hasFloorAt в сцене без террейна проходит регистрацию и падает при вычислении (SYS-5, SYS-9)', () => {
    // Наличие террейна — факт сборки сцены, а не зарегистрированного мира: одно
    // и то же описание системы валидно для сцены, где террейн есть.
    const grounded: SystemDef = {
      name: 'Grounded',
      order: 10,
      do: [
        {
          if: {
            cond: { hasFloorAt: [{ vec: [0, 0] }] },
            then: [{ emitEvent: { type: 'OnFloor', data: {} } }],
          },
        },
      ],
    };
    const world = makeWorld();

    expect(() => { validateSystem(grounded, world); }).not.toThrow();

    const registry = new SystemRegistry();
    registry.registerFromJson(grounded, world);
    expect(() => tick({ systems: registry, worldSeed: 1, math: mathApi }, initialState(world, 1))).toThrow(
      /система "Grounded", узел \[0\]\.if: оператор "hasFloorAt": сцена без террейна/,
    );
  });
});

/**
 * Обязательные аргументы действий (ACT-1) ловятся на регистрации: состав
 * аргументов виден из текста системы целиком, и ждать срабатывания ветки
 * незачем (SYS-3).
 *
 * Перечень `requiredArgs` живёт рядом с таблицей действий, а его связь с самими
 * чтецами аргументов держит этот файл: полный набор регистрируется, а он же без
 * любого одного обязательного ключа — падает.
 */
describe('обязательные аргументы действий на регистрации (SYS-3, ACT-1)', () => {
  const invalid = (patch: Partial<SystemDef>): (() => void) => {
    const world = makeWorld();
    return () => { validateSystem({ ...BURNING_JSON, ...patch }, world); };
  };

  /** Полный набор аргументов каждого действия — только обязательные, без единого лишнего. */
  const FULL: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {
    modifyComponent: { entity: v('e'), component: 'Health' },
    addComponent: { entity: v('e'), component: 'Health' },
    removeComponent: { entity: v('e'), component: 'Health' },
    spawnEntity: { prefab: 'Torch' },
    destroyEntity: { entity: v('e') },
    emitEvent: { type: 'Died' },
    addTween: { entity: v('e'), def: 0, from: 0, to: F(1), duration: F(1) },
    // `component` адресует список источников сцены; на регистрации он проверяется
    // как обычное имя компонента (SYS-3), а наличие списка — дело сборки (SYS-5).
    addModifier: { entity: v('e'), component: 'Health', id: 1, value: F(1) },
    removeModifier: { entity: v('e'), component: 'Health', id: 1 },
    carveFloor: { at: { vec: [0, 0] } },
    if: { cond: true, then: [] },
    let: { do: [] },
    random: { as: 'r', do: [] },
    randomBelow: { as: 'r', bound: F(2), do: [] },
    forEach: { query: {}, as: 'x', do: [] },
    forEachEvent: { type: 'Died', as: 'ev', do: [] },
  };

  /** Тот же набор без одного ключа — узел, который автор недописал. */
  const without = (name: string, key: string): Record<string, unknown> => {
    const args: Record<string, unknown> = { ...FULL[name]! };
    delete args[key];
    return { [name]: args };
  };

  it('перечень покрывает набор действий целиком и совпадает с нормой ключ в ключ', () => {
    expect(Object.keys(requiredArgs).sort()).toEqual([...actionNames].sort());
    expect(Object.keys(FULL).sort()).toEqual([...actionNames].sort());
    // `FULL` выписан по ACT-1, а не собран из `requiredArgs`: перечень, из
    // которого ключ выпал, обязан краснеть здесь.
    for (const name of actionNames) {
      expect(Object.keys(FULL[name]!).sort(), name).toEqual([...requiredArgs[name]!].sort());
    }
  });

  it('полный набор аргументов принимается у каждого действия', () => {
    for (const name of actionNames) {
      expect(invalid({ do: [{ [name]: FULL[name]! }] }), name).not.toThrow();
    }
  });

  for (const name of Object.keys(FULL)) {
    it(`"${name}" без любого обязательного аргумента на регистрацию не проходит`, () => {
      const required = requiredArgs[name]!;
      expect(required.length, `${name}: перечень пуст`).toBeGreaterThan(0);
      for (const key of required) {
        // Ключ обязателен: полный набор без него — уже не система.
        expect(invalid({ do: [without(name, key)] }), `${name}.${key}`).toThrow(
          new RegExp(`не задан обязательный аргумент "${key}"`),
        );
      }
    });
  }

  it('сообщение называет путь до узла и недостающий ключ', () => {
    expect(invalid({ do: [{ modifyComponent: { entity: v('e') } }] })).toThrow(
      /система "Burning"\[0\]\.forEach\.do\[0\]\.modifyComponent: не задан обязательный аргумент "component"/,
    );
  });

  it('примеры из нормы: forEach без `as`, if без `then`', () => {
    expect(invalid({ do: [{ forEach: { query: {}, do: [] } }] })).toThrow(
      /\.forEach: не задан обязательный аргумент "as"/,
    );
    expect(invalid({ do: [{ if: { cond: true } }] })).toThrow(/\.if: не задан обязательный аргумент "then"/);
  });

  it('необязательное остаётся необязательным', () => {
    // `radius` у carveFloor: его отсутствие — не пропуск, а «одна клетка под точкой».
    expect(invalid({ do: [{ carveFloor: { at: { vec: [0, 0] } } }] })).not.toThrow();
    // `else` у ветвления, `values` у записи полей, `easing`/`ignoreTimeScale` у
    // твина, `subStream` у случайного действия, `overrides` у спавна.
    expect(invalid({ do: [{ if: { cond: true, then: [], else: [] } }] })).not.toThrow();
    expect(invalid({ do: [{ addTween: FULL.addTween! }] })).not.toThrow();
    expect(invalid({ do: [{ random: { as: 'r', subStream: 'crits', do: [] } }] })).not.toThrow();
    expect(invalid({ do: [{ let: { bindings: { n: 1 }, do: [] } }] })).not.toThrow();
  });

  it('обязательный аргумент проверяется после написанного: называется ошибка, а не пропуск', () => {
    // В узле есть и опечатка, и недостающий ключ. Сообщение — про опечатку:
    // недописанный слот автор видит и сам, а неизвестный компонент — нет.
    expect(invalid({ do: [{ modifyComponent: { component: 'Ghost' } }] })).toThrow(
      /компонент "Ghost" не зарегистрирован/,
    );
  });
});
