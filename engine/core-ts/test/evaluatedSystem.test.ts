import { describe, expect, it } from 'vitest';
import { EvaluatedSystem, validateSystem, type SystemDef } from '../src/evaluatedSystem.js';
import { SystemRegistry } from '../src/system.js';
import { initialState, tick, type Simulation } from '../src/tick.js';
import * as fixed from '../src/fixed.js';
import { mathApi } from '../src/mathApi.js';
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

/** Та же логика нативно — эталон парности для SYS-8. */
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

/** Полное состояние сцены в виде строки — сверка JSON- и нативной версии. */
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
    for (const event of tick(sim, state).events) events.push(`${event.type}:${event.data['entity']}`);
  }
  return { world, events };
}

describe('EvaluatedSystem в тике (SYS-1, SYS-4)', () => {
  it('JSON-система исполняется наравне с нативной', () => {
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

describe('парность JSON и нативной реализации (SYS-6, SYS-8)', () => {
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
    expect(() => registry().override(other)).toThrow(/order 10.*заявляет 11/);
  });

  it('отвергает подмену незарегистрированной системы', () => {
    expect(() => registry().override({ name: 'Ghost', order: 1, run: () => {} })).toThrow(/не зарегистрирована/);
  });
});

describe('валидация на регистрации (SYS-3)', () => {
  const invalid = (patch: Partial<SystemDef>): (() => void) => {
    const world = makeWorld();
    return () => validateSystem({ ...BURNING_JSON, ...patch }, world);
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

    expect(() => validateSystem(bound, makeWorld())).not.toThrow();
    expect(() => validateSystem(leaked, makeWorld())).toThrow(/переменная "dmg" не связана/);
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

    expect(() => validateSystem(bound, makeWorld())).not.toThrow();
    expect(() => validateSystem(leaked, makeWorld())).toThrow(/переменная "face" не связана/);
  });

  it('опечатка в имени случайного действия падает на регистрации (ACT-1)', () => {
    const typo = { ...BURNING_JSON, do: [{ randomBelwo: { as: 'r', bound: F(6), do: [] } }] } as SystemDef;
    expect(() => validateSystem(typo, makeWorld())).toThrow(/неизвестное действие "randomBelwo"/);
  });

  it('registerFromJson не регистрирует систему, не прошедшую валидацию', () => {
    const r = new SystemRegistry();
    expect(() => r.registerFromJson({ ...BURNING_JSON, query: { all: ['Ghost'] } }, makeWorld())).toThrow();
    expect(r.ordered()).toEqual([]);
  });
});
