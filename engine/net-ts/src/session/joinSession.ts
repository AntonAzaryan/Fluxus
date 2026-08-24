/**
 * Сборка стороны присоединяющегося (`net-session` SES-3, SES-4).
 *
 * Два входа, потому что фаз сбора ростера бывает две: `joinSession` — по инвайту
 * лобби (матч по приглашению), `joinMatch` — прямо в поднятый матч
 * (преднастроенный ростер). После этого различий нет: обе дороги кончаются тем
 * же `MatchClient` с тем же `Hello` (NTR-5), и режим сессии до него не доходит
 * (SES-2).
 */
import type { Serializer } from '@fluxus/core';
import { ClientHost, type ClientHostOptions } from '../client/host.js';
import { MatchClient, type MatchClientOptions } from '../client/matchClient.js';
import { LobbyClientHost } from '../lobby/clientHost.js';
import { LobbyClient } from '../lobby/lobbyClient.js';
import type { LobbyClientOutcome } from '../lobby/lobbyClient.js';
import type { Transport } from '../transport/transport.js';
import type { Rendezvous } from './rendezvous.js';
import { createSessionInfo, type SessionInfo, type SessionMode } from './session.js';

/** Исходы лобби, кроме удачного. Тип отказа — то, что осталось, а не отдельный перечень. */
export type LobbyFailure = Exclude<LobbyClientOutcome, { kind: 'begun' }>;

/** Присоединиться не удалось. Несёт исход фазы лобби целиком: он и есть объяснение. */
export class SessionJoinError extends Error {
  readonly outcome: LobbyFailure;

  constructor(outcome: LobbyFailure) {
    super(
      outcome.kind === 'denied'
        ? `лобби отказало: ${outcome.reason} — ${outcome.detail}`
        : outcome.kind === 'closed'
          ? `лобби закрыто: ${outcome.reason} — ${outcome.detail}`
          : `связь с лобби потеряна: ${outcome.detail}`,
    );
    this.name = 'SessionJoinError';
    this.outcome = outcome;
  }
}

export interface JoinedMatch {
  readonly info: SessionInfo;
  readonly client: MatchClient;
  readonly host: ClientHost;
  readonly transport: Transport;
  /** Ростер, названный лобби. У прямого входа в матч его нет — он приедет в `Welcome`. */
  readonly roster: readonly string[] | undefined;
}

export interface JoinMatchOptions {
  readonly rendezvous: Rendezvous;
  /** Инвайт матча: из приглашения к выделенному матчу либо из `Begin` лобби. */
  readonly invite: string;
  readonly client: MatchClientOptions;
  readonly serializer?: Serializer;
  readonly clientHost?: ClientHostOptions;
  /**
   * Режим, для которого собран этот участник. Величина сборки, а не провода:
   * присоединяющийся не отличает `listen` от `dedicated` и не должен (SES-1).
   */
  readonly mode?: SessionMode;
}

export interface JoinSessionOptions extends Omit<JoinMatchOptions, 'invite'> {
  /** Инвайт лобби. */
  readonly invite: string;
}

/** Прямо в поднятый матч: преднастроенный ростер, фазы лобби нет. */
export async function joinMatch(options: JoinMatchOptions): Promise<JoinedMatch> {
  const info = createSessionInfo(options.mode ?? 'dedicated', options.rendezvous.name);
  info.phase = 'starting';
  const transport = await options.rendezvous.resolve(options.invite);
  const client = new MatchClient(options.client);
  const host = new ClientHost(client, transport, {
    ...(options.serializer !== undefined ? { serializer: options.serializer } : {}),
    ...options.clientHost,
  });
  host.start();
  info.phase = 'match';
  return { info, client, host, transport, roster: undefined };
}

/** По инвайту лобби: сбор ростера, затем тот же матч тем же клиентом. */
export async function joinSession(options: JoinSessionOptions): Promise<JoinedMatch> {
  const info = createSessionInfo(options.mode ?? 'listen', options.rendezvous.name);
  info.phase = 'lobby';

  const lobbyTransport = await options.rendezvous.resolve(options.invite);
  const lobbyClient = new LobbyClient({
    invite: options.invite,
    playerId: options.client.playerId,
    version: options.client.version,
  });
  const lobbyHost = new LobbyClientHost(lobbyClient, lobbyTransport, {
    ...(options.serializer !== undefined ? { serializer: options.serializer } : {}),
  });
  lobbyHost.start();

  const outcome = await lobbyHost.outcome();
  if (outcome.kind !== 'begun') {
    info.phase = 'ended';
    throw new SessionJoinError(outcome);
  }

  const joined = await joinMatch({
    ...options,
    invite: outcome.invite,
    mode: options.mode ?? 'listen',
  });
  // `info` заводится до фазы лобби, поэтому наблюдаемой остаётся вся дорога, а
  // не только её конец: зависшее подключение обязано называть, где встало (SES-9).
  info.phase = joined.info.phase;
  return { ...joined, info, roster: outcome.players };
}
