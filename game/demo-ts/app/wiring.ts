/**
 * Сообщения сборки демо между главным потоком и воркерами — то, чем стороны
 * договариваются ДО матча.
 *
 * Протоколом матча они не являются и рядом с ним не живут: канал оболочки
 * (`protocol.ts`) и канал матча (`net-ts`) закрыты, и добавлять в них «а ещё
 * бывает такое сообщение» нельзя (SES-2, SHELL-3). Поэтому здесь свои три
 * конверта, и каждый несёт ровно то, что нельзя передать иначе: порт участника
 * (его не скопировать — только transfer) и адрес стенда.
 */
import type { RawPort } from '@game-mvp/bot';

/** Главный поток → воркеру сервера: подними матч вкладки. */
export interface DemoServerInit {
  readonly t: 'demo-server-init';
}

/** Воркер сервера → главному потоку: канал участника, который надо отдать клиенту. */
export interface DemoServerReady {
  readonly t: 'demo-server-ready';
  readonly port: RawPort;
}

/**
 * Главный поток → воркеру клиента: как добраться до сервера матча. Ровно одно
 * из двух — порт матча своей вкладки либо адрес стенда (SES-1).
 */
export interface DemoClientInit {
  readonly t: 'demo-client-init';
  readonly port?: RawPort;
  readonly url?: string;
}

/** Воркер → главному потоку: показать человеку, почему матча нет. */
export interface DemoNotice {
  readonly t: 'demo-notice';
  readonly message: string;
}

function tagOf(message: unknown): string | undefined {
  return typeof message === 'object' && message !== null
    ? (message as { t?: string }).t
    : undefined;
}

export function isDemoServerInit(message: unknown): message is DemoServerInit {
  return tagOf(message) === 'demo-server-init';
}

export function isDemoServerReady(message: unknown): message is DemoServerReady {
  return tagOf(message) === 'demo-server-ready';
}

export function isDemoClientInit(message: unknown): message is DemoClientInit {
  return tagOf(message) === 'demo-client-init';
}

export function isDemoNotice(message: unknown): message is DemoNotice {
  return tagOf(message) === 'demo-notice';
}
