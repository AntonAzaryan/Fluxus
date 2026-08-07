/**
 * Закрытый набор сообщений лобби (`net-session` SES-4). Отдельный от набора
 * матча (NTR-4) и на отдельном соединении: выделенный сервер с преднастроенным
 * ростером обязан работать без лобби вовсе, а тип, недопустимый в половине
 * сборок, — это согласование возможностей в рантайме под другим именем.
 *
 * Правила те же, что у набора матча, и повторены не по инерции: сообщение
 * неизвестного типа, сообщение не своего направления и сообщение, недопустимое
 * в текущей фазе, рвут соединение с названным исходом и молча не игнорируются.
 *
 * `playerId` в `Join` есть, а в остальных сообщениях нет по той же причине, по
 * которой его нет в кадре ввода: дальше личность даёт соединение, а не
 * содержимое сообщения.
 */
import type { GameVersion } from '../protocol/messages.js';

/**
 * Исходы отказа во входе в лобби. Половины версии названы отдельно теми же
 * исходами, что в хендшейке матча (NTR-5): проверка здесь — ранний фильтр, а не
 * замена, и разные названия одного и того же для игрока были бы разными
 * действиями там, где действие одно.
 */
export type LobbyDenyReason =
  | 'build-mismatch'
  | 'content-mismatch'
  | 'invite-invalid'
  | 'invite-expired'
  | 'lobby-closed'
  | 'roster-full'
  | 'duplicate-player'
  | 'protocol-error';

export type LobbyCloseReason = 'started' | 'cancelled' | 'founder-left';

// ------------------------------------------------------------ client → lobby

export interface JoinMessage {
  readonly type: 'Join';
  /** Предъявленный инвайт целиком: разбирает его рандеву, лобби только сверяет (SES-3, SES-5). */
  readonly invite: string;
  readonly playerId: string;
  readonly version: GameVersion;
}

export interface LeaveMessage {
  readonly type: 'Leave';
  readonly reason: string;
}

export type LobbyClientMessage = JoinMessage | LeaveMessage;

// ------------------------------------------------------------ lobby → client

export interface JoinedMessage {
  readonly type: 'Joined';
  readonly playerId: string;
  readonly roster: readonly string[];
}

export interface DeniedMessage {
  readonly type: 'Denied';
  readonly reason: LobbyDenyReason;
  readonly detail: string;
}

export interface RosterMessage {
  readonly type: 'Roster';
  readonly players: readonly string[];
}

/**
 * Ростер заморожен, сервер матча поднят. Несёт инвайт матча — второе значение
 * рандеву; соединение лобби после этого закрывается, а участник открывает
 * соединение матча и шлёт обычный `Hello` (SES-4).
 */
export interface BeginMessage {
  readonly type: 'Begin';
  readonly invite: string;
  readonly players: readonly string[];
}

export interface ClosedMessage {
  readonly type: 'Closed';
  readonly reason: LobbyCloseReason;
  readonly detail: string;
}

export type LobbyServerMessage =
  | JoinedMessage
  | DeniedMessage
  | RosterMessage
  | BeginMessage
  | ClosedMessage;

// ------------------------------------------------------------------- разбор

export class LobbyProtocolError extends Error {
  readonly reason: LobbyDenyReason;

  constructor(message: string, reason: LobbyDenyReason = 'protocol-error') {
    super(message);
    this.name = 'LobbyProtocolError';
    this.reason = reason;
  }
}

function object(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new LobbyProtocolError(`${what}: ожидался объект`);
  }
  return value as Record<string, unknown>;
}

function str(source: Record<string, unknown>, key: string, what: string): string {
  const value = source[key];
  if (typeof value !== 'string' || value === '') {
    throw new LobbyProtocolError(`${what}: поле "${key}" — непустая строка`);
  }
  return value;
}

function names(value: unknown, what: string): readonly string[] {
  if (!Array.isArray(value) || value.some((name) => typeof name !== 'string')) {
    throw new LobbyProtocolError(`${what}: ожидался массив строк`);
  }
  return value as readonly string[];
}

function version(value: unknown): GameVersion {
  const source = object(value, 'Join.version');
  return {
    buildId: str(source, 'buildId', 'Join.version'),
    contentPackHash: str(source, 'contentPackHash', 'Join.version'),
  };
}

export function parseLobbyClientMessage(value: unknown): LobbyClientMessage {
  const source = object(value, 'сообщение лобби');
  switch (source['type']) {
    case 'Join':
      return {
        type: 'Join',
        invite: str(source, 'invite', 'Join'),
        playerId: str(source, 'playerId', 'Join'),
        version: version(source['version']),
      };
    case 'Leave':
      return { type: 'Leave', reason: typeof source['reason'] === 'string' ? source['reason'] : '' };
    default:
      throw new LobbyProtocolError(`неизвестный тип сообщения лобби: ${JSON.stringify(source['type'])}`);
  }
}

export function parseLobbyServerMessage(value: unknown): LobbyServerMessage {
  const source = object(value, 'сообщение лобби');
  switch (source['type']) {
    case 'Joined':
      return {
        type: 'Joined',
        playerId: str(source, 'playerId', 'Joined'),
        roster: names(source['roster'], 'Joined.roster'),
      };
    case 'Denied':
      return {
        type: 'Denied',
        reason: denyReason(source['reason']),
        detail: typeof source['detail'] === 'string' ? source['detail'] : '',
      };
    case 'Roster':
      return { type: 'Roster', players: names(source['players'], 'Roster.players') };
    case 'Begin':
      return {
        type: 'Begin',
        invite: str(source, 'invite', 'Begin'),
        players: names(source['players'], 'Begin.players'),
      };
    case 'Closed':
      return {
        type: 'Closed',
        reason: closeReason(source['reason']),
        detail: typeof source['detail'] === 'string' ? source['detail'] : '',
      };
    default:
      throw new LobbyProtocolError(`неизвестный тип сообщения лобби: ${JSON.stringify(source['type'])}`);
  }
}

const DENY_REASONS: readonly string[] = [
  'build-mismatch',
  'content-mismatch',
  'invite-invalid',
  'invite-expired',
  'lobby-closed',
  'roster-full',
  'duplicate-player',
  'protocol-error',
];

const CLOSE_REASONS: readonly string[] = ['started', 'cancelled', 'founder-left'];

function denyReason(value: unknown): LobbyDenyReason {
  if (typeof value !== 'string' || !DENY_REASONS.includes(value)) {
    throw new LobbyProtocolError(`Denied: неизвестный исход ${JSON.stringify(value)}`);
  }
  return value as LobbyDenyReason;
}

function closeReason(value: unknown): LobbyCloseReason {
  if (typeof value !== 'string' || !CLOSE_REASONS.includes(value)) {
    throw new LobbyProtocolError(`Closed: неизвестный исход ${JSON.stringify(value)}`);
  }
  return value as LobbyCloseReason;
}
