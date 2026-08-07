/**
 * Сборка режима `listen` (`net-session` SES-1): авторитетный цикл исполняется в
 * процессе игрока-хоста.
 *
 * Ничего нового про матч здесь нет и быть не может. Это тот же `MatchServer`
 * (NTR-3) с тем же `MatchHost`, и собственный клиент хоста — тот же
 * `MatchClient` с тем же `ClientHost`, подключённый внутрипроцессным
 * транспортом (SES-6). Различие с `dedicated` целиком укладывается в этот файл:
 * там, где выделенная сборка поднимает только сервер, здесь поднимаются лобби,
 * сервер и рядом один локальный клиент.
 *
 * Соблазн, который здесь дешевле всего поддаться: сервер и клиент хоста живут в
 * одном процессе, и прямой вызов между ними выглядит оптимизацией. Он ею не
 * является — это второй путь исполнения, которого нет ни у одного удалённого
 * участника, и loopback остаётся асинхронным и копирующим (NTR-2).
 */
import type { Serializer } from '@game-mvp/core';
import { ClientHost, type ClientHostOptions } from '../client/host.js';
import { MatchClient, type MatchClientOptions } from '../client/matchClient.js';
import { LobbyHost } from '../lobby/host.js';
import { LobbyServer, type LobbyConfig } from '../lobby/lobbyServer.js';
import type { GameVersion } from '../protocol/messages.js';
import { MatchHost } from '../server/host.js';
import { MatchServer, type MatchConfig } from '../server/matchServer.js';
import { LoopbackHub } from '../transport/loopback.js';
import { mergeTransportServers } from '../transport/merged.js';
import type { Transport } from '../transport/transport.js';
import type { PublishedSession, Rendezvous } from './rendezvous.js';
import { createSessionInfo, type SessionInfo } from './session.js';

export interface HostSessionOptions {
  readonly rendezvous: Rendezvous;
  /** Версия матча — версия сборки основателя (NET-16). */
  readonly version: GameVersion;
  /** Идентификатор игрока-хоста. Занимает слот 0 порядком приёма, а не привилегией. */
  readonly founder: string;
  /** Число слотов, включая основателя (NTR-6). */
  readonly slots: number;
  /** Данные матча: сцена, seed, расстановка, темп, зависимости сборки мира (NTR-14). */
  readonly match: Omit<MatchConfig, 'version' | 'players'>;
  readonly serializer?: Serializer;
  readonly now?: () => number;
  /** Срок жизни инвайта лобби, мс эпохи (SES-5). */
  readonly inviteExpiresAt?: number;
}

export interface StartedMatch {
  readonly server: MatchServer;
  readonly host: MatchHost;
}

export class HostSession {
  readonly info: SessionInfo;
  /** Инвайт лобби — то, что основатель рассылает приглашённым. */
  readonly invite: string;
  readonly lobby: LobbyServer;
  readonly lobbyHost: LobbyHost;

  private readonly options: HostSessionOptions;
  private readonly publishedLobby: PublishedSession;
  private readonly localHub = new LoopbackHub();
  private publishedMatch: PublishedSession | undefined;
  private started: StartedMatch | undefined;

  private constructor(
    options: HostSessionOptions,
    publishedLobby: PublishedSession,
    lobby: LobbyServer,
    lobbyHost: LobbyHost,
  ) {
    this.options = options;
    this.publishedLobby = publishedLobby;
    this.invite = publishedLobby.invite;
    this.lobby = lobby;
    this.lobbyHost = lobbyHost;
    this.info = createSessionInfo('listen', options.rendezvous.name);
    this.info.phase = 'lobby';
  }

  static async open(options: HostSessionOptions): Promise<HostSession> {
    const published = await options.rendezvous.publish('lobby');
    const config: LobbyConfig = {
      version: options.version,
      founder: options.founder,
      slots: options.slots,
      invite: published.invite,
      ...(options.inviteExpiresAt !== undefined ? { expiresAt: options.inviteExpiresAt } : {}),
      match: options.match,
    };
    const lobby = new LobbyServer(config);
    const lobbyHost = new LobbyHost(lobby, published.transports, {
      ...(options.serializer !== undefined ? { serializer: options.serializer } : {}),
      ...(options.now !== undefined ? { now: options.now } : {}),
    });
    return new HostSession(options, published, lobby, lobbyHost);
  }

  get roster(): readonly string[] {
    return this.lobby.roster;
  }

  get match(): StartedMatch | undefined {
    return this.started;
  }

  /**
   * Морозит ростер и поднимает матч. `Begin` уходит последним — только после
   * того, как эндпойнт матча существует: участник, узнавший адрес раньше,
   * постучался бы в пустоту (SES-4).
   */
  async start(): Promise<StartedMatch> {
    if (this.started !== undefined) return this.started;
    this.info.phase = 'starting';
    const config = this.lobby.freeze();
    const published = await this.options.rendezvous.publish('match');
    this.publishedMatch = published;

    const server = new MatchServer(config);
    const host = new MatchHost(server, mergeTransportServers(this.localHub, published.transports), {
      ...(this.options.serializer !== undefined ? { serializer: this.options.serializer } : {}),
    });
    this.started = { server, host };

    this.lobby.begin(published.invite);
    this.lobbyHost.flush();
    this.info.phase = 'match';
    return this.started;
  }

  /** Канал собственного клиента хоста. Внутрипроцессный — и только этим он отличается (SES-6). */
  connectLocal(): Transport {
    if (this.started === undefined) throw new Error('HostSession: матч ещё не поднят');
    return this.localHub.connect();
  }

  /**
   * Собственный клиент хоста: тот же `MatchClient`, тот же хендшейк, тот же
   * персональный снапшот. Привилегий нет ни одной — ни полного потока, ни пути
   * ввода в обход сообщения `Input` (SES-6).
   */
  localClient(
    clientOptions: MatchClientOptions,
    hostOptions: ClientHostOptions = {},
  ): { readonly client: MatchClient; readonly host: ClientHost } {
    const client = new MatchClient(clientOptions);
    const host = new ClientHost(client, this.connectLocal(), {
      ...(this.options.serializer !== undefined ? { serializer: this.options.serializer } : {}),
      ...hostOptions,
    });
    return { client, host };
  }

  async close(): Promise<void> {
    this.info.phase = 'ended';
    this.lobby.close('cancelled');
    this.lobbyHost.flush();
    if (this.started !== undefined) await this.started.host.stop();
    await this.publishedMatch?.close();
    await this.publishedLobby.close();
    await this.localHub.close();
  }
}
