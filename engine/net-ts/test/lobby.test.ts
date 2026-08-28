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
import { lobbyClientCodec } from '../src/lobby/codec.js';
import {
  LobbyProtocolError,
  parseLobbyClientMessage,
  parseLobbyServerMessage,
  type LobbyServerMessage,
} from '../src/lobby/messages.js';
import { DEFAULT_SERIALIZER } from '../src/protocol/codec.js';
import { InProcessRendezvous } from '../src/session/rendezvous/inProcess.js';
import { loopbackPair } from '../src/transport/loopback.js';
import type { Transport } from '../src/transport/transport.js';
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
  /** Голое соединение лобби без клиента: нужно тестам, пишущим в канал кадр руками. */
  readonly raw: () => Promise<Transport>;
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
    raw: () => rendezvous.resolve(published.invite),
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

/**
 * Закрытие лобби — исход, который участнику НАЗЫВАЮТ, а не разрыв канала
 * (SES-4). Разница видна с той стороны: отменённый сбор чинится повторным
 * приглашением, упавший канал — переподключением, и клиент лобби эти исходы
 * различает (`LobbyClientOutcome`).
 */
describe('закрытие лобби', () => {
  it('отмена доходит до участника названным исходом (SES-4)', async () => {
    const { lobby, host, join } = await assemble();
    const p2 = await join('p2');

    lobby.close('cancelled', 'основатель передумал');
    host.flush();
    await settle();

    expect(p2.client.outcome).toEqual({
      kind: 'closed',
      reason: 'cancelled',
      detail: 'основатель передумал',
    });
    expect(lobby.phase).toBe('closed');
  });

  it('уход основателя — свой исход, а не отмена', async () => {
    const { host, join, lobby } = await assemble();
    const p2 = await join('p2');

    lobby.close('founder-left');
    host.flush();
    await settle();

    // Пояснения нет, а исход всё равно назван: пустая строка — это «сказать
    // нечего сверх причины», а не отсутствие причины.
    expect(p2.client.outcome).toEqual({ kind: 'closed', reason: 'founder-left', detail: '' });
  });

  it('после Begin закрывать уже нечего: исход участника остаётся begun', async () => {
    const { lobby, host, join } = await assemble();
    const p2 = await join('p2');
    lobby.freeze();
    lobby.begin('fluxus1.матч');
    host.flush();
    await settle();

    lobby.close('cancelled');
    host.flush();
    await settle();

    // Соединение лобби закрывается на переходе к матчу самим хостом (SES-4), и
    // это закрытие — штатное завершение фазы, а не разрыв: подменить уже
    // полученный адрес матча отменой оно не вправе.
    expect(p2.client.outcome).toEqual({
      kind: 'begun',
      invite: 'fluxus1.матч',
      players: ['p1', 'p2'],
    });
  });
});

describe('ростер в ходе сбора', () => {
  it('уже принятый узнаёт о следующем', async () => {
    const { join } = await assemble({ slots: 3 });
    const p2 = await join('p2');
    expect(p2.client.roster).toEqual(['p1', 'p2']);

    const p3 = await join('p3');
    // Вошедший узнаёт состав из своего `Joined`, остальные — рассылкой ростера;
    // видят они при этом одно и то же.
    expect(p3.client.roster).toEqual(['p1', 'p2', 'p3']);
    expect(p2.client.roster).toEqual(['p1', 'p2', 'p3']);
  });

  it('ушедший исчезает из ростера оставшихся', async () => {
    const { join, lobby } = await assemble({ slots: 3 });
    const p2 = await join('p2');
    const p3 = await join('p3');

    p3.leave('передумал');
    await settle();

    expect(lobby.roster).toEqual(['p1', 'p2']);
    expect(p2.client.roster).toEqual(['p1', 'p2']);
  });
});

/**
 * Набор сообщений лобби закрыт (SES-4), и правила у него те же, что у набора
 * матча (NTR-4): неизвестный тип, сообщение не своего направления и неизвестное
 * значение исхода рвут соединение с названной причиной, а не проходят молча.
 * Проверяются они здесь и разбором напрямую, и через канал — тем же кодеком,
 * которым лобби говорит в бою.
 */
describe('кадр лобби', () => {
  const codec = lobbyClientCodec();

  it('круг серверных сообщений через кодек лобби', () => {
    const messages: readonly LobbyServerMessage[] = [
      { type: 'Joined', playerId: 'p2', roster: ['p1', 'p2'] },
      { type: 'Roster', players: ['p1', 'p2', 'p3'] },
      { type: 'Denied', reason: 'roster-full', detail: 'свободных слотов нет' },
      { type: 'Begin', invite: 'fluxus1.матч', players: ['p1', 'p2'] },
      { type: 'Closed', reason: 'founder-left', detail: '' },
    ];
    for (const message of messages) {
      expect(codec.decode(DEFAULT_SERIALIZER.encode(message))).toEqual(message);
    }
  });

  it('сообщение не своего направления отвергается', () => {
    // `Joined` — серверное, `Join` — клиентское; каждое направление знает только своё.
    expect(() => parseLobbyClientMessage({ type: 'Joined', playerId: 'p2', roster: [] }))
      .toThrow(LobbyProtocolError);
    expect(() => parseLobbyServerMessage({ type: 'Join', invite: 'fluxus1.лобби', playerId: 'p2' }))
      .toThrow(LobbyProtocolError);
  });

  it('неизвестный исход отказа и закрытия не проходит молча', () => {
    // Исход — закрытое перечисление, а не строка: сборка, придумавшая себе новую
    // причину, обязана быть отвергнутой здесь, а не показана игроку как есть.
    expect(() => parseLobbyServerMessage({ type: 'Denied', reason: 'надоел', detail: '' }))
      .toThrow(LobbyProtocolError);
    expect(() => parseLobbyServerMessage({ type: 'Closed', reason: 'разошлись', detail: '' }))
      .toThrow(LobbyProtocolError);
  });

  it('битые байты дают LobbyProtocolError, а не падение сериализатора наружу', () => {
    expect(() => codec.decode(Uint8Array.from([0xc1, 0xff, 0xff]))).toThrow(LobbyProtocolError);
  });

  it('узнанный тип не той формы отвергается тем же исходом', () => {
    // Тип узнан, а поля нет либо оно не той природы: верить такому кадру нельзя
    // ровно так же, как кадру неизвестного типа.
    expect(() => parseLobbyClientMessage({ type: 'Join', invite: 'fluxus1.лобби', version: {} }))
      .toThrow(LobbyProtocolError);
    expect(() => parseLobbyServerMessage({ type: 'Roster', players: ['p1', 7] }))
      .toThrow(LobbyProtocolError);
    expect(() => parseLobbyServerMessage('не объект')).toThrow(LobbyProtocolError);
  });

  it('отказ разбора несёт исход, а не один текст', () => {
    // `LobbyHost` берёт из ошибки именно `reason` и им отвечает — умолчание
    // здесь и есть тот самый `protocol-error`, который увидит предъявитель.
    const error = new LobbyProtocolError('кадр не разбирается');
    expect(error.reason).toBe('protocol-error');
    expect(error.name).toBe('LobbyProtocolError');
    expect(new LobbyProtocolError('чужой инвайт', 'invite-invalid').reason).toBe('invite-invalid');
  });

  it('неизвестный тип от участника рвёт соединение названным исходом (SES-4)', async () => {
    const { lobby, raw } = await assemble();
    const transport = await raw();
    const seen: LobbyServerMessage[] = [];
    transport.onMessage((bytes) => { seen.push(codec.decode(bytes)); });

    transport.send(DEFAULT_SERIALIZER.encode({ type: 'Cheat', slots: 99 }));
    await settle();

    const [denied] = seen;
    expect(denied).toMatchObject({ type: 'Denied', reason: 'protocol-error' });
    expect(transport.isClosed).toBe(true);
    // И слот такой предъявитель не занимает: до `Join` он безымянен.
    expect(lobby.roster).toEqual(['p1']);
  });

  it('неизвестный исход в Closed не становится исходом клиента, а рвёт канал', async () => {
    const [lobbySide, clientSide] = loopbackPair();
    const client = new LobbyClient({ invite: 'fluxus1.лобби', playerId: 'p2', version: VERSION });
    const clientHost = new LobbyClientHost(client, clientSide);
    clientHost.start();
    await settle();

    lobbySide.send(DEFAULT_SERIALIZER.encode({ type: 'Closed', reason: 'разошлись', detail: '' }));
    await settle();

    // Разрыв, а не `closed`: исход, которого клиент не знает, — это рассогласование
    // версий, и назвать его закрытием значило бы соврать про причину.
    expect(outcomeOf(clientHost).kind).toBe('disconnected');
    expect(clientSide.isClosed).toBe(true);
  });
});
