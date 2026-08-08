/**
 * Персональные снапшоты (NTR-9, NET-12).
 *
 * Проверяется не то, как ядро считает видимость — это зона FoW-тестов ядра, — а
 * то, что сетевой слой зовёт фильтр с верным `viewpoint` и не выдаёт игроку
 * поток без фильтрации.
 */
import { describe, expect, it } from 'vitest';
import { duelConfig, fogScene, harness, hello } from './fixtures.js';
import type { SnapshotMessage } from '../src/protocol/messages.js';

/** Оба героя видимы только своей команде: слот 0 — биту 0, слот 1 — биту 1. */
function fogConfig(overrides = {}) {
  return duelConfig({
    scene: fogScene(),
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

function snapshotsAfterTick(config = fogConfig(), observer = false) {
  const fixture = harness(config);
  const { server } = fixture;
  server.connect(1);
  server.receive(1, hello('p1', config.version));
  server.connect(2);
  server.receive(2, hello('p2', config.version));
  if (observer) {
    server.connect(3);
    server.receive(3, hello('watcher', config.version, true));
  }
  server.drain();
  server.advance();

  const byConnection = new Map<number, SnapshotMessage>();
  for (const outgoing of server.drain()) {
    if (outgoing.message.type === 'Snapshot') byConnection.set(outgoing.to, outgoing.message);
  }
  return byConnection;
}

describe('фильтрация по viewpoint', () => {
  it('тик считается один раз, снапшотов — по числу соединений', () => {
    const snapshots = snapshotsAfterTick();
    expect(snapshots.size).toBe(2);
  });

  it('невидимый противник в снапшот не попадает', () => {
    const snapshots = snapshotsAfterTick();

    for (const [connection, message] of snapshots) {
      const world = message.snapshot.world;
      // Своя сущность осталась, чужая вырезана штатным удалением (NET-12).
      expect(world.aliveCount).toBe(1);
      const slot = connection - 1;
      expect(world.alive[slot]).toBe(1);
      expect(world.alive[1 - slot]).toBe(0);
    }
  });

  it('персональные снапшоты расходятся по generations и freeList — это норма (NET-12)', () => {
    const snapshots = snapshotsAfterTick();
    const [first, second] = [...snapshots.values()];

    expect(first!.snapshot.world.freeList).not.toEqual(second!.snapshot.world.freeList);
    expect(first!.snapshot.world.generations).not.toEqual(second!.snapshot.world.generations);
    // При этом тик один и тот же: канонический мир один, персональные — производные.
    expect(first!.tick).toBe(second!.tick);
  });

  it('наблюдатель получает полный мир', () => {
    const snapshots = snapshotsAfterTick(fogConfig({ allowObserver: true }), true);
    expect(snapshots.size).toBe(3);

    const observer = snapshots.get(3)!;
    expect(observer.snapshot.world.aliveCount).toBe(2);
  });

  it('сцена без тумана фильтром не режется', () => {
    const snapshots = snapshotsAfterTick(duelConfig({ snapshotRate: 60 }));
    for (const message of snapshots.values()) {
      expect(message.snapshot.world.aliveCount).toBe(2);
    }
  });
});

describe('авторизация полного потока', () => {
  it('игровому слоту viewpoint = ALL не выдаётся ни при каких условиях (NTR-9)', () => {
    // -1 — это `VIEWPOINT_ALL`. Конфиг, пытающийся выдать его игроку, не
    // собирается: иначе wallhack въезжал бы опечаткой в конфиге.
    expect(() => harness(fogConfig({ teams: [-1, 1] }))).toThrow(/вне диапазона/);
    expect(() => harness(fogConfig({ teams: [0, 99] }))).toThrow(/вне диапазона/);
  });

  it('явные команды слотов уважаются', () => {
    // Оба игрока в команде 0 — видят друг друга.
    const snapshots = snapshotsAfterTick(fogConfig({ teams: [0, 0] }));
    const forSecond = snapshots.get(2)!;
    expect(forSecond.snapshot.world.aliveCount).toBe(1);
    // Слот 1 в команде 0 видит героя команды 0, а не себя: маска задана расстановкой.
    expect(forSecond.snapshot.world.alive[0]).toBe(1);
  });
});
