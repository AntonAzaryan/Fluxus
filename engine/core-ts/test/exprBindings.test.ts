/**
 * Проводка операторов Expression DSL в Math API (EXPR-2, EXPR-6): каждый
 * оператор таблицы сверяется с прямым вызовом `mathApi` на тех же аргументах.
 *
 * Сама математика проверена в `fixed.test.ts` и `vector.test.ts` — здесь
 * ловится перепутанный биндинг (`min` на `max`, обратный порядок аргументов в
 * `vec.sub`, `lengthSq` вместо `length`). Такая ошибка тихая: значение
 * остаётся правдоподобным числом в правильном масштабе, а на сцене
 * проявляется как «неверная балансировка» в JSON-системе, где кода нет.
 *
 * Аргументы намеренно асимметричны (`A` ≠ `B`, разные знаки), иначе
 * перестановка операндов ничего не меняет и тест слеп.
 */
import { describe, expect, it } from 'vitest';
import { evaluate, operators, type Expression, type ExprValue, type ExprWorld } from '../src/dsl/expr.js';
import { EventBus } from '../src/ecs/events.js';
import * as fixed from '../src/math/fixed.js';
import { mathApi } from '../src/math/mathApi.js';

const F = fixed.fromFloat;

const A = F(3.5);
const B = F(-1.25);
const VA = { x: F(3), y: F(4) };
const VB = { x: F(-1.5), y: F(0.5) };

/** Минимальный мир: операторы этой таблицы чистые, к состоянию не обращаются. */
const world: ExprWorld = {
  tick: 0,
  math: mathApi,
  events: new EventBus(),
  get: () => {
    throw new Error('чистый оператор не читает мир');
  },
  has: () => false,
  isAlive: () => false,
};

const vecOf = (v: { x: number; y: number }): Expression => ({ vec: [v.x, v.y] });

/** Оператор → пары «выражение → ожидаемое от Math API напрямую». */
const BINDINGS: Record<string, readonly (readonly [Expression, ExprValue])[]> = {
  // арифметика
  '+': [[{ '+': [A, B] }, mathApi.add(A, B)]],
  '-': [[{ '-': [A, B] }, mathApi.sub(A, B)]],
  '*': [[{ '*': [A, B] }, mathApi.mul(A, B)]],
  '/': [[{ '/': [A, B] }, mathApi.div(A, B)]],
  min: [[{ min: [A, B] }, mathApi.min(A, B)]],
  max: [[{ max: [A, B] }, mathApi.max(A, B)]],
  abs: [
    [{ abs: [B] }, mathApi.abs(B)],
    [{ abs: [A] }, mathApi.abs(A)],
  ],
  sqrt: [[{ sqrt: [F(2)] }, mathApi.sqrt(F(2))]],
  sin: [[{ sin: [F(0.125)] }, mathApi.sin(F(0.125))]],
  cos: [[{ cos: [F(0.125)] }, mathApi.cos(F(0.125))]],
  // порядок аргументов clamp: значение, минимум, максимум
  clamp: [
    [{ clamp: [A, B, F(1)] }, mathApi.clamp(A, B, F(1))],
    [{ clamp: [B, F(0), A] }, mathApi.clamp(B, F(0), A)],
  ],
  fromInt: [[{ fromInt: [3] }, mathApi.fromInt(3)]],
  toInt: [[{ toInt: [A] }, mathApi.toInt(A)]],

  // сравнения: обе стороны, иначе перестановка операндов не видна
  '<': [
    [{ '<': [B, A] }, true],
    [{ '<': [A, B] }, false],
    [{ '<': [A, A] }, false],
  ],
  '<=': [
    [{ '<=': [B, A] }, true],
    [{ '<=': [A, B] }, false],
    [{ '<=': [A, A] }, true],
  ],
  '>': [
    [{ '>': [A, B] }, true],
    [{ '>': [B, A] }, false],
    [{ '>': [A, A] }, false],
  ],
  '>=': [
    [{ '>=': [A, B] }, true],
    [{ '>=': [B, A] }, false],
    [{ '>=': [A, A] }, true],
  ],
  '==': [
    [{ '==': [A, A] }, true],
    [{ '==': [A, B] }, false],
  ],
  '!=': [
    [{ '!=': [A, B] }, true],
    [{ '!=': [A, A] }, false],
  ],

  // логика: короткого замыкания нет, но таблица истинности обязана сойтись
  and: [
    [{ and: [true, true] }, true],
    [{ and: [true, false] }, false],
    [{ and: [false, true] }, false],
    [{ and: [true, true, false] }, false],
  ],
  or: [
    [{ or: [false, true] }, true],
    [{ or: [true, false] }, true],
    [{ or: [false, false] }, false],
    [{ or: [false, false, true] }, true],
  ],
  '!': [
    [{ '!': [false] }, true],
    [{ '!': [true] }, false],
  ],
  if: [
    [{ if: [true, A, B] }, A],
    [{ if: [false, A, B] }, B],
    [{ if: [false, A, true, B, F(0)] }, B],
  ],

  // векторы
  vec: [[vecOf(VA), VA]],
  'vec.add': [[{ 'vec.add': [vecOf(VA), vecOf(VB)] }, mathApi.vec.add(VA, VB)]],
  'vec.sub': [
    [{ 'vec.sub': [vecOf(VA), vecOf(VB)] }, mathApi.vec.sub(VA, VB)],
    [{ 'vec.sub': [vecOf(VB), vecOf(VA)] }, mathApi.vec.sub(VB, VA)],
  ],
  'vec.dot': [[{ 'vec.dot': [vecOf(VA), vecOf(VB)] }, mathApi.vec.dot(VA, VB)]],
  'vec.length': [[{ 'vec.length': [vecOf(VA)] }, mathApi.vec.length(VA)]],
  'vec.lengthSq': [[{ 'vec.lengthSq': [vecOf(VA)] }, mathApi.vec.lengthSq(VA)]],
  'vec.normalize': [
    [{ 'vec.normalize': [vecOf(VA)] }, mathApi.vec.normalize(VA)],
    // нулевой вектор — штатный случай, а не деление на ноль
    [{ 'vec.normalize': [vecOf({ x: 0, y: 0 })] }, { x: 0, y: 0 }],
  ],
  'vec.scale': [[{ 'vec.scale': [vecOf(VA), B] }, mathApi.vec.scale(VA, B)]],
  'vec.x': [[{ 'vec.x': [vecOf(VA)] }, VA.x]],
  'vec.y': [[{ 'vec.y': [vecOf(VA)] }, VA.y]],
};

/**
 * Операторы, чей смысл — доступ к миру или к шине тика: их семантика проверена
 * в `expr.test.ts` на полном стабе, здесь для них нет ни аргументов, ни
 * эталона из Math API.
 */
const WORLD_OPS: readonly string[] = [
  'var',
  'tick',
  'getComponent',
  'hasComponent',
  'isAlive',
  'eventField',
  'bitTest',
  'hasFloorAt',
];

describe('проводка операторов в Math API (EXPR-2)', () => {
  for (const [op, cases] of Object.entries(BINDINGS)) {
    it(`оператор "${op}" зовёт свою операцию с аргументами в своём порядке`, () => {
      for (const [expr, expected] of cases) {
        expect(evaluate(expr, world), JSON.stringify(expr)).toEqual(expected);
      }
    });
  }
});

describe('полнота таблицы операторов (EXPR-6)', () => {
  it('каждый оператор либо сверен с Math API, либо отнесён к доступу в мир', () => {
    const classified = new Set([...Object.keys(BINDINGS), ...WORLD_OPS]);
    // Новый оператор должен попасть в одну из двух корзин: без этого он
    // экспортирован в контент, но не вызван ни одним тестом ядра.
    expect(operators.filter((op) => !classified.has(op))).toEqual([]);
    expect([...classified].filter((op) => !operators.includes(op))).toEqual([]);
  });
});
