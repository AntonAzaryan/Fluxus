import { describe, expect, it } from 'vitest';
import { evaluate, operators, type Expression, type ExprWorld } from '../src/dsl/expr.js';
import * as fixed from '../src/math/fixed.js';
import { mathApi } from '../src/math/mathApi.js';

const F = fixed.fromFloat;

/** Сущность 1 — раненый с целочисленным счётчиком зарядов, 2 — цель в (3, 4). */
const ENTITIES: Record<number, Record<string, Record<string, number>>> = {
  1: {
    Position: { x: F(0), y: F(0) },
    Health: { current: F(25), max: F(100) },
    Ammo: { count: 3 }, // поле типа i32: сырое целое, не Q16.16
  },
  2: {
    Position: { x: F(3), y: F(4) },
    Health: { current: F(90), max: F(100) },
  },
};

// Sandbox EXPR-3 проверяется типом, а не тестом: в ExprWorld нет ни commands,
// ни events, поэтому выражению нечем мутировать мир — этот стаб полон.
const world: ExprWorld = {
  tick: 42,
  math: mathApi,
  get: (e, c, f) => {
    const value = ENTITIES[e]?.[c]?.[f];
    if (value === undefined) throw new Error(`нет поля ${c}.${f} у ${e}`);
    return value;
  },
  has: (e, c) => ENTITIES[e]?.[c] !== undefined,
  isAlive: (e) => ENTITIES[e] !== undefined,
};

const position = (entity: Expression): Expression => ({
  vec: [
    { getComponent: [entity, 'Position', 'x'] },
    { getComponent: [entity, 'Position', 'y'] },
  ],
});

describe('арифметика в Q16.16 (EXPR-2)', () => {
  it('умножает по правилам fixed-point, а не оператором языка-хоста', () => {
    // Double дал бы 32768 * 32768 = 2^30; fixed-point даёт ровно 0.25.
    expect(evaluate({ '*': [F(0.5), F(0.5)] }, world)).toBe(F(0.25));
  });

  it('складывает, делит и берёт min/max в том же масштабе', () => {
    expect(evaluate({ '+': [F(1.5), F(2.25)] }, world)).toBe(F(3.75));
    expect(evaluate({ '/': [F(10), F(4)] }, world)).toBe(F(2.5));
    expect(evaluate({ clamp: [F(7), F(0), F(5)] }, world)).toBe(F(5));
  });

  it('целочисленное поле требует явного fromInt', () => {
    const raw = { '*': [{ getComponent: [1, 'Ammo', 'count'] }, F(2)] };
    const scaled = { '*': [{ fromInt: [{ getComponent: [1, 'Ammo', 'count'] }] }, F(2)] };

    expect(evaluate(scaled, world)).toBe(F(6));
    expect(evaluate(raw, world)).not.toBe(F(6)); // масштаб не совпал — тихо неверно
  });
});

describe('доступ к миру', () => {
  it('считает дистанцию между сущностями через Math API (сценарий EXPR-2)', () => {
    const distance = { 'vec.length': [{ 'vec.sub': [position({ var: 'b' }), position({ var: 'a' })] }] };

    const result = evaluate(distance, world, { a: 1, b: 2 });
    expect(fixed.toFloat(result as number)).toBeCloseTo(5, 3);
  });

  it('отдаёт hasComponent, isAlive и номер тика', () => {
    expect(evaluate({ hasComponent: [1, 'Ammo'] }, world)).toBe(true);
    expect(evaluate({ hasComponent: [2, 'Ammo'] }, world)).toBe(false);
    expect(evaluate({ isAlive: [99] }, world)).toBe(false);
    expect(evaluate({ tick: [] }, world)).toBe(42);
  });
});

describe('ветвление (сценарий ACT-1)', () => {
  // «Бьёт сильнее по целям ниже 30% HP» — политика как данные, без кода.
  const damage = (entity: Expression): Expression => ({
    if: [
      { '<': [{ getComponent: [entity, 'Health', 'current'] }, { '*': [{ getComponent: [entity, 'Health', 'max'] }, F(0.3)] }] },
      F(20),
      F(10),
    ],
  });

  it('добивает раненого удвоенным уроном', () => {
    expect(evaluate(damage(1), world)).toBe(F(20));
  });

  it('бьёт здорового обычным уроном', () => {
    expect(evaluate(damage(2), world)).toBe(F(10));
  });

  it('складывает условия через and/or/!', () => {
    const expr = { and: [{ hasComponent: [1, 'Ammo'] }, { '!': [{ hasComponent: [1, 'Shield'] }] }] };
    expect(evaluate(expr, world)).toBe(true);
  });
});

describe('закрытая таблица операторов (EXPR-6)', () => {
  it('падает на неизвестном операторе, а не возвращает молчаливый результат', () => {
    expect(() => evaluate({ '**': [F(2), F(3)] }, world)).toThrow(/неизвестный оператор "\*\*"/);
  });

  it('не разрешает имена из цепочки прототипов', () => {
    expect(() => evaluate({ constructor: [] }, world)).toThrow(/неизвестный оператор "constructor"/);
    expect(() => evaluate({ toString: [] }, world)).toThrow(/неизвестный оператор/);
  });

  it('в таблице нет оператора итерации — циклы только в actions (EXPR-5)', () => {
    expect(operators.filter((op) => /each|map|reduce|while|loop|repeat/i.test(op))).toEqual([]);
  });
});

describe('ошибки формы AST', () => {
  it('отвергает узел с двумя операторами', () => {
    expect(() => evaluate({ '+': [F(1), F(2)], '-': [F(1), F(2)] }, world)).toThrow(/ровно один оператор/);
  });

  it('отвергает неизвестную переменную', () => {
    expect(() => evaluate({ var: 'nope' }, world)).toThrow(/неизвестная переменная "nope"/);
  });

  it('проверяет число аргументов и типы', () => {
    expect(() => evaluate({ '+': [F(1)] }, world)).toThrow(/ожидалось аргументов 2/);
    expect(() => evaluate({ '+': [true, F(1)] }, world)).toThrow(/ожидалось число/);
    expect(() => evaluate({ if: [true, F(1)] }, world)).toThrow(/оператор "if"/);
    expect(() => evaluate({ '==': [position(1), position(2)] }, world)).toThrow(/покомпонентно/);
  });
});

describe('bitTest (EXPR-2)', () => {
  it('читает отдельный бит сырой маски', () => {
    expect(evaluate({ bitTest: [5, 0] }, world)).toBe(true);
    expect(evaluate({ bitTest: [5, 1] }, world)).toBe(false);
    expect(evaluate({ bitTest: [5, 2] }, world)).toBe(true);
  });

  it('старший бит i32 читается как бит 31, а не как знак', () => {
    expect(evaluate({ bitTest: [-2147483648, 31] }, world)).toBe(true);
  });

  it('номер бита вне 0..31 — ошибка', () => {
    expect(() => evaluate({ bitTest: [1, 32] }, world)).toThrow(/0\.\.31/);
  });
});
