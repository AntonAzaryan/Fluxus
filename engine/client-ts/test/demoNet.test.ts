/**
 * Дефолтная сборка демо (design D1) на внутрипроцессных транспортах: сессия
 * `local` — `MatchServer` сборки-вкладки, человек через пару портов, бот в
 * оставшемся слоте (BOT-7), `NetworkShell` у клиента и `RemoteHost` у главного
 * потока.
 *
 * Собирается ровно теми же модулями, что и вкладка (`demo/localSession.ts`,
 * `demo/netClient.ts`, `demo/match.ts`): отдельной тестовой реализации сервера
 * или клиента здесь нет и быть не должно (NTR-12), подменены только среда
 * исполнения бота (тот же `startBotWorker`, но в этом же процессе) и
 * расписание — матч двигает тест, а не таймеры.
 *
 * Порты настоящие, из `node:worker_threads`: тот же структурный минимум, что у
 * браузерного `MessagePort` (SHELL-3), та же асинхронная доставка с
 * копированием байтов (NTR-2).
 */
import { MessageChannel } from 'node:worker_threads';
import { afterEach, describe, expect, it } from 'vitest';
import { fixed, type Serializer } from '@game-mvp/core';
import {
  isBotWorkerInit,
  parseBotProfile,
  startBotWorker,
  type BotHost,
  type WorkerLike,
} from '@game-mvp/bot';
import type { RenderSubsystem, TickView } from '@game-mvp/render';
import { jsonSerializer } from '@game-mvp/net';
import { RemoteHost, type ShellPort } from '../src/index.js';
import { portTransport } from '../src/portTransport.js';
import { shellPort } from '../src/protocol.js';
import { DEMO_PLAYERS, demoMatchConfig } from '../demo/match.js';
import { openLocalSession, type DemoLocalSession } from '../demo/localSession.js';
import { bufferedShellPort, joinDemoMatch, type DemoJoinResult } from '../demo/netClient.js';
import { demoHudComposition } from '../demo/hud.js';
import { demoMode, localModeUrl, serverModeUrl, slotCandidates } from '../demo/mode.js';
import { dummyContext, syncPortPair } from './fixtures.js';
import botProfileJson from '../../../content/bots/normal.json';

/** Заметное движение в Q16.16: его видно и в каноническом логе, и в снапшоте. */
const STEP = fixed.fromFloat(0.5);

const channels: MessageChannel[] = [];
const sessions: DemoLocalSession[] = [];
let bots: BotHost | null = null;

afterEach(async () => {
  bots?.dispose();
  bots = null;
  for (const session of sessions) await session.dispose();
  sessions.length = 0;
  // Порты держат событийный цикл: незакрытые концы подвесили бы прогон.
  for (const channel of channels) {
    channel.port1.close();
    channel.port2.close();
  }
  channels.length = 0;
});

/** Доставка через порты асинхронна — шаг цикла заканчивается тут. */
async function flush(rounds = 3): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

function makeChannel(): MessageChannel {
  const channel = new MessageChannel();
  channels.push(channel);
  return channel;
}

/**
 * Поток ботов этого прогона: тот же `startBotWorker`, что исполнил бы entry
 * воркера, — но в этом же процессе и без собственного таймера, чтобы матч
 * двигал тест.
 */
function botThread(): WorkerLike {
  return {
    postMessage(message: unknown): void {
      if (isBotWorkerInit(message)) bots = startBotWorker(message, { autoRun: false });
    },
  };
}

function session(
  reserved: readonly string[],
  serializer?: Serializer,
): DemoLocalSession {
  const opened = openLocalSession({
    config: demoMatchConfig(),
    reserved,
    ...(serializer !== undefined ? { serializer } : {}),
    bots: {
      worker: botThread(),
      channel: () => makeChannel(),
      brain: 'classic',
      profile: parseBotProfile(botProfileJson, 'профиль бота теста'),
    },
  });
  sessions.push(opened);
  return opened;
}

/** Канал участника: серверный конец ушёл матчу, дальний — клиенту (NTR-2). */
function participantPort(opened: DemoLocalSession): ShellPort {
  return shellPort(opened.connect(makeChannel()));
}

interface Probe {
  readonly subsystem: RenderSubsystem;
  readonly views: TickView[];
}

/** Подсистема-зонд: доставленное presentation-состояние и ничего больше (REND-8). */
function probe(): Probe {
  const views: TickView[] = [];
  return {
    views,
    subsystem: {
      name: 'probe',
      init: () => {},
      syncTick: (view) => views.push(view),
      updateFrame: () => {},
    },
  };
}

interface Rig {
  readonly joined: DemoJoinResult;
  readonly remote: RemoteHost;
  readonly probe: Probe;
  /** Всё, что воркер отправил главному потоку: порядок и состав handshake. */
  readonly posted: unknown[];
}

/** Вход человека в поднятый матч тем же путём, каким входит вкладка. */
async function join(
  opened: DemoLocalSession,
  candidates: readonly string[],
  clock: { ms: number },
  serializer?: Serializer,
): Promise<Rig> {
  const [rawWorkerPort, mainPort] = syncPortPair();
  const posted: unknown[] = [];
  const workerPort: ShellPort = {
    post(message, transfer) {
      posted.push(message);
      rawWorkerPort.post(message, transfer);
    },
    onMessage(handler) {
      rawWorkerPort.onMessage(handler);
    },
  };
  const shellProbe = probe();
  const remote: RemoteHost = new RemoteHost(dummyContext(), {
    clock: () => clock.ms,
    onReady: () => remote.register(shellProbe.subsystem),
  }).connect(mainPort);
  const joined = await joinDemoMatch({
    port: workerPort,
    connect: () => Promise.resolve(portTransport(participantPort(opened))),
    candidates,
    clock: () => clock.ms,
    settle: () => flush(1),
    timeoutMs: 2000,
    ...(serializer !== undefined ? { serializer } : {}),
  });
  return { joined, remote, probe: shellProbe, posted };
}

/** Конверты handshake, доехавшие до главного потока (SHELL-5). */
function hellos(rig: Rig): { extra?: { hero: number; playerId: string; slot: number } }[] {
  return rig.posted.filter(
    (message): message is { t: 'hello'; extra?: { hero: number; playerId: string; slot: number } } =>
      (message as { t?: string }).t === 'hello',
  );
}

describe('демо по умолчанию: матч против бота на сетевом стеке (D1, SES-1)', () => {
  it('человек и бот входят в матч, ввод доезжает до сервера, снапшоты — в TickView', async () => {
    const clock = { ms: 0 };
    const opened = session(DEMO_PLAYERS.slice(0, 1));
    const rig = await join(opened, slotCandidates({ kind: 'local' }, DEMO_PLAYERS), clock);

    expect(rig.joined.ok).toBe(true);
    if (!rig.joined.ok) return;
    expect(rig.joined.playerId).toBe(DEMO_PLAYERS[0]);
    expect(rig.joined.client.slot).toBe(0);
    // Handshake доехал ровно один и с режимом (SHELL-5, SHELL-8), а id своей
    // сущности в нём — тот, что известен только после `Welcome` (NTR-5).
    expect(rig.remote.mode).toBe('network');
    expect(hellos(rig)).toHaveLength(1);
    expect(hellos(rig)[0]!.extra).toEqual({
      hero: rig.joined.hero,
      playerId: DEMO_PLAYERS[0],
      slot: 0,
    });

    // Таймер оболочки снимается: шаги делает тест (NTR-12).
    rig.joined.shell.stop();
    // Матч ждёт второго участника — до дедлайна слот свободен (BOT-7).
    expect(opened.server.phase).toBe('lobby');
    expect(opened.filler.seats).toHaveLength(0);

    opened.filler.fill();
    await flush();
    expect(bots?.seats).toHaveLength(1);
    expect(bots!.seats[0]!.playerId).toBe(DEMO_PLAYERS[1]);
    expect(bots!.seats[0]!.client.slot).toBe(1);
    // Оба слота заняты — ростер заморожен, матч пошёл (SES-4, NTR-6).
    expect(opened.server.phase).toBe('running');

    rig.remote.sendInput({ x: STEP, y: 0 });
    for (let i = 0; i < 20; i++) {
      clock.ms += 1000 / 60;
      rig.joined.shell.step();
      bots!.step();
      await flush(1);
      opened.host.step();
      await flush(1);
    }
    rig.joined.shell.step();
    await flush();

    expect(rig.joined.client.phase).toBe('playing');
    // Ввод главного потока уехал серверу и вошёл в канонический лог (SHELL-6,
    // NET-7): локально его не применял никто.
    const own = opened.server.canonicalInputs.filter(
      (frame) => frame.playerId === DEMO_PLAYERS[0] && frame.move.x !== 0,
    );
    expect(own.length).toBeGreaterThan(0);
    // Снапшоты доехали до подсистемы главного потока — тем же контрактом
    // доставки, что у локальной сборки (REND-8).
    expect(rig.joined.client.metrics.snapshotsApplied).toBeGreaterThan(0);
    expect(rig.probe.views.length).toBeGreaterThan(0);
    const view = rig.probe.views.at(-1)!;
    expect(view.tick).toBeGreaterThan(0);
    // В кадре оба героя матча: свой и бота (NET-15 — своя сущность всегда).
    // Прочие визуальные типы сцены (снаряд) кадру не мешают.
    const heroes = [...view.entities.values()].filter((entity) => entity.kind === 'Hero');
    expect(heroes).toHaveLength(2);
  });

  it('формат кадра сессии доезжает до бота: дебаг-формат не вешает лобби (SER-3)', async () => {
    const clock = { ms: 0 };
    // Сессия в дебаг-формате: сервер, человек и бот обязаны говорить одним —
    // полем протокола формат не согласовывается, и разошедшийся дал бы не
    // отказ, а вечное лобби.
    const opened = session(DEMO_PLAYERS.slice(0, 1), jsonSerializer);
    const rig = await join(opened, [DEMO_PLAYERS[0]!], clock, jsonSerializer);
    expect(rig.joined.ok).toBe(true);

    opened.filler.fill();
    await flush();
    expect(bots?.seats[0]!.client.slot).toBe(1);
    expect(opened.server.phase).toBe('running');
    if (rig.joined.ok) rig.joined.shell.stop();
  });

  it('слот занят — клиент берёт следующий, а не падает (D4)', async () => {
    const clock = { ms: 0 };
    // Резерва нет: оба слота открыты, и первым приходит «сосед по стенду».
    const opened = session([]);
    const first = await join(opened, [DEMO_PLAYERS[0]!], clock);
    expect(first.joined.ok).toBe(true);

    const second = await join(opened, DEMO_PLAYERS, clock);
    expect(second.joined.ok).toBe(true);
    if (!second.joined.ok) return;
    // Первый слот отдан первому пришедшему, второй — откату (`slot-taken`).
    expect(second.joined.playerId).toBe(DEMO_PLAYERS[1]);
    expect(second.joined.client.slot).toBe(1);
    expect(opened.server.phase).toBe('running');
    // Откат не оставил следа в главном потоке: handshake отвергнутой попытки
    // выброшен, доехал ровно один — и с id сущности ВТОРОГО слота (SHELL-5).
    expect(hellos(second)).toHaveLength(1);
    expect(hellos(second)[0]!.extra).toEqual({
      hero: second.joined.hero,
      playerId: DEMO_PLAYERS[1],
      slot: 1,
    });
    if (first.joined.ok) first.joined.shell.stop();
    second.joined.shell.stop();
  });

  it('свободных слотов нет — внятная причина, а не молчание', async () => {
    const clock = { ms: 0 };
    const opened = session([]);
    const first = await join(opened, [DEMO_PLAYERS[0]!], clock);
    const second = await join(opened, [DEMO_PLAYERS[1]!], clock);
    expect(first.joined.ok && second.joined.ok).toBe(true);

    const third = await join(opened, DEMO_PLAYERS, clock);
    expect(third.joined.ok).toBe(false);
    if (third.joined.ok) return;
    // Матч уже идёт: отказ фазы матча (NTR-6) — и он назван.
    expect(third.joined.reason).toContain('match-in-progress');
    if (first.joined.ok) first.joined.shell.stop();
    if (second.joined.ok) second.joined.shell.stop();
  });
});

describe('порт попыток входа: один живой потребитель (SHELL-3, D4)', () => {
  it('после отката оболочка отвергнутой попытки не получает ничего', () => {
    // Под `ShellPort` лежит `addEventListener`, то есть подписки
    // НАКАПЛИВАЮТСЯ, а `NetworkShell.stop()` от порта не отписывается: без
    // отцепления оболочка мёртвой попытки продолжала бы принимать каждый `ret`
    // главного потока и складывать буферы в пул, который никто не дренирует.
    const delivered: unknown[] = [];
    // Держатель, а не переменная: подписку ставит замыкание, и сужение типа по
    // потоку управления иначе решило бы, что она так и осталась null.
    const inbound: { handler: ((message: unknown) => void) | null } = { handler: null };
    const real: ShellPort = {
      post: (message) => delivered.push(message),
      onMessage: (handler) => {
        inbound.handler = handler;
      },
    };

    const buffered = bufferedShellPort(real);
    const first: unknown[] = [];
    buffered.port.onMessage((message) => first.push(message));
    buffered.port.post({ t: 'hello', mode: 'network', extra: { hero: 0 } });

    // Попытка не удалась: конверт выброшен, потребитель отцеплен.
    buffered.discard();
    inbound.handler?.({ t: 'ret' });
    expect(first).toHaveLength(0);
    expect(delivered).toHaveLength(0);

    // Вторая попытка удалась: доезжает её handshake и её сообщения.
    const second: unknown[] = [];
    buffered.port.onMessage((message) => second.push(message));
    buffered.port.post({ t: 'hello', mode: 'network', extra: { hero: 0 } });
    buffered.commit({ hero: 42 });
    inbound.handler?.({ t: 'ret' });

    expect(first).toHaveLength(0);
    expect(second).toEqual([{ t: 'ret' }]);
    expect(delivered).toEqual([{ t: 'hello', mode: 'network', extra: { hero: 42 } }]);
  });
});

describe('режим страницы выбирается при старте (SHELL-8, D4)', () => {
  it('строка запроса называет режим, а переключение — это другой URL', () => {
    expect(demoMode('')).toEqual({ kind: 'local' });
    expect(demoMode('?solo')).toEqual({ kind: 'solo' });
    expect(demoMode('?server=ws://10.0.0.5:9000')).toEqual({
      kind: 'server',
      url: 'ws://10.0.0.5:9000',
    });
    // Пустой параметр означает «адрес сборки», а не пустой адрес (D4).
    expect(demoMode('?server=').kind).toBe('server');

    const href = 'http://localhost:5173/?solo';
    expect(serverModeUrl(href, 'ws://127.0.0.1:8080')).toBe(
      'http://localhost:5173/?server=ws%3A%2F%2F127.0.0.1%3A8080',
    );
    expect(localModeUrl(serverModeUrl(href))).toBe('http://localhost:5173/');
  });

  it('у матча своей вкладки кандидат один, у стенда — весь ростер', () => {
    expect(slotCandidates({ kind: 'local' }, DEMO_PLAYERS)).toEqual([DEMO_PLAYERS[0]]);
    expect(slotCandidates({ kind: 'solo' }, DEMO_PLAYERS)).toEqual([DEMO_PLAYERS[0]]);
    expect(slotCandidates({ kind: 'server', url: 'ws://x' }, DEMO_PLAYERS)).toEqual([
      ...DEMO_PLAYERS,
    ]);
  });
});

/** Длительность тика — та, что приезжает handshake'ом (SHELL-5). */
const TICK_MS = 1000 / 60;

describe('HUD деградирует по контракту оболочки (D5)', () => {
  it('сетевая сборка не заводит слотов паузы у статуса матча', () => {
    const local = demoHudComposition({ controls: true, tickMs: TICK_MS }).entries[0]!;
    const network = demoHudComposition({ controls: false, tickMs: TICK_MS }).entries[0]!;

    expect(local.widget).toBe('match-status');
    expect(local.actions).toEqual({ pause: 'match.pause', resume: 'match.resume' });
    expect(local.params).toEqual({ controls: true });

    expect(network.widget).toBe('match-status');
    // Слотов нет вовсе: кнопка, которой некуда вести, — обещание, которого
    // сборка не выполнит (NET-11, REW-6).
    expect(network.actions).toBeUndefined();
    expect(network.params).toEqual({ controls: false });
    // Прочие виджеты не различаются: им всё равно, кто тикает (SHELL-2..5).
    expect(demoHudComposition({ controls: false, tickMs: TICK_MS }).entries.slice(1)).toEqual(
      demoHudComposition({ controls: true, tickMs: TICK_MS }).entries.slice(1),
    );
  });
});
