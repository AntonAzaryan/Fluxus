/**
 * Клиентская библиотека управляющего протокола (SRV-2, SRV-3) — одна на
 * менеджер и на тесты агента.
 *
 * Одна, потому что вторая означала бы второе мнение о протоколе: тесты
 * проверяли бы одну реализацию, а менеджер разговаривал бы другой. Здесь же
 * живёт TOFU-пиннинг отпечатка (SRV-3): при первом подключении отпечаток
 * закрепляется, а его изменение — ГРОМКИЙ отказ с объяснением, а не тихое
 * переподключение.
 *
 * Сам сокет приезжает фабрикой, а не создаётся здесь: в Node это `ws` поверх
 * TLS, где отпечаток виден и проверяется по-настоящему, а в странице —
 * встроенный `WebSocket`, у которого доступа к сертификату нет вовсе (см.
 * `browserSocket`). Библиотека одна, а граница проверки названа там, где она
 * действительно проходит.
 */
import {
  CONTROL_PROTOCOL_VERSION,
  type AdminOp,
  type AgentVersions,
  type ControlResponse,
  type RefusalReason,
  type ResultResponse,
  type ServerEvent,
  type StartParams,
} from '../protocol/messages.js';
import { parseControlResponse } from '../protocol/parse.js';

/**
 * Дедлайн рукопожатия: агент, не ответивший за это время, — мёртвый пир или
 * чужой WebSocket, и `connect()` обязан вернуть названный отказ, а не висеть.
 */
const HANDSHAKE_TIMEOUT_MS = 10_000;

/**
 * Причина отказа клиентской библиотеки: причины протокола (SRV-2) плюс её
 * собственные — то, что случается ДО ответа агента либо вместо него.
 */
export type ClientFailure =
  | RefusalReason
  /** Отпечаток известного хоста изменился (SRV-3) — громкий отказ, а не переподключение. */
  | 'fingerprint-changed'
  /** Канал не открылся вовсе: адрес, сеть, чужой протокол. */
  | 'connect-failed'
  /** Канала больше нет: операция без подключения либо разрыв в полёте. */
  | 'closed'
  /** Ответ агента не разобран: клиент не показывает прежнее состояние свежим. */
  | 'malformed';

export class ControlClientError extends Error {
  readonly reason: ClientFailure;

  constructor(reason: ClientFailure, detail: string) {
    super(detail);
    this.name = 'ControlClientError';
    this.reason = reason;
  }
}

/** Канал управляющего протокола: текстовые сообщения, ничего сверх того. */
export interface ControlSocket {
  send(text: string): void;
  close(): void;
  onMessage(handler: (text: string) => void): void;
  onClose(handler: (reason: string) => void): void;
}

export interface OpenedSocket {
  readonly socket: ControlSocket;
  /**
   * Отпечаток предъявленного сертификата; пустая строка — среда его не
   * показывает (см. `browserSocket`), и закреплять нечего.
   */
  readonly fingerprint: string;
}

/**
 * Как открыть канал. `pinned` — закреплённый отпечаток известного хоста:
 * фабрика, которая отпечаток ВИДИТ, обязана отказать при несовпадении.
 */
export type ControlSocketFactory = (url: string, pinned: string) => Promise<OpenedSocket>;

export interface ConnectOptions {
  readonly url: string;
  /** Долгоживущий токен (SRV-3); пустая строка — токена ещё нет. */
  readonly token?: string;
  /** Код пейринга: обменивается на токен при первом подключении (SRV-3). */
  readonly pairingCode?: string;
  /** Имя клиента в перечне выданных токенов. */
  readonly label?: string;
  /** Закреплённый отпечаток известного хоста; пустая строка — хост новый (TOFU). */
  readonly pinned?: string;
}

export interface ConnectedAgent {
  readonly versions: AgentVersions;
  /** Отпечаток агента: закрепляется вызывающим при первом подключении (TOFU). */
  readonly fingerprint: string;
  /** Выданный пейрингом токен; пустая строка — обмена не было. */
  readonly token: string;
}

export interface ControlClient {
  connect(options: ConnectOptions): Promise<ConnectedAgent>;
  list(): Promise<ResultResponse>;
  matches(): Promise<ResultResponse>;
  start(params: StartParams): Promise<ResultResponse>;
  stop(server: string): Promise<ResultResponse>;
  stopAll(): Promise<ResultResponse>;
  subscribe(server: string): Promise<ResultResponse>;
  unsubscribe(server: string): Promise<ResultResponse>;
  admin(server: string, op: AdminOp, slot?: number): Promise<ResultResponse>;
  log(server: string): Promise<ResultResponse>;
  tokens(): Promise<ResultResponse>;
  revoke(token: string): Promise<ResultResponse>;
  /** События подписки (SRV-2): реестр меняется — подписчик узнаёт без опроса. */
  onEvent(listener: (event: ServerEvent) => void): () => void;
  /**
   * Разрыв канала — наблюдаемое событие, а не молчание (SRV-2). Клиент, у
   * которого канал умер (агент ушёл, сеть пропала, токен отозван — SRV-3),
   * обязан сказать об этом наблюдателю: иначе тот показывает прошлое состояние
   * как настоящее и узнаёт правду только по отказу первой же операции.
   */
  onClose(listener: (reason: string) => void): () => void;
  close(): void;
  readonly connected: boolean;
}

interface Waiting {
  readonly resolve: (value: ResultResponse) => void;
  readonly reject: (error: ControlClientError) => void;
}

export function createControlClient(open: ControlSocketFactory): ControlClient {
  let socket: ControlSocket | undefined;
  let nextId = 1;
  const waiting = new Map<number, Waiting>();
  const listeners = new Set<(event: ServerEvent) => void>();
  const closing = new Set<(reason: string) => void>();
  let greeting: ((response: ControlResponse) => void) | undefined;

  const fail = (error: ControlClientError): void => {
    for (const [id, pending] of waiting) {
      pending.reject(error);
      waiting.delete(id);
    }
  };

  const receive = (text: string): void => {
    let message: ControlResponse;
    try {
      message = parseControlResponse(JSON.parse(text));
    } catch (error) {
      // Непонятый ответ агента — отказ, а не молчание: клиент, проглотивший
      // мусор, показал бы человеку прежнее состояние как свежее.
      fail(new ControlClientError('malformed', error instanceof Error ? error.message : String(error)));
      return;
    }
    if (message.t === 'welcome') {
      greeting?.(message);
      return;
    }
    if (message.t === 'event') {
      for (const listener of listeners) listener(message);
      return;
    }
    if (message.t === 'refused') {
      // Отказ рукопожатия приезжает с номером `0`: ждать его некому, кроме
      // самого рукопожатия.
      if (message.id === 0) {
        greeting?.(message);
        return;
      }
      waiting.get(message.id)?.reject(new ControlClientError(message.reason, message.detail));
      waiting.delete(message.id);
      return;
    }
    waiting.get(message.id)?.resolve(message);
    waiting.delete(message.id);
  };

  const send = (body: Record<string, unknown>): Promise<ResultResponse> => {
    const live = socket;
    if (live === undefined) {
      return Promise.reject(new ControlClientError('closed', 'подключения к агенту нет'));
    }
    const id = nextId++;
    return new Promise<ResultResponse>((resolve, reject) => {
      waiting.set(id, { resolve, reject });
      live.send(JSON.stringify({ ...body, id }));
    });
  };

  return {
    get connected(): boolean {
      return socket !== undefined;
    },
    async connect(options) {
      const pinned = options.pinned ?? '';
      // Только шифрованный канал (SRV-3) — и на стороне КЛИЕНТА тоже. Агент
      // незашифрованного слушателя не поднимает вовсе, но опечатка в адресе
      // (`ws://`) уводила бы страницу на чужой открытый сокет, вынося на провод
      // код пейринга и админ-токен; в Node тот же адрес роняет `nodeSocket`
      // обращением к TLS-методам обычного сокета.
      let scheme = '';
      try {
        scheme = new URL(options.url).protocol;
      } catch {
        throw new ControlClientError('connect-failed', `адрес "${options.url}" не разобрать`);
      }
      if (scheme !== 'wss:') {
        throw new ControlClientError(
          'connect-failed',
          `управляющий канал существует только шифрованным (SRV-3), а адрес назвал "${scheme}"`,
        );
      }
      const opened = await open(options.url, pinned);
      socket = opened.socket;
      opened.socket.onMessage(receive);
      opened.socket.onClose((reason) => {
        socket = undefined;
        // Разрыв ДО рукопожатия разрешает сам хендшейк названным исходом:
        // без этого `connect()` висел бы вечно на мёртвом или чужом канале.
        // После рукопожатия `greeting` уже снят, и это no-op — работает `fail`.
        greeting?.({
          t: 'refused',
          id: 0,
          reason: 'malformed',
          detail: reason === '' ? 'канал закрылся до рукопожатия' : reason,
        });
        fail(new ControlClientError('closed', reason === '' ? 'канал закрыт' : reason));
        for (const listener of closing) listener(reason);
      });
      const welcome = await new Promise<ControlResponse>((resolve) => {
        // Рукопожатие обязано ЗАВЕРШИТЬСЯ исходом (SRV-2: «Отказ любой операции
        // SHALL быть наблюдаем как отказ с названной причиной»). Мёртвый пир,
        // чужой WebSocket или разрыв посреди хендшейка иначе оставили бы
        // `connect()` висеть вечно — поэтому и разрыв (`onClose` выше), и
        // дедлайн ниже разрешают ЭТОТ же промис названным исходом. Обёртка над
        // `resolve` снимает таймер любым первым исходом.
        const deadline = setTimeout(() => {
          greeting?.({
            t: 'refused',
            id: 0,
            reason: 'malformed',
            detail: `агент не ответил на рукопожатие за ${String(HANDSHAKE_TIMEOUT_MS)} мс`,
          });
        }, HANDSHAKE_TIMEOUT_MS);
        greeting = (response): void => {
          clearTimeout(deadline);
          resolve(response);
        };
        opened.socket.send(
          JSON.stringify({
            t: 'hello',
            protocol: CONTROL_PROTOCOL_VERSION,
            token: options.token ?? '',
            pairingCode: options.pairingCode ?? '',
            label: options.label ?? '',
          }),
        );
      });
      greeting = undefined;
      if (welcome.t === 'refused') {
        opened.socket.close();
        socket = undefined;
        throw new ControlClientError(welcome.reason, welcome.detail);
      }
      if (welcome.t !== 'welcome') {
        opened.socket.close();
        socket = undefined;
        throw new ControlClientError('malformed', 'агент ответил не рукопожатием');
      }
      // Отпечаток, названный САМИМ агентом, сверяется с закреплённым и здесь —
      // на случай среды, где сертификат каналу не виден (страница). Это слабее
      // проверки на уровне TLS и не заменяет её: там, где отпечаток виден,
      // канал не открылся бы вовсе (см. `nodeSocket`).
      // Отсутствие отпечатка — НЕ совпадение. Пропустив пустой, закрепление
      // отменял бы сам предъявитель: достаточно не назваться, и TOFU обходится,
      // а пустое значение потом ложится в книгу вместо прежнего закрепления —
      // хост оказался бы откреплён навсегда (SRV-3).
      if (pinned !== '' && welcome.fingerprint !== pinned) {
        opened.socket.close();
        socket = undefined;
        throw new ControlClientError(
          'fingerprint-changed',
          `отпечаток хоста изменился: закреплён ${pinned}, предъявлен ${welcome.fingerprint}`,
        );
      }
      return {
        versions: welcome.agent,
        fingerprint: opened.fingerprint === '' ? welcome.fingerprint : opened.fingerprint,
        token: welcome.token,
      };
    },
    list: () => send({ t: 'list' }),
    matches: () => send({ t: 'matches' }),
    start: (params) => send({ t: 'start', params }),
    stop: (server) => send({ t: 'stop', server }),
    stopAll: () => send({ t: 'stop-all' }),
    subscribe: (server) => send({ t: 'subscribe', server }),
    unsubscribe: (server) => send({ t: 'unsubscribe', server }),
    admin: (server, op, slot = -1) => send({ t: 'admin', server, op, slot }),
    log: (server) => send({ t: 'log', server }),
    tokens: () => send({ t: 'tokens' }),
    revoke: (token) => send({ t: 'revoke', token }),
    onEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    onClose(listener) {
      closing.add(listener);
      return () => closing.delete(listener);
    },
    close() {
      socket?.close();
      socket = undefined;
    },
  };
}
