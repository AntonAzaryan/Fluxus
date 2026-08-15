/**
 * Локальный режим как ХОСТ мира (SHELL-6, SHELL-8): ульта отката прожимается в
 * симуляции — JSON-система сцены эмитит событие-запрос, — а оболочка дренирует
 * его после тика и сама проводит переходы машины состояний через core-API
 * (WSM-5). Тот же контракт, что у сервера матча, и та же цепочка: запрос →
 * заморозка → ведение точки по удержанию → возобновление.
 *
 * Сетевого режима это не касается вовсе: там запрос дренирует сервер, а
 * собственной перемотки у клиента MUST NOT быть ни при каких условиях
 * (`netcode` NET-11).
 */
import { describe, expect, it } from 'vitest';
import {
  InputSystem,
  RingHistory,
  createInputLog,
  createRewindController,
  initialState,
  loadScene,
  mathApi,
  query,
  world as coreWorld,
  worldInitSpawn,
  type SceneDef,
  type Simulation,
  type SimulationState,
} from '@game-mvp/core';
import { REWIND_REQUEST_EVENT } from '@game-mvp/net';
import { WorkerShell, type ShellHistory } from '../src/index.js';
import { PLAYER_ID, TICK_SECONDS, makeExtractor, sceneDef, syncPortPair } from './fixtures.js';

const ULT_BUTTON = 7;
const ULT = 1 << ULT_BUTTON;
/** Обычное действие рядом с ультой: сцена его ни во что не превращает. */
const OTHER = 1 << 2;
const DEPTH_TICKS = 12;
const STEP_TICKS = 3;
const EVERY = 2;

const e = { var: 'e' } as const;
const field = (component: string, name: string): object => ({ getComponent: [e, component, name] });

/** Сцена фикстуры плюс ульта отката: гейт по фронту кнопки и по cooldown'у. */
function ultScene(): SceneDef {
  const def = sceneDef();
  const hero = def.prefabs![0]!;
  return {
    ...def,
    components: [...def.components, { name: 'RewindCooldown', fields: { max: 'i32', ticks: 'i32' } }],
    prefabs: [
      { ...hero, components: { ...hero.components, RewindCooldown: { max: 600, ticks: 0 } } },
    ],
    systems: [
      ...def.systems!,
      {
        name: 'RewindCooldownTick',
        order: 5,
        query: { all: ['RewindCooldown'] },
        as: 'e',
        do: [
          {
            if: {
              cond: { '>': [field('RewindCooldown', 'ticks'), 0] },
              then: [
                {
                  modifyComponent: {
                    entity: e,
                    component: 'RewindCooldown',
                    values: { ticks: { '-': [field('RewindCooldown', 'ticks'), 1] } },
                  },
                },
              ],
            },
          },
        ],
      },
      {
        name: 'RewindCast',
        order: 40,
        query: { all: ['Input', 'RewindCooldown'] },
        as: 'e',
        do: [
          {
            if: {
              cond: {
                and: [
                  { bitTest: [field('Input', 'buttons'), ULT_BUTTON] },
                  { '!': [{ bitTest: [field('Input', 'prevButtons'), ULT_BUTTON] }] },
                  { '==': [field('RewindCooldown', 'ticks'), 0] },
                ],
              },
              then: [
                {
                  modifyComponent: {
                    entity: e,
                    component: 'RewindCooldown',
                    values: { ticks: field('RewindCooldown', 'max') },
                  },
                },
                {
                  emitEvent: {
                    type: REWIND_REQUEST_EVENT,
                    data: { initiator: e, depthTicks: DEPTH_TICKS },
                  },
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

interface Rig {
  readonly shell: WorkerShell;
  readonly state: SimulationState;
  readonly history: ShellHistory;
  readonly dropped: number[];
  send(buttons: number): void;
  run(ticks: number, buttons?: number): void;
  holdUntilResume(buttons: number, maxTicks?: number): void;
}

function localRig(): Rig {
  const scene = loadScene(ultScene());
  scene.systems.register(new InputSystem({ players: [PLAYER_ID] }));
  worldInitSpawn(scene.world, 'Hero');
  const state = initialState(scene.world, 7);
  const sim: Simulation = {
    systems: scene.systems,
    worldSeed: 7,
    math: mathApi,
    ...(scene.terrain !== undefined ? { terrain: scene.terrain } : {}),
  };

  const ring = new RingHistory({ interval: 3, capacity: 32 });
  const dropped: number[] = [];
  // Обрезка стёртой ветви — контракт оболочки, а не кольца ядра: провайдер с
  // `dropAfter` живёт в сетевом слое, здесь его роль играет запись вызовов.
  const history: ShellHistory = {
    record: (s) => { ring.record(s); },
    nearest: (tick) => ring.nearest(tick),
    get oldestTick() { return ring.oldestTick; },
    get newestTick() { return ring.newestTick; },
    dropAfter: (tick) => { dropped.push(tick); },
  };
  const inputs = createInputLog();
  // Cooldown ульты — exempt-компонент (REW-9): без него откат вернул бы его в
  // ноль, и удерживаемая кнопка кастовала бы ульту снова на первом же живом
  // тике после возобновления.
  const rewind = createRewindController(sim, state, {
    history,
    inputs,
    exempt: [{ component: 'RewindCooldown' }],
  });
  history.record(state);

  const [workerPort, mainPort] = syncPortPair();
  const shell = new WorkerShell({
    mode: 'local',
    port: workerPort,
    sim,
    state,
    tickSeconds: TICK_SECONDS,
    extractor: makeExtractor({ scene, sim, state }),
    playerId: PLAYER_ID,
    rewind,
    inputs,
    history,
    scrub: { button: ULT_BUTTON, step: STEP_TICKS, every: EVERY, timeoutTicks: 6 },
    clock: () => 0,
  });

  const send = (buttons: number): void => {
    mainPort.post({ t: 'input', move: { x: 0, y: 0 }, aimDir: 0, buttons });
  };
  const run = (ticks: number, buttons = 0): void => {
    for (let i = 0; i < ticks; i++) {
      send(buttons);
      shell.stepTick();
    }
  };
  const holdUntilResume = (buttons: number, maxTicks = 200): void => {
    for (let i = 0; i < maxTicks && state.mode !== 'Running'; i++) {
      send(buttons);
      shell.stepTick();
    }
  };

  return { shell, state, history, dropped, send, run, holdUntilResume };
}

/** Кнопки, доехавшие до мира: то, что `InputSystem` положила на сущность игрока. */
function heroButtons(state: SimulationState): number {
  for (const entity of query(state.world, { all: ['Input'] })) {
    return coreWorld.getField(state.world, entity, 'Input', 'buttons');
  }
  throw new Error('в мире нет сущности с компонентом Input');
}

describe('локальный режим: дренаж запроса и ведение точки (SHELL-6, WSM-5)', () => {
  it('ульта из JSON-системы уводит мир в Rewinding через Paused', () => {
    const rig = localRig();
    rig.run(10);
    expect(rig.state.mode).toBe('Running');

    rig.run(1, ULT);

    expect(rig.state.mode).toBe('Rewinding');
    expect(rig.state.tick).toBe(11);
  });

  it('точка перемотки идёт назад по шагу, пока орган управления удержан', () => {
    const rig = localRig();
    rig.run(20);
    rig.run(1, ULT);
    const castTick = rig.state.tick;

    rig.run(2 * EVERY, ULT);

    expect(rig.state.tick).toBe(castTick - 2 * STEP_TICKS);
    expect(rig.state.mode).toBe('Rewinding');
    // Стёртая ветвь ушла из истории на каждом восстановлении.
    expect(rig.dropped).toEqual([castTick - STEP_TICKS, castTick - 2 * STEP_TICKS]);
  });

  it('отпускание возобновляет мир с достигнутой точки', () => {
    const rig = localRig();
    rig.run(20);
    rig.run(1, ULT);
    const castTick = rig.state.tick;
    rig.run(2 * EVERY, ULT);
    const stopped = rig.state.tick;

    rig.run(EVERY, 0);

    expect(rig.state.mode).toBe('Running');
    // Тик, на котором скраб кончился, мир уже проходит живым: оболочка должна
    // тик за вызов, и после возобновления он принадлежит продолженному миру.
    expect(rig.state.tick).toBe(stopped + 1);
    expect(stopped).toBe(castTick - 2 * STEP_TICKS);
  });

  it('на глубине из запроса мир возобновляется сам', () => {
    const rig = localRig();
    rig.run(30);
    rig.run(1, ULT);
    const castTick = rig.state.tick;

    rig.holdUntilResume(ULT);

    expect(rig.state.mode).toBe('Running');
    // Точка автостопа — ровно глубина запроса; тик возобновления идёт следом.
    expect(rig.state.tick).toBe(castTick - DEPTH_TICKS + 1);
    // Мир пошёл дальше от откаченного тика — заморозка кончилась вместе со скрабом.
    rig.run(3);
    expect(rig.state.tick).toBe(castTick - DEPTH_TICKS + 4);
  });

  it('молчание главного потока равно отпусканию: замерший main не вешает мир', () => {
    const rig = localRig();
    rig.run(20);
    rig.run(1, ULT);

    // Сообщений ввода больше нет вовсе — только тики.
    for (let i = 0; i < 20; i++) rig.shell.stepTick();

    expect(rig.state.mode).toBe('Running');
  });

  it('кнопка, нажатая в замороженном мире, после возобновления не срабатывает (REW-5)', () => {
    const rig = localRig();
    rig.run(30);
    rig.run(1, ULT);
    expect(rig.state.mode).toBe('Rewinding');

    // Игрок держит ульту и заодно жмёт обычное действие — руки не знают, что мир
    // стоит. Латч фронтов оболочки гасится на КАЖДОМ замороженном тике, и до
    // первого живого тика после возобновления это нажатие не доезжает: иначе
    // ввод, накопленный в замороженном мире, лёг бы на возобновлённый залпом
    // (NET-11, REW-5).
    rig.holdUntilResume(ULT | OTHER);

    expect(rig.state.mode).toBe('Running');
    expect(heroButtons(rig.state) & OTHER).toBe(0);
  });

  it('вторая ульта во время cooldown гейтится контентом, а не оболочкой', () => {
    const rig = localRig();
    rig.run(30);
    rig.run(1, ULT);
    rig.holdUntilResume(ULT);
    const resumed = rig.state.tick;

    // Кнопка нажата заново в возобновлённом мире: cooldown откат пережил
    // (exempt-компонент), и гейт системы вторую перемотку не пускает.
    rig.run(1, 0);
    rig.run(2, ULT);

    expect(rig.state.mode).toBe('Running');
    expect(rig.state.tick).toBe(resumed + 3);
    expect(rig.dropped.length).toBeGreaterThan(0);
  });
});
