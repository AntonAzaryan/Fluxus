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
import { RingHistory, createInputLog, createRewindController, tick } from '@game-mvp/core';
import { ViewBuffer, type RenderSubsystem, type TickView } from '@game-mvp/render';
import { RemoteHost, WorkerShell, shellPort, type TickEnvelope } from '../src/index.js';
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

/** Подсистема-зонд: копит снимки syncTick и все события с freshEvents. */
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
    expect(frozenRemote.view!.tick).toBe(6);
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
        const envelope = message as TickEnvelope;
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- baseline
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
