/**
 * Вертикальное смещение инстанса (REND-12): дуга прыжка по фазе манёвра и
 * снижение при провале. Чистая математика — ни сцены, ни THREE.
 */
import { describe, expect, it } from 'vitest';
import { advanceFall, jumpArc, jumpBase, maneuverEnds, type ManeuverEnds } from '../src/index.js';

const ends = (): ManeuverEnds => ({ takeoffX: 0, takeoffY: 0, landingX: 0, landingY: 0 });

describe('jumpArc: парабола по фазе манёвра (REND-12)', () => {
  it('ноль на концах, максимум высоты в середине', () => {
    expect(jumpArc(0, 2)).toBe(0);
    expect(jumpArc(1, 2)).toBe(0);
    expect(jumpArc(0.5, 2)).toBeCloseTo(2, 10);
    expect(jumpArc(0.25, 2)).toBeCloseTo(1.5, 10);
    // Симметрия: подъём и спуск — одна и та же кривая.
    expect(jumpArc(0.3, 2)).toBeCloseTo(jumpArc(0.7, 2), 10);
  });

  it('NaN («манёвра нет») и отсутствие высоты дают ноль', () => {
    expect(jumpArc(Number.NaN, 2)).toBe(0);
    expect(jumpArc(0.5, 0)).toBe(0);
    expect(jumpArc(Number.POSITIVE_INFINITY, 2)).toBe(0);
  });

  it('фаза за пределами [0..1] кламппится, а не уводит дугу под землю', () => {
    expect(jumpArc(-0.5, 2)).toBe(0);
    expect(jumpArc(1.5, 2)).toBe(0);
  });
});

describe('maneuverEnds: концы манёвра из фазы (REND-12)', () => {
  // Манёвр в 4 тика: шаг фазы 0.25, шаг позиции — 1 по x за тик.
  const STEP = 0.25;

  it('первый тик манёвра: отрыв — позиция до прыжка, приземление — конец траектории', () => {
    const out = maneuverEnds(1, 0, 1, 0, STEP, STEP, ends());
    expect(out.takeoffX).toBeCloseTo(0, 10);
    expect(out.landingX).toBeCloseTo(4, 10);
    expect(out.takeoffY).toBeCloseTo(0, 10);
    expect(out.landingY).toBeCloseTo(0, 10);
  });

  it('последний тик манёвра даёт те же концы: траектория одна на весь манёвр', () => {
    const out = maneuverEnds(3, 0, 1, 0, 0.75, STEP, ends());
    expect(out.takeoffX).toBeCloseTo(0, 10);
    expect(out.landingX).toBeCloseTo(4, 10);
  });

  it('диагональный прыжок экстраполируется по обеим осям', () => {
    const out = maneuverEnds(1, 2, 0.5, 1, 0.5, STEP, ends());
    expect(out.takeoffX).toBeCloseTo(0, 10);
    expect(out.takeoffY).toBeCloseTo(0, 10);
    expect(out.landingX).toBeCloseTo(2, 10);
    expect(out.landingY).toBeCloseTo(4, 10);
  });

  it('вырожденный вход схлопывает концы в текущую позицию', () => {
    // Разрыв непрерывности: prev = curr, шага фазы нет (REND-2).
    expect(maneuverEnds(7, 3, 1, 0, 0.5, 0, ends())).toMatchObject({
      takeoffX: 7,
      takeoffY: 3,
      landingX: 7,
      landingY: 3,
    });
    // Прыжок на месте: перемещения за тик нет.
    expect(maneuverEnds(7, 3, 0, 0, 0.5, STEP, ends())).toMatchObject({ takeoffX: 7, landingX: 7 });
    // Манёвра нет вовсе.
    expect(maneuverEnds(7, 3, 1, 0, Number.NaN, STEP, ends())).toMatchObject({
      takeoffX: 7,
      landingX: 7,
    });
  });

  it('фаза за пределами [0..1] кламппится', () => {
    expect(maneuverEnds(1, 0, 1, 0, 1.5, STEP, ends()).landingX).toBeCloseTo(1, 10);
    expect(maneuverEnds(1, 0, 1, 0, -0.5, STEP, ends()).takeoffX).toBeCloseTo(1, 10);
  });
});

describe('jumpBase: переход между опорными высотами (REND-12)', () => {
  it('идёт от высоты отрыва к высоте приземления по фазе', () => {
    expect(jumpBase(0, 0.5, 0)).toBe(0);
    expect(jumpBase(0, 0.5, 1)).toBe(0.5);
    expect(jumpBase(0, 0.5, 0.5)).toBeCloseTo(0.25, 10);
    // Прыжок вниз — та же прямая с другим знаком.
    expect(jumpBase(0.5, 0, 0.25)).toBeCloseTo(0.375, 10);
  });

  it('ровная площадка даёт постоянное основание — прежнее поведение', () => {
    for (const p of [0, 0.3, 0.7, 1]) expect(jumpBase(1.5, 1.5, p)).toBeCloseTo(1.5, 10);
  });

  it('фаза вне диапазона и NaN не уводят основание за концы', () => {
    expect(jumpBase(0, 0.5, 1.5)).toBe(0.5);
    expect(jumpBase(0, 0.5, -1)).toBe(0);
    expect(jumpBase(0, 0.5, Number.NaN)).toBe(0.5);
  });
});

describe('advanceFall: снижение при провале (REND-12, ARENA-5)', () => {
  it('идёт вниз со скоростью и упирается в глубину', () => {
    let offset = 0;
    offset = advanceFall(offset, 6, 4, 0.1);
    expect(offset).toBeCloseTo(-0.6, 10);
    offset = advanceFall(offset, 6, 4, 0.1);
    expect(offset).toBeCloseTo(-1.2, 10);
    // Большой шаг не проваливает инстанс глубже заданного: дальше он висит.
    offset = advanceFall(offset, 6, 4, 10);
    expect(offset).toBe(-4);
    expect(advanceFall(offset, 6, 4, 10)).toBe(-4);
  });

  it('без глубины или без скорости снижения нет', () => {
    expect(advanceFall(0, 6, 0, 0.1)).toBe(0);
    expect(advanceFall(0, 0, 4, 0.1)).toBe(0);
    expect(advanceFall(-2, 6, 4, 0)).toBe(-2); // кадр без времени ничего не двигает
  });
});
