/**
 * Кольцо собственных кадров ввода (NET-9, NET-10).
 *
 * Тестов у кольца не было вовсе: клиент MVP не предсказывает (NTR-10), кольцо
 * ему нужно для замера «нажал → увидел» и разбора потерь, и на матчевых тестах
 * его поведение не видно — они смотрят на снапшоты, а не на то, что клиент
 * помнит о своей отправке. Между тем кольцо и есть шов, который NET-4 потребует
 * готовым, когда предсказание включится: тогда ошибка в вытеснении или в поиске
 * по `seq` станет ошибкой reconciliation, то есть рассинхроном.
 *
 * Глубина (NET-10, ~120 тиков = две секунды при 60 Гц) проверяется как
 * граничное поведение, а не как число ради числа: ровно `capacity` тиков назад
 * кадр обязан быть, на тик глубже — обязан быть вытеснен.
 */
import { describe, expect, it } from 'vitest';
import type { InputFrame } from '@game-mvp/core';
import { DEFAULT_RING_TICKS, InputRing } from '../src/index.js';

function frame(tick: number, seq: number = tick): InputFrame {
  return { tick, playerId: 'p1', seq, move: { x: 0, y: 0 }, aimDir: 0, buttons: 0 };
}

describe('InputRing: ёмкость и глубина (NET-9, NET-10)', () => {
  it('дефолт — 120 тиков: две секунды при 60 Гц', () => {
    expect(DEFAULT_RING_TICKS).toBe(120);
    expect(new InputRing().capacity).toBe(DEFAULT_RING_TICKS);
  });

  it('нулевая и дробная ёмкость отвергаются', () => {
    expect(() => new InputRing(0)).toThrow(/ёмкость/);
    expect(() => new InputRing(-1)).toThrow(/ёмкость/);
    expect(() => new InputRing(1.5)).toThrow(/ёмкость/);
  });

  it('хранит ровно capacity последних тиков, на тик глубже — уже нет', () => {
    const ring = new InputRing(4);
    for (let tick = 0; tick < 10; tick++) ring.push(frame(tick), tick * 16);

    // Последние четыре тика на месте.
    for (let tick = 6; tick < 10; tick++) {
      expect(ring.at(tick)?.frame.tick).toBe(tick);
    }
    // Тик 5 вытеснен тиком 9: оба ложатся в слот 9 % 4 == 1.
    expect(ring.at(5)).toBeUndefined();
  });

  it('вытесненный тик не выдаётся за живой: слот занят чужим кадром', () => {
    // Слот адресуется остатком, поэтому в нём всегда что-то лежит. Кольцо
    // обязано отличать «этот тик» от «этот слот»: иначе замер «нажал → увидел»
    // считался бы по времени отправки постороннего кадра.
    const ring = new InputRing(4);
    ring.push(frame(1), 100);
    ring.push(frame(5), 500);

    expect(ring.at(5)?.sentAtMs).toBe(500);
    expect(ring.at(1)).toBeUndefined();
    expect(ring.at(9)).toBeUndefined();
  });

  it('момент отправки хранится вместе с кадром — это и есть половина замера', () => {
    const ring = new InputRing(8);
    ring.push(frame(3), 1234);
    expect(ring.at(3)).toEqual({ frame: frame(3), sentAtMs: 1234 });
  });
});

describe('InputRing: поиск по seq (NET-9)', () => {
  it('находит кадр по seq — то, что приезжает обратно в снапшоте', () => {
    const ring = new InputRing(8);
    ring.push(frame(1, 100), 10);
    ring.push(frame(2, 101), 26);

    expect(ring.bySeq(101)?.frame.tick).toBe(2);
    expect(ring.bySeq(100)?.sentAtMs).toBe(10);
  });

  it('seq вне кольца — undefined, а не чужой кадр', () => {
    const ring = new InputRing(2);
    ring.push(frame(1, 100), 10);
    ring.push(frame(2, 101), 20);
    ring.push(frame(3, 102), 30); // вытесняет seq 100

    expect(ring.bySeq(100)).toBeUndefined();
    expect(ring.bySeq(999)).toBeUndefined();
    expect(ring.bySeq(102)?.frame.tick).toBe(3);
  });

  it('пустое кольцо ничего не находит', () => {
    const ring = new InputRing(4);
    expect(ring.at(0)).toBeUndefined();
    expect(ring.bySeq(0)).toBeUndefined();
  });
});
