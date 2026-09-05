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
 *
 * Плюс — ДОКУМЕНТЫ контент-пака (`game-content` CONT-5, design D4): читает их
 * главный поток, один раз, из раздачи оболочки (`match.ts`), и раздаёт сторонам
 * структурным клоном. Три чтения одного живого дерева увидели бы две его версии,
 * а версия матча (NET-16) обязана быть одна на всю страницу.
 */
import type { RawPort } from '@fluxus/bot';
import type { DemoDocuments } from './match.js';

/** Главный поток → воркеру сервера: подними матч вкладки по этим документам. */
export interface DemoServerInit {
  readonly t: 'demo-server-init';
  readonly documents: DemoDocuments;
}

/**
 * Главный поток → соло-воркеру: собери симуляцию по этим документам (SHELL-8).
 *
 * Свой конверт, а не молчаливая сборка на загрузке модуля: документы приезжают
 * из раздачи, и до них соло-воркеру собирать нечего — сцена ещё не прочитана.
 */
export interface DemoSoloInit {
  readonly t: 'demo-solo-init';
  readonly documents: DemoDocuments;
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
  readonly documents: DemoDocuments;
  readonly port?: RawPort;
  readonly url?: string;
  /**
   * Входить НАБЛЮДАТЕЛЕМ (`netcode-transport` NTR-9, NTR-21): слота воркер не
   * просит и ввод не отправляет. Поля нет — обычный участник.
   *
   * Здесь, а не в воркере: род участия выбирает страница своим режимом
   * (`mode.ts`, SHELL-8), и воркер о строке запроса ничего не знает.
   */
  readonly observer?: boolean;
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

/**
 * Документы в конверте есть. Проверяется НАЛИЧИЕ, а не форма: конверт приезжает
 * от своего же главного потока, а не из сети, и разбирать документы второй раз
 * значило бы завести вторую их проверку рядом с раскладкой конфига (NTR-14).
 * Пустой конверт при этом обязан быть отличим: без документов сторона матча не
 * поднимается вовсе, и молча собрать её «на умолчаниях» нечем (CONT-5).
 */
function hasDocuments(message: unknown): boolean {
  const documents = (message as { documents?: unknown }).documents;
  return typeof documents === 'object' && documents !== null;
}

export function isDemoServerInit(message: unknown): message is DemoServerInit {
  return tagOf(message) === 'demo-server-init' && hasDocuments(message);
}

export function isDemoSoloInit(message: unknown): message is DemoSoloInit {
  return tagOf(message) === 'demo-solo-init' && hasDocuments(message);
}

export function isDemoServerReady(message: unknown): message is DemoServerReady {
  return tagOf(message) === 'demo-server-ready';
}

export function isDemoClientInit(message: unknown): message is DemoClientInit {
  return tagOf(message) === 'demo-client-init' && hasDocuments(message);
}

export function isDemoNotice(message: unknown): message is DemoNotice {
  return tagOf(message) === 'demo-notice';
}

export function isDemoInputLead(message: unknown): message is DemoInputLead {
  return tagOf(message) === 'demo-input-lead';
}
