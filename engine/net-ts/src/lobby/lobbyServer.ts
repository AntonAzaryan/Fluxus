/**
 * Лобби: сбор ростера до старта матча (`net-session` SES-4).
 *
 * Форма та же, что у `MatchServer` (NTR-3), и по той же причине: чистый цикл без
 * ввода-вывода — сообщения приходят вызовом, исходящие забираются `drain()`,
 * момент времени приезжает аргументом. Ни сокетов, ни таймеров, ни системных
 * часов внутри; связка с транспортом живёт в `LobbyHost`.
 *
 * Результат лобби — готовый `MatchConfig`. Сервер матча о лобби не знает: он
 * принимает конфиг и не различает, преднастроен тот запускалкой или собран
 * здесь (NTR-6).
 */
import type { GameVersion } from '../protocol/messages.js';
import type { MatchConfig } from '../server/matchServer.js';
import type { ConnectionId } from '../transport/transport.js';
import {
  type LobbyClientMessage,
  type LobbyCloseReason,
  type LobbyDenyReason,
  type LobbyServerMessage,
} from './messages.js';

export interface LobbyConfig {
  /** Версия матча — версия сборки основателя (NET-16). Сверяется ранним фильтром. */
  readonly version: GameVersion;
  /** Основатель занимает слот 0. Это следствие порядка приёма, а не привилегия. */
  readonly founder: string;
  /** Число слотов матча, включая основателя (NTR-6). */
  readonly slots: number;
  /** Опубликованный инвайт целиком: сверяется равенством, разбирает его рандеву (SES-3). */
  readonly invite: string;
  /** Срок жизни инвайта, мс эпохи (SES-5). Без него инвайт живёт до заморозки. */
  readonly expiresAt?: number;
  /** Всё, что уедет в `MatchConfig` как есть: сцена, seed, расстановка, темп, зависимости сборки. */
  readonly match: Omit<MatchConfig, 'version' | 'players'>;
}

export type LobbyPhase = 'open' | 'frozen' | 'closed';

export interface LobbyOutgoing {
  readonly to: ConnectionId;
  readonly message: LobbyServerMessage;
  readonly closeAfter: boolean;
}

interface LobbyConnection {
  readonly id: ConnectionId;
  /** До `Join` участник безымянен: личность даёт принятое сообщение, дальше — соединение. */
  playerId: string | undefined;
}

export class LobbyServer {
  readonly config: LobbyConfig;

  private lobbyPhase: LobbyPhase = 'open';
  private readonly connections = new Map<ConnectionId, LobbyConnection>();
  private readonly joined: string[] = [];
  private readonly outbox: LobbyOutgoing[] = [];

  constructor(config: LobbyConfig) {
    this.config = config;
  }

  get phase(): LobbyPhase {
    return this.lobbyPhase;
  }

  /** Ростер в порядке слотов: основатель, затем принятые в порядке принятия. */
  get roster(): readonly string[] {
    return [this.config.founder, ...this.joined];
  }

  get isFull(): boolean {
    return this.roster.length >= this.config.slots;
  }

  connect(id: ConnectionId): void {
    this.connections.set(id, { id, playerId: undefined });
  }

  receive(id: ConnectionId, message: LobbyClientMessage, now: number): void {
    const connection = this.connections.get(id);
    if (connection === undefined) return;
    if (message.type === 'Join') this.join(connection, message.invite, message.playerId, message.version, now);
    else this.leave(connection);
  }

  /** Разбор не прошёл или сообщение недопустимо в фазе: назвать и разорвать (SES-4). */
  protocolError(id: ConnectionId, reason: LobbyDenyReason, detail: string): void {
    this.deny(id, reason, detail);
  }

  disconnect(id: ConnectionId): void {
    const connection = this.connections.get(id);
    if (connection === undefined) return;
    this.connections.delete(id);
    // После заморозки состав неизменен (NTR-6): разрыв соединения лобби уже
    // ничего не решает — участник числится в ростере и опаздывает к матчу.
    if (this.lobbyPhase !== 'open' || connection.playerId === undefined) return;
    const at = this.joined.indexOf(connection.playerId);
    if (at >= 0) this.joined.splice(at, 1);
    this.broadcastRoster();
  }

  drain(): readonly LobbyOutgoing[] {
    const outgoing = this.outbox.slice();
    this.outbox.length = 0;
    return outgoing;
  }

  /**
   * Замораживает ростер и отдаёт конфиг матча. Один раз: после заморозки состав
   * MUST NOT меняться, и вторая заморозка означала бы второй состав.
   */
  freeze(): MatchConfig {
    if (this.lobbyPhase !== 'open') throw new Error('LobbyServer: ростер уже заморожен');
    this.lobbyPhase = 'frozen';
    return { ...this.config.match, version: this.config.version, players: this.roster };
  }

  /**
   * Матч поднят — рассылает адрес. Зовётся только после того, как эндпойнт
   * матча существует: участник, узнавший адрес раньше, постучится в пустоту.
   */
  begin(matchInvite: string): void {
    if (this.lobbyPhase !== 'frozen') throw new Error('LobbyServer: матч начинается после заморозки ростера');
    const players = this.roster;
    for (const connection of this.connections.values()) {
      if (connection.playerId === undefined) continue;
      this.outbox.push({
        to: connection.id,
        message: { type: 'Begin', invite: matchInvite, players },
        closeAfter: true,
      });
    }
    this.lobbyPhase = 'closed';
    this.connections.clear();
  }

  close(reason: LobbyCloseReason, detail = ''): void {
    if (this.lobbyPhase === 'closed') return;
    this.lobbyPhase = 'closed';
    for (const connection of this.connections.values()) {
      this.outbox.push({ to: connection.id, message: { type: 'Closed', reason, detail }, closeAfter: true });
    }
    this.connections.clear();
  }

  // ------------------------------------------------------------------ приём

  private join(
    connection: LobbyConnection,
    invite: string,
    playerId: string,
    version: GameVersion,
    now: number,
  ): void {
    if (connection.playerId !== undefined) {
      this.deny(connection.id, 'protocol-error', 'повторный Join на том же соединении');
      return;
    }
    if (this.lobbyPhase !== 'open') {
      this.deny(connection.id, 'lobby-closed', 'ростер уже заморожен');
      return;
    }
    if (invite !== this.config.invite) {
      this.deny(connection.id, 'invite-invalid', 'предъявлен не тот инвайт');
      return;
    }
    if (this.config.expiresAt !== undefined && now >= this.config.expiresAt) {
      this.deny(connection.id, 'invite-expired', 'срок инвайта истёк');
      return;
    }
    // Ранний фильтр версии. Хендшейк матча свою сверку сохраняет полностью
    // (NTR-5) и остаётся единственной нормативной; здесь она нужна потому, что
    // участник с чужой версией, попавший в замороженный ростер, никогда не
    // пройдёт `Hello`, и матч не стартует вовсе (NTR-6).
    if (version.buildId !== this.config.version.buildId) {
      this.deny(connection.id, 'build-mismatch', 'сборка участника отличается от сборки матча');
      return;
    }
    if (version.contentPackHash !== this.config.version.contentPackHash) {
      this.deny(connection.id, 'content-mismatch', 'контент-пак участника отличается от контент-пака матча');
      return;
    }
    if (this.roster.includes(playerId)) {
      this.deny(connection.id, 'duplicate-player', `игрок "${playerId}" уже в ростере`);
      return;
    }
    if (this.isFull) {
      this.deny(connection.id, 'roster-full', 'свободных слотов нет');
      return;
    }

    connection.playerId = playerId;
    this.joined.push(playerId);
    this.outbox.push({
      to: connection.id,
      message: { type: 'Joined', playerId, roster: this.roster },
      closeAfter: false,
    });
    this.broadcastRoster(connection.id);
  }

  private leave(connection: LobbyConnection): void {
    this.connections.delete(connection.id);
    if (this.lobbyPhase === 'open' && connection.playerId !== undefined) {
      const at = this.joined.indexOf(connection.playerId);
      if (at >= 0) this.joined.splice(at, 1);
      this.broadcastRoster();
    }
  }

  private deny(id: ConnectionId, reason: LobbyDenyReason, detail: string): void {
    this.connections.delete(id);
    this.outbox.push({ to: id, message: { type: 'Denied', reason, detail }, closeAfter: true });
  }

  private broadcastRoster(except?: ConnectionId): void {
    const players = this.roster;
    for (const connection of this.connections.values()) {
      if (connection.playerId === undefined || connection.id === except) continue;
      this.outbox.push({ to: connection.id, message: { type: 'Roster', players }, closeAfter: false });
    }
  }
}
