/**
 * Внутрипроцессный транспорт (NTR-2): сервер и оба клиента в одном процессе.
 *
 * Не заглушка, а полноправная реализация — тесты обязаны гонять тот же сервер
 * и того же клиента, что играют по сети (NTR-12). Отсюда два требования, оба
 * неочевидные:
 *
 * 1. Доставка асинхронная. Синхронный вызов получателя прямо из `send` дал бы
 *    тесты, зелёные на порядке вызовов, которого в сети не бывает: обработчик
 *    отправителя ещё не закончил, а получатель уже ответил.
 * 2. Байты копируются. Настоящий сокет сериализует их и отдаёт другой буфер;
 *    без копии тест не заметил бы, что кто-то держит ссылку на чужой массив.
 */
import { BaseTransport, type Transport, type TransportServer } from './transport.js';

export interface LoopbackOptions {
  /**
   * Планировщик доставки. По умолчанию микротаск — доставка на границе текущей
   * задачи. Подмена нужна для искусственной задержки: `(deliver) =>
   * setTimeout(deliver, 40)` даёт канал с плечом, не трогая ни сервер, ни клиента.
   */
  readonly schedule?: (deliver: () => void) => void;
}

const microtask = (deliver: () => void): void => {
  queueMicrotask(deliver);
};

class LoopbackTransport extends BaseTransport {
  peer: LoopbackTransport | undefined;
  private readonly schedule: (deliver: () => void) => void;

  constructor(options: LoopbackOptions) {
    super();
    this.schedule = options.schedule ?? microtask;
  }

  send(bytes: Uint8Array): void {
    if (this.isClosed) return;
    const copy = bytes.slice();
    const peer = this.peer;
    this.schedule(() => {
      if (peer === undefined || peer.isClosed) return;
      peer.receiveFromPeer(copy);
    });
  }

  protected doClose(reason?: string): void {
    const peer = this.peer;
    if (peer === undefined) return;
    // Через планировщик, как и сообщения: закрытие — такое же событие канала, и
    // мгновенный разрыв прямо в `close()` дал бы порядок, которого в сети нет.
    this.schedule(() => peer.closedByPeer(reason));
  }

  private receiveFromPeer(bytes: Uint8Array): void {
    this.deliver(bytes);
  }
}

/** Пара связанных концов одного канала. */
export function loopbackPair(options: LoopbackOptions = {}): readonly [Transport, Transport] {
  const a = new LoopbackTransport(options);
  const b = new LoopbackTransport(options);
  a.peer = b;
  b.peer = a;
  return [a, b];
}

/**
 * Слушающая сторона поверх пары концов: `connect()` отдаёт клиентский конец, а
 * серверный уходит в обработчик соединений — та же форма, что у сетевого
 * сервера, поэтому связка сервера с транспортом в тестах и в бою одна и та же.
 */
export class LoopbackHub implements TransportServer {
  private handler: ((transport: Transport) => void) | undefined;
  private readonly pending: Transport[] = [];
  private readonly options: LoopbackOptions;

  constructor(options: LoopbackOptions = {}) {
    this.options = options;
  }

  onConnection(handler: (transport: Transport) => void): void {
    this.handler = handler;
    // Соединения, пришедшие до подписки, не теряются: клиент вправе
    // подключиться раньше, чем сервер разложил обработчики.
    while (this.pending.length > 0) handler(this.pending.shift()!);
  }

  connect(): Transport {
    const [serverSide, clientSide] = loopbackPair(this.options);
    if (this.handler === undefined) this.pending.push(serverSide);
    else this.handler(serverSide);
    return clientSide;
  }

  /**
   * Не `async`: закрытие loopback'а синхронно целиком, ждать нечего. `Promise`
   * в подписи — требование интерфейса, за которым стоят транспорты с настоящим
   * закрытием сокета, а `async` без единого `await` изображал бы ожидание.
   */
  close(): Promise<void> {
    this.handler = undefined;
    this.pending.length = 0;
    return Promise.resolve();
  }
}
