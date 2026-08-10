/**
 * Лобби: сбор ростера и его заморозка в конфиг матча (`net-session` SES-4).
 *
 * Матча здесь нет — предмет проверки в том, что лобби отдаёт `MatchConfig`,
 * неотличимый от преднастроенного (NTR-6), и что ошибка версии отсекается до
 * заморозки, а не убивает матч целиком.
 */
import { describe, expect, it } from 'vitest';
import { LobbyClient } from '../src/lobby/lobbyClient.js';
import { LobbyClientHost } from '../src/lobby/clientHost.js';
import { LobbyHost } from '../src/lobby/host.js';
import { LobbyServer, type LobbyConfig } from '../src/lobby/lobbyServer.js';
import { InProcessRendezvous } from '../src/session/rendezvous/inProcess.js';
import type { GameVersion } from '../src/protocol/messages.js';
import { BUILD_ID, duelConfig, duelScene, settle, versionOf } from './fixtures.js';

const SCENE = duelScene();
const VERSION = versionOf(SCENE);

function lobbyConfig(invite: string, overrides: Partial<LobbyConfig> = {}): LobbyConfig {
  const { version: _version, players: _players, ...match } = duelConfig({ scene: SCENE });
  return { version: VERSION, founder: 'p1', slots: 2, invite, match, ...overrides };
}

interface Assembled {
  readonly rendezvous: InProcessRendezvous;
  readonly lobby: LobbyServer;
  readonly host: LobbyHost;
  readonly invite: string;
  readonly join: (playerId: string, version?: GameVersion, invite?: string) => Promise<LobbyClientHost>;
}

/** Исход клиента лобби всегда назван — тест читает его без ветвления по форме. */
function outcomeOf(host: LobbyClientHost): { kind: string; reason?: string; detail?: string } {
  const outcome = host.client.outcome;
  expect(outcome).toBeDefined();
  return outcome as { kind: string; reason?: string; detail?: string };
}

async function assemble(overrides: Partial<LobbyConfig> = {}, now = () => 1000): Promise<Assembled> {
  const rendezvous = new InProcessRendezvous();
  const published = await rendezvous.publish('lobby');
  const lobby = new LobbyServer(lobbyConfig(published.invite, overrides));
  const host = new LobbyHost(lobby, published.transports, { now });
  return {
    rendezvous,
    lobby,
    host,
    invite: published.invite,
    join: async (playerId, version = VERSION, invite = published.invite) => {
      const transport = await rendezvous.resolve(published.invite);
      const client = new LobbyClient({ invite, playerId, version });
      const clientHost = new LobbyClientHost(client, transport);
      clientHost.start();
      await settle();
      return clientHost;
    },
  };
}

describe('сбор ростера', () => {
  it('основатель занимает слот 0, принятый — следующий', async () => {
    const { lobby, join } = await assemble();
    expect(lobby.roster).toEqual(['p1']);

    const p2 = await join('p2');
    expect(lobby.roster).toEqual(['p1', 'p2']);
    expect(p2.client.roster).toEqual(['p1', 'p2']);
  });

  it('заморозка даёт конфиг матча, неотличимый от преднастроенного', async () => {
    const { lobby, join } = await assemble();
    await join('p2');

    const config = lobby.freeze();
    expect(config.players).toEqual(['p1', 'p2']);
    expect(config.version).toEqual(VERSION);
    expect(config.seed).toBe(duelConfig({ scene: SCENE }).seed);
    expect(config.sceneRef).toBe('duel');
  });

  it('вторая заморозка означала бы второй состав и запрещена', async () => {
    const { lobby, join } = await assemble();
    await join('p2');
    lobby.freeze();
    expect(() => lobby.freeze()).toThrow();
  });

  it('ушедший до заморозки освобождает слот', async () => {
    const { lobby, join } = await assemble();
    const p2 = await join('p2');
    p2.leave('передумал');
    await settle();
    expect(lobby.roster).toEqual(['p1']);
  });
});

describe('отказы во входе', () => {
  it('расхождение сборки названо своей половиной', async () => {
    const { join } = await assemble();
    const p2 = await join('p2', { buildId: 'другая-сборка', contentPackHash: VERSION.contentPackHash });
    expect(outcomeOf(p2).kind).toBe('denied');
    expect(outcomeOf(p2).reason).toBe('build-mismatch');
  });

  it('расхождение контент-пака названо своей половиной', async () => {
    const { join } = await assemble();
    const p2 = await join('p2', { buildId: BUILD_ID, contentPackHash: 'другой-хеш' });
    expect(outcomeOf(p2).kind).toBe('denied');
    expect(outcomeOf(p2).reason).toBe('content-mismatch');
  });

  it('участник с чужой версией не занимает слот', async () => {
    const { lobby, join } = await assemble();
    await join('p2', { buildId: 'другая-сборка', contentPackHash: VERSION.contentPackHash });
    // Ради этого ранний фильтр и заведён: попав в замороженный ростер, такой
    // участник никогда не прошёл бы `Hello`, и матч не стартовал бы вовсе.
    expect(lobby.roster).toEqual(['p1']);
  });

  it('опоздавший к заморозке получает отказ, а не тихо висит', async () => {
    const { lobby, join } = await assemble();
    await join('p2');
    lobby.freeze();

    const late = await join('p3');
    expect(outcomeOf(late).reason).toBe('lobby-closed');
  });

  it('лишний участник получает отказ по слотам', async () => {
    const { join } = await assemble();
    await join('p2');
    const p3 = await join('p3');
    expect(outcomeOf(p3).reason).toBe('roster-full');
  });

  it('повторный идентификатор игрока отвергается', async () => {
    const { join } = await assemble();
    const twin = await join('p1');
    expect(outcomeOf(twin).reason).toBe('duplicate-player');
  });

  it('не тот инвайт отвергается', async () => {
    const { join } = await assemble();
    const stranger = await join('p2', VERSION, 'fluxus1.чужое');
    expect(outcomeOf(stranger).reason).toBe('invite-invalid');
  });

  it('просроченный инвайт отвергается отдельным исходом', async () => {
    const { join } = await assemble({ expiresAt: 500 }, () => 1000);
    const late = await join('p2');
    expect(outcomeOf(late).reason).toBe('invite-expired');
  });
});

describe('переход к матчу', () => {
  it('Begin уходит только после заморозки', async () => {
    const { lobby } = await assemble();
    expect(() => { lobby.begin('fluxus1.матч'); }).toThrow();
  });

  it('Begin несёт адрес матча и ростер, после чего фаза лобби кончается', async () => {
    const { lobby, host, join } = await assemble();
    const p2 = await join('p2');
    lobby.freeze();
    lobby.begin('fluxus1.матч');
    host.flush();
    await settle();

    expect(p2.client.outcome).toEqual({
      kind: 'begun',
      invite: 'fluxus1.матч',
      players: ['p1', 'p2'],
    });
    expect(lobby.phase).toBe('closed');
  });

  it('разрыв до Begin отличается от закрытия после него', async () => {
    const { join } = await assemble();
    const p2 = await join('p2');
    p2.client.onTransportClosed('канал упал');
    expect(p2.client.outcome).toEqual({ kind: 'disconnected', detail: 'канал упал' });
  });
});
