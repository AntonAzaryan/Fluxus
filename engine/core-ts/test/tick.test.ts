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
import { buildSimulation } from '../src/sim/build.js';
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
  /** Что система увидела в контексте и сколько раз её вообще позвали. */
  interface Watch {
    readonly system: System;
    readonly seen: { runs: number; context?: SystemContext };
  }

  /**
   * Система-наблюдатель одного тика: выносит увиденный контекст НАРУЖУ и считает
   * запуски.
   *
   * Счётчик здесь не украшение. Ассерт, живущий внутри `run`, не исполняется
   * вовсе, если систему не позвали, — и тест остаётся зелёным, не доказав
   * ничего: ни того, что зависимость дошла, ни того, что её отсутствие тик
   * переживает. Обе половины норма требует у каждой из двух опциональных
   * зависимостей — физики (DI-3) и навигации (DI-4). Поэтому «система
   * запускалась» проверяется отдельным
   * ассертом после тика, а не подразумевается.
   */
  function watch(): Watch {
    const seen: { runs: number; context?: SystemContext } = { runs: 0 };
    const system: System = {
      name: 'Checker',
      order: 10,
      run: (ctx) => {
        seen.runs += 1;
        seen.context = ctx;
      },
    };
    return { system, seen };
  }

  it('ядро тикает без Physics API, и система это видит (DI-3)', () => {
    const { system, seen } = watch();

    expect(() => tick(makeSim([system]), freshState())).not.toThrow();

    expect(seen.runs).toBe(1);
    expect(seen.context?.physics).toBeUndefined();
  });

  it('переданный Physics API доходит до системы (DI-3)', () => {
    const physics: PhysicsApi = { raycast: () => null, inradiusOf: () => undefined };
    const { system, seen } = watch();

    tick(makeSim([system], physics), freshState());

    expect(seen.runs).toBe(1);
    expect(seen.context?.physics).toBe(physics);
  });

  it('ядро тикает без Navigation API, и поля navigation в контексте нет (DI-4)', () => {
    const { system, seen } = watch();

    expect(() => tick(makeSim([system]), freshState())).not.toThrow();

    expect(seen.runs).toBe(1);
    // Отсутствует, а не `undefined`: поле есть ровно при собранной зависимости (SYS-5).
    expect(Object.hasOwn(seen.context!, 'navigation')).toBe(false);
  });

  it('переданный Navigation API доходит до системы (DI-4, NAV-1)', () => {
    const path = { status: 'found', waypoints: [{ x: 65536, y: 0 }] } as const;
    const navigation: NavigationApi = { findPath: () => path };
    const { system, seen } = watch();

    tick(makeSim([system], undefined, navigation), freshState());

    expect(seen.runs).toBe(1);
    expect(seen.context?.navigation).toBe(navigation);
    expect(seen.context?.navigation?.findPath({ x: 0, y: 0 }, { x: 65536, y: 0 })).toBe(path);
  });

  it('собранная сборкой навигация доходит до системы и ищет путь (NAV-1, NAV-7)', () => {
    const { system, seen } = watch();
    const built = buildSimulation(
      {
        scene: {
          components: SCHEMAS,
          terrain: { width: 4, height: 1, tileSize: 65536, levels: ['0000'], flags: ['....'] },
        },
        seed: WORLD_SEED,
        navigation: { budget: 128, maxAgentRadius: 32768 },
      },
      { where: 'тест' },
    );
    built.sim.systems.register(system);

    tick(built.sim, built.state);

    const path = seen.context?.navigation?.findPath({ x: 32768, y: 32768 }, { x: 229376, y: 32768 });
    expect(path?.status).toBe('found');
    expect(path?.waypoints).toEqual([{ x: 229376, y: 32768 }]);
  });

  it('сцена без террейна навигацию собрать не может — отказ называет зависимость (NAV-3)', () => {
    expect(() =>
      buildSimulation(
        { scene: { components: SCHEMAS }, seed: WORLD_SEED, navigation: { budget: 8, maxAgentRadius: 0 } },
        { where: 'тест' },
      ),
    ).toThrow(/NAV-3/);
  });
});

describe('наблюдаемость (OBS-1..3)', () => {
  it('события системы попадают в TickResult и доходят до observer после тика', () => {
    const emitter: System = {
      name: 'DamageSystem',
      order: 10,
      run: (ctx) => { ctx.events.emit('DamageDealt', { amount: 7 }); },
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

  it('отчёт о тике не даёт записи ни в одну часть состояния (OBS-1, TICK-3)', () => {
    const state = freshState();
    const result = tick(makeSim([moveSystem]), state);

    // Строки ниже не компилируются, и это и есть проверка: «read-only отчёт»
    // держится ТИПОМ, а не обещанием. Неизменяемость полей `TickResult`
    // запрещает подменить ссылку, но не запрещает переписать то, на что она
    // указывает, — поэтому наружу уходит проекция, а не состояние хоста.
    //
    // Тело намеренно не исполняется: исполнив его, проверка сама провела бы то
    // изменение состояния вне тика, которое отрицает (TICK-3).
    const forbiddenWrites = (): void => {
      // @ts-expect-error номер тика в отчёте только читается (OBS-1)
      result.state.tick = 999;
      // @ts-expect-error режим мира переключает RewindController, а не наблюдатель (WSM-5)
      result.state.mode = 'Paused';
    };
    expect(typeof forbiddenWrites).toBe('function');

    // Мутирующих методов нет и у соседних частей состояния: обращение к ним не
    // компилируется, хотя в рантайме за проекцией лежат те же живые объекты —
    // проверка про поверхность отчёта, а не про его содержимое.
    // @ts-expect-error эмит в шину — работа системы внутри тика (OBS-1, EVT-2)
    const emit: unknown = result.state.events.emit;
    // @ts-expect-error восстановление стримов RNG — операция ядра при перемотке (RNG-5)
    const restoreRng: unknown = result.state.rng.restore;
    // @ts-expect-error выдача стрима — шаг генератора, то есть запись в состояние (SNAP-1)
    const forSystem: unknown = result.state.rng.forSystem;
    expect([emit, restoreRng, forSystem].every((member) => typeof member === 'function')).toBe(true);

    // Отчёт при этом остаётся живым view на то же состояние (TICK-1, OBS-3).
    expect(result.state).toBe(state);
    expect(result.state.tick).toBe(1);
    expect(result.state.mode).toBe('Running');
  });
});

describe('поверхность симуляции (TICK-3)', () => {
  it('собранная симуляция не публикует буфер команд — мутатора мира вне тика снаружи нет', () => {
    const built = buildSimulation({ scene: { components: SCHEMAS }, seed: WORLD_SEED }, { where: 'тест' });
    tick(built.sim, built.state);
    // Буфер заведён первым тиком, но живёт в приватной таблице тика, а не полем
    // `Simulation`: `flush` применяет команды к миру вне тика, и опубликованный
    // буфер был бы side channel'ом мимо Command Buffer тика (TICK-3, DET-7).
    // Проверка по значениям, а не по именам: эталон `api-surface` стережёт
    // экспорты `index.ts`, а не форму объекта, который сборка раздаёт наружу.
    expect(Object.keys(built.sim)).not.toContain('commands');
    for (const value of Object.values(built.sim)) {
      const flush = (value as { readonly flush?: unknown }).flush;
      expect(typeof flush).not.toBe('function');
    }
  });
});
