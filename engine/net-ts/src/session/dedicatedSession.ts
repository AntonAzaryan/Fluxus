/**
 * Сборка режима `dedicated` (`net-session` SES-1): авторитетный цикл отдельным
 * процессом, игроков не содержащим.
 *
 * Файл существует ради того, что в нём не написано. Рядом с `hostSession.ts` он
 * показывает границу различия режимов: она проходит по лобби и по локальному
 * клиенту, и больше нигде — тот же `MatchServer`, тот же `MatchHost`, тот же
 * набор сообщений (SES-2). Лобби здесь нет вовсе, потому что ростер известен из
 * конфига (NTR-6).
 */
import type { Serializer } from '@game-mvp/core';
import { MatchHost } from '../server/host.js';
import { MatchServer, type MatchConfig } from '../server/matchServer.js';
import type { PublishedSession, Rendezvous } from './rendezvous.js';
import { createSessionInfo, type SessionInfo } from './session.js';

export interface DedicatedSessionOptions {
  readonly rendezvous: Rendezvous;
  readonly config: MatchConfig;
  readonly serializer?: Serializer;
}

export class DedicatedSession {
  readonly info: SessionInfo;
  readonly server: MatchServer;
  readonly host: MatchHost;
  /** Инвайт матча: приглашённые идут по нему сразу в матч, минуя фазу лобби. */
  readonly invite: string;

  private readonly published: PublishedSession;

  private constructor(options: DedicatedSessionOptions, published: PublishedSession) {
    this.published = published;
    this.invite = published.invite;
    this.server = new MatchServer(options.config);
    this.host = new MatchHost(this.server, published.transports, {
      ...(options.serializer !== undefined ? { serializer: options.serializer } : {}),
    });
    this.info = createSessionInfo('dedicated', options.rendezvous.name);
    this.info.phase = 'match';
  }

  static async open(options: DedicatedSessionOptions): Promise<DedicatedSession> {
    const published = await options.rendezvous.publish('match');
    return new DedicatedSession(options, published);
  }

  async close(): Promise<void> {
    this.info.phase = 'ended';
    await this.host.stop();
    await this.published.close();
  }
}
