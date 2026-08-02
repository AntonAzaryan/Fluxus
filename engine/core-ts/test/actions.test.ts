import { describe, expect, it } from 'vitest';
import { execute, actionNames, type Action } from '../src/dsl/actions.js';
import type { Expression } from '../src/dsl/expr.js';
import { EventBus } from '../src/ecs/events.js';
import * as fixed from '../src/math/fixed.js';
import { mathApi } from '../src/math/mathApi.js';
import { createRngRegistry } from '../src/math/rng.js';
import { createCommandBuffer, type CommandBufferHandle } from '../src/ecs/commands.js';
import { query } from '../src/ecs/query.js';
import { createWorld, getField, hasComponent, isAlive, listAlive, spawn, type PrefabDef } from '../src/ecs/world.js';
import type { ComponentSchema, SystemContext } from '../src/types.js';

const F = fixed.fromFloat;

const Position: ComponentSchema = { name: 'Position', fields: { x: 'fixed', y: 'fixed' } };
const Health: ComponentSchema = { name: 'Health', fields: { current: 'fixed', max: 'fixed' } };
const Shield: ComponentSchema = { name: 'Shield', fields: { amount: 'fixed' } };
// Поле с целочисленным именем: именно из-за него порядок ключей объекта
// нельзя брать за основу детерминизма (ACT-3).
const Slots: ComponentSchema = { name: 'Slots', fields: { '0': 'i32', a: 'i32', b: 'i32' } };

const PREFABS: PrefabDef[] = [
  { name: 'Hero', components: { Position: { x: 0, y: 0 }, Health: { current: F(100), max: F(100) } } },
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
  const world = createWorld([Position, Health, Shield, Slots], PREFABS);
  const commands = createCommandBuffer(world);
  const events = new EventBus();
  const setFieldLog: string[] = [];

  const ctx: SystemContext = {
    tick: 1,
    query: (spec) => query(world, spec),
    get: (e, c, f) => getField(world, e, c, f),
    has: (e, c) => hasComponent(world, e, c),
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
    inputs: [],
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
    expect(() => h.commands.flush()).toThrow(/не содержит компонент "Health"/);
  });

  it('падает на несуществующем поле', () => {
    const h = harness();
    execute([{ spawnEntity: { prefab: 'Projectile', overrides: { Position: { z: F(1) } } } }], h.ctx);
    expect(() => h.commands.flush()).toThrow(/нет поля "z"/);
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

describe('ошибки формы (ACT-1)', () => {
  it('падает на неизвестном действии', () => {
    expect(() => execute([{ teleport: {} }], harness().ctx)).toThrow(/неизвестное действие "teleport"/);
  });

  it('не разрешает имена из цепочки прототипов', () => {
    expect(() => execute([{ constructor: {} }], harness().ctx)).toThrow(/неизвестное действие/);
  });

  it('падает на узле с двумя действиями', () => {
    expect(() => execute([{ destroyEntity: { entity: 1 }, emitEvent: { type: 'X' } }], harness().ctx)).toThrow(
      /ровно одно действие/,
    );
  });

  it('требует строковый литерал в имени компонента', () => {
    const bad = { modifyComponent: { entity: 1, component: { var: 'c' }, values: {} } };
    expect(() => execute([bad], harness().ctx)).toThrow(/строковый литерал/);
  });

  it('требует булево в условии if', () => {
    expect(() => execute([{ if: { cond: F(1), then: [] } }], harness().ctx)).toThrow(/булевым/);
  });

  it('в наборе нет addTween и addModifier — отложены до этапа 15', () => {
    expect(actionNames).not.toContain('addTween');
    expect(actionNames).not.toContain('addModifier');
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
    expect(() => execute([{ random: { as: 'r', do: [] } }, after], h.ctx)).toThrow(/неизвестная переменная "r"/);
  });

  it('subStream — строковый литерал, а не выражение', () => {
    expect(() => execute([{ random: { as: 'r', subStream: { var: 'x' }, do: [] } }], harness().ctx)).toThrow(
      /строковый литерал/,
    );
  });
});
