/**
 * Кольцо своих кадров ввода (NET-9, NET-10): контракт вытеснения.
 *
 * Тестов у кольца не было вовсе: клиент MVP не предсказывает (NTR-10), кольцо
 * ему нужно для замера «нажал → увидел» и разбора потерь, и на матчевых тестах
 * его поведение не видно — они смотрят на снапшоты, а не на то, что клиент
 * помнит о своей отправке. Когда включится reconciliation (NET-4), тот же
 * `at()` станет источником кадров для переигровки, и чужой кадр будет уже
 * настоящим расхождением с сервером, а не только диагностической ошибкой.
 *
 * Главное здесь — что `at()` отличает «слот занят кадром запрошенного тика» от
 * «слот занят кадром, который старше ровно на длину кольца». Без этой проверки
 * промах по вытесненному тику возвращал бы чужой кадр с чужим `sentAtMs`, и
 * метрика «нажал → увидел» врала бы на глубину кольца — две секунды при
 * умолчании в 120 тиков (NET-10), молча и правдоподобно.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_RING_TICKS, InputRing } from '../src/client/inputRing.js';
import type { InputFrame } from '@game-mvp/core';

function frame(tick: number, seq: number = tick): InputFrame {
  return { tick, playerId: 'p1', seq, move: { x: 0, y: 0 }, aimDir: 0, buttons: 0 };
}

describe('ёмкость кольца', () => {
  it('по умолчанию — 120 тиков, две секунды при 60 Гц', () => {
    expect(DEFAULT_RING_TICKS).toBe(120);
    expect(new InputRing().capacity).toBe(DEFAULT_RING_TICKS);
    expect(new InputRing(8).capacity).toBe(8);
  });

  it('нулевая и дробная ёмкость — ошибка сборки, а не тихое кольцо на один слот', () => {
    expect(() => new InputRing(0)).toThrow(/положительное целое/);
    expect(() => new InputRing(-1)).toThrow(/положительное целое/);
    expect(() => new InputRing(1.5)).toThrow(/положительное целое/);
  });
});

describe('поиск по тику', () => {
  it('отдаёт кадр вместе с моментом отправки', () => {
    const ring = new InputRing(8);
    ring.push(frame(5, 1), 1000);

    expect(ring.at(5)).toEqual({ frame: frame(5, 1), sentAtMs: 1000 });
  });

  it('на тике, до которого кольцо ещё не дошло, — промах', () => {
    const ring = new InputRing(8);
    ring.push(frame(5, 1), 1000);

    expect(ring.at(4)).toBeUndefined();
    expect(ring.at(6)).toBeUndefined();
  });

  it('вытесненный тик — промах, а не кадр, занявший его слот', () => {
    const ring = new InputRing(8);
    ring.push(frame(5, 1), 1000);
    // Тик 13 садится ровно в слот тика 5 (13 % 8 === 5).
    ring.push(frame(13, 2), 2000);

    expect(ring.at(13)).toEqual({ frame: frame(13, 2), sentAtMs: 2000 });
    // Вернись здесь кадр тика 13 — отклик посчитался бы от чужой отправки,
    // то есть промахнулся бы на глубину кольца.
    expect(ring.at(5)).toBeUndefined();
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

  it('пустое кольцо ничего не находит', () => {
    const ring = new InputRing(4);
    expect(ring.at(0)).toBeUndefined();
    expect(ring.bySeq(0)).toBeUndefined();
  });
});

describe('поиск по seq (метрика отклика)', () => {
  it('находит отправку по номеру, который вернулся в снапшоте', () => {
    const ring = new InputRing(8);
    ring.push(frame(5, 41), 1000);
    ring.push(frame(6, 42), 1016);

    expect(ring.bySeq(42)?.sentAtMs).toBe(1016);
    expect(ring.bySeq(41)?.frame.tick).toBe(5);
  });

  it('на неизвестном и вытесненном seq — промах, а не чужая отправка', () => {
    const ring = new InputRing(8);
    ring.push(frame(5, 41), 1000);
    ring.push(frame(13, 49), 2000);

    expect(ring.bySeq(7)).toBeUndefined();
    expect(ring.bySeq(41)).toBeUndefined();
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
});
