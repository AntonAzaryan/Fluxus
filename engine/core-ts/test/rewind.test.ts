import { describe, expect, it } from 'vitest';
import { mathApi } from '../src/math/mathApi.js';
import { SystemRegistry } from '../src/systems/registry.js';
import { initialState, restoreSnapshot, takeSnapshot, tick, type Simulation } from '../src/sim/tick.js';
import { RingHistory } from '../src/sim/history.js';
import { createInputLog, createRewindController } from '../src/sim/rewind.js';
import { createWorld, getField, listAlive, setField, spawn, toPlain } from '../src/ecs/world.js';
import { indexOf as rawIndexOf } from '../src/ecs/entityIndex.js';
import { InputSystem } from '../src/systems/inputSystem.js';
import type { ComponentSchema, InputFrame, SimulationState, System } from '../src/types.js';
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

/** Кадр ввода одного игрока: важен только `moveX`, остальное — обязательные поля. */
function frameOf(tick: number, moveX: number): InputFrame {
  return { tick, playerId: 'p1', seq: tick, move: { x: moveX, y: 0 }, aimDir: 0, buttons: 0 };
}

/**
 * Стенд для REW-5: та же история и тот же контроллер, но в мире есть игрок со
 * слотом и компонентом ввода, а в реестре — `InputSystem`. Отдельно от общего
 * harness, потому что остальным тестам ввод не нужен и лишний компонент менял
 * бы их снапшоты.
 */
function inputHarness() {
  const registry = new SystemRegistry();
  registry.register(new InputSystem({ players: ['p1'] }));
  const world = createWorld(
    [
      { name: 'Player', fields: { slot: 'i32' } },
      {
        name: 'Input',
        fields: { aimDir: 'i32', buttons: 'i32', moveX: 'fixed', moveY: 'fixed', prevButtons: 'i32', seq: 'i32' },
      },
    ],
    [{ name: 'hero', components: { Player: { slot: 0 }, Input: {} } }],
  );
  const player = spawn(world, 'hero');
  const sim: Simulation = { systems: registry, worldSeed: WORLD_SEED, math: mathApi };
  const state = initialState(world, WORLD_SEED);
  const history = new RingHistory({ interval: 1, capacity: 8 });
  const inputs = createInputLog();
  history.record(state);

  return {
    sim,
    state,
    history,
    inputs,
    player,
    press(tickNumber: number, moveX: number) {
      const frames = [frameOf(tickNumber, moveX)];
      inputs.record(tickNumber, frames);
      tick(sim, state, frames);
      history.record(state);
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

// REW-3: перемотка — режим МИРА, а не эффект на сущность. Машина состояний
// живёт на состоянии симуляции целиком, поэтому отматывается весь мир всем
// участникам, а не «личная история» инициатора.
describe('машина состояний мира (WSM-1..3, WSM-5, REW-8, REW-3)', () => {
  // Ровно то, что контроллеру нужно, — чтобы стенд с вводом (REW-5) подходил
  // сюда, не притворяясь полным `Harness`.
  const controller = (h: Pick<Harness, 'sim' | 'state' | 'history' | 'inputs'>) =>
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
    expect(() => { wsm.beginRewind(); }).toThrow(/только через Paused/);
  });

  it('перемотка внутри перемотки запрещена (REW-8)', () => {
    const wsm = controller(harness());
    wsm.pause();
    wsm.beginRewind();
    expect(() => { wsm.beginRewind(); }).toThrow(/REW-8/);
  });

  it('seekTo вне Rewinding отклоняется (WSM-5)', () => {
    const wsm = controller(harness());
    expect(() => { wsm.seekTo(0); }).toThrow(/только в Rewinding/);
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

  /**
   * REW-5 — следствие REW-4, но следствие, которое стоит зафиксировать
   * отдельно: «обычные системы выключены» становится обещанием игроку («твоё
   * движение во время перемотки ни на что не влияет») только если выключен и
   * разбор ввода. `InputSystem` — обычная система (TICK-4), и ровно поэтому
   * кадр, пришедший в Rewinding, до мира не доходит: компонент ввода
   * сохраняет значение целевого тика, а не последнего нажатия.
   */
  it('ввод во время Rewinding до мира не доходит (REW-5)', () => {
    const h = inputHarness();
    h.press(1, 500);
    h.press(2, 900);
    expect(getField(h.state.world, h.player, 'Input', 'moveX')).toBe(900);

    const wsm = controller(h);
    wsm.pause();
    wsm.beginRewind();

    // Кадр с движением приходит, пока мир в Rewinding.
    tick(h.sim, h.state, [frameOf(3, 777)]);
    expect(h.state.tick).toBe(2);
    expect(getField(h.state.world, h.player, 'Input', 'moveX')).toBe(900);

    // И после отката — тоже значение целевого тика, а не 777.
    wsm.seekTo(1);
    expect(getField(h.state.world, h.player, 'Input', 'moveX')).toBe(500);
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

  // EVT-3: события — часть снапшота, поэтому откат на тик с необработанной
  // шиной восстанавливает её вместе с миром, а не начинает с пустой.
  it('шина событий откатывается на целевой тик, а не очищается (REW-10, EVT-3)', () => {
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

/**
 * Стенд для ID-4/ID-6: жизненный цикл слотов по расписанию тиков. Отдельно от
 * общего `harness`, потому что тому нужен неизменный состав сущностей, а здесь
 * весь смысл — в удалении на одном тике и спавне на другом.
 */
function slotHarness(interval = 2, capacity = 8, custom?: { lifecycle: System; spawns: number }) {
  const lifecycle: System = custom?.lifecycle ?? {
    name: 'Lifecycle',
    order: 30,
    run(ctx) {
      // Слот 1 умирает на тике 3, новая сущность рождается на тике 5 — между
      // ними список свободных слотов непуст, и именно этот отрезок пересекает
      // перемотка.
      if (ctx.tick === 3) ctx.commands.destroy(ctx.query({ all: ['Position'] })[1]!);
      if (ctx.tick === 5) ctx.commands.spawn('mover');
    },
  };

  const registry = new SystemRegistry();
  registry.register(moveSystem);
  registry.register(lifecycle);
  const world = createWorld(SCHEMAS, PREFABS, capacity);
  for (let i = 0; i < (custom?.spawns ?? 3); i++) spawn(world, 'mover'); // слоты 0..N−1
  const sim: Simulation = { systems: registry, worldSeed: WORLD_SEED, math: mathApi };
  const state = initialState(world, WORLD_SEED);
  const history = new RingHistory({ interval, capacity: 16 });
  const inputs = createInputLog();
  history.record(state);

  return {
    sim,
    state,
    history,
    inputs,
    runTo(target: number) {
      while (state.tick < target) {
        inputs.record(state.tick + 1, []);
        tick(sim, state);
        history.record(state);
      }
    },
    slots: () => Array.from(listAlive(state.world), rawIndexOf),
    ids: () => [...listAlive(state.world)],
    idState: () => {
      const plain = toPlain(state.world);
      return { nextIndex: plain.nextIndex, freeList: plain.freeList, generations: plain.generations };
    },
  };
}

describe('состояние схемы идентификаторов при откате (ID-4, ID-6, SNAP-1)', () => {
  it('ID-4: список свободных слотов возвращается к значению целевого тика, а не остаётся живым', () => {
    const h = slotHarness();
    h.runTo(4); // смерть слота 1 уже случилась, спавн — ещё нет
    expect(h.idState()).toMatchObject({ nextIndex: 3, freeList: [1] });

    const wsm = createRewindController(h.sim, h.state, { history: h.history, inputs: h.inputs });
    wsm.pause();
    wsm.beginRewind();
    wsm.seekTo(2);

    // Слот 1 освобождён «в будущем» относительно тика 2 — в откаченном мире он
    // снова занят, а список пуст. Живой список предложил бы его аллокации.
    expect(h.idState()).toMatchObject({ nextIndex: 3, freeList: [] });
    expect(h.slots()).toEqual([0, 1, 2]);
  });

  it('ID-4: восстановленный список — тот же стек, а не производная от признака занятости', () => {
    // Смерти в порядке «слот 2, затем слот 0» дают невозрастающий список [2, 0]:
    // восстановление, выводящее его из перечня живых (или сортирующее), дало бы
    // [0, 2] — состав тот же, а вершина стека другая, и аллокация после отката
    // взяла бы другой слот. Ровно этот случай ID-4 объявляет нарушением.
    const lifecycle: System = {
      name: 'Lifecycle',
      order: 30,
      run(ctx) {
        if (ctx.tick === 2) ctx.commands.destroy(ctx.query({ all: ['Position'] })[2]!);
        if (ctx.tick === 3) ctx.commands.destroy(ctx.query({ all: ['Position'] })[0]!);
      },
    };
    const h = slotHarness(2, 8, { lifecycle, spawns: 4 });
    h.runTo(4);
    expect(h.idState().freeList).toEqual([2, 0]);

    const wsm = createRewindController(h.sim, h.state, { history: h.history, inputs: h.inputs });
    wsm.pause();
    wsm.beginRewind();
    wsm.seekTo(3); // снапшот тика 2 + реплей тика 3: обе смерти позади

    expect(h.idState().freeList).toEqual([2, 0]); // точный массив, не состав
    // Вершина восстановленного стека — слот 0 (освобождён последним, ID-6).
    expect(rawIndexOf(spawn(h.state.world, 'mover'))).toBe(0);
  });

  it('ID-4/DET-6: реплей через удаление выдаёт те же {index, generation}', () => {
    const honest = slotHarness();
    honest.runTo(7);
    const expected = honest.ids();
    const expectedState = honest.idState();

    const h = slotHarness();
    h.runTo(7);
    const wsm = createRewindController(h.sim, h.state, { history: h.history, inputs: h.inputs });
    wsm.pause();
    wsm.beginRewind();
    wsm.seekTo(2); // до смерти слота 1
    wsm.pause();
    wsm.resume();
    h.runTo(7);

    // Слот 1 освободился на реплее там же, где и в первом прогоне, и спавн тика 5
    // снова занял именно его — с тем же поколением.
    expect(h.ids()).toEqual(expected);
    expect(h.idState()).toEqual(expectedState);
    expect(h.slots()).toEqual([0, 1, 2]);
    expect(h.idState().generations[1]).toBe(1); // слот переиспользован ровно один раз
  });

  it('SNAP-1: спавн сразу после restoreSnapshot даёт тот же {index, generation}', () => {
    const honest = slotHarness();
    honest.runTo(4);
    const snapshot = takeSnapshot(honest.state); // freeList = [1]
    honest.runTo(5); // тик со спавном
    const expected = honest.ids();

    // Тот же тик, но начатый с восстановленного состояния: состояние схемы
    // идентификаторов пришло в снапшоте целиком, включая список свободных слотов.
    const other = slotHarness();
    other.runTo(7); // уводим мир заведомо в другое состояние
    restoreSnapshot(other.state, snapshot);
    tick(other.sim, other.state);

    expect(other.state.tick).toBe(5);
    expect(other.ids()).toEqual(expected);
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
      run: (ctx) => { ctx.commands.spawn('mover'); },
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

