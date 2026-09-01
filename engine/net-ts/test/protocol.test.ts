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
        match: { sceneRef: 'duel', initial: [{ prefab: 'Hero' }] },
        worldInitHash: 'deadbeef',
        pacing: { tickRate: 60, snapshotRate: 30, inputDelay: 2, inputWindow: 15, eventRepeat: 2 },
      };
      const codec2 = serverCodec(serializer);
      expect(codec.decode(codec2.encode(message) as never)).toEqual(message);
    });

    it(`круг потока событий через ${serializer.name} (NTR-15)`, () => {
      const codec = clientCodec(serializer);
      const message: ServerMessage = {
        type: 'Events',
        epoch: 3,
        from: 10,
        to: 12,
        // Тик 11 в теле отсутствует: внутри объявленного диапазона это
        // «событий не было», а не потерянная пачка (NTR-15).
        batches: [
          { tick: 10, events: [{ type: 'EntityDied', data: { entity: 7 } }] },
          { tick: 12, events: [{ type: 'RoundEnded', data: {} }] },
        ],
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

  it('точка прицела едет плоской парой и переживает круг через оба формата (TICK-2)', () => {
    for (const serializer of serializers) {
      const codec = serverCodec(serializer);
      const message: ClientMessage = inputMessage({
        ...wireInput(7, 3, 65536, -65536, 5),
        targetX: 131072,
        targetY: -262144,
      });
      expect(codec.decode(codec.encode(message as never) as never)).toEqual(message);
    }
  });

  it('кадр без точки её и не приобретает: отсутствие — не ноль', () => {
    const parsed = parseClientMessage(inputMessage(wireInput(1, 1))) as unknown as {
      frames: readonly Record<string, unknown>[];
    };
    const frame = parsed.frames[0]!;
    expect(frame.targetX).toBeUndefined();
    expect(frame.targetY).toBeUndefined();
    // И до ядра доезжает КАДР БЕЗ ПОЛЯ, а не кадр с нулями: канонический
    // `inputs[]` пишется отсюда, и подставленные нули отличали бы запись матча
    // от записи того же матча до появления поля (CLI-10).
    expect(toInputFrame(wireInput(1, 1), 'p1', 1).target).toBeUndefined();
  });

  it('точка вне i32 отвергается на транспортной границе (NTR-7, FP-1)', () => {
    const over = { ...wireInput(1, 1), targetX: 2147483648, targetY: 0 };
    expect(() => parseClientMessage(inputMessage(over))).toThrow(ProtocolError);
    const under = { ...wireInput(1, 1), targetX: 0, targetY: -2147483649 };
    expect(() => parseClientMessage(inputMessage(under))).toThrow(ProtocolError);
    // Границы включающие: за ними Q16.16 не представима, до них — законна.
    const edge = { ...wireInput(1, 1), targetX: 2147483647, targetY: -2147483648 };
    expect(() => parseClientMessage(inputMessage(edge))).not.toThrow();
  });

  it('половина точки — отказ разбора, а не выброшенная координата', () => {
    const half = { ...wireInput(1, 1), targetX: 65536 };
    expect(() => parseClientMessage(inputMessage(half))).toThrow(/парой/);
  });

  it('провод не несёт ни номера шага, ни длины цепочки (TICK-2)', () => {
    // Форма кадра — плоские поля рядом с движением и ничего сверх них: шаги
    // накапливаются в симуляции (ABIL-5), и цепочка любой длины остаётся
    // данными сцены, а не свойством протокола.
    const parsed = parseClientMessage(
      inputMessage({ ...wireInput(1, 1), targetX: 1, targetY: 2 }),
    ) as unknown as { frames: readonly Record<string, unknown>[] };
    expect(Object.keys(parsed.frames[0]!).sort()).toEqual([
      'aimDir',
      'buttons',
      'moveX',
      'moveY',
      'seq',
      'targetX',
      'targetY',
      'tick',
    ]);
  });

  it('нецелые и отсутствующие поля кадра отвергаются', () => {
    expect(() => parseClientMessage({ type: 'Input', epoch: 0, frames: [{ tick: 1.5, seq: 1 }] })).toThrow(
      ProtocolError,
    );
    expect(() => parseClientMessage({ type: 'Input', epoch: 0, frames: [] })).toThrow(ProtocolError);
    expect(() => parseClientMessage({ type: 'Input' })).toThrow(ProtocolError);
  });

  it('отсутствующая эпоха — разрыв, а не умолчание (NTR-16)', () => {
    expect(() => parseClientMessage({ type: 'Input', frames: [wireInput(1, 1)] })).toThrow(ProtocolError);
    expect(() => parseServerMessage({ type: 'Snapshot', tick: 1, snapshot: {} })).toThrow(ProtocolError);
  });

  it('Welcome без inputWindow в pacing отвергается (NTR-7)', () => {
    expect(() =>
      parseServerMessage({
        type: 'Welcome',
        slot: 0,
        players: ['p1', 'p2'],
        match: { sceneRef: 'duel', initial: [] },
        worldInitHash: 'x',
        pacing: { tickRate: 60, snapshotRate: 30, inputDelay: 2, eventRepeat: 2 },
      }),
    ).toThrow(ProtocolError);
  });

  it('Welcome без eventRepeat в pacing отвергается (NTR-15)', () => {
    expect(() =>
      parseServerMessage({
        type: 'Welcome',
        slot: 0,
        players: ['p1', 'p2'],
        match: { sceneRef: 'duel', initial: [] },
        worldInitHash: 'x',
        pacing: { tickRate: 60, snapshotRate: 30, inputDelay: 2, inputWindow: 15 },
      }),
    ).toThrow(ProtocolError);
  });

  it('точка с провода становится полем `target` кадра ядра (TICK-2)', () => {
    const frame = toInputFrame({ ...wireInput(4, 2), targetX: 65536, targetY: -131072 }, 'p2', 4);
    expect(frame.target).toEqual({ x: 65536, y: -131072 });
  });

  it('личность даёт соединение, а не содержимое кадра', () => {
    const frame = toInputFrame(wireInput(4, 2, 65536), 'p2', 4);
    expect(frame.playerId).toBe('p2');
    expect(frame.move).toEqual({ x: 65536, y: 0 });
    expect(frame.tick).toBe(4);
  });
});

/**
 * Поток фактов тиков (NTR-15). Разбор — единственная граница, на которой
 * сообщение становится доверенным, поэтому каждое нарушение формы называется
 * исходом, а не пропускается молча.
 */
describe('разбор потока событий', () => {
  const events = (patch: Record<string, unknown> = {}): unknown => ({
    type: 'Events',
    epoch: 1,
    from: 4,
    to: 6,
    batches: [{ tick: 5, events: [{ type: 'EntityDied', data: { entity: 3 } }] }],
    ...patch,
  });

  it('пустой диапазон без событий разбирается: тишина отличима от потери', () => {
    const parsed = parseServerMessage(events({ batches: [] }));
    expect(parsed).toEqual({ type: 'Events', epoch: 1, from: 4, to: 6, batches: [] });
  });

  it('from больше to отвергается: диапазон замкнутый', () => {
    expect(() => parseServerMessage(events({ from: 7, to: 6, batches: [] }))).toThrow(ProtocolError);
    // Диапазон в один тик легален — замкнутость включает обе границы.
    expect(() => parseServerMessage(events({ from: 5, to: 5 }))).not.toThrow();
  });

  it('отрицательный и дробный номер тика в диапазоне отвергается', () => {
    expect(() => parseServerMessage(events({ from: -1, to: 6, batches: [] }))).toThrow(ProtocolError);
    expect(() => parseServerMessage(events({ from: 4, to: 6.5, batches: [] }))).toThrow(ProtocolError);
  });

  it('пачка с тиком вне объявленного диапазона отвергается', () => {
    expect(() => parseServerMessage(events({ batches: [{ tick: 3, events: [] }] }))).toThrow(ProtocolError);
    expect(() => parseServerMessage(events({ batches: [{ tick: 7, events: [] }] }))).toThrow(ProtocolError);
    // Обе границы включающие.
    expect(() =>
      parseServerMessage(events({ batches: [{ tick: 4, events: [] }, { tick: 6, events: [] }] })),
    ).not.toThrow();
  });

  it('пустой тип события отвергается', () => {
    expect(() =>
      parseServerMessage(events({ batches: [{ tick: 5, events: [{ type: '', data: {} }] }] })),
    ).toThrow(ProtocolError);
  });

  it('data — плоская карта чисел, вложенность отвергается (OBS-1)', () => {
    const nested = { type: 'Hit', data: { entity: 3, at: { x: 1 } } };
    expect(() => parseServerMessage(events({ batches: [{ tick: 5, events: [nested] }] }))).toThrow(
      ProtocolError,
    );
    const stringly = { type: 'Hit', data: { entity: '3' } };
    expect(() => parseServerMessage(events({ batches: [{ tick: 5, events: [stringly] }] }))).toThrow(
      ProtocolError,
    );
    const listed = { type: 'Hit', data: { entity: [3] } };
    expect(() => parseServerMessage(events({ batches: [{ tick: 5, events: [listed] }] }))).toThrow(
      ProtocolError,
    );
  });

  it('отсутствующая эпоха диапазона — разрыв, а не умолчание (NTR-16)', () => {
    const { epoch: _epoch, ...withoutEpoch } = events() as Record<string, unknown>;
    expect(() => parseServerMessage(withoutEpoch)).toThrow(ProtocolError);
  });

  it('потолка на число пачек нет: границы NTR-15 меряются в тиках', () => {
    // Сотня пачек — больше, чем `MAX_FRAMES_PER_MESSAGE` у `Input`: потолок
    // разбора ввода потоку событий не наследуется, иначе бой на длинном
    // диапазоне давал бы молча укороченную пачку.
    const batches = Array.from({ length: 100 }, (_, i) => ({
      tick: i,
      events: [{ type: 'Hit', data: { entity: i } }],
    }));
    const parsed = parseServerMessage(events({ from: 0, to: 99, batches }));
    expect(parsed).toMatchObject({ type: 'Events', from: 0, to: 99 });
    expect((parsed as { batches: readonly unknown[] }).batches).toHaveLength(100);
  });

  it('batches не массив — отвергается, а не пропускается молча', () => {
    expect(() => parseServerMessage(events({ batches: {} }))).toThrow(ProtocolError);
    expect(() => parseServerMessage(events({ batches: [{ tick: 5 }] }))).toThrow(ProtocolError);
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
