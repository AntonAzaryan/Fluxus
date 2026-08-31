/**
 * Сообщения сборки демо между главным потоком и воркерами — то, чем стороны
 * договариваются ДО матча.
 *
 * Протоколом матча они не являются и рядом с ним не живут: канал оболочки
 * (`protocol.ts`) и канал матча (`net-ts`) закрыты, и добавлять в них «а ещё
 * бывает такое сообщение» нельзя (SES-2, SHELL-3). Поэтому здесь свои конверты,
 * и каждый несёт ровно то, что нельзя передать иначе: порт участника (его не
 * скопировать — только transfer), адрес стенда и то, что знает про сессию
 * только воркер, — состояние входа и счётчики его клиента.
 */
import type { RawPort } from '@fluxus/bot';

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

/**
 * Воркер → главному потоку: текущий адаптивный запас разметки ввода в тиках
 * (`netcode-transport` NTR-7), он же счётчик клиента `inputLead` (NTR-11).
 *
 * Своим конвертом по той же причине, что и остальные: канал оболочки закрыт
 * (SHELL-3), а величина — клиентская наблюдаемая СБОРКИ, не состояние мира и не
 * доставка. Без неё «вяло, потому что канал длинный» остаётся догадкой: сам
 * `MatchClient` живёт в воркере, и в главный поток его счётчики иначе не едут.
 *
 * Поля нет — матча нет: клиент закрыт концом матча или разрывом, и величины не
 * существует. Форма «нет величины» обязана быть отличима от значения по той же
 * причине, по которой она отличима в самих счётчиках (NTR-11): без неё
 * замороженное на экране число пережило бы матч, о котором говорило.
 */
export interface DemoInputLead {
  readonly t: 'demo-input-lead';
  readonly lead?: number;
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

export function isDemoInputLead(message: unknown): message is DemoInputLead {
  return tagOf(message) === 'demo-input-lead';
}
