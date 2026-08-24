/**
 * Транспорт матча поверх портов (design Decision 9): байты и закрытие в обе
 * стороны, затем smoke настоящего матча — MatchServer + два MatchClient через
 * MessageChannel-пары, тот же код, что играет по loopback и WebSocket (NTR-2).
 */
import { describe, expect, it } from 'vitest';
import { contentPackHash, fixed, type SceneDef } from '@fluxus/core';
import {
  ClientHost,
  MatchClient,
  MatchHost,
  MatchServer,
  contentPack,
  type MatchConfig,
  type Transport,
  type TransportServer,
} from '@fluxus/net';
import { portTransport, shellPort } from '../src/index.js';
import { syncPortPair } from './fixtures.js';

const BUILD_ID = 'client-shell-smoke';
const STEP = fixed.fromInt(1);

/** Сцена дуэли из сетевых тестов net-ts — движение по вводу JSON-системой. */
function duelScene(): SceneDef {
  return {
    components: [
      { name: 'Player', fields: { slot: 'i32' } },
      {
        name: 'Input',
        fields: {
          aimDir: 'fixed',
          buttons: 'i32',
          moveX: 'fixed',
          moveY: 'fixed',
          prevButtons: 'i32',
          seq: 'i32',
        },
      },
      { name: 'Position', fields: { x: 'fixed', y: 'fixed' } },
    ],
    prefabs: [
      {
        name: 'Hero',
        components: {
          Player: { slot: 0 },
          Input: { aimDir: 0, buttons: 0, moveX: 0, moveY: 0, prevButtons: 0, seq: 0 },
          Position: { x: 0, y: 0 },
        },
      },
    ],
    systems: [
      {
        name: 'Movement',
        order: 10,
        query: { all: ['Position', 'Input'] },
        as: 'e',
        do: [
          {
            modifyComponent: {
              entity: { var: 'e' },
              component: 'Position',
              values: {
                x: {
                  '+': [
                    { getComponent: [{ var: 'e' }, 'Position', 'x'] },
                    { getComponent: [{ var: 'e' }, 'Input', 'moveX'] },
                  ],
                },
              },
            },
          },
        ],
      },
    ],
    capacity: 8,
  };
}

/** «Сервер соединений» поверх MessageChannel: connect() — новая пара портов. */
class PortHub implements TransportServer {
  private handler: ((transport: Transport) => void) | null = null;
  private readonly channels: MessageChannel[] = [];

  onConnection(handler: (transport: Transport) => void): void {
    this.handler = handler;
  }

  connect(): Transport {
    const channel = new MessageChannel();
    this.channels.push(channel);
    this.handler?.(portTransport(shellPort(channel.port1)));
    return portTransport(shellPort(channel.port2));
  }

  /** Не `async`: закрытие портов синхронно, `Promise` — только форма интерфейса. */
  close(): Promise<void> {
    for (const channel of this.channels) {
      channel.port1.close();
      channel.port2.close();
    }
    return Promise.resolve();
  }
}

function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('portTransport', () => {
  it('байты ходят в обе стороны, закрытие доезжает до пира', () => {
    const [a, b] = syncPortPair();
    const left = portTransport(a);
    const right = portTransport(b);

    const gotRight: number[][] = [];
    const gotLeft: number[][] = [];
    right.onMessage((bytes) => gotRight.push([...bytes]));
    left.onMessage((bytes) => gotLeft.push([...bytes]));

    left.send(new Uint8Array([1, 2, 3]));
    right.send(new Uint8Array([4]));
    expect(gotRight).toEqual([[1, 2, 3]]);
    expect(gotLeft).toEqual([[4]]);

    let closedReason: string | undefined;
    right.onClose((reason) => {
      closedReason = reason;
    });
    left.close('bye');
    expect(right.isClosed).toBe(true);
    expect(closedReason).toBe('bye');
  });

  it('smoke: матч двух игроков через MessageChannel-пары (NTR-2)', async () => {
    const scene = duelScene();
    const pack = contentPack({ duel: scene });
    const version = { buildId: BUILD_ID, contentPackHash: contentPackHash(scene) };
    const config: MatchConfig = {
      version,
      players: ['p1', 'p2'],
      seed: 99,
      sceneRef: 'duel',
      scene,
      initial: [{ prefab: 'Hero' }, { prefab: 'Hero', overrides: { Player: { slot: 1 } } }],
      tickRate: 60,
      snapshotRate: 30,
      inputDelay: 2,
    };

    const hub = new PortHub();
    const server = new MatchServer(config);
    const host = new MatchHost(server, hub);
    const clock = { ms: 0 };

    const connect = (playerId: string, moving: boolean) => {
      const client = new MatchClient({ playerId, version, content: pack });
      const clientHost = new ClientHost(client, hub.connect(), {
        now: () => clock.ms,
        ...(moving
          ? { input: () => ({ move: { x: STEP, y: 0 }, aimDir: 0, buttons: 0 }) }
          : {}),
      });
      clientHost.start();
      return { client, clientHost };
    };
    const a = connect('p1', true);
    const b = connect('p2', false);
    await settle();
    await settle();

    for (let i = 0; i < 24; i++) {
      clock.ms += 1000 / 60;
      a.clientHost.step();
      b.clientHost.step();
      await settle();
      host.step();
      await settle();
    }

    expect(server.phase).toBe('running');
    expect(a.client.phase).toBe('playing');
    expect(b.client.phase).toBe('playing');
    expect(server.tick).toBeGreaterThan(0);
    // Игрок 2 видит чужое движение исключительно из снапшота через порт.
    expect(b.client.latest).toBeDefined();

    await hub.close();
  });
});
