/**
 * Слушающая сторона WebSocket (NTR-2). Node-only: браузер сервером не бывает,
 * поэтому клиентская сторона живёт отдельным файлом и этот модуль не тянет.
 *
 * Границы сообщений WebSocket даёт сам — восстанавливать их реализации не
 * приходится, в отличие от транспорта поверх голого потока.
 */
import { WebSocketServer, type WebSocket } from 'ws';
import { BaseTransport, type Transport, type TransportServer } from './transport.js';

class WsTransport extends BaseTransport {
  private readonly socket: WebSocket;

  // Поле объявлено явно, а не parameter property: строгий TS их допускает, но
  // strip-only режим Node — нет, а bin-скрипты ходят через него.
  constructor(socket: WebSocket) {
    super();
    this.socket = socket;
    socket.binaryType = 'nodebuffer';
    socket.on('message', (data: Buffer) => {
      // Копия, а не view на буфер `ws`: он вправе переиспользовать его под
      // следующее сообщение, а разбор кадра переживает возврат из обработчика.
      this.deliver(new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)));
    });
    socket.on('close', () => this.closedByPeer());
    socket.on('error', (error: Error) => this.closedByPeer(error.message));
  }

  send(bytes: Uint8Array): void {
    if (this.isClosed || this.socket.readyState !== this.socket.OPEN) return;
    this.socket.send(bytes);
  }

  protected doClose(): void {
    this.socket.close();
  }
}

export interface WebSocketServerOptions {
  readonly port: number;
  readonly host?: string;
}

export function webSocketTransportServer(options: WebSocketServerOptions): TransportServer {
  const wss = new WebSocketServer({
    port: options.port,
    ...(options.host !== undefined ? { host: options.host } : {}),
  });
  let handler: ((transport: Transport) => void) | undefined;
  const pending: Transport[] = [];

  wss.on('connection', (socket: WebSocket) => {
    const transport = new WsTransport(socket);
    if (handler === undefined) pending.push(transport);
    else handler(transport);
  });

  return {
    onConnection(next) {
      handler = next;
      while (pending.length > 0) next(pending.shift()!);
    },
    close() {
      return new Promise<void>((resolve) => {
        for (const client of wss.clients) client.close();
        wss.close(() => resolve());
      });
    },
  };
}
