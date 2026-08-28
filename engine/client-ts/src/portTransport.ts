/**
 * Транспорт netcode поверх пары портов (design Decision 9): локальный сервер
 * матча — второй воркер, `MatchServer`/`MatchClient` не знают, что между
 * ними MessageChannel, а не сокет (NTR-2).
 *
 * Байты копируются, не transfer'ятся: протокол матча переиспользует свои
 * буферы, а отчуждение чужого буфера — сюрприз, которого интерфейс
 * `Transport` не обещает. Границы сообщений даёт сам канал.
 */
import { BaseTransport, type Transport } from '@fluxus/net';
import type { ShellPort } from './protocol.js';

interface BytesMessage {
  readonly t: 'bytes';
  readonly bytes: Uint8Array;
}

interface CloseMessage {
  readonly t: 'close';
  readonly reason?: string;
}

type WireMessage = BytesMessage | CloseMessage;

class PortTransport extends BaseTransport {
  private readonly port: ShellPort;

  constructor(port: ShellPort) {
    super();
    this.port = port;
    port.onMessage((raw) => {
      // Разбор по полю-дискриминатору, а не цепочкой `if/else`: сообщение
      // приехало через границу потоков, и вида, которого этот кодек не знает,
      // достаточно, чтобы `else` перестал означать `close`. `switch` без
      // `default` молча пропускает такой вид — ровно то, что здесь и нужно.
      const message = raw as WireMessage;
      switch (message.t) {
        case 'bytes':
          this.deliver(message.bytes);
          break;
        case 'close':
          this.closedByPeer(message.reason);
          break;
      }
    });
  }

  send(bytes: Uint8Array): void {
    if (this.isClosed) return;
    // Копия: structured clone скопирует ещё раз, но отправитель может
    // мутировать свой буфер до асинхронной доставки — снимок обязателен.
    const message: BytesMessage = { t: 'bytes', bytes: bytes.slice() };
    this.port.post(message);
  }

  protected doClose(reason?: string): void {
    const message: CloseMessage = reason === undefined ? { t: 'close' } : { t: 'close', reason };
    this.port.post(message);
  }
}

/** Транспорт матча поверх порта; по транспорту на соединение. */
export function portTransport(port: ShellPort): Transport {
  return new PortTransport(port);
}
