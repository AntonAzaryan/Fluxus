/**
 * Вертикальное смещение инстанса (REND-12): дуга прыжка по фазе манёвра и
 * снижение при провале. Чистая математика — ни сцены, ни THREE.
 */
import { describe, expect, it } from 'vitest';
import { advanceFall, jumpArc } from '../src/index.js';

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
