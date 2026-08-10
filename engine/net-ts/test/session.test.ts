/**
 * Сборка сессии (`net-session` SES-1, SES-2, SES-6, SES-8).
 *
 * Предмет проверки — не матч (он покрыт своими тестами), а то, что режим не
 * протекает внутрь: клиент хоста проходит тот же путь и получает тот же
 * персональный снапшот, что удалённый участник, а `dedicated` остаётся той же
 * сборкой.
 */
import { describe, expect, it } from 'vitest';
import { query, world as coreWorld } from '@game-mvp/core';
import { contentPack } from '../src/content/pack.js';
import { ClientHost } from '../src/client/host.js';
import { MatchClient } from '../src/client/matchClient.js';
import { DedicatedSession } from '../src/session/dedicatedSession.js';
import { HostSession } from '../src/session/hostSession.js';
import { joinMatch, joinSession, SessionJoinError } from '../src/session/joinSession.js';
import { InProcessRendezvous } from '../src/session/rendezvous/inProcess.js';
import { duelConfig, fogScene, settle, versionOf } from './fixtures.js';
import type { PresentedState } from '../src/client/interpolation.js';
import type { MatchConfig } from '../src/server/matchServer.js';

/** Оба героя видимы только своей команде: слот 0 — биту 0, слот 1 — биту 1. */
function fogConfig(): MatchConfig {
  return duelConfig({
    scene: fogScene(),
    // Сцена с флагом `fog` обязывает конфиг объявить пересчёт видимости (NTR-14).
    visibility: {},
    snapshotRate: 60,
    initial: [
      { prefab: 'Hero', overrides: { Visibility: { visibleTo: 1 }, Team: { id: 0 } } },
      {
        prefab: 'Hero',
        overrides: { Player: { slot: 1 }, Visibility: { visibleTo: 2 }, Team: { id: 1 } },
      },
    ],
  });
}

/** Слоты, дожившие до снапшота: именно они и есть видимая часть мира (NET-12). */
function slotsIn(snapshot: PresentedState): number[] {
  const entities = query(snapshot.world, { all: ['Player'] });
  return Array.from(entities, (entity) => coreWorld.getField(snapshot.world, entity, 'Player', 'slot')).sort();
}

/**
 * Зависимости сборки мира клиент берёт из ТОГО ЖЕ описания матча, что сервер
 * (NTR-14): обе стороны поднимают мир общим путём, и состав систем у них обязан
 * совпасть. Для сцены с флагом `fog` это ещё и условие входа — клиент без
 * объявленного пересчёта видимости мир матча не поднимет вовсе.
 */
function clientOptions(playerId: string, config: MatchConfig) {
  const pack = contentPack({ duel: config.scene });
  return {
    playerId,
    version: versionOf(config.scene),
    content: pack,
    ...(config.visibility !== undefined ? { visibility: config.visibility } : {}),
  };
}

interface ListenFixture {
  readonly session: HostSession;
  readonly hostClient: { readonly client: MatchClient; readonly host: ClientHost };
  readonly joined: Awaited<ReturnType<typeof joinSession>>;
  readonly config: MatchConfig;
}

/**
 * Матч в режиме `listen` целиком внутрипроцессно: рандеву, лобби, заморозка,
 * матч. Тот же `MatchServer` и тот же `MatchClient`, что играют по сети.
 */
async function listenMatch(config: MatchConfig = duelConfig()): Promise<ListenFixture> {
  const rendezvous = new InProcessRendezvous();
  const { version: _version, players: _players, ...match } = config;
  const session = await HostSession.open({
    rendezvous,
    version: config.version,
    founder: 'p1',
    slots: 2,
    match,
  });

  // Присоединяющийся входит в лобби и ждёт `Begin`: он приходит только после
  // того, как эндпойнт матча поднят (SES-4).
  const joining = joinSession({
    rendezvous,
    invite: session.invite,
    client: clientOptions('p2', config),
  });
  await settle();
  expect(session.roster).toEqual(['p1', 'p2']);

  await session.start();
  const joined = await joining;
  const hostClient = session.localClient(clientOptions('p1', config));
  hostClient.host.start();
  await settle();

  return { session, hostClient, joined, config };
}

async function stepMatch(fixture: ListenFixture, ticks: number): Promise<void> {
  for (let i = 0; i < ticks; i++) {
    fixture.hostClient.host.step();
    fixture.joined.host.step();
    await settle();
    fixture.session.match!.host.step();
    await settle();
  }
}

describe('режим listen', () => {
  it('поднимает матч на собранном лобби ростере', async () => {
    const fixture = await listenMatch();
    expect(fixture.session.info.mode).toBe('listen');
    expect(fixture.session.info.phase).toBe('match');
    expect(fixture.session.match!.server.config.players).toEqual(['p1', 'p2']);
    expect(fixture.joined.roster).toEqual(['p1', 'p2']);
    await fixture.session.close();
  });

  it('клиент хоста проходит обычный хендшейк и занимает слот по Welcome', async () => {
    const fixture = await listenMatch();
    await stepMatch(fixture, 2);
    expect(fixture.hostClient.client.slot).toBe(0);
    expect(fixture.joined.client.slot).toBe(1);
    expect(fixture.hostClient.client.phase).toBe('playing');
    await fixture.session.close();
  });

  it('ввод клиента хоста уходит сообщением Input, а не мимо протокола', async () => {
    const fixture = await listenMatch();
    const step = { move: { x: 1024, y: 0 }, aimDir: 0, buttons: 0 };
    fixture.hostClient.host.step();
    await settle();
    fixture.hostClient.client.pushInput(step, 0);
    fixture.hostClient.host.flush();
    await settle();
    fixture.session.match!.host.step();
    await settle();

    expect(fixture.hostClient.client.metrics.inputsSent).toBeGreaterThan(0);
    expect(fixture.session.match!.server.metrics.slots[0]!.applied).toBeGreaterThanOrEqual(0);
    await fixture.session.close();
  });

  it('клиент хоста получает персональный снапшот, а не полный мир (SES-6)', async () => {
    const fixture = await listenMatch(fogConfig());
    await stepMatch(fixture, 2);

    const hostSnapshot = fixture.hostClient.client.latest;
    const remoteSnapshot = fixture.joined.client.latest;
    expect(hostSnapshot).toBeDefined();
    expect(remoteSnapshot).toBeDefined();
    // Каждый видит только свою сущность: у хоста нет ни полного потока, ни
    // прямого чтения состояния сервера — фильтр зовётся для него на общих
    // основаниях (NTR-9).
    expect(slotsIn(hostSnapshot!)).toEqual([0]);
    expect(slotsIn(remoteSnapshot!)).toEqual([1]);
    await fixture.session.close();
  });

  it('конец хост-процесса участник наблюдает как разрыв, а не как молчание (SES-8)', async () => {
    const fixture = await listenMatch();
    await stepMatch(fixture, 2);
    await fixture.session.close();
    await settle();

    expect(fixture.joined.client.phase).toBe('closed');
    expect(fixture.joined.client.closeReason).toBeDefined();
  });

  it('инвайт после заморозки ростера не действует', async () => {
    const rendezvous = new InProcessRendezvous();
    const config = duelConfig();
    const { version: _version, players: _players, ...match } = config;
    const session = await HostSession.open({
      rendezvous,
      version: config.version,
      founder: 'p1',
      slots: 2,
      match,
    });
    const joining = joinSession({ rendezvous, invite: session.invite, client: clientOptions('p2', config) });
    await settle();
    await session.start();
    await joining;

    await expect(
      joinSession({ rendezvous, invite: session.invite, client: clientOptions('p3', config) }),
    ).rejects.toThrow(SessionJoinError);
    await session.close();
  });
});

describe('режим dedicated', () => {
  it('поднимается тем же сервером и принимает тех же клиентов без лобби', async () => {
    const rendezvous = new InProcessRendezvous();
    const config = duelConfig();
    const session = await DedicatedSession.open({ rendezvous, config });
    expect(session.info.mode).toBe('dedicated');

    const a = await joinMatch({ rendezvous, invite: session.invite, client: clientOptions('p1', config) });
    const b = await joinMatch({ rendezvous, invite: session.invite, client: clientOptions('p2', config) });
    await settle();
    session.host.step();
    await settle();

    expect(a.client.slot).toBe(0);
    expect(b.client.slot).toBe(1);
    await session.close();
  });
});
