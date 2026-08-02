import { describe, expect, it } from 'vitest';
import {
  jsonSerializer,
  prettyJsonSerializer,
  snapshotFromPlain,
  snapshotToPlain,
} from '../src/sim/serialization.js';
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

/** Мир с непустым freeList и тегами — то, что легко потерять при выгрузке. */
function populated(): ReturnType<typeof createWorld> {
  const world = createWorld(COMPONENTS, PREFABS, 64);
  const first = spawn(world, 'Torch');
  spawn(world, 'Rock');
  const third = spawn(world, 'Torch');
  destroy(world, first); // слот 0 уходит в freeList, поколение растёт
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

    expect(Object.keys(toPlain(straight).components['P']!)).toEqual(['x', 'y']);
    expect(Object.keys(toPlain(reversed).components['P']!)).toEqual(['x', 'y']);
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
