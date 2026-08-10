/**
 * Рандеву поверх WebSocket (`net-session` SES-3) и каналы на одном порту.
 *
 * Здесь поднимаются настоящие сокеты: путь URL — единственное, что отличает
 * канал лобби от канала матча, и проверить это подменой нечем. Порт берётся
 * эфемерный (`0`), поэтому тест не конфликтует ни с чем на машине.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketRendezvous } from '../src/session/rendezvous/webSocket.js';
import { RendezvousError } from '../src/session/rendezvous.js';
import { decodeInvite } from '../src/session/invite.js';
import type { Transport } from '../src/transport/transport.js';

const open: WebSocketRendezvous[] = [];

function founder(options: Record<string, unknown> = {}): WebSocketRendezvous {
  const rendezvous = new WebSocketRendezvous({ port: 0, host: '127.0.0.1', ...options });
  open.push(rendezvous);
  return rendezvous;
}

afterEach(async () => {
  while (open.length > 0) await open.pop()!.close();
});

function received(transport: Transport): Promise<Uint8Array> {
  return new Promise((resolve) => { transport.onMessage(resolve); });
}

describe('рандеву поверх WebSocket', () => {
  it('оба канала живут на одном порту и различаются путём', async () => {
    const rendezvous = founder();
    const lobby = await rendezvous.publish('lobby');
    const match = await rendezvous.publish('match');

    const lobbyUrl = decodeInvite(lobby.invite).url!;
    const matchUrl = decodeInvite(match.invite).url!;
    expect(new URL(lobbyUrl).port).toBe(new URL(matchUrl).port);
    expect(new URL(lobbyUrl).pathname).not.toBe(new URL(matchUrl).pathname);
  });

  it('сообщение приходит в свой канал, а не в соседний', async () => {
    const rendezvous = founder();
    const lobby = await rendezvous.publish('lobby');
    const match = await rendezvous.publish('match');

    const inLobby = new Promise<Uint8Array>((resolve) => {
      lobby.transports.onConnection((transport) => { resolve(received(transport)); });
    });
    const matchSeen: Uint8Array[] = [];
    match.transports.onConnection((transport) => { transport.onMessage((bytes) => matchSeen.push(bytes)); });

    const client = await rendezvous.resolve(lobby.invite);
    client.send(Uint8Array.of(42));

    expect(Array.from(await inLobby)).toEqual([42]);
    expect(matchSeen).toHaveLength(0);
    client.close();
  });

  it('просроченный инвайт не доходит до сокета', async () => {
    let clock = 1000;
    const rendezvous = founder({ inviteTtlMs: 10, now: () => clock });
    const lobby = await rendezvous.publish('lobby');
    clock += 100;
    await expect(rendezvous.resolve(lobby.invite)).rejects.toThrow(RendezvousError);
  });

  it('сторона присоединяющегося публиковать не умеет и говорит об этом', async () => {
    const joiner = new WebSocketRendezvous();
    await expect(joiner.publish('lobby')).rejects.toThrow(RendezvousError);
  });
});
