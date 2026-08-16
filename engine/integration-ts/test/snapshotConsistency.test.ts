/**
 * Согласованность персональных снапшотов двух клиентов (NET-12, DET-1) на
 * настоящей вертикали с туманом войны.
 *
 * Требование двустороннее, и проверяются обе стороны. Пока сущность видима
 * обоим, её состояние в обоих персональных снапшотах — побитово состояние
 * канонического мира: тик исполняется один раз, фильтрация — производная
 * проекция, и никакой «своей» симуляции у клиента нет. Когда же видимость
 * расходится, персональные снапшоты РАСХОДЯТСЯ по схеме идентификаторов —
 * вырезание идёт штатным удалением в копии, поколение слота растёт (ID-3), слот
 * уходит в freeList (ID-6), — и NET-12 прямо велит НЕ считать это десинком:
 * канонический мир один, а запись матча по-прежнему реплеится побитово (NTR-8).
 *
 * Почему это здесь, а не в `net-ts`: попарно фильтр и его вызов уже проверены
 * (`filtering.test.ts` ядра и net), а согласие ДВУХ клиентов на живом канале —
 * свойство вертикали, и разойтись стороны могут попарно.
 */
import { describe, expect, it } from 'vitest';
import { query, runScenario, snapshotToPlain, world as coreWorld } from '@game-mvp/core';
import type { PresentedState } from '@game-mvp/net';
import { fogConfig, playMatch, walkRight } from './fixtures.js';

/** Позиции героев по слотам — общая часть трёх миров, сравниваемая побитово. */
function positionsBySlot(world: PresentedState['world']): Record<number, { x: number; y: number }> {
  const result: Record<number, { x: number; y: number }> = {};
  for (const entity of query(world, { all: ['Player', 'Position'] })) {
    result[coreWorld.getField(world, entity, 'Player', 'slot')] = {
      x: coreWorld.getField(world, entity, 'Position', 'x'),
      y: coreWorld.getField(world, entity, 'Position', 'y'),
    };
  }
  return result;
}

describe('персональные снапшоты двух клиентов на одном тике (NET-12)', () => {
  it('пока герои видят друг друга, общие сущности совпадают с каноном побитово', async () => {
    // Восемь тиков: слот 0 уже заметно сместился, но обзора (радиус 1) не покинул.
    const match = await playMatch(8, { a: walkRight(1000) }, fogConfig());
    const a = match.a.client.latest!;
    const b = match.b.client.latest!;

    // Один и тот же тик у сервера и обоих клиентов: сравнение — на общем срезе.
    expect(a.tick).toBe(match.server.tick);
    expect(b.tick).toBe(match.server.tick);

    const canon = positionsBySlot(match.server.snapshot().world);
    // Контроль непустоты: видимы оба героя, и движение уже видно в каноне —
    // совпадение не является совпадением нулей.
    expect(Object.keys(canon).sort()).toEqual(['0', '1']);
    expect(canon[0]!.x).toBeGreaterThan(0);

    expect(positionsBySlot(a.world)).toEqual(canon);
    expect(positionsBySlot(b.world)).toEqual(canon);
  });

  it('разошедшаяся видимость меняет схему ID проекций, но не канонический мир', async () => {
    // К 24-му тику слот 0 ушёл за радиус обзора: каждый клиент видит только себя.
    const match = await playMatch(24, { a: walkRight(1000) }, fogConfig());
    const a = coreWorld.toPlain(match.a.client.latest!.world);
    const b = coreWorld.toPlain(match.b.client.latest!.world);
    const canon = coreWorld.toPlain(match.server.snapshot().world);

    // Контроль: видимость действительно разошлась — у каждого остался свой герой.
    expect(Object.keys(positionsBySlot(match.a.client.latest!.world))).toEqual(['0']);
    expect(Object.keys(positionsBySlot(match.b.client.latest!.world))).toEqual(['1']);

    // Канонический мир полон: в нём никто ничего не вырезал.
    expect(canon.freeList).toEqual([]);

    // Персональные проекции разошлись со схемой ID канона — и друг с другом:
    // вырезание шло штатным удалением (ID-3, ID-6), и вырезаны разные сущности.
    expect(a.freeList).toHaveLength(1);
    expect(b.freeList).toHaveLength(1);
    expect(a.freeList).not.toEqual(b.freeList);
    expect(a.generations).not.toEqual(canon.generations);
    expect(b.generations).not.toEqual(canon.generations);
    expect(a.aliveCount).toBe(canon.aliveCount - 1);

    // И это норма, а не десинк (NET-12): вход следующего тика — канонический
    // мир, и запись матча реплеится ядром побитово (NTR-8).
    const replay = runScenario(match.server.toScenario());
    expect(replay.worldInitHash).toBe(match.server.worldInitHash);
    expect(replay.ticks[replay.ticks.length - 1]).toEqual(snapshotToPlain(match.server.snapshot()));
  });
});
