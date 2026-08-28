import { describe, expect, it } from 'vitest';
import * as fixed from '../src/math/fixed.js';
import { mathApi } from '../src/math/mathApi.js';
import { SystemRegistry } from '../src/systems/registry.js';
import { initialState, restoreSnapshot, takeSnapshot, tick, type Simulation } from '../src/sim/tick.js';
import { RingHistory } from '../src/sim/history.js';
import { createInputLog, createRewindController } from '../src/sim/rewind.js';
import { EvaluatedSystem } from '../src/dsl/evaluatedSystem.js';
import { loadScene, type SceneDef } from '../src/sim/scene.js';
import { snapshotToPlain } from '../src/sim/serialization.js';
import { createWorld, getField, listAlive, setField, spawn, toPlain } from '../src/ecs/world.js';
import { indexOf as rawIndexOf } from '../src/ecs/entityIndex.js';
import { InputSystem } from '../src/systems/inputSystem.js';
import { FIXED_ONE, TIME_SCALE_COMPONENT } from '../src/types.js';
import type { ComponentSchema, EntityId, InputFrame, SimulationState, System } from '../src/types.js';
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

/** Счётчик списаний exempt-поля: по нему видно, сколько раз его тронул реплей. */
interface CooldownStats {
  writes: number;
}

/**
 * Обычная система кулдауна: каждый тик списывает единицу. Обычная — потому что
 * exempt-поле продвигает именно она, в том числе на тиках реплея внутри
 * `seekTo` (REW-4), и весь смысл carve-out'а REW-9 в том, чем это кончается.
 */
const cooldownSystem = (stats: CooldownStats = { writes: 0 }): System => ({
  name: 'CooldownSystem',
  order: 15,
  run(ctx) {
    for (const entity of ctx.query({ all: ['Cooldown'] })) {
      const left = ctx.get(entity, 'Cooldown', 'rewind');
      if (left > 0) {
        stats.writes++;
        ctx.commands.setField(entity, 'Cooldown', 'rewind', left - 1);
      }
    }
  },
});

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

  /**
   * NTR-16: после перемотки живые тики записываются заново под теми же
   * номерами, и буфер без усечения держит по два снапшота на тик — стёртой
   * ветви и живой. Стёртая ветвь отброшена (REW-13): вторая перемотка обязана
   * восстановить живую запись, а не молча подменить мир состоянием временной
   * линии, в которой симуляция уже не находится.
   */
  it('вторая перемотка не восстанавливает стёртую ветвь: при равных тиках побеждает записанный позже снапшот (NTR-16, REW-13)', () => {
    const h = inputHarness();
    for (let t = 1; t <= 6; t++) h.press(t, 500); // ветвь, которую сотрёт перемотка
    const wsm = createRewindController(h.sim, h.state, { history: h.history, inputs: h.inputs });
    wsm.pause();
    wsm.beginRewind();
    wsm.seekTo(3);
    wsm.pause();
    wsm.resume();
    // Тики 4..6 переигрываются с другим вводом: снапшоты ложатся под теми же
    // номерами, что у стёртой ветви (NTR-16), поверх непросечённого буфера.
    for (let t = 4; t <= 6; t++) h.press(t, -500);
    expect(getField(h.state.world, h.player, 'Input', 'moveX')).toBe(-500);

    wsm.pause();
    wsm.beginRewind();
    wsm.seekTo(6);
    expect(h.state.tick).toBe(6);
    // Восстановлена живая запись тика 6, а не снапшот стёртой ветви (moveX 500).
    expect(getField(h.state.world, h.player, 'Input', 'moveX')).toBe(-500);
  });

  /**
   * Дно буфера после перемотки — минимальный ТИК, а не старейший слот:
   * порядок записи перестал совпадать с порядком тиков, и старейший слот может
   * держать снапшот стёртой ветви. Запрос глубже буфера обязан упереться в
   * живую запись (REW-1), а не восстановить стёртую временную линию.
   */
  it('запрос глубже буфера после перемотки упирается в живую запись, а не в старейший слот стёртой ветви (REW-1, NTR-16)', () => {
    const h = inputHarness(); // interval 1, capacity 8
    for (let t = 1; t <= 6; t++) h.press(t, 500);
    const wsm = createRewindController(h.sim, h.state, { history: h.history, inputs: h.inputs });
    wsm.pause();
    wsm.beginRewind();
    wsm.seekTo(3);
    wsm.pause();
    wsm.resume();
    // Живая линия уезжает до тика 8: снапшоты общего прошлого (тики ≤ 3)
    // вытеснены, и старейший СЛОТ буфера теперь держит тик 4 стёртой ветви.
    for (let t = 4; t <= 8; t++) h.press(t, -500);

    wsm.pause();
    wsm.beginRewind();
    wsm.seekTo(3);

    // Упёрлись в самый ранний доступный тик (REW-1) — и это живая запись
    // тика 4, а не одноимённый снапшот стёртой ветви (moveX 500).
    expect(h.state.tick).toBe(4);
    expect(getField(h.state.world, h.player, 'Input', 'moveX')).toBe(-500);
  });
});

/**
 * Стенд компонентной формы exempt (REW-9): мир начинается ПУСТЫМ, носители
 * cooldown рождаются системой уже после того, как перемотка сконфигурирована, —
 * ровно тот случай, ради которого форма и заведена (перечислить `EntityId`
 * заранее нечем). Cooldown убывает каждый тик: без этого «пережил откат» и «не
 * тикал в замороженном мире» были бы неотличимы от «никто его не трогал».
 */
function componentExemptHarness(interval = 3, capacity = 10) {
  const lifecycle: System = {
    name: 'Lifecycle',
    order: 5,
    run(ctx) {
      if (ctx.tick === 2) ctx.commands.spawn('mover');
      if (ctx.tick === 4) ctx.commands.spawn('mover');
    },
  };

  const registry = new SystemRegistry();
  registry.register(lifecycle);
  registry.register(moveSystem);
  registry.register(cooldownSystem());
  const world = createWorld(SCHEMAS, PREFABS);
  const sim: Simulation = { systems: registry, worldSeed: WORLD_SEED, math: mathApi };
  const state = initialState(world, WORLD_SEED);
  const history = new RingHistory({ interval, capacity });
  const inputs = createInputLog();
  history.record(state);

  // Контроллер строится ДО первого спавна — сущностей в мире ещё нет.
  const wsm = createRewindController(sim, state, {
    history,
    inputs,
    exempt: [{ component: 'Cooldown' }],
  });

  return {
    sim,
    state,
    history,
    inputs,
    wsm,
    owners: (): number[] => [...listAlive(state.world)],
    cooldowns: (): number[] =>
      [...listAlive(state.world)].map((entity) => getField(state.world, entity, 'Cooldown', 'rewind')),
    runTo(target: number) {
      while (state.tick < target) {
        inputs.record(state.tick + 1, []);
        tick(sim, state);
        history.record(state);
      }
    },
  };
}

describe('компонентная форма exempt-списка (REW-9)', () => {
  it('cooldown сущности, рождённой после конфигурирования, переживает откат', () => {
    const h = componentExemptHarness();
    h.runTo(6);
    expect(h.owners()).toHaveLength(2);
    // Ульта потрачена обоими: значения ставятся снаружи — кто и как взводит
    // cooldown, решает политика (WSM-5), а не механизм.
    const [first, second] = h.owners() as [number, number];
    setField(h.state.world, first, 'Cooldown', 'rewind', 600);
    setField(h.state.world, second, 'Cooldown', 'rewind', 300);

    h.wsm.pause();
    h.wsm.beginRewind();
    h.wsm.seekTo(3);

    expect(h.state.tick).toBe(3);
    // Тик 3: вторая сущность ещё не родилась — её значение возвращать некуда.
    expect(h.owners()).toEqual([first]);
    expect(getField(h.state.world, first, 'Cooldown', 'rewind')).toBe(600);
  });

  it('владелец, отката не переживший, значение теряет, а выживший — нет', () => {
    const h = componentExemptHarness();
    h.runTo(6);
    const [first, second] = h.owners() as [number, number];
    setField(h.state.world, first, 'Cooldown', 'rewind', 600);
    setField(h.state.world, second, 'Cooldown', 'rewind', 300);

    h.wsm.pause();
    h.wsm.beginRewind();
    h.wsm.seekTo(5); // обе сущности уже живы

    expect(h.cooldowns()).toEqual([600, 300]);
  });

  it('exempt-значение в замороженном мире не тикает (REW-9)', () => {
    const h = componentExemptHarness();
    h.runTo(6);
    const [first] = h.owners() as [number];
    setField(h.state.world, first, 'Cooldown', 'rewind', 600);

    h.wsm.pause();
    // Триста тиков реального времени в замороженном мире: обычные системы
    // выключены (REW-4), и убывать cooldown нечем.
    for (let i = 0; i < 300; i++) tick(h.sim, h.state);
    expect(getField(h.state.world, first, 'Cooldown', 'rewind')).toBe(600);

    h.wsm.beginRewind();
    for (let i = 0; i < 300; i++) tick(h.sim, h.state);
    h.wsm.seekTo(4);

    expect(getField(h.state.world, first, 'Cooldown', 'rewind')).toBe(600);
    // А после возобновления — снова убывает: заморожено было время мира.
    h.wsm.pause();
    h.wsm.resume();
    h.runTo(5);
    expect(getField(h.state.world, first, 'Cooldown', 'rewind')).toBe(599);
  });

  it('exempt-компонент, не объявленный в мире, — ошибка конфигурации', () => {
    const h = harness();
    expect(() =>
      createRewindController(h.sim, h.state, {
        history: h.history,
        inputs: h.inputs,
        exempt: [{ component: 'Fireproof' }],
      }),
    ).toThrow(/REW-9/);
  });

  it('обе формы exempt работают рядом', () => {
    const h = componentExemptHarness();
    h.runTo(6);
    const [first] = h.owners() as [number];
    const both = createRewindController(h.sim, h.state, {
      history: h.history,
      inputs: h.inputs,
      exempt: [{ component: 'Cooldown' }, { entity: first, component: 'Velocity', field: 'x' }],
    });
    setField(h.state.world, first, 'Cooldown', 'rewind', 600);
    setField(h.state.world, first, 'Velocity', 'x', 42);

    both.pause();
    both.beginRewind();
    both.seekTo(4);

    expect(getField(h.state.world, first, 'Cooldown', 'rewind')).toBe(600);
    expect(getField(h.state.world, first, 'Velocity', 'x')).toBe(42);
  });
});

/**
 * Стенд carve-out'а REW-9 для реплея внутри `seekTo` (REW-4): cooldown взведён
 * ДО первого тика, поэтому в истории лежат его убывающие значения, и реплей
 * вперёд действительно списывает exempt-поле, а не проходит мимо нуля.
 * `interval` — параметр стенда: от него зависит длина реплея (SNAP-4), а
 * наблюдаемое значение зависеть от неё не должно.
 */
function replayExemptHarness(interval: number, start: number) {
  const stats: CooldownStats = { writes: 0 };
  const registry = new SystemRegistry();
  registry.register(cooldownSystem(stats));
  const world = createWorld(SCHEMAS, PREFABS);
  const mover = spawn(world, 'mover');
  setField(world, mover, 'Cooldown', 'rewind', start);
  const sim: Simulation = { systems: registry, worldSeed: WORLD_SEED, math: mathApi };
  const state = initialState(world, WORLD_SEED);
  const history = new RingHistory({ interval, capacity: 32 });
  const inputs = createInputLog();
  history.record(state);

  return {
    sim,
    state,
    stats,
    cooldown: (): number => getField(state.world, mover, 'Cooldown', 'rewind'),
    /** Контроллер с exempt-компонентом или без него — вторым видно результат реплея. */
    controller: (exempt: boolean) =>
      createRewindController(sim, state, {
        history,
        inputs,
        ...(exempt ? { exempt: [{ component: 'Cooldown' }] } : {}),
      }),
    runTo(target: number) {
      while (state.tick < target) {
        inputs.record(state.tick + 1, []);
        tick(sim, state);
        history.record(state);
      }
    },
  };
}

/**
 * Запрет «вне `Running` exempt-значения не продвигаются» — о НАБЛЮДАЕМОМ
 * результате `seekTo`, а не о промежуточных тиках его реплея: реплей обязан
 * исполнять обычные системы с теми же входами (REW-4, DET-1), и exempt-поле он
 * трогает наравне с прочими. Снимает противоречие сама схема lift/write-back —
 * запись снятого значения после реплея накрывает то, что реплей насчитал.
 */
describe('carve-out REW-9 для реплея внутри seekTo (REW-4)', () => {
  const START = 1200;
  /** Цель не кратна ни одному из интервалов стенда — реплею есть что доигрывать. */
  const TARGET = 17;
  const CAST_TICK = 20;

  /** Ульта прожата: политика взводит cooldown заново (WSM-5), механизм его лишь несёт. */
  const cast = (h: ReturnType<typeof replayExemptHarness>): void => {
    h.runTo(CAST_TICK);
    setField(h.state.world, listAlive(h.state.world)[0]!, 'Cooldown', 'rewind', START);
  };

  it('реплей внутри seekTo тронул exempt-поле, а запись после реплея его накрыла', () => {
    const h = replayExemptHarness(10, START);
    cast(h);
    expect(h.cooldown()).toBe(START);

    const wsm = h.controller(true);
    const before = h.stats.writes;
    wsm.pause();
    wsm.beginRewind();
    wsm.seekTo(TARGET);

    // Реплей от снапшота тика 10 доиграл семь тиков, и на каждом система
    // кулдаунов списывала exempt-поле: запрет о результате, а не о реплее.
    expect(h.stats.writes - before).toBe(TARGET - 10);
    expect(h.state.tick).toBe(TARGET);
    // И всё же наблюдаемое значение — то, каким оно было в момент вызова.
    expect(h.cooldown()).toBe(START);
  });

  it('без exempt-списка на том же месте остаётся результат реплея', () => {
    const h = replayExemptHarness(10, START);
    cast(h);

    const wsm = h.controller(false);
    wsm.pause();
    wsm.beginRewind();
    wsm.seekTo(TARGET);

    // Контроль: реплей насчитал значение целевого тика — именно его и накрывает
    // запись в предыдущем тесте, а не «поле, которого никто не трогал».
    expect(h.cooldown()).toBe(START - TARGET);
  });

  it('наблюдаемое значение exempt-поля от interval провайдера истории не зависит (SNAP-4)', () => {
    const observed: number[] = [];
    const replayed: number[] = [];

    for (const interval of [1, 3, 10]) {
      const h = replayExemptHarness(interval, START);
      cast(h);
      const wsm = h.controller(true);
      const before = h.stats.writes;
      wsm.pause();
      wsm.beginRewind();
      wsm.seekTo(TARGET);

      observed.push(h.cooldown());
      replayed.push(h.stats.writes - before);
    }

    // Длина реплея — настройка производительности, и от неё зависит: 17 — сам
    // снапшот, 15 и 10 — база плюс два и семь тиков доигрывания.
    expect(replayed).toEqual([0, 2, 7]);
    // Наблюдаемое значение — нет: иначе глубже поводивший ползунком получал бы
    // ульту дешевле, и цена зависела бы от настройки провайдера.
    expect(observed).toEqual([START, START, START]);
  });
});

/**
 * Цена `seekTo` и его база: стенд считает ПРОТИКАННЫЕ реплеем тики — по ним и
 * видно, от какой базы шёл реплей. База одна всегда — ближайший снапшот
 * (REW-2); кэша восстановленного состояния у контроллера нет (design,
 * Decision 3), и путь к любой точке зависит только от истории, а не от того,
 * какие точки скраб прошёл до неё.
 */
function countingHarness(interval = 10, capacity = 10) {
  const counter = { ticks: 0 };
  const counting: System = {
    name: 'Counting',
    order: 1,
    run: () => { counter.ticks++; },
  };
  const registry = new SystemRegistry();
  registry.register(counting);
  registry.register(rollSystem);
  registry.register(moveSystem);
  const world = createWorld(SCHEMAS, PREFABS);
  const mover = spawn(world, 'mover');
  const sim: Simulation = { systems: registry, worldSeed: WORLD_SEED, math: mathApi };
  const state = initialState(world, WORLD_SEED);
  const history = new RingHistory({ interval, capacity });
  const inputs = createInputLog();
  history.record(state);

  return {
    sim,
    state,
    history,
    inputs,
    mover,
    counter,
    runTo(target: number) {
      while (state.tick < target) {
        inputs.record(state.tick + 1, []);
        tick(sim, state);
        history.record(state);
      }
    },
  };
}

describe('база восстановления — ближайший снапшот (REW-2)', () => {
  it('путь к точке на состояние не влияет: бит-в-бит одно и то же (DET-1)', () => {
    // Прямо в целевой тик: реплей от снапшота тика 20.
    const plain = countingHarness();
    plain.runTo(28);
    const direct = createRewindController(plain.sim, plain.state, {
      history: plain.history,
      inputs: plain.inputs,
    });
    direct.pause();
    direct.beginRewind();
    direct.seekTo(26);
    const expected = snapshotToPlain(takeSnapshot(plain.state));

    // Через промежуточную точку 23 и затем ВПЕРЁД до 26 — тот же снапшот тика
    // 20 основанием, тот же реплей, то же состояние.
    const stepped = countingHarness();
    stepped.runTo(28);
    const wsm = createRewindController(stepped.sim, stepped.state, {
      history: stepped.history,
      inputs: stepped.inputs,
    });
    wsm.pause();
    wsm.beginRewind();
    wsm.seekTo(23);
    const beforeForward = stepped.counter.ticks;
    wsm.seekTo(26);

    expect(snapshotToPlain(takeSnapshot(stepped.state))).toEqual(expected);
    // Шесть тиков реплея от снапшота тика 20: уже пройденная точка 23 базой не
    // становится — кэша восстановленного состояния у контроллера нет.
    expect(stepped.counter.ticks - beforeForward).toBe(6);
  });

  it('шаг назад доигрывается от снапшота: состояние будущего основанием не бывает', () => {
    const h = countingHarness();
    h.runTo(28);
    const wsm = createRewindController(h.sim, h.state, { history: h.history, inputs: h.inputs });
    wsm.pause();
    wsm.beginRewind();
    wsm.seekTo(26);
    const before = h.counter.ticks;
    wsm.seekTo(23);

    expect(h.state.tick).toBe(23);
    expect(h.counter.ticks - before).toBe(3); // снапшот тика 20 + три тика реплея
  });
});

/**
 * Стенд TIME-9: сцена с платформой TimeScale (SER-7) и три носителя РАЗНЫХ
 * темпов — половинного, обычного и удвоенного. Отдельно от общего harness,
 * потому что остальным тестам платформа не нужна, а её компоненты меняли бы их
 * снапшоты (SER-7).
 *
 * Источники ставятся overrides спавна, а не системой: список источников —
 * обычный компонент (TIME-7), и постоянный на весь прогон множитель есть его
 * начальное значение, а не эффект, который кто-то навешивает по ходу.
 */
const TIME_SCALE_SCENE: SceneDef = {
  components: [
    { name: 'Position', fields: { x: 'fixed', y: 'fixed' } },
    { name: 'Velocity', fields: { x: 'fixed', y: 'fixed' } },
  ],
  // Компоненты `TimeScale`/`TimeScaleModifiers` и сведение источников
  // подключает сама сцена (SER-7, TIME-2, TIME-7).
  timeScale: true,
  prefabs: [
    {
      name: 'scaledMover',
      components: {
        Position: { x: 0, y: 0 },
        Velocity: { x: FIXED_ONE, y: 0 },
        TimeScaleModifiers: {},
      },
    },
  ],
};

/** Половина и удвоение — точные доли Q16.16, а не округления (FP-3). */
const HALF_SCALE = fixed.fromFloat(0.5);
const DOUBLE_SCALE = fixed.fromInt(2);

/**
 * Потребитель времени, опт-инувшийся в TimeScale (TIME-4): точка интеграции
 * физики (PHYS-8) в миниатюре — за тик сущность проходит свою скорость,
 * умноженную на личный множитель.
 */
const scaledMoveSystem: System = {
  name: 'ScaledMove',
  order: 20,
  run(ctx) {
    for (const entity of ctx.query({ all: ['Position', 'Velocity'] })) {
      const step = ctx.math.mul(
        ctx.get(entity, 'Velocity', 'x'),
        ctx.getEffectiveDelta(entity, FIXED_ONE),
      );
      ctx.commands.setField(entity, 'Position', 'x', ctx.math.add(ctx.get(entity, 'Position', 'x'), step));
    }
  },
};

function timeScaleHarness(interval = 5, capacity = 8) {
  const { world, systems, modifiers } = loadScene(TIME_SCALE_SCENE);
  // Тот же бросок RNG в состояние, что и в общем harness: без него реплей не
  // проверил бы восстановление стримов.
  systems.register(rollSystem);
  systems.register(scaledMoveSystem);

  const half = spawn(world, 'scaledMover', { TimeScaleModifiers: { id0: 1, value0: HALF_SCALE } });
  // Без источников: произведение нейтрально, компонент не заводится (TIME-3).
  const normal = spawn(world, 'scaledMover');
  const double = spawn(world, 'scaledMover', { TimeScaleModifiers: { id0: 1, value0: DOUBLE_SCALE } });

  const sim: Simulation = { systems, worldSeed: WORLD_SEED, math: mathApi, modifiers };
  const state = initialState(world, WORLD_SEED);
  const history = new RingHistory({ interval, capacity });
  const inputs = createInputLog();
  history.record(state);

  return {
    sim,
    state,
    history,
    inputs,
    half,
    normal,
    double,
    /** Пройденный путь всех трёх темпов — то, чем половинный отличается от удвоенного. */
    xs: (): number[] => [half, normal, double].map((entity) => getField(world, entity, 'Position', 'x')),
    scaleOf: (entity: EntityId): number => getField(world, entity, TIME_SCALE_COMPONENT, 'value'),
    runTo(target: number) {
      while (state.tick < target) {
        inputs.record(state.tick + 1, []);
        tick(sim, state);
        history.record(state);
      }
    },
  };
}

/**
 * TIME-9 и его граница. Норма — про ФАЗУ ОЖИДАНИЯ команды перемотки: «перемотка
 * идёт единым темпом rewind-механизма, без учёта индивидуальных скоростей».
 * На внутренний реплей вперёд внутри `seekTo` она MUST NOT распространяться
 * (REW-2, REW-4): там TimeScale каждой сущности читается и применяется штатно,
 * ровно как в исходном проходе, иначе реплей не восстановил бы бит-в-бит то же
 * состояние (DET-1, SNAP-1).
 */
describe('TimeScale и перемотка (TIME-9, REW-2, REW-4, DET-1)', () => {
  const controller = (h: Pick<Harness, 'sim' | 'state' | 'history' | 'inputs'>) =>
    createRewindController(h.sim, h.state, { history: h.history, inputs: h.inputs });

  it('в фазе ожидания личные темпы ни на что не влияют, а темп задаёт rewind-механизм (TIME-9)', () => {
    const h = timeScaleHarness();
    h.runTo(6);

    // Источники доехали до сущностей штатным путём (TIME-7), и темпы разошлись:
    // без расхождения «мир стоит» было бы неотличимо от «TimeScale тут нет».
    expect(h.scaleOf(h.half)).toBe(HALF_SCALE);
    expect(h.scaleOf(h.double)).toBe(DOUBLE_SCALE);
    const frozen = h.xs();
    expect(frozen).toEqual([fixed.fromInt(3), fixed.fromInt(6), fixed.fromInt(12)]);

    const wsm = controller(h);
    wsm.pause();
    wsm.beginRewind();
    // Мир ждёт команду: тик вперёд не идёт вообще, и TimeScale не на что
    // влиять — ни половинной сущности, ни удвоенной (TIME-9, REW-4).
    tick(h.sim, h.state);
    tick(h.sim, h.state);
    expect(h.state.tick).toBe(6);
    expect(h.xs()).toEqual(frozen);

    // Ведёт мир один только rewind-механизм, и ведёт его единым темпом: один
    // `seekTo` уводит на целевой тик и половинную сущность, и удвоенную разом.
    wsm.seekTo(2);
    expect(h.state.tick).toBe(2);
    expect(h.xs()).toEqual([fixed.fromInt(1), fixed.fromInt(2), fixed.fromInt(4)]);
  });

  it('реплей внутри seekTo применяет личный TimeScale и восстанавливает состояние бит-в-бит (REW-2, DET-1)', () => {
    // Цель между снапшотами: интервал 5, ближайший снапшот — тик 10, дальше
    // три тика реплея, каждый из которых обязан читать личный темп сущности.
    const TARGET = 13;
    const h = timeScaleHarness(5, 8);
    h.runTo(TARGET);

    const expected = snapshotToPlain(takeSnapshot(h.state));
    const positions = h.xs();
    expect(positions).toEqual([fixed.fromFloat(6.5), fixed.fromInt(13), fixed.fromInt(26)]);

    h.runTo(20);
    const wsm = controller(h);
    wsm.pause();
    wsm.beginRewind();
    wsm.seekTo(TARGET);

    // Побитово то же состояние целиком — мир, шина, стримы RNG и номер тика
    // (SNAP-1): реплей прошёл теми же темпами, что исходный проход. Режим мира
    // восстанавливаемым содержимым не является (REW-2) — скраб остаётся в
    // `Rewinding`, и только он один отличает восстановленный снапшот от
    // исходного.
    expect(snapshotToPlain(takeSnapshot(h.state))).toEqual({ ...expected, mode: 'Rewinding' });
    // Отдельно — сами расхождения темпов: реплей, игнорирующий TimeScale,
    // провёл бы три тика от снапшота тика 10 одним общим шагом, и красным был
    // бы именно этот список — половинная сущность уехала бы вперёд, удвоенная
    // отстала.
    expect(h.xs()).toEqual(positions);
  });
});

/**
 * Событие-запрос перемотки: конвенция ХОСТА, не ядра. Ядро событие не
 * интерпретирует — оно наблюдаемо снаружи в составе `TickResult`, а переходы
 * машины состояний проводит тот, кто владеет миром (WSM-5).
 */
describe('запрос перемотки как обычное событие шины (WSM-5, OBS-1)', () => {
  const REQUEST = '$rewind/request';

  const requestSystem = new EvaluatedSystem({
    name: 'RewindCast',
    order: 40,
    query: { all: ['Cooldown'] },
    as: 'e',
    do: [
      {
        if: {
          cond: { '==': [{ getComponent: [{ var: 'e' }, 'Cooldown', 'rewind'] }, 0] },
          then: [
            {
              emitEvent: {
                type: REQUEST,
                data: { initiator: { var: 'e' }, depthTicks: 420 },
              },
            },
          ],
        },
      },
    ],
  });

  it('запрос читается из TickResult, а мир его не исполняет', () => {
    const registry = new SystemRegistry();
    registry.register(requestSystem);
    const world = createWorld(SCHEMAS, PREFABS);
    const caster = spawn(world, 'mover');
    const sim: Simulation = { systems: registry, worldSeed: WORLD_SEED, math: mathApi };
    const state = initialState(world, WORLD_SEED);

    const result = tick(sim, state);

    const requests = [...result.events].filter((event) => event.type === REQUEST);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.data).toEqual({ initiator: caster, depthTicks: 420 });
    // Ядро запрос не трактует: мир идёт дальше, машина состояний не тронута.
    expect(result.mode).toBe('Running');
    expect(state.tick).toBe(1);
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

