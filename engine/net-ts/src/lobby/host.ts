/**
 * Связка лобби с транспортом — зеркало `MatchHost`: сокеты и системные часы
 * живут здесь, а `LobbyServer` остаётся чистым циклом (`net-session` SES-4).
 *
 * Один и тот же хост обслуживает внутрипроцессное рандеву в автотесте и
 * WebSocket в живом сборе: различается объект, переданный в конструктор.
 */
import type { Serializer } from '@game-mvp/core';
import { DEFAULT_SERIALIZER, type Codec } from '../protocol/codec.js';
import type { ConnectionId, Transport, TransportServer } from '../transport/transport.js';
import { lobbyServerCodec } from './codec.js';
import { LobbyProtocolError, type LobbyClientMessage, type LobbyServerMessage } from './messages.js';
import type { LobbyServer } from './lobbyServer.js';

export interface LobbyHostOptions {
  readonly serializer?: Serializer;
  readonly now?: () => number;
}

export class LobbyHost {
  readonly lobby: LobbyServer;

  private readonly codec: Codec<LobbyServerMessage, LobbyClientMessage>;
  private readonly attached = new Map<ConnectionId, Transport>();
  private readonly now: () => number;
  private nextId: ConnectionId = 1;

  constructor(lobby: LobbyServer, transports: TransportServer, options: LobbyHostOptions = {}) {
    this.lobby = lobby;
    this.codec = lobbyServerCodec(options.serializer ?? DEFAULT_SERIALIZER);
    this.now = options.now ?? Date.now;
    transports.onConnection((transport) => { this.attach(transport); });
  }

  private attach(transport: Transport): void {
    const id = this.nextId++;
    this.attached.set(id, transport);
    this.lobby.connect(id);

    transport.onMessage((bytes) => {
      try {
        this.lobby.receive(id, this.codec.decode(bytes), this.now());
      } catch (error) {
        const reason = error instanceof LobbyProtocolError ? error.reason : 'protocol-error';
        this.lobby.protocolError(id, reason, error instanceof Error ? error.message : String(error));
      }
      this.flush();
    });

    transport.onClose(() => {
      this.attached.delete(id);
      this.lobby.disconnect(id);
      this.flush();
    });

    this.flush();
  }

  /** Отправляет накопленные исходящие. Публичен: тест гоняет сбор ростера без таймеров. */
  flush(): void {
    for (const outgoing of this.lobby.drain()) {
      const transport = this.attached.get(outgoing.to);
      if (transport === undefined) continue;
      transport.send(this.codec.encode(outgoing.message));
      if (outgoing.closeAfter) {
        this.attached.delete(outgoing.to);
        transport.close(outgoing.message.type === 'Denied' ? outgoing.message.reason : 'lobby-done');
      }
    }
  }
}
