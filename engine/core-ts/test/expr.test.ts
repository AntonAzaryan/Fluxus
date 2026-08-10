import { describe, expect, it } from 'vitest';
import {
  evaluate,
  operators,
  signatureOf,
  type Expression,
  type ExprWorld,
  type OpSignature,
} from '../src/dsl/expr.js';
import { EventBus } from '../src/ecs/events.js';
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

/** Шина тика: два события, чтобы читалось именно то, на которое ссылка (EVT-2). */
const events = new EventBus();
events.emit('Collision', { entity: 1, other: 2, nx: fixed.fromInt(-1), ny: 0 });
events.emit('Died', { entity: 7 });

// Sandbox EXPR-3 проверяется типом, а не тестом: в ExprWorld нет commands, а
// шина лежит read-only-частью, без `emit`, — этот стаб полон.
const world: ExprWorld = {
  tick: 42,
  math: mathApi,
  events,
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

  it('sin/cos: угол — Q16.16-доля оборота, значения из таблицы FP-8', () => {
    expect(evaluate({ sin: [F(0.25)] }, world)).toBe(F(1)); // 90°
    expect(evaluate({ cos: [F(0.5)] }, world)).toBe(F(-1)); // 180°
    expect(evaluate({ sin: [{ '+': [F(0.25), F(1)] }] }, world)).toBe(F(1)); // оборот заворачивается
    expect(evaluate({ sin: [F(0.125)] }, world)).toBe(fixed.sin(F(0.125))); // 45° — из той же таблицы
  });

  it('разворачивает угол прицеливания в единичный вектор без нативной системы (EXPR-2)', () => {
    const angle = F(0.125); // 45°
    const dir = evaluate({ vec: [{ cos: [angle] }, { sin: [angle] }] }, world);
    expect(dir).toEqual({ x: fixed.cos(angle), y: fixed.sin(angle) });
    // √2/2 в Q16.16 — длина вектора остаётся единичной с точностью кванта
    expect(fixed.toFloat(mathApi.vec.length(dir as { x: number; y: number }))).toBeCloseTo(1, 3);
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

describe('чтение поля события (EXPR-2)', () => {
  // Ссылка на событие — индекс в шине тика; в системе её связывает forEachEvent.
  const hit = (index: number, field: string): Expression => ({ eventField: [index, field] });

  it('читает поле того события, на которое ссылка', () => {
    expect(evaluate(hit(0, 'entity'), world)).toBe(1);
    expect(evaluate(hit(0, 'nx'), world)).toBe(fixed.fromInt(-1));
    expect(evaluate(hit(1, 'entity'), world)).toBe(7);
  });

  it('масштаб не преобразует — как getComponent', () => {
    // Нормаль уже Q16.16, идентификатор — сырое целое; оператор не трогает ни то, ни другое.
    expect(evaluate({ '*': [hit(0, 'nx'), F(0.25)] }, world)).toBe(F(-0.25));
  });

  it('падает на отсутствующем поле, называя тип события и поле', () => {
    expect(() => evaluate(hit(1, 'nx'), world)).toThrow(/у события "Died" нет поля "nx"/);
  });

  it('не разрешает имя поля через цепочку прототипов (EXPR-6)', () => {
    expect(() => evaluate(hit(0, 'toString'), world)).toThrow(/нет поля "toString"/);
  });

  it('падает на ссылке вне шины', () => {
    expect(() => evaluate(hit(9, 'entity'), world)).toThrow(/нет события с индексом 9/);
  });

  it('оператор входит в закрытую таблицу', () => {
    expect(operators).toContain('eventField');
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
    expect(() => evaluate({ '+': [true, F(1)] }, world)).toThrow(/ожидалось значение типа number/);
    expect(() => evaluate({ if: [true, F(1)] }, world)).toThrow(/оператор "if"/);
    expect(() => evaluate({ '==': [position(1), position(2)] }, world)).toThrow(/покомпонентно/);
  });
});

/**
 * Копия состава таблицы EXPR-8 — по разделам требования и в его порядке.
 * Список литеральный намеренно: рассинхронизация состава с нормой должна
 * краснеть здесь, а не обнаруживаться чтением спеки рядом с кодом.
 */
const EXPR_8_TABLE: readonly string[] = [
  // окружение и мир
  'var',
  'tick',
  'getComponent',
  'hasComponent',
  'isAlive',
  'hasFloorAt',
  'eventField',
  // арифметика
  '+',
  '-',
  '*',
  '/',
  'min',
  'max',
  'abs',
  'sqrt',
  'sin',
  'cos',
  'clamp',
  'fromInt',
  'toInt',
  'bitTest',
  // сравнения
  '<',
  '<=',
  '>',
  '>=',
  '==',
  '!=',
  // логика
  'and',
  'or',
  '!',
  'if',
  // векторы
  'vec',
  'vec.add',
  'vec.sub',
  'vec.scale',
  'vec.dot',
  'vec.lengthSq',
  'vec.length',
  'vec.normalize',
  'vec.x',
  'vec.y',
];

/**
 * Форма применения каждого оператора — вторая копия таблицы EXPR-8, снятая с
 * текста требования, а не с `signatureOf`. В этом весь смысл: сверка с
 * реализацией через саму реализацию не поймала бы ничего. Вторая реализация ядра
 * собирает свою таблицу по тому же тексту (CLI-6), и расхождение в арности или
 * литеральных позициях обязано краснеть здесь.
 *
 * `odd`, `literals` и `ranges` опущены там, где норма их не задаёт: умолчания —
 * `false`, пустой список, пустой список.
 */
interface ExpectedShape {
  readonly min: number;
  readonly max: number;
  readonly odd?: boolean;
  readonly literals?: readonly number[];
  readonly ranges?: readonly (readonly [number, number, number])[];
}

const EXPR_8_SHAPES: Readonly<Record<string, ExpectedShape>> = {
  // окружение и мир
  var: { min: 1, max: 1, literals: [0] },
  tick: { min: 0, max: 0 },
  getComponent: { min: 3, max: 3, literals: [1, 2] },
  hasComponent: { min: 2, max: 2, literals: [1] },
  isAlive: { min: 1, max: 1 },
  hasFloorAt: { min: 1, max: 1 },
  eventField: { min: 2, max: 2, literals: [1] },
  // арифметика
  '+': { min: 2, max: 2 },
  '-': { min: 2, max: 2 },
  '*': { min: 2, max: 2 },
  '/': { min: 2, max: 2 },
  min: { min: 2, max: 2 },
  max: { min: 2, max: 2 },
  abs: { min: 1, max: 1 },
  sqrt: { min: 1, max: 1 },
  sin: { min: 1, max: 1 },
  cos: { min: 1, max: 1 },
  clamp: { min: 3, max: 3 },
  fromInt: { min: 1, max: 1 },
  toInt: { min: 1, max: 1 },
  bitTest: { min: 2, max: 2, ranges: [[1, 0, 31]] },
  // сравнения
  '<': { min: 2, max: 2 },
  '<=': { min: 2, max: 2 },
  '>': { min: 2, max: 2 },
  '>=': { min: 2, max: 2 },
  '==': { min: 2, max: 2 },
  '!=': { min: 2, max: 2 },
  // логика
  and: { min: 2, max: Infinity },
  or: { min: 2, max: Infinity },
  '!': { min: 1, max: 1 },
  if: { min: 3, max: Infinity, odd: true },
  // векторы
  vec: { min: 2, max: 2 },
  'vec.add': { min: 2, max: 2 },
  'vec.sub': { min: 2, max: 2 },
  'vec.scale': { min: 2, max: 2 },
  'vec.dot': { min: 2, max: 2 },
  'vec.lengthSq': { min: 1, max: 1 },
  'vec.length': { min: 1, max: 1 },
  'vec.normalize': { min: 1, max: 1 },
  'vec.x': { min: 1, max: 1 },
  'vec.y': { min: 1, max: 1 },
};

/** Полная форма из краткой записи ожидания — умолчания те же, что у `def`. */
function expanded(shape: ExpectedShape): OpSignature {
  return {
    min: shape.min,
    max: shape.max,
    odd: shape.odd ?? false,
    literals: shape.literals ?? [],
    ranges: shape.ranges ?? [],
  };
}

/** Только поля сигнатуры: строка таблицы несёт ещё и `fn`, а он к норме не относится. */
function shapeOf(op: string): OpSignature | undefined {
  const signature = signatureOf(op);
  if (signature === undefined) return undefined;
  return {
    min: signature.min,
    max: signature.max,
    odd: signature.odd,
    literals: [...signature.literals],
    ranges: signature.ranges.map((range) => [...range] as [number, number, number]),
  };
}

describe('состав таблицы операторов (EXPR-8)', () => {
  it('совпадает с нормативной таблицей имя в имя', () => {
    expect([...operators].sort()).toEqual([...EXPR_8_TABLE].sort());
  });

  it('в таблице ровно 41 оператор', () => {
    expect(EXPR_8_TABLE.length).toBe(41);
    expect(new Set(EXPR_8_TABLE).size).toBe(41);
  });

  it('перечень форм покрывает таблицу целиком и ничего сверх неё', () => {
    expect(Object.keys(EXPR_8_SHAPES).sort()).toEqual([...EXPR_8_TABLE].sort());
  });

  for (const op of EXPR_8_TABLE) {
    it(`форма применения "${op}" — как в норме`, () => {
      expect(shapeOf(op)).toEqual(expanded(EXPR_8_SHAPES[op]!));
    });
  }

  it('имени вне таблицы формы нет, и цепочка прототипов её не даёт (EXPR-6)', () => {
    expect(signatureOf('nope')).toBeUndefined();
    expect(signatureOf('constructor')).toBeUndefined();
    expect(signatureOf('toString')).toBeUndefined();
  });
});

describe('строка таблицы неизменяема (EXPR-6, DI-1)', () => {
  it('подменить реализацию оператора снаружи нечем', () => {
    const signature = signatureOf('+')! as OpSignature & { fn: unknown };
    expect(Object.isFrozen(signature)).toBe(true);
    // Модули ES исполняются в strict mode: запись во frozen — исключение, а не
    // молчаливый no-op. Это и есть `add_operation` json-logic-js, которого здесь
    // быть не должно.
    expect(() => {
      (signature as { fn: unknown }).fn = () => 0;
    }).toThrow(TypeError);
    expect(() => {
      (signature as { min: number }).min = 7;
    }).toThrow(TypeError);
  });

  it('вложенные списки формы заморожены вместе со строкой', () => {
    const getComponent = signatureOf('getComponent')!;
    expect(Object.isFrozen(getComponent.literals)).toBe(true);
    expect(() => (getComponent.literals as number[]).push(0)).toThrow(TypeError);

    const bitTest = signatureOf('bitTest')!;
    expect(Object.isFrozen(bitTest.ranges)).toBe(true);
    expect(Object.isFrozen(bitTest.ranges[0])).toBe(true);
    expect(() => ((bitTest.ranges[0] as unknown as number[])[2] = 99)).toThrow(TypeError);
  });

  it('заморожена каждая строка таблицы, а не только те, что смотрели', () => {
    for (const op of operators) {
      const signature = signatureOf(op)!;
      expect(Object.isFrozen(signature), op).toBe(true);
      expect(Object.isFrozen(signature.literals), op).toBe(true);
      expect(Object.isFrozen(signature.ranges), op).toBe(true);
    }
  });
});

describe('краевые случаи таблицы (EXPR-8)', () => {
  it('clamp при lo > hi даёт hi', () => {
    // Порядок сведения нормативен: зеркальная запись дала бы lo.
    expect(evaluate({ clamp: [F(0), F(10), F(2)] }, world)).toBe(F(2));
    expect(evaluate({ clamp: [F(100), F(10), F(2)] }, world)).toBe(F(2));
  });

  it('нормализация нулевого вектора даёт нулевой вектор, а не насыщение (FP-5)', () => {
    expect(evaluate({ 'vec.normalize': [{ vec: [0, 0] }] }, world)).toEqual({ x: 0, y: 0 });
  });

  it('abs от INT32_MIN заворачивается в INT32_MIN (FP-4)', () => {
    expect(evaluate({ abs: [fixed.INT32_MIN] }, world)).toBe(fixed.INT32_MIN);
  });

  it('оператор нулевой арности записывается пустым списком', () => {
    expect(evaluate({ tick: [] }, world)).toBe(42);
    // `null` — не список, поэтому читается как список из одного аргумента.
    expect(() => evaluate({ tick: null }, world)).toThrow(
      /оператор "tick": ожидалось аргументов 0, получено 1/,
    );
  });

  it('разнотипные операнды == и != — ошибка, а не false (EXPR-7)', () => {
    expect(() => evaluate({ '==': [F(1), true] }, world)).toThrow(
      /оператор "==": операнды разных типов, number и bool/,
    );
    expect(() => evaluate({ '!=': [true, F(0)] }, world)).toThrow(
      /оператор "!=": операнды разных типов, bool и number/,
    );
    // Однотипные сравниваются как прежде.
    expect(evaluate({ '==': [true, true] }, world)).toBe(true);
    expect(evaluate({ '!=': [F(1), F(2)] }, world)).toBe(true);
  });
});

describe('ленивость логики (EXPR-8)', () => {
  /** Заведомо падающее выражение: у события "Died" поля "nx" нет. */
  const boom: Expression = { eventField: [1, 'nx'] };

  it('and не вычисляет аргументы за первым false', () => {
    expect(evaluate({ and: [false, { '==': [boom, F(0)] }] }, world)).toBe(false);
    expect(() => evaluate({ and: [true, { '==': [boom, F(0)] }] }, world)).toThrow(/нет поля "nx"/);
  });

  it('or не вычисляет аргументы за первым true', () => {
    expect(evaluate({ or: [true, { '==': [boom, F(0)] }] }, world)).toBe(true);
    expect(() => evaluate({ or: [false, { '==': [boom, F(0)] }] }, world)).toThrow(/нет поля "nx"/);
  });

  it('if не вычисляет невыбранную ветвь и условия за первым истинным', () => {
    // Ветвь `then` первого условия ложна — падающее выражение в ней не трогают.
    expect(evaluate({ if: [false, boom, true, F(2), F(3)] }, world)).toBe(F(2));
    // Второе условие стоит за истинным первым — не вычисляется вместе со своей ветвью.
    expect(evaluate({ if: [true, F(1), { '==': [boom, F(0)] }, F(2), F(3)] }, world)).toBe(F(1));
    // Ветвь `else` не вычисляется, когда условие истинно.
    expect(evaluate({ if: [true, F(1), boom] }, world)).toBe(F(1));
  });
});

describe('чего в таблице нет (EXPR-8)', () => {
  it('вариадической арифметики нет: сложение строго бинарное', () => {
    expect(() => evaluate({ '+': [F(1), F(2), F(3)] }, world)).toThrow(
      /оператор "\+": ожидалось аргументов 2, получено 3/,
    );
  });

  it('унарного минуса нет', () => {
    expect(() => evaluate({ '-': [F(1)] }, world)).toThrow(/оператор "-": ожидалось аргументов 2, получено 1/);
  });

  it('у var нет второго аргумента-умолчания', () => {
    expect(() => evaluate({ var: ['a', F(0)] }, world, { a: F(1) })).toThrow(
      /оператор "var": ожидалось аргументов 1, получено 2/,
    );
  });

  it('цепочечных сравнений нет', () => {
    expect(() => evaluate({ '<': [F(1), F(2), F(3)] }, world)).toThrow(
      /оператор "<": ожидалось аргументов 2, получено 3/,
    );
  });

  it('if без else нет', () => {
    expect(() => evaluate({ if: [true, F(1)] }, world)).toThrow(
      /оператор "if": ожидалось \[cond, then, …, else\] — нечётное число аргументов не менее 3, получено 2/,
    );
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

describe('модель типов значения (EXPR-7)', () => {
  it('число в позиции условия — ошибка вычисления, а не «ненулевое истинно»', () => {
    // Обе трактовки числа защитимы (`65536` — это `1.0`, `1` — `0.0000152`),
    // поэтому правила истинности числа в языке нет вовсе.
    const nodes: Expression[] = [
      { if: [F(1), F(1), F(0)] },
      { and: [F(1), true] },
      { or: [F(0), true] },
      { '!': F(0) },
    ];
    for (const node of nodes) {
      expect(() => evaluate(node, world)).toThrow(/ожидалось значение типа bool, получено number/);
    }
  });

  it('флаговое поле читается сравнением с нулём (ECS-3, FOW-3)', () => {
    const flag: Expression = { getComponent: [1, 'Ammo', 'count'] };
    // Само поле условием быть не может — это `number`; сравнение даёт `bool`.
    expect(() => evaluate({ '!': flag }, world)).toThrow(/ожидалось значение типа bool/);
    expect(evaluate({ '!=': [flag, 0] }, world)).toBe(true);
    expect(evaluate({ '==': [flag, 0] }, world)).toBe(false);
  });

  it('булево в арифметике — ошибка, а не 0/1 в сумме', () => {
    expect(() => evaluate({ '+': [{ hasComponent: [1, 'Ammo'] }, F(1)] }, world)).toThrow(
      /оператор "\+": ожидалось значение типа number, получено bool/,
    );
    expect(() => evaluate({ '<': [{ isAlive: [1] }, F(1)] }, world)).toThrow(
      /оператор "<": ожидалось значение типа number, получено bool/,
    );
  });

  it('вектор в скалярном операторе и сравнение векторов целиком — ошибки', () => {
    expect(() => evaluate({ '+': [position(1), F(1)] }, world)).toThrow(
      /оператор "\+": ожидалось значение типа number, получено vec2/,
    );
    expect(() => evaluate({ '!=': [position(1), position(2)] }, world)).toThrow(
      /оператор "!=": векторы сравниваются покомпонентно, а не целиком/,
    );
  });

  it('строка в позиции значения — ошибка: строкового типа значения нет', () => {
    expect(() => evaluate({ '+': ['Ammo', F(1)] }, world)).toThrow(
      /строка допустима только как аргумент-имя оператора/,
    );
    // В позиции литерального имени та же строка законна и не вычисляется.
    expect(evaluate({ hasComponent: [1, 'Ammo'] }, world)).toBe(true);
  });

  it('идентификатор доживает до предиката живости целым, без усечения до 32 бит', () => {
    // 48-битный EntityId: index 5, generation 300. Через `var` (биндинг
    // `forEach … as`) и через поле-ссылку он обязан дойти как есть (ECS-6).
    const reference = 5 + 300 * 2 ** 24;
    const seen: number[] = [];
    const probe: ExprWorld = {
      ...world,
      get: () => reference,
      isAlive: (entity) => {
        seen.push(entity);
        return true;
      },
    };
    expect(evaluate({ var: 'target' }, probe, { target: reference })).toBe(reference);
    expect(evaluate({ isAlive: [{ var: 'target' }] }, probe, { target: reference })).toBe(true);
    expect(evaluate({ isAlive: [{ getComponent: [1, 'Seeker', 'target'] }] }, probe)).toBe(true);
    expect(seen).toEqual([reference, reference]);
  });
});
