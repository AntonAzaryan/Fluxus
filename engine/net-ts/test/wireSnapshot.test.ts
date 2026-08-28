/**
 * Состав персонального снапшота НА ПРОВОДЕ (NET-18) и пересчёт видимости в
 * конфиге матча (NTR-14).
 *
 * Предмет проверки — не фильтрация (она в `filtering.test.ts` и в тестах ядра), а
 * состав кадра: он строится из перечисленных частей, состояний стримов RNG в нём
 * нет ни при каком `viewpoint`, включая наблюдателя, а эпоха едет полем сообщения
 * рядом с проекцией, а не внутри неё.
 */
import { describe, expect, it } from 'vitest';
import { snapshotToPlain, VIEWPOINT_ALL } from '@fluxus/core';
import { buildMatchWorld } from '../src/match/world.js';
import { MatchClient } from '../src/client/matchClient.js';
import { contentPack } from '../src/content/pack.js';
import { parseServerMessage } from '../src/protocol/messages.js';
import { MatchServer } from '../src/server/matchServer.js';
import { duelConfig, duelScene, fogScene, harness, hello, versionOf } from './fixtures.js';
import type { SnapshotMessage } from '../src/protocol/messages.js';
import type { MatchConfig } from '../src/server/matchServer.js';

/** Сцена с флагом `fog` обязывает конфиг объявить пересчёт видимости (NTR-14). */
function fogConfig(overrides: Partial<MatchConfig> = {}): MatchConfig {
  return duelConfig({
    scene: fogScene(),
    visibility: {},
    snapshotRate: 60,
    initial: [
      { prefab: 'Hero', overrides: { Visibility: { visibleTo: 1 }, Team: { id: 0 } } },
      {
        prefab: 'Hero',
        overrides: { Player: { slot: 1 }, Visibility: { visibleTo: 2 }, Team: { id: 1 } },
      },
    ],
    ...overrides,
  });
}

/** Матч двух игроков и наблюдателя на исполненном тике: три `viewpoint` на один тик. */
function withObserver(): { server: MatchServer; frames: Map<number, SnapshotMessage> } {
  const config = fogConfig({ allowObserver: true });
  const { server } = harness(config);
  server.connect(1);
  server.receive(1, hello('p1', config.version));
  server.connect(2);
  server.receive(2, hello('p2', config.version));
  server.connect(3);
  server.receive(3, hello('watcher', config.version, true));
  server.drain();
  server.advance();

  const frames = new Map<number, SnapshotMessage>();
  for (const outgoing of server.drain()) {
    if (outgoing.message.type === 'Snapshot') frames.set(outgoing.to, outgoing.message);
  }
  return { server, frames };
}

describe('состав кадра Snapshot (NET-18)', () => {
  it('состояний стримов RNG в кадре нет ни у игрока, ни у наблюдателя', () => {
    const { server, frames } = withObserver();
    expect(frames.size).toBe(3);

    for (const message of frames.values()) {
      expect(Object.keys(message.snapshot).sort()).toEqual(['events', 'mode', 'tick', 'world']);
      expect('rng' in message.snapshot).toBe(false);
    }
    // Наблюдателю исключение не снимается: основание — назначение потока, а не
    // видимость, и отдельной ветки «спектейтору можно всё» нет.
    // Три сущности: два героя плюс носитель карты пола — сцена с туманом
    // обязана нести террейн (SER-7), и носитель публичен (NET-12).
    expect(frames.get(3)!.snapshot.world.aliveCount).toBe(3);
    expect('rng' in frames.get(3)!.snapshot).toBe(false);

    // Контроль: плоская форма снапшота МИРА состояния стримов по-прежнему несёт —
    // исключение касается провода, а не хранения и не вывода CLI (NET-18, SNAP-1,
    // CLI-3). Список стримов в этой сцене пуст (никто не тянул случайность,
    // стримы ленивые), и предмет контроля именно поле, а не его содержимое.
    expect('rng' in snapshotToPlain(server.snapshot(VIEWPOINT_ALL))).toBe(true);
  });

  it('перечисленные части в кадре есть: номер тика, машина состояний, шина, схема ID', () => {
    const { server, frames } = withObserver();

    for (const message of frames.values()) {
      expect(message.snapshot.tick).toBe(server.tick);
      // Машина состояний мира (WSM-1): клиент обязан отличать идущий мир от
      // замороженного и перематываемого (NET-11, SHELL-7).
      expect(message.snapshot.mode).toBe('Running');
      // Шина этого тика — часть проекции; на этом тике событий не было, и пустой
      // список означает именно это.
      expect(message.snapshot.events).toEqual([]);
      // Схема идентификаторов персональной копии (ID-4): без неё утверждение
      // NET-12 про `generations`/`freeList` не о чем.
      expect(message.snapshot.world.generations.length).toBeGreaterThan(0);
      expect(message.snapshot.world.freeList).toBeDefined();
    }
  });

  it('эпоха едет полем сообщения рядом с проекцией, а не внутри неё (NTR-16)', () => {
    const { frames } = withObserver();
    for (const message of frames.values()) {
      expect(message.epoch).toBe(0);
      expect('epoch' in message.snapshot).toBe(false);
    }
  });

  it('в декодированном клиентом кадре состояний стримов нет ни при каком viewpoint', () => {
    const { frames } = withObserver();
    for (const message of frames.values()) {
      // Через настоящий разбор, и с подсунутым `rng`: части ВЫБИРАЮТСЯ по именам,
      // поэтому сервер постарше нормы не пронесёт стримы в декодированный кадр.
      const decoded = parseServerMessage({
        ...message,
        snapshot: { ...message.snapshot, rng: [{ name: 'подсунутый', state: [1, 2, 3, 4] }] },
      }) as SnapshotMessage;

      expect(decoded.type).toBe('Snapshot');
      expect('rng' in decoded.snapshot).toBe(false);
      expect(Object.keys(decoded.snapshot).sort()).toEqual(['events', 'mode', 'tick', 'world']);
      expect(decoded.snapshot.mode).toBe('Running');
    }
  });

  it('клиент применяет кадр без состояний стримов и продолжает играть (NTR-10)', () => {
    const config = duelConfig({ snapshotRate: 60 });
    const { server } = harness(config);
    const pack = contentPack({ duel: config.scene });
    const client = new MatchClient({ playerId: 'p1', version: versionOf(config.scene), content: pack });

    server.connect(1);
    server.receive(1, hello('p1', config.version));
    server.connect(2);
    server.receive(2, hello('p2', config.version));
    const relay = (atMs: number): void => {
      for (const outgoing of server.drain()) {
        if (outgoing.to === 1) client.receive(outgoing.message, atMs);
      }
    };
    relay(0);
    server.advance();
    relay(1);

    expect(client.phase).toBe('playing');
    expect(client.metrics.snapshotsApplied).toBe(1);
    expect(client.latest!.tick).toBe(server.tick);
    // Мир восстановлен, а реестр стримов у восстановленного снапшота пуст: клиент
    // `tick()` не исполняет, тянуть случайность ему нечем и незачем (NTR-10).
    expect(client.latest!.rng).toEqual([]);
  });
});

describe('пересчёт видимости в конфиге матча (NTR-14)', () => {
  it('сцена с fog без объявленного пересчёта — отказ сборки, и он называет пересчёт', () => {
    expect(() => buildMatchWorld({ scene: fogScene(), seed: 1, players: ['p1'] })).toThrow(
      /пересчёт видимости/,
    );
    // Тот же отказ на пути сервера, до первого тика: матч не начинается с
    // масками, замороженными на значениях начальной расстановки. Пересчёт НЕ
    // объявлен — то есть ключа в конфиге нет вовсе: документ матча (NTR-6)
    // ключа со значением `undefined` не знает, и отказ обязан ловить именно
    // отсутствие секции.
    const { visibility: _undeclared, ...withoutVisibility } = fogConfig();
    expect(() => new MatchServer(withoutVisibility)).toThrow(/пересчёт видимости/);
  });

  it('сцена без fog собирается без объявления пересчёта и не требует его', () => {
    const built = buildMatchWorld({ scene: duelScene(), seed: 1, players: ['p1'] });
    expect(built.sim.systems.ordered().map((system) => system.name)).not.toContain('Visibility');
    expect(() => new MatchServer(duelConfig())).not.toThrow();
  });

  it('объявленный пересчёт даёт систему в составе матча', () => {
    const config = fogConfig();
    const built = buildMatchWorld({
      scene: config.scene,
      seed: config.seed,
      players: config.players,
      initial: config.initial!,
      visibility: config.visibility!,
    });
    expect(built.sim.systems.ordered().map((system) => system.name)).toContain('Visibility');
  });

  /**
   * Обе стороны берут зависимости сборки из одного описания матча (NTR-14), и
   * проверяется это КЛИЕНТСКИМ путём — хендшейком настоящего `MatchClient`, — а не
   * вторым вызовом `buildMatchWorld` рядом: тот сравнивал бы функцию с собой.
   *
   * Наблюдаемая разница здесь резкая, и это и есть смысл отказа сборки: клиент,
   * которому пересчёт не передали, в матч НЕ ВХОДИТ, вместо того чтобы войти с
   * составом систем, отличным от серверного.
   */
  it('клиент входит в матч с туманом, только получив пересчёт из того же описания', () => {
    const config = fogConfig();
    const pack = contentPack({ duel: config.scene });
    const greet = (visibility?: MatchConfig['visibility']): MatchClient => {
      const { server } = harness(config);
      const client = new MatchClient({
        playerId: 'p1',
        version: versionOf(config.scene),
        content: pack,
        ...(visibility !== undefined ? { visibility } : {}),
      });
      server.connect(1);
      server.receive(1, hello('p1', config.version));
      for (const outgoing of server.drain()) {
        if (outgoing.to === 1) client.receive(outgoing.message, 0);
      }
      return client;
    };

    const withRecompute = greet(config.visibility);
    expect(withRecompute.phase).toBe('lobby');
    // Хеши сошлись — значит мир клиента поднялся тем же путём, что серверный.
    expect(withRecompute.worldInitHash).toBe(new MatchServer(config).worldInitHash);

    const without = greet();
    expect(without.phase).toBe('closed');
    expect(without.closeReason).toBe('data-mismatch');
    expect(without.closeDetail).toMatch(/пересчёт видимости/);
  });
});
