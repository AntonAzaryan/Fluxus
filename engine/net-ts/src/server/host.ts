/**
 * Связка сервера матча с транспортом — тот самый внешний слой, которого нет
 * внутри `MatchServer` (NTR-3). Здесь и только здесь живут сокеты, таймер и
 * системные часы.
 *
 * Один и тот же хост обслуживает внутрипроцессный транспорт в автотесте и
 * WebSocket в живом матче (NTR-12): различается объект, переданный в
 * конструктор, а не код.
 */
import type { Serializer } from '@game-mvp/core';
import { serverCodec, DEFAULT_SERIALIZER, type Codec } from '../protocol/codec.js';
import { ProtocolError, type ClientMessage, type ServerMessage } from '../protocol/messages.js';
import type { ConnectionId, Transport, TransportServer } from '../transport/transport.js';
import type { MatchServer } from './matchServer.js';

export interface MatchHostOptions {
  readonly serializer?: Serializer;
}

export class MatchHost {
  readonly server: MatchServer;

  private readonly transports: TransportServer;
  private readonly codec: Codec<ServerMessage, ClientMessage>;
  private readonly attached = new Map<ConnectionId, Transport>();
  private nextId: ConnectionId = 1;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(server: MatchServer, transports: TransportServer, options: MatchHostOptions = {}) {
    this.server = server;
    this.transports = transports;
    this.codec = serverCodec(options.serializer ?? DEFAULT_SERIALIZER);
    this.transports.onConnection((transport) => { this.attach(transport); });
  }

  private attach(transport: Transport): void {
    const id = this.nextId++;
    this.attached.set(id, transport);
    this.server.connect(id);

    transport.onMessage((bytes) => {
      try {
        this.server.receive(id, this.codec.decode(bytes));
      } catch (error) {
        // Битый кадр, чужое направление и недопустимое для состояния соединения
        // сообщение — один исход: назвать и разорвать (NTR-4).
        const reason = error instanceof ProtocolError ? error.reason : 'protocol-error';
        this.server.protocolError(id, reason, error instanceof Error ? error.message : String(error));
      }
      this.flush();
    });

    transport.onClose(() => {
      this.attached.delete(id);
      this.server.disconnect(id);
      this.flush();
    });

    this.flush();
  }

  /** Отправляет накопленные сервером исходящие. Публичен: тесты гоняют матч без таймера. */
  flush(): void {
    for (const outgoing of this.server.drain()) {
      const transport = this.attached.get(outgoing.to);
      if (transport === undefined) continue;
      const bytes = this.codec.encode(outgoing.message);
      this.server.metrics.bytesSent += bytes.byteLength;
      transport.send(bytes);
      if (outgoing.closeAfter) {
        this.attached.delete(outgoing.to);
        transport.close(outgoing.message.type === 'Reject' ? outgoing.message.reason : 'match-ended');
      }
    }
  }

  /** Один шаг расписания. Отдельно от `start()`, чтобы тест двигал матч сам. */
  step(): void {
    this.server.advance();
    this.flush();
  }

  start(): void {
    if (this.timer !== undefined) return;
    const periodMs = 1000 / this.server.pacing.tickRate;
    this.timer = setInterval(() => { this.step(); }, periodMs);
  }

  async stop(): Promise<void> {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    this.server.stop();
    this.flush();
    await this.transports.close();
  }
}
