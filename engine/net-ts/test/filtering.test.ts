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

/**
 * Оба героя видимы только своей команде: слот 0 — биту 0, слот 1 — биту 1.
 *
 * Сцена включает флаг `fog`, поэтому конфиг ОБЯЗАН объявить пересчёт видимости
 * (NTR-14) — без него матч не собирается. Расстановка при этом ставит те же
 * маски, что посчитает `VisibilitySystem`: наблюдателей с `Vision` в сцене нет,
 * и маска сущности сводится к биту её собственной команды (FOW-3).
 */
function fogConfig(overrides = {}) {
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

/**
 * Сущностей-носителей у сцены с туманом ровно одна — носитель карты пола: `fog`
 * без `terrain` загрузчик отвергает (SER-7). Носители спавнятся до расстановки
 * (SER-7), поэтому герои занимают слоты, сдвинутые на это число.
 */
const CARRIERS = 1;

function running(config = fogConfig(), observer = false) {
  const { server } = harness(config);
  server.connect(1);
  server.receive(1, hello('p1', config.version));
  server.connect(2);
  server.receive(2, hello('p2', config.version));
  if (observer) {
    server.connect(3);
    server.receive(3, hello('watcher', config.version, true));
  }
  server.drain();
  return server;
}

/** Разосланные снапшоты по соединениям — то, что каждое из них реально увидело. */
function drainSnapshots(server: ReturnType<typeof running>) {
  const byConnection = new Map<number, SnapshotMessage>();
  for (const outgoing of server.drain()) {
    if (outgoing.message.type === 'Snapshot') byConnection.set(outgoing.to, outgoing.message);
  }
  return byConnection;
}

function snapshotsAfterTick(config = fogConfig(), observer = false) {
  const server = running(config, observer);
  server.advance();
  return drainSnapshots(server);
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
      // Плюс носитель карты пола: сцена с туманом обязана нести террейн
      // (SER-7), носитель спавнится первым и `Visibility` не несёт, поэтому
      // остаётся в каждом персональном снапшоте (NET-12).
      expect(world.aliveCount).toBe(2);
      expect(world.alive[CARRIERS - 1]).toBe(1);
      const slot = connection - 1;
      expect(world.alive[CARRIERS + slot]).toBe(1);
      expect(world.alive[CARRIERS + 1 - slot]).toBe(0);
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
    expect(observer.snapshot.world.aliveCount).toBe(CARRIERS + 2);
  });

  it('сцена без тумана фильтром не режется', () => {
    const snapshots = snapshotsAfterTick(duelConfig({ snapshotRate: 60 }));
    for (const message of snapshots.values()) {
      expect(message.snapshot.world.aliveCount).toBe(2);
    }
  });

  it('восстановленное состояние режется по видимости целевого тика (REW-11, NTR-9)', () => {
    // Рассылка по факту восстановления идёт мимо расписания (NTR-16), то есть
    // отдельным путём, — и персональная фильтрация обязана применяться к ней на
    // общих основаниях. Разослать в этой точке канонический мир было бы самым
    // естественным сокращением и означало бы wallhack ровно на время перемотки.
    const server = running(fogConfig({ rewind: { interval: 1, capacity: 32 } }));
    for (let tick = 1; tick <= 6; tick++) server.advance();
    server.drain();

    server.pause();
    server.beginRewind();
    server.seekTo(3);

    const snapshots = drainSnapshots(server);
    expect(snapshots.size).toBe(2);
    for (const [connection, message] of snapshots) {
      expect(message).toMatchObject({ epoch: 1, tick: 3 });
      const world = message.snapshot.world;
      const slot = connection - 1;
      expect(world.aliveCount).toBe(CARRIERS + 1);
      expect(world.alive[CARRIERS + slot]).toBe(1);
      expect(world.alive[CARRIERS + 1 - slot]).toBe(0);
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

  /**
   * Точка зрения слота — команда его СУЩНОСТИ, а не номер слота (NET-12,
   * NET-15). РЕГРЕССИЯ: прежде точка зрения выводилась из номера слота, и в
   * кооперативной сцене — оба игрока в команде 0 — слот 1 получал точку зрения
   * «команда 1», то есть не находил в собственном снапшоте даже своего героя.
   * В дуэли дефект не стрелял только потому, что номер слота случайно совпадал
   * с номером команды.
   */
  it('точка зрения слота берётся из команды его сущности, а не из номера слота (NET-12, NET-15)', () => {
    const coop = fogConfig({
      initial: [
        { prefab: 'Hero', overrides: { Visibility: { visibleTo: 1 }, Team: { id: 0 } } },
        {
          prefab: 'Hero',
          overrides: { Player: { slot: 1 }, Visibility: { visibleTo: 1 }, Team: { id: 0 } },
        },
      ],
    });
    const snapshots = snapshotsAfterTick(coop);

    for (const message of snapshots.values()) {
      // Оба героя в команде 0 и видимы ей: каждый союзник видит и себя, и второго.
      expect(message.snapshot.world.aliveCount).toBe(CARRIERS + 2);
      expect(message.snapshot.world.alive[CARRIERS]).toBe(1);
      expect(message.snapshot.world.alive[CARRIERS + 1]).toBe(1);
    }
  });

  it('объявленная команда слота, совпавшая с миром, действует', () => {
    // Конфиг вправе назвать точку зрения сам — но только ту же самую: второго
    // мнения о команде слота в матче не бывает.
    const declared = fogConfig({
      teams: [0, 0],
      initial: [
        { prefab: 'Hero', overrides: { Visibility: { visibleTo: 1 }, Team: { id: 0 } } },
        {
          prefab: 'Hero',
          overrides: { Player: { slot: 1 }, Visibility: { visibleTo: 1 }, Team: { id: 0 } },
        },
      ],
    });
    const snapshots = snapshotsAfterTick(declared);
    expect(snapshots.get(2)!.snapshot.world.aliveCount).toBe(CARRIERS + 2);
  });

  it('две сущности одного слота в разных командах роняют сборку матча', () => {
    // Расстановка, не договорившаяся о команде слота, не имеет «главной»
    // сущности: выбрать за неё значило бы отдать точку зрения игрока порядку
    // спавна.
    const ambiguous = fogConfig({
      initial: [
        { prefab: 'Hero', overrides: { Visibility: { visibleTo: 1 }, Team: { id: 0 } } },
        {
          prefab: 'Hero',
          overrides: { Player: { slot: 1 }, Visibility: { visibleTo: 2 }, Team: { id: 1 } },
        },
        {
          prefab: 'Hero',
          overrides: { Player: { slot: 1 }, Visibility: { visibleTo: 1 }, Team: { id: 0 } },
        },
      ],
    });
    expect(() => harness(ambiguous)).toThrow(/сущности слота 1 названы разными командами/);
  });

  it('объявленная команда слота, разошедшаяся с миром, роняет сборку матча (NET-15)', () => {
    // Герой слота 1 в мире — команды 1, а конфиг называет его командой 0. Отказ
    // до первого тика, а не персональный снапшот по чужой команде: в нём у
    // игрока не было бы даже собственной сущности.
    expect(() => harness(fogConfig({ teams: [0, 0] }))).toThrow(/слот 1 объявлен командой 0/);
  });
});
