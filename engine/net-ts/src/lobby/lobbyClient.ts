/**
 * Клиент лобби (`net-session` SES-4): предъявляет инвайт, ждёт ростера, получает
 * адрес поднятого матча.
 *
 * Как и клиент матча — чистый цикл без ввода-вывода: сообщения приходят вызовом,
 * исходящие забираются `drain()`. Ни сокетов, ни часов внутри.
 */
import type { GameVersion } from '../protocol/messages.js';
import type {
  LobbyClientMessage,
  LobbyCloseReason,
  LobbyDenyReason,
  LobbyServerMessage,
} from './messages.js';

export type LobbyClientPhase = 'joining' | 'waiting' | 'begun' | 'closed';

export interface LobbyClientOptions {
  readonly invite: string;
  readonly playerId: string;
  readonly version: GameVersion;
}

/** Почему клиент лобби кончился. Отказ хоста и разрыв канала различены: чинятся по-разному. */
export type LobbyClientOutcome =
  | { readonly kind: 'begun'; readonly invite: string; readonly players: readonly string[] }
  | { readonly kind: 'denied'; readonly reason: LobbyDenyReason; readonly detail: string }
  | { readonly kind: 'closed'; readonly reason: LobbyCloseReason; readonly detail: string }
  | { readonly kind: 'disconnected'; readonly detail: string };

export class LobbyClient {
  private readonly options: LobbyClientOptions;
  private readonly outbox: LobbyClientMessage[] = [];

  private clientPhase: LobbyClientPhase = 'joining';
  private currentRoster: readonly string[] = [];
  private result: LobbyClientOutcome | undefined;

  constructor(options: LobbyClientOptions) {
    this.options = options;
  }

  get phase(): LobbyClientPhase {
    return this.clientPhase;
  }

  get roster(): readonly string[] {
    return this.currentRoster;
  }

  /** Исход. `undefined`, пока лобби идёт. */
  get outcome(): LobbyClientOutcome | undefined {
    return this.result;
  }

  start(): void {
    this.outbox.push({
      type: 'Join',
      invite: this.options.invite,
      playerId: this.options.playerId,
      version: this.options.version,
    });
  }

  receive(message: LobbyServerMessage): void {
    if (this.clientPhase === 'closed' || this.clientPhase === 'begun') return;
    switch (message.type) {
      case 'Joined':
        this.clientPhase = 'waiting';
        this.currentRoster = message.roster;
        break;
      case 'Roster':
        this.currentRoster = message.players;
        break;
      case 'Begin':
        this.currentRoster = message.players;
        this.clientPhase = 'begun';
        this.result = { kind: 'begun', invite: message.invite, players: message.players };
        break;
      case 'Denied':
        this.clientPhase = 'closed';
        this.result = { kind: 'denied', reason: message.reason, detail: message.detail };
        break;
      case 'Closed':
        this.clientPhase = 'closed';
        this.result = { kind: 'closed', reason: message.reason, detail: message.detail };
        break;
    }
  }

  leave(reason = ''): void {
    if (this.clientPhase === 'closed') return;
    this.outbox.push({ type: 'Leave', reason });
    this.clientPhase = 'closed';
    this.result ??= { kind: 'closed', reason: 'cancelled', detail: reason };
  }

  /**
   * Канал закрылся. После `Begin` это штатное завершение фазы — хост закрывает
   * соединение лобби сам (SES-4), — а до него разрыв, и исходы разные.
   */
  onTransportClosed(detail = ''): void {
    if (this.clientPhase === 'begun') return;
    if (this.clientPhase === 'closed') return;
    this.clientPhase = 'closed';
    this.result = { kind: 'disconnected', detail };
  }

  drain(): readonly LobbyClientMessage[] {
    const outgoing = this.outbox.slice();
    this.outbox.length = 0;
    return outgoing;
  }
}
