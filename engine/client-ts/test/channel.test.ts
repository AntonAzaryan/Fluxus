/**
 * Канал оболочки целиком (SHELL-1..7): WorkerShell + RemoteHost.
 *
 * Интеграционный тест гоняет настоящий Node MessageChannel (structured clone
 * и transfer как в браузере) и сравнивает воркер-сборку с однопоточной парой
 * Extractor→ViewBuffer на второй идентичной симуляции (детерминизм ядра
 * делает их сравнимыми побитово). Conflation и ноль аллокаций проверяются на
 * синхронных портах, где доставкой управляет тест.
 */
import { describe, expect, it } from 'vitest';
import {
  RingHistory,
  createInputLog,
  createRewindController,
  fixed,
  query,
  tick,
  world as coreWorld,
} from '@fluxus/core';
import { ViewBuffer, type Extractor, type RenderSubsystem, type TickView } from '@fluxus/render';
import {
  RemoteHost,
  ShellSender,
  WorkerShell,
  readTick,
  shellPort,
  type ShellPort,
  type TickEnvelope,
  type WorkerToMain,
} from '../src/index.js';
import {
  PLAYER_ID,
  STEP,
  TICK_SECONDS,
  dummyContext,
  makeExtractor,
  makeRig,
  queuedPortPair,
  snapshotView,
  syncPortPair,
} from './fixtures.js';

/** Доставка Node MessageChannel асинхронная: пара макротасков на раунд. */
async function settle(rounds = 4): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Подсистема-зонд: копит снимки syncTick, все события с freshEvents и число
 * вытесненных событий КАЖДОЙ доставки (SHELL-4) — счётчик хоста суммарен, а
 * наблюдаемость требуется у доставки.
 */
function probe(): {
  subsystem: RenderSubsystem;
  views: unknown[];
  events: { tick: number | undefined; type: string }[];
  expired: number[];
} {
  const views: unknown[] = [];
  const events: { tick: number | undefined; type: string }[] = [];
  const expired: number[] = [];
  return {
    views,
    events,
    expired,
    subsystem: {
      name: 'probe',
      init: () => {},
      syncTick(view: TickView) {
        views.push(snapshotView(view));
        expired.push(view.expiredEvents);
        if (view.freshEvents) {
          for (const event of view.events) events.push({ tick: event.tick, type: event.type });
        }
      },
      updateFrame: () => {},
    },
  };
}

describe('воркер-сборка против однопоточной (SHELL-2, задача 4.1)', () => {
  it('одинаковая последовательность TickView, события ровно один раз', async () => {
    // Две идентичные симуляции: детерминизм делает прогоны сравнимыми.
    const workerRig = makeRig({ castOnTicks: [3], breakFloorOnTick: 5 });
    const directRig = makeRig({ castOnTicks: [3], breakFloorOnTick: 5 });

    const channel = new MessageChannel();
    const shell = new WorkerShell({
      mode: 'local',
      port: shellPort(channel.port1),
      sim: workerRig.sim,
      state: workerRig.state,
      tickSeconds: TICK_SECONDS,
      extractor: makeExtractor(workerRig),
      playerId: PLAYER_ID,
      helloExtra: { hero: 42 },
      clock: () => 0,
    });

    let helloExtra: unknown = null;
    const remoteProbe = probe();
    const remote = new RemoteHost(dummyContext(), {
      clock: () => 0,
      onReady: (hello) => {
        helloExtra = hello.extra;
        remote.register(remoteProbe.subsystem);
      },
    }).connect(shellPort(channel.port2));

    // Однопоточная пара на той же сцене.
    const directExtractor = makeExtractor(directRig);
    const directBuffer = new ViewBuffer({
      tickSeconds: TICK_SECONDS,
      floorBits: new Uint8Array(directRig.scene.terrain!.grid.floor),
      clock: () => 0,
    });
    const directViews: unknown[] = [];
    const directEvents: { tick: number | undefined; type: string }[] = [];

    shell.start(); // handshake; тикер не успеет — тики шагаем вручную
    shell.stop();
    await settle();
    expect(helloExtra).toEqual({ hero: 42 });
    // Режим приезжает в handshake и до первой доставки состояния (SHELL-8):
    // `WorkerShell` есть локальный режим, и объявляет он это сам.
    expect(remote.mode).toBe('local');
    expect(remote.terrain).not.toBeNull();
    expect(remote.terrain!.width).toBe(2);

    for (let step = 1; step <= 8; step++) {
      remote.sendInput({ x: STEP, y: 0 });
      await settle();
      shell.stepTick();
      await settle(); // конверт доехал, буфер вернулся — каждый тик доставлен

      const result = tick(directRig.sim, directRig.state, [
        {
          tick: directRig.state.tick + 1,
          playerId: PLAYER_ID,
          seq: step,
          move: { x: STEP, y: 0 },
          aimDir: 0,
          buttons: 0,
        },
      ]);
      directBuffer.apply(directExtractor.extract(result));
      directViews.push(snapshotView(directBuffer.view));
      if (directBuffer.view.freshEvents) {
        for (const event of directBuffer.view.events) {
          directEvents.push({ tick: event.tick, type: event.type });
        }
      }
    }

    expect(remoteProbe.views).toEqual(directViews);
    expect(remoteProbe.events).toEqual(directEvents);
    // Каст тика 3 доставлен ровно один раз.
    expect(remoteProbe.events.filter((e) => e.type === 'CastFireball')).toHaveLength(1);

    channel.port1.close();
    channel.port2.close();
  });
});

describe('conflation: состояние последнее, события все (SHELL-4, задача 4.2)', () => {
  it('задушенный main получает последний тик и полный лог событий', () => {
    const rig = makeRig({ castOnTicks: [2, 4], breakFloorOnTick: 3 });
    const ports = queuedPortPair();
    const shell = new WorkerShell({
      mode: 'local',
      port: ports.worker,
      sim: rig.sim,
      state: rig.state,
      tickSeconds: TICK_SECONDS,
      extractor: makeExtractor(rig),
      playerId: PLAYER_ID,
      sender: { poolSize: 1 },
      clock: () => 0,
    });
    const remoteProbe = probe();
    const remote = new RemoteHost(dummyContext(), {
      clock: () => 0,
      onReady: () => remote.register(remoteProbe.subsystem),
    }).connect(ports.main);
    shell.start();
    shell.stop();

    // Main заморожен: 5 тиков без дренажа. Пул из 1 буфера: уйдёт только тик 1.
    for (let step = 0; step < 5; step++) shell.stepTick();
    ports.drain(); // hello + конверт тика 1; ack возвращает буфер → уходит тик 5
    ports.drain();

    const view = remote.view!;
    expect(view.tick).toBe(5);
    // Промежуточные состояния вытеснены: доставлены только тики 1 и 5.
    expect(remoteProbe.views).toHaveLength(2);
    // События тиков 2..5 доехали все, с номерами тиков (SHELL-4).
    expect(remoteProbe.events.map((e) => e.tick)).toEqual([2, 4]);
    // Дельта пола пережила conflation: клетка 0 выбита в тике 3.
    expect(view.floorBits![0]).toBe(0);
    expect(remote.expiredEvents).toBe(0);
    // Ничего не вытеснено — и доставка говорит об этом числом (SHELL-4):
    // «событий не было» не должно быть неотличимо от «события не доехали».
    expect(remoteProbe.expired).toEqual([0, 0]);
  });

  it('лимит глубины аккумулятора: просроченные события считаются, не доставляются', () => {
    const rig = makeRig({ castOnTicks: [1] });
    const ports = queuedPortPair();
    const shell = new WorkerShell({
      mode: 'local',
      port: ports.worker,
      sim: rig.sim,
      state: rig.state,
      tickSeconds: TICK_SECONDS,
      extractor: makeExtractor(rig),
      playerId: PLAYER_ID,
      sender: { poolSize: 1, maxEventAgeTicks: 2 },
      clock: () => 0,
    });
    const remoteProbe = probe();
    const remote = new RemoteHost(dummyContext(), {
      clock: () => 0,
      onReady: () => remote.register(remoteProbe.subsystem),
    }).connect(ports.main);
    shell.start();
    shell.stop();

    shell.stepTick(); // тик 1: каст; конверт уходит немедленно (пул свободен)
    // Доставку задерживаем; каст тика 1 уже в полёте, дальше — тишина 6 тиков.
    for (let step = 0; step < 6; step++) shell.stepTick();
    ports.drain();
    ports.drain();

    expect(remoteProbe.events.map((e) => e.tick)).toEqual([1]);
    expect(remote.view!.tick).toBe(7);
    expect(remote.expiredEvents).toBe(0); // событие успело до заморозки

    // Теперь каст попадает в заморозку и протухает: не доставлен, но посчитан.
    const frozen = makeRig({ castOnTicks: [1] });
    const frozenPorts = queuedPortPair();
    const frozenShell = new WorkerShell({
      mode: 'local',
      port: frozenPorts.worker,
      sim: frozen.sim,
      state: frozen.state,
      tickSeconds: TICK_SECONDS,
      extractor: makeExtractor(frozen),
      playerId: PLAYER_ID,
      sender: { poolSize: 0, maxEventAgeTicks: 2 },
      clock: () => 0,
    });
    const frozenProbe = probe();
    const frozenRemote = new RemoteHost(dummyContext(), {
      clock: () => 0,
      onReady: () => frozenRemote.register(frozenProbe.subsystem),
    }).connect(frozenPorts.main);
    frozenShell.start();
    frozenShell.stop();

    for (let step = 0; step < 6; step++) frozenShell.stepTick();
    // Буфер появляется только теперь: как будто main вернул его после разморозки.
    // eslint-disable-next-line @typescript-eslint/dot-notation -- намеренный доступ к private-полю в тесте
    frozenShell['sender'].ack(new ArrayBuffer(16 * 1024));
    frozenPorts.drain();

    expect(frozenProbe.events).toHaveLength(0);
    expect(frozenRemote.expiredEvents).toBe(1);
    // То же число доезжает ДО ПОТРЕБИТЕЛЯ той же доставкой (SHELL-4): виджет
    // вправе показать разрыв ровно там, где события пропали, — а по суммарному
    // счётчику хоста доставку не назовёшь.
    expect(frozenProbe.expired).toEqual([1]);
    expect(frozenRemote.view!.expiredEvents).toBe(1);
    expect(frozenRemote.view!.tick).toBe(6);
  });
});

describe('окно доставки через перемотку: реплеевые дубликаты не доставляются (SHELL-4)', () => {
  it('конверт несёт только новые события; каст до перемотки не проигрывается второй раз', () => {
    const rig = makeRig({ castOnTicks: [2, 6] });
    const ports = queuedPortPair();
    const history = new RingHistory({ interval: 1, capacity: 16 });
    const rewind = createRewindController(rig.sim, rig.state, {
      history,
      inputs: createInputLog(),
    });
    const shell = new WorkerShell({
      port: ports.worker,
      mode: 'local',
      sim: rig.sim,
      state: rig.state,
      tickSeconds: TICK_SECONDS,
      extractor: makeExtractor(rig),
      playerId: PLAYER_ID,
      rewind,
      sender: { poolSize: 1 },
      observers: [
        {
          name: 'history',
          onTick: (result) => {
            if (result.mode === 'Running' && !result.isReplay) history.record(result.state);
          },
        },
      ],
      clock: () => 0,
    });
    const remoteProbe = probe();
    const remote = new RemoteHost(dummyContext(), {
      clock: () => 0,
      onReady: () => remote.register(remoteProbe.subsystem),
    }).connect(ports.main);
    shell.start();
    shell.stop();

    // Честные тики 1..3, каст в тике 2 — всё доставлено до перемотки.
    for (let step = 0; step < 3; step++) shell.stepTick();
    ports.drain();
    ports.drain();
    expect(remoteProbe.events).toEqual([{ tick: 2, type: 'CastFireball' }]);

    // Main замирает: конверт замороженного тика съедает единственный буфер,
    // дальше окно копится. Перемотка на тик 2 восстанавливает его снапшот,
    // шина которого несёт уже доставленный каст (REW-10); замороженный тик в
    // Rewinding отдаёт его extractor'у нечестным (freshEvents=false). После
    // возобновления честные тики 3..6 приносят новый каст в тике 6.
    remote.control('pause');
    shell.stepTick();
    remote.control('beginRewind');
    remote.control('seekTo', 2);
    shell.stepTick();
    remote.control('pause');
    remote.control('resume');
    for (let step = 0; step < 4; step++) shell.stepTick();
    ports.drain();
    ports.drain();

    // Конверт окна не смешал реплеевый дубликат с новым событием: каст тика 2
    // обработан ровно один раз, тика 6 — доставлен (SHELL-4, match-hud HUD-5).
    expect(remoteProbe.events).toEqual([
      { tick: 2, type: 'CastFireball' },
      { tick: 6, type: 'CastFireball' },
    ]);
    expect(remote.view!.tick).toBe(6);
    expect(remote.view!.mode).toBe('Running');
  });
});

describe('факты разрыва не уезжают проигрываемыми (SHELL-4, match-hud HUD-5)', () => {
  it('обычная доставка после разрыва не воскрешает признак «эти факты можно проигрывать»', () => {
    const rig = makeRig();
    const posted: TickEnvelope[] = [];
    const port: ShellPort = {
      post(message) {
        posted.push(message as TickEnvelope);
      },
      onMessage() {
        // Обратного канала этому стенду не нужно: он проверяет отправителя.
      },
    };
    // Свободного буфера нет вовсе — ровно то состояние, в котором доставка не
    // уходит, а накопитель копит: узкое окно живёт здесь.
    const sender = new ShellSender(port, { poolSize: 0 });
    const extractor = makeExtractor(rig);

    // Сетевая сторона кладёт факты, попавшие на разрыв непрерывности (SHELL-7):
    // играть их нельзя — картинка через разрыв перескочила.
    sender.pushEvents([{ type: 'CastFireball', tick: 2, data: {} }], false);
    // Обычный честный тик следом: прежде его признак ИЛИ-ился с накопленным и
    // делал проигрываемой всю пачку, включая факты по ту сторону разрыва.
    sender.push(
      extractor.extract(
        tick(rig.sim, rig.state, [
          {
            tick: rig.state.tick + 1,
            playerId: PLAYER_ID,
            seq: 1,
            move: { x: 0, y: 0 },
            aimDir: 0,
            buttons: 0,
          },
        ]),
      ),
    );
    expect(posted).toHaveLength(0); // буфера нет — доставка ждёт

    // Main вернул буфер: копившееся уезжает одним конвертом.
    sender.ack(new ArrayBuffer(64 * 1024));
    expect(posted).toHaveLength(1);
    const envelope = posted[0]!;
    const delivered = readTick(envelope.buffer, envelope.events, []);
    expect(delivered.events.map((event) => event.type)).toEqual(['CastFireball']);
    // «Нельзя» победило: доигрывать сквозь разрыв запрещено (HUD-5), а флаг у
    // конверта один на всю пачку.
    expect(delivered.freshEvents).toBe(false);
  });

  it('без разрыва признак остаётся честным: обычные факты проигрываются', () => {
    const rig = makeRig();
    const posted: TickEnvelope[] = [];
    const port: ShellPort = {
      post(message) {
        posted.push(message as TickEnvelope);
      },
      onMessage() {
        // См. выше: стенд проверяет отправителя.
      },
    };
    const sender = new ShellSender(port, { poolSize: 1 });
    const extractor = makeExtractor(rig);

    sender.pushEvents([{ type: 'CastFireball', tick: 2, data: {} }], true);
    sender.push(
      extractor.extract(
        tick(rig.sim, rig.state, [
          {
            tick: rig.state.tick + 1,
            playerId: PLAYER_ID,
            seq: 1,
            move: { x: 0, y: 0 },
            aimDir: 0,
            buttons: 0,
          },
        ]),
      ),
    );

    expect(posted).toHaveLength(1);
    const delivered = readTick(posted[0]!.buffer, posted[0]!.events, []);
    expect(delivered.events.map((event) => event.type)).toEqual(['CastFireball']);
    expect(delivered.freshEvents).toBe(true);
  });
});

describe('признаки разрыва копятся через окно конфляции (SHELL-4)', () => {
  /** Стенд отправителя без пула: доставка не уходит, пока тест не вернёт буфер. */
  function heldSender(): {
    sender: ShellSender;
    posted: TickEnvelope[];
    extract: (options?: { replay?: boolean }) => ReturnType<Extractor['extract']>;
  } {
    const rig = makeRig();
    const posted: TickEnvelope[] = [];
    const port: ShellPort = {
      post(message) {
        posted.push(message as TickEnvelope);
      },
      onMessage() {
        // Обратного канала стенду не нужно: он проверяет отправителя.
      },
    };
    const sender = new ShellSender(port, { poolSize: 0 });
    const extractor = makeExtractor(rig);
    let seq = 0;
    return {
      sender,
      posted,
      extract: (options = {}) => {
        seq += 1;
        const result = tick(rig.sim, rig.state, [
          {
            tick: rig.state.tick + 1,
            playerId: PLAYER_ID,
            seq,
            move: { x: 0, y: 0 },
            aimDir: 0,
            buttons: 0,
          },
        ]);
        // Реплеевый проход (REW-4): экстрактор взводит по нему и разрыв, и
        // смену ветви (SHELL-7) — ровно те признаки, что обязаны копиться.
        return extractor.extract(options.replay === true ? { ...result, isReplay: true } : result);
      },
    };
  }

  it('разрыв тика, съеденного конфляцией, уезжает с ближайшим конвертом', () => {
    const stand = heldSender();

    // Обычный тик, затем реплеевый (разрыв + смена ветви), затем снова обычный.
    // Уехать успеет только последний — состояние conflatable (SHELL-4).
    stand.sender.push(stand.extract());
    const replayed = stand.extract({ replay: true });
    expect(replayed.snapAll).toBe(true);
    expect(replayed.branchChanged).toBe(true);
    stand.sender.push(replayed);
    // Состояние реплеевого тика вытеснено следующим — оно conflatable; признаки
    // разрыва вытеснению не подлежат.
    stand.sender.push(stand.extract());
    expect(stand.posted).toHaveLength(0);

    stand.sender.ack(new ArrayBuffer(64 * 1024));
    expect(stand.posted).toHaveLength(1);
    const delivered = readTick(stand.posted[0]!.buffer, stand.posted[0]!.events, []);
    // Состояние — последнего тика, у которого разрыва нет вовсе; признаки же
    // накоплены ИЛИ-ом по всему окну: потеряй их приёмник — он проинтерполировал
    // бы сквозь стёртую ветвь истории.
    expect(delivered.snapAll).toBe(true);
    expect(delivered.branchChanged).toBe(true);
  });

  it('окно без разрыва признаков не выдумывает', () => {
    const stand = heldSender();
    stand.sender.push(stand.extract());
    stand.sender.push(stand.extract());
    stand.sender.ack(new ArrayBuffer(64 * 1024));

    const delivered = readTick(stand.posted[0]!.buffer, stand.posted[0]!.events, []);
    expect(delivered.snapAll).toBe(false);
    expect(delivered.branchChanged).toBe(false);
  });

  it('накопленное гаснет отправкой: следующее окно начинается чистым', () => {
    const stand = heldSender();
    stand.sender.push(stand.extract({ replay: true }));
    stand.sender.ack(new ArrayBuffer(64 * 1024));
    expect(readTick(stand.posted[0]!.buffer, stand.posted[0]!.events, []).snapAll).toBe(true);

    stand.sender.push(stand.extract());
    stand.sender.ack(new ArrayBuffer(64 * 1024));
    expect(stand.posted).toHaveLength(2);
    expect(readTick(stand.posted[1]!.buffer, stand.posted[1]!.events, []).snapAll).toBe(false);
  });
});

describe('свежий подписчик получает полный кадр (SHELL-3)', () => {
  it('оболочка, переиспользующая экстрактор, стирает зеркало на новом подписчике', () => {
    const rig = makeRig();
    const extractor = makeExtractor(rig);
    const step = (): ReturnType<Extractor['extract']> =>
      extractor.extract(
        tick(rig.sim, rig.state, [
          {
            tick: rig.state.tick + 1,
            playerId: PLAYER_ID,
            seq: rig.state.tick + 1,
            move: { x: 0, y: 0 },
            aimDir: 0,
            buttons: 0,
          },
        ]),
      );

    // Первый подписчик: полный кадр, затем частичные — зеркало живёт.
    const first = step();
    expect(first.full).toBe(true);
    const rows = first.count;
    expect(rows).toBeGreaterThan(0);
    extractor.markDelivered();
    const partial = step();
    expect(partial.full).toBe(false);
    extractor.markDelivered();

    // Пришёл ВТОРОЙ подписчик: оболочка, живущая с одним экстрактором,
    // объявляет зеркало недействительным — приёмнику не известно ничего
    // (SHELL-5, handshake), и частичный кадр он применить не смог бы.
    extractor.forgetDelivered();
    const fresh = step();
    expect(fresh.full).toBe(true);
    expect(fresh.count).toBe(rows);
    // Полный кадр авторитетен, и списка исчезнувших в нём не бывает.
    expect(fresh.removedCount).toBe(0);
  });
});

describe('буфер возвращается воркеру всегда (SHELL-3)', () => {
  it('конверт тика, приехавший до приветственного сообщения, не съедает буфер пула', () => {
    const posted: { message: unknown; transfer: ArrayBuffer[] | undefined }[] = [];
    let deliver: ((message: unknown) => void) | null = null;
    const port: ShellPort = {
      post(message, transfer) {
        posted.push({ message, transfer });
      },
      onMessage(handler) {
        deliver = handler;
      },
    };
    new RemoteHost(dummyContext(), { clock: () => 0 }).connect(port);

    // Порядок сообщений штатной сборки этого не допускает — потому и защита; но
    // защита в одну сторону навсегда укорачивала бы пул канала (SHELL-3).
    const buffer = new ArrayBuffer(1024);
    const envelope: TickEnvelope = { t: 'tick', buffer, events: [], kinds: [], expiredEvents: 0 };
    deliver!(envelope);

    expect(posted).toHaveLength(1);
    expect(posted[0]!.message).toEqual({ t: 'ret', buffer });
    // Тем же transfer'ом, каким буфер приехал: круг «воркер → main → воркер»
    // замыкается и на этом выходе.
    expect(posted[0]!.transfer).toEqual([buffer]);
  });
});

describe('ноль аллокаций канала в устоявшемся режиме (SHELL-3, задача 2.3)', () => {
  it('буферы циркулируют по кругу; рост сцены перевыделяет разово', () => {
    const rig = makeRig();
    const [workerPort, mainPort] = syncPortPair();
    const seen = new Set<ArrayBuffer>();
    // Подслушиваем конверты до RemoteHost: какие ArrayBuffer ходят по кругу.
    const spyPort: typeof workerPort = {
      post(message, transfer) {
        // Приводится к ВСЕМУ, что шлёт воркер-сторона, а не сразу к конверту
        // тика: по каналу идут ещё handshake и конверт паузы, и проверка вида
        // здесь настоящая, а не формальность (SHELL-4, SHELL-5).
        const envelope = message as WorkerToMain;
        if (envelope.t === 'tick') seen.add(envelope.buffer);
        workerPort.post(message, transfer);
      },
      onMessage(handler) {
        workerPort.onMessage(handler);
      },
    };
    const shell = new WorkerShell({
      mode: 'local',
      port: spyPort,
      sim: rig.sim,
      state: rig.state,
      tickSeconds: TICK_SECONDS,
      extractor: makeExtractor(rig),
      playerId: PLAYER_ID,
      clock: () => 0,
    });
    const remote = new RemoteHost(dummyContext(), { clock: () => 0 }).connect(mainPort);
    shell.start();
    shell.stop();

    for (let step = 0; step < 100; step++) shell.stepTick();
    expect(remote.view!.tick).toBe(100);
    // Синхронный ack: хватает одного буфера, и он один и тот же все 100 тиков.
    expect(seen.size).toBe(1);
  });
});

describe('обратный канал: ввод и управление (SHELL-6, задача 3.5)', () => {
  it('нажатие между тиками входит в InputFrame ближайшего тика', () => {
    const rig = makeRig({ castOnTicks: [] });
    const [workerPort, mainPort] = syncPortPair();
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
    const remote = new RemoteHost(dummyContext(), { clock: () => 0 }).connect(mainPort);
    shell.start();
    shell.stop();

    shell.stepTick();
    const still = remote.view!.entities.values().next().value!;
    const x0 = still.currX;

    remote.sendInput({ x: STEP, y: 0 });
    shell.stepTick();
    const moved = remote.view!.entities.values().next().value!;
    expect(moved.currX).toBeGreaterThan(x0);
    expect(moved.moving).toBe(true);
  });

  it('точка прицела и новые биты доезжают до InputFrame тем же каналом (SHELL-6, TICK-2)', () => {
    const rig = makeRig();
    const [workerPort, mainPort] = syncPortPair();
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
    const remote = new RemoteHost(dummyContext(), { clock: () => 0 }).connect(mainPort);
    shell.start();
    shell.stop();

    const hero = query(rig.state.world, { all: ['Player'] })[0]!;
    // Бит подтверждения — обычный бит маски (INP-4): собственного поля канал
    // под него не получает, и формат сообщения от него не меняется.
    const confirm = 1 << 8;
    remote.sendInput({ x: 0, y: 0 }, 0, confirm, { x: fixed.fromFloat(3), y: fixed.fromFloat(-4) });
    shell.stepTick();

    expect(coreWorld.getField(rig.state.world, hero, 'Input', 'buttons')).toBe(confirm);
    expect(coreWorld.getField(rig.state.world, hero, 'Input', 'targetX')).toBe(fixed.fromFloat(3));
    expect(coreWorld.getField(rig.state.world, hero, 'Input', 'targetY')).toBe(fixed.fromFloat(-4));

    // Точка — состояние: следующий тик без неё её не гасит (TICK-2).
    remote.sendInput({ x: 0, y: 0 }, 0, 0, null);
    shell.stepTick();
    expect(coreWorld.getField(rig.state.world, hero, 'Input', 'targetX')).toBe(fixed.fromFloat(3));
  });

  it('pause/resume доезжают до машины состояний мира', () => {
    const rig = makeRig();
    const [workerPort, mainPort] = syncPortPair();
    const history = new RingHistory({ interval: 1, capacity: 8 });
    const rewind = createRewindController(rig.sim, rig.state, {
      history,
      inputs: createInputLog(),
    });
    const shell = new WorkerShell({
      mode: 'local',
      port: workerPort,
      sim: rig.sim,
      state: rig.state,
      tickSeconds: TICK_SECONDS,
      extractor: makeExtractor(rig),
      playerId: PLAYER_ID,
      rewind,
      clock: () => 0,
    });
    const remote = new RemoteHost(dummyContext(), { clock: () => 0 }).connect(mainPort);
    shell.start();
    shell.stop();

    shell.stepTick();
    expect(remote.view!.mode).toBe('Running');

    remote.control('pause');
    shell.stepTick();
    expect(remote.view!.mode).toBe('Paused');
    const pausedTick = remote.view!.tick;

    shell.stepTick();
    expect(remote.view!.tick).toBe(pausedTick); // мир заморожен

    remote.control('resume');
    shell.stepTick();
    expect(remote.view!.mode).toBe('Running');
    expect(remote.view!.tick).toBe(pausedTick + 1);
  });
});
