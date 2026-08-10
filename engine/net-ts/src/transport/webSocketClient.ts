/**
 * Подключающаяся сторона WebSocket (NTR-2). Стоит на глобальном `WebSocket` —
 * он есть и в Node (>=22), и в браузере, — поэтому файл переезжает в браузерный
 * клиент без правок, когда к тому же `MatchClient` подключат рендер (NTR-12).
 */
import { BaseTransport, type Transport } from './transport.js';

class WebSocketClientTransport extends BaseTransport {
  private readonly socket: WebSocket;

  // Явное поле, не parameter property: их не поддерживает strip-only режим Node.
  constructor(socket: WebSocket) {
    super();
    this.socket = socket;
    socket.binaryType = 'arraybuffer';
    socket.addEventListener('message', (event: MessageEvent) => {
      const data: unknown = event.data;
      if (data instanceof ArrayBuffer) this.deliver(new Uint8Array(data));
    });
    socket.addEventListener('close', () => { this.closedByPeer(); });
    socket.addEventListener('error', () => { this.closedByPeer('ошибка сокета'); });
  }

  send(bytes: Uint8Array): void {
    if (this.isClosed || this.socket.readyState !== WebSocket.OPEN) return;
    this.socket.send(bytes);
  }

  protected doClose(): void {
    this.socket.close();
  }
}

/** Резолвится, когда канал готов принимать: до этого отправленный `Hello` был бы потерян. */
export function connectWebSocket(url: string): Promise<Transport> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    socket.addEventListener('open', () => { resolve(new WebSocketClientTransport(socket)); }, { once: true });
    socket.addEventListener('error', () => { reject(new Error(`не удалось подключиться к ${url}`)); }, {
      once: true,
    });
  });
}
