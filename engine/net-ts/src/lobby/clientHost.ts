/**
 * Связка клиента лобби с транспортом — зеркало `ClientHost` матча: сокет живёт
 * здесь, `LobbyClient` остаётся чистым циклом.
 */
import type { Serializer } from '@fluxus/core';
import { DEFAULT_SERIALIZER, type Codec } from '../protocol/codec.js';
import type { Transport } from '../transport/transport.js';
import { lobbyClientCodec } from './codec.js';
import { LobbyProtocolError, type LobbyClientMessage, type LobbyServerMessage } from './messages.js';
import type { LobbyClient, LobbyClientOutcome } from './lobbyClient.js';

export interface LobbyClientHostOptions {
  readonly serializer?: Serializer;
}

export class LobbyClientHost {
  readonly client: LobbyClient;

  private readonly transport: Transport;
  private readonly codec: Codec<LobbyClientMessage, LobbyServerMessage>;
  private readonly waiting: ((outcome: LobbyClientOutcome) => void)[] = [];

  constructor(client: LobbyClient, transport: Transport, options: LobbyClientHostOptions = {}) {
    this.client = client;
    this.transport = transport;
    this.codec = lobbyClientCodec(options.serializer ?? DEFAULT_SERIALIZER);

    transport.onMessage((bytes) => {
      try {
        this.client.receive(this.codec.decode(bytes));
      } catch (error) {
        const detail = error instanceof LobbyProtocolError ? error.message : String(error);
        this.client.onTransportClosed(detail);
        this.transport.close(detail);
      }
      this.flush();
      this.settle();
    });

    transport.onClose((reason) => {
      this.client.onTransportClosed(reason ?? '');
      this.settle();
    });
  }

  start(): void {
    this.client.start();
    this.flush();
  }

  flush(): void {
    if (this.transport.isClosed) return;
    for (const message of this.client.drain()) this.transport.send(this.codec.encode(message));
  }

  /** Ждёт исхода фазы лобби: адреса матча, отказа или разрыва. */
  outcome(): Promise<LobbyClientOutcome> {
    const known = this.client.outcome;
    if (known !== undefined) return Promise.resolve(known);
    return new Promise((resolve) => this.waiting.push(resolve));
  }

  leave(reason = ''): void {
    this.client.leave(reason);
    this.flush();
    this.transport.close(reason);
  }

  private settle(): void {
    const outcome = this.client.outcome;
    if (outcome === undefined) return;
    while (this.waiting.length > 0) this.waiting.shift()!(outcome);
  }
}
