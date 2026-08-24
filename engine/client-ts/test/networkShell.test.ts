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
  clientCodec,
  contentPack,
  type MatchConfig,
  type ServerMessage,
  type Transport,
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
  /**
   * Возврат владельца слота в идущий матч (NTR-17): НОВЫЙ клиент и новый канал
   * в ТУ ЖЕ оболочку. Таймер снимается сразу — шаги делает тест.
   */
  rejoin(): MatchClient;
}

function networkRig(
  options: { snapshotRate?: number; wrapTransport?: (inner: Transport) => Transport } = {},
): NetworkRig {
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

  const wrap = options.wrapTransport ?? ((transport: Transport): Transport => transport);
  /** Канал ТЕКУЩЕГО подключения: возврат в матч рвёт его и открывает новый. */
  let link = wrap(hub.connect());
  const shell = new NetworkShell({
    mode: 'network',
    port: workerPort,
    client,
    transport: link,
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
    rejoin: () => {
      // Канал рвётся так же, как его рвёт сеть: сервер отвязывает соединение от
      // слота, но слот остаётся за игроком (NTR-6).
      link.close('обрыв канала');
      const back = new MatchClient({
        playerId: PLAYER_ID,
        version: config.version,
        content: pack,
      });
      link = wrap(hub.connect());
      shell.reattach(back, link);
      shell.stop();
      return back;
    },
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

/** Номера тиков доставленных фактов сцены, по возрастанию. */
function pulseTicks(rig: NetworkRig): number[] {
  return rig.probe.events
    .filter((event) => event.type === PULSE_EVENT)
    .map((event) => event.tick!)
    .sort((left, right) => left - right);
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

    const ticks = pulseTicks(rig);
    expect(ticks.length).toBeGreaterThan(4);
    expect(new Set(ticks).size).toBe(ticks.length);
    // Диапазон покрыт непрерывно: тик без снапшота фактами не обделён.
    for (let i = 1; i < ticks.length; i++) expect(ticks[i]! - ticks[i - 1]!).toBe(1);
    // И конвертов при этом вдвое меньше, чем тиков: состояние conflatable,
    // факты — нет (SHELL-4).
    expect(rig.client.metrics.snapshotsApplied).toBeLessThan(ticks.length);
  });

  it('хвост потока событий доезжает до main до остановки сессии (NTR-15, SHELL-4)', async () => {
    // Конец матча — это `Events` с хвостом и `End`, без финального снапшота:
    // сервер выпускает хвост, а не рассылает состояние. Факты этих тиков ждут
    // доставки, которой не будет, — и терялись бы в каждом матче.
    const rig = networkRig({ snapshotRate: TICK_RATE / 2 });
    await playTicks(rig, 9);
    const beforeEnd = pulseTicks(rig);
    const lastDelivered = beforeEnd.at(-1)!;
    const viewsBefore = rig.probe.views.length;

    rig.server.stop();
    rig.matchHost.flush();
    await settle();
    rig.shell.step();
    await settle();

    expect(rig.client.phase).toBe('closed');
    const afterEnd = pulseTicks(rig);
    // Хвост доехал: факты тиков после последней рассылки на main есть.
    expect(afterEnd.at(-1)!).toBeGreaterThan(lastDelivered);
    for (let i = 1; i < afterEnd.length; i++) expect(afterEnd[i]! - afterEnd[i - 1]!).toBe(1);
    // Доставка — повтор последнего состояния, а не новый тик: состояние
    // conflatable, факт — нет.
    expect(rig.probe.views.length).toBe(viewsBefore + 1);
    const tailView = rig.probe.views.at(-1) as { tick: number; freshEvents: boolean };
    const stateView = rig.probe.views.at(-2) as { tick: number };
    expect(tailView.tick).toBe(stateView.tick);
    // И факты хвоста проигрываемы: иначе «доехали» означало бы «доехали и молчат».
    expect(tailView.freshEvents).toBe(true);
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
    const delivered = rig.probe.views.at(-1) as {
      tick: number;
      snapAll: boolean;
      isReplay: boolean;
    };
    expect(delivered.tick).toBe(target);
    // Смена эпохи — разрыв непрерывности: состояние рисуется snap'ом (SHELL-7).
    // `isReplay` приезжает ТОЛЬКО из признака клиента (снапшот его не несёт), и
    // потому пиннит именно путь признака, а не смену режима мира рядом с ним.
    expect(delivered.isReplay).toBe(true);
    expect(delivered.snapAll).toBe(true);
    // Кольцо своих кадров (NET-9) в сетевой сборке есть, и видно это по величине,
    // которую только оно и даёт: сколько ввода игрока унесла перемотка (NTR-10).
    expect(rig.client.metrics.inputsStranded).toBeGreaterThan(0);
    expect(rig.systemRuns()).toBe(0);
  });
});

describe('возврат в матч тем же каналом главного потока (NTR-17, SHELL-5, SHELL-7)', () => {
  it('реаттач: второго handshake нет, первая доставка — snap, таблица видов сквозная', async () => {
    const rig = networkRig();
    await playTicks(rig, 6);
    const beforeReturn = rig.probe.views.length;
    expect(beforeReturn).toBeGreaterThan(0);
    expect(rig.posted.filter((type) => type === 'hello')).toHaveLength(1);

    // Канал рвётся, и владелец слота возвращается НОВЫМ клиентом (NTR-17,
    // design D5): курсоры, буфер интерполяции и оценка тика у него чистые.
    const returned = rig.rejoin();
    // Разрыв и новый `Hello` доезжают до сервера в порядке отправки (NTR-2).
    await settle();
    expect(rig.shell.client).toBe(returned);

    await playTicks(rig, 6);
    expect(returned.slot).toBe(0);
    expect(returned.metrics.snapshotsApplied).toBeGreaterThan(0);

    // Handshake главному потоку по-прежнему ОДИН (SHELL-5): для него сессия не
    // начиналась заново — режим, темп, террейн и словарь статов те же.
    expect(rig.posted.filter((type) => type === 'hello')).toHaveLength(1);

    // Первая доставка после возврата — snap'ом (NTR-17): между картиной до
    // разрыва и «сейчас» матча промежуточных положений не существовало.
    const after = rig.probe.views.slice(beforeReturn) as { snapAll: boolean }[];
    expect(after.length).toBeGreaterThan(0);
    expect(after[0]!.snapAll).toBe(true);
    expect(after.slice(1).some((view) => view.snapAll)).toBe(false);

    // Таблица видов сквозная: индексы конверта — числа, главный поток копит их
    // подряд, и продюсер, начавший нумерацию заново, назвал бы сущностям чужие
    // виды. Своя сущность в персональном снапшоте есть всегда (NET-15).
    const view = rig.remote.view!;
    expect([...view.entities.values()][0]!.kind).toBe('Hero');
  });
});

describe('неупорядоченный канал: факты новой эпохи против состояния старой (NTR-2, NTR-16)', () => {
  it('факты эпохи, обогнавшие её первый снапшот, ждут её состояния, а не проигрываются на картинке старой', async () => {
    // Канал матча нормативно не упорядочен (NTR-2): `Events` новой эпохи может
    // приехать раньше её первого снапшота, а снапшот старой — позже них обоих.
    // Тик пачки новой эпохи с тиками старой ветви несравним (NTR-16): уложить
    // его в `before` по номеру значило бы проиграть факты новой ветви на
    // картинке старой эпохи, до snap'а разрыва, и съесть их. Тест играет роль
    // канала: перехватывает байты и доставляет их в выбранном порядке.
    const codec = clientCodec();
    const held: Uint8Array[] = [];
    let gate = false;
    let deliver: ((bytes: Uint8Array) => void) | undefined;
    const rig = networkRig({
      wrapTransport: (inner) => ({
        send: (bytes) => { inner.send(bytes); },
        close: (reason) => { inner.close(reason); },
        get isClosed() { return inner.isClosed; },
        onMessage: (handler) => {
          deliver = handler;
          inner.onMessage((bytes) => {
            if (gate) held.push(bytes);
            else handler(bytes);
          });
        },
        onClose: (handler) => { inner.onClose(handler); },
      }),
    });
    // Выпускает из задержанного всё, что подходит под предикат, сохраняя порядок.
    const release = (want: (message: ServerMessage) => boolean): number => {
      let released = 0;
      for (let i = 0; i < held.length; ) {
        if (want(codec.decode(held[i]!))) {
          deliver!(held[i]!);
          held.splice(i, 1);
          released++;
        } else i++;
      }
      return released;
    };
    const stepShell = (): void => {
      rig.clock.ms += 1000 / TICK_RATE;
      rig.shell.step();
    };
    const pulseCount = (): number =>
      rig.probe.events.filter((event) => event.type === PULSE_EVENT).length;

    await playTicks(rig, 12);
    const oldBranchTick = rig.state.tick;

    // Дальше всё копится у «канала». Ещё один живой тик старой эпохи — его
    // снапшот «задержится в пути»; затем перемотка на сервере и два живых тика
    // новой эпохи по прежним номерам (NTR-16).
    gate = true;
    rig.matchHost.step();
    await settle();
    const target = 5;
    rig.server.pause();
    rig.server.beginRewind();
    rig.server.seekTo(target);
    rig.server.pause();
    rig.server.resume();
    rig.matchHost.flush();
    rig.matchHost.step();
    rig.matchHost.step();
    await settle();

    // Первыми доезжают `Events` новой эпохи — раньше любого её снапшота.
    expect(release((message) => message.type === 'Events' && message.epoch > 0)).toBeGreaterThan(0);
    stepShell();
    const pulsesBefore = pulseCount();

    // Следом — задержавшийся снапшот СТАРОЙ эпохи. Пачки новой эпохи обязаны
    // остаться в ожидании её собственного состояния, а не уйти в представление
    // фактами текущей: на картинке старой ветви их тики — чужие (NTR-16).
    expect(release((message) => message.type === 'Snapshot' && message.epoch === 0)).toBe(1);
    stepShell();
    expect(rig.state.tick).toBe(oldBranchTick + 1);
    expect(pulseCount()).toBe(pulsesBefore);

    // Состояние новой эпохи доехало — мир перескочил на её ветвь.
    release(() => true);
    stepShell();
    expect(rig.client.epoch).toBe(1);
    expect(rig.state.tick).toBe(target + 2);
    expect(rig.systemRuns()).toBe(0);
  });
});

describe('одна подсистема в обеих сборках оболочки (SHELL-8, REND-8)', () => {
  it('локальная и сетевая сборки дают подсистеме один контракт доставки', async () => {
    // Сетевая сборка.
    const net = networkRig();
    net.remote.sendInput({ x: STEP, y: 0 });
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
    // Ввод — тот же и в той же форме (SHELL-6): в локальном режиме он войдёт в
    // `InputFrame` тика, в сетевом уехал серверу и вернулся снапшотом.
    local.sendInput({ x: STEP, y: 0 });
    for (let i = 0; i < 8; i++) shell.stepTick();

    // Режим главному потоку известен и различается; всё остальное — нет.
    expect(local.mode).toBe('local');
    expect(net.remote.mode).toBe('network');

    expect(localProbe.views.length).toBeGreaterThan(0);
    expect(net.probe.views.length).toBeGreaterThan(0);
    const localView = localProbe.views.at(-1) as Record<string, unknown>;
    const netView = net.probe.views.at(-1) as Record<string, unknown>;
    const localEntity = (localView.entities as Record<string, unknown>[])[0]!;
    const netEntity = (netView.entities as Record<string, unknown>[])[0]!;
    // Подсистема получила в обеих сборках одно и то же ПО СУЩЕСТВУ, а не один
    // набор ключей: визуальный тип из словаря kind'ов, доехавшего каналом
    // (SHELL-5), режим мира, зеркало карты пола длиной сетки из handshake и
    // производный признак движения (REND-4) — по нему видно, что ввод прошёл
    // весь путь в обоих режимах: тиком и кругом до сервера.
    expect(netEntity.kind).toBe('Hero');
    expect(localEntity.kind).toBe('Hero');
    expect(netView.mode).toBe(localView.mode);
    expect(netView.mode).toBe('Running');
    expect([...(netView.floorBits as number[])]).toEqual([...(localView.floorBits as number[])]);
    expect(netEntity.moving).toBe(true);
    expect(localEntity.moving).toBe(true);
    // Факты в обоих режимах приходят с номером тика (SHELL-4), хотя источники
    // разные: локальная шина тика и поток `Events` (NTR-15).
    expect(localProbe.events.every((event) => typeof event.tick === 'number')).toBe(true);
    expect(net.probe.events.every((event) => typeof event.tick === 'number')).toBe(true);
    expect(net.probe.events.length).toBeGreaterThan(0);
    expect(localProbe.events.length).toBeGreaterThan(0);
  });
});
