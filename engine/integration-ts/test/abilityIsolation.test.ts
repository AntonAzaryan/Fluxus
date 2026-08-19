/**
 * Изоляция сущностей-спутников платформы в персональном снапшоте (NET-12) — на
 * настоящей вертикали с туманом войны, а не на вызове фильтра.
 *
 * Предмет проверки — направление умолчания. `filter.ts` считает публичной
 * сущность БЕЗ компонента `Visibility`, и слот способности, которому маску
 * забыли выдать, уехал бы каждому участнику матча вместе с остатками
 * кулдаунов, фазой каста и накопленным прицеливанием. Тест держит именно это:
 * ни одного ЧУЖОГО `AbilitySlot` и ни одного чужого `BuffInstance` в снапшоте
 * противника, при том что сам чужой герой и сущность, заспавненная его кастом,
 * в нём есть — они часть мира, а не состояние чужого слота.
 *
 * Почему здесь, а не в `core-ts`: масок здесь никто не расставляет руками —
 * их считает `VisibilitySystem`, объявленная конфигом матча (NTR-14), и
 * наследует `AbilityVisibilitySystem`, зарегистрированная загрузчиком; а
 * вырезает их сетевой слой на пути к клиенту. Разойтись эта цепочка может
 * только целиком.
 */
import { describe, expect, it } from 'vitest';
import { query, world as coreWorld } from '@game-mvp/core';
import type { PresentedState } from '@game-mvp/net';
import { abilityFogConfig, playMatch, walkRight } from './fixtures.js';

type View = PresentedState['world'];

const SLOT = 'AbilitySlot';
const INSTANCE = 'BuffInstance';

/** Стороны владельцев слотов, лежащих в этом мире (`Player.slot` — биндинг сцены). */
function slotSides(view: View): number[] {
  return [...query(view, { all: [SLOT] })].map((slot) =>
    coreWorld.getField(view, coreWorld.getField(view, slot, SLOT, 'owner'), 'Player', 'slot'),
  );
}

/** Стороны целей инстансов баффов, лежащих в этом мире. */
function buffSides(view: View): number[] {
  return [...query(view, { all: [INSTANCE] })].map((instance) =>
    coreWorld.getField(view, coreWorld.getField(view, instance, INSTANCE, 'target'), 'Player', 'slot'),
  );
}

/** Стороны героев, оставшихся в этом мире. */
function heroSides(view: View): number[] {
  return [...query(view, { all: ['Player', 'Position'] })].map((hero) =>
    coreWorld.getField(view, hero, 'Player', 'slot'),
  );
}

/** Стороны, которым принадлежат заспавненные кастом сущности мира. */
function flareSides(view: View): number[] {
  return [...query(view, { all: ['Trace'] })].map((flare) => coreWorld.getField(view, flare, 'Trace', 'by'));
}

describe('спутники платформы в персональном снапшоте (NET-12)', () => {
  it('чужих слотов и чужих инстансов у клиента нет, а чужой герой и его каст — есть', async () => {
    // Восемь тиков: слот 0 уже сместился, но обзора (радиус 1) не покинул —
    // видимость ещё общая, и вырезано будет только то, что вырезает маска
    // спутника, а не туман.
    const match = await playMatch(8, { a: walkRight(1000) }, abilityFogConfig());
    const canon = match.server.snapshot().world;

    // Контроль непустоты: в каноническом мире спутники обеих сторон есть.
    expect(slotSides(canon).sort()).toEqual([0, 1]);
    expect(buffSides(canon).sort()).toEqual([0, 1]);
    expect(flareSides(canon).sort()).toEqual([0, 1]);

    const a = match.a.client.latest!.world;
    const b = match.b.client.latest!.world;

    // Слот способности виден РОВНО стороне владельца: остатки кулдаунов и
    // накопленное прицеливание клиенту противника недоступны физически.
    expect(slotSides(a)).toEqual([0]);
    expect(slotSides(b)).toEqual([1]);

    // Инстанс баффа наследует маску цели, а цель сейчас видна обоим.
    expect(buffSides(a).sort()).toEqual([0, 1]);
    expect(buffSides(b).sort()).toEqual([0, 1]);

    // При этом сам чужой герой и сущность, заспавненная его кастом, в снапшоте
    // есть: скрыто состояние решения, а не мир.
    expect(heroSides(b).sort()).toEqual([0, 1]);
    expect(flareSides(b).sort()).toEqual([0, 1]);
  });

  it('цель ушла в туман — её инстансы баффов исчезли вместе с ней', async () => {
    // К 24-му тику слот 0 покинул обзор слота 1: маска цели сузилась до её
    // собственной стороны, и маска инстанса обязана сузиться вместе с ней.
    const match = await playMatch(24, { a: walkRight(1000) }, abilityFogConfig());
    const b = match.b.client.latest!.world;

    expect(heroSides(b)).toEqual([1]);
    expect(buffSides(b)).toEqual([1]);
    expect(slotSides(b)).toEqual([1]);

    // Канонический мир при этом полон: вырезание — свойство проекции (NET-12).
    expect(buffSides(match.server.snapshot().world).sort()).toEqual([0, 1]);
  });
});
