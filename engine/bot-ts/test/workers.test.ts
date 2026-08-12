/**
 * Сборка бота на портах (design D3) и нагрузочный прогон «матч, заполненный
 * ботами» (BOT-4, сценарий «Десять ботов в тестовом прогоне»).
 *
 * Порты — настоящие, из `node:worker_threads`: тот же структурный минимум, что
 * у браузерного `MessagePort` (`client-shell` SHELL-3), та же асинхронная
 * доставка с копированием байтов (NTR-2). Отдельный ПОТОК здесь не поднимается
 * намеренно: пакеты репозитория — исходники на TypeScript без сборки, и запуск
 * настоящего `Worker` потребовал бы бандлера, то есть проверял бы сборочный
 * инструмент, а не бота. Предмет проверки — что общая воркер-сторона
 * (`startBotWorker`) поднимает ботов из init-сообщения и играет через порты;
 * какой поток исполняет её код, ни сервер, ни клиент не различают.
 */
import { MessageChannel } from 'node:worker_threads';
import { afterEach, describe, expect, it } from 'vitest';
import { fixed, query, world as coreWorld } from '@game-mvp/core';
import { MatchHost, MatchServer } from '@game-mvp/net';
import { PortConnections, botWorkerInit, isBotWorkerInit } from '../src/assembly.js';
import { attachBots } from '../src/worker/spawn.js';
import { startBotWorker } from '../src/worker/botWorker.js';
import type { BotHost } from '../src/host.js';
import { BUILD_ID, duelConfig, duelScene, testProfile } from './fixtures.js';

const channels: MessageChannel[] = [];

/** Порты держат событийный цикл: незакрытые концы подвесили бы прогон. */
afterEach(() => {
  for (const channel of channels) {
    channel.port1.close();
    channel.port2.close();
  }
  channels.length = 0;
});

/** Доставка через порты асинхронна — шаг цикла заканчивается тут. */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function openChannel(connections: PortConnections): ReturnType<PortConnections['open']> {
  const channel = new MessageChannel();
  channels.push(channel);
  return connections.open(channel);
}

describe('матч, заполненный ботами через порты (BOT-4)', () => {
  it('десять слотов в одном хосте: все входят в матч и шлют ввод', async () => {
    const players = Array.from({ length: 10 }, (_, index) => `bot-${index}`);
    const config = duelConfig({ players });
    const server = new MatchServer(config);
    const connections = new PortConnections();
    const matchHost = new MatchHost(server, connections);

    const ports = players.map(() => openChannel(connections));
    const init = botWorkerInit({
      seats: players.map((playerId) => ({
        playerId,
        brain: 'classic' as const,
        profile: testProfile(),
      })),
      ports,
      buildId: BUILD_ID,
      sceneRef: 'duel',
      scene: config.scene,
      physics: {},
      visibility: {},
    });
    expect(isBotWorkerInit(init)).toBe(true);

    // Ровно тот код, который исполнил бы entry воркера, получив init-сообщение.
    const bots: BotHost = startBotWorker(init, { autoRun: false });
    await flush();

    for (let i = 0; i < 30; i++) {
      bots.step();
      await flush();
      matchHost.step();
      await flush();
    }

    expect(bots.seats).toHaveLength(10);
    expect(bots.seats.map((seat) => seat.client.slot)).toEqual([...players.keys()]);
    for (const seat of bots.seats) {
      expect(seat.client.phase, seat.playerId).toBe('playing');
      expect(seat.client.metrics.bytesReceived, seat.playerId).toBeGreaterThan(0);
      expect(seat.client.metrics.inputsSent, seat.playerId).toBeGreaterThan(0);
    }
    // Сервер отработал расписание и знает всех десятерых одинаково (BOT-1).
    expect(server.tick).toBe(30);
    const owners = new Set((server.toScenario().inputs ?? []).map((frame) => frame.playerId));
    expect(owners).toEqual(new Set(players));

    bots.dispose();
    await matchHost.stop();
  });
});

describe('данные сцены доезжают до мозга сборкой (BOT-6, ARENA-1, NTR-7)', () => {
  it('арена со смещённым центром и темп 30 Гц: бот идёт в НАСТОЯЩИЙ центр', async () => {
    // Центр арены живёт в ассете сцены, а не в компоненте: возьми мозг
    // умолчание «начало координат» — и «иди в центр» увело бы его в угол.
    const scene = duelScene({ centerX: 6, centerY: 6, radius: 20 });
    const config = duelConfig({ scene, players: ['bot-1'], tickRate: 30, snapshotRate: 30 });
    const server = new MatchServer(config);
    const connections = new PortConnections();
    const matchHost = new MatchHost(server, connections);
    const port = openChannel(connections);

    const bots = startBotWorker(
      botWorkerInit({
        seats: [{ playerId: 'bot-1', brain: 'scripted', profile: testProfile() }],
        ports: [port],
        buildId: BUILD_ID,
        sceneRef: 'duel',
        scene,
        physics: {},
        visibility: {},
      }),
      { autoRun: false },
    );
    await flush();
    for (let i = 0; i < 60; i++) {
      bots.step();
      await flush();
      matchHost.step();
      await flush();
    }

    // Темп матча доехал до бота из `Welcome`, а не из константы 60 (NTR-7).
    expect(bots.seats[0]!.client.pacing?.tickRate).toBe(30);

    const snapshot = server.snapshot();
    const [hero] = [...query(snapshot.world, { all: ['Player', 'Position'] })];
    const x = fixed.toFloat(coreWorld.getField(snapshot.world, hero!, 'Position', 'x'));
    const y = fixed.toFloat(coreWorld.getField(snapshot.world, hero!, 'Position', 'y'));
    // Стартовал в начале координат — ушёл в сторону (6, 6), а не остался.
    expect(x).toBeGreaterThan(0.5);
    expect(y).toBeGreaterThan(0.5);
    expect(Math.abs(x - y)).toBeLessThan(0.5);

    bots.dispose();
    await matchHost.stop();
  });

  it('битый профиль в init-сообщении отвергается на конструировании (BOT-6)', () => {
    const config = duelConfig({ players: ['bot-1'] });
    const connections = new PortConnections();
    const port = openChannel(connections);
    const broken = { ...testProfile(), aggression: 12 };
    expect(() =>
      startBotWorker(
        botWorkerInit({
          seats: [{ playerId: 'bot-1', brain: 'classic', profile: broken }],
          ports: [port],
          buildId: BUILD_ID,
          sceneRef: 'duel',
          scene: config.scene,
        }),
        { autoRun: false },
      ),
    ).toThrow(/bot-1[\s\S]*aggression/);
  });
});

describe('сборка канала бота (design D3)', () => {
  it('пара портов: серверный конец становится соединением, ботский уезжает наружу', async () => {
    const config = duelConfig({ players: ['bot-1'] });
    const server = new MatchServer(config);
    const connections = new PortConnections();
    const matchHost = new MatchHost(server, connections);
    const port = openChannel(connections);
    expect(port).toBeDefined();

    const bots = startBotWorker(
      botWorkerInit({
        seats: [{ playerId: 'bot-1', brain: 'scripted', profile: testProfile() }],
        ports: [port],
        buildId: BUILD_ID,
        sceneRef: 'duel',
        scene: config.scene,
        physics: {},
        visibility: {},
      }),
      { autoRun: false },
    );
    await flush();
    matchHost.step();
    await flush();

    expect(bots.seats[0]!.client.slot).toBe(0);
    bots.dispose();
    await matchHost.stop();
  });

  it('несовпадение числа ботов и портов — ошибка сборки, а не тишина', () => {
    expect(() =>
      botWorkerInit({
        seats: [{ playerId: 'bot-1', brain: 'scripted', profile: testProfile() }],
        ports: [],
        buildId: BUILD_ID,
        sceneRef: 'duel',
        scene: duelConfig().scene,
      }),
    ).toThrow(/по порту на бота/);
  });

  it('чужое сообщение entry не трогает', () => {
    expect(isBotWorkerInit({ t: 'ret', buffer: new ArrayBuffer(8) })).toBe(false);
    expect(isBotWorkerInit(null)).toBe(false);
  });

  it('главная сторона раздаёт концы и шлёт порты transfer’ом', async () => {
    const config = duelConfig({ players: ['bot-1', 'bot-2'] });
    const server = new MatchServer(config);
    const connections = new PortConnections();
    const matchHost = new MatchHost(server, connections);
    const posted: { message: unknown; transfer: readonly unknown[] | undefined }[] = [];

    attachBots({
      worker: {
        postMessage: (message, transfer) => { posted.push({ message, transfer }); },
      },
      connections,
      channel: () => {
        const channel = new MessageChannel();
        channels.push(channel);
        return channel;
      },
      seats: [
        { playerId: 'bot-1', brain: 'scripted', profile: testProfile() },
        { playerId: 'bot-2', brain: 'classic', profile: testProfile() },
      ],
      buildId: BUILD_ID,
      sceneRef: 'duel',
      scene: config.scene,
      physics: {},
      visibility: {},
    });

    expect(posted).toHaveLength(1);
    const init = posted[0]!.message;
    expect(isBotWorkerInit(init)).toBe(true);
    // Порты — не копируемое значение: без списка переноса воркер получил бы
    // сообщение, но не канал.
    expect(posted[0]!.transfer).toHaveLength(2);

    // Серверная сторона тем временем уже приняла два соединения.
    const bots = startBotWorker(init as ReturnType<typeof botWorkerInit>, { autoRun: false });
    await flush();
    matchHost.step();
    await flush();
    expect(bots.seats.map((seat) => seat.client.slot)).toEqual([0, 1]);
    bots.dispose();
    await matchHost.stop();
  });
});
