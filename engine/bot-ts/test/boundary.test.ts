/**
 * Граница «мозг → ввод» (BOT-5): намерение мозга проходит те же ограничение и
 * квантование, что ввод с устройства (`input-devices` INP-3). Предмет теста —
 * что обойти их бот не может: сверхчеловеческий ввод не выражается.
 */
import { describe, expect, it } from 'vitest';
import { FIXED_ONE, fixed } from '@game-mvp/core';
import { TURN_UNITS, aimToRadians, toInputSample } from '../src/boundary.js';

const length = (sample: { move: { x: number; y: number } }): number =>
  Math.hypot(fixed.toFloat(sample.move.x), fixed.toFloat(sample.move.y));

describe('намерение мозга → InputSample (BOT-5, INP-3)', () => {
  it('вектор движения клампится единичным кругом', () => {
    const sample = toInputSample({ moveX: 5, moveY: 5, aimRadians: 0 });
    expect(length(sample)).toBeCloseTo(1, 4);
  });

  it('диагональ не быстрее единицы: бот не получает преимущества устройства', () => {
    const diagonal = toInputSample({ moveX: 1, moveY: 1, aimRadians: 0 });
    const straight = toInputSample({ moveX: 1, moveY: 0, aimRadians: 0 });
    expect(length(diagonal)).toBeCloseTo(length(straight), 4);
  });

  it('аналоговая длина внутри круга сохраняется — медленный подход выразим', () => {
    const sample = toInputSample({ moveX: 0.5, moveY: 0, aimRadians: 0 });
    expect(fixed.toFloat(sample.move.x)).toBeCloseTo(0.5, 4);
    expect(length(sample)).toBeCloseTo(0.5, 4);
  });

  it('нечисло от мозга даёт нейтраль, а не падение матча', () => {
    const sample = toInputSample({ moveX: NaN, moveY: Infinity, aimRadians: NaN, buttons: NaN });
    expect(sample.move).toEqual({ x: 0, y: 0 });
    expect(sample.aimDir).toBe(0);
    expect(sample.buttons).toBe(0);
  });

  it('движение представимо в Q16.16 без дальнейшего квантования (INP-3)', () => {
    const sample = toInputSample({ moveX: 0.3, moveY: -0.7, aimRadians: 1 });
    expect(Number.isInteger(sample.move.x)).toBe(true);
    expect(Number.isInteger(sample.move.y)).toBe(true);
    expect(Math.abs(sample.move.x)).toBeLessThanOrEqual(FIXED_ONE);
  });
});

describe('прицел — единица угла ядра (FP-7)', () => {
  it('оборот заворачивается маской, а не обрезается', () => {
    const zero = toInputSample({ moveX: 0, moveY: 0, aimRadians: 0 });
    const turn = toInputSample({ moveX: 0, moveY: 0, aimRadians: Math.PI * 2 });
    const two = toInputSample({ moveX: 0, moveY: 0, aimRadians: Math.PI * 6 });
    expect(turn.aimDir).toBe(zero.aimDir);
    expect(two.aimDir).toBe(zero.aimDir);
  });

  it('отрицательный угол попадает в домен 0..TURN_UNITS-1', () => {
    const sample = toInputSample({ moveX: 0, moveY: 0, aimRadians: -Math.PI / 2 });
    expect(sample.aimDir).toBeGreaterThanOrEqual(0);
    expect(sample.aimDir).toBeLessThan(TURN_UNITS);
    expect(sample.aimDir).toBe((TURN_UNITS * 3) / 4);
  });

  it('чтение угла обратно даёт то же направление', () => {
    const radians = 1.2345;
    const sample = toInputSample({ moveX: 0, moveY: 0, aimRadians: radians });
    expect(aimToRadians(sample.aimDir)).toBeCloseTo(radians, 3);
  });
});

describe('маска действий — ширина u16 (`tick-loop` TICK-2)', () => {
  it('биты выше 15 отсекаются: бот не выражает того, чего не выразит игрок', () => {
    const sample = toInputSample({ moveX: 0, moveY: 0, aimRadians: 0, buttons: 1 << 20 });
    expect(sample.buttons).toBe(0);
  });

  it('значащие биты доезжают целиком', () => {
    const sample = toInputSample({ moveX: 0, moveY: 0, aimRadians: 0, buttons: 0b1010_0000_0000_0101 });
    expect(sample.buttons).toBe(0b1010_0000_0000_0101);
  });

  it('дробная маска усекается до целого', () => {
    const sample = toInputSample({ moveX: 0, moveY: 0, aimRadians: 0, buttons: 3.9 });
    expect(sample.buttons).toBe(3);
  });
});
