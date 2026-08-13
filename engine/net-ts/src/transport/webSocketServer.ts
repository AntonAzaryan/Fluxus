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
    socket.on('close', () => { this.closedByPeer(); });
    socket.on('error', (error: Error) => { this.closedByPeer(error.message); });
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
        wss.close(() => { resolve(); });
      });
    },
  };
}

// ------------------------------------------------------------------- каналы

/**
 * Несколько слушающих сторон на одном порту, различаемых путём URL.
 *
 * Каналов у сессии два — лобби и матч (`net-session` SES-4), — и жить они
 * обязаны на одном порту: шаг существует ради «позвал друга», а два порта
 * означают две записи в пробросе. Множественность каналов — артефакт этого
 * транспорта: у WebRTC это два DataChannel на одном соединении, и порта нет
 * вовсе.
 *
 * Путь не является ни полем протокола, ни согласованием возможностей: сервер и
 * клиент матча его не видят, он живёт целиком в рандеву (SES-3).
 */
export interface WebSocketChannelServer {
  /** Слушающая сторона канала. Повторный вызов с тем же путём отдаёт ту же. */
  channel(path: string): TransportServer;
  /** Порт, на котором сервер поднялся. Отличается от запрошенного, если просили `0`. */
  readonly port: number;
  close(): Promise<void>;
}

interface ChannelState {
  readonly wss: WebSocketServer;
  handler: ((transport: Transport) => void) | undefined;
  readonly pending: Transport[];
}

/**
 * Резолвится, когда сокет уже слушает: инвайт с портом `0` иначе называл бы
 * порт, которого ещё нет.
 */
export async function webSocketChannelServer(
  options: WebSocketServerOptions,
): Promise<WebSocketChannelServer> {
  // Динамический импорт node-only модуля, спрятанный от статического анализа
  // бандлеров: этот файл целиком node-only (браузер сервером не бывает), но
  // попадает в граф браузерной сборки через барьер пакета — оттуда его выносит
  // tree-shaking, а вот предупреждение «модуль externalized» бандлер печатает
  // ещё до него, на разборе. Пометка гасит именно предупреждение; поведение в
  // Node прежнее — обычный динамический импорт.
  const { createServer } = await import(/* @vite-ignore */ 'node:http');
  const http = createServer();
  const channels = new Map<string, ChannelState>();

  const state = (path: string): ChannelState => {
    const existing = channels.get(path);
    if (existing !== undefined) return existing;
    const created: ChannelState = { wss: new WebSocketServer({ noServer: true }), handler: undefined, pending: [] };
    created.wss.on('connection', (socket: WebSocket) => {
      const transport = new WsTransport(socket);
      if (created.handler === undefined) created.pending.push(transport);
      else created.handler(transport);
    });
    channels.set(path, created);
    return created;
  };

  http.on('upgrade', (request, socket, head) => {
    const path = (request.url ?? '/').split('?')[0] ?? '/';
    const target = channels.get(path);
    // Неизвестный путь рвётся, а не молча висит: путь — часть инвайта, и
    // опечатка в нём обязана отлаживаться по отказу, а не по отсутствию матча.
    if (target === undefined) {
      socket.destroy();
      return;
    }
    target.wss.handleUpgrade(request, socket, head, (ws) => target.wss.emit('connection', ws, request));
  });

  await new Promise<void>((resolve, reject) => {
    http.once('error', reject);
    http.listen(options.port, options.host, () => {
      http.removeListener('error', reject);
      resolve();
    });
  });

  const address = http.address();
  const port = typeof address === 'object' && address !== null ? address.port : options.port;

  return {
    port,
    channel(path: string): TransportServer {
      const target = state(path);
      return {
        onConnection(next) {
          target.handler = next;
          while (target.pending.length > 0) next(target.pending.shift()!);
        },
        close() {
          return new Promise<void>((resolve) => {
            for (const client of target.wss.clients) client.close();
            target.wss.close(() => { resolve(); });
          });
        },
      };
    },
    close() {
      return new Promise<void>((resolve) => {
        for (const target of channels.values()) {
          for (const client of target.wss.clients) client.close();
          target.wss.close();
        }
        http.close(() => { resolve(); });
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- baseline
        http.closeAllConnections?.();
      });
    },
  };
}
