/**
 * Значение инвайта (`net-session` SES-5): адресат и допуск в одном куске,
 * который игрок пересылает целиком.
 *
 * Обе половины обязаны быть внутри, потому что режим `listen` каталога сессий
 * не имеет: сессия существует, пока жив процесс хоста, и опознаётся только
 * предъявленным значением.
 *
 * Криптографии здесь нет и не заявляется. Инвайт подтверждает, что предъявитель
 * получил значение, и ничего сверх этого; аутентификации участников в MVP нет
 * (NTR-9), и `listen` от неё ближе не становится (SES-7).
 */
import { RendezvousError } from './rendezvous.js';
import type { SessionChannel } from './rendezvous.js';

/** Префикс — чтобы чужая строка отсеивалась до разбора, а не разбирался мусор. */
const PREFIX = 'fluxus1.';

export interface InvitePayload {
  /** Реализация рандеву, выдавшая инвайт. Разбирает его только она (SES-3). */
  readonly via: string;
  readonly channel: SessionChannel;
  /** Допуск: проверяется хостом на входе, а не предъявителем (SES-5). */
  readonly token: string;
  /** Адресат. У внутрипроцессного рандеву адреса не существует, и поля нет. */
  readonly url?: string;
  /** Срок жизни, мс эпохи. Хост проверяет свой, это — чтобы предъявитель узнал раньше. */
  readonly expiresAt?: number;
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function fromBase64Url(text: string): Uint8Array {
  const padded = text.replaceAll('-', '+').replaceAll('_', '/');
  const binary = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, '='));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function encodeInvite(payload: InvitePayload): string {
  const json = JSON.stringify(payload);
  return PREFIX + toBase64Url(new TextEncoder().encode(json));
}

export function decodeInvite(invite: string): InvitePayload {
  if (!invite.startsWith(PREFIX)) throw new RendezvousError('инвайт не распознан: чужой префикс');
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder().decode(fromBase64Url(invite.slice(PREFIX.length))));
  } catch (error) {
    throw new RendezvousError(`инвайт не разбирается: ${String(error)}`);
  }
  if (typeof raw !== 'object' || raw === null) throw new RendezvousError('инвайт не разбирается: не объект');
  const source = raw as Record<string, unknown>;
  const via = source['via'];
  const channel = source['channel'];
  const token = source['token'];
  if (typeof via !== 'string' || via === '') throw new RendezvousError('инвайт: поле "via" — непустая строка');
  if (channel !== 'lobby' && channel !== 'match') throw new RendezvousError('инвайт: поле "channel" — lobby или match');
  if (typeof token !== 'string' || token === '') throw new RendezvousError('инвайт: поле "token" — непустая строка');
  const url = source['url'];
  const expiresAt = source['expiresAt'];
  return {
    via,
    channel,
    token,
    ...(typeof url === 'string' ? { url } : {}),
    ...(typeof expiresAt === 'number' ? { expiresAt } : {}),
  };
}
