/**
 * Матч двух игроков целиком (NTR-8, NTR-10, NTR-12): сервер, два клиента и
 * внутрипроцессный транспорт — тот же код, что играет по сети.
 *
 * Главная проверка здесь — парность (NTR-8): записанный матч прогоняется через
 * `runScenario` ядра и обязан дать побитово то же состояние. Без неё у сетевого
 * слоя нет доказательства, что он не сломал детерминизм, и первое же
 * расхождение искали бы в ядре, где его нет.
 */
import { describe, expect, it } from 'vitest';
import {
  query,
  runScenario,
  snapshotToPlain,
  world as coreWorld,
  type Snapshot,
} from '@game-mvp/core';
import {
  connectClient,
  duelConfig,
  duelScene,
  harness,
  placedScene,
  settle,
  STEP,
  type ConnectedClient,
} from './fixtures.js';
import type { InputSource } from '../src/client/host.js';
import type { MatchConfig } from '../src/server/matchServer.js';

function walkRight(untilTick: number): InputSource {
  return (tick) => (tick <= untilTick ? { move: { x: STEP, y: 0 }, aimDir: 0, buttons: 0 } : undefined);
}

function positionOfSlot(snapshot: Snapshot, slot: number): { x: number; y: number } | undefined {
  for (const entity of query(snapshot.world, { all: ['Player', 'Position'] })) {
    if (coreWorld.getField(snapshot.world, entity, 'Player', 'slot') !== slot) continue;
    return {
      x: coreWorld.getField(snapshot.world, entity, 'Position', 'x'),
      y: coreWorld.getField(snapshot.world, entity, 'Position', 'y'),
    };
  }
  return undefined;
}

async function playMatch(ticks: number, config: MatchConfig = duelConfig()) {
  const fixture = harness(config);
  const scene = config.scene;
  const a = connectClient(fixture.hub, 'p1', fixture.clock, scene, { input: walkRight(8) });
  const b = connectClient(fixture.hub, 'p2', fixture.clock, scene, {});
  await settle();

  for (let i = 0; i < ticks; i++) {
    fixture.clock.ms += 1000 / 60;
    a.host.step();
    b.host.step();
    await settle();
    fixture.host.step();
    await settle();
  }
  return { ...fixture, a, b };
}

describe('матч двух игроков', () => {
  it('хендшейк доводит обоих до игры', async () => {
    const { server, a, b } = await playMatch(0);
    expect(server.phase).toBe('running');
    expect(a.client.phase).toBe('playing');
    expect(b.client.phase).toBe('playing');
    expect(a.client.slot).toBe(0);
    expect(b.client.slot).toBe(1);
  });

  it('ввод игрока 1 доезжает до состояния, которое видит игрок 2', async () => {
    const { b, server } = await playMatch(24);

    expect(server.tick).toBeGreaterThan(0);
    const seen = b.client.latest;
    expect(seen).toBeDefined();
    // Игрок 2 не двигался и видит чужое движение исключительно из снапшота.
    expect(positionOfSlot(seen!, 0)!.x).toBeGreaterThan(0);
    expect(positionOfSlot(seen!, 1)!.x).toBe(0);
  });

  it('записанный матч воспроизводится прогоном сценария побитово (NTR-8)', async () => {
    const { server } = await playMatch(24);

    const replay = runScenario(server.toScenario());
    expect(replay.worldInitHash).toBe(server.worldInitHash);
    expect(replay.ticks).toHaveLength(server.tick + 1);
    // Последний тик прогона против канонического состояния сервера — включая
    // rng, шину событий и режим мира, а не только позиции.
    expect(replay.ticks[replay.ticks.length - 1]).toEqual(snapshotToPlain(server.snapshot()));
  });

  it('расстановка сцены применяется до расстановки матча и остаётся парной ядру (SER-8, NTR-8)', async () => {
    // Сцена с непустым `initial`: пролог `buildMatchWorld` повторяет пролог
    // ядра, и забытая в нём расстановка сцены разошлась бы именно здесь.
    const { server, a } = await playMatch(12, duelConfig({ scene: placedScene() }));

    const snapshot = server.snapshot();
    // Реквизит сцены занял первые слоты, герои матча встали за ним (ID-2).
    const positions = [...query(snapshot.world, { all: ['Position'] })].map((entity) => ({
      x: coreWorld.getField(snapshot.world, entity, 'Position', 'x'),
      hero: coreWorld.hasComponent(snapshot.world, entity, 'Player'),
    }));
    expect(positions).toHaveLength(4);
    expect(positions.slice(0, 2).map((entry) => entry.hero)).toEqual([false, false]);
    expect(positions.slice(2).map((entry) => entry.hero)).toEqual([true, true]);

    const replay = runScenario(server.toScenario());
    expect(replay.worldInitHash).toBe(server.worldInitHash);
    expect(replay.ticks[replay.ticks.length - 1]).toEqual(snapshotToPlain(snapshot));
    // Клиент поднимает мир той же сборкой из той же сцены контент-пака (NTR-5).
    expect(a.client.worldInitHash).toBe(server.worldInitHash);
  });

  it('канонический лог содержит кадр каждого слота на каждом тике', async () => {
    const { server } = await playMatch(12);

    const frames = server.canonicalInputs;
    expect(frames).toHaveLength(server.tick * 2);
    for (let tick = 1; tick <= server.tick; tick++) {
      const atTick = frames.filter((frame) => frame.tick === tick);
      expect(atTick.map((frame) => frame.playerId).sort()).toEqual(['p1', 'p2']);
    }
  });

  it('клиент не тикает симуляцию — он применяет чужое состояние (NTR-10)', async () => {
    const { a, server } = await playMatch(16);

    // Локальный мир клиента поднят ради сверки хешей и остался на worldInit:
    // предсказания в MVP нет, и мир вперёд клиент не двигает.
    expect(a.client.worldInitHash).toBe(server.worldInitHash);
    expect(a.client.latest!.tick).toBeGreaterThan(0);
  });

  it('устаревший снапшот отбрасывается (NTR-10)', async () => {
    const { a, server, clock } = await playMatch(16);

    const applied = a.client.metrics.snapshotsApplied;
    const lastTick = a.client.latest!.tick;
    a.client.receive(
      { type: 'Snapshot', tick: lastTick - 2, snapshot: snapshotToPlain(server.snapshot()) },
      clock.ms,
    );

    expect(a.client.metrics.snapshotsDropped).toBe(1);
    expect(a.client.metrics.snapshotsApplied).toBe(applied);
    expect(a.client.latest!.tick).toBe(lastTick);
  });
});

describe('наблюдаемость (NTR-11)', () => {
  it('отклик измеряется без единого лишнего сообщения в протоколе', async () => {
    const { a } = await playMatch(24);

    expect(a.client.metrics.inputsSent).toBeGreaterThan(0);
    // `seq` возвращается сам — его кладёт в компонент ввода `InputSystem` ядра.
    expect(a.client.metrics.inputToVisibleMs).toBeDefined();
    expect(a.client.metrics.inputToVisibleMs).toBeGreaterThan(0);
    expect(a.client.metrics.inputToVisibleMaxMs).toBeGreaterThanOrEqual(
      a.client.metrics.inputToVisibleMinMs!,
    );
  });

  it('молчащий игрок не превращает отклик в «время с последнего нажатия»', async () => {
    // Клиент отправил ввод и замолчал: сервер продолжает подставлять
    // predicted-кадры, повторяя последний `seq` (TICK-2). Тот же `seq`,
    // померенный повторно, дал бы растущее без предела число вместо отклика.
    const fixture = harness();
    const scene = duelScene();
    const a = connectClient(fixture.hub, 'p1', fixture.clock, scene, { input: walkRight(2) });
    connectClient(fixture.hub, 'p2', fixture.clock, scene, {});
    await settle();

    for (let i = 0; i < 40; i++) {
      fixture.clock.ms += 1000 / 60;
      a.host.step();
      await settle();
      fixture.host.step();
      await settle();
    }

    expect(a.client.metrics.inputToVisibleMs).toBeDefined();
    // Ввода не было около 38 тиков (>600 мс), а отклик обязан остаться откликом.
    expect(a.client.metrics.inputToVisibleMaxMs).toBeLessThan(400);
  });

  it('оценка серверного тика не убегает вперёд без предела', async () => {
    // Собственный таймер клиента идёт не ровно в темпе сервера. Односторонний
    // подтягивающий `max` копил бы расхождение, пока кадры не выпали бы из окна
    // приёма — то есть ввод исчезал бы целиком (NTR-7).
    const fixture = harness();
    const scene = duelScene();
    const a = connectClient(fixture.hub, 'p1', fixture.clock, scene, { input: walkRight(1000) });
    connectClient(fixture.hub, 'p2', fixture.clock, scene, {});
    await settle();

    for (let i = 0; i < 60; i++) {
      fixture.clock.ms += 1000 / 60;
      // Клиент шагает вдвое чаще сервера — намеренно разъезжающиеся часы.
      a.host.step();
      a.host.step();
      await settle();
      fixture.host.step();
      await settle();
    }

    const drift = a.client.serverTick - fixture.server.tick;
    expect(drift).toBeLessThanOrEqual(4);
    // И ввод при этом продолжает применяться, а не выпадает из окна.
    expect(fixture.server.metrics.slots[0]!.outOfWindow).toBe(0);
    expect(fixture.server.metrics.slots[0]!.applied).toBeGreaterThan(0);
  });

  it('причины расходятся по разным счётчикам, а не сводятся в одну', async () => {
    const { server, a } = await playMatch(24);

    const counters = server.metrics.slots[0]!;
    expect(counters.applied).toBeGreaterThan(0);
    expect(counters.late).toBe(0);
    expect(counters.outOfWindow).toBe(0);
    expect(server.metrics.snapshotsSent).toBeGreaterThan(0);
    expect(server.metrics.bytesSent).toBeGreaterThan(0);
    expect(a.client.metrics.bytesReceived).toBeGreaterThan(0);
  });

  it('буфер интерполяции отстаёт от последнего состояния (NET-3)', async () => {
    const { a, clock } = await playMatch(24);

    const sampled = a.client.sample(clock.ms);
    expect(sampled).toBeDefined();
    expect(a.client.metrics.bufferLagMs).toBeDefined();
    expect(sampled!.alpha).toBeGreaterThanOrEqual(0);
    expect(sampled!.alpha).toBeLessThanOrEqual(1);
  });
});

describe('транспорт', () => {
  it('матч идёт без сокетов и без таймеров', async () => {
    // Тест целиком отработал на внутрипроцессном транспорте и ручных шагах —
    // это и есть то, ради чего сервер не заводит часов (NTR-3, NTR-12).
    const { server } = await playMatch(4);
    expect(server.tick).toBe(4);
  });

  it('оба клиента прошли через один и тот же код', async () => {
    const { a, b }: { a: ConnectedClient; b: ConnectedClient } = await playMatch(4);
    expect(a.client.constructor).toBe(b.client.constructor);
    expect(a.host.constructor).toBe(b.host.constructor);
  });
});
