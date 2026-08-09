/**
 * Вертикальный смоук всех слоёв (CLI-9): авторитетный сервер → персональный
 * снапшот → клиент → рендер-хост → объект THREE-сцены. Настоящие реализации,
 * публичные API, один процесс без сокетов и таймеров (NTR-12).
 *
 * Смоук тонкий: содержательные проверки швов остаются в попарных тестах
 * пакетов; здесь — что цепочка жива и позиции мешей соответствуют
 * интерполированному снапшоту (REND-2 поверх NET-3).
 */
import { describe, expect, it } from 'vitest';
import { FIXED_ONE, query, world as coreWorld, type Snapshot } from '@game-mvp/core';
import { TICK_DELTA, TICK_RATE, playMatch, walkRight } from './fixtures.js';

function slotX(snapshot: Snapshot, slot: number): number {
  for (const entity of query(snapshot.world, { all: ['Player', 'Position'] })) {
    if (coreWorld.getField(snapshot.world, entity, 'Player', 'slot') !== slot) continue;
    return coreWorld.getField(snapshot.world, entity, 'Position', 'x');
  }
  throw new Error(`слот ${slot} не найден в снапшоте`);
}

function meshOfSlot(match: Awaited<ReturnType<typeof playMatch>>, slot: number) {
  const snapshot = match.b.client.latest!;
  for (const id of match.bridge.host.view.entities.keys()) {
    if (coreWorld.getField(snapshot.world, id, 'Player', 'slot') !== slot) continue;
    return match.bridge.positions.objects.get(id)!;
  }
  throw new Error(`объект слота ${slot} не найден`);
}

describe('вертикаль сервер → снапшот → клиент → рендер (CLI-9)', () => {
  it('цепочка поднимается: матч идёт, мост построен из того же контента, что сервер', async () => {
    const match = await playMatch(4);
    expect(match.server.phase).toBe('running');
    expect(match.a.client.phase).toBe('playing');
    expect(match.b.client.phase).toBe('playing');
    // Мир моста поднят публичным путём клиента и обязан сойтись с сервером.
    expect(match.bridge.world.worldInitHash).toBe(match.server.worldInitHash);
    // Рендер дожил до последнего снапшота, по объекту THREE на каждого героя.
    expect(match.bridge.host.view.tick).toBe(match.b.client.latest!.tick);
    expect(match.bridge.positions.objects.size).toBe(2);
    expect(match.bridge.scene.children).toHaveLength(2);
  });

  it('ввод игрока 1 доезжает до позиции меша у клиента игрока 2', async () => {
    const match = await playMatch(24, { a: walkRight(1000) });
    const snapshot = match.b.client.latest!;

    // Чужое движение пришло только по цепочке снапшотов.
    const snapX = slotX(snapshot, 0) / FIXED_ONE;
    expect(snapX).toBeGreaterThan(0);

    // Кадр в конце тика: альфа = 1 — меш стоит ровно в позиции снапшота.
    match.clock.ms += 1000 / TICK_RATE;
    match.bridge.host.frame(match.clock.ms);
    expect(meshOfSlot(match, 0).position.x).toBeCloseTo(snapX, 10);

    // Молчащий игрок 2 остался в нуле — и в снапшоте, и в своём меше.
    expect(slotX(snapshot, 1)).toBe(0);
    expect(meshOfSlot(match, 1).position.x).toBe(0);
  });

  it('между тиками меш интерполируется между двумя последними снапшотами (REND-2)', async () => {
    const match = await playMatch(24, { a: walkRight(1000) });
    const snapshot = match.b.client.latest!;
    const snapX = slotX(snapshot, 0) / FIXED_ONE;

    // Игрок шёл непрерывно: позиция предыдущего тика — на смещение тика позади.
    const step = TICK_DELTA / FIXED_ONE;
    match.clock.ms += 1000 / TICK_RATE / 2; // середина тика: альфа = 0.5
    match.bridge.host.frame(match.clock.ms);
    expect(meshOfSlot(match, 0).position.x).toBeCloseTo(snapX - step / 2, 10);
  });
});
