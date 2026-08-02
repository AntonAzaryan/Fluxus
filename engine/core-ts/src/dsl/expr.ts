/**
 * Expression Evaluator (EXPR-1..6): чистые вычисления над JSON-AST в форме
 * JsonLogic. Реализация своя, а не `json-logic-js`: её арифметика — встроенные
 * операторы JavaScript над double (мимо DET-2), а расширение через
 * `add_operation` — глобальная мутация синглтона (мимо DI-1). Форма AST при
 * этом сохранена — с ней работает редактор.
 */
import type { EntityId, Fixed, MathApi, SystemContext, Vec2 } from '../types.js';

/** Узел AST: литерал либо объект с ровно одним ключом-оператором (EXPR-1). */
export type Expression = number | boolean | string | { readonly [op: string]: unknown };

/** Все числа — сырой Q16.16 (EXPR-2); `i32`-поля приводятся оператором `fromInt`. */
export type ExprValue = Fixed | boolean | Vec2;

/**
 * Read-only срез `SystemContext`. Sandbox EXPR-3 держится на этом типе:
 * `commands` и `events` в выражение не попадают, значит писать ему нечем.
 */
export type ExprWorld = Pick<SystemContext, 'tick' | 'get' | 'has' | 'isAlive' | 'math'>;

/** Локальные переменные: аргументы системы и биндинги `let` из Action DSL. */
export type ExprVars = Readonly<Record<string, ExprValue>>;

/** Точка подмены реализации (EXPR-4). */
export interface ExpressionEvaluator {
  evaluate(expr: Expression, world: ExprWorld, vars?: ExprVars): ExprValue;
}

const NO_VARS: ExprVars = {};

export function evaluate(expr: Expression, world: ExprWorld, vars: ExprVars = NO_VARS): ExprValue {
  if (typeof expr === 'number' || typeof expr === 'boolean') return expr;
  if (typeof expr !== 'object' || expr === null) {
    throw new Error(`строка допустима только как аргумент-имя оператора: ${JSON.stringify(expr)}`);
  }
  const keys = Object.keys(expr);
  if (keys.length !== 1) {
    throw new Error(`узел должен содержать ровно один оператор, найдено ${keys.length}: ${JSON.stringify(expr)}`);
  }
  const op = keys[0]!;
  // hasOwn, а не `op in OPS`: иначе `constructor` в позиции оператора
  // разрешился бы через цепочку прототипов (EXPR-6).
  if (!Object.hasOwn(OPS, op)) throw new Error(`неизвестный оператор "${op}"`);
  const raw = (expr as Record<string, unknown>)[op];
  return OPS[op]!((Array.isArray(raw) ? raw : [raw]) as readonly Expression[], world, vars);
}

/** Реализация по умолчанию за абстракцией EXPR-4. */
export const evaluator: ExpressionEvaluator = { evaluate };

// ------------------------------------------------------------------ коэрсии

function arity(op: string, args: readonly Expression[], n: number): void {
  if (args.length !== n) {
    throw new Error(`оператор "${op}": ожидалось аргументов ${n}, получено ${args.length}`);
  }
}

function num(v: ExprValue, op: string): Fixed {
  if (typeof v !== 'number') throw new Error(`оператор "${op}": ожидалось число, получено ${typeof v}`);
  return v;
}

function bool(v: ExprValue, op: string): boolean {
  if (typeof v !== 'boolean') throw new Error(`оператор "${op}": ожидалось булево, получено ${typeof v}`);
  return v;
}

function vec(v: ExprValue, op: string): Vec2 {
  if (typeof v !== 'object') throw new Error(`оператор "${op}": ожидался вектор, получено ${typeof v}`);
  return v;
}

/** EntityId — сырое число, а не Q16.16: масштабировать его нельзя. */
function eid(v: ExprValue, op: string): EntityId {
  return num(v, op);
}

/** Имя компонента/поля/переменной: строковый литерал, который не вычисляется. */
function str(e: Expression, op: string): string {
  if (typeof e !== 'string') throw new Error(`оператор "${op}": ожидалось имя строкой, получено ${typeof e}`);
  return e;
}

// ---------------------------------------------------------------- операторы

type OpFn = (args: readonly Expression[], world: ExprWorld, vars: ExprVars) => ExprValue;

const num1 =
  (op: string, fn: (m: MathApi, a: Fixed) => ExprValue): OpFn =>
  (args, w, v) => {
    arity(op, args, 1);
    return fn(w.math, num(evaluate(args[0]!, w, v), op));
  };

const num2 =
  (op: string, fn: (m: MathApi, a: Fixed, b: Fixed) => ExprValue): OpFn =>
  (args, w, v) => {
    arity(op, args, 2);
    return fn(w.math, num(evaluate(args[0]!, w, v), op), num(evaluate(args[1]!, w, v), op));
  };

const vec1 =
  (op: string, fn: (m: MathApi, a: Vec2) => ExprValue): OpFn =>
  (args, w, v) => {
    arity(op, args, 1);
    return fn(w.math, vec(evaluate(args[0]!, w, v), op));
  };

const vec2 =
  (op: string, fn: (m: MathApi, a: Vec2, b: Vec2) => ExprValue): OpFn =>
  (args, w, v) => {
    arity(op, args, 2);
    return fn(w.math, vec(evaluate(args[0]!, w, v), op), vec(evaluate(args[1]!, w, v), op));
  };

const equality =
  (op: string, negate: boolean): OpFn =>
  (args, w, v) => {
    arity(op, args, 2);
    const a = evaluate(args[0]!, w, v);
    const b = evaluate(args[1]!, w, v);
    if (typeof a === 'object' || typeof b === 'object') {
      throw new Error(`оператор "${op}": векторы сравниваются покомпонентно, а не целиком`);
    }
    return (a === b) !== negate;
  };

/**
 * Закрытая таблица (EXPR-6). Оператора итерации в ней нет и быть не должно:
 * циклы живут только в actions (EXPR-5).
 */
const OPS: Record<string, OpFn> = {
  // окружение
  var: (args, _w, v) => {
    arity('var', args, 1);
    const key = str(args[0]!, 'var');
    if (!Object.hasOwn(v, key)) throw new Error(`неизвестная переменная "${key}"`);
    return v[key]!;
  },
  /** Номер тика — сырое целое, для арифметики требует `fromInt`. */
  tick: (args, w) => {
    arity('tick', args, 0);
    return w.tick;
  },
  getComponent: (args, w, v) => {
    arity('getComponent', args, 3);
    const entity = eid(evaluate(args[0]!, w, v), 'getComponent');
    return w.get(entity, str(args[1]!, 'getComponent'), str(args[2]!, 'getComponent'));
  },
  hasComponent: (args, w, v) => {
    arity('hasComponent', args, 2);
    return w.has(eid(evaluate(args[0]!, w, v), 'hasComponent'), str(args[1]!, 'hasComponent'));
  },
  isAlive: (args, w, v) => {
    arity('isAlive', args, 1);
    return w.isAlive(eid(evaluate(args[0]!, w, v), 'isAlive'));
  },

  // арифметика Q16.16
  '+': num2('+', (m, a, b) => m.add(a, b)),
  '-': num2('-', (m, a, b) => m.sub(a, b)),
  '*': num2('*', (m, a, b) => m.mul(a, b)),
  '/': num2('/', (m, a, b) => m.div(a, b)),
  min: num2('min', (m, a, b) => m.min(a, b)),
  max: num2('max', (m, a, b) => m.max(a, b)),
  abs: num1('abs', (m, a) => m.abs(a)),
  sqrt: num1('sqrt', (m, a) => m.sqrt(a)),
  clamp: (args, w, v) => {
    arity('clamp', args, 3);
    return w.math.clamp(
      num(evaluate(args[0]!, w, v), 'clamp'),
      num(evaluate(args[1]!, w, v), 'clamp'),
      num(evaluate(args[2]!, w, v), 'clamp'),
    );
  },
  /** Явное приведение масштаба для полей типа `i32` (EXPR-2). */
  fromInt: num1('fromInt', (m, a) => m.fromInt(a)),
  toInt: num1('toInt', (m, a) => m.toInt(a)),
  /**
   * Проверка бита маски `i32` — сырое целое, без Q16.16 (EXPR-2). Единственная
   * битовая операция в таблице: маска читается по одному биту, арифметика над
   * ней не определена, а фронт кнопки (TICK-4) иначе в JSON не выразить.
   */
  bitTest: (args, w, v) => {
    arity('bitTest', args, 2);
    const mask = num(evaluate(args[0]!, w, v), 'bitTest');
    const bit = num(evaluate(args[1]!, w, v), 'bitTest');
    if (!Number.isInteger(bit) || bit < 0 || bit > 31) {
      throw new Error(`оператор "bitTest": номер бита — целое 0..31, получено ${bit}`);
    }
    return ((mask >>> bit) & 1) === 1;
  },

  // сравнения: Q16.16 монотонен, поэтому сравнение обычное числовое
  '<': num2('<', (_m, a, b) => a < b),
  '<=': num2('<=', (_m, a, b) => a <= b),
  '>': num2('>', (_m, a, b) => a > b),
  '>=': num2('>=', (_m, a, b) => a >= b),
  '==': equality('==', false),
  '!=': equality('!=', true),

  // логика
  and: (args, w, v) => {
    if (args.length < 2) throw new Error('оператор "and": нужно минимум два аргумента');
    return args.every((a) => bool(evaluate(a, w, v), 'and'));
  },
  or: (args, w, v) => {
    if (args.length < 2) throw new Error('оператор "or": нужно минимум два аргумента');
    return args.some((a) => bool(evaluate(a, w, v), 'or'));
  },
  '!': (args, w, v) => {
    arity('!', args, 1);
    return !bool(evaluate(args[0]!, w, v), '!');
  },
  /** `[cond, then, …, else]` — ветвление чистое, к EXPR-5 отношения не имеет. */
  if: (args, w, v) => {
    if (args.length < 3 || args.length % 2 === 0) {
      throw new Error(`оператор "if": ожидалось [cond, then, …, else], получено аргументов ${args.length}`);
    }
    for (let i = 0; i + 1 < args.length; i += 2) {
      if (bool(evaluate(args[i]!, w, v), 'if')) return evaluate(args[i + 1]!, w, v);
    }
    return evaluate(args[args.length - 1]!, w, v);
  },

  // векторы — только через Math API (EXPR-2)
  vec: num2('vec', (_m, x, y) => ({ x, y })),
  'vec.add': vec2('vec.add', (m, a, b) => m.vec.add(a, b)),
  'vec.sub': vec2('vec.sub', (m, a, b) => m.vec.sub(a, b)),
  'vec.dot': vec2('vec.dot', (m, a, b) => m.vec.dot(a, b)),
  'vec.length': vec1('vec.length', (m, a) => m.vec.length(a)),
  'vec.lengthSq': vec1('vec.lengthSq', (m, a) => m.vec.lengthSq(a)),
  'vec.normalize': vec1('vec.normalize', (m, a) => m.vec.normalize(a)),
  'vec.x': vec1('vec.x', (_m, a) => a.x),
  'vec.y': vec1('vec.y', (_m, a) => a.y),
  'vec.scale': (args, w, v) => {
    arity('vec.scale', args, 2);
    return w.math.vec.scale(
      vec(evaluate(args[0]!, w, v), 'vec.scale'),
      num(evaluate(args[1]!, w, v), 'vec.scale'),
    );
  },
};

/** Имена операторов — для валидации AST на регистрации системы (SYS-3, этап 8). */
export const operators: readonly string[] = Object.keys(OPS);
