/**
 * Кольцо своих кадров ввода (NET-9): контракт вытеснения.
 *
 * Главное здесь — что `at()` отличает «слот занят кадром запрошенного тика» от
 * «слот занят кадром, который старше ровно на длину кольца». Без этой проверки
 * промах по вытесненному тику возвращал бы чужой кадр с чужим `sentAtMs`, и
 * метрика «нажал → увидел» врала бы на глубину кольца — две секунды при
 * умолчании в 120 тиков, молча и правдоподобно.
 *
 * Сегодня цена ошибки — только диагностика: клиент MVP не предсказывает
 * (NTR-10), кольцо меряет отклик и разбирает потери. Когда включится
 * reconciliation (NET-4), тот же `at()` станет источником кадров для
 * переигровки, и чужой кадр будет уже настоящим расхождением с сервером.
 */
import { describe, expect, it } from 'vitest';
import { InputRing, DEFAULT_RING_TICKS } from '../src/client/inputRing.js';
import type { InputFrame } from '@game-mvp/core';

function frame(tick: number, seq: number): InputFrame {
  return { tick, playerId: 'p1', seq, move: { x: 0, y: 0 }, aimDir: 0, buttons: 0 };
}

describe('ёмкость кольца', () => {
  it('по умолчанию — две секунды при 60 Гц', () => {
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
});
