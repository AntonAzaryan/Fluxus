/**
 * Протокол (NTR-4, NTR-13): круг кодирования обоими сериализаторами и то, что
 * недопустимое сообщение называет исход, а не проходит молча.
 */
import { describe, expect, it } from 'vitest';
import { clientCodec, jsonSerializer, msgpackSerializer, serverCodec } from '../src/protocol/codec.js';
import {
  parseClientMessage,
  parseServerMessage,
  ProtocolError,
  toInputFrame,
  type ClientMessage,
  type ServerMessage,
} from '../src/protocol/messages.js';
import { BUILD_ID, duelConfig, harness, hello, inputMessage, wireInput } from './fixtures.js';

const serializers = [msgpackSerializer, jsonSerializer];

describe('кодирование кадра', () => {
  for (const serializer of serializers) {
    it(`круг клиентского сообщения через ${serializer.name}`, () => {
      const codec = serverCodec(serializer);
      const message: ClientMessage = inputMessage(wireInput(7, 3, 65536, -65536, 5));
      expect(codec.decode(codec.encode(message as never) as never)).toEqual(message);
    });

    it(`круг серверного сообщения через ${serializer.name}`, () => {
      const codec = clientCodec(serializer);
      const message: ServerMessage = {
        type: 'Welcome',
        slot: 1,
        players: ['p1', 'p2'],
        seed: 99,
        match: { sceneRef: 'duel', initial: [{ prefab: 'Hero' }] },
        worldInitHash: 'deadbeef',
        pacing: { tickRate: 60, snapshotRate: 30, inputDelay: 2 },
      };
      const codec2 = serverCodec(serializer);
      expect(codec.decode(codec2.encode(message) as never)).toEqual(message);
    });
  }

  it('битые байты дают ProtocolError, а не падение сериализатора наружу', () => {
    const codec = serverCodec(msgpackSerializer);
    expect(() => codec.decode(Uint8Array.from([0xc1, 0xff, 0xff]))).toThrow(ProtocolError);
  });
});

describe('разбор входящего', () => {
  it('неизвестный тип отвергается', () => {
    expect(() => parseClientMessage({ type: 'Cheat', damage: 50 })).toThrow(ProtocolError);
  });

  it('сообщение не своего направления отвергается', () => {
    // `Welcome` — серверное; разбор клиентского направления его знать не должен.
    expect(() => parseClientMessage({ type: 'Welcome', slot: 0 })).toThrow(ProtocolError);
    expect(() => parseServerMessage({ type: 'Hello', playerId: 'p1' })).toThrow(ProtocolError);
  });

  it('buttons вне u16 отвергается на границе (TICK-2)', () => {
    expect(() => parseClientMessage(inputMessage(wireInput(1, 1, 0, 0, 65536)))).toThrow(ProtocolError);
    expect(() => parseClientMessage(inputMessage(wireInput(1, 1, 0, 0, -1)))).toThrow(ProtocolError);
    // Верхняя граница включающая — это значение легально.
    expect(() => parseClientMessage(inputMessage(wireInput(1, 1, 0, 0, 65535)))).not.toThrow();
  });

  it('нецелые и отсутствующие поля кадра отвергаются', () => {
    expect(() => parseClientMessage({ type: 'Input', frames: [{ tick: 1.5, seq: 1 }] })).toThrow(ProtocolError);
    expect(() => parseClientMessage({ type: 'Input', frames: [] })).toThrow(ProtocolError);
    expect(() => parseClientMessage({ type: 'Input' })).toThrow(ProtocolError);
  });

  it('личность даёт соединение, а не содержимое кадра', () => {
    const frame = toInputFrame(wireInput(4, 2, 65536), 'p2', 4);
    expect(frame.playerId).toBe('p2');
    expect(frame.move).toEqual({ x: 65536, y: 0 });
    expect(frame.tick).toBe(4);
  });
});

describe('состояние соединения', () => {
  it('ввод до хендшейка рвёт соединение с названным исходом', () => {
    const { server } = harness();
    server.connect(1);
    server.receive(1, inputMessage(wireInput(1, 1)));
    const out = server.drain();
    expect(out).toHaveLength(1);
    expect(out[0]!.message).toMatchObject({ type: 'Reject', reason: 'protocol-error' });
    expect(out[0]!.closeAfter).toBe(true);
  });

  it('повторный Hello в установленном соединении рвёт его', () => {
    const config = duelConfig();
    const { server } = harness(config);
    server.connect(1);
    server.receive(1, hello('p1', config.version));
    server.drain();
    server.receive(1, hello('p1', config.version));
    expect(server.drain()[0]!.message).toMatchObject({ type: 'Reject', reason: 'protocol-error' });
  });

  it('отвергнутые сообщения видны в счётчиках', () => {
    const { server } = harness();
    server.connect(1);
    server.protocolError(1, 'protocol-error', 'тест');
    expect(server.metrics.rejectedMessages).toBe(1);
  });

  it('версия предъявляется парой и обе половины сверяются', () => {
    const config = duelConfig();
    expect(config.version.buildId).toBe(BUILD_ID);
    expect(config.version.contentPackHash).toMatch(/^[0-9a-f]{8}$/);
  });
});
