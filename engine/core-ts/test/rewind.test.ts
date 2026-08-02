import { describe, expect, it } from 'vitest';
import { mathApi } from '../src/math/mathApi.js';
import { SystemRegistry } from '../src/systems/registry.js';
import { initialState, takeSnapshot, tick, type Simulation } from '../src/sim/tick.js';
import { RingHistory } from '../src/sim/history.js';
import { createInputLog, createRewindController } from '../src/sim/rewind.js';
import { createWorld, getField, listAlive, setField, spawn } from '../src/ecs/world.js';
import type { ComponentSchema, SimulationState, System } from '../src/types.js';
import type { PrefabDef } from '../src/ecs/world.js';

const WORLD_SEED = 4242;

const SCHEMAS: ComponentSchema[] = [
  { name: 'Position', fields: { x: 'fixed', y: 'fixed' } },
  { name: 'Velocity', fields: { x: 'fixed', y: 'fixed' } },
  { name: 'Cooldown', fields: { rewind: 'i32' } },
];

const PREFABS: PrefabDef[] = [
  {
    name: 'mover',
    components: { Position: { x: 0, y: 0 }, Velocity: { x: 65536, y: 0 }, Cooldown: { rewind: 0 } },
  },
];

/** Двигает всё, у чего есть Velocity, и капает cooldown вниз. */
const moveSystem: System = {
  name: 'MoveSystem',
  order: 20,
  run(ctx) {
    for (const entity of ctx.query({ all: ['Position', 'Velocity'] })) {
      const x = ctx.get(entity, 'Position', 'x');
      ctx.commands.setField(entity, 'Position', 'x', ctx.math.add(x, ctx.get(entity, 'Velocity', 'x')));
      ctx.events.emit('Moved', { entity });
    }
  },
};

/** Бросок RNG в состояние: без него реплей не проверил бы восстановление стримов. */
const rollSystem: System = {
  name: 'RollSystem',
  order: 10,
  run(ctx) {
    for (const entity of ctx.query({ all: ['Position'] })) {
      ctx.commands.setField(entity, 'Position', 'y', ctx.rng.stream().nextBelow(1000));
    }
  },
};

interface Harness {
  readonly sim: Simulation;
  readonly state: SimulationState;
  readonly history: RingHistory;
  readonly inputs: ReturnType<typeof createInputLog>;
  readonly mover: number;
  runTo(tick: number): void;
}

function harness(interval = 3, capacity = 4): Harness {
  const registry = new SystemRegistry();
  registry.register(rollSystem);
  registry.register(moveSystem);
  const world = createWorld(SCHEMAS, PREFABS);
  const mover = spawn(world, 'mover');
  const sim: Simulation = { systems: registry, worldSeed: WORLD_SEED, math: mathApi };
  const state = initialState(world, WORLD_SEED);
  const history = new RingHistory({ interval, capacity });
  const inputs = createInputLog();

  history.record(state); // тик 0
  return {
    sim,
    state,
    history,
    inputs,
    mover,
    runTo(target) {
      while (state.tick < target) {
        inputs.record(state.tick + 1, []);
        tick(sim, state);
        history.record(state);
      }
    },
  };
}

describe('ring buffer истории (SNAP-2..4, SNAP-6)', () => {
  it('снимает снапшот только на кратных интервалу тиках', () => {
    const h = harness(3, 10);
    h.runTo(7);

    expect(h.history.oldestTick).toBe(0);
    expect(h.history.newestTick).toBe(6);
    expect(h.history.nearest(7)!.tick).toBe(6);
    expect(h.history.nearest(5)!.tick).toBe(3);
  });

  it('переполнение затирает самый старый (SNAP-3)', () => {
    const h = harness(1, 3);
    h.runTo(10);

    expect(h.history.oldestTick).toBe(8);
    expect(h.history.newestTick).toBe(10);
  });

  it('запрос глубже буфера упирается в самый старый доступный тик (REW-1)', () => {
    const h = harness(1, 3);
    h.runTo(10);

    expect(h.history.nearest(2)!.tick).toBe(8);
  });

  it('глубина буфера считается из интервала и ёмкости (SNAP-6)', () => {
    expect(new RingHistory({ interval: 30, capacity: 15 }).depth).toBe(420);
  });

  it('пустая история ничего не отдаёт', () => {
    expect(new RingHistory({ interval: 1, capacity: 2 }).nearest(0)).toBeUndefined();
  });
});

describe('машина состояний мира (WSM-1..3, WSM-5, REW-8)', () => {
  const controller = (h: Harness) =>
    createRewindController(h.sim, h.state, { history: h.history, inputs: h.inputs });

  it('единственный флоу перемотки — Running → Paused → Rewinding → Paused → Running', () => {
    const h = harness();
    const wsm = controller(h);

    expect(wsm.mode).toBe('Running');
    wsm.pause();
    expect(wsm.mode).toBe('Paused');
    wsm.beginRewind();
    expect(wsm.mode).toBe('Rewinding');
    wsm.pause();
    expect(wsm.mode).toBe('Paused');
    wsm.resume();
    expect(wsm.mode).toBe('Running');
  });

  it('прямой переход Running → Rewinding отклоняется (WSM-2)', () => {
    const wsm = controller(harness());
    expect(() => wsm.beginRewind()).toThrow(/только через Paused/);
  });

  it('перемотка внутри перемотки запрещена (REW-8)', () => {
    const wsm = controller(harness());
    wsm.pause();
    wsm.beginRewind();
    expect(() => wsm.beginRewind()).toThrow(/REW-8/);
  });

  it('seekTo вне Rewinding отклоняется (WSM-5)', () => {
    const wsm = controller(harness());
    expect(() => wsm.seekTo(0)).toThrow(/только в Rewinding/);
  });

  it('обычные системы во время Paused и Rewinding выключены (REW-4)', () => {
    const h = harness();
    const wsm = controller(h);
    h.runTo(3);
    const frozen = getField(h.state.world, h.mover, 'Position', 'x');

    wsm.pause();
    tick(h.sim, h.state);
    expect(h.state.tick).toBe(3);
    expect(getField(h.state.world, h.mover, 'Position', 'x')).toBe(frozen);

    wsm.beginRewind();
    tick(h.sim, h.state);
    expect(h.state.tick).toBe(3);
    expect(getField(h.state.world, h.mover, 'Position', 'x')).toBe(frozen);
  });

  it('mode прокидывается в TickResult (WSM-1, WSM-6)', () => {
    const h = harness();
    const wsm = controller(h);
    expect(tick(h.sim, h.state).mode).toBe('Running');
    wsm.pause();
    const result = tick(h.sim, h.state);
    expect(result.mode).toBe('Paused');
    expect(result.isReplay).toBe(false);
  });
});

describe('перемотка (REW-1, REW-2, REW-9, REW-10)', () => {
  it('целевой тик между снапшотами доигрывается по каноническим вводам и совпадает с честным прогоном', () => {
    const h = harness(3, 10);
    h.runTo(4);
    const honest = takeSnapshot(h.state); // тик 4, ближайший снапшот — тик 3
    h.runTo(9);

    const wsm = createRewindController(h.sim, h.state, { history: h.history, inputs: h.inputs });
    wsm.pause();
    wsm.beginRewind();
    wsm.seekTo(4);

    expect(h.state.tick).toBe(4);
    expect(getField(h.state.world, h.mover, 'Position', 'x')).toBe(
      getField(honest.world, h.mover, 'Position', 'x'),
    );
    // Стрим RNG откатился вместе с миром: значение из реплея равно исходному.
    expect(getField(h.state.world, h.mover, 'Position', 'y')).toBe(
      getField(honest.world, h.mover, 'Position', 'y'),
    );
  });

  it('после отката продолжение совпадает с честным прогоном (DET-1)', () => {
    const play = (): number[] => {
      const h = harness(3, 10);
      h.runTo(9);
      return [
        getField(h.state.world, h.mover, 'Position', 'x'),
        getField(h.state.world, h.mover, 'Position', 'y'),
      ];
    };
    const honest = play();

    const h = harness(3, 10);
    h.runTo(9);
    const wsm = createRewindController(h.sim, h.state, { history: h.history, inputs: h.inputs });
    wsm.pause();
    wsm.beginRewind();
    wsm.seekTo(5);
    wsm.pause();
    wsm.resume();
    h.runTo(9);

    expect([
      getField(h.state.world, h.mover, 'Position', 'x'),
      getField(h.state.world, h.mover, 'Position', 'y'),
    ]).toEqual(honest);
  });

  it('шина событий откатывается на целевой тик, а не очищается (REW-10)', () => {
    const h = harness(1, 20);
    h.runTo(5);

    const wsm = createRewindController(h.sim, h.state, { history: h.history, inputs: h.inputs });
    wsm.pause();
    wsm.beginRewind();
    wsm.seekTo(3);

    expect([...h.state.events].map((event) => event.type)).toEqual(['Moved']);
  });

  it('exempt-поле переживает откат (REW-9)', () => {
    const h = harness(1, 20);
    h.runTo(3);
    const wsm = createRewindController(h.sim, h.state, {
      history: h.history,
      inputs: h.inputs,
      exempt: [{ entity: h.mover, component: 'Cooldown', field: 'rewind' }],
    });
    h.runTo(5);
    // Ульта потрачена. Значение ставится напрямую: тест играет роль внешнего
    // слоя, а не системы, — кто и как взводит cooldown, решает политика.
    setField(h.state.world, h.mover, 'Cooldown', 'rewind', 600);

    wsm.pause();
    wsm.beginRewind();
    wsm.seekTo(1);

    expect(getField(h.state.world, h.mover, 'Cooldown', 'rewind')).toBe(600);
    expect(h.state.tick).toBe(1);
  });

  it('запрос глубже истории останавливается на самом старом тике (REW-1)', () => {
    const h = harness(1, 3);
    h.runTo(10);

    const wsm = createRewindController(h.sim, h.state, { history: h.history, inputs: h.inputs });
    wsm.pause();
    wsm.beginRewind();
    wsm.seekTo(2);

    expect(h.state.tick).toBe(8);
  });
});

describe('dirty-tracking (OBS-6, NET-8)', () => {
  it('TickResult.changes перечисляет изменённые сущности по компонентам', () => {
    const h = harness();
    const result = tick(h.sim, h.state);

    expect(result.changes.isEmpty).toBe(false);
    expect([...result.changes.changedEntities('Position')]).toEqual([h.mover]);
    expect(result.changes.changedEntities('Velocity').size).toBe(0);
  });

  it('срез изменений начинается заново каждый тик', () => {
    const idle: System = { name: 'Idle', order: 1, run: () => {} };
    const registry = new SystemRegistry();
    registry.register(idle);
    const world = createWorld(SCHEMAS, PREFABS);
    spawn(world, 'mover');
    const sim: Simulation = { systems: registry, worldSeed: 1, math: mathApi };
    const state = initialState(world, 1);

    // Спавн до первого тика уже пометил компоненты — тик обязан начать с нуля.
    expect(tick(sim, state).changes.isEmpty).toBe(true);
  });

  it('спавн и удаление помечают все компоненты сущности', () => {
    const spawner: System = {
      name: 'Spawner',
      order: 5,
      run: (ctx) => ctx.commands.spawn('mover'),
    };
    const registry = new SystemRegistry();
    registry.register(spawner);
    const world = createWorld(SCHEMAS, PREFABS);
    const sim: Simulation = { systems: registry, worldSeed: 1, math: mathApi };
    const state = initialState(world, 1);

    const result = tick(sim, state);
    const born = listAlive(world)[0]!;
    expect([...result.changes.changedEntities('Position')]).toEqual([born]);
    expect([...result.changes.changedEntities('Velocity')]).toEqual([born]);
  });
});

