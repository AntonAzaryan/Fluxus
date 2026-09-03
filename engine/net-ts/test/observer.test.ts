/**
 * Наблюдатель матча насквозь (NTR-21, NTR-9): настоящий `MatchServer`, настоящий
 * `MatchClient` и настоящий транспорт — тот же код, что играет по сети (NTR-12).
 *
 * Серверная половина — фильтрация по `viewpoint` и поток событий наблюдателя —
 * проверена по `server.drain()` в `filtering.test.ts` и `events.test.ts`.
 * Предмет этого файла ровно тот, которого там не было: КЛИЕНТ. До приветствия
 * наблюдателя (NTR-21) первый же снапшот рвал его соединение — «снапшот до
 * Welcome» (NTR-5), — и отгруженный путь `bin/play.mjs --observer` падал всегда.
 */
import { describe, expect, it } from 'vitest';
import { query, type GameEvent, type SceneDef } from '@fluxus/core';
import {
  authoredMaskScene,
  connectClient,
  duelConfig,
  harness,
  hello,
  inputMessage,
  settle,
  versionOf,
  wireInput,
  type ConnectedClient,
  type Harness,
} from './fixtures.js';
import { contentPack } from '../src/content/pack.js';
import { MatchClient } from '../src/client/matchClient.js';
import { NO_SLOT } from '../src/protocol/messages.js';
import type { MatchConfig } from '../src/server/matchServer.js';
import type { PresentedState } from '../src/client/interpolation.js';

/**
 * Сцена с масками, объявленными РАССТАНОВКОЙ (`authoredMaskScene`), плюс
 * система, публикующая событие по фронту кнопки: событие ссылается на
 * кастующего полем `entity`, поэтому предикат видимости (NET-13) отбирает его
 * по видимости этой сущности.
 *
 * Маски авторит расстановка, а не `VisibilitySystem`: предмет файла — что видит
 * КЛИЕНТ наблюдателя, а не как считается видимость (это зона FoW-тестов ядра).
 */
function castScene(): SceneDef {
  const scene = authoredMaskScene();
  return {
    ...scene,
    systems: [
      ...(scene.systems ?? []),
      {
        name: 'Cast',
        order: 20,
        query: { all: ['Input', 'Player'] },
        as: 'e',
        do: [
          {
            if: {
              cond: {
                and: [
                  { bitTest: [{ getComponent: [{ var: 'e' }, 'Input', 'buttons'] }, 0] },
                  { '!': [{ bitTest: [{ getComponent: [{ var: 'e' }, 'Input', 'prevButtons'] }, 0] }] },
                ],
              },
              then: [
                {
                  emitEvent: {
                    type: 'Cast',
                    data: {
                      entity: { var: 'e' },
                      slot: { getComponent: [{ var: 'e' }, 'Player', 'slot'] },
                    },
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

/** Герои видимы только своей команде: слот 0 — биту 0, слот 1 — биту 1. */
function watchedConfig(overrides: Partial<MatchConfig> = {}): MatchConfig {
  return duelConfig({
    scene: castScene(),
    snapshotRate: 60,
    eventRepeat: 0,
    allowObserver: true,
    initial: [
      { prefab: 'Hero', overrides: { Visibility: { visibleTo: 1 }, Team: { id: 0 } } },
      {
        prefab: 'Hero',
        overrides: { Player: { slot: 1 }, Visibility: { visibleTo: 2 }, Team: { id: 1 } },
      },
    ],
    ...overrides,
  });
}

interface Watched extends Harness {
  readonly player: ConnectedClient;
  readonly other: ConnectedClient;
  readonly watcher: ConnectedClient;
  /**
   * Факты, слитые ХОСТОМ каждого клиента (NTR-15): очередь пустеет чтением, и
   * читает её `ClientHost.step()` — то есть смотреть в `pendingEvents` после
   * прогона не на что. Копим здесь, как копил бы потребитель.
   */
  readonly facts: { readonly player: GameEvent[]; readonly other: GameEvent[]; readonly watcher: GameEvent[] };
}

/** Матч двух игроков плюс наблюдатель — все трое настоящими клиентами. */
async function watchedMatch(config: MatchConfig = watchedConfig()): Promise<Watched> {
  const fixture = harness(config);
  const player = connectClient(fixture.hub, 'p1', fixture.clock, config.scene);
  const other = connectClient(fixture.hub, 'p2', fixture.clock, config.scene);
  const watcher = connectClient(fixture.hub, 'watcher', fixture.clock, config.scene, {
    observer: true,
  });
  await settle();
  return {
    ...fixture,
    player,
    other,
    watcher,
    facts: { player: [], other: [], watcher: [] },
  };
}

async function play(match: Watched, ticks: number): Promise<void> {
  for (let i = 0; i < ticks; i++) {
    match.clock.ms += 1000 / 60;
    stepInto(match.player, match.facts.player);
    stepInto(match.other, match.facts.other);
    stepInto(match.watcher, match.facts.watcher);
    await settle();
    match.host.step();
    await settle();
  }
}

/** Шаг клиента вместе со сливом его фактов — то, что делает потребитель. */
function stepInto(side: ConnectedClient, facts: GameEvent[]): void {
  for (const delivered of side.host.step().events) facts.push(...delivered.events);
}

/** Сколько УЧАСТНИКОВ матча в применённом состоянии — то, что клиент реально увидел. */
function heroes(state: PresentedState | undefined): number {
  if (state === undefined) return -1;
  return [...query(state.world, { all: ['Player', 'Position'] })].length;
}

describe('наблюдатель поднимает мир и применяет состояния (NTR-21)', () => {
  it('приветствие с сентинелем доводит наблюдателя до применённых снапшотов', async () => {
    const match = await watchedMatch();
    await play(match, 4);

    // Прежний отказ был здесь: мира у наблюдателя не было, и первый же снапшот
    // закрывал соединение «снапшотом до Welcome» (NTR-5).
    expect(match.watcher.client.phase).toBe('playing');
    expect(match.watcher.client.closeReason).toBeUndefined();
    expect(match.watcher.client.metrics.snapshotsApplied).toBeGreaterThan(0);
    // Слота нет вовсе, и наружу это едет отсутствием величины, а не числом -1.
    expect(match.watcher.client.slot).toBeUndefined();
    expect(match.watcher.client.observer).toBe(true);
    // Мир он поднял сам и сверил его хеш теми же двумя сверками (NTR-5).
    expect(match.watcher.client.worldInitHash).toBe(match.server.worldInitHash);
    // Участник наблюдателем не стал.
    expect(match.player.client.observer).toBe(false);
    expect(match.player.client.slot).toBe(0);
  });

  it('наблюдателю доставлен весь мир, участнику — только его команда (NTR-9, NET-12)', async () => {
    const match = await watchedMatch();
    await play(match, 4);

    // Оба героя против одного своего у каждого участника: маски расстановки
    // называют каждого героя видимым только своей команде.
    expect(heroes(match.watcher.client.latest)).toBe(2);
    expect(heroes(match.player.client.latest)).toBe(1);
    expect(heroes(match.other.client.latest)).toBe(1);
  });

  it('факты приходят наблюдателю без фильтрации (NTR-15)', async () => {
    const match = await watchedMatch();
    // Каст противника: событие ссылается на его сущность, невидимую для p1.
    match.other.client.pushInput(
      { move: { x: 0, y: 0 }, aimDir: 0, buttons: 1 },
      match.clock.ms,
    );
    match.other.host.flush();
    await settle();
    await play(match, 6);

    const castsOf = (facts: readonly GameEvent[]): number =>
      facts.filter((event) => event.type === 'Cast').length;
    // Своему каст доехал, чужому — нет (NET-13), наблюдателю — доехал: он
    // получает тот же поток без фильтрации, и второго канала под него нет.
    expect(castsOf(match.facts.other)).toBe(1);
    expect(castsOf(match.facts.player)).toBe(0);
    expect(castsOf(match.facts.watcher)).toBe(1);
  });
});

describe('наблюдатель ничего не отправляет и ничего не стоит матчу (NTR-21)', () => {
  it('ввод наблюдателя не уезжает и запаса разметки у него нет', async () => {
    const match = await watchedMatch();
    await play(match, 2);

    match.watcher.client.pushInput(
      { move: { x: 1000, y: 0 }, aimDir: 0, buttons: 1 },
      match.clock.ms,
    );
    expect(match.watcher.client.drain()).toEqual([]);
    expect(match.watcher.client.metrics.inputsSent).toBe(0);
    // Запас разметки описывает канал ВВЕРХ, которого у наблюдателя нет: у
    // величины форма «нет значения», а не ноль (NTR-11).
    expect(match.watcher.client.metrics.inputLead).toBeUndefined();
    // Соединение живо: сервер разрывает за ОТПРАВЛЕННЫЙ ввод (NTR-4), а его нет.
    await play(match, 2);
    expect(match.watcher.client.phase).toBe('playing');
    expect(match.server.phase).toBe('running');
  });

  it('молчание наблюдателя матча не завершает: порог считается по слотам (NTR-6)', () => {
    const config = watchedConfig({ silenceTicks: 4 });
    const { server } = harness(config);
    server.connect(1);
    server.receive(1, hello('p1', config.version));
    server.connect(2);
    server.receive(2, hello('p2', config.version));
    server.connect(3);
    server.receive(3, hello('watcher', config.version, true));
    server.drain();

    // Слоты говорят, наблюдатель молчит — вдвое дольше порога.
    for (let tick = 1; tick <= 12; tick++) {
      server.receive(1, inputMessage(wireInput(tick, tick)));
      server.receive(2, inputMessage(wireInput(tick, tick)));
      server.advance();
    }

    expect(server.phase).toBe('running');
    expect(server.drain().some((entry) => entry.message.type === 'End')).toBe(false);
  });

  it('уход наблюдателя не трогает ни слотов, ни матча', () => {
    const config = watchedConfig();
    const { server } = harness(config);
    server.connect(1);
    server.receive(1, hello('p1', config.version));
    server.connect(2);
    server.receive(2, hello('p2', config.version));
    server.connect(3);
    server.receive(3, hello('watcher', config.version, true));
    server.advance();
    server.drain();

    server.receive(3, { type: 'Bye', reason: 'насмотрелся' });
    server.advance();

    expect(server.phase).toBe('running');
    expect(server.slotLease(0).attached).toBe(true);
    expect(server.slotLease(1).attached).toBe(true);
    expect(server.drain().some((entry) => entry.message.type === 'End')).toBe(false);
  });
});

describe('вход наблюдателя в идущий и в законченный матч (NTR-21)', () => {
  it('вошедший после старта получает Start с ИСХОДНЫМ тиком начала (NTR-17)', () => {
    const config = watchedConfig();
    const { server } = harness(config);
    server.connect(1);
    server.receive(1, hello('p1', config.version));
    server.connect(2);
    server.receive(2, hello('p2', config.version));
    for (let tick = 0; tick < 5; tick++) server.advance();
    server.drain();

    server.connect(3);
    server.receive(3, hello('watcher', config.version, true));

    const types = server.drain().map((entry) => entry.message);
    expect(types[0]).toMatchObject({ type: 'Welcome', slot: NO_SLOT });
    // Тик начала матча, а не «сейчас»: для вошедшего матч не начался заново.
    expect(types[1]).toMatchObject({ type: 'Start', tick: 0 });
    expect(types.some((message) => message.type === 'Pause')).toBe(true);
  });

  it('вошедший в завершённый матч получает названный отказ, а не тишину', () => {
    const config = watchedConfig();
    const { server } = harness(config);
    server.connect(1);
    server.receive(1, hello('p1', config.version));
    server.connect(2);
    server.receive(2, hello('p2', config.version));
    server.advance();
    server.stop();
    server.drain();

    server.connect(3);
    server.receive(3, hello('watcher', config.version, true));

    const outgoing = server.drain();
    expect(outgoing[0]!.message).toMatchObject({ type: 'Reject', reason: 'match-ended' });
    expect(outgoing[0]!.closeAfter).toBe(true);
  });
});

describe('приветствие сверяется с предъявленным родом участия (NTR-21)', () => {
  const scene = castScene();

  function client(observer: boolean): MatchClient {
    return new MatchClient({
      playerId: 'p1',
      version: versionOf(scene),
      content: contentPack({ duel: scene }),
      ...(observer ? { observer: true } : {}),
    });
  }

  const pacing = { tickRate: 60, snapshotRate: 60, inputDelay: 2, inputWindow: 15, eventRepeat: 0 };

  it('участнику приехал сентинель — разрыв, а не тихий переход в наблюдение', () => {
    const player = client(false);
    player.receive(
      {
        type: 'Welcome',
        slot: NO_SLOT,
        players: ['p1', 'p2'],
        match: { sceneRef: 'duel', initial: [] },
        worldInitHash: 'неважно',
        pacing,
      },
      0,
    );

    expect(player.phase).toBe('closed');
    expect(player.closeReason).toBe('protocol-error');
    // Мир не поднят и хеш не сверялся: расхождение вскрылось до сверки.
    expect(player.worldInitHash).toBeUndefined();
  });

  it('наблюдателю приехал слот — тот же разрыв с другой стороны', () => {
    const watcher = client(true);
    watcher.receive(
      {
        type: 'Welcome',
        slot: 0,
        players: ['p1', 'p2'],
        match: { sceneRef: 'duel', initial: [] },
        worldInitHash: 'неважно',
        pacing,
      },
      0,
    );

    expect(watcher.phase).toBe('closed');
    expect(watcher.closeReason).toBe('protocol-error');
    expect(watcher.observer).toBe(false);
  });
});
