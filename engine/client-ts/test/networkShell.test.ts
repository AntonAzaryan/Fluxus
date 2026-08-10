/**
 * Сетевой режим оболочки (SHELL-8) против локального сервера матча (NTR-12).
 *
 * Матч поднимается внутрипроцессно — настоящие `MatchServer`, `MatchClient` и
 * loopback-транспорт, без сокетов и таймеров: «отдельной тестовой реализации
 * сервера или клиента MUST NOT быть» (NTR-12), поэтому здесь та же сборка, что
 * играет по сети, а подменён только транспорт.
 *
 * Что именно проверяется, кроме того, что связка работает:
 *
 * - `tick()` в сетевом режиме не вызван ни разу за сессию (SHELL-8). Запрет
 *   структурный — `NetworkShell` `Simulation` не получает вовсе, и вызвать
 *   `tick()` ему нечем, — но SHELL-8 требует наблюдаемости, а не ревью: в мир,
 *   который оболочка наполняет снапшотами, подсаживается система-зонд, и её
 *   счётчик прогонов остаётся нулевым до конца сессии.
 * - ввод локально не применяется (`netcode-transport` NTR-10): состояние
 *   воркера не двигается, пока не пришёл снапшот;
 * - запрос перемотки уезжает вводом и машину состояний воркера не двигает
 *   (`netcode` NET-11, `snapshot-rewind` REW-6); картинка перематывается только
 *   с приходом перемотанных авторитетных состояний;
 * - одна и та же подсистема рендера подключается к локальной и к сетевой сборке
 *   без правок и получает тот же контракт доставки — то самое доказательство
 *   того, что граница режимов выбрана верно (design Decision 3).
 */
import { describe, expect, it } from 'vitest';
import {
  FIXED_ONE,
  query,
  world as coreWorld,
  type EntityId,
  type SceneDef,
  type SimulationState,
  type System,
} from '@game-mvp/core';
import {
  LoopbackHub,
  MatchClient,
  MatchHost,
  MatchServer,
  buildMatchWorld,
  contentPack,
  type MatchConfig,
} from '@game-mvp/net';
import { Extractor, kindByTags, type RenderSubsystem, type TickView } from '@game-mvp/render';
import { NetworkShell, RemoteHost, WorkerShell, type ShellPort } from '../src/index.js';
import {
  PLAYER_ID,
  STEP,
  TICK_SECONDS,
  dummyContext,
  makeExtractor,
  makeRig,
  sceneDef,
  snapshotView,
  syncPortPair,
} from './fixtures.js';

const BUILD_ID = 'shell-network-0001';
const TICK_RATE = 20;
const SCENE_REF = 'duel';
/** Бит кнопки, которым сборка выражает запрос ульты отката (WSM-5 — политика). */
const REWIND_BUTTON = 4;
const PULSE_EVENT = 'Pulse';

/** Доставка loopback'а асинхронная (NTR-2): пара макротасков на раунд. */
async function settle(rounds = 3): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Сцена матча — фикстура оболочки плюс система, эмитящая факт каждый тик:
 * поток `Events` (NTR-15) иначе пуст, и «события едут отдельным сообщением, а
 * не шиной снапшота» проверить было бы нечем.
 */
function matchScene(): SceneDef {
  const base = sceneDef();
  return {
    ...base,
    systems: [
      ...(base.systems ?? []),
      {
        name: 'Pulse',
        order: 20,
        query: { all: ['Player'] },
        as: 'e',
        do: [{ emitEvent: { type: PULSE_EVENT, data: { dirX: 0, dirY: FIXED_ONE } } }],
      },
    ],
  };
}

function matchConfig(scene: SceneDef, hash: string, snapshotRate = TICK_RATE): MatchConfig {
  return {
    version: { buildId: BUILD_ID, contentPackHash: hash },
    // Один слот: матч стартует, как только он занят, и второй клиент вертикали
    // оболочки ничего не добавляет — проверяется клиент, а не состав матча.
    players: [PLAYER_ID],
    seed: 7,
    sceneRef: SCENE_REF,
    scene,
    initial: [{ prefab: 'Hero' }],
    tickRate: TICK_RATE,
    // По умолчанию снапшот каждый тик: доставка главному потоку идёт в темпе
    // рассылки, и ожидания теста считаются без поправки на прореживание.
    // Прореженная рассылка проверяется отдельно — ею и покрываются тики без
    // снапшота (NTR-15).
    snapshotRate,
    inputDelay: 2,
    rewind: { interval: 1, capacity: 64 },
  };
}

/** Подсистема-зонд: копит доставленные view и события с их номерами тиков. */
function probe(): {
  subsystem: RenderSubsystem;
  views: unknown[];
  events: { tick: number | undefined; type: string }[];
} {
  const views: unknown[] = [];
  const events: { tick: number | undefined; type: string }[] = [];
  return {
    views,
    events,
    subsystem: {
      name: 'probe',
      init: () => {},
      syncTick(view: TickView) {
        views.push(snapshotView(view));
        for (const event of view.events) events.push({ tick: event.tick, type: event.type });
      },
      updateFrame: () => {},
    },
  };
}

interface NetworkRig {
  readonly clock: { ms: number };
  readonly server: MatchServer;
  readonly matchHost: MatchHost;
  readonly client: MatchClient;
  readonly shell: NetworkShell;
  readonly remote: RemoteHost;
  readonly state: SimulationState;
  readonly probe: ReturnType<typeof probe>;
  readonly posted: string[];
  /** Прогонов систем в мире оболочки: нулевой счётчик и есть «tick() не вызван». */
  systemRuns(): number;
}

function networkRig(options: { snapshotRate?: number } = {}): NetworkRig {
  const scene = matchScene();
  const pack = contentPack({ [SCENE_REF]: scene });
  const config = matchConfig(scene, pack.hash, options.snapshotRate);
  const clock = { ms: 0 };

  const hub = new LoopbackHub();
  const server = new MatchServer(config);
  const matchHost = new MatchHost(server, hub);

  const client = new MatchClient({
    playerId: PLAYER_ID,
    version: config.version,
    content: pack,
  });

  // Локально поднятый мир матча (NTR-5, NTR-10) — тем же публичным путём, каким
  // его поднимает клиент. Оболочке уезжает только его состояние: `Simulation`
  // остаётся здесь, и потому вызвать `tick()` сетевой стороне нечем (SHELL-8).
  const world = buildMatchWorld({
    scene,
    seed: config.seed,
    players: config.players,
    ...(config.initial !== undefined ? { initial: config.initial } : {}),
  });
  let runs = 0;
  const spy: System = { name: 'TickProbe', order: 1000, run: () => { runs++; } };
  world.sim.systems.register(spy);

  const grid = world.sim.terrain?.grid;
  const extractor = new Extractor({
    kindOf: kindByTags(['Hero']),
    ...(grid !== undefined ? { terrainGrid: grid } : {}),
  });

  // Порт воркера протоколирует отправленное: порядок сообщений воркер → main и
  // есть ответ на вопрос «режим приехал до первой доставки состояния» (SHELL-8).
  const [rawWorkerPort, mainPort] = syncPortPair();
  const posted: string[] = [];
  const workerPort: ShellPort = {
    post(message, transfer) {
      posted.push((message as { t: string }).t);
      rawWorkerPort.post(message, transfer);
    },
    onMessage(handler) {
      rawWorkerPort.onMessage(handler);
    },
  };

  const shellProbe = probe();
  const remote = new RemoteHost(dummyContext(), {
    clock: () => clock.ms,
    onReady: () => remote.register(shellProbe.subsystem),
  }).connect(mainPort);

  const shell = new NetworkShell({
    mode: 'network',
    port: workerPort,
    client,
    transport: hub.connect(),
    state: world.state,
    // Доставки идут в темпе рассылки снапшотов — знаменатель альфы главного
    // потока берётся оттуда же (SHELL-3).
    tickSeconds: 1 / (config.snapshotRate ?? TICK_RATE),
    extractor,
    terrain: grid ?? null,
    // Политика сборки: ульта отката висит на этом бите (WSM-5). Пауза и
    // возобновление не отображены намеренно — проверяется и это.
    controlButtons: { beginRewind: REWIND_BUTTON },
    helloExtra: { player: PLAYER_ID },
    clock: () => clock.ms,
  });
  shell.start();
  // Таймер снимается сразу: шаги делает тест, как и в локальных тестах канала.
  shell.stop();

  return {
    clock,
    server,
    matchHost,
    client,
    shell,
    remote,
    state: world.state,
    probe: shellProbe,
    posted,
    systemRuns: () => runs,
  };
}

/** Круг матча: локальный шаг клиента, затем шаг расписания сервера. */
async function playTicks(rig: NetworkRig, count: number): Promise<void> {
  for (let i = 0; i < count; i++) {
    rig.clock.ms += 1000 / TICK_RATE;
    rig.shell.step();
    await settle();
    rig.matchHost.step();
    await settle();
  }
  // Последний шаг — чтобы доехавшее применилось и уехало главному потоку.
  rig.shell.step();
  await settle();
}

function heroOf(state: SimulationState): EntityId {
  const [hero] = [...query(state.world, { all: ['Player', 'Position'] })];
  expect(hero).toBeDefined();
  return hero!;
}

function positionOf(state: SimulationState): { x: number; y: number } {
  const hero = heroOf(state);
  return {
    x: coreWorld.getField(state.world, hero, 'Position', 'x'),
    y: coreWorld.getField(state.world, hero, 'Position', 'y'),
  };
}

describe('сетевой режим: тонкий клиент против локального сервера (SHELL-8, NTR-10, NTR-12)', () => {
  it('ввод доезжает, снапшоты рисуются, tick() не вызван ни разу за сессию', async () => {
    const rig = networkRig();
    // Handshake ушёл до всякого состояния, и режим в нём есть (SHELL-5, SHELL-8):
    // первое сообщение воркера — `hello`, и доставок состояния до него нет.
    expect(rig.posted[0]).toBe('hello');
    expect(rig.posted.indexOf('tick')).toBe(-1);
    expect(rig.remote.mode).toBe('network');

    const start = positionOf(rig.state);
    rig.remote.sendInput({ x: STEP, y: 0 });
    await playTicks(rig, 10);

    expect(rig.client.phase).toBe('playing');
    // Снапшоты применены и доехали до подсистемы главного потока.
    expect(rig.client.metrics.snapshotsApplied).toBeGreaterThan(0);
    expect(rig.probe.views.length).toBeGreaterThan(0);
    // Ввод уехал серверу и вернулся авторитетным состоянием: мир оболочки
    // сдвинулся, хотя тика в ней не было.
    expect(rig.client.metrics.inputsSent).toBeGreaterThan(0);
    expect(positionOf(rig.state).x).toBeGreaterThan(start.x);
    expect(rig.state.tick).toBeGreaterThan(0);

    // Наблюдаемое утверждение SHELL-8: систем мира оболочки не прогонял никто.
    expect(rig.systemRuns()).toBe(0);
  });

  it('факты едут потоком Events, а не шиной снапшота: reliable-часть с номерами тиков (NTR-15, SHELL-4)', async () => {
    const rig = networkRig();
    await playTicks(rig, 8);

    const pulses = rig.probe.events.filter((event) => event.type === PULSE_EVENT);
    expect(pulses.length).toBeGreaterThan(0);
    // Каждый факт несёт свой номер тика, и одного тика дважды не бывает: поток
    // дедуплицируется клиентом, а конверт оболочки его не размножает.
    const ticks = pulses.map((event) => event.tick);
    expect(ticks.every((tick) => typeof tick === 'number')).toBe(true);
    expect(new Set(ticks).size).toBe(ticks.length);
    expect(rig.client.metrics.eventBatchesDelivered).toBeGreaterThan(0);
  });

  it('прореженная рассылка: факты тиков без снапшота не теряются (NTR-15, NTR-7)', async () => {
    // `snapshotRate` — целый делитель `tickRate`, то есть большинство тиков
    // рассылкой не сопровождается. Факты этих тиков едут reliable-частью
    // ближайшего конверта, а не пропадают вместе с ненаступившей рассылкой.
    const rig = networkRig({ snapshotRate: TICK_RATE / 2 });
    await playTicks(rig, 12);

    const ticks = rig.probe.events
      .filter((event) => event.type === PULSE_EVENT)
      .map((event) => event.tick as number)
      .sort((left, right) => left - right);
    expect(ticks.length).toBeGreaterThan(4);
    expect(new Set(ticks).size).toBe(ticks.length);
    // Диапазон покрыт непрерывно: тик без снапшота фактами не обделён.
    for (let i = 1; i < ticks.length; i++) expect(ticks[i]! - ticks[i - 1]!).toBe(1);
    // И конвертов при этом вдвое меньше, чем тиков: состояние conflatable,
    // факты — нет (SHELL-4).
    expect(rig.client.metrics.snapshotsApplied).toBeLessThan(ticks.length);
  });

  it('ввод локально не применяется: состояние воркера не меняется до прихода снапшота (NTR-10)', async () => {
    const rig = networkRig();
    await playTicks(rig, 4);

    const before = positionOf(rig.state);
    const tickBefore = rig.state.tick;
    const sent = rig.client.metrics.inputsSent;

    // Сервер не шагает: снапшотов нет. Шаги оболочки при этом идут, и ввод
    // уезжает — но состояние остаётся тем, которое сервер уже породил.
    rig.remote.sendInput({ x: STEP, y: 0 });
    for (let i = 0; i < 5; i++) {
      rig.clock.ms += 1000 / TICK_RATE;
      rig.shell.step();
      await settle();
    }
    expect(rig.client.metrics.inputsSent).toBeGreaterThan(sent);
    expect(positionOf(rig.state)).toEqual(before);
    expect(rig.state.tick).toBe(tickBefore);
    expect(rig.systemRuns()).toBe(0);

    // Сдвинется оно на пришедшем снапшоте — и эта задержка ожидаема (NTR-10).
    await playTicks(rig, 4);
    expect(positionOf(rig.state).x).toBeGreaterThan(before.x);
  });

  it('запрос перемотки уходит вводом, машина состояний воркера не двигается (NET-11, REW-6)', async () => {
    const rig = networkRig();
    await playTicks(rig, 6);
    const hero = heroOf(rig.state);
    const modeBefore = rig.state.mode;

    // Неотображённое действие отбрасывается: исполнять переход у себя воркер
    // MUST NOT ни при каком отображении (SHELL-6).
    rig.remote.control('pause');
    expect(rig.shell.unmappedControls).toBe(1);
    expect(rig.state.mode).toBe(modeBefore);

    // Отображённое уезжает вводом — и возвращается авторитетным состоянием, в
    // котором кнопка видна на сущности игрока.
    rig.remote.control('beginRewind');
    const buttons: number[] = [];
    for (let i = 0; i < 8; i++) {
      rig.clock.ms += 1000 / TICK_RATE;
      rig.shell.step();
      await settle();
      rig.matchHost.step();
      await settle();
      rig.shell.step();
      await settle();
      buttons.push(coreWorld.getField(rig.state.world, hero, 'Input', 'buttons'));
    }
    expect(buttons).toContain(REWIND_BUTTON);
    // Машина состояний воркера не двигалась: режим мира — тот, что прислал
    // сервер, и своей перемотки у клиента нет.
    expect(rig.state.mode).toBe('Running');
    expect(rig.systemRuns()).toBe(0);
  });

  it('картинка перематывается только с приходом перемотанных авторитетных состояний (NTR-16, SHELL-7)', async () => {
    const rig = networkRig();
    await playTicks(rig, 12);
    const beforeTick = rig.state.tick;
    expect(beforeTick).toBeGreaterThan(6);

    // Запрос из UI сам по себе не перематывает ничего: пока сервер не провёл
    // мир по единственному разрешённому флоу (NET-11, WSM-2), состояние воркера
    // остаётся идущим вперёд.
    rig.remote.control('beginRewind');
    await playTicks(rig, 2);
    expect(rig.state.tick).toBeGreaterThanOrEqual(beforeTick);
    const epochBefore = rig.client.epoch;

    const target = 5;
    rig.server.pause();
    rig.server.beginRewind();
    rig.server.seekTo(target);
    rig.server.pause();
    rig.server.resume();
    // Восстановленное состояние уезжает по факту восстановления, мимо
    // расписания рассылки (NTR-16).
    rig.matchHost.flush();
    await settle();
    rig.shell.step();
    await settle();

    expect(rig.client.epoch).toBeGreaterThan(epochBefore);
    expect(rig.state.tick).toBe(target);
    const delivered = rig.probe.views.at(-1) as { tick: number; snapAll: boolean };
    expect(delivered.tick).toBe(target);
    // Смена эпохи — разрыв непрерывности: состояние рисуется snap'ом (SHELL-7).
    expect(delivered.snapAll).toBe(true);
    // Кольцо своих кадров (NET-9) в сетевой сборке есть, и видно это по величине,
    // которую только оно и даёт: сколько ввода игрока унесла перемотка (NTR-10).
    expect(rig.client.metrics.inputsStranded).toBeGreaterThan(0);
    expect(rig.systemRuns()).toBe(0);
  });
});

describe('одна подсистема в обеих сборках оболочки (SHELL-8, REND-8)', () => {
  it('локальная и сетевая сборки дают подсистеме один контракт доставки', async () => {
    // Сетевая сборка.
    const net = networkRig();
    await playTicks(net, 8);

    // Локальная сборка: та же подсистема-зонд, тот же `RemoteHost`, тот же
    // канал — различается только воркер-сторона.
    const rig = makeRig({ castOnTicks: [3] });
    const [workerPort, mainPort] = syncPortPair();
    const localProbe = probe();
    const local = new RemoteHost(dummyContext(), {
      clock: () => 0,
      onReady: () => local.register(localProbe.subsystem),
    }).connect(mainPort);
    const shell = new WorkerShell({
      mode: 'local',
      port: workerPort,
      sim: rig.sim,
      state: rig.state,
      tickSeconds: TICK_SECONDS,
      extractor: makeExtractor(rig),
      playerId: PLAYER_ID,
      clock: () => 0,
    });
    shell.start();
    shell.stop();
    for (let i = 0; i < 8; i++) shell.stepTick();

    // Режим главному потоку известен и различается; всё остальное — нет.
    expect(local.mode).toBe('local');
    expect(net.remote.mode).toBe('network');

    expect(localProbe.views.length).toBeGreaterThan(0);
    expect(net.probe.views.length).toBeGreaterThan(0);
    const localView = localProbe.views.at(-1) as Record<string, unknown>;
    const netView = net.probe.views.at(-1) as Record<string, unknown>;
    // Тот же состав presentation-состояния и тот же состав среза сущности:
    // подсистема, написанная под один режим, работает во втором без правок.
    expect(Object.keys(netView).sort()).toEqual(Object.keys(localView).sort());
    const localEntity = (localView.entities as Record<string, unknown>[])[0]!;
    const netEntity = (netView.entities as Record<string, unknown>[])[0]!;
    expect(Object.keys(netEntity).sort()).toEqual(Object.keys(localEntity).sort());
    // Зеркало карты пола приезжает в обоих режимах: террейн сцены есть у обеих.
    expect(localView.floorBits).not.toBeNull();
    expect(netView.floorBits).not.toBeNull();
    // Факты в обоих режимах приходят с номером тика (SHELL-4), хотя источники
    // разные: локальная шина тика и поток `Events` (NTR-15).
    expect(localProbe.events.every((event) => typeof event.tick === 'number')).toBe(true);
    expect(net.probe.events.every((event) => typeof event.tick === 'number')).toBe(true);
    expect(net.probe.events.length).toBeGreaterThan(0);
    expect(localProbe.events.length).toBeGreaterThan(0);
  });
});
