import { describe, expect, it } from 'vitest';
import { execute, actionNames, requiredArgs, type Action } from '../src/dsl/actions.js';
import type { Expression } from '../src/dsl/expr.js';
import { EventBus } from '../src/ecs/events.js';
import * as fixed from '../src/math/fixed.js';
import { mathApi } from '../src/math/mathApi.js';
import { createRngRegistry } from '../src/math/rng.js';
import { createCommandBuffer, type CommandBufferHandle } from '../src/ecs/commands.js';
import { modifierList } from '../src/systems/modifiers.js';
import { query, queryInto } from '../src/ecs/query.js';
import {
  createWorld,
  getField,
  getFieldByHandle,
  getFieldByIndex,
  hasComponent,
  hasComponentByHandle,
  isAlive,
  listAlive,
  resolveComponentHandle,
  resolveFieldHandle,
  spawn,
  type PrefabDef,
} from '../src/ecs/world.js';
import {
  FIXED_ONE,
  TIME_SCALE_COMPONENT,
  type ComponentSchema,
  type ModifierRegistry,
  type SystemContext,
} from '../src/types.js';

const F = fixed.fromFloat;

const Position: ComponentSchema = { name: 'Position', fields: { x: 'fixed', y: 'fixed' } };
const Health: ComponentSchema = { name: 'Health', fields: { current: 'fixed', max: 'fixed' } };
const Shield: ComponentSchema = { name: 'Shield', fields: { amount: 'fixed' } };
// Поля с целочисленными именами: именно из-за них порядок ключей объекта нельзя
// брать за основу детерминизма (ACT-3). `"9"`/`"10"` — случай, где численный
// порядок всплывших ключей противоположен лексикографическому.
const Slots: ComponentSchema = {
  name: 'Slots',
  fields: { '0': 'i32', '9': 'i32', '10': 'i32', a: 'i32', b: 'i32' },
};

/** Список источников сцены (TIME-7): экземпляр на харнесс, не на модуль (DI-1). */
const SLOW = modifierList('SlowSources', 2);
/** Масочный список (FOW-3): значение слота — маска каналов i32, нейтраль 0, свёртка OR. */
const CLOAK = modifierList('CloakSources', 2, 'mask');
const MODIFIERS: ModifierRegistry = new Map([
  [SLOW.component, SLOW],
  [CLOAK.component, CLOAK],
]);

const PREFABS: PrefabDef[] = [
  {
    name: 'Hero',
    components: {
      Position: { x: 0, y: 0 },
      Health: { current: F(100), max: F(100) },
      SlowSources: {},
      CloakSources: {},
    },
  },
  { name: 'Projectile', components: { Position: { x: 0, y: 0 } } },
];

interface Harness {
  readonly ctx: SystemContext;
  readonly commands: CommandBufferHandle;
  readonly events: EventBus;
  readonly world: ReturnType<typeof createWorld>;
  readonly setFieldLog: string[];
}

const SYSTEM_NAME = 'Test';

function harness(seed = 1234): Harness {
  const world = createWorld([Position, Health, Shield, Slots, SLOW.schema, CLOAK.schema], PREFABS);
  const commands = createCommandBuffer(world);
  const events = new EventBus();
  const setFieldLog: string[] = [];

  const ctx: SystemContext = {
    tick: 1,
    query: (spec) => query(world, spec),
    queryInto: (spec, ids, indices) => queryInto(world, spec, ids, indices),
    get: (e, c, f) => getField(world, e, c, f),
    has: (e, c) => hasComponent(world, e, c),
    resolveField: (c, f) => resolveFieldHandle(world, c, f),
    resolveComponent: (c) => resolveComponentHandle(world, c),
    getByHandle: (e, handle) => getFieldByHandle(world, e, handle),
    getByIndex: (index, handle) => getFieldByIndex(world, index, handle),
    hasByHandle: (e, handle) => hasComponentByHandle(world, e, handle),
    isAlive: (e) => isAlive(world, e),
    commands: {
      ...commands,
      setField: (e, c, f, value) => {
        setFieldLog.push(`${c}.${f}`);
        commands.setField(e, c, f, value);
      },
    },
    events,
    rng: createRngRegistry(seed).forSystem(SYSTEM_NAME),
    math: mathApi,
    modifiers: MODIFIERS,
    inputs: [],
    getEffectiveDelta: (entity, globalDelta) =>
      hasComponent(world, entity, TIME_SCALE_COMPONENT)
        ? mathApi.mul(globalDelta, getField(world, entity, TIME_SCALE_COMPONENT, 'value'))
        : globalDelta,
  };

  return { ctx, commands, events, world, setFieldLog };
}

describe('мутации только через Command Buffer (ACT-2, CMD-1)', () => {
  it('modifyComponent не меняет мир до flush', () => {
    const h = harness();
    const hero = spawn(h.world, 'Hero');

    execute([{ modifyComponent: { entity: hero, component: 'Health', values: { current: F(40) } } }], h.ctx);
    expect(getField(h.world, hero, 'Health', 'current')).toBe(F(100));

    h.commands.flush();
    expect(getField(h.world, hero, 'Health', 'current')).toBe(F(40));
  });

  it('два modifyComponent подряд читают состояние на начало системы (CMD-5)', () => {
    const h = harness();
    const hero = spawn(h.world, 'Hero');
    const damage: Action = {
      modifyComponent: {
        entity: hero,
        component: 'Health',
        values: { current: { '-': [{ getComponent: [hero, 'Health', 'current'] }, F(10)] } },
      },
    };

    execute([damage, damage], h.ctx);
    h.commands.flush();

    // Оба выражения прочитали 100 — итог равен последней записи, а не 80.
    expect(getField(h.world, hero, 'Health', 'current')).toBe(F(90));
  });

  it('addComponent и removeComponent идут командами', () => {
    const h = harness();
    const hero = spawn(h.world, 'Hero');

    execute([{ addComponent: { entity: hero, component: 'Shield', values: { amount: F(25) } } }], h.ctx);
    expect(hasComponent(h.world, hero, 'Shield')).toBe(false);
    h.commands.flush();
    expect(getField(h.world, hero, 'Shield', 'amount')).toBe(F(25));

    execute([{ removeComponent: { entity: hero, component: 'Shield' } }], h.ctx);
    h.commands.flush();
    expect(hasComponent(h.world, hero, 'Shield')).toBe(false);
  });

  it('destroyEntity убивает сущность на flush', () => {
    const h = harness();
    const hero = spawn(h.world, 'Hero');

    execute([{ destroyEntity: { entity: hero } }], h.ctx);
    expect(isAlive(h.world, hero)).toBe(true);
    h.commands.flush();
    expect(isAlive(h.world, hero)).toBe(false);
  });
});

describe('порядок команд (ACT-3)', () => {
  it('поля идут по отсортированным именам, а не по порядку ключей JSON', () => {
    const h = harness();
    const hero = spawn(h.world, 'Hero');
    execute([{ addComponent: { entity: hero, component: 'Slots' } }], h.ctx);
    h.commands.flush();

    execute(
      [{ modifyComponent: { entity: hero, component: 'Slots', values: { b: 2, a: 1, 0: 7 } } }],
      h.ctx,
    );

    expect(h.setFieldLog).toEqual(['Slots.0', 'Slots.a', 'Slots.b']);
  });

  it('целочисленные имена полей идут лексикографически, а не численно', () => {
    const h = harness();
    const hero = spawn(h.world, 'Hero');
    execute([{ addComponent: { entity: hero, component: 'Slots' } }], h.ctx);
    h.commands.flush();

    execute([{ modifyComponent: { entity: hero, component: 'Slots', values: { 9: 1, 10: 2 } } }], h.ctx);

    // Перечисление ключей объекта дало бы `9`, `10` — численный порядок
    // всплывших целочисленных имён; ACT-3 требует лексикографического.
    expect(h.setFieldLog).toEqual(['Slots.10', 'Slots.9']);
  });

  it('действия внутри do исполняются в порядке перечисления', () => {
    const h = harness();
    const hero = spawn(h.world, 'Hero');

    execute(
      [
        { modifyComponent: { entity: hero, component: 'Health', values: { current: F(50) } } },
        { modifyComponent: { entity: hero, component: 'Health', values: { current: F(10) } } },
      ],
      h.ctx,
    );
    h.commands.flush();

    expect(getField(h.world, hero, 'Health', 'current')).toBe(F(10));
  });
});

describe('spawnEntity с переопределением полей prefab (CMD-6)', () => {
  it('создаёт сущность с переданной позицией', () => {
    const h = harness();
    execute(
      [{ spawnEntity: { prefab: 'Projectile', overrides: { Position: { x: F(3), y: { '+': [F(1), F(1)] } } } } }],
      h.ctx,
    );
    h.commands.flush();

    const spawned = listAlive(h.world)[0]!;
    expect(getField(h.world, spawned, 'Position', 'x')).toBe(F(3));
    expect(getField(h.world, spawned, 'Position', 'y')).toBe(F(2));
  });

  it('падает на компоненте, которого нет в prefab', () => {
    const h = harness();
    execute([{ spawnEntity: { prefab: 'Projectile', overrides: { Health: { current: F(1) } } } }], h.ctx);
    expect(() => { h.commands.flush(); }).toThrow(/не содержит компонент "Health"/);
  });

  it('падает на несуществующем поле', () => {
    const h = harness();
    execute([{ spawnEntity: { prefab: 'Projectile', overrides: { Position: { z: F(1) } } } }], h.ctx);
    expect(() => { h.commands.flush(); }).toThrow(/нет поля "z"/);
  });
});

describe('итерация по событиям тика (ACT-1, EVT-2)', () => {
  /** Реакция: на каждое событие своего типа публикуется `Reacted` с его полем. */
  const react = (type: string): Action => ({
    forEachEvent: {
      type,
      as: 'hit',
      do: [{ emitEvent: { type: 'Reacted', data: { n: { eventField: [{ var: 'hit' }, 'n'] } } } }],
    },
  });

  // Поле `n` кладёт сам тест; пропавшее показывается как `undefined` в диффе
  // сравнения, а не теряется молча.
  const types = (h: Harness): string[] => [...h.events].map((e) => `${e.type}:${String(e.data.n)}`);

  it('обходит только события своего типа, в порядке публикации', () => {
    const h = harness();
    h.events.emit('Collision', { n: 1 });
    h.events.emit('Died', { n: 2 });
    h.events.emit('Collision', { n: 3 });

    execute([react('Collision')], h.ctx);

    expect(types(h)).toEqual(['Collision:1', 'Died:2', 'Collision:3', 'Reacted:1', 'Reacted:3']);
  });

  it('событие, эмитнутое телом, в текущем обходе не участвует', () => {
    const h = harness();
    h.events.emit('Collision', { n: 1 });

    // Тело публикует событие того же типа: обход, растущий изнутри, зациклился бы.
    execute(
      [
        {
          forEachEvent: {
            type: 'Collision',
            as: 'hit',
            do: [{ emitEvent: { type: 'Collision', data: { n: { eventField: [{ var: 'hit' }, 'n'] } } } }],
          },
        },
      ],
      h.ctx,
    );

    expect(types(h)).toEqual(['Collision:1', 'Collision:1']);
  });

  it('ссылка на событие не видна за пределами тела', () => {
    const h = harness();
    h.events.emit('Collision', { n: 1 });
    const after: Action = { emitEvent: { type: 'Reacted', data: { n: { eventField: [{ var: 'hit' }, 'n'] } } } };

    expect(() => { execute([react('Collision'), after], h.ctx); }).toThrow(/неизвестная переменная "hit"/);
  });

  it('тип события — строковый литерал, а не выражение', () => {
    expect(() => { execute([{ forEachEvent: { type: { var: 'x' }, as: 'hit', do: [] } }], harness().ctx); }).toThrow(
      /строковый литерал/,
    );
  });

  it('действие входит в закрытый набор', () => {
    expect(actionNames).toContain('forEachEvent');
  });
});

describe('управляющие действия', () => {
  it('forEach связывает сущность и видит внешние переменные', () => {
    const h = harness();
    const a = spawn(h.world, 'Hero');
    const b = spawn(h.world, 'Hero');

    execute(
      [
        {
          forEach: {
            query: { all: ['Health'] },
            as: 'target',
            do: [
              {
                modifyComponent: {
                  entity: { var: 'target' },
                  component: 'Health',
                  values: { current: { '-': [{ getComponent: [{ var: 'target' }, 'Health', 'current'] }, { var: 'dmg' }] } },
                },
              },
            ],
          },
        },
      ],
      h.ctx,
      { dmg: F(30) },
    );
    h.commands.flush();

    expect(getField(h.world, a, 'Health', 'current')).toBe(F(70));
    expect(getField(h.world, b, 'Health', 'current')).toBe(F(70));
  });

  it('forEach фильтрует по withinRadius с центром из выражения', () => {
    const h = harness();
    const near = spawn(h.world, 'Hero');
    const far = spawn(h.world, 'Hero', { Position: { x: F(50), y: 0 } });

    execute(
      [
        {
          forEach: {
            query: { all: ['Health'], withinRadius: { center: { vec: [F(1), F(0)] }, radius: F(5) } },
            as: 'target',
            do: [{ destroyEntity: { entity: { var: 'target' } } }],
          },
        },
      ],
      h.ctx,
    );
    h.commands.flush();

    expect(isAlive(h.world, near)).toBe(false);
    expect(isAlive(h.world, far)).toBe(true);
  });

  it('let затеняет внешнюю переменную и не протекает наружу', () => {
    const h = harness();

    execute(
      [
        {
          let: {
            bindings: { dmg: F(5) },
            do: [{ emitEvent: { type: 'Inner', data: { value: { var: 'dmg' } } } }],
          },
        },
        { emitEvent: { type: 'Outer', data: { value: { var: 'dmg' } } } },
      ],
      h.ctx,
      { dmg: F(1) },
    );

    expect(h.events.at(0)).toEqual({ type: 'Inner', data: { value: F(5) } });
    expect(h.events.at(1)).toEqual({ type: 'Outer', data: { value: F(1) } });
  });

  it('if выбирает ветку, else необязателен', () => {
    const h = harness();
    const hero = spawn(h.world, 'Hero');
    const branch = (cond: Expression): Action => ({
      if: {
        cond,
        then: [{ emitEvent: { type: 'Then' } }],
        else: [{ emitEvent: { type: 'Else' } }],
      },
    });

    execute([branch({ '<': [{ getComponent: [hero, 'Health', 'current'] }, F(50)] })], h.ctx);
    execute([branch({ '>': [{ getComponent: [hero, 'Health', 'current'] }, F(50)] })], h.ctx);
    execute([{ if: { cond: false, then: [{ emitEvent: { type: 'Never' } }] } }], h.ctx);

    expect([...h.events].map((e) => e.type)).toEqual(['Else', 'Then']);
  });
});

/**
 * Свёртка (ACT-4): `let` — аккумулятор, `set` — присваивание ему. Проверяется
 * то, ради чего механизм и заведён: значение, накопленное во вложенном теле,
 * читается ПОСЛЕ выхода из него — иначе `forEach` свёрткой не станет.
 */
describe('изменяемая привязка let и действие set (ACT-4)', () => {
  /** Значение привязки, вынесенное наружу событием: иного выхода у скоупа нет. */
  const report = (name: string): Action => ({
    emitEvent: { type: 'Result', data: { value: { var: name } } },
  });

  const results = (h: Harness): number[] =>
    [...h.events].filter((e) => e.type === 'Result').map((e) => e.data.value!);

  it('сумма по forEach видна после цикла', () => {
    const h = harness();
    spawn(h.world, 'Hero');
    spawn(h.world, 'Hero', { Health: { current: F(40) } });
    spawn(h.world, 'Hero', { Health: { current: F(10) } });

    execute(
      [
        {
          let: {
            bindings: { total: 0 },
            do: [
              {
                forEach: {
                  query: { all: ['Health'] },
                  as: 'target',
                  do: [
                    {
                      set: {
                        name: 'total',
                        value: {
                          '+': [{ var: 'total' }, { getComponent: [{ var: 'target' }, 'Health', 'current'] }],
                        },
                      },
                    },
                  ],
                },
              },
              report('total'),
            ],
          },
        },
      ],
      h.ctx,
    );

    expect(results(h)).toEqual([F(150)]);
  });

  it('присваивание из вложенных тел if, forEachEvent и вложенного let видно снаружи', () => {
    const h = harness();
    h.events.emit('Collision', { n: F(2) });
    h.events.emit('Collision', { n: F(3) });

    execute(
      [
        {
          let: {
            bindings: { acc: F(1) },
            do: [
              {
                forEachEvent: {
                  type: 'Collision',
                  as: 'hit',
                  do: [
                    {
                      if: {
                        cond: true,
                        then: [
                          {
                            let: {
                              bindings: { step: { eventField: [{ var: 'hit' }, 'n'] } },
                              do: [{ set: { name: 'acc', value: { '*': [{ var: 'acc' }, { var: 'step' }] } } }],
                            },
                          },
                        ],
                      },
                    },
                  ],
                },
              },
              report('acc'),
            ],
          },
        },
      ],
      h.ctx,
    );

    expect(results(h)).toEqual([F(6)]);
  });

  it('внутренний let затеняет внешний: присваивание достаётся ближайшему', () => {
    const h = harness();

    execute(
      [
        {
          let: {
            bindings: { acc: F(1) },
            do: [
              {
                let: {
                  bindings: { acc: F(10) },
                  do: [{ set: { name: 'acc', value: F(20) } }, report('acc')],
                },
              },
              report('acc'),
            ],
          },
        },
      ],
      h.ctx,
    );

    // Внутреннее тело видит своё значение, внешнее — своё нетронутым (ACT-1).
    expect(results(h)).toEqual([F(20), F(1)]);
  });

  it('тип значения привязки — тип последнего присвоенного (EXPR-7)', () => {
    const h = harness();

    execute(
      [
        {
          let: {
            bindings: { any: F(1) },
            do: [
              { set: { name: 'any', value: { vec: [F(2), F(3)] } } },
              { emitEvent: { type: 'Result', data: { value: { 'vec.y': [{ var: 'any' }] } } } },
            ],
          },
        },
      ],
      h.ctx,
    );

    expect(results(h)).toEqual([F(3)]);
  });

  /**
   * Оба отказа ловит регистрация (SYS-3) — здесь проверяется последний рубеж
   * исполнителя: до него доходит только система, зарегистрированная в обход.
   */
  it('переменная итерации и несвязанное имя неизменяемы', () => {
    const h = harness();
    spawn(h.world, 'Hero');

    expect(() => {
      execute(
        [
          {
            forEach: {
              query: { all: ['Health'] },
              as: 'target',
              do: [{ set: { name: 'target', value: F(0) } }],
            },
          },
        ],
        h.ctx,
      );
    }).toThrow(/переменная "target" связана не действием let и неизменяема/);

    expect(() => { execute([{ set: { name: 'nope', value: F(0) } }], h.ctx); }).toThrow(
      /неизвестная переменная "nope"/,
    );
  });

  it('действие входит в закрытый набор', () => {
    expect(actionNames).toContain('set');
  });
});

/**
 * Упорядоченная выборка (ACT-5). Порядок обхода наблюдается событиями: иного
 * выхода у обхода нет, а событие несёт идентификатор сущности как есть.
 */
describe('упорядоченная выборка forEach (ACT-5)', () => {
  const visit = (args: Readonly<Record<string, unknown>>): Action => ({
    forEach: {
      query: { all: ['Position'] },
      as: 'target',
      ...args,
      do: [{ emitEvent: { type: 'Visited', data: { entity: { var: 'target' } } } }],
    },
  });

  const visited = (h: Harness): number[] => [...h.events].map((e) => e.data.entity!);

  const origin: Expression = { vec: [0, 0] };

  it('ближайшая цель: limit 1 при nearestTo обходит ровно одну — ближайшую', () => {
    const h = harness();
    spawn(h.world, 'Hero', { Position: { x: F(5), y: 0 } });
    const near = spawn(h.world, 'Hero', { Position: { x: F(1), y: 0 } });

    execute([visit({ nearestTo: origin, limit: F(1) })], h.ctx);

    expect(visited(h)).toEqual([near]);
  });

  it('равноудалённые обходятся в порядке raw-индекса (QUERY-2)', () => {
    const h = harness();
    // Одинаковый квадрат расстояния до начала координат, разные позиции.
    const first = spawn(h.world, 'Hero', { Position: { x: F(2), y: 0 } });
    const second = spawn(h.world, 'Hero', { Position: { x: 0, y: F(-2) } });
    const far = spawn(h.world, 'Hero', { Position: { x: F(3), y: 0 } });

    execute([visit({ nearestTo: origin })], h.ctx);

    expect(visited(h)).toEqual([first, second, far]);
  });

  /**
   * Квадрат расстояния считается точной 64-битной арифметикой — той же, что у
   * `withinRadius` (QUERY-1), а не приближением Q16.16. Оба случая ниже —
   * ровно те, на которых приближение соврало бы: за пределом квадратичной
   * арифметики (~181 единица) произведение в Q16.16 завернулось бы в
   * отрицательное и утащило дальнюю цель в начало обхода, а на смещениях
   * меньше кванта — схлопнуло бы разные расстояния в один ключ и подменило бы
   * нормативный тай-брейк.
   */
  it('порядок верен за пределом квадратичной арифметики Q16.16', () => {
    const h = harness();
    const far = spawn(h.world, 'Hero', { Position: { x: F(200), y: 0 } });
    const near = spawn(h.world, 'Hero', { Position: { x: F(1), y: 0 } });

    execute([visit({ nearestTo: origin })], h.ctx);

    expect(visited(h)).toEqual([near, far]);
  });

  it('различает расстояния меньше кванта Q16.16, а не схлопывает их в тай-брейк', () => {
    const h = harness();
    // Смещения 2 и 1 сырых единицы: их квадраты (4 и 1) меньше кванта Q16.16,
    // и в приближённом ключе обе цели оказались бы равноудалёнными.
    const further = spawn(h.world, 'Hero', { Position: { x: 2, y: 0 } });
    const closer = spawn(h.world, 'Hero', { Position: { x: 1, y: 0 } });

    execute([visit({ nearestTo: origin })], h.ctx);

    expect(visited(h)).toEqual([closer, further]);
  });

  it('сущность без Position стоит в начале координат (ECS-7)', () => {
    const h = harness();
    const away = spawn(h.world, 'Hero', { Position: { x: F(4), y: 0 } });
    // Выборка идёт по `Health`, поэтому сущность без `Position` из неё не
    // выпадает: позиция читается тотально и ставит её в начало координат —
    // то есть ближе всех, а не в конец обхода.
    const homeless = spawn(h.world, 'Hero', { Position: { x: F(9), y: 0 } });
    h.commands.removeComponent(homeless, 'Position');
    h.commands.flush();

    execute(
      [
        {
          forEach: {
            query: { all: ['Health'] },
            as: 'target',
            nearestTo: origin,
            do: [{ emitEvent: { type: 'Visited', data: { entity: { var: 'target' } } } }],
          },
        },
      ],
      h.ctx,
    );

    expect(visited(h)).toEqual([homeless, away]);
  });

  it('limit без nearestTo обрывает обход в порядке QUERY-2', () => {
    const h = harness();
    const first = spawn(h.world, 'Hero', { Position: { x: F(5), y: 0 } });
    spawn(h.world, 'Hero', { Position: { x: F(1), y: 0 } });

    execute([visit({ limit: F(1) })], h.ctx);

    expect(visited(h)).toEqual([first]);
  });

  it('нулевой limit — пустой обход, отрицательный — ошибка вычисления (SYS-9)', () => {
    const h = harness();
    spawn(h.world, 'Hero');

    execute([visit({ nearestTo: origin, limit: 0 })], h.ctx);
    expect(visited(h)).toEqual([]);

    expect(() => { execute([visit({ limit: F(-1) })], h.ctx); }).toThrow(
      /действие "forEach": "limit" не может быть отрицательным/,
    );
  });

  it('limit больше выборки безопасен, а сама выборка не меняется', () => {
    const h = harness();
    const only = spawn(h.world, 'Hero');

    execute([visit({ nearestTo: origin, limit: F(10) })], h.ctx);

    expect(visited(h)).toEqual([only]);
  });

  /**
   * Вложенные упорядоченные обходы: у каждого уровня свой буфер сортировки,
   * иначе внутренний портил бы порядок внешнего прямо посреди его обхода.
   */
  it('вложенный упорядоченный forEach не портит порядок внешнего', () => {
    const h = harness();
    const a = spawn(h.world, 'Hero', { Position: { x: F(1), y: 0 } });
    const b = spawn(h.world, 'Hero', { Position: { x: F(2), y: 0 } });

    execute(
      [
        {
          forEach: {
            query: { all: ['Position'] },
            as: 'outer',
            nearestTo: origin,
            do: [
              {
                forEach: {
                  query: { all: ['Position'] },
                  as: 'inner',
                  nearestTo: { vec: [F(9), 0] },
                  do: [{ emitEvent: { type: 'Visited', data: { entity: { var: 'inner' } } } }],
                },
              },
              { emitEvent: { type: 'Visited', data: { entity: { var: 'outer' } } } },
            ],
          },
        },
      ],
      h.ctx,
    );

    // Внутренний обход идёт от дальней точки — порядок обратный внешнему.
    expect(visited(h)).toEqual([b, a, a, b, a, b]);
  });
});

describe('ошибки формы (ACT-1)', () => {
  it('падает на неизвестном действии', () => {
    expect(() => { execute([{ teleport: {} }], harness().ctx); }).toThrow(/неизвестное действие "teleport"/);
  });

  it('не разрешает имена из цепочки прототипов', () => {
    expect(() => { execute([{ constructor: {} }], harness().ctx); }).toThrow(/неизвестное действие/);
  });

  it('падает на узле с двумя действиями', () => {
    expect(() => { execute([{ destroyEntity: { entity: 1 }, emitEvent: { type: 'X' } }], harness().ctx); }).toThrow(
      /ровно одно действие/,
    );
  });

  it('требует строковый литерал в имени компонента', () => {
    const bad = { modifyComponent: { entity: 1, component: { var: 'c' }, values: {} } };
    expect(() => { execute([bad], harness().ctx); }).toThrow(/строковый литерал/);
  });

  it('требует булево в условии if', () => {
    expect(() => { execute([{ if: { cond: F(1), then: [] } }], harness().ctx); }).toThrow(
      /действие "if": "cond": ожидалось значение типа bool, получено number/,
    );
  });

  /**
   * Вектор в скалярное поле (EXPR-7): поля компонента и поля данных события
   * скалярны (ECS-3), поэтому запись векторного выражения — ошибка вычисления, а
   * не раскладка по угаданным именам `x`/`y`. Автор раскладывает сам — `vec.x`.
   */
  it('вектор в поле компонента и в данные события — ошибка вычисления (EXPR-7)', () => {
    const h = harness();
    const hero = spawn(h.world, 'Hero');
    const vector: Expression = { vec: [F(1), F(2)] };
    expect(() => {
      execute([{ modifyComponent: { entity: hero, component: 'Position', values: { x: vector } } }], h.ctx);
    }).toThrow(/действие "modifyComponent": ожидалось значение типа number, получено vec2/);
    expect(() => {
      execute([{ emitEvent: { type: 'Aimed', data: { dir: vector } } }], h.ctx);
    }).toThrow(/действие "emitEvent": ожидалось значение типа number, получено vec2/);
    // Ни команды, ни события: отказ случился до постановки.
    expect(h.events.length).toBe(0);
    expect(h.commands.peekField(hero, 'Position', 'x')).toBeUndefined();
  });

  it('разложенный вектор в те же поля проходит (EXPR-2)', () => {
    const h = harness();
    const hero = spawn(h.world, 'Hero');
    const vector: Expression = { vec: [F(1), F(2)] };
    execute(
      [
        {
          modifyComponent: {
            entity: hero,
            component: 'Position',
            values: { x: { 'vec.x': vector }, y: { 'vec.y': vector } },
          },
        },
      ],
      h.ctx,
    );
    h.commands.flush();
    expect(getField(h.world, hero, 'Position', 'x')).toBe(F(1));
    expect(getField(h.world, hero, 'Position', 'y')).toBe(F(2));
  });

  it('addTween, addModifier и removeModifier в наборе (ACT-1)', () => {
    expect(actionNames).toContain('addTween');
    expect(actionNames).toContain('addModifier');
    expect(actionNames).toContain('removeModifier');
  });
});

describe('источники-модификаторы из DSL (ACT-1, TIME-8)', () => {
  const slot = (h: Harness, entity: number, i: number): [number, number] => [
    getField(h.world, entity, SLOW.component, `id${i}`),
    getField(h.world, entity, SLOW.component, `value${i}`),
  ];

  it('addModifier занимает свободный слот через Command Buffer', () => {
    const h = harness();
    const hero = spawn(h.world, 'Hero');

    execute([{ addModifier: { entity: hero, component: SLOW.component, id: 7, value: F(0.5) } }], h.ctx);
    // ACT-2: до flush мир не тронут.
    expect(slot(h, hero, 0)).toEqual([0, FIXED_ONE]);

    h.commands.flush();
    expect(slot(h, hero, 0)).toEqual([7, F(0.5)]);
  });

  it('два addModifier в одном теле занимают разные слоты (CMD-5)', () => {
    const h = harness();
    const hero = spawn(h.world, 'Hero');

    execute(
      [
        { addModifier: { entity: hero, component: SLOW.component, id: 1, value: F(0.5) } },
        { addModifier: { entity: hero, component: SLOW.component, id: 2, value: F(0.25) } },
      ],
      h.ctx,
    );
    h.commands.flush();

    expect(slot(h, hero, 0)).toEqual([1, F(0.5)]);
    expect(slot(h, hero, 1)).toEqual([2, F(0.25)]);
  });

  it('повторный id обновляет тот же слот, а не занимает второй', () => {
    const h = harness();
    const hero = spawn(h.world, 'Hero');

    execute(
      [
        { addModifier: { entity: hero, component: SLOW.component, id: 1, value: F(0.5) } },
        { addModifier: { entity: hero, component: SLOW.component, id: 1, value: F(0.25) } },
      ],
      h.ctx,
    );
    h.commands.flush();

    expect(slot(h, hero, 0)).toEqual([1, F(0.25)]);
    expect(slot(h, hero, 1)).toEqual([0, FIXED_ONE]);
  });

  it('removeModifier освобождает слот и возвращает нейтральное значение', () => {
    const h = harness();
    const hero = spawn(h.world, 'Hero');

    execute([{ addModifier: { entity: hero, component: SLOW.component, id: 7, value: F(0.5) } }], h.ctx);
    h.commands.flush();
    execute([{ removeModifier: { entity: hero, component: SLOW.component, id: 7 } }], h.ctx);
    h.commands.flush();

    expect(slot(h, hero, 0)).toEqual([0, FIXED_ONE]);
  });

  it('снятие отсутствующего источника — не ошибка и не команда (TIME-8)', () => {
    const h = harness();
    const hero = spawn(h.world, 'Hero');

    execute([{ removeModifier: { entity: hero, component: SLOW.component, id: 42 } }], h.ctx);
    h.commands.flush();

    expect(h.setFieldLog).toEqual([]);
  });

  it('переполнение слотов — ошибка, а не вытеснение чужого источника (TIME-7)', () => {
    const h = harness();
    const hero = spawn(h.world, 'Hero');

    expect(() =>
      { execute(
        [
          { addModifier: { entity: hero, component: SLOW.component, id: 1, value: F(0.5) } },
          { addModifier: { entity: hero, component: SLOW.component, id: 2, value: F(0.5) } },
          { addModifier: { entity: hero, component: SLOW.component, id: 3, value: F(0.5) } },
        ],
        h.ctx,
      ); },
    ).toThrow(/все 2 слот/);
  });

  it('нулевой id источника запрещён (TIME-7)', () => {
    const h = harness();
    const hero = spawn(h.world, 'Hero');
    expect(() =>
      { execute([{ addModifier: { entity: hero, component: SLOW.component, id: 0, value: F(0.5) } }], h.ctx); },
    ).toThrow(/не может быть нулём/);
  });

  it('масочный список: нейтраль слота 0, свёртка OR, снятие не трогает второй канал (FOW-3)', () => {
    const h = harness();
    const hero = spawn(h.world, 'Hero');
    // Пустой список — пустая маска, а не FIXED_ONE.
    expect(CLOAK.union(h.ctx, hero)).toBe(0);
    expect(getField(h.world, hero, CLOAK.component, 'value0')).toBe(0);

    execute(
      [
        { addModifier: { entity: hero, component: CLOAK.component, id: 1, value: 1 << 2 } },
        { addModifier: { entity: hero, component: CLOAK.component, id: 2, value: 1 << 5 } },
      ],
      h.ctx,
    );
    h.commands.flush();
    expect(CLOAK.union(h.ctx, hero)).toBe((1 << 2) | (1 << 5));

    execute([{ removeModifier: { entity: hero, component: CLOAK.component, id: 1 } }], h.ctx);
    h.commands.flush();
    expect(CLOAK.union(h.ctx, hero)).toBe(1 << 5);
    // Освобождённый слот вернулся к нейтрали масочного списка — нулю.
    expect(getField(h.world, hero, CLOAK.component, 'value0')).toBe(0);
  });

  it('список, не подключённый сценой, — ошибка, а не действие без эффекта (ACT-1)', () => {
    const h = harness();
    const hero = spawn(h.world, 'Hero');
    expect(() =>
      { execute([{ addModifier: { entity: hero, component: 'Shield', id: 1, value: F(0.5) } }], h.ctx); },
    ).toThrow(/не подключает/);
  });
});

describe('random и randomBelow (ACT-1, RNG-6)', () => {
  /** Значение, связанное действием, — через запись в поле: другого выхода наружу у тела нет. */
  function draw(action: Action, seed = 1234): number {
    const h = harness(seed);
    const hero = spawn(h.world, 'Hero');
    const body = [{ modifyComponent: { entity: hero, component: 'Health', values: { current: { var: 'r' } } } }];
    execute([{ ...action, [Object.keys(action)[0]!]: { ...(Object.values(action)[0] as object), as: 'r', do: body } }], h.ctx);
    h.commands.flush();
    return getField(h.world, hero, 'Health', 'current');
  }

  it('random даёт значение стрима системы', () => {
    const expected = createRngRegistry(1234).forSystem(SYSTEM_NAME).stream().nextFixed();
    expect(draw({ random: {} })).toBe(expected);
  });

  it('тот же seed — то же значение, другой seed — другое', () => {
    expect(draw({ random: {} })).toBe(draw({ random: {} }));
    expect(draw({ random: {} }, 1234)).not.toBe(draw({ random: {} }, 4321));
  });

  it('subStream — отдельная последовательность (RNG-2)', () => {
    const expected = createRngRegistry(1234).forSystem(SYSTEM_NAME).stream('crits').nextFixed();
    expect(draw({ random: { subStream: 'crits' } })).toBe(expected);
    expect(draw({ random: { subStream: 'crits' } })).not.toBe(draw({ random: {} }));
  });

  it('randomBelow совпадает с прямым nextBelow — без смещения остатком', () => {
    const expected = createRngRegistry(1234).forSystem(SYSTEM_NAME).stream().nextBelow(6);
    expect(draw({ randomBelow: { bound: F(6) } })).toBe(expected);
  });

  it('randomBelow: bound меньше единицы — ошибка', () => {
    expect(() => draw({ randomBelow: { bound: F(0.5) } })).toThrow(/не меньше 1/);
  });

  it('имя из as не видно за пределами тела', () => {
    const h = harness();
    const hero = spawn(h.world, 'Hero');
    const after = { modifyComponent: { entity: hero, component: 'Health', values: { current: { var: 'r' } } } };
    expect(() => { execute([{ random: { as: 'r', do: [] } }, after], h.ctx); }).toThrow(/неизвестная переменная "r"/);
  });

  it('subStream — строковый литерал, а не выражение', () => {
    expect(() => { execute([{ random: { as: 'r', subStream: { var: 'x' }, do: [] } }], harness().ctx); }).toThrow(
      /строковый литерал/,
    );
  });
});

/**
 * Связь `requiredArgs` с самими чтецами аргументов (ACT-1). Перечень читает
 * валидация на регистрации (SYS-3), а бросают `argExpr`, `argStr` и `argBody`
 * при исполнении — и разъехаться этим двум нельзя: перечень, где ключа не
 * хватает, вернул бы ошибку в середину матча, а лишний ключ отверг бы систему,
 * которую исполнитель принимает.
 *
 * Сверка идёт в обе стороны: полный набор из одних обязательных ключей
 * исполнителя по аргументам устраивает, а он же без любого одного — нет.
 */
describe('перечень обязательных аргументов и чтецы аргументов (ACT-1, SYS-3)', () => {
  /** Отказ по недостающему аргументу — в отличие от отказа по устройству сцены. */
  const MISSING_ARG = /не задан "|— список действий|— строковый литерал|аргументы задаются объектом/;

  /**
   * Годное значение каждого аргумента: своё там, где действие смотрит на
   * содержимое (`component` у модификаторов адресует список источников сцены),
   * общее — там, где не смотрит. `entity` подставляется живой сущностью уже
   * поднятого мира (см. `run`).
   */
  const VALUE: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {
    addModifier: { component: SLOW.component },
    removeModifier: { component: SLOW.component },
  };
  const COMMON: Readonly<Record<string, unknown>> = {
    entity: 0,
    component: 'Shield',
    prefab: 'Projectile',
    type: 'Died',
    at: { vec: [0, 0] },
    cond: true,
    bound: F(2),
    as: 'r',
    id: 1,
    // Имя изменяемой привязки (ACT-4). Связывающего `let` вокруг здесь нет —
    // и не нужно: отказ по несвязанному имени про аргументы ничего не говорит,
    // а этот блок проверяет именно их.
    name: 'acc',
    value: F(1),
    def: 0,
    from: 0,
    to: F(1),
    duration: F(1),
    query: {},
    do: [],
    then: [],
  };

  /**
   * Набор аргументов действия СОБИРАЕТСЯ ПО ПЕРЕЧНЮ, а не выписан рядом с ним:
   * ключ, выпавший из перечня, выпадает и отсюда — и исполнитель на нём падает.
   * Именно так ловится перечень, в котором ключа не хватает.
   */
  function fullArgs(name: string): Record<string, unknown> {
    const args: Record<string, unknown> = {};
    for (const key of requiredArgs[name]!) args[key] = VALUE[name]?.[key] ?? COMMON[key];
    return args;
  }

  /** Сообщение отказа исполнителя; пусто — действие отработало. */
  function run(node: Action): string {
    const h = harness();
    const hero = spawn(h.world, 'Hero');
    const args = { ...(Object.values(node)[0] as Record<string, unknown>) };
    // `entity` фиксируется на живую сущность уже поднятого мира.
    if (args.entity !== undefined) args.entity = hero;
    try {
      execute([{ [Object.keys(node)[0]!]: args }], h.ctx);
      return '';
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  it('перечень покрывает набор действий целиком, и каждому ключу есть значение', () => {
    expect(Object.keys(requiredArgs).sort()).toEqual([...actionNames].sort());
    for (const name of actionNames) {
      for (const [key, value] of Object.entries(fullArgs(name))) {
        expect(value, `${name}.${key}`).toBeDefined();
      }
    }
  });

  it('собранный по перечню набор исполнитель по аргументам устраивает: в перечне ничего не пропущено', () => {
    for (const name of actionNames) {
      // Отказ по устройству сцены (террейна в харнессе нет) — не про аргументы и
      // здесь не считается (SYS-5, SYS-9).
      expect(run({ [name]: fullArgs(name) }), name).not.toMatch(MISSING_ARG);
    }
  });

  it('без любого обязательного ключа исполнитель падает: лишнего в перечне нет', () => {
    for (const name of actionNames) {
      for (const key of requiredArgs[name]!) {
        const stripped = fullArgs(name);
        delete stripped[key];
        expect(run({ [name]: stripped }), `${name} без "${key}"`).toMatch(MISSING_ARG);
      }
    }
  });
});
