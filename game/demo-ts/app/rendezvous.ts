/**
 * Рандеву демо: как участник узнаёт, КУДА подключаться (`net-session` SES-3).
 *
 * SES-3 требует, чтобы способ встречи был скрыт за интерфейсом и чтобы сборка
 * матча не знала, какая реализация под ним стоит. Здесь это ровно один тип —
 * пара «как соединиться» и «под какими именами пробовать войти», — и вход в
 * матч (`netClient.ts`) видит только его. Реализаций у демо сегодня две, и обе
 * из перечисленных SES-3 как минимальный набор:
 *
 * - `tabRendezvous` — внутрипроцессная: матч поднят своей же вкладкой, адресов
 *   не существует вовсе, транспорт — пара портов (NTR-2). Ею же пользуется
 *   тест дефолтной сборки (NTR-12).
 * - `directRendezvous` — прямой адрес: участник знает, куда идти, транспорт —
 *   WebSocket.
 *
 * Третья, `инвайт`, интерфейс не расширяет — и это главное, ради чего он здесь
 * заведён. Лобби (SES-4) отличается от прямого адреса не транспортом, а тем,
 * что идентификатор игрока НАЗНАЧАЕТСЯ до матча: перебор имён ростера — это
 * способ обойтись без лобби, и у рандеву с лобби `candidates` будет ровно один
 * элемент — назначенное имя. Поэтому список имён приезжает ОТСЮДА, а не
 * вычисляется у входа в матч: лобби добавляется новой реализацией рандеву, а
 * не веткой в `joinDemoMatch`, и ни клиент, ни оболочка его не заметят (SES-2).
 *
 * Рандеву заканчивается транспортом и заканчивается НА ЭТОМ (SES-3): дальше
 * идёт хендшейк матча (NTR-5), одинаковый во всех режимах.
 */
import type { RawPort } from '@fluxus/bot';
import { connectWebSocket, type Transport } from '@fluxus/net';
import { portTransport, shellPort } from '@fluxus/client';
import { slotCandidates } from './mode.js';

export interface DemoRendezvous {
  /** Транспорт до сервера матча (NTR-2); имя нужно тем реализациям, что его предъявляют. */
  readonly connect: (playerId: string) => Promise<Transport>;
  /** Имена ростера по порядку попыток входа (D4); у лобби здесь одно назначенное имя. */
  readonly candidates: readonly string[];
}

/**
 * Матч своей вкладки: транспорт — пара портов, и порт ОДНОРАЗОВЫЙ. Перебирать
 * по нему нечего — второй слот держит бот-заполнитель (BOT-7).
 */
export function tabRendezvous(port: RawPort, players: readonly string[]): DemoRendezvous {
  return {
    connect: () => Promise.resolve(portTransport(shellPort(port))),
    candidates: slotCandidates({ kind: 'local' }, players),
  };
}

/** Выделенный стенд по известному адресу: каждая попытка входа — свой сокет. */
export function directRendezvous(url: string, players: readonly string[]): DemoRendezvous {
  return {
    connect: () => connectWebSocket(url),
    candidates: slotCandidates({ kind: 'server', url }, players),
  };
}
