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
import { WorkerShell, type ControlMessage, type ShellHistory } from '../src/index.js';
import { PLAYER_ID, TICK_SECONDS, makeExtractor, sceneDef, syncPortPair } from './fixtures.js';

const ULT_BUTTON = 7;
const ULT = 1 << ULT_BUTTON;
/** Обычное действие рядом с ультой: сцена его ни во что не превращает. */
const OTHER = 1 << 2;
const DEPTH_TICKS = 12;
/** Cooldown ульты в сцене оснастки: второй каст возможен только после него. */
const ULT_COOLDOWN = 600;
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
      { ...hero, components: { ...hero.components, RewindCooldown: { max: ULT_COOLDOWN, ticks: 0 } } },
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

/** Что у собранной оболочки отнимают ради проверки её отказа. */
interface RigOptions {
  /** Собрать оболочку БЕЗ контроллера перемотки — механизма в сборке нет. */
  readonly withoutRewind?: boolean;
  /** Приёмник диагностики запроса перемотки вместо умолчания-консоли. */
  readonly rewindWarn?: (message: string) => void;
}

interface Rig {
  readonly shell: WorkerShell;
  readonly state: SimulationState;
  readonly history: ShellHistory;
  readonly dropped: number[];
  send(buttons: number): void;
  run(ticks: number, buttons?: number): void;
  holdUntilResume(buttons: number, maxTicks?: number): void;
  /** Команда управления из HUD — тем же каналом, что ввод (SHELL-6). */
  control(action: ControlMessage['action'], tick?: number): void;
}

function localRig(options: RigOptions = {}): Rig {
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
    ...(options.withoutRewind === true ? {} : { rewind }),
    ...(options.rewindWarn !== undefined ? { rewindWarn: options.rewindWarn } : {}),
    inputs,
    history,
    scrub: { button: ULT_BUTTON, step: STEP_TICKS, every: EVERY, timeoutTicks: 6 },
    clock: () => 0,
  });

  const send = (buttons: number): void => {
    mainPort.post({ t: 'input', move: { x: 0, y: 0 }, aimDir: 0, buttons });
  };
  const control = (action: ControlMessage['action'], tick?: number): void => {
    mainPort.post({ t: 'control', action, ...(tick !== undefined ? { tick } : {}) });
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

  return { shell, state, history, dropped, send, run, holdUntilResume, control };
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

    // ОДНОГО тика без бита довольно: отпускание читается каждым тиком, а не на
    // границе цикла шага (REW-13). Досиженный цикл означал бы мир, замерший уже
    // после того, как игрок отпустил клавишу.
    rig.run(1, 0);

    expect(rig.state.mode).toBe('Running');
    // Тик, на котором скраб кончился, мир уже проходит живым: оболочка должна
    // тик за вызов, и после возобновления он принадлежит продолженному миру.
    expect(rig.state.tick).toBe(stopped + 1);
    expect(stopped).toBe(castTick - 2 * STEP_TICKS);
  });

  it('короткое нажатие двигает точку, а не сгорает впустую (РЕГРЕССИЯ, REW-13)', () => {
    // РЕГРЕССИЯ, зеркальная серверной (`net-ts/test/rewind.test.ts`). Первого
    // шага ждали целый цикл, а проверка отпускания стояла ЗА тем же гейтом:
    // игрок, отпустивший клавишу внутри цикла, получал мир, замерший и
    // возобновившийся на ТОМ ЖЕ тике, — ульта сгорала на полный cooldown, не
    // отмотав ни одного тика.
    const rig = localRig();
    rig.run(20);
    rig.run(1, ULT);
    const castTick = rig.state.tick;
    expect(rig.state.mode).toBe('Rewinding');

    // Короче нажатия не бывает: бита нет уже в первом сообщении после каста —
    // то есть отпускание попадает ВНУТРЬ первого цикла шага (`EVERY`).
    //
    // Первое ведение: шаг входа сделан, мир ещё заморожен.
    rig.run(1, 0);
    expect(rig.state.mode).toBe('Rewinding');
    expect(rig.state.tick).toBe(castTick - STEP_TICKS);

    // Второе: отпускание прочитано тем же тиком, мир возобновлён с достигнутой
    // точки и пошёл дальше живыми тиками — раньше того, где ульту прожали.
    rig.run(1, 0);
    expect(rig.state.mode).toBe('Running');
    expect(rig.state.tick).toBeLessThan(castTick);
  });

  it('оболочка без контроллера запрос не исполняет, но называет это вслух — один раз', () => {
    // Зеркало серверной проверки (`net-ts/test/rewind.test.ts`): сборка БЕЗ
    // механизма перемотки — дефект сборки, а не норма REW-12. Молчание о нём
    // выглядит снаружи как ульта, которая жжёт cooldown и ничего не делает.
    const warned: string[] = [];
    const rig = localRig({
      withoutRewind: true,
      rewindWarn: (message) => {
        warned.push(message);
      },
    });

    // Ульта прожимается дважды: гейт cooldown'а сцены пропустит только первый
    // каст, поэтому запрос второй раз придёт после его истечения — а отчёт
    // всё равно останется один.
    rig.run(20);
    rig.run(1, ULT);
    expect(rig.state.mode).toBe('Running');
    rig.run(ULT_COOLDOWN + 2);
    rig.run(1, ULT);

    expect(rig.state.mode).toBe('Running');
    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain(REWIND_REQUEST_EVENT);
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

describe('команды управления из HUD (SHELL-6, WSM-5)', () => {
  it('seekTo командой управления обрезает стёртую ветвь истории, как шаг скраба (REW-13)', () => {
    const rig = localRig();
    rig.run(20);
    rig.control('pause');
    rig.control('beginRewind');

    rig.control('seekTo', 15);

    expect(rig.state.mode).toBe('Rewinding');
    expect(rig.state.tick).toBe(15);
    // Стёртая ветвь ушла из истории тем же вызовом, что у шага скраба: без
    // обрезки в буфере лежали бы два снапшота на один номер тика — стёртой
    // ветви и живой, — и следующая перемотка восстановила бы ту, в которой
    // мира уже нет (контракт `ShellHistory`).
    expect(rig.dropped).toEqual([15]);

    // Скраб ВПЕРЁД внутри одной перемотки законен (REW-7): тик 18 исполнен и
    // лежит в каноническом логе — граница у seekTo не текущий тик, а последний
    // исполненный живой.
    rig.control('seekTo', 18);
    expect(rig.state.tick).toBe(18);
    expect(rig.dropped).toEqual([15, 18]);
  });

  it('seekTo вперёд исполненного тика отбрасывается: реплей по пустому логу — не состояние (REW-7)', () => {
    const rig = localRig();
    rig.run(20);
    rig.control('pause');
    rig.control('beginRewind');

    rig.control('seekTo', 100);

    // Мир не «доигран» реплеем по пустому логу вводов до тика, которого нет и
    // не будет в каноническом логе (там же смысл границы у `MatchServer.seekTo`):
    // команда отброшена целиком, история не тронута.
    expect(rig.state.tick).toBe(20);
    expect(rig.state.mode).toBe('Rewinding');
    expect(rig.dropped).toEqual([]);
  });

  it('команда, недопустимая для текущего режима, отбрасывается, а не роняет воркер (WSM-2, REW-8)', () => {
    const rig = localRig();
    rig.run(5);

    // Канал управления асинхронен: main мог отправить команду до того, как
    // узнал о смене режима. Ядро на такие переходы бросает (WSM-2, WSM-5,
    // REW-8) — до обработчика сообщений воркера бросок долетать не должен.
    expect(() => {
      rig.control('resume'); // выход в Running не из Paused
      rig.control('seekTo', 2); // seekTo вне Rewinding
      rig.control('beginRewind'); // вход в Rewinding не из Paused
    }).not.toThrow();
    expect(rig.state.mode).toBe('Running');
    expect(rig.state.tick).toBe(5);

    rig.control('pause');
    rig.control('pause'); // двойной клик паузы идемпотентен
    expect(rig.state.mode).toBe('Paused');
    rig.control('beginRewind');
    // Перемотка внутри перемотки (REW-8) — отброшена, а не исключение.
    expect(() => { rig.control('beginRewind'); }).not.toThrow();
    expect(rig.state.mode).toBe('Rewinding');

    rig.control('pause');
    rig.control('resume');
    expect(rig.state.mode).toBe('Running');
  });
});
