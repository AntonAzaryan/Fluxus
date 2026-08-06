import { describe, expect, it } from 'vitest';
import { mathApi } from '../src/math/mathApi.js';
import { SystemRegistry } from '../src/systems/registry.js';
import {
  dispatch,
  initialState,
  restoreSnapshot,
  takeSnapshot,
  tick,
  type Simulation,
} from '../src/sim/tick.js';
import { createWorld, getField, listAlive, spawn } from '../src/ecs/world.js';
import type {
  ComponentSchema,
  NavigationApi,
  PhysicsApi,
  SimulationState,
  System,
  SystemContext,
  TickObserver,
  TickResult,
} from '../src/types.js';
import type { PrefabDef } from '../src/ecs/world.js';

const WORLD_SEED = 12345;

const SCHEMAS: ComponentSchema[] = [
  { name: 'Position', fields: { x: 'fixed', y: 'fixed' } },
  { name: 'Velocity', fields: { x: 'fixed', y: 'fixed' } },
];

const PREFABS: PrefabDef[] = [
  { name: 'mover', components: { Position: { x: 0, y: 0 }, Velocity: { x: 65536, y: 0 } } },
];

function makeSim(
  systems: System[],
  physics?: PhysicsApi,
  navigation?: NavigationApi,
): Simulation {
  const registry = new SystemRegistry();
  for (const system of systems) registry.register(system);
  return {
    systems: registry,
    worldSeed: WORLD_SEED,
    math: mathApi,
    ...(physics ? { physics } : {}),
    ...(navigation ? { navigation } : {}),
  };
}

function freshState(): SimulationState {
  return initialState(createWorld(SCHEMAS, PREFABS), WORLD_SEED);
}

/** Двигает всё, у чего есть Velocity. Пишет только через ctx.commands (DET-7). */
const moveSystem: System = {
  name: 'MoveSystem',
  order: 20,
  run(ctx) {
    for (const entity of ctx.query({ all: ['Position', 'Velocity'] })) {
      const x = ctx.get(entity, 'Position', 'x');
      const vx = ctx.get(entity, 'Velocity', 'x');
      ctx.commands.setField(entity, 'Position', 'x', ctx.math.add(x, vx));
    }
  },
};

describe('tick — мутабельный мир (TICK-1)', () => {
  it('продвигает переданное состояние на месте и возвращает ссылку на него же', () => {
    const sim = makeSim([moveSystem]);
    const state = freshState();
    const entity = spawn(state.world, 'mover');

    const result = tick(sim, state);

    expect(result.state).toBe(state);
    expect(state.tick).toBe(1);
    expect(getField(state.world, entity, 'Position', 'x')).toBe(65536);
  });

  it('спавн в одной системе виден следующей по order в том же тике (CMD-2)', () => {
    const spawner: System = {
      name: 'SpawnSystem',
      order: 10,
      run(ctx) {
        if (ctx.tick === 1) ctx.commands.spawn('mover');
      },
    };
    const sim = makeSim([moveSystem, spawner]);

    const result = tick(sim, freshState());
    const alive = listAlive(result.state.world);

    expect(alive.length).toBe(1);
    // MoveSystem (order 20) отработала уже по заспавненной сущности.
    expect(getField(result.state.world, alive[0]!, 'Position', 'x')).toBe(65536);
  });

  it('порядок систем задаётся order, а не порядком регистрации (DET-3)', () => {
    const trace: string[] = [];
    const late: System = { name: 'Late', order: 30, run: () => void trace.push('late') };
    const early: System = { name: 'Early', order: 10, run: () => void trace.push('early') };

    tick(makeSim([late, early]), freshState());

    expect(trace).toEqual(['early', 'late']);
  });
});

describe('снапшоты (SNAP-1, SNAP-4, REW-2)', () => {
  it('снапшот переживает последующие тики и восстанавливается в то же состояние', () => {
    const sim = makeSim([moveSystem]);
    const state = freshState();
    const entity = spawn(state.world, 'mover');

    tick(sim, state); // x = 1.0
    const snapshot = takeSnapshot(state);
    tick(sim, state); // x = 2.0
    tick(sim, state); // x = 3.0

    // Снапшот не «поехал» вслед за мутациями живого мира.
    expect(getField(snapshot.world, entity, 'Position', 'x')).toBe(65536);
    expect(getField(state.world, entity, 'Position', 'x')).toBe(196608);

    // Восстановление идёт НА МЕСТЕ: ссылка на мир не подменяется (REW-2).
    restoreSnapshot(state, snapshot);
    expect(state.tick).toBe(1);
    expect(getField(state.world, entity, 'Position', 'x')).toBe(65536);
  });

  it('снапшот + реплей вперёд даёт то же состояние, что честный прогон (REW-2)', () => {
    const roller: System = {
      name: 'DamageSystem',
      order: 10,
      run(ctx) {
        const roll = ctx.rng.stream().nextBelow(1000);
        for (const entity of ctx.query({ all: ['Position'] })) {
          ctx.commands.setField(entity, 'Position', 'y', roll);
        }
      },
    };
    const sim = makeSim([roller, moveSystem]);

    const state = freshState();
    const entity = spawn(state.world, 'mover');
    tick(sim, state);
    const snapshot = takeSnapshot(state); // тик 1

    // Честный прогон до тика 4.
    for (let i = 0; i < 3; i++) tick(sim, state);
    const honest = [
      getField(state.world, entity, 'Position', 'x'),
      getField(state.world, entity, 'Position', 'y'),
    ];

    // Восстановление тика 1 в чистом состоянии и реплей тех же трёх тиков.
    const replayed = freshState();
    spawn(replayed.world, 'mover');
    restoreSnapshot(replayed, snapshot);
    for (let i = 0; i < 3; i++) tick(sim, replayed);

    expect(replayed.tick).toBe(4);
    expect([
      getField(replayed.world, entity, 'Position', 'x'),
      getField(replayed.world, entity, 'Position', 'y'),
    ]).toEqual(honest);
  });
});

describe('детерминизм прогона (DET-1)', () => {
  it('два прогона одного сценария от одного seed дают одинаковое состояние', () => {
    const rngSystem: System = {
      name: 'DamageSystem',
      order: 10,
      run(ctx) {
        const roll = ctx.rng.stream().nextBelow(100);
        for (const entity of ctx.query({ all: ['Position'] })) {
          ctx.commands.setField(entity, 'Position', 'y', roll);
        }
      },
    };

    const run = (): number[] => {
      const sim = makeSim([rngSystem, moveSystem]);
      const state = freshState();
      spawn(state.world, 'mover');
      const trace: number[] = [];
      for (let i = 0; i < 5; i++) {
        tick(sim, state);
        const entity = listAlive(state.world)[0]!;
        trace.push(getField(state.world, entity, 'Position', 'x'));
        trace.push(getField(state.world, entity, 'Position', 'y'));
      }
      return trace;
    };

    expect(run()).toEqual(run());
  });

  it('стрим системы продолжается между тиками, а не пересидивается (RNG-5)', () => {
    const rolls: number[] = [];
    const roller: System = {
      name: 'DamageSystem',
      order: 10,
      run: (ctx) => void rolls.push(ctx.rng.stream().next()),
    };
    const sim = makeSim([roller]);
    const state = freshState();

    tick(sim, state); // rolls[0]
    const snapshot = takeSnapshot(state);
    tick(sim, state); // rolls[1]

    // Стрим продолжается, а не начинается заново каждый тик.
    expect(rolls[0]).not.toBe(rolls[1]);
    expect(snapshot.rng).toHaveLength(1);
    expect(snapshot.rng[0]!.name).toBe('DamageSystem');

    // Состояние стримов входит в снапшот: восстановление повторяет бросок тика 2.
    restoreSnapshot(state, snapshot);
    tick(sim, state); // rolls[2]
    expect(rolls[2]).toBe(rolls[1]);
  });
});

describe('DI (DI-3, DI-4)', () => {
  it('ядро тикает без Physics API', () => {
    const checker: System = {
      name: 'Checker',
      order: 10,
      run: (ctx) => expect(ctx.physics).toBeUndefined(),
    };
    expect(() => tick(makeSim([checker]), freshState())).not.toThrow();
  });

  it('переданный Physics API доходит до системы', () => {
    const physics: PhysicsApi = { raycast: () => null, inradiusOf: () => undefined };
    const checker: System = {
      name: 'Checker',
      order: 10,
      run: (ctx) => expect(ctx.physics).toBe(physics),
    };
    tick(makeSim([checker], physics), freshState());
  });

  it('ядро тикает без Navigation API, и поля navigation в контексте нет', () => {
    let seen: SystemContext | undefined;
    const checker: System = {
      name: 'Checker',
      order: 10,
      run: (ctx) => void (seen = ctx),
    };
    expect(() => tick(makeSim([checker]), freshState())).not.toThrow();
    // Отсутствует, а не `undefined`: поле есть ровно при собранной зависимости (SYS-5).
    expect(Object.hasOwn(seen!, 'navigation')).toBe(false);
  });

  it('переданный Navigation API доходит до системы (NAV-1)', () => {
    const path = { status: 'found', waypoints: [{ x: 65536, y: 0 }] } as const;
    const navigation: NavigationApi = { findPath: () => path };
    const checker: System = {
      name: 'Checker',
      order: 10,
      run: (ctx) => {
        expect(ctx.navigation).toBe(navigation);
        expect(ctx.navigation!.findPath({ x: 0, y: 0 }, { x: 65536, y: 0 })).toBe(path);
      },
    };
    tick(makeSim([checker], undefined, navigation), freshState());
  });
});

describe('наблюдаемость (OBS-1..3)', () => {
  it('события системы попадают в TickResult и доходят до observer после тика', () => {
    const emitter: System = {
      name: 'DamageSystem',
      order: 10,
      run: (ctx) => ctx.events.emit('DamageDealt', { amount: 7 }),
    };

    const seen: TickResult[] = [];
    const observer: TickObserver = { name: 'analytics', onTick: (r) => void seen.push(r) };

    const result = tick(makeSim([emitter]), freshState());
    dispatch(result, [observer]);

    expect(result.events.length).toBe(1);
    expect(result.events.at(0)).toEqual({ type: 'DamageDealt', data: { amount: 7 } });
    expect(seen).toEqual([result]);
    expect(result.mode).toBe('Running');
    expect(result.isReplay).toBe(false);
    expect(result.changes.isEmpty).toBe(true);
  });
});
